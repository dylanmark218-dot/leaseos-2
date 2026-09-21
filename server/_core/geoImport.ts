/**
 * v22.13 — The mapping foundation, from open data.
 *
 * Pure geometry and parsing. Two authoritative Alberta services answer in
 * GeoJSON; this module turns their features into rows, computes what a
 * polygon or line implies (centroid, bounding box, length, distance), and
 * carries Alberta's own vocabulary rather than inventing one. Nothing here
 * reaches the network — the router does that, so every calculation is
 * testable against captured fixtures.
 *
 * Sources, verified 2026-09-10:
 *   ATS v4.1 LSD with road allowance — Alberta Township System MapServer
 *     layer 20, Open Government Licence — Alberta, JSON/geoJSON/PBF.
 *   Base Features Access Road — access_facility_roads MapServer layer 0,
 *     "the authoritative source of road data for the province of Alberta".
 */

export const ATS_LSD_ENDPOINT = "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/20/query";
export const ATS_LSD_LAYER = "ATS Legal Subdivision with Road Allowance Outline";
export const ACCESS_ROADS_ENDPOINT = "https://geospatial.alberta.ca/titan/rest/services/transportation/access_facility_roads/MapServer/0/query";
export const ACCESS_ROADS_LAYER = "Access and Facility Roads";

/** Alberta's published FEATURE_TYPE legend for the access road layer, read from the service's renderer. */
export const ROAD_FEATURE_TYPES: Record<number, { label: string; surface: SurfaceKind; lanes: number | null }> = {
  1: { label: "Ferry Crossing", surface: "ferry", lanes: null },
  2: { label: "Ford/Winter Crossing", surface: "ford", lanes: null },
  3: { label: "Interchange Ramp", surface: "ramp", lanes: 1 },
  4: { label: "One Lane Gravel Road", surface: "gravel", lanes: 1 },
  5: { label: "Two Lane Gravel Road", surface: "gravel", lanes: 2 },
  6: { label: "Divided Paved Road", surface: "paved", lanes: 4 },
  7: { label: "One Lane Undivided Paved Road", surface: "paved", lanes: 1 },
  8: { label: "Two Lane Undivided Paved Road", surface: "paved", lanes: 2 },
  9: { label: "Four Lane Undivided Paved Road", surface: "paved", lanes: 4 },
  10: { label: "Driveway", surface: "driveway", lanes: 1 },
  12: { label: "Winter Road", surface: "winter", lanes: null },
  14: { label: "Dry-Weather Road", surface: "dry_weather", lanes: null },
};
export type SurfaceKind = "paved" | "gravel" | "dry_weather" | "winter" | "driveway" | "ramp" | "ferry" | "ford" | "other" | "unknown";

export type LngLat = [number, number];
export type BoundingBox = { minLatitude: number; minLongitude: number; maxLatitude: number; maxLongitude: number };

export function boundingBox(points: readonly LngLat[]): BoundingBox {
  if (!points.length) throw new Error("A bounding box needs at least one point");
  let minLng = points[0]![0], maxLng = points[0]![0], minLat = points[0]![1], maxLat = points[0]![1];
  for (const [lng, lat] of points) { if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng; if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; }
  return { minLatitude: minLat, minLongitude: minLng, maxLatitude: maxLat, maxLongitude: maxLng };
}

