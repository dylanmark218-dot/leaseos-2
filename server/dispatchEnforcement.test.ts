import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { currentMode, decideLegacyAssignment } from "./_core/dispatchEnforcement";
import { computeEligibilityFingerprint, type StoredEligibilityCheck } from "./_core/dispatchAward";
import type { DispatchBlocker } from "./_core/dispatchReadiness";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
const blk = (over: Partial<DispatchBlocker> & { code: string }): DispatchBlocker => ({ label: over.code, severity: "blocking", subject: "truck", overridable: false, ...over });
const facts = { operatorId: 1, operatorCredentialVersion: "a", hoursAvailableMinutes: null, unitId: 2, unitStatusVersion: "b", criticalDefectCount: 0, mechanicReleaseVersion: "c", trailerId: null, trailerStatusVersion: "none", jobClassificationVersion: "d", materialClassificationVersion: "none", permitVersion: "none", destinationAcceptanceVersion: "none", routeProfileId: null, routeDecisionVersion: "not_evaluated" };
const check = (over: Partial<StoredEligibilityCheck> = {}): StoredEligibilityCheck => ({ checkId: 10, fingerprint: "EF-x", operatorId: 1, verdict: "eligible", blockers: [], evaluatedAt: mins(-5), explanation: "", ...over });
const subject = { operatorId: 1, unitId: 2, jobId: 3 };

/* ------------------------------------------------------------------ */
/* The setting                                                          */
/* ------------------------------------------------------------------ */

describe("the current mode is the latest row for the scope", () => {
  it("breaks a same-second tie by id — the bug the end-to-end test found", () => {
    const t = mins(0);
    const rows = [
      { id: 1, financialEntityId: null, mode: "advisory" as const, setAt: t },
      { id: 2, financialEntityId: null, mode: "enforced" as const, setAt: t },
    ];
    expect(currentMode(rows, null).mode).toBe("enforced");
    expect(currentMode([...rows].reverse(), null).mode).toBe("enforced");
  });

  it("defaults to off, reads global, and lets an entity row override global", () => {
    expect(currentMode([], null)).toEqual({ mode: "off", source: "default" });
    const rows = [
      { financialEntityId: null, mode: "advisory" as const, setAt: mins(-100) },
      { financialEntityId: null, mode: "enforced" as const, setAt: mins(-50) },
      { financialEntityId: 7, mode: "off" as const, setAt: mins(-10) },
    ];
    expect(currentMode(rows, null)).toEqual({ mode: "enforced", source: "global" });
    expect(currentMode(rows, 7)).toEqual({ mode: "off", source: "entity" });
    expect(currentMode(rows, 8)).toEqual({ mode: "enforced", source: "global" });
  });
});

/* ------------------------------------------------------------------ */
/* The decision                                                         */
/* ------------------------------------------------------------------ */

