/**
 * Insurance & Risk.
 *
 * Six statuses, because two things that look alike are not:
 *
 *   coverage_verified   a person confirmed the coverage with the insurer
 *   coverage_reported   the company says it is covered; nobody has confirmed
 *   document_missing    no proof on file — coverage may well exist
 *   document_expired    the proof on file is out of date — coverage may still exist
 *   coverage_expired    the POLICY is past its expiry
 *   coverage_unknown    no policy on record at all
 *
 * `document_missing` and `coverage_expired` are not the same condition, and
 * treating them the same shuts down trucks that are insured. Only the last
 * two block. The middle two are office work.
 *
 * On claims: the repair bill is an expense. The insurer's payment is a
 * recovery. They are added up side by side; one never erases the other.
 */

import { roadsidePackagePermits } from "./fieldDevice";

export type CoverageStatus =
  | "coverage_verified" | "coverage_reported" | "document_missing"
  | "document_expired" | "coverage_expired" | "coverage_unknown";

export type PolicyRecord = {
  policyRef: string;
  policyType: string;
  effectiveAt: Date;
  expiresAt: Date;
  status: "quoted" | "binder" | "active" | "renewal_pending" | "cancelled" | "expired";
  coverageVerificationStatus: "coverage_verified" | "coverage_reported" | "coverage_unknown";
  coverages: readonly { coverageType: string; limitAmount: number | null; additionalInsuredEndorsement: boolean }[];
  /** The proof document, if any. */
  document: { expiresAt: Date | null; verificationStatus: "needs_review" | "verified" | "rejected" } | null;
};

export type CoverageAssessment = {
  coverageType: string;
  status: CoverageStatus;
  effect: "none" | "review" | "blocked";
  policyRef: string | null;
  expiresAt: Date | null;
  daysToExpiry: number | null;
  reason: string;
};

/** The status of one coverage type for an entity, given the policies that cover it. */
export function assessCoverage(args: { coverageType: string; policies: readonly PolicyRecord[]; now: Date; warnDays?: number }): CoverageAssessment {
  const relevant = args.policies.filter(p => p.coverages.some(c => c.coverageType === args.coverageType) && p.status !== "cancelled" && p.status !== "quoted");
  if (relevant.length === 0) {
    return { coverageType: args.coverageType, status: "coverage_unknown", effect: "blocked", policyRef: null, expiresAt: null, daysToExpiry: null, reason: `No ${args.coverageType} policy on record` };
  }
  const best = [...relevant].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0]!;
  const days = Math.floor((best.expiresAt.getTime() - args.now.getTime()) / 86_400_000);
  const base = { coverageType: args.coverageType, policyRef: best.policyRef, expiresAt: best.expiresAt, daysToExpiry: days };

  if (best.expiresAt <= args.now || best.status === "expired") {
    return { ...base, status: "coverage_expired", effect: "blocked", reason: `${args.coverageType} policy ${best.policyRef} expired ${-days} day(s) ago` };
  }
  if (!best.document) {
    return { ...base, status: "document_missing", effect: "review", reason: `${args.coverageType} covered under ${best.policyRef} but no proof document on file — office to obtain; coverage is not assumed absent` };
  }
  if (best.document.expiresAt && best.document.expiresAt <= args.now) {
    return { ...base, status: "document_expired", effect: "review", reason: `Proof of ${args.coverageType} on file expired; policy ${best.policyRef} runs to ${best.expiresAt.toISOString().slice(0, 10)} — refresh the document` };
  }
  if (best.document.verificationStatus === "rejected") {
    return { ...base, status: "document_missing", effect: "review", reason: `Proof of ${args.coverageType} was rejected on review — obtain a valid document` };
  }
  if (best.coverageVerificationStatus === "coverage_verified" && best.document.verificationStatus === "verified") {
    const warn = args.warnDays ?? 30;
    return { ...base, status: "coverage_verified", effect: days <= warn ? "review" : "none", reason: days <= warn ? `${args.coverageType} verified; policy expires in ${days} day(s)` : `${args.coverageType} verified under ${best.policyRef}` };
  }
  return { ...base, status: "coverage_reported", effect: "review", reason: `${args.coverageType} reported under ${best.policyRef} — coverage or document not yet verified` };
}

