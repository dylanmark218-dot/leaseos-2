/**
 * 0220 — the only writer of `eldEvents`.
 *
 * Routers do not insert ELD events. They authenticate the transport (signature, nonce, freshness)
 * and hand the enrolled device and the raw batch here. This module decides identity, tenancy,
 * idempotency and conflict, and writes the batch in one transaction.
 *
 * Identity is the enrolled device's, never the payload's:
 *   the organization is `fieldDevices.orgRef`;
 *   the operator is the device user's operator record, checked against that organization;
 *   a stated `unitNumber` must name a unit that exists and belongs to that organization.
 * There is no field in which a driver's name could arrive, and if there were it would not be read.
 *
 * Idempotency and conflict, per event, inside the transaction:
 *   same eventRef, same hashes                  → replayed (nothing written)
 *   same eventRef, different content            → the canonical row stays; a conflict row is written
 *   same (device, sequence), same hashes        → replayed (implies the same eventRef; see canonical form)
 *   same (device, sequence), different content  → the canonical row stays; a conflict row is written
 * The store never chooses the most recent copy. First accepted is canonical; every later
 * disagreement is evidence.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { eldEventIngestConflicts, eldEvents, operators, units, type EldEventRow } from "../../../drizzle/schema";
import type { Db, Tx } from "../dbTypes";
import { recordBelongsToOrganization } from "../coreRecordOwnership";
import type { LedgerEventLike } from "./hosProjection";
import { assessDeviceChain, prepareEldBatch, type BatchProblem, type ChainAssessment, type EldAppendReasonCode, type HashedEldEvent } from "./ledger";
import { ELD_SCALE } from "../../../shared/eld/eldEvent";

/** The device as the router loaded it. The store re-checks the facts it depends on; it does not trust the caller to have. */
export type EldAppendDevice = {
  id: number;
  deviceRef: string;
  userId: number;
  orgRef: string | null;
  status: "enrolled" | "active" | "suspended" | "revoked";
};

export type EldAppendArgs = {
  device: EldAppendDevice;
  /** The authenticated session user. The device must be enrolled to exactly this user. */
  claimedUserId: number;
  /** The raw events as submitted; validated and hashed here, not by the caller. */
  events: unknown[];
  receivedAt: Date;
  /** Where the batch came from, for the row (a package ref, a batch ref). */
  sourceRef?: string | null;
  /**
   * Runs inside the transaction after every row is written and before commit. The extension point
   * for anything that must live or die with the batch (a later outbox emission). A throw rolls the
   * whole batch back — which is also how the atomicity test proves there is no partial state.
   */
  withinTransaction?: (tx: Tx, written: EldEventRow[]) => Promise<void>;
};

export type EldEventOutcome = {
  eventRef: string;
  deviceSequence: number;
  outcome: "inserted" | "replayed" | "conflict";
  code: EldAppendReasonCode;
  /** The canonical row's id — the new one, or the one already on record. */
  eventId: number;
  eventHash: string;
  /** Set on a conflict: the evidence row that preserved the attempt. */
  conflictRef: string | null;
  detail: string;
};

export type EldAppendResult =
  | {
      state: "accepted";
      orgRef: string;
      operatorId: number | null;
      counts: { inserted: number; replayed: number; conflict: number };
      events: EldEventOutcome[];
      /** The device's chain as it stands after this batch. */
      integrity: ChainAssessment;
    }
  | { state: "refused"; code: EldAppendReasonCode; reason: string; problems: BatchProblem[] };

const refuse = (code: EldAppendReasonCode, reason: string, problems: BatchProblem[] = []): EldAppendResult => ({ state: "refused", code, reason, problems });
const conflictRef = () => `ELDC-${randomUUID().toUpperCase()}`;
const isDup = (e: unknown) => typeof e === "object" && e != null && (e as { code?: string }).code === "ER_DUP_ENTRY";

/**
 * Append a device's batch. Refusals are returned, not thrown, so a router can turn them into a
 * structured response the device acts on; only infrastructure failures throw.
 */
