/**
 * v22.20 — tests 21 and 22, plus the policy that decides test 11.
 */
import { describe, expect, it } from "vitest";
import {
  localRestriction, onAuthoritativeOrderState, onSynchronized, reconcileCaptureAuthorization,
  type CaptureAuthorizationClaim, type LocalSafetyLatch,
} from "../client/src/runtime/safetyLatch";
import {
  mayRecordFinding, mayRelease, policyInForce, satisfiesIssuingCondition,
  selectPolicyForScope, type FindingType, type OosReleasePolicy, type ScopedPolicy,
} from "./_core/oosReleasePolicy";

const latch = (o: Partial<LocalSafetyLatch> = {}): LocalSafetyLatch => ({
  latchRef: "L-1", subjectType: "vehicle", subjectRef: "UNIT-127", source: "confirmed_oos_capture",
  capturedAt: "2026-09-11T08:42:00Z", captureLocalId: "cap-1", state: "blocking",
  serverEventRef: null, serverOrderRef: null, synchronized: false, liftedBecause: null, liftedAt: null, ...o,
});

describe("21 — the device blocks before the server hears about it", () => {
  it("prohibits from an unsynchronized capture alone", () => {
    const r = localRestriction([latch()], "vehicle", "UNIT-127");
    expect(r.state).toBe("prohibited");
    if (r.state !== "prohibited") return;
    expect(r.synchronized).toBe(false);
    expect(r.reason).toContain("not yet synchronized. Do not move.");
  });

  it("prohibits only the subject it names", () => {
    expect(localRestriction([latch()], "driver", "D-221").state).toBe("clear");
    expect(localRestriction([latch()], "vehicle", "UNIT-999").state).toBe("clear");
  });

  it("SYNCHRONIZING DOES NOT LIFT IT — it only adds server identity", () => {
    const synced = onSynchronized(latch(), { eventRef: "ENF-1", orderRef: "OOS-1" });
    expect(synced.state).toBe("blocking");
    expect(synced).toMatchObject({ synchronized: true, serverEventRef: "ENF-1", serverOrderRef: "OOS-1" });
    const r = localRestriction([synced], "vehicle", "UNIT-127");
    expect(r.state).toBe("prohibited");
    if (r.state !== "prohibited") return;
    expect(r.synchronized).toBe(true);
  });

  it("lifts only on an authoritative released or rescinded state, and only for its own order", () => {
    const synced = onSynchronized(latch(), { eventRef: "ENF-1", orderRef: "OOS-1" });
    const at = "2026-09-11T14:01:00Z";

    expect(onAuthoritativeOrderState(synced, { orderRef: "OOS-1", status: "active" }, at).state).toBe("blocking");
    expect(onAuthoritativeOrderState(synced, { orderRef: "OOS-OTHER", status: "released" }, at).state).toBe("blocking");

    const released = onAuthoritativeOrderState(synced, { orderRef: "OOS-1", status: "released" }, at);
    expect(released).toMatchObject({ state: "lifted", liftedBecause: "released", liftedAt: at });
    expect(localRestriction([released], "vehicle", "UNIT-127").state).toBe("clear");

    const rescinded = onAuthoritativeOrderState(synced, { orderRef: "OOS-1", status: "rescinded" }, at);
    expect(rescinded.liftedBecause).toBe("rescinded");
  });

  it("cannot be lifted before it has a server order to be lifted by", () => {
    // An unsynchronized latch has no serverOrderRef, so no order state matches it.
    expect(onAuthoritativeOrderState(latch(), { orderRef: "OOS-1", status: "released" }, "2026-09-11T14:01:00Z").state).toBe("blocking");
  });
});

