/**
 * Fleet & Equipment Portfolio — reads and narrow, audited writes over a unit's holds, meters and state.
 *
 * Foundation slice (docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md). The Mechanic Portal
 * consumes these functions rather than keeping holds, meters or unit state of its own (owner decisions
 * 2026-09-25): checkpoint 2 places a hold with `sourceKind: "defect"` through `placeHold`, releases it
 * through `releaseHold`, and reads the unit through `operationalStateFor`.
 *
 * Every function here takes a unit the caller has already scoped; the router does the scoping.
 */
import { and, desc, eq, inArray, isNotNull, or as sqlOr } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  faultCodes, fleetPortfolioEvents, fuelTransactions, maintenanceDefects, roadsideServiceEvents, telemetrySnapshots,
  tireInstallations, tireMeasurements, trips, unitHolds, unitMeterReadings, workOrderReleases, workOrders,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { meterSequence, METER_TYPES, type MeterObservation, type MeterType, type Standing } from "./_core/fleetMeters";
import { operationalState, type HoldEffect, type HoldType, type OperationalState, type PortfolioFacts } from "./_core/fleetPortfolio";
import { loadEnforcementState } from "./readinessComposer";

export const fleetRef = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(5).toString("hex").toUpperCase()}`;

/** An organization's rows carry its orgRef; the historical single tenant's carry NULL (0132). */
export const orgRefOf = (tenantId: string) => (tenantId === "default" ? null : tenantId);

type EventType = typeof fleetPortfolioEvents.$inferInsert["eventType"];
export async function appendEvent(db: DbOrTx, e: { orgRef: string | null; unitId: number; subjectType: string; subjectRef: string; eventType: EventType; previousState?: string | null; newState?: string | null; detail?: string | null; actorUserId: number | null; actorRole: string | null; at?: Date }) {
  await db.insert(fleetPortfolioEvents).values({
    eventRef: fleetRef("FPE"), orgRef: e.orgRef, unitId: e.unitId, subjectType: e.subjectType, subjectRef: e.subjectRef,
    eventType: e.eventType, previousState: e.previousState ?? null, newState: e.newState ?? null, detail: e.detail?.slice(0, 600) ?? null,
    actorUserId: e.actorUserId, actorRole: e.actorRole, occurredAt: e.at ?? new Date(),
  });
}

/* ------------------------------------------------------------------ */
/* Meters: read where they live                                        */
/* ------------------------------------------------------------------ */

/** Per source, the newest this many rows are read. A unit on telemetry reports many times a day. */
const PER_SOURCE = 2000;

/**
 * Every meter observation on one unit, from every place LeaseOS keeps one, each naming where it lives.
 * Nothing is copied. An observation whose time is not recorded is left out rather than guessed.
 */
export async function meterObservations(db: DbOrTx, unitId: number): Promise<(MeterObservation & { ledger?: { verificationStatus: string; enteredByUserId: number; confidence: string; note: string | null; sourceRef: string | null } })[]> {
  const out: (MeterObservation & { ledger?: { verificationStatus: string; enteredByUserId: number; confidence: string; note: string | null; sourceRef: string | null } })[] = [];
  const add = (o: Omit<MeterObservation, "ref" | "value" | "recordedAt"> & { value: number | null | undefined; recordedAt: Date | null | undefined }, extra?: object) => {
    if (o.value == null || !Number.isFinite(o.value) || !o.recordedAt) return;
    out.push({ ...o, value: o.value, recordedAt: o.recordedAt, ref: `${o.sourceTable}#${o.sourceId}.${o.sourceField}`, ...(extra ?? {}) });
  };
  const accepted: Standing = "accepted";

  const [ledger, telemetry, wos, fuel, tripRows, installs, measures] = await Promise.all([
    db.select().from(unitMeterReadings).where(eq(unitMeterReadings.unitId, unitId)).orderBy(desc(unitMeterReadings.recordedAt)).limit(PER_SOURCE),
    db.select().from(telemetrySnapshots).where(eq(telemetrySnapshots.unitId, unitId)).orderBy(desc(telemetrySnapshots.recordedAt)).limit(PER_SOURCE),
    db.select().from(workOrders).where(and(eq(workOrders.unitId, unitId), sqlOr(isNotNull(workOrders.odometerKm), isNotNull(workOrders.engineHours)))).orderBy(desc(workOrders.openedAt)).limit(PER_SOURCE),
    db.select().from(fuelTransactions).where(and(eq(fuelTransactions.unitId, unitId), sqlOr(isNotNull(fuelTransactions.odometerKm), isNotNull(fuelTransactions.engineHours)))).orderBy(desc(fuelTransactions.occurredAt)).limit(PER_SOURCE),
    db.select().from(trips).where(and(eq(trips.unitId, unitId), sqlOr(isNotNull(trips.odometerStartKm), isNotNull(trips.odometerEndKm)))).orderBy(desc(trips.id)).limit(PER_SOURCE),
    db.select().from(tireInstallations).where(eq(tireInstallations.unitId, unitId)).orderBy(desc(tireInstallations.installedAt)).limit(PER_SOURCE),
    db.select({ m: tireMeasurements }).from(tireMeasurements).innerJoin(tireInstallations, eq(tireInstallations.id, tireMeasurements.installationId))
      .where(and(eq(tireInstallations.unitId, unitId), isNotNull(tireMeasurements.odometerKm))).orderBy(desc(tireMeasurements.measuredAt)).limit(PER_SOURCE),
  ]);

  for (const r of ledger) {
    const standing: Standing = r.verificationStatus === "verified" ? "accepted" : r.verificationStatus === "rejected" ? "rejected" : "provisional";
    add({ meterType: r.meterType, value: r.reading, recordedAt: r.recordedAt, source: "ledger", standing, sourceTable: "unitMeterReadings", sourceId: r.id, sourceField: "reading", ledgerSource: r.source },
      { ledger: { verificationStatus: r.verificationStatus, enteredByUserId: r.enteredByUserId, confidence: r.confidence, note: r.note, sourceRef: r.sourceRef } });
  }
  for (const s of telemetry) {
    add({ meterType: "odometer_km", value: s.odometerKm, recordedAt: s.recordedAt, source: "telematics", standing: accepted, sourceTable: "telemetrySnapshots", sourceId: s.id, sourceField: "odometerKm" });
    add({ meterType: "engine_hours", value: s.engineHours, recordedAt: s.recordedAt, source: "telematics", standing: accepted, sourceTable: "telemetrySnapshots", sourceId: s.id, sourceField: "engineHours" });
    add({ meterType: "pto_hours", value: s.ptoHours, recordedAt: s.recordedAt, source: "telematics", standing: accepted, sourceTable: "telemetrySnapshots", sourceId: s.id, sourceField: "ptoHours" });
  }
  for (const w of wos) {
    add({ meterType: "odometer_km", value: w.odometerKm, recordedAt: w.openedAt, source: "work_order", standing: accepted, sourceTable: "workOrders", sourceId: w.id, sourceField: "odometerKm" });
    add({ meterType: "engine_hours", value: w.engineHours, recordedAt: w.openedAt, source: "work_order", standing: accepted, sourceTable: "workOrders", sourceId: w.id, sourceField: "engineHours" });
  }
  for (const f of fuel) {
    add({ meterType: "odometer_km", value: f.odometerKm, recordedAt: f.occurredAt, source: "fuel_receipt", standing: accepted, sourceTable: "fuelTransactions", sourceId: f.id, sourceField: "odometerKm" });
    add({ meterType: "engine_hours", value: f.engineHours, recordedAt: f.occurredAt, source: "fuel_receipt", standing: accepted, sourceTable: "fuelTransactions", sourceId: f.id, sourceField: "engineHours" });
  }
  for (const t of tripRows) {
    // A trip's odometer is read at the trip's own recorded start and completion. Without those times
    // the reading's moment is unknown, and an observation of unknown time cannot be put in sequence.
    add({ meterType: "odometer_km", value: t.odometerStartKm, recordedAt: t.startedAt, source: "trip", standing: accepted, sourceTable: "trips", sourceId: t.id, sourceField: "odometerStartKm" });
    add({ meterType: "odometer_km", value: t.odometerEndKm, recordedAt: t.completedAt, source: "trip", standing: accepted, sourceTable: "trips", sourceId: t.id, sourceField: "odometerEndKm" });
  }
  for (const i of installs) {
    add({ meterType: "odometer_km", value: i.installOdometerKm, recordedAt: i.installedAt, source: "tire_service", standing: accepted, sourceTable: "tireInstallations", sourceId: i.id, sourceField: "installOdometerKm" });
    add({ meterType: "odometer_km", value: i.removeOdometerKm, recordedAt: i.removedAt, source: "tire_service", standing: accepted, sourceTable: "tireInstallations", sourceId: i.id, sourceField: "removeOdometerKm" });
  }
  for (const { m } of measures) {
    add({ meterType: "odometer_km", value: m.odometerKm, recordedAt: m.measuredAt, source: "tire_service", standing: accepted, sourceTable: "tireMeasurements", sourceId: m.id, sourceField: "odometerKm" });
  }
  return out;
}

