/**
 * ELD checkpoint 2d — the device-side ELD outbox, end to end against a server that uses the REAL
 * pure pieces of the ledger: `canonicalEldBatch` + `verifyP256PackageSignature` for the signed
 * envelope, and `prepareEldBatch` for validation and eld-h1 hashing (so a device hash that differs
 * from the server's by one byte is refused here exactly as in production). What the fake keeps in
 * memory is only the idempotency/conflict bookkeeping that `appendEldEvents` does in MariaDB; the
 * database suite (`eldLedger.db.test.ts`) repeats the decisive cases against the real store.
 *
 * The device store is a stand-in for persistent storage, as in `boardQueueDurable.test.ts`: every
 * write is serialized to a shared "disk", and a restart is a new store and a new outbox over the
 * same disk, so nothing survives in an object or a closure. That proves what the outbox does over a
 * durable store with an atomic insert-if-absent. It does NOT prove a durable store exists on a
 * device: in this repository the native encrypted store is a stub (see the checkpoint document).
 *
 * Every timestamp is a literal; no test waits on a real clock.
 */
import { describe, expect, it } from "vitest";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import {
  canonicalEldBatchText, eldRetryDelayMs, EldOutbox, ELD_INTERRUPTED, hashLocalEvent, MemoryEldEventStore, wireEvent,
  type EldAppendInput, type EldAppendResponse, type EldDelivery, type EldEventStore, type EldInsertResult, type EldTransport, type LocalEldEvent,
} from "../client/src/runtime/eldOutbox";
import { Outbox } from "../client/src/runtime/outbox";
import { canonicalEldBatch, prepareEldBatch } from "./_core/eld/ledger";
import { verifyP256PackageSignature } from "./_core/deviceSignature";
import { CANONICAL_ELD_EVENT_KEYS, normalizeUuid } from "../shared/eld/eldEvent";

const DEVICE = "FD-ELD-TEST-0001";
const ME = { orgKey: "ORG-A", userId: 41 };
const T0 = new Date("2026-10-20T14:00:00.000Z");

/* ---- a persistent store stand-in ---- */

type Disk = Map<string, string>;
class DiskEldEventStore implements EldEventStore {
  /** Set to make the next insert fail the way a write can: nothing is stored. */
  failNextInsert: Error | null = null;
  constructor(private disk: Disk) {}
  private read<T>(k: string, fallback: T): T { const v = this.disk.get(k); return v == null ? fallback : JSON.parse(v) as T; }
  private write(k: string, v: unknown) { this.disk.set(k, JSON.stringify(v)); }
  async insertEvent(e: LocalEldEvent): Promise<EldInsertResult> {
    // One read and one write with no await between: atomic in this process, as one SQL statement is on a device.
    if (this.failNextInsert) { const err = this.failNextInsert; this.failNextInsert = null; throw err; }
    const all = this.read<Record<string, LocalEldEvent>>("events", {});
    if (Object.values(all).some(x => x.deviceRef === e.deviceRef && x.event.deviceSequence === e.event.deviceSequence)) return "sequence_taken";
    const ref = normalizeUuid(e.event.eventRef);
    if (all[ref]) return "event_ref_taken";
    all[ref] = e; this.write("events", all);
    return "inserted";
  }
  async getEvent(ref: string) { return this.read<Record<string, LocalEldEvent>>("events", {})[normalizeUuid(ref)] ?? null; }
  async latestEvent(deviceRef: string) {
    return Object.values(this.read<Record<string, LocalEldEvent>>("events", {})).filter(e => e.deviceRef === deviceRef).sort((a, b) => b.event.deviceSequence - a.event.deviceSequence)[0] ?? null;
  }
  async listEvents() { return Object.values(this.read<Record<string, LocalEldEvent>>("events", {})); }
  async putDelivery(d: EldDelivery) { const all = this.read<Record<string, EldDelivery>>("deliveries", {}); all[normalizeUuid(d.eventRef)] = d; this.write("deliveries", all); }
  async getDelivery(ref: string) { return this.read<Record<string, EldDelivery>>("deliveries", {})[normalizeUuid(ref)] ?? null; }
  async listDeliveries() { return Object.values(this.read<Record<string, EldDelivery>>("deliveries", {})); }
  async getMeta(k: string) { return this.read<Record<string, string>>("meta", {})[k] ?? null; }
  async setMeta(k: string, v: string) { const all = this.read<Record<string, string>>("meta", {}); all[k] = v; this.write("meta", all); }
}

