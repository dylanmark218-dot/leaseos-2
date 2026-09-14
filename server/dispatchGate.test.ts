import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { asChecklist, mergeBlockers } from "./readinessComposer";
import { decideAward } from "./_core/dispatchAward";
import type { DispatchBlocker, DispatchEligibility } from "./_core/dispatchReadiness";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { UNIVERSAL_PERMISSIONS, authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const base = (verdict: DispatchEligibility["verdict"] = "eligible", blockers: DispatchBlocker[] = []): DispatchEligibility => ({ verdict, blockers, evaluatedAt: NOW, explanation: "" });
const blk = (over: Partial<DispatchBlocker> & { code: string }): DispatchBlocker => ({ label: over.code, severity: "blocking", subject: "truck", overridable: false, ...over });

/* ------------------------------------------------------------------ */
/* Merge                                                                */
/* ------------------------------------------------------------------ */

describe("the newer engines' findings merge in B12's vocabulary", () => {
  it("blocking beats unknown beats review; unknown never rounds up", () => {
    expect(mergeBlockers(base(), [blk({ code: "a", severity: "review" })]).verdict).toBe("eligible_review");
    expect(mergeBlockers(base(), [blk({ code: "a", severity: "review" }), blk({ code: "b", severity: "unknown" })]).verdict).toBe("unknown");
    expect(mergeBlockers(base(), [blk({ code: "b", severity: "unknown" }), blk({ code: "c", severity: "blocking" })]).verdict).toBe("blocked");
    expect(mergeBlockers(base(), []).verdict).toBe("eligible");
  });

  it("names every blocking item in the explanation", () => {
    const m = mergeBlockers(base(), [blk({ code: "insurance_coverage_expired", label: "commercial auto policy POL-1 expired 3 day(s) ago" }), blk({ code: "roadside_event_open", label: "Roadside event RS-9 open" })]);
    expect(m.explanation).toBe("BLOCKED — commercial auto policy POL-1 expired 3 day(s) ago; Roadside event RS-9 open");
  });

  it("does not duplicate a code the base already carries", () => {
    const m = mergeBlockers(base("blocked", [blk({ code: "x" })]), [blk({ code: "x" })]);
    expect(m.blockers).toHaveLength(1);
  });

  it("turns blockers into a checklist that says what is fixable and by whom", () => {
    const c = asChecklist(mergeBlockers(base(), [
      blk({ code: "route_not_evaluated", label: "Route not evaluated", severity: "unknown", overridable: true, overrideAuthority: "manager" }),
      blk({ code: "insurance_coverage_expired", label: "Policy expired" }),
    ]));
    expect(c.verdict).toBe("blocked");
    expect(c.items.find(i => i.code === "route_not_evaluated")!.fixable).toContain("manager override");
    expect(c.items.find(i => i.code === "insurance_coverage_expired")!.fixable).toBe("Must be resolved — no override");
  });
});

/* ------------------------------------------------------------------ */
/* The B12 award bug                                                    */
/* ------------------------------------------------------------------ */

describe("a granted override resolves an overridable unknown — the bug the wiring found", () => {
  const route = blk({ code: "route_not_evaluated", label: "Route not evaluated", severity: "unknown", subject: "route", overridable: true, overrideAuthority: "manager" });
  const ctx = (over: Partial<Parameters<typeof decideAward>[0]> = {}): Parameters<typeof decideAward>[0] => ({
    postingState: "direct", bidState: null,
    eligibility: { ...base("unknown", [route]), checkId: 1, fingerprint: "EF-1", operatorId: 1 },
    validity: { valid: true, ageMinutes: 1, reason: "fresh", requiresReEvaluation: false, invalidatedBy: "none" },
    conflicts: [], grantedOverrides: [], ...over,
  });

  it("still refuses an unknown with no override", () => {
    const d = decideAward(ctx());
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals.join(" ")).toContain("UNKNOWN — Route not evaluated (no authorised override)");
  });

  it("awards when a manager granted the override the readiness engine offered", () => {
    const d = decideAward(ctx({ grantedOverrides: [{ blockerCode: "route_not_evaluated", grantedByUserId: 5, grantedByRole: "manager", reason: "Known local route, verified by phone with the lease operator", grantedAt: NOW }] }));
    expect(d.permitted, (d as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
  });

  it("never lets an override cover an unknown nobody may override", () => {
    const hard = blk({ code: "medical_fitness_not_current", label: "Medical", severity: "unknown", subject: "operator", overridable: false });
    const d = decideAward(ctx({ eligibility: { ...base("unknown", [hard]), checkId: 1, fingerprint: "EF-1", operatorId: 1 }, grantedOverrides: [{ blockerCode: "medical_fitness_not_current", grantedByUserId: 5, grantedByRole: "administrator", reason: "x", grantedAt: NOW }] }));
    expect(d.permitted).toBe(false);
  });

  it("checks review blockers even when the verdict is unknown — previously skipped", () => {
    const review = blk({ code: "insurance_proof_missing", label: "Proof missing", severity: "review", overridable: true, overrideAuthority: "dispatcher" });
    const d = decideAward(ctx({ eligibility: { ...base("unknown", [route, review]), checkId: 1, fingerprint: "EF-1", operatorId: 1 }, grantedOverrides: [{ blockerCode: "route_not_evaluated", grantedByUserId: 5, grantedByRole: "manager", reason: "r", grantedAt: NOW }] }));
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals.join(" ")).toContain("REVIEW — Proof missing");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions                                                          */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who evaluates, who awards, who grants", () => {
  it("reserves award and grant to dispatcher and management; readiness_own is universal", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "dispatch.award" }).allowed).sort()).toEqual(["dispatcher", "management"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "dispatch.override.grant" }).allowed).sort()).toEqual(["dispatcher", "management"]);
    expect(UNIVERSAL_PERMISSIONS).toContain("dispatch.readiness_own");
  });
});

