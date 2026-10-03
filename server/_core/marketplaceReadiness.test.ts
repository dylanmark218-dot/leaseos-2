/**
 * The verified readiness evaluator, without a database.
 *
 * Facts arrive already read from the registries; what is pinned here is the verdict each shape of
 * fact produces, that unknown hard requirements fail closed, that warnings never block, that the
 * rows never carry a name, that the fingerprint moves with the facts and with a lapsed expiry and
 * not with the clock, and that the client's projection withholds the detail.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_TENDER_REQUIREMENTS,
  NOT_EVALUATED_BY_MARKETPLACE,
  TDG_QUALIFICATION_CODE,
  clientReadinessProjection,
  evaluateMarketplaceReadiness,
  normalizeTenderRequirements,
  readinessFingerprint,
  workerStanding,
  type MarketplaceReadinessFacts,
  type WorkerQualificationStanding,
} from "./marketplaceReadiness";
import { proofFromDocuments, type PolicyRecord } from "./insuranceRisk";

const NOW = new Date("2026-10-02T12:00:00Z");
const d = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

/** A standing as `qualificationReads.effectiveQualifications` returns it; held by default. */
const holding = (code: string, over: Partial<WorkerQualificationStanding> = {}): WorkerQualificationStanding => ({
  code, held: true, notHeld: null, state: "in_force", source: "ACADEMY_QUALIFICATION", sourceRef: `AQ-${code}-${Math.random().toString(36).slice(2, 6)}`, expiresAt: d(300), ...over,
});
/** Proof of cover as production builds it: the canonical verdict on a verified, in-force insurance_proof row. */
const verifiedProof = proofFromDocuments([{ id: 1, docType: "insurance_proof", title: "insurance_proof", issuedAt: d(-30), expiresAt: d(300), verificationStatus: "verified", capturedAt: d(-30) }], NOW);
const policy = (limit: number | null, over: Partial<PolicyRecord> = {}): PolicyRecord => ({
  policyRef: "POL-1", policyType: "general_liability", effectiveAt: d(-60), expiresAt: d(300), status: "active", coverageVerificationStatus: "coverage_verified",
  coverages: [{ coverageType: "general_liability", limitAmount: limit, additionalInsuredEndorsement: false }], document: verifiedProof, ...over,
});
const doc = (docType: string, over: Partial<MarketplaceReadinessFacts["carrierDocuments"][number]> = {}) => ({
  id: Math.floor(Math.random() * 1e6), docType, title: docType, issuedAt: d(-30), expiresAt: d(365), verificationStatus: "verified" as const, capturedAt: d(-30), ...over,
});

const REQ = normalizeTenderRequirements({ workerQualificationCodes: ["H2S_ALIVE"], tdgRequired: true, organizationDocTypes: ["wcb_clearance"], insurance: { coverageType: "general_liability", minimumLimitCents: 500_000_000, additionalInsuredRequired: false }, equipmentClasses: ["TRI_DRIVE_VAC"] });

const compliant = (over: Partial<MarketplaceReadinessFacts> = {}): MarketplaceReadinessFacts => ({
  stage: "submission",
  bidderOrgRef: "ORG-BIDDER", clientOrgRef: "ORG-CLIENT",
  organizationStatus: "active", contractorProfileStatus: "active", distribution: "public", invited: false,
  window: { open: true, closesAt: null, remainingMs: null },
  unitsRequired: 4, unitsOffered: 4,
  requirements: REQ,
  financialEntityIds: [11],
  carrierDocuments: [doc("wcb_clearance")],
  policies: [policy(5_000_000)],
  units: [1, 2, 3, 4].map(unitId => ({ unitId, vehicleType: "TRI_DRIVE_VAC", inspectionStatus: "current" as const, maintenanceStatus: "clear" as const })),
  workers: [101, 102, 103, 104].map(userId => ({ userId, qualifications: [holding("H2S_ALIVE"), holding(TDG_QUALIFICATION_CODE)] })),
  unlinkedWorkers: 0,
  activeCarrierOutOfServiceOrders: 0,
  ...over,
});

const check = (r: ReturnType<typeof evaluateMarketplaceReadiness>, name: string) => r.checks.find(c => c.check === name)!;

