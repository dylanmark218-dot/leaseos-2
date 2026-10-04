/**
 * Analytics Checkpoint B — where each metric's rows come from.
 *
 * One resolver per registered metric. Each takes the caller's scope and returns the qualifying rows
 * and what it could not place; `metricContract.aggregate` turns the rows into the value. Nothing here
 * computes a number a screen shows — it only decides which records qualify.
 *
 * Every read goes through a scope rule that already existed before analytics did:
 *
 *   trips, dispatchEligibilityChecks   orgScopeWhere (orgRef; NULL = historical single tenant)
 *   units and everything keyed to one  ownershipScopeWhere("unit")  — defects, work orders, inspections
 *   dutyRecords                        ownershipScopeWhere("operator")
 *   complianceDocuments                complianceDocumentScopeWhere — the listComplianceDocuments rule
 *   incidentReports, nearMissReports   jobUnitOperatorScopeWhere    — the incidentInScope rule
 *
 * A table with no scope rule is not read. The registry test holds `sources` to this list.
 *
 * Nothing here decides a rule the tree already decides: whether a document is in force is
 * `complianceDocumentValidity` (over `documentValidity`), not a date comparison written again here.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  complianceDocuments, dispatchEligibilityChecks, dutyRecords, incidentReports, inspections, jobs,
  maintenanceDefects, nearMissReports, operators, trips, units, workOrders,
} from "../../../drizzle/schema";
import {
  complianceDocumentScopeWhere, getDb, jobScopeSubquery, jobUnitOperatorScopeWhere, orgScopeWhere,
  ownershipScopeWhere, type TenantScope,
} from "../../db";
import { documentExpiry, type ComplianceDocumentRow } from "../complianceDocumentValidity";
import type { ValidityState } from "../documentValidity";
import { ROW_CAP, overlapMinutes, type DrillRow, type FilterKey, type SourceAnswer, type Unknown } from "./metricContract";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type ResolveInput = {
  scope: TenantScope;
  /** The resolved range. Ignored by `current` metrics. */
  from: Date;
  to: Date;
  now: Date;
  filters: Partial<Record<FilterKey, number>>;
};
type Resolver = (db: Db, input: ResolveInput) => Promise<SourceAnswer>;

const IN_PROGRESS = ["loading", "in_transit", "unloading"] as const;
const OPEN_DEFECT = ["open", "in_progress"] as const;
const OPEN_WORK_ORDER = ["open", "in_progress", "waiting_parts", "ready_for_service"] as const;
/** The engine's default notice period (`documentValidity.validityOf`), stated once. */
export const DOCUMENT_NOTICE_DAYS = 30;

const HOUR = 3_600_000;

/** Read one more than the cap, so the answer can say it stopped rather than pass a cut list as whole. */
function capped<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > ROW_CAP ? { rows: rows.slice(0, ROW_CAP), truncated: true } : { rows, truncated: false };
}
const where = (...parts: (SQL | undefined)[]) => and(...parts.filter((p): p is SQL => p !== undefined));
const opt = <T>(v: T | undefined, f: (v: T) => SQL) => (v === undefined ? undefined : f(v));
const unknown = (reason: string, count: number): Unknown => ({ reason, count });

/* ------------------------------------------------------------------ trips */

type TripRow = { id: number; tripNumber: string; status: string; jobId: number | null; unitId: number | null; operatorId: number | null; startedAt: Date | null; completedAt: Date | null };

function tripFilters(f: ResolveInput["filters"]) {
  return [
    opt(f.unitId, v => eq(trips.unitId, v)),
    opt(f.operatorId, v => eq(trips.operatorId, v)),
    opt(f.jobId, v => eq(trips.jobId, v)),
  ];
}
const tripCols = {
  id: trips.id, tripNumber: trips.tripNumber, status: trips.status, jobId: trips.jobId,
  unitId: trips.unitId, operatorId: trips.operatorId, startedAt: trips.startedAt, completedAt: trips.completedAt,
};
const tripRow = (t: TripRow, at: Date | null): DrillRow => ({
  key: `trip:${t.id}`,
  record: { table: "trips", id: t.id, ref: t.tripNumber },
  label: `Trip ${t.tripNumber}`,
  at,
  fields: { status: t.status, jobId: t.jobId, unitId: t.unitId, operatorId: t.operatorId },
});

