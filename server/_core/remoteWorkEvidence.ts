/**
 * Remote-work evidence.
 *
 * LeaseOS knows where a worker's home base is and where they worked. That is
 * evidence a worker and their accountant can use for a residency or travel
 * claim. It is not, and cannot become, a determination that a claim applies:
 * the rules that decide that are jurisdictional, dated, and not loaded (P9),
 * and even when they are, the decision belongs to a person.
 *
 * So the output type carries `taxConclusion: "not_determined"` as a literal.
 * Not an enum with other values, not a nullable field somebody could later
 * populate — a type that cannot express a conclusion. GPS proposes distance;
 * nothing here proposes eligibility.
 */

export type DistanceSource = "route_engine" | "geodesic" | "operator_confirmed" | "unknown";

export type Coordinates = { latitude: number; longitude: number };

export type RemoteWorkEvidenceInput = {
  userId: number;
  homeBaseRef: string;
  workLocationRef: string;
  /** ISO calendar date the work occurred on. */
  occurredOn: string;
  home?: Coordinates | null;
  work?: Coordinates | null;
  /** A distance from a routing engine, if one ran. Preferred over geodesic. */
  routedDistanceKm?: number | null;
  /** A distance the operator confirmed, e.g. from an odometer. */
  operatorConfirmedKm?: number | null;
  nightsAway?: number | null;
};

export type RemoteWorkEvidence = {
  userId: number;
  homeBaseRef: string;
  workLocationRef: string;
  occurredOn: string;
  distanceKm: number | null;
  distanceSource: DistanceSource;
  nightsAway: number | null;
  conclusion: "evidence_available" | "insufficient_evidence";
  insufficiencyReason?: string;
  /**
   * Always. This is the whole point of the type. A downstream reader that
   * wants a tax conclusion has to go get one from a person.
   */
  taxConclusion: "not_determined";
};

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance. Straight-line, so a floor on road distance, never a ceiling. */
export function geodesicKm(a: Coordinates, b: Coordinates): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const la1 = toRad(a.latitude);
  const la2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validCoords(c: Coordinates | null | undefined): c is Coordinates {
  return (
    !!c &&
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    Math.abs(c.latitude) <= 90 &&
    Math.abs(c.longitude) <= 180 &&
    // (0,0) is in the Gulf of Guinea, and is also what a failed GPS fix
    // reports. Nobody's home base is there.
    !(c.latitude === 0 && c.longitude === 0)
  );
}

/**
 * Build the evidence record. The distance source ladder is operator-confirmed
 * > routed > geodesic > unknown, and the record says which rung it reached.
 * Missing or implausible inputs yield `insufficient_evidence` with a reason,
 * never a silently-zero distance.
 */
export function buildRemoteWorkEvidence(input: RemoteWorkEvidenceInput): RemoteWorkEvidence {
  const base = {
    userId: input.userId,
    homeBaseRef: input.homeBaseRef,
    workLocationRef: input.workLocationRef,
    occurredOn: input.occurredOn,
    nightsAway: input.nightsAway ?? null,
    taxConclusion: "not_determined" as const,
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    return {
      ...base,
      distanceKm: null,
      distanceSource: "unknown",
      conclusion: "insufficient_evidence",
      insufficiencyReason: "occurredOn is not an ISO calendar date",
    };
  }
  if (input.nightsAway != null && (input.nightsAway < 0 || !Number.isInteger(input.nightsAway))) {
    return {
      ...base,
      distanceKm: null,
      distanceSource: "unknown",
      conclusion: "insufficient_evidence",
      insufficiencyReason: "nightsAway must be a non-negative whole number",
    };
  }

  if (input.operatorConfirmedKm != null && input.operatorConfirmedKm >= 0) {
    return {
      ...base,
      distanceKm: round1(input.operatorConfirmedKm),
      distanceSource: "operator_confirmed",
      conclusion: "evidence_available",
    };
  }
  if (input.routedDistanceKm != null && input.routedDistanceKm >= 0) {
    return {
      ...base,
      distanceKm: round1(input.routedDistanceKm),
      distanceSource: "route_engine",
      conclusion: "evidence_available",
    };
  }
  if (validCoords(input.home) && validCoords(input.work)) {
    return {
      ...base,
      distanceKm: round1(geodesicKm(input.home, input.work)),
      distanceSource: "geodesic",
      conclusion: "evidence_available",
    };
  }

  const missing: string[] = [];
  if (!validCoords(input.home)) missing.push("home base coordinates");
  if (!validCoords(input.work)) missing.push("work location coordinates");
  return {
    ...base,
    distanceKm: null,
    distanceSource: "unknown",
    conclusion: "insufficient_evidence",
    insufficiencyReason: `No usable distance: missing ${missing.join(" and ")}, no routed or confirmed distance`,
  };
}

/**
 * A calendar-year summary a worker can hand to an accountant. Counts and
 * distances only. It does not say whether any threshold is met, because it
 * does not know what the threshold is.
 */
export function summarizeRemoteWork(records: readonly RemoteWorkEvidence[]): {
  days: number;
  daysWithDistance: number;
  daysInsufficient: number;
  totalNightsAway: number;
  maxDistanceKm: number | null;
  distinctWorkLocations: number;
  taxConclusion: "not_determined";
} {
  const withDistance = records.filter(r => r.distanceKm != null);
  return {
    days: records.length,
    daysWithDistance: withDistance.length,
    daysInsufficient: records.filter(r => r.conclusion === "insufficient_evidence").length,
    totalNightsAway: records.reduce((n, r) => n + (r.nightsAway ?? 0), 0),
    maxDistanceKm: withDistance.length ? Math.max(...withDistance.map(r => r.distanceKm!)) : null,
    distinctWorkLocations: new Set(records.map(r => r.workLocationRef)).size,
    taxConclusion: "not_determined",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