/* ---- a server built from the real pure ledger pieces ---- */

type Stored = { eventRef: string; deviceSequence: number; eventHash: string; id: number };
function fakeLedger(keystore: MemoryKeystore) {
  const byRef = new Map<string, Stored>();
  const bySeq = new Map<string, Stored>();
  const received: EldAppendInput[] = [];
  let nextId = 1;
  let conflictSeq = 0;
  let mode: { kind: "ok" } | { kind: "throw"; error: unknown; afterStoring?: boolean } | { kind: "respond"; response: EldAppendResponse } = { kind: "ok" };
  const once = (m: typeof mode) => { mode = m; };

  const transport: EldTransport = {
    async eventsAppend(input) {
      received.push(structuredClone(input));
      const m = mode; mode = { kind: "ok" };
      if (m.kind === "throw" && !m.afterStoring) throw m.error;
      if (m.kind === "respond") return m.response;
      // The envelope the server verifies, built by the server's own function.
      const payload = canonicalEldBatch({ deviceRef: input.deviceRef, batchRef: input.batchRef, signedAt: input.signedAt, nonce: input.nonce, events: input.events });
      if (!verifyP256PackageSignature({ publicKeySpkiBase64: await keystore.publicKeySpkiBase64(), payload, signatureP1363Base64: input.signatureP1363Base64 })) {
        return { state: "refused", code: "signature_invalid", reason: "Invalid device batch signature", problems: [] };
      }
      const prepared = prepareEldBatch(input.deviceRef, input.events);
      if (!prepared.ok) return { state: "refused", code: prepared.problems[0]!.code, reason: "refused", problems: prepared.problems };
      const events = prepared.events.map(h => {
        const ref = h.input.eventRef, seq = h.input.deviceSequence;
        const prior = byRef.get(ref) ?? bySeq.get(`${input.deviceRef}#${seq}`);
        if (prior) {
          const same = prior.eventRef === ref && prior.deviceSequence === seq && prior.eventHash === h.eventHash;
          return same
            ? { eventRef: ref, deviceSequence: seq, outcome: "replayed" as const, code: "replayed", eventId: prior.id, eventHash: prior.eventHash, conflictRef: null, detail: "already on record" }
            : { eventRef: ref, deviceSequence: seq, outcome: "conflict" as const, code: prior.eventRef === ref ? "conflict_event_ref" : "conflict_device_sequence", eventId: prior.id, eventHash: prior.eventHash, conflictRef: `ELDC-${++conflictSeq}`, detail: "different content on record" };
        }
        const row = { eventRef: ref, deviceSequence: seq, eventHash: h.eventHash, id: nextId++ };
        byRef.set(ref, row); bySeq.set(`${input.deviceRef}#${seq}`, row);
        return { eventRef: ref, deviceSequence: seq, outcome: "inserted" as const, code: "inserted", eventId: row.id, eventHash: h.eventHash, conflictRef: null, detail: "" };
      });
      if (m.kind === "throw" && m.afterStoring) throw m.error;        // stored, and the answer is lost
      return { state: "accepted", events };
    },
  };
  return { transport, received, rows: () => Array.from(byRef.values()), once, seed: (s: Stored, deviceRef = DEVICE) => { byRef.set(s.eventRef, s); bySeq.set(`${deviceRef}#${s.deviceSequence}`, s); } };
}

/* ---- a device ---- */

let uuidSeq = 0;
const nextUuid = () => `00000000-0000-4000-8000-${(++uuidSeq).toString(16).padStart(12, "0")}`;

