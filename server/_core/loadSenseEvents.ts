export const LOADSENSE_EVENTS = {
  snapshotAccepted: "loadsense.snapshot_accepted",
  axleNearLimit: "loadsense.axle_near_limit",
  configuredLimitExceeded: "loadsense.configured_limit_exceeded",
  calibrationReviewRequired: "loadsense.calibration_review_required",
  certifiedVarianceDetected: "loadsense.certified_variance_detected",
  gatewayOffline: "loadsense.gateway_offline",
  loadMaterialMeasured: "load.material_measured",
  loadDiscrepancyDetected: "load.measurement_discrepancy_detected",
} as const;

export type LoadSenseEventType = typeof LOADSENSE_EVENTS[keyof typeof LOADSENSE_EVENTS];

export function buildLoadSenseEvent(args: {
  type: LoadSenseEventType;
  loadId?: number;
  unitId?: number;
  snapshotId?: string;
  calibrationId?: string | null;
  detail: Record<string, unknown>;
}) {
  return {
    eventType: args.type,
    aggregateType: args.loadId ? "load" : args.unitId ? "unit" : "loadsense",
    aggregateId: String(args.loadId ?? args.unitId ?? args.snapshotId ?? "unknown"),
    unitId: args.unitId ? String(args.unitId) : undefined,
    payload: {
      snapshotId: args.snapshotId ?? null,
      calibrationId: args.calibrationId ?? null,
      ...args.detail,
    },
  };
}