export async function appendEldEvents(db: Db, args: EldAppendArgs): Promise<EldAppendResult> {
  const d = args.device;
  if (d.userId !== args.claimedUserId) return refuse("device_not_callers", `Device ${d.deviceRef} is enrolled to another user`);
  if (!d.orgRef) return refuse("device_no_organization", `Device ${d.deviceRef} has no organization binding and must be re-enrolled`);
  if (d.status !== "active") return refuse("device_not_active", `Device ${d.deviceRef} is ${d.status}, not active`);
  const orgRef = d.orgRef;

  const prepared = prepareEldBatch(d.deviceRef, args.events);
  if (!prepared.ok) return refuse(prepared.problems[0]!.code, `${prepared.problems.length} event(s) refused; nothing was written`, prepared.problems);
  const batch = prepared.events;

  return db.transaction(async (tx) => {
    /* ---- identity: the device's user is the operator, and both belong to the device's org ---- */
    const opRows = await tx.select({ id: operators.id }).from(operators).where(eq(operators.userId, d.userId));
    if (opRows.length > 1) return refuse("operator_ambiguous", `User ${d.userId} has ${opRows.length} operator records; which one this log belongs to has to be established, not guessed`);
    let operatorId: number | null = opRows[0]?.id ?? null;
    if (operatorId != null && !(await recordBelongsToOrganization(tx, orgRef, "operator", operatorId))) {
      return refuse("operator_not_in_organization", `Operator ${operatorId} is not owned by organization ${orgRef}`);
    }
    if (operatorId == null && batch.some(h => h.input.dutyStatus != null)) {
      return refuse("operator_unresolved", `Device ${d.deviceRef} belongs to a user with no operator record; a duty status needs a driver`);
    }

    /* ---- units: named by number by the device, resolved and checked against the org, never assumed ---- */
    const unitNumbers = Array.from(new Set(batch.map(h => h.input.unitNumber).filter((u): u is string => u != null)));
    const unitIdByNumber = new Map<string, number>();
    if (unitNumbers.length) {
      for (const r of await tx.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(inArray(units.unitNumber, unitNumbers))) unitIdByNumber.set(r.unitNumber, r.id);
      // A unit refusal names the events that stated the unit (2d), so a device can hold exactly those
      // and resend the rest of the batch; nothing in the batch is written either way.
      const naming = (n: string, code: EldAppendReasonCode, detail: string): BatchProblem[] =>
        batch.filter(h => h.input.unitNumber === n).map(h => ({ eventRef: h.input.eventRef, deviceSequence: h.input.deviceSequence, code, detail }));
      for (const n of unitNumbers) {
        const id = unitIdByNumber.get(n);
        if (id == null) return refuse("unit_unknown", `Unit ${n} is not on record`, naming(n, "unit_unknown", `Unit ${n} is not on record`));
        if (!(await recordBelongsToOrganization(tx, orgRef, "unit", id))) return refuse("unit_not_in_organization", `Unit ${n} is not owned by organization ${orgRef}`, naming(n, "unit_not_in_organization", `Unit ${n} is not owned by this organization`));
      }
    }

    /* ---- the ledger ---- */
    const outcomes: EldEventOutcome[] = [];
    const written: EldEventRow[] = [];
    const counts = { inserted: 0, replayed: 0, conflict: 0 };

    const findByRef = async (ref: string) => (await tx.select().from(eldEvents).where(eq(eldEvents.eventRef, ref)).for("update"))[0] ?? null;
    const findBySeq = async (seq: number) => (await tx.select().from(eldEvents).where(and(eq(eldEvents.fieldDeviceId, d.id), eq(eldEvents.deviceSequence, seq))).for("update"))[0] ?? null;

    const recordConflict = async (h: HashedEldEvent, canonical: EldEventRow, kind: "event_ref" | "device_sequence"): Promise<EldEventOutcome> => {
      // Once per (canonical row, attempted hash): a re-sent conflicting copy is the same evidence.
      const prior = (await tx.select({ conflictRef: eldEventIngestConflicts.conflictRef }).from(eldEventIngestConflicts)
        .where(and(eq(eldEventIngestConflicts.canonicalEventId, canonical.id), eq(eldEventIngestConflicts.attemptedEventHash, h.eventHash))).limit(1))[0];
      let ref = prior?.conflictRef ?? null;
      if (!ref) {
        ref = conflictRef();
        try {
          await tx.insert(eldEventIngestConflicts).values({
            conflictRef: ref, orgRef, fieldDeviceId: d.id, collisionKind: kind,
            canonicalEventId: canonical.id, canonicalEventRef: canonical.eventRef, canonicalPayloadHash: canonical.payloadHash, canonicalEventHash: canonical.eventHash,
            attemptedEventRef: h.input.eventRef, attemptedDeviceSequence: h.input.deviceSequence, attemptedCanonicalJson: h.canonicalJson,
            attemptedPayloadHash: h.payloadHash, attemptedPreviousEventHash: h.input.previousEventHash, attemptedEventHash: h.eventHash, hashVersion: h.hashVersion,
            sourceKind: "field_device", sourceRef: args.sourceRef ?? null, submittedByUserId: args.claimedUserId, receivedAt: args.receivedAt,
          });
        } catch (e) {
          if (!isDup(e)) throw e;
          ref = (await tx.select({ conflictRef: eldEventIngestConflicts.conflictRef }).from(eldEventIngestConflicts)
            .where(and(eq(eldEventIngestConflicts.canonicalEventId, canonical.id), eq(eldEventIngestConflicts.attemptedEventHash, h.eventHash))).limit(1))[0]?.conflictRef ?? ref;
        }
      }
      counts.conflict++;
      const code: EldAppendReasonCode = kind === "event_ref" ? "conflict_event_ref" : "conflict_device_sequence";
      return {
        eventRef: h.input.eventRef, deviceSequence: h.input.deviceSequence, outcome: "conflict", code, eventId: canonical.id, eventHash: canonical.eventHash, conflictRef: ref,
        detail: kind === "event_ref"
          ? `eventRef ${h.input.eventRef} is already on record with different content (on record ${canonical.eventHash}, attempted ${h.eventHash}); the record stands and the attempt is preserved as ${ref}`
          : `device sequence ${h.input.deviceSequence} is already on record as ${canonical.eventRef} with different content (on record ${canonical.eventHash}, attempted ${h.eventHash}); the record stands and the attempt is preserved as ${ref}`,
      };
    };

    const classifyExisting = async (h: HashedEldEvent): Promise<EldEventOutcome | null> => {
      const byRef = await findByRef(h.input.eventRef);
      if (byRef) {
        if (byRef.eventHash === h.eventHash && byRef.payloadHash === h.payloadHash) {
          counts.replayed++;
          return { eventRef: h.input.eventRef, deviceSequence: h.input.deviceSequence, outcome: "replayed", code: "replayed", eventId: byRef.id, eventHash: byRef.eventHash, conflictRef: null, detail: "already on record with identical content" };
        }
        return recordConflict(h, byRef, "event_ref");
      }
      const bySeq = await findBySeq(h.input.deviceSequence);
      if (bySeq) {
        // Same hashes would imply the same eventRef, which findByRef would have found; so this is a disagreement.
        return recordConflict(h, bySeq, "device_sequence");
      }
      return null;
    };

    for (const h of batch) {
      const existing = await classifyExisting(h);
      if (existing) { outcomes.push(existing); continue; }
      const e = h.input;
      // The canonical bytes are the record. The floating columns are derived from the fixed-scale
      // integers for querying and are never what integrity is checked against.
      const scaled = (v: number | null | undefined, scale: number) => (v == null ? null : v / scale);
      const values = {
        eventRef: e.eventRef, orgRef, fieldDeviceId: d.id, deviceSequence: e.deviceSequence,
        operatorId, unitId: e.unitNumber == null ? null : unitIdByNumber.get(e.unitNumber) ?? null,
        eventType: e.eventType, eventCode: e.eventCode ?? null, dutyStatus: e.dutyStatus ?? null,
        recordOrigin: e.recordOrigin, sourceKind: "field_device" as const, sourceRef: args.sourceRef ?? null,
        eventAt: new Date(e.eventAtMs), eventUtcOffsetMinutes: e.eventUtcOffsetMinutes ?? null, receivedAt: args.receivedAt,
        latitude: scaled(e.latitudeE7, ELD_SCALE.degreesE7), longitude: scaled(e.longitudeE7, ELD_SCALE.degreesE7),
        locationAccuracyM: scaled(e.locationAccuracyMm, ELD_SCALE.metresToMm), locationSource: e.locationSource ?? null,
        jurisdiction: e.jurisdiction ?? null, odometerKm: scaled(e.odometerM, ELD_SCALE.kmToM),
        engineHours: scaled(e.engineHoursMillis, ELD_SCALE.hoursToMillis), vehicleSpeedKph: scaled(e.vehicleSpeedKphMillis, ELD_SCALE.kphToMillis),
        annotation: e.annotation ?? null, supersedesEventRef: e.supersedesEventRef ?? null,
        canonicalJson: h.canonicalJson, payloadHash: h.payloadHash, previousEventHash: e.previousEventHash, eventHash: h.eventHash, hashVersion: h.hashVersion,
        submittedByUserId: args.claimedUserId,
      };
      let inserted: EldEventRow | null = null;
      try {
        const ins = await tx.insert(eldEvents).values(values);
        const id = Number(ins[0]?.insertId ?? 0);
        inserted = (await tx.select().from(eldEvents).where(eq(eldEvents.id, id)))[0] ?? null;
      } catch (err) {
        // A concurrent writer got there first. Classify against what it wrote rather than failing.
        if (!isDup(err)) throw err;
        const again = await classifyExisting(h);
        if (again) { outcomes.push(again); continue; }
        throw err;
      }
      if (!inserted) throw new Error("eldEvents insert returned no row");
      counts.inserted++;
      written.push(inserted);
      outcomes.push({ eventRef: e.eventRef, deviceSequence: e.deviceSequence, outcome: "inserted", code: "inserted", eventId: inserted.id, eventHash: inserted.eventHash, conflictRef: null, detail: "recorded" });
    }

    if (args.withinTransaction) await args.withinTransaction(tx, written);

    const chainRows = await tx.select({ eventRef: eldEvents.eventRef, deviceSequence: eldEvents.deviceSequence, eventAt: eldEvents.eventAt, previousEventHash: eldEvents.previousEventHash, eventHash: eldEvents.eventHash })
      .from(eldEvents).where(eq(eldEvents.fieldDeviceId, d.id));
    const integrity = assessDeviceChain(chainRows.map(r => ({ ...r, deviceSequence: Number(r.deviceSequence) })));
    return { state: "accepted", orgRef, operatorId, counts, events: outcomes, integrity };
  });
}

