/**
 * Analytics Checkpoint B — against a real database.
 *
 * Two organizations built record by record with hand-counted expectations, plus a caller in the
 * historical single tenant. What is proven:
 *
 *   - every value equals what was counted by hand;
 *   - every value equals its own drill-down, for every registered metric and every scope — the
 *     "14 overdue units means 14 rows" invariant, run over the whole registry rather than one example;
 *   - neither organization's answer contains a row of the other's, and the single tenant sees neither;
 *   - a filter naming another organization's unit, operator or job is "not found", never a quiet zero;
 *   - the procedure gate and the per-metric source gate both hold, for drivers, mechanics, bookkeepers;
 *   - a driver's own numbers are theirs alone, and nothing in the input can name someone else;
 *   - a missing timestamp is an unknown, an average over nothing is not applicable, and neither is 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { METRICS } from "./_core/analytics/metricRegistry";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 281_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
/** A UTC wall-clock string, so nothing depends on the test process's local zone. */
const ts = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const at = (s: string) => ts(new Date(s));

const FROM = new Date("2026-01-10T00:00:00Z");
const TO = new Date("2026-01-11T00:00:00Z");
const RANGE = { label: "custom" as const, from: FROM, to: TO };

async function insert(sql: string, params: unknown[]): Promise<number> {
  const [r] = await pool.execute<mysql.ResultSetHeader>(sql, params as never[]);
  return Number(r.insertId);
}
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function person(orgRefs: string[], roles: string[]) {
  const userId = seq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  for (const orgRef of orgRefs) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  return userId;
}
const own = (orgRef: string, recordType: "unit" | "operator", recordId: number) =>
  pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,?,?,1)", [orgRef, recordType, recordId]);
async function unit(orgRef: string, vehicleType = "vac truck") {
  const id = await insert("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus) VALUES (?,?, 'due', 'review')", [`AN-${rnd()}`, vehicleType]);
  await own(orgRef, "unit", id);
  return id;
}
async function operator(orgRef: string, userId: number | null = null) {
  const id = await insert("INSERT INTO operators (name, userId) VALUES (?,?)", [`Driver ${rnd()}`, userId]);
  await own(orgRef, "operator", id);
  return id;
}
const job = (orgRef: string) => insert("INSERT INTO jobs (orgRef, jobCode, type, customer, location) VALUES (?,?,'haul','Customer','Site')", [orgRef, `J-${rnd()}`]);
const trip = (orgRef: string, t: { status: string; jobId?: number | null; unitId?: number | null; operatorId?: number | null; startedAt?: string | null; completedAt?: string | null }) =>
  insert("INSERT INTO trips (orgRef, tripNumber, jobId, unitId, operatorId, status, startedAt, completedAt) VALUES (?,?,?,?,?,?,?,?)",
    [orgRef, `T-${rnd()}`, t.jobId ?? null, t.unitId ?? null, t.operatorId ?? null, t.status, t.startedAt ?? null, t.completedAt ?? null]);
const defect = (unitId: number, severity: string, status: string, reportedAt: string) =>
  insert("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt) VALUES (?,?,?,?,?)", [unitId, `Defect ${rnd()}`, severity, status, at(reportedAt)]);
const workOrder = (unitId: number, status: string, openedAt: string, completedAt: string | null) =>
  insert("INSERT INTO workOrders (workOrderNumber, unitId, status, openedAt, completedAt) VALUES (?,?,?,?,?)", [`WO-${rnd()}`, unitId, status, at(openedAt), completedAt ? at(completedAt) : null]);
const inspection = (unitId: number, type: string, status: string, observedAt: string, operatorId: number | null) =>
  insert("INSERT INTO inspections (unitId, type, status, observedAt, authenticatedOperatorId) VALUES (?,?,?,?,?)", [unitId, type, status, at(observedAt), operatorId]);
const DAY = 86_400_000;
const document = (ownerType: string, ownerId: number, docType: string, verificationStatus: string, expiresInDays: number | null, privateDetail = false) =>
  insert("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus, privateDetail) VALUES (?,?,?,?,?,?,?,?)",
    [ownerType, ownerId, docType, `${docType} ${rnd()}`, ts(new Date(Date.now() - 400 * DAY)), expiresInDays === null ? null : ts(new Date(Date.now() + expiresInDays * DAY)), verificationStatus, privateDetail]);
