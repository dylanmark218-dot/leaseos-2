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
export function evaluateZoneMembership(
  point: BreadcrumbPoint,
  zone: ZoneCandidate
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
