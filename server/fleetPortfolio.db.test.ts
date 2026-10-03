/**
 * Fleet & Equipment Portfolio foundation — against a real database, through the real router, the real
 * readiness composer and the real triggers. Nothing here mocks a safety result.
 *
 * docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md; owner decisions of 2026-09-25.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { composeReadiness } from "./readinessComposer";

const URL = process.env.DATABASE_URL;
describe("fleet portfolio foundation — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped portfolio suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 199_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?, ?, 'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}
async function person(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?, ?, ?, 'employee', 'active', '2020-01-01', 1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, ?, 'global', 1, NOW())", [userId, role]);
  return userId;
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
/** A driver and a job, so the real composer can be asked about the unit. */
async function dispatchSubject(orgRef: string) {
  const driverUser = await person(orgRef, ["driver"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, orgRef) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0, ?)", [`JOB-${rnd()}`, orgRef]);
  return { operatorId: Number(op.insertId), jobId: Number(j.insertId) };
}
const holdFindings = async (unitId: number, s: { operatorId: number; jobId: number }, trailerId: number | null = null) => {
  const r = await composeReadiness({ operatorId: s.operatorId, unitId, trailerId, jobId: s.jobId });
  return { r, holds: r.eligibility.blockers.filter(b => /_hold_/.test(b.code)) as (typeof r.eligibility.blockers[number] & { overrideClass?: string })[] };
};

let A = "", B = "";
let mechanic = 0, mechanic2 = 0, shopLead = 0, safety = 0, safety2 = 0, management = 0, dispatcher = 0, driver = 0, office = 0;
let leadB = 0, safetyB = 0;
beforeAll(async () => {
  if (!URL) return;
  A = await org(); B = await org();
  mechanic = await person(A, ["mechanic"]); mechanic2 = await person(A, ["mechanic"]);
  shopLead = await person(A, ["shop_lead"]); safety = await person(A, ["safety"]); safety2 = await person(A, ["safety"]);
  management = await person(A, ["management"]); dispatcher = await person(A, ["dispatcher"]); driver = await person(A, ["driver"]);
  office = await person(A, ["office"]);
  leadB = await person(B, ["shop_lead", "management"]); safetyB = await person(B, ["safety"]);
});

