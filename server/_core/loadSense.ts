import { createHash } from "node:crypto";
import type { VehicleValues } from "./routeEvaluation";
import { authorityForWeightSource, measurementAuthorityRank } from "./measurementQuality";

export type WeightSource =
  | "estimated"
  | "driver_entered"
  | "loadsense_uncalibrated"
  | "loadsense_calibrated"
  | "certified_scale";

export type WeightConfidence = "low" | "medium" | "high" | "certified";

export type CalibrationPoint = {
  rawValue: number;
  knownWeightKg: number;
};

export type LinearCalibration = {
  slope: number;
  offset: number;
  pointCount: number;
  rSquared?: number;
};

export type StabilityInput = {
  speedKph?: number | null;
  pitchDeg?: number | null;
  rollDeg?: number | null;
  accelerationMps2?: number | null;
  pressureSamples?: number[];
};

export type StabilityPolicy = {
  maxSpeedKph: number;
  maxAbsPitchDeg: number;
  maxAbsRollDeg: number;
  maxAbsAccelerationMps2: number;
  maxPressureSpreadPercent: number;
};

export const DEFAULT_STABILITY_POLICY: StabilityPolicy = {
  maxSpeedKph: 1,
  maxAbsPitchDeg: 2.5,
  maxAbsRollDeg: 2.5,
  maxAbsAccelerationMps2: 0.75,
  maxPressureSpreadPercent: 2,
};

export type StabilityAssessment = {
  stable: boolean;
  score: number;
  reasons: string[];
};

export type AxleWeightInput = {
  axleGroupKey: string;
  label: string;
  weightKg: number;
  configuredLimitKg?: number | null;
  limitSource?: string | null;
  sourceChannels?: string[];
};

export type AxleWeightResult = AxleWeightInput & {
  percentOfLimit: number | null;
  remainingKg: number | null;
  status: "within" | "near_limit" | "over_limit" | "unknown_limit";
};

export type WeightSnapshotInput = {
  loadId: number;
  unitId: number;
  trailerId?: number | null;
  jobId?: number | null;
  tripId?: number | null;
  tareKg: number;
  axleGroups: AxleWeightInput[];
  measurementSource: WeightSource;
  calibrationId?: string | null;
  stability: StabilityAssessment;
  latitude?: number | null;
  longitude?: number | null;
  measuredAt: Date;
  nearLimitPercent?: number;
};

export type WeightSnapshotDraft = {
  tareKg: number;
  grossKg: number;
  payloadKg: number;
  measurementSource: WeightSource;
  confidence: WeightConfidence;
  stable: boolean;
  stabilityScore: number;
  axleGroups: AxleWeightResult[];
  limitingAxleGroup: AxleWeightResult | null;
  theoreticalGvwRemainingKg: number | null;
  shouldStopLoading: boolean;
  warnings: string[];
  payloadHash: string;
};

export type DensityProfile = {
  densityKgM3: number;
  source: string;
  verified: boolean;
  moistureAdjusted?: boolean;
};

export type DerivedVolume = {
  volumeM3: number;
  measurementKind: "derived_from_weight";
  source: string;
  verifiedDensity: boolean;
  note: string;
};

export function weightSourceRank(source: WeightSource) {
  return measurementAuthorityRank(authorityForWeightSource(source));
}

export function selectPreferredWeightSource<T extends { measurementSource: WeightSource }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => weightSourceRank(a.measurementSource) - weightSourceRank(b.measurementSource))[0];
}

export function fitTwoPointCalibration(a: CalibrationPoint, b: CalibrationPoint): LinearCalibration {
  if (!Number.isFinite(a.rawValue) || !Number.isFinite(b.rawValue) || !Number.isFinite(a.knownWeightKg) || !Number.isFinite(b.knownWeightKg)) {
    throw new Error("Calibration points must contain finite values");
  }
  if (a.rawValue === b.rawValue) throw new Error("Calibration raw values must be different");
  const slope = (b.knownWeightKg - a.knownWeightKg) / (b.rawValue - a.rawValue);
  if (slope <= 0) throw new Error("Calibration must produce a positive weight response");
  const offset = a.knownWeightKg - slope * a.rawValue;
  return { slope, offset, pointCount: 2 };
}