describe("tender requirements are typed and read the checkpoint-1 spellings", () => {
  it("maps certifications, permits, dangerous goods, a liability minimum and equipment types onto the typed shape", () => {
    const r = normalizeTenderRequirements({ certifications: ["tdg", "H2S"], permits: ["Overdimension_Permit"], dangerousGoods: ["CLASS_3"], insuranceLiabilityMinimumCents: 500_000_000, equipmentTypes: ["tri_drive_vac"] });
    expect(r).toEqual({
      workerQualificationCodes: ["H2S", "TDG", TDG_QUALIFICATION_CODE],
      organizationDocTypes: ["overdimension_permit"],
      tdgRequired: true,
      insurance: { coverageType: "general_liability", minimumLimitCents: 500_000_000, additionalInsuredRequired: false },
      equipmentClasses: ["TRI_DRIVE_VAC"],
      jurisdiction: null,
      clientSpecific: [],
    });
    expect(normalizeTenderRequirements({})).toEqual(EMPTY_TENDER_REQUIREMENTS);
    expect(normalizeTenderRequirements(null)).toEqual(EMPTY_TENDER_REQUIREMENTS);
    expect(normalizeTenderRequirements({ tdgRequired: true }).workerQualificationCodes).toEqual([TDG_QUALIFICATION_CODE]);
  });
});

describe("a compliant bidder", () => {
  it("is submittable with every hard row PASS and the dispatch gate's questions listed as not evaluated", () => {
    const r = evaluateMarketplaceReadiness(compliant(), NOW);
    expect(r.verdict).toBe("submittable");
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
    for (const name of ["counterparty", "organization", "contractor_profile", "invitation", "bidding_window", "carrier_enforcement", "organization_document:wcb_clearance", "insurance", "equipment", "worker_qualifications", "dangerous_goods", "units_offered"]) {
      expect(check(r, name).result, name).toBe("PASS");
    }
    expect(r.notEvaluated).toEqual(NOT_EVALUATED_BY_MARKETPLACE);
    expect(r.notEvaluated.map(n => n.capability)).toContain("hos");
    expect(r.basis).toBe("canonical_registries");
    expect(r.dependencyFingerprint).toMatch(/^MR-[0-9a-f]{64}$/);
  });

  it("carries counts and never a name or an identifier", () => {
    const r = evaluateMarketplaceReadiness(compliant({ unitsRequired: 1, unitsOffered: 1, workers: [{ userId: 777_001, qualifications: [holding("H2S_ALIVE", { sourceRef: "HLD-SECRET-REF" }), holding(TDG_QUALIFICATION_CODE)] }] }), NOW);
    const text = JSON.stringify(r.checks);
    expect(text).not.toContain("777001");
    expect(text).not.toContain("HLD-SECRET-REF");
    expect(check(r, "worker_qualifications").detail).toMatch(/1 worker\(s\) hold every required qualification/);
  });
});

