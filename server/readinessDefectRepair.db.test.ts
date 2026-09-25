/**
 * The readiness-defect repair, against a real database.
 *
 * Written before the repair and RED at `f21cd1b`. Every case here reproduces a defect the MariaDB
 * execution package confirmed (X-1 … X-8), and the whole file exists because
 * `readinessComposer`'s critical-defect derivation had no coverage at all: the one integration
 * test that cleared a critical defect did it with a raw `UPDATE ... SET status = 'resolved'` that
 * no production caller can perform, so it could not tell the two mechanisms apart.
 *
 * Two rules this file keeps:
 *   nothing here reimplements readiness — it calls `composeReadiness` and the real tRPC callers;
 *   a skipped suite is a failure, not a pass, so the precondition is asserted unconditionally.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { composeReadiness } from "./readinessComposer";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;

describe("readiness defect repair — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped readiness suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 710000 + Math.floor(Math.random() * 40000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = nextUser();
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

const HOUR = 3_600_000;
let mechanic = 0, shopLead = 0, dispatcher = 0, driverOnly = 0;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
  mechanic = await withRole("mechanic");
  shopLead = await withRole("shop_lead");
  dispatcher = await withRole("dispatcher");
  driverOnly = await withRole("driver");
});

/**
 * A unit, operator and job whose only *blocking* axis is the mechanic/defect one. The ambient
 * `unknown` and `review` blockers (hours, medical, route, destination) are deliberately left as
 * they are: this suite asserts on named blocker codes, never on the overall verdict alone.
 */
async function scenario(tag: string, orgRef: string | null = null) {
  const driverUser = await withRole("driver");
  const [u] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key(tag).slice(0, 30)]);
  const unitId = Number(u.insertId);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, unitId]);
  const [op] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const operatorId = Number(op.insertId);
  const [j] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0)", [key("JOB").slice(0, 40)]);
  const jobId = Number(j.insertId);
  for (const [t, title] of [["cvip_certificate", "CVIP"], ["vehicle_registration", "Registration"], ["insurance_proof", "Pink card"]]) {
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, title]);
  }
  const [insr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status) VALUES (?, ?, 'insurer', 'active')", [key("PRV").slice(0, 40), key("Ins").slice(0, 60)]);
  const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insurancePolicies (policyRef, financialEntityId, insurerId, policyType, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus) VALUES (?, 1, ?, 'commercial_auto', ?, DATE_SUB(NOW(), INTERVAL 60 DAY), DATE_ADD(NOW(), INTERVAL 300 DAY), 'active', 'coverage_verified')", [key("POL").slice(0, 40), Number(insr.insertId), key("PN").slice(0, 40)]);
  const policyId = Number(pol.insertId);
  await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, additionalInsuredEndorsement) VALUES (?, 'commercial_auto', 5000000, 1)", [policyId]);
  await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'unit', ?, DATE_SUB(NOW(), INTERVAL 60 DAY))", [policyId, unitId]);
  return { unitId, operatorId, jobId };
}

async function addDefect(unitId: number, severity: "advisory" | "inspection_required" | "critical", hoursAgo: number, title: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, ?, ?, 'open', DATE_SUB(NOW(), INTERVAL ? HOUR), 1)",
    [unitId, title, severity, hoursAgo]);
  return Number(r.insertId);
}

async function addWorkOrder(unitId: number, defectId: number | null, status = "in_progress") {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO workOrders (workOrderNumber, unitId, defectId, status, priority, openedAt) VALUES (?, ?, ?, ?, 'routine', DATE_SUB(NOW(), INTERVAL 6 HOUR))",
    [key("WO").slice(0, 60), unitId, defectId, status]);
  return Number(r.insertId);
}

/** What the production readiness path said about the mechanic/defect axis. */
async function readiness(s: { operatorId: number; unitId: number; jobId: number }) {
  const r = await composeReadiness({ operatorId: s.operatorId, unitId: s.unitId, trailerId: null, jobId: s.jobId });
  const has = (code: string) => r.eligibility.blockers.some(b => b.code === code);
  const cap = (name: string) => r.capabilities.find(c => c.capability === name);
  return {
    verdict: r.eligibility.verdict,
    criticalDefect: has("critical_defect"),
    releaseMissing: has("mechanic_release_missing"),
    mechanic: cap("mechanic release")?.status ?? "ABSENT",
    enforcement: cap("enforcement orders")?.status ?? "ABSENT",
    enforcementDetail: (cap("enforcement orders") as { detail?: string } | undefined)?.detail ?? null,
    blocking: r.eligibility.blockers.filter(b => b.severity === "blocking").map(b => b.code).sort(),
    nonOverridable: r.eligibility.blockers.filter(b => !b.overridable).map(b => b.code).sort(),
    codes: r.eligibility.blockers.map(b => b.code).sort(),
  };
}