async function tripsInProgress(db: Db, i: ResolveInput) {
  return capped(await db.select(tripCols).from(trips)
    .where(where(orgScopeWhere(trips, i.scope), inArray(trips.status, [...IN_PROGRESS]), ...tripFilters(i.filters)))
    .orderBy(asc(trips.id)).limit(ROW_CAP + 1));
}

const tripsInProgressResolver: Resolver = async (db, i) => {
  const { rows, truncated } = await tripsInProgress(db, i);
  return { rows: rows.map(t => tripRow(t, t.startedAt)), unknowns: [], truncated };
};

const tripsCompletedResolver: Resolver = async (db, i) => {
  const scoped = where(orgScopeWhere(trips, i.scope), eq(trips.status, "complete"), ...tripFilters(i.filters));
  const { rows, truncated } = capped(await db.select(tripCols).from(trips)
    .where(where(scoped, isNotNull(trips.completedAt), gte(trips.completedAt, i.from), lt(trips.completedAt, i.to)))
    .orderBy(asc(trips.completedAt), asc(trips.id)).limit(ROW_CAP + 1));
  const unplaced = await db.select({ id: trips.id }).from(trips).where(where(scoped, isNull(trips.completedAt)));
  return {
    rows: rows.map(t => tripRow(t, t.completedAt)),
    unknowns: [unknown("Trips marked complete with no completedAt, which no range can place", unplaced.length)],
    truncated,
  };
};

/** Names for ids, but only for records the scope may see; anything else keeps its bare id. */
async function unitNumbers(db: Db, ids: number[], scope: TenantScope): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const r = await db.select({ id: units.id, n: units.unitNumber }).from(units).where(and(inArray(units.id, ids), ownershipScopeWhere("unit", units.id, scope)));
  return new Map(r.map(x => [x.id, x.n]));
}
async function operatorNames(db: Db, ids: number[], scope: TenantScope): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const r = await db.select({ id: operators.id, n: operators.name }).from(operators).where(and(inArray(operators.id, ids), ownershipScopeWhere("operator", operators.id, scope)));
  return new Map(r.map(x => [x.id, x.n]));
}

const jobsWithTripResolver: Resolver = async (db, i) => {
  const { rows: live, truncated } = await tripsInProgress(db, i);
  const jobIds = Array.from(new Set(live.map(t => t.jobId).filter((v): v is number => v !== null)));
  const visible = jobIds.length
    ? await db.select({ id: jobs.id, jobCode: jobs.jobCode, customer: jobs.customer }).from(jobs).where(and(inArray(jobs.id, jobIds), orgScopeWhere(jobs, i.scope))).orderBy(asc(jobs.id))
    : [];
  const byId = new Map(visible.map(j => [j.id, j]));
  const tripsPer = new Map<number, number>();
  for (const t of live) if (t.jobId !== null) tripsPer.set(t.jobId, (tripsPer.get(t.jobId) ?? 0) + 1);
  return {
    rows: visible.map(j => ({
      key: `job:${j.id}`, record: { table: "jobs", id: j.id, ref: j.jobCode }, label: `Job ${j.jobCode}`, at: null,
      fields: { customer: j.customer, tripsInProgress: tripsPer.get(j.id) ?? 0 },
    })),
    unknowns: [
      unknown("Trips in progress that name no job", live.filter(t => t.jobId === null).length),
      unknown("Trips in progress naming a job this organization cannot see", jobIds.filter(id => !byId.has(id)).length),
    ],
    truncated,
  };
};

const driversOnTripResolver: Resolver = async (db, i) => {
  const { rows: live, truncated } = await tripsInProgress(db, i);
  const ids = Array.from(new Set(live.map(t => t.operatorId).filter((v): v is number => v !== null))).sort((a, b) => a - b);
  const names = await operatorNames(db, ids, i.scope);
  return {
    rows: ids.map(id => ({
      key: `operator:${id}`, record: { table: "operators", id, ref: null }, label: names.get(id) ?? `Operator ${id}`, at: null,
      fields: { trips: live.filter(t => t.operatorId === id).map(t => t.tripNumber).join(", ") },
    })),
    unknowns: [unknown("Trips in progress that name no driver", live.filter(t => t.operatorId === null).length)],
    truncated,
  };
};

