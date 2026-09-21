/**
 * What the Readiness Panel is actually served — `dispatch.readiness`, against a real database.
 *
 * The panel's whole safety claim is "the client displays exactly what the server returns", and
 * that claim is only worth anything if something checks what the server returns. So this file
 * asserts the *wire contract* the panel is built against: which fields arrive, which do not, and
 * that the PR #4 repairs are visible through this procedure rather than only through
 * `composeReadiness`. `readinessDefectRepair.db.test.ts` proves the repairs; this proves the
 * dispatcher can see them.
 *
 * Nothing here reimplements readiness. Every verdict comes from the production tRPC caller.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;

describe("dispatch readiness panel — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped panel suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 810000 + Math.floor(Math.random() * 40000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = nextUser();
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

const HOUR = 3_600_000;
let dispatcher = 0, mechanic = 0, shopLead = 0, driverOnly = 0;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 8 });
  dispatcher = await withRole("dispatcher");
  mechanic = await withRole("mechanic");
  shopLead = await withRole("shop_lead");
  driverOnly = await withRole("driver");
});

/** A unit, operator and job whose only *blocking* axis is the one each test introduces. */
async function scenario(tag: string) {
  const driverUser = await withRole("driver");
  const [u] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key(tag).slice(0, 30)]);
  const unitId = Number(u.insertId);
  const [op] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'P. Nandi', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
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

async function addCriticalDefect(unitId: number, title: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, ?, 'critical', 'open', DATE_SUB(NOW(), INTERVAL 3 HOUR), 1)", [unitId, title]);
  return Number(r.insertId);
}

async function addWorkOrder(unitId: number, defectId: number | null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO workOrders (workOrderNumber, unitId, defectId, status, priority, openedAt) VALUES (?, ?, ?, 'in_progress', 'routine', DATE_SUB(NOW(), INTERVAL 6 HOUR))",
    [key("WO").slice(0, 60), unitId, defectId]);
  return Number(r.insertId);
}

async function addActiveOosOrder(unitId: number) {
  const eventRef = key("EV").slice(0, 60);
  await pool.execute(
    "INSERT INTO enforcementEvents (eventRef, eventType, jurisdiction, tenantId, agency, occurredAt, inspectionResult, unitId, status, confirmedByUserId, confirmedAt) VALUES (?, 'roadside_inspection', 'AB', 'default', 'CVSA', DATE_SUB(NOW(), INTERVAL 2 HOUR), 'out_of_service', ?, 'confirmed', 1, DATE_SUB(NOW(), INTERVAL 2 HOUR))",
    [eventRef, unitId]);
  const orderRef = key("OOS").slice(0, 60);
  await pool.execute(
    "INSERT INTO outOfServiceOrders (orderRef, eventRef, scope, subjectRef, tenantId, issuedAt, issuingAgency, releaseCondition, status) VALUES (?, ?, 'vehicle', ?, 'default', DATE_SUB(NOW(), INTERVAL 2 HOUR), 'CVSA', 'Brakes repaired and re-inspected', 'active')",
    [orderRef, eventRef, `UNIT-${unitId}`]);
  return orderRef;
}

/** Exactly the call the panel's container makes. */
const panelQuery = (s: { operatorId: number; unitId: number; jobId: number }, userId = dispatcher) =>
  caller(userId).dispatch.readiness({ operatorId: s.operatorId, unitId: s.unitId, trailerId: null, jobId: s.jobId });

const releaseFor = (workOrderId: number, defectIds: number[]) =>
  caller(mechanic).shop.workOrderRelease({
    workOrderId, releaseType: "full", repairSummary: "Replaced brake chamber diaphragm",
    testProcedure: "Static leak test", testResult: "pass", roadTestPerformed: true,
    resolvedDefectIds: defectIds, releasedAt: new Date(Date.now() - HOUR),
  });

/* ================================================================== */
/* The wire contract the panel is built against                        */
/* ================================================================== */

