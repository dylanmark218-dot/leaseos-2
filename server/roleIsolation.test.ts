// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B24 — P0: the acting role is a boundary, not a label.
 */
import { describe, expect, it } from "vitest";
import { actorForRole, contextFor, type RoleGrantSource } from "./_core/roleActor";
import { listOfferable, openBoard, saveBoard, type WidgetLayoutStore, rejectionsOf } from "./_core/widgetService";
import { planBoard } from "./_core/widgetDashboard";
import { ok, type Provenance } from "./_core/widgetPayload";
import type { NormalizedItem } from "./_core/widgetLayoutWrite";
import type { LayoutItem } from "./_core/widgetDashboard";
import type { StoredLayout } from "./_core/widgetService";

const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: new Date() };

const DRIVER = ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "readiness.read", "sync.push_own", "trip.read"];
const DISPATCHER = ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "surface.exceptions.read", "dispatch.read", "job.read"];

/** An account that both drives and dispatches. */
const grants: RoleGrantSource = {
  permissionsForRole: async (userId, roleKey) => {
    if (userId !== 77) return null;
    if (roleKey === "DRIVER") return DRIVER;
    if (roleKey === "DISPATCHER") return DISPATCHER;
    return null;
  },
};

const store = (seed?: { layout: StoredLayout; items: readonly LayoutItem[] }): WidgetLayoutStore => {
  let held = seed ?? null;
  return {
    findLayout: async (q) =>
      held && held.layout.userId === q.userId && held.layout.roleKey === q.roleKey ? held : null,
    createLayout: async (layout, items: readonly NormalizedItem[]) => {
      held = { layout: { ...layout, layoutRef: "WL-1" }, items: items.map((i) => ({ ...i })) };
      return { layoutRef: "WL-1" };
    },
    updateOwnedLayout: async () => ({ ok: true }),
  };
};

const actor = async (roleKey: string, userId = 77) => {
  const out = await actorForRole(grants, { userId, tenantId: "ORG-A", roleKey });
  if (!out.ok) throw new Error(out.code);
  return out.actor;
};