const defectRow = async (id: number) =>
  (await pool.execute<mysql.RowDataPacket[]>("SELECT id, severity, status FROM maintenanceDefects WHERE id = ?", [id]))[0][0];

/** A fully evidenced release for a critical defect, through the production procedure. */
const releaseFor = (userId: number, workOrderId: number, defectIds: number[], releasedAt: Date) =>
  caller(userId).shop.workOrderRelease({
    workOrderId, releaseType: "full", repairSummary: "Replaced brake chamber diaphragm",
    testProcedure: "Static leak test", testResult: "pass", roadTestPerformed: true,
    resolvedDefectIds: defectIds, releasedAt,
  });

/* ================================================================== */
/* Mechanic release and critical defects                               */
/* ================================================================== */

d("a critical defect clears only through explicit, defect-specific resolution", () => {
  it("M1. open critical defect, no release — BLOCKED, non-overridable", async () => {
    const s = await scenario("M1");
    await addDefect(s.unitId, "critical", 2, "Brake air leak");
    const r = await readiness(s);
    expect(r.criticalDefect).toBe(true);
    expect(r.releaseMissing).toBe(true);
    expect(r.mechanic).toBe("BLOCKED");
    expect(r.nonOverridable).toContain("critical_defect");
    expect(r.verdict).toBe("blocked");
  });

  it("M2. X-1/X-3 — an unrelated release on another work order cannot clear it", async () => {
    const s = await scenario("M2");
    const crit = await addDefect(s.unitId, "critical", 2, "Brake air leak");
    // A separate work order with no defect attached: judged `advisory`, so it needs no test at all.
    const wo = await addWorkOrder(s.unitId, null);
    const out = await caller(mechanic).shop.workOrderRelease({
      workOrderId: wo, releaseType: "full", repairSummary: "Replaced a mudflap bracket",
      roadTestPerformed: false, resolvedDefectIds: [], releasedAt: new Date(Date.now() - HOUR),
    });
    expect(out.defectSeverity).toBe("advisory");
    const r = await readiness(s);
    expect(r.criticalDefect, "an advisory release on another work order must not clear a critical defect").toBe(true);
    expect((await defectRow(crit)).status).toBe("open");
  });

  it("M3. X-2 — two critical defects, a release naming only one: the other still blocks", async () => {
    const s = await scenario("M3");
    const critA = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const critB = await addDefect(s.unitId, "critical", 2, "Steering play beyond limit");
    const wo = await addWorkOrder(s.unitId, critA);
    await releaseFor(mechanic, wo, [critA], new Date(Date.now() - HOUR));
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: critA, releaseId: null, note: "Brake chamber replaced and leak-tested" }).catch(() => undefined);
    const r = await readiness(s);
    expect(r.criticalDefect, "defect B was never named by any release").toBe(true);
    expect((await defectRow(critB)).status).toBe("open");
  });

  it("M4. X-4 — a stored failed release cannot satisfy mechanic-release readiness", async () => {
    const s = await scenario("M4");
    const crit = await addDefect(s.unitId, "critical", 2, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    await pool.execute(
      "INSERT INTO workOrderReleases (workOrderId, unitId, releaseType, repairSummary, testProcedure, testResult, roadTestPerformed, technicianUserId, technicianIdentifier, releasedAt, resolvedDefectIds) VALUES (?, ?, 'full', 'Attempted repair', 'Static leak test', 'fail', 1, ?, 'TECH-X', DATE_SUB(NOW(), INTERVAL 1 HOUR), ?)",
      [wo, s.unitId, mechanic, JSON.stringify([crit])]);
    const r = await readiness(s);
    expect(r.criticalDefect).toBe(true);
    expect(r.releaseMissing, "a failed test result is not release evidence").toBe(true);
  });

  it("M5. X-1 — a revoked release cannot satisfy mechanic-release readiness", async () => {
    const s = await scenario("M5");
    const crit = await addDefect(s.unitId, "critical", 4, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const before = await readiness(s);
    const revoke = await caller(shopLead).records.maintenance.revokeRelease({ workOrderId: wo, reason: "Unit must not move — brake leak unrepaired" });
    expect((revoke as { unitHeld?: boolean }).unitHeld).toBe(true);
    const after = await readiness(s);
    expect(after.criticalDefect, "a revocation is not a release").toBe(true);
    expect(after.blocking).toEqual(before.blocking);
  });

  it("M6. OD-5 — revocation after a valid release never improves readiness", async () => {
    const s = await scenario("M6");
    const crit = await addDefect(s.unitId, "critical", 6, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const rel = await releaseFor(mechanic, wo, [crit], new Date(Date.now() - 5 * HOUR));
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced and leak-tested" });
    const afterRelease = await readiness(s);
    await caller(shopLead).records.maintenance.revokeRelease({ workOrderId: wo, reason: "Leak reappeared on the yard walk-around" });
    const afterRevoke = await readiness(s);
    // "Never better" is the invariant: the blocking set may grow, never shrink.
    for (const code of afterRelease.blocking) expect(afterRevoke.blocking).toContain(code);
    expect(afterRevoke.releaseMissing, "the release that evidenced this defect was revoked").toBe(true);
    expect(afterRevoke.blocking.length).toBeGreaterThan(afterRelease.blocking.length);
  });

  it("M7. X-1 — a revocation-only fixture never turns BLOCKED into PASS", async () => {
    const s = await scenario("M7");
    await addDefect(s.unitId, "critical", 4, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, null);
    const before = await readiness(s);
    expect(before.mechanic).toBe("BLOCKED");
    await caller(shopLead).records.maintenance.revokeRelease({ workOrderId: wo, reason: "Withdrawn from service" });
    const after = await readiness(s);
    expect(after.mechanic).toBe("BLOCKED");
    const ev = await caller(dispatcher).dispatch.evaluate({ operatorId: s.operatorId, unitId: s.unitId, trailerId: null, jobId: s.jobId });
    expect(ev.verdict).toBe("blocked");
  });

  it("M8. X-5 — an explicit resolution moves the defect to resolved in the database", async () => {
    const s = await scenario("M8");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const rel = await releaseFor(mechanic, wo, [crit], new Date(Date.now() - HOUR));
    const out = await caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced and leak-tested" });
    expect(out.defectId).toBe(crit);
    expect(out.status).toBe("resolved");
    const row = await defectRow(crit);
    expect(row.status, "the database must carry an observable status change").toBe("resolved");
    const [prov] = await pool.execute<mysql.RowDataPacket[]>("SELECT resolvedAt, resolvedByUserId, resolvedByReleaseId FROM maintenanceDefects WHERE id = ?", [crit]);
    expect(prov[0]!.resolvedByUserId).toBe(mechanic);
    expect(prov[0]!.resolvedAt).toBeTruthy();
    expect(Number(prov[0]!.resolvedByReleaseId)).toBe(rel.releaseId);
  });

  it("M9. resolving one critical defect never resolves its siblings", async () => {
    const s = await scenario("M9");
    const critA = await addDefect(s.unitId, "critical", 4, "Brake air leak");
    const critB = await addDefect(s.unitId, "critical", 3, "Steering play beyond limit");
    const wo = await addWorkOrder(s.unitId, critA);
    const rel = await releaseFor(mechanic, wo, [critA], new Date(Date.now() - HOUR));
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: critA, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced" });
    expect((await defectRow(critA)).status).toBe("resolved");
    expect((await defectRow(critB)).status, "a sibling must never be resolved silently").toBe("open");
    const r = await readiness(s);
    expect(r.criticalDefect).toBe(true);
    expect(r.verdict).toBe("blocked");
  });

  it("M10. a cross-tenant defect cannot be resolved, and the row is unchanged", async () => {
    const s = await scenario("M10", "ORG-OTHER");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    await expect(
      caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: null, note: "Not mine to resolve" })
    ).rejects.toThrow(/not found/i);
    expect((await defectRow(crit)).status).toBe("open");
  });

  it("M11. an unauthorized caller cannot resolve a defect, and the row is unchanged", async () => {
    const s = await scenario("M11");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const rel = await releaseFor(mechanic, wo, [crit], new Date(Date.now() - HOUR));
    await expect(
      caller(driverOnly).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "I drove it, it seems fine" })
    ).rejects.toThrow();
    expect((await defectRow(crit)).status).toBe("open");
    await expect(
      caller(dispatcher).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Need the truck today" })
    ).rejects.toThrow();
    expect((await defectRow(crit)).status).toBe("open");
  });

  it("M12. a resolved critical defect with a valid release clears BOTH conditions", async () => {
    const s = await scenario("M12");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const blocked = await readiness(s);
    expect(blocked.blocking).toContain("critical_defect");
    const rel = await releaseFor(mechanic, wo, [crit], new Date(Date.now() - HOUR));
    const midway = await readiness(s);
    expect(midway.criticalDefect, "a release is evidence; it is not resolution").toBe(true);
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced and leak-tested" });
    const r = await readiness(s);
    expect(r.criticalDefect).toBe(false);
    expect(r.releaseMissing).toBe(false);
    expect(r.mechanic).toBe("PASS");
    expect(r.blocking).toEqual([]);
  });

  it("M13. resolving a critical defect requires release evidence that actually names it", async () => {
    const s = await scenario("M13");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const other = await addDefect(s.unitId, "critical", 3, "Steering play");
    const wo = await addWorkOrder(s.unitId, other);
    const rel = await releaseFor(mechanic, wo, [other], new Date(Date.now() - HOUR));
    await expect(
      caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Close enough" })
    ).rejects.toThrow(/does not name|release/i);
    expect((await defectRow(crit)).status).toBe("open");
  });

  it("M14. a non-critical defect resolves without a release, and never blocked to begin with", async () => {
    const s = await scenario("M14");
    const minor = await addDefect(s.unitId, "inspection_required", 3, "Mirror bracket loose");
    const before = await readiness(s);
    expect(before.blocking).toEqual([]);
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: minor, releaseId: null, note: "Bracket retightened" });
    expect((await defectRow(minor)).status).toBe("resolved");
  });

  it("M15. a defect already resolved is refused rather than resolved twice", async () => {
    const s = await scenario("M15");
    const minor = await addDefect(s.unitId, "advisory", 3, "Chipped mirror");
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: minor, releaseId: null, note: "Mirror replaced" });
    await expect(
      caller(mechanic).records.maintenance.resolveDefect({ defectId: minor, releaseId: null, note: "again" })
    ).rejects.toThrow(/already resolved/i);
  });

  it("M17. a revoked release that NAMES the defect is still not release evidence", async () => {
    // `shop.workOrderRelease` accepts `releaseType: "revoked"` alongside `resolvedDefectIds`, so a
    // revocation that names its defects is a reachable row and not only a hypothetical one.
    const s = await scenario("M17");
    const crit = await addDefect(s.unitId, "critical", 3, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    await caller(mechanic).shop.workOrderRelease({
      workOrderId: wo, releaseType: "revoked", repairSummary: "Withdrawn — leak reappeared",
      resolvedDefectIds: [crit], roadTestPerformed: false, releasedAt: new Date(Date.now() - HOUR),
    });
    const r = await readiness(s);
    expect(r.criticalDefect).toBe(true);
    expect(r.releaseMissing, "a revocation naming a defect is still not a release of it").toBe(true);
    await expect(
      caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: null, note: "Signed off" })
    ).rejects.toThrow(/mechanic release/i);
  });

  it("M18. release evidence is matched by defect identity, not by presence on the unit", async () => {
    const s = await scenario("M18");
    const critA = await addDefect(s.unitId, "critical", 4, "Brake air leak");
    const critB = await addDefect(s.unitId, "critical", 3, "Steering play beyond limit");
    const wo = await addWorkOrder(s.unitId, critA);
    const rel = await releaseFor(mechanic, wo, [critA], new Date(Date.now() - HOUR));
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: critA, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced" });
    const r = await readiness(s);
    // A's release is real and standing; it says nothing whatever about B.
    expect(r.criticalDefect).toBe(true);
    expect(r.releaseMissing, "B has no release naming it — A's must not answer for it").toBe(true);
  });

  it("M16. a defect that does not exist is refused", async () => {
    await expect(
      caller(mechanic).records.maintenance.resolveDefect({ defectId: 2_000_000_000, releaseId: null, note: "phantom" })
    ).rejects.toThrow(/not found/i);
  });
});

