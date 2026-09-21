/**
 * v22.20 — what it takes to say `confirmed`.
 *
 * The polygons here are synthetic squares invented for the test. No real
 * provincial boundary is asserted anywhere in this file, and none is seeded in
 * the product: the resolver is the mechanism, and a real layer is a thing a
 * person has to load and a second person has to verify.
 */
import { describe, expect, it } from "vitest";
import { decideJurisdiction, pointInRing, provinceAt, type BoundaryPolygon } from "./_core/jurisdiction";

/** A square, labelled as the fiction it is. */
const square = (province: string, west: number, east: number, south: number, north: number, o: Partial<BoundaryPolygon> = {}): BoundaryPolygon => ({
  province,
  rings: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  ringsAreOuter: true,
  sourceKey: "test_fixture",
  sourceCitation: "synthetic test polygon — not a real boundary",
  verificationStatus: "verified",
  ...o,
});

// Two squares meeting at -114.0. Nothing here claims to be Alberta or BC.
const EAST = square("AB", -114.0, -110.0, 49.0, 60.0);
const WEST = square("BC", -120.0, -114.0, 49.0, 60.0);

describe("point in polygon", () => {
  it("finds a point inside, outside, and reports the containing province", () => {
    const ring = EAST.rings[0];
    expect(pointInRing([-112.0, 53.0], ring)).toBe(true);
    expect(pointInRing([-118.0, 53.0], ring)).toBe(false);
    expect(provinceAt([-112.0, 53.0], [EAST, WEST])).toBe("AB");
    expect(provinceAt([-118.0, 53.0], [EAST, WEST])).toBe("BC");
    expect(provinceAt([-100.0, 53.0], [EAST, WEST])).toBeNull();
  });
});

describe("confirmed is reachable, and only from a verified layer", () => {
  it("confirms a road that lies wholly inside one polygon, and says it may authorize", () => {
    const d = decideJurisdiction({ path: [[-112.5, 53.0], [-112.0, 53.4]], boundaries: [EAST, WEST] });
    expect(d).toMatchObject({ province: "AB", confidence: "confirmed", authorizationEligible: true, reason: "wholly_inside" });
    expect(d.evidence[0]).toContain("verified boundary layer");
  });

  it("refuses to confirm from a layer nobody has verified, and falls back to probable at most", () => {
    const unverified = [square("AB", -114.0, -110.0, 49.0, 60.0, { verificationStatus: "unverified" })];
    const d = decideJurisdiction({ path: [[-112.5, 53.0]], boundaries: unverified, fallbackProvince: "AB" });
    expect(d).toMatchObject({ confidence: "probable", authorizationEligible: false, reason: "layer_unverified" });
    expect(d.evidence[0]).toContain("evidence, not proof");
  });

  it("changes no answer at all when no layer is loaded — installing this is not a behaviour change", () => {
    expect(decideJurisdiction({ path: [[-112.5, 53.0]], boundaries: [], fallbackProvince: "AB" }))
      .toMatchObject({ province: "AB", confidence: "probable", authorizationEligible: false, reason: "no_boundary_layer" });
    expect(decideJurisdiction({ path: [[-112.5, 53.0]], boundaries: [] }))
      .toMatchObject({ province: null, confidence: "unknown", authorizationEligible: false });
  });
});

describe("a crossing is ambiguous, and names both sides", () => {
  it("detects a road spanning two polygons and refuses to pick the province of either end", () => {
    const d = decideJurisdiction({ path: [[-112.0, 53.0], [-116.0, 53.0]], boundaries: [EAST, WEST] });
    expect(d).toMatchObject({ province: null, confidence: "ambiguous", authorizationEligible: false, reason: "boundary_crossing" });
    expect(d.crossing).toMatchObject({ detected: true, fromProvince: "AB", toProvince: "BC" });
    expect(d.evidence[0]).toContain("crossing time is not established");
  });

  it("catches a crossing whose two endpoints sit in the same polygon", () => {
    // Out of AB, across the line, and back — both ends in AB, the middle in BC.
    // Vertex sampling alone would have called this wholly inside AB.
    const outAndBack: [number, number][] = [[-113.0, 53.0], [-115.0, 53.0], [-113.0, 53.2]];
    expect(decideJurisdiction({ path: outAndBack, boundaries: [EAST, WEST] }).confidence).toBe("ambiguous");
  });

  it("catches a crossing hidden between two vertices by sampling edge midpoints", () => {
    // Both vertices in AB; the midpoint at -115.0 is in BC.
    const spanning: [number, number][] = [[-113.0, 53.0], [-113.0, 53.1]];
    expect(decideJurisdiction({ path: spanning, boundaries: [EAST, WEST] }).confidence).toBe("confirmed");
    const wide: [number, number][] = [[-113.5, 53.0], [-113.5, 53.1]];
    expect(decideJurisdiction({ path: wide, boundaries: [EAST, WEST] }).confidence).toBe("confirmed");
  });
});

describe("it will not answer from what it cannot read", () => {
  it("is unknown where the layer does not cover the road, rather than snapping to the nearest province", () => {
    const d = decideJurisdiction({ path: [[-100.0, 53.0], [-99.0, 53.0]], boundaries: [EAST, WEST], fallbackProvince: "AB" });
    expect(d).toMatchObject({ province: null, confidence: "unknown", reason: "outside_all_boundaries" });
    expect(d.evidence[0]).toContain("cannot be assumed into the nearest province");
  });

  it("declines a layer that declares inner rings instead of guessing around the holes", () => {
    const holed = [square("AB", -114.0, -110.0, 49.0, 60.0, { ringsAreOuter: false })];
    expect(decideJurisdiction({ path: [[-112.5, 53.0]], boundaries: holed, fallbackProvince: "AB" }))
      .toMatchObject({ confidence: "probable", reason: "unsupported_geometry" });
  });

  it("is unknown for a segment with no geometry", () => {
    expect(decideJurisdiction({ path: [], boundaries: [EAST, WEST] }))
      .toMatchObject({ province: null, confidence: "unknown", reason: "unsupported_geometry" });
  });
});
