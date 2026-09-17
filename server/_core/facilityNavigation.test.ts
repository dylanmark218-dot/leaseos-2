import { describe, expect, it } from "vitest";
import { buildFacilityLinks } from "./facilityNavigation";

describe("facility navigation links", () => {
  it("prefers verified entrance coordinates", () => {
    const links = buildFacilityLinks({ precision: "verified_entrance", entrance: { lat: 53.1, lon: -117.2 }, site: { lat: 53, lon: -117 } });
    expect(links.googleDirections).toContain("destination=53.1%2C-117.2");
  });
  it("does not build directions for approximate or community coordinates", () => {
    for (const precision of ["approximate_site", "community_only", "unknown"] as const)
      expect(buildFacilityLinks({ precision, site: { lat: 53, lon: -117 } }).googleDirections).toBeNull();
  });
  it("encodes contact handoffs", () => {
    const links = buildFacilityLinks({ precision: "verified_site", site: { lat: 53, lon: -117 }, phone: "+1 780 555 0100", email: "dispatch@example.ca" });
    expect(links.tel).toBe("tel:+17805550100");
    expect(links.mailto).toBe("mailto:dispatch%40example.ca");
  });
});
