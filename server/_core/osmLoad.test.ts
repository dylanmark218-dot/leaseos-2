/**
 * M2 — the loader. Four lines of text instead of a 350 MB fixture, which is the whole point of
 * splitting extraction from loading.
 */
import { describe, expect, it } from "vitest";
import { parseExtractLine, planLoad, refusalSummary } from "./osmLoad";

const rec = (id: number, tags: Record<string, string>, nodes: number[]) =>
  JSON.stringify({ id, tags, nodes, geometry: nodes.map(n => [-114 + n / 1000, 53 + n / 1000]) });

const OPTS = { buildRef: "RG-TEST", sourceKey: "geofabrik_osm_ab", extractSha256: "abc123" };

/** A valid first line. The header became mandatory when version checking landed, so every fixture
 *  that expects records to be read needs one. */
const hdr = (o: Record<string, unknown> = {}) => JSON.stringify({
  format: "leaseos.osm.intermediate", version: 1, sourceKey: "geofabrik_osm_ab",
  extractFile: "alberta-260910.osm.pbf", extractSha256: "abc123",
  extractPublishedAt: "2026-09-10T00:00:00Z", ...o,
});

describe("a line becomes a record or says what is wrong with it", () => {
  it("refuses malformed JSON by line number", () => {
    // 1-based, so it matches what an editor shows when somebody goes to look.
    const r = parseExtractLine("{not json", 7);
    expect(r).toMatchObject({ line: 7, reason: "malformed_json" });
  });

  it("refuses a record missing a field it needs", () => {
    expect(parseExtractLine(JSON.stringify({ id: 1, tags: {} }), 2)).toMatchObject({ reason: "missing_field" });
  });

  it("refuses a way whose ids and coordinates are different lengths", () => {
    /*
     * The pair has to stay in step, or a cut lands on the wrong vertex and the edge gets the right
     * endpoints with the wrong shape — which draws convincingly and routes somebody down the wrong
     * road.
     */
    const bad = JSON.stringify({ id: 1, tags: { highway: "track" }, nodes: [1, 2, 3], geometry: [[-114, 53]] });
    expect(parseExtractLine(bad, 3)).toMatchObject({ reason: "arrays_disagree", detail: "3 nodes, 1 coordinates" });
  });
});

describe("planning a build", () => {
  it("builds edges and junctions from crossing ways", () => {
    const plan = planLoad([
      hdr(),
      rec(1, { highway: "unclassified", name: "Range Road 51" }, [10, 20, 30]),
      rec(2, { highway: "residential", name: "Township Road 520" }, [40, 20, 50]),
    ], OPTS);
    expect(plan.counts.waysImported).toBe(2);
    expect(plan.junctionCount).toBe(1);
    expect(plan.counts.edgesBuilt).toBe(4);
    expect(plan.edges[0]!.segmentId).toBe("OSM-AB-way/1");
  });

  it("records every refusal with its line, rather than skipping it", () => {
    /*
     * An extract that silently loses ways to a serialisation bug produces a graph with holes, and a
     * hole in a road graph looks exactly like a road that is not there.
     */
    const plan = planLoad([
      hdr(),
      rec(1, { highway: "track" }, [1, 2]),
      "{broken",
      rec(3, { highway: "footway" }, [5, 6]),
      rec(4, { highway: "track", access: "no" }, [7, 8]),
    ], OPTS);
    expect(plan.counts.waysImported).toBe(1);
    expect(plan.refusals.map(r => r.line)).toEqual([3, 4, 5]);
    expect(refusalSummary(plan)).toEqual({ malformed_json: 1, not_vehicle_accessible: 1, access_forbidden: 1 });
  });

  it("separates refusal reasons, because one kind is healthy and another is a broken extract", () => {
    // 223,334 footpaths refused is a normal Alberta build. 4,000 malformed lines is not.
    const plan = planLoad([hdr(), rec(1, { highway: "footway" }, [1, 2]), "{x", "{y"], OPTS);
    const summary = refusalSummary(plan);
    expect(summary.not_vehicle_accessible).toBe(1);
    expect(summary.malformed_json).toBe(2);
  });

  it("ignores blank lines without counting them as anything", () => {
    const plan = planLoad([hdr(), rec(1, { highway: "track" }, [1, 2]), "", "   "], OPTS);
    expect(plan.counts.linesRead).toBe(1);
    expect(plan.refusals).toHaveLength(0);
  });

  it("keeps linesRead reconcilable: every line read is either imported or refused", () => {
    /*
     * The header is not a record. Counting it would put every report one over, and the arithmetic
     * below is the only thing that makes the numbers auditable rather than decorative.
     */
    const plan = planLoad([
      hdr(),
      rec(1, { highway: "track" }, [1, 2]),
      rec(2, { highway: "footway" }, [3, 4]),
      "{broken",
    ], OPTS);
    expect(plan.counts.linesRead).toBe(plan.counts.waysImported + plan.refusals.length);
  });

  it("carries the extract's checksum, not just its name", () => {
    /*
     * Months later the question is "which file produced the graph that approved this route", and a
     * filename does not answer it — Geofabrik reuses names every day.
     */
    expect(planLoad([hdr(), rec(1, { highway: "track" }, [1, 2])], OPTS).extractSha256).toBe("abc123");
  });
});

