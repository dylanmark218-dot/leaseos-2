// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B25 — action safety, and a board at full size.
 */
import { describe, expect, it, vi } from "vitest";
import { submitBoardAction, openBoard, type WidgetLayoutStore } from "./_core/widgetService";
import { planBoard, runBoard, sourceKeyOf, type LayoutItem } from "./_core/widgetDashboard";
import { blocked, ok, unknown, type Provenance, type WidgetPayload } from "./_core/widgetPayload";
import { planGrid } from "../client/src/widgets/gridPlan";
import { buildDeviceManifest, WIDGET_RUNTIME_VERSION } from "./_core/deviceManifest";
import type { RoleActor } from "./_core/roleActor";

const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: new Date() };

const DRIVER: RoleActor = {
  userId: 77, tenantId: "ORG-A", roleKey: "DRIVER", roles: ["DRIVER"],
  permissions: ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "sync.push_own", "trip.read", "readiness.read",
    "compliance.read", "dispatch.release"],
};

describe("a widget's button is not an authorization", () => {
  it("refuses when the gate now says blocked, however green the tile was", async () => {
    // The tile said clear when it was drawn.
    const tile = ok("clear", prov);
    expect(tile.state).toBe("ok");

    // The condition changed between the read and the tap.
    const gate = vi.fn(async () => [
      { code: "NO_RELEASE", detail: "Critical defect DEF-4471 has no mechanic release" },
    ]);
    const outcome = await submitBoardAction({ gate }, DRIVER, {
      action: "dispatch.release", subjectRef: "UNIT-114", requiredPermission: "dispatch.release",
    });

    expect(outcome).toMatchObject({ ok: false, code: "BLOCKED" });
    if (outcome.ok) return;
    expect(outcome.blockers[0]?.code).toBe("NO_RELEASE");
  });

  it("never consults the tile's own state", async () => {
    const gate = vi.fn(async () => []);
    await submitBoardAction({ gate }, DRIVER, {
      action: "dispatch.release", subjectRef: "UNIT-114", requiredPermission: "dispatch.release",
    });
    // The gate is given the actor, the action and the subject. Not the payload.
    const args = gate.mock.calls.at(0)?.at(0) as Record<string, unknown> | undefined;
    expect(Object.keys(args ?? {}).sort()).toEqual(["action", "actor", "subjectRef"]);
  });

  it("checks the acting role's permission before running the gate at all", async () => {
    const gate = vi.fn(async () => []);
    const outcome = await submitBoardAction({ gate }, DRIVER, {
      action: "billing.finalize", subjectRef: "INV-9", requiredPermission: "billing.finalize",
    });
    expect(outcome).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("allows the action only when the gate is clear now", async () => {
    const outcome = await submitBoardAction({ gate: async () => [] }, DRIVER, {
      action: "dispatch.release", subjectRef: "UNIT-114", requiredPermission: "dispatch.release",
    });
    expect(outcome).toMatchObject({ ok: true, action: "dispatch.release" });
  });
});

describe("a board at full size", () => {
  const PERMS = [...DRIVER.permissions, "dispatch.read", "job.read", "surface.exceptions.read"];
  const ctx = (connected = true) => ({
    permissions: PERMS, connected, implicitSubjects: { unit: "UNIT-1", job: "JOB-1", trip: "TRIP-1" },
  });

  /** 40 tiles: duplicated sources, unique sources, device-local, withheld, faults. */
  const synthetic = (): LayoutItem[] => {
    const items: LayoutItem[] = [];
    let p = 0;
    // 12 tiles over 3 shared dispatch/exception sources.
    for (let i = 0; i < 4; i++) {
      items.push({ instanceRef: `dup-disp-${i}`, widgetKey: "dispatchReadiness", variant: "status", position: p++ });
      items.push({ instanceRef: `dup-exc-${i}`, widgetKey: "exceptions", variant: "kpi", position: p++ });
      items.push({ instanceRef: `dup-inbox-${i}`, widgetKey: "inbox", variant: "queue", position: p++ });
    }
    // 8 unique subjects on one widget.
    for (let i = 0; i < 8; i++) {
      items.push({
        instanceRef: `unit-${i}`, widgetKey: "unitReadiness", variant: "status",
        subjectRef: `UNIT-${i}`, position: p++, spanColumns: i % 3 === 0 ? 2 : 1,
      });
    }
    // 8 device-local.
    for (let i = 0; i < 4; i++) {
      items.push({ instanceRef: `hos-${i}`, widgetKey: "hosRemaining", variant: i % 2 ? "kpi" : "gauge", position: p++ });
      items.push({ instanceRef: `sync-${i}`, widgetKey: "syncStatus", variant: "status", position: p++ });
    }
    // 6 with distinct options.
    for (let i = 0; i < 6; i++) {
      items.push({
        instanceRef: `docs-${i}`, widgetKey: "documentExpiry", variant: "list",
        options: { warnDays: (i + 1) * 10 }, position: p++,
      });
    }
    // 4 unregistered, 2 mixed-variant search/tracking.
    for (let i = 0; i < 4; i++) items.push({ instanceRef: `gone-${i}`, widgetKey: `retired${i}`, variant: "kpi", position: p++ });
    items.push({ instanceRef: "search-1", widgetKey: "search", variant: "form", position: p++ });
    items.push({ instanceRef: "track-1", widgetKey: "trackingLookup", variant: "timeline", position: p++ });
    return items;
  };

  const reader = () => {
    let reads = 0;
    const read = async (t: { widgetKey: string }): Promise<WidgetPayload<unknown>> => {
      reads++;
      if (t.widgetKey === "inbox") throw new Error("notification service unavailable");
      if (t.widgetKey === "dispatchReadiness") return blocked([{ code: "HOS", detail: "0h 40m to a break" }]);
      if (t.widgetKey === "search") return unknown("no verified axle limit loaded");
      return ok({ current: 3, max: 10 }, prov);
    };
    return { read, reads: () => reads };
  };

  it("has 40 tiles and reads far fewer sources", async () => {
    const items = synthetic();
    expect(items).toHaveLength(40);
    const plan = planBoard(items, ctx());
    const distinct = new Set(plan.tasks.map(sourceKeyOf)).size;
    const r = reader();
    await runBoard(plan, r.read);
    expect(r.reads()).toBe(distinct);
    // 3 shared server sources + 8 unit subjects + 1 HOS + 1 sync + 6 option
    // variants + search + tracking = 21 reads for 36 resolvable tiles. The four
    // hos tiles and four sync tiles collapse to one read each, which is the
    // point: four presentations of one local answer, not four computations.
    expect(plan.tasks).toHaveLength(36);
    expect(distinct).toBe(21);
    expect(distinct).toBeLessThan(plan.tasks.length);
  });

  it("returns exactly one tile per instance, in saved order", async () => {
    const items = synthetic();
    const plan = planBoard(items, ctx());
    const tiles = await runBoard(plan, reader().read);
    expect(tiles).toHaveLength(40);
    expect(new Set(tiles.map((t) => t.instanceRef)).size).toBe(40);
    expect(tiles.map((t) => t.instanceRef)).toEqual(items.map((i) => i.instanceRef));
  });

  it("is deterministic across runs", async () => {
    const items = synthetic();
    const a = await runBoard(planBoard(items, ctx()), reader().read);
    const b = await runBoard(planBoard(items, ctx()), reader().read);
    expect(a.map((t) => [t.instanceRef, t.payload.state])).toEqual(b.map((t) => [t.instanceRef, t.payload.state]));
  });

  it("isolates the faulting source to its own four tiles", async () => {
    const tiles = await runBoard(planBoard(synthetic(), ctx()), reader().read);
    const failed = tiles.filter((t) => t.payload.state === "failed");
    // 4 inbox tiles that threw, plus 4 unregistered widget keys.
    expect(failed).toHaveLength(8);
    expect(tiles.filter((t) => t.payload.state === "ok").length).toBeGreaterThan(20);
  });

  it("plans a grid for the same board without losing or reordering a tile", () => {
    const items = synthetic();
    const grid = planGrid(items, "desktop");
    expect(grid.tiles).toHaveLength(40);
    expect(grid.tiles.map((t) => t.instanceRef)).toEqual(items.map((i) => i.instanceRef));
    expect(grid.tiles.filter((t) => t.spanColumns === 2)).toHaveLength(3);
    expect(planGrid(items, "phone").tiles.every((t) => t.spanColumns === 1)).toBe(true);
  });

  it("issues device tasks for the eight device-local tiles and nothing else", () => {
    const plan = planBoard(synthetic(), ctx(false));
    const res = buildDeviceManifest(plan, DRIVER, WIDGET_RUNTIME_VERSION);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.tasks).toHaveLength(8);
    expect(new Set(res.manifest.tasks.map((t) => t.sourceType))).toEqual(new Set(["hos_log", "sync_queue"]));
  });

  it("keeps a withheld tile in place on a full board", async () => {
    const restricted = { ...ctx(), permissions: PERMS.filter((p) => p !== "surface.exceptions.read") };
    const plan = planBoard(synthetic(), restricted);
    const tiles = await runBoard(plan, reader().read);
    const withheld = tiles.filter((t) => t.payload.state === "not_permitted");
    expect(withheld).toHaveLength(4);
    // Position 1 in the saved board, still position 1 on screen.
    expect(tiles[1]?.instanceRef).toBe("dup-exc-0");
  });
});

describe("openBoard carries spans and options through to the board", () => {
  const store: WidgetLayoutStore = {
    findLayout: async () => ({
      layout: { layoutRef: "WL-1", userId: 77, roleKey: "DRIVER", deviceClass: "tablet", name: "B", isDefault: true },
      items: [
        { instanceRef: "a", widgetKey: "documentExpiry", variant: "list", position: 0, spanColumns: 2, spanRows: 1, options: { warnDays: 14 } },
        { instanceRef: "b", widgetKey: "hosRemaining", variant: "gauge", position: 1, spanColumns: 1, spanRows: 2, options: null },
      ],
    }),
    createLayout: async () => ({ layoutRef: "x" }),
    updateOwnedLayout: async () => ({ ok: true }),
  };

  it("hands the source the tile's validated options", async () => {
    const seen: (Readonly<Record<string, unknown>> | null)[] = [];
    await openBoard(
      { store, read: async (task) => { seen.push(task.options); return ok(1, prov); } },
      DRIVER, { deviceClass: "tablet" },
    );
    // Before B25 this was [null, null]: options died at planning.
    expect(seen).toContainEqual({ warnDays: 14 });
  });
});
