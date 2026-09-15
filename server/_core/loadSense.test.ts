import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  assessBillingUse,
  assessWeightStability,
  buildWeightSnapshot,
  calculateDeliveredMass,
  calibrationInvalidationReason,
  deriveVolumeFromWeight,
  fitMultiPointCalibration,
  fitTwoPointCalibration,
  reconcileCertifiedScale,
  selectPreferredWeightSource,
  toRoutingVehicleValues,
} from "./loadSense";

describe("LoadSense calibration", () => {
  it("fits a two-point pressure-to-weight calibration", () => {
    const c = fitTwoPointCalibration({ rawValue: 30, knownWeightKg: 9000 }, { rawValue: 60, knownWeightKg: 18000 });
    expect(applyCalibration(45, c)).toBeCloseTo(13500, 6);
  });

  it("fits a multi-point linear calibration", () => {
    const c = fitMultiPointCalibration([
      { rawValue: 20, knownWeightKg: 6000 },
      { rawValue: 40, knownWeightKg: 12000 },
      { rawValue: 60, knownWeightKg: 18000 },
    ]);
    expect(c.rSquared).toBeCloseTo(1, 8);
    expect(applyCalibration(50, c)).toBeCloseTo(15000, 6);
  });

  it("rejects a calibration with no raw-value span", () => {
    expect(() => fitTwoPointCalibration({ rawValue: 30, knownWeightKg: 9000 }, { rawValue: 30, knownWeightKg: 18000 })).toThrow();
  });
});

describe("LoadSense stability", () => {
  it("marks a stationary level settled vehicle stable", () => {
    const result = assessWeightStability({ speedKph: 0, pitchDeg: 0.4, rollDeg: 0.3, accelerationMps2: 0.05, pressureSamples: [40, 40.2, 40.1, 40.05] });
    expect(result.stable).toBe(true);
  });

  it("does not present a moving or leaning reading as stable", () => {
    const result = assessWeightStability({ speedKph: 12, pitchDeg: 4.5, rollDeg: 0.3, accelerationMps2: 1.2, pressureSamples: [35, 44] });
    expect(result.stable).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(1);
  });
});

describe("LoadSense load snapshot", () => {
  const stable = assessWeightStability({ speedKph: 0, pitchDeg: 0.2, rollDeg: 0.2, accelerationMps2: 0.02, pressureSamples: [40, 40.1] });
  it("stops loading when an axle group reaches its configured limit before GVW", () => {
    const snapshot = buildWeightSnapshot({
      loadId: 1, unitId: 218, tareKg: 19480, measuredAt: new Date("2026-09-05T12:00:00Z"),
      measurementSource: "loadsense_calibrated", calibrationId: "CAL-1", stability: stable,
      axleGroups: [
        { axleGroupKey: "steer", label: "Steer", weightKg: 6180, configuredLimitKg: 7300 },
        { axleGroupKey: "drive", label: "Drives", weightKg: 17920, configuredLimitKg: 18000 },
        { axleGroupKey: "trailer", label: "Trailer", weightKg: 22840, configuredLimitKg: 23000 },
      ],
    });
    expect(snapshot.grossKg).toBe(46940);
    expect(snapshot.payloadKg).toBe(27460);
    expect(snapshot.shouldStopLoading).toBe(true);
    expect(snapshot.limitingAxleGroup?.axleGroupKey).toBe("drive");
  });

  it("keeps unknown configured limits visible instead of inventing clearance", () => {
    const snapshot = buildWeightSnapshot({
      loadId: 1, unitId: 1, tareKg: 10000, measuredAt: new Date(), measurementSource: "loadsense_calibrated", stability: stable,
      axleGroups: [{ axleGroupKey: "drive", label: "Drive", weightKg: 16000 }],
    });
    expect(snapshot.axleGroups[0].status).toBe("unknown_limit");
    expect(snapshot.warnings.join(" ")).toMatch(/no configured limit/i);
  });

  it("turns a measured snapshot into the existing routing vehicle shape", () => {
    const snapshot = buildWeightSnapshot({
      loadId: 1, unitId: 1, tareKg: 10000, measuredAt: new Date(), measurementSource: "loadsense_calibrated", stability: stable,
      axleGroups: [
        { axleGroupKey: "steer", label: "Steer", weightKg: 6000, configuredLimitKg: 8000 },
        { axleGroupKey: "drive", label: "Drive", weightKg: 18000, configuredLimitKg: 20000 },
      ],
    });
    const vehicle = toRoutingVehicleValues({ snapshot, heightM: 4.1, widthM: 2.6, lengthM: 19, dangerousGoods: false, requiresEscort: false });
    expect(vehicle.grossWeightKg).toBe(24000);
    expect(vehicle.maxAxleGroupKg).toBe(18000);
  });
});

describe("material and reconciliation", () => {
  it("labels weight-to-volume as derived rather than measured", () => {
    const result = deriveVolumeFromWeight(25590, { densityKgM3: 1700, source: "customer_profile", verified: true });
    expect(result.volumeM3).toBeCloseTo(15.053, 3);
    expect(result.measurementKind).toBe("derived_from_weight");
  });

  it("calculates delivered mass from before/after gross measurements", () => {
    expect(calculateDeliveredMass(46940, 21490)).toBe(25450);
  });

  it("recommends recalibration when certified-scale variance crosses configured policy", () => {
    const result = reconcileCertifiedScale(48420, 49620, { reviewVariancePercent: 1, recalibrationVariancePercent: 2 });
    expect(result.status).toBe("recalibration_recommended");
  });
});

describe("billing and provenance boundaries", () => {
  it("prefers certified scale over calibrated LoadSense over estimates", () => {
    const best = selectPreferredWeightSource([
      { id: 1, measurementSource: "estimated" as const },
      { id: 2, measurementSource: "loadsense_calibrated" as const },
      { id: 3, measurementSource: "certified_scale" as const },
    ]);
    expect(best?.id).toBe(3);
  });

  it("will not auto-bill from onboard weight when certified trade scale is required", () => {
    expect(assessBillingUse({ source: "loadsense_calibrated", stable: true, requiresCertifiedTradeScale: true }).allowed).toBe(false);
  });

  it("requires a stable reading for calibrated LoadSense billing", () => {
    expect(assessBillingUse({ source: "loadsense_calibrated", stable: false, requiresCertifiedTradeScale: false }).allowed).toBe(false);
  });

  it("flags suspension/sensor work as a calibration review trigger", () => {
    expect(calibrationInvalidationReason({ levelingValveChanged: true, sensorReplaced: true })).toMatch(/calibration review required/i);
  });
});
