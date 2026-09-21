// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B26 — restore default goes through the one validated save path.
 */
import { describe, expect, it, vi } from "vitest";
import { previewDefaultBoard, restoreDefaultBoard, type StoredLayout, type WidgetLayoutStore } from "./_core/widgetService";
import type { NormalizedItem } from "./_core/widgetLayoutWrite";
import type { RoleActor } from "./_core/roleActor";

const DRIVER: RoleActor = {
  userId: 77, tenantId: "ORG-A", roleKey: "DRIVER", roles: ["DRIVER"],
  permissions: ["widgets.read", "widgets.own.manage", "myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read",
    "sync.push_own", "trip.read", "readiness.read", "compliance.read"],
};
const DISPATCHER: RoleActor = {
  userId: 12, tenantId: "ORG-A", roleKey: "DISPATCHER", roles: ["DISPATCHER"],
  permissions: ["widgets.read", "widgets.own.manage", "myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "surface.exceptions.read",
    "dispatch.read", "job.read"],
};

const spyStore = () => {
  const calls: { layout: StoredLayout; items: readonly NormalizedItem[]; expected?: number }[] = [];
  const store: WidgetLayoutStore = {
    findLayout: async () => null,
    createLayout: async (layout, items) => { calls.push({ layout: layout as unknown as StoredLayout, items }); return { layoutRef: "WL-NEW" }; },
    updateOwnedLayout: async (layout, items, _u, _t, expectedRevision) => {
      calls.push({ layout, items, ...(expectedRevision !== undefined ? { expected: expectedRevision } : {}) });
      return { ok: true, revision: (expectedRevision ?? 0) + 1 };
    },
  };
  return { store, calls };
};

describe("preview", () => {
  it("derives a driver phone board from the registry, with titles", () => {
    const p = previewDefaultBoard(DRIVER, "phone", 9);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.map((i) => i.title)).toContain("Hours Remaining");
    expect(p.replacing).toBe(9);
  });

  it("gives a dispatcher desktop board different widgets", () => {
    const driver = previewDefaultBoard(DRIVER, "phone", 0).items.map((i) => i.widgetKey);
    const dispatcher = previewDefaultBoard(DISPATCHER, "desktop", 0).items.map((i) => i.widgetKey);
    expect(dispatcher).not.toEqual(driver);
    expect(dispatcher).toContain("exceptions");
    expect(driver).not.toContain("exceptions");
  });

  it("opens a bigger board on desktop than on phone", () => {
    expect(previewDefaultBoard(DISPATCHER, "phone", 0).items.length)
      .toBeLessThanOrEqual(previewDefaultBoard(DISPATCHER, "desktop", 0).items.length);
  });

  it("never resurrects a revoked permission", () => {
    const revoked = { ...DISPATCHER, permissions: DISPATCHER.permissions.filter((p) => p !== "surface.exceptions.read") };
    expect(previewDefaultBoard(revoked, "desktop", 0).items.map((i) => i.widgetKey)).not.toContain("exceptions");
  });

  it("is deterministic", () => {
    expect(previewDefaultBoard(DRIVER, "phone", 0)).toEqual(previewDefaultBoard(DRIVER, "phone", 0));
  });
});

describe("restore", () => {
  it("writes exactly what the preview showed", async () => {
    const { store, calls } = spyStore();
    const preview = previewDefaultBoard(DRIVER, "phone", 3);
    const out = await restoreDefaultBoard({ store }, DRIVER, { deviceClass: "phone", name: "Default", isDefault: true });
    expect(out.ok).toBe(true);
    expect(calls[0]?.items.map((i) => i.widgetKey)).toEqual(preview.items.map((i) => i.widgetKey));
  });

  it("produces dense positions and deterministic instance refs", async () => {
    const { store, calls } = spyStore();
    await restoreDefaultBoard({ store }, DRIVER, { deviceClass: "phone", name: "Default", isDefault: true });
    const items = calls[0]?.items ?? [];
    expect(items.map((i) => i.position)).toEqual(items.map((_, i) => i));
    // Restoring twice must produce the same refs, or a staged offline board
    // could not be compared against a restored one.
    const second = spyStore();
    await restoreDefaultBoard({ store: second.store }, DRIVER, { deviceClass: "phone", name: "Default", isDefault: true });
    expect(second.calls[0]?.items.map((i) => i.instanceRef)).toEqual(items.map((i) => i.instanceRef));
  });

  it("carries the expected revision so a restore cannot clobber a changed board", async () => {
    const { store, calls } = spyStore();
    await restoreDefaultBoard({ store }, DRIVER, {
      layoutRef: "WL-1", expectedRevision: 7, deviceClass: "phone", name: "Default", isDefault: true,
    });
    expect(calls[0]?.expected).toBe(7);
  });

  it("surfaces a conflict rather than replacing a board that moved", async () => {
    const store: WidgetLayoutStore = {
      findLayout: async () => null,
      createLayout: async () => ({ layoutRef: "x" }),
      updateOwnedLayout: async () => ({ ok: false, code: "LAYOUT_CONFLICT", serverRevision: 11 }),
    };
    const out = await restoreDefaultBoard({ store }, DRIVER, {
      layoutRef: "WL-1", expectedRevision: 7, deviceClass: "phone", name: "Default", isDefault: true,
    });
    expect(out).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT", serverRevision: 11 });
  });

  it("goes through validation, not around it", async () => {
    // A restore for an actor holding no widget permissions produces an empty
    // board rather than a board of widgets they cannot read.
    const { store, calls } = spyStore();
    const stripped = { ...DRIVER, permissions: ["widgets.own.manage"] };
    const out = await restoreDefaultBoard({ store }, stripped, { deviceClass: "phone", name: "Default", isDefault: true });
    expect(out.ok).toBe(true);
    expect(calls[0]?.items).toEqual([]);
  });
});
