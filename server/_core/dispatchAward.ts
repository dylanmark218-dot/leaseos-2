/**
 * Award decision + eligibility invalidation.
 *
 * B14 made eligibility time-fresh. That is not enough: a check run 5 minutes
 * ago is worthless if the truck failed an inspection 4 minutes ago. So an
 * eligibility check now carries a DEPENDENCY FINGERPRINT over the facts it
 * relied on, and is invalid the moment any of those facts change — regardless
 * of how recent it is.
 *
 *     valid = withinFreshnessWindow AND fingerprintUnchanged
 *
 * Freshness is a maximum reuse window, never permission to ignore a change.
 *
 * decideAward() is pure. The transactional wrapper in the router performs the
 * locking and writes; this module decides whether the award is permitted at
 * all, so the rule can be tested without a database.
 */

import type { DispatchBlocker, DispatchEligibility } from "./dispatchReadiness";

/**
 * The facts an eligibility verdict depends on. Any change here invalidates
 * the check. Deliberately explicit rather than hashing whole rows — a
 * cosmetic edit to an operator's phone number must not force re-evaluation,
 * while a licence expiry change must.
 */
export type EligibilityFacts = {
  operatorId: number;
  operatorCredentialVersion: string;
  hoursAvailableMinutes: number | null;
  unitId: number | null;
  unitStatusVersion: string;
  criticalDefectCount: number;
  mechanicReleaseVersion: string;
  trailerId: number | null;
  trailerStatusVersion: string;
  jobClassificationVersion: string;
  materialClassificationVersion: string;
  permitVersion: string;
  destinationAcceptanceVersion: string;
  routeProfileId: string | null;
  routeDecisionVersion: string;
};

function stableHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function computeEligibilityFingerprint(facts: EligibilityFacts): string {
  const canonical = Object.entries(facts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([k, v]) => `${k}:${v === null || v === undefined ? "null" : String(v)}`
    )
    .join("|");
  return `EF-${stableHash(canonical)}`;
}

export type StoredEligibilityCheck = DispatchEligibility & {
  checkId: number;
  fingerprint: string;
  operatorId: number;
};

export type EligibilityValidity = {
  valid: boolean;
  ageMinutes: number;
  reason: string;
  requiresReEvaluation: boolean;
  invalidatedBy: "none" | "age" | "dependency_change";
};

/**
 * A check is reusable only if it is both recent AND still describes the world.
 * Dependency change is reported separately from age because they mean
 * different things to a dispatcher: one is routine, the other means something
 * material happened since.
 */
export function assessEligibilityValidity(
  check: StoredEligibilityCheck,
  currentFacts: EligibilityFacts,
  now: Date,
  maxAgeMinutes = 30
): EligibilityValidity {
  const ageMinutes = Math.floor(
    (now.getTime() - check.evaluatedAt.getTime()) / 60_000
  );
  const currentFingerprint = computeEligibilityFingerprint(currentFacts);

  if (currentFingerprint !== check.fingerprint) {
    return {
      valid: false,
      ageMinutes,
      requiresReEvaluation: true,
      invalidatedBy: "dependency_change",
      reason: `Underlying facts changed since this check (${ageMinutes} min ago) — re-evaluate before awarding.`,
    };
  }
  if (ageMinutes > maxAgeMinutes) {
    return {
      valid: false,
      ageMinutes,
      requiresReEvaluation: true,
      invalidatedBy: "age",
      reason: `Readiness was evaluated ${ageMinutes} min ago, beyond the ${maxAgeMinutes} min reuse window.`,
    };
  }
  return {
    valid: true,
    ageMinutes,
    requiresReEvaluation: false,
    invalidatedBy: "none",
    reason: `Readiness evaluated ${ageMinutes} min ago and dependencies unchanged.`,
  };
}

/* ============================ award decision ============================ */

export type PostingState =
  | "draft"
  | "planning"
  | "open_for_bid"
  | "invite_only"
  | "on_call"
  | "direct"
  | "bid_closed"
  | "awarding"
  | "partially_staffed"
  | "staffed"
  | "dispatched"
  | "in_progress"
  | "completed"
  | "cancelled";

export type BidState =
  | "draft"
  | "submitted"
  | "viewed"
  | "shortlisted"
  | "awarded"
  | "declined"
  | "withdrawn"
  | "expired"
  | "not_selected";

/** States in which a posting may still receive an award. */
const AWARDABLE_POSTING_STATES: PostingState[] = [
  "open_for_bid",
  "invite_only",
  "on_call",
  "direct",
  "bid_closed",
  "awarding",
  "partially_staffed",
];

export type GrantedOverride = {
  blockerCode: string;
  grantedByUserId: number;
  grantedByRole: string;
  reason: string;
  grantedAt: Date;
};

export type AwardRequest = {
  postingId: number;
  roleId: number | null;
  operatorId: number;
  unitId: number | null;
  trailerId: number | null;
  requestedByUserId: number;
  requestedAt: Date;
  /** Client-supplied; makes a retried request safe to replay. */
  idempotencyKey: string;
};

