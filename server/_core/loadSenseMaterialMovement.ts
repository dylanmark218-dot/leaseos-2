import type { WeightSource } from "./loadSense";

export type MaterialMovementEvidence = {
  loadNumber: string;
  loadId: number;
  jobId?: number;
  tripId?: number;
  unitId: number;
  trailerId?: number | null;
  material?: string | null;
  grossKg: number;
  tareKg: number;
  payloadKg: number;
  source: WeightSource;
  snapshotId: string;
  calibrationId?: string | null;
  measuredAt: string;
  latitude?: number | null;
  longitude?: number | null;
  axleGroups: Array<{ axleGroupKey: string; weightKg: number }>;
};

export function buildManifestWeightEvidence(input: MaterialMovementEvidence) {
  return {
    loadNumber: input.loadNumber,
    measurement: {
      grossWeightKg: input.grossKg,
      tareWeightKg: input.tareKg,
      netPayloadKg: input.payloadKg,
      measurementSource: input.source,
      measuredAt: input.measuredAt,
      calibrationId: input.calibrationId ?? null,
      snapshotId: input.snapshotId,
      axleGroups: input.axleGroups,
    },
    provenance: {
      unitId: input.unitId,
      trailerId: input.trailerId ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    },
  };
}

export function buildTonneBillingCandidate(input: MaterialMovementEvidence) {
  return {
    loadId: input.loadId,
    sourceTrackingNumber: input.loadNumber,
    quantity: Number((input.payloadKg / 1000).toFixed(3)),
    quantityUnit: "t",
    measurementMethod: input.source === "loadsense_calibrated"
      ? "loadsense_calibrated"
      : input.source === "certified_scale"
        ? "scale"
        : input.source === "loadsense_uncalibrated"
          ? "loadsense_uncalibrated"
          : "unknown",
    sourceSnapshotId: input.snapshotId,
  } as const;
}

export type DeliveryLeg = { destinationId: string; deliveredKg: number };

export function validateSplitLoad(originalPayloadKg: number, legs: DeliveryLeg[], toleranceKg = 25) {
  if (originalPayloadKg < 0) throw new Error("Original payload must be non-negative");
  if (legs.some((leg) => leg.deliveredKg < 0)) throw new Error("Delivered quantities must be non-negative");
  const deliveredKg = legs.reduce((s, leg) => s + leg.deliveredKg, 0);
  const differenceKg = originalPayloadKg - deliveredKg;
  return {
    originalPayloadKg,
    deliveredKg: Number(deliveredKg.toFixed(3)),
    differenceKg: Number(differenceKg.toFixed(3)),
    withinTolerance: Math.abs(differenceKg) <= toleranceKg,
  };
}

export function compareLoadToUnload(originalPayloadKg: number, deliveredKg: number) {
  if (originalPayloadKg <= 0 || deliveredKg < 0) throw new Error("Weights are invalid");
  const differenceKg = originalPayloadKg - deliveredKg;
  return {
    differenceKg: Number(differenceKg.toFixed(3)),
    differencePercent: Number((Math.abs(differenceKg) / originalPayloadKg * 100).toFixed(4)),
    direction: differenceKg > 0 ? "less_delivered" : differenceKg < 0 ? "more_delivered" : "matched",
  } as const;
}
