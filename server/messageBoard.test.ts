/**
 * v22.20 — the board, and the three things a message must not become.
 */
import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGEMENT_REQUIRED, acknowledgementStatus, broadcast, broadcastReaches,
  ChannelViolation, mayOpen, post, suggestActions,
  type Channel, type Receipt, type Viewer,
} from "./_core/messageBoard";

const AT = new Date("2026-10-20T14:42:00Z");
const channel = (o: Partial<Channel> = {}): Channel => ({
  channelRef: "CH-ROAD", type: "road_conditions", name: "Road & Route Conditions",
  jobRef: null, clientRef: null, archived: false, ...o,
});
const message = (o: Partial<Parameters<typeof post>[0]> = {}) => post({
  messageRef: "MSG-1", channel: channel(), authorUserId: 7, authorRole: "driver",
  priority: "normal", body: "KM 42 west access washed out", deviceCreatedAt: AT, ...o,
});

describe("both clocks are kept", () => {
  it("records when the device saw it and leaves the server time null until it arrives", () => {
    const m = message({ deviceId: "TAB-9" });
    expect(m.deviceCreatedAt).toEqual(AT);
    expect(m.serverReceivedAt).toBeNull();
    expect(m.deviceId).toBe("TAB-9");
  });

  it("keeps the device time unchanged once the server receives it", () => {
    const arrived = new Date("2026-10-20T18:05:00Z");
    const m = message({ serverReceivedAt: arrived });
    // Overwriting the first loses the only record of when the driver saw it.
    expect(m.deviceCreatedAt).toEqual(AT);
    expect(m.serverReceivedAt).toEqual(arrived);
  });
});

describe("urgency is not optional", () => {
  it("derives acknowledgement from priority rather than letting a poster choose", () => {
    expect(message({ priority: "normal" }).requiresAcknowledgement).toBe(false);
    expect(message({ priority: "important" }).requiresAcknowledgement).toBe(false);
    expect(message({ priority: "urgent" }).requiresAcknowledgement).toBe(true);
    expect(message({ priority: "emergency" }).requiresAcknowledgement).toBe(true);
    expect([...ACKNOWLEDGEMENT_REQUIRED]).toEqual(["urgent", "emergency"]);
  });

  it("refuses a post to an archived channel and a client channel naming no client", () => {
    expect(() => message({ channel: channel({ archived: true }) })).toThrow(ChannelViolation);
    expect(() => message({ channel: channel({ type: "client", clientRef: null }) })).toThrow(/names no client/);
  });
});

describe("read is not acknowledged", () => {
  // Canonical lifecycle receipts: evidence lives in `at`, keyed by the state it
  // evidences. The board used to carry its own five-value shape here; 0097
  // removed it so there is one vocabulary.
  const receipt = (userId: number, o: Partial<Receipt> = {}): Receipt => ({
    messageRef: "MSG-1", userId, state: "delivered", at: { delivered: AT }, ...o,
  });

  it("separates those who read it without acknowledging from those it never reached", () => {
    const s = acknowledgementStatus("MSG-1", true, [
      receipt(1, { state: "acknowledged", at: { delivered: AT, opened: AT, acknowledged: AT } }),
      receipt(2, { state: "opened", at: { delivered: AT, opened: AT } }),
      receipt(3, { state: "queued_offline", at: {} }),
    ]);
    expect(s.acknowledged).toEqual([1]);
    expect(s.readNotAcknowledged).toEqual([2]);
    expect(s.neverDelivered).toEqual([3]);
    expect(s.outstanding).toBe(true);
    expect(s.line).toContain("1 read without acknowledging, 1 never reached");
  });

  it("is settled only when everybody has acknowledged", () => {
    const s = acknowledgementStatus("MSG-1", true, [receipt(1, { state: "acknowledged", at: { delivered: AT, opened: AT, acknowledged: AT } }), receipt(2, { state: "acknowledged", at: { delivered: AT, opened: AT, acknowledged: AT } })]);
    expect(s.outstanding).toBe(false);
    expect(s.line).toBe("all 2 acknowledged");
  });

  it("says so plainly when acknowledgement was never required", () => {
    expect(acknowledgementStatus("MSG-1", false, [receipt(1, { state: "opened", at: { delivered: AT, opened: AT } })]).line).toContain("(not required)");
  });
});

