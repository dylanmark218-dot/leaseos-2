/**
 * Mechanic Portal checkpoint 2 — Defect → Work Order → Repair Evidence → Authorized Return-to-Service.
 *
 *   unit → defect → work order → hold → repair tasks → release (repair evidence)
 *        → independent return to service → derived operational state → dispatch readiness
 *
 * Through the real router, the real readiness composer and the real triggers, as people in their real
 * roles: the arc end to end, and its refusals at every step — wrong role, same person, another
 * organization, an open task, a missing road test, a cancelled work order, a revoked release.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { composeReadiness } from "./readinessComposer";

const URL = process.env.DATABASE_URL;

describe("defect lifecycle — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped lifecycle suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 217_000_000 + Math.floor(Math.random() * 50_000);
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
async function dispatchSubject(orgRef: string) {
  const driverUser = await person(orgRef, ["driver"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, orgRef) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0, ?)", [`JOB-${rnd()}`, orgRef]);
  return { operatorId: Number(op.insertId), jobId: Number(j.insertId) };
}
type Blocker = { code: string; severity: string; overridable?: boolean; overrideClass?: string };
async function readiness(unitId: number, s: { operatorId: number; jobId: number }) {
  const r = await composeReadiness({ operatorId: s.operatorId, unitId, trailerId: null, jobId: s.jobId });
  const blockers = r.eligibility.blockers as unknown as Blocker[];
  return { fingerprint: r.fingerprint, blockers, codes: blockers.map(b => b.code) };
}
const events = async (defectId: number) => (await pool.execute<mysql.RowDataPacket[]>("SELECT eventType, actorUserId, actorRole FROM maintenanceDefectEvents WHERE defectId = ? ORDER BY id", [defectId]))[0];
const holdStatus = async (holdRef: string) => String((await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM unitHolds WHERE holdRef = ?", [holdRef]))[0][0]!.status);
const brakeReport = (unitId: number) => ({ unitId, title: "Air leak at the rear brake chamber", driverStatement: "Hissing at the back left wheel every time I touch the brakes.", severityProposed: "critical" as const });
const goodRelease = (workOrderId: number, defectId: number) => ({
  workOrderId, releaseType: "full" as const, repairSummary: "Replaced the rear left brake chamber and diaphragm; re-bled the line",
  testProcedure: "Applied-pressure leak test at 100 psi, 2 minutes", testResult: "pass" as const, roadTestPerformed: true, resolvedDefectIds: [defectId],
});

let A = "", B = "";
let s: { operatorId: number; jobId: number };
let driver = 0, mechanic = 0, mechanic2 = 0, shopLead = 0, safety = 0, safety2 = 0, dispatcher = 0;
let mechanicB = 0, safetyB = 0;
beforeAll(async () => {
  if (!URL) return;
  A = await org(); B = await org();
  s = await dispatchSubject(A);
  driver = await person(A, ["driver"]); mechanic = await person(A, ["mechanic"]); mechanic2 = await person(A, ["mechanic"]);
  shopLead = await person(A, ["shop_lead"]); safety = await person(A, ["safety"]); safety2 = await person(A, ["safety"]);
  dispatcher = await person(A, ["dispatcher"]);
  mechanicB = await person(B, ["mechanic", "shop_lead"]); safetyB = await person(B, ["safety", "management"]);
});

/** Report, triage, send to shop, assign, start — the common opening of the arc. */
async function intoTheShop(unitId: number) {
  const reported = await caller(driver).maintenance.defectReport(brakeReport(unitId));
  await caller(mechanic).maintenance.defectTriage({ defectId: reported.defectId, severity: "critical", reason: "Confirmed: the chamber diaphragm is ruptured" });
  const wo = await caller(dispatcher).maintenance.defectSendToShop({ defectId: reported.defectId });
  await caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo.workOrderId, toUserId: mechanic });
  await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo.workOrderId, to: "in_progress" });
  return { ...reported, ...wo };
}

