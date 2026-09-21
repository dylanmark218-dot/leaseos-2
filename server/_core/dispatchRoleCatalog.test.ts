/**
 * The dispatch role-type catalog resolver.
 *
 * `roleCode` was deliberately not made an enum: LeaseOS supports another trucking role by inserting
 * a row, not by shipping a migration. It was equally deliberately not left as free text, because
 * that is what `jobUnits.role` is — `varchar(100)`, unvalidated, read by nothing, and meaningless
 * as a result.
 *
 * Resolution is tenant-first, then global. The one rule that is easy to get backwards, and the
 * reason this is a tested pure function rather than a query: a tenant's own definition of `LEAD`
 * must win over the global one, and a global row must still be reachable by every tenant. In this
 * repository `orgRef IS NULL` ordinarily means "the historical single tenant", so the catalog's
 * reading of NULL as "available to everyone" is a deliberate departure and is pinned here.
 */
import { describe, expect, it } from "vitest";
import { resolveRoleType, visibleRoleTypes, type RoleType } from "./dispatchRoleCatalog";

const type = (o: Partial<RoleType> = {}): RoleType => ({
  roleCode: "LEAD", orgRef: null, displayName: "Lead", description: null,
  defaultEquipmentClass: null, defaultTrailerClass: null, active: true, ...o,
});

describe("resolving a role code", () => {
  it("finds a global type for any tenant", () => {
    const rows = [type()];
    expect(resolveRoleType("LEAD", "ORG-A", rows)?.displayName).toBe("Lead");
    expect(resolveRoleType("LEAD", "ORG-B", rows)?.displayName).toBe("Lead");
    expect(resolveRoleType("LEAD", "default", rows)?.displayName).toBe("Lead");
  });

  it("prefers the tenant's own definition over the global one", () => {
    const rows = [type(), type({ orgRef: "ORG-A", displayName: "Lead hand" })];
    expect(resolveRoleType("LEAD", "ORG-A", rows)?.displayName).toBe("Lead hand");
    expect(resolveRoleType("LEAD", "ORG-B", rows)?.displayName, "B has no override").toBe("Lead");
  });

  it("never lets one tenant's type resolve for another", () => {
    const rows = [type({ roleCode: "STEAM_TRUCK", orgRef: "ORG-A", displayName: "Steam truck" })];
    expect(resolveRoleType("STEAM_TRUCK", "ORG-A", rows)).toBeTruthy();
    expect(resolveRoleType("STEAM_TRUCK", "ORG-B", rows)).toBeNull();
  });

  it("refuses a code nobody defined", () => {
    expect(resolveRoleType("NOT_A_ROLE", "ORG-A", [type()])).toBeNull();
  });

  it("refuses an inactive type, tenant or global", () => {
    expect(resolveRoleType("LEAD", "ORG-A", [type({ active: false })])).toBeNull();
    expect(resolveRoleType("LEAD", "ORG-A", [type({ orgRef: "ORG-A", active: false })])).toBeNull();
  });

  /*
   * A tenant deactivating its own override must fall back to the global type rather than losing the
   * code entirely — otherwise turning off a local variant would break every posting that names it.
   */
  it("falls back to the global type when the tenant's override is deactivated", () => {
    const rows = [type(), type({ orgRef: "ORG-A", displayName: "Lead hand", active: false })];
    expect(resolveRoleType("LEAD", "ORG-A", rows)?.displayName).toBe("Lead");
  });

  it("carries the requirement defaults, which the caller snapshots rather than points at", () => {
    const rows = [type({ defaultEquipmentClass: "tandem", defaultTrailerClass: "none" })];
    const r = resolveRoleType("LEAD", "ORG-A", rows)!;
    expect(r.defaultEquipmentClass).toBe("tandem");
    expect(r.defaultTrailerClass).toBe("none");
  });
});

describe("listing what a tenant may use", () => {
  it("shows globals plus the tenant's own, with the tenant's shadowing a global of the same code", () => {
    const rows = [
      type({ roleCode: "LEAD" }),
      type({ roleCode: "PICKER" }),
      type({ roleCode: "LEAD", orgRef: "ORG-A", displayName: "Lead hand" }),
      type({ roleCode: "STEAM_TRUCK", orgRef: "ORG-A", displayName: "Steam truck" }),
      type({ roleCode: "FLOAT", orgRef: "ORG-B", displayName: "Float" }),
    ];
    const visible = visibleRoleTypes("ORG-A", rows);
    expect(visible.map(t => t.roleCode).sort()).toEqual(["LEAD", "PICKER", "STEAM_TRUCK"]);
    expect(visible.find(t => t.roleCode === "LEAD")?.displayName, "the tenant's own wins").toBe("Lead hand");
    expect(visible.some(t => t.roleCode === "FLOAT"), "another tenant's type is invisible").toBe(false);
  });

  it("omits inactive types from what may be used", () => {
    const rows = [type({ roleCode: "LEAD" }), type({ roleCode: "PICKER", active: false })];
    expect(visibleRoleTypes("ORG-A", rows).map(t => t.roleCode)).toEqual(["LEAD"]);
  });
});
