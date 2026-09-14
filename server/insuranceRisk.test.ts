import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  assessCoverage, certificatesAffectedByRenewal, claimFinancials, dispatchInsuranceGate, matchCustomerRequirements,
  renewalCalendar, roadsideInsuranceItems, type PolicyRecord,
} from "./_core/insuranceRisk";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const policy = (over: Partial<PolicyRecord> = {}): PolicyRecord => ({
  policyRef: "POL-1", policyType: "commercial_auto", effectiveAt: days(-200), expiresAt: days(165), status: "active",
  coverageVerificationStatus: "coverage_verified",
  coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000, additionalInsuredEndorsement: true }],
  document: { expiresAt: days(165), verificationStatus: "verified" }, ...over,
});

/* ------------------------------------------------------------------ */
/* Six statuses                                                         */
/* ------------------------------------------------------------------ */

describe("document_missing is not coverage_expired", () => {
  it("verifies when the insurer confirmed and the proof is verified", () => {
    const a = assessCoverage({ coverageType: "commercial_auto", policies: [policy()], now: NOW });
    expect(a.status).toBe("coverage_verified");
    expect(a.effect).toBe("none");
  });

  it("reviews — does not block — when no proof document is on file", () => {
    const a = assessCoverage({ coverageType: "commercial_auto", policies: [policy({ document: null })], now: NOW });
    expect(a.status).toBe("document_missing");
    expect(a.effect).toBe("review");
    expect(a.reason).toContain("coverage is not assumed absent");
  });

  it("reviews when the proof expired but the policy has not", () => {
    const a = assessCoverage({ coverageType: "commercial_auto", policies: [policy({ document: { expiresAt: days(-5), verificationStatus: "verified" } })], now: NOW });
    expect(a.status).toBe("document_expired");
    expect(a.effect).toBe("review");
    expect(a.reason).toContain("refresh the document");
  });

  it("blocks when the policy itself expired, and when there is no policy", () => {
    expect(assessCoverage({ coverageType: "commercial_auto", policies: [policy({ expiresAt: days(-1) })], now: NOW }).status).toBe("coverage_expired");
    expect(assessCoverage({ coverageType: "commercial_auto", policies: [policy({ expiresAt: days(-1) })], now: NOW }).effect).toBe("blocked");
    const none = assessCoverage({ coverageType: "cargo", policies: [policy()], now: NOW });
    expect(none.status).toBe("coverage_unknown");
    expect(none.effect).toBe("blocked");
  });

  it("holds at coverage_reported until a person verifies with the insurer", () => {
    const a = assessCoverage({ coverageType: "commercial_auto", policies: [policy({ coverageVerificationStatus: "coverage_reported" })], now: NOW });
    expect(a.status).toBe("coverage_reported");
    expect(a.effect).toBe("review");
  });

  it("ignores cancelled and quoted policies", () => {
    expect(assessCoverage({ coverageType: "commercial_auto", policies: [policy({ status: "cancelled" })], now: NOW }).status).toBe("coverage_unknown");
    expect(assessCoverage({ coverageType: "commercial_auto", policies: [policy({ status: "quoted" })], now: NOW }).status).toBe("coverage_unknown");
  });
});

describe("dispatch is blocked by an expired policy, not by missing paper", () => {
  it("separates blockers from office actions", () => {
    const g = dispatchInsuranceGate([
      assessCoverage({ coverageType: "commercial_auto", policies: [policy({ document: null })], now: NOW }),
      assessCoverage({ coverageType: "cargo", policies: [policy({ policyRef: "POL-C", coverages: [{ coverageType: "cargo", limitAmount: 250_000, additionalInsuredEndorsement: false }] })], now: NOW }),
    ]);
    expect(g.verdict).toBe("review");
    expect(g.blockers).toEqual([]);
    expect(g.officeActions).toHaveLength(1);
    const blocked = dispatchInsuranceGate([assessCoverage({ coverageType: "commercial_auto", policies: [policy({ expiresAt: days(-1) })], now: NOW })]);
    expect(blocked.verdict).toBe("blocked");
  });

  it("puts only proof on the roadside package — never premiums or claims", () => {
    const items = roadsideInsuranceItems([assessCoverage({ coverageType: "commercial_auto", policies: [policy()], now: NOW })]);
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("insurance_proof");
    for (const k of Object.keys(items[0])) expect(["category", "coverageType", "status", "policyRef"]).toContain(k);
  });
});