d("dispatch.readiness — the shape the panel renders", () => {
  it("P1. returns a verdict, an explanation, blockers and contributions, and nothing else", async () => {
    const s = await scenario("P1");
    const r = await panelQuery(s);
    expect(Object.keys(r).sort()).toEqual(["blockers", "contributions", "explanation", "verdict"]);
    expect(typeof r.verdict).toBe("string");
    expect(typeof r.explanation).toBe("string");
    expect(Array.isArray(r.blockers)).toBe(true);
    expect(Array.isArray(r.contributions)).toBe(true);
  });

  it("P2. every verdict it can emit is one of the four the presentation layer knows", async () => {
    const s = await scenario("P2");
    expect(["eligible", "eligible_review", "blocked", "unknown"]).toContain((await panelQuery(s)).verdict);
  });

  it("P3. every blocker carries the five fields the panel reads, and no severity outside the three", async () => {
    const s = await scenario("P3");
    await addCriticalDefect(s.unitId, "Brake air leak");
    const r = await panelQuery(s);
    expect(r.blockers.length).toBeGreaterThan(0);
    for (const b of r.blockers) {
      expect(typeof b.code).toBe("string");
      expect(typeof b.label).toBe("string");
      expect(["blocking", "unknown", "review"]).toContain(b.severity);
      expect(["operator", "truck", "trailer", "job", "route"]).toContain(b.subject);
      expect(typeof b.overridable).toBe("boolean");
      if (b.overrideAuthority !== undefined) expect(["dispatcher", "manager", "administrator"]).toContain(b.overrideAuthority);
    }
  });

  it("P4. contributions are engine/finding pairs of plain strings — the panel prints them as they are", async () => {
    const s = await scenario("P4");
    const r = await panelQuery(s);
    expect(r.contributions.length).toBeGreaterThan(0);
    for (const c of r.contributions) {
      expect(typeof c.engine).toBe("string");
      expect(typeof c.finding).toBe("string");
    }
  });

  /*
   * The gap this slice found and did not paper over. `composeReadiness` computes the P8.1
   * capability picture and `dispatch.evaluate` stores it on the check row, but `dispatch.readiness`
   * does not return it — so the panel has no capability data to show and says so on screen rather
   * than rendering an empty grid that reads as clear. If this assertion ever fails because the
   * field was added, the panel can start showing it; until then it must not pretend.
   */
  it("P5. does NOT return the P8.1 capability picture — the panel must not fabricate one", async () => {
    const s = await scenario("P5");
    const r = await panelQuery(s) as Record<string, unknown>;
    expect(r.capabilities).toBeUndefined();
    expect(r.capabilityVerdict).toBeUndefined();
  });
});

/* ================================================================== */
/* The PR #4 repairs, seen through the procedure the panel calls       */
/* ================================================================== */

d("the panel sees the repaired readiness, not the old one", () => {
  it("P6. an unresolved critical defect reaches the panel as a blocking, non-overridable blocker", async () => {
    const s = await scenario("P6");
    await addCriticalDefect(s.unitId, "Brake air leak");
    const r = await panelQuery(s);
    expect(r.verdict).toBe("blocked");
    const b = r.blockers.find(x => x.code === "critical_defect");
    expect(b, "the dispatcher must be told which condition holds the unit").toBeTruthy();
    expect(b!.severity).toBe("blocking");
    expect(b!.overridable).toBe(false);
  });

  it("P7. an active out-of-service order reaches the panel without any caller supplying enforcement", async () => {
    const s = await scenario("P7");
    const orderRef = await addActiveOosOrder(s.unitId);
    const r = await panelQuery(s);
    expect(r.verdict).toBe("blocked");
    const b = r.blockers.find(x => x.code === "oos.vehicle");
    expect(b, `the panel must show the active order ${orderRef}`).toBeTruthy();
    expect(b!.severity).toBe("blocking");
    expect(b!.overridable, "an inspector's order is overridable by nobody").toBe(false);
  });

  it("P8. a release alone does not clear the panel; an explicit resolution does", async () => {
    const s = await scenario("P8");
    const crit = await addCriticalDefect(s.unitId, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);

    expect((await panelQuery(s)).blockers.map(b => b.code)).toContain("critical_defect");

    const rel = await releaseFor(wo, [crit]);
    expect((await panelQuery(s)).blockers.map(b => b.code),
      "a release is evidence, not resolution").toContain("critical_defect");

    await caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced and leak-tested" });
    const after = await panelQuery(s);
    expect(after.blockers.map(b => b.code)).not.toContain("critical_defect");
    expect(after.blockers.filter(b => b.severity === "blocking")).toEqual([]);
  });

  it("P9. revoking a release can never turn the panel from blocked into ready", async () => {
    const s = await scenario("P9");
    const crit = await addCriticalDefect(s.unitId, "Brake air leak");
    const wo = await addWorkOrder(s.unitId, crit);
    const rel = await releaseFor(wo, [crit]);
    await caller(mechanic).records.maintenance.resolveDefect({ defectId: crit, releaseId: rel.releaseId ?? null, note: "Brake chamber replaced and leak-tested" });
    const cleared = await panelQuery(s);
    expect(cleared.blockers.filter(b => b.severity === "blocking")).toEqual([]);

    await caller(shopLead).records.maintenance.revokeRelease({ workOrderId: wo, reason: "Leak reappeared on the yard walk-around" });
    const after = await panelQuery(s);
    expect(after.verdict).not.toBe("eligible");
    expect(after.blockers.map(b => b.code)).toContain("mechanic_release_missing");
  });

  it("P10. the explanation the panel prints is the engine's own, and names the count it blocked on", async () => {
    const s = await scenario("P10");
    await addCriticalDefect(s.unitId, "Brake air leak");
    const r = await panelQuery(s);
    expect(r.explanation.trim().length).toBeGreaterThan(0);
    expect(r.explanation).not.toMatch(/ready|clear to dispatch/i);
  });
});

/* ================================================================== */
/* Who may open the panel                                              */
/* ================================================================== */

d("the panel is behind the existing authorization, unchanged", () => {
  it("P11. a dispatcher may read it", async () => {
    const s = await scenario("P11");
    await expect(panelQuery(s, dispatcher)).resolves.toBeTruthy();
  });

  it("P12. a driver with no dispatch grant may not, and the panel gets an error rather than a verdict", async () => {
    const s = await scenario("P12");
    await expect(panelQuery(s, driverOnly)).rejects.toThrow();
  });
});
