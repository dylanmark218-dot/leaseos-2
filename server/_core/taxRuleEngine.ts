/**
 * Tax rules.
 *
 * The single most important property of this subsystem: **LeaseOS never invents
 * a tax rule.** Not a rate, not a threshold, not a depreciation class, not a
 * filing requirement. Every rule arrives as data carrying a jurisdiction, a tax
 * year, an effective window, a named source authority and a verification state.
 *
 * An unverified rule does not produce a number. It produces UNKNOWN, with the
 * reason attached. This is the financial form of the routing engine's rule that
 * a satisfied limit based on unverified data is REVIEW rather than PASS — and
 * the stakes are the same, because a confidently wrong tax figure is worse than
 * an obvious gap.
 *
 * Rules are looked up as of a date. Amending a prior period re-runs against the
 * rule that was in force then, not the one in force today.
 */

export type TaxRuleStatus = "unverified" | "verified" | "expired" | "superseded";

export type TaxRule = {
  ruleKey: string;
  version: number;
  jurisdiction: string;
  taxYear?: number | null;
  entityType?: string | null;
  ruleType: string;
  /** Opaque to this engine — a rate, a threshold, a class, a table. */
  parameters: Record<string, unknown>;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
  status: TaxRuleStatus;
  source?: {
    sourceKey: string;
    authority: string;
    reference?: string | null;
    verifiedAt?: Date | null;
  } | null;
};

export type DeterminationOutcome = "determined" | "unknown" | "not_applicable";

export type Determination<T = Record<string, unknown>> = {
  outcome: DeterminationOutcome;
  /** Present only when `outcome === "determined"`. */
  parameters?: T;
  ruleKey?: string;
  ruleVersion?: number;
  sourceAuthority?: string;
  /** Always populated when the outcome is not `determined`. */
  reason?: string;
  /** Shown wherever a figure derived from this is displayed. */
  caveat?: string;
};

export const UNKNOWN_DISPLAY = "Tax treatment unknown — authority rule not verified";

function inWindow(rule: TaxRule, asOf: Date): boolean {
  if (asOf < rule.effectiveFrom) return false;
  if (rule.effectiveUntil && asOf > rule.effectiveUntil) return false;
  return true;
}

/**
 * Select the rule in force. Only `verified` rules are eligible — an unverified
 * rule is recorded so its absence is visible, never so it can be used.
 */
export function selectRule(
  rules: readonly TaxRule[],
  query: {
    jurisdiction: string;
    ruleType: string;
    asOf: Date;
    taxYear?: number | null;
    entityType?: string | null;
  }
): { rule: TaxRule | null; rejected: Array<{ ruleKey: string; why: string }> } {
  const rejected: Array<{ ruleKey: string; why: string }> = [];
  const candidates: TaxRule[] = [];

  for (const r of rules) {
    if (r.jurisdiction !== query.jurisdiction) continue;
    if (r.ruleType !== query.ruleType) continue;
    if (
      query.entityType &&
      r.entityType &&
      r.entityType !== query.entityType
    ) {
      continue;
    }
    if (query.taxYear && r.taxYear && r.taxYear !== query.taxYear) {
      rejected.push({ ruleKey: r.ruleKey, why: `tax year ${r.taxYear}` });
      continue;
    }
    if (!inWindow(r, query.asOf)) {
      rejected.push({ ruleKey: r.ruleKey, why: "outside effective window" });
      continue;
    }
    if (r.status !== "verified") {
      rejected.push({ ruleKey: r.ruleKey, why: `status ${r.status}` });
      continue;
    }
    candidates.push(r);
  }

  if (candidates.length === 0) return { rule: null, rejected };

  // Most recently effective wins; ties break on higher version.
  candidates.sort((a, b) => {
    const d = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    return d !== 0 ? d : b.version - a.version;
  });
  return { rule: candidates[0], rejected };
}

/**
 * Make a determination, or decline to. There is no third option and no
 * fallback default — a missing rule is reported, not substituted.
 */
export function determine(
  rules: readonly TaxRule[],
  query: {
    jurisdiction: string;
    ruleType: string;
    asOf: Date;
    taxYear?: number | null;
    entityType?: string | null;
  }
): Determination {
  const { rule, rejected } = selectRule(rules, query);

  if (!rule) {
    const unverified = rejected.filter(r => r.why.startsWith("status unverified"));
    const reason =
      unverified.length > 0
        ? `A rule exists for ${query.ruleType} in ${query.jurisdiction} but its source is unverified`
        : `No verified ${query.ruleType} rule loaded for ${query.jurisdiction}`;
    return {
      outcome: "unknown",
      reason,
      caveat: UNKNOWN_DISPLAY,
    };
  }

  return {
    outcome: "determined",
    parameters: rule.parameters,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.version,
    sourceAuthority: rule.source?.authority,
  };
}

/**
 * Whether a figure calculated from this determination may be presented as a
 * result rather than as an open question.
 */
export function isUsable(d: Determination): boolean {
  return d.outcome === "determined";
}

