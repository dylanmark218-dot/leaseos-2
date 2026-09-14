/**
 * v22.20 — what a person needs before their next shift, and who may take it.
 *
 * Pure. No network, no database.
 *
 * Two scheduling decisions that must not be rubber-stamped.
 *
 * **Ready for tomorrow** is the screen a driver opens at 9pm. Its value is
 * entirely in being honest at that hour: a green tick against a check that
 * never ran is worse than no screen, because the person stops looking. So a
 * check with no answer reads UNKNOWN and the shift is not ready. The same rule
 * the dispatch gate, the roadside panel and the calendar run on.
 *
 * **A shift swap** is two people agreeing, which is not the same as the work
 * being covered. If one of them cannot legally or competently do the other's
 * assignment, the agreement is irrelevant — and the system that approves it
 * because both parties clicked yes has quietly made a qualification decision
 * nobody was asked to make.
 */

import type { Severity } from "./calendarProjection";

/* ------------------------------------------------------------------ */
/* Ready for tomorrow                                                   */
/* ------------------------------------------------------------------ */

export type CheckState = "satisfied" | "failed" | "unknown" | "not_applicable";

export type ReadinessCheck = {
  key: string;
  label: string;
  state: CheckState;
  /** Whether failing this stops the shift, as opposed to being worth knowing. */
  blocksShift: boolean;
  /** Why, in the words the person needs. Required when not satisfied. */
  reason: string | null;
};

export type ShiftReadiness = {
  shiftStartsAt: Date;
  verdict: "ready" | "not_ready" | "incomplete";
  blocking: ReadinessCheck[];
  unknown: ReadinessCheck[];
  advisory: ReadinessCheck[];
  satisfied: ReadinessCheck[];
  /** One line per check, in the order a person should read them. */
  lines: string[];
  headline: string;
};

const MARK: Record<CheckState, string> = { satisfied: "OK", failed: "MISSING", unknown: "UNKNOWN", not_applicable: "N/A" };

/**
 * Compose the picture for one upcoming shift.
 *
 * `incomplete` is its own verdict rather than being folded into `not_ready`.
 * "Something is missing" and "we could not tell" send a person to different
 * places: the first to fix it, the second to whoever can answer.
 */
export function readyForShift(args: { shiftStartsAt: Date; checks: readonly ReadinessCheck[] }): ShiftReadiness {
  const relevant = args.checks.filter(c => c.state !== "not_applicable");
  const blocking = relevant.filter(c => c.state === "failed" && c.blocksShift);
  const unknown = relevant.filter(c => c.state === "unknown");
  const advisory = relevant.filter(c => c.state === "failed" && !c.blocksShift);
  const satisfied = relevant.filter(c => c.state === "satisfied");

  const verdict = blocking.length ? "not_ready" : unknown.length ? "incomplete" : "ready";
  const headline =
    verdict === "not_ready" ? `NOT READY — ${blocking.length} item(s) stop this shift`
    : verdict === "incomplete" ? `INCOMPLETE — ${unknown.length} item(s) could not be checked. Unknown is not ready.`
    : `READY — everything checked is in order${advisory.length ? `, with ${advisory.length} thing(s) worth knowing` : ""}`;

  // Blocking first, then what could not be answered, then the rest: the reason a
  // person cannot start should not be below a list of things that are fine.
  const order = [...blocking, ...unknown, ...advisory, ...satisfied];
  return {
    shiftStartsAt: args.shiftStartsAt, verdict, blocking, unknown, advisory, satisfied,
    lines: order.map(c => `${MARK[c.state]} · ${c.label}${c.reason ? ` — ${c.reason}` : ""}`),
    headline,
  };
}

/** Severity for the calendar, from the same check. One vocabulary, not two. */
export const checkSeverity = (c: ReadinessCheck): Severity =>
  c.state === "unknown" ? "unknown"
  : c.state === "failed" ? (c.blocksShift ? "blocking" : "overdue")
  : "informational";

/* ------------------------------------------------------------------ */
/* Shift swaps                                                          */
/* ------------------------------------------------------------------ */

export type Assignment = {
  assignmentRef: string;
  startsAt: Date;
  endsAt: Date;
  /** What the work needs. Held by the assignment, not by whoever usually does it. */
  requiredQualifications: readonly string[];
  requiredRole: string;
};

export type Person = {
  userId: number;
  name: string;
  roles: readonly string[];
  /** Only qualifications established as current. An expired one is simply absent. */
  currentQualifications: readonly string[];
  /** Assignments they already hold, for the overlap check. */
  existingAssignments: readonly Assignment[];
};

export type SwapObjection = {
  code: "missing_qualification" | "wrong_role" | "overlaps_existing" | "hos_unknown" | "coverage_lost";
  who: string;
  detail: string;
};

export type SwapDecision = {
  permitted: boolean;
  objections: SwapObjection[];
  /** Always true. A clean swap still goes to a supervisor. */
  requiresSupervisorApproval: true;
  note: string;
};

const overlaps = (a: Assignment, b: Assignment) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * Whether a proposed swap may go forward to approval.
 *
 * `hosKnown` is a parameter because this module does not decide hours of
 * service; where the applicable rule profile is unverified, the answer is
 * unknown and that is an objection rather than something to assume away.
 *
 * Note what this never returns: `permitted: true` on its own does not move
 * anything. It means the swap is fit to be *asked about*. A supervisor still
 * approves it, because coverage and judgement are not in this data.
 */
export function evaluateSwap(args: {
  a: Person; aGives: Assignment;
  b: Person; bGives: Assignment;
  hosKnown: boolean;
}): SwapDecision {
  const objections: SwapObjection[] = [];

  const check = (taker: Person, taking: Assignment, giving: Assignment) => {
    for (const q of taking.requiredQualifications) {
      if (!taker.currentQualifications.includes(q)) {
        objections.push({ code: "missing_qualification", who: taker.name, detail: `${taking.assignmentRef} requires ${q} and ${taker.name} has no current ${q}` });
      }
    }
    if (!taker.roles.includes(taking.requiredRole)) {
      objections.push({ code: "wrong_role", who: taker.name, detail: `${taking.assignmentRef} is a ${taking.requiredRole} assignment and ${taker.name} does not hold that role` });
    }
    for (const held of taker.existingAssignments) {
      if (held.assignmentRef === giving.assignmentRef) continue;   // the one they are handing over
      if (overlaps(held, taking)) {
        objections.push({ code: "overlaps_existing", who: taker.name, detail: `${taking.assignmentRef} overlaps ${held.assignmentRef}, which ${taker.name} already holds` });
      }
    }
  };

  check(args.a, args.bGives, args.aGives);
  check(args.b, args.aGives, args.bGives);

  if (!args.hosKnown) {
    objections.push({ code: "hos_unknown", who: "both", detail: "The hours-of-service effect of this swap is not established — no verified rule profile applies" });
  }

  const permitted = objections.length === 0;
  return {
    permitted, objections, requiresSupervisorApproval: true,
    note: permitted
      ? "Fit to be asked about. Two people agreeing is not coverage — a supervisor approves this."
      : `Refused before approval: ${objections.length} objection(s). Two people agreeing does not make either of them qualified.`,
  };
}
