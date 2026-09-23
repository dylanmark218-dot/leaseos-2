/**
 * C1a — readiness hardening, against a real database and through the real procedures.
 *
 *   producer → typed finding → composeReadiness → dispatch.evaluate → override → dispatch.award
 *
 * The pure half (classification, merge, policy, fingerprint) is server/_core/complianceFinding.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { composeReadiness } from "./readinessComposer";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 9_300_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
type Finding = { code: string; label: string; severity: string; overridable: boolean; overrideAuthority?: string; dispatchEffect?: string; overrideClass?: string; result?: string; authorityClass?: string };

/**
 * A subject whose every safety prerequisite is ESTABLISHED: licence, medical, inspection,
 * registration, verified insurance, today's HOS attestation and an approved route. What remains is
 * warning-grade only, so an award is possible after acknowledgement — which is the baseline each
 * test then disturbs.
 */
async function establishedSubject() {
  const dispatcher = await withRole("dispatcher");
  const manager = await withRole("management");
  const driverUser = await withRole("driver");
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key("U").slice(0, 30)]);
  const unitId = Number(u.insertId);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'C. One', DATE_ADD(NOW(), INTERVAL 400 DAY))", [driverUser]);
  const operatorId = Number(op.insertId);
  for (const t of ["cvip_certificate", "vehicle_registration", "insurance_proof"]) {
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('unit', ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [unitId, t, t]);
  }
  await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator', ?, 'medical_fitness', 'Medical', NOW(), DATE_ADD(NOW(), INTERVAL 300 DAY), 'verified')", [operatorId]);
  const [insr] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role, status) VALUES (?, ?, 'insurer', 'active')", [key("PRV").slice(0, 40), key("Ins").slice(0, 60)]);
  const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insurancePolicies (policyRef, financialEntityId, insurerId, policyType, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus) VALUES (?, 1, ?, 'commercial_auto', ?, DATE_SUB(NOW(), INTERVAL 60 DAY), DATE_ADD(NOW(), INTERVAL 300 DAY), 'active', 'coverage_verified')", [key("POL").slice(0, 40), Number(insr.insertId), key("PN").slice(0, 40)]);
  const policyId = Number(pol.insertId);
  await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, additionalInsuredEndorsement) VALUES (?, 'commercial_auto', 5000000, 1)", [policyId]);
  await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'unit', ?, DATE_SUB(NOW(), INTERVAL 60 DAY))", [policyId, unitId]);
  const customer = key("Cust").slice(0, 40);
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', ?, 'LSD 04-12-052-09W5', 'dispatched', 0)", [key("JOB").slice(0, 40), customer]);
  const jobId = Number(j.insertId);
  const [p] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, planningBlocker, priority, crewSize, rateVisible, createdByUserId) VALUES (?, ?, 'direct_assignment', 'direct', 'none', 'normal', 1, 0, ?)", [key("POST").slice(0, 40), jobId, dispatcher]);
  const postingId = Number(p.insertId);
  const approvalRef = key("RA").slice(0, 60);
  await pool.execute("INSERT INTO routeApprovals (approvalRef, jobId, unitId, originRef, destinationRef, dispatchStatus, segmentIdsJson, fingerprintJson, fingerprintHash, explanation, status, approvedByUserId) VALUES (?, ?, ?, 'yard', 'lease', 'clear', '[]', '{}', ?, 'Approved local route', 'approved', ?)", [approvalRef, jobId, unitId, "c".repeat(64), manager]);
  await pool.execute("INSERT INTO hosAttestations (operatorId, dutyDate, method, statement, hoursAvailableMinutesStated, attestedByUserId) VALUES (?, UTC_DATE(), 'paper_log_reviewed', 'Reviewed the paper log for today', 600, ?)", [operatorId, manager]);
  const subject = { operatorId, unitId, trailerId: null, jobId, routeApprovalRef: approvalRef };
  return { dispatcher, manager, driverUser, unitId, operatorId, jobId, postingId, approvalRef, policyId, customer, subject };
}
type Subject = Awaited<ReturnType<typeof establishedSubject>>;

const window = () => ({ startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });

