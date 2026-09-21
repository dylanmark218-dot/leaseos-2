/**
 * M2 — where roads meet, and where they only appear to.
 */
import { describe, expect, it } from "vitest";
import { buildTopology, edgesLeaving, nodeUsage, type WayForTopology } from "./osmTopology";

const AB = { idPrefix: "OSM-AB-" };
const pt = (n: number) => [-114 + n / 100, 53 + n / 100] as [number, number];
const way = (segmentId: string, nodeIds: number[], over: Partial<WayForTopology> = {}): WayForTopology =>
  ({ segmentId, label: segmentId, nodeIds, geometry: nodeIds.map(pt), direction: "both", ...over });

describe("a junction exists where the source says one does", () => {
  it("cuts a way at the node another way shares", () => {
    // A range road crossed by a township road halfway along.
    const r = buildTopology([way("A", [1, 2, 3]), way("B", [9, 2, 8])], AB);
    expect(r.junctionCount).toBe(1);
    expect(r.edges.map(e => e.edgeId).sort()).toEqual(["A#1", "A#2", "B#1", "B#2"]);
    expect(r.edges.find(e => e.edgeId === "A#1")!.toNodeKey).toBe("OSM-AB-node/2");
  });

  it("does not join ways that cross without sharing a node", () => {
    /*
     * The overpass case, and the reason proximity is never used: these two cross at the same place
     * on a map and a truck cannot turn from one to the other. A graph that joined them would send
     * somebody onto a highway from the road above it.
     */
    const r = buildTopology([way("A", [1, 2, 3]), way("B", [7, 8, 9])], AB);
    expect(r.junctionCount).toBe(0);
    expect(r.edges).toHaveLength(2);
    expect(r.edges.every(e => e.ofPieces === 1)).toBe(true);
  });

  it("leaves an unshared interior node as geometry, not a junction", () => {
    // A bend in the road is not somewhere to turn.
    const r = buildTopology([way("A", [1, 2, 3, 4, 5])], AB);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.geometry).toHaveLength(5);
  });

  it("does not cut at a node one way uses twice", () => {
    // A loop or a turning circle: the same node, one way, nothing joining.
    const usage = nodeUsage([way("A", [1, 2, 3, 2, 4])]);
    expect(usage.get(2)).toBe(1);
    expect(buildTopology([way("A", [1, 2, 3, 2, 4])], AB).edges).toHaveLength(1);
  });

  it("counts a way that meets nothing", () => {
    const r = buildTopology([way("A", [1, 2]), way("B", [3, 4]), way("C", [4, 5])], AB);
    expect(r.isolatedWays).toBe(1);   // A; B and C share node 4
  });
});

describe("pieces keep their parent and their geometry", () => {
  it("names each piece after the way it came from", () => {
    const r = buildTopology([way("OSM-AB-way/77", [1, 2, 3]), way("X", [5, 2, 6])], AB);
    const pieces = r.edges.filter(e => e.segmentId === "OSM-AB-way/77");
    expect(pieces.map(e => e.edgeId)).toEqual(["OSM-AB-way/77#1", "OSM-AB-way/77#2"]);
    expect(pieces.every(e => e.ofPieces === 2)).toBe(true);
  });

  it("leaves an uncut way with its own id, not a #1 suffix", () => {
    // A way that meets nothing is one edge and should read as one, not as the first of one.
    expect(buildTopology([way("OSM-AB-way/77", [1, 2])], AB).edges[0]!.edgeId).toBe("OSM-AB-way/77");
  });

  it("gives each piece the span of geometry it covers, endpoints included", () => {
    const r = buildTopology([way("A", [1, 2, 3, 4, 5]), way("B", [9, 3, 8])], AB);
    const [first, second] = r.edges.filter(e => e.segmentId === "A");
    expect(first!.geometry).toHaveLength(3);    // nodes 1,2,3
    expect(second!.geometry).toHaveLength(3);   // nodes 3,4,5
    expect(first!.geometry.at(-1)).toEqual(second!.geometry[0]);
  });
});

describe("direction is honoured when leaving a node", () => {
  it("lets a two-way edge be left from either end", () => {
    const r = buildTopology([way("A", [1, 2])], AB);
    expect(edgesLeaving(r.edges, "OSM-AB-node/1")).toHaveLength(1);
    expect(edgesLeaving(r.edges, "OSM-AB-node/2")).toHaveLength(1);
  });

  it("lets a forward edge be left only from its start", () => {
    // Otherwise a router plans a route the wrong way up a divided highway.
    const r = buildTopology([way("A", [1, 2], { direction: "forward" })], AB);
    expect(edgesLeaving(r.edges, "OSM-AB-node/1")).toHaveLength(1);
    expect(edgesLeaving(r.edges, "OSM-AB-node/2")).toHaveLength(0);
  });

  it("reads backward as travelled against the way's drawing", () => {
    // OSM's oneway=-1.
    const r = buildTopology([way("A", [1, 2], { direction: "backward" })], AB);
    expect(edgesLeaving(r.edges, "OSM-AB-node/2")).toHaveLength(1);
    expect(edgesLeaving(r.edges, "OSM-AB-node/1")).toHaveLength(0);
  });
});

describe("node identity is namespaced like everything else", () => {
  it("cannot collide between two sources on the same node number", () => {
    const ab = buildTopology([way("A", [1, 2])], AB).edges[0]!;
    const bc = buildTopology([way("A", [1, 2])], { idPrefix: "OSM-BC-" }).edges[0]!;
    expect(ab.fromNodeKey).toBe("OSM-AB-node/1");
    expect(bc.fromNodeKey).toBe("OSM-BC-node/1");
  });
});