function device(o: { disk?: Disk; clock?: SettableClock; keystore?: MemoryKeystore; online?: boolean; session?: typeof ME | null; utcOffsetMinutes?: (d: Date) => number | null; deviceRef?: string | null } = {}) {
  const disk = o.disk ?? new Map<string, string>();
  const clock = o.clock ?? new SettableClock(T0);
  const keystore = o.keystore ?? new MemoryKeystore(clock, "hardware");
  const connectivity = new FlagConnectivity(o.online ?? true);
  const store = new DiskEldEventStore(disk);
  const ledger = fakeLedger(keystore);
  let session: typeof ME | null = o.session === undefined ? ME : o.session;
  const make = (transport: EldTransport) => new EldOutbox({
    store, keystore, transport, connectivity, clock, deviceRef: async () => (o.deviceRef === undefined ? DEVICE : o.deviceRef), session: () => session,
    newUuid: nextUuid, utcOffsetMinutes: o.utcOffsetMinutes ?? (() => -360),
  });
  return { disk, clock, keystore, connectivity, store, ledger, outbox: make(ledger.transport), make, signIn: (s: typeof ME | null) => { session = s; } };
}
/** The same device after a restart: a new store and a new outbox over the same disk, same keystore. */
const restart = (d: ReturnType<typeof device>, transport?: EldTransport) => {
  const again = device({ disk: d.disk, clock: d.clock, keystore: d.keystore });
  return { ...again, outbox: again.make(transport ?? d.ledger.transport), ledger: d.ledger };
};
const duty = (d: ReturnType<typeof device>, status: "off_duty" | "on_duty" | "sleeper_berth", key: string) => d.outbox.recordDutyStatus({ status, actionKey: key });
const state = async (d: { outbox: EldOutbox }, e: LocalEldEvent) => (await d.outbox.delivery(e.event.eventRef)).state;

/* ================================================================== */

