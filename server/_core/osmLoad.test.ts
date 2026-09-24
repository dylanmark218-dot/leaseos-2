/**
 * M2 — the loader. Four lines of text instead of a 350 MB fixture, which is the whole point of
 * splitting extraction from loading.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OSM_EXTRACT_FORMAT_VERSION, parseExtractLine, planIsLoadable, planLoad, refusalSummary } from "./osmLoad";

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

/* ------------------------------------------------------------------ */
/* RI-P2 — what osmLoadPlan enforced, carried into the one loader      */
/* ------------------------------------------------------------------ */
/*
 * `osmLoadPlan.ts` was a second reader of the same extract with its own tests. It is deleted in this
 * change, so every rule it enforced has to be enforced here first. The v23.29 line folded the two
 * and dropped three of those rules on the way; each case below names the osmLoadPlan test it
 * replaces, and the three marked RESTORED are the ones the fold had lost.
 */
describe("the header says what the extract is of, completely (from osmLoadPlan)", () => {
  it("reads a well-formed header and its ways, and keeps the header on the plan", () => {
    // osmLoadPlan: "reads a well-formed header and its ways"
    const plan = planLoad([hdr(), rec(1, { highway: "unclassified", name: "Range Road 51" }, [11, 12])], OPTS);
    expect(plan.header).toMatchObject({ sourceKey: "geofabrik_osm_ab", extractFile: "alberta-260910.osm.pbf", extractSha256: "abc123", extractPublishedAt: "2026-09-10T00:00:00Z" });
    expect(plan.counts.waysImported).toBe(1);
    expect(plan.refusals).toHaveLength(0);
    expect(planIsLoadable(plan)).toEqual({ loadable: true, reasons: [] });
  });

  it("takes the source's standing from the registry, not from the file", () => {
    // osmLoadPlan: "takes the source's standing from the registry, not from the file"
    // An extraction that could assert its own confidence would be a road dataset marking its own work.
    const plan = planLoad([hdr({ confidence: "authority_confirmed", idPrefix: "MINE-" }), rec(1, { highway: "track" }, [1, 2])], OPTS);
    expect(plan.edges[0]!.segmentId.startsWith("OSM-AB-")).toBe(true);
  });

  it("RESTORED: refuses a header that names a different source than the one being loaded", () => {
    // osmLoadPlan read the source from the header; this loader takes it from the caller. When the two
    // disagree, loading would give a British Columbia extract Alberta's standing and jurisdiction.
    const plan = planLoad([hdr({ sourceKey: "geofabrik_osm_bc" }), rec(1, { highway: "track" }, [1, 2])], OPTS);
    expect(plan.counts.waysImported).toBe(0);
    expect(plan.header).toBeNull();
    expect(plan.refusals[0]).toMatchObject({ line: 1, reason: "source_mismatch" });
    expect(plan.refusals[0]!.detail).toMatch(/geofabrik_osm_bc/);
    expect(planIsLoadable(plan).loadable).toBe(false);
  });

  it("RESTORED: names the header field that is missing, for every required field", () => {
    // osmLoadPlan: "names the header field that is missing"
    for (const field of ["sourceKey", "extractFile", "extractSha256", "extractPublishedAt"]) {
      const plan = planLoad([hdr({ [field]: "" }), rec(1, { highway: "track" }, [1, 2])], OPTS);
      expect(plan.counts.waysImported, field).toBe(0);
      expect(plan.refusals[0], field).toMatchObject({ line: 1, reason: "bad_header" });
      expect(plan.refusals[0]!.detail, field).toBe(`header has no ${field}`);
    }
  });

  it("refuses a version it does not read, and the plan is not loadable", () => {
    // osmLoadPlan: "refuses a version it does not read, rather than reading it leniently"
    const plan = planLoad([hdr({ version: OSM_EXTRACT_FORMAT_VERSION + 1 }), rec(1, { highway: "track" }, [1, 2])], OPTS);
    expect(plan.header).toBeNull();
    expect(plan.refusals[0]!.reason).toBe("wrong_version");
    expect(planIsLoadable(plan).loadable).toBe(false);
  });

  it("stops at a bad header with exactly one refusal, however many lines follow", () => {
    // osmLoadPlan: "stops at a bad header instead of reporting thousands of identical rejections"
    const plan = planLoad([JSON.stringify({ format: "something_else" }), rec(1, { highway: "track" }, [1, 2]), rec(2, { highway: "track" }, [3, 4]), rec(3, { highway: "track" }, [5, 6])], OPTS);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]!.reason).toBe("bad_header");
    expect(plan.counts.waysImported).toBe(0);
  });
});

