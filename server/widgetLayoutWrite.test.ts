// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B23 — saving a board. Every assertion names an outcome or a rejection code.
 */
import { describe, expect, it } from "vitest";
import {
  defaultBoardFor, MAX_TILES, prepareLayoutSave,
  type IncomingItem, type LayoutSaveRequest, type WriteContext,
} from "./_core/widgetLayoutWrite";

const DRIVER_PERMS = ["myday.read_own", "inbox.read_own", "surface.search", "surface.timeline.read", "hos.read", "readiness.read", "sync.push_own", "trip.read"];

const ctx = (o: Partial<WriteContext> = {}): WriteContext => ({
  actingUserId: 77, roles: ["DRIVER"], permissions: DRIVER_PERMS, ...o,
});

const tile = (widgetKey: string, o: Partial<IncomingItem> = {}): IncomingItem => ({
  instanceRef: `WI-${widgetKey}`, widgetKey, variant: "status", position: 0, ...o,
});

const req = (o: Partial<LayoutSaveRequest> = {}): LayoutSaveRequest => ({
  layoutRef: "WL-1", userId: 77, roleKey: "DRIVER", deviceClass: "phone",
  name: "Yard", isDefault: false, items: [tile("myDay", { variant: "list" })], ...o,
});

const codes = (r: ReturnType<typeof prepareLayoutSave>) =>
  r.ok ? [] : r.rejections.map((x) => x.code);

describe("ownership", () => {
  it("refuses a layout saved for another user, and says nothing else about it", () => {
    const r = prepareLayoutSave(
      req({ userId: 99, name: "", items: [tile("nope")] }),
      ctx(),
    );
    expect(r.ok).toBe(false);
    // The empty name and the bad widget are real faults, deliberately not
    // enumerated back to a caller reaching for somebody else's board.
    expect(codes(r)).toEqual(["NOT_OWNER"]);
  });

  it("refuses a layout saved against a role the caller does not hold", () => {
    const r = prepareLayoutSave(req({ roleKey: "TENANT_ADMIN" }), ctx());
    expect(codes(r)).toEqual(["ROLE_NOT_HELD"]);
  });

  it("accepts the caller's own board for a role they hold", () => {
    expect(prepareLayoutSave(req(), ctx()).ok).toBe(true);
  });
});

describe("named rejections", () => {
  it("returns every fault together, not one per attempt", () => {
    const r = prepareLayoutSave(
      req({
        name: "",
        items: [tile("nope"), tile("hosRemaining", { variant: "map" }), tile("exceptions")],
      }),
      ctx(),
    );
    expect(codes(r).sort()).toEqual(
      ["NAME_EMPTY", "UNKNOWN_WIDGET", "VARIANT_UNSUPPORTED", "WIDGET_NOT_PERMITTED"].sort(),
    );
  });

  it("attaches the instance to every tile-level rejection", () => {
    const r = prepareLayoutSave(req({ items: [tile("exceptions", { instanceRef: "WI-X" })] }), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0]).toMatchObject({ code: "WIDGET_NOT_PERMITTED", instanceRef: "WI-X" });
  });

  it("names the supported variants instead of just refusing", () => {
    const r = prepareLayoutSave(req({ items: [tile("hosRemaining", { variant: "map" })] }), ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0]?.detail).toContain("gauge");
  });

  it("refuses a tile the caller cannot read rather than saving a withheld one", () => {
    expect(codes(prepareLayoutSave(req({ items: [tile("exceptions")] }), ctx()))).toEqual(["WIDGET_NOT_PERMITTED"]);
  });

  it("refuses a duplicate instance reference", () => {
    const r = prepareLayoutSave(
      req({ items: [tile("myDay", { variant: "list" }), tile("myDay", { variant: "list" })] }),
      ctx(),
    );
    expect(codes(r)).toEqual(["DUPLICATE_INSTANCE"]);
  });

  it("refuses an empty pinned subject instead of reading it as 'current'", () => {
    const r = prepareLayoutSave(
      req({ items: [tile("unitReadiness", { subjectRef: "  " })] }),
      ctx(),
    );
    expect(codes(r)).toEqual(["SUBJECT_EMPTY"]);
  });

  it("accepts null as 'whatever is current'", () => {
    const r = prepareLayoutSave(req({ items: [tile("unitReadiness", { subjectRef: null })] }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0]?.subjectRef).toBeNull();
  });
});

