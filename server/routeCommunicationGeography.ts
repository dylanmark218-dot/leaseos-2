/**
 * LeaseOS v22.20 candidate — canonical route communication geography resolver.
 *
 * This is the ONE database-backed path from a graph build + ordered segment IDs
 * to the geographic facts used by communications planning, readiness, offline
 * package sealing/staleness, and award recomputation.
 *
 * Design rules:
 * - never guess a coordinate;
 * - never trust caller-supplied province over the road source;
 * - full ordered polyline, not one representative point;
 * - missing/invalid geometry stays explicit and therefore evaluates UNKNOWN;
 * - the digest changes when route order, geometry, graph nodes, source
 *   jurisdiction, or source revision facts change.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  accessRoadSegments,
  externalDataSources,
  roadGraphEdges,
  roadGraphNodes,
} from "../drizzle/schema";
import type { getDb } from "./db";
import { haversineMetres, type LngLat } from "./_core/geoImport";
import type { JurisdictionConfidence, JurisdictionCrossing } from "./_core/commRoute";
import { hashOf } from "./_core/commPackage";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Structurally compatible with the SegmentGeography shape described for v22.20. */
export type ResolvedSegmentGeography = {
  segmentId: string;
  province: string | null;
  /** Source-wide metadata is only probable until coordinate-level boundary evidence exists. */
  jurisdictionConfidence: JurisdictionConfidence;
  jurisdictionCandidates: readonly string[];
  jurisdictionEvidenceRefs: readonly string[];
  crossing: JurisdictionCrossing | null;
  from: LngLat;
  to: LngLat;
  /** Full, ordered road geometry. Never a midpoint approximation. */
  path: readonly LngLat[];
  buildRef: string;
  geometryHash: string;
};

export type MissingSegmentGeography = {
  segmentId: string;
  reason:
    | "graph_edge_missing"
    | "graph_endpoint_missing"
    | "road_geometry_missing"
    | "road_geometry_invalid"
    | "jurisdiction_unknown";
  detail: string;
};

export type RouteCommunicationGeography = {
  buildRef: string;
  /** Ordered route IDs exactly as supplied. */
  segmentIds: readonly string[];
  geographyBySegment: Record<string, ResolvedSegmentGeography>;
  missing: readonly MissingSegmentGeography[];
  /**
   * Hashes both known and missing facts in route order. A missing segment becoming
   * known is therefore a stale-making change, not a silent upgrade.
   */
  geographyHash: string;
};

function validLngLat(v: unknown): v is LngLat {
  return Array.isArray(v)
    && v.length === 2
    && typeof v[0] === "number"
    && Number.isFinite(v[0])
    && v[0] >= -180
    && v[0] <= 180
    && typeof v[1] === "number"
    && Number.isFinite(v[1])
    && v[1] >= -90
    && v[1] <= 90;
}

export function parseRoadPath(raw: string): LngLat[] | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || v.length < 2 || !v.every(validLngLat)) return null;
    return v.map(p => [p[0], p[1]] as LngLat);
  } catch {
    return null;
  }
}

/**
 * Convert a source-registry Canadian subdivision (CA-AB, CA-BC, CA-NT, etc.)
 * to the two-letter jurisdiction used by the radio engine. Anything broader,
 * foreign, malformed, or absent remains unknown.
 */
export function provinceFromJurisdiction(jurisdiction: string | null | undefined): string | null {
  if (!jurisdiction) return null;
  const m = /^CA-([A-Z]{2})$/.exec(jurisdiction.trim().toUpperCase());
  return m?.[1] ?? null;
}

/**
 * accessRoadSegments.pathJson retains source order while graph endpoints can be
 * snapped. Orient the source polyline to the graph edge's from->to direction by
 * whichever endpoint pairing has the smaller total geodesic error.
 */
export function orientPath(path: readonly LngLat[], from: LngLat, to: LngLat): LngLat[] {
  if (path.length < 2) return [...path];
  const first = path[0]!;
  const last = path[path.length - 1]!;
  const direct = haversineMetres(first, from) + haversineMetres(last, to);
  const reversed = haversineMetres(last, from) + haversineMetres(first, to);
  return reversed < direct ? [...path].reverse() : [...path];
}

/**
 * Resolve geography once. Callers should pass this same result into every
 * downstream question instead of independently rebuilding coordinates.
 */
