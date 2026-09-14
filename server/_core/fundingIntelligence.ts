/**
 * Funding & incentives intelligence.
 *
 * LeaseOS already knows most of what a grant screener asks for — province,
 * fleet size, headcount, planned purchases, training scheduled, apprentices,
 * R&D projects. So instead of "here are 2,000 programs", it can say "eight
 * employees are scheduled for eligible training and this program may cover
 * about half, subject to approval — apply before training starts".
 *
 * Three disciplines keep that from becoming a liability:
 *
 *   A program is a knowledge object with a verification status. Its
 *   percentages, caps and deadlines are CLAIMED until somebody checks them
 *   against the administering authority. An unverified program can be
 *   surfaced as worth investigating. Its numbers are never presented as money.
 *
 *   The status ladder separates estimates from cash. estimated → potential →
 *   pre_screened → application_submitted → approved → claimed → received. Only
 *   the last three describe money that exists, and the UI reads the state.
 *
 *   No double-dipping. One expense funded under one program is on a ledger,
 *   and the same invoice offered to a second program is detected before it is
 *   claimed. Programs frequently forbid stacking, and the failure surfaces at
 *   audit.
 */

export type ProgramType =
  | "grant"
  | "loan"
  | "loan_guarantee"
  | "refundable_tax_credit"
  | "non_refundable_tax_credit"
  | "deduction"
  | "rebate"
  | "wage_subsidy"
  | "cost_share"
  | "insurance_risk_management"
  | "equity_investment"
  | "tax_system_grant";

/** Money you keep versus money you owe back versus money you never receive. */
export function programMoneyNature(
  t: ProgramType
): "non_repayable" | "repayable" | "tax_treatment" | "risk_transfer" | "ownership" {
  switch (t) {
    case "grant":
    case "wage_subsidy":
    case "cost_share":
    case "rebate":
      return "non_repayable";
    case "loan":
    case "loan_guarantee":
      return "repayable";
    case "refundable_tax_credit":
    case "non_refundable_tax_credit":
    case "deduction":
    case "tax_system_grant":
      return "tax_treatment";
    case "insurance_risk_management":
      return "risk_transfer";
    case "equity_investment":
      return "ownership";
  }
}

export type VerificationStatus = "unverified" | "verified" | "expired" | "superseded";
export type ProgramStatus =
  | "unknown" | "open" | "closed" | "upcoming"
  | "expired" | "funding_exhausted" | "source_changed";

export type FundingProgram = {
  programKey: string;
  version: number;
  officialName: string;
  governmentLevel: string;
  country: string;
  province?: string | null;
  programType: ProgramType;
  deliveryMechanism: "application_intake" | "tax_return" | "lender" | "continuous" | "other";
  categoryKey: string;
  applicantTypes: readonly string[];
  industries: readonly string[];
  /** Applicant types or attributes this program explicitly excludes. */
  exclusions: readonly string[];
  /** Claimed parameters. Opaque; the engine reads named keys when present. */
  parameters: Record<string, unknown>;
  preApprovalRequired: boolean;
  stackingRule: "unknown" | "permitted" | "prohibited" | "conditional";
  programStatus: ProgramStatus;
  intakeOpensAt?: Date | null;
  intakeClosesAt?: Date | null;
  fundingExhaustionPossible: boolean;
  temporaryProgram: boolean;
  verificationStatus: VerificationStatus;
  lastVerifiedAt?: Date | null;
  sourceAuthority?: string | null;
};

/* ------------------------------------------------------------------ */
/* Matching                                                              */
/* ------------------------------------------------------------------ */

export type CompanyProfile = {
  country: string;
  province?: string | null;
  applicantType: "corporation" | "sole_proprietor" | "partnership" | "independent_contractor" | "farming";
  industries: readonly string[];
  employeeCount?: number | null;
  annualRevenue?: number | null;
  /** Attributes the matcher can screen on, e.g. "has_apprentices". */
  attributes: readonly string[];
};

export type TriggerEvent =
  | "training.created"
  | "capital_purchase.planned"
  | "development_project.created"
  | "employee.hired"
  | "ag_equipment.purchase_planned"
  | "safety.corrective_action_created"
  | "manual";

/** Which program categories each trigger opens a search in. Data, not code. */
export const TRIGGER_CATEGORIES: Record<TriggerEvent, readonly string[]> = {
  "training.created": ["training", "workforce", "wage_subsidy"],
  "capital_purchase.planned": ["financing", "equipment", "clean_technology", "tax"],
  "development_project.created": ["rd_innovation", "clean_technology"],
  "employee.hired": ["wage_subsidy", "workforce", "training"],
  "ag_equipment.purchase_planned": ["agriculture", "financing"],
  "safety.corrective_action_created": ["safety", "training"],
  manual: [],
};