describe("the loader refuses a source it cannot join", () => {
  it("refuses a coordinate-snap source by name", () => {
    // ATS has no node ids; running it through here would produce a graph of fragments.
    expect(() => planLoad([], { ...OPTS, sourceKey: "ats_road_allowance" }))
      .toThrow(/joins by coordinate_snap, not shared node ids/);
  });

  it("refuses an unregistered source rather than assuming a strategy", () => {
    // Unanswered is not permission.
    expect(() => planLoad([], { ...OPTS, sourceKey: "somebody_new" }))
      .toThrow(/no strategy anyone has recorded/);
  });

  it("accepts each registered OSM extract", () => {
    for (const sourceKey of ["geofabrik_osm_ab", "geofabrik_osm_bc", "geofabrik_osm_sk"]) {
      expect(() => planLoad([rec(1, { highway: "track" }, [1, 2])], { ...OPTS, sourceKey })).not.toThrow();
    }
  });
});

describe("the header is checked before anything is read", () => {
  it("stops on a first line that is not a header, rather than rejecting every line after it", () => {
    /*
     * Judging thousands of following lines against a contract we could not confirm produces
     * thousands of identical rejections, and that is not a report — it is noise with the real
     * answer buried in line one.
     */
    const plan = planLoad([rec(1, { highway: "track" }, [1, 2]), rec(2, { highway: "track" }, [3, 4])], OPTS);
    expect(plan.counts.waysImported).toBe(0);
    expect(plan.refusals).toEqual([{ line: 1, reason: "bad_header", detail: "first line is not an extract header" }]);
  });

  it("refuses a format version it does not know", () => {
    // A format change read by an old loader writes roads that are subtly wrong and reports success.
    const plan = planLoad([hdr({ version: 2 }), rec(1, { highway: "track" }, [1, 2])], OPTS);
    expect(plan.counts.waysImported).toBe(0);
    expect(plan.refusals[0]).toMatchObject({ line: 1, reason: "wrong_version" });
  });

  it("catches the file you hashed not being the file you are reading", () => {
    const plan = planLoad([hdr({ extractSha256: "deadbeef" }), rec(1, { highway: "track" }, [1, 2])], OPTS);
    expect(plan.counts.waysImported).toBe(0);
    expect(plan.refusals[0]).toMatchObject({ line: 1, reason: "extract_mismatch" });
  });

  it("refuses an empty extract instead of reporting a successful build of nothing", () => {
    const plan = planLoad([], OPTS);
    expect(plan.refusals).toEqual([{ line: 1, reason: "bad_header", detail: "empty extract" }]);
  });
});
