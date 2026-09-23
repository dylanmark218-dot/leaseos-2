/**
 * C1a — the typed finding contract, pure. The database-backed half is
 * server/complianceReadinessC1a.db.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVED_OVERRIDE_POLICIES, CLASSIFICATION, classifyBlocker, mergeFindings, resolveOverridePolicy, uncoveredFindings,
  type ComplianceFinding, type OverridePolicy,
} from "./complianceFinding";
import type { BlockerSeverity, DispatchBlocker } from "./dispatchReadiness";
import { blockersForUnevaluatedRequired, CAPABILITY } from "./readinessCapabilities";
import { computeEligibilityFingerprint, decideAward, type EligibilityFacts } from "./dispatchAward";
import { dangerousGoodsAuthority, mergeBlockers } from "../readinessComposer";

const AT = new Date("2026-09-23T12:00:00Z");
const blk = (over: Partial<DispatchBlocker> & { code: string }): DispatchBlocker => ({ label: over.code, severity: "blocking", subject: "truck", overridable: false, ...over });
const f = (b: DispatchBlocker) => classifyBlocker(b, AT);

/* ------------------------------------------------------------------ */
/* C1a-1 / D-02 — the classification                                  */
/* ------------------------------------------------------------------ */

describe("D-02: an unknown that could make the trip unauthorized BLOCKS — per finding, not globally", () => {
  const safetyUnknowns = [
    "enforcement_result_unknown", "operator_licence_unknown", "operator_tdg_certificate_unknown", "hos_unknown",
    "truck_inspection_unknown", "trailer_inspection_unknown", "truck_insurance_unknown", "insurance_coverage_unknown",
    "insurance_coverage_unverified", "route_not_evaluated", "route_approval_missing", "permit_unknown",
    "dg_classification_unverified", "dg_classification_missing", "tdg_document_unknown", "medical_fitness_unknown",
    "academy_binding_conditions_unknown", "fault_p0420_active", "capability_not_evaluated_hos",
  ];
  for (const code of safetyUnknowns) {
    it(`${code} — UNKNOWN, BLOCK, never a warning acknowledgement`, () => {
      // Classified from the MOST permissive producer claim possible, to show the rule is the classification's.
      const x = f(blk({ code, severity: "unknown", overridable: true, overrideAuthority: "dispatcher" }));
      expect(x.result).toBe("UNKNOWN");
      expect(x.dispatchEffect).toBe("BLOCK");
      expect(["APPROVED_POLICY_ONLY", "NEVER_OVERRIDABLE"]).toContain(x.overrideClass);
      expect(x.severity).not.toBe("review");
    });
  }

  it("does not make every unknown block: an incomplete communication plan (company policy) warns", () => {
    const x = f(blk({ code: "communication_plan_unknown", severity: "unknown", overridable: true, overrideAuthority: "manager" }));
    expect(x.result).toBe("UNKNOWN");
    expect(x.dispatchEffect).toBe("WARN");
    expect(x.overrideClass).toBe("WARNING_ONLY");
    // …unless the company's own policy made it a blocker at source, which is honoured.
    expect(f(blk({ code: "communication_plan_unknown", severity: "blocking", overridable: true, overrideAuthority: "manager" })).dispatchEffect).toBe("BLOCK");
  });

  it("administrative items warn: availability, documents, destination acceptance, maintenance overdue", () => {
    for (const code of ["availability_not_declared", "documents_missing", "destination_acceptance_unverified", "maintenance_overdue"]) {
      const x = f(blk({ code, severity: "review", overridable: true, overrideAuthority: "manager" }));
      expect(x.dispatchEffect, code).toBe("WARN");
      expect(x.overrideClass, code).toBe("WARNING_ONLY");
    }
  });

  it("carries the authority: an inspector's order is regulator_order, NEVER_OVERRIDABLE", () => {
    const x = f(blk({ code: "oos.vehicle", overridable: true, overrideAuthority: "administrator" }));
    expect(x.authorityClass).toBe("regulator_order");
    expect(x.overrideClass).toBe("NEVER_OVERRIDABLE");
    expect(x.overridable).toBe(false);
    expect(x.ruleRef.key).toBe("enforcement.oos");
  });

  it("never reads a producer's claim as softer than it was — the classification only tightens", () => {
    const severities: BlockerSeverity[] = ["review", "unknown", "blocking"];
    const rank = { review: 0, unknown: 1, blocking: 2 } as const;
    const codes = ["availability_not_declared", "hos_attested", "communication_plan_unknown", "made_up_code_nobody_classified", "route_review", "hos_unknown"];
    for (const code of codes) for (const severity of severities) for (const overridable of [true, false]) {
      const x = f(blk({ code, severity, overridable, overrideAuthority: "dispatcher" }));
      expect(rank[x.severity], `${code}/${severity}`).toBeGreaterThanOrEqual(rank[severity]);
      if (!overridable) expect(x.overrideClass, `${code}/${severity}`).toBe("NEVER_OVERRIDABLE");
      if (severity === "blocking") expect(x.dispatchEffect, `${code}/${severity}`).toBe("BLOCK");
    }
  });

  it("an unregistered unknown fails closed (BLOCK), it is not treated as a warning", () => {
    const x = f(blk({ code: "some_future_engine_unknown", severity: "unknown", overridable: true }));
    expect(x.dispatchEffect).toBe("BLOCK");
    expect(x.ruleRef.key).toBe("unregistered");
  });

  it("every rule is sound: a BLOCK rule is never warning-grade, and every rule has a key", () => {
    for (const r of CLASSIFICATION) {
      expect(r.key.length).toBeGreaterThan(0);
      if (r.dispatchEffect === "BLOCK") expect(["APPROVED_POLICY_ONLY", "NEVER_OVERRIDABLE"]).toContain(r.overrideClass);
    }
  });
});

