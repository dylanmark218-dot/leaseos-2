/**
 * v23.26 — the permit gate gets something to read.
 *
 * The gate's own logic was never wrong. What was wrong sat in `readinessComposer.ts`, where
 * `permitRequired: false` was a literal on every job — so the gate's careful three-valued branch was
 * dead code and an oversize movement passed the permit check in silence.
 */
import { describe, expect, it } from "vitest";
import { permitCoversMoment, resolvePermitStatus, type DeterminationRow, type PermitRow } from "./movementPermits";

const AT = new Date("2026-09-20T12:00:00Z");
const permit = (o: Partial<PermitRow> = {}): PermitRow => ({
  permitRef: "PRM-1", authority: "Alberta Transportation", jurisdiction: "CA-AB",
  permitNumber: "OS-2026-0001", permitType: "oversize",
  effectiveFrom: new Date("2026-09-01T00:00:00Z"), effectiveTo: new Date("2026-09-30T00:00:00Z"),
  verificationStatus: "verified", ...o,
});
const det = (o: Partial<DeterminationRow> = {}): DeterminationRow =>
  ({ permitRequired: true, basis: "dimensions_exceed_limit", supersededAt: null, ...o });

describe("does this permit cover the moment", () => {
  it("covers a movement inside its window", () => {
    expect(permitCoversMoment(permit(), AT)).toBe(true);
  });

  it("reads a missing window as unknown, not as open-ended", () => {
    /*
     * A permit with no end date is not a permit that never expires — it is a permit whose expiry was
     * not written down, and those differ in exactly the way that matters at a scale house.
     */
    expect(permitCoversMoment(permit({ effectiveTo: null }), AT)).toBeNull();
    expect(permitCoversMoment(permit({ effectiveFrom: null }), AT)).toBeNull();
  });

  it("does not cover before or after", () => {
    expect(permitCoversMoment(permit(), new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(permitCoversMoment(permit(), new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });

  it("refuses a rejected or superseded permit whatever its dates say", () => {
    expect(permitCoversMoment(permit({ verificationStatus: "rejected" }), AT)).toBe(false);
    expect(permitCoversMoment(permit({ verificationStatus: "superseded" }), AT)).toBe(false);
  });
});

describe("resolving what the gate should be told", () => {
  it("a job nobody has assessed is UNKNOWN, not exempt", () => {
    // This is the whole point. `false` was an answer nobody gave.
    const s = resolvePermitStatus([], [], AT);
    expect(s.permitRequired).toBeNull();
    expect(s.detail).toMatch(/nobody has recorded whether this movement needs one/);
  });

  it("a recorded no-permit-needed determination is a real false, with its basis", () => {
    const s = resolvePermitStatus([det({ permitRequired: false, basis: "within_legal_limits" })], [], AT);
    expect(s.permitRequired).toBe(false);
    expect(s.detail).toBe("No permit required — within legal limits.");
  });

  it("treats two live determinations as a conflict rather than taking the newest", () => {
    /*
     * Taking the most recent would hide that two people disagreed about whether a movement is legal.
     */
    const s = resolvePermitStatus([det(), det({ permitRequired: false })], [], AT);
    expect(s.permitRequired).toBeNull();
    expect(s.detail).toMatch(/2 conflicting permit determinations/);
  });

  it("required and none on file blocks", () => {
    const s = resolvePermitStatus([det()], [], AT);
    expect(s).toMatchObject({ permitRequired: true, permitOnFile: false });
    expect(s.detail).toBe("A permit is required and none is on file.");
  });

  it("required, on file, and covering the movement passes", () => {
    const s = resolvePermitStatus([det()], [permit()], AT);
    expect(s).toMatchObject({ permitRequired: true, permitOnFile: true });
    expect(s.detail).toBe("1 verified permit(s) on file.");
  });

  it("keeps unverified visible instead of folding it into the boolean", () => {
    /*
     * "We have the permit" and "we checked it with the issuer" are different claims, so verification
     * gets its own sentence rather than being collapsed into permitOnFile.
     */
    const s = resolvePermitStatus([det()], [permit({ verificationStatus: "unverified" })], AT);
    expect(s.permitOnFile).toBe(true);
    expect(s.detail).toMatch(/1 not yet verified with the issuing authority/);
  });

  it("an undated permit leaves the answer unknown rather than assuming it covers", () => {
    const s = resolvePermitStatus([det()], [permit({ effectiveTo: null })], AT);
    expect(s).toMatchObject({ permitRequired: true, permitOnFile: null });
    expect(s.detail).toMatch(/no recorded effective period/);
  });

  it("an expired permit is not on file for this movement, and says how many were looked at", () => {
    const s = resolvePermitStatus([det()], [permit({ effectiveTo: new Date("2026-09-05T00:00:00Z") })], AT);
    expect(s.permitOnFile).toBe(false);
    expect(s.detail).toBe("A permit is required and 1 on file do not cover this movement.");
  });

  it("does not ask about permits on a movement that needs none", () => {
    // An irrelevant expired permit must not block a job that was determined not to need one.
    const s = resolvePermitStatus([det({ permitRequired: false, basis: "within_legal_limits" })],
      [permit({ effectiveTo: new Date("2020-01-01T00:00:00Z") })], AT);
    expect(s.permitRequired).toBe(false);
    expect(s.permitOnFile).toBeNull();
  });
});
