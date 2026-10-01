/**
 * The readiness presentation contract.
 *
 * This is the one place a server status becomes a thing on a screen, and the reason it is a
 * separate tested module rather than JSX is that every safety property of the dispatcher slice
 * lives here: a colour, a badge or a label must never reinterpret what the server said.
 *
 * Two vocabularies, deliberately not merged:
 *   capability status    PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED   (P8.1)
 *   eligibility verdict  eligible | eligible_review | blocked | unknown      (the dispatch engine)
 *
 * Nothing here recomputes readiness. It maps a string the server produced onto a presentation and
 * refuses to guess when the string is not one it knows — a value this module does not recognise
 * is `unavailable`, never `ready`, because the alternative is a screen inventing a verdict out of
 * a typo, a truncated payload or a status the server grew after this file was written.
 */

/** The single presentation vocabulary. Everything on the panel reduces to one of these. */
export type Readiness =
  | "ready"
  | "review"
  | "blocked"
  | "insufficient"
  | "not_evaluated"
  | "unavailable";

export type Presented = {
  readiness: Readiness;
  /** What the badge says. */
  label: string;
  /** What it means, in the words a dispatcher would use to act on it. */
  meaning: string;
};

/** The P8.1 capability statuses, in the contract's own order. */
export const CAPABILITY_STATUSES = ["PASS", "REVIEW", "BLOCKED", "UNKNOWN", "NOT_EVALUATED"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** The dispatch engine's eligibility verdicts. `unknown` outranks `review` there, and here. */
export const ELIGIBILITY_VERDICTS = ["eligible", "eligible_review", "blocked", "unknown"] as const;
export type EligibilityVerdict = (typeof ELIGIBILITY_VERDICTS)[number];

/**
 * What a value this module does not understand becomes. It is a real presentation — the screen
 * says the word — rather than a silent fallback, because "we do not know what the server meant"
 * is information a dispatcher needs and "ready" is not a safe stand-in for it.
 */
export const UNAVAILABLE: Presented = {
  readiness: "unavailable",
  label: "Unavailable",
  meaning: "The server sent a status this screen does not recognise. Treat this as not established.",
};

const CAPABILITY: Record<CapabilityStatus, Presented> = {
  PASS: { readiness: "ready", label: "Pass", meaning: "Evaluated, and nothing on this axis stands in the way." },
  REVIEW: { readiness: "review", label: "Review", meaning: "Evaluated, and something here needs a person to look before dispatch." },
  BLOCKED: { readiness: "blocked", label: "Blocked", meaning: "Evaluated, and this axis stops the assignment." },
  UNKNOWN: { readiness: "insufficient", label: "Not established", meaning: "The facts this axis needs could not be established. Not the same as clear." },
  NOT_EVALUATED: { readiness: "not_evaluated", label: "Not evaluated", meaning: "This axis was not evaluated at all. It says nothing either way." },
};

const VERDICT: Record<EligibilityVerdict, Presented> = {
  eligible: { readiness: "ready", label: "Ready", meaning: "Every check the engine ran passed." },
  eligible_review: { readiness: "review", label: "Review required", meaning: "Dispatchable, but something is flagged for a person to review first." },
  blocked: { readiness: "blocked", label: "Blocked", meaning: "At least one condition stops this assignment." },
  unknown: { readiness: "insufficient", label: "Not established", meaning: "Something could not be established. Unknown is not ready." },
};

const isCapabilityStatus = (s: string): s is CapabilityStatus =>
  (CAPABILITY_STATUSES as readonly string[]).includes(s);

const isEligibilityVerdict = (s: string): s is EligibilityVerdict =>
  (ELIGIBILITY_VERDICTS as readonly string[]).includes(s);

/** A P8.1 capability status as a presentation. Anything else is `UNAVAILABLE`. */
export function presentCapability(status: string): Presented {
  return isCapabilityStatus(status) ? CAPABILITY[status] : UNAVAILABLE;
}

/** An eligibility verdict as a presentation. Anything else — including "" — is `UNAVAILABLE`. */
export function presentVerdict(verdict: string): Presented {
  return isEligibilityVerdict(verdict) ? VERDICT[verdict] : UNAVAILABLE;
}

/**
 * The one gate. Every "can this go out?" question on the panel asks this and nothing else, so
 * there is exactly one line in the client that can be wrong about it.
 */
export const isReady = (p: Presented): boolean => p.readiness === "ready";

export type BlockerSeverity = "blocking" | "unknown" | "review";

export type BlockerLike = {
  code: string;
  label: string;
  severity: BlockerSeverity | string;
  subject: string;
  overridable: boolean;
  overrideAuthority?: "dispatcher" | "manager" | "administrator" | string;
};

export type OverrideState =
  /** Not overridable by anyone. The condition has to be corrected. */
  | "none"
  /**
   * Flagged overridable, but `blocking` — and the award gate refuses every blocking blocker
   * before it ever reads overrides (`server/_core/dispatchAward.ts`). Two blockers in the tree
   * carry exactly this combination, so showing the flag alone would tell a dispatcher something
   * untrue about what an override would achieve.
   */
  | "marked_overridable_but_blocking"
  /** Overridable, and the underlying fact is known. A named authority may accept it. */
  | "available"
  /** Overridable, but the fact is not established. Verify before anyone overrides a blank. */
  | "requires_verification";

export type PresentedBlocker = Presented & {
  code: string;
  overrideState: OverrideState;
  /** One sentence, for the row. Says what an override here would and would not do. */
  overrideNote: string;
};

const SEVERITY: Record<BlockerSeverity, Presented> = {
  blocking: { readiness: "blocked", label: "Blocking", meaning: "This stops the assignment." },
  unknown: { readiness: "insufficient", label: "Not established", meaning: "This could not be established." },
  review: { readiness: "review", label: "Review", meaning: "Someone has to look at this." },
};

const authorityPhrase = (a: BlockerLike["overrideAuthority"]) =>
  a ? `a ${a}` : "an authorized role";

export function presentBlocker(b: BlockerLike): PresentedBlocker {
  const severity = (SEVERITY as Record<string, Presented>)[b.severity] ?? UNAVAILABLE;

  if (!b.overridable) {
    return {
      ...severity, code: b.code, overrideState: "none",
      overrideNote: "There is no override for this — the condition has to be corrected.",
    };
  }

  if (b.severity === "blocking") {
    return {
      ...severity, code: b.code, overrideState: "marked_overridable_but_blocking",
      overrideNote: `Marked overridable, but a blocking condition is refused at award before any override is read — ${authorityPhrase(b.overrideAuthority)} cannot permit this one.`,
    };
  }

  if (b.severity === "unknown") {
    return {
      ...severity, code: b.code, overrideState: "requires_verification",
      overrideNote: `Nothing was established here, so there is nothing yet to accept — verify it first, then ${authorityPhrase(b.overrideAuthority)} may accept what is found.`,
    };
  }

  return {
    ...severity, code: b.code, overrideState: "available",
    overrideNote: `${authorityPhrase(b.overrideAuthority)} may accept this, on the record, elsewhere in dispatch.`,
  };
}
