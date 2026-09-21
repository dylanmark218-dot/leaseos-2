/**
 * v22.16 — The first routing graph, built from imported road data.
 *
 * Pure. No network, no database. Alberta's access-road layer is properly
 * noded — across one township, 440 endpoints meet another segment's endpoint
 * exactly and one is a T-junction — so the graph joins segments at their
 * endpoints, with a snap tolerance for the near-misses.
 *
 * This answers only the first of the two routing questions the architecture
 * separates: *what roads connect A and B*. Whether **this** truck with
 * **this** load may travel them is the four-axis evaluator's question, and
 * this module never answers it. A path here is a proposal to evaluate, not a
 * permission to drive.
 */
import { distanceToPathMetres, haversineMetres, pathLengthMetres, type LngLat, type SurfaceKind } from "./geoImport";

export type GraphSegment = { segmentId: string; accessRoadObjectId: number; label: string; surfaceKind: SurfaceKind; path: LngLat[]; sourceKey?: string | null; sourceLayer?: string | null; sourceFeatureId?: string | null; sourceVersion?: string | null };
export type GraphNode = { nodeKey: string; latitude: number; longitude: number; degree: number; componentId: number };
export type GraphEdge = { segmentId: string; accessRoadObjectId: number; label: string; /** 0164: the source that produced this edge, carried so the evaluator is told the truth about it. */ sourceKey?: string | null; sourceLayer?: string | null; sourceFeatureId?: string | null; sourceVersion?: string | null; fromNodeKey: string; toNodeKey: string; lengthMetres: number; surfaceKind: SurfaceKind; featureTypeLabel?: string | null; componentId: number; path: LngLat[] };
export type Graph = { nodes: Map<string, GraphNode>; edges: GraphEdge[]; adjacency: Map<string, GraphEdge[]>; componentCount: number; largestComponentEdges: number; isolatedEdges: number; excludedSurfaces: SurfaceKind[]; segmentsConsidered: number };

/** Surfaces a loaded commercial unit is never routed down. A driveway is somebody's yard; a ferry and a ford are not roads. */
export const NOT_ROUTABLE: readonly SurfaceKind[] = ["driveway", "ferry", "ford"];

/** A node key is a rounded coordinate: ~11 cm at six decimals, which is finer than any surveyed endpoint disagreement. */
export const nodeKeyFor = (p: LngLat, precision = 6): string => `${p[1].toFixed(precision)},${p[0].toFixed(precision)}`;

/**
 * Build the graph. Endpoints join exactly at the key's precision; anything
 * within the snap tolerance of an already-known node joins it instead of
 * starting a new one, which is what closes the surveyed near-misses.
 */