describe("a dropped road is reported, never silent (from osmLoadPlan)", () => {
  it("reports an unparseable line by number and keeps reading", () => {
    // osmLoadPlan: "reports an unparseable line by number and keeps reading"
    const plan = planLoad([hdr(), rec(1, { highway: "track" }, [1, 2]), "{not json", rec(2, { highway: "track" }, [3, 4])], OPTS);
    expect(plan.counts.waysImported).toBe(2);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]).toMatchObject({ line: 3, reason: "malformed_json" });
  });

  it("refuses a way whose node ids and coordinates disagree, inside a real plan", () => {
    // osmLoadPlan: "refuses a way whose node ids and coordinates disagree"
    const bad = JSON.stringify({ id: 9, tags: { highway: "track" }, nodes: [11, 12, 13], geometry: [[-114.1, 53.4], [-114.0, 53.5]] });
    const plan = planLoad([hdr(), bad], OPTS);
    expect(plan.counts.waysImported).toBe(0);
    expect(plan.refusals[0]).toMatchObject({ line: 2, reason: "arrays_disagree", detail: "3 nodes, 2 coordinates" });
  });

  it("refuses a way record missing a required field, inside a real plan", () => {
    // osmLoadPlan: "refuses a way record missing a required field"
    const plan = planLoad([hdr(), JSON.stringify({ id: 5, tags: {} })], OPTS);
    expect(plan.refusals[0]).toMatchObject({ line: 2, reason: "missing_field" });
  });
});

describe("a plan is loadable only when there is something true to build (from osmLoadPlan)", () => {
  it("refuses an unregistered source even though the registry would hand it an id prefix", () => {
    // osmLoadPlan: "refuses an unregistered source even though it has an id prefix" — here it is
    // refused before a plan exists at all, which is stronger: no plan, nothing to mistake for one.
    expect(() => planLoad([hdr({ sourceKey: "somebody_elses_extract" }), rec(1, { highway: "track" }, [1, 2])], { ...OPTS, sourceKey: "somebody_elses_extract" }))
      .toThrow(/no strategy anyone has recorded/);
  });

  it("RESTORED: refuses a valid header with no way records behind it — a build of nothing is not a build", () => {
    // osmLoadPlan: "refuses a header with no ways behind it"
    const plan = planLoad([hdr()], OPTS);
    expect(plan.header).not.toBeNull();
    expect(plan.refusals).toHaveLength(0);
    expect(planIsLoadable(plan).reasons).toContain("header is valid but no way records followed");
    expect(planIsLoadable(plan).loadable).toBe(false);
  });

  it("refuses an empty file without crashing on it", () => {
    // osmLoadPlan: "refuses an empty file without crashing on it"
    const plan = planLoad([], OPTS);
    expect(planIsLoadable(plan).reasons).toContain("no valid extract header");
  });

  it("is loadable when every line was refused for a healthy reason — refusals are counted, not fatal", () => {
    // Footpaths are refused in every real build; a plan whose records were all read is loadable, and
    // what it refused is in refusalSummary for a person to judge.
    const plan = planLoad([hdr(), rec(1, { highway: "footway" }, [1, 2])], OPTS);
    expect(planIsLoadable(plan).loadable).toBe(true);
    expect(refusalSummary(plan)).toEqual({ not_vehicle_accessible: 1 });
  });
});

describe("one loader", () => {
  it("osmLoadPlan is gone, and nothing in production or scripts still imports it", () => {
    expect(existsSync("server/_core/osmLoadPlan.ts")).toBe(false);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.name === "node_modules" ? [] : d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]);
    const offenders = [...walk("server"), ...walk("scripts"), ...walk("tools")]
      .filter(f => /\.(ts|py|sh)$/.test(f) && !f.endsWith("osmLoad.test.ts"))
      // An import or dynamic import of the module, not a comment that remembers it existed.
      .filter(f => /(from\s+|import\(\s*|require\(\s*)["'][^"']*osmLoadPlan["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the extractor writes the header this loader requires, with no silent source or date", () => {
    const py = readFileSync("tools/osm-extract.py", "utf8");
    expect(py).toMatch(/"format":"leaseos\.osm\.intermediate"/);
    expect(py).toMatch(/"version":1/);
    expect(py).not.toMatch(/else "geofabrik_osm_ab"/);
    expect(py).not.toMatch(/extractPublishedAt":\s*sys\.argv\[8\] if len\(sys\.argv\)>8 else ""/);
  });
});