describe("an event is created, committed and sent", () => {
  it("1. online: one commit, one signed batch the server's own verifier accepts, acknowledged as ACCEPTED", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "a1");
    expect(e.event).toMatchObject({ deviceSequence: 0, previousEventHash: null, eventType: "duty_status_change", dutyStatus: "on_duty", recordOrigin: "driver", eventAtMs: T0.getTime(), eventUtcOffsetMinutes: -360 });
    expect(e.hashVersion).toBe("eld-h1");
    const out = await d.outbox.flush();
    expect(out).toMatchObject({ attempted: true, sent: 1, accepted: 1 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "acknowledged", outcome: "accepted", code: "inserted", serverEventId: 1, attempts: 1 });
    // The server hashed the same bytes to the same eventHash the device committed.
    expect(d.ledger.rows()).toEqual([expect.objectContaining({ eventRef: e.event.eventRef, eventHash: e.eventHash })]);
  });

  it("signs exactly the bytes the server's canonicalEldBatch produces", async () => {
    const d = device();
    const e = await duty(d, "off_duty", "sig");
    const events = [wireEvent(e)];
    const env = { deviceRef: DEVICE, batchRef: "B1", signedAt: T0, nonce: "n".repeat(32), events };
    expect(canonicalEldBatchText(env)).toBe(canonicalEldBatch(env).toString("utf8"));
  });

  it("2. offline: the event is committed locally, nothing is attempted, and being offline is not counted as a failure", async () => {
    const d = device({ online: false });
    const e = await duty(d, "sleeper_berth", "off1");
    const out = await d.outbox.flush();
    expect(out).toMatchObject({ attempted: false, sent: 0 });
    expect(out.reason).toMatch(/Offline/);
    expect(await state(d, e)).toBe("pending");
    expect(d.ledger.received).toHaveLength(0);
    expect(await d.store.getMeta("eldBackoff")).toBeNull();
  });

  it("3 + 21. an offline event survives a restart, and the restarted device sends it", async () => {
    const d = device({ online: false });
    const e = await duty(d, "on_duty", "r1");
    const after = restart(d);
    expect(await after.store.getEvent(e.event.eventRef)).toEqual(e);
    expect(await after.outbox.flush()).toMatchObject({ sent: 1, accepted: 1 });
    expect(await state(after, e)).toBe("acknowledged");
  });

  it("4. the device sequence and the chain continue across a restart, from the committed head", async () => {
    const d = device({ online: false });
    const a = await duty(d, "on_duty", "s1");
    const b = await duty(d, "off_duty", "s2");
    const after = restart(d);
    const c = await duty(after, "on_duty", "s3");
    expect([a, b, c].map(x => x.event.deviceSequence)).toEqual([0, 1, 2]);
    expect(c.event.previousEventHash).toBe(b.eventHash);
  });

  it("5. concurrent creation gives unique, gap-free sequences — in one process, and across two writers on one store", async () => {
    const d = device({ online: false });
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => duty(d, i % 2 ? "on_duty" : "off_duty", `c${i}`)));
    expect(many.map(x => x.event.deviceSequence).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // Two outboxes (two processes) over one store: each has its own lock, so only the atomic insert keeps them apart.
    const other = d.make(d.ledger.transport);
    const raced = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? d.outbox : other).recordDutyStatus({ status: "on_duty", actionKey: `x${i}` })));
    const seqs = [...many, ...raced].map(x => x.event.deviceSequence).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i));
    const integrity = await d.outbox.integrity();
    expect(integrity).toMatchObject({ eventCount: 30, gaps: [], chainMismatches: [], verifiedLinks: 29 });
  });

  it("5. a writer that loses the race for a sequence re-reads the head and commits at the next one — deterministically", async () => {
    const d = device({ online: false });
    const rival = d.make(d.ledger.transport);
    // Between this writer reading the head and inserting, the rival commits the same sequence.
    const store = d.store;
    const results: string[] = [];
    let interleaved = false;
    const racing: EldEventStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      latestEvent: async (ref: string) => {
        const head = await store.latestEvent(ref);
        if (!interleaved) { interleaved = true; await rival.recordDutyStatus({ status: "off_duty", actionKey: "rival" }); }
        return head;
      },
      insertEvent: async (e: LocalEldEvent) => { const r = await store.insertEvent(e); results.push(r); return r; },
    });
    const loser = new EldOutbox({ store: racing, keystore: d.keystore, transport: d.ledger.transport, connectivity: d.connectivity, clock: d.clock, deviceRef: async () => DEVICE, session: () => ME, newUuid: nextUuid, utcOffsetMinutes: () => -360 });
    const mine = await loser.recordDutyStatus({ status: "on_duty", actionKey: "loser" });
    expect(results).toEqual(["sequence_taken", "inserted"]);
    const theirs = (await store.listEvents()).find(e => e.actionKey === "rival")!;
    expect([theirs.event.deviceSequence, mine.event.deviceSequence]).toEqual([0, 1]);
    expect(mine.event.previousEventHash).toBe(theirs.eventHash);
  });

  it("8 + 9. several offline events form one hash chain on the device", async () => {
    const d = device({ online: false });
    const [a, b, c] = [await duty(d, "on_duty", "h1"), await duty(d, "off_duty", "h2"), await duty(d, "sleeper_berth", "h3")];
    expect(a.event.previousEventHash).toBeNull();
    expect(b.event.previousEventHash).toBe(a.eventHash);
    expect(c.event.previousEventHash).toBe(b.eventHash);
    expect(await d.outbox.integrity()).toMatchObject({ verifiedLinks: 2, gaps: [], chainMismatches: [], unverifiableLinks: [] });
  });
});