/** Acknowledge every WARNING_ONLY finding on a check: requested by the dispatcher, granted by the manager. */
async function acknowledgeWarnings(s: Subject, checkId: number, blockers: Finding[]) {
  for (const b of blockers.filter(x => x.overrideClass === "WARNING_ONLY")) {
    await caller(s.dispatcher).dispatch.overrideRequest({ checkId, blockerCode: b.code, reason: `Reviewed and accepted — ${b.code}` });
    const granter = b.overrideAuthority === "administrator" ? await withRole("controller") : s.manager;
    const g = await caller(granter).dispatch.overrideGrant({ checkId, blockerCode: b.code, reason: `Acknowledged on record — ${b.code}` });
    expect(g.granted, b.code).toBe(true);
  }
}

/** The OOS release policy the enforcement domain requires before any finding can be recorded. */
async function approvedOosPolicy(branch: string) {
  const proposer = await withRole("management");
  const approver = await withRole("management");
  const ROLES = { repair_verification: ["mechanic", "shop_lead"], reinspection: ["safety"], inspector_release: ["safety"], document_confirmation: ["office"], waiting_period_complete: ["safety"], other: ["management"] };
  // Branch-scoped, as the enforcement suites do: a company-wide policy would collide with any other
  // approved company policy in the same database.
  const p = await caller(proposer).comms.oosPolicyPropose({ label: `c1a policy ${rnd()}`, scopeType: "branch", scopeRef: branch, allowedFindingRoles: ROLES, effectiveFrom: new Date("2020-01-01") });
  await caller(approver).comms.oosPolicyApprove({ policyRef: p.policyRef, decision: "approve" });
}