/** Dispatch's view: blocked only by an expired or absent POLICY. Missing paper is office work. */
export function dispatchInsuranceGate(assessments: readonly CoverageAssessment[]): { verdict: "ready" | "review" | "blocked"; blockers: string[]; officeActions: string[] } {
  const blockers = assessments.filter(a => a.effect === "blocked").map(a => a.reason);
  const officeActions = assessments.filter(a => a.effect === "review").map(a => a.reason);
  return { verdict: blockers.length ? "blocked" : officeActions.length ? "review" : "ready", blockers, officeActions };
}

/* ------------------------------------------------------------------ */
/* Customer certificate requirements                                   */
/* ------------------------------------------------------------------ */

export type CustomerRequirement = {
  coverageType: string;
  minimumLimit: number | null;
  additionalInsuredRequired: boolean;
};

export type RequirementMatch = {
  coverageType: string;
  outcome: "match" | "gap" | "unknown";
  reason: string;
};

/** Customer requirement ↔ company coverage ↔ evidence → MATCH / GAP / UNKNOWN. */
export function matchCustomerRequirements(args: { requirements: readonly CustomerRequirement[]; policies: readonly PolicyRecord[]; now: Date }): { matches: RequirementMatch[]; readinessPercent: number } {
  const matches = args.requirements.map<RequirementMatch>(r => {
    const a = assessCoverage({ coverageType: r.coverageType, policies: args.policies, now: args.now });
    if (a.status === "coverage_unknown" || a.status === "coverage_expired") return { coverageType: r.coverageType, outcome: "gap", reason: a.reason };
    if (a.status !== "coverage_verified") return { coverageType: r.coverageType, outcome: "unknown", reason: a.reason };
    const policy = args.policies.find(p => p.policyRef === a.policyRef)!;
    const cov = policy.coverages.find(c => c.coverageType === r.coverageType)!;
    if (r.minimumLimit != null) {
      if (cov.limitAmount == null) return { coverageType: r.coverageType, outcome: "unknown", reason: `Customer requires a ${r.minimumLimit} limit; policy limit not recorded` };
      if (cov.limitAmount < r.minimumLimit) return { coverageType: r.coverageType, outcome: "gap", reason: `Customer requires ${r.minimumLimit}; policy limit is ${cov.limitAmount}` };
    }
    if (r.additionalInsuredRequired && !cov.additionalInsuredEndorsement) return { coverageType: r.coverageType, outcome: "gap", reason: "Customer requires additional-insured endorsement; policy has none" };
    return { coverageType: r.coverageType, outcome: "match", reason: `${r.coverageType} meets the customer's requirement under ${policy.policyRef}` };
  });
  const readinessPercent = matches.length ? Math.round((matches.filter(m => m.outcome === "match").length / matches.length) * 100) : 100;
  return { matches, readinessPercent };
}

/* ------------------------------------------------------------------ */
/* Renewal calendar                                                     */
/* ------------------------------------------------------------------ */

export type RenewalBucket = "expired" | "7_days" | "14_days" | "30_days" | "60_days" | "90_days" | "later";