describe("a retry is the same event", () => {
  it("6 + 7 + 22. a network failure mid-upload: back to pending, backed off, and resent with the same UUID, sequence and hash", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "n1");
    d.ledger.once({ kind: "throw", error: new TypeError("Failed to fetch") });
    const first = await d.outbox.flush();
    expect(first).toMatchObject({ attempted: true, requeued: 1, accepted: 0 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "pending", code: "network", attempts: 1 });
    // Backed off: 30 s after the first failure. A flush inside the window sends nothing.
    expect(JSON.parse((await d.store.getMeta("eldBackoff"))!)).toEqual({ failures: 1, nextAttemptAt: "2026-10-20T14:00:30.000Z" });
    expect(await d.outbox.flush()).toMatchObject({ attempted: false });
    // Offline during the wait is not another failure.
    d.connectivity.isOnline = false; d.clock.set(new Date("2026-10-20T14:05:00Z"));
    await d.outbox.flush();
    expect(JSON.parse((await d.store.getMeta("eldBackoff"))!).failures).toBe(1);
    d.connectivity.isOnline = true;
    expect(await d.outbox.flush()).toMatchObject({ sent: 1, accepted: 1 });
    const [try1, try2] = d.ledger.received;
    expect(try2!.events).toEqual(try1!.events);                       // same UUID, sequence, predecessor, hash
    expect(try2!.events[0]!.declaredEventHash).toBe(e.eventHash);
    expect(try2!.batchRef).not.toBe(try1!.batchRef);                   // a new transport attempt, not a new event
    expect(try2!.nonce).not.toBe(try1!.nonce);
    expect(d.ledger.rows()).toHaveLength(1);
  });

  it("12. a lost acknowledgement: the server stored it, the device never heard, the resend is IDEMPOTENT", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "l1");
    d.ledger.once({ kind: "throw", error: new TypeError("connection reset"), afterStoring: true });
    await d.outbox.flush();
    expect(await state(d, e)).toBe("pending");
    expect(d.ledger.rows()).toHaveLength(1);
    expect(await d.outbox.flush({ ignoreBackoff: true })).toMatchObject({ idempotent: 1, accepted: 0 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "acknowledged", outcome: "idempotent", code: "replayed" });
    expect(d.ledger.rows()).toHaveLength(1);
  });

  it("11. an exact replay of an event already on record is acknowledged as IDEMPOTENT", async () => {
    const d = device();
    const e = await duty(d, "off_duty", "i1");
    d.ledger.seed({ eventRef: e.event.eventRef, deviceSequence: 0, eventHash: e.eventHash, id: 77 });
    expect(await d.outbox.flush()).toMatchObject({ idempotent: 1 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "acknowledged", outcome: "idempotent", serverEventId: 77 });
  });

  it("21. a send in flight when the process died is resumed after restart, unchanged", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "f1");
    // The crash: delivery marked in flight, the request never completed.
    await d.store.putDelivery({ ...(await d.outbox.delivery(e.event.eventRef)), state: "in_flight", attempts: 1, lastBatchRef: "ELDB-lost" });
    const after = restart(d);
    expect(await after.outbox.hydrate()).toEqual({ interrupted: 1 });
    expect(await after.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "pending", reason: ELD_INTERRUPTED });
    expect(await after.outbox.flush()).toMatchObject({ accepted: 1 });
    expect(await after.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "acknowledged", attempts: 2 });
  });

  it("27. an acknowledged event is never resent and cannot be released as a new send", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "k1");
    await d.outbox.flush();
    expect(await d.outbox.flush()).toMatchObject({ attempted: false, reason: "Nothing to send" });
    await expect(d.outbox.requeue(e.event.eventRef)).rejects.toThrow(/acknowledged event is never resent/);
    expect(d.ledger.received).toHaveLength(1);
  });

  it("26. delivery state lives beside the event and never changes it or its hash", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "d1");
    const before = JSON.stringify(await d.store.getEvent(e.event.eventRef));
    d.ledger.once({ kind: "throw", error: new TypeError("offline") });
    await d.outbox.flush();
    await d.outbox.flush({ ignoreBackoff: true });
    expect(JSON.stringify(await d.store.getEvent(e.event.eventRef))).toBe(before);
    expect(await hashLocalEvent(DEVICE, e.event)).toEqual({ payloadHash: e.payloadHash, eventHash: e.eventHash });
    expect(Object.keys(e)).not.toContain("state");
  });
});