describe("actorForRole", () => {
  it("returns only the permissions effective for that role", async () => {
    const driver = await actor("DRIVER");
    expect(driver.permissions).toEqual(DRIVER);
    // The account also dispatches. The driver actor must not know it.
    expect(driver.permissions).not.toContain("dispatch.read");
    expect(driver.roles).toEqual(["DRIVER"]);
  });

  it("fails closed on a role the account does not hold", async () => {
    const out = await actorForRole(grants, { userId: 77, tenantId: "ORG-A", roleKey: "TENANT_ADMIN" });
    expect(out).toMatchObject({ ok: false, code: "ROLE_NOT_HELD" });
  });

  it("fails closed for an unknown user", async () => {
    const out = await actorForRole(grants, { userId: 999, tenantId: "ORG-A", roleKey: "DRIVER" });
    expect(out.ok).toBe(false);
  });

  it("keeps a role that grants nothing distinct from a role not held", async () => {
    // `[]` is a configuration; `null` is an identity claim that failed. Folding
    // them together would turn a revoked role into an empty board.
    const empty: RoleGrantSource = { permissionsForRole: async () => [] };
    const out = await actorForRole(empty, { userId: 1, tenantId: "ORG-A", roleKey: "NEW_ROLE" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.actor.permissions).toEqual([]);
  });

  it("takes the tenant from the caller, never from a request field", async () => {
    const a = await actor("DRIVER");
    expect(a.tenantId).toBe("ORG-A");
  });
});

describe("a driver board does not inherit dispatcher privileges", () => {
  it("withholds a dispatcher-only tile in DRIVER mode", async () => {
    const board = await openBoard(
      { store: store({
          layout: { layoutRef: "WL-1", userId: 77, roleKey: "DRIVER", deviceClass: "phone", name: "B", isDefault: true },
          items: [
            { instanceRef: "WI-1", widgetKey: "hosRemaining", variant: "gauge", position: 0 },
            { instanceRef: "WI-2", widgetKey: "exceptions", variant: "queue", position: 1 },
          ],
        }), read: async () => ok(1, prov) },
      await actor("DRIVER"),
      { deviceClass: "phone" },
    );
    expect(board.tiles.map((t) => t.payload.state)).toEqual(["ok", "not_permitted"]);
  });

  it("shows the same tile to the same account in DISPATCHER mode", async () => {
    const board = await openBoard(
      { store: store({
          layout: { layoutRef: "WL-2", userId: 77, roleKey: "DISPATCHER", deviceClass: "desktop", name: "D", isDefault: true },
          items: [{ instanceRef: "WI-2", widgetKey: "exceptions", variant: "queue", position: 0 }],
        }), read: async () => ok(1, prov) },
      await actor("DISPATCHER"),
      { deviceClass: "desktop" },
    );
    expect(board.tiles[0]?.payload.state).toBe("ok");
  });

  it("does not offer a dispatcher widget in the driver picker", async () => {
    const offered = listOfferable(await actor("DRIVER")).map((o) => o.widgetKey);
    expect(offered).not.toContain("exceptions");
    expect(offered).not.toContain("dispatchReadiness");
    expect(offered).toContain("hosRemaining");
  });

  it("offers it in the dispatcher picker", async () => {
    const offered = listOfferable(await actor("DISPATCHER")).map((o) => o.widgetKey);
    expect(offered).toContain("exceptions");
  });

  it("refuses to save a dispatcher tile onto a driver board", async () => {
    const out = await saveBoard({ store: store() }, await actor("DRIVER"), {
      deviceClass: "phone", name: "Sneaky", isDefault: false,
      items: [{ instanceRef: "WI-1", widgetKey: "exceptions", variant: "queue", position: 0 }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(rejectionsOf(out)[0]?.code).toBe("WIDGET_NOT_PERMITTED");
  });

  it("seeds a different starting board per role", async () => {
    const driverBoard = await openBoard({ store: store(), read: async () => ok(1, prov) },
      await actor("DRIVER"), { deviceClass: "phone" });
    const dispatchBoard = await openBoard({ store: store(), read: async () => ok(1, prov) },
      await actor("DISPATCHER"), { deviceClass: "desktop" });
    expect(driverBoard.tiles.map((t) => t.widgetKey)).not.toEqual(dispatchBoard.tiles.map((t) => t.widgetKey));
    expect(driverBoard.tiles.map((t) => t.widgetKey)).toContain("hosRemaining");
    expect(dispatchBoard.tiles.map((t) => t.widgetKey)).toContain("exceptions");
  });
});

describe("a revoked role stops working immediately", () => {
  it("stops resolving as soon as the grant is gone", async () => {
    let held = true;
    const revocable: RoleGrantSource = {
      permissionsForRole: async (_u, r) => (held && r === "DISPATCHER" ? DISPATCHER : null),
    };
    expect((await actorForRole(revocable, { userId: 77, tenantId: "ORG-A", roleKey: "DISPATCHER" })).ok).toBe(true);
    held = false;
    expect((await actorForRole(revocable, { userId: 77, tenantId: "ORG-A", roleKey: "DISPATCHER" })).ok).toBe(false);
  });

  it("leaves an already-saved tile visibly withheld rather than dropping it", async () => {
    // The account keeps its dispatcher board; the role is gone. The tile must
    // still appear, named, or the user believes they saw the whole board.
    const board = await openBoard(
      { store: store({
          layout: { layoutRef: "WL-2", userId: 77, roleKey: "DRIVER", deviceClass: "phone", name: "Old", isDefault: true },
          items: [
            { instanceRef: "WI-1", widgetKey: "exceptions", variant: "queue", position: 0 },
            { instanceRef: "WI-2", widgetKey: "hosRemaining", variant: "gauge", position: 1 },
          ],
        }), read: async () => ok(1, prov) },
      await actor("DRIVER"),
      { deviceClass: "phone" },
    );
    expect(board.tiles).toHaveLength(2);
    expect(board.tiles[0]).toMatchObject({ widgetKey: "exceptions" });
    expect(board.tiles[0]?.payload.state).toBe("not_permitted");
    expect(board.tiles[0]?.appearance.badge).toBe("withheld");
  });
});

describe("contextFor", () => {
  it("carries only the device's own situation from the request", async () => {
    const ctx = contextFor(await actor("DRIVER"), { connected: false, subjects: { unit: "UNIT-9" } });
    expect(ctx).toMatchObject({
      actingUserId: 77, roles: ["DRIVER"], permissions: DRIVER,
      connected: false, implicitSubjects: { unit: "UNIT-9" },
    });
  });

  it("plans a board with role permissions only", async () => {
    const plan = planBoard(
      [{ instanceRef: "WI-1", widgetKey: "dispatchReadiness", variant: "status", position: 0 }],
      contextFor(await actor("DRIVER"), { connected: true, subjects: { job: "JOB-1" } }),
    );
    expect(plan.tasks).toHaveLength(0);
    expect(plan.settled[0]?.payload).toMatchObject({ state: "not_permitted", permission: "dispatch.read" });
  });
});
