import { describe, expect, it } from "vitest";
import { toCsv, toGeoJson } from "./facilityExport";
import type { FacilitySeedRow } from "./facilitySeed";

const approximate = { facilityKey: "x", name: "Comma, Site", latitude: 53, longitude: -117,
  coordinatePrecision: "community_only", coordinateSourceUrl: "https://example.test", sourceBriefNames: ["X"],
  disposition: "approximate_facility" } as FacilitySeedRow;

describe("facility exports", () => {
  it("never marks approximate GeoJSON pins routable", () => {
    expect(toGeoJson([approximate]).features[0].properties.routable).toBe(false);
  });
  it("uses RFC 4180 quoting in CSV", () => {
    expect(toCsv([approximate])).toContain('"Comma, Site"');
  });
});