/** The sequence of every meter type that has at least one observation. */
export async function meterSequencesFor(db: DbOrTx, unitId: number) {
  const obs = await meterObservations(db, unitId);
  const present = new Set(obs.map(o => o.meterType));
  return { observations: obs, sequences: METER_TYPES.filter(t => present.has(t)).map(t => meterSequence(obs, t)) };
}

/* ------------------------------------------------------------------ */
/* Holds                                                               */
/* ------------------------------------------------------------------ */

export async function activeHolds(db: DbOrTx, unitId: number) {
  return db.select().from(unitHolds).where(and(eq(unitHolds.unitId, unitId), eq(unitHolds.status, "active"))).orderBy(unitHolds.placedAt);
}

export type PlaceHold = {
  unitId: number; orgRef: string | null; holdType: HoldType; effect: HoldEffect; reason: string;
  sourceKind: typeof unitHolds.$inferInsert["sourceKind"]; sourceRef?: string | null; evidenceRecordId?: number | null;
  byUserId: number; byRole: string;
};

/** Place a hold and its history event, together or not at all. */
export async function placeHold(db: DbOrTx, h: PlaceHold): Promise<string> {
  const holdRef = fleetRef("HOLD");
  const at = new Date();
  const write = async (tx: DbOrTx) => {
    await tx.insert(unitHolds).values({
      holdRef, orgRef: h.orgRef, unitId: h.unitId, holdType: h.holdType, dispatchEffect: h.effect, reason: h.reason,
      sourceKind: h.sourceKind ?? "manual", sourceRef: h.sourceRef ?? null, evidenceRecordId: h.evidenceRecordId ?? null,
      placedByUserId: h.byUserId, placedByRole: h.byRole, placedAt: at,
    });
    await appendEvent(tx, { orgRef: h.orgRef, unitId: h.unitId, subjectType: "hold", subjectRef: holdRef, eventType: "hold_placed", newState: `active:${h.effect}`, detail: `${h.holdType} (${h.sourceKind ?? "manual"}${h.sourceRef ? ` ${h.sourceRef}` : ""}): ${h.reason}`, actorUserId: h.byUserId, actorRole: h.byRole, at });
  };
  if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  return holdRef;
}