export function renewalCalendar(policies: readonly Pick<PolicyRecord, "policyRef" | "policyType" | "expiresAt" | "status">[], now: Date): Array<{ policyRef: string; policyType: string; expiresAt: Date; daysToExpiry: number; bucket: RenewalBucket; action: string }> {
  const ACTION: Record<RenewalBucket, string> = {
    expired: "Operational exception — coverage lapsed", "7_days": "Critical expiry warning", "14_days": "Chase missing binders and certificates",
    "30_days": "Review quotes and coverage", "60_days": "Broker submissions due", "90_days": "Renewal preparation", later: "No action yet",
  };
  return policies.filter(p => p.status !== "cancelled").map(p => {
    const days = Math.floor((p.expiresAt.getTime() - now.getTime()) / 86_400_000);
    const bucket: RenewalBucket = days < 0 ? "expired" : days <= 7 ? "7_days" : days <= 14 ? "14_days" : days <= 30 ? "30_days" : days <= 60 ? "60_days" : days <= 90 ? "90_days" : "later";
    return { policyRef: p.policyRef, policyType: p.policyType, expiresAt: p.expiresAt, daysToExpiry: days, bucket, action: ACTION[bucket] };
  }).sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/** Every certificate a renewal invalidates. One renewal, twenty-seven customers. */
export function certificatesAffectedByRenewal(args: { policyRef: string; certificates: readonly { certificateRef: string; policyRef: string; recipientCustomerRef: string; expiresAt: Date }[]; now: Date }): string[] {
  return args.certificates.filter(c => c.policyRef === args.policyRef && c.expiresAt > args.now).map(c => c.recipientCustomerRef);
}

/* ------------------------------------------------------------------ */
/* Claim financials                                                     */
/* ------------------------------------------------------------------ */

export type ClaimCost = { costType: string; amount: number };
export type ClaimRecovery = { recoveryType: "approved" | "received" | "denied" | "adjustment"; amount: number };

export type ClaimFinancials = {
  grossLoss: number;
  deductible: number;
  approved: number;
  received: number;
  receivableOutstanding: number;
  unrecovered: number;
  /** The costs are still here. A recovery is added beside them, never subtracted from them. */
  costs: ClaimCost[];
};

export function claimFinancials(args: { costs: readonly ClaimCost[]; recoveries: readonly ClaimRecovery[]; deductible: number | null }): ClaimFinancials {
  const grossLoss = r2(args.costs.reduce((n, c) => n + c.amount, 0));
  const approved = r2(args.recoveries.filter(r => r.recoveryType === "approved").reduce((n, r) => n + r.amount, 0) + args.recoveries.filter(r => r.recoveryType === "adjustment").reduce((n, r) => n + r.amount, 0));
  const received = r2(args.recoveries.filter(r => r.recoveryType === "received").reduce((n, r) => n + r.amount, 0));
  const deductible = args.deductible ?? 0;
  return {
    grossLoss, deductible, approved, received,
    receivableOutstanding: r2(Math.max(0, approved - received)),
    unrecovered: r2(Math.max(0, grossLoss - approved)),
    costs: [...args.costs],
  };
}

/* ------------------------------------------------------------------ */
/* Roadside                                                             */
/* ------------------------------------------------------------------ */

/**
 * What insurance contributes to a roadside package: proof, and nothing about
 * premiums or claims.
 *
 * The category is not a string insurance chooses; it is one the P4 allowlist
 * permits. Every emitted item is checked through `roadsidePackagePermits`,
 * and anything the allowlist does not name is dropped — fail closed. Possession
 * of the tablet is not a permission, and neither is a module deciding for
 * itself what belongs on the roadside screen.
 */
export const INSURANCE_ROADSIDE_CATEGORY = "insurance_proof" as const;

export function roadsideInsuranceItems(assessments: readonly CoverageAssessment[]): Array<{ category: typeof INSURANCE_ROADSIDE_CATEGORY; coverageType: string; status: CoverageStatus; policyRef: string | null }> {
  if (!roadsidePackagePermits(INSURANCE_ROADSIDE_CATEGORY)) return [];
  return assessments
    .filter(a => a.coverageType === "commercial_auto" || a.coverageType === "cargo")
    .map(a => ({ category: INSURANCE_ROADSIDE_CATEGORY, coverageType: a.coverageType, status: a.status, policyRef: a.policyRef }))
    .filter(item => roadsidePackagePermits(item.category));
}

function r2(n: number): number { return Math.round(n * 100) / 100; }
