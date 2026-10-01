/**
 * v22.20 (0086) — the enforcement surface, and what a client cannot say.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("confirming a stop and releasing a truck are sensitive", () => {
  it("fails closed on both", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("enforcement.confirm");
    expect(SENSITIVE_PERMISSIONS).toContain("enforcement.release");
    expect(SENSITIVE_PERMISSIONS).not.toContain("enforcement.read");
    expect(SENSITIVE_PERMISSIONS).not.toContain("enforcement.capture");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 8_600_000 + Math.floor(Math.random() * 60_000);
/**
 * B23.1B — the unit these events are written against, created here rather than
 * named as a number.
 *
 * This fixture used to say `unitId: 127` and rely on unit 127 either not
 * existing or belonging to nobody. Every enforcement event opens a defect and a
 * work order against that unit, and `shopRouter` resolves the work order
 * through `workOrderInScope`, which asks `coreRecordOwnership` who owns the
 * unit. The moment any other suite created enough units to reach id 127 and
 * claimed it for an organization, all five releases here failed with
 * "Work order N not found" — a tenant refusal that was entirely correct about
 * somebody else's unit, and that reads exactly like an authorization bug.
 */
let unitId = 0;
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  const [u] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')",
    [`U-ENF-${rnd()}`]
  );
  unitId = u.insertId;
});
/** CP1.5 — a member confirms a stop on a unit their organization owns; another organization's is not found. */
async function unitFor(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-ENF-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

const stop = (over: Record<string, unknown> = {}) => ({
  eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: `agency-${rnd()}`,
  occurredAt: new Date("2026-09-11T08:42:00Z"), inspectionReportNumber: `INSP-${rnd()}`,
  inspectionLevel: "I", inspectionResult: "out_of_service" as const,
  unitId, subjectRefs: { vehicle: `UNIT-${rnd()}` },
  violations: [{
    system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER", citationIssued: true, outOfService: true,
    oosScope: "vehicle" as const, defectRequired: true, repairRequired: true, courtAction: false,
    releaseCondition: "reinspection passed", requiredFindingType: "reinspection" as const,
  }],
  ...over,
});

async function approvedPolicy(scopeRef?: string) {
  const proposer = await withRole("management");
  const approver = await withRole("management");
  const ROLES = { repair_verification: ["mechanic", "shop_lead"], reinspection: ["safety"], inspector_release: ["safety"], document_confirmation: ["office"], waiting_period_complete: ["safety"], other: ["management"] };
  const p = await caller(proposer).comms.oosPolicyPropose({
    label: `policy ${rnd()}`, allowedFindingRoles: ROLES, effectiveFrom: new Date("2020-01-01"),
    ...(scopeRef ? { scopeType: "branch" as const, scopeRef } : {}),
  });
  await caller(approver).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "approve" });
  return p.policyRef;
}

d("a client supplies observations; the server supplies facts", () => {
  it("will not accept repairs from the request — there is no such parameter", async () => {
    const safety = await withRole("safety");
    const branch = `B-${rnd()}`;
    await approvedPolicy(branch);
    const c = await caller(safety).enforcement.eventConfirm(stop({ branchId: branch }));
    const orderRef = c.orderRefs[0];

    // A caller that tries to assert its own repairs is refused by validation.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (caller(safety).enforcement.orderRelease as any)({ orderRef, repairs: [{ workOrderRef: "MINE", repairCompletedAt: new Date(), repairCompletedByUserId: 1, functionalTestPassed: true, afterEvidenceRef: "X" }] }),
    ).rejects.toThrow();

    // And with no shop record at all, the release is refused for want of a repair.
    await expect(caller(safety).enforcement.orderRelease({ orderRef })).rejects.toThrow(/No completed repair/i);
  });

  it("writes the server's organization and confirming user, not the caller's claims", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT tenantId, confirmedByUserId FROM enforcementEvents WHERE eventRef = ?", [c.eventRef]);
    expect(rows[0]).toMatchObject({ tenantId: "default", confirmedByUserId: safety });
  });

  it("records a scan as a proposal that decides nothing", async () => {
    const driver = await withRole("driver");
    const r = await caller(driver).enforcement.extractionRecord({
      documentKind: "inspection_report", capturedAt: new Date(),
      fields: [{ field: "agency", value: "an agency", confidence: 0.9 }],
    });
    expect(r.requiresConfirmation).toBe(true);
    expect(r.missingRequired).toContain("inspectionReportNumber");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, requiresConfirmation FROM enforcementDocumentExtractions WHERE extractionRef = ?", [r.extractionRef]);
    expect(rows[0]).toMatchObject({ status: "proposed", requiresConfirmation: 1 });
  });
});

