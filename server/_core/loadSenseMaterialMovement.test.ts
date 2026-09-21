import { describe, expect, it } from "vitest";
import { buildManifestWeightEvidence, buildTonneBillingCandidate, compareLoadToUnload, validateSplitLoad } from "./loadSenseMaterialMovement";

const evidence = {
  loadNumber: "LD-2026-009174", loadId: 9174, jobId: 1, tripId: 2, unitId: 218, trailerId: 67,
  material: "gravel", grossKg: 46940, tareKg: 21350, payloadKg: 25590,
  source: "loadsense_calibrated" as const, snapshotId: "LWS-1", calibrationId: "CAL-1",
  measuredAt: "2026-09-05T12:00:00Z", axleGroups: [{ axleGroupKey: "drive", weightKg: 17920 }],
};

describe("LoadSense material movement chain", () => {
  it("uses the same snapshot identity in manifest evidence", () => {
    expect(buildManifestWeightEvidence(evidence).measurement.snapshotId).toBe("LWS-1");
  });
  it("builds tonnes from measured payload without copying a separate quantity", () => {
    const line = buildTonneBillingCandidate(evidence);
    expect(line.quantity).toBe(25.59);
    expect(line.sourceSnapshotId).toBe("LWS-1");
  });
  it("supports split deliveries and checks conservation of the original load", () => {
    const result = validateSplitLoad(28000, [{ destinationId: "A", deliveredKg: 12200 }, { destinationId: "B", deliveredKg: 15800 }]);
    expect(result.withinTolerance).toBe(true);
    expect(result.differenceKg).toBe(0);
  });
  it("flags a load/unload discrepancy without silently correcting either measurement", () => {
    const result = compareLoadToUnload(25590, 25450);
    expect(result.differenceKg).toBe(140);
    expect(result.direction).toBe("less_delivered");
  });
});
