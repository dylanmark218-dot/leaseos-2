import { describe, expect, it } from "vitest";
import {
  assessEligibilityValidity,
  awardIdempotencyKey,
  computeEligibilityFingerprint,
  decideAward,
  validateReassignment,
  type AwardContext,
  type EligibilityFacts,
  type StoredEligibilityCheck,
} from "./dispatchAward";
import type { DispatchBlocker } from "./dispatchReadiness";

const NOW = new Date(Date.UTC(2026, 7, 31, 6, 0));
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const FACTS: EligibilityFacts = {
  operatorId: 47,
  operatorCredentialVersion: "v9",
  hoursAvailableMinutes: 600,
  unitId: 27,
  unitStatusVersion: "v4",
  criticalDefectCount: 0,
  mechanicReleaseVersion: "v1",
  trailerId: null,
  trailerStatusVersion: "v0",
  jobClassificationVersion: "v2",
  materialClassificationVersion: "v2",
  permitVersion: "v1",
  destinationAcceptanceVersion: "v3",
  routeProfileId: "RP-1a2b3c4d",
  routeDecisionVersion: "v1",
};

const eligible = (
  verdict: StoredEligibilityCheck["verdict"] = "eligible",
  blockers: DispatchBlocker[] = [],
  evaluatedAt = minsAgo(5)
): StoredEligibilityCheck => ({
  checkId: 991,
  operatorId: 47,
  verdict,
  blockers,
  evaluatedAt,
  explanation: "",
  fingerprint: computeEligibilityFingerprint(FACTS),
});

const ctx = (over: Partial<AwardContext> = {}): AwardContext => {
  const check = over.eligibility ?? eligible();
  return {
    postingState: "awarding",
    bidState: "submitted",
    eligibility: check,
    validity: assessEligibilityValidity(check, FACTS, NOW),
    conflicts: [],
    grantedOverrides: [],
    ...over,
  };
};

describe("computeEligibilityFingerprint", () => {
  it("is stable for identical facts", () => {
    expect(computeEligibilityFingerprint(FACTS)).toBe(
      computeEligibilityFingerprint({ ...FACTS })
    );
  });

  it("changes when a credential version changes", () => {
    expect(
      computeEligibilityFingerprint({
        ...FACTS,
        operatorCredentialVersion: "v10",
      })
    ).not.toBe(computeEligibilityFingerprint(FACTS));
  });

  it("changes when a critical defect appears", () => {
    expect(
      computeEligibilityFingerprint({ ...FACTS, criticalDefectCount: 1 })
    ).not.toBe(computeEligibilityFingerprint(FACTS));
  });

  it("changes when HOS, permit, destination or route change", () => {
    for (const patch of [
      { hoursAvailableMinutes: 120 },
      { permitVersion: "v2" },
      { destinationAcceptanceVersion: "v4" },
      { routeDecisionVersion: "v2" },
    ] as Partial<EligibilityFacts>[]) {
      expect(computeEligibilityFingerprint({ ...FACTS, ...patch })).not.toBe(
        computeEligibilityFingerprint(FACTS)
      );
    }
  });
});

describe("assessEligibilityValidity — dependency change beats freshness", () => {
  it("accepts a recent check whose dependencies are unchanged", () => {
    const v = assessEligibilityValidity(eligible(), FACTS, NOW);
    expect(v.valid).toBe(true);
    expect(v.invalidatedBy).toBe("none");
  });

  it("invalidates a 5-minute-old check when a defect appeared 4 minutes ago", () => {
    const v = assessEligibilityValidity(
      eligible(),
      { ...FACTS, criticalDefectCount: 1 },
      NOW
    );
    expect(v.valid).toBe(false);
    expect(v.invalidatedBy).toBe("dependency_change");
    expect(v.ageMinutes).toBe(5);
    expect(v.reason).toContain("Underlying facts changed");
  });

  it("invalidates on age even when nothing changed", () => {
    const v = assessEligibilityValidity(
      eligible("eligible", [], minsAgo(90)),
      FACTS,
      NOW
    );
    expect(v.valid).toBe(false);
    expect(v.invalidatedBy).toBe("age");
  });

  it("reports dependency change rather than age when both apply", () => {
    const v = assessEligibilityValidity(
      eligible("eligible", [], minsAgo(90)),
      { ...FACTS, permitVersion: "v2" },
      NOW
    );
    expect(v.invalidatedBy).toBe("dependency_change");
  });
});

