/**
 * Integration Hub — the dead-letter state machine.
 *
 * A dead letter is a record of something LeaseOS accepted and could not
 * complete. It moves only when a person moves it. Requeueing creates a NEW
 * attempt and leaves every old one where it was; if the requeued work dies
 * again it becomes a new dead letter that names this one as its predecessor.
 * The machine never requeues on its own, which is what makes "no endless
 * dead → retry → dead loop" a property rather than a hope.
 */
export type DeadLetterState = "open" | "requeued" | "cancelled" | "acknowledged" | "resolved";
export type DeadLetterAction = "inspected" | "requeued" | "retried_now" | "cancelled" | "acknowledged" | "resolved" | "reopened";

const TRANSITIONS: Record<DeadLetterState, Partial<Record<DeadLetterAction, DeadLetterState>>> = {
  open: { inspected: "open", requeued: "requeued", retried_now: "requeued", cancelled: "cancelled", acknowledged: "acknowledged", resolved: "resolved" },
  acknowledged: { inspected: "acknowledged", requeued: "requeued", retried_now: "requeued", cancelled: "cancelled", resolved: "resolved" },
  requeued: { inspected: "requeued", resolved: "resolved", cancelled: "cancelled" },
  cancelled: { inspected: "cancelled", reopened: "open" },
  resolved: { inspected: "resolved", reopened: "open" },
};

export function nextDeadLetterState(from: DeadLetterState, action: DeadLetterAction): { ok: true; to: DeadLetterState } | { ok: false; reason: string } {
  const to = TRANSITIONS[from][action];
  return to ? { ok: true, to } : { ok: false, reason: `a ${from} dead letter cannot be ${action}` };
}

/** A person may requeue at most this many times before the item must be acknowledged with a note first. */
export const MAX_UNACKNOWLEDGED_REQUEUES = 3;
export function requeueAllowed(dl: { state: DeadLetterState; requeueCount: number; acknowledgedAt: Date | null }): { ok: true } | { ok: false; reason: string } {
  const t = nextDeadLetterState(dl.state, "requeued");
  if (!t.ok) return t;
  if (dl.requeueCount >= MAX_UNACKNOWLEDGED_REQUEUES && !dl.acknowledgedAt) return { ok: false, reason: `requeued ${dl.requeueCount} times already; acknowledge it with a note before requeueing again` };
  return { ok: true };
}

export type AttemptHistoryEntry = { attempt: number; at: string; status: string; httpStatus: number | null; error: string | null; outcomeClass: string | null };