/* ------------------------------------------------------------------ */
/* Customer requirements                                                */
/* ------------------------------------------------------------------ */

describe("customer requirement ↔ company coverage ↔ evidence", () => {
  const policies = [
    policy(),
    policy({ policyRef: "POL-GL", policyType: "general_liability", coverages: [{ coverageType: "general_liability", limitAmount: 2_000_000, additionalInsuredEndorsement: false }] }),
  ];

  it("matches, gaps on limit and endorsement, and is unknown when unverified", () => {
    const r = matchCustomerRequirements({
      requirements: [
        { coverageType: "commercial_auto", minimumLimit: 2_000_000, additionalInsuredRequired: true },
        { coverageType: "general_liability", minimumLimit: 5_000_000, additionalInsuredRequired: false },
        { coverageType: "general_liability", minimumLimit: null, additionalInsuredRequired: true },
        { coverageType: "pollution", minimumLimit: null, additionalInsuredRequired: false },
      ],
      policies, now: NOW,
    });
    expect(r.matches.map(m => m.outcome)).toEqual(["match", "gap", "gap", "gap"]);
    expect(r.matches[1].reason).toContain("Customer requires 5000000; policy limit is 2000000");
    expect(r.matches[2].reason).toContain("additional-insured endorsement");
    expect(r.readinessPercent).toBe(25);
  });

  it("is unknown, not gap, when coverage is reported but unverified", () => {
    const r = matchCustomerRequirements({ requirements: [{ coverageType: "commercial_auto", minimumLimit: null, additionalInsuredRequired: false }], policies: [policy({ coverageVerificationStatus: "coverage_reported" })], now: NOW });
    expect(r.matches[0].outcome).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* Renewals                                                             */
/* ------------------------------------------------------------------ */

describe("the renewal calendar", () => {
  it("buckets by days to expiry with an action per bucket", () => {
    const cal = renewalCalendar([
      { policyRef: "A", policyType: "commercial_auto", expiresAt: days(5), status: "active" },
      { policyRef: "B", policyType: "cargo", expiresAt: days(45), status: "active" },
      { policyRef: "C", policyType: "property", expiresAt: days(-2), status: "active" },
      { policyRef: "D", policyType: "cyber", expiresAt: days(400), status: "active" },
      { policyRef: "E", policyType: "garage", expiresAt: days(3), status: "cancelled" },
    ], NOW);
    expect(cal.map(c => [c.policyRef, c.bucket])).toEqual([["C", "expired"], ["A", "7_days"], ["B", "60_days"], ["D", "later"]]);
    expect(cal[0].action).toContain("Operational exception");
  });

  it("names every customer whose certificate a renewal invalidates", () => {
    const affected = certificatesAffectedByRenewal({
      policyRef: "POL-1", now: NOW,
      certificates: [
        { certificateRef: "C1", policyRef: "POL-1", recipientCustomerRef: "Suncor", expiresAt: days(100) },
        { certificateRef: "C2", policyRef: "POL-1", recipientCustomerRef: "CNRL", expiresAt: days(100) },
        { certificateRef: "C3", policyRef: "POL-1", recipientCustomerRef: "Old Co", expiresAt: days(-10) },
        { certificateRef: "C4", policyRef: "POL-2", recipientCustomerRef: "Other", expiresAt: days(100) },
      ],
    });
    expect(affected).toEqual(["Suncor", "CNRL"]);
  });
});

/* ------------------------------------------------------------------ */
/* Claims                                                               */
/* ------------------------------------------------------------------ */

describe("a recovery is added beside the cost, never subtracted from it", () => {
  it("keeps the specification's collision arithmetic", () => {
    const f = claimFinancials({
      costs: [{ costType: "tow", amount: 2400 }, { costType: "repair", amount: 31000 }, { costType: "rental_replacement", amount: 5000 }, { costType: "cleanup", amount: 1800 }],
      recoveries: [{ recoveryType: "approved", amount: 32500 }],
      deductible: 5000,
    });
    expect(f.grossLoss).toBe(40200);
    expect(f.approved).toBe(32500);
    expect(f.received).toBe(0);
    expect(f.receivableOutstanding).toBe(32500);
    expect(f.unrecovered).toBe(7700);
    expect(f.deductible).toBe(5000);
    // The four costs are still there.
    expect(f.costs).toHaveLength(4);
  });

  it("clears the receivable when payment arrives, and the costs remain", () => {
    const f = claimFinancials({ costs: [{ costType: "repair", amount: 31000 }], recoveries: [{ recoveryType: "approved", amount: 26000 }, { recoveryType: "received", amount: 26000 }], deductible: 5000 });
    expect(f.receivableOutstanding).toBe(0);
    expect(f.unrecovered).toBe(5000);
    expect(f.grossLoss).toBe(31000);
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow                                             */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who sees what", () => {
  it("lets a driver read a summary and nothing about claims or premiums", () => {
    expect(authorize({ userId: 1, roles: ["driver"], permission: "insurance.read_summary" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "insurance.read_policy" }).allowed).toBe(false);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "insurance.claim.financial" }).allowed).toBe(false);
  });
  it("reserves claim financials to finance and management", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "insurance.claim.financial" }).allowed).sort()).toEqual(["bookkeeper", "controller", "management"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 260000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("one policy, fifty trucks, one document; a collision; a customer certificate", () => {
  it("runs the chain end to end", async () => {
    const office = await withRole("office");
    const dispatcher = await withRole("dispatcher");
    const bookkeeper = await withRole("bookkeeper");
    const entityId = 260000 + Math.floor(Math.random() * 90000);
    const [ev] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, storageKey, capturedAt, capturedBy, status) VALUES ('Fleet policy', 'insurance', ?, NOW(), ?, 'verified')", [key("s3").slice(0, 60), office]);
    const evidenceId = Number(ev.insertId);

    // Record the policy. It is reported, not verified.
    const pol = await callerFor(office).insurance.policyRecord({
      financialEntityId: entityId, policyType: "commercial_auto", insurerName: "XYZ Insurance", brokerName: "ABC Brokers", policyNumber: key("PN"),
      effectiveAt: days(-100), expiresAt: days(265), annualPremium: 180000, deductible: 5000, evidenceRecordId: evidenceId,
      coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000, additionalInsuredEndorsement: true }, { coverageType: "cargo", limitAmount: 250_000 }],
    });
    expect(pol.coverageVerificationStatus).toBe("coverage_reported");

    // Cover three units under it. The one document relates to all three.
    const unitIds = [1001, 1002, 1003].map(n => n + Math.floor(Math.random() * 900000));
    const cov = await callerFor(office).insurance.coverageAssign({ policyRef: pol.policyRef, entities: unitIds.map(id => ({ entityType: "unit" as const, entityId: id })), coveredFrom: days(-100) });
    expect(cov.covered).toBe(3);
    const [rels] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRelationships WHERE evidenceRecordId = ? AND role = 'insured_under'", [evidenceId]);
    expect(Number(rels[0].n)).toBe(3);
    const [docs] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE id = ?", [evidenceId]);
    expect(Number(docs[0].n)).toBe(1);

    // Dispatch: unit 1 has no proof document on file → review, not blocked.
    const before = await callerFor(dispatcher).insurance.coverageForEntity({ financialEntityId: entityId, entityType: "unit", entityId: unitIds[0], coverageTypes: ["commercial_auto"] });
    expect(before.assessments[0].status).toBe("document_missing");
    expect(before.dispatch.verdict).toBe("review");
    expect(before.dispatch.blockers).toEqual([]);
    expect(before.assessments[0]).not.toHaveProperty("annualPremium");

    // Office puts proof on the unit and verifies coverage with the insurer.
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus, confidence) VALUES ('unit', ?, 'insurance_proof', 'Pink card', NOW(), ?, 'verified', 'high')", [unitIds[0], days(265)]);
    await expect(callerFor(dispatcher).insurance.coverageVerify({ policyRef: pol.policyRef, outcome: "coverage_verified" })).rejects.toBeTruthy();
    await callerFor(office).insurance.coverageVerify({ policyRef: pol.policyRef, outcome: "coverage_verified" });
    const after = await callerFor(dispatcher).insurance.coverageForEntity({ financialEntityId: entityId, entityType: "unit", entityId: unitIds[0], coverageTypes: ["commercial_auto"] });
    expect(after.assessments[0].status).toBe("coverage_verified");
    expect(after.dispatch.verdict).toBe("ready");
    expect(after.roadside[0].category).toBe("insurance_proof");

    // A customer's requirement profile, matched. Then a certificate.
    const cust = key("Suncor");
    await callerFor(office).insurance.requirementSet({ customerRef: cust, requirements: [{ coverageType: "commercial_auto", minimumLimit: 2_000_000, additionalInsuredRequired: true }, { coverageType: "pollution_environmental", minimumLimit: 1_000_000 }] });
    const match = await callerFor(office).insurance.requirementMatch({ financialEntityId: entityId, customerRef: cust });
    expect(match.matches.map(m => m.outcome)).toEqual(["match", "gap"]);
    expect(match.readinessPercent).toBe(50);
    const coi = await callerFor(office).insurance.certificateIssue({ policyRef: pol.policyRef, recipientCustomerRef: cust, additionalInsuredNamed: true });
    expect(coi.certificateRef).toMatch(/^COI-/);
    const cal = await callerFor(office).insurance.renewalCalendar({ financialEntityId: entityId });
    expect(cal.calendar.find(c => c.policyRef === pol.policyRef)?.certificatesToReissue).toEqual([cust]);

    // A collision. The incident's original statement is untouched; the claim links to it.
    const stmt = "Hit black ice on the 63 north of Wandering River. Rolled onto the shoulder. I am not hurt.";
    const [inc] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO incidentReports (incidentNumber, incidentType, severity, unitId, occurredAt, reportedAt, originalStatement, originalStatementSource, status) VALUES (?, 'collision', 'critical', ?, ?, ?, ?, 'typed', 'open')",
      [key("INC").slice(0, 40), unitIds[0], days(-3), days(-3), stmt]
    );
    const claim = await callerFor(office).insurance.claimOpen({ policyRef: pol.policyRef, incidentReportId: Number(inc.insertId), unitId: unitIds[0], lossOccurredAt: days(-3), claimType: "collision", estimatedLoss: 40000 });
    expect(claim.incidentStatementPreserved).toBe(true);
    expect(claim.deductible).toBe(5000);
    // A loss before the policy period is refused.
    await expect(callerFor(office).insurance.claimOpen({ policyRef: pol.policyRef, lossOccurredAt: days(-500), claimType: "collision" })).rejects.toThrow(/outside the policy period/);

    // Office cannot record money; the bookkeeper can.
    await expect(callerFor(office).insurance.claimCostRecord({ claimRef: claim.claimRef, costType: "repair", amount: 31000, incurredAt: days(-1) })).rejects.toBeTruthy();
    for (const [t, a] of [["tow", 2400], ["repair", 31000], ["rental_replacement", 5000], ["cleanup", 1800]] as const) {
      await callerFor(bookkeeper).insurance.claimCostRecord({ claimRef: claim.claimRef, costType: t, amount: a, incurredAt: days(-1) });
    }
    await callerFor(bookkeeper).insurance.claimRecoveryRecord({ claimRef: claim.claimRef, recoveryType: "approved", amount: 32500 });
    const fin1 = await callerFor(bookkeeper).insurance.claimFinancials({ claimRef: claim.claimRef });
    expect(fin1.grossLoss).toBe(40200);
    expect(fin1.receivableOutstanding).toBe(32500);
    expect(fin1.unrecovered).toBe(7700);
    expect(fin1.status).toBe("approved");
    await callerFor(bookkeeper).insurance.claimRecoveryRecord({ claimRef: claim.claimRef, recoveryType: "received", amount: 32500, reference: "EFT-8832" });
    const fin2 = await callerFor(bookkeeper).insurance.claimFinancials({ claimRef: claim.claimRef });
    expect(fin2.receivableOutstanding).toBe(0);
    expect(fin2.grossLoss).toBe(40200); // the repair bill did not go anywhere
    expect(fin2.costs).toHaveLength(4);

    const [incAfter] = await pool.execute<mysql.RowDataPacket[]>("SELECT originalStatement FROM incidentReports WHERE id = ?", [Number(inc.insertId)]);
    expect(incAfter[0].originalStatement).toBe(stmt);
  });

  it("refuses a certificate on unverified coverage", async () => {
    const office = await withRole("office");
    const entityId = 270000 + Math.floor(Math.random() * 90000);
    const pol = await callerFor(office).insurance.policyRecord({ financialEntityId: entityId, policyType: "cargo", insurerName: "Q", policyNumber: key("PN"), effectiveAt: days(-10), expiresAt: days(355), coverages: [{ coverageType: "cargo", limitAmount: 100000 }] });
    await expect(callerFor(office).insurance.certificateIssue({ policyRef: pol.policyRef, recipientCustomerRef: "X" })).rejects.toThrow(/verify the coverage before issuing/);
  });
});

