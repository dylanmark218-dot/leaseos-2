import { describe, expect, it } from "vitest";
import { checkMapping, featureToCandidate, lifecycleFromStatus, ringCentroid, SK_FACILITIES } from "./arcgisImport";
import { latLonToUtm } from "./projections";

describe("ArcGIS layer → facility candidate", () => {
  it("names the mapped fields a layer does not have instead of assuming them", () => {
    expect(checkMapping(SK_FACILITIES.fields, SK_FACILITIES.mapping)).toEqual({ ok: true, missing: [] });
    expect(checkMapping(["ID", "NAME"], { id: "ID", operator: "OPERATOR_NAME" })).toEqual({ ok: false, missing: ["operator → OPERATOR_NAME"] });
  });
  it("turns an SK polygon feature into a candidate at the polygon centroid, reprojected from UTM 13N, with the licence number as regulator ref and approximate_site precision", () => {
    const { easting, northing } = latLonToUtm(51.4667, -109.1667, 13);   // Kindersley
    const ring = [[easting - 50, northing - 50], [easting + 50, northing - 50], [easting + 50, northing + 50], [easting - 50, northing + 50], [easting - 50, northing - 50]];
    const r = featureToCandidate("sk_facilities", { attributes: { LICENCENUM: "WP00123", OWNERNAME: "R360 CANADA", LICTYPE: "WASTE FACILITY", LICSTATUS: "ACTIVE", SURFACELOC: "16-16-030-23W3" }, geometry: { rings: [ring] } }, SK_FACILITIES.mapping, 2957);
    expect("candidate" in r).toBe(true);
    const c = (r as { candidate: ReturnType<typeof featureToCandidate> extends infer T ? T extends { candidate: infer C } ? C : never : never }).candidate;
    expect(c).toMatchObject({ facilityKey: "sk_facilities:WP00123", name: "R360 CANADA — WP00123", regulatorRef: "WP00123", facilityType: "WASTE FACILITY", sourceStatus: "ACTIVE", legalLocation: "16-16-030-23W3", coordinatePrecision: "approximate_site" });
    expect(Math.abs(c.latitude! - 51.4667)).toBeLessThan(0.001);
    expect(Math.abs(c.longitude! - -109.1667)).toBeLessThan(0.001);
    expect(c.coordinateNote).toContain("centroid");
  });
  it("skips a feature with no identifier or an unsupported spatial reference, and keeps an unknown status unknown", () => {
    expect(featureToCandidate("x", { attributes: {} }, { id: "LICENCENUM" }, 2957)).toEqual({ skipped: "no LICENCENUM" });
    expect(featureToCandidate("x", { attributes: { ID: 1 }, geometry: { x: 1, y: 2 } }, { id: "ID" }, 99999)).toEqual({ skipped: "unsupported spatial reference WKID 99999" });
    expect(ringCentroid([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])).toEqual({ x: 1, y: 1 });
    expect(lifecycleFromStatus("ACTIVE")).toBe("operating");
    expect(lifecycleFromStatus("SUSPENDED")).toBe("suspended");
    expect(lifecycleFromStatus("ABANDONED")).toBe("closed");
    expect(lifecycleFromStatus("PENDING")).toBe("unknown");
    expect(lifecycleFromStatus(null)).toBe("unknown");
  });
});
