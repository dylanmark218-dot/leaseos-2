/**
 * v22.20 — who has to act, and when they get told.
 *
 * **Reconciliation note.** This began as `readyForTomorrow.ts`, written four
 * minutes after `shiftReadiness.ts` landed in the same tree and answering the
 * same question with a slightly worse vocabulary. Two modules deciding shift
 * readiness is the failure both of their docstrings warned about, so the
 * duplicate is gone and `readyForShift` is the one answer.
 *
 * What survives here is what that module does not do: route an outstanding
 * check to the person who can resolve it, and escalate a reminder rather than
 * repeat it. Both compose over `ShiftReadiness` and neither re-decides it.
 *
 * Its `CheckState` is the better one and is used as-is — `not_applicable` is a
 * real answer, and a check that does not apply should be dropped rather than
 * shown as satisfied.
 */

import type { ReadinessCheck, ShiftReadiness } from "./shiftReadiness";
import type { Severity } from "./calendarProjection";

/** Who can actually resolve something before the shift starts. */
export type Owner = "driver" | "dispatch" | "office" | "shop" | "safety";

export type OwnedCheck = ReadinessCheck & { owner: Owner };

export type RoutedReadiness = {
  verdict: ShiftReadiness["verdict"];
  /** Only what somebody has to act on, grouped by who. Satisfied checks are not anybody's task. */
  byOwner: { owner: Owner; items: OwnedCheck[]; blocking: number }[];
  unrouted: OwnedCheck[];
  headline: string;
};

const ORDER: Owner[] = ["driver", "dispatch", "office", "shop", "safety"];

/**
 * Group the outstanding checks by who has to act.
 *
 * A single "you are not ready" addressed to everybody is how a checklist
 * becomes noise: the driver cannot upload the office's permit and the office
 * cannot take the truck to the shop.
 *
 * `ownerOf` is supplied because only the caller knows which check is whose —
 * the same check can belong to different people at different companies.
 */
export function routeByOwner(readiness: ShiftReadiness, ownerOf: (check: ReadinessCheck) => Owner | null): RoutedReadiness {
  const outstanding = [...readiness.blocking, ...readiness.unknown, ...readiness.advisory];
  const owned: OwnedCheck[] = [];
  const unrouted: OwnedCheck[] = [];
  for (const c of outstanding) {
    const owner = ownerOf(c);
    if (owner) owned.push({ ...c, owner });
    // A check nobody owns is listed rather than dropped: unassigned work is
    // still work, and silently discarding it is how it never gets done.
    else unrouted.push({ ...c, owner: "dispatch" });
  }
  const byOwner = ORDER
    .map(owner => {
      const items = owned.filter(c => c.owner === owner);
      return { owner, items, blocking: items.filter(c => c.blocksShift && c.state === "failed").length };
    })
    .filter(g => g.items.length > 0);

  const totalBlocking = byOwner.reduce((n, g) => n + g.blocking, 0);
  const headline = outstanding.length === 0
    ? "Nothing outstanding for anyone"
    : `${outstanding.length} outstanding across ${byOwner.length} owner(s)${totalBlocking ? `, ${totalBlocking} of them blocking` : ""}${unrouted.length ? `, ${unrouted.length} unassigned` : ""}`;

  return { verdict: readiness.verdict, byOwner, unrouted, headline };
}

/* ------------------------------------------------------------------ */
/* Reminders that climb                                                 */
/* ------------------------------------------------------------------ */

export type ReminderStage = "worker" | "supervisor" | "cutoff_warning" | "exception";

export type ReminderDecision = {
  stage: ReminderStage | null;
  audience: Owner[];
  reason: string;
  /** True only where the outstanding item actually stops billing. */
  blocksBilling: boolean;
};

/**
 * Decide the next reminder for one outstanding item.
 *
 * The same message every hour is how people learn to swipe notifications away.
 * This climbs — the worker, their supervisor once it has sat, a warning as the
 * cutoff nears, an exception once it passes — and says whether the item stops
 * billing, because a missing meal receipt and an unsigned field ticket are not
 * the same problem even when they are equally late.
 */
export function nextReminder(input: {
  outstandingSince: Date;
  cutoffAt: Date;
  now: Date;
  severity: Severity;
  supervisorAfterHours?: number;
  cutoffWarningHours?: number;
}): ReminderDecision {
  const supervisorAfter = input.supervisorAfterHours ?? 12;
  const warnBefore = input.cutoffWarningHours ?? 4;
  const hoursOutstanding = (input.now.getTime() - input.outstandingSince.getTime()) / 3_600_000;
  const hoursToCutoff = (input.cutoffAt.getTime() - input.now.getTime()) / 3_600_000;
  const blocksBilling = input.severity === "blocking";

  if (hoursToCutoff < 0) {
    return {
      stage: "exception", audience: ["office", "dispatch"],
      reason: `The cutoff passed ${Math.abs(Math.round(hoursToCutoff))} h ago and this is still outstanding`,
      blocksBilling,
    };
  }
  if (hoursToCutoff <= warnBefore) {
    return { stage: "cutoff_warning", audience: ["driver", "dispatch"], reason: `Cutoff in ${Math.round(hoursToCutoff)} h`, blocksBilling };
  }
  if (hoursOutstanding >= supervisorAfter) {
    return { stage: "supervisor", audience: ["dispatch"], reason: `Outstanding ${Math.round(hoursOutstanding)} h with no submission`, blocksBilling };
  }
  if (hoursOutstanding >= 1) {
    return { stage: "worker", audience: ["driver"], reason: `Expected after the job finished ${Math.round(hoursOutstanding)} h ago`, blocksBilling };
  }
  // Silence is a valid answer. Nothing is gained by saying something yet.
  return { stage: null, audience: [], reason: "Recently due; no reminder yet", blocksBilling };
}