describe("hard requirements fail closed", () => {
  it("blocks when no worker holds a required qualification, and names the gap by code and count", () => {
    const r = evaluateMarketplaceReadiness(compliant({ workers: [{ userId: 1, qualifications: [holding(TDG_QUALIFICATION_CODE)] }] }), NOW);
    expect(r.verdict).toBe("blocked");
    expect(check(r, "worker_qualifications")).toMatchObject({ result: "BLOCK", blocking: true });
    expect(check(r, "worker_qualifications").detail).toMatch(/H2S_ALIVE: 0\/1/);
  });

  it("counts only what the adapter called held: unverified, rejected, unknown, expired and not-yet-effective never become held", () => {
    const only = (h: WorkerQualificationStanding) => compliant({ workers: [{ userId: 1, qualifications: [h, holding("H2S_ALIVE")] }] });
    for (const bad of [
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "unverified", state: "unverified" }),
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "rejected", state: "rejected" }),
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "unknown", state: "incomplete", expiresAt: null }),
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "expired", state: "expired", expiresAt: d(-1) }),
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "unverified", state: "not_yet_effective" }),
      holding(TDG_QUALIFICATION_CODE, { held: false, notHeld: "unknown", state: "none", source: null, sourceRef: null, expiresAt: null }),
    ]) {
      const r = evaluateMarketplaceReadiness(only(bad), NOW);
      expect(r.verdict, bad.state).toBe("blocked");
      expect(check(r, "dangerous_goods").result).toBe("BLOCK");
      // The adapter's not-held code is carried through, counted, not recomputed.
      expect(check(r, "worker_qualifications").detail, bad.state).toContain(`${TDG_QUALIFICATION_CODE}: 0/1 [not held: ${bad.notHeld} 1]`);
    }
  });

  it("fails closed on a code the adapter did not answer, and on a not-held answer with no code", () => {
    expect(workerStanding({ userId: 1, qualifications: [] }, "H2S_ALIVE")).toEqual({ held: false, notHeld: "unknown" });
    expect(workerStanding({ userId: 1, qualifications: [holding("H2S_ALIVE", { held: false, notHeld: null })] }, "H2S_ALIVE")).toEqual({ held: false, notHeld: "unknown" });
    const r = evaluateMarketplaceReadiness(compliant({ workers: [{ userId: 1, qualifications: [holding("H2S_ALIVE")] }] }), NOW);
    expect(check(r, "dangerous_goods").result).toBe("BLOCK");
    expect(check(r, "worker_qualifications").detail).toContain(`${TDG_QUALIFICATION_CODE}: 0/1 [not held: unknown 1]`);
  });

  it("blocks an insurance gap and fails closed on insurance it cannot verify", () => {
    const gap = evaluateMarketplaceReadiness(compliant({ policies: [policy(2_000_000)] }), NOW);
    expect(check(gap, "insurance")).toMatchObject({ result: "BLOCK", blocking: true });
    expect(check(gap, "insurance").detail).toMatch(/requires 5000000; policy limit is 2000000/);
    const reported = evaluateMarketplaceReadiness(compliant({ policies: [policy(5_000_000, { coverageVerificationStatus: "coverage_reported" })] }), NOW);
    expect(check(reported, "insurance")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(reported.verdict).toBe("blocked");
    // No proof document on file: the engine's "document missing" is UNKNOWN here — verification unavailable, fail closed.
    const noProof = evaluateMarketplaceReadiness(compliant({ policies: [policy(5_000_000, { document: null })] }), NOW);
    expect(check(noProof, "insurance")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(check(noProof, "insurance").detail).toMatch(/no proof document on file/);
    const noLimit = evaluateMarketplaceReadiness(compliant({ policies: [policy(null)] }), NOW);
    expect(check(noLimit, "insurance")).toMatchObject({ result: "UNKNOWN", blocking: true });
    const expired = evaluateMarketplaceReadiness(compliant({ policies: [policy(5_000_000, { expiresAt: d(-1) })] }), NOW);
    expect(check(expired, "insurance").result).toBe("BLOCK");
    const none = evaluateMarketplaceReadiness(compliant({ policies: [] }), NOW);
    expect(check(none, "insurance").result).toBe("BLOCK");
  });

  it("fails closed when the organization has no financial entity, because its carrier credentials and policies cannot be located", () => {
    const r = evaluateMarketplaceReadiness(compliant({ financialEntityIds: [], carrierDocuments: [], policies: [] }), NOW);
    expect(check(r, "insurance")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(check(r, "organization_documents")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(r.verdict).toBe("blocked");
  });

  it("reads carrier documents by the document engine's rule: in force, expiring, expired, rejected, unverified, none", () => {
    const states: Array<[Partial<MarketplaceReadinessFacts["carrierDocuments"][number]>, string, boolean]> = [
      [{}, "PASS", false],
      [{ expiresAt: d(10) }, "WARN", false],
      [{ expiresAt: d(-1) }, "BLOCK", true],
      [{ verificationStatus: "rejected" }, "BLOCK", true],
      [{ verificationStatus: "needs_review" }, "UNKNOWN", true],
    ];
    for (const [over, result, blocking] of states) {
      const r = evaluateMarketplaceReadiness(compliant({ carrierDocuments: [doc("wcb_clearance", over)] }), NOW);
      expect(check(r, "organization_document:wcb_clearance"), JSON.stringify(over)).toMatchObject({ result, blocking });
    }
    const none = evaluateMarketplaceReadiness(compliant({ carrierDocuments: [] }), NOW);
    expect(check(none, "organization_document:wcb_clearance")).toMatchObject({ result: "BLOCK" });
  });

  it("blocks when no owned unit of the required class is compliant, and counts the ones held back", () => {
    const wrongClass = evaluateMarketplaceReadiness(compliant({ units: [{ unitId: 1, vehicleType: "TANDEM_VAC", inspectionStatus: "current", maintenanceStatus: "clear" }] }), NOW);
    expect(check(wrongClass, "equipment")).toMatchObject({ result: "BLOCK" });
    const allHeld = evaluateMarketplaceReadiness(compliant({ units: [{ unitId: 1, vehicleType: "TRI_DRIVE_VAC", inspectionStatus: "due", maintenanceStatus: "clear" }, { unitId: 2, vehicleType: "tri_drive_vac", inspectionStatus: "current", maintenanceStatus: "blocked" }] }), NOW);
    expect(check(allHeld, "equipment")).toMatchObject({ result: "BLOCK" });
    expect(check(allHeld, "equipment").detail).toMatch(/2 unit\(s\).*none with inspection current and maintenance clear/);
  });

  it("blocks on an active carrier-scope out-of-service order, a suspended organization, a suspended profile, an uninvited bidder, a closed window, and a self-bid", () => {
    expect(evaluateMarketplaceReadiness(compliant({ activeCarrierOutOfServiceOrders: 1 }), NOW).blockers.map(b => b.check)).toEqual(["carrier_enforcement"]);
    expect(evaluateMarketplaceReadiness(compliant({ organizationStatus: "suspended" }), NOW).blockers.map(b => b.check)).toEqual(["organization"]);
    expect(evaluateMarketplaceReadiness(compliant({ organizationStatus: "missing" }), NOW).verdict).toBe("blocked");
    expect(evaluateMarketplaceReadiness(compliant({ contractorProfileStatus: "suspended" }), NOW).blockers.map(b => b.check)).toEqual(["contractor_profile"]);
    expect(evaluateMarketplaceReadiness(compliant({ distribution: "invite_only", invited: false }), NOW).blockers.map(b => b.check)).toEqual(["invitation"]);
    expect(evaluateMarketplaceReadiness(compliant({ distribution: "invite_only", invited: true }), NOW).verdict).toBe("submittable");
    expect(evaluateMarketplaceReadiness(compliant({ window: { open: false, reason: "closed_by_deadline" } }), NOW).blockers.map(b => b.check)).toEqual(["bidding_window"]);
    expect(evaluateMarketplaceReadiness(compliant({ bidderOrgRef: "ORG-CLIENT" }), NOW).blockers.map(b => b.check)).toEqual(["counterparty"]);
  });

  it("fails closed on worker qualifications when the organization has no worker linked to a user", () => {
    const r = evaluateMarketplaceReadiness(compliant({ workers: [], unlinkedWorkers: 3 }), NOW);
    expect(check(r, "worker_qualifications")).toMatchObject({ result: "UNKNOWN", blocking: true });
    expect(check(r, "worker_qualifications").detail).toMatch(/3 unlinked worker\(s\)/);
    expect(check(r, "dangerous_goods").result).toBe("UNKNOWN");
  });
});

describe("warnings stay visible and never block", () => {
  it("warns on fewer compliant units, fewer qualified workers, fewer units offered, a missing profile, an expiring document, unlinked workers, and client-stated requirements", () => {
    const r = evaluateMarketplaceReadiness(compliant({
      contractorProfileStatus: "none",
      units: [{ unitId: 1, vehicleType: "TRI_DRIVE_VAC", inspectionStatus: "current", maintenanceStatus: "clear" }, { unitId: 2, vehicleType: "TRI_DRIVE_VAC", inspectionStatus: "due", maintenanceStatus: "clear" }],
      workers: [{ userId: 1, qualifications: [holding("H2S_ALIVE"), holding(TDG_QUALIFICATION_CODE)] }, { userId: 2, qualifications: [holding("H2S_ALIVE")] }],
      unlinkedWorkers: 1,
      unitsOffered: 3,
      carrierDocuments: [doc("wcb_clearance", { expiresAt: d(5) })],
      requirements: { ...REQ, clientSpecific: ["Crews must attend the client's site orientation"] },
    }), NOW);
    expect(r.verdict).toBe("submittable");
    expect(r.blockers).toEqual([]);
    expect(r.warnings.map(w => w.check).sort()).toEqual(["contractor_profile", "equipment", "organization_document:wcb_clearance", "units_offered", "worker_qualifications", "worker_qualifications:unlinked"].sort());
    const cs = r.checks.find(c => c.check.startsWith("client_requirement:"))!;
    expect(cs).toMatchObject({ result: "UNKNOWN", blocking: false });
    expect(check(r, "equipment").detail).toMatch(/1 of 4 required compliant unit\(s\).*1 more held back/);
  });

  it("passes every requirement row on a tender that requires nothing", () => {
    const r = evaluateMarketplaceReadiness(compliant({ requirements: EMPTY_TENDER_REQUIREMENTS, financialEntityIds: [], carrierDocuments: [], policies: [], units: [], workers: [] }), NOW);
    expect(r.verdict).toBe("submittable");
    for (const name of ["organization_documents", "insurance", "equipment", "worker_qualifications"]) expect(check(r, name).result, name).toBe("PASS");
  });
});

describe("stage", () => {
  it("asks about the bidding window at submission and not for standing readiness, with the same fingerprint either way", () => {
    const closed = compliant({ window: { open: false, reason: "closed_by_client" } });
    expect(evaluateMarketplaceReadiness(closed, NOW).blockers.map(b => b.check)).toEqual(["bidding_window"]);
    const standing = evaluateMarketplaceReadiness({ ...closed, stage: "standing" }, NOW);
    expect(standing.verdict).toBe("submittable");
    expect(standing.checks.some(c => c.check === "bidding_window")).toBe(false);
    expect(standing.dependencyFingerprint).toBe(evaluateMarketplaceReadiness(closed, NOW).dependencyFingerprint);
  });
});

describe("the fingerprint", () => {
  it("is stable across the clock, moves with any fact, and moves when a governing expiry lapses", () => {
    const f = compliant();
    expect(readinessFingerprint(f, NOW)).toBe(readinessFingerprint(f, d(1)));
    expect(readinessFingerprint(f, NOW)).not.toBe(readinessFingerprint(compliant({ policies: [policy(5_000_001)] }), NOW));
    expect(readinessFingerprint(f, NOW)).not.toBe(readinessFingerprint(compliant({ units: f.units.slice(1) }), NOW));
    const lapses = compliant({ policies: [policy(5_000_000, { expiresAt: d(2) })] });
    expect(readinessFingerprint(lapses, NOW)).not.toBe(readinessFingerprint(lapses, d(3)));
    expect(evaluateMarketplaceReadiness(lapses, d(3)).verdict).toBe("blocked");
  });

  it("moves when the adapter's verdict on a worker's qualification changes", () => {
    const f = compliant();
    const changed = compliant({ workers: f.workers.map((w, i) => (i ? w : { ...w, qualifications: w.qualifications.map(q => ({ ...q, held: false, notHeld: "expired" as const, state: "expired" as const })) })) });
    expect(readinessFingerprint(f, NOW)).not.toBe(readinessFingerprint(changed, NOW));
  });
});

describe("the client's projection", () => {
  it("gives eligibility in the client's words, check names and results, counts — and no detail", () => {
    const ok = clientReadinessProjection(evaluateMarketplaceReadiness(compliant(), NOW));
    expect(ok.eligibility).toBe("eligible");
    expect(ok.checks.every(c => !("detail" in c))).toBe(true);
    expect(ok.checks.find(c => c.check === "insurance")).toEqual({ check: "insurance", result: "PASS" });
    const warned = clientReadinessProjection(evaluateMarketplaceReadiness(compliant({ unitsOffered: 2 }), NOW));
    expect(warned).toMatchObject({ eligibility: "eligible_with_warnings", warningCount: 1, blockerCount: 0 });
    const blocked = clientReadinessProjection(evaluateMarketplaceReadiness(compliant({ policies: [] }), NOW));
    expect(blocked).toMatchObject({ eligibility: "not_currently_eligible", blockerCount: 1 });
    expect(JSON.stringify(blocked)).not.toMatch(/policy limit|worker\(s\) hold/);
  });
});