const unitsOnTripResolver: Resolver = async (db, i) => {
  const { rows: live, truncated } = await tripsInProgress(db, i);
  const ids = Array.from(new Set(live.map(t => t.unitId).filter((v): v is number => v !== null))).sort((a, b) => a - b);
  const numbers = await unitNumbers(db, ids, i.scope);
  return {
    rows: ids.map(id => ({
      key: `unit:${id}`, record: { table: "units", id, ref: numbers.get(id) ?? null }, label: numbers.has(id) ? `Unit ${numbers.get(id)}` : `Unit ${id}`, at: null,
      fields: { trips: live.filter(t => t.unitId === id).map(t => t.tripNumber).join(", ") },
    })),
    unknowns: [unknown("Trips in progress that name no unit", live.filter(t => t.unitId === null).length)],
    truncated,
  };
};

/* ------------------------------------------------------------------ fleet */

const unitsRegisteredResolver: Resolver = async (db, i) => {
  const { rows, truncated } = capped(await db.select({ id: units.id, unitNumber: units.unitNumber, vehicleType: units.vehicleType })
    .from(units).where(ownershipScopeWhere("unit", units.id, i.scope)).orderBy(asc(units.id)).limit(ROW_CAP + 1));
  return {
    rows: rows.map(u => ({ key: `unit:${u.id}`, record: { table: "units", id: u.id, ref: u.unitNumber }, label: `Unit ${u.unitNumber}`, at: null, fields: { vehicleType: u.vehicleType } })),
    unknowns: [],
    truncated,
  };
};

function inspectionResolver(failedOnly: boolean): Resolver {
  return async (db, i) => {
    const { rows, truncated } = capped(await db.select({
      id: inspections.id, unitId: inspections.unitId, type: inspections.type, status: inspections.status,
      observedAt: inspections.observedAt, operatorId: inspections.authenticatedOperatorId,
    }).from(inspections).where(where(
      ownershipScopeWhere("unit", inspections.unitId, i.scope),
      gte(inspections.observedAt, i.from), lt(inspections.observedAt, i.to),
      failedOnly ? inArray(inspections.status, ["fail", "needs_maintenance"]) : undefined,
      opt(i.filters.unitId, v => eq(inspections.unitId, v)),
      opt(i.filters.operatorId, v => eq(inspections.authenticatedOperatorId, v)),
    )).orderBy(asc(inspections.observedAt), asc(inspections.id)).limit(ROW_CAP + 1));
    return {
      rows: rows.map(r => ({
        key: `inspection:${r.id}`, record: { table: "inspections", id: r.id, ref: null },
        label: `${r.type.replace("_", "-")} inspection, unit ${r.unitId}`, at: r.observedAt,
        fields: { unitId: r.unitId, type: r.type, status: r.status, operatorId: r.operatorId },
      })),
      unknowns: [],
      truncated,
    };
  };
}

/* ------------------------------------------------------------------ maintenance */

function defectResolver(kind: "open" | "critical_open" | "reported"): Resolver {
  return async (db, i) => {
    const { rows, truncated } = capped(await db.select({
      id: maintenanceDefects.id, unitId: maintenanceDefects.unitId, title: maintenanceDefects.title,
      severity: maintenanceDefects.severity, status: maintenanceDefects.status, reportedAt: maintenanceDefects.reportedAt,
    }).from(maintenanceDefects).where(where(
      ownershipScopeWhere("unit", maintenanceDefects.unitId, i.scope),
      kind === "reported" ? and(gte(maintenanceDefects.reportedAt, i.from), lt(maintenanceDefects.reportedAt, i.to)) : inArray(maintenanceDefects.status, [...OPEN_DEFECT]),
      kind === "critical_open" ? eq(maintenanceDefects.severity, "critical") : undefined,
      opt(i.filters.unitId, v => eq(maintenanceDefects.unitId, v)),
    )).orderBy(asc(maintenanceDefects.reportedAt), asc(maintenanceDefects.id)).limit(ROW_CAP + 1));
    return {
      rows: rows.map(d => ({
        key: `defect:${d.id}`, record: { table: "maintenanceDefects", id: d.id, ref: null }, label: d.title, at: d.reportedAt,
        fields: { unitId: d.unitId, severity: d.severity, status: d.status },
      })),
      unknowns: [],
      truncated,
    };
  };
}

const workOrdersOpenResolver: Resolver = async (db, i) => {
  const { rows, truncated } = capped(await db.select({
    id: workOrders.id, number: workOrders.workOrderNumber, unitId: workOrders.unitId, status: workOrders.status,
    priority: workOrders.priority, openedAt: workOrders.openedAt,
  }).from(workOrders).where(where(
    ownershipScopeWhere("unit", workOrders.unitId, i.scope),
    inArray(workOrders.status, [...OPEN_WORK_ORDER]),
    opt(i.filters.unitId, v => eq(workOrders.unitId, v)),
  )).orderBy(asc(workOrders.openedAt), asc(workOrders.id)).limit(ROW_CAP + 1));
  return {
    rows: rows.map(w => ({
      key: `workOrder:${w.id}`, record: { table: "workOrders", id: w.id, ref: w.number }, label: `Work order ${w.number}`, at: w.openedAt,
      fields: { unitId: w.unitId, status: w.status, priority: w.priority },
    })),
    unknowns: [],
    truncated,
  };
};

