/**
 * M2 — the OSM way → road edge conversion.
 *
 * Tag combinations here are taken from what the two extracts actually contain, not invented: a
 * Range Road with no surface tag, a Forest Service Road tagged `track`, the handful of ways that do
 * state a weight, and BC's fords.
 */
import { describe, expect, it } from "vitest";
import { LEGAL_CHECKS, importOsmWay, surfaceFor, type OsmWay } from "./osmImport";

const AB = { sourceKey: "geofabrik_osm_ab", idPrefix: "OSM-AB-" };
const line = [[-114.1, 53.4], [-114.0, 53.5]] as const;
const way = (tags: Record<string, string>, over: Partial<OsmWay> = {}): OsmWay =>
  ({ id: 1234567, tags, geometry: line as never, ...over });

describe("what becomes a road", () => {
  it("imports a Range Road with nothing but a name and a class", () => {
    const r = importOsmWay(way({ highway: "unclassified", name: "Range Road 51" }), AB);
    expect(r.imported).toBe(true);
    if (!r.imported) throw new Error("unreachable");
    expect(r.segmentId).toBe("OSM-AB-way/1234567");
    expect(r.label).toBe("Range Road 51");
    expect(r.direction).toBe("both");   // OSM's own default when oneway is absent
  });

  it("imports a track, because that is what a Forest Service Road usually is", () => {
    /*
     * Excluding `highway=track` would drop lease approaches, resource roads and most of BC's 7,180
     * Forest Service Roads — the roads this product exists to route on.
     */
    const r = importOsmWay(way({ highway: "track", name: "Forest Service Road 291", tracktype: "grade3" }), AB);
    expect(r.imported).toBe(true);
    if (!r.imported) throw new Error("unreachable");
    expect(r.surfaceKind).toBe("dry_weather");
  });

  it("refuses a footpath by name, not silently", () => {
    const r = importOsmWay(way({ highway: "footway" }), AB);
    expect(r.imported).toBe(false);
    if (r.imported) throw new Error("unreachable");
    expect(r.reason).toBe("not_vehicle_accessible");
    expect(r.detail).toMatch(/highway=footway does not carry motor vehicles/);
  });

  it("refuses an unrecognised class rather than guessing either way", () => {
    // A new OSM value should appear in the skipped report, not become a road and not vanish.
    const r = importOsmWay(way({ highway: "some_new_value" }), AB);
    expect(r.imported).toBe(false);
    if (r.imported) throw new Error("unreachable");
    expect(r.detail).toMatch(/not a class this importer recognises/);
  });

  it("refuses a road closed to motor vehicles", () => {
    for (const tags of [{ highway: "track", access: "no" }, { highway: "track", motor_vehicle: "no" }]) {
      const r = importOsmWay(way(tags), AB);
      expect(r.imported).toBe(false);
    }
  });
});

describe("surface is not assumed", () => {
  it("does not call an untagged road paved", () => {
    /*
     * On a Range Road that guess is wrong most of the time and wrong in the expensive direction.
     * `dry_weather` reads as `review` in the suitability table, which is the honest answer.
     */
    expect(surfaceFor({ highway: "unclassified" })).toBe("dry_weather");
  });

  it("reads the surface OSM does state", () => {
    expect(surfaceFor({ highway: "primary", surface: "asphalt" })).toBe("paved");
    expect(surfaceFor({ highway: "unclassified", surface: "gravel" })).toBe("gravel");
    expect(surfaceFor({ highway: "track", surface: "dirt" })).toBe("dry_weather");
  });

  it("falls back to tracktype when surface is missing, since that is what tracks carry", () => {
    expect(surfaceFor({ highway: "track", tracktype: "grade1" })).toBe("gravel");
    expect(surfaceFor({ highway: "track", tracktype: "grade5" })).toBe("dry_weather");
  });

  it("recognises a ford, which BC tags 113 times and Alberta barely does", () => {
    // A water crossing is a constraint on a loaded unit, not a quality of the surface.
    expect(surfaceFor({ highway: "track", ford: "yes" })).toBe("ford");
  });
});

describe("no OSM tag answers a legal check", () => {
  it("keeps every legal check silent, including the ones OSM has a tag for", () => {
    const r = importOsmWay(way({ highway: "primary", maxweight: "10", maxheight: "4.2", hgv: "yes" }), AB);
    if (!r.imported) throw new Error("unreachable");
    for (const { check } of LEGAL_CHECKS) expect(r.silentChecks, check).toContain(check);
  });

  it("turns a stated limit into an advisory that says it is not a limit", () => {
    /*
     * "Nobody has told us the weight here" and "OSM says 10 t and nobody verified it" are different
     * situations for a dispatcher. The second is a reason to look before sending 52 tonnes. Neither
     * is permission to send it.
     */
    const r = importOsmWay(way({ highway: "unclassified", maxweight: "10" }), AB);
    if (!r.imported) throw new Error("unreachable");
    expect(r.advisories.join(" ")).toMatch(/road_weight_restriction: OpenStreetMap states maxweight=10 — unverified/);
    expect(r.advisories.join(" ")).toMatch(/a reason to check rather than a limit to rely on/);
  });

  it("says a bridge is there and that OSM states no capacity for it", () => {
    // 10,157 mapped bridges in BC; about one percent state a capacity.
    const r = importOsmWay(way({ highway: "unclassified", bridge: "yes" }), AB);
    if (!r.imported) throw new Error("unreachable");
    expect(r.advisories.join(" ")).toMatch(/a structure is here; OpenStreetMap states no capacity/);
  });

  it("names access=private as somebody's permission to give", () => {
    const r = importOsmWay(way({ highway: "track", access: "private" }), AB);
    if (!r.imported) throw new Error("unreachable");
    expect(r.advisories.join(" ")).toMatch(/permission to use this road is somebody's to give and is not recorded here/);
  });

  it("keeps the raw tags, because the compiler cannot weigh a tag it never saw", () => {
    const tags = { highway: "track", surface: "gravel", maxweight: "10", hazmat: "designated" };
    const r = importOsmWay(way(tags), AB);
    if (!r.imported) throw new Error("unreachable");
    expect(r.rawTags).toEqual(tags);
  });
});

describe("identity and direction", () => {
  it("namespaces by source, so two provinces and the ATS layer cannot collide", () => {
    const ab = importOsmWay(way({ highway: "track" }), AB);
    const bc = importOsmWay(way({ highway: "track" }), { sourceKey: "geofabrik_osm_bc", idPrefix: "OSM-BC-" });
    if (!ab.imported || !bc.imported) throw new Error("unreachable");
    expect(ab.segmentId).toBe("OSM-AB-way/1234567");
    expect(bc.segmentId).toBe("OSM-BC-way/1234567");
    expect(ab.segmentId).not.toBe(bc.segmentId);
  });

  it("reads oneway in both of the forms OSM uses", () => {
    const dir = (oneway?: string) => {
      const r = importOsmWay(way(oneway ? { highway: "primary", oneway } : { highway: "primary" }), AB);
      return r.imported ? r.direction : null;
    };
    expect(dir("yes")).toBe("forward");
    expect(dir("1")).toBe("forward");
    expect(dir("-1")).toBe("backward");
    expect(dir()).toBe("both");
  });
});