const check = (orgRef: string, operatorId: number, verdict: string, evaluatedAt: string, blockers: unknown[] = []) =>
  insert("INSERT INTO dispatchEligibilityChecks (operatorId, verdict, blockersJson, fingerprint, orgRef, evaluatedAt) VALUES (?,?,?,?,?,?)", [operatorId, verdict, JSON.stringify(blockers), `EF2-${rnd()}`, orgRef, at(evaluatedAt)]);
const incident = (r: { jobId?: number; unitId?: number; operatorId?: number; severity: string; occurredAt: string }) =>
  insert("INSERT INTO incidentReports (incidentNumber, incidentType, severity, operatorId, jobId, unitId, occurredAt, reportedAt, originalStatement) VALUES (?,?,?,?,?,?,?,?,?)",
    [`INC-${rnd()}`, "incident", r.severity, r.operatorId ?? null, r.jobId ?? null, r.unitId ?? null, at(r.occurredAt), at(r.occurredAt), "What happened"]);
const nearMiss = (r: { unitId?: number; occurredAt: string }) =>
  insert("INSERT INTO nearMissReports (nearMissNumber, unitId, occurredAt, reportedAt, originalStatement) VALUES (?,?,?,?,?)", [`NM-${rnd()}`, r.unitId ?? null, at(r.occurredAt), at(r.occurredAt), "Nearly"]);
const duty = (operatorId: number, dutyStatus: string, startedAt: string, endedAt: string) =>
  insert("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt) VALUES (?,?,?,?)", [operatorId, dutyStatus, at(startedAt), at(endedAt)]);