/* ================================================================== */
/* Enforcement orders                                                  */
/* ================================================================== */

/** An out-of-service order as the enforcement domain actually writes one: an event, then the order. */
async function addOosOrder(args: { unitId?: number | null; operatorId?: number | null; tenantId: string | null; status?: "active" | "released" | "rescinded" }) {
  const eventRef = key("EV").slice(0, 60);
  await pool.execute(
    "INSERT INTO enforcementEvents (eventRef, eventType, jurisdiction, tenantId, agency, occurredAt, inspectionResult, operatorId, unitId, status, confirmedByUserId, confirmedAt) VALUES (?, 'roadside_inspection', 'AB', ?, 'CVSA', DATE_SUB(NOW(), INTERVAL 2 HOUR), 'out_of_service', ?, ?, 'confirmed', 1, DATE_SUB(NOW(), INTERVAL 2 HOUR))",
    [eventRef, args.tenantId, args.operatorId ?? null, args.unitId ?? null]);
  const orderRef = key("OOS").slice(0, 60);
  await pool.execute(
    "INSERT INTO outOfServiceOrders (orderRef, eventRef, scope, subjectRef, tenantId, issuedAt, issuingAgency, releaseCondition, status) VALUES (?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 HOUR), 'CVSA', 'Brakes repaired and re-inspected', ?)",
    [orderRef, eventRef, args.operatorId ? "driver" : "vehicle", args.unitId ? `UNIT-${args.unitId}` : `OP-${args.operatorId}`, args.tenantId, args.status ?? "active"]);
  return { eventRef, orderRef };
}

