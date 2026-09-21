/**
 * P8.1 — the one status engines use to speak to each other.
 *
 * Each engine already has a union that suits its own domain: routing has
 * `CheckResult = "pass" | "fail" | "review" | "unknown"`, readiness has an `EligibilityVerdict`,
 * the customer projection has `"READY" | "REVIEW" | "BLOCKED" | "UNKNOWN"`. Those stay. This is the
 * **boundary** type — what an engine hands to a consumer — and the adapters below translate into it
 * so nothing is rewritten. Building a fifth union and refactoring four engines onto it would be the
 * parallel system this is meant to avoid.
 *
 * The state that did not exist before is `NOT_EVALUATED`, and it is the whole point:
 *
 *   a module that is switched off, or that this account never licensed, has not decided anything.
 *   It did not pass. It did not fail. It was not asked.
 *
 * Without that state a consumer has two bad options — treat the absent input as satisfied, which
 * silently certifies something nobody checked, or treat it as a failure, which bricks every engine
 * downstream of a feature a customer simply did not buy. Both are wrong, and the second is why
 * "turning a feature off must never brick the other engines" needed a contract rather than a
 * convention.
 *
 * Two rules do the work, and both are tested:
 *
 *   1. **`NOT_EVALUATED` never rounds up to `PASS`.** Not when every other check passed, not when
 *      the input was optional, not at billing, not in the archive. It travels beside the verdict as
 *      a named list rather than being folded into it, so "what was not checked when we invoiced
 *      this" is answerable from the record months later.
 *   2. **The consumer declares what it requires.** Billing may need only that a daily log exists,
 *      not a live hours figure; dispatch needs the hours. So the same unevaluated input is a
 *      REVIEW for one consumer and a recorded absence for another, and neither decides for the
 *      other.
 *
 * A required input that was not evaluated yields `REVIEW` — a person decides. It is deliberately
 * not `BLOCKED`: blocked is an answer, and the point is that no answer was given.
 */

export type InterEngineStatus = "PASS" | "REVIEW" | "BLOCKED" | "UNKNOWN" | "NOT_EVALUATED";

/** Why a capability was not evaluated. There is no unexplained NOT_EVALUATED. */
export type NotEvaluatedReason =
  | "module_disabled"        // the company turned it off
  | "not_licensed"           // they never bought it
  | "not_applicable"         // it does not apply to this job, unit or jurisdiction
  | "no_data_source_loaded"; // the authoritative data has not been loaded yet

export type CapabilityResult = {
  /** The capability that answered, named as the consumer knows it. */
  capability: string;
  status: InterEngineStatus;
  /** Present only when the status is NOT_EVALUATED, and required then. */
  reason?: NotEvaluatedReason;
  /** What a person should read. Never a score. */
  detail?: string;
};

export const notEvaluated = (
  capability: string,
  reason: NotEvaluatedReason,
  detail?: string,
): CapabilityResult => ({ capability, status: "NOT_EVALUATED", reason, detail });

/** What a consumer needs from the capabilities it reads. */
export type ConsumerContract = {
  /** The consumer, for the record. */
  consumer: string;
  /** Capabilities whose absence a person must see before this consumer's answer is acted on. */
  requires: readonly string[];
  /**
   * Capabilities this consumer can do without. Their absence is recorded and carried forward, and
   * it does not change the verdict — which is not the same as it not having happened.
   */
  optional?: readonly string[];
};

export type CombinedVerdict = {
  consumer: string;
  status: InterEngineStatus;
  /** Every capability that was not evaluated, with its reason. Never folded into `status`. */
  notEvaluated: readonly CapabilityResult[];
  /** Of those, the ones this consumer said it requires. These are why the status is REVIEW. */
  missingRequired: readonly string[];
  /** The blocking answers, when there are any. */
  blockers: readonly CapabilityResult[];
  /** One line a person can read, assembled from the parts. */
  explanation: string;
};

/** Worst-first, among states that actually decided something. */
const SEVERITY: Record<Exclude<InterEngineStatus, "NOT_EVALUATED">, number> = {
  BLOCKED: 4, UNKNOWN: 3, REVIEW: 2, PASS: 1,
};

/**
 * Combine what the capabilities answered into one verdict for this consumer.
 *
 * `NOT_EVALUATED` results are set aside before the worst-of comparison — that is what stops them
 * being rounded up by a set of passes or hidden behind an unrelated blocker — and then reintroduced
 * as their own field, plus a REVIEW floor when the consumer said it needed one of them.
 */