/* ------------------------------------------------------------------ */
/* Filing requirements                                                  */
/* ------------------------------------------------------------------ */

export type TaxpayerType =
  | "corporation"
  | "sole_proprietor"
  | "partnership"
  | "employee"
  | "independent_contractor";

export type FilingObligation = {
  obligationKey: string;
  label: string;
  /** Never asserted from code — always traced to a rule. */
  ruleKey: string;
  sourceAuthority: string;
};

export type FilingProfile = {
  taxpayerType: TaxpayerType;
  obligations: FilingObligation[];
  unknowns: string[];
  /**
   * True when at least one obligation could not be determined. The UI must not
   * present a filing checklist as complete while this is set.
   */
  incomplete: boolean;
};

/**
 * What this taxpayer has to file.
 *
 * Deliberately derived entirely from loaded rules. It is tempting to hard-code
 * "a corporation files a corporate return" because it is obviously true — but
 * the moment one obviously-true thing is hard-coded, the next one gets
 * hard-coded too, and eventually a rate lands in a source file with no date and
 * no source. So the engine reports what it can trace and names what it cannot.
 */
export function buildFilingProfile(args: {
  taxpayerType: TaxpayerType;
  jurisdiction: string;
  taxYear: number;
  asOf: Date;
  rules: readonly TaxRule[];
}): FilingProfile {
  const obligations: FilingObligation[] = [];
  const unknowns: string[] = [];

  const relevant = args.rules.filter(
    r =>
      r.ruleType === "filing_obligation" &&
      r.jurisdiction === args.jurisdiction &&
      (!r.entityType || r.entityType === args.taxpayerType)
  );

  if (relevant.length === 0) {
    unknowns.push(
      `No filing-obligation rules loaded for ${args.taxpayerType} in ${args.jurisdiction}`
    );
    return {
      taxpayerType: args.taxpayerType,
      obligations: [],
      unknowns,
      incomplete: true,
    };
  }

  for (const r of relevant) {
    if (r.status !== "verified") {
      unknowns.push(`${r.ruleKey} is ${r.status} — obligation not asserted`);
      continue;
    }
    if (!inWindow(r, args.asOf)) {
      unknowns.push(`${r.ruleKey} is outside its effective window`);
      continue;
    }
    obligations.push({
      obligationKey: String(r.parameters.obligationKey ?? r.ruleKey),
      label: String(r.parameters.label ?? r.ruleKey),
      ruleKey: r.ruleKey,
      sourceAuthority: r.source?.authority ?? "unrecorded",
    });
  }

  return {
    taxpayerType: args.taxpayerType,
    obligations,
    unknowns,
    incomplete: unknowns.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Registration thresholds                                              */
/* ------------------------------------------------------------------ */

export type ThresholdStatus =
  | "below"
  | "approaching"
  | "exceeded"
  | "unknown";

export type ThresholdAssessment = {
  status: ThresholdStatus;
  measuredAmount: number;
  thresholdAmount?: number;
  ruleKey?: string;
  sourceAuthority?: string;
  reason?: string;
  /** Never "you must register" — that is a determination for an advisor. */
  suggestedAction: string;
};

/**
 * Assess rolling revenue against a registration threshold.
 *
 * The threshold is looked up, never embedded. If no verified rule is loaded the
 * answer is `unknown` and the suggested action is to get the rule — not a guess
 * at whether registration is required.
 */
export function assessRegistrationThreshold(args: {
  rollingRevenue: number;
  jurisdiction: string;
  asOf: Date;
  rules: readonly TaxRule[];
  approachingRatio?: number;
}): ThresholdAssessment {
  const d = determine(args.rules, {
    jurisdiction: args.jurisdiction,
    ruleType: "registration_threshold",
    asOf: args.asOf,
  });

  if (!isUsable(d)) {
    return {
      status: "unknown",
      measuredAmount: args.rollingRevenue,
      reason: d.reason,
      suggestedAction:
        "Load the current registration-threshold rule for this jurisdiction, or ask an accountant",
    };
  }

  const threshold = Number(d.parameters?.amount);
  if (!Number.isFinite(threshold)) {
    return {
      status: "unknown",
      measuredAmount: args.rollingRevenue,
      reason: "Threshold rule is loaded but carries no usable amount",
      suggestedAction: "Correct the rule parameters",
    };
  }

  const ratio = args.approachingRatio ?? 0.8;
  const status: ThresholdStatus =
    args.rollingRevenue >= threshold
      ? "exceeded"
      : args.rollingRevenue >= threshold * ratio
        ? "approaching"
        : "below";

  return {
    status,
    measuredAmount: args.rollingRevenue,
    thresholdAmount: threshold,
    ruleKey: d.ruleKey,
    sourceAuthority: d.sourceAuthority,
    suggestedAction:
      status === "exceeded"
        ? "Rolling revenue is at or above the loaded threshold — review registration requirement with an accountant"
        : status === "approaching"
          ? "Rolling revenue is approaching the loaded threshold — worth watching"
          : "No action indicated by the loaded rule",
  };
}