export function fitMultiPointCalibration(points: CalibrationPoint[]): LinearCalibration {
  if (points.length < 2) throw new Error("At least two calibration points are required");
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.rawValue, 0);
  const sy = points.reduce((s, p) => s + p.knownWeightKg, 0);
  const sxx = points.reduce((s, p) => s + p.rawValue * p.rawValue, 0);
  const sxy = points.reduce((s, p) => s + p.rawValue * p.knownWeightKg, 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) throw new Error("Calibration points do not span enough raw-value range");
  const slope = (n * sxy - sx * sy) / denom;
  if (slope <= 0) throw new Error("Calibration must produce a positive weight response");
  const offset = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((s, p) => s + (p.knownWeightKg - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.knownWeightKg - (slope * p.rawValue + offset)) ** 2, 0);
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, offset, pointCount: n, rSquared };
}

export function applyCalibration(rawValue: number, calibration: LinearCalibration): number {
  if (!Number.isFinite(rawValue)) throw new Error("Raw sensor value must be finite");
  return Math.max(0, calibration.slope * rawValue + calibration.offset);
}

function pressureSpreadPercent(samples: number[]) {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  if (Math.abs(mean) < 1e-9) return 0;
  const max = Math.max(...samples), min = Math.min(...samples);
  return Math.abs((max - min) / mean) * 100;
}

export function assessWeightStability(input: StabilityInput, policy: StabilityPolicy = DEFAULT_STABILITY_POLICY): StabilityAssessment {
  const reasons: string[] = [];
  const speed = Math.abs(input.speedKph ?? 0);
  const pitch = Math.abs(input.pitchDeg ?? 0);
  const roll = Math.abs(input.rollDeg ?? 0);
  const accel = Math.abs(input.accelerationMps2 ?? 0);
  const spread = pressureSpreadPercent(input.pressureSamples ?? []);

  if (speed > policy.maxSpeedKph) reasons.push(`Vehicle speed ${speed.toFixed(1)} km/h exceeds stability threshold`);
  if (pitch > policy.maxAbsPitchDeg) reasons.push(`Pitch ${pitch.toFixed(1)}° exceeds stability threshold`);
  if (roll > policy.maxAbsRollDeg) reasons.push(`Roll ${roll.toFixed(1)}° exceeds stability threshold`);
  if (accel > policy.maxAbsAccelerationMps2) reasons.push(`Acceleration ${accel.toFixed(2)} m/s² exceeds stability threshold`);
  if (spread > policy.maxPressureSpreadPercent) reasons.push(`Pressure spread ${spread.toFixed(2)}% is still moving`);

  const fractions = [
    Math.min(1, speed / Math.max(policy.maxSpeedKph, 0.001)),
    Math.min(1, pitch / Math.max(policy.maxAbsPitchDeg, 0.001)),
    Math.min(1, roll / Math.max(policy.maxAbsRollDeg, 0.001)),
    Math.min(1, accel / Math.max(policy.maxAbsAccelerationMps2, 0.001)),
    Math.min(1, spread / Math.max(policy.maxPressureSpreadPercent, 0.001)),
  ];
  const score = Math.max(0, Math.min(1, 1 - fractions.reduce((a, b) => a + b, 0) / fractions.length));
  return { stable: reasons.length === 0, score: Number(score.toFixed(4)), reasons };
}

function axleResult(axle: AxleWeightInput, nearLimitPercent: number): AxleWeightResult {
  if (!Number.isFinite(axle.weightKg) || axle.weightKg < 0) throw new Error(`Invalid weight for ${axle.label}`);
  if (axle.configuredLimitKg === null || axle.configuredLimitKg === undefined || axle.configuredLimitKg <= 0) {
    return { ...axle, percentOfLimit: null, remainingKg: null, status: "unknown_limit" };
  }
  const percent = axle.weightKg / axle.configuredLimitKg * 100;
  const status = percent > 100 ? "over_limit" : percent >= nearLimitPercent ? "near_limit" : "within";
  return {
    ...axle,
    percentOfLimit: Number(percent.toFixed(2)),
    remainingKg: Number((axle.configuredLimitKg - axle.weightKg).toFixed(2)),
    status,
  };
}

function confidenceFor(source: WeightSource, stable: boolean): WeightConfidence {
  if (source === "certified_scale") return "certified";
  if (source === "loadsense_calibrated") return stable ? "high" : "medium";
  if (source === "driver_entered") return "medium";
  return "low";
}