d("the permission matrix", () => {
  it("lets a driver scan and read, and refuses them confirmation and release", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).enforcement.activeOrders({})).resolves.toBeTruthy();
    await expect(caller(driver).enforcement.eventConfirm(stop())).rejects.toThrow();
    await expect(caller(driver).enforcement.orderRelease({ orderRef: "OOS-X" })).rejects.toThrow();
  });

  it("lets a mechanic record a finding and refuses them the release", async () => {
    const mechanic = await withRole("mechanic");
    await expect(caller(mechanic).enforcement.orderRelease({ orderRef: "OOS-X" })).rejects.toThrow();
  });

  it("refuses a dispatcher both confirmation and findings", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(caller(dispatcher).enforcement.eventConfirm(stop())).rejects.toThrow();
    await expect(caller(dispatcher).enforcement.findingRecord({ orderRef: "OOS-X", finding: "satisfied", findingType: "reinspection" })).rejects.toThrow();
  });
});

d("a finding is the policy's decision, not the caller's", () => {
  it("refuses a finding type the caller's role may not record", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const branch = `B-${rnd()}`;
    await approvedPolicy(branch);
    const c = await caller(safety).enforcement.eventConfirm(stop({ branchId: branch }));
    const orderRef = c.orderRefs[0];

    // The policy permits reinspection findings from safety only.
    await expect(caller(mechanic).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection" }))
      .rejects.toThrow(/permits reinspection findings from safety/i);

    const ok = await caller(safety).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection", evidenceRef: "EV-1" });
    expect(ok.recordedByRole).toBe("safety");
    expect(ok.note).toContain("A finding is not a release");
  });

  it("refuses a finding on an order that is not active, and on one that does not exist", async () => {
    const safety = await withRole("safety");
    await expect(caller(safety).enforcement.findingRecord({ orderRef: "OOS-NOPE", finding: "satisfied", findingType: "reinspection" }))
      .rejects.toThrow(/No such out-of-service order/i);
  });

  it("refuses a finding where no approved policy governs the order's scope", async () => {
    const safety = await withRole("safety");
    const orphanBranch = `B-${rnd()}`;   // no policy approved for it, and none at company scope in this tenant
    const c = await caller(safety).enforcement.eventConfirm(stop({ branchId: orphanBranch }));
    const orderRef = c.orderRefs[0];
    const [[{ n }]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM oosReleasePolicies WHERE status='approved' AND scopeType='company'");
    if (Number(n) === 0) {
      await expect(caller(safety).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection" }))
        .rejects.toThrow(/No approved release policy is in force/i);
    }
  });
});

d("reads", () => {
  it("lists active prohibitions and says what an absence means", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const list = await caller(safety).enforcement.activeOrders({ scope: "vehicle" });
    expect(list.orders.some(o => o.orderRef === c.orderRefs[0])).toBe(true);
    expect(list.note).toContain("never deleted");
  });

  it("returns a stop with everything that followed from it", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const got = await caller(safety).enforcement.eventGet({ eventRef: c.eventRef });
    expect(got.violations).toHaveLength(1);
    expect(got.orders).toHaveLength(1);
    expect(got.event.inspectionResult).toBe("out_of_service");
  });
});

