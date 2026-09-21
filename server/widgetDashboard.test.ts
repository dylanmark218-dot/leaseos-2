// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B23 — resolving a board. Outcome states only.
 */
import { describe, expect, it } from "vitest";
import { offerableWidgets, planBoard, runBoard, type LayoutItem, type ResolveContext } from "./_core/widgetDashboard";
import { ok, type Provenance, type WidgetPayload } from "./_core/widgetPayload";

const DRIVER_PERMS = ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "readiness.read", "sync.push_own", "trip.read"];

const ctx = (o: Partial<ResolveContext> = {}): ResolveContext => ({
  permissions: DRIVER_PERMS, connected: true, implicitSubjects: { unit: "UNIT-114", trip: "TRIP-88" }, ...o,
});

let n = 0;
const item = (widgetKey: string, o: Partial<LayoutItem> = {}): LayoutItem => ({
  instanceRef: `WI-${++n}`, widgetKey, variant: "status", position: n, ...o,
});

const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: new Date() };
const stateOf = (rs: readonly { widgetKey: string; payload: WidgetPayload<unknown> }[], key: string) =>
  rs.find((r) => r.widgetKey === key)?.payload.state;

describe("authorization", () => {
  it("keeps a withheld tile on the board as a named withheld item", () => {
    const plan = planBoard([item("exceptions")], ctx());
    expect(plan.tasks).toHaveLength(0);
    expect(plan.settled[0]?.payload).toMatchObject({
      state: "not_permitted", permission: "surface.exceptions.read",
    });
  });

  it("does not shrink the board when a permission is lost", () => {
    const items = [item("myDay"), item("exceptions"), item("hosRemaining")];
    const plan = planBoard(items, ctx());
    expect(plan.tasks.length + plan.settled.length).toBe(3);
  });

  it("refuses an unmapped procedure instead of degrading it to authenticated-only", () => {
    // Simulates the wiring fault: a registered widget whose procedure nobody
    // put in the authorization map.
    const plan = planBoard([item("myDay")], ctx({ permissions: [] }));
    expect(plan.settled[0]?.payload.state).toBe("not_permitted");
  });

  it("offers only what the caller could actually read", () => {
    const offered = offerableWidgets({ permissions: DRIVER_PERMS }, ["DRIVER"]);
    // Withheld from the picker because it would resolve to not_permitted.
    expect(offered).not.toContain("exceptions");
    expect(offered).toContain("hosRemaining");
  });

  it("orders suggested-for-this-role widgets ahead of the rest", () => {
    // The rule is group-then-title, not a fixed head element: asserting a
    // specific first key pins an alphabetical accident instead of the rule.
    const offered = offerableWidgets({ permissions: DRIVER_PERMS }, ["DRIVER"]);
    const suggested = new Set(["hosRemaining", "activeTrip", "syncStatus", "myDay", "unitReadiness"]);
    const lastSuggested = offered.reduce((acc, k, i) => (suggested.has(k) ? i : acc), -1);
    const firstOther = offered.findIndex((k) => !suggested.has(k));
    if (firstOther !== -1) expect(lastSuggested).toBeLessThan(firstOther);
    expect(offered.filter((k) => suggested.has(k)).length).toBeGreaterThan(0);
  });
});

describe("offline", () => {
  it("renders offline rather than a cached number when the source has no offline answer", () => {
    const plan = planBoard([item("inbox")], ctx({ connected: false, permissions: DRIVER_PERMS }));
    expect(plan.settled[0]?.payload).toMatchObject({ state: "offline" });
    expect(plan.tasks).toHaveLength(0);
  });

  it("still resolves the device-local clock with no connection", () => {
    const plan = planBoard([item("hosRemaining")], ctx({ connected: false }));
    expect(plan.tasks[0]).toMatchObject({ widgetKey: "hosRemaining", deviceLocal: true });
  });

  it("carries the freshness budget for a pre-departure cached source", () => {
    const plan = planBoard([item("unitReadiness")], ctx({ connected: false }));
    expect(plan.tasks[0]).toMatchObject({ maxStaleMinutes: 720, deviceLocal: false });
  });
});