export function buildWeightSnapshot(input: WeightSnapshotInput): WeightSnapshotDraft {
  if (!Number.isFinite(input.tareKg) || input.tareKg < 0) throw new Error("Tare must be a non-negative finite value");
  if (!input.axleGroups.length) throw new Error("At least one axle group is required");
  const nearLimitPercent = input.nearLimitPercent ?? 98;
  const axleGroups = input.axleGroups.map((a) => axleResult(a, nearLimitPercent));
  const grossKg = axleGroups.reduce((s, a) => s + a.weightKg, 0);
  const payloadKg = Math.max(0, grossKg - input.tareKg);
  const limited = axleGroups.filter((a) => a.configuredLimitKg && a.configuredLimitKg > 0);
  const limitingAxleGroup = limited.length
    ? [...limited].sort((a, b) => (b.percentOfLimit ?? 0) - (a.percentOfLimit ?? 0))[0]
    : null;
  const theoreticalGvwRemainingKg = limited.length
    ? Math.max(0, Math.min(...limited.map((a) => a.remainingKg ?? Number.POSITIVE_INFINITY)))
    : null;
  const warnings: string[] = [];
  for (const axle of axleGroups) {
    if (axle.status === "over_limit") warnings.push(`${axle.label} exceeds configured limit by ${Math.abs(axle.remainingKg ?? 0).toFixed(0)} kg`);
    if (axle.status === "near_limit") warnings.push(`${axle.label} is ${axle.percentOfLimit?.toFixed(1)}% of configured limit`);
    if (axle.status === "unknown_limit") warnings.push(`${axle.label} has no configured limit`);
  }
  if (!input.stability.stable) warnings.push(...input.stability.reasons);
  if (input.measurementSource === "loadsense_uncalibrated") warnings.push("LoadSense is not currently backed by a valid calibration");

  const stablePayload = JSON.stringify({
    loadId: input.loadId,
    unitId: input.unitId,
    trailerId: input.trailerId ?? null,
    measuredAt: input.measuredAt.toISOString(),
    tareKg: Number(input.tareKg.toFixed(3)),
    grossKg: Number(grossKg.toFixed(3)),
    payloadKg: Number(payloadKg.toFixed(3)),
    measurementSource: input.measurementSource,
    calibrationId: input.calibrationId ?? null,
    stable: input.stability.stable,
    axles: axleGroups.map((a) => [a.axleGroupKey, Number(a.weightKg.toFixed(3)), a.configuredLimitKg ?? null]),
  });

  return {
    tareKg: Number(input.tareKg.toFixed(3)),
    grossKg: Number(grossKg.toFixed(3)),
    payloadKg: Number(payloadKg.toFixed(3)),
    measurementSource: input.measurementSource,
    confidence: confidenceFor(input.measurementSource, input.stability.stable),
    stable: input.stability.stable,
    stabilityScore: input.stability.score,
    axleGroups,
    limitingAxleGroup,
    theoreticalGvwRemainingKg: theoreticalGvwRemainingKg === null ? null : Number(theoreticalGvwRemainingKg.toFixed(2)),
    shouldStopLoading: axleGroups.some((a) => a.status === "over_limit" || a.status === "near_limit"),
    warnings,
    payloadHash: createHash("sha256").update(stablePayload).digest("hex"),
  };
}

export function deriveVolumeFromWeight(payloadKg: number, density: DensityProfile): DerivedVolume {
  if (!Number.isFinite(payloadKg) || payloadKg < 0) throw new Error("Payload must be a non-negative finite value");
  if (!Number.isFinite(density.densityKgM3) || density.densityKgM3 <= 0) throw new Error("Density must be greater than zero");
  const volumeM3 = payloadKg / density.densityKgM3;
  return {
    volumeM3: Number(volumeM3.toFixed(3)),
    measurementKind: "derived_from_weight",
    source: density.source,
    verifiedDensity: density.verified,
    note: `Derived from ${payloadKg.toFixed(0)} kg using ${density.densityKgM3.toFixed(1)} kg/m³ density${density.moistureAdjusted ? " (moisture adjusted)" : ""}.`,
  };
}

export type ReconciliationPolicy = {
  reviewVariancePercent: number;
  recalibrationVariancePercent: number;
};

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = {
  reviewVariancePercent: 1,
  recalibrationVariancePercent: 2,
};

export function reconcileCertifiedScale(onboardGrossKg: number, certifiedGrossKg: number, policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY) {
  if (onboardGrossKg < 0 || certifiedGrossKg <= 0) throw new Error("Weights must be positive");
  const varianceKg = certifiedGrossKg - onboardGrossKg;
  const variancePercent = Math.abs(varianceKg) / certifiedGrossKg * 100;
  const status = variancePercent >= policy.recalibrationVariancePercent
    ? "recalibration_recommended"
    : variancePercent >= policy.reviewVariancePercent
      ? "review"
      : "within_tolerance";
  return {
    varianceKg: Number(varianceKg.toFixed(3)),
    variancePercent: Number(variancePercent.toFixed(4)),
    status: status as "within_tolerance" | "review" | "recalibration_recommended",
  };
}

