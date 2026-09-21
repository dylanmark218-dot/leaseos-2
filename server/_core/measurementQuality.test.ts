import { describe, expect, it } from "vitest";
import {
  classifyMeasurementMethod,
  compareMeasurementQuality,
  isRecognizedMeasurementMethod,
  strongerMeasurementMethod,
  MEASUREMENT_AUTHORITY_RANK,
} from "./measurementQuality";
import {
  reconcileDisposal,
  type DisposalRecordInput,
} from "./disposalReconciliation";

const FULL_REQS = {
  facilityIssuesScaleTicket: true,
  manifestRequired: true,
  facilitySignatureRequired: true,
  weightRequired: true,
};

const COMPLETE: DisposalRecordInput = {
  ticketNumber: "DT-2026-004821-01",
  jobId: 1842,
  tripId: 4821,
  loadId: 91,
  createdByUserId: 382,
  operatorId: 47,
  facilityId: 3,
  material: "Produced water",
  quantity: 8.7,
  measurementMethod: "scale",
  arrivedAt: new Date(),
  departedAt: new Date(),
  facilityTicketNumber: "F-99183",
  facilityAcknowledgedAt: new Date(),
  manifestNumber: "MF-2026-004821",
  billingBookEntryId: 55,
  netKg: 8500,
  verificationStatus: "verified",
  requirements: FULL_REQS,
};

describe("classifyMeasurementMethod — recognition", () => {
  it("recognizes every method declared in the schema enums", () => {
    for (const m of [
      "meter",
      "scale",
      "gauge",
      "estimate",
      "customer_stated",
      "system_timed",
      "loadsense_calibrated",
      "loadsense_uncalibrated",
      "unknown",
    ]) {
      expect(isRecognizedMeasurementMethod(m)).toBe(true);
      expect(classifyMeasurementMethod(m).recognized).toBe(true);
    }
  });

  it("treats an absent method as unknown rather than assuming it is fine", () => {
    for (const raw of [null, undefined, ""]) {
      const c = classifyMeasurementMethod(raw);
      expect(c.method).toBe("unknown");
      expect(c.recognized).toBe(false);
      expect(c.adequateForCharge).toBe(false);
    }
  });

  it("recognizes the reconciled LoadSense methods but keeps their billing gate closed here", () => {
    const calibrated = classifyMeasurementMethod("loadsense_calibrated");
    expect(calibrated.recognized).toBe(true);
    expect(calibrated.authority).toBe("instrument_calibrated");
    expect(calibrated.adequateForCharge).toBe(false);
    expect(calibrated.detail).toContain("contract");

    const uncalibrated = classifyMeasurementMethod("loadsense_uncalibrated");
    expect(uncalibrated.recognized).toBe(true);
    expect(uncalibrated.authority).toBe("instrument_uncalibrated");
    expect(uncalibrated.adequateForCharge).toBe(false);
  });

  it("still fails closed on weight-source vocabulary that is not an operational measurement method", () => {
    for (const foreign of ["certified_scale", "driver_entered", "estimated"]) {
      const c = classifyMeasurementMethod(foreign);
      expect(c.recognized).toBe(false);
      expect(c.method).toBe("unknown");
      expect(c.adequateForCharge).toBe(false);
      expect(c.unrecognizedValue).toBe(foreign);
    }
  });

  it("does not confuse a near-miss spelling for the known value", () => {
    // "estimated" is not "estimate". A one-character vocabulary drift must
    // not silently inherit the weaker-but-accepted classification.
    expect(classifyMeasurementMethod("estimate").recognized).toBe(true);
    expect(classifyMeasurementMethod("estimated").recognized).toBe(false);
    expect(classifyMeasurementMethod("estimated").adequateForCharge).toBe(false);
  });
});