export type MatchStrength = "strong" | "possible" | "more_information_required" | "excluded";

export type ProgramMatch = {
  programKey: string;
  officialName: string;
  programType: ProgramType;
  moneyNature: ReturnType<typeof programMoneyNature>;
  strength: MatchStrength;
  reasons: string[];
  missingInformation: string[];
  /** Always present for an unverified program; the UI shows it inline. */
  verificationCaveat?: string;
  preApprovalWarning: boolean;
  intakeState: "open" | "closed" | "upcoming" | "unknown";
};

/**
 * Match one program against a company profile.
 *
 * Exclusions are evaluated FIRST and are terminal. A farming business excluded
 * from a general financing program must not be shown that program as
 * "possible" — it must be shown as excluded, and the agricultural equivalent
 * surfaced instead. That routing is data on the program, not a hard-coded
 * "farming → agricultural loan" branch.
 */
export function matchProgram(args: {
  program: FundingProgram;
  company: CompanyProfile;
  now: Date;
}): ProgramMatch {
  const { program: p, company: c, now } = args;
  const reasons: string[] = [];
  const missing: string[] = [];

  const base = {
    programKey: p.programKey,
    officialName: p.officialName,
    programType: p.programType,
    moneyNature: programMoneyNature(p.programType),
    preApprovalWarning: p.preApprovalRequired,
    intakeState: intakeState(p, now),
    verificationCaveat:
      p.verificationStatus === "verified"
        ? undefined
        : `Program details are ${p.verificationStatus} — not confirmed against ${p.sourceAuthority ?? "the administering authority"}`,
  };

  // Terminal exclusions.
  for (const ex of p.exclusions) {
    if (ex === c.applicantType || c.attributes.includes(ex)) {
      return {
        ...base,
        strength: "excluded",
        reasons: [`Excluded: program does not apply to ${ex}`],
        missingInformation: [],
      };
    }
  }

  if (p.country !== c.country) {
    return {
      ...base,
      strength: "excluded",
      reasons: [`Excluded: program is for ${p.country}`],
      missingInformation: [],
    };
  }
  if (p.province && c.province && p.province !== c.province) {
    return {
      ...base,
      strength: "excluded",
      reasons: [`Excluded: program is for ${p.province}`],
      missingInformation: [],
    };
  }
  if (p.province && !c.province) {
    missing.push("Company operating province");
  }

  if (p.applicantTypes.length > 0) {
    if (p.applicantTypes.includes(c.applicantType)) {
      reasons.push(`Applicant type ${c.applicantType} is eligible`);
    } else {
      return {
        ...base,
        strength: "excluded",
        reasons: [`Excluded: applicant type ${c.applicantType} is not eligible`],
        missingInformation: [],
      };
    }
  }

  if (p.industries.length > 0) {
    const hit = c.industries.filter(i => p.industries.includes(i));
    if (hit.length > 0) reasons.push(`Industry match: ${hit.join(", ")}`);
    else missing.push("Confirm industry classification against program list");
  }

  const maxEmployees = numberParam(p.parameters, "maxEmployees");
  if (maxEmployees != null) {
    if (c.employeeCount == null) missing.push("Employee count");
    else if (c.employeeCount > maxEmployees) {
      return {
        ...base,
        strength: "excluded",
        reasons: [`Excluded: ${c.employeeCount} employees exceeds the ${maxEmployees} limit`],
        missingInformation: [],
      };
    } else reasons.push(`Employee count within limit`);
  }

  const maxRevenue = numberParam(p.parameters, "maxRevenue");
  if (maxRevenue != null) {
    if (c.annualRevenue == null) missing.push("Annual revenue");
    else if (c.annualRevenue > maxRevenue) {
      return {
        ...base,
        strength: "excluded",
        reasons: [`Excluded: revenue exceeds the program limit`],
        missingInformation: [],
      };
    } else reasons.push("Revenue within limit");
  }

  if (base.intakeState === "closed") {
    missing.push("Program intake is closed — watch for the next intake");
  }
  if (p.fundingExhaustionPossible && base.intakeState === "open") {
    missing.push("Funding may be exhausted before the published close date");
  }

  // Unverified programs can never be "strong". Nothing about them is confirmed.
  // A verified program the company fits with nothing missing IS strong — the
  // number of criteria a program happens to have says nothing about fit.
  let strength: MatchStrength;
  if (missing.length > 0) strength = "more_information_required";
  else if (p.verificationStatus === "verified") strength = "strong";
  else strength = "possible";

  return { ...base, strength, reasons, missingInformation: missing };
}