/* ------------------------------------------------------------------ */
/* Promotion review — roadside scope is the P4 allowlist's, not insurance's */
/* ------------------------------------------------------------------ */

import { INSURANCE_ROADSIDE_CATEGORY, roadsideInsuranceItems, assessCoverage as assessCoverageP } from "./_core/insuranceRisk";
import { NEVER_IN_ROADSIDE_PACKAGE, ROADSIDE_PACKAGE_CATEGORIES, roadsidePackagePermits } from "./_core/fieldDevice";

describe("roadside mode is built on the P4 allowlist, not beside it", () => {
  it("uses a category the allowlist names, verbatim", () => {
    expect(ROADSIDE_PACKAGE_CATEGORIES).toContain(INSURANCE_ROADSIDE_CATEGORY);
    expect(roadsidePackagePermits(INSURANCE_ROADSIDE_CATEGORY)).toBe(true);
  });

  it("emits nothing the allowlist forbids — premium and claims_reserve are on the never-list", () => {
    for (const forbidden of ["premium", "claims_reserve"]) expect(NEVER_IN_ROADSIDE_PACKAGE).toContain(forbidden);
    const items = roadsideInsuranceItems([
      { coverageType: "commercial_auto", status: "coverage_verified", policyRef: "POL-1" } as never,
      { coverageType: "cargo", status: "document_missing", policyRef: "POL-1" } as never,
      { coverageType: "umbrella_excess", status: "coverage_verified", policyRef: "POL-2" } as never,
    ]);
    expect(items.every(i => roadsidePackagePermits(i.category))).toBe(true);
    expect(items.map(i => i.coverageType)).toEqual(["commercial_auto", "cargo"]);
    for (const i of items) expect(Object.keys(i)).not.toContain("annualPremium");
  });

  it("is coupled: a category the allowlist does not permit yields nothing", () => {
    // If the allowlist ever stops naming insurance_proof, insurance contributes
    // nothing to the roadside screen rather than contributing anyway.
    expect(roadsideInsuranceItems([])).toEqual([]);
    expect(roadsidePackagePermits("insurance_policy_full")).toBe(false);
  });
});