d("C1a baseline — an established subject is awardable once its warnings are acknowledged", () => {
  it("has no BLOCK finding, only WARNING_ONLY ones, and awards", async () => {
    const s = await establishedSubject();
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    const blockers = c.blockers as Finding[];
    expect(blockers.filter(b => b.dispatchEffect === "BLOCK").map(b => b.code)).toEqual([]);
    for (const b of blockers) expect(b.overrideClass, b.code).toBe("WARNING_ONLY");
    await acknowledgeWarnings(s, c.checkId, blockers);
    const a = await caller(s.dispatcher).dispatch.award({ checkId: c.checkId, ...window() });
    expect(a.ok, (a as { refusals?: string[] }).refusals?.join(" | ")).toBe(true);
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT fingerprint, ruleSetHash, orgRef FROM dispatchEligibilityChecks WHERE id = ?", [c.checkId]);
    expect(String(row[0].fingerprint)).toMatch(/^EF2-[0-9a-f]{64}$/);
    expect(String(row[0].ruleSetHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(row[0].orgRef).toBe("default");
  });
});

/* ------------------------------------------------------------------ */
/* C1a-8 — the mandatory OOS end-to-end                                */
/* ------------------------------------------------------------------ */

d("C1a-8: government OOS → finding → composer → BLOCK → NEVER_OVERRIDABLE → award refused; repair ≠ release; release lifts it", () => {
  it("1–4, 20. walks the whole path through the real procedures", async () => {
    const s = await establishedSubject();
    const branch = `B-${rnd()}`;
    await approvedOosPolicy(branch);
    const safety = await withRole("safety");
    const mechanic = await withRole("mechanic");

    // An inspector puts the unit out of service. Confirmed by safety through the enforcement domain.
    const confirmed = await caller(safety).enforcement.eventConfirm({
      eventType: "roadside_inspection", jurisdiction: "CA-AB", agency: `agency-${rnd()}`,
      occurredAt: new Date(Date.now() - 3_600_000), inspectionReportNumber: `INSP-${rnd()}`,
      inspectionLevel: "I", inspectionResult: "out_of_service", unitId: s.unitId, branchId: branch,
      subjectRefs: { vehicle: `UNIT-${rnd()}` },
      violations: [{
        system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER", citationIssued: true, outOfService: true,
        oosScope: "vehicle", defectRequired: true, repairRequired: true, courtAction: false,
        releaseCondition: "reinspection passed", requiredFindingType: "reinspection",
      }],
    });
    const orderRef = confirmed.orderRefs[0];

    // 1. The canonical contribution: BLOCK, NEVER_OVERRIDABLE, regulator_order — through the composer.
    const pre = await caller(s.dispatcher).dispatch.readiness(s.subject);
    const oos = (pre.blockers as Finding[]).find(b => b.code === "oos.vehicle");
    expect(oos, JSON.stringify(pre.blockers.map(b => b.code))).toBeTruthy();
    expect(oos).toMatchObject({ severity: "blocking", overridable: false, dispatchEffect: "BLOCK", overrideClass: "NEVER_OVERRIDABLE", result: "UNSATISFIED", authorityClass: "regulator_order" });
    expect(pre.verdict).toBe("blocked");

    // 2. Nobody may override it: the request is recorded and refused, and a manager's grant is refused.
    const c1 = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    const req = await caller(s.dispatcher).dispatch.overrideRequest({ checkId: c1.checkId, blockerCode: "oos.vehicle", reason: "Customer is waiting and the load is hot" });
    expect(req.requestable).toBe(false);
    expect(req.overrideClass).toBe("NEVER_OVERRIDABLE");
    expect((await caller(s.manager).dispatch.overrideGrant({ checkId: c1.checkId, blockerCode: "oos.vehicle", reason: "I accept responsibility for this one" })).granted).toBe(false);
    // The controller role does not hold the grant permission at all; refused before the class is even read.
    const admin = await withRole("controller");
    await expect(caller(admin).dispatch.overrideGrant({ checkId: c1.checkId, blockerCode: "oos.vehicle", reason: "Administrator taking responsibility" })).rejects.toThrow();

    // 20. The refusal is the SERVER's: every other finding acknowledged, the award is still refused
    //     by the API itself, and no assignment was written.
    await acknowledgeWarnings(s, c1.checkId, c1.blockers as Finding[]);
    const a1 = await caller(s.dispatcher).dispatch.award({ checkId: c1.checkId, ...window() });
    expect(a1.ok).toBe(false);
    if (!a1.ok) expect(a1.refusals.join(" ")).toContain(oos!.label);
    const [approved] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM dispatchAuditEvents WHERE postingId = ? AND eventType = 'assignment_approved'", [s.postingId]);
    expect(Number(approved[0].n)).toBe(0);

    // 3. The shop repairs it, through the shop's own procedures. Repair is not release: still BLOCKED.
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT defectId, workOrderId FROM enforcementViolations WHERE eventRef = ?", [confirmed.eventRef]).then(r => r[0]) as unknown as mysql.RowDataPacket[];
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "in_progress" });
    await caller(mechanic).shop.workOrderAdvance({ workOrderId: Number(v.workOrderId), to: "ready_for_service" });
    await caller(mechanic).shop.workOrderRelease({
      workOrderId: Number(v.workOrderId), releaseType: "full", repairSummary: "brake chamber replaced", testProcedure: "brake performance test",
      testResult: "pass", roadTestPerformed: true, roadTestNotes: "no pull", resolvedDefectIds: [Number(v.defectId)], releasedAt: new Date(),
    });
    const afterRepair = await caller(s.dispatcher).dispatch.readiness(s.subject);
    expect((afterRepair.blockers as Finding[]).find(b => b.code === "oos.vehicle")).toMatchObject({ dispatchEffect: "BLOCK", overrideClass: "NEVER_OVERRIDABLE" });
    expect(afterRepair.verdict).toBe("blocked");
    await expect(caller(safety).enforcement.orderRelease({ orderRef })).rejects.toThrow();

    // Wrong role: a mechanic cannot release a government order.
    await expect(caller(mechanic).enforcement.orderRelease({ orderRef })).rejects.toThrow();

    // 4. The authorized release: safety records the reinspection the order demands, then releases.
    await caller(safety).enforcement.findingRecord({ orderRef, finding: "satisfied", findingType: "reinspection", evidenceRef: "EV-REINSP" });
    const released = await caller(safety).enforcement.orderRelease({ orderRef, releaseEvidenceRef: "EV-REINSP" });
    expect(released.released).toBe(true);
    const after = await caller(s.dispatcher).dispatch.readiness(s.subject);
    const codes = after.blockers.map(b => b.code);
    expect(codes.filter(c => c.startsWith("oos.") || c === "enforcement_result_unknown")).toEqual([]);
    // Other, independent findings may remain — the release lifts the order, nothing else.
  });
});