export type AwardContext = {
  postingState: PostingState;
  bidState: BidState | null;
  eligibility: StoredEligibilityCheck;
  validity: EligibilityValidity;
  conflicts: Array<{
    resourceRef: string;
    existingJob: string;
    message: string;
  }>;
  grantedOverrides: GrantedOverride[];
};

export type AwardDecision =
  | { permitted: true; eligibilityCheckId: number; explanation: string }
  | { permitted: false; refusals: string[]; explanation: string };

/**
 * The single authority on whether an award may proceed. The client requests;
 * this decides. A match score is not an input here — it cannot reach this
 * function, which is the B14 invariant carried into B15.
 */
export function decideAward(context: AwardContext): AwardDecision {
  const refusals: string[] = [];

  if (!AWARDABLE_POSTING_STATES.includes(context.postingState)) {
    refusals.push(
      `Posting is ${context.postingState} and cannot receive an award`
    );
  }

  if (context.bidState !== null) {
    if (context.bidState === "withdrawn") refusals.push("Bid was withdrawn");
    else if (context.bidState === "expired") refusals.push("Bid has expired");
    else if (context.bidState === "declined") refusals.push("Bid was declined");
    else if (context.bidState === "draft")
      refusals.push("Bid was never submitted");
  }

  if (!context.validity.valid) {
    refusals.push(context.validity.reason);
  }

  const verdict = context.eligibility.verdict;
  if (verdict === "blocked") {
    const named = context.eligibility.blockers
      .filter(b => b.severity === "blocking")
      .map(b => `BLOCKED — ${b.label}`);
    refusals.push(...named);
  }
  if (verdict === "unknown") {
    const named = context.eligibility.blockers
      .filter(b => b.severity === "unknown")
      .map(b => `UNKNOWN — ${b.label}`);
    refusals.push(...named);
  }
  if (verdict === "eligible_review") {
    for (const b of context.eligibility.blockers.filter(
      x => x.severity === "review"
    )) {
      const covered = context.grantedOverrides.some(
        o => o.blockerCode === b.code
      );
      if (!covered)
        refusals.push(
          `REVIEW — ${b.label} (unresolved, no authorised override)`
        );
    }
  }

  // An override can never cover a non-overridable blocker, even if one was
  // somehow recorded. Belt and braces against a bad write upstream.
  for (const o of context.grantedOverrides) {
    const blocker = context.eligibility.blockers.find(
      b => b.code === o.blockerCode
    );
    if (blocker && !blocker.overridable) {
      refusals.push(
        `Override of ${blocker.code} is not permitted for any role`
      );
    }
  }

  for (const c of context.conflicts) {
    refusals.push(`Resource conflict — ${c.message}`);
  }

  if (refusals.length > 0) {
    return {
      permitted: false,
      refusals,
      explanation: refusals.join(". ") + ".",
    };
  }

  return {
    permitted: true,
    eligibilityCheckId: context.eligibility.checkId,
    explanation: `Award permitted on eligibility check ${context.eligibility.checkId} (${context.validity.ageMinutes} min old, dependencies unchanged).`,
  };
}

/**
 * Deterministic key for an award attempt. A retried request with the same key
 * resolves to the existing assignment instead of creating a second one — the
 * application-level half of the concurrency guard, alongside the row lock and
 * unique constraint in the transaction.
 */
export function awardIdempotencyKey(
  request: Omit<AwardRequest, "idempotencyKey" | "requestedAt">
): string {
  const canonical = [
    request.postingId,
    request.roleId ?? "null",
    request.operatorId,
    request.unitId ?? "null",
    request.trailerId ?? "null",
  ].join(":");
  return `AW-${stableHash(canonical)}`;
}

/* ===================== reassignment reason codes ===================== */

export type ReassignmentReason =
  | "operator_unavailable"
  | "hos"
  | "equipment_failure"
  | "customer_change"
  | "permit_delay"
  | "route_change"
  | "emergency_reassignment"
  | "weather"
  | "no_response"
  | "operator_declined"
  | "mechanical_blocker"
  | "other";

export type Reassignment = {
  fromOperatorId: number;
  toOperatorId: number;
  fromUnitId: number | null;
  toUnitId: number | null;
  reason: ReassignmentReason;
  detail?: string | null;
  actorUserId: number;
  occurredAt: Date;
};

/** `other` demands free text; the rest may stand alone. */
export function validateReassignment(r: Reassignment): {
  ok: boolean;
  problem?: string;
} {
  if (r.reason === "other" && !r.detail?.trim()) {
    return {
      ok: false,
      problem: "Reason 'other' requires a written explanation",
    };
  }
  if (r.fromOperatorId === r.toOperatorId && r.fromUnitId === r.toUnitId) {
    return {
      ok: false,
      problem: "Reassignment does not change the operator or unit",
    };
  }
  return { ok: true };
}