describe("when the policy and the document disagree, the policy decides first", () => {
  const NOWP = new Date("2026-09-10T12:00:00Z");
  const d = (n: number) => new Date(NOWP.getTime() + n * 86_400_000);
  const pol = (over: Partial<import("./_core/insuranceRisk").PolicyRecord> = {}): import("./_core/insuranceRisk").PolicyRecord => ({
    policyRef: "POL-1", policyType: "commercial_auto", effectiveAt: d(-300), expiresAt: d(65), status: "active",
    coverageVerificationStatus: "coverage_verified", coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000, additionalInsuredEndorsement: true }],
    document: { expiresAt: d(65), verificationStatus: "verified" }, ...over,
  });

  it("calls an expired policy with a perfectly verified current proof card coverage_expired — the card does not resurrect the policy", () => {
    const a = assessCoverageP({ coverageType: "commercial_auto", policies: [pol({ expiresAt: d(-2), document: { expiresAt: d(300), verificationStatus: "verified" } })], now: NOWP });
    expect(a.status).toBe("coverage_expired");
    expect(a.effect).toBe("blocked");
  });

  it("calls a current policy with an expired proof card document_expired — review, the truck is still insured", () => {
    const a = assessCoverageP({ coverageType: "commercial_auto", policies: [pol({ document: { expiresAt: d(-10), verificationStatus: "verified" } })], now: NOWP });
    expect(a.status).toBe("document_expired");
    expect(a.effect).toBe("review");
    expect(a.reason).toContain("refresh the document");
  });

  it("prefers the renewal over the expired predecessor for the same coverage", () => {
    const a = assessCoverageP({ coverageType: "commercial_auto", policies: [pol({ policyRef: "POL-OLD", expiresAt: d(-1), status: "expired" }), pol({ policyRef: "POL-NEW", status: "renewal_pending", expiresAt: d(364) })], now: NOWP });
    expect(a.policyRef).toBe("POL-NEW");
    expect(a.status).toBe("coverage_verified");
  });

  it("holds coverage_reported when the insurer has not confirmed, even with a verified card", () => {
    const a = assessCoverageP({ coverageType: "commercial_auto", policies: [pol({ coverageVerificationStatus: "coverage_reported" })], now: NOWP });
    expect(a.status).toBe("coverage_reported");
    expect(a.effect).toBe("review");
  });
});
