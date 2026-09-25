/**
 * Where a provincial record says it applies, as the one shape `advisoryImpact` places.
 *
 * Pure. `RoadAdvisory` carries a point and a radius, because that is what a route can be
 * intersected against without a map-matching engine. A publisher gives a point, two points, or a
 * line; each becomes the smallest circle this module can prove covers every coordinate the
 * publisher gave, plus a margin. Over-covering costs a dispatcher one extra line to read.
 * Under-covering is how a closure on the route goes unreported, so the error only goes one way.
 */

import { DEFAULT_ADVISORY_RADIUS_METRES } from "../advisoryImpact";
import { haversineMetres, type LngLat } from "../geoImport";

/** Added to every covering radius: publishers place events a little off the carriageway. */
export const PLACEMENT_MARGIN_METRES = 250;

const valid = (c: LngLat) =>
  Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90 && !(c[0] === 0 && c[1] === 0);

/**
 * Centre of the coordinates' bounding box, and a radius reaching the farthest one.
 *
 * Returns null when nothing usable was given — the caller reports that record as unplaceable
 * rather than inventing a position for it. A single point gets a null radius, so the generous
 * default in `advisoryImpact` applies: the publisher stated a place, not an extent. A radius is
 * never smaller than that default, so a publisher's line can only widen the reach.
 */
export function coveringCircle(coords: readonly LngLat[]): { point: LngLat; radiusMetres: number | null } | null {
  const usable = coords.filter(valid);
  if (usable.length === 0) return null;
  if (usable.length === 1) return { point: usable[0], radiusMetres: null };
  const lngs = usable.map(c => c[0]);
  const lats = usable.map(c => c[1]);
  const point: LngLat = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const farthest = Math.max(...usable.map(c => haversineMetres(point, c)));
  return { point, radiusMetres: Math.max(DEFAULT_ADVISORY_RADIUS_METRES, Math.ceil(farthest + PLACEMENT_MARGIN_METRES)) };
}

/** A GeoJSON geometry's coordinates, flattened. Unknown geometry types yield nothing. */
export function geometryCoordinates(geometry: unknown): LngLat[] {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g || typeof g !== "object" || !Array.isArray(g.coordinates)) return [];
  const pair = (v: unknown): LngLat | null =>
    Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number" ? [v[0], v[1]] : null;
  const flat = (v: unknown, depth: number): LngLat[] =>
    depth === 0 ? [pair(v)].filter((p): p is LngLat => p !== null) : Array.isArray(v) ? v.flatMap(x => flat(x, depth - 1)) : [];
  switch (g.type) {
    case "Point": return flat(g.coordinates, 0);
    case "MultiPoint":
    case "LineString": return flat(g.coordinates, 1);
    case "MultiLineString":
    case "Polygon": return flat(g.coordinates, 2);
    case "MultiPolygon": return flat(g.coordinates, 3);
    default: return [];
  }
}
