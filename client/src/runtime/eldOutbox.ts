/**
 * ELD checkpoint 2d — the device-side ELD event outbox.
 *
 *   driver action / device observation
 *     → canonical ELD event, minted HERE (UUID, device sequence, predecessor hash, eld-h1 hashes)
 *     → committed to the device's ELD store in ONE atomic write
 *     → signed batch to `eld.eventsAppend`
 *     → the server's per-event answer
 *     → a delivery record beside the event (never inside it)
 *
 * There is one event format: `shared/eld/eldEvent.ts`, the contract the server hashes with. This file
 * builds `EldEventInput` values and hashes them with that contract's canonical form; it defines no
 * field of its own that the server sees.
 *
 * THE COMMIT. A device event is committed by one atomic "insert if absent" of the event record, keyed
 * by (deviceRef, deviceSequence) and by eventRef (`EldEventStore.insertEvent`). There is no separate
 * sequence counter: the next sequence and the predecessor hash are read from the device's highest
 * committed event. So "the sequence advanced but the event is missing" cannot happen — the event IS
 * the advance — and a failed write leaves both exactly as they were. Two creations racing for one
 * sequence cannot both commit: the loser's insert answers `sequence_taken` and it re-reads the head.
 *
 * IMMUTABLE vs MUTABLE. The committed `LocalEldEvent` is never rewritten. Delivery — pending,
 * in_flight, acknowledged, conflict, rejected, quarantined — lives in a separate `EldDelivery` record
 * keyed by eventRef; a missing record means pending (an event committed just before a crash is
 * therefore pending, not lost). Changing delivery state cannot change a hash.
 *
 * A RETRY IS THE SAME EVENT. The eventRef, sequence, predecessor hash and event hash are fixed at the
 * commit. A timeout, an offline period, a lost acknowledgement or a restart resends the same bytes;
 * the server answers `replayed` and the event is acknowledged. Nothing here ever mints a new identity
 * for an event that already exists, and a conflict is held for a person, never "fixed" by resending
 * under a new sequence.
 *
 * WHAT THIS DOES NOT DO. It decides no hours-of-service question, detects no driving (there is no
 * engine/ECM source in LeaseOS; a driver cannot select DRIVING here), resolves no unit (the server
 * resolves a stated unit number and refuses one it cannot place), and names no operator or
 * organization: the server takes both from the enrolled device and the signed-in user.
 */

import {
  canonicalEldEventJson, eldEventHashPreimage, ELD_HASH_VERSION, ELD_SCALE, normalizeUuid, validateEldEventShape,
  type EldDeviceRecordOrigin, type EldDutyStatus, type EldEventInput, type EldEventType, type EldLocationSource,
} from "@shared/eld/eldEvent";
import { assessDeviceChain, type ChainAssessment } from "@shared/eld/chain";
import { canonicalJson, sha256HexOfString } from "./crypto";
import type { CaptureScope, Clock, Connectivity, GpsFix, Keystore } from "./contracts";

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

export const ELD_DELIVERY_STATES = ["pending", "in_flight", "acknowledged", "conflict", "rejected", "quarantined"] as const;
export type EldDeliveryState = (typeof ELD_DELIVERY_STATES)[number];

/** A committed device event. Written once by `insertEvent`; never rewritten by anything. */
export type LocalEldEvent = {
  deviceRef: string;
  /** Exactly what was hashed: the server recomputes the same hashes from these fields. */
  event: EldEventInput;
  payloadHash: string;
  eventHash: string;
  hashVersion: typeof ELD_HASH_VERSION;
  /**
   * Local only — never hashed, never sent. Who was signed in and for which organization when the
   * event was recorded, so it is sent only in that session: the server takes the operator from the
   * device's user and refuses a batch from anyone else, and an event must not wait for, or be sent
   * as, someone it does not belong to.
   */
  scope: CaptureScope;
  /** Local only. The UI action that produced it; recording the same action again returns this event. */
  actionKey: string | null;
};

