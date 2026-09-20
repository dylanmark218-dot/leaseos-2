/**
 * Which joining rule a source gets, and why the two are not interchangeable.
 *
 * `roadGraph.buildGraph` joins by coordinate with a 5 m tolerance. `osmTopology.buildTopology`
 * joins by shared node id and never by distance. Both are right, for different inputs, and running
 * a source through the wrong one fails quietly in both directions:
 *
 *   - a coordinate source through exact matching becomes disconnected fragments, because two
 *     surveys of the same intersection disagree by a metre or two;
 *   - an id-bearing source through snapping gains junctions nobody can drive, because a highway and
 *     its overpass cross at identical coordinates.
 *
 * The second is the dangerous one. A fragmented graph refuses to route and somebody notices; an
 * invented junction routes beautifully until a driver is standing at a fence. So the strategy is a
 * property of the source, recorded beside its identity and confidence, rather than a parameter
 * whoever writes the next loader has to remember.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROAD_SOURCE_STANDING, standingFor } from "./legalLand";

describe("every source says how its roads join", () => {
  it("leaves no registered source without a strategy", () => {
    for (const [key, standing] of Object.entries(ROAD_SOURCE_STANDING)) {
      expect(standing.topology, `${key} has no topology strategy`).not.toBeNull();
    }
  });

  it("gives every OSM extract shared node ids", () => {
    for (const key of ["geofabrik_osm_ab", "geofabrik_osm_bc", "geofabrik_osm_sk"]) {
      expect(standingFor(key).topology, key).toBe("shared_node_ids");
    }
  });

  it("gives the surveyed authority source coordinate snapping", () => {
    // ATS road allowance carries coordinates and no vertex identity: position is all there is.
    expect(standingFor("ats_road_allowance").topology).toBe("coordinate_snap");
  });

  it("says nothing about an unregistered source rather than guessing", () => {
    /*
     * A default would have to be one of the two, and both are wrong half the time. Null forces
     * whoever adds a source to answer, which takes a moment and is the whole point.
     */
    expect(standingFor("something_nobody_registered").topology).toBeNull();
  });
});

describe("the two builders stay apart", () => {
  it("keeps snapping out of the OSM path entirely", () => {
    const topo = readFileSync("server/_core/osmTopology.ts", "utf8");
    expect(topo).not.toMatch(/snapTolerance|haversine|within .* metres of/i);
    expect(topo).toMatch(/share a node/);
  });

  it("keeps the coordinate builder's tolerance, because its input needs it", () => {
    /*
     * Not a defect to remove. ATS endpoints are surveyed, and without a tolerance every surveyed
     * near-miss becomes a dead end. This pins it so a later reading of the OSM rule does not get
     * applied to the source it would break.
     */
    const graph = readFileSync("server/_core/roadGraph.ts", "utf8");
    expect(graph).toMatch(/snapToleranceMetres\?: number/);
    expect(graph).toMatch(/opts\.snapToleranceMetres \?\? 5/);
  });
});
