import { describe, expect, it } from "vitest";
import { detectSequenceGaps, mergeGatewayFrames, validateGatewayFrame, type LoadSenseGatewayFrame } from "./loadSenseProtocol";

const frame = (sequence: number, buffered = false): LoadSenseGatewayFrame => ({
  protocol: "leaseos.loadsense.v1", gatewayDeviceId: "GW-218", sequence,
  measuredAt: `2026-09-05T12:00:${String(sequence).padStart(2, "0")}Z`, buffered,
  readings: { drivePsi: 40 + sequence }, vehicle: { speedKph: 0 },
});

describe("LoadSense gateway protocol", () => {
  it("rejects malformed frames instead of guessing", () => {
    const result = validateGatewayFrame({ protocol: "other", sequence: -1, readings: { x: "bad" } });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(2);
  });

  it("deduplicates buffered replay by gateway and sequence", () => {
    const result = mergeGatewayFrames([frame(1, true)], [frame(1, false), frame(2, true)]);
    expect(result).toHaveLength(2);
    expect(result[0].buffered).toBe(false);
  });

  it("reports missing gateway sequence ranges", () => {
    expect(detectSequenceGaps([frame(1), frame(2), frame(5)])).toEqual([{ gatewayDeviceId: "GW-218", from: 3, to: 4 }]);
  });
});