export function calculateDeliveredMass(loadedGrossKg: number, postUnloadGrossKg: number) {
  if (loadedGrossKg < 0 || postUnloadGrossKg < 0) throw new Error("Weights must be non-negative");
  if (postUnloadGrossKg > loadedGrossKg) throw new Error("Post-unload gross cannot exceed loaded gross for this calculation");
  return Number((loadedGrossKg - postUnloadGrossKg).toFixed(3));
}

export function toRoutingVehicleValues(args: {
  snapshot: Pick<WeightSnapshotDraft, "grossKg" | "axleGroups">;
  heightM: number;
  widthM: number;
  lengthM: number;
  dangerousGoods: boolean;
  requiresEscort: boolean;
}): VehicleValues {
  const maxAxleGroupKg = Math.max(...args.snapshot.axleGroups.map((a) => a.weightKg));
  return {
    grossWeightKg: args.snapshot.grossKg,
    maxAxleGroupKg,
    heightM: args.heightM,
    widthM: args.widthM,
    lengthM: args.lengthM,
    dangerousGoods: args.dangerousGoods,
    requiresEscort: args.requiresEscort,
  };
}

export function assessBillingUse(args: {
  source: WeightSource;
  stable: boolean;
  requiresCertifiedTradeScale: boolean;
}) {
  if (args.requiresCertifiedTradeScale && args.source !== "certified_scale") {
    return { allowed: false, reason: "Contract or jurisdiction requires a certified trade-scale measurement." };
  }
  if (args.source === "loadsense_uncalibrated" || args.source === "estimated") {
    return { allowed: false, reason: "Measurement source is not suitable for automatic weight-based billing." };
  }
  if (args.source === "loadsense_calibrated" && !args.stable) {
    return { allowed: false, reason: "LoadSense measurement is not stable; stop on level ground and re-measure." };
  }
  return {
    allowed: true,
    reason: args.source === "certified_scale"
      ? "Certified scale evidence is available."
      : "Calibrated measurement may support billing when the customer contract permits onboard measurements.",
  };
}

export function calibrationInvalidationReason(input: {
  replacedAirBag?: boolean;
  levelingValveChanged?: boolean;
  suspensionGeometryChanged?: boolean;
  axleWork?: boolean;
  sensorReplaced?: boolean;
  severeSuspensionDamage?: boolean;
}) {
  const reasons = Object.entries(input).filter(([, value]) => value).map(([key]) => key.replace(/([A-Z])/g, " $1").toLowerCase());
  return reasons.length ? `Calibration review required after ${reasons.join(", ")}.` : null;
}

/* ------------------------------------------------------------------ */
/* P4.2 — a weight is not an axle determination                        */
/* ------------------------------------------------------------------ */

/**
 * Whether an onboard weight may be used as a **legal axle determination** — the number a carrier
 * would stand behind at a scale or in a prosecution.
 *
 * Until now this rule lived in a sentence: the ingest returns a note reading "Billing authority:
 * not_granted. Certified-scale authority: not_granted." That is true today and enforces nothing —
 * a string in a response cannot stop the next change from reading an axle row and treating it as
 * the legal figure, and nothing would fail when it did.
 *
 * Three conditions, and each one has cost somebody money somewhere:
 *
 *   **A calibration, current at the time of the reading.** An expired calibration is not a
 *   slightly worse one — the drift it was meant to correct is unbounded and unknown, and a number
 *   corrected by a stale model reads exactly like a number corrected by a good one.
 *
 *   **A stable reading.** A truck rolling, pitched on a lease approach, or with air still settling
 *   gives a number that is real and not a weight. Stability is already assessed; this is what makes
 *   the assessment binding.
 *
 *   **A source that can bear it.** An operator-entered figure and an estimate are legitimate for
 *   operations and cannot become a legal determination by passing through a calibration.
 *
 * Failing any of them is not an error. The weight remains perfectly good for loading decisions,
 * dispatch and the driver's own judgement — it is simply not the number to put in front of an
 * officer, and the refusal says which condition is missing so somebody can fix it.
 */