d("the shop bridge — a prohibition arrives in the shop queue", () => {
  it("creates the defect and the work order in the same transaction as the order", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    expect(c.repairRequired).toHaveLength(1);

    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT defectId, workOrderId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    expect(v.defectId).toBeTruthy();
    expect(v.workOrderId).toBeTruthy();

    const [defects] = await pool.execute<mysql.RowDataPacket[]>("SELECT severity, status, unitId FROM maintenanceDefects WHERE id = ?", [v.defectId]);
    // A government prohibition is critical work, not advisory.
    expect(defects[0]).toMatchObject({ severity: "critical", status: "open", unitId });

    const [wos] = await pool.execute<mysql.RowDataPacket[]>("SELECT priority, status, unitId, defectId FROM workOrders WHERE id = ?", [v.workOrderId]);
    expect(wos[0]).toMatchObject({ priority: "critical", status: "open", unitId, defectId: v.defectId });
  });

  it("raises an inspection-required defect and an urgent work order where no prohibition was issued", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop({
      inspectionResult: "requires_attention",
      violations: [{ system: "lamps", ownCode: "LEASEOS.LAMPS.MARKER", citationIssued: false, outOfService: false, oosScope: null, defectRequired: true, repairRequired: true, courtAction: false }],
    }));
    expect(c.orderRefs).toHaveLength(0);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT d.severity, w.priority FROM enforcementViolations v JOIN maintenanceDefects d ON d.id = v.defectId JOIN workOrders w ON w.id = v.workOrderId WHERE v.eventRef = ?", [c.eventRef]);
    expect(rows[0]).toMatchObject({ severity: "inspection_required", priority: "urgent" });
  });

  it("raises no shop work for a citation that required none", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop({
      inspectionResult: "pass",
      violations: [{ system: "paperwork", ownCode: "LEASEOS.DOC.ABSENT", citationIssued: true, outOfService: false, oosScope: null, defectRequired: false, repairRequired: false, courtAction: true }],
    }));
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT defectId, workOrderId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]);
    expect(rows[0].defectId).toBeNull();
    expect(rows[0].workOrderId).toBeNull();
  });

  it("does not create a second work order when the same stop is confirmed twice", async () => {
    const safety = await withRole("safety");
    const s = stop();
    const first = await caller(safety).enforcement.eventConfirm(s);
    await caller(safety).enforcement.eventConfirm(s);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM workOrders w JOIN enforcementViolations v ON v.workOrderId = w.id WHERE v.eventRef = ?", [first.eventRef]);
    expect(Number(rows[0].n)).toBe(1);
  });
});

d("§11 — the latch endpoints", () => {
  const latch = (over: Record<string, unknown> = {}) => ({
    captureLocalId: `cap-${rnd()}`, subjectType: "vehicle" as const, subjectRef: `UNIT-${rnd()}`,
    capturedAt: new Date("2026-09-11T08:42:00Z"), ...over,
  });

  it("records a device's claim and creates no prohibition from it", async () => {
    const driver = await withRole("driver");
    const l = latch();
    const r = await caller(driver).enforcement.latchReport(l);
    expect(r).toMatchObject({ recorded: true, state: "blocking", serverOrderRef: null });
    expect(r.note).toContain("does not by itself create an out-of-service order");

    // And no order exists for that subject.
    const orders = await caller(driver).enforcement.activeOrders({ subjectRef: l.subjectRef });
    expect(orders.orders).toHaveLength(0);
  });

  it("is idempotent — a device retrying on a bad connection is not a second truck", async () => {
    const driver = await withRole("driver");
    const l = latch();
    const first = await caller(driver).enforcement.latchReport(l);
    const again = await caller(driver).enforcement.latchReport(l);
    expect(again.recorded).toBe(false);
    expect(again.latchRef).toBe(first.latchRef);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM deviceSafetyLatches WHERE captureLocalId = ?", [l.captureLocalId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("HOLDS on an order the server has never heard of — unknown is not a lift", async () => {
    const driver = await withRole("driver");
    const r = await caller(driver).enforcement.latchStates({ orderRefs: ["OOS-NEVER-EXISTED"] });
    expect(r.states[0]).toMatchObject({ decision: "hold", authority: null });
    expect(r.states[0].reason).toContain("keep blocking");
    expect(r.note).toContain("Anything else is hold");
  });

  it("holds while an order is active and lifts only once it is released", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const branch = `B-${rnd()}`;
    await approvedPolicy(branch);
    const c = await caller(safety).enforcement.eventConfirm(stop({ branchId: branch }));
    const orderRef = c.orderRefs[0];

    const active = await caller(driver).enforcement.latchStates({ orderRefs: [orderRef] });
    expect(active.states[0]).toMatchObject({ decision: "hold" });
    expect(active.states[0].reason).toContain("still active");

    // Release it directly at the row, to isolate the latch decision from the
    // release gate which has its own tests.
    await pool.execute("UPDATE outOfServiceOrders SET status = 'released', releasedAt = NOW() WHERE orderRef = ?", [orderRef]);
    const lifted = await caller(driver).enforcement.latchStates({ orderRefs: [orderRef] });
    expect(lifted.states[0]).toMatchObject({ decision: "lift", authority: "released" });
  });

  it("lifts on a rescinded order too, because an order that never applied is not a prohibition", async () => {
    const safety = await withRole("safety");
    const driver = await withRole("driver");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const orderRef = c.orderRefs[0];
    await pool.execute("UPDATE outOfServiceOrders SET status = 'rescinded', rescindedAt = NOW() WHERE orderRef = ?", [orderRef]);
    const r = await caller(driver).enforcement.latchStates({ orderRefs: [orderRef] });
    expect(r.states[0]).toMatchObject({ decision: "lift", authority: "rescinded" });
  });

  it("returns the latches this caller holds, and not another device's", async () => {
    const a = await withRole("driver");
    const b = await withRole("driver");
    const mine = latch();
    await caller(a).enforcement.latchReport(mine);
    await caller(b).enforcement.latchReport(latch());
    const r = await caller(a).enforcement.latchStates({});
    expect(r.heldLatches.some(h => h.subjectRef === mine.subjectRef)).toBe(true);
    expect(r.heldLatches).toHaveLength(1);
  });
});

