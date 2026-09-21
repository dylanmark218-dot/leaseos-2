import { describe, expect, it } from "vitest";
import { buildLoadSenseEvent, LOADSENSE_EVENTS } from "./loadSenseEvents";

describe("LoadSense workflow event contract", () => {
  it("keeps measurement facts as domain events rather than workflow verdicts", () => {
    const event = buildLoadSenseEvent({ type: LOADSENSE_EVENTS.snapshotAccepted, loadId: 91, unitId: 218, snapshotId: "LWS-1", detail: { payloadKg: 25590 } });
    expect(event.aggregateType).toBe("load");
    expect(event.payload.snapshotId).toBe("LWS-1");
    expect(event).not.toHaveProperty("verdict");
  });
});