export function buildGraph(segments: readonly GraphSegment[], opts: { snapToleranceMetres?: number; excludeSurfaces?: readonly SurfaceKind[] } = {}): Graph {
  const snap = opts.snapToleranceMetres ?? 5;
  const excluded = (opts.excludeSurfaces ?? NOT_ROUTABLE) as SurfaceKind[];
  const usable = segments.filter(s => !excluded.includes(s.surfaceKind) && s.path.length >= 2);
  const nodes = new Map<string, GraphNode>();
  const nodeList: GraphNode[] = [];

  const nodeFor = (p: LngLat): GraphNode => {
    const exact = nodes.get(nodeKeyFor(p));
    if (exact) return exact;
    for (const n of nodeList) { if (haversineMetres(p, [n.longitude, n.latitude]) <= snap) return n; }
    const node: GraphNode = { nodeKey: nodeKeyFor(p), latitude: p[1], longitude: p[0], degree: 0, componentId: 0 };
    nodes.set(node.nodeKey, node); nodeList.push(node);
    return node;
  };

  const edges: GraphEdge[] = [];
  for (const s of usable) {
    const from = nodeFor(s.path[0]!), to = nodeFor(s.path[s.path.length - 1]!);
    if (from.nodeKey === to.nodeKey) continue;                       // a loop that returns to its own start connects nothing
    from.degree += 1; to.degree += 1;
    edges.push({ segmentId: s.segmentId, accessRoadObjectId: s.accessRoadObjectId, label: s.label, sourceKey: s.sourceKey ?? null, sourceLayer: s.sourceLayer ?? null, sourceFeatureId: s.sourceFeatureId ?? null, sourceVersion: s.sourceVersion ?? null, fromNodeKey: from.nodeKey, toNodeKey: to.nodeKey, lengthMetres: pathLengthMetres(s.path), surfaceKind: s.surfaceKind, componentId: 0, path: s.path });
  }

  const adjacency = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    for (const k of [e.fromNodeKey, e.toNodeKey]) { const list = adjacency.get(k); if (list) list.push(e); else adjacency.set(k, [e]); }
  }

  // Connected components, so a route that cannot exist says so rather than searching forever.
  let componentId = 0;
  const assigned = new Set<string>();
  const sizes: number[] = [];
  for (const key of Array.from(nodes.keys())) {
    if (assigned.has(key)) continue;
    componentId += 1;
    const stack = [key];
    const edgesHere = new Set<string>();
    while (stack.length) {
      const k = stack.pop()!;
      if (assigned.has(k)) continue;
      assigned.add(k);
      nodes.get(k)!.componentId = componentId;
      for (const e of adjacency.get(k) ?? []) {
        edgesHere.add(e.segmentId);
        e.componentId = componentId;
        const other = e.fromNodeKey === k ? e.toNodeKey : e.fromNodeKey;
        if (!assigned.has(other)) stack.push(other);
      }
    }
    sizes.push(edgesHere.size);
  }
  sizes.sort((a, b) => b - a);
  return { nodes, edges, adjacency, componentCount: componentId, largestComponentEdges: sizes[0] ?? 0, isolatedEdges: sizes.filter(n => n === 1).length, excludedSurfaces: excluded, segmentsConsidered: segments.length };
}

/* ---- snapping a position onto the graph ---- */

export type Snap = { edge: GraphEdge; nodeKey: string; metresFromPosition: number; snappedTo: LngLat };
/** The graph node a position enters by: the nearest end of the nearest routable edge. A position too far from anything is not snapped. */
export function snapToGraph(position: LngLat, graph: Graph, maxMetres = 3_000): { ok: true; snap: Snap } | { ok: false; reason: string; nearestMetres: number | null } {
  let best: { edge: GraphEdge; metres: number; closest: LngLat } | null = null;
  for (const e of graph.edges) {
    const d = distanceToPathMetres(position, e.path);
    if (!best || d.metres < best.metres) best = { edge: e, metres: d.metres, closest: d.closest };
  }
  if (!best) return { ok: false, reason: "The graph has no routable edges", nearestMetres: null };
  if (best.metres > maxMetres) return { ok: false, reason: `The nearest routable road is ${Math.round(best.metres)} m away, beyond the ${maxMetres} m snap limit — import the roads around this position before routing to it`, nearestMetres: Math.round(best.metres) };
  const from = graph.nodes.get(best.edge.fromNodeKey)!, to = graph.nodes.get(best.edge.toNodeKey)!;
  const dFrom = haversineMetres(best.closest, [from.longitude, from.latitude]);
  const dTo = haversineMetres(best.closest, [to.longitude, to.latitude]);
  return { ok: true, snap: { edge: best.edge, nodeKey: dFrom <= dTo ? from.nodeKey : to.nodeKey, metresFromPosition: Math.round(best.metres), snappedTo: best.closest } };
}

/* ---- the search ---- */

export type CostModel = { surfacePenalty?: Partial<Record<SurfaceKind, number>>; preferPaved?: boolean };
/** Cost in metres, weighted: a kilometre of dry-weather road costs more than a kilometre of pavement, and the weighting is stated. */
export function edgeCost(e: GraphEdge, model: CostModel = {}): number {
  const defaults: Partial<Record<SurfaceKind, number>> = { paved: 1, gravel: 1.15, dry_weather: 1.8, winter: 2.2, ramp: 1, other: 1.5, unknown: 1.5 };
  const weight = model.surfacePenalty?.[e.surfaceKind] ?? defaults[e.surfaceKind] ?? 1.5;
  return e.lengthMetres * (model.preferPaved && e.surfaceKind !== "paved" ? weight * 1.25 : weight);
}

