/**
 * v22.20 — who may record which finding, and who may release.
 *
 * Pure. No network, no database.
 *
 * Separation of duties here is a company decision with a real cost: insisting
 * on two people at 3am on a highway may mean the truck sits until morning, and
 * for some operators that is right and for others it is not. So the policy is
 * configurable — and *versioned*, so an auditor asking "why was this truck
 * released on the eleventh?" gets the policy that was in force on the eleventh
 * rather than whatever the company believes today.
 *
 * One rule is not configurable, and it is the one that matters:
 *
 *     Company policy may satisfy or strengthen the issuing authority's release
 *     condition. It can never weaken it.
 *
 * A mechanic may be permitted to record `repair_verification`. That does not
 * convert an order requiring a reinspection into one a repair can lift. If the
 * order demands an external act — an inspector, a reinspection, a waiting
 * period, a document — that act remains required however the company is
 * staffed.
 */

export type FindingType = "repair_verification" | "reinspection" | "inspector_release" | "document_confirmation" | "waiting_period_complete" | "other";

export type OosReleasePolicy = {
  policyRef: string;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  repairerMayRecordRepairVerification: boolean;
  releaserMustDifferFromRepairer: boolean;
  releaserMustDifferFromFindingAuthor: boolean;
  allowedFindingRoles: Record<FindingType, readonly string[]>;
  approvedByUserId: number;
  approvedAt: Date;
};

/** Where the stop happened, snapshotted on the order. Not where the truck is today. */
export type PolicyScope = { tenantId: string | null; branchId: string | null; terminalId: string | null };

export type ScopedPolicy = OosReleasePolicy & {
  scopeType: "company" | "branch" | "terminal";
  scopeRef: string | null;
  tenantId: string | null;
};

export type PolicySelection =
  | { policy: ScopedPolicy; scopeType: "company" | "branch" | "terminal"; reason: string }
  | { policy: null; failure: "no_tenant" | "none_in_scope" | "ambiguous"; reason: string };

const effectiveAt = (p: ScopedPolicy, at: Date) =>
  p.effectiveFrom.getTime() <= at.getTime() && (!p.effectiveTo || p.effectiveTo.getTime() > at.getTime());

/**
 * Select the policy that governs one order's release.
 *
 * Most specific wins: terminal, then branch, then company — and only within the
 * order's own tenant. Version is deliberately NOT the tiebreak any more. Two
 * approved policies overlapping at the same specificity is an ambiguity nobody
 * intended, and picking the higher version would be guessing which one the
 * company meant. It fails closed instead.
 */
export function selectPolicyForScope(policies: readonly ScopedPolicy[], scope: PolicyScope, at: Date): PolicySelection {
  if (!scope.tenantId) {
    return { policy: null, failure: "no_tenant", reason: "This order records no tenant, so no policy can be established as governing it" };
  }
  const candidates = policies.filter(p => p.tenantId === scope.tenantId && effectiveAt(p, at));

  const tiers: { type: "terminal" | "branch" | "company"; match: (p: ScopedPolicy) => boolean }[] = [
    { type: "terminal", match: p => p.scopeType === "terminal" && !!scope.terminalId && p.scopeRef === scope.terminalId },
    { type: "branch", match: p => p.scopeType === "branch" && !!scope.branchId && p.scopeRef === scope.branchId },
    { type: "company", match: p => p.scopeType === "company" },
  ];

  for (const tier of tiers) {
    const at_tier = candidates.filter(tier.match);
    if (!at_tier.length) continue;
    if (at_tier.length > 1) {
      return {
        policy: null, failure: "ambiguous",
        reason: `${at_tier.length} approved ${tier.type} policies are in force for this order at once (${at_tier.map(p => `${p.policyRef} v${p.version}`).join(", ")}). Which one the company meant is not something to guess at — release is blocked until one is superseded.`,
      };
    }
    return { policy: at_tier[0], scopeType: tier.type, reason: `Governed by the ${tier.type} policy ${at_tier[0].policyRef} v${at_tier[0].version}` };
  }
  return { policy: null, failure: "none_in_scope", reason: "No approved release policy is in force for this order's tenant, branch or terminal" };
}