/* ------------------------------------------------------------------ */
/* C1a-4 — strictest duplicate wins, whatever the order                */
/* ------------------------------------------------------------------ */

describe("strictest duplicate wins, independent of arrival order", () => {
  const soft = { ...f(blk({ code: "route_approval_stale", severity: "unknown", overridable: true, overrideAuthority: "manager" })), evidenceRefs: ["A"] };
  const hard = { ...f(blk({ code: "route_approval_stale", severity: "blocking", overridable: false })), evidenceRefs: ["B"] };

  it("keeps the NEVER_OVERRIDABLE duplicate over an overridable one — first-seen no longer wins", () => {
    for (const merged of [mergeFindings([soft, hard]), mergeFindings([hard, soft])]) {
      expect(merged).toHaveLength(1);
      expect(merged[0].overrideClass).toBe("NEVER_OVERRIDABLE");
      expect(merged[0].severity).toBe("blocking");
      expect(merged[0].evidenceRefs).toEqual(["A", "B"]); // evidence of both is kept
    }
  });

  it("merge(A, B) and merge(B, A) have the same effective safety outcome, for every pair", () => {
    const pool: ComplianceFinding[] = [
      f(blk({ code: "x", severity: "review", overridable: true, overrideAuthority: "dispatcher" })),
      f(blk({ code: "x", severity: "unknown", overridable: true })),
      f(blk({ code: "x", severity: "blocking", overridable: true })),
      f(blk({ code: "x", severity: "blocking", overridable: false })),
      f(blk({ code: "x", severity: "blocking", overridable: false, label: "other text" })),
    ];
    const key = (m: ComplianceFinding[]) => m.map(x => [x.code, x.dispatchEffect, x.overrideClass, x.severity, x.result, x.label].join("|")).join(";");
    for (const a of pool) for (const b of pool) expect(key(mergeFindings([a, b]))).toBe(key(mergeFindings([b, a])));
  });

  it("through the composer's merge too: the verdict does not depend on which engine spoke first", () => {
    const base = { verdict: "eligible" as const, blockers: [], evaluatedAt: AT, explanation: "" };
    const a = blk({ code: "dup", severity: "review", overridable: true, overrideAuthority: "dispatcher" });
    const b = blk({ code: "dup", severity: "blocking", overridable: false });
    expect(mergeBlockers(base, [a, b]).verdict).toBe("blocked");
    expect(mergeBlockers(base, [b, a]).verdict).toBe("blocked");
  });
});

