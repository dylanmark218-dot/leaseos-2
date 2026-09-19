/**
 * P4.2 — the evidence behind a weight, and what a failure finding un-certifies.
 *
 * The backwards case is the one that costs money: a scale found out of tolerance in September was
 * not fine until September, and somebody has to be told which loads and which invoices those were.
 */
import { describe, expect, it } from "vitest";
import { deriveExceptions, type ExceptionSources } from "./exceptionCentre";
import { permissionsForDomainRole } from "./recordsAuthorization";
import {
  fitQuality, projectCalibrationEvidence, sweepSuspectReadings, suspectWindow,
  type CalibrationEvent, type CalibrationModel, type SnapshotRef,
} from "./calibrationEvidence";

const AT = new Date("2026-09-18T10:00:00Z");
const model = (o: Partial<CalibrationModel> = {}): CalibrationModel =>
  ({ id: 1, modelRef: "LSCAL-7", calibrationEventId: 9, slope: 1.02, interceptOffset: -14,
     pointCount: 6, rSquared: 0.995, status: "active", effectiveAt: new Date("2026-06-01T00:00:00Z"), invalidatedAt: null, ...o });
const event = (o: Partial<CalibrationEvent> = {}): CalibrationEvent =>
  ({ id: 9, measurementDeviceId: 3, eventType: "calibrated", performedAt: new Date("2026-06-01T00:00:00Z"),
     performedBy: "Alberta Scale Co.", standardReference: "NIST F-1 class", toleranceStated: "+/- 0.5%",
     errorFound: null, suspectFrom: null, validUntil: new Date("2026-12-01T00:00:00Z"), certificateEvidenceId: 41, ...o });

describe("what stands behind a weight", () => {
  it("projects the certifier, the standard, the tolerance and the fit", () => {
    const e = projectCalibrationEvidence({ model: model(), event: event(), readingAt: AT });
    expect(e.inForceAtReading).toBe(true);
    expect(e.certifiedBy).toBe("Alberta Scale Co.");
    expect(e.standardReference).toBe("NIST F-1 class");
    expect(e.fit.quality).toBe("strong");
    expect(e.summary).toMatch(/6-point fit \(strong\), certified by Alberta Scale Co\. against NIST F-1 class/);
    expect(e.gaps).toEqual([]);
  });

  it("will not call a two-point fit strong however perfect the r-squared", () => {
    // A line through two points fits perfectly by construction. Reporting r²=1.0 without the point
    // count is how a two-point check comes to look like a twelve-point one.
    expect(fitQuality(2, 1.0)).toBe("weak");
    expect(fitQuality(6, 0.995)).toBe("strong");
    expect(fitQuality(4, 0.98)).toBe("adequate");
    expect(fitQuality(6, null)).toBe("unstated");   // no statistic is not a good one
    const e = projectCalibrationEvidence({ model: model({ pointCount: 2, rSquared: 1 }), event: event(), readingAt: AT });
    expect(e.gaps.join(" ")).toMatch(/fits perfectly by construction and proves nothing/);
  });

  it("names the gaps rather than smoothing them over", () => {
    const e = projectCalibrationEvidence({
      model: model({ rSquared: null }),
      event: event({ standardReference: null, toleranceStated: null }), readingAt: AT,
    });
    expect(e.gaps).toContain("no standard reference recorded — what the device was checked against is unstated");
    expect(e.gaps.join(" ")).toMatch(/'within tolerance' has no number behind it/);
    expect(e.gaps).toContain("no fit statistic recorded");
  });

  it("says a model was not in force rather than quietly using the newest one", () => {
    const e = projectCalibrationEvidence({ model: model({ effectiveAt: new Date("2026-10-01T00:00:00Z") }), event: event(), readingAt: AT });
    expect(e.inForceAtReading).toBe(false);
    expect(e.summary).toMatch(/NOT in force at this reading/);
  });

  it("reports a missing calibration event as the gap it is", () => {
    const e = projectCalibrationEvidence({ model: model(), event: null, readingAt: AT });
    expect(e.gaps.join(" ")).toMatch(/nothing records who certified the device or against what/);
    expect(e.certifiedBy).toBeNull();
  });
});

describe("what a failure finding calls into question", () => {
  const failed = event({
    eventType: "out_of_tolerance_found", performedAt: new Date("2026-09-15T00:00:00Z"),
    errorFound: "reading 2.3% high at 30,000 kg", suspectFrom: new Date("2026-06-20T00:00:00Z"),
  });
  const snap = (ref: string, day: string, legal: boolean | null, device = 3): SnapshotRef =>
    ({ snapshotRef: ref, measuredAt: new Date(`${day}T12:00:00Z`), measurementDeviceId: device, legalDetermination: legal, loadId: 1 });

  it("opens the window the examiner stated, never one it inferred", () => {
    const w = suspectWindow(failed)!;
    expect(w.from).toEqual(new Date("2026-06-20T00:00:00Z"));
    expect(w.to).toEqual(new Date("2026-09-15T00:00:00Z"));
    // How far back a drift reaches is a judgement by whoever examined the device. A system that
    // guessed it would be inventing the number that decides how many invoices get reopened.
    expect(w.because).toMatch(/as stated by whoever examined the device/);
    expect(w.because).toMatch(/reading 2\.3% high at 30,000 kg/);
  });

  it("opens no window for an ordinary calibration, or a finding with no suspect date", () => {
    expect(suspectWindow(event())).toBeNull();
    expect(suspectWindow(event({ eventType: "failed", suspectFrom: null }))).toBeNull();
  });

  it("separates determinations from mere readings, because they need different work", () => {
    const r = sweepSuspectReadings(failed, [
      snap("LSW-1", "2026-05-01", true),           // before the window
      snap("LSW-2", "2026-07-02", true),           // inside, and was relied on
      snap("LSW-3", "2026-08-11", false),          // inside, never a determination
      snap("LSW-4", "2026-09-20", true),           // after the finding
      snap("LSW-5", "2026-07-05", true, 99),       // another device entirely
    ]);
    expect(r.determinationsInQuestion.map(s => s.snapshotRef)).toEqual(["LSW-2"]);
    expect(r.measurementsInQuestion.map(s => s.snapshotRef)).toEqual(["LSW-3"]);
    // Named, so somebody can act: "the scale was bad, check everything" is not an answer.
    expect(r.explanation).toMatch(/1 legal axle determination\(s\).*LSW-2/);
    expect(r.explanation).toMatch(/can no longer be stood behind/);
  });

  it("says so plainly when nothing relied on the device in that window", () => {
    const r = sweepSuspectReadings(failed, [snap("LSW-3", "2026-08-11", false)]);
    expect(r.determinationsInQuestion).toEqual([]);
    expect(r.explanation).toMatch(/No legal axle determination was taken on this device in that window; 1 other reading/);
  });

  it("leaves the stored verdicts alone, and says that it does", () => {
    // The determination was made in good faith on the evidence then available, and that is part of
    // the record. Overwriting would destroy the answer to "what did we believe, and on what basis?"
    const r = sweepSuspectReadings(failed, [snap("LSW-2", "2026-07-02", true)]);
    expect(r.explanation).toMatch(/Their stored verdicts are left as they were/);
    expect(r.determinationsInQuestion[0]!.legalDetermination).toBe(true);
  });
});