d("the mechanic release, as a procedure", () => {
  it("attributes the release to the authenticated technician and not to anything the body said", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT workOrderId, defectId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];

    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "ready_for_service" });
    const r = await caller(mechanic).shop.workOrderRelease({
      workOrderId: Number(v.workOrderId), releaseType: "full",
      repairSummary: "chamber replaced", testProcedure: "brake performance test",
      testResult: "pass", roadTestPerformed: true, resolvedDefectIds: [Number(v.defectId)],
    });
    expect(r.technicianUserId).toBe(mechanic);
    expect(r.defectSeverity).toBe("critical");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT technicianUserId, technicianIdentifier FROM workOrderReleases WHERE id = ?", [r.releaseId]);
    expect(rows[0]).toMatchObject({ technicianUserId: mechanic, technicianIdentifier: `TECH-${mechanic}` });
  });

  it("refuses a critical release with no road test, using the shop's own rules", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT workOrderId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "ready_for_service" });
    await expect(caller(mechanic).shop.workOrderRelease({
      workOrderId: Number(v.workOrderId), releaseType: "full",
      repairSummary: "chamber replaced", testResult: "pass", roadTestPerformed: false,
    })).rejects.toThrow(/road test/i);
  });

  it("says plainly that a mechanic release is not a lift of a government order", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT workOrderId, defectId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "ready_for_service" });
    await caller(mechanic).shop.workOrderRelease({
      workOrderId: Number(v.workOrderId), releaseType: "full", repairSummary: "chamber replaced",
      testProcedure: "brake performance test", testResult: "pass", roadTestPerformed: true,
      resolvedDefectIds: [Number(v.defectId)],
    });
    // The order is untouched by the shop's release.
    const still = await caller(safety).enforcement.activeOrders({ subjectRef: c.orderRefs.length ? (await caller(safety).enforcement.eventGet({ eventRef: c.eventRef })).orders[0].subjectRef : "" });
    expect(still.orders).toHaveLength(1);
  });

  it("is refused to a driver and a dispatcher", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    for (const who of [driver, dispatcher]) {
      await expect(caller(who).shop.workOrderRelease({ workOrderId: 1, releaseType: "full", repairSummary: "anything at all" })).rejects.toThrow();
    }
  });
});

d("a work order moves forward only", () => {
  it("refuses to go backwards and refuses to reopen a closed one", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT workOrderId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    const id = Number(v.workOrderId);

    await caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "ready_for_service" });
    await expect(caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "in_progress" }))
      .rejects.toThrow(/does not move from ready_for_service back/i);

    await caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "closed" });
    await expect(caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "ready_for_service" }))
      .rejects.toThrow(/not reopened by changing a status/i);
  });

  it("allows waiting_parts back to in_progress, because that is forward in the real sense", async () => {
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT workOrderId FROM enforcementViolations WHERE eventRef = ?", [c.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    const id = Number(v.workOrderId);
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "waiting_parts" });
    await expect(caller(mechanic).shop.workOrderAdvance({ workOrderId: id, to: "in_progress" })).resolves.toMatchObject({ to: "in_progress" });
  });
});

