import { describe, expect, it } from "vitest";
import { branchRolesFor, engineRoleKey } from "./widgetRoleKeys";

describe("role vocabulary bridge", () => {
  it("maps the branch's roles to the engine's keys", () => {
    expect(engineRoleKey("driver")).toBe("DRIVER");
    expect(engineRoleKey("safety")).toBe("SAFETY_COMPLIANCE");
    expect(engineRoleKey("bookkeeper")).toBe("BILLING_ACCOUNTING");
  });
  it("round-trips a role the table does not know, rather than dropping it", () => {
    expect(engineRoleKey("yard_marshal")).toBe("YARD_MARSHAL");
    expect(branchRolesFor("YARD_MARSHAL")).toEqual(["yard_marshal"]);
  });
  it("names every branch role that shares an engine key", () => {
    expect([...branchRolesFor("MECHANIC")].sort()).toEqual(["mechanic", "shop_lead"]);
    expect(branchRolesFor("DRIVER")).toEqual(["driver"]);
  });
});
