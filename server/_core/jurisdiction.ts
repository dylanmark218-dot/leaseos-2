/**
 * v22.20 — deciding which province a road is in.
 *
 * Pure. No network, no database, and — deliberately — no boundary data.
 *
 * Everything upstream has spent three checkpoints refusing to manufacture
 * jurisdiction: a dataset published by Alberta proves who published it, a
 * device reporting "AB" is making a claim, and a polyline that crosses a line
 * is neither side. All three now answer `probable` or `ambiguous`, which is
 * honest and also useless — nothing can ever reach `confirmed`.
 *
 * This is the piece that makes `confirmed` reachable. It does not make it
 * true: it takes boundary polygons somebody has loaded and verified, and it
 * decides. With no layer loaded it returns exactly what the system returns
 * today, so installing this changes no answer until a person loads a real
 * boundary file and a second person verifies it.
 *
 * What it will not do:
 *
 *   - Treat an unverified boundary layer as proof. An unverified polygon is
 *     evidence like any other unverified row, and caps the answer at
 *     `probable`.
 *   - Guess at a vertex that falls outside every polygon. That is a hole in
 *     the layer or a road in the ocean, and either way it is `unknown`.
 *   - Invent a crossing time. A segment that spans two provinces is
 *     `ambiguous` with both named, and the time it crossed is not a fact this
 *     module has.
 */

import type { LngLat } from "./geoImport";
import type { JurisdictionConfidence } from "./commRoute";

export type VerificationStatus = "unverified" | "verified" | "superseded";

/**
 * One province or territory as a set of rings. Holes are not modelled: no
 * Canadian provincial boundary needs one, and a ring set that did would be
 * silently wrong rather than loudly unsupported, so `ringsAreOuter` records the
 * claim rather than assuming it.
 */
export type BoundaryPolygon = {
  province: string;
  rings: readonly (readonly LngLat[])[];
  ringsAreOuter: boolean;
  sourceKey: string;
  sourceCitation: string;
  verificationStatus: VerificationStatus;
};

export type JurisdictionReason =
  | "wholly_inside"
  | "boundary_crossing"
  | "no_boundary_layer"
  | "layer_unverified"
  | "outside_all_boundaries"
  | "unsupported_geometry";

export type JurisdictionDecision = {
  province: string | null;
  confidence: JurisdictionConfidence;
  /** True only when jurisdiction is established well enough to grant a permission. */
  authorizationEligible: boolean;
  crossing: { detected: boolean; fromProvince: string | null; toProvince: string | null } | null;
  reason: JurisdictionReason;
  /** What was actually consulted, in a dispatcher's words. */
  evidence: string[];
};

/* ------------------------------------------------------------------ */

/** Ray casting. A point exactly on an edge is counted inside — the conservative direction for a boundary. */
export function pointInRing(p: LngLat, ring: readonly LngLat[]): boolean {
  if (ring.length < 3) return false;
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi === yj) continue;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export const pointInPolygon = (p: LngLat, poly: BoundaryPolygon): boolean => poly.rings.some(r => pointInRing(p, r));

/** The province containing a point, or null when no loaded polygon does. */
export function provinceAt(p: LngLat, boundaries: readonly BoundaryPolygon[]): string | null {
  for (const b of boundaries) if (b.verificationStatus !== "superseded" && pointInPolygon(p, b)) return b.province;
  return null;
}

const midpoint = (a: LngLat, b: LngLat): LngLat => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * Sample a polyline: every vertex, plus the midpoint of every edge. The
 * midpoints matter because two vertices can sit in the same province while the
 * road between them clips a third — the same reason a radius exclusion needed
 * edge interiors rather than endpoints.
 */
function samplesOf(path: readonly LngLat[]): LngLat[] {
  const out: LngLat[] = [...path];
  for (let i = 0; i < path.length - 1; i++) out.push(midpoint(path[i], path[i + 1]));
  return out;
}

/**
 * Decide a segment's jurisdiction from whatever boundary layer is loaded.
 *
 * `fallback` is the province the system would otherwise have assumed — a
 * source tag or a device's claim. It is never promoted above `probable`, and
 * it is only used when no verified layer can answer.
 */
export function decideJurisdiction(args: {
  path: readonly LngLat[];
  boundaries: readonly BoundaryPolygon[];
  fallbackProvince?: string | null;
}): JurisdictionDecision {
  const { path, fallbackProvince = null } = args;
  const live = args.boundaries.filter(b => b.verificationStatus !== "superseded");
  const verified = live.filter(b => b.verificationStatus === "verified");

  const fallbackAnswer = (reason: JurisdictionReason, evidence: string[]): JurisdictionDecision =>
    fallbackProvince
      ? { province: fallbackProvince, confidence: "probable", authorizationEligible: false, crossing: null, reason, evidence }
      : { province: null, confidence: "unknown", authorizationEligible: false, crossing: null, reason, evidence };

  if (!path.length) {
    return { province: null, confidence: "unknown", authorizationEligible: false, crossing: null, reason: "unsupported_geometry", evidence: ["No geometry was supplied for this segment"] };
  }
  if (live.some(b => !b.ringsAreOuter)) {
    // A layer with holes would give confidently wrong answers around them.
    return fallbackAnswer("unsupported_geometry", ["A loaded boundary polygon declares inner rings, which this resolver does not model — it will not answer from a layer it cannot read correctly"]);
  }
  if (!live.length) return fallbackAnswer("no_boundary_layer", ["No province or territory boundary layer is loaded — jurisdiction cannot be established from the coordinate"]);
  if (!verified.length) {
    return fallbackAnswer("layer_unverified", [`A boundary layer is loaded from ${live[0].sourceCitation} but nobody has verified it — an unverified polygon is evidence, not proof`]);
  }

  const samples = samplesOf(path);
  const found = samples.map(s => provinceAt(s, verified));
  if (found.some(p => p === null)) {
    const n = found.filter(p => p === null).length;
    return {
      province: null, confidence: "unknown", authorizationEligible: false, crossing: null,
      reason: "outside_all_boundaries",
      evidence: [`${n} of ${samples.length} sampled points on this road fall outside every loaded boundary — the layer does not cover this road, and a road cannot be assumed into the nearest province`],
    };
  }

  const distinct = Array.from(new Set(found as string[]));
  if (distinct.length === 1) {
    return {
      province: distinct[0], confidence: "confirmed", authorizationEligible: true, crossing: null,
      reason: "wholly_inside",
      evidence: [`Every sampled point on this road lies inside ${distinct[0]}, from a verified boundary layer (${verified[0].sourceCitation})`],
    };
  }

  // Two or more. The road crosses. Which side it started on is the order the
  // geometry was given in, and the moment it crossed is not a fact here.
  return {
    province: null, confidence: "ambiguous", authorizationEligible: false,
    crossing: { detected: true, fromProvince: found[0] ?? null, toProvince: found[path.length - 1] ?? null },
    reason: "boundary_crossing",
    evidence: [`This road crosses a provincial boundary — sampled points fall in ${distinct.join(" and ")}. No single jurisdiction governs it, and the crossing time is not established by geometry alone.`],
  };
}
