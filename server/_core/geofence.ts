/**
 * Geofence math for the GPS breadcrumb / zone-event engine.
 *
 * Kept as pure functions with no DB/network access so accuracy behaviour can
 * be unit tested directly (see geofence.test.ts). This is deliberately the
 * only place distance/confidence math happens — the orchestration layer
 * (tripGps.ts) should never recompute it inline.
 */

export type ZoneCandidate = {
  id: number;
  latitude: number;
  longitude: number;
  radiusMetres: number;
};

export type BreadcrumbPoint = {
  latitude: number;
  longitude: number;
  /** GPS accuracy radius in metres, if the device/OS reported one. */
  accuracyMetres?: number | null;
};

export type Confidence = "low" | "medium" | "high";

export type ZoneMembership = {
  zoneId: number;
  distanceMetres: number;
  inside: boolean;
  confidence: Confidence;
};

export type TransitionEvent = {
  zoneId: number;
  eventType: "enter" | "exit";
  distanceMetres: number;
  confidence: Confidence;
};

const EARTH_RADIUS_METRES = 6_371_000;

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineMetres(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METRES * c;
}

/**
 * Decide whether a point is inside a zone, and how confident that call is.
 *
 * Confidence is driven by how the reported GPS accuracy compares to the
 * "margin" between the point and the zone boundary — a reading with 40 m of
 * accuracy sitting 5 m inside a 75 m-radius zone is a much weaker signal than
 * the same reading sitting 60 m inside it. Under tree canopy / in valleys
 * where accuracy degrades, this naturally downgrades to "low" instead of
 * pretending precision that isn't there.
 */
/**
 * Where the fix came from. Accuracy alone cannot tell these apart, and they are not comparable
 * kinds of evidence: a GPS receiver reports a measurement with an error estimate, a network fix
 * reports a coarser one whose estimate is often optimistic, and a typed position reports what a
 * person believes. All three arrive as a latitude, a longitude and a number called accuracy.
 */
export type FixSource = "gps" | "dead_reckoning" | "manual";

/**
 * The highest confidence each source may reach, whatever accuracy it claims.
 *
 * This is the same distinction the HOS attestation draws between stated and computed, one layer
 * down. A driver typing "I'm at the lease" can be recorded with `accuracyMetres: 5` — nothing
 * stops that, and the arithmetic below would then call it `high` and propose an arrival that looks
 * measured. A typed position is a statement; it may be perfectly true and it is still not a
 * measurement, so it is capped where a person can see it is one.
 */
const CONFIDENCE_CEILING: Readonly<Record<FixSource, Confidence>> = {
  gps: "high",
  // Dead reckoning is inference from the last known fix and a heading — a real method, and one
  // whose error grows with every metre travelled since the signal was lost.
  dead_reckoning: "medium",
  manual: "low",       // a statement about position, not an observation of it
};

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

export function evaluateZoneMembership(
  point: BreadcrumbPoint,
  zone: ZoneCandidate,
  /**
   * The value `tripBreadcrumbs.source` already carries. The column has recorded it since the table
   * existed; the confidence arithmetic simply never read it, so a typed position and a satellite
   * fix of the same claimed accuracy produced the same verdict. Optional here so existing callers
   * are unchanged; `tripGps` passes it, which is the boundary where a zone event is proposed.
   */
  fixSource?: FixSource
): ZoneMembership {
  const distanceMetres = haversineMetres(
    point.latitude,
    point.longitude,
    zone.latitude,
    zone.longitude
  );
  const inside = distanceMetres <= zone.radiusMetres;
  const margin = Math.abs(zone.radiusMetres - distanceMetres);

  // No accuracy reported (e.g. dead-reckoned point) → treat as the worst
  // case we'd still want to act on: as wide as the zone itself.
  const accuracyMetres = point.accuracyMetres ?? zone.radiusMetres;

  let confidence: Confidence;
  if (accuracyMetres <= margin * 0.5) confidence = "high";
  else if (accuracyMetres <= margin) confidence = "medium";
  else confidence = "low";

  // The ceiling only ever lowers. A source can make a tight fix less trusted; none can make a
  // loose one more trusted, which is why this is a cap and not a second opinion.
  if (fixSource) {
    const ceiling = CONFIDENCE_CEILING[fixSource];
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[ceiling]) confidence = ceiling;
  }

  return { zoneId: zone.id, distanceMetres, inside, confidence };
}

/**
 * Compare a trip's previous zone-membership state to its current one and
 * return only the state *changes* (enter/exit), not the full membership set.
 */
export function detectTransitions(
  previous: Pick<ZoneMembership, "zoneId" | "inside">[],
  current: ZoneMembership[]
): TransitionEvent[] {
  const wasInside = new Set(previous.filter(m => m.inside).map(m => m.zoneId));
  const events: TransitionEvent[] = [];

  for (const membership of current) {
    const nowInside = membership.inside;
    const previouslyInside = wasInside.has(membership.zoneId);
    if (nowInside && !previouslyInside) {
      events.push({
        zoneId: membership.zoneId,
        eventType: "enter",
        distanceMetres: membership.distanceMetres,
        confidence: membership.confidence,
      });
    } else if (!nowInside && previouslyInside) {
      events.push({
        zoneId: membership.zoneId,
        eventType: "exit",
        distanceMetres: membership.distanceMetres,
        confidence: membership.confidence,
      });
    }
  }

  return events;
}