d("the arc — a driver's critical defect to an independent return to service, through the API", () => {
  it("holds the unit from the report, keeps it held through the repair and the release, and frees it only on a second person's return to service", async () => {
    const u = await unit(A);
    const clean = await readiness(u, s);

    // 1. The driver reports: their words kept, their proposal stands until triage, and the unit is held at once.
    const reported = await caller(driver).maintenance.defectReport(brakeReport(u));
    expect(reported).toMatchObject({ severity: "critical", unitStatus: "out_of_service" });
    expect(reported.holdRef).toMatch(/^HOLD-/);
    const [row] = (await pool.execute<mysql.RowDataPacket[]>("SELECT severity, severityProposed, driverStatement, source, status FROM maintenanceDefects WHERE id = ?", [reported.defectId]))[0];
    expect(row).toMatchObject({ severity: "critical", severityProposed: "critical", driverStatement: brakeReport(u).driverStatement, source: "driver_report", status: "open" });
    let r = await readiness(u, s);
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "critical_defect", severity: "blocking", overridable: false }),
      expect.objectContaining({ code: "unit_hold_safety", severity: "blocking", overrideClass: "NEVER_OVERRIDABLE" }),
    ]));
    expect(r.fingerprint).not.toBe(clean.fingerprint);

    // 2. Triage confirms. 3. Sent to shop: the work order and its first task in one act. 4. Assigned, started.
    const triaged = await caller(mechanic).maintenance.defectTriage({ defectId: reported.defectId, severity: "critical", reason: "Confirmed: the chamber diaphragm is ruptured" });
    expect(triaged).toMatchObject({ from: "critical", severity: "critical", releasedHoldRefs: [], placedHoldRef: null });
    const wo = await caller(dispatcher).maintenance.defectSendToShop({ defectId: reported.defectId });
    expect(wo.taskRef).toMatch(/^TASK-/);
    await caller(shopLead).maintenance.workOrderAssign({ workOrderId: wo.workOrderId, toUserId: mechanic });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo.workOrderId, to: "in_progress" });

    // 5. No release while a task is open, and none for a critical without a road test.
    await expect(caller(mechanic).shop.workOrderRelease(goodRelease(wo.workOrderId, reported.defectId))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/Unfinished tasks/) });
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "in_progress" });
    await expect(caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/corrective action/) });
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done", findings: "Diaphragm torn along the clamp line", correctiveAction: "Chamber assembly replaced, line re-bled, leak test passed" });
    await expect(caller(mechanic).shop.workOrderRelease({ ...goodRelease(wo.workOrderId, reported.defectId), roadTestPerformed: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/road test/) });

    // 6. The release — the repair's evidence. The unit is still held: nobody has returned it to service.
    const release = await caller(mechanic).shop.workOrderRelease(goodRelease(wo.workOrderId, reported.defectId));
    expect(release.releaseId).toBeGreaterThan(0);
    r = await readiness(u, s);
    expect(r.codes).toEqual(expect.arrayContaining(["unit_hold_safety"]));
    expect((await caller(dispatcher).fleet.unitState({ unitId: u })).status).toBe("out_of_service");

    // 7. Not by the technician who signed it; not by a mechanic who may not lift a safety hold.
    const rts = { workOrderId: wo.workOrderId, releaseId: release.releaseId!, outcome: "pass" as const, summary: "Walk-around, brake application at 100 psi, no audible leak; chamber stroke in spec" };
    await expect(caller(mechanic).maintenance.returnToService(rts)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/signed release/) });
    await expect(caller(mechanic2).maintenance.returnToService(rts)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/may release a safety hold/) });
    await expect(caller(driver).maintenance.returnToService(rts)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await holdStatus(reported.holdRef!)).toBe("active");

    // 8. An independent safety officer verifies: the defect is resolved on that release, the hold lifted,
    //    the work order closed — and the unit is available, with readiness back where it started.
    const back = await caller(safety).maintenance.returnToService(rts);
    expect(back).toMatchObject({ outcome: "pass", resolvedDefectIds: [reported.defectId], releasedHoldRefs: [reported.holdRef], unitStatus: "available" });
    expect(back.inspectionRef).toMatch(/^RTS-/);
    expect(await holdStatus(reported.holdRef!)).toBe("released");
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT status, resolvedByReleaseId, resolvedByUserId FROM maintenanceDefects WHERE id = ?", [reported.defectId]))[0][0]).toMatchObject({ status: "resolved", resolvedByReleaseId: release.releaseId, resolvedByUserId: safety });
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM workOrders WHERE id = ?", [wo.workOrderId]))[0][0]!.status).toBe("closed");
    r = await readiness(u, s);
    expect(r.codes).not.toEqual(expect.arrayContaining(["critical_defect"]));
    expect(r.codes.filter(c => /unit_hold_|critical_defect|mechanic_release_missing/.test(c))).toEqual([]);
    // What blocks this unit is exactly what blocked it before the defect (the fixture's driver documents, if any).
    expect([...r.codes].sort()).toEqual([...clean.codes].sort());

    // Every step left an event, with who acted and in what role.
    const ev = await events(reported.defectId);
    expect(ev.map(e => e.eventType)).toEqual(["reported", "hold_placed", "severity_decided", "sent_to_shop", "task_added", "task_status", "task_status", "released", "returned_to_service", "resolved", "hold_released"]);
    expect(ev.find(e => e.eventType === "reported")).toMatchObject({ actorUserId: driver, actorRole: "driver" });
    expect(ev.find(e => e.eventType === "released")).toMatchObject({ actorUserId: mechanic, actorRole: "mechanic" });
    expect(ev.find(e => e.eventType === "returned_to_service")).toMatchObject({ actorUserId: safety, actorRole: "safety" });

    // And it does not happen twice.
    await expect(caller(safety2).maintenance.returnToService(rts)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/closed/) });
    const history = await caller(mechanic).maintenance.defectHistory({ defectId: reported.defectId });
    expect(history.defect).toMatchObject({ status: "resolved", severityProposed: "critical" });
    expect(history.tasks).toHaveLength(1);
  });

  it("an inspection-required defect held for maintenance is returned to service by another mechanic; a failed verification changes nothing", async () => {
    const u = await unit(A);
    const reported = await caller(driver).maintenance.defectReport({ unitId: u, title: "Marker lamp out, driver side", driverStatement: "Second marker from the front is dark.", severityProposed: "inspection_required" });
    expect(reported.holdRef).toBeNull();
    const triaged = await caller(mechanic).maintenance.defectTriage({ defectId: reported.defectId, severity: "inspection_required", reason: "Lamp and pigtail both corroded; keep it in", holdUnit: true });
    expect(triaged.placedHoldRef).toMatch(/^HOLD-/);
    expect((await readiness(u, s)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unit_hold_maintenance", overrideClass: "APPROVED_POLICY_ONLY" })]));
    const wo = await caller(mechanic).maintenance.defectSendToShop({ defectId: reported.defectId, task: { kind: "replace", title: "Replace marker lamp and pigtail" } });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo.workOrderId, to: "in_progress" });
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done", correctiveAction: "Lamp and pigtail replaced" });
    const release = await caller(mechanic).shop.workOrderRelease({ workOrderId: wo.workOrderId, releaseType: "full", repairSummary: "Lamp and pigtail replaced, circuit tested", testProcedure: "Lamp check", testResult: "pass", resolvedDefectIds: [reported.defectId] });

    // A mechanic may lift a maintenance hold — so here independence is the only thing between the
    // technician who signed the release and the unit's return to service.
    await expect(caller(mechanic).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: release.releaseId!, outcome: "pass", summary: "My own work, verified by me" }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/signed release/) });
    const failed = await caller(mechanic2).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: release.releaseId!, outcome: "fail", summary: "Lamp flickers with the door open — ground still bad" });
    expect(failed).toMatchObject({ outcome: "fail", resolvedDefectIds: [], releasedHoldRefs: [] });
    expect(await holdStatus(triaged.placedHoldRef!)).toBe("active");

    const passed = await caller(mechanic2).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: release.releaseId!, outcome: "pass", summary: "Ground re-made; lamp steady in every door position" });
    expect(passed).toMatchObject({ outcome: "pass", releasedHoldRefs: [triaged.placedHoldRef] });
  });
});

