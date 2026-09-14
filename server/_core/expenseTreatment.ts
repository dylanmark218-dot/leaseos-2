/**
 * Expenses.
 *
 * LeaseOS catalogues and substantiates the expense. It does not decide the tax
 * treatment. "I have a receipt" never becomes "this is a write-off" anywhere in
 * this file — treatment depends on entity type, business purpose, jurisdiction,
 * percentage of business use, documentation and the rules in force for that tax
 * year, and only the last of those is something software can look up.
 *
 * So the default treatment is `unknown_review_required`, AI may propose a
 * category but never a treatment, and the personal half of a mixed-use purchase
 * is stored rather than deleted to make the business half look bigger.
 */

import { determine, isUsable, type TaxRule } from "./taxRuleEngine";

export type TaxTreatment =
  | "unknown_review_required"
  | "potentially_deductible"
  | "capital_asset"
  | "inventory"
  | "employee_reimbursement"
  | "personal"
  | "mixed_use"
  | "non_deductible"
  | "taxable_benefit_review";

/** Treatments a human or a verified rule may set — never AI, never a default. */
const HUMAN_DETERMINED: readonly TaxTreatment[] = [
  "potentially_deductible",
  "capital_asset",
  "inventory",
  "employee_reimbursement",
  "personal",
  "mixed_use",
  "non_deductible",
  "taxable_benefit_review",
];

export type ExpenseInput = {
  total: number;
  salesTaxAmount?: number | null;
  transactionDate: Date;
  vendorName?: string | null;
  categoryKey?: string | null;
  categorySource?: "human" | "ai_proposed" | "ai_confirmed" | "merchant_memory";
  businessUsePercent?: number;
  paidPersonally?: boolean;
  hasReceiptEvidence: boolean;
  /** Category-level amount above which a purchase is queried, not assumed. */
  capitalReviewThreshold?: number | null;
};

export type ExpenseAssessment = {
  treatment: TaxTreatment;
  /** Reasons this needs a human. Empty does not mean deductible. */
  reviewReasons: string[];
  businessAmount: number;
  personalAmount: number;
  /** Present when a split exists. Both halves are kept. */
  split: boolean;
  salesTaxRecoverability: "unknown" | "determined";
  salesTaxNote: string;
  capitalReviewSuggested: boolean;
  /** What the UI must show next to any figure derived from this. */
  disclaimer: string;
};

export const EXPENSE_DISCLAIMER =
  "Catalogued and substantiated. Tax treatment is determined by verified rules and your accountant, not by this record.";

/**
 * Assess an expense. Always returns `unknown_review_required` on its own — the
 * function's job is to gather the reasons a human needs to look, not to reach a
 * conclusion. A caller wanting a treatment must set one explicitly through
 * `applyHumanTreatment`.
 */
export function assessExpense(input: ExpenseInput): ExpenseAssessment {
  const reviewReasons: string[] = [];

  const pct = clampPercent(input.businessUsePercent ?? 100);
  const businessAmount = round2((input.total * pct) / 100);
  const personalAmount = round2(input.total - businessAmount);
  const split = personalAmount > 0;

  if (!input.hasReceiptEvidence) {
    reviewReasons.push("No receipt or supporting document attached");
  }
  if (!input.categoryKey) {
    reviewReasons.push("No category assigned");
  } else if (
    input.categorySource === "ai_proposed" ||
    input.categorySource === "merchant_memory"
  ) {
    // A suggestion is a suggestion. Merchant memory is a strong hint and still
    // not a decision — a new kind of purchase from a familiar vendor is common.
    reviewReasons.push("Category is a suggestion and has not been confirmed");
  }
  if (split) {
    reviewReasons.push(
      `Mixed use — ${pct}% business, ${round2(100 - pct)}% personal`
    );
  }
  if (input.paidPersonally) {
    reviewReasons.push(
      "Paid personally — reimbursement or owner-account treatment to confirm"
    );
  }

  const capitalReviewSuggested =
    typeof input.capitalReviewThreshold === "number" &&
    input.total >= input.capitalReviewThreshold;
  if (capitalReviewSuggested) {
    reviewReasons.push(
      `Amount is at or above the capital-review threshold for this category — may be a capital asset rather than an expense`
    );
  }

  return {
    // Never anything else from this function.
    treatment: "unknown_review_required",
    reviewReasons,
    businessAmount,
    personalAmount,
    split,
    salesTaxRecoverability: "unknown",
    salesTaxNote:
      "Sales tax recoverability requires a verified rule for this jurisdiction and period",
    capitalReviewSuggested,
    disclaimer: EXPENSE_DISCLAIMER,
  };
}

export type TreatmentApplication =
  | { ok: true; treatment: TaxTreatment; determinedBy: number }
  | { ok: false; reason: string };

/**
 * Set a treatment. Requires a human, and refuses the treatments that are not a
 * human's to assert directly.
 */