type World = Awaited<ReturnType<typeof build>>;
async function build() {
  const A = await org(), B = await org();
  const mgrA = await person([A], ["management"]), mgrB = await person([B], ["management"]), legacy = await person([], ["management"]);
  const driverA = await person([A], ["driver"]), mechA = await person([A], ["mechanic"]), bookA = await person([A], ["bookkeeper"]);
  const dispatcherNoOperator = await person([A], ["dispatcher"]), twoOrgs = await person([A, B], ["management"]);

  const uA1 = await unit(A), uA2 = await unit(A, "trailer"), uB1 = await unit(B);
  const opA = await operator(A, driverA), opA2 = await operator(A), opB = await operator(B);
  const jA = await job(A), jB = await job(B);
  const soon = ts(new Date(Date.now() - 3_600_000));

  const trips = {
    tA1: await trip(A, { status: "in_transit", jobId: jA, unitId: uA1, operatorId: opA, startedAt: soon }),
    tA2: await trip(A, { status: "loading", jobId: jA, unitId: uA2, operatorId: opA2, startedAt: soon }),
    tA3: await trip(A, { status: "complete", jobId: jA, unitId: uA1, operatorId: opA, startedAt: at("2026-01-10T08:00:00Z"), completedAt: at("2026-01-10T12:00:00Z") }),
    tA4: await trip(A, { status: "complete", operatorId: opA2 }),
    tA5: await trip(A, { status: "in_transit" }),
    tB1: await trip(B, { status: "in_transit", jobId: jB, unitId: uB1, operatorId: opB, startedAt: soon }),
  };
  const defects = {
    dA1: await defect(uA1, "critical", "open", "2026-01-10T08:00:00Z"),
    dA2: await defect(uA2, "advisory", "in_progress", "2026-01-09T08:00:00Z"),
    dA3: await defect(uA1, "inspection_required", "resolved", "2026-01-10T09:00:00Z"),
    dB1: await defect(uB1, "critical", "open", "2026-01-10T08:00:00Z"),
  };
  const workOrders = {
    wA1: await workOrder(uA1, "closed", "2026-01-10T00:00:00Z", "2026-01-10T10:00:00Z"),
    wA2: await workOrder(uA1, "closed", "2026-01-09T00:00:00Z", null),
    wA3: await workOrder(uA2, "open", "2026-01-09T00:00:00Z", null),
    wA4: await workOrder(uA2, "draft", "2026-01-09T00:00:00Z", null),
    wA5: await workOrder(uA1, "waiting_parts", "2026-01-09T00:00:00Z", null),
    wB1: await workOrder(uB1, "closed", "2026-01-10T00:00:00Z", "2026-01-10T02:00:00Z"),
  };
  const inspections = {
    iA1: await inspection(uA1, "pre_trip", "pass", "2026-01-10T06:00:00Z", opA),
    iA2: await inspection(uA2, "post_trip", "fail", "2026-01-10T18:00:00Z", opA2),
    iA3: await inspection(uA1, "pre_trip", "pass", "2026-01-12T06:00:00Z", opA),
    iB1: await inspection(uB1, "pre_trip", "pass", "2026-01-10T06:00:00Z", opB),
  };
  const documents = {
    docA1: await document("operator", opA, "driver_licence", "verified", 10),
    docA2: await document("operator", opA, "h2s_alive", "verified", -3),
    docA3: await document("operator", opA, "medical_fitness", "verified", 5, true),
    docA4: await document("unit", uA1, "vehicle_registration", "needs_review", null),
    docA5: await document("unit", uA1, "insurance_proof", "verified", 200),
    docB1: await document("operator", opB, "driver_licence", "verified", 10),
  };
  const checks = {
    cA1: await check(A, opA, "blocked", "2026-01-10T07:00:00Z", [{ code: "critical_defect", severity: "blocking" }]),
    cA2: await check(A, opA2, "unknown", "2026-01-10T07:30:00Z"),
    cA3: await check(A, opA, "blocked", "2026-01-12T07:00:00Z"),
    cB1: await check(B, opB, "blocked", "2026-01-10T07:00:00Z"),
  };
  const incidents = {
    // A's job, B's unit: the job decides, as incidentInScope decides.
    inA1: await incident({ jobId: jA, unitId: uB1, severity: "serious", occurredAt: "2026-01-10T10:00:00Z" }),
    inA2: await incident({ operatorId: opA, severity: "minor", occurredAt: "2026-01-10T11:00:00Z" }),
    inB1: await incident({ unitId: uB1, severity: "minor", occurredAt: "2026-01-10T11:00:00Z" }),
  };
  const nearMisses = { nmA1: await nearMiss({ unitId: uA1, occurredAt: "2026-01-10T13:00:00Z" }) };
  const duties = {
    dutA1: await duty(opA, "driving", "2026-01-10T01:00:00Z", "2026-01-10T03:00:00Z"),
    dutA2: await duty(opA, "on_duty", "2026-01-10T03:00:00Z", "2026-01-10T04:00:00Z"),
    dutA3: await duty(opA, "driving", "2026-01-09T23:00:00Z", "2026-01-10T00:30:00Z"),
    dutA4: await duty(opA2, "driving", "2026-01-10T05:00:00Z", "2026-01-10T05:45:00Z"),
    dutB1: await duty(opB, "driving", "2026-01-10T05:00:00Z", "2026-01-10T06:40:00Z"),
  };
  const ids = { trips, defects, workOrders, inspections, documents, checks, incidents, nearMisses, duties };
  /** Every fixture record id per table, split by which organization it belongs to. */
  const byOrg = (prefix: "A" | "B") => {
    const out: Record<string, Set<number>> = {};
    const table: Record<string, string> = { trips: "trips", defects: "maintenanceDefects", workOrders: "workOrders", inspections: "inspections", documents: "complianceDocuments", checks: "dispatchEligibilityChecks", incidents: "incidentReports", nearMisses: "nearMissReports", duties: "dutyRecords" };
    for (const [group, rec] of Object.entries(ids)) {
      const t = table[group]!;
      out[t] ??= new Set();
      // Every fixture is named for its organization: tA1, dutB1, docA3.
      for (const [name, id] of Object.entries(rec)) if (/([AB])\d+$/.exec(name)?.[1] === prefix) out[t]!.add(id);
    }
    out.units = new Set(prefix === "A" ? [uA1, uA2] : [uB1]);
    out.operators = new Set(prefix === "A" ? [opA, opA2] : [opB]);
    out.jobs = new Set(prefix === "A" ? [jA] : [jB]);
    return out;
  };
  return { A, B, mgrA, mgrB, legacy, driverA, mechA, bookA, dispatcherNoOperator, twoOrgs, uA1, uA2, uB1, opA, opA2, opB, jA, jB, ids, owned: { A: byOrg("A"), B: byOrg("B") } };
}