/**
 * Release one active hold, once. Conditional on `status = 'active'`, so two people releasing at once
 * cannot both succeed; the loser learns it was released a moment ago.
 */
export async function releaseHold(db: DbOrTx, r: { hold: typeof unitHolds.$inferSelect; byUserId: number; byRole: string; reason: string; evidenceRecordId?: number | null }): Promise<boolean> {
  const at = new Date();
  let released = false;
  const write = async (tx: DbOrTx) => {
    const res = await tx.update(unitHolds).set({ status: "released", releasedAt: at, releasedByUserId: r.byUserId, releasedByRole: r.byRole, releaseReason: r.reason, releaseEvidenceRecordId: r.evidenceRecordId ?? null })
      .where(and(eq(unitHolds.id, r.hold.id), eq(unitHolds.status, "active")));
    released = (res as unknown as [{ affectedRows: number }])[0]?.affectedRows === 1;
    if (!released) return;
    await appendEvent(tx, { orgRef: r.hold.orgRef, unitId: r.hold.unitId, subjectType: "hold", subjectRef: r.hold.holdRef, eventType: "hold_released", previousState: `active:${r.hold.dispatchEffect}`, newState: "released", detail: r.reason, actorUserId: r.byUserId, actorRole: r.byRole, at });
  };
  if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  return released;
}

