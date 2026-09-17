// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B23 — the board service, against a fake store.
 */
import { describe, expect, it, vi } from "vitest";
import {
  listOfferable, openBoard, saveBoard,
  type StoredLayout, type WidgetLayoutStore,
} from "./_core/widgetService";
import { ok, type Provenance } from "./_core/widgetPayload";
import type { LayoutItem } from "./_core/widgetDashboard";
import type { NormalizedItem } from "./_core/widgetLayoutWrite";

const DRIVER_PERMS = ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "readiness.read", "sync.push_own", "trip.read"];
const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: new Date() };

/** An actor for one role, as `actorForRole` would build it. */
const ctx = (o: Record<string, unknown> = {}) => ({
  userId: 77, tenantId: "ORG-A", roleKey: "DRIVER",
  permissions: DRIVER_PERMS, roles: ["DRIVER"], ...o,
} as Parameters<typeof openBoard>[1]);

const device = { deviceClass: "phone" as const, subjects: { unit: "UNIT-114", trip: "TRIP-88" } };

/** In-memory store. One layout, so a round trip is observable. */
function fakeStore(seed?: { layout: StoredLayout; items: readonly LayoutItem[] }) {
  let held = seed ?? null;
  const unsets: boolean[] = [];
  let nextRef = 1;
  const store: WidgetLayoutStore = {
    findLayout: async (q) =>
      held && held.layout.userId === q.userId && held.layout.roleKey === q.roleKey ? held : null,
    createLayout: async (layout, items: readonly NormalizedItem[], unsetOtherDefaults) => {
      unsets.push(unsetOtherDefaults);
      const layoutRef = `WL-NEW-${nextRef++}`;
      held = { layout: { ...layout, layoutRef }, items: items.map((i) => ({ ...i })) };
      return { layoutRef };
    },
    updateOwnedLayout: async (layout, items: readonly NormalizedItem[], unsetOtherDefaults) => {
      // The fake enforces ownership too, so a service test cannot pass by
      // leaning on a store that does not.
      if (!held || held.layout.userId !== layout.userId || held.layout.layoutRef !== layout.layoutRef) {
        return { ok: false };
      }
      unsets.push(unsetOtherDefaults);
      held = { layout, items: items.map((i) => ({ ...i })) };
      return { ok: true };
    },
  };
  return { store, unsets, peek: () => held };
}

describe("opening a board", () => {
  it("seeds from the registry when nothing is saved, and says it did", async () => {
    const { store, peek } = fakeStore();
    const board = await openBoard({ store, read: async () => ok(1, prov) }, ctx(), device);
    expect(board.seeded).toBe(true);
    expect(board.layoutRef).toBeNull();
    expect(board.tiles.length).toBeGreaterThan(0);
    // A read writes nothing.
    expect(peek()).toBeNull();
  });

  it("returns the saved board once one exists", async () => {
    const { store } = fakeStore({
      layout: { layoutRef: "WL-9", userId: 77, roleKey: "DRIVER", deviceClass: "phone", name: "Yard", isDefault: true },
      items: [{ instanceRef: "WI-1", widgetKey: "hosRemaining", variant: "gauge", position: 0 }],
    });
    const board = await openBoard({ store, read: async () => ok("4h 12m", prov) }, ctx(), device);
    expect(board).toMatchObject({ seeded: false, layoutRef: "WL-9", name: "Yard" });
    expect(board.tiles).toHaveLength(1);
    expect(board.tiles[0]).toMatchObject({ title: "Hours Remaining", variant: "gauge" });
  });

  it("computes the appearance server-side so a client cannot invent its own rules", async () => {
    const { store } = fakeStore();
    const board = await openBoard(
      { store, read: async () => ok("31,500 kg", { ...prov, verification: "unverified" }) },
      ctx(), device,
    );
    expect(board.tiles[0]?.appearance).toMatchObject({ tone: "provisional", actionable: false });
  });

  it("keeps a withheld tile and a faulted tile on the board", async () => {
    const { store } = fakeStore({
      layout: { layoutRef: "WL-1", userId: 77, roleKey: "DRIVER", deviceClass: "phone", name: "B", isDefault: false },
      items: [
        { instanceRef: "WI-1", widgetKey: "myDay", variant: "list", position: 0 },
        { instanceRef: "WI-2", widgetKey: "exceptions", variant: "queue", position: 1 },
        { instanceRef: "WI-3", widgetKey: "retiredWidget", variant: "kpi", position: 2 },
      ],
    });
    const board = await openBoard({ store, read: async () => ok(1, prov) }, ctx(), device);
    const states = board.tiles.map((t) => t.payload.state).sort();
    expect(states).toEqual(["failed", "not_permitted", "ok"]);
    // The faulted tile still has a heading, or it could not report the loss.
    expect(board.tiles.find((t) => t.widgetKey === "retiredWidget")?.title).toBe("retiredWidget");
  });

  it("audits the board once, with the withheld count", async () => {
    const audit = vi.fn(async () => {});
    const { store } = fakeStore({
      layout: { layoutRef: "WL-2", userId: 77, roleKey: "DRIVER", deviceClass: "phone", name: "B", isDefault: false },
      items: [
        { instanceRef: "WI-1", widgetKey: "myDay", variant: "list", position: 0 },
        { instanceRef: "WI-2", widgetKey: "exceptions", variant: "queue", position: 1 },
      ],
    });
    await openBoard({ store, read: async () => ok(1, prov), audit }, ctx(), device);
    // Once per board, not once per tile: thirty reads a minute would bury the log.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tiles: 2, withheld: 1, layoutRef: "WL-2" }));
  });

  it("does not read another user's saved board", async () => {
    const { store } = fakeStore({
      layout: { layoutRef: "WL-X", userId: 99, roleKey: "DRIVER", deviceClass: "phone", name: "Theirs", isDefault: true },
      items: [{ instanceRef: "WI-1", widgetKey: "myDay", variant: "list", position: 0 }],
    });
    const board = await openBoard({ store, read: async () => ok(1, prov) }, ctx(), device);
    expect(board.seeded).toBe(true);
    expect(board.name).not.toBe("Theirs");
  });
});