d("the readiness composer reads canonical enforcement state itself", () => {
  it("E1. X-6 — an active out-of-service order in the database BLOCKS, non-overridably", async () => {
    const s = await scenario("E1");
    const { orderRef } = await addOosOrder({ unitId: s.unitId, tenantId: "default" });
    const r = await readiness(s);
    expect(r.enforcement).toBe("BLOCKED");
    expect(r.enforcementDetail).toContain(orderRef);
    expect(r.blocking).toContain("oos.vehicle");
    expect(r.nonOverridable).toContain("oos.vehicle");
    expect(r.verdict).toBe("blocked");
  });

  it("E2. known clear — no applicable active order is a genuine PASS", async () => {
    const s = await scenario("E2");
    await addOosOrder({ unitId: s.unitId, tenantId: "default", status: "released" });
    const r = await readiness(s);
    expect(r.enforcement).toBe("PASS");
    expect(r.blocking).toEqual([]);
  });

  it("E3. X-7 — enforcement that cannot be evaluated must not read as PASS", async () => {
    const s = await scenario("E3");
    await pool.execute(
      "INSERT INTO enforcementEvents (eventRef, eventType, jurisdiction, tenantId, agency, occurredAt, inspectionResult, unitId, status, confirmedByUserId, confirmedAt) VALUES (?, 'roadside_inspection', 'AB', 'default', 'CVSA', DATE_SUB(NOW(), INTERVAL 2 HOUR), 'unknown', ?, 'under_review', 1, DATE_SUB(NOW(), INTERVAL 2 HOUR))",
      [key("EV").slice(0, 60), s.unitId]);
    const r = await readiness(s);
    expect(r.enforcement, "an inspection whose result is not established is not a pass").not.toBe("PASS");
    expect(r.codes).toContain("enforcement_result_unknown");
  });

  it("E4. X-6 — the production dispatch path blocks without any caller supplying enforcement", async () => {
    const s = await scenario("E4");
    await addOosOrder({ unitId: s.unitId, tenantId: "default" });
    // dispatch.readiness and dispatch.evaluate have no enforcement input at all.
    const view = await caller(dispatcher).dispatch.readiness({ operatorId: s.operatorId, unitId: s.unitId, trailerId: null, jobId: s.jobId });
    expect(view.blockers.some(b => b.code === "oos.vehicle" && b.severity === "blocking" && !b.overridable)).toBe(true);
    const ev = await caller(dispatcher).dispatch.evaluate({ operatorId: s.operatorId, unitId: s.unitId, trailerId: null, jobId: s.jobId });
    expect(ev.verdict).toBe("blocked");
    const award = await caller(dispatcher).dispatch.overrideRequest({ checkId: ev.checkId, blockerCode: "oos.vehicle", reason: "The customer is waiting and the load is hot" });
    expect(award.requestable, "an inspector's order is overridable by nobody").toBe(false);
  });

  it("E5. a cross-tenant order cannot contaminate another tenant's readiness", async () => {
    const s = await scenario("E5", "ORG-A");
    await addOosOrder({ unitId: s.unitId, tenantId: "ORG-B" });
    const r = await readiness(s);
    expect(r.blocking, "an order recorded against another organization must not block here").not.toContain("oos.vehicle");
  });

  it("E6. an order against the operator blocks the operator, by its own scope", async () => {
    const s = await scenario("E6");
    await addOosOrder({ operatorId: s.operatorId, tenantId: "default" });
    const r = await readiness(s);
    expect(r.blocking).toContain("oos.driver");
    expect(r.enforcement).toBe("BLOCKED");
  });
});
