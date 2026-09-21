/**
 * M2 — turning imported ways into a graph.
 *
 * `osmImport` decides whether a way is a road. This decides where roads meet, which is a different
 * question and the one that makes a graph out of a pile of lines.
 *
 * ## Why shared node ids and nothing else
 *
 * Two OSM ways connect if and only if they share a node. Geometric proximity does not connect them
 * and must not: a highway and the overpass above it cross at identical coordinates and are not
 * joined, and a pipeline right-of-way running beside a road is not a turn onto it. Every
 * "snap ways within N metres" heuristic eventually invents a junction where a truck cannot turn,
 * and a routing graph that invents junctions sends somebody down a road that does not connect.
 *
 * So topology here is exact by construction. A junction exists where the source says a junction
 * exists, and nowhere else. That also means OSM's own mistakes come through unaltered — a road that
 * really does meet another but was drawn without a shared node stays disconnected. That is the
 * right failure: a missing connection is visible as a route that will not compute, while an
 * invented one is invisible until a driver is standing at a fence.
 *
 * ## What a split is for
 *
 * A way runs from its first node to its last and may be crossed many times on the way. An edge that
 * spans three intersections cannot express "turn at the second", so each way is cut at every node
 * another way also uses. Interior nodes that nobody else touches are geometry, not junctions, and
 * are kept inside the edge rather than becoming degree-2 nodes nothing needs.
 *
 * ## Measured on Alberta
 *
 * ```
 * routable ways        508,807      junctions (2+ ways)    536,506
 * distinct nodes     2,851,772      graph edges after cuts 883,380
 * ways meeting nothing     525  (0.1%)
 * ```
 *
 * That last figure is the one that settles the no-snapping argument. If exact node matching were
 * leaving the graph in pieces, isolated ways would run to tens of thousands and something would
 * have to bridge the gaps. At 0.1% the source's own topology is sound, so inventing junctions would
 * buy almost nothing and risk the failure that cannot be seen — a turn that exists in the graph and
 * not on the ground.
 *
 * Most ways are cut once or not at all (366,824 stay whole); 20,424 come apart into six pieces or
 * more, which is what a long range road crossed by a township grid looks like.
 */

import type { LngLat } from "./geoImport";

/** A way as the importer accepted it, with the node ids OSM gave it. */
export type WayForTopology = {
  segmentId: string;
  label: string;
  /** OSM node ids in order. Shared ids between ways are what makes a junction. */
  nodeIds: readonly number[];
  geometry: readonly LngLat[];
  direction: "both" | "forward" | "backward";
};

export type TopologyEdge = {
  /** The parent way's segment id plus which piece of it this is. */
  edgeId: string;
  segmentId: string;
  label: string;
  fromNodeKey: string;
  toNodeKey: string;
  geometry: readonly LngLat[];
  direction: "both" | "forward" | "backward";
  /** How many pieces the parent way was cut into. 1 means it met nothing. */
  ofPieces: number;
};

export type TopologyResult = {
  edges: readonly TopologyEdge[];
  /** Nodes used by more than one way — the junctions. */
  junctionCount: number;
  /** Ways that met nothing at all. High counts here are worth looking at, not worth panicking over. */
  isolatedWays: number;
};

/** Node identity is namespaced like everything else: two sources may both have a node 1234. */
export function nodeKey(prefix: string, osmNodeId: number): string {
  return `${prefix}node/${osmNodeId}`;
}

/**
 * Count how many distinct ways use each node.
 *
 * A node used twice **by the same way** is not a junction — it is a loop, a turning circle or a
 * way that doubles back, and treating it as a junction would cut a road at a point where nothing
 * joins. So membership is counted per way, not per occurrence.
 */
export function nodeUsage(ways: readonly WayForTopology[]): Map<number, number> {
  const usage = new Map<number, number>();
  for (const w of ways) {
    // `Array.from` rather than iterating the Set directly: the production tsconfig sets no
    // `target`, so TypeScript falls back to ES5 there and refuses. Changing what the production
    // build emits is a decision of its own, not a side effect of adding a module.
    Array.from(new Set(w.nodeIds)).forEach(id => usage.set(id, (usage.get(id) ?? 0) + 1));
  }
  return usage;
}

/**
 * Cut each way at the nodes it shares with another way.
 *
 * Endpoints are always cut points even when nothing meets there: a way has to start and end
 * somewhere, and an edge with no endpoints is not an edge.
 */
export function buildTopology(
  ways: readonly WayForTopology[],
  source: { idPrefix: string },
): TopologyResult {
  const usage = nodeUsage(ways);
  const edges: TopologyEdge[] = [];
  let isolated = 0;

  for (const w of ways) {
    if (w.nodeIds.length < 2) continue;

    const cutAt = new Set<number>([0, w.nodeIds.length - 1]);
    for (let i = 1; i < w.nodeIds.length - 1; i++) {
      if ((usage.get(w.nodeIds[i]!) ?? 0) > 1) cutAt.add(i);
    }
    const cuts = Array.from(cutAt).sort((a, b) => a - b);
    if (cuts.length === 2) {
      // Both endpoints unshared as well means this way touches nothing in the extract.
      const endsShared = (usage.get(w.nodeIds[0]!) ?? 0) > 1 || (usage.get(w.nodeIds[w.nodeIds.length - 1]!) ?? 0) > 1;
      if (!endsShared) isolated++;
    }

    const pieces = cuts.length - 1;
    for (let p = 0; p < pieces; p++) {
      const a = cuts[p]!, b = cuts[p + 1]!;
      edges.push({
        edgeId: pieces === 1 ? w.segmentId : `${w.segmentId}#${p + 1}`,
        segmentId: w.segmentId,
        label: w.label,
        fromNodeKey: nodeKey(source.idPrefix, w.nodeIds[a]!),
        toNodeKey: nodeKey(source.idPrefix, w.nodeIds[b]!),
        // The geometry of this piece, endpoints included, so the edge draws as the road drew.
        geometry: w.geometry.slice(a, b + 1),
        direction: w.direction,
        ofPieces: pieces,
      });
    }
  }

  let junctions = 0;
  usage.forEach(n => { if (n > 1) junctions++; });
  return { edges, junctionCount: junctions, isolatedWays: isolated };
}

/**
 * Which edges leave a node.
 *
 * Direction is honoured: a `forward` edge can be left only from its `from` end, and a router that
 * ignored that would happily plan a route the wrong way up a divided highway. `backward` is OSM's
 * `oneway=-1` — the way is drawn one way and travelled the other.
 */
export function edgesLeaving(edges: readonly TopologyEdge[], from: string): TopologyEdge[] {
  return edges.filter(e =>
    (e.direction === "both" && (e.fromNodeKey === from || e.toNodeKey === from)) ||
    (e.direction === "forward" && e.fromNodeKey === from) ||
    (e.direction === "backward" && e.toNodeKey === from));
}