describe("saving a board", () => {
  const req = {
    deviceClass: "phone" as const,
    name: "Yard", isDefault: true,
    items: [{ instanceRef: "WI-1", widgetKey: "hosRemaining", variant: "gauge", position: 9 }],
  };

  it("writes nothing when validation refuses", async () => {
    const { store, peek } = fakeStore();
    const out = await saveBoard({ store }, ctx(), { ...req, layoutRef: "WL-NOT-MINE" });
    expect(out.ok).toBe(false);
    expect(peek()).toBeNull();
  });

  it("round-trips a saved board and normalizes the position", async () => {
    const f = fakeStore();
    const saved = await saveBoard({ store: f.store }, ctx(), req);
    expect(saved).toMatchObject({ ok: true, tiles: 1, created: true });

    const board = await openBoard({ store: f.store, read: async () => ok("4h 12m", prov) }, ctx(), device);
    expect(board.seeded).toBe(false);
    expect(f.peek()?.items[0]?.position).toBe(0);
  });

  it("passes the unset-defaults instruction through to the one write", async () => {
    const f = fakeStore();
    await saveBoard({ store: f.store }, ctx(), req);
    await saveBoard({ store: f.store }, ctx(), { ...req, isDefault: false });
    expect(f.unsets).toEqual([true, false]);
  });

  it("saves the seeded board unchanged when the user keeps it", async () => {
    const f = fakeStore();
    const board = await openBoard({ store: f.store, read: async () => ok(1, prov) }, ctx(), device);
    const out = await saveBoard({ store: f.store }, ctx(), {
      deviceClass: "phone", name: "Kept", isDefault: true,
      items: board.tiles.map((t, i) => ({
        instanceRef: `WI-${i}`, widgetKey: t.widgetKey, variant: t.variant, position: i,
      })),
    });
    // The failure this pins: a seeded board the save path would reject.
    expect(out.ok).toBe(true);
  });
});

describe("the picker", () => {
  it("returns titles and variants for what the caller may read", () => {
    const offers = listOfferable(ctx());
    expect(offers.map((o) => o.widgetKey)).not.toContain("exceptions");
    const hos = offers.find((o) => o.widgetKey === "hosRemaining");
    expect(hos).toMatchObject({ title: "Hours Remaining", defaultVariant: "gauge" });
    expect(hos?.variants).toContain("countdown");
  });
});