/** @deprecated Scope-blind. Kept only for callers that genuinely have one scope. */
export const policyInForce = (policies: readonly OosReleasePolicy[], at: Date): OosReleasePolicy | null =>
  [...policies]
    .filter(p => p.effectiveFrom.getTime() <= at.getTime() && (!p.effectiveTo || p.effectiveTo.getTime() > at.getTime()))
    .sort((a, b) => b.version - a.version)[0] ?? null;

export type Decision = { allowed: boolean; reason: string };

/** May this person, in this role, record this kind of finding on this order? */
export function mayRecordFinding(args: {
  policy: OosReleasePolicy | null;
  findingType: FindingType;
  role: string;
  userId: number;
  repairedByUserIds: readonly number[];
}): Decision {
  if (!args.policy) return { allowed: false, reason: "No release policy is in force — nobody may record a release finding until one is approved" };
  const allowedRoles = args.policy.allowedFindingRoles[args.findingType] ?? [];
  if (!allowedRoles.includes(args.role)) {
    return { allowed: false, reason: `Policy ${args.policy.policyRef} v${args.policy.version} permits ${args.findingType} findings from ${allowedRoles.join(", ") || "nobody"}, not ${args.role}` };
  }
  const isRepairer = args.repairedByUserIds.includes(args.userId);
  if (isRepairer && args.findingType === "repair_verification" && !args.policy.repairerMayRecordRepairVerification) {
    return { allowed: false, reason: `Policy ${args.policy.policyRef} v${args.policy.version} requires somebody other than the repairing technician to verify the repair` };
  }
  if (isRepairer && args.findingType !== "repair_verification") {
    return { allowed: false, reason: `The technician who performed the repair may not record a ${args.findingType} finding — that is an independent act` };
  }
  return { allowed: true, reason: `Permitted for ${args.role} under policy ${args.policy.policyRef} v${args.policy.version}` };
}

/**
 * Does this finding satisfy what the *order* demands?
 *
 * This is the non-configurable half. `requiredFindingType` comes from the
 * issuing authority's own condition; no policy argument can make a weaker
 * finding satisfy it.
 */
export function satisfiesIssuingCondition(requiredFindingType: FindingType | null, finding: { findingType: FindingType; finding: "satisfied" | "not_satisfied" | "unknown" }): Decision {
  if (finding.finding !== "satisfied") return { allowed: false, reason: `The latest finding is "${finding.finding}"` };
  if (!requiredFindingType) return { allowed: true, reason: `The order names no specific required act; a satisfied ${finding.findingType} finding stands` };
  if (finding.findingType !== requiredFindingType) {
    return {
      allowed: false,
      reason: `This order requires a ${requiredFindingType} and the finding on record is a ${finding.findingType}. Company policy may strengthen the issuing authority's condition and can never weaken it.`,
    };
  }
  return { allowed: true, reason: `A satisfied ${requiredFindingType} finding is what this order requires` };
}

/** May this person perform the release itself? */
export function mayRelease(args: {
  policy: OosReleasePolicy | null;
  releaserUserId: number;
  repairedByUserIds: readonly number[];
  findingAuthorUserIds: readonly number[];
}): Decision {
  if (!args.policy) return { allowed: false, reason: "No release policy is in force — nobody may release an order until one is approved" };
  if (args.policy.releaserMustDifferFromRepairer && args.repairedByUserIds.includes(args.releaserUserId)) {
    return { allowed: false, reason: `Policy ${args.policy.policyRef} v${args.policy.version} requires the releaser to be somebody other than the repairing technician` };
  }
  if (args.policy.releaserMustDifferFromFindingAuthor && args.findingAuthorUserIds.includes(args.releaserUserId)) {
    return { allowed: false, reason: `Policy ${args.policy.policyRef} v${args.policy.version} requires the releaser to be somebody other than the author of the release finding` };
  }
  return { allowed: true, reason: `Permitted under policy ${args.policy.policyRef} v${args.policy.version}, approved ${args.policy.approvedAt.toISOString().slice(0, 10)}` };
}