/** What one device's rows prove, as they stand. Read-only. */
export async function deviceLedgerIntegrity(db: Db, fieldDeviceId: number): Promise<ChainAssessment> {
  const rows = await db.select({ eventRef: eldEvents.eventRef, deviceSequence: eldEvents.deviceSequence, eventAt: eldEvents.eventAt, previousEventHash: eldEvents.previousEventHash, eventHash: eldEvents.eventHash })
    .from(eldEvents).where(eq(eldEvents.fieldDeviceId, fieldDeviceId));
  return assessDeviceChain(rows.map(r => ({ ...r, deviceSequence: Number(r.deviceSequence) })));
}

/**
 * The rows the HOS engine reads for one operator, inside one organization. Read-only.
 *
 * Three sets, because a window cut at `since` would otherwise lie about its own first hours:
 *   every row in [since, at];
 *   the last duty-status row before `since`, so a status already running when the window opens is
 *     counted from the window's start rather than dropped (the engine counts only the overlap);
 *   every row, at any time, that names one of the rows above in `supersedesEventRef`, so a
 *     correction recorded after the window still retracts what it names.
 * Scoped by `orgRef` on every query: an operator id from another organization reads as nothing.
 *
 * Also returns each device's sequence gaps as time spans, for the engine's HOS_DATA_GAP check: a gap
 * from sequence a to b runs from the event before a to the event after b, the narrowest span the
 * record can vouch for.
 */
