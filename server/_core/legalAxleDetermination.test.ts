/**
 * P4.2 — a weight is not an axle determination.
 *
 * The rule used to live in a sentence: the ingest returns a note reading "Billing authority:
 * not_granted." True, and enforcing nothing — a string in a response cannot stop the next change
 * from reading an axle row and treating it as the legal figure, and nothing would fail when it did.
 *
 * Each case below is a real truck state, and each refusal has cost somebody money somewhere.
 */
import { describe, expect, it } from "vitest";
import { legalAxleDetermination } from "./loadSense";

const AT = new Date("2026-09-18T10:00:00Z");
const good = { verifiedAt: new Date("2026-06-01T00:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z") };
const stable = { stable: true, reasons: [] as string[] };

describe("what may become a legal axle determination", () => {
  it("accepts a calibrated onboard reading that is current and stable", () => {
    const v = legalAxleDetermination({ source: "loadsense_calibrated", calibration: good, stability: stable, readingAt: AT });
    expect(v.legal).toBe(true);
    if (!v.legal) throw new Error("unreachable");
    expect(v.confidence).toBe("high");
    expect(v.basis).toMatch(/Calibration verified 2026-06-01, current to 2026-12-01, on a stable reading/);
  });

  it("accepts a certified scale without asking about our own calibration", () => {
    // The certified scale IS the determination. Requiring our calibration to be current before we
    // would believe a weigh scale would be the system preferring its own opinion to the evidence.
    const v = legalAxleDetermination({ source: "certified_scale", calibration: null, stability: stable, readingAt: AT });
    expect(v.legal).toBe(true);
    if (!v.legal) throw new Error("unreachable");
    expect(v.confidence).toBe("certified");
  });
});

describe("what may not, and why", () => {
  it("refuses a reading with no calibration on file", () => {
    const v = legalAxleDetermination({ source: "loadsense_calibrated", calibration: null, stability: stable, readingAt: AT });
    expect(v.legal).toBe(false);
    if (v.legal) throw new Error("unreachable");
    expect(v.code).toBe("NO_CALIBRATION");
    expect(v.reason).toMatch(/nothing establishing what its raw reading means/);
  });

  it("refuses a calibration that expired before the reading, and says why that is not a lesser calibration", () => {
    const expired = { verifiedAt: new Date("2025-01-01T00:00:00Z"), expiresAt: new Date("2026-01-01T00:00:00Z") };
    const v = legalAxleDetermination({ source: "loadsense_calibrated", calibration: expired, stability: stable, readingAt: AT });
    expect(v.legal).toBe(false);
    if (v.legal) throw new Error("unreachable");
    expect(v.code).toBe("CALIBRATION_EXPIRED");
    // The point that matters: the corrected number looks identical either way.
    expect(v.reason).toMatch(/drift it corrects is unbounded and unknown/);
  });

  it("accepts a calibration with no expiry rather than inventing one", () => {
    const v = legalAxleDetermination({ source: "loadsense_calibrated", calibration: { verifiedAt: good.verifiedAt, expiresAt: null }, stability: stable, readingAt: AT });
    expect(v.legal).toBe(true);
  });

  it("refuses an unstable reading, carrying the stability reasons", () => {
    const v = legalAxleDetermination({
      source: "loadsense_calibrated", calibration: good, readingAt: AT,
      stability: { stable: false, reasons: ["speed 12 km/h above threshold", "pitch 4.1 deg on approach"] },
    });
    expect(v.legal).toBe(false);
    if (v.legal) throw new Error("unreachable");
    expect(v.code).toBe("READING_UNSTABLE");
    expect(v.reason).toMatch(/speed 12 km\/h above threshold; pitch 4\.1 deg on approach/);
    expect(v.reason).toMatch(/still settling gives a number that is real and is not a weight/);
  });

  it("refuses a driver-entered or estimated figure however good everything else is", () => {
    for (const source of ["driver_entered", "estimated", "loadsense_uncalibrated"] as const) {
      const v = legalAxleDetermination({ source, calibration: good, stability: stable, readingAt: AT });
      expect(v.legal, source).toBe(false);
      if (v.legal) throw new Error("unreachable");
      expect(v.code).toBe("SOURCE_NOT_ELIGIBLE");
      // Passing an estimate through a calibration does not change what it is.
      expect(v.reason).toMatch(/does not change what it is/);
    }
  });

  it("says what the weight is still good for, because a refusal is not a fault", () => {
    const v = legalAxleDetermination({ source: "estimated", calibration: null, stability: stable, readingAt: AT });
    if (v.legal) throw new Error("unreachable");
    expect(v.stillUsableFor).toMatch(/loading decisions, dispatch and the driver's own judgement/);
  });
});

describe("the rule is structural, not a sentence in a response", () => {
  it("is what the ingest's authority note rests on", async () => {
    const { readFileSync } = await import("node:fs");
    const router = readFileSync("server/integrationRouter.ts", "utf8");
    // The note may stay — it is useful — but it must not be the only thing saying so.
    expect(router).toMatch(/Billing authority: not_granted/);
    expect(readFileSync("server/_core/loadSense.ts", "utf8")).toMatch(/export function legalAxleDetermination/);
  });
});