describe("22 — capture authorization is history, not current state", () => {
  const claims: CaptureAuthorizationClaim[] = ["authorized", "unauthorized", "unknown"];
  it("returns exactly what was captured, for every claim and every sync outcome", () => {
    for (const claim of claims) {
      for (const succeeded of [true, false]) {
        expect(reconcileCaptureAuthorization(claim, succeeded)).toBe(claim);
      }
    }
  });

  it("never turns an unauthorized capture into an authorized one because the upload worked", () => {
    expect(reconcileCaptureAuthorization("unauthorized", true)).toBe("unauthorized");
    expect(reconcileCaptureAuthorization("unknown", true)).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */

const ROLES: Record<FindingType, readonly string[]> = {
  repair_verification: ["mechanic", "shop_lead"],
  reinspection: ["safety", "management"],
  inspector_release: ["safety"],
  document_confirmation: ["office", "safety"],
  waiting_period_complete: ["safety", "dispatcher"],
  other: ["management"],
};
const policy = (o: Partial<OosReleasePolicy> = {}): OosReleasePolicy => ({
  policyRef: "POL-OOS", version: 3, effectiveFrom: new Date("2026-01-01"), effectiveTo: null,
  repairerMayRecordRepairVerification: true, releaserMustDifferFromRepairer: true,
  releaserMustDifferFromFindingAuthor: false, allowedFindingRoles: ROLES,
  approvedByUserId: 2, approvedAt: new Date("2026-01-01"), ...o,
});

describe("11 — separation of duties is policy, and the policy is versioned", () => {
  it("answers with the policy in force on the day, not today's", () => {
    const old = policy({ version: 1, effectiveFrom: new Date("2025-01-01"), effectiveTo: new Date("2026-01-01"), repairerMayRecordRepairVerification: false });
    const current = policy();
    expect(policyInForce([old, current], new Date("2025-06-01"))!.version).toBe(1);
    expect(policyInForce([old, current], new Date("2026-09-11"))!.version).toBe(3);
    expect(policyInForce([old, current], new Date("2024-01-01"))).toBeNull();
  });

  it("lets a lone mechanic verify their own repair where the company permits it, and refuses where it does not", () => {
    const permissive = mayRecordFinding({ policy: policy({ repairerMayRecordRepairVerification: true }), findingType: "repair_verification", role: "mechanic", userId: 5, repairedByUserIds: [5] });
    expect(permissive.allowed).toBe(true);

    const strict = mayRecordFinding({ policy: policy({ repairerMayRecordRepairVerification: false }), findingType: "repair_verification", role: "mechanic", userId: 5, repairedByUserIds: [5] });
    expect(strict.allowed).toBe(false);
    expect(strict.reason).toContain("other than the repairing technician");
  });

  it("never lets the repairing technician record an independent act, whatever the policy says", () => {
    const r = mayRecordFinding({ policy: policy({ repairerMayRecordRepairVerification: true, allowedFindingRoles: { ...ROLES, reinspection: ["mechanic", "safety"] } }), findingType: "reinspection", role: "mechanic", userId: 5, repairedByUserIds: [5] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("that is an independent act");
  });

  it("refuses a role the policy does not permit for that finding type, and refuses everything with no policy", () => {
    expect(mayRecordFinding({ policy: policy(), findingType: "inspector_release", role: "mechanic", userId: 9, repairedByUserIds: [] }).allowed).toBe(false);
    expect(mayRecordFinding({ policy: null, findingType: "repair_verification", role: "shop_lead", userId: 9, repairedByUserIds: [] }).reason).toContain("until one is approved");
  });

  it("holds the releaser apart from the repairer and, where configured, from the finding author", () => {
    expect(mayRelease({ policy: policy(), releaserUserId: 5, repairedByUserIds: [5], findingAuthorUserIds: [8] }).allowed).toBe(false);
    expect(mayRelease({ policy: policy(), releaserUserId: 7, repairedByUserIds: [5], findingAuthorUserIds: [8] }).allowed).toBe(true);
    expect(mayRelease({ policy: policy({ releaserMustDifferFromFindingAuthor: true }), releaserUserId: 8, repairedByUserIds: [5], findingAuthorUserIds: [8] }).allowed).toBe(false);
  });
});

describe("company policy can strengthen the issuing condition and never weaken it", () => {
  it("refuses a repair verification against an order that requires a reinspection", () => {
    const r = satisfiesIssuingCondition("reinspection", { findingType: "repair_verification", finding: "satisfied" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("can never weaken it");
  });

  it("accepts the act the order actually demands", () => {
    expect(satisfiesIssuingCondition("reinspection", { findingType: "reinspection", finding: "satisfied" }).allowed).toBe(true);
    expect(satisfiesIssuingCondition("inspector_release", { findingType: "inspector_release", finding: "satisfied" }).allowed).toBe(true);
  });

  it("refuses an unsatisfied or unknown finding whatever its type", () => {
    expect(satisfiesIssuingCondition(null, { findingType: "reinspection", finding: "unknown" }).allowed).toBe(false);
    expect(satisfiesIssuingCondition(null, { findingType: "reinspection", finding: "not_satisfied" }).allowed).toBe(false);
  });

  it("accepts any satisfied finding where the order names no specific act", () => {
    expect(satisfiesIssuingCondition(null, { findingType: "repair_verification", finding: "satisfied" }).allowed).toBe(true);
  });
});

describe("the policy an auditor is shown is the one that released the order", () => {
  it("binds policyRef and version at the moment of release rather than leaving them to be reconstructed", () => {
    // Proven against the database in enforcementCommit.test.ts; pinned here as
    // the shape the release must record.
    const bound = { releasePolicyRef: "POL-OOS", releasePolicyVersion: 3 };
    expect(Object.keys(bound).sort()).toEqual(["releasePolicyRef", "releasePolicyVersion"]);
  });

  it("refuses to release at all when no approved policy is in force", () => {
    expect(mayRelease({ policy: null, releaserUserId: 7, repairedByUserIds: [], findingAuthorUserIds: [] }))
      .toMatchObject({ allowed: false });
    expect(mayRelease({ policy: null, releaserUserId: 7, repairedByUserIds: [], findingAuthorUserIds: [] }).reason)
      .toContain("until one is approved");
  });
});

describe("28a–28d — whose policy governs this release", () => {
  const scoped = (o: Partial<ScopedPolicy> & { policyRef: string }): ScopedPolicy => ({
    version: 1, effectiveFrom: new Date("2026-01-01"), effectiveTo: null,
    repairerMayRecordRepairVerification: true, releaserMustDifferFromRepairer: true,
    releaserMustDifferFromFindingAuthor: false, allowedFindingRoles: ROLES,
    approvedByUserId: 2, approvedAt: new Date("2026-01-01"),
    scopeType: "company", scopeRef: null, tenantId: "T-1", ...o,
  });
  const at = new Date("2026-09-11T12:00:00Z");

  it("28a — another branch's higher version cannot govern this one", () => {
    const policies = [
      scoped({ policyRef: "COMPANY", version: 2, scopeType: "company" }),
      scoped({ policyRef: "BRANCH-A", version: 3, scopeType: "branch", scopeRef: "B-A" }),
      scoped({ policyRef: "BRANCH-B", version: 9, scopeType: "branch", scopeRef: "B-B" }),
    ];
    const r = selectPolicyForScope(policies, { tenantId: "T-1", branchId: "B-A", terminalId: null }, at);
    expect(r.policy?.policyRef).toBe("BRANCH-A");
    expect(r.policy?.version).toBe(3);   // not v9
  });

  it("28b — terminal outranks branch, branch outranks company", () => {
    const policies = [
      scoped({ policyRef: "COMPANY", scopeType: "company" }),
      scoped({ policyRef: "BRANCH-A", scopeType: "branch", scopeRef: "B-A" }),
      scoped({ policyRef: "TERM-1", scopeType: "terminal", scopeRef: "TR-1" }),
    ];
    expect(selectPolicyForScope(policies, { tenantId: "T-1", branchId: "B-A", terminalId: "TR-1" }, at).policy?.policyRef).toBe("TERM-1");
    expect(selectPolicyForScope(policies, { tenantId: "T-1", branchId: "B-A", terminalId: null }, at).policy?.policyRef).toBe("BRANCH-A");
    expect(selectPolicyForScope(policies, { tenantId: "T-1", branchId: null, terminalId: null }, at).policy?.policyRef).toBe("COMPANY");
  });

  it("28c — the order's captured scope decides, so a later asset transfer changes nothing", () => {
    const policies = [
      scoped({ policyRef: "BRANCH-A", scopeType: "branch", scopeRef: "B-A" }),
      scoped({ policyRef: "BRANCH-B", scopeType: "branch", scopeRef: "B-B" }),
    ];
    // The stop happened at Branch A. The truck has since moved to Branch B.
    const capturedAtStop = { tenantId: "T-1", branchId: "B-A", terminalId: null };
    expect(selectPolicyForScope(policies, capturedAtStop, at).policy?.policyRef).toBe("BRANCH-A");
  });

  it("28d — two approved policies at the same specificity block the release rather than guessing", () => {
    const policies = [
      scoped({ policyRef: "BRANCH-A1", version: 1, scopeType: "branch", scopeRef: "B-A" }),
      scoped({ policyRef: "BRANCH-A2", version: 7, scopeType: "branch", scopeRef: "B-A" }),
    ];
    const r = selectPolicyForScope(policies, { tenantId: "T-1", branchId: "B-A", terminalId: null }, at);
    expect(r.policy).toBeNull();
    if (r.policy) return;
    expect(r.failure).toBe("ambiguous");
    expect(r.reason).toContain("not something to guess at");
  });

  it("refuses across tenants and with no tenant at all", () => {
    const policies = [scoped({ policyRef: "OTHER-CO", tenantId: "T-9", scopeType: "company" })];
    expect(selectPolicyForScope(policies, { tenantId: "T-1", branchId: null, terminalId: null }, at).policy).toBeNull();
    const noTenant = selectPolicyForScope(policies, { tenantId: null, branchId: null, terminalId: null }, at);
    expect(noTenant.policy).toBeNull();
    if (!noTenant.policy) expect(noTenant.failure).toBe("no_tenant");
  });

  it("ignores a policy outside its effective window even at the right scope", () => {
    const expired = [scoped({ policyRef: "OLD", scopeType: "branch", scopeRef: "B-A", effectiveTo: new Date("2026-06-01") })];
    const r = selectPolicyForScope(expired, { tenantId: "T-1", branchId: "B-A", terminalId: null }, at);
    expect(r.policy).toBeNull();
    if (!r.policy) expect(r.failure).toBe("none_in_scope");
  });
});