describe("what the server refuses is kept, with its reason", () => {
  it("13. same UUID, different content on the server: CONFLICT, held as recorded, never resent", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "u1");
    d.ledger.seed({ eventRef: e.event.eventRef, deviceSequence: 0, eventHash: "f".repeat(64), id: 9 });
    expect(await d.outbox.flush()).toMatchObject({ conflicts: 1 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "conflict", outcome: "conflict", code: "conflict_event_ref", conflictRef: "ELDC-1" });
    expect(await d.store.getEvent(e.event.eventRef)).toEqual(e);
    expect(await d.outbox.flush()).toMatchObject({ attempted: false });
    await expect(d.outbox.requeue(e.event.eventRef)).rejects.toThrow(/conflict is investigated/);
    // The next observation is a new event at the next sequence; the conflicting one is not re-minted.
    const next = await duty(d, "off_duty", "u2");
    expect(next.event.deviceSequence).toBe(1);
  });

  it("14. same (device, sequence), different UUID on the server: CONFLICT on the sequence", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "q1");
    d.ledger.seed({ eventRef: "00000000-0000-4000-8000-ffffffffffff", deviceSequence: 0, eventHash: "e".repeat(64), id: 5 });
    await d.outbox.flush();
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "conflict", code: "conflict_device_sequence" });
  });

  it("15 + 20. a refusal naming one event rejects that event, keeps it, and resends the rest unchanged", async () => {
    const d = device();
    const a = await duty(d, "on_duty", "p1");
    const b = await duty(d, "off_duty", "p2");
    d.ledger.once({ kind: "respond", response: { state: "refused", code: "unit_not_in_organization", reason: "Unit T-9 is not owned by organization ORG-A", problems: [{ eventRef: a.event.eventRef, deviceSequence: 0, code: "unit_not_in_organization", detail: "Unit T-9 is not owned by this organization" }] } });
    expect(await d.outbox.flush()).toMatchObject({ rejected: 1, requeued: 1 });
    expect(await d.outbox.delivery(a.event.eventRef)).toMatchObject({ state: "rejected", outcome: "rejected", code: "unit_not_in_organization" });
    expect(await d.outbox.delivery(b.event.eventRef)).toMatchObject({ state: "pending", code: "batch_refused_for_another_event" });
    expect(await d.store.getEvent(a.event.eventRef)).toEqual(a);
    expect(await d.outbox.flush()).toMatchObject({ sent: 1, accepted: 1 });
    expect(await state(d, b)).toBe("acknowledged");
    expect(await state(d, a)).toBe("rejected");
  });

  it("16. an authorization failure keeps the event, rejected with the reason, releasable by a person with the same identity", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "z1");
    d.ledger.once({ kind: "throw", error: Object.assign(new Error("Device is not bound to the active organization"), { code: "FORBIDDEN" }) });
    expect(await d.outbox.flush()).toMatchObject({ rejected: 1 });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "rejected", code: "server_forbidden" });
    expect(await d.store.getEvent(e.event.eventRef)).toEqual(e);
    await d.outbox.requeue(e.event.eventRef);
    expect(await d.outbox.flush()).toMatchObject({ accepted: 1 });
    expect(d.ledger.received.map(r => r.events[0]!.eventRef)).toEqual([e.event.eventRef, e.event.eventRef]);
  });

  it("a whole-batch identity refusal (an ambiguous operator) rejects every event in it, deleting none", async () => {
    const d = device();
    const a = await duty(d, "on_duty", "w1");
    const b = await duty(d, "off_duty", "w2");
    d.ledger.once({ kind: "respond", response: { state: "refused", code: "operator_ambiguous", reason: "User 41 has 2 operator records", problems: [] } });
    expect(await d.outbox.flush()).toMatchObject({ rejected: 2 });
    for (const e of [a, b]) expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "rejected", code: "operator_ambiguous" });
    expect(await d.store.listEvents()).toHaveLength(2);
  });

  it("an expired session or a stale clock is not a judgment of the events: they wait, unchanged", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "t1");
    d.ledger.once({ kind: "throw", error: Object.assign(new Error("Please login"), { code: "UNAUTHORIZED" }) });
    await d.outbox.flush();
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "pending", code: "transient_unauthorized" });
    d.ledger.once({ kind: "respond", response: { state: "refused", code: "signature_stale", reason: "signature is 20 minutes old", problems: [] } });
    await d.outbox.flush({ ignoreBackoff: true });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "pending", code: "signature_stale" });
    expect(await d.outbox.flush({ ignoreBackoff: true })).toMatchObject({ accepted: 1 });
  });

  it("quarantines an event whose stored bytes no longer hash to what was committed, and never sends it", async () => {
    const d = device();
    const e = await duty(d, "on_duty", "qq");
    const all = JSON.parse(d.disk.get("events")!) as Record<string, LocalEldEvent>;
    all[e.event.eventRef]!.event.dutyStatus = "off_duty";                  // the disk was altered under the app
    d.disk.set("events", JSON.stringify(all));
    expect(await d.outbox.flush()).toMatchObject({ quarantined: 1, attempted: false });
    expect(await d.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "quarantined", code: "local_hash_mismatch" });
    expect(d.ledger.received).toHaveLength(0);
  });
});