export type AxleDeterminationRefusalCode =
  | "NO_CALIBRATION" | "CALIBRATION_EXPIRED" | "CALIBRATION_INVALIDATED" | "CALIBRATION_NOT_YET_EFFECTIVE"
  | "READING_UNSTABLE" | "SOURCE_NOT_ELIGIBLE";

export type AxleDeterminationVerdict =
  | { legal: true; confidence: WeightConfidence; basis: string }
  | { legal: false; code: AxleDeterminationRefusalCode; reason: string; stillUsableFor: string };

/** Sources that can carry a legal determination at all, given everything else holds. */
const LEGALLY_ELIGIBLE_SOURCES: readonly WeightSource[] = ["certified_scale", "loadsense_calibrated"];

export function legalAxleDetermination(input: {
  source: WeightSource;
  /**
   * The calibration in force for this device, if any.
   *
   * `invalidatedAt` and `expiresAt` are kept apart deliberately. A calibration that lapsed was
   * fine and got old; one that was invalidated is one somebody withdrew, usually because it was
   * found wrong. Both refuse the determination, and a person chasing the refusal needs to know
   * which — "recalibrate the device" and "the last calibration was bad, check what it certified"
   * are different mornings.
   */
  calibration: { verifiedAt: Date; expiresAt: Date | null; invalidatedAt?: Date | null; status?: string } | null;
  stability: { stable: boolean; reasons: readonly string[] };
  readingAt: Date;
}): AxleDeterminationVerdict {
  const usable = "loading decisions, dispatch and the driver's own judgement";

  if (!LEGALLY_ELIGIBLE_SOURCES.includes(input.source)) {
    return {
      legal: false, code: "SOURCE_NOT_ELIGIBLE", stillUsableFor: usable,
      reason: `A ${input.source.replace(/_/g, " ")} figure cannot become a legal axle determination. Passing it through a calibration does not change what it is.`,
    };
  }
  // A certified scale is the determination; it does not need our calibration to be current.
  if (input.source !== "certified_scale") {
    if (!input.calibration) {
      return {
        legal: false, code: "NO_CALIBRATION", stillUsableFor: usable,
        reason: "No calibration is on file for this device, so there is nothing establishing what its raw reading means.",
      };
    }
    const cal = input.calibration;
    if (cal.verifiedAt > input.readingAt) {
      return {
        legal: false, code: "CALIBRATION_NOT_YET_EFFECTIVE", stillUsableFor: usable,
        reason: `The calibration takes effect ${cal.verifiedAt.toISOString().slice(0, 10)}, after this reading. A calibration cannot certify a number taken before it existed.`,
      };
    }
    if (cal.invalidatedAt && cal.invalidatedAt <= input.readingAt) {
      return {
        legal: false, code: "CALIBRATION_INVALIDATED", stillUsableFor: usable,
        reason: `The calibration was invalidated ${cal.invalidatedAt.toISOString().slice(0, 10)}, before this reading. Invalidated is not lapsed: somebody withdrew it, so what it certified is in question rather than merely old.`,
      };
    }
    if (cal.status != null && cal.status !== "active" && cal.status !== "current") {
      return {
        legal: false, code: "CALIBRATION_INVALIDATED", stillUsableFor: usable,
        reason: `The calibration model is ${cal.status}, not in force. A model that is not in force cannot carry a legal determination whatever its numbers say.`,
      };
    }
    if (input.calibration.expiresAt && input.calibration.expiresAt <= input.readingAt) {
      return {
        legal: false, code: "CALIBRATION_EXPIRED", stillUsableFor: usable,
        reason: `The calibration expired ${input.calibration.expiresAt.toISOString().slice(0, 10)}, before this reading. An expired calibration is not a slightly worse one: the drift it corrects is unbounded and unknown, and the corrected number looks identical either way.`,
      };
    }
  }
  if (!input.stability.stable) {
    return {
      legal: false, code: "READING_UNSTABLE", stillUsableFor: usable,
      reason: `The reading was not stable: ${input.stability.reasons.join("; ") || "stability could not be established"}. A truck still settling gives a number that is real and is not a weight.`,
    };
  }
  return {
    legal: true,
    confidence: confidenceFor(input.source, true),
    basis: input.source === "certified_scale"
      ? "Certified scale reading."
      : `Calibration verified ${input.calibration!.verifiedAt.toISOString().slice(0, 10)}${input.calibration!.expiresAt ? `, current to ${input.calibration!.expiresAt.toISOString().slice(0, 10)}` : ""}, on a stable reading.`,
  };
}
