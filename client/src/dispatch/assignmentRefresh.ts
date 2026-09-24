/**
 * What the detail screen must re-read after a slot changes.
 *
 * Two reads go stale when a binding moves, and they go stale differently:
 *
 *   the **slot list** is visibly stale — the dispatcher sees the driver they just replaced, and
 *   nothing about that is dangerous because nothing about it is convincing;
 *
 *   the **readiness verdict** is invisibly stale. `composeReadiness` takes its subject as a
 *   parameter and fingerprints that subject's facts, so a verdict computed for the previous driver
 *   is not an old answer to this question — it is a current-looking answer to a different one. Left
 *   on screen it shows a clearance that was never granted to the crew now in the slot.
 *
 * The readiness query belongs to a child component, so the detail screen invalidates rather than
 * refetches. That turns "and also refresh readiness" into a decision worth stating once and testing,
 * instead of a line at the end of two mutation callbacks that is easy to write in one and forget in
 * the other.
 *
 * Order and isolation matter: readiness is invalidated even when the slot list's invalidation
 * throws, because the failure mode that must not happen is a stale clearance surviving a partial
 * refresh.
 */

export type Invalidator = { invalidate: () => unknown };

export type RefreshOutcome = {
  /** False when readiness could not be invalidated — the caller should refuse to look settled. */
  readinessInvalidated: boolean;
};

export function invalidateAfterSlotMutation(queries: {
  listRoles: Invalidator;
  readiness: Invalidator;
}): RefreshOutcome {
  // Deliberately not `Promise.all` over both: a rejection there would skip nothing, but a throw
  // from the first synchronous call would. The slot list is attempted first and its failure is
  // absorbed, because it is the one whose staleness a dispatcher can see.
  try {
    queries.listRoles.invalidate();
  } catch {
    /* A slot list that failed to refresh is visibly wrong; readiness still must not be. */
  }

  try {
    queries.readiness.invalidate();
  } catch {
    return { readinessInvalidated: false };
  }

  return { readinessInvalidated: true };
}