const repairHoursResolver: Resolver = async (db, i) => {
  const scoped = where(ownershipScopeWhere("unit", workOrders.unitId, i.scope), eq(workOrders.status, "closed"), opt(i.filters.unitId, v => eq(workOrders.unitId, v)));
  const { rows, truncated } = capped(await db.select({
    id: workOrders.id, number: workOrders.workOrderNumber, unitId: workOrders.unitId, openedAt: workOrders.openedAt, completedAt: workOrders.completedAt,
  }).from(workOrders).where(where(scoped, isNotNull(workOrders.completedAt), gte(workOrders.completedAt, i.from), lt(workOrders.completedAt, i.to)))
    .orderBy(asc(workOrders.completedAt), asc(workOrders.id)).limit(ROW_CAP + 1));
  const unplaced = await db.select({ id: workOrders.id }).from(workOrders).where(where(scoped, isNull(workOrders.completedAt)));
  const backwards = rows.filter(w => w.completedAt!.getTime() < w.openedAt.getTime());
  return {
    rows: rows.filter(w => !backwards.includes(w)).map(w => ({
      key: `workOrder:${w.id}`, record: { table: "workOrders", id: w.id, ref: w.number }, label: `Work order ${w.number}`, at: w.completedAt,
      fields: { unitId: w.unitId, repairHours: Math.round(((w.completedAt!.getTime() - w.openedAt.getTime()) / HOUR) * 100) / 100 },
    })),
    unknowns: [
      unknown("Closed work orders with no completedAt (closed through shop.workOrderAdvance, which stamps no time), which no range can place", unplaced.length),
      unknown("Work orders completed before they were opened", backwards.length),
    ],
    truncated,
  };
};

/* ------------------------------------------------------------------ compliance */