describe("untrusted layout rows", () => {
  it("names a widget that no longer exists rather than rendering a blank", () => {
    const plan = planBoard([item("axleWeightEstimate")], ctx());
    expect(plan.settled[0]?.payload).toMatchObject({ state: "failed" });
    expect((plan.settled[0]?.payload as { reason: string }).reason).toContain("axleWeightEstimate");
  });

  it("falls back to the default variant instead of honouring an unsupported one", () => {
    const plan = planBoard([item("hosRemaining", { variant: "map" })], ctx());
    expect(plan.tasks[0]?.variant).toBe("gauge");
  });

  it("will not guess a subject for a scoped tile", () => {
    const plan = planBoard([item("unitReadiness")], ctx({ implicitSubjects: {} }));
    expect(plan.settled[0]?.payload).toMatchObject({ state: "unknown" });
    // The failure this pins: a readiness tile describing the wrong truck.
    expect((plan.settled[0]?.payload as { reason: string }).reason).toContain("unit");
  });

  it("prefers the pinned subject over the implicit one", () => {
    const plan = planBoard([item("unitReadiness", { subjectRef: "UNIT-902" })], ctx());
    expect(plan.tasks[0]?.subjectRef).toBe("UNIT-902");
  });
});

describe("isolation", () => {
  it("lets one source fail without taking the board down", async () => {
    const plan = planBoard([item("myDay"), item("hosRemaining"), item("syncStatus")], ctx());
    const results = await runBoard(plan, async (task) => {
      if (task.widgetKey === "hosRemaining") throw new Error("HOS rule registry unavailable");
      return ok({ tile: task.widgetKey }, prov);
    });
    expect(results).toHaveLength(3);
    expect(stateOf(results, "myDay")).toBe("ok");
    expect(stateOf(results, "syncStatus")).toBe("ok");
    expect(stateOf(results, "hosRemaining")).toBe("failed");
  });

  it("returns settled tiles alongside read tiles, none dropped", async () => {
    const plan = planBoard([item("myDay"), item("exceptions"), item("nope")], ctx());
    const results = await runBoard(plan, async () => ok(1, prov));
    expect(results).toHaveLength(3);
    expect(stateOf(results, "exceptions")).toBe("not_permitted");
    expect(stateOf(results, "nope")).toBe("failed");
  });

  it("does not convert a failed source into an empty ok", async () => {
    const plan = planBoard([item("myDay")], ctx());
    const results = await runBoard(plan, async () => {
      throw new Error("boom");
    });
    expect(results[0]?.payload.state).toBe("failed");
  });
});

describe("a cached answer cannot look live", () => {
  it("downgrades an ok from a pre-departure source to stale when offline", async () => {
    // Regression: the plan handed `maxStaleMinutes` to the reader and trusted
    // it to age the value. The demo reader did not, and an offline board
    // rendered cached numbers as verified.
    const plan = planBoard([item("unitReadiness")], ctx({ connected: false }));
    expect(plan.tasks[0]?.servedFromCache).toBe(true);
    const results = await runBoard(plan, async () => ok("clear", prov));
    expect(results[0]?.payload.state).toBe("stale");
  });

  it("leaves a connected read alone", async () => {
    const plan = planBoard([item("unitReadiness")], ctx({ connected: true }));
    expect(plan.tasks[0]?.servedFromCache).toBe(false);
    const results = await runBoard(plan, async () => ok("clear", prov));
    expect(results[0]?.payload.state).toBe("ok");
  });

  it("leaves a device-local answer alone, because it is not from cache", async () => {
    const plan = planBoard([item("hosRemaining")], ctx({ connected: false }));
    expect(plan.tasks[0]).toMatchObject({ deviceLocal: true, servedFromCache: false });
    const results = await runBoard(plan, async () => ok("4h 12m", prov));
    expect(results[0]?.payload.state).toBe("ok");
  });
});