describe("limits", () => {
  it("refuses a board past the tile ceiling, naming the reason it exists", () => {
    const many = Array.from({ length: MAX_TILES + 1 }, (_, i) =>
      tile("myDay", { instanceRef: `WI-${i}`, variant: "list", position: i }));
    const r = prepareLayoutSave(req({ items: many }), ctx());
    expect(codes(r)).toContain("TOO_MANY_TILES");
    if (!r.ok) expect(r.rejections.find((x) => x.code === "TOO_MANY_TILES")?.detail).toContain("server read");
  });

  it("refuses a multi-column tile on a phone board rather than clamping it", () => {
    const r = prepareLayoutSave(req({ deviceClass: "phone", items: [tile("myDay", { variant: "list", spanColumns: 2 })] }), ctx());
    expect(codes(r)).toEqual(["SPAN_OUT_OF_RANGE"]);
  });

  it("allows the same tile two columns wide on a tablet", () => {
    const r = prepareLayoutSave(req({ deviceClass: "tablet", items: [tile("myDay", { variant: "list", spanColumns: 2 })] }), ctx());
    expect(r.ok).toBe(true);
  });

  it("refuses a fractional span", () => {
    const r = prepareLayoutSave(req({ deviceClass: "desktop", items: [tile("myDay", { variant: "list", spanColumns: 1.5 })] }), ctx());
    expect(codes(r)).toEqual(["SPAN_OUT_OF_RANGE"]);
  });
});

describe("normalization", () => {
  it("rewrites gapped positions to a dense sequence in the caller's order", () => {
    const r = prepareLayoutSave(
      req({
        items: [
          tile("syncStatus", { position: 40 }),
          tile("myDay", { variant: "list", position: 5 }),
          tile("hosRemaining", { variant: "gauge", position: 12 }),
        ],
      }),
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => [i.widgetKey, i.position])).toEqual([
        ["myDay", 0], ["hosRemaining", 1], ["syncStatus", 2],
      ]);
    }
  });

  it("breaks a position tie on arrival order, so the same request gives the same board", () => {
    const items = [
      tile("syncStatus", { position: 3 }),
      tile("myDay", { variant: "list", position: 3 }),
    ];
    const first = prepareLayoutSave(req({ items }), ctx());
    const again = prepareLayoutSave(req({ items }), ctx());
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(first.items.map((i) => i.widgetKey)).toEqual(["syncStatus", "myDay"]);
      expect(again.items.map((i) => i.widgetKey)).toEqual(first.items.map((i) => i.widgetKey));
    }
  });

  it("trims the name and defaults spans and options", () => {
    const r = prepareLayoutSave(req({ name: "  Yard  " }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layout.name).toBe("Yard");
      expect(r.items[0]).toMatchObject({ spanColumns: 1, spanRows: 1, options: null });
    }
  });
});

describe("the default flag", () => {
  it("returns the unset side effect so 'only one default' cannot be forgotten", () => {
    const r = prepareLayoutSave(req({ isDefault: true }), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sideEffects).toEqual([
        { kind: "unset_other_defaults", userId: 77, roleKey: "DRIVER", deviceClass: "phone" },
      ]);
    }
  });

  it("asks for nothing when the board is not the default", () => {
    const r = prepareLayoutSave(req({ isDefault: false }), ctx());
    if (r.ok) expect(r.sideEffects).toEqual([]);
  });
});

describe("the starting board", () => {
  it("opens with no withheld tiles", () => {
    const board = defaultBoardFor({ roles: ["DRIVER"], permissions: DRIVER_PERMS }, "phone");
    expect(board.length).toBeGreaterThan(0);
    expect(board.map((b) => b.widgetKey)).not.toContain("exceptions");
  });

  it("gives a caller with no permissions an empty board rather than a broken one", () => {
    expect(defaultBoardFor({ roles: ["DRIVER"], permissions: [] }, "phone")).toEqual([]);
  });

  it("opens a smaller board on a phone than on a desktop", () => {
    const perms = [...DRIVER_PERMS, "surface.exceptions.read", "dispatch.read", "job.read", "compliance.read"];
    const who = { roles: ["DRIVER", "DISPATCHER"], permissions: perms };
    expect(defaultBoardFor(who, "phone").length)
      .toBeLessThanOrEqual(defaultBoardFor(who, "desktop").length);
  });

  it("saves cleanly through the same validation it will be read by", () => {
    const board = defaultBoardFor({ roles: ["DRIVER"], permissions: DRIVER_PERMS }, "phone");
    const r = prepareLayoutSave(
      req({
        items: board.map((b, i) => ({
          instanceRef: `WI-D${i}`, widgetKey: b.widgetKey, variant: b.variant, position: b.position,
        })),
      }),
      ctx(),
    );
    // The failure this pins: a seeded board that the save path would refuse.
    expect(r.ok).toBe(true);
  });
});
