/**
 * The Fleet presentation contract: every server status becomes a word and a meaning; nothing it does
 * not recognise becomes "Operational".
 */
import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATUSES, OPERATIONAL_STATUSES, UNIT_SIDE_VERDICTS, presentAssetClass, presentLifecycle, presentOperational, presentUnitSide } from "./fleetPresentation";

describe("fleet presentation", () => {
  it("maps every operational status, and an unknown one to Unavailable — never Operational", () => {
    for (const s of OPERATIONAL_STATUSES) expect(presentOperational(s).tone).not.toBe("unavailable");
    expect(presentOperational("available").label).toBe("Operational");
    expect(presentOperational("out_of_service").tone).toBe("blocked");
    expect(presentOperational("indeterminate").tone).toBe("insufficient");
    for (const bad of ["ready", "AVAILABLE", "", undefined, null, "green"]) expect(presentOperational(bad as never).label).toBe("Unavailable");
  });
  it("maps every lifecycle and unit-side verdict the same way", () => {
    for (const s of LIFECYCLE_STATUSES) expect(presentLifecycle(s).tone).not.toBe("unavailable");
    expect(presentLifecycle("retired").tone).toBe("blocked");
    expect(presentLifecycle("fleet").label).toBe("Unavailable");
    for (const v of UNIT_SIDE_VERDICTS) expect(presentUnitSide(v).tone).not.toBe("unavailable");
    expect(presentUnitSide("clear").meaning).toMatch(/decided at dispatch/);
    expect(presentUnitSide("eligible").label).toBe("Unavailable");
  });
  it("says unclassified, never guesses a class", () => {
    expect(presentAssetClass(null)).toBe("Unclassified");
    expect(presentAssetClass("mounted_system")).toBe("mounted system");
  });
});
