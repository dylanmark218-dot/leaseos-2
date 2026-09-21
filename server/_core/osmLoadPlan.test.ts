/**
 * M2 — reading an extraction, and what it refuses to read.
 *
 * The loader is testable with a few lines of text precisely because PBF parsing lives outside it.
 */
import { describe, expect, it } from "vitest";
import { OSM_INTERMEDIATE_FORMAT_VERSION, planIsLoadable, planLoad } from "./osmLoadPlan";

const header = (over: Record<string, unknown> = {}) => JSON.stringify({
  format: "leaseos.osm.intermediate",
  version: OSM_INTERMEDIATE_FORMAT_VERSION,
  sourceKey: "geofabrik_osm_ab",
  extractFile: "alberta-260910.osm.pbf",
  extractSha256: "a".repeat(64),
  extractPublishedAt: "2026-09-10",
  wayCount: 1,
  ...over,
});
const way = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: 1234567,
  tags: { highway: "unclassified", name: "Range Road 51" },
  nodeIds: [11, 12],
  geometry: [[-114.1, 53.4], [-114.0, 53.5]],
  ...over,
});

describe("an extraction says what it is of", () => {
  it("reads a well-formed header and its ways", () => {
    const plan = planLoad([header(), way()]);
    expect(plan.header?.extractSha256).toBe("a".repeat(64));
    expect(plan.ways).toHaveLength(1);
    expect(plan.rejections).toHaveLength(0);
    expect(planIsLoadable(plan).loadable).toBe(true);
  });

  it("takes the source's standing from the registry, not from the file", () => {
    /*
     * The extraction names a source; what that source's claims are worth is `0164`'s business. An
     * extraction that could assert its own confidence would be a road dataset marking its own work.
     */
    const plan = planLoad([header(), way()]);
    expect(plan.idPrefix).toBe("OSM-AB-");
    expect(plan.topology).toBe("shared_node_ids");
  });

  it("refuses a version it does not read, rather than reading it leniently", () => {
    // Guessing which half of a changed contract still applies is how roads come out subtly wrong.
    const plan = planLoad([header({ version: 99 }), way()]);
    expect(plan.header).toBeNull();
    expect(plan.rejections[0]!.reason).toBe("wrong_version");
    expect(planIsLoadable(plan).loadable).toBe(false);
  });

  it("stops at a bad header instead of reporting thousands of identical rejections", () => {
    const plan = planLoad([JSON.stringify({ format: "something_else" }), way(), way(), way()]);
    expect(plan.rejections).toHaveLength(1);
    expect(plan.rejections[0]!.reason).toBe("wrong_format");
    expect(plan.ways).toHaveLength(0);
  });

  it("names the header field that is missing", () => {
    const plan = planLoad([header({ extractSha256: "" }), way()]);
    expect(plan.rejections[0]!.detail).toMatch(/header has no extractSha256/);
  });
});

describe("a dropped road is reported, never silent", () => {
  it("reports an unparseable line by number and keeps reading", () => {
    /*
     * An extraction that quietly drops roads and reports success is worse than one that fails: the
     * graph looks complete and the holes are wherever the dropped roads were.
     */
    const plan = planLoad([header(), way(), "{not json", way()]);
    expect(plan.ways).toHaveLength(2);
    expect(plan.rejections).toHaveLength(1);
    expect(plan.rejections[0]!.line).toBe(3);
    expect(plan.rejections[0]!.reason).toBe("unparseable");
  });

  it("refuses a way whose node ids and coordinates disagree", () => {
    /*
     * Topology cuts by node index and takes the geometry at that index. If the two disagree, an
     * edge gets somebody else's shape — it draws, it routes, and it is the wrong road.
     */
    const plan = planLoad([header(), way({ nodeIds: [11, 12, 13] })]);
    expect(plan.ways).toHaveLength(0);
    expect(plan.rejections[0]!.reason).toBe("geometry_mismatch");
    expect(plan.rejections[0]!.detail).toMatch(/3 node ids against 2 coordinates/);
  });

  it("refuses a way record missing a required field", () => {
    const plan = planLoad([header(), JSON.stringify({ id: 5, tags: {} })]);
    expect(plan.rejections[0]!.reason).toBe("missing_field");
  });
});

describe("a plan is not loadable without a rule for joining", () => {
  it("refuses an unregistered source even though it has an id prefix", () => {
    /*
     * `standingFor` answers for anything with a generated prefix, so identity alone would let a
     * load proceed with no idea how its roads connect. The join is not a detail; it is the graph.
     */
    const plan = planLoad([header({ sourceKey: "somebody_elses_extract" }), way()]);
    expect(plan.idPrefix).not.toBeNull();
    expect(plan.topology).toBeNull();
    const v = planIsLoadable(plan);
    expect(v.loadable).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/not registered, so there is no rule for how its roads join/);
  });

  it("refuses a header with no ways behind it", () => {
    expect(planIsLoadable(planLoad([header()])).reasons).toContain("header is valid but no way records followed");
  });

  it("refuses an empty file without crashing on it", () => {
    expect(planIsLoadable(planLoad([])).reasons).toContain("no valid extract header");
  });
});