describe("identity and scope", () => {
  it("17 + 29. the wire event carries the canonical fields and the device's hash — no organization, operator, user or name", async () => {
    const d = device();
    const e = await d.outbox.record({ eventType: "duty_status_change", recordOrigin: "driver", dutyStatus: "on_duty", unitNumber: "T-101", gps: { latitude: 53.5461, longitude: -113.4938, accuracyM: 4.2, fixedAt: T0.toISOString(), source: "device_gps" }, actionKey: "g1" });
    const keys = Object.keys(wireEvent(e)).sort();
    const allowed = [...CANONICAL_ELD_EVENT_KEYS.filter(k => k !== "hashVersion" && k !== "deviceRef"), "previousEventHash", "declaredEventHash"].sort();
    expect(keys).toEqual(allowed);
    expect(wireEvent(e)).toMatchObject({ unitNumber: "T-101", latitudeE7: 535461000, longitudeE7: -1134938000, locationAccuracyMm: 4200, locationSource: "gps" });
    for (const k of ["orgRef", "orgKey", "operatorId", "operatorName", "userId", "driverName", "name"]) expect(keys).not.toContain(k);
  });

  it("sends an event only in the session that recorded it, and only from the device that minted it", async () => {
    const d = device();
    const mine = await duty(d, "on_duty", "m1");
    d.signIn({ orgKey: "ORG-A", userId: 99 });
    expect(await d.outbox.flush()).toMatchObject({ attempted: false, reason: "Nothing to send" });
    d.signIn(null);
    expect((await d.outbox.flush()).reason).toMatch(/Nobody is signed in/);
    await expect(duty(d, "on_duty", "m2")).rejects.toThrow(/Nobody is signed in/);
    d.signIn(ME);
    expect(await d.outbox.flush()).toMatchObject({ accepted: 1 });
    expect(await state(d, mine)).toBe("acknowledged");
    const unenrolled = device({ deviceRef: null });
    await expect(duty(unenrolled, "on_duty", "e1")).rejects.toThrow(/not enrolled/);
  });

  it("28. one UI duty-status action is one canonical event identity, however often the handler runs", async () => {
    const d = device();
    const [x, y] = await Promise.all([duty(d, "on_duty", "tap-17"), duty(d, "on_duty", "tap-17")]);
    const z = await duty(d, "on_duty", "tap-17");
    expect(new Set([x.event.eventRef, y.event.eventRef, z.event.eventRef]).size).toBe(1);
    expect(await d.store.listEvents()).toHaveLength(1);
  });

  it("28. the generic capture path no longer mints a duty event, and a driver cannot hand-select DRIVING", async () => {
    const clock = new SettableClock(T0);
    const generic = new Outbox(new MemoryStore(), new MemoryVault(new MemoryKeystore(clock)), clock);
    await expect(generic.saveDraft({ kind: "hos_event", formKey: null, title: "On duty", category: "hos", fields: { status: "on_duty" }, unitId: 1 })).rejects.toThrow(/ELD outbox/);
    const d = device();
    await expect(d.outbox.recordDutyStatus({ status: "driving" as never, actionKey: "drv" })).rejects.toThrow(/engine data/);
    expect(await d.store.listEvents()).toHaveLength(0);
  });
});