function intakeState(p: FundingProgram, now: Date): ProgramMatch["intakeState"] {
  if (p.programStatus === "open") return "open";
  if (p.programStatus === "closed" || p.programStatus === "expired" || p.programStatus === "funding_exhausted") return "closed";
  if (p.programStatus === "upcoming") return "upcoming";
  if (p.intakeOpensAt && now < p.intakeOpensAt) return "upcoming";
  if (p.intakeClosesAt && now > p.intakeClosesAt) return "closed";
  if (p.intakeOpensAt || p.intakeClosesAt) return "open";
  return "unknown";
}

function numberParam(params: Record<string, unknown>, key: string): number | null {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function matchPrograms(args: {
  programs: readonly FundingProgram[];
  company: CompanyProfile;
  trigger: TriggerEvent;
  now: Date;
}): ProgramMatch[] {
  const cats = TRIGGER_CATEGORIES[args.trigger];
  const pool =
    args.trigger === "manual"
      ? args.programs
      : args.programs.filter(p => cats.includes(p.categoryKey));
  const order: Record<MatchStrength, number> = {
    strong: 0, possible: 1, more_information_required: 2, excluded: 3,
  };
  return pool
    .map(program => matchProgram({ program, company: args.company, now: args.now }))
    .sort((a, b) => order[a.strength] - order[b.strength]);
}

/* ------------------------------------------------------------------ */
/* Estimates                                                             */
/* ------------------------------------------------------------------ */

export type Estimate = {
  amount: number | null;
  /** The label the UI must show beside the amount. Never just a dollar figure. */
  label: string;
  basis: string;
  /** True only when every input to the figure was a verified program parameter. */
  fromVerifiedProgram: boolean;
};

/**
 * Estimate a cost-share contribution. Explicitly an estimate, explicitly
 * labelled, and explicitly caveated when the program's parameters are
 * unverified. There is no code path that returns a bare number.
 */
export function estimateCostShare(args: {
  program: FundingProgram;
  eligibleCost: number;
  units?: number;
}): Estimate {
  const pct = numberParam(args.program.parameters, "coveragePercent");
  const capPerUnit = numberParam(args.program.parameters, "capPerUnit");
  const capTotal = numberParam(args.program.parameters, "capPerApplicant");
  const verified = args.program.verificationStatus === "verified";

  if (pct == null) {
    return {
      amount: null,
      label: "No estimate — program does not state a coverage percentage",
      basis: "missing coveragePercent",
      fromVerifiedProgram: verified,
    };
  }

  let amount = (args.eligibleCost * pct) / 100;
  const parts = [`${pct}% of ${args.eligibleCost.toFixed(2)}`];
  if (capPerUnit != null && args.units) {
    const unitCap = capPerUnit * args.units;
    if (amount > unitCap) { amount = unitCap; parts.push(`capped at ${capPerUnit} × ${args.units}`); }
  }
  if (capTotal != null && amount > capTotal) {
    amount = capTotal; parts.push(`capped at applicant maximum ${capTotal}`);
  }
  amount = Math.round(amount * 100) / 100;

  return {
    amount,
    label: verified
      ? "Estimated — subject to program approval"
      : "Estimated from UNVERIFIED program details — confirm before relying on this",
    basis: parts.join("; "),
    fromVerifiedProgram: verified,
  };
}

/* ------------------------------------------------------------------ */
/* Status ladder                                                         */
/* ------------------------------------------------------------------ */

export type OpportunityStatus =
  | "estimated" | "potential" | "pre_screened" | "application_submitted"
  | "approved" | "claimed" | "received" | "declined" | "expired" | "withdrawn";

const LADDER: Record<OpportunityStatus, OpportunityStatus[]> = {
  estimated: ["potential", "withdrawn", "expired"],
  potential: ["pre_screened", "withdrawn", "expired"],
  pre_screened: ["application_submitted", "withdrawn", "expired"],
  application_submitted: ["approved", "declined", "withdrawn", "expired"],
  approved: ["claimed", "withdrawn"],
  claimed: ["received", "declined"],
  received: [],
  declined: ["potential"],
  expired: [],
  withdrawn: [],
};

export function canAdvanceOpportunity(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return LADDER[from].includes(to);
}

/** Only these describe money that exists. Everything else is a forecast. */
export function isRealizedMoney(s: OpportunityStatus): boolean {
  return s === "approved" || s === "claimed" || s === "received";
}

export function pipelineLabel(s: OpportunityStatus): string {
  switch (s) {
    case "estimated": return "Estimated";
    case "potential": return "Potential";
    case "pre_screened": return "Pre-screened";
    case "application_submitted": return "Application submitted";
    case "approved": return "Approved";
    case "claimed": return "Claimed";
    case "received": return "Received";
    case "declined": return "Declined";
    case "expired": return "Expired";
    case "withdrawn": return "Withdrawn";
  }
}

/* ------------------------------------------------------------------ */
/* Pre-approval                                                          */
/* ------------------------------------------------------------------ */

export type PurchaseAdvisory = {
  warn: boolean;
  headline: string;
  programsRequiringPreApproval: string[];
  detail: string;
};

/**
 * "Do not purchase yet." Many programs require approval before the expense
 * is incurred. Buying first forfeits the funding, and the customer only finds
 * out when the application is declined for a purchase already made.
 */
export function purchaseAdvisory(matches: readonly ProgramMatch[]): PurchaseAdvisory {
  const pre = matches.filter(
    m => m.preApprovalWarning && m.strength !== "excluded"
  );
  if (pre.length === 0) {
    return {
      warn: false,
      headline: "No matched program requires pre-approval",
      programsRequiringPreApproval: [],
      detail: "",
    };
  }
  return {
    warn: true,
    headline: "DO NOT PURCHASE YET — a matched program requires pre-approval",
    programsRequiringPreApproval: pre.map(m => m.programKey),
    detail:
      "Incurring the expense before approval may forfeit eligibility. Confirm the program's timing rule, then decide.",
  };
}

/* ------------------------------------------------------------------ */
/* Stacking                                                              */
/* ------------------------------------------------------------------ */

export type ExistingClaim = {
  claimRef: string;
  programKey: string;
  expenseRef: string;
  eligibleCost: number;
  claimedAmount: number;
  status: "draft" | "submitted" | "approved" | "paid" | "rejected" | "withdrawn";
};

export type StackingAssessment = {
  outcome: "clear" | "possible_duplicate" | "prohibited" | "review";
  reason: string;
  conflicts: ExistingClaim[];
  remainingUnfundedAmount: number;
};

/**
 * Whether this expense may be offered to this program given what is already
 * claimed against it. Live claims (not rejected/withdrawn) on the same expense
 * are a conflict. Whether the conflict is fatal depends on the program's
 * stacking rule — and `unknown` resolves to review, not to clear.
 */
export function assessStacking(args: {
  program: FundingProgram;
  expenseRef: string;
  eligibleCost: number;
  proposedAmount: number;
  existingClaims: readonly ExistingClaim[];
}): StackingAssessment {
  const live = args.existingClaims.filter(
    c => c.expenseRef === args.expenseRef && c.status !== "rejected" && c.status !== "withdrawn"
  );
  const alreadyClaimed = live.reduce((s, c) => s + c.claimedAmount, 0);
  const remaining = Math.max(0, Math.round((args.eligibleCost - alreadyClaimed) * 100) / 100);

  if (live.length === 0) {
    return {
      outcome: "clear",
      reason: "No other program funds this expense",
      conflicts: [],
      remainingUnfundedAmount: remaining,
    };
  }

  const sameProgram = live.find(c => c.programKey === args.program.programKey);
  if (sameProgram) {
    return {
      outcome: "possible_duplicate",
      reason: `${args.expenseRef} is already claimed under ${args.program.programKey} (${sameProgram.claimRef})`,
      conflicts: [sameProgram],
      remainingUnfundedAmount: remaining,
    };
  }

  switch (args.program.stackingRule) {
    case "prohibited":
      return {
        outcome: "prohibited",
        reason: `${args.expenseRef} is already funded under ${live.map(c => c.programKey).join(", ")} and ${args.program.programKey} prohibits stacking`,
        conflicts: live,
        remainingUnfundedAmount: remaining,
      };
    case "permitted":
      if (args.proposedAmount > remaining) {
        return {
          outcome: "review",
          reason: `Stacking is permitted but ${args.proposedAmount} exceeds the ${remaining} still unfunded on ${args.expenseRef}`,
          conflicts: live,
          remainingUnfundedAmount: remaining,
        };
      }
      return {
        outcome: "clear",
        reason: "Stacking permitted and within the unfunded remainder",
        conflicts: live,
        remainingUnfundedAmount: remaining,
      };
    case "conditional":
    case "unknown":
    default:
      return {
        outcome: "review",
        reason: `${args.expenseRef} is already funded under ${live.map(c => c.programKey).join(", ")}; ${args.program.programKey}'s stacking rule is ${args.program.stackingRule} — review before claiming`,
        conflicts: live,
        remainingUnfundedAmount: remaining,
      };
  }
}