/** Area-weighted centroid of a closed ring (shoelace). For a degenerate ring, the mean of its points. */
export function ringCentroid(ring: readonly LngLat[]): LngLat {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!, [x1, y1] = ring[i]!;
    const f = x0 * y1 - x1 * y0;
    twiceArea += f; x += (x0 + x1) * f; y += (y0 + y1) * f;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    const n = ring.length || 1;
    return [ring.reduce((a, p) => a + p[0], 0) / n, ring.reduce((a, p) => a + p[1], 0) / n];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

/** Is the point inside the ring? Ray casting; a point on the boundary may fall either way, which is fine for a locator. */
export function pointInRing(point: LngLat, ring: readonly LngLat[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in metres. */
export function haversineMetres(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function pathLengthMetres(path: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineMetres(path[i - 1]!, path[i]!);
  return total;
}
/** Distance from a point to a segment, and the closest point on it — local planar approximation, accurate at these scales. */
export function distanceToSegmentMetres(p: LngLat, a: LngLat, b: LngLat): { metres: number; closest: LngLat } {
  const latScale = Math.cos(rad(p[1]));
  const toXY = (q: LngLat): [number, number] => [q[0] * latScale, q[1]];
  const [px, py] = toXY(p), [ax, ay] = toXY(a), [bx, by] = toXY(b);
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closest: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { metres: haversineMetres(p, closest), closest };
}
export function distanceToPathMetres(p: LngLat, path: readonly LngLat[]): { metres: number; closest: LngLat } {
  if (path.length === 1) return { metres: haversineMetres(p, path[0]!), closest: path[0]! };
  let best = { metres: Number.POSITIVE_INFINITY, closest: path[0]! };
  for (let i = 1; i < path.length; i++) {
    const d = distanceToSegmentMetres(p, path[i - 1]!, path[i]!);
    if (d.metres < best.metres) best = d;
  }
  return best;
}

/* ---- ArcGIS GeoJSON features → rows ---- */

export type GeoFeature = { type: string; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null };
export type FeatureCollection = { type: string; features: GeoFeature[]; properties?: { exceededTransferLimit?: boolean } };

export type ParsedLsd = {
  pid: string; meridian: number; rangeNumber: number; township: number; sectionNumber: number; quarterSection: string | null; legalSubdivision: number | null; roadAllowance: string | null;
  descriptor: string; centroidLatitude: number; centroidLongitude: number; areaSquareMetres: number | null; ring: LngLat[];
} & BoundingBox;

const asInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
const asText = (v: unknown): string | null => { const t = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim(); return t.length ? t : null; };

/** One ATS feature. A feature without the grid fields, a polygon or a PID is refused by name, never guessed. */
export function parseLsdFeature(f: GeoFeature): { ok: true; row: ParsedLsd } | { ok: false; reason: string } {
  const p = f.properties ?? {};
  const pid = asText(p.PID);
  if (!pid) return { ok: false, reason: "feature carries no PID" };
  const meridian = asInt(p.M), rangeNumber = asInt(p.RGE), township = asInt(p.TWP), sectionNumber = asInt(p.SEC);
  if (meridian == null || rangeNumber == null || township == null || sectionNumber == null) return { ok: false, reason: `PID ${pid}: incomplete grid (M/RGE/TWP/SEC)` };
  if (!f.geometry || f.geometry.type !== "Polygon") return { ok: false, reason: `PID ${pid}: geometry is ${f.geometry?.type ?? "absent"}, not Polygon` };
  const rings = f.geometry.coordinates as LngLat[][];
  const ring = rings?.[0];
  if (!ring || ring.length < 4) return { ok: false, reason: `PID ${pid}: outer ring has ${ring?.length ?? 0} points` };
  const [lng, lat] = ringCentroid(ring);
  return { ok: true, row: {
    pid, meridian, rangeNumber, township, sectionNumber,
    quarterSection: asText(p.QS), legalSubdivision: asInt(p.LS), roadAllowance: asText(p.RA),
    descriptor: asText(p.DESCRIPTOR) ?? `LSD-${p.LS} SEC-${sectionNumber} TWP-${township} RGE-${rangeNumber} MER-${meridian}`,
    centroidLatitude: lat, centroidLongitude: lng,
    areaSquareMetres: typeof p["SHAPE.STArea()"] === "number" ? (p["SHAPE.STArea()"] as number) : null,
    ring, ...boundingBox(ring),
  } };
}

export type ParsedRoad = {
  objectId: number; name: string | null; highwayNumber: string | null; roadClass: string | null; featureType: number | null; featureTypeLabel: string | null;
  surfaceKind: SurfaceKind; lanes: number | null; lengthMetres: number; path: LngLat[]; geometrySource: string | null; geometryDate: Date | null; providerUpdatedAt: Date | null;
} & BoundingBox;

const asDate = (v: unknown): Date | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v) : null);

/** One access-road feature. A multi-part line is taken as its longest part, and that is said in the run's skip count if parts were dropped. */
export function parseRoadFeature(f: GeoFeature): { ok: true; row: ParsedRoad; droppedParts: number } | { ok: false; reason: string } {
  const p = f.properties ?? {};
  const objectId = asInt(p.OBJECTID);
  if (objectId == null) return { ok: false, reason: "feature carries no OBJECTID" };
  if (!f.geometry) return { ok: false, reason: `OBJECTID ${objectId}: no geometry` };
  let path: LngLat[] | null = null, droppedParts = 0;
  if (f.geometry.type === "LineString") path = f.geometry.coordinates as LngLat[];
  else if (f.geometry.type === "MultiLineString") {
    const parts = f.geometry.coordinates as LngLat[][];
    if (parts.length) { path = parts.reduce((a, b) => (pathLengthMetres(b) > pathLengthMetres(a) ? b : a)); droppedParts = parts.length - 1; }
  } else return { ok: false, reason: `OBJECTID ${objectId}: geometry is ${f.geometry.type}, not a line` };
  if (!path || path.length < 2) return { ok: false, reason: `OBJECTID ${objectId}: line has ${path?.length ?? 0} points` };
  const ft = asInt(p.FEATURE_TYPE);
  const legend = ft != null ? ROAD_FEATURE_TYPES[ft] : undefined;
  return { ok: true, droppedParts, row: {
    objectId, name: asText(p.NAME), highwayNumber: asText(p.HWY_NUMBER), roadClass: asText(p.ROAD_CLASS),
    featureType: ft, featureTypeLabel: legend?.label ?? (ft != null ? `Feature type ${ft} (not in the published legend)` : null),
    surfaceKind: legend?.surface ?? "unknown", lanes: legend?.lanes ?? null,
    lengthMetres: pathLengthMetres(path), path,
    geometrySource: asText(p.GEO_SOURCE), geometryDate: asDate(p.GEO_DATE), providerUpdatedAt: asDate(p.UPDATE_DATE),
    ...boundingBox(path),
  } };
}

/* ---- the locator ---- */

export type LsdRecord = { pid: string; descriptor: string; centroidLatitude: number; centroidLongitude: number; roadAllowance: string | null; ring: LngLat[] };
export type RoadRecord = { objectId: number; name: string | null; featureTypeLabel: string | null; surfaceKind: SurfaceKind; roadClass: string | null; path: LngLat[] };
export type AccessPoint = { objectId: number; name: string | null; surfaceKind: SurfaceKind; featureTypeLabel: string | null; metresFromCentroid: number; latitude: number; longitude: number; touchesParcel: boolean };

/** Truck-suitable surfaces, in the order a loaded unit would prefer them. A driveway, ferry or ford is never offered as a lease access point. */
export const ACCESS_SURFACE_PREFERENCE: readonly SurfaceKind[] = ["paved", "gravel", "dry_weather", "winter"];

/**
 * Where a truck reaches a parcel: the nearest point on a truck-suitable road,
 * preferring roads that actually touch the parcel. The centroid is where the
 * land is; the access point is where the road is — they are never conflated.
 */
export function locateAccess(lsd: LsdRecord, roads: readonly RoadRecord[], opts: { maxMetres?: number } = {}): { centroid: LngLat; access: AccessPoint | null; considered: number; reasons: string[] } {
  const centroid: LngLat = [lsd.centroidLongitude, lsd.centroidLatitude];
  const reasons: string[] = [];
  const maxMetres = opts.maxMetres ?? 2_000;
  const suitable = roads.filter(r => ACCESS_SURFACE_PREFERENCE.includes(r.surfaceKind));
  if (roads.length && !suitable.length) reasons.push(`${roads.length} road(s) nearby, none truck-suitable (${Array.from(new Set(roads.map(r => r.surfaceKind))).join(", ")})`);
  const scored = suitable.map(r => {
    const d = distanceToPathMetres(centroid, r.path);
    const touches = r.path.some(pt => pointInRing(pt, lsd.ring));
    return { r, d, touches };
  }).filter(x => x.d.metres <= maxMetres);
  if (suitable.length && !scored.length) reasons.push(`No truck-suitable road within ${maxMetres} m of the parcel centroid`);
  scored.sort((a, b) => (a.touches === b.touches ? a.d.metres - b.d.metres : a.touches ? -1 : 1));
  const best = scored[0];
  if (!best) { reasons.push("No access point determined — the centroid is the land, not a destination a truck can reach"); return { centroid, access: null, considered: roads.length, reasons }; }
  reasons.push(best.touches ? `Nearest truck-suitable road touches the parcel: ${best.r.featureTypeLabel ?? best.r.surfaceKind}` : `Nearest truck-suitable road is ${Math.round(best.d.metres)} m from the centroid and does not touch the parcel — confirm the lease entrance`);
  if (lsd.roadAllowance) reasons.push(`Parcel is a road allowance (${lsd.roadAllowance}), not land`);
  return { centroid, access: { objectId: best.r.objectId, name: best.r.name, surfaceKind: best.r.surfaceKind, featureTypeLabel: best.r.featureTypeLabel, metresFromCentroid: Math.round(best.d.metres), latitude: best.d.closest[1], longitude: best.d.closest[0], touchesParcel: best.touches }, considered: roads.length, reasons };
}