describe("a client channel is separated, not filtered", () => {
  const client: Viewer = { userId: 50, internal: false, clientRef: "CUST-9", roles: [] };
  const staff: Viewer = { userId: 7, internal: true, clientRef: null, roles: ["dispatcher"] };

  it("keeps an outside viewer out of every internal channel", () => {
    for (const type of ["dispatch", "safety", "maintenance", "general", "job", "private"] as const) {
      expect(mayOpen(channel({ type }), client).allowed).toBe(false);
    }
    expect(mayOpen(channel({ type: "dispatch" }), client).reason).toContain("not visible outside the company");
  });

  it("lets a client into their own channel and not another client's", () => {
    expect(mayOpen(channel({ type: "client", clientRef: "CUST-9" }), client).allowed).toBe(true);
    expect(mayOpen(channel({ type: "client", clientRef: "CUST-8" }), client))
      .toMatchObject({ allowed: false });
    expect(mayOpen(channel({ type: "client", clientRef: "CUST-8" }), client).reason).toContain("different client");
  });

  it("keeps a private management channel away from other internal staff", () => {
    expect(mayOpen(channel({ type: "private" }), staff).allowed).toBe(false);
    expect(mayOpen(channel({ type: "private" }), { ...staff, roles: ["management"] }).allowed).toBe(true);
  });
});

describe("a message proposes; it does not create a record", () => {
  const hints = [
    { pattern: /wire showing|shaking/i, action: "create_defect" as const, title: "Possible critical vehicle defect — create defect report?" },
    { pattern: /washed out|closure/i, action: "add_route_hazard" as const, title: "Add temporary route hazard?" },
    { pattern: /overflow/i, action: "create_incident" as const, title: "Create incident report?" },
  ];

  it("suggests a defect from a driver's description and creates nothing", () => {
    const m = message({ body: "My steer tire has wire showing and it's shaking pretty bad" });
    const [s] = suggestActions(m, hints);
    expect(s.action).toBe("create_defect");
    expect(s.performed).toBe(false);
    expect(s.note).toContain("the message is an observation, not a finding");
  });

  it("carries the driver's own words rather than an interpretation", () => {
    const body = "My steer tire has wire showing and it's shaking pretty bad";
    const [s] = suggestActions(message({ body }), hints);
    expect(s.fromMessage).toBe(body);
  });

  it("suggests nothing when nothing matches, rather than guessing", () => {
    expect(suggestActions(message({ body: "Back at the yard, see you tomorrow" }), hints)).toEqual([]);
  });

  it("can suggest more than one, leaving the choice to a person", () => {
    const m = message({ body: "Tank overflowed and the road is washed out" });
    expect(suggestActions(m, hints).map(s => s.action).sort()).toEqual(["add_route_hazard", "create_incident"]);
  });
});

describe("emergency broadcast", () => {
  const emergency = () => message({ priority: "emergency", body: "Highway 40 closed at KM 73" });

  it("refuses anything short of an emergency", () => {
    expect(() => broadcast({ message: message({ priority: "urgent" }), target: { kind: "company" } }))
      .toThrow(/anything less goes to a channel/);
  });

  it("stays pinned until somebody clears it", () => {
    const b = broadcast({ message: emergency(), target: { kind: "company" } });
    expect(b.pinnedUntilCleared).toBe(true);
    expect(b.clearedAt).toBeNull();
  });

  it("reaches only what the target names", () => {
    const person = { branchRef: "B-NORTH", jobRefs: ["J-1"], unitRef: "UNIT-127" };
    expect(broadcastReaches({ kind: "company" }, person)).toBe(true);
    expect(broadcastReaches({ kind: "branch", branchRef: "B-NORTH" }, person)).toBe(true);
    expect(broadcastReaches({ kind: "branch", branchRef: "B-SOUTH" }, person)).toBe(false);
    expect(broadcastReaches({ kind: "job", jobRef: "J-1" }, person)).toBe(true);
    expect(broadcastReaches({ kind: "units", unitRefs: ["UNIT-127"] }, person)).toBe(true);
    expect(broadcastReaches({ kind: "units", unitRefs: ["UNIT-999"] }, person)).toBe(false);
  });

  it("does not reach somebody with no unit when the target names units", () => {
    expect(broadcastReaches({ kind: "units", unitRefs: ["UNIT-127"] }, { branchRef: null, jobRefs: [], unitRef: null })).toBe(false);
  });
});