describe("classifyMeasurementMethod — ladder ordering", () => {
  it("ranks instrument readings above stated and estimated figures", () => {
    expect(compareMeasurementQuality("scale", "customer_stated")).toBeLessThan(0);
    expect(compareMeasurementQuality("meter", "estimate")).toBeLessThan(0);
    expect(compareMeasurementQuality("gauge", "system_timed")).toBeLessThan(0);
  });

  it("ranks a customer's stated figure above a bare estimate", () => {
    expect(compareMeasurementQuality("customer_stated", "estimate")).toBeLessThan(0);
  });

  it("puts unknown at the bottom of the ladder without exception", () => {
    for (const m of ["scale", "meter", "gauge", "system_timed", "customer_stated", "estimate"]) {
      expect(compareMeasurementQuality(m, "unknown")).toBeLessThan(0);
    }
    expect(compareMeasurementQuality("unknown", "not_a_real_method")).toBe(0);
  });

  it("reserves a tier above instrument readings for an authority-certified source", () => {
    // Nothing occupies it yet. The slot exists so a certified reading can be
    // added without renumbering, and so nothing else quietly claims the top.
    expect(MEASUREMENT_AUTHORITY_RANK.authority_certified).toBeLessThan(
      MEASUREMENT_AUTHORITY_RANK.instrument_measured
    );
    const occupied = ["meter", "scale", "gauge", "estimate", "customer_stated", "system_timed", "loadsense_calibrated", "loadsense_uncalibrated", "unknown"]
      .map(m => classifyMeasurementMethod(m).authority);
    expect(occupied).not.toContain("authority_certified");
    expect(occupied).toContain("instrument_calibrated");
    expect(occupied).toContain("instrument_uncalibrated");
  });

  it("returns the stronger method without discarding that a weaker one exists", () => {
    expect(strongerMeasurementMethod("estimate", "scale")).toBe("scale");
    expect(strongerMeasurementMethod("scale", "estimate")).toBe("scale");
    expect(strongerMeasurementMethod("estimate", null)).toBe("estimate");
  });

  it("is symmetric — argument order does not change which is stronger", () => {
    expect(compareMeasurementQuality("scale", "estimate")).toBe(
      -compareMeasurementQuality("estimate", "scale")
    );
  });
});

describe("disposal billing gate — regression", () => {
  it("holds the disposal charge when the method is from an unknown vocabulary", () => {
    // Before the ladder, this passed: the string was not literally "unknown",
    // so the gate read it as adequate provenance for a charge.
    const r = reconcileDisposal({
      ...COMPLETE,
      measurementMethod: "loadsense_uncalibrated",
    });
    const c = r.checks.find(x => x.key === "measurement_method");
    expect(c?.status).toBe("missing");
    expect(r.missing).toContain("Measurement method");
    expect(r.disposalChargeHeld).toBe(true);
  });

  it("still holds the charge for an explicitly unknown method", () => {
    const r = reconcileDisposal({ ...COMPLETE, measurementMethod: "unknown" });
    expect(r.missing).toContain("Measurement method");
    expect(r.disposalChargeHeld).toBe(true);
  });

  it("still passes an estimate while flagging it, unchanged", () => {
    const r = reconcileDisposal({ ...COMPLETE, measurementMethod: "estimate" });
    const c = r.checks.find(x => x.key === "measurement_method");
    expect(c?.status).toBe("pass");
    expect(c?.detail).toContain("Estimated, not weighed");
  });

  it("now flags a customer-stated quantity instead of passing it silently", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      measurementMethod: "customer_stated",
    });
    const c = r.checks.find(x => x.key === "measurement_method");
    expect(c?.status).toBe("pass");
    expect(c?.detail).toContain("not independently measured");
  });

  it("leaves other charges free to proceed when only measurement is held", () => {
    const r = reconcileDisposal({
      ...COMPLETE,
      measurementMethod: "certified_scale",
    });
    expect(r.disposalChargeHeld).toBe(true);
    expect(r.otherChargesMayProceed).toBe(true);
  });
});