export type RoutePath = { edges: GraphEdge[]; metres: number; weightedCost: number; surfaces: Record<string, number>; nodeKeys: string[] };
export type RouteOutcome =
  | { outcome: "path"; path: RoutePath; reasons: string[] }
  | { outcome: "disconnected"; reasons: string[]; originComponent: number; destinationComponent: number }
  | { outcome: "no_path"; reasons: string[] };

/** Dijkstra over the graph. Disconnected components are reported as such — the honest answer when no road in the imported fabric joins them. */
export function shortestPath(graph: Graph, fromNodeKey: string, toNodeKey: string, model: CostModel = {}): RouteOutcome {
  const from = graph.nodes.get(fromNodeKey), to = graph.nodes.get(toNodeKey);
  if (!from || !to) return { outcome: "no_path", reasons: ["One of the endpoints is not on the graph"] };
  if (fromNodeKey === toNodeKey) return { outcome: "path", path: { edges: [], metres: 0, weightedCost: 0, surfaces: {}, nodeKeys: [fromNodeKey] }, reasons: ["Origin and destination snap to the same point on the road network"] };
  if (from.componentId !== to.componentId) return { outcome: "disconnected", originComponent: from.componentId, destinationComponent: to.componentId, reasons: [`No road in the imported fabric joins these positions — they are in separate connected components (${from.componentId} and ${to.componentId}). Import the roads between them, or the connection is not in this data.`] };

  const dist = new Map<string, number>([[fromNodeKey, 0]]);
  const prev = new Map<string, { nodeKey: string; edge: GraphEdge }>();
  const visited = new Set<string>();
  const queue = new Set<string>([fromNodeKey]);
  while (queue.size) {
    let current: string | null = null, currentDist = Number.POSITIVE_INFINITY;
    for (const k of Array.from(queue)) { const d = dist.get(k) ?? Number.POSITIVE_INFINITY; if (d < currentDist) { current = k; currentDist = d; } }
    if (current == null) break;
    queue.delete(current); visited.add(current);
    if (current === toNodeKey) break;
    for (const e of graph.adjacency.get(current) ?? []) {
      const next = e.fromNodeKey === current ? e.toNodeKey : e.fromNodeKey;
      if (visited.has(next)) continue;
      const candidate = currentDist + edgeCost(e, model);
      if (candidate < (dist.get(next) ?? Number.POSITIVE_INFINITY)) { dist.set(next, candidate); prev.set(next, { nodeKey: current, edge: e }); queue.add(next); }
    }
  }
  if (!prev.has(toNodeKey)) return { outcome: "no_path", reasons: ["The components are joined but no path was found — this should not happen and is worth reporting"] };

  const edges: GraphEdge[] = [];
  const nodeKeys: string[] = [toNodeKey];
  let cursor = toNodeKey;
  while (cursor !== fromNodeKey) {
    const step = prev.get(cursor)!;
    edges.unshift(step.edge); nodeKeys.unshift(step.nodeKey);
    cursor = step.nodeKey;
  }
  const surfaces: Record<string, number> = {};
  for (const e of edges) surfaces[e.surfaceKind] = Math.round(((surfaces[e.surfaceKind] ?? 0) + e.lengthMetres / 1000) * 100) / 100;
  const metres = edges.reduce((a, e) => a + e.lengthMetres, 0);
  const reasons = [`${edges.length} segment(s), ${(metres / 1000).toFixed(1)} km over ${Object.entries(surfaces).map(([k, v]) => `${v} km ${k.replace(/_/g, " ")}`).join(", ")}`];
  if (edges.some(e => e.surfaceKind === "dry_weather" || e.surfaceKind === "winter")) reasons.push("The path uses a dry-weather or winter road — its condition is seasonal and is not stated by the road layer");
  return { outcome: "path", path: { edges, metres: Math.round(metres), weightedCost: Math.round(dist.get(toNodeKey)!), surfaces, nodeKeys }, reasons };
}