export function applyHumanTreatment(args: {
  treatment: TaxTreatment;
  determinedByUserId: number | null;
  actorIsAi?: boolean;
}): TreatmentApplication {
  if (args.actorIsAi) {
    return {
      ok: false,
      reason: "AI may propose a category; it may not set a tax treatment",
    };
  }
  if (!args.determinedByUserId) {
    return { ok: false, reason: "A treatment must name the person who set it" };
  }
  if (!HUMAN_DETERMINED.includes(args.treatment)) {
    return {
      ok: false,
      reason: `${args.treatment} is not a treatment that can be set directly`,
    };
  }
  return {
    ok: true,
    treatment: args.treatment,
    determinedBy: args.determinedByUserId,
  };
}

/**
 * Sales tax recoverability, looked up rather than assumed. Not every tax amount
 * on a receipt is recoverable, and treating them all as recoverable is a
 * common and expensive mistake.
 */
export function assessSalesTaxRecoverability(args: {
  jurisdiction: string;
  asOf: Date;
  rules: readonly TaxRule[];
}): { recoverable: "unknown" | "per_rule"; reason?: string; ruleKey?: string } {
  const d = determine(args.rules, {
    jurisdiction: args.jurisdiction,
    ruleType: "sales_tax_recoverability",
    asOf: args.asOf,
  });
  return isUsable(d)
    ? { recoverable: "per_rule", ruleKey: d.ruleKey }
    : { recoverable: "unknown", reason: d.reason };
}

/* ------------------------------------------------------------------ */
/* Allocation                                                           */
/* ------------------------------------------------------------------ */

export type Allocation = {
  allocationType: "business" | "personal" | "job" | "unit" | "entity";
  percent: number;
  amount: number;
  basis: string;
};

/**
 * Build the stored allocation rows. The personal portion is always emitted when
 * one exists — deleting it to make the expense look wholly business is the
 * thing this function exists to prevent.
 */
export function buildAllocations(args: {
  total: number;
  businessUsePercent: number;
  basis: string;
  jobId?: number | null;
  unitId?: number | null;
}): Allocation[] {
  const pct = clampPercent(args.businessUsePercent);
  const businessAmount = round2((args.total * pct) / 100);
  const personalAmount = round2(args.total - businessAmount);

  const out: Allocation[] = [
    {
      allocationType: "business",
      percent: pct,
      amount: businessAmount,
      basis: args.basis,
    },
  ];
  if (personalAmount > 0) {
    out.push({
      allocationType: "personal",
      percent: round2(100 - pct),
      amount: personalAmount,
      basis: args.basis,
    });
  }
  return out;
}

/** Allocations must account for the whole amount, to the cent. */
export function allocationsBalance(
  total: number,
  allocations: readonly Allocation[]
): { balanced: boolean; difference: number } {
  const sum = allocations
    .filter(a => a.allocationType === "business" || a.allocationType === "personal")
    .reduce((s, a) => s + a.amount, 0);
  const difference = round2(total - sum);
  return { balanced: Math.abs(difference) < 0.005, difference };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 100;
  return Math.min(100, Math.max(0, round2(p)));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Duplicate detection                                                  */
/* ------------------------------------------------------------------ */

export type DuplicateCandidate = {
  expenseRef: string;
  score: number;
  reasons: string[];
};

/**
 * A photographed receipt and the card transaction for the same purchase are one
 * expense with two pieces of evidence, not two expenses. Detected, never
 * auto-merged — merging the wrong pair silently loses a real cost.
 */
export function findDuplicateCandidates(args: {
  candidate: { vendorName?: string | null; total: number; transactionDate: Date };
  existing: ReadonlyArray<{
    expenseRef: string;
    vendorName?: string | null;
    total: number;
    transactionDate: Date;
  }>;
  dayTolerance?: number;
}): DuplicateCandidate[] {
  const tol = args.dayTolerance ?? 3;
  const out: DuplicateCandidate[] = [];

  for (const e of args.existing) {
    const reasons: string[] = [];
    let score = 0;

    const dayDiff =
      Math.abs(e.transactionDate.getTime() - args.candidate.transactionDate.getTime()) /
      86_400_000;
    if (dayDiff <= tol) {
      score += 0.3;
      reasons.push(`within ${Math.round(dayDiff)} day(s)`);
    }

    if (Math.abs(e.total - args.candidate.total) < 0.005) {
      score += 0.5;
      reasons.push("identical amount");
    }

    const a = (e.vendorName ?? "").trim().toLowerCase();
    const b = (args.candidate.vendorName ?? "").trim().toLowerCase();
    if (a && b && (a === b || a.startsWith(b) || b.startsWith(a))) {
      score += 0.2;
      reasons.push("same vendor");
    }

    if (score >= 0.7) out.push({ expenseRef: e.expenseRef, score: round2(score), reasons });
  }

  return out.sort((x, y) => y.score - x.score);
}