/* ------------------------------------------------------------------ */
/* C1a-3 — grantor provenance                                          */
/* ------------------------------------------------------------------ */

d("C1a-3: the grantor is recorded, and is never the requester", () => {
  it("5–6. records requester and grantor separately, with authority, reason, time, scope and expiry", async () => {
    const s = await establishedSubject();
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    const w = (c.blockers as Finding[]).find(b => b.overrideClass === "WARNING_ONLY")!;
    await caller(s.dispatcher).dispatch.overrideRequest({ checkId: c.checkId, blockerCode: w.code, reason: "Checked with the operator by phone" });
    await expect(caller(s.dispatcher).dispatch.overrideGrant({ checkId: c.checkId, blockerCode: w.code, reason: "Granting my own request" })).rejects.toThrow(/own override/);
    const g = await caller(s.manager).dispatch.overrideGrant({ checkId: c.checkId, blockerCode: w.code, reason: "Accepted; the note is on file" });
    expect(g).toMatchObject({ granted: true, grantedByUserId: s.manager, requestedByUserId: s.dispatcher });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM dispatchOverrides WHERE eligibilityCheckId = ? AND blockerCode = ? AND granted = 1", [c.checkId, w.code]);
    expect(row).toHaveLength(1);
    const r = row[0];
    expect(Number(r.requestedByUserId)).toBe(s.dispatcher);
    expect(Number(r.grantedByUserId)).toBe(s.manager);
    expect(r.grantedByRole).toBe("manager");
    expect(r.grantReason).toBe("Accepted; the note is on file");
    expect(r.reason).toBe("Checked with the operator by phone");
    expect(r.overrideClass).toBe("WARNING_ONLY");
    expect(r.grantedAt).toBeTruthy();
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.parse(r.scopeJson)).toMatchObject({ checkId: c.checkId, blockerCode: w.code });
  });

  it("a pre-0172 granted row with no recorded grantor is not a grant — the award refuses", async () => {
    const s = await establishedSubject();
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    // Exactly what the old code wrote: `granted = 1`, and only the requester on record.
    for (const b of c.blockers as Finding[]) {
      await pool.execute("INSERT INTO dispatchOverrides (eligibilityCheckId, postingId, blockerCode, requestedByUserId, requestedByRole, reason, granted, requestedAt) VALUES (?, ?, ?, ?, 'manager', 'legacy row', 1, NOW())", [c.checkId, s.postingId, b.code, s.manager]);
    }
    const a = await caller(s.dispatcher).dispatch.award({ checkId: c.checkId, ...window() });
    expect(a.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* C1a-6 — the fingerprint stales a check when governing state moves  */
/* ------------------------------------------------------------------ */

d("C1a-6: a readiness decision goes stale when anything it governed on changes", () => {
  const fp = async (s: Subject) => composeReadiness(s.subject);

  it("is stable when nothing changed", async () => {
    const s = await establishedSubject();
    expect((await fp(s)).fingerprint).toBe((await fp(s)).fingerprint);
  });

  it("13. an OOS order issued after the check stales it, and the award refuses on the change", async () => {
    const s = await establishedSubject();
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    await acknowledgeWarnings(s, c.checkId, c.blockers as Finding[]);
    const eventRef = key("EV").slice(0, 60);
    await pool.execute("INSERT INTO enforcementEvents (eventRef, eventType, jurisdiction, tenantId, agency, occurredAt, inspectionResult, unitId, status, confirmedByUserId, confirmedAt) VALUES (?, 'roadside_inspection', 'AB', 'default', 'CVSA', NOW(), 'out_of_service', ?, 'confirmed', 1, NOW())", [eventRef, s.unitId]);
    await pool.execute("INSERT INTO outOfServiceOrders (orderRef, eventRef, scope, subjectRef, tenantId, issuedAt, issuingAgency, releaseCondition, status) VALUES (?, ?, 'vehicle', ?, 'default', NOW(), 'CVSA', 'Reinspection', 'active')", [key("OOS").slice(0, 60), eventRef, `UNIT-${s.unitId}`]);
    const a = await caller(s.dispatcher).dispatch.award({ checkId: c.checkId, ...window() });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.refusals.join(" ")).toMatch(/changed/i);
  });

  it("12. insurance expiring after the check stales it", async () => {
    const s = await establishedSubject();
    const before = (await fp(s)).fingerprint;
    // Restored afterwards: the exception centre is not tenant-scoped yet (see the tenancy follow-up),
    // so an expired policy left behind shows up in every other suite's exception list.
    const [orig] = await pool.execute<mysql.RowDataPacket[]>("SELECT expiresAt FROM insurancePolicies WHERE id = ?", [s.policyId]);
    try {
      await pool.execute("UPDATE insurancePolicies SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?", [s.policyId]);
      expect((await fp(s)).fingerprint).not.toBe(before);
    } finally {
      await pool.execute("UPDATE insurancePolicies SET expiresAt = ? WHERE id = ?", [orig[0].expiresAt, s.policyId]);
    }
  });

  it("14. an HOS change stales it — today's attestation superseded", async () => {
    const s = await establishedSubject();
    const before = (await fp(s)).fingerprint;
    await pool.execute("UPDATE hosAttestations SET supersededAt = NOW() WHERE operatorId = ?", [s.operatorId]);
    expect((await fp(s)).fingerprint).not.toBe(before);
  });

  it("15. a required credential expiring stales it — structured and legacy licence alike", async () => {
    const s = await establishedSubject();
    const before = (await fp(s)).fingerprint;
    await pool.execute("UPDATE complianceDocuments SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE ownerType = 'operator' AND ownerId = ? AND docType = 'medical_fitness'", [s.operatorId]);
    const mid = (await fp(s)).fingerprint;
    expect(mid).not.toBe(before);
    await pool.execute("UPDATE operators SET licenseExpiresAt = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?", [s.operatorId]);
    expect((await fp(s)).fingerprint).not.toBe(mid);
  });

  it("16. a route or permit change stales it — the approval revoked, or its dependency hash moved", async () => {
    const s = await establishedSubject();
    const before = (await fp(s)).fingerprint;
    await pool.execute("UPDATE routeApprovals SET fingerprintHash = ? WHERE approvalRef = ?", ["d".repeat(64), s.approvalRef]); // e.g. a permit added to the set
    const mid = (await fp(s)).fingerprint;
    expect(mid).not.toBe(before);
    await pool.execute("UPDATE routeApprovals SET status = 'revoked' WHERE approvalRef = ?", [s.approvalRef]);
    expect((await fp(s)).fingerprint).not.toBe(mid);
  });

  it("a safety-critical telematics fault appearing stales it", async () => {
    const s = await establishedSubject();
    const before = (await fp(s)).fingerprint;
    await pool.execute("INSERT INTO faultCodes (unitId, protocol, code, firstSeenAt, lastSeenAt, status, severityDetermination, sourceClientId) VALUES (?, 'j1939', ?, NOW(), NOW(), 'active', 'critical', 1)", [s.unitId, `SPN${rnd()}`.slice(0, 12)]);
    expect((await fp(s)).fingerprint).not.toBe(before);
  });

  it("17. a rule-set change stales it even though no fact about the truck or driver moved", async () => {
    const s = await establishedSubject();
    const r0 = await fp(s);
    const [req] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO academyRequirements (requirementCode, title, qualificationCode, enforcement, active) VALUES (?, 'Site orientation', 'SITE_ORIENTATION', 'review', 1)", [key("REQ").slice(0, 90)]);
    await pool.execute("INSERT INTO academyRequirementBindings (bindingRef, requirementId, subjectType, subjectCode, active) VALUES (?, ?, 'customer', ?, 1)", [key("BIND").slice(0, 90), Number(req.insertId), s.customer]);
    const r1 = await fp(s);
    expect(r1.ruleSetHash).not.toBe(r0.ruleSetHash);
    expect(r1.fingerprint).not.toBe(r0.fingerprint);
  });
});

/* ------------------------------------------------------------------ */
/* C1a-7 — dangerous goods, in the composer                            */
/* ------------------------------------------------------------------ */

d("C1a-7: the composer reads dangerous goods from verified load classification, never from the job's wording", () => {
  it("10–11. a job typed 'hazard …' with no loads is UNKNOWN; a verified UN load under 'water_haul' requires TDG", async () => {
    const s = await establishedSubject();
    await pool.execute("UPDATE jobs SET type = 'hazard_tree_removal' WHERE id = ?", [s.jobId]);
    const r1 = await caller(s.dispatcher).dispatch.readiness(s.subject);
    expect((r1.blockers as Finding[]).find(b => b.code === "dg_classification_missing")).toMatchObject({ result: "UNKNOWN", dispatchEffect: "BLOCK" });

    await pool.execute("UPDATE jobs SET type = 'water_haul' WHERE id = ?", [s.jobId]);
    await pool.execute("INSERT INTO loadProfiles (jobId, material, unNumber, dgClass, classificationStatus, verifiedAt) VALUES (?, 'Gasoline', 'UN1203', '3', 'verified', NOW())", [s.jobId]);
    const r2 = await caller(s.dispatcher).dispatch.readiness(s.subject);
    const codes = r2.blockers.map(b => b.code);
    expect(codes).toContain("operator_tdg_certificate_missing");
    expect(codes).toContain("tdg_document_unknown");
    expect(codes).not.toContain("dg_classification_missing");
  });

  it("free text never clears: 'hazard' in the job over a verified non-DG load is not DG, and an unverified load is UNKNOWN", async () => {
    const s = await establishedSubject();
    await pool.execute("UPDATE jobs SET type = 'hazard_tree_removal' WHERE id = ?", [s.jobId]);
    const [lp] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loadProfiles (jobId, material, classificationStatus, verifiedAt) VALUES (?, 'Wood chips', 'verified', NOW())", [s.jobId]);
    const r1 = await caller(s.dispatcher).dispatch.readiness(s.subject);
    expect(r1.blockers.map(b => b.code).filter(c => c.startsWith("dg_") || c.startsWith("tdg_") || c.includes("tdg_certificate"))).toEqual([]);
    await pool.execute("UPDATE loadProfiles SET classificationStatus = 'needs_verification' WHERE id = ?", [Number(lp.insertId)]);
    const r2 = await caller(s.dispatcher).dispatch.readiness(s.subject);
    expect((r2.blockers as Finding[]).find(b => b.code === "dg_classification_unverified")).toMatchObject({ result: "UNKNOWN", dispatchEffect: "BLOCK" });
  });
});

/* ------------------------------------------------------------------ */
/* Tenancy on the touched path                                          */
/* ------------------------------------------------------------------ */

d("18. tenant-crossing attempts are refused, and the caller cannot supply a tenant", () => {
  it("another organization's dispatcher cannot read, evaluate, grant on or award this tenant's readiness", async () => {
    const s = await establishedSubject();
    const c = await caller(s.dispatcher).dispatch.evaluate({ ...s.subject, postingId: s.postingId });
    const w = (c.blockers as Finding[]).find(b => b.overrideClass === "WARNING_ONLY")!;
    await caller(s.dispatcher).dispatch.overrideRequest({ checkId: c.checkId, blockerCode: w.code, reason: "Checked with the operator by phone" });

    const orgRef = key("ORG").slice(0, 60);
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
    const outsider = await withRole("management");
    await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [key("MEM").slice(0, 60), orgRef, outsider]);

    await expect(caller(outsider).dispatch.readiness(s.subject)).rejects.toThrow(/not found/i);
    await expect(caller(outsider).dispatch.evaluate({ ...s.subject, postingId: s.postingId })).rejects.toThrow(/not found/i);
    await expect(caller(outsider).dispatch.overrideRequest({ checkId: c.checkId, blockerCode: w.code, reason: "From another company entirely" })).rejects.toThrow(/not found/i);
    await expect(caller(outsider).dispatch.overrideGrant({ checkId: c.checkId, blockerCode: w.code, reason: "From another company entirely" })).rejects.toThrow(/not found/i);
    await expect(caller(outsider).dispatch.award({ checkId: c.checkId, ...window() })).rejects.toThrow(/not found/i);
    // A tenant id in the request is not an input: it is stripped, and the scope stays the server's.
    await expect(caller(outsider).dispatch.readiness({ ...s.subject, orgRef: "default", tenantId: "default" } as never)).rejects.toThrow(/not found/i);
    const [o] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM dispatchOverrides WHERE eligibilityCheckId = ? AND granted = 1", [c.checkId]);
    expect(Number(o[0].n)).toBe(0);
  });
});