/* ------------------------------------------------------------------ */
/* The unit's state                                                    */
/* ------------------------------------------------------------------ */

/**
 * The facts the projection reads — the same records, with the same filters, the readiness composer
 * reads. A source that cannot be read is reported, and the state becomes indeterminate.
 */
export async function portfolioFacts(db: DbOrTx, unitId: number): Promise<PortfolioFacts> {
  const unreadable: string[] = [];
  const attempt = async <T>(name: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try { return await read(); } catch { unreadable.push(name); return empty; }
  };
  const [holds, defects, releases, roadside, faults, enforcement, meters] = await Promise.all([
    attempt("unitHolds", () => activeHolds(db, unitId), []),
    attempt("maintenanceDefects", () => db.select().from(maintenanceDefects).where(and(eq(maintenanceDefects.unitId, unitId), sqlOr(inArray(maintenanceDefects.status, ["open", "in_progress"]), eq(maintenanceDefects.severity, "critical")))), []),
    attempt("workOrderReleases", () => db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, unitId)).orderBy(desc(workOrderReleases.releasedAt)), []),
    attempt("roadsideServiceEvents", () => db.select().from(roadsideServiceEvents).where(and(eq(roadsideServiceEvents.unitId, unitId), inArray(roadsideServiceEvents.status, ["open", "vendor_assigned", "in_repair", "repaired_awaiting_release"]))), []),
    attempt("faultCodes", () => db.select().from(faultCodes).where(and(eq(faultCodes.unitId, unitId), inArray(faultCodes.status, ["active", "acknowledged"]))), []),
    // A unit may be a tractor or a trailer; an order may name it either way.
    attempt("outOfServiceOrders", () => loadEnforcementState(db, { unitId, trailerId: unitId, operatorId: null }), null),
    attempt("meters", async () => (await meterSequencesFor(db, unitId)).sequences, []),
  ]);
  const mine = new Set([`unit:${unitId}`, `trailer:${unitId}`]);
  return {
    holds: holds.map(h => ({ holdRef: h.holdRef, holdType: h.holdType, dispatchEffect: h.dispatchEffect, reason: h.reason, placedAt: h.placedAt, sourceKind: h.sourceKind, sourceRef: h.sourceRef })),
    defects: defects.map(d => ({ id: d.id, title: d.title, severity: d.severity, status: d.status, resolvedByReleaseId: d.resolvedByReleaseId, reportedAt: d.reportedAt })),
    releases: releases.map(r => ({ id: r.id, workOrderId: r.workOrderId, releaseType: r.releaseType, testResult: r.testResult, resolvedDefectIds: r.resolvedDefectIds, releasedAt: r.releasedAt, restrictionDetail: r.restrictionDetail })),
    activeOrders: (enforcement?.orders ?? []).filter(o => mine.has(o.subjectRef) && (o.scope === "vehicle" || o.scope === "trailer"))
      .map(o => ({ orderRef: o.orderRef, scope: o.scope, issuedAt: o.issuedAt ?? null, issuingAgency: o.issuingAgency ?? null })),
    unestablishedInspections: (enforcement?.unresolvedInspections ?? []).filter(i => i.coversSubjectRefs.some(r => mine.has(r))).map(i => ({ inspectionRef: i.inspectionRef })),
    openRoadside: roadside.map(r => ({ eventRef: r.eventRef, status: r.status, occurredAt: r.occurredAt })),
    faults: faults.map(f => ({ id: f.id, code: f.code, status: f.status, severityDetermination: f.severityDetermination, occurrenceCount: f.occurrenceCount, lastSeenAt: f.lastSeenAt })),
    meters: meters.map(m => ({ meterType: m.meterType, trust: m.trust, regressions: m.regressions })),
    unreadable,
  };
}

/** The unit's operational state — the one the mechanic portal, the driver card and the passport read. */
export async function operationalStateFor(db: DbOrTx, unitId: number): Promise<OperationalState> {
  return operationalState(await portfolioFacts(db, unitId));
}

export type { MeterType };