export async function resolveRouteCommunicationGeography(
  d: Db,
  input: { buildRef: string; segmentIds: readonly string[] },
): Promise<RouteCommunicationGeography> {
  const segmentIds = [...input.segmentIds];
  if (!segmentIds.length) {
    return {
      buildRef: input.buildRef,
      segmentIds,
      geographyBySegment: {},
      missing: [],
      geographyHash: hashOf({ buildRef: input.buildRef, route: [] }),
    };
  }

  const uniqueSegmentIds = Array.from(new Set(segmentIds));
  const edgeRows = await d
    .select()
    .from(roadGraphEdges)
    .where(and(eq(roadGraphEdges.buildRef, input.buildRef), inArray(roadGraphEdges.segmentId, uniqueSegmentIds)));

  const edgesBySegment = new Map(edgeRows.map(e => [e.segmentId, e]));
  const nodeKeys = Array.from(new Set(edgeRows.flatMap(e => [e.fromNodeKey, e.toNodeKey])));
  const objectIds = Array.from(new Set(edgeRows.map(e => e.accessRoadObjectId)));

  const [nodeRows, roadRows] = await Promise.all([
    nodeKeys.length
      ? d.select().from(roadGraphNodes).where(and(eq(roadGraphNodes.buildRef, input.buildRef), inArray(roadGraphNodes.nodeKey, nodeKeys)))
      : Promise.resolve([]),
    objectIds.length
      ? d.select().from(accessRoadSegments).where(inArray(accessRoadSegments.objectId, objectIds))
      : Promise.resolve([]),
  ]);

  const sourceKeys = Array.from(new Set(roadRows.map(r => r.sourceKey)));
  const sourceRows = sourceKeys.length
    ? await d.select().from(externalDataSources).where(inArray(externalDataSources.sourceKey, sourceKeys))
    : [];

  const nodesByKey = new Map(nodeRows.map(n => [n.nodeKey, n]));
  const roadsByObject = new Map(roadRows.map(r => [r.objectId, r]));
  const sourcesByKey = new Map(sourceRows.map(s => [s.sourceKey, s]));

  const geographyBySegment: Record<string, ResolvedSegmentGeography> = {};
  const missing: MissingSegmentGeography[] = [];

  for (const segmentId of uniqueSegmentIds) {
    const edge = edgesBySegment.get(segmentId);
    if (!edge) {
      missing.push({ segmentId, reason: "graph_edge_missing", detail: `No ${segmentId} edge exists in graph build ${input.buildRef}` });
      continue;
    }

    const fromNode = nodesByKey.get(edge.fromNodeKey);
    const toNode = nodesByKey.get(edge.toNodeKey);
    if (!fromNode || !toNode) {
      missing.push({
        segmentId,
        reason: "graph_endpoint_missing",
        detail: `Graph edge ${segmentId} is missing ${!fromNode ? edge.fromNodeKey : edge.toNodeKey}; no endpoint was guessed`,
      });
      continue;
    }

    const road = roadsByObject.get(edge.accessRoadObjectId);
    if (!road) {
      missing.push({
        segmentId,
        reason: "road_geometry_missing",
        detail: `Graph edge ${segmentId} names road object ${edge.accessRoadObjectId}, but its source geometry is absent`,
      });
      continue;
    }

    const parsed = parseRoadPath(road.pathJson);
    if (!parsed) {
      missing.push({
        segmentId,
        reason: "road_geometry_invalid",
        detail: `Road object ${edge.accessRoadObjectId} has no valid two-point-or-longer [longitude,latitude] path; no point was guessed in its place`,
      });
      continue;
    }

    const source = sourcesByKey.get(road.sourceKey);
    // A source that is not verified may describe a jurisdiction, but it may not
    // establish one operationally. UNKNOWN is safer than promoting metadata.
    const province = source?.status === "verified"
      ? provinceFromJurisdiction(source.jurisdiction)
      : null;
    // Critical distinction: externalDataSources.jurisdiction describes the DATASET,
    // not the jurisdiction at every coordinate inside a polyline. Treating that as
    // confirmed made a genuine AB/BC crossing look confidently Alberta. Until an
    // authoritative coordinate boundary layer is wired, it is probable evidence
    // only and therefore cannot authorize a province-limited rule.
    const jurisdictionConfidence: JurisdictionConfidence = province ? "probable" : "unknown";
    const jurisdictionCandidates = province ? [province] : [];
    const jurisdictionEvidenceRefs = source ? [`externalDataSources:${source.sourceKey}:${source.jurisdiction ?? "unknown"}`] : [];
    const crossing: JurisdictionCrossing | null = null;

    const from: LngLat = [fromNode.longitude, fromNode.latitude];
    const to: LngLat = [toNode.longitude, toNode.latitude];
    const path = orientPath(parsed, from, to);

    const geometryHash = hashOf({
      buildRef: input.buildRef,
      segmentId,
      accessRoadObjectId: edge.accessRoadObjectId,
      fromNodeKey: edge.fromNodeKey,
      toNodeKey: edge.toNodeKey,
      from,
      to,
      path,
      province,
      jurisdictionConfidence,
      jurisdictionCandidates,
      jurisdictionEvidenceRefs,
      crossing,
      sourceKey: road.sourceKey,
      sourceJurisdiction: source?.jurisdiction ?? null,
      sourceStatus: source?.status ?? null,
      importRunRef: road.importRunRef,
      geometryDate: road.geometryDate,
      providerUpdatedAt: road.providerUpdatedAt,
      retrievedAt: road.retrievedAt,
    });

    geographyBySegment[segmentId] = {
      segmentId,
      province,
      jurisdictionConfidence,
      jurisdictionCandidates,
      jurisdictionEvidenceRefs,
      crossing,
      from,
      to,
      path,
      buildRef: input.buildRef,
      geometryHash,
    };

    if (!province) {
      missing.push({
        segmentId,
        reason: "jurisdiction_unknown",
        detail: `Road source ${road.sourceKey} does not establish a verified Canadian provincial/territorial jurisdiction`,
      });
    }
  }

  // Hash in ROUTE ORDER. Reordering identical segments is a different trip.
  // Missing facts are included so later availability necessarily makes the
  // package/eligibility basis move.
  const geographyHash = hashOf({
    buildRef: input.buildRef,
    route: segmentIds.map(segmentId => {
      const g = geographyBySegment[segmentId];
      if (g) return { segmentId, geometryHash: g.geometryHash };
      const miss = missing.find(m => m.segmentId === segmentId);
      return { segmentId, missing: miss?.reason ?? "unknown" };
    }),
  });

  return { buildRef: input.buildRef, segmentIds, geographyBySegment, missing, geographyHash };
}