describe("off assigns; advisory assigns and reports; enforced refuses by name", () => {
  it("off: allowed, no findings, whatever the state", () => {
    const d = decideLegacyAssignment({ mode: "off", check: null, currentFacts: null, grantedOverrides: [], subject, now: NOW });
    expect(d).toEqual({ allowed: true, mode: "off", exceptions: [], checkId: null });
  });

  it("advisory: allowed without a check, and the absence is the exception", () => {
    const d = decideLegacyAssignment({ mode: "advisory", check: null, currentFacts: null, grantedOverrides: [], subject, now: NOW });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.exceptions).toEqual(["Assignment made without a readiness check"]);
  });

  it("advisory: allowed against a blocked check, and the blocker is the exception", () => {
    const d = decideLegacyAssignment({ mode: "advisory", check: check({ verdict: "blocked", blockers: [blk({ code: "critical_defect_open", label: "Critical defect open" })] }), currentFacts: null, grantedOverrides: [], subject, now: NOW });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.exceptions).toEqual(["BLOCKED — Critical defect open"]);
  });

  it("enforced: refuses without a check", () => {
    const d = decideLegacyAssignment({ mode: "enforced", check: null, currentFacts: null, grantedOverrides: [], subject, now: NOW });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals).toEqual(["Assignment made without a readiness check"]);
  });

  it("enforced: refuses a blocked check by name, and a check for another operator", () => {
    const d = decideLegacyAssignment({ mode: "enforced", check: check({ operatorId: 99, verdict: "blocked", blockers: [blk({ code: "roadside_event_open", label: "Roadside event RS-1 open" })] }), currentFacts: null, grantedOverrides: [], subject, now: NOW });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.refusals).toContain("Check 10 is for a different operator");
      expect(d.refusals).toContain("BLOCKED — Roadside event RS-1 open");
    }
  });

  it("enforced: refuses a stale check and one whose facts moved", () => {
    const good = check({ fingerprint: computeEligibilityFingerprint(facts) });
    expect(decideLegacyAssignment({ mode: "enforced", check: good, currentFacts: facts, grantedOverrides: [], subject, now: NOW }).allowed).toBe(true);
    const stale = decideLegacyAssignment({ mode: "enforced", check: { ...good, evaluatedAt: mins(-45) }, currentFacts: facts, grantedOverrides: [], subject, now: NOW });
    expect(stale.allowed).toBe(false);
    const moved = decideLegacyAssignment({ mode: "enforced", check: good, currentFacts: { ...facts, criticalDefectCount: 1 }, grantedOverrides: [], subject, now: NOW });
    expect(moved.allowed).toBe(false);
    if (!moved.allowed) expect(moved.refusals.join(" ")).toMatch(/changed/i);
  });

  it("enforced: an overridable unknown is covered by a granted override; a non-overridable one never is", () => {
    const route = blk({ code: "route_not_evaluated", label: "Route not evaluated", severity: "unknown", subject: "route", overridable: true, overrideAuthority: "manager" });
    const c = check({ verdict: "unknown", blockers: [route] });
    expect(decideLegacyAssignment({ mode: "enforced", check: c, currentFacts: null, grantedOverrides: [], subject, now: NOW }).allowed).toBe(false);
    expect(decideLegacyAssignment({ mode: "enforced", check: c, currentFacts: null, grantedOverrides: [{ blockerCode: "route_not_evaluated", grantedByUserId: 5, grantedByRole: "manager", reason: "r", grantedAt: NOW }], subject, now: NOW }).allowed).toBe(true);
    const hard = check({ verdict: "blocked", blockers: [blk({ code: "insurance_coverage_expired" })] });
    const d = decideLegacyAssignment({ mode: "enforced", check: hard, currentFacts: null, grantedOverrides: [{ blockerCode: "insurance_coverage_expired", grantedByUserId: 5, grantedByRole: "administrator", reason: "r", grantedAt: NOW }], subject, now: NOW });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.refusals.join(" ")).toContain("not permitted for any role");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions                                                          */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who may change enforcement", () => {
  it("management and controller only", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "dispatch.enforcement.manage" }).allowed).sort()).toEqual(["controller", "management"]);
  });
});