d("a roadside breakdown is closed by the return to service of its repair (S-4)", () => {
  it("the roadside event that grounded the unit closes with the independent verification, not before", async () => {
    const u = await unit(A);
    const rs = await caller(driver).roadside.open({ eventType: "brake_issue", unitId: u, occurredAt: new Date(Date.now() - 3_600_000), vehicleMovable: "no" });
    expect((await readiness(u, s)).codes).toEqual(expect.arrayContaining(["roadside_event_open"]));
    const wo = await caller(dispatcher).maintenance.defectSendToShop({ defectId: rs.defectId });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: wo.workOrderId, to: "in_progress" });
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done", correctiveAction: "Brake valve replaced on the roadside tow-in" });
    const rel = await caller(mechanic).shop.workOrderRelease(goodRelease(wo.workOrderId, rs.defectId));
    // Released, not yet verified: the breakdown still stands.
    expect((await readiness(u, s)).codes).toEqual(expect.arrayContaining(["roadside_event_open"]));
    const back = await caller(mechanic2).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: rel.releaseId!, outcome: "pass", summary: "Brake application verified on the yard" });
    expect(back.closedRoadside).toEqual([rs.eventRef]);
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT status, closedAt FROM roadsideServiceEvents WHERE eventRef = ?", [rs.eventRef]))[0][0]).toMatchObject({ status: "closed", closedAt: expect.any(Date) });
    expect((await readiness(u, s)).codes).not.toEqual(expect.arrayContaining(["roadside_event_open"]));
  });
});