d("holds, through the router and the readiness composer", () => {
  it("a safety hold is out of service: the projection says so, readiness fails closed with no override, and the fingerprint moves", async () => {
    const unitId = await unit(A);
    const s = await dispatchSubject(A);
    const before = (await holdFindings(unitId, s)).r.fingerprint;
    await expect(caller(mechanic).fleet.holdPlace({ unitId, holdType: "safety", reason: "Steering box leaking under load — out of service" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const h = await caller(safety).fleet.holdPlace({ unitId, holdType: "safety", reason: "Steering box leaking under load — out of service" });
    expect(h).toMatchObject({ dispatchEffect: "out_of_service", status: "out_of_service" });
    expect(h.driverNotice).toMatch(/^Out of service — do not operate/);

    const { r, holds } = await holdFindings(unitId, s);
    expect(holds).toEqual([expect.objectContaining({ code: "unit_hold_safety", severity: "blocking", overridable: false, overrideClass: "NEVER_OVERRIDABLE" })]);
    expect(r.eligibility.verdict).toBe("blocked");
    expect(r.fingerprint).not.toBe(before);
    const state = await caller(dispatcher).fleet.unitState({ unitId });
    expect(state).toMatchObject({ status: "out_of_service", reasons: [expect.objectContaining({ code: "hold_safety", source: { table: "unitHolds", ref: h.holdRef } })] });
  });

  it("a blocking hold holds for maintenance and is releasable only under an approved policy; a warning hold only warns and is never a release of anything", async () => {
    const unitId = await unit(A);
    const s = await dispatchSubject(A);
    const block = await caller(mechanic).fleet.holdPlace({ unitId, holdType: "maintenance", reason: "Wheel seal weeping — hold for the shop" });
    expect(block).toMatchObject({ dispatchEffect: "block", status: "maintenance_hold" });
    let f = await holdFindings(unitId, s);
    expect(f.holds).toEqual([expect.objectContaining({ code: "unit_hold_maintenance", severity: "blocking", overrideClass: "APPROVED_POLICY_ONLY" })]);

    const warn = await caller(shopLead).fleet.holdPlace({ unitId, holdType: "damage", reason: "Scraped mirror housing, cosmetic" });
    expect(warn).toMatchObject({ dispatchEffect: "warn", status: "maintenance_hold" });
    f = await holdFindings(unitId, s);
    expect(f.holds.map(b => [b.code, b.severity, b.overrideClass]).sort()).toEqual([
      ["unit_hold_damage_warning", "review", "WARNING_ONLY"],
      ["unit_hold_maintenance", "blocking", "APPROVED_POLICY_ONLY"],
    ]);
    // Releasing the warning changes nothing about the blocking hold.
    await caller(management).fleet.holdRelease({ holdRef: warn.holdRef, reason: "Mirror replaced" });
    expect((await caller(dispatcher).fleet.unitState({ unitId })).status).toBe("maintenance_hold");
    f = await holdFindings(unitId, s);
    expect(f.holds.map(b => b.code)).toEqual(["unit_hold_maintenance"]);
  });

  it("releasing the right hold updates the derived state; the history is kept and cannot be rewritten; the unauthorized are refused", async () => {
    const unitId = await unit(A);
    const s = await dispatchSubject(A);
    const h = await caller(safety).fleet.holdPlace({ unitId, holdType: "safety", reason: "Brake pushrod travel over limit" });
    // Nobody without a releasing role, the placer, or a mechanic (for a safety hold) may release it.
    await expect(caller(driver).fleet.holdRelease({ holdRef: h.holdRef, reason: "fine now" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(dispatcher).fleet.holdRelease({ holdRef: h.holdRef, reason: "fine now" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(mechanic).fleet.holdRelease({ holdRef: h.holdRef, reason: "adjusted" })).rejects.toThrow(/may release a safety hold/);
    await expect(caller(safety).fleet.holdRelease({ holdRef: h.holdRef, reason: "adjusted" })).rejects.toThrow(/placed a hold may not release it/);
    // Placing is refused to the driver and the dispatcher at the permission.
    await expect(caller(driver).fleet.holdPlace({ unitId, holdType: "maintenance", reason: "sounds odd to me" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(dispatcher).fleet.holdPlace({ unitId, holdType: "maintenance", reason: "sounds odd to me" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rel = await caller(safety2).fleet.holdRelease({ holdRef: h.holdRef, reason: "Slack adjusters replaced, pushrod travel within limit" });
    expect(rel.status).toBe("available");
    expect((await holdFindings(unitId, s)).holds).toEqual([]);
    await expect(caller(management).fleet.holdRelease({ holdRef: h.holdRef, reason: "again" })).rejects.toThrow(/already released/);

    const list = await caller(dispatcher).fleet.holdList({ unitId, includeReleased: true });
    expect(list.holds).toEqual([expect.objectContaining({ holdRef: h.holdRef, status: "released", placedByUserId: safety, releasedByUserId: safety2, releaseReason: "Slack adjusters replaced, pushrod travel within limit" })]);
    const events = (await caller(dispatcher).fleet.history({ unitId })).events.filter(e => e.subjectRef === h.holdRef);
    expect(events.map(e => [e.eventType, e.actorUserId])).toEqual([["hold_released", safety2], ["hold_placed", safety]]);
    // The database itself refuses a rewrite: of the released hold, of the history, and a delete of either.
    await expect(pool.execute("UPDATE unitHolds SET status = 'active' WHERE holdRef = ?", [h.holdRef])).rejects.toThrow(/released hold is history/);
    await expect(pool.execute("UPDATE unitHolds SET reason = 'nothing happened' WHERE holdRef = ?", [h.holdRef])).rejects.toThrow(/never edited/);
    await expect(pool.execute("DELETE FROM unitHolds WHERE holdRef = ?", [h.holdRef])).rejects.toThrow(/never deleted/);
    await expect(pool.execute("UPDATE fleetPortfolioEvents SET detail = 'x' WHERE subjectRef = ?", [h.holdRef])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM fleetPortfolioEvents WHERE subjectRef = ?", [h.holdRef])).rejects.toThrow(/append-only/);
  });

  it("a trailer's safety hold blocks the pairing as the trailer's", async () => {
    const unitId = await unit(A), trailerId = await unit(A);
    const s = await dispatchSubject(A);
    await caller(safety).fleet.holdPlace({ unitId: trailerId, holdType: "safety", reason: "Kingpin plate cracked" });
    expect((await holdFindings(unitId, s, trailerId)).holds).toEqual([expect.objectContaining({ code: "trailer_hold_safety", subject: "trailer", overrideClass: "NEVER_OVERRIDABLE" })]);
  });
});

d("the organization boundary", () => {
  it("another organization's unit, hold and reading look exactly like ones that do not exist", async () => {
    const unitA = await unit(A);
    const h = await caller(safety).fleet.holdPlace({ unitId: unitA, holdType: "safety", reason: "Held by organization A for inspection" });
    const r = await caller(mechanic).fleet.meterRecord({ unitId: unitA, meterType: "odometer_km", reading: 10_000, source: "mechanic" });
    const [[{ maxId }]] = await pool.execute<mysql.RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM units") as unknown as [[{ maxId: number }]];
    const ghost = Number(maxId) + 10_000;
    const same = async (fn: (id: number) => Promise<unknown>) => {
      const e1 = await fn(unitA).then(() => null, (e: { code?: string; message?: string }) => e);
      const e2 = await fn(ghost).then(() => null, (e: { code?: string; message?: string }) => e);
      expect(e1?.code).toBe("NOT_FOUND");
      expect({ code: e1?.code, message: e1?.message?.replace(String(unitA), "<id>") }).toEqual({ code: e2?.code, message: e2?.message?.replace(String(ghost), "<id>") });
    };
    const b = caller(leadB);
    await same(id => b.fleet.unitState({ unitId: id }));
    await same(id => b.fleet.holdList({ unitId: id, includeReleased: true }));
    await same(id => b.fleet.holdPlace({ unitId: id, holdType: "maintenance", reason: "holding someone else's truck" }));
    await same(id => b.fleet.meterReadings({ unitId: id }));
    await same(id => b.fleet.meterProgress({ unitId: id, meterType: "odometer_km", baselineRef: "x" }));
    await same(id => b.fleet.meterRecord({ unitId: id, meterType: "odometer_km", reading: 1, source: "mechanic" }));
    await same(id => b.fleet.history({ unitId: id }));
    // Another organization's hold and reading, by reference: not found, and unchanged.
    await expect(caller(safetyB).fleet.holdRelease({ holdRef: h.holdRef, reason: "releasing another organization's hold" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(leadB).fleet.meterDecide({ readingRef: r.readingRef, decision: "rejected", note: "not ours" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller(dispatcher).fleet.holdList({ unitId: unitA })).holds.map(x => x.status)).toEqual(["active"]);
  });
});

d("the meter record: read where it lives, never copied, never rewritten", () => {
  it("reads telemetry, fuel, work-order, trip and ledger readings with their provenance, and copies none of them", async () => {
    const unitId = await unit(A);
    await pool.execute("INSERT INTO telemetrySnapshots (unitId, recordedAt, odometerKm, engineHours, ptoHours, sourceClientId, inboundEventId) VALUES (?, '2026-09-01 08:00:00', 100000, 4000.5, 900.2, 1, 1)", [unitId]);
    await pool.execute("INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, occurredAt, fuelType, totalCents, odometerKm) VALUES (?, 1, ?, '2026-09-02 08:00:00', 'diesel', 0, 100300)", [`FUEL-${rnd()}`, unitId]);
    const woId = Number(await caller(office).fieldRoute.workOrders.create({ workOrderNumber: `WO-${rnd()}`, unitId, openedAt: new Date("2026-09-03T08:00:00Z"), odometerKm: 100_450, engineHours: 4_012 }));
    const tripId = Number(await caller(dispatcher).fieldRoute.trips.create({ tripNumber: `T-${rnd()}`, unitId, startedAt: new Date("2026-09-04T08:00:00Z"), odometerStartKm: 100_500 }));
    const manual = await caller(mechanic).fleet.meterRecord({ unitId, meterType: "odometer_km", reading: 100_800, recordedAt: new Date("2026-09-05T08:00:00Z"), source: "mechanic" });

    const m = await caller(dispatcher).fleet.meterReadings({ unitId });
    const odo = m.meters.find(x => x.meterType === "odometer_km")!;
    expect(odo.observations.map(o => [o.source, o.sourceTable, o.sourceField, o.value, o.standing])).toEqual([
      ["telematics", "telemetrySnapshots", "odometerKm", 100_000, "accepted"],
      ["fuel_receipt", "fuelTransactions", "odometerKm", 100_300, "accepted"],
      ["work_order", "workOrders", "odometerKm", 100_450, "accepted"],
      ["trip", "trips", "odometerStartKm", 100_500, "accepted"],
      ["ledger", "unitMeterReadings", "reading", 100_800, "provisional"],
    ]);
    expect(odo.observations[2].ref).toBe(`workOrders#${woId}.odometerKm`);
    expect(odo.observations[3].ref).toBe(`trips#${tripId}.odometerStartKm`);
    // An unverified reading is shown, never current.
    expect(odo.current?.ref).toBe(`trips#${tripId}.odometerStartKm`);
    expect(m.meters.map(x => x.meterType)).toEqual(["odometer_km", "engine_hours", "pto_hours"]);
    // No duplicate distance truth: the ledger holds the one reading that had no other home.
    const [[{ n }]] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM unitMeterReadings WHERE unitId = ?", [unitId]) as unknown as [[{ n: number }]];
    expect(Number(n)).toBe(1);
    expect(manual.readingRef).toMatch(/^MTR-/);
  });

  it("evaluates increasing readings, treats identical ones as no progress, and answers METER_REGRESSION for a drop — keeping the reading", async () => {
    const unitId = await unit(A);
    const base = `workOrders#${Number(await caller(office).fieldRoute.workOrders.create({ workOrderNumber: `WO-${rnd()}`, unitId, openedAt: new Date("2026-09-01T08:00:00Z"), odometerKm: 200_000 }))}.odometerKm`;
    await pool.execute("INSERT INTO telemetrySnapshots (unitId, recordedAt, odometerKm, sourceClientId, inboundEventId) VALUES (?, '2026-09-03 08:00:00', 200000, 1, 1)", [unitId]);
    expect(await caller(dispatcher).fleet.meterProgress({ unitId, meterType: "odometer_km", baselineRef: base })).toMatchObject({ status: "evaluable", progress: 0 });
    await pool.execute("INSERT INTO telemetrySnapshots (unitId, recordedAt, odometerKm, sourceClientId, inboundEventId) VALUES (?, '2026-09-05 08:00:00', 201500, 1, 1)", [unitId]);
    expect(await caller(dispatcher).fleet.meterProgress({ unitId, meterType: "odometer_km", baselineRef: base })).toMatchObject({ status: "evaluable", progress: 1_500 });

    // A mechanic types 20,150 for 201,500. The sequence is flagged at once; progress cannot be evaluated.
    const typo = await caller(mechanic).fleet.meterRecord({ unitId, meterType: "odometer_km", reading: 20_150, recordedAt: new Date("2026-09-06T08:00:00Z"), source: "mechanic" });
    expect(typo).toMatchObject({ trust: "UNTRUSTED_METER_SEQUENCE", regressions: [expect.objectContaining({ code: "METER_REGRESSION" })] });
    expect(await caller(dispatcher).fleet.meterProgress({ unitId, meterType: "odometer_km", baselineRef: base })).toMatchObject({ status: "indeterminate", reason: "METER_REGRESSION" });
    expect((await caller(dispatcher).fleet.unitState({ unitId })).reasons).toEqual([expect.objectContaining({ code: "UNTRUSTED_METER_SEQUENCE", status: "warning" })]);
    // The reading is evidence: the database refuses to change what was observed, or to delete it.
    await expect(pool.execute("UPDATE unitMeterReadings SET reading = 201500 WHERE readingRef = ?", [typo.readingRef])).rejects.toThrow(/never edited/);
    await expect(pool.execute("DELETE FROM unitMeterReadings WHERE readingRef = ?", [typo.readingRef])).rejects.toThrow(/never deleted/);

    // Its author may not judge it; a second mechanic rejects it; the evaluation resumes, and the reading stays.
    await expect(caller(mechanic).fleet.meterDecide({ readingRef: typo.readingRef, decision: "rejected", note: "my typo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller(mechanic2).fleet.meterDecide({ readingRef: typo.readingRef, decision: "rejected", note: "Dropped a digit — the dash read 201,500" });
    await expect(caller(shopLead).fleet.meterDecide({ readingRef: typo.readingRef, decision: "verified", note: "second thoughts" })).rejects.toThrow(/already rejected/);
    await expect(pool.execute("UPDATE unitMeterReadings SET verificationStatus = 'verified' WHERE readingRef = ?", [typo.readingRef])).rejects.toThrow(/verified or rejected once/);
    expect(await caller(dispatcher).fleet.meterProgress({ unitId, meterType: "odometer_km", baselineRef: base })).toMatchObject({ status: "evaluable", progress: 1_500 });
    const kept = (await caller(dispatcher).fleet.meterReadings({ unitId, meterType: "odometer_km" })).meters[0].observations.find(o => o.sourceTable === "unitMeterReadings");
    expect(kept).toMatchObject({ value: 20_150, standing: "rejected" });

    // A drop in an accepted source cannot be rejected away: it stays indeterminate from that baseline.
    await pool.execute("INSERT INTO telemetrySnapshots (unitId, recordedAt, odometerKm, sourceClientId, inboundEventId) VALUES (?, '2026-09-07 08:00:00', 150000, 1, 1)", [unitId]);
    expect(await caller(dispatcher).fleet.meterProgress({ unitId, meterType: "odometer_km", baselineRef: base })).toMatchObject({ status: "indeterminate", reason: "METER_REGRESSION" });
  });

  it("records a ledger reading only under a source the caller's role may use; the driver records none in this slice", async () => {
    const unitId = await unit(A);
    await expect(caller(driver).fleet.meterRecord({ unitId, meterType: "odometer_km", reading: 1, source: "mechanic" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(office).fleet.meterRecord({ unitId, meterType: "odometer_km", reading: 1, source: "mechanic" })).rejects.toThrow(/None of your roles records a reading as "mechanic"/);
    await expect(caller(office).fleet.meterRecord({ unitId, meterType: "odometer_km", reading: 5, source: "job_closeout" })).resolves.toMatchObject({ verificationStatus: "unverified" });
    await expect(caller(mechanic).fleet.meterRecord({ unitId, meterType: "engine_hours", reading: 5, recordedAt: new Date(Date.now() + 86_400_000), source: "mechanic" })).rejects.toThrow(/future/);
  });
});
