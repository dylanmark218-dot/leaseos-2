/**
 * Two different silences.
 *
 * The engine already distinguishes them; nothing downstream did. I found that
 * the hard way in 0091, reading `unknownCount: 0` as "everything is known" when
 * it meant "no determination was produced at all" — because four fixture
 * profiles applied equally and `selectProfile` correctly refused to choose.
 *
 *   0 determinations produced   LeaseOS could not safely select an authority
 *   4 determinations, all UNKNOWN   authority selected, figures unverified
 *
 * A count cannot tell those apart, and a badge that renders both as "unknown"
 * teaches a dispatcher that the two are the same problem. They are not: the
 * first is fixed by a person choosing which schedule governs, the second by a
 * person verifying figures.
 */

export type NoDeterminationReason =
  | "NO_APPLICABLE_PROFILE"
  | "AMBIGUOUS_PROFILE"
  | "MISSING_OPERATION_CONTEXT";

export type HosEvaluationState =
  | { kind: "NO_DETERMINATION"; reason: NoDeterminationReason; detail: string; candidates?: readonly string[] }
  | { kind: "DETERMINATION"; result: "WITHIN" | "EXCEEDED" | "UNKNOWN"; determined: number; undetermined: number };

/** What a person is supposed to do about it. Different in every case. */
export const NEXT_ACTION: Readonly<Record<NoDeterminationReason | "UNKNOWN" | "WITHIN" | "EXCEEDED", string>> = {
  NO_APPLICABLE_PROFILE: "No schedule covers this operation — record one for this jurisdiction and authority.",
  AMBIGUOUS_PROFILE: "More than one schedule applies equally — a person decides which governs.",
  MISSING_OPERATION_CONTEXT: "The operation is under-described — supply the authority, jurisdiction and latitude.",
  UNKNOWN: "A schedule applies but its figures are unverified — verify them against the instrument.",
  WITHIN: "Within the limits determined.",
  EXCEEDED: "A limit determined as exceeded.",
};

export type EngineSelection = { outcome: string; reasons?: readonly string[]; candidates?: readonly string[] };
export type EngineDetermination = {
  verdict: "within" | "exceeded" | "unknown";
  determinations: readonly { limitKey: string; result: string }[];
  unknownCount: number;
};

/**
 * Map the engine's answer onto the two-state model.
 *
 * Selection is read first, because an unselected schedule is not an
 * undetermined one — there is nothing yet to determine against.
 */
export function evaluationStateOf(
  selection: EngineSelection,
  determination: EngineDetermination,
): HosEvaluationState {
  if (selection.outcome === "conflict") {
    return {
      kind: "NO_DETERMINATION", reason: "AMBIGUOUS_PROFILE",
      detail: selection.reasons?.[0] ?? "More than one schedule applies equally to this operation",
      candidates: selection.candidates,
    };
  }

  if (selection.outcome === "none" || selection.outcome === "no_match") {
    return { kind: "NO_DETERMINATION", reason: "NO_APPLICABLE_PROFILE",
      detail: selection.reasons?.[0] ?? "No schedule covers this operation" };
  }

  if (selection.outcome === "insufficient_context") {
    return { kind: "NO_DETERMINATION", reason: "MISSING_OPERATION_CONTEXT",
      detail: selection.reasons?.[0] ?? "The operation is not described well enough to select a schedule" };
  }

  // A schedule was selected and produced nothing. That is still the absence of
  // an authority to measure against, not a determination of unknown.
  if (determination.determinations.length === 0) {
    return { kind: "NO_DETERMINATION", reason: "NO_APPLICABLE_PROFILE",
      detail: "A schedule was selected but carries no limits" };
  }

  const undetermined = determination.determinations.filter((d) => d.result === "unknown").length;
  return {
    kind: "DETERMINATION",
    result: determination.verdict.toUpperCase() as "WITHIN" | "EXCEEDED" | "UNKNOWN",
    determined: determination.determinations.length - undetermined,
    undetermined,
  };
}

/** One line a person can act on, never a bare "unknown". */
export function describe(state: HosEvaluationState): string {
  if (state.kind === "NO_DETERMINATION") {
    return `No determination — ${NEXT_ACTION[state.reason]}`;
  }
  if (state.result === "UNKNOWN") {
    return `${state.undetermined} of ${state.determined + state.undetermined} limits unverified — ${NEXT_ACTION.UNKNOWN}`;
  }
  return NEXT_ACTION[state.result];
}

/* ------------------------------------------------------------------ */
/* The states a rule can be shown in                                   */
/* ------------------------------------------------------------------ */

export const RULE_DISPLAY_STATES = [
  "UNVERIFIED", "FUTURE", "CURRENT", "SUPERSEDED", "CORRECTED", "REVOKED", "AMBIGUOUS_AUTHORITY",
] as const;

export type RuleDisplayState = (typeof RULE_DISPLAY_STATES)[number];

/** Each state says what it is in words. None of them is a colour. */
export const RULE_STATE_TEXT: Readonly<Record<RuleDisplayState, string>> = {
  UNVERIFIED: "Not verified — no figure has been established",
  FUTURE: "Verified, not yet in force",
  CURRENT: "Verified and in force",
  SUPERSEDED: "Replaced by a later verification",
  CORRECTED: "Withdrawn — corrected by a later verification",
  REVOKED: "Withdrawn by the issuing authority — no longer in force",
  AMBIGUOUS_AUTHORITY: "More than one schedule applies — a person decides which governs",
};

/**
 * The display state for a ledger row.
 *
 * `CORRECTED` is separated from `SUPERSEDED` deliberately: one figure was
 * replaced because the rule changed, the other because it was wrong. Reading
 * them as the same thing loses the distinction an audit most wants.
 */
export function displayStateOf(row: {
  status: string; correctsPromotionRef?: string | null;
}, correctedByLater: boolean): RuleDisplayState {
  if (row.status === "REVOKED") return "REVOKED";
  if (row.status === "FUTURE") return "FUTURE";
  if (row.status === "EXPIRED") return "SUPERSEDED";
  if (row.status === "SUPERSEDED") return correctedByLater ? "CORRECTED" : "SUPERSEDED";
  return "CURRENT";
}