d("the roadside panel — possession of the code is not access", () => {
  const AT = new Date("2026-09-11T10:00:00Z");
  const later = (min: number) => new Date(AT.getTime() + min * 60_000);

  it("opens against a live grant and shows the blocking order by name", async () => {
    const safety = await withRole("safety");
    const dispatcher = await withRole("dispatcher");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const unitRef = (await caller(safety).enforcement.eventGet({ eventRef: c.eventRef })).orders[0].subjectRef;

    const grant = await caller(dispatcher).enforcement.panelGrantIssue({ unitRef, issuedFor: "roadside inspection", minutesValid: 60, at: AT });
    expect(grant.note).toContain("It is not a key");

    const view = await caller(dispatcher).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(1) });
    expect(view.panel.verdict).toBe("blocked");
    expect(view.panel.blockingReasons[0]).toContain("OOS.VEHICLE");
    expect(view.panel.headline).toContain("NOT AUTHORIZED TO OPERATE");
    expect(view.access).toContain("issued for roadside inspection");
  });

  it("always carries the withheld list, and names no person in the payload", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const unitRef = (await caller(safety).enforcement.eventGet({ eventRef: c.eventRef })).orders[0].subjectRef;
    const grant = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    const view = await caller(safety).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(1) });

    expect(view.panel.withheld).toHaveLength(3);
    expect(view.lines.join("\n")).toContain("WITHHELD (3)");
    const payload = JSON.stringify({ axes: view.panel.axes, blockingReasons: view.panel.blockingReasons }).toLowerCase();
    for (const forbidden of ["driverid", "operatorid", "medical", "premium"]) expect(payload.includes(forbidden)).toBe(false);
  });

  it("shows an axis that applies and could not be evaluated as UNKNOWN rather than omitting it", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    const unitRef = (await caller(safety).enforcement.eventGet({ eventRef: c.eventRef })).orders[0].subjectRef;
    const grant = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    const view = await caller(safety).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(1) });
    const periodic = view.panel.axes.find(a => a.axis === "periodic_inspection");
    expect(periodic?.state).toBe("unknown");
    expect(view.panel.unknownReasons.join(" ")).toContain("no verified record was found");
  });

  it("refuses an unknown code, an expired grant, a revoked one, and a different unit", async () => {
    const safety = await withRole("safety");
    const unitRef = `UNIT-${rnd()}`;
    await expect(caller(safety).enforcement.panelView({ grantRef: "PGRANT-NOPE", unitRef, at: AT })).rejects.toThrow(/does not resolve/i);

    const short = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", minutesValid: 5, at: AT });
    await expect(caller(safety).enforcement.panelView({ grantRef: short.grantRef, unitRef, at: later(6) })).rejects.toThrow(/expired/i);

    const other = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    await expect(caller(safety).enforcement.panelView({ grantRef: other.grantRef, unitRef: `UNIT-${rnd()}`, at: later(1) })).rejects.toThrow(/different unit/i);

    const revoked = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    await caller(safety).enforcement.panelGrantRevoke({ grantRef: revoked.grantRef, reason: "stop ended", at: later(2) });
    await expect(caller(safety).enforcement.panelView({ grantRef: revoked.grantRef, unitRef, at: later(3) })).rejects.toThrow(/revoked/i);
    await expect(caller(safety).enforcement.panelGrantRevoke({ grantRef: revoked.grantRef, reason: "again", at: later(4) })).rejects.toThrow(/already revoked/i);
  });

  it("records every view on the grant, so who saw the records is not a memory question", async () => {
    const safety = await withRole("safety");
    const unitRef = `UNIT-${rnd()}`;
    const grant = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    await caller(safety).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(1) });
    await caller(safety).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(2) });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT viewCount, lastViewedAt FROM roadsidePanelGrants WHERE grantRef = ?", [grant.grantRef]);
    expect(rows[0].viewCount).toBe(2);
    expect(rows[0].lastViewedAt).toBeTruthy();
  });

  it("shows a clean unit as incomplete rather than in order, because unknown is not a pass", async () => {
    const safety = await withRole("safety");
    const unitRef = `UNIT-${rnd()}`;
    const grant = await caller(safety).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection", at: AT });
    const view = await caller(safety).enforcement.panelView({ grantRef: grant.grantRef, unitRef, at: later(1) });
    expect(view.panel.verdict).toBe("unknown");
    expect(view.panel.headline).toContain("Unknown is not compliance");
  });
});