export function combineForConsumer(
  contract: ConsumerContract,
  results: readonly CapabilityResult[],
): CombinedVerdict {
  for (const r of results) {
    if (r.status === "NOT_EVALUATED" && !r.reason) {
      throw new Error(`${r.capability} is NOT_EVALUATED with no reason; an unexplained absence is not a record`);
    }
  }

  const unevaluated = results.filter((r) => r.status === "NOT_EVALUATED");
  const decided = results.filter((r) => r.status !== "NOT_EVALUATED");
  const required = new Set(contract.requires);
  const missingRequired = unevaluated.filter((r) => required.has(r.capability)).map((r) => r.capability);
  const blockers = decided.filter((r) => r.status === "BLOCKED");

  // A capability the consumer requires that answered nothing at all: also not evaluated, in effect,
  // and a consumer that never received an input must not read its silence as consent.
  const answered = new Set(results.map((r) => r.capability));
  const absentRequired = contract.requires.filter((c) => !answered.has(c));

  let status: InterEngineStatus;
  if (decided.length === 0 && unevaluated.length > 0 && absentRequired.length === 0) {
    // Nothing decided anything. The verdict is the absence itself, not a pass.
    status = required.size === 0 ? "NOT_EVALUATED" : "REVIEW";
  } else {
    const worst = decided.reduce<Exclude<InterEngineStatus, "NOT_EVALUATED">>(
      (acc, r) => (SEVERITY[r.status as Exclude<InterEngineStatus, "NOT_EVALUATED">] > SEVERITY[acc] ? (r.status as Exclude<InterEngineStatus, "NOT_EVALUATED">) : acc),
      "PASS",
    );
    status = worst;
  }

  // The REVIEW floor: a required capability that was not evaluated can never leave a PASS standing.
  if ((missingRequired.length > 0 || absentRequired.length > 0) && status === "PASS") status = "REVIEW";

  const parts: string[] = [];
  if (blockers.length > 0) parts.push(`blocked by ${blockers.map((b) => b.capability).join(", ")}`);
  if (missingRequired.length > 0) parts.push(`${missingRequired.join(", ")} not evaluated and required here`);
  if (absentRequired.length > 0) parts.push(`${absentRequired.join(", ")} gave no answer at all`);
  const optionalAbsent = unevaluated.filter((r) => !required.has(r.capability)).map((r) => r.capability);
  if (optionalAbsent.length > 0) parts.push(`${optionalAbsent.join(", ")} not evaluated, not required here`);

  return {
    consumer: contract.consumer,
    status,
    notEvaluated: unevaluated,
    missingRequired,
    blockers,
    explanation: parts.length > 0 ? `${status}: ${parts.join("; ")}.` : `${status}: every capability this consumer reads answered.`,
  };
}

/**
 * Carry an unevaluated set forward without losing it.
 *
 * Billing and the archive are the two places where a summary usually replaces the detail, and
 * where "everything was fine" is the sentence that gets written. A verdict crossing into either
 * keeps the list, so an invoice can say which checks were never run against the work it bills.
 */
export function carryForward(
  verdict: CombinedVerdict,
  into: string,
): { into: string; status: InterEngineStatus; notEvaluated: readonly CapabilityResult[]; note: string } {
  return {
    into,
    status: verdict.status,
    notEvaluated: verdict.notEvaluated,
    note: verdict.notEvaluated.length === 0
      ? `Every capability ${verdict.consumer} reads was evaluated.`
      : `${verdict.notEvaluated.length} capability/capabilities were not evaluated when ${verdict.consumer} answered: ${verdict.notEvaluated.map((r) => `${r.capability} (${r.reason})`).join(", ")}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Adapters — each engine keeps its own union                          */
/* ------------------------------------------------------------------ */

/** Routing's `CheckResult`. `fail` is an answer, so it becomes BLOCKED, not NOT_EVALUATED. */
export function fromCheckResult(capability: string, r: "pass" | "fail" | "review" | "unknown", detail?: string): CapabilityResult {
  const status: InterEngineStatus = r === "pass" ? "PASS" : r === "fail" ? "BLOCKED" : r === "review" ? "REVIEW" : "UNKNOWN";
  return { capability, status, detail };
}

/** The customer projection's verdict. READY is its word for PASS. */
export function fromProjection(capability: string, v: "READY" | "REVIEW" | "BLOCKED" | "UNKNOWN", detail?: string): CapabilityResult {
  return { capability, status: v === "READY" ? "PASS" : v, detail };
}

/** Readiness eligibility. `eligible_review` is a pass that a person must look at, so REVIEW. */
export function fromEligibility(capability: string, v: string, detail?: string): CapabilityResult {
  const status: InterEngineStatus =
    v === "eligible" ? "PASS" : v === "eligible_review" ? "REVIEW" : v === "ineligible" || v === "blocked" ? "BLOCKED" : "UNKNOWN";
  return { capability, status, detail };
}