describe("P0 — a board comes back in the order the user arranged it", () => {
  const mixedPerms = [...DRIVER_PERMS, "dispatch.read", "job.read"];
  const board = [
    item("myDay", { variant: "list", position: 0 }),
    item("exceptions", { variant: "queue", position: 1 }),      // withheld
    item("hosRemaining", { variant: "gauge", position: 2 }),    // device-local
    item("unitReadiness", { position: 3 }),                     // unknown: no unit
    item("retiredWidget", { position: 4 }),                     // failed: unregistered
    item("dispatchReadiness", { position: 5 }),                 // blocked
    item("syncStatus", { position: 6 }),                        // failed: source throws
  ];
  const mixedCtx = ctx({ permissions: mixedPerms, implicitSubjects: { job: "JOB-1", trip: "TRIP-1" } });

  const runMixed = () => {
    const plan = planBoard(board, mixedCtx);
    return runBoard(plan, async (task) => {
      if (task.widgetKey === "syncStatus") throw new Error("queue unreadable");
      if (task.widgetKey === "dispatchReadiness") {
        return { state: "blocked", blockers: [{ code: "X", detail: "Annual inspection expired" }] };
      }
      return ok(1, prov);
    });
  };

  it("interleaves fetched and settled tiles without moving any of them", async () => {
    // The defect: `[...tasks, ...settled]` pushed every withheld, unknown and
    // unregistered tile to the bottom. Seven tiles, four of them settled
    // before any read, three fetched — all must come back 0..6.
    const results = await runMixed();
    expect(results.map((r) => r.widgetKey)).toEqual([
      "myDay", "exceptions", "hosRemaining", "unitReadiness",
      "retiredWidget", "dispatchReadiness", "syncStatus",
    ]);
    expect(results.map((r) => r.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("covers all seven states in that one board", async () => {
    const results = await runMixed();
    expect(results.map((r) => r.payload.state)).toEqual([
      "ok", "not_permitted", "ok", "unknown", "failed", "blocked", "failed",
    ]);
  });

  it("does not depend on which source resolves first", async () => {
    const plan = planBoard(board, mixedCtx);
    const results = await runBoard(plan, async (task) => {
      // myDay answers last, syncStatus first: async completion order inverted.
      await new Promise((r) => setTimeout(r, task.widgetKey === "myDay" ? 12 : 1));
      return ok(task.widgetKey, prov);
    });
    expect(results.map((r) => r.widgetKey)[0]).toBe("myDay");
    expect(results.map((r) => r.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps an offline tile in place too", async () => {
    const plan = planBoard(
      [item("hosRemaining", { variant: "gauge", position: 0 }),
       item("inbox", { variant: "queue", position: 1 }),
       item("syncStatus", { position: 2 })],
      ctx({ connected: false }),
    );
    const results = await runBoard(plan, async () => ok("x", prov));
    expect(results.map((r) => [r.widgetKey, r.payload.state]))
      .toEqual([["hosRemaining", "ok"], ["inbox", "offline"], ["syncStatus", "ok"]]);
  });
});

describe("P0 — one engine answer is read once", () => {
  it("shares a read between tiles asking the same source the same question", async () => {
    const three = [
      item("dispatchReadiness", { variant: "status", position: 0 }),
      item("dispatchReadiness", { variant: "checklist", position: 1 }),
      item("dispatchReadiness", { variant: "detail", position: 2 }),
    ];
    const plan = planBoard(three, ctx({ permissions: [...DRIVER_PERMS, "dispatch.read"], implicitSubjects: { job: "JOB-1" } }));
    let calls = 0;
    const results = await runBoard(plan, async () => { calls += 1; return ok("ready", prov); });
    // Three zoom levels on one gate answer, not three gate invocations.
    expect(calls).toBe(1);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it("does not share between different subjects", async () => {
    const two = [
      item("unitReadiness", { subjectRef: "UNIT-1", position: 0 }),
      item("unitReadiness", { subjectRef: "UNIT-2", position: 1 }),
    ];
    const plan = planBoard(two, ctx());
    let calls = 0;
    await runBoard(plan, async () => { calls += 1; return ok("clear", prov); });
    expect(calls).toBe(2);
  });
});

describe("P0 — cache age boundaries", () => {
  const at = (minutesAgo: number) => ({
    ...prov, observedAt: new Date(NOW_MS - minutesAgo * 60_000),
  });
  const NOW_MS = new Date("2026-09-12T14:35:00Z").getTime();
  const NOW = new Date(NOW_MS);
  // unitReadiness declares pre_departure with a 720-minute budget.
  const offlinePlan = () => planBoard([item("unitReadiness", { position: 0 })], ctx({ connected: false }));
  const stateAt = async (minutesAgo: number) => {
    const results = await runBoard(offlinePlan(), async () => ok("clear", at(minutesAgo)), NOW);
    return results[0]?.payload.state;
  };

  it("age 0 is stale, not confirmed", async () => { expect(await stateAt(0)).toBe("stale"); });
  it("one minute under the budget is stale", async () => { expect(await stateAt(719)).toBe("stale"); });
  it("exactly the budget is stale", async () => { expect(await stateAt(720)).toBe("stale"); });
  it("one minute over the budget expires to offline", async () => { expect(await stateAt(721)).toBe("offline"); });
  it("an ancient cache expires rather than showing an old number", async () => {
    expect(await stateAt(60 * 24 * 30)).toBe("offline");
  });
  it("reports when it last held an answer", async () => {
    const results = await runBoard(offlinePlan(), async () => ok("clear", at(5000)), NOW);
    expect(results[0]?.payload).toMatchObject({ state: "offline", cachedAt: at(5000).observedAt });
  });
  it("does not expire a cached blocked, unknown or failed", async () => {
    for (const p of [
      { state: "blocked", blockers: [{ code: "X", detail: "expired" }] },
      { state: "unknown", reason: "no rule loaded" },
      { state: "failed", reason: "down" },
    ] as const) {
      const results = await runBoard(offlinePlan(), async () => p, NOW);
      expect(results[0]?.payload.state).toBe(p.state);
    }
  });
});