/**
 * P4.2 — the owner decision of 2026-09-19 on what a sweep is, and what it is not.
 *
 * "These determinations were made during a calibration interval we can no longer fully stand behind
 * and require review." Not "these invoices are wrong."
 */
/**
 * The engine's full source shape, taken verbatim from the fuel-line suite rather than hand-rolled.
 * A partial fixture would satisfy these tests and prove nothing about the engine callers use.
 */
const EMPTY = (NOW: Date): ExceptionSources => ({ now: NOW, criticalDefects: [], roadsideOpen: [], vendorBills: [], purchaseRequests: [], credentials: [], aiProposals: [], aiQuestions: [], syncConflicts: [], revokedDevicesWithQueue: [], measurementDevices: [], insurancePolicies: [], carrierProfileReviews: [], ungatedAssignments: [], statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [] });

describe("one parent case, not one per finding", () => {
  it("raises exactly one exception for a sweep however many readings it names", () => {
    const base = EMPTY(new Date("2026-09-18T12:00:00Z"));
    const sweep = {
      sweepRef: "CSW-2026-000004", deviceRef: "SCALE-11", determinationsInQuestion: 40,
      measurementsInQuestion: 12, suspectFrom: new Date("2026-06-20T00:00:00Z"), runAt: new Date("2026-09-15T09:00:00Z"),
    };
    const out = deriveExceptions({ ...base, openCalibrationSweeps: [sweep] } as never)
      .filter(e => e.subjectType === "calibration_sweep");
    // Forty rows in the Exception Centre would bury every other exception raised that day.
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("calibration_sweep:CSW-2026-000004");
    expect(out[0]!.reason).toMatch(/40 legal axle determination\(s\) and 12 other reading\(s\)/);
  });

  it("says what is in question and never what it costs", () => {
    const base = EMPTY(new Date());
    const e = deriveExceptions({ ...base, openCalibrationSweeps: [{ sweepRef: "CSW-1", deviceRef: "SCALE-2", determinationsInQuestion: 3, measurementsInQuestion: 0, suspectFrom: new Date(), runAt: new Date() }] } as never)
      .find(x => x.subjectType === "calibration_sweep")!;
    // Nothing here has looked at a price. A case that guessed would send somebody to argue with a
    // customer about a number the system invented.
    expect(`${e.title} ${e.reason}`).not.toMatch(/\$|invoice|credit|refund|owed|overcharg/i);
    expect(e.action).toMatch(/Any credit or rebill follows the Commercial Office approval path/);
    expect(e.requiredPermission).toBe("loadsense.calibration.sweep");
  });

  it("drops to medium when nothing was relied on as a determination", () => {
    const base = EMPTY(new Date());
    const e = deriveExceptions({ ...base, openCalibrationSweeps: [{ sweepRef: "CSW-2", deviceRef: null, determinationsInQuestion: 0, measurementsInQuestion: 5, suspectFrom: new Date(), runAt: new Date() }] } as never)
      .find(x => x.subjectType === "calibration_sweep")!;
    expect(e.severity).toBe("medium");
    expect(e.reason).toMatch(/None of them was relied on as a legal determination/);
  });
});

describe("the sweep is not given to everyone, and confers nothing", () => {
  it("is not held by the ordinary office role", () => {
    // The sweep names which invoices may rest on a device later found bad. That list is not
    // something everyone with a desk should be able to produce on a whim.
    expect(permissionsForDomainRole("office")).not.toContain("loadsense.calibration.sweep");
    expect(permissionsForDomainRole("management")).toContain("loadsense.calibration.sweep");
    expect(permissionsForDomainRole("safety")).toContain("loadsense.calibration.sweep");
  });

  it("grants no financial authority to whoever holds it", () => {
    // The point of separating them: running a sweep must not become a way to approve the credit it
    // suggests. `safety` may sweep and still cannot touch money.
    const safety = permissionsForDomainRole("safety") as readonly string[];
    expect(safety).toContain("loadsense.calibration.sweep");
    for (const financial of ["billing.write", "invoice.approve", "billing.approve", "credit.issue"]) {
      expect(safety, `safety must not hold ${financial}`).not.toContain(financial);
    }
  });
});