function documentResolver(state: Extract<ValidityState, "expiring" | "expired" | "unverified">): Resolver {
  return async (db, i) => {
    const { rows, truncated } = capped(await db.select({
      id: complianceDocuments.id, ownerType: complianceDocuments.ownerType, ownerId: complianceDocuments.ownerId,
      docType: complianceDocuments.docType, title: complianceDocuments.title, issuedAt: complianceDocuments.issuedAt,
      expiresAt: complianceDocuments.expiresAt, verificationStatus: complianceDocuments.verificationStatus,
      capturedAt: complianceDocuments.capturedAt, privateDetail: complianceDocuments.privateDetail,
    }).from(complianceDocuments).where(where(
      complianceDocumentScopeWhere(i.scope),
      opt(i.filters.operatorId, v => and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, v))!),
      opt(i.filters.unitId, v => and(inArray(complianceDocuments.ownerType, ["unit", "trailer", "equipment"]), eq(complianceDocuments.ownerId, v))!),
    )).orderBy(asc(complianceDocuments.id)).limit(ROW_CAP + 1));

    const bySubject = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.ownerType}:${r.ownerId}`;
      const list = bySubject.get(k);
      if (list) list.push(r); else bySubject.set(k, [r]);
    }
    const out: DrillRow[] = [];
    for (const [subject, docs] of Array.from(bySubject.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      const [ownerType, ownerId] = [docs[0]!.ownerType, docs[0]!.ownerId];
      for (const v of documentExpiry(docs as ComplianceDocumentRow[], i.now, DOCUMENT_NOTICE_DAYS)) {
        if (v.state !== state) continue;
        // A private document is counted — it expires like any other — but what it is stays withheld.
        const isPrivate = docs.some(d => d.docType === v.docType && d.privateDetail);
        out.push({
          key: `document:${subject}:${isPrivate ? `private-${v.documentId}` : v.docType}`,
          record: { table: "complianceDocuments", id: v.documentId, ref: null },
          label: isPrivate ? `Private document — ${ownerType} ${ownerId}` : `${v.title} — ${ownerType} ${ownerId}`,
          at: v.expiresAt,
          fields: { ownerType, ownerId, docType: isPrivate ? "(withheld)" : v.docType, daysRemaining: v.daysRemaining, reason: isPrivate ? "withheld" : v.reason },
        });
      }
    }
    return { rows: out, unknowns: [], truncated };
  };
}

function readinessResolver(verdict: "blocked" | "unknown"): Resolver {
  return async (db, i) => {
    const { rows, truncated } = capped(await db.select({
      id: dispatchEligibilityChecks.id, operatorId: dispatchEligibilityChecks.operatorId, unitId: dispatchEligibilityChecks.unitId,
      jobId: dispatchEligibilityChecks.jobId, blockersJson: dispatchEligibilityChecks.blockersJson, evaluatedAt: dispatchEligibilityChecks.evaluatedAt,
      usedForAward: dispatchEligibilityChecks.usedForAward,
    }).from(dispatchEligibilityChecks).where(where(
      orgScopeWhere(dispatchEligibilityChecks, i.scope),
      eq(dispatchEligibilityChecks.verdict, verdict),
      gte(dispatchEligibilityChecks.evaluatedAt, i.from), lt(dispatchEligibilityChecks.evaluatedAt, i.to),
      opt(i.filters.operatorId, v => eq(dispatchEligibilityChecks.operatorId, v)),
      opt(i.filters.unitId, v => eq(dispatchEligibilityChecks.unitId, v)),
      opt(i.filters.jobId, v => eq(dispatchEligibilityChecks.jobId, v)),
    )).orderBy(asc(dispatchEligibilityChecks.evaluatedAt), asc(dispatchEligibilityChecks.id)).limit(ROW_CAP + 1));
    return {
      rows: rows.map(c => ({
        key: `check:${c.id}`, record: { table: "dispatchEligibilityChecks", id: c.id, ref: null },
        label: `Dispatch check ${c.id} — operator ${c.operatorId}`, at: c.evaluatedAt,
        fields: { operatorId: c.operatorId, unitId: c.unitId, jobId: c.jobId, usedForAward: c.usedForAward, blockerCodes: blockerCodes(c.blockersJson) },
      })),
      unknowns: [],
      truncated,
    };
  };
}

/** The reason codes a stored check carried, or null when the stored text is not the array it should be. */
export function blockerCodes(json: string | null): string | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(b => (b && typeof b === "object" && typeof (b as { code?: unknown }).code === "string" ? (b as { code: string }).code : null))
      .filter((c): c is string => c !== null).join(", ");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ safety */

const incidentResolver: Resolver = async (db, i) => {
  const { rows, truncated } = capped(await db.select({
    id: incidentReports.id, number: incidentReports.incidentNumber, type: incidentReports.incidentType, severity: incidentReports.severity,
    status: incidentReports.status, occurredAt: incidentReports.occurredAt,
  }).from(incidentReports).where(where(
    jobUnitOperatorScopeWhere(db, { jobId: incidentReports.jobId, unitId: incidentReports.unitId, operatorId: incidentReports.operatorId }, i.scope),
    gte(incidentReports.occurredAt, i.from), lt(incidentReports.occurredAt, i.to),
    opt(i.filters.jobId, v => eq(incidentReports.jobId, v)),
    opt(i.filters.unitId, v => eq(incidentReports.unitId, v)),
    opt(i.filters.operatorId, v => eq(incidentReports.operatorId, v)),
  )).orderBy(asc(incidentReports.occurredAt), asc(incidentReports.id)).limit(ROW_CAP + 1));
  return {
    rows: rows.map(r => ({
      key: `incident:${r.id}`, record: { table: "incidentReports", id: r.id, ref: r.number }, label: `${r.number} — ${r.type.replace(/_/g, " ")}`, at: r.occurredAt,
      fields: { incidentType: r.type, severity: r.severity, status: r.status },
    })),
    unknowns: [],
    truncated,
  };
};

const nearMissResolver: Resolver = async (db, i) => {
  const { rows, truncated } = capped(await db.select({
    id: nearMissReports.id, number: nearMissReports.nearMissNumber, status: nearMissReports.status, occurredAt: nearMissReports.occurredAt,
  }).from(nearMissReports).where(where(
    jobUnitOperatorScopeWhere(db, { jobId: nearMissReports.jobId, unitId: nearMissReports.unitId, operatorId: nearMissReports.operatorId }, i.scope),
    gte(nearMissReports.occurredAt, i.from), lt(nearMissReports.occurredAt, i.to),
    opt(i.filters.jobId, v => eq(nearMissReports.jobId, v)),
    opt(i.filters.unitId, v => eq(nearMissReports.unitId, v)),
    opt(i.filters.operatorId, v => eq(nearMissReports.operatorId, v)),
  )).orderBy(asc(nearMissReports.occurredAt), asc(nearMissReports.id)).limit(ROW_CAP + 1));
  return {
    rows: rows.map(r => ({
      key: `nearMiss:${r.id}`, record: { table: "nearMissReports", id: r.id, ref: r.number }, label: `Near miss ${r.number}`, at: r.occurredAt,
      fields: { status: r.status },
    })),
    unknowns: [],
    truncated,
  };
};

/* ------------------------------------------------------------------ hours of service */

function dutyMinutesResolver(statuses: readonly ("driving" | "on_duty")[]): Resolver {
  return async (db, i) => {
    // Time that has not happened yet is not time recorded.
    const end = new Date(Math.min(i.to.getTime(), i.now.getTime()));
    if (end.getTime() <= i.from.getTime()) return { rows: [], unknowns: [], truncated: false };
    const { rows, truncated } = capped(await db.select({
      id: dutyRecords.id, operatorId: dutyRecords.operatorId, tripId: dutyRecords.tripId, dutyStatus: dutyRecords.dutyStatus,
      startedAt: dutyRecords.startedAt, endedAt: dutyRecords.endedAt,
    }).from(dutyRecords).where(where(
      ownershipScopeWhere("operator", dutyRecords.operatorId, i.scope),
      inArray(dutyRecords.dutyStatus, [...statuses]),
      lt(dutyRecords.startedAt, end),
      or(isNull(dutyRecords.endedAt), gte(dutyRecords.endedAt, i.from)),
      opt(i.filters.operatorId, v => eq(dutyRecords.operatorId, v)),
    )).orderBy(asc(dutyRecords.startedAt), asc(dutyRecords.id)).limit(ROW_CAP + 1));
    const backwards = rows.filter(r => r.endedAt !== null && r.endedAt.getTime() < r.startedAt.getTime());
    const out: DrillRow[] = [];
    for (const r of rows) {
      if (backwards.includes(r)) continue;
      const minutes = Math.round(overlapMinutes(r.startedAt, r.endedAt ?? i.now, i.from, end) * 100) / 100;
      if (minutes <= 0) continue;
      out.push({
        key: `duty:${r.id}`, record: { table: "dutyRecords", id: r.id, ref: null },
        label: `${r.dutyStatus.replace("_", " ")} — operator ${r.operatorId}`, at: r.startedAt,
        fields: { operatorId: r.operatorId, tripId: r.tripId, dutyStatus: r.dutyStatus, open: r.endedAt === null, minutes },
      });
    }
    return { rows: out, unknowns: [unknown("Duty records that end before they start", backwards.length)], truncated };
  };
}

/* ------------------------------------------------------------------ the map */

export const RESOLVERS: Readonly<Record<string, Resolver>> = {
  "ops.trips.in_progress": tripsInProgressResolver,
  "ops.trips.completed": tripsCompletedResolver,
  "ops.jobs.with_trip_in_progress": jobsWithTripResolver,
  "ops.drivers.on_trip": driversOnTripResolver,
  "ops.units.on_trip": unitsOnTripResolver,
  "fleet.units.registered": unitsRegisteredResolver,
  "fleet.inspections.completed": inspectionResolver(false),
  "fleet.inspections.failed": inspectionResolver(true),
  "maintenance.defects.open": defectResolver("open"),
  "maintenance.defects.critical_open": defectResolver("critical_open"),
  "maintenance.defects.reported": defectResolver("reported"),
  "maintenance.work_orders.open": workOrdersOpenResolver,
  "maintenance.work_orders.repair_hours_avg": repairHoursResolver,
  "compliance.documents.expiring": documentResolver("expiring"),
  "compliance.documents.expired": documentResolver("expired"),
  "compliance.documents.unverified": documentResolver("unverified"),
  "compliance.readiness.checks_blocked": readinessResolver("blocked"),
  "compliance.readiness.checks_unknown": readinessResolver("unknown"),
  "safety.incidents.reported": incidentResolver,
  "safety.near_misses.reported": nearMissResolver,
  "hos.driving_minutes_elapsed": dutyMinutesResolver(["driving"]),
  "hos.on_duty_minutes_elapsed": dutyMinutesResolver(["driving", "on_duty"]),
};

/** The resolver for a metric, or null for one registered as unavailable. */
export function resolverFor(metricId: string): Resolver | null {
  return RESOLVERS[metricId] ?? null;
}