/* ------------------------------------------------------------------ */
/* The gate, end to end                                                 */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 210000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("can Unit 142 take this job tomorrow?", () => {
  it("refuses a held unit, lifts on mechanic release, needs a manager for the unknown route, and refuses when the facts move", async () => {
    const dispatcher = await withRole("dispatcher");
    const manager = await withRole("management");
    const mechanic = await withRole("mechanic");
    const driverUser = await withRole("driver");
    const unitNo = key("142").slice(0, 30);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [unitNo]);
    const unitId = Number(u.insertId);
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
    const operatorId = Number(op.insertId);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0)", [key("JOB").slice(0, 40)]);
    const jobId = Number(j.insertId);
    const [p] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, planningBlocker, priority, crewSize, rateVisible, createdByUserId) VALUES (?, ?, 'direct_assignment', 'direct', 'none', 'normal', 1, 0, ?)", [key("POST").slice(0, 40), jobId, dispatcher]);
    const postingId = Number(p.insertId);
    // Unit credentials: inspection, registration verified; insured under a verified policy with proof on file.
    for (const [t, title] of [["cvip_certificate", "CVIP"], ["vehicle_registration", "Registration"], ["insurance_proof", "Pink card"]]) {
      await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, title]);
    }
    const [insr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status) VALUES (?, ?, 'insurer', 'active')", [key("PRV").slice(0, 40), key("Insurer").slice(0, 60)]);
    const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insurancePolicies (policyRef, financialEntityId, insurerId, policyType, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus) VALUES (?, 1, ?, 'commercial_auto', ?, DATE_SUB(NOW(), INTERVAL 60 DAY), DATE_ADD(NOW(), INTERVAL 300 DAY), 'active', 'coverage_verified')", [key("POL").slice(0, 40), Number(insr.insertId), key("PN").slice(0, 40)]);
    const policyId = Number(pol.insertId);
    await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, additionalInsuredEndorsement) VALUES (?, 'commercial_auto', 5000000, 1)", [policyId]);
    await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'unit', ?, DATE_SUB(NOW(), INTERVAL 60 DAY))", [policyId, unitId]);
    // A critical defect, unreleased.
    const [df] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, 'Brake air leak', 'critical', 'open', DATE_SUB(NOW(), INTERVAL 2 HOUR), ?)", [unitId, driverUser]);
    void df;

    // 1. Preview: BLOCKED — the defect, named; route unknown alongside.
    const pre = await callerFor(dispatcher).dispatch.readiness({ operatorId, unitId, trailerId: null, jobId });
    expect(pre.verdict).toBe("blocked");
    expect(pre.blockers.some(b => /critical defect|defect/i.test(b.label) && b.severity === "blocking")).toBe(true);
    expect(pre.blockers.some(b => b.code === "route_not_evaluated")).toBe(true);
    expect(pre.contributions.some(c => c.engine === "insurance" && c.finding.startsWith("coverage_verified"))).toBe(true);

    // 2. Evaluate records the check; award against a blocked check is refused by name.
    const c1 = await callerFor(dispatcher).dispatch.evaluate({ operatorId, unitId, trailerId: null, jobId, postingId });
    expect(c1.verdict).toBe("blocked");
    const a1 = await callerFor(dispatcher).dispatch.award({ checkId: c1.checkId, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });
    expect(a1.ok).toBe(false);
    if (!a1.ok) expect(a1.refusals.join(" ")).toMatch(/defect|release/i);

    // 3. A defect blocker is overridable by no one — the request is recorded and refused.
    const defectCode = c1.blockers.find(b => b.severity === "blocking" && b.subject === "truck")!.code;
    const oreq = await callerFor(dispatcher).dispatch.overrideRequest({ checkId: c1.checkId, blockerCode: defectCode, reason: "We really need this truck out today" });
    expect(oreq.requestable).toBe(false);
    expect(oreq.refusal).toContain("overridable by no one");

    // 4. Mechanic releases. The old check is stale by fact change: award on it is refused; re-evaluate.
    await pool.execute("INSERT INTO workOrderReleases (workOrderId, unitId, releaseType, repairSummary, testProcedure, testResult, roadTestPerformed, technicianUserId, technicianIdentifier, releasedAt) VALUES (0, ?, 'full', 'Replaced brake chamber diaphragm', 'Static leak test', 'pass', 1, ?, 'M. Jones #4471', NOW())", [unitId, mechanic]);
    await pool.execute("UPDATE maintenanceDefects SET status = 'resolved' WHERE unitId = ? AND severity = 'critical'", [unitId]);
    const a2 = await callerFor(dispatcher).dispatch.award({ checkId: c1.checkId, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });
    expect(a2.ok).toBe(false);
    if (!a2.ok) expect(a2.refusals.join(" ")).toMatch(/changed|re-evaluate/i);

    const c2 = await callerFor(dispatcher).dispatch.evaluate({ operatorId, unitId, trailerId: null, jobId, postingId });
    expect(c2.verdict).toBe("unknown"); // only the route now
    expect(c2.blockers.filter(b => b.severity === "blocking")).toEqual([]);
    expect(c2.blockers.map(b => b.code)).toContain("route_not_evaluated");

    // 5. Dispatcher requests the route override; dispatcher may not grant it (manager authority); the requester may not grant their own.
    const req2 = await callerFor(dispatcher).dispatch.overrideRequest({ checkId: c2.checkId, blockerCode: "route_not_evaluated", reason: "Lease road verified by phone with Acme site lead; 14 km gravel, no bridges" });
    expect(req2.requestable).toBe(true);
    expect(req2.requiredAuthority).toBe("manager");
    await expect(callerFor(dispatcher).dispatch.overrideGrant({ checkId: c2.checkId, blockerCode: "route_not_evaluated", reason: "Granting my own request" })).rejects.toThrow(/own override/);
    const dispatcher2 = await withRole("dispatcher");
    const g1 = await callerFor(dispatcher2).dispatch.overrideGrant({ checkId: c2.checkId, blockerCode: "route_not_evaluated", reason: "I agree with the dispatcher" });
    expect(g1.granted).toBe(false); // a second dispatcher lacks manager authority
    const g2 = await callerFor(manager).dispatch.overrideGrant({ checkId: c2.checkId, blockerCode: "route_not_evaluated", reason: "Known route; I accept responsibility until routing data is loaded" });
    expect(g2.granted).toBe(true);

    // 6. One override is not dispatch. The award still names everything else
    //    that is unknown or unresolved — HOS state, availability, destination
    //    acceptance, medical fitness — and refuses. Each must be resolved or
    //    overridden by the right authority; nothing rounds up.
    const a3 = await callerFor(dispatcher).dispatch.award({ checkId: c2.checkId, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });
    expect(a3.ok).toBe(false);
    if (!a3.ok) {
      expect(a3.refusals.join(" ")).toMatch(/hours-of-service/i);
      expect(a3.refusals.join(" ")).toMatch(/medical fitness/i);
      expect(a3.refusals.join(" ")).not.toMatch(/Route not evaluated/); // the granted one is covered
    }
    const remaining = c2.blockers.filter(b => b.code !== "route_not_evaluated");
    expect(remaining.every(b => b.overridable)).toBe(true); // all overridable — none is a safety/legal blocker
    for (const b of remaining) {
      const rq = await callerFor(dispatcher).dispatch.overrideRequest({ checkId: c2.checkId, blockerCode: b.code, reason: `Confirmed by phone with the operator and the facility — ${b.code}` });
      expect(rq.requestable).toBe(true);
      const granter = b.overrideAuthority === "administrator" ? await withRole("controller") : manager;
      const gr = await callerFor(granter).dispatch.overrideGrant({ checkId: c2.checkId, blockerCode: b.code, reason: `Accepted with reason on record — ${b.code}` });
      expect(gr.granted, b.code).toBe(true);
    }

    // 7. Now the award proceeds — and marks the check used, with every override on record.
    const a4 = await callerFor(dispatcher).dispatch.award({ checkId: c2.checkId, startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });
    expect(a4.ok, (a4 as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
    const [used] = await pool.execute<mysql.RowDataPacket[]>("SELECT usedForAward, verdict FROM dispatchEligibilityChecks WHERE id = ?", [c2.checkId]);
    expect(Number(used[0].usedForAward)).toBe(1);
    const [ovr] = await pool.execute<mysql.RowDataPacket[]>("SELECT blockerCode, granted FROM dispatchOverrides WHERE eligibilityCheckId = ? AND granted = 1", [c2.checkId]);
    expect(new Set(ovr.map(o => o.blockerCode))).toEqual(new Set(c2.blockers.map(b => b.code)));

    // 8. The operator's own checklist: reads their own record, says what is missing, and carries nothing private.
    const mine = await callerFor(driverUser).dispatch.whatAmIMissing({ unitId, jobId });
    expect(mine.items.some(i => i.code === "route_not_evaluated")).toBe(true);
    expect(mine.items.some(i => i.code === "medical_fitness_unknown")).toBe(true);
    expect(JSON.stringify(mine)).not.toMatch(/storageKey|identifier|diagnos/i);
    // A user with no operator record gets an honest note, not someone else's readiness.
    const stranger = await withRole("office");
    const s = await callerFor(stranger).dispatch.whatAmIMissing();
    expect(s.items).toEqual([]);
    expect(s.note).toContain("No operator record");
  });

  it("blocks an uninsured truck with no override, and an open roadside event likewise", async () => {
    const dispatcher = await withRole("dispatcher");
    const driverUser = await withRole("driver");
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key("188").slice(0, 30)]);
    const unitId = Number(u.insertId);
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'K. Lee', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
    for (const t of ["cvip_certificate", "vehicle_registration"]) await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, t]);
    await pool.execute("INSERT INTO roadsideServiceEvents (eventRef, unitId, operatorId, eventType, status, occurredAt, reportedAt, reportedByUserId, driverStatement, vehicleMovable, driverSafe, loadStatus, dangerousGoods, assistanceRequired, customerAffected) VALUES (?, ?, ?, 'air_system', 'open', NOW(), NOW(), ?, 'Lost air pressure at km 40', 'no', 'yes', 'empty', 'no', 1, 'unknown')", [key("RS").slice(0, 40), unitId, Number(op.insertId), driverUser]);
    const pre = await callerFor(dispatcher).dispatch.readiness({ operatorId: Number(op.insertId), unitId, trailerId: null, jobId: null });
    expect(pre.verdict).toBe("blocked");
    const codes = pre.blockers.filter(b => b.severity === "blocking").map(b => b.code);
    expect(codes).toContain("insurance_coverage_unknown");
    expect(codes).toContain("roadside_event_open");
    expect(pre.blockers.filter(b => codes.includes(b.code)).every(b => !b.overridable)).toBe(true);
  });
});