/** Mutable delivery state, beside the event. A missing record means `pending`. */
export type EldDelivery = {
  eventRef: string;
  state: EldDeliveryState;
  attempts: number;
  lastBatchRef: string | null;
  lastAttemptAt: string | null;
  /** The server's answer, when it gave one: accepted (new), idempotent (already on record), conflict, rejected. */
  outcome: "accepted" | "idempotent" | "conflict" | "rejected" | null;
  /** A reason code: the server's (`inserted`, `replayed`, `conflict_event_ref`, `unit_unknown`, …) or this outbox's. */
  code: string | null;
  reason: string | null;
  serverEventId: number | null;
  conflictRef: string | null;
  acknowledgedAt: string | null;
  updatedAt: string;
};

export type EldInsertResult = "inserted" | "sequence_taken" | "event_ref_taken";

/**
 * The device's ELD store. The one primitive the outbox depends on for correctness is `insertEvent`:
 * a single atomic insert-if-absent. On the native shell that is a SQLite statement under
 * UNIQUE(deviceRef, deviceSequence) and UNIQUE(eventRef); in IndexedDB it is `add()` on those keys.
 * Neither binding exists in this repository yet (the native store is a stub — see the checkpoint
 * document); `MemoryEldEventStore` implements the contract for tests and the browser fallback.
 */
export interface EldEventStore {
  insertEvent(e: LocalEldEvent): Promise<EldInsertResult>;
  getEvent(eventRef: string): Promise<LocalEldEvent | null>;
  /** The device's committed event with the highest sequence, or null for a device with none. */
  latestEvent(deviceRef: string): Promise<LocalEldEvent | null>;
  listEvents(): Promise<LocalEldEvent[]>;
  putDelivery(d: EldDelivery): Promise<void>;
  getDelivery(eventRef: string): Promise<EldDelivery | null>;
  listDeliveries(): Promise<EldDelivery[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** In-memory ELD store. Atomic because each method's check-and-write runs without an await between. */
export class MemoryEldEventStore implements EldEventStore {
  private events = new Map<string, LocalEldEvent>();
  private bySeq = new Map<string, string>();
  private deliveries = new Map<string, EldDelivery>();
  private meta = new Map<string, string>();
  async insertEvent(e: LocalEldEvent): Promise<EldInsertResult> {
    const ref = normalizeUuid(e.event.eventRef);
    const seqKey = `${e.deviceRef}#${e.event.deviceSequence}`;
    if (this.bySeq.has(seqKey)) return "sequence_taken";
    if (this.events.has(ref)) return "event_ref_taken";
    this.events.set(ref, structuredClone(e));
    this.bySeq.set(seqKey, ref);
    return "inserted";
  }
  async getEvent(ref: string) { const e = this.events.get(normalizeUuid(ref)); return e ? structuredClone(e) : null; }
  async latestEvent(deviceRef: string) {
    let best: LocalEldEvent | null = null;
    for (const e of Array.from(this.events.values())) if (e.deviceRef === deviceRef && (!best || e.event.deviceSequence > best.event.deviceSequence)) best = e;
    return best ? structuredClone(best) : null;
  }
  async listEvents() { return Array.from(this.events.values()).map(e => structuredClone(e)); }
  async putDelivery(d: EldDelivery) { this.deliveries.set(normalizeUuid(d.eventRef), structuredClone(d)); }
  async getDelivery(ref: string) { const d = this.deliveries.get(normalizeUuid(ref)); return d ? structuredClone(d) : null; }
  async listDeliveries() { return Array.from(this.deliveries.values()).map(d => structuredClone(d)); }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async setMeta(k: string, v: string) { this.meta.set(k, v); }
}

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

/** What goes on the wire: the hashed fields, plus the hash the device computed (the server re-checks it). */
export type EldWireEvent = EldEventInput & { declaredEventHash: string };

export type EldAppendInput = {
  deviceRef: string;
  signedWithFingerprint: string;
  signedAt: Date;
  nonce: string;
  signatureP1363Base64: string;
  deviceClockAt: Date;
  batchRef: string;
  events: EldWireEvent[];
};

/** `eld.eventsAppend`'s answer, as the device reads it. */
export type EldAppendResponse =
  | {
      state: "accepted";
      events: { eventRef: string; deviceSequence: number; outcome: "inserted" | "replayed" | "conflict"; code: string; eventId: number; eventHash: string; conflictRef: string | null; detail: string }[];
    }
  | { state: "refused"; code: string; reason: string; problems: { eventRef: string | null; deviceSequence: number | null; code: string; detail: string }[] };

export interface EldTransport {
  eventsAppend(input: EldAppendInput): Promise<EldAppendResponse>;
}

/** The server's batch envelope, byte for byte: `canonicalEldBatch` in server/_core/eld/ledger.ts. */
export function canonicalEldBatchText(input: { deviceRef: string; batchRef: string; signedAt: Date; nonce: string; events: EldWireEvent[] }): string {
  return canonicalJson({ deviceRef: input.deviceRef, batchRef: input.batchRef, signedAt: input.signedAt.toISOString(), nonce: input.nonce, events: input.events });
}

/* ------------------------------------------------------------------ */
/* Retry                                                                */
/* ------------------------------------------------------------------ */

export const ELD_MAX_EVENTS_PER_BATCH = 500;          // the server's limit on `eld.eventsAppend`
export const ELD_RETRY_BASE_MS = 30_000;
export const ELD_RETRY_MAX_MS = 15 * 60_000;

/**
 * How long to wait after the n-th consecutive failed send (n ≥ 1): 30 s, 1, 2, 4, 8 min, then 15 min.
 * Deterministic — no jitter — because a device has one outbox and a test must be able to say when.
 * Being offline is not a failure and never advances this.
 */
export function eldRetryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(ELD_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), ELD_RETRY_MAX_MS);
}