describe("decideAward", () => {
  it("permits an award on a fresh, unchanged, eligible check", () => {
    const d = decideAward(ctx());
    expect(d.permitted).toBe(true);
    if (d.permitted) expect(d.eligibilityCheckId).toBe(991);
  });

  it("refuses when eligibility is blocked, naming each blocker", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "truck_inspection_expired",
        label: "Annual inspection expired 2026-08-26",
        severity: "blocking",
        subject: "truck",
        overridable: false,
      },
    ];
    const d = decideAward(ctx({ eligibility: eligible("blocked", blockers) }));
    expect(d.permitted).toBe(false);
    if (!d.permitted)
      expect(d.refusals[0]).toContain("BLOCKED — Annual inspection expired");
  });

  it("refuses on unknown — an accepted bid does not resolve it", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "hos_unknown",
        label: "Operator hours-of-service state has not been reported",
        severity: "unknown",
        subject: "operator",
        overridable: true,
        overrideAuthority: "manager",
      },
    ];
    const d = decideAward(
      ctx({ bidState: "submitted", eligibility: eligible("unknown", blockers) })
    );
    expect(d.permitted).toBe(false);
    if (!d.permitted)
      expect(d.refusals[0]).toContain("UNKNOWN — Operator hours-of-service");
  });

  it("refuses an unresolved review condition with no override", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "destination_acceptance_unverified",
        label: "Destination facility acceptance not verified",
        severity: "review",
        subject: "job",
        overridable: true,
        overrideAuthority: "manager",
      },
    ];
    const d = decideAward(
      ctx({ eligibility: eligible("eligible_review", blockers) })
    );
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals[0]).toContain("REVIEW —");
  });

  it("permits a review condition covered by an authorised override", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "destination_acceptance_unverified",
        label: "Destination facility acceptance not verified",
        severity: "review",
        subject: "job",
        overridable: true,
        overrideAuthority: "manager",
      },
    ];
    const d = decideAward(
      ctx({
        eligibility: eligible("eligible_review", blockers),
        grantedOverrides: [
          {
            blockerCode: "destination_acceptance_unverified",
            grantedByUserId: 8,
            grantedByRole: "manager",
            reason: "Confirmed by phone, ref 88214",
            grantedAt: minsAgo(2),
          },
        ],
      })
    );
    expect(d.permitted).toBe(true);
  });

  it("refuses even a recorded override of a non-overridable blocker", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "critical_defect",
        label: "VAC-27 has an open critical defect",
        severity: "blocking",
        subject: "truck",
        overridable: false,
      },
    ];
    const d = decideAward(
      ctx({
        eligibility: eligible("blocked", blockers),
        grantedOverrides: [
          {
            blockerCode: "critical_defect",
            grantedByUserId: 1,
            grantedByRole: "administrator",
            reason: "Customer waiting",
            grantedAt: minsAgo(1),
          },
        ],
      })
    );
    expect(d.permitted).toBe(false);
    if (!d.permitted) {
      expect(d.refusals.join(" ")).toContain("not permitted for any role");
    }
  });

  it("refuses a withdrawn bid", () => {
    const d = decideAward(ctx({ bidState: "withdrawn" }));
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals).toContain("Bid was withdrawn");
  });

  it("refuses on a cancelled posting", () => {
    const d = decideAward(ctx({ postingState: "cancelled" }));
    expect(d.permitted).toBe(false);
    if (!d.permitted)
      expect(d.refusals[0]).toContain("cannot receive an award");
  });

  it("refuses when the check was invalidated by a dependency change", () => {
    const check = eligible();
    const d = decideAward(
      ctx({
        eligibility: check,
        validity: assessEligibilityValidity(
          check,
          { ...FACTS, criticalDefectCount: 1 },
          NOW
        ),
      })
    );
    expect(d.permitted).toBe(false);
    if (!d.permitted)
      expect(d.refusals.join(" ")).toContain("Underlying facts changed");
  });

  it("refuses on a resource conflict", () => {
    const d = decideAward(
      ctx({
        conflicts: [
          {
            resourceRef: "VAC-27",
            existingJob: "JOB-8841",
            message:
              "VAC-27 is assigned to JOB-8841 until 16:00 and is also proposed for JOB-8850 at 14:00",
          },
        ],
      })
    );
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals[0]).toContain("Resource conflict");
  });

  it("permits a direct assignment with no bid at all", () => {
    const d = decideAward(ctx({ postingState: "direct", bidState: null }));
    expect(d.permitted).toBe(true);
  });

  it("lists every refusal rather than stopping at the first", () => {
    const blockers: DispatchBlocker[] = [
      {
        code: "a",
        label: "Licence expired",
        severity: "blocking",
        subject: "operator",
        overridable: false,
      },
      {
        code: "b",
        label: "Inspection expired",
        severity: "blocking",
        subject: "truck",
        overridable: false,
      },
    ];
    const d = decideAward(
      ctx({
        postingState: "cancelled",
        bidState: "withdrawn",
        eligibility: eligible("blocked", blockers),
      })
    );
    if (!d.permitted) expect(d.refusals.length).toBeGreaterThanOrEqual(4);
  });
});

describe("awardIdempotencyKey", () => {
  const base = {
    postingId: 5,
    roleId: 2,
    operatorId: 47,
    unitId: 27,
    trailerId: null,
    requestedByUserId: 3,
  };

  it("is identical for a replayed request", () => {
    expect(awardIdempotencyKey(base)).toBe(awardIdempotencyKey({ ...base }));
  });

  it("differs for a different operator or unit", () => {
    expect(awardIdempotencyKey({ ...base, operatorId: 48 })).not.toBe(
      awardIdempotencyKey(base)
    );
    expect(awardIdempotencyKey({ ...base, unitId: 31 })).not.toBe(
      awardIdempotencyKey(base)
    );
  });

  it("differs per role, so a multi-role job awards each independently", () => {
    expect(awardIdempotencyKey({ ...base, roleId: 3 })).not.toBe(
      awardIdempotencyKey(base)
    );
  });
});

describe("validateReassignment", () => {
  const base = {
    fromOperatorId: 47,
    toOperatorId: 48,
    fromUnitId: 27,
    toUnitId: 31,
    actorUserId: 3,
    occurredAt: NOW,
  };

  it("accepts a coded reason", () => {
    expect(validateReassignment({ ...base, reason: "hos" }).ok).toBe(true);
  });

  it("requires free text when the reason is 'other'", () => {
    expect(validateReassignment({ ...base, reason: "other" }).ok).toBe(false);
    expect(
      validateReassignment({
        ...base,
        reason: "other",
        detail: "Customer refused entry",
      }).ok
    ).toBe(true);
  });

  it("rejects a reassignment that changes nothing", () => {
    expect(
      validateReassignment({
        ...base,
        toOperatorId: 47,
        toUnitId: 27,
        reason: "hos",
      }).ok
    ).toBe(false);
  });
});