/* ------------------------------------------------------------------ */
/* C1a-2 — override classes and approved policies                      */
/* ------------------------------------------------------------------ */

describe("override classes: no general manager override", () => {
  const route = f(blk({ code: "route_not_evaluated", severity: "unknown", subject: "route", overridable: true, overrideAuthority: "manager" }));
  const policy: OverridePolicy = { policyRef: "OP-1", version: 1, findingCodes: ["route_not_evaluated"], grantorMinimumRole: "manager", maxValidityMinutes: 60, approvedBy: ["Owner A", "Owner B"], approvedAt: "2026-09-01T00:00:00Z", effectiveFrom: "2026-09-01T00:00:00Z", effectiveUntil: null, rationale: "test" };
  const g = (over: Partial<Parameters<typeof uncoveredFindings>[1][number]> = {}) => ({ blockerCode: "route_not_evaluated", requestedByUserId: 1, grantedByUserId: 2, grantedByRole: "manager", reason: "r", grantedAt: AT, policyRef: null, expiresAt: null, ...over });

  it("ships with no approved override policy: D-02 unknowns are released by establishing the fact", () => {
    expect(APPROVED_OVERRIDE_POLICIES).toEqual([]);
    expect(resolveOverridePolicy("anything", route, AT).ok).toBe(false);
  });

  it("an approved policy must name the code, be in force, and carry two distinct approvers", () => {
    expect(resolveOverridePolicy("OP-1", route, AT, [policy]).ok).toBe(true);
    expect(resolveOverridePolicy("OP-1", route, AT, [{ ...policy, findingCodes: ["hos_unknown"] }]).ok).toBe(false);
    expect(resolveOverridePolicy("OP-1", route, AT, [{ ...policy, effectiveFrom: "2027-01-01T00:00:00Z" }]).ok).toBe(false);
    expect(resolveOverridePolicy("OP-1", route, AT, [{ ...policy, approvedBy: ["Owner A", "Owner A"] }]).ok).toBe(false);
    const oos = f(blk({ code: "oos.vehicle" }));
    expect(resolveOverridePolicy("OP-1", oos, AT, [{ ...policy, findingCodes: ["oos.vehicle"] }]).ok).toBe(false); // NEVER_OVERRIDABLE
  });

  it("a grant by the requester is no grant; an expired grant is no grant", () => {
    expect(uncoveredFindings([route], [g({ policyRef: "OP-1" })], AT, [policy])).toEqual([]);
    expect(uncoveredFindings([route], [g({ policyRef: "OP-1", grantedByUserId: 1 })], AT, [policy])).not.toEqual([]);
    expect(uncoveredFindings([route], [g({ policyRef: "OP-1", expiresAt: new Date(AT.getTime() - 1) })], AT, [policy])).not.toEqual([]);
  });

  it("19. a safety-critical UNKNOWN can never become green: not merged away, not awarded, not acknowledged", () => {
    const base = { verdict: "eligible" as const, blockers: [], evaluatedAt: AT, explanation: "" };
    const merged = mergeBlockers(base, [blk({ code: "hos_unknown", severity: "unknown", overridable: true, overrideAuthority: "dispatcher" })]);
    expect(merged.verdict).toBe("unknown");
    const d = decideAward({
      postingState: "direct", bidState: null, at: AT,
      eligibility: { ...merged, checkId: 1, fingerprint: "EF2-x", operatorId: 1 },
      validity: { valid: true, ageMinutes: 1, reason: "fresh", requiresReEvaluation: false, invalidatedBy: "none" },
      conflicts: [], grantedOverrides: [{ ...g(), blockerCode: "hos_unknown", grantedByRole: "administrator" }],
    });
    expect(d.permitted).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* C1a-5 — the capability blocker, typed                               */
/* ------------------------------------------------------------------ */

describe("9. an unevaluated required capability no longer relies on a cast", () => {
  it("returns a real DispatchBlocker with no stray fields, and classifies as blocking-grade", () => {
    const [b] = blockersForUnevaluatedRequired(
      { status: "UNKNOWN", missingRequired: [CAPABILITY.hos], failedRequired: [], unknownRequired: [], explanation: "" } as never,
      { [CAPABILITY.hos]: { evaluated: false, reason: "module_disabled", detail: "x" } } as never,
    );
    expect(Object.keys(b).sort()).toEqual(["code", "label", "overridable", "severity", "subject"]);
    expect("minimumRole" in b).toBe(false);
    expect(b.subject).toBe("operator");
    const x = f(b);
    expect(x.dispatchEffect).toBe("BLOCK");
    expect(x.overrideClass).toBe("APPROVED_POLICY_ONLY");
    const [enf] = blockersForUnevaluatedRequired(
      { status: "UNKNOWN", missingRequired: [CAPABILITY.enforcementOrders], failedRequired: [], unknownRequired: [], explanation: "" } as never, {} as never,
    );
    expect(f(enf).overrideClass).toBe("NEVER_OVERRIDABLE");
  });

  it("the source carries no `as DispatchBlocker` cast and no minimumRole field", () => {
    const src = readFileSync("server/_core/readinessCapabilities.ts", "utf8");
    expect(src).not.toMatch(/as DispatchBlocker\b/);
    expect(src).not.toMatch(/minimumRole:/);
  });
});

/* ------------------------------------------------------------------ */
/* C1a-7 — dangerous goods from structure, never from text            */
/* ------------------------------------------------------------------ */

describe("dangerous goods: structured authority only", () => {
  const load = (over: Partial<Parameters<typeof dangerousGoodsAuthority>[0][number]> = {}) => ({ id: 1, unNumber: null, dgClass: null, packingGroup: null, classificationStatus: "verified" as const, verifiedAt: AT, ...over });

  it("10. free text cannot establish compliance: 'hazard' in the job type over verified non-DG loads is not DG", () => {
    expect(dangerousGoodsAuthority([load()], true).state).toBe("not_dg");
  });
  it("10. free text cannot establish DG either: a verified UN load is DG whatever the job is called", () => {
    const a = dangerousGoodsAuthority([load({ unNumber: "UN1203", dgClass: "3" })], false);
    expect(a.state).toBe("dg");
    expect(a.blockers).toEqual([]);
  });
  it("11. a load whose classification is not verified is UNKNOWN, and blocks", () => {
    const a = dangerousGoodsAuthority([load({ classificationStatus: "needs_verification", unNumber: "UN1203" })], false);
    expect(a.state).toBe("unknown");
    expect(f(a.blockers[0]).dispatchEffect).toBe("BLOCK");
  });
  it("11. no load recorded but the job suggests DG — classification missing, UNKNOWN", () => {
    const a = dangerousGoodsAuthority([], true);
    expect(a.state).toBe("unknown");
    expect(a.blockers[0].code).toBe("dg_classification_missing");
  });
  it("no load and no signal at all — not applicable, and says so", () => {
    expect(dangerousGoodsAuthority([], false)).toMatchObject({ state: "not_applicable", blockers: [] });
  });
  it("a refused classification blocks, non-overridably", () => {
    const a = dangerousGoodsAuthority([load({ classificationStatus: "blocked" })], false);
    expect(f(a.blockers[0]).overrideClass).toBe("NEVER_OVERRIDABLE");
  });
});

/* ------------------------------------------------------------------ */
/* C1a-6 — the fingerprint                                             */
/* ------------------------------------------------------------------ */

describe("the readiness fingerprint: canonical SHA-256 over every governing fact", () => {
  const FACTS: EligibilityFacts = {
    operatorId: 1, operatorCredentialVersion: "a", hoursAvailableMinutes: null, unitId: 2, unitStatusVersion: "b", criticalDefectCount: 0,
    mechanicReleaseVersion: "c", trailerId: null, trailerStatusVersion: "none", jobClassificationVersion: "d", materialClassificationVersion: "m",
    permitVersion: "none", destinationAcceptanceVersion: "x", routeProfileId: null, routeDecisionVersion: "not_evaluated", communicationPlanVersion: "none",
    unitCredentialVersion: "u", insuranceVersion: "i", enforcementVersion: "e", roadsideVersion: "r", telematicsFaultVersion: "t",
    calibrationVersion: "c", medicalVersion: "m", hosVersion: "h", deviceVersion: "d", ruleSetHash: "rs", policyVersion: "pv", expiryStateVersion: "es",
  };
  it("is SHA-256 with a version prefix, and independent of key order", () => {
    const fp = computeEligibilityFingerprint(FACTS);
    expect(fp).toMatch(/^EF2-[0-9a-f]{64}$/);
    const reversed = Object.fromEntries(Object.entries(FACTS).reverse()) as EligibilityFacts;
    expect(computeEligibilityFingerprint(reversed)).toBe(fp);
  });
  it("moves when any governing fact moves", () => {
    const fp = computeEligibilityFingerprint(FACTS);
    for (const k of Object.keys(FACTS) as (keyof EligibilityFacts)[]) {
      if (typeof FACTS[k] !== "string") continue;
      expect(computeEligibilityFingerprint({ ...FACTS, [k]: `${FACTS[k]}-changed` }), k).not.toBe(fp);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Review findings on the C1a PR                                        */
/* ------------------------------------------------------------------ */

describe("review fixes", () => {
  it("a lone worker with no recorded satellite device blocks — never easier to release than the confirmed-absent case", () => {
    const unknown = f(blk({ code: "lone_worker_satellite_unknown", severity: "unknown", overridable: true, overrideAuthority: "manager" }));
    const absent = f(blk({ code: "lone_worker_no_satellite", severity: "blocking", overridable: true, overrideAuthority: "manager" }));
    expect(unknown.dispatchEffect).toBe("BLOCK");
    expect(unknown.overrideClass).toBe("APPROVED_POLICY_ONLY");
    expect(absent.overrideClass).toBe("APPROVED_POLICY_ONLY");
  });

  it("strictest wins on the authority an acknowledgement needs too, whichever duplicate arrived first", () => {
    const byDispatcher = f(blk({ code: "dup", label: "same", severity: "review", overridable: true, overrideAuthority: "dispatcher" }));
    const byManager = f(blk({ code: "dup", label: "same", severity: "review", overridable: true, overrideAuthority: "manager" }));
    expect(mergeFindings([byDispatcher, byManager])[0].overrideAuthority).toBe("manager");
    expect(mergeFindings([byManager, byDispatcher])[0].overrideAuthority).toBe("manager");
    const truck = f(blk({ code: "dup2", label: "same", subject: "truck" }));
    const job = f(blk({ code: "dup2", label: "same", subject: "job" }));
    expect(mergeFindings([truck, job])[0].subject).toBe(mergeFindings([job, truck])[0].subject);
  });

  it("an approved-policy grant is re-checked against the policy in force at award, and needs two named approvers", () => {
    const route = f(blk({ code: "route_not_evaluated", severity: "unknown", overridable: true }));
    const base: OverridePolicy = { policyRef: "OP-2", version: 2, findingCodes: ["route_not_evaluated"], grantorMinimumRole: "administrator", maxValidityMinutes: 60, approvedBy: ["Owner A", "Owner B"], approvedAt: "2026-09-01T00:00:00Z", effectiveFrom: "2026-09-01T00:00:00Z", effectiveUntil: null, rationale: "t" };
    const grant = { blockerCode: "route_not_evaluated", requestedByUserId: 1, grantedByUserId: 2, grantedByRole: "manager", reason: "r", grantedAt: AT, policyRef: "OP-2", expiresAt: null };
    expect(uncoveredFindings([route], [grant], AT, [base])).not.toEqual([]); // manager grant, policy now needs administrator
    expect(uncoveredFindings([route], [{ ...grant, grantedByRole: "administrator" }], AT, [base])).toEqual([]);
    expect(resolveOverridePolicy("OP-2", route, AT, [{ ...base, approvedBy: ["Owner A", " "] }]).ok).toBe(false);
  });
});