let w: World;
beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 });
  w = await build();
}, 60_000);
afterAll(async () => { await pool?.end(); });

const metric = (userId: number, metricId: string, extra: Record<string, unknown> = {}) =>
  callerFor(userId).analytics.metric({ metricId, range: RANGE, ...extra } as never);
const drill = (userId: number, metricId: string, extra: Record<string, unknown> = {}) =>
  callerFor(userId).analytics.drilldown({ metricId, range: RANGE, ...extra } as never);

d("values, counted by hand", () => {
  it("answers operations as the fixtures say, naming what it could not place", async () => {
    const inProgress = await metric(w.mgrA, "ops.trips.in_progress");
    expect(inProgress).toMatchObject({ value: 3, determination: "computed", breakdown: { in_transit: 2, loading: 1 }, scope: { tenantId: w.A, derivedFrom: "membership" } });
    // The definition travels with the answer, so a screen or an assistant can say how it was counted.
    expect(inProgress.formula).toBe(METRICS.find(m => m.id === "ops.trips.in_progress")!.formula);
    expect(inProgress.description.length).toBeGreaterThan(0);
    const completed = await metric(w.mgrA, "ops.trips.completed");
    expect(completed).toMatchObject({ value: 1, determination: "partial" });
    expect(completed.unknowns).toEqual([{ reason: expect.stringContaining("no completedAt"), count: 1 }]);
    expect(await metric(w.mgrA, "ops.jobs.with_trip_in_progress")).toMatchObject({ value: 1, determination: "partial", unknowns: [{ reason: expect.stringContaining("name no job"), count: 1 }] });
    expect(await metric(w.mgrA, "ops.drivers.on_trip")).toMatchObject({ value: 2, determination: "partial" });
    expect(await metric(w.mgrA, "ops.units.on_trip")).toMatchObject({ value: 2, determination: "partial" });
    expect(await metric(w.mgrB, "ops.trips.in_progress")).toMatchObject({ value: 1, determination: "computed" });
  });

  it("answers fleet and maintenance", async () => {
    expect(await metric(w.mgrA, "fleet.units.registered")).toMatchObject({ value: 2, breakdown: { "vac truck": 1, trailer: 1 } });
    expect(await metric(w.mgrA, "fleet.inspections.completed")).toMatchObject({ value: 2, breakdown: { pre_trip: 1, post_trip: 1 } });
    expect(await metric(w.mgrA, "fleet.inspections.failed")).toMatchObject({ value: 1, breakdown: { fail: 1 } });
    expect(await metric(w.mgrA, "maintenance.defects.open")).toMatchObject({ value: 2, breakdown: { critical: 1, advisory: 1 } });
    expect(await metric(w.mgrA, "maintenance.defects.critical_open")).toMatchObject({ value: 1 });
    expect(await metric(w.mgrA, "maintenance.defects.reported")).toMatchObject({ value: 2 });
    expect(await metric(w.mgrA, "maintenance.work_orders.open")).toMatchObject({ value: 2, breakdown: { open: 1, waiting_parts: 1 } });
    expect(await metric(w.mgrA, "maintenance.defects.open", { filters: { unitId: w.uA1 } })).toMatchObject({ value: 1 });
  });

  it("averages repair time over what it can place, and says what it cannot", async () => {
    const a = await metric(w.mgrA, "maintenance.work_orders.repair_hours_avg");
    expect(a).toMatchObject({ value: 10, determination: "partial", basis: 1, unit: "hours" });
    expect(a.unknowns[0]).toMatchObject({ count: 1, reason: expect.stringContaining("workOrderAdvance") });
    expect(await metric(w.mgrB, "maintenance.work_orders.repair_hours_avg")).toMatchObject({ value: 2, determination: "computed" });
  });

  it("states zero, missing and nothing-to-average as three different answers", async () => {
    const empty = { label: "custom", from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-02-02T00:00:00Z") };
    // B has no work orders closed in February and none it cannot place: nothing to average.
    expect(await metric(w.mgrB, "maintenance.work_orders.repair_hours_avg", { range: empty })).toMatchObject({ value: null, determination: "not_applicable" });
    // A has one it cannot place, so it may have belonged there: unknown, not "none".
    expect(await metric(w.mgrA, "maintenance.work_orders.repair_hours_avg", { range: empty })).toMatchObject({ value: null, determination: "unknown" });
    // A count over an empty range is a counted zero.
    expect(await metric(w.mgrB, "fleet.inspections.completed", { range: empty })).toMatchObject({ value: 0, determination: "computed" });
  });

  it("decides document state with the validity engine, and withholds what a private document is", async () => {
    const expiring = await drill(w.mgrA, "compliance.documents.expiring");
    expect(expiring).toMatchObject({ value: 2, breakdown: { driver_licence: 1, "(withheld)": 1 } });
    const priv = expiring.rows.find(r => r.fields.docType === "(withheld)")!;
    expect(priv.label).toMatch(/^Private document/);
    expect(priv.fields.reason).toBe("withheld");
    expect(JSON.stringify(expiring)).not.toContain("medical_fitness");
    expect(await metric(w.mgrA, "compliance.documents.expired")).toMatchObject({ value: 1, breakdown: { h2s_alive: 1 } });
    expect(await metric(w.mgrA, "compliance.documents.unverified")).toMatchObject({ value: 1, breakdown: { vehicle_registration: 1 } });
    expect(await metric(w.mgrB, "compliance.documents.expiring")).toMatchObject({ value: 1 });
  });

  it("reads stored readiness verdicts with their reason codes", async () => {
    const blocked = await drill(w.mgrA, "compliance.readiness.checks_blocked");
    expect(blocked.value).toBe(1);
    expect(blocked.rows[0]!.fields.blockerCodes).toBe("critical_defect");
    expect(await metric(w.mgrA, "compliance.readiness.checks_unknown")).toMatchObject({ value: 1 });
  });

  it("scopes safety records by job first, then unit, then operator, as incidentInScope does", async () => {
    const a = await drill(w.mgrA, "safety.incidents.reported");
    expect(a.value).toBe(2);
    expect(a.rows.map(r => r.record.id).sort()).toEqual([w.ids.incidents.inA1, w.ids.incidents.inA2].sort());
    const b = await drill(w.mgrB, "safety.incidents.reported");
    // B owns the unit on inA1 but not its job; the job decides.
    expect(b.rows.map(r => r.record.id)).toEqual([w.ids.incidents.inB1]);
    expect(a.rows.every(r => !("originalStatement" in r.fields))).toBe(true);
    expect(await metric(w.mgrA, "safety.near_misses.reported")).toMatchObject({ value: 1 });
  });

  it("sums recorded duty minutes inside the range only", async () => {
    // 120 + 30 (the part of 23:00–00:30 after midnight) + 45.
    expect(await metric(w.mgrA, "hos.driving_minutes_elapsed")).toMatchObject({ value: 195, unit: "minutes", determination: "computed" });
    expect(await metric(w.mgrA, "hos.on_duty_minutes_elapsed")).toMatchObject({ value: 255, breakdown: { driving: 3, on_duty: 1 } });
    expect(await metric(w.mgrA, "hos.driving_minutes_elapsed", { filters: { operatorId: w.opA } })).toMatchObject({ value: 150 });
  });

  it("answers a metric the records cannot support with its reason and no rows", async () => {
    const overdue = await drill(w.mgrA, "maintenance.work_orders.overdue");
    expect(overdue).toMatchObject({ value: null, determination: "not_derivable", rows: [] });
    expect(overdue.unknowns[0]!.reason).toMatch(/no due date/);
    expect(await metric(w.mgrA, "hos.limit_position")).toMatchObject({ value: null, determination: "unknown" });
    expect(await metric(w.mgrA, "fleet.utilization")).toMatchObject({ value: null, determination: "not_evaluated" });
  });
});

d("the value is its drill-down", () => {
  it("returns exactly the rows behind every registered metric, in every scope", async () => {
    for (const userId of [w.mgrA, w.mgrB, w.legacy]) {
      for (const def of METRICS) {
        const v = await metric(userId, def.id);
        const rows = await drill(userId, def.id);
        expect(rows.value, `${def.id} for ${userId}`).toBe(v.value);
        expect(rows.determination, def.id).toBe(v.determination);
        if (def.aggregation.kind === "count" && !def.unavailable) expect(rows.rows.length, def.id).toBe(v.value);
        if (def.aggregation.kind === "sum") {
          const field = def.aggregation.field;
          expect(Math.round(rows.rows.reduce((s, r) => s + Number(r.fields[field]), 0) * 100) / 100, def.id).toBe(v.value);
        }
        if (def.aggregation.kind === "mean" && rows.rows.length) {
          const field = def.aggregation.field;
          expect(Math.round((rows.rows.reduce((s, r) => s + Number(r.fields[field]), 0) / rows.rows.length) * 100) / 100, def.id).toBe(v.value);
        }
        // The drill-down names the call that repeats the question exactly.
        expect(v.drilldown).toMatchObject({ procedure: "analytics.drilldown", input: { metricId: def.id, range: { label: "custom", from: FROM, to: TO } } });
      }
    }
  }, 120_000);
});

d("one organization never sees another's records", () => {
  const recordIds = async (userId: number) => {
    const seen: Record<string, Set<number>> = {};
    for (const def of METRICS) {
      if (def.unavailable) continue;
      for (const r of (await drill(userId, def.id)).rows) (seen[r.record.table] ??= new Set()).add(r.record.id);
    }
    return seen;
  };
  const overlap = (seen: Record<string, Set<number>>, other: Record<string, Set<number>>) =>
    Object.entries(seen).flatMap(([t, ids]) => Array.from(ids).filter(id => other[t]?.has(id)).map(id => `${t}:${id}`));

  it("keeps A, B and the single tenant apart across every metric's rows", async () => {
    const a = await recordIds(w.mgrA), b = await recordIds(w.mgrB), legacy = await recordIds(w.legacy);
    expect(overlap(a, w.owned.B)).toEqual([]);
    expect(overlap(b, w.owned.A)).toEqual([]);
    expect(overlap(legacy, w.owned.A)).toEqual([]);
    expect(overlap(legacy, w.owned.B)).toEqual([]);
    // And each does see its own.
    expect(a.trips?.has(w.ids.trips.tA1)).toBe(true);
    expect(b.trips?.has(w.ids.trips.tB1)).toBe(true);
  }, 120_000);

  it("calls another organization's unit, operator or job not found, never zero", async () => {
    await expect(metric(w.mgrB, "maintenance.defects.open", { filters: { unitId: w.uA1 } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(metric(w.mgrB, "hos.driving_minutes_elapsed", { filters: { operatorId: w.opA } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(metric(w.mgrB, "ops.trips.in_progress", { filters: { jobId: w.jA } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(drill(w.mgrB, "safety.incidents.reported", { filters: { jobId: w.jA } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(metric(w.legacy, "maintenance.defects.open", { filters: { unitId: w.uA1 } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to choose for someone in two organizations", async () => {
    await expect(metric(w.twoOrgs, "ops.trips.in_progress")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

d("the gates", () => {
  it("keeps organization metrics from a driver, though the driver holds the trip read", async () => {
    await expect(metric(w.driverA, "ops.trips.in_progress")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(drill(w.driverA, "ops.trips.in_progress")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(w.driverA).analytics.catalog()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("holds each metric to its source's own read permission", async () => {
    // A mechanic reads defects but not dispatch checks or duty records.
    expect(await metric(w.mechA, "maintenance.defects.open")).toMatchObject({ value: 2 });
    await expect(metric(w.mechA, "compliance.readiness.checks_blocked")).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("dispatch.read") });
    await expect(drill(w.mechA, "hos.driving_minutes_elapsed")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const catalog = await callerFor(w.mechA).analytics.catalog();
    const permitted = new Map(catalog.metrics.map(m => [m.id, m.permitted]));
    expect(permitted.get("maintenance.defects.open")).toBe(true);
    expect(permitted.get("compliance.readiness.checks_blocked")).toBe(false);
    expect(catalog.registryVersion).toBe("b.1");
  });

  it("keeps a bookkeeper out of operations metrics entirely", async () => {
    await expect(metric(w.bookA, "fleet.units.registered")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a filter a metric does not take, an unknown metric, and an unknown zone", async () => {
    await expect(metric(w.mgrA, "fleet.units.registered", { filters: { unitId: w.uA1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(metric(w.mgrA, "no.such.metric")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(metric(w.mgrA, "ops.trips.completed", { range: { label: "today", zone: "Mountain" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const echoed = await metric(w.mgrA, "ops.trips.completed", { range: { label: "today", zone: "America/Edmonton" } });
    expect(echoed.range).toMatchObject({ label: "today", zone: "America/Edmonton" });
  });
});

d("a driver's own numbers", () => {
  it("resolves the operator from the session and answers only for them", async () => {
    const mine = await callerFor(w.driverA).analytics.mine({ range: RANGE });
    expect(mine.operatorId).toBe(w.opA);
    const by = new Map(mine.metrics.map(m => [m.metricId, m]));
    expect(by.get("ops.trips.in_progress")).toMatchObject({ value: 1, filters: { operatorId: w.opA } });
    expect(by.get("ops.trips.completed")).toMatchObject({ value: 1, determination: "computed" });
    expect(by.get("fleet.inspections.completed")).toMatchObject({ value: 1 });
    expect(by.get("compliance.documents.expiring")).toMatchObject({ value: 2 });
    expect(by.get("compliance.documents.expired")).toMatchObject({ value: 1 });
    expect(by.get("compliance.readiness.checks_blocked")).toMatchObject({ value: 1 });
    expect(by.get("hos.driving_minutes_elapsed")).toMatchObject({ value: 150 });
    expect(by.get("hos.on_duty_minutes_elapsed")).toMatchObject({ value: 210 });
    for (const m of mine.metrics) expect(m.drilldown.procedure).toBe("analytics.mineDrilldown");
  });

  it("drills into exactly the driver's own rows", async () => {
    const rows = await callerFor(w.driverA).analytics.mineDrilldown({ metricId: "hos.driving_minutes_elapsed", range: RANGE });
    expect(rows.rows.map(r => r.record.id).sort()).toEqual([w.ids.duties.dutA1, w.ids.duties.dutA3].sort());
    expect(rows.rows.every(r => r.fields.operatorId === w.opA)).toBe(true);
  });

  it("offers nothing that could name another person", async () => {
    await expect(callerFor(w.driverA).analytics.mine({ range: RANGE, filters: { operatorId: w.opA2 } } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(w.driverA).analytics.mineDrilldown({ metricId: "hos.driving_minutes_elapsed", range: RANGE, operatorId: w.opA2 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(w.driverA).analytics.mine({ metricIds: ["maintenance.defects.open"], range: RANGE })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("says why rather than report zeros when the organization does not own the driver's operator record", async () => {
    const hired = await person([w.A], ["driver"]);
    await insert("INSERT INTO operators (name, userId) VALUES (?,?)", [`Unowned ${rnd()}`, hired]);
    expect(await callerFor(hired).analytics.mine({ range: RANGE })).toMatchObject({ operatorId: null, reason: expect.stringContaining("not recorded as belonging to your organization"), metrics: [] });
  });

  it("says plainly when no operator record is linked, and is open to every role", async () => {
    expect(await callerFor(w.dispatcherNoOperator).analytics.mine({ range: RANGE })).toEqual({ operatorId: null, reason: "No operator record is linked to your login", metrics: [] });
    expect((await callerFor(w.bookA).analytics.mine({ range: RANGE })).operatorId).toBeNull();
    await expect(callerFor(w.dispatcherNoOperator).analytics.mineDrilldown({ metricId: "ops.trips.completed", range: RANGE })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
