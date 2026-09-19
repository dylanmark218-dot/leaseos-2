/**
 * Source neutrality at the road boundary (0164).
 *
 * `roadAsSegment` used to stamp every segment `confidence: "authority_confirmed"` and mint
 * `AB-ACCESS-<objectId>`, and the path→evaluator conversion manufactured
 * `sourceKey: "ats_road_allowance"` as a literal. All three were true while Alberta's access-road
 * layer was the only source, and all three become false the moment a second one arrives.
 *
 * The one that matters is the confidence. A wrong label is visible; an OpenStreetMap surface claim
 * arriving as a provincial statement produces a clean PASS on a road nobody verified, and nothing
 * looks wrong.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROAD_SOURCE_STANDING, roadAsSegment, standingFor, type ImportedRoad } from "./legalLand";
import { evaluateRoute } from "./routeEvaluation";

const road = (over: Partial<ImportedRoad> = {}): ImportedRoad => ({
  objectId: 1234567, name: "Range Road 51", highwayNumber: null, roadClass: null,
  featureTypeLabel: null, surfaceKind: "gravel", lanes: null, lengthMetres: 4200,
  path: [[-114.1, 53.4], [-114.0, 53.5]],
  sourceKey: "ats_road_allowance", sourceLayer: "Access and Facility Roads",
  retrievedAt: new Date("2026-09-01T00:00:00Z"), geometrySource: "v3", ...over,
});

const osm = (over: Partial<ImportedRoad> = {}) =>
  road({ sourceKey: "geofabrik_osm_ab", sourceLayer: "lines", sourceFeatureId: "way/1234567", ...over });

describe("confidence comes from the source, not from the function", () => {
  it("keeps Alberta's own layer authority-confirmed", () => {
    const seg = roadAsSegment(road());
    expect(seg.attributes[0]!.confidence).toBe("authority_confirmed");
    expect(seg.attributes[0]!.jurisdiction).toBe("CA-AB");
  });

  it("does not let an OSM surface claim become authority-confirmed", () => {
    // Possibly accurate. Still nobody's legal statement.
    const seg = roadAsSegment(osm());
    expect(seg.attributes[0]!.confidence).toBe("unverified");
  });

  it("gives an unverified surface a different verdict from a verified one", () => {
    /*
     * The whole point, end to end through the evaluator: the same gravel, the same check, two
     * sources — and only the province's statement may clear it outright.
     */
    const vehicle = { grossWeightKg: 52_000, axleGroups: [], heightM: 4.1, widthM: 2.6, lengthM: 23 };
    const verdictFor = (r: ImportedRoad) => {
      const s = roadAsSegment(r);
      return evaluateRoute(["surface_condition"], [{ segmentId: s.segmentId, label: s.label, lengthKm: s.lengthKm, attributes: s.attributes }], vehicle as never);
    };
    const authority = verdictFor(road());
    const contributed = verdictFor(osm());
    const result = (v: ReturnType<typeof verdictFor>) => v.evidence.find(e => e.check === "surface_condition")?.result;
    expect(result(authority)).toBe("pass");
    expect(result(contributed)).toBe("review");   // satisfied, and on data nobody checked
  });

  it("treats an unregistered source as claiming nothing, rather than borrowing Alberta's standing", () => {
    const seg = roadAsSegment(road({ sourceKey: "some_new_provider", sourceLayer: "roads" }));
    expect(seg.attributes[0]!.confidence).toBe("unverified");
    expect(seg.attributes[0]!.jurisdiction).toBeNull();   // a caller's location is not evidence
  });
});

describe("segment identity is namespaced by source", () => {
  it("cannot collide across sources on the same number", () => {
    // ATS OBJECTID 1234567 and OSM way 1234567 are different roads that happen to share an integer.
    const a = roadAsSegment(road({ objectId: 1234567 })).segmentId;
    const b = roadAsSegment(osm({ objectId: 1234567, sourceFeatureId: "way/1234567" })).segmentId;
    expect(a).not.toBe(b);
    expect(a).toBe("AB-ACCESS-1234567");
    expect(b).toBe("OSM-AB-way/1234567");
  });

  it("keeps Alberta's historical prefix, because stored decisions reference it", () => {
    // Re-minting these would orphan every route already approved against them, to fix an identity
    // that was never ambiguous while this was the only source.
    expect(ROAD_SOURCE_STANDING.ats_road_allowance!.idPrefix).toBe("AB-ACCESS-");
    expect(roadAsSegment(road()).segmentId).toMatch(/^AB-ACCESS-/);
  });

  it("namespaces an unregistered source on its own key", () => {
    expect(standingFor("yellowhead_county_roads").idPrefix).toBe("yellowhead_county_roads:");
  });
});

describe("UNKNOWN is not weakened", () => {
  it("still answers nothing at all about weight, axle, clearance or width", () => {
    // The silent checks are the reason the sparse OSM extract is safe to import: absent evidence
    // stays absent rather than arriving as a nullable column somebody reads as unlimited.
    const seg = roadAsSegment(osm());
    for (const check of ["road_weight_restriction", "axle_group_limit", "bridge_capacity", "overhead_clearance"]) {
      expect(seg.silentChecks, check).toContain(check);
      expect(seg.attributes.map(a => a.check), check).not.toContain(check);
    }
  });

  it("answers UNKNOWN for a weight check on a road with no weight evidence", () => {
    const seg = roadAsSegment(osm());
    const v = evaluateRoute(["road_weight_restriction"], [{ segmentId: seg.segmentId, label: seg.label, lengthKm: seg.lengthKm, attributes: seg.attributes }], { grossWeightKg: 52_000, axleGroups: [] } as never);
    expect(v.evidence.find(e => e.check === "road_weight_restriction")?.result).toBe("unknown");
  });
});

describe("no production call site manufactures a source", () => {
  it("has no literal sourceKey outside the source registry and the importers that legitimately name their own", () => {
    /*
     * The defect this replaces: the path→evaluator conversion wrote `sourceKey:
     * "ats_road_allowance"` as a literal, so every edge reached the evaluator labelled Alberta
     * whatever had produced it. An importer naming its own source is correct — it knows what it is
     * fetching. A translator naming a source is inventing one.
     */
    const files = readdirSync("server").filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(f => `server/${f}`);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/sourceKey:\s*"([a-z_]+)"/g)) {
        // geoRouter's importer legitimately names the dataset it is fetching; the conversion may not.
        const line = src.slice(0, m.index).split("\n").length;
        const context = src.split("\n")[line - 1] ?? "";
        /*
         * An importer naming the dataset it is fetching is correct — it knows what it went and
         * got. A translator naming a source is inventing one. The line tells them apart: an import
         * run, a source gate, or a field observation recording its own origin.
         */
        if (/geoImportRuns|sourceGate\(|runRef|field_observation|permanent: true/.test(context)) continue;
        offenders.push(`${f}:${line} → ${m[1]}`);
      }
    }
    expect(offenders, "a production call site names a road source instead of carrying it").toEqual([]);
  });
});
