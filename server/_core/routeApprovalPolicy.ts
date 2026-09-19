/**
 * §10.4 — what a second approver is for, and what coverage is for.
 *
 * Owner decision (2026-09-19), and the change in it matters more than the rest. The obvious design
 * is a threshold: "under 70% verified coverage, require two signatures." It sounds cautious and it
 * would be unusable here. The Alberta extract carries **24 `maxweight` tags across 512,979
 * vehicle-road ways**, so verified weight coverage on an ordinary back-road route starts near zero.
 * A percentage gate would demand a second signature for every load in the province, every day,
 * because OpenStreetMap does not publish legal weight limits — and a signature everyone gives
 * hundreds of times a week is not a control, it is a keystroke.
 *
 * So the two ideas are separated:
 *
 *   **Coverage is evidence.** Persisted per axis, reported prominently, and never a gate. Its job is
 *   to answer "what did we know when we approved this?" years later, which is why it is stored
 *   rather than recomputed — a route approved at 13% verified weight coverage must still read 13%
 *   after the province publishes data that lifts it to 60%.
 *
 *   **Risk is the trigger.** A second approver is required when a **specific** high-consequence fact
 *   is unresolved on a road this route actually uses — an unknown capacity on a bridge it crosses,
 *   not an unknown capacity somewhere in Alberta.
 *
 * And the hard one: **a known FAIL stays a FAIL.** A second signature is permission to proceed on
 * something nobody could establish. It is not permission to proceed on something established as
 * false, and no number of approvers converts one into the other.
 */

export type CoverageAxis =
  | "weight" | "axle" | "height" | "width" | "length" | "bridge" | "dangerous_goods" | "seasonal" | "surface";

/** What a single check on a single segment contributed. */
export type CheckOutcome = {
  axis: CoverageAxis;
  segmentId: string;
  /** `pass` / `review` / `fail` / `unknown`, as the evaluator answered. */
  result: "pass" | "review" | "fail" | "unknown";
  /** Whether the evidence behind it was authority-confirmed. */
  verified: boolean;
  /** True when this check applies to a structure or restriction the route genuinely meets. */
  highConsequence: boolean;
  /** Two authorities disagreeing is its own state, not an average. */
  conflicting?: boolean;
  detail: string;
};

export type AxisCoverage = {
  axis: CoverageAxis;
  applicable: number;
  verified: number;
  unverified: number;
  absent: number;
  conflicting: number;
  /** Verified ÷ applicable, as a percentage. Evidence, never a gate. */
  coveragePercent: number;
};

export type SecondApprovalTrigger = { axis: CoverageAxis; segmentId: string; reason: string };

export type RouteApprovalAssessment = {
  byAxis: readonly AxisCoverage[];
  totalApplicable: number;
  totalVerified: number;
  highConsequenceUnresolved: number;
  secondApprovalRequired: boolean;
  triggers: readonly SecondApprovalTrigger[];
  /** A FAIL is not approvable by anybody. Carried separately so it cannot be read as a trigger. */
  blocking: readonly CheckOutcome[];
  explanation: string;
};

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 1000) / 10);

/**
 * The conditions that call for a second person.
 *
 * Every one is a **specific unresolved fact on a road this route uses**, which is what keeps the
 * list short enough to mean something. "The province has not published weight limits" is not on it
 * and never will be: that is a fact about Alberta, not about this route.
 */
export function assessRouteApproval(outcomes: readonly CheckOutcome[]): RouteApprovalAssessment {
  const axes = Array.from(new Set(outcomes.map(o => o.axis)));
  const byAxis: AxisCoverage[] = axes.map(axis => {
    const on = outcomes.filter(o => o.axis === axis);
    const verified = on.filter(o => o.verified && o.result !== "unknown").length;
    const conflicting = on.filter(o => o.conflicting).length;
    const absent = on.filter(o => o.result === "unknown").length;
    return {
      axis, applicable: on.length, verified,
      unverified: on.length - verified - absent,
      absent, conflicting, coveragePercent: pct(verified, on.length),
    };
  }).sort((a, b) => a.axis.localeCompare(b.axis));

  // A failure is not a trigger. Nobody approves past it, so it is not part of the approval question.
  const blocking = outcomes.filter(o => o.result === "fail");

  const triggers: SecondApprovalTrigger[] = outcomes
    .filter(o => o.result !== "fail")
    .filter(o => (o.highConsequence && (o.result === "unknown" || !o.verified)) || o.conflicting)
    .map(o => ({
      axis: o.axis, segmentId: o.segmentId,
      reason: o.conflicting
        ? `${o.axis}: authorities disagree on ${o.segmentId} — ${o.detail}`
        : o.result === "unknown"
          ? `${o.axis}: unresolved on ${o.segmentId}, which this route uses — ${o.detail}`
          : `${o.axis}: cleared on unverified evidence on ${o.segmentId} — ${o.detail}`,
    }));

  const totalApplicable = outcomes.length;
  const totalVerified = outcomes.filter(o => o.verified && o.result !== "unknown").length;

  return {
    byAxis, totalApplicable, totalVerified,
    highConsequenceUnresolved: triggers.length,
    secondApprovalRequired: triggers.length > 0,
    triggers,
    blocking,
    explanation: blocking.length > 0
      // Said first and said plainly: a second signature is not the remedy for this.
      ? `Not approvable: ${blocking.map(b => `${b.axis} fails on ${b.segmentId} (${b.detail})`).join("; ")}. A second approver cannot clear a failed check.`
      : triggers.length === 0
        ? `No high-consequence fact is unresolved on this route. Verified coverage ${pct(totalVerified, totalApplicable)}% across ${totalApplicable} applicable check(s) — recorded as evidence, not as a gate.`
        : `Second approver required for ${triggers.length} unresolved high-consequence item(s): ${triggers.map(t => t.reason).join("; ")}.`,
  };
}