describe("time on the device", () => {
  it("23. a clock that goes backwards keeps sequence order, records the time as observed, and is reported by the shared assessment", async () => {
    const d = device({ online: false });
    const a = await duty(d, "on_duty", "k-a");
    d.clock.set(new Date("2026-10-20T13:10:00.000Z"));                  // set back 50 minutes
    const b = await duty(d, "off_duty", "k-b");
    expect([a.event.deviceSequence, b.event.deviceSequence]).toEqual([0, 1]);
    expect(b.event.eventAtMs).toBe(Date.parse("2026-10-20T13:10:00.000Z"));
    expect(b.event.previousEventHash).toBe(a.eventHash);
    expect((await d.outbox.integrity()).timingInconsistencies).toEqual([{ eventRef: b.event.eventRef, deviceSequence: 1, eventAt: "2026-10-20T13:10:00.000Z", previousEventAt: "2026-10-20T14:00:00.000Z" }]);
    d.connectivity.isOnline = true;
    expect(await d.outbox.flush()).toMatchObject({ accepted: 2 });
  });

  it("24. events either side of midnight, sent hours later, keep the device's own times", async () => {
    const d = device({ online: false, clock: new SettableClock(new Date("2026-10-21T05:59:00.000Z")) });   // 23:59 at −06:00
    const before = await duty(d, "on_duty", "mid-a");
    d.clock.set(new Date("2026-10-21T06:01:00.000Z"));                                                      // 00:01
    const after = await duty(d, "off_duty", "mid-b");
    d.clock.set(new Date("2026-10-21T11:30:00.000Z")); d.connectivity.isOnline = true;                     // connection back hours later
    await d.outbox.flush();
    const sent = d.ledger.received[0]!.events;
    expect(sent.map(e => e.eventAtMs)).toEqual([Date.parse("2026-10-21T05:59:00.000Z"), Date.parse("2026-10-21T06:01:00.000Z")]);
    expect([before.event.eventUtcOffsetMinutes, after.event.eventUtcOffsetMinutes]).toEqual([-360, -360]);
  });

  it("25. across a daylight-saving change the device records each event's own offset; the sequence does not notice", async () => {
    const winnipeg = (at: Date) => {
      const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Winnipeg", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
      const g = (t: string) => Number(p.find(x => x.type === t)!.value);
      return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
    };
    const d = device({ online: false, clock: new SettableClock(new Date("2026-11-01T06:30:00.000Z")), utcOffsetMinutes: winnipeg });   // 01:30 CDT
    const cdt = await duty(d, "on_duty", "dst-a");
    d.clock.set(new Date("2026-11-01T07:30:00.000Z"));                                                                                   // 01:30 CST, an hour later
    const cst = await duty(d, "off_duty", "dst-b");
    expect([cdt.event.eventUtcOffsetMinutes, cst.event.eventUtcOffsetMinutes]).toEqual([-300, -360]);
    expect(cst.event.eventAtMs - cdt.event.eventAtMs).toBe(60 * 60_000);
    expect(cst.event.deviceSequence).toBe(cdt.event.deviceSequence + 1);
  });
});

describe("the commit is atomic", () => {
  it("30. a failed write commits nothing: the sequence does not advance, and the next event takes the same sequence", async () => {
    const d = device({ online: false });
    const a = await duty(d, "on_duty", "tx-a");
    d.store.failNextInsert = new Error("SQLITE_IOERR: disk I/O error");
    await expect(duty(d, "off_duty", "tx-b")).rejects.toThrow(/SQLITE_IOERR/);
    expect((await d.store.latestEvent(DEVICE))!.event.eventRef).toBe(a.event.eventRef);
    expect(await d.store.listEvents()).toHaveLength(1);
    const b = await duty(d, "off_duty", "tx-b");
    expect(b.event.deviceSequence).toBe(1);
    expect(b.event.previousEventHash).toBe(a.eventHash);
    expect(await d.outbox.integrity()).toMatchObject({ gaps: [], verifiedLinks: 1 });
  });

  it("an event committed just before a crash, with no delivery record yet, is pending — not lost", async () => {
    const d = device({ online: false });
    const e = await duty(d, "on_duty", "cr");
    expect(await d.store.getDelivery(e.event.eventRef)).toBeNull();
    const after = restart(d);
    expect(await after.outbox.status()).toMatchObject({ pending: 1 });
  });

  it("the in-memory store has the same insert-if-absent contract", async () => {
    const s = new MemoryEldEventStore();
    const e = (seq: number, ref: string) => ({ deviceRef: DEVICE, event: { eventRef: ref, deviceSequence: seq } } as unknown as LocalEldEvent);
    expect(await s.insertEvent(e(0, "00000000-0000-4000-8000-00000000000a"))).toBe("inserted");
    expect(await s.insertEvent(e(0, "00000000-0000-4000-8000-00000000000b"))).toBe("sequence_taken");
    expect(await s.insertEvent(e(1, "00000000-0000-4000-8000-00000000000A"))).toBe("event_ref_taken");
  });

  it("backs off 30 s, 1, 2, 4, 8 minutes, then holds at 15", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(eldRetryDelayMs)).toEqual([0, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
});