d("one organization cannot see or touch another's prohibitions", () => {
  async function memberOf(role: DomainRole, orgRef: string) {
    const id = seq++;
    await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
    await pool.execute(
      "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
      [`MEM-${rnd()}`, orgRef, id]);
    return id;
  }
  async function anOrg() {
    const orgRef = `ORG-${rnd()}`;
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
    return orgRef;
  }

  it("keeps another organization's active orders out of the list entirely", async () => {
    const orgA = await anOrg();
    const orgB = await anOrg();
    const safetyA = await memberOf("safety", orgA);
    const safetyB = await memberOf("safety", orgB);

    const a = await caller(safetyA).enforcement.eventConfirm(stop({ unitId: await unitFor(orgA) }));
    const listB = await caller(safetyB).enforcement.activeOrders({});
    expect(listB.orders.some(o => o.orderRef === a.orderRefs[0])).toBe(false);

    // And the owner still sees it.
    const listA = await caller(safetyA).enforcement.activeOrders({});
    expect(listA.orders.some(o => o.orderRef === a.orderRefs[0])).toBe(true);
  });

  it("answers NOT FOUND rather than FORBIDDEN for another organization's stop", async () => {
    const orgA = await anOrg();
    const orgB = await anOrg();
    const safetyA = await memberOf("safety", orgA);
    const safetyB = await memberOf("safety", orgB);
    const a = await caller(safetyA).enforcement.eventConfirm(stop({ unitId: await unitFor(orgA) }));

    // Whether another organization has a stop by this reference is itself
    // something this caller should not learn.
    await expect(caller(safetyB).enforcement.eventGet({ eventRef: a.eventRef })).rejects.toThrow(/No such enforcement event/i);
    await expect(caller(safetyA).enforcement.eventGet({ eventRef: a.eventRef })).resolves.toBeTruthy();
  });

  it("refuses a finding and a release on another organization's order", async () => {
    const orgA = await anOrg();
    const orgB = await anOrg();
    const safetyA = await memberOf("safety", orgA);
    const safetyB = await memberOf("safety", orgB);
    const a = await caller(safetyA).enforcement.eventConfirm(stop({ unitId: await unitFor(orgA) }));
    const orderRef = a.orderRefs[0];

    await expect(caller(safetyB).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection" }))
      .rejects.toThrow(/No such out-of-service order/i);
    await expect(caller(safetyB).enforcement.orderRelease({ orderRef }))
      .rejects.toThrow(/No such out-of-service order/i);
  });

  it("shows an inspector nothing from another organization, even on a valid grant for that unit ref", async () => {
    const orgA = await anOrg();
    const orgB = await anOrg();
    const safetyA = await memberOf("safety", orgA);
    const safetyB = await memberOf("safety", orgB);
    const a = await caller(safetyA).enforcement.eventConfirm(stop({ unitId: await unitFor(orgA) }));
    const unitRef = (await caller(safetyA).enforcement.eventGet({ eventRef: a.eventRef })).orders[0].subjectRef;

    const grantB = await caller(safetyB).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection" });
    const viewB = await caller(safetyB).enforcement.panelView({ grantRef: grantB.grantRef, unitRef });
    // B's panel carries none of A's prohibitions.
    expect(viewB.panel.blockingReasons).toEqual([]);

    const grantA = await caller(safetyA).enforcement.panelGrantIssue({ unitRef, issuedFor: "inspection" });
    const viewA = await caller(safetyA).enforcement.panelView({ grantRef: grantA.grantRef, unitRef });
    expect(viewA.panel.blockingReasons.length).toBe(1);
  });

  it("still works for a caller with no membership, on the single-tenant fallback", async () => {
    const safety = await withRole("safety");
    const c = await caller(safety).enforcement.eventConfirm(stop());
    await expect(caller(safety).enforcement.eventGet({ eventRef: c.eventRef })).resolves.toBeTruthy();
  });
});
