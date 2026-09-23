/**
 * What must be re-read after a slot changes, and why it cannot be left to the caller.
 *
 * Changing who is on a slot changes the readiness question. `composeReadiness` takes its subject as
 * a parameter and fingerprints the facts of that subject, so a verdict computed for the previous
 * driver is not merely old — it is about a different crew. Leaving it on screen would show a
 * dispatcher a clearance that was never granted to the person now in the slot.
 *
 * The readiness query belongs to a child component, so the detail screen cannot refetch it
 * directly; it invalidates. That makes the policy a decision rather than a line of wiring, and a
 * decision that is easy to half-forget — invalidating the slot list is the obvious half, and it is
 * the half that does not matter for safety.
 */
import { describe, expect, it, vi } from "vitest";
import { invalidateAfterSlotMutation } from "./assignmentRefresh";

const spy = () => {
  const invalidate = vi.fn();
  return { invalidate };
};

describe("I3a — a slot change invalidates both reads, never only the visible one", () => {
  it("invalidates the slot list", () => {
    const listRoles = spy(), readiness = spy();
    invalidateAfterSlotMutation({ listRoles, readiness });
    expect(listRoles.invalidate).toHaveBeenCalledTimes(1);
  });

  /*
   * The one that matters. A stale slot list is visibly stale — the dispatcher sees the old driver
   * and re-reads. A stale readiness verdict looks exactly like a current one.
   */
  it("invalidates readiness", () => {
    const listRoles = spy(), readiness = spy();
    invalidateAfterSlotMutation({ listRoles, readiness });
    expect(readiness.invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates readiness even when invalidating the slot list throws", () => {
    const listRoles = { invalidate: vi.fn(() => { throw new Error("network"); }) };
    const readiness = spy();
    expect(() => invalidateAfterSlotMutation({ listRoles, readiness })).not.toThrow();
    expect(
      readiness.invalidate,
      "a failure to re-read the slots must not be able to leave a stale clearance on screen",
    ).toHaveBeenCalledTimes(1);
  });

  it("reports a failure to invalidate rather than swallowing it silently", () => {
    const listRoles = spy();
    const readiness = { invalidate: vi.fn(() => { throw new Error("network"); }) };
    expect(invalidateAfterSlotMutation({ listRoles, readiness })).toEqual({ readinessInvalidated: false });
  });

  it("reports success when both landed", () => {
    expect(invalidateAfterSlotMutation({ listRoles: spy(), readiness: spy() }))
      .toEqual({ readinessInvalidated: true });
  });
});
