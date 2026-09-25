/**
 * Assignment history — the append-only half of the slot model.
 *
 * `dispatchRoles` carries the current binding and is mutated in place, because a slot's occupancy
 * is not a contested question: it has one answer, and who put it there is history rather than
 * interpretation. That history lives in `dispatchRoleAssignmentEvents` and is never updated or
 * deleted.
 *
 * It deliberately does **not** live in `dispatchAuditEvents`. That table's entire production
 * vocabulary is `assignment_approved` and `assignment_blocked`, and `assignment_approved` doubles
 * as the award's idempotency record (`_core/dispatchTransaction.ts:109-116`). Writing assignment
 * history there would make an assignment indistinguishable from an award to the award's own replay
 * check — which is exactly the conflation this subsystem exists to end.
 */

export type Binding = {
  operatorId: number | null;
  unitId: number | null;
  trailerId: number | null;
};

export type AssignmentEventType =
  | "assignment_created"
  | "assignment_reassigned"
  | "assignment_unassigned";

const isBound = (b: Binding) => b.operatorId !== null || b.unitId !== null || b.trailerId !== null;

const same = (a: Binding, b: Binding) =>
  a.operatorId === b.operatorId && a.unitId === b.unitId && a.trailerId === b.trailerId;

/**
 * What kind of change this was, derived from the two bindings rather than declared by the caller.
 *
 * Null means nothing changed, and a caller that gets null must write no event: a history row saying
 * a dispatcher acted when they did not is a lie in the audit, and advancing the concurrency head
 * would make another dispatcher's in-flight submission stale for no reason.
 */
export function describeTransition(from: Binding, to: Binding): AssignmentEventType | null {
  if (same(from, to)) return null;
  if (!isBound(to)) return "assignment_unassigned";
  if (!isBound(from)) return "assignment_created";
  return "assignment_reassigned";
}

/**
 * The concurrency token: the head of this role's own history.
 *
 * Null is a claim, not an absence — "I observed a slot nothing had touched" — which is what makes a
 * first assignment safe against a concurrent first assignment. Ids are monotonic, so the highest is
 * the most recent.
 */
export function headEventId(events: readonly { id: number }[]): number | null {
  if (events.length === 0) return null;
  return events.reduce((hi, e) => (e.id > hi ? e.id : hi), events[0]!.id);
}
