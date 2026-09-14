/**
 * v22.16 — The first routing graph.
 * The fixture is the same real Alberta road data captured for v22.13.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { NOT_ROUTABLE, buildGraph, edgeCost, nodeKeyFor, shortestPath, snapToGraph, type GraphSegment } from "./_core/roadGraph";
import { parseRoadFeature, type FeatureCollection, type LngLat } from "./_core/geoImport";
import { setGeoFetcher } from "./geoRouter";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const roadsFixture = JSON.parse(readFileSync("server/fixtures/geo/roads_54_18_w5.geojson", "utf8")) as FeatureCollection;
const atsFixture = JSON.parse(readFileSync("server/fixtures/geo/ats_54_18_w5_sec24.geojson", "utf8")) as FeatureCollection;
const segments: GraphSegment[] = roadsFixture.features.map(parseRoadFeature).flatMap(p => (p.ok ? [{ segmentId: `AB-ACCESS-${p.row.objectId}`, accessRoadObjectId: p.row.objectId, label: p.row.name ?? p.row.featureTypeLabel ?? `Access road ${p.row.objectId}`, surfaceKind: p.row.surfaceKind, path: p.row.path }] : []));

describe("a graph built from real imported road data", () => {
  it("joins segments at their endpoints, leaves out what a loaded truck is never routed down, and reports its own disconnection", () => {
    const graph = buildGraph(segments);
    expect(graph.segmentsConsidered).toBe(293);
    expect(graph.edges.length).toBeGreaterThan(200);
    expect(graph.edges.length).toBeLessThan(293);                                  // driveways, ferries and fords are not routable
    expect(graph.excludedSurfaces).toEqual(NOT_ROUTABLE);
    expect(graph.edges.some(e => e.surfaceKind === "driveway")).toBe(false);
    expect(graph.nodes.size).toBeGreaterThan(0);
    expect(graph.nodes.size).toBeLessThan(graph.edges.length * 2);                 // sharing endpoints is the whole point
    expect(graph.componentCount).toBeGreaterThan(0);
    expect(graph.largestComponentEdges).toBeGreaterThan(graph.edges.length / 2);   // the fabric is mostly one piece
    const junctions = Array.from(graph.nodes.values()).filter(n => n.degree > 2);
    expect(junctions.length).toBeGreaterThan(0);                                   // real intersections exist
    expect(nodeKeyFor([-116.5291234567, 53.6846254321])).toBe("53.684625,-116.529123");
  });
  it("costs a kilometre of dry-weather road above a kilometre of pavement, and says so through the weighting", () => {
    const base = { segmentId: "s", accessRoadObjectId: 1, label: "l", fromNodeKey: "a", toNodeKey: "b", lengthMetres: 1_000, componentId: 1, path: [] as LngLat[] };
    expect(edgeCost({ ...base, surfaceKind: "paved" })).toBe(1_000);
    expect(edgeCost({ ...base, surfaceKind: "gravel" })).toBeCloseTo(1_150, 6);
    expect(edgeCost({ ...base, surfaceKind: "dry_weather" })).toBeCloseTo(1_800, 6);
    expect(edgeCost({ ...base, surfaceKind: "gravel" }, { preferPaved: true })).toBeGreaterThan(edgeCost({ ...base, surfaceKind: "gravel" }));
    expect(edgeCost({ ...base, surfaceKind: "paved" }, { preferPaved: true })).toBe(1_000);
  });
  it("snaps a position to the nearest routable road, and refuses one that is too far to be on the network", () => {
    const graph = buildGraph(segments);
    const onRoad = graph.edges[0]!.path[0]!;
    const near = snapToGraph(onRoad, graph);
    expect(near.ok).toBe(true);
    if (near.ok) { expect(near.snap.metresFromPosition).toBeLessThan(5); expect(graph.nodes.has(near.snap.nodeKey)).toBe(true); }
    const far = snapToGraph([-110, 51], graph, 3_000);
    expect(far.ok).toBe(false);
    if (!far.ok) { expect(far.reason).toContain("beyond the 3000 m snap limit"); expect(far.nearestMetres).toBeGreaterThan(3_000); }
  });
  it("finds the shortest path across the real fabric and names disconnection rather than searching forever", () => {
    const graph = buildGraph(segments);
    const biggest = Array.from(graph.nodes.values()).filter(n => n.componentId === graph.edges.find(e => e.componentId)!.componentId);
    const main = graph.edges.reduce((acc, e) => { acc[e.componentId] = (acc[e.componentId] ?? 0) + 1; return acc; }, {} as Record<number, number>);
    const mainComponent = Number(Object.entries(main).sort((a, b) => b[1] - a[1])[0]![0]);
    const inMain = graph.edges.filter(e => e.componentId === mainComponent);
    const a = inMain[0]!.fromNodeKey, b = inMain[inMain.length - 1]!.toNodeKey;
    const result = shortestPath(graph, a, b);
    expect(result.outcome).toBe("path");
    if (result.outcome === "path") {
      expect(result.path.edges.length).toBeGreaterThan(0);
      expect(result.path.metres).toBeGreaterThan(0);
      expect(result.path.weightedCost).toBeGreaterThanOrEqual(result.path.metres);   // weighting never makes a road cheaper than its length
      expect(Object.keys(result.path.surfaces).length).toBeGreaterThan(0);
      expect(result.reasons[0]).toMatch(/segment\(s\), [\d.]+ km over/);
      // every consecutive pair actually shares a node — the path is connected, not merely a list
      for (let i = 1; i < result.path.edges.length; i++) {
        const prev = result.path.edges[i - 1]!, cur = result.path.edges[i]!;
        expect([prev.fromNodeKey, prev.toNodeKey].some(k => k === cur.fromNodeKey || k === cur.toNodeKey)).toBe(true);
      }
    }
    const other = graph.edges.find(e => e.componentId !== mainComponent);
    if (other) {
      const dis = shortestPath(graph, a, other.fromNodeKey);
      expect(dis.outcome).toBe("disconnected");
      if (dis.outcome === "disconnected") expect(dis.reasons[0]).toContain("No road in the imported fabric joins these positions");
    }
    expect(shortestPath(graph, a, a).outcome).toBe("path");
    expect(shortestPath(graph, a, "not-a-node").outcome).toBe("no_path");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 6_100_000 + Math.floor(Math.random() * 50_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = userSeq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("routing over the imported fabric, through the database", () => {
  it("builds a graph, computes a real route, and hands it to the evaluator where every unstated limit is UNKNOWN", async () => {
    const controller = await withRole("controller");
    const dispatcher = await withRole("dispatcher");
    setGeoFetcher(async endpoint => (endpoint.includes("alberta_township_system") ? atsFixture : roadsFixture));
    await callerFor(controller).geo.accessRoadsImport({ minLatitude: 53.62, minLongitude: -116.66, maxLatitude: 53.72, maxLongitude: -116.5 });
    const built = await callerFor(controller).geo.graphBuild({ label: `TWP 54 RGE 18 W5 ${Date.now()}`, minLatitude: 53.6, minLongitude: -116.7, maxLatitude: 53.75, maxLongitude: -116.45 });
    expect(built.routableEdges).toBeGreaterThan(100);
    expect(built.segmentsConsidered).toBeGreaterThan(built.routableEdges);            // excluded surfaces were left out
    expect(built.excludedSurfaces).toEqual(["driveway", "ferry", "ford"]);
    expect(built.nodes).toBeGreaterThan(0);
    expect(built.sourceRuns.length).toBeGreaterThan(0);                               // the graph names the imports it was built from
    const [edges] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM roadGraphEdges WHERE buildRef = ?", [built.buildRef]);
    expect(Number(edges[0].n)).toBe(built.routableEdges);
    // two positions on the network: a real route between them
    const [ends] = await pool.execute<mysql.RowDataPacket[]>("SELECT latitude, longitude, componentId FROM roadGraphNodes WHERE buildRef = ? AND componentId = (SELECT componentId FROM roadGraphEdges WHERE buildRef = ? GROUP BY componentId ORDER BY COUNT(*) DESC LIMIT 1) ORDER BY latitude LIMIT 400", [built.buildRef, built.buildRef]);
    expect(ends.length).toBeGreaterThan(2);
    const from = ends[0]!, to = ends[ends.length - 1]!;
    const route = await callerFor(dispatcher).geo.routeCompute({ fromLatitude: Number(from.latitude), fromLongitude: Number(from.longitude), toLatitude: Number(to.latitude), toLongitude: Number(to.longitude) });
    expect(route.outcome).toBe("path_only");                                          // no vehicle supplied: a road connection, not a permission
    expect(route.path).not.toBeNull();
    expect(route.path!.segments.length).toBeGreaterThan(0);
    expect(route.path!.kilometres).toBeGreaterThan(0);
    expect(route.buildRef).toBe(built.buildRef);
    expect(route.reasons.some((r: string) => r.includes("not a permission to drive it"))).toBe(true);
    expect(route.reasons.some((r: string) => r.includes("the last stretch to the site is not part of the road network"))).toBe(true);
    // the same route, evaluated for a loaded unit
    const evaluated = await callerFor(dispatcher).geo.routeCompute({
      fromLatitude: Number(from.latitude), fromLongitude: Number(from.longitude), toLatitude: Number(to.latitude), toLongitude: Number(to.longitude),
      vehicle: { grossWeightKg: 63_500, maxAxleGroupKg: 24_000, heightM: 4.15, widthM: 2.6, lengthM: 27.5, dangerousGoods: false, requiresEscort: false },
      requiredChecks: ["road_weight_restriction", "bridge_clearance", "surface_condition"],
    });
    expect(evaluated.outcome).toBe("evaluated");
    expect(evaluated.verdict).not.toBeNull();
    expect(evaluated.verdict!.unknownCount).toBeGreaterThan(0);
    expect(evaluated.verdict!.dispatchStatus).not.toBe("clear_to_dispatch");           // a computed path is still not a clear route
    expect(evaluated.path!.segments.length).toBe(route.path!.segments.length);
    // outside any built graph, the honest answer is unchanged
    const outside = await callerFor(dispatcher).geo.routeCompute({ fromLatitude: 51.0, fromLongitude: -110.0, toLatitude: 51.1, toLongitude: -110.1 });
    expect(outside.outcome).toBe("no_graph");
    expect(outside.reasons[0]).toContain("P0 stands outside the areas a person has imported and built");
    // a position on the graph, a destination far from any road
    const unreachable = await callerFor(dispatcher).geo.routeCompute({ fromLatitude: Number(from.latitude), fromLongitude: Number(from.longitude), toLatitude: 53.749, toLongitude: -116.46, snapLimitMetres: 100, buildRef: built.buildRef });
    expect(["destination_unreachable", "origin_unreachable"]).toContain(unreachable.outcome);
    expect(unreachable.path).toBeNull();
    await expect(callerFor(dispatcher).geo.graphBuild({ label: "not a dispatcher's act", minLatitude: 53.6, minLongitude: -116.7, maxLatitude: 53.75, maxLongitude: -116.45 })).rejects.toThrow(/geo.graph.build/);   // building is not a dispatcher's act
    await expect(callerFor(controller).geo.graphBuild({ label: "empty", minLatitude: 51.0, minLongitude: -110.0, maxLatitude: 51.1, maxLongitude: -109.9 })).rejects.toThrow(/No imported road segments/);
  });
});
