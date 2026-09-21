import { describe, expect, it } from "vitest";
import { coordinatePrecisionSchema, facilityRecordSchema } from "../../shared/facilities";
import seed from "../../data/western-canada-facilities.json";
import { toMapFeatures, validateFacilitySeed, type FacilitySeedRow } from "./facilitySeed";

describe("facility contracts", () => {
  it("rejects coordinates without precision and provenance", () => {
    expect(() => facilityRecordSchema.parse({ facilityKey: "x", name: "X", latitude: 53, longitude: -117 })).toThrow();
  });

  it("accepts all supported coordinate precision values", () => {
    for (const value of ["verified_entrance", "verified_site", "approximate_site", "community_only", "unknown"])
      expect(coordinatePrecisionSchema.parse(value)).toBe(value);
  });

  it("rejects out-of-range WGS84 coordinates", () => {
    expect(() => facilityRecordSchema.parse({
      facilityKey: "bad", name: "Bad", latitude: 91, longitude: -117,
      coordinatePrecision: "verified_site", coordinateSourceUrl: "https://example.test/source",
    })).toThrow();
  });
});

describe("reviewed facility seed", () => {
  const rows = seed as FacilitySeedRow[];
  it("validates every row and retains coordinate safety metadata", () => {
    expect(validateFacilitySeed(rows).errors).toEqual([]);
  });
  it("never makes community-only leads routable", () => {
    expect(toMapFeatures(rows).filter(feature => feature.coordinatePrecision === "community_only").every(feature => !feature.routable)).toBe(true);
  });
});
