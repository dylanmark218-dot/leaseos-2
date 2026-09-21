/**
 * The assignment-event vocabulary.
 *
 * `dispatchRoles` holds the current binding and is mutated; this is where the history lives, and it
 * is append-only. The two questions a reader has — what kind of change was this, and what did the
 * client last see — are both answered here rather than by whoever happens to be writing the
 * transaction, because both are easy to get subtly wrong and neither is visible in a diff.
 *
 * The event kind is derived from the transition, never declared by the caller. A caller who says
 * "this is a reassignment" while the slot was open is describing their intent, not what happened.
 */
import { describe, expect, it } from "vitest";
import { describeTransition, headEventId, type Binding } from "./dispatchAssignmentEvents";

const empty: Binding = { operatorId: null, unitId: null, trailerId: null };
const bound = (o: Partial<Binding> = {}): Binding => ({ operatorId: 7, unitId: 12, trailerId: null, ...o });

describe("what kind of change this was", () => {
  it("an empty slot becoming bound is a creation", () => {
    expect(describeTransition(empty, bound())).toBe("assignment_created");
  });

  it("a bound slot becoming differently bound is a reassignment", () => {
    expect(describeTransition(bound(), bound({ operatorId: 8 }))).toBe("assignment_reassigned");
    expect(describeTransition(bound(), bound({ unitId: 13 }))).toBe("assignment_reassigned");
    expect(describeTransition(bound(), bound({ trailerId: 40 }))).toBe("assignment_reassigned");
  });

  it("a bound slot becoming empty is an unassignment", () => {
    expect(describeTransition(bound(), empty)).toBe("assignment_unassigned");
  });

  /*
   * Nothing-to-nothing is not an event. Writing one would put a row in the history that says a
   * dispatcher did something when they did not, and would advance the concurrency head so another
   * dispatcher's in-flight submission became stale for no reason.
   */
  it("refuses a transition that changes nothing", () => {
    expect(describeTransition(empty, empty)).toBeNull();
    expect(describeTransition(bound(), bound())).toBeNull();
  });

  it("treats a slot with only a trailer as bound, because that is still a binding somebody made", () => {
    expect(describeTransition(empty, { operatorId: null, unitId: null, trailerId: 40 })).toBe("assignment_created");
  });

  it("does not care which field moved — any difference is the same kind of change", () => {
    expect(describeTransition(bound({ trailerId: 40 }), bound({ trailerId: null }))).toBe("assignment_reassigned");
  });
});

describe("the concurrency head", () => {
  it("is the highest event id for the role, because ids are monotonic", () => {
    expect(headEventId([{ id: 3 }, { id: 11 }, { id: 7 }])).toBe(11);
  });

  /*
   * Null is not "no opinion" — it is the client saying "I observed a slot with no history". That
   * distinction is what makes a first assignment safe against a concurrent first assignment.
   */
  it("is null for a role nothing has ever touched", () => {
    expect(headEventId([])).toBeNull();
  });
});
