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

describe("a second province exercises the boundary the registry was built for", () => {
  const bc = (over: Partial<ImportedRoad> = {}) =>
    road({ sourceKey: "geofabrik_osm_bc", sourceLayer: "lines", sourceFeatureId: "way/1234567", ...over });

  it("carries BC's jurisdiction from the source, not Alberta's from a constant", () => {
    /*
     * The defect `0164` replaced hard-coded `jurisdiction: "CA-AB"`. A BC road evaluated under
     * Alberta's rules would be a quiet, confident wrong answer — the evaluator would apply the
     * wrong province's limits and report a clean verdict.
     */
    expect(roadAsSegment(bc()).attributes[0]!.jurisdiction).toBe("CA-BC");
    expect(roadAsSegment(road()).attributes[0]!.jurisdiction).toBe("CA-AB");
  });

  it("gives BC its own identity namespace", () => {
    // Three sources, one integer: ATS OBJECTID, an Alberta OSM way and a BC OSM way can all be
    // 1234567 and none of them is the same road.
    const ids = [road(), osm(), bc()].map(r => roadAsSegment(r).segmentId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe("OSM-BC-way/1234567");
  });

  it("does not let BC data claim authority either", () => {
    // 490,986 vehicle ways, 108 maxweight tags and zero maxwidth. Excellent topology; no standing.
    expect(roadAsSegment(bc()).attributes[0]!.confidence).toBe("unverified");
  });

  it("still answers nothing about width, which is the tag BC does not have at all", () => {
    const seg = roadAsSegment(bc());
    expect(seg.silentChecks).toContain("width_restriction");
    expect(seg.attributes.map(a => a.check)).not.toContain("width_restriction");
  });
});

const bcRoad = (over: Partial<ImportedRoad> = {}) =>
  road({ sourceKey: "geofabrik_osm_bc", sourceLayer: "lines", sourceFeatureId: "way/1234567", ...over });

describe("three provinces, one boundary", () => {
  const sk = (over: Partial<ImportedRoad> = {}) =>
    road({ sourceKey: "geofabrik_osm_sk", sourceLayer: "lines", sourceFeatureId: "way/1234567", ...over });

  it("gives each province its own jurisdiction and namespace", () => {
    /*
     * The same integer, four sources, four roads. And three different provinces whose rules differ:
     * an SK road judged under AB limits is a confident wrong answer, which is worse than UNKNOWN.
     */
    const all = [road(), osm(), bcRoad(), sk()].map(r => roadAsSegment(r));
    expect(new Set(all.map(s => s.segmentId)).size).toBe(4);
    expect(all.map(s => s.attributes[0]!.jurisdiction)).toEqual(["CA-AB", "CA-AB", "CA-BC", "CA-SK"]);
    expect(all[3]!.segmentId).toBe("OSM-SK-way/1234567");
  });

  it("holds every OSM province at unverified, whatever its coverage", () => {
    // Saskatchewan has 83% surface coverage and nine weight tags in the province. Good data and no
    // standing are not in tension: the first is about accuracy, the second about who is speaking.
    for (const r of [osm(), bcRoad(), sk()]) {
      expect(roadAsSegment(r).attributes[0]!.confidence).toBe("unverified");
    }
  });

  it("answers nothing about axle, width or length for any of them", () => {
    // Across all three extracts those three tags total 9, 23 and 15 against 1.27 million vehicle
    // ways. The silent checks are not a temporary gap; they are the normal state of this data.
    for (const r of [osm(), bcRoad(), sk()]) {
      const seg = roadAsSegment(r);
      for (const check of ["axle_group_limit", "width_restriction", "road_weight_restriction"]) {
        expect(seg.silentChecks, check).toContain(check);
      }
    }
  });
});