export const ELD_INTERRUPTED = "Interrupted before the server answered — will be resent unchanged; the server records an event once";

/** Server refusals that judged the TRANSPORT (clock), not the events: the same events are resent later. */
const TRANSIENT_REFUSALS = new Set(["signature_stale"]);
/** tRPC errors that are not a judgment of the events: resend later. Everything else thrown with a code is a refusal. */
const TRANSIENT_ERROR_CODES = new Set(["UNAUTHORIZED", "CONFLICT", "TIMEOUT", "TOO_MANY_REQUESTS", "INTERNAL_SERVER_ERROR", "BAD_GATEWAY", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT", "CLIENT_CLOSED_REQUEST"]);

const errorCode = (e: unknown): string | null => {
  const x = e as { code?: unknown; data?: { code?: unknown } } | null;
  const c = x?.data?.code ?? x?.code;
  return typeof c === "string" ? c : null;
};

/* ------------------------------------------------------------------ */
/* The outbox                                                           */
/* ------------------------------------------------------------------ */

export type EldOutboxDeps = {
  store: EldEventStore;
  keystore: Keystore;
  transport: EldTransport;
  connectivity: Connectivity;
  clock: Clock;
  /** The enrolled device reference (the sync engine's `deviceRef` meta), or null before enrolment. */
  deviceRef: () => Promise<string | null>;
  /** Who is signed in, and for which organization, or null when nobody is. */
  session: () => CaptureScope | null;
  /** UUID v4 for a new event. Defaults to the platform's `crypto.randomUUID`. */
  newUuid?: () => string;
  /** The device's UTC offset at an instant, in minutes east of UTC. Defaults to the platform's. */
  utcOffsetMinutes?: (at: Date) => number | null;
};

export type RecordEldEventArgs = {
  eventType: EldEventType;
  recordOrigin: EldDeviceRecordOrigin;
  dutyStatus?: EldDutyStatus | null;
  eventCode?: string | null;
  /** Only a unit number from an authoritative unit session; never a free-text vehicle name. The server resolves it. */
  unitNumber?: string | null;
  gps?: GpsFix | null;
  jurisdiction?: string | null;
  annotation?: string | null;
  supersedesEventRef?: string | null;
  odometerM?: number | null;
  engineHoursMillis?: number | null;
  vehicleSpeedKphMillis?: number | null;
  /** The UI action's own key. Recording the same key again returns the event already committed for it. */
  actionKey?: string | null;
};

/** What a driver may select by hand. DRIVING is recorded automatically from engine data, which LeaseOS does not have yet. */
export const DRIVER_SELECTABLE_DUTY_STATUSES = ["off_duty", "sleeper_berth", "on_duty"] as const;
export type DriverSelectableDutyStatus = (typeof DRIVER_SELECTABLE_DUTY_STATUSES)[number];

export type EldFlushOutcome = {
  attempted: boolean;
  reason: string;
  batchRef: string | null;
  sent: number;
  accepted: number;
  idempotent: number;
  conflicts: number;
  rejected: number;
  quarantined: number;
  /** Returned to pending: never judged by the server (network, clock, session). */
  requeued: number;
};

const GPS_SOURCE: Record<GpsFix["source"], EldLocationSource> = { device_gps: "gps", network: "network", manual: "manual" };
const COMMIT_RETRIES = 8;

export class EldOutbox {
  private chain: Promise<unknown> = Promise.resolve();
  private flushing: Promise<EldFlushOutcome> | null = null;
  constructor(private deps: EldOutboxDeps) {}

  /** Serializes creation and flushing inside this process. Across processes, `insertEvent` decides. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A driver's hand-selected duty status: one action, one canonical event identity. */
  recordDutyStatus(args: { status: DriverSelectableDutyStatus; actionKey: string; unitNumber?: string | null; gps?: GpsFix | null; annotation?: string | null }): Promise<LocalEldEvent> {
    if (!(DRIVER_SELECTABLE_DUTY_STATUSES as readonly string[]).includes(args.status)) {
      return Promise.reject(new Error(`A driver cannot select ${String(args.status)} by hand here: driving is recorded automatically from engine data, which this device does not have`));
    }
    return this.record({ eventType: "duty_status_change", recordOrigin: "driver", dutyStatus: args.status, unitNumber: args.unitNumber, gps: args.gps, annotation: args.annotation, actionKey: args.actionKey });
  }

  /**
   * Mint, hash and commit one event. The observation time is read once, before anything else, so a
   * retried commit records the same moment; the eventRef is minted once and kept across a lost race.
   */
  record(args: RecordEldEventArgs): Promise<LocalEldEvent> {
    const observedAt = this.deps.clock.now();
    return this.exclusive(async () => {
      const deviceRef = await this.deps.deviceRef();
      if (!deviceRef) throw new Error("This device is not enrolled; an ELD event needs an enrolled device");
      const scope = this.deps.session();
      if (!scope) throw new Error("Nobody is signed in; an ELD event is recorded under the signed-in driver");

      if (args.actionKey) {
        const prior = (await this.deps.store.listEvents()).find(e => e.actionKey === args.actionKey && e.deviceRef === deviceRef);
        if (prior) return prior;
      }

      const eventRef = normalizeUuid((this.deps.newUuid ?? (() => globalThis.crypto.randomUUID()))());
      const offset = (this.deps.utcOffsetMinutes ?? ((d: Date) => -d.getTimezoneOffset()))(observedAt);
      for (let attempt = 0; attempt < COMMIT_RETRIES; attempt++) {
        const head = await this.deps.store.latestEvent(deviceRef);
        const event: EldEventInput = {
          eventRef,
          deviceSequence: head ? head.event.deviceSequence + 1 : 0,
          eventType: args.eventType,
          eventCode: args.eventCode ?? null,
          dutyStatus: args.dutyStatus ?? null,
          recordOrigin: args.recordOrigin,
          eventAtMs: observedAt.getTime(),
          eventUtcOffsetMinutes: offset,
          unitNumber: args.unitNumber ?? null,
          latitudeE7: args.gps ? Math.round(args.gps.latitude * ELD_SCALE.degreesE7) : null,
          longitudeE7: args.gps ? Math.round(args.gps.longitude * ELD_SCALE.degreesE7) : null,
          locationAccuracyMm: args.gps?.accuracyM != null ? Math.round(args.gps.accuracyM * ELD_SCALE.metresToMm) : null,
          locationSource: args.gps ? GPS_SOURCE[args.gps.source] : null,
          jurisdiction: args.jurisdiction ?? null,
          odometerM: args.odometerM ?? null,
          engineHoursMillis: args.engineHoursMillis ?? null,
          vehicleSpeedKphMillis: args.vehicleSpeedKphMillis ?? null,
          annotation: args.annotation ?? null,
          supersedesEventRef: args.supersedesEventRef == null ? null : normalizeUuid(args.supersedesEventRef),
          // The chain follows creation on this device, not delivery: the predecessor is the last
          // COMMITTED event, whether or not the server has it.
          previousEventHash: head ? head.eventHash : null,
        };
        const problems = validateEldEventShape(event);
        if (problems.length) throw new Error(`ELD event refused on the device: ${problems.join("; ")}`);
        const { payloadHash, eventHash } = await hashLocalEvent(deviceRef, event);
        const local: LocalEldEvent = { deviceRef, event, payloadHash, eventHash, hashVersion: ELD_HASH_VERSION, scope: { ...scope }, actionKey: args.actionKey ?? null };
        const r = await this.deps.store.insertEvent(local);
        if (r === "inserted") return local;
        if (r === "event_ref_taken") throw new Error(`Event ${eventRef} is already on this device; an eventRef is never reused`);
        // sequence_taken: another writer committed this sequence first. Re-read the head and retry.
      }
      throw new Error("Could not commit the ELD event: the device sequence kept moving under concurrent writers");
    });
  }

  /** After a restart: a send that was in flight when the process died goes back to pending, unchanged. */
  async hydrate(): Promise<{ interrupted: number }> {
    let interrupted = 0;
    for (const d of await this.deps.store.listDeliveries()) {
      if (d.state === "in_flight") { await this.putDelivery({ ...d, state: "pending", reason: ELD_INTERRUPTED }); interrupted++; }
    }
    return { interrupted };
  }

  /** A person releases a rejected (or quarantined) event for another send, after fixing its cause. Same identity. */
  async requeue(eventRef: string): Promise<EldDelivery> {
    return this.exclusive(async () => {
      const d = await this.delivery(eventRef);
      if (d.state !== "rejected" && d.state !== "quarantined") {
        throw new Error(`Event ${eventRef} is ${d.state}; only a rejected or quarantined event is released for another send (an acknowledged event is never resent, a conflict is investigated, not resent)`);
      }
      return this.putDelivery({ ...d, state: "pending", reason: `Released for another send after ${d.state}: ${d.reason ?? ""}`.trim() });
    });
  }

  async delivery(eventRef: string): Promise<EldDelivery> {
    return (await this.deps.store.getDelivery(eventRef)) ?? emptyDelivery(eventRef, this.deps.clock.now().toISOString());
  }

  /** Counts by delivery state, for the device's sync indicator. */
  async status(): Promise<Record<EldDeliveryState, number>> {
    const counts = Object.fromEntries(ELD_DELIVERY_STATES.map(s => [s, 0])) as Record<EldDeliveryState, number>;
    for (const e of await this.deps.store.listEvents()) counts[(await this.delivery(e.event.eventRef)).state]++;
    return counts;
  }

  /**
   * The device's own chain, judged by the same pure assessment the server uses: sequence gaps, hash
   * links, and clock regressions (a later sequence with an earlier device clock — recorded as
   * observed, never reordered).
   */
  async integrity(deviceRef?: string): Promise<ChainAssessment> {
    const ref = deviceRef ?? (await this.deps.deviceRef());
    const rows = (await this.deps.store.listEvents()).filter(e => e.deviceRef === ref)
      .map(e => ({ eventRef: e.event.eventRef, deviceSequence: e.event.deviceSequence, eventAt: new Date(e.event.eventAtMs), previousEventHash: e.event.previousEventHash, eventHash: e.eventHash }));
    return assessDeviceChain(rows);
  }

  /** Send what is pending. One flush at a time; a call while one runs joins it. */
  flush(options: { ignoreBackoff?: boolean } = {}): Promise<EldFlushOutcome> {
    if (this.flushing) return this.flushing;
    this.flushing = this.exclusive(() => this.flushNow(options)).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushNow(options: { ignoreBackoff?: boolean }): Promise<EldFlushOutcome> {
    const out: EldFlushOutcome = { attempted: false, reason: "", batchRef: null, sent: 0, accepted: 0, idempotent: 0, conflicts: 0, rejected: 0, quarantined: 0, requeued: 0 };
    const stop = (reason: string) => ({ ...out, reason });
    await this.hydrate();
    // Offline is a state, not an error: nothing is counted and nothing is retried against a dead link.
    if (!(await this.deps.connectivity.online())) return stop("Offline — ELD events are kept on the device and sent when a connection returns");
    const deviceRef = await this.deps.deviceRef();
    if (!deviceRef) return stop("Device not enrolled");
    const scope = this.deps.session();
    if (!scope) return stop("Nobody is signed in — events are sent only as the driver who recorded them");
    const now = this.deps.clock.now();
    const backoff = await this.backoff();
    if (!options.ignoreBackoff && backoff.nextAttemptAt && now.getTime() < Date.parse(backoff.nextAttemptAt)) return stop(`Waiting until ${backoff.nextAttemptAt} after ${backoff.failures} failed send(s)`);

    // Pending events of THIS device, recorded in THIS session, in the order they were created.
    const candidates = (await this.deps.store.listEvents())
      .filter(e => e.deviceRef === deviceRef && e.scope.orgKey === scope.orgKey && e.scope.userId === scope.userId)
      .sort((a, b) => a.event.deviceSequence - b.event.deviceSequence);
    const batch: LocalEldEvent[] = [];
    for (const e of candidates) {
      if (batch.length >= ELD_MAX_EVENTS_PER_BATCH) break;
      const d = await this.delivery(e.event.eventRef);
      if (d.state !== "pending") continue;
      // Re-derive both hashes from the stored fields before sending. A record that no longer hashes
      // to what was committed is held for a person and never sent.
      const h = await hashLocalEvent(e.deviceRef, e.event);
      if (h.payloadHash !== e.payloadHash || h.eventHash !== e.eventHash) {
        await this.putDelivery({ ...d, state: "quarantined", code: "local_hash_mismatch", reason: "The stored event no longer hashes to what was committed on this device; held, not sent" });
        out.quarantined++;
        continue;
      }
      batch.push(e);
    }
    if (!batch.length) return stop(out.quarantined ? "Nothing sendable; quarantined events held" : "Nothing to send");

    // A batch reference unique by a durable per-device counter, never by the clock.
    const batchSeq = Number((await this.deps.store.getMeta(`eldBatchSeq:${deviceRef}`)) ?? "0") + 1;
    await this.deps.store.setMeta(`eldBatchSeq:${deviceRef}`, String(batchSeq));
    const batchRef = `ELDB-${deviceRef}-${batchSeq.toString(36).padStart(6, "0")}`.slice(0, 64);
    out.attempted = true; out.batchRef = batchRef; out.sent = batch.length;
    for (const e of batch) {
      const d = await this.delivery(e.event.eventRef);
      await this.putDelivery({ ...d, state: "in_flight", attempts: d.attempts + 1, lastBatchRef: batchRef, lastAttemptAt: now.toISOString() });
    }

    const events = batch.map(e => wireEvent(e));
    const signedAt = this.deps.clock.now();
    const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, "0")).join("");
    let response: EldAppendResponse;
    try {
      const signatureP1363Base64 = await this.deps.keystore.signP1363(new TextEncoder().encode(canonicalEldBatchText({ deviceRef, batchRef, signedAt, nonce, events })));
      response = await this.deps.transport.eventsAppend({ deviceRef, signedWithFingerprint: await this.deps.keystore.fingerprint(), signedAt, nonce, signatureP1363Base64, deviceClockAt: signedAt, batchRef, events });
    } catch (e) {
      const code = errorCode(e);
      const reason = e instanceof Error ? e.message : String(e);
      if (code && !TRANSIENT_ERROR_CODES.has(code)) {
        // The server answered with a refusal (FORBIDDEN, BAD_REQUEST, …): kept, with the reason.
        for (const ev of batch) await this.settle(ev, { state: "rejected", outcome: "rejected", code: `server_${code.toLowerCase()}`, reason });
        out.rejected = batch.length;
        await this.clearBackoff();
        return { ...out, reason: `Refused by the server (${code}): ${reason}` };
      }
      // No answer, or not a judgment of the events. The server may have stored them anyway; the
      // resend is the same bytes and comes back `replayed`.
      for (const ev of batch) await this.settle(ev, { state: "pending", code: code ? `transient_${code.toLowerCase()}` : "network", reason });
      out.requeued = batch.length;
      const next = await this.recordFailure(now);
      return { ...out, reason: `Not sent (${code ?? "network"}): ${reason}; next attempt after ${next}` };
    }

    if (response.state === "refused") {
      if (TRANSIENT_REFUSALS.has(response.code)) {
        for (const ev of batch) await this.settle(ev, { state: "pending", code: response.code, reason: response.reason });
        out.requeued = batch.length;
        const next = await this.recordFailure(now);
        return { ...out, reason: `${response.code}: ${response.reason}; next attempt after ${next}` };
      }
      const named = new Map(response.problems.filter(p => p.eventRef).map(p => [normalizeUuid(p.eventRef!), p]));
      for (const ev of batch) {
        const p = named.get(normalizeUuid(ev.event.eventRef));
        if (p) { await this.settle(ev, { state: "rejected", outcome: "rejected", code: p.code, reason: p.detail }); out.rejected++; }
        else if (named.size) { await this.settle(ev, { state: "pending", code: "batch_refused_for_another_event", reason: `Nothing in ${batchRef} was written because another event was refused (${response.code}); resent unchanged` }); out.requeued++; }
        else { await this.settle(ev, { state: "rejected", outcome: "rejected", code: response.code, reason: response.reason }); out.rejected++; }
      }
      await this.clearBackoff();
      return { ...out, reason: `${response.code}: ${response.reason}` };
    }

    const answers = new Map(response.events.map(a => [normalizeUuid(a.eventRef), a]));
    const at = this.deps.clock.now().toISOString();
    for (const ev of batch) {
      const a = answers.get(normalizeUuid(ev.event.eventRef));
      if (!a) { await this.settle(ev, { state: "pending", code: "no_answer", reason: `The server's answer to ${batchRef} did not mention this event; resent unchanged` }); out.requeued++; continue; }
      if (a.outcome === "conflict") {
        // Held exactly as recorded. Not rewritten, not resent under a new sequence: a person investigates.
        await this.settle(ev, { state: "conflict", outcome: "conflict", code: a.code, reason: a.detail, serverEventId: a.eventId, conflictRef: a.conflictRef });
        out.conflicts++;
      } else {
        const idempotent = a.outcome === "replayed";
        await this.settle(ev, { state: "acknowledged", outcome: idempotent ? "idempotent" : "accepted", code: a.code, reason: null, serverEventId: a.eventId, conflictRef: null, acknowledgedAt: at });
        if (idempotent) out.idempotent++; else out.accepted++;
      }
    }
    await this.clearBackoff();
    return { ...out, reason: `Sent ${batch.length} event(s) in ${batchRef}` };
  }

  private async settle(e: LocalEldEvent, patch: Partial<EldDelivery>) {
    const d = await this.delivery(e.event.eventRef);
    await this.putDelivery({ ...d, ...patch });
  }
  private async putDelivery(d: EldDelivery): Promise<EldDelivery> {
    const next = { ...d, updatedAt: this.deps.clock.now().toISOString() };
    await this.deps.store.putDelivery(next);
    return next;
  }
  private async backoff(): Promise<{ failures: number; nextAttemptAt: string | null }> {
    const raw = await this.deps.store.getMeta("eldBackoff");
    return raw ? JSON.parse(raw) as { failures: number; nextAttemptAt: string | null } : { failures: 0, nextAttemptAt: null };
  }
  private async recordFailure(now: Date): Promise<string> {
    const failures = (await this.backoff()).failures + 1;
    const nextAttemptAt = new Date(now.getTime() + eldRetryDelayMs(failures)).toISOString();
    await this.deps.store.setMeta("eldBackoff", JSON.stringify({ failures, nextAttemptAt }));
    return nextAttemptAt;
  }
  private async clearBackoff() { await this.deps.store.setMeta("eldBackoff", JSON.stringify({ failures: 0, nextAttemptAt: null })); }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** eld-h1, computed with the shared contract: payloadHash over the canonical bytes, eventHash over the preimage. */
export async function hashLocalEvent(deviceRef: string, event: EldEventInput): Promise<{ payloadHash: string; eventHash: string }> {
  const payloadHash = await sha256HexOfString(canonicalEldEventJson(deviceRef, event));
  const eventHash = await sha256HexOfString(eldEventHashPreimage(payloadHash, event.previousEventHash));
  return { payloadHash, eventHash };
}

/** The event as sent: its hashed fields with nothing undefined (the server's envelope encodes every key it sees), and the device's hash. */
export function wireEvent(e: LocalEldEvent): EldWireEvent {
  const w: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.event)) if (v !== undefined && k !== "declaredEventHash") w[k] = v;
  w.declaredEventHash = e.eventHash;
  return w as EldWireEvent;
}

function emptyDelivery(eventRef: string, at: string): EldDelivery {
  return { eventRef: normalizeUuid(eventRef), state: "pending", attempts: 0, lastBatchRef: null, lastAttemptAt: null, outcome: null, code: null, reason: null, serverEventId: null, conflictRef: null, acknowledgedAt: null, updatedAt: at };
}