/* ------------------------------------------------------------------ */
/* The legacy path, end to end                                          */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 760000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("jobUnits.create under off, advisory and enforced", () => {
  it("walks the setting up and the legacy path behaves accordingly, leaving the history behind", async () => {
    const dispatcher = await withRole("dispatcher");
    const manager = await withRole("management");
    const driverUser = await withRole("driver");
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key("211").slice(0, 30)]);
    const unitId = Number(u.insertId);
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'T. Nguyen', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
    const operatorId = Number(op.insertId);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 12-01-050-08W5', 'dispatched', 0)", [key("JOB").slice(0, 40)]);
    const jobId = Number(j.insertId);
    // Insured, inspected, registered — so only the unknowns remain.
    for (const [t, title] of [["cvip_certificate", "CVIP"], ["vehicle_registration", "Registration"], ["insurance_proof", "Pink card"]]) await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, title]);
    const [insr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status) VALUES (?, ?, 'insurer', 'active')", [key("PRV").slice(0, 40), key("Ins").slice(0, 60)]);
    const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insurancePolicies (policyRef, financialEntityId, insurerId, policyType, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus) VALUES (?, 1, ?, 'commercial_auto', ?, DATE_SUB(NOW(), INTERVAL 60 DAY), DATE_ADD(NOW(), INTERVAL 300 DAY), 'active', 'coverage_verified')", [key("POL").slice(0, 40), Number(insr.insertId), key("PN").slice(0, 40)]);
    await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, additionalInsuredEndorsement) VALUES (?, 'commercial_auto', 5000000, 1)", [Number(pol.insertId)]);
    await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'unit', ?, DATE_SUB(NOW(), INTERVAL 60 DAY))", [Number(pol.insertId), unitId]);
    const identity = (uid: number) => callerFor(uid).fieldRoute.identity.jobUnits;

    // OFF: the setting is global and persists across runs, so establish it rather than assume it.
    await callerFor(manager).dispatch.enforcementSet({ mode: "off", reason: "Test start — establish the default explicitly" });
    expect((await callerFor(dispatcher).dispatch.enforcementGet()).mode).toBe("off");
    // Assigns as it always has, and records that it did so under "off".
    const id1 = await identity(dispatcher).create({ jobId, unitId, operatorId, role: "operator", joinedAt: new Date() });
    const [r1] = await pool.execute<mysql.RowDataPacket[]>("SELECT enforcementModeAtCreate, eligibilityCheckId FROM jobUnits WHERE id = ?", [id1]);
    expect(r1[0].enforcementModeAtCreate).toBe("off");
    expect(r1[0].eligibilityCheckId).toBeNull();

    // A dispatcher may not change the setting; management may. The change is a row, not an update.
    await expect(callerFor(dispatcher).dispatch.enforcementSet({ mode: "advisory", reason: "Let us see what would be refused" })).rejects.toBeTruthy();
    const s1 = await callerFor(manager).dispatch.enforcementSet({ mode: "advisory", reason: "Let us see what would be refused before we enforce" });
    expect(s1).toEqual({ scope: "global", previous: "off", mode: "advisory" });

    // ADVISORY: assigns without a check — and that assignment is an exception the centre raises.
    const id2 = await identity(dispatcher).create({ jobId, unitId, operatorId, role: "operator", joinedAt: new Date() });
    const [r2] = await pool.execute<mysql.RowDataPacket[]>("SELECT enforcementModeAtCreate FROM jobUnits WHERE id = ?", [id2]);
    expect(r2[0].enforcementModeAtCreate).toBe("advisory");
    const ex = await callerFor(dispatcher).surfaces.exceptions({ category: "dispatch" });
    expect(ex.items.some(x => x.key === `ungated:${id2}` && x.title.includes("without a readiness check"))).toBe(true);
    expect(ex.items.some(x => x.key === `ungated:${id1}`)).toBe(false); // made under "off" — not an exception

    // ENFORCED: refuses without a check; refuses on an unknown check; assigns once the unknowns are overridden.
    await callerFor(manager).dispatch.enforcementSet({ mode: "enforced", reason: "Routing source and HOS rule not yet loaded; we accept manager overrides as the record" });
    await expect(identity(dispatcher).create({ jobId, unitId, operatorId, role: "operator", joinedAt: new Date() })).rejects.toThrow(/without a readiness check/);
    const c = await callerFor(dispatcher).dispatch.evaluate({ operatorId, unitId, trailerId: null, jobId, postingId: null });
    expect(c.verdict).toBe("unknown");
    await expect(identity(dispatcher).create({ jobId, unitId, operatorId, role: "operator", joinedAt: new Date(), eligibilityCheckId: c.checkId })).rejects.toThrow(/UNKNOWN/);
    for (const b of c.blockers) {
      await callerFor(dispatcher).dispatch.overrideRequest({ checkId: c.checkId, blockerCode: b.code, reason: `Verified by phone — ${b.code}` });
      const granter = b.overrideAuthority === "administrator" ? await withRole("controller") : manager;
      expect((await callerFor(granter).dispatch.overrideGrant({ checkId: c.checkId, blockerCode: b.code, reason: `Accepted on record — ${b.code}` })).granted, b.code).toBe(true);
    }
    const id3 = await identity(dispatcher).create({ jobId, unitId, operatorId, role: "operator", joinedAt: new Date(), eligibilityCheckId: c.checkId });
    const [r3] = await pool.execute<mysql.RowDataPacket[]>("SELECT enforcementModeAtCreate, eligibilityCheckId FROM jobUnits WHERE id = ?", [id3]);
    expect(r3[0].enforcementModeAtCreate).toBe("enforced");
    expect(Number(r3[0].eligibilityCheckId)).toBe(c.checkId);
    const [used] = await pool.execute<mysql.RowDataPacket[]>("SELECT usedForAward, jobId, postingId FROM dispatchEligibilityChecks WHERE id = ?", [c.checkId]);
    expect(Number(used[0].usedForAward)).toBe(1);
    expect(Number(used[0].jobId)).toBe(jobId);
    expect(used[0].postingId).toBeNull();

    // A job-scoped check cannot be turned into a posting award.
    const aw = callerFor(dispatcher).dispatch.award({ checkId: c.checkId, startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000) });
    await expect(aw).rejects.toThrow(/direct job assignment/);

    // A check for a different job or unit is refused before the mode is even consulted. The other job is a real one
    // (P4.1: a job the caller cannot see is "not found" before anything else is looked at, so `jobId + 1` no longer works).
    const [otherJob] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 12-01-050-08W5', 'dispatched', 0)", [key("JOB").slice(0, 40)]);
    await expect(identity(dispatcher).create({ jobId: Number(otherJob.insertId), unitId, operatorId, role: "operator", joinedAt: new Date(), eligibilityCheckId: c.checkId })).rejects.toThrow(/for job/);

    // The history is all there, in order, with reasons.
    const [hist] = await pool.execute<mysql.RowDataPacket[]>("SELECT mode, reason, setByUserId FROM dispatchEnforcementSettings WHERE financialEntityId IS NULL AND setByUserId = ? ORDER BY setAt, id", [manager]);
    expect(hist.map(h => h.mode)).toEqual(["off", "advisory", "enforced"]);
    expect(hist.every(h => Number(h.setByUserId) === manager && String(h.reason).length > 10)).toBe(true);

    // Back to off, so other suites' legacy assignments are unaffected.
    await callerFor(manager).dispatch.enforcementSet({ mode: "off", reason: "Test teardown — restore default" });
    expect((await callerFor(dispatcher).dispatch.enforcementGet()).mode).toBe("off");
  });
});
