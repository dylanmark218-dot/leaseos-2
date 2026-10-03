/**
 * Fleet & Equipment Portfolio — asset core rules, pure.
 */
import { describe, expect, it } from "vitest";
import { classMismatchBlocker, componentAttachment, componentBlockers, lifecycleBlocker, lifecycleTransition, unitSideVerdict } from "./fleetAssets";
import { ASSET_CLASSES, ASSET_TYPES, assetClassOf, assetIdentitySchema, vehicleTypeFor } from "../../shared/fleetAssetTypes";

describe("the vocabulary", () => {
  it("every type belongs to exactly one class, and an unknown type to none", () => {
    for (const t of ASSET_TYPES) expect(ASSET_CLASSES.includes(assetClassOf(t)!)).toBe(true);
    expect(new Set(ASSET_TYPES).size).toBe(ASSET_TYPES.length);
    expect(assetClassOf("spaceship")).toBeNull();
    expect(vehicleTypeFor("hot_seat_trailer")).toBe("hot seat trailer");
  });
  it("identity input refuses a type outside the vocabulary and a year outside a vehicle's", () => {
    expect(assetIdentitySchema.safeParse({ assetType: "hydrovac", modelYear: 2019 }).success).toBe(true);
    expect(assetIdentitySchema.safeParse({ assetType: "hydro vac" }).success).toBe(false);
    expect(assetIdentitySchema.safeParse({ assetType: "hydrovac", modelYear: 1850 }).success).toBe(false);
  });
});

describe("lifecycle", () => {
  it("storage is reversible by anyone who may set lifecycle; retired and sold are terminal except to management", () => {
    expect(lifecycleTransition({ from: "active", to: "seasonal_storage", roles: ["shop_lead"] })).toEqual({ allowed: true, terminal: false });
    expect(lifecycleTransition({ from: "seasonal_storage", to: "active", roles: ["shop_lead"] })).toEqual({ allowed: true, terminal: false });
    expect(lifecycleTransition({ from: "active", to: "retired", roles: ["shop_lead"] })).toEqual({ allowed: true, terminal: true });
    expect(lifecycleTransition({ from: "retired", to: "active", roles: ["shop_lead"] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/only by management/) });
    expect(lifecycleTransition({ from: "sold", to: "active", roles: ["management"] })).toEqual({ allowed: true, terminal: false });
  });
  it("a no-op is refused, and transfer is refused until an ownership history exists (O-4)", () => {
    expect(lifecycleTransition({ from: "active", to: "active", roles: ["management"] })).toMatchObject({ allowed: false });
    expect(lifecycleTransition({ from: "active", to: "transferred", roles: ["management"] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/O-4/) });
    expect(lifecycleTransition({ from: "transferred", to: "active", roles: ["management"] })).toMatchObject({ allowed: false });
  });
  it("out of the fleet is overridable by no one; storage needs an approved policy; active is no finding", () => {
    expect(lifecycleBlocker("unit", "27", "active")).toBeNull();
    expect(lifecycleBlocker("unit", "27", "retired")).toMatchObject({ code: "unit_retired", severity: "blocking", overridable: false, subject: "truck" });
    expect(lifecycleBlocker("trailer", "T9", "sold")).toMatchObject({ code: "trailer_sold", severity: "blocking", overridable: false, subject: "trailer" });
    expect(lifecycleBlocker("unit", "27", "seasonal_storage")).toMatchObject({ code: "unit_in_storage", severity: "blocking", overridable: true, overrideAuthority: "manager" });
  });
});

describe("class", () => {
  it("a trailer slot filled by a truck is a mismatch; an unclassified unit is not guessed", () => {
    expect(classMismatchBlocker("trailer", "T9", "power_unit")).toMatchObject({ code: "trailer_class_mismatch", severity: "blocking", overridable: false });
    expect(classMismatchBlocker("unit", "27", "trailer")).toMatchObject({ code: "unit_class_mismatch" });
    expect(classMismatchBlocker("unit", "27", "power_unit")).toBeNull();
    expect(classMismatchBlocker("trailer", "T9", "trailer")).toBeNull();
    expect(classMismatchBlocker("unit", "27", null)).toBeNull();
  });
});

describe("components", () => {
  const unit = (id: number, assetClass: "power_unit" | "trailer" | "mounted_system" | "portable_equipment" | "component" | null, lifecycleStatus: "active" | "retired" = "active") => ({ id, assetClass, lifecycleStatus });
  it("a mounted system attaches to a truck; a truck or a trailer is never a child; nothing out of the fleet takes part", () => {
    expect(componentAttachment({ parent: unit(1, "power_unit"), child: unit(2, "mounted_system"), relationship: "mounted", active: [] })).toEqual({ allowed: true });
    expect(componentAttachment({ parent: unit(1, "power_unit"), child: unit(2, "trailer"), relationship: "towed", active: [] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/dispatched beside/) });
    expect(componentAttachment({ parent: unit(1, "power_unit"), child: unit(2, "power_unit"), relationship: "attached", active: [] })).toMatchObject({ allowed: false });
    expect(componentAttachment({ parent: unit(1, "power_unit", "retired"), child: unit(2, "mounted_system"), relationship: "mounted", active: [] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/retired/) });
    expect(componentAttachment({ parent: unit(1, "power_unit"), child: unit(1, "power_unit"), relationship: "mounted", active: [] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/itself/) });
  });
  it("a child is in one place at a time, and never becomes its own ancestor", () => {
    expect(componentAttachment({ parent: unit(1, "power_unit"), child: unit(2, "mounted_system"), relationship: "mounted", active: [{ parentUnitId: 3, childUnitId: 2 }] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/attached elsewhere/) });
    // 2 is mounted on 1; attaching 1 under 2 would make a cycle (1 is a mounted system here for the sake of the walk).
    expect(componentAttachment({ parent: unit(2, "mounted_system"), child: unit(1, "portable_equipment"), relationship: "attached", active: [{ parentUnitId: 1, childUnitId: 2 }] })).toMatchObject({ allowed: false, reason: expect.stringMatching(/ancestor/) });
  });
  it("a component's critical defect or safety hold holds the parent, one blocker per cause, named by the child (O-9)", () => {
    const b = componentBlockers("27", [
      { componentRef: "CMP-1", childUnitId: 9, childUnitNumber: "VAC-9", relationship: "mounted", removable: false, criticalDefectOpen: true, safetyHold: true },
      { componentRef: "CMP-2", childUnitId: 10, childUnitNumber: "PTO-10", relationship: "installed", removable: true, criticalDefectOpen: false, safetyHold: false },
    ]);
    expect(b.map(x => [x.code, x.severity, x.overridable])).toEqual([["component_critical_defect:9", "blocking", false], ["component_hold_safety:9", "blocking", false]]);
  });
});

describe("the unit-side verdict", () => {
  it("orders blocking over unknown over review, and clear says nothing about the driver, the job or the route", () => {
    expect(unitSideVerdict([])).toBe("clear");
    expect(unitSideVerdict([{ severity: "review" }])).toBe("review");
    expect(unitSideVerdict([{ severity: "review" }, { severity: "unknown" }])).toBe("unknown");
    expect(unitSideVerdict([{ severity: "unknown" }, { severity: "blocking" }])).toBe("blocked");
  });
});