d("refusals at every step", () => {
  it("another organization's unit, defect, task and work order are not found — at every act", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await expect(caller(mechanicB).maintenance.defectReport(brakeReport(u))).rejects.toMatchObject({ code: "NOT_FOUND", message: `Unit ${u} not found` });
    for (const attempt of [
      () => caller(mechanicB).maintenance.defectTriage({ defectId: wo.defectId, severity: "advisory", reason: "Looks fine from here" }),
      () => caller(mechanicB).maintenance.defectSendToShop({ defectId: wo.defectId }),
      () => caller(mechanicB).maintenance.defectHistory({ defectId: wo.defectId }),
    ]) await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND", message: `Defect ${wo.defectId} not found` });
    await expect(caller(mechanicB).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "in_progress" })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Task ${wo.taskRef} not found` });
    await expect(caller(mechanicB).maintenance.taskAdd({ workOrderId: wo.workOrderId, kind: "inspect", title: "Look at it" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(safetyB).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: 1, outcome: "pass", summary: "Not ours to sign" })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Work order ${wo.workOrderId} not found` });
  });

  it("a mechanic may raise a defect to critical but not take one back down; safety may, unless they placed the hold", async () => {
    const u = await unit(A);
    const reported = await caller(driver).maintenance.defectReport(brakeReport(u));
    await expect(caller(mechanic).maintenance.defectTriage({ defectId: reported.defectId, severity: "inspection_required", reason: "Only a slow leak" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/safety hold/) });
    expect(await holdStatus(reported.holdRef!)).toBe("active");
    const lowered = await caller(safety).maintenance.defectTriage({ defectId: reported.defectId, severity: "inspection_required", reason: "Fitting loose, not the chamber; tightened and tested" });
    expect(lowered.releasedHoldRefs).toEqual([reported.holdRef]);

    // A safety officer who reports a critical placed its hold, and may not lower it themselves.
    const u2 = await unit(A);
    const reporter = await person(A, ["safety", "mechanic"]);
    const theirs = await caller(reporter).maintenance.defectReport(brakeReport(u2));
    await expect(caller(reporter).maintenance.defectTriage({ defectId: theirs.defectId, severity: "advisory", reason: "On reflection it is fine" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/placed a hold may not release it/) });
  });

  it("the hold is the defect's: fleet.holdRelease will not lift it, and cancelling the work order repairs, resolves and releases nothing", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await expect(caller(safety).fleet.holdRelease({ holdRef: wo.holdRef!, reason: "Looks repaired" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller(shopLead).maintenance.workOrderCancel({ workOrderId: wo.workOrderId, reason: "Going to the dealer under warranty" });
    expect(await holdStatus(wo.holdRef!)).toBe("active");
    expect((await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM maintenanceDefects WHERE id = ?", [wo.defectId]))[0][0]!.status).not.toBe("resolved");
    await expect(caller(safety).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: 1, outcome: "pass", summary: "Nothing was done" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/cancelled/) });
    // The defect can go back to the shop on a new work order.
    const again = await caller(dispatcher).maintenance.defectSendToShop({ defectId: wo.defectId });
    expect(again.workOrderId).not.toBe(wo.workOrderId);
  });

  it("a revoked release does not stand for a return to service, and a release that names no defect verifies nothing", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done", correctiveAction: "Chamber replaced" });
    const unnamed = await caller(mechanic).shop.workOrderRelease({ ...goodRelease(wo.workOrderId, wo.defectId), resolvedDefectIds: [] });
    await expect(caller(safety).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: unnamed.releaseId!, outcome: "pass", summary: "Verified" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/names no defect/) });
    const named = await caller(mechanic).shop.workOrderRelease(goodRelease(wo.workOrderId, wo.defectId));
    await caller(shopLead).records.maintenance.revokeRelease({ workOrderId: wo.workOrderId, reason: "Chamber was the wrong part number" });
    await expect(caller(safety).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: named.releaseId!, outcome: "pass", summary: "Verified" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/does not stand/) });
    expect(await holdStatus(wo.holdRef!)).toBe("active");
  });

  it("there is one release door: records.maintenance.recordRelease is closed and points to it", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await expect(caller(mechanic).records.maintenance.recordRelease({ workOrderId: wo.workOrderId, releaseType: "full", repairSummary: "Brake chamber replaced", roadTestPerformed: true, technicianIdentifier: "TECH-1" } as never))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/shop\.workOrderRelease/) });
    expect(Number((await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workOrderReleases WHERE workOrderId = ?", [wo.workOrderId]))[0][0]!.n)).toBe(0);
  });

  it("tasks move forward only, and a finished one is history", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await expect(caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "deferred" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/reason/) });
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "not_required", findings: "Leak was the gladhand seal, covered by the second task" });
    await expect(caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "in_progress" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/finished/) });
    await expect(pool.execute("UPDATE workOrderTasks SET status = 'open' WHERE taskRef = ?", [wo.taskRef])).rejects.toThrow(/finished work-order task is history/);
    await expect(pool.execute("DELETE FROM workOrderTasks WHERE taskRef = ?", [wo.taskRef])).rejects.toThrow(/never deleted/);
    await expect(pool.execute("UPDATE maintenanceDefectEvents SET actorUserId = 1 WHERE defectId = ?", [wo.defectId])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM maintenanceDefectEvents WHERE defectId = ?", [wo.defectId])).rejects.toThrow(/append-only/);
  });

  it("a return-to-service inspection, once signed, cannot be edited or removed", async () => {
    const u = await unit(A);
    const wo = await intoTheShop(u);
    await caller(mechanic).maintenance.taskSetStatus({ taskRef: wo.taskRef, status: "done", correctiveAction: "Chamber replaced" });
    const rel = await caller(mechanic).shop.workOrderRelease(goodRelease(wo.workOrderId, wo.defectId));
    const back = await caller(safety).maintenance.returnToService({ workOrderId: wo.workOrderId, releaseId: rel.releaseId!, outcome: "pass", summary: "Verified at 100 psi" });
    await expect(pool.execute("UPDATE inspections SET outcome = 'fail' WHERE inspectionRef = ?", [back.inspectionRef])).rejects.toThrow(/never edited/);
    await expect(pool.execute("DELETE FROM inspections WHERE inspectionRef = ?", [back.inspectionRef])).rejects.toThrow(/never deleted/);
  });
});
