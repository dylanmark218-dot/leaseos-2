/**
 * P4.2 — a weight is not an axle determination.
 *
 * The rule used to live in a sentence: the ingest returns a note reading "Billing authority:
 * not_granted." True, and enforcing nothing — a string in a response cannot stop the next change
 * from reading an axle row and treating it as the legal figure, and nothing would fail when it did.
 *
 * Each case below is a real truck state, and each refusal has cost somebody money somewhere.
 */
import { readFileSync } from "node:fs";
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

describe("an invalidated calibration is not a lapsed one", () => {
  it("says which, because the two are different mornings", () => {
    // "Recalibrate the device" and "the last calibration was bad — check what it certified" are
    // different problems, and a single EXPIRED code would send someone to the wrong one.
    const lapsed = legalAxleDetermination({
      source: "loadsense_calibrated", stability: { stable: true, reasons: [] }, readingAt: AT,
      calibration: { verifiedAt: new Date("2025-01-01T00:00:00Z"), expiresAt: new Date("2026-01-01T00:00:00Z") },
    });
    const withdrawn = legalAxleDetermination({
      source: "loadsense_calibrated", stability: { stable: true, reasons: [] }, readingAt: AT,
      calibration: { verifiedAt: new Date("2025-01-01T00:00:00Z"), expiresAt: null, invalidatedAt: new Date("2026-05-01T00:00:00Z") },
    });
    if (lapsed.legal || withdrawn.legal) throw new Error("unreachable");
    expect(lapsed.code).toBe("CALIBRATION_EXPIRED");
    expect(withdrawn.code).toBe("CALIBRATION_INVALIDATED");
    expect(withdrawn.reason).toMatch(/Invalidated is not lapsed/);
  });

  it("refuses a model that is not in force whatever its numbers say", () => {
    const v = legalAxleDetermination({
      source: "loadsense_calibrated", stability: { stable: true, reasons: [] }, readingAt: AT,
      calibration: { verifiedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: null, status: "superseded" },
    });
    if (v.legal) throw new Error("unreachable");
    expect(v.code).toBe("CALIBRATION_INVALIDATED");
    expect(v.reason).toMatch(/is superseded, not in force/);
  });

  it("refuses a calibration that takes effect after the reading", () => {
    // A calibration cannot certify a number taken before it existed. Without this, back-dating a
    // reading into a newly calibrated window would launder it.
    const v = legalAxleDetermination({
      source: "loadsense_calibrated", stability: { stable: true, reasons: [] }, readingAt: AT,
      calibration: { verifiedAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null },
    });
    if (v.legal) throw new Error("unreachable");
    expect(v.code).toBe("CALIBRATION_NOT_YET_EFFECTIVE");
  });
});

describe("the ingest stores the verdict and speaks from it", () => {
  const router = () => readFileSync("server/integrationRouter.ts", "utf8");

  it("computes the determination where the inputs are, and stores it on the snapshot", async () => {
    const src = router();
    expect(src).toMatch(/legalAxleDetermination\(\{/);
    expect(src).toMatch(/legalDetermination: determination\.legal/);
    expect(src).toMatch(/legalDeterminationCode: determination\.legal \? null : determination\.code/);
  });

  it("generates the authority line from the verdict instead of asserting it", () => {
    const src = router();
    expect(src).toMatch(/const authority = snapshotVerdict == null/);
    expect(src).toMatch(/snapshotVerdict\.legal/);
    // The sentence and the behaviour can no longer drift apart, which is the whole change.
    expect(src).not.toMatch(/note: `\$\{classification\}\. Billing authority: not_granted\. Certified-scale authority: not_granted\.`/);
  });
});