export async function loadHosLedgerWindow(db: Db, args: { orgRef: string; operatorId: number; since: Date; at: Date }): Promise<{
  rows: LedgerEventLike[];
  chainGaps: { fieldDeviceId: number; fromSequence: number; toSequence: number; fromAt: Date | null; toAt: Date | null }[];
}> {
  const cols = {
    eventRef: eldEvents.eventRef, deviceSequence: eldEvents.deviceSequence, operatorId: eldEvents.operatorId, eventType: eldEvents.eventType,
    eventCode: eldEvents.eventCode, dutyStatus: eldEvents.dutyStatus, eventAt: eldEvents.eventAt, supersedesEventRef: eldEvents.supersedesEventRef,
    fieldDeviceId: eldEvents.fieldDeviceId,
  };
  const own = and(eq(eldEvents.orgRef, args.orgRef), eq(eldEvents.operatorId, args.operatorId));
  const inWindow = await db.select(cols).from(eldEvents).where(and(own, gte(eldEvents.eventAt, args.since), lte(eldEvents.eventAt, args.at)));
  const before = await db.select(cols).from(eldEvents)
    .where(and(own, lt(eldEvents.eventAt, args.since), isNotNull(eldEvents.dutyStatus)))
    .orderBy(desc(eldEvents.eventAt), desc(eldEvents.deviceSequence)).limit(1);
  const byRef = new Map<string, (typeof inWindow)[number]>();
  for (const r of [...before, ...inWindow]) byRef.set(r.eventRef, r);
  // Follow supersession forward: a correction recorded later can itself be retracted by a later one,
  // and leaving that second one out would make a retracted correction look active. Bounded, because a
  // chain longer than this is a device fault, not a correction history.
  let frontier = Array.from(byRef.keys());
  for (let depth = 0; frontier.length && depth < 16; depth++) {
    const naming = await db.select(cols).from(eldEvents).where(and(own, inArray(eldEvents.supersedesEventRef, frontier)));
    frontier = naming.filter(r => !byRef.has(r.eventRef)).map(r => r.eventRef);
    for (const r of naming) byRef.set(r.eventRef, r);
  }
  const all = Array.from(byRef.values());

  const devices = Array.from(new Set(all.map(r => r.fieldDeviceId).filter((d): d is number => d != null)));
  const chainGaps: { fieldDeviceId: number; fromSequence: number; toSequence: number; fromAt: Date | null; toAt: Date | null }[] = [];
  for (const fieldDeviceId of devices) {
    const chain = await db.select({ eventRef: eldEvents.eventRef, deviceSequence: eldEvents.deviceSequence, eventAt: eldEvents.eventAt, previousEventHash: eldEvents.previousEventHash, eventHash: eldEvents.eventHash })
      .from(eldEvents).where(and(eq(eldEvents.orgRef, args.orgRef), eq(eldEvents.fieldDeviceId, fieldDeviceId)));
    const atBySeq = new Map(chain.map(c => [Number(c.deviceSequence), c.eventAt] as const));
    for (const g of assessDeviceChain(chain.map(c => ({ ...c, deviceSequence: Number(c.deviceSequence) }))).gaps) {
      chainGaps.push({ fieldDeviceId, fromSequence: g.from, toSequence: g.to, fromAt: atBySeq.get(g.from - 1) ?? null, toAt: atBySeq.get(g.to + 1) ?? null });
    }
  }
  return {
    rows: all.map(r => ({ eventRef: r.eventRef, deviceSequence: r.deviceSequence == null ? null : Number(r.deviceSequence), operatorId: r.operatorId, eventType: r.eventType, eventCode: r.eventCode, dutyStatus: r.dutyStatus, eventAt: r.eventAt, supersedesEventRef: r.supersedesEventRef })),
    chainGaps,
  };
}
