/**
 * v22.20 (0081) — where a road advisory touches this route, and what that is
 * allowed to mean.
 *
 * Pure. No network, no database.
 *
 * Two rules carry the whole module.
 *
 * **Geometry, not names.** A 511 event says "Highway 40" and a route is a list
 * of segment polylines; matching those by string would attach an advisory on
 * Highway 40 near Grande Cache to a truck on Highway 40 near Longview. So an
 * advisory is placed by intersecting its position and radius against the
 * ordered route, and an advisory that cannot be placed is reported as unplaced
 * rather than dropped or guessed onto the nearest segment.
 *
 * **Advisory stays advisory.** The result of this module is an impact, never a
 * verdict. A closure reported by a traffic feed can put a trip in front of a
 * person before departure; it cannot clear a verified restriction, make an
 * illegal route legal, or become the rule that blocks one. Those come from a
 * document somebody verified. The type here has no way to say otherwise, which
 * is the point.
 *
 * A third, smaller rule, learned from the channel work: a feed that has gone
 * quiet says so. An advisory that is hours older than its publisher's own
 * update interval is shown AS stale. "Probably still true" is not a state.
 */

import { polylineRangeMetres, type SegmentGeography } from "./commRoute";
import type { LngLat } from "./geoImport";

export type AdvisoryType = "closure" | "incident" | "construction" | "road_condition" | "weather" | "restriction" | "other";
export type AdvisorySeverity = "info" | "minor" | "major" | "closure" | "unknown";

export type RoadAdvisory = {
  sourceKey: string;
  externalRef: string;
  advisoryType: AdvisoryType;
  severity: AdvisorySeverity;
  headline: string;
  roadName: string | null;
  /** The publisher's own position. Null means it cannot be placed on a route. */
  point: LngLat | null;
  /** How far from that point the publisher says it applies. Null defaults conservatively. */
  radiusMetres: number | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  sourceUpdatedAt: Date | null;
  retrievedAt: Date;
  /** Structurally true. There is no shape of this type that says otherwise. */
  advisoryOnly: true;
};

/** A route as geometry, in order. The same shape the geography resolver produces. */
export type RouteLeg = { segmentId: string; lengthKm: number; geography: SegmentGeography | null };

/**
 * Without a stated radius, an advisory is taken to apply within this distance
 * of the point the publisher gave. Deliberately generous: an event placed a
 * little off the carriageway should still reach the road, and the cost of
 * over-reporting an advisory is a person reading one extra line.
 */
export const DEFAULT_ADVISORY_RADIUS_METRES = 2_000;

export type Staleness = "current" | "aging" | "stale" | "unknown";

export type AdvisoryPlacement = {
  advisory: RoadAdvisory;
  fromKm: number;
  toKm: number;
  segmentIds: string[];
  nearestMetres: number;
  ageMinutes: number | null;
  staleness: Staleness;
  /** One line, in the words a dispatcher would use. */
  line: string;
};

export type UnplacedAdvisory = { advisory: RoadAdvisory; reason: "no_position" | "no_route_geometry" | "out_of_window" | "too_far"; detail: string };

export type RouteAdvisoryImpact = {
  /** Always this. The caller cannot read a permission out of this object. */
  determination: "advisory_only";
  totalKm: number;
  placed: AdvisoryPlacement[];
  unplaced: UnplacedAdvisory[];
  /** Kilometres of the route with no usable geometry, where an advisory could not have been found even if one existed. */
  unsearchableKm: number;
  /** `clear` means nothing was found, not that nothing is happening. */
  outcome: "no_advisories" | "advisories" | "advisories_and_stale" | "unsearchable";
  summary: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

function stalenessOf(advisory: RoadAdvisory, at: Date, publisherIntervalHours: number | null): { ageMinutes: number | null; staleness: Staleness } {
  const basis = advisory.sourceUpdatedAt ?? advisory.retrievedAt;
  if (!basis) return { ageMinutes: null, staleness: "unknown" };
  const ageMinutes = Math.round((at.getTime() - basis.getTime()) / 60_000);
  if (publisherIntervalHours == null) return { ageMinutes, staleness: "unknown" };
  const interval = publisherIntervalHours * 60;
  return { ageMinutes, staleness: ageMinutes <= interval ? "current" : ageMinutes <= interval * 3 ? "aging" : "stale" };
}

const inWindow = (a: RoadAdvisory, at: Date): boolean =>
  (!a.effectiveFrom || at.getTime() >= a.effectiveFrom.getTime()) && (!a.effectiveTo || at.getTime() < a.effectiveTo.getTime());

/**
 * Walk the route and place each advisory on it by geometry.
 *
 * `publisherIntervalHours` is the source's own registered update interval — how
 * often the publisher says it refreshes — so staleness is measured against what
 * the publisher promised rather than a number invented here.
 */
export function advisoriesOnRoute(input: {
  route: readonly RouteLeg[];
  advisories: readonly RoadAdvisory[];
  at: Date;
  publisherIntervalHours?: number | null;
}): RouteAdvisoryImpact {
  const { route, at } = input;
  const interval = input.publisherIntervalHours ?? null;

  let km = 0;
  let unsearchableKm = 0;
  const spans: { segmentId: string; fromKm: number; toKm: number; path: readonly LngLat[] | null }[] = [];
  for (const leg of route) {
    const path = leg.geography?.path?.length ? leg.geography.path : null;
    if (!path) unsearchableKm += leg.lengthKm;
    spans.push({ segmentId: leg.segmentId, fromKm: round1(km), toKm: round1(km + leg.lengthKm), path });
    km += leg.lengthKm;
  }
  const totalKm = round1(km);

  const placed: AdvisoryPlacement[] = [];
  const unplaced: UnplacedAdvisory[] = [];

  for (const advisory of input.advisories) {
    if (!inWindow(advisory, at)) {
      // Named, not silently dropped — the same rule the restriction windows follow.
      unplaced.push({
        advisory, reason: "out_of_window",
        detail: advisory.effectiveTo && at.getTime() >= advisory.effectiveTo.getTime()
          ? `Ended ${advisory.effectiveTo.toISOString().slice(0, 16).replace("T", " ")}`
          : `Does not start until ${advisory.effectiveFrom?.toISOString().slice(0, 16).replace("T", " ") ?? "an unstated time"}`,
      });
      continue;
    }
    if (!advisory.point) {
      unplaced.push({ advisory, reason: "no_position", detail: `${advisory.headline} — the publisher gave no position, so it cannot be placed on a route${advisory.roadName ? ` (it names ${advisory.roadName})` : ""}` });
      continue;
    }
    const searchable = spans.filter(s => s.path);
    if (!searchable.length) {
      unplaced.push({ advisory, reason: "no_route_geometry", detail: "This route has no usable geometry, so nothing can be placed on it" });
      continue;
    }

    const radius = advisory.radiusMetres ?? DEFAULT_ADVISORY_RADIUS_METRES;
    let nearest = Number.POSITIVE_INFINITY;
    const touched: typeof spans = [];
    for (const s of searchable) {
      const { nearest: d } = polylineRangeMetres(advisory.point, s.path!);
      nearest = Math.min(nearest, d);
      if (d <= radius) touched.push(s);
    }
    if (!touched.length) {
      unplaced.push({ advisory, reason: "too_far", detail: `${advisory.headline} — closest approach ${Math.round(nearest / 100) / 10} km, outside its ${Math.round(radius / 100) / 10} km area` });
      continue;
    }

    const { ageMinutes, staleness } = stalenessOf(advisory, at, interval);
    const fromKm = Math.min(...touched.map(t => t.fromKm));
    const toKm = Math.max(...touched.map(t => t.toKm));
    const age = ageMinutes == null ? "age unknown" : ageMinutes < 60 ? `updated ${ageMinutes} min ago` : `updated ${Math.round(ageMinutes / 60)} h ago`;
    const flag = staleness === "stale" ? " · STALE, older than this feed's own refresh interval" : staleness === "aging" ? " · aging" : staleness === "unknown" ? " · staleness unknown" : "";
    placed.push({
      advisory, fromKm, toKm, segmentIds: touched.map(t => t.segmentId), nearestMetres: Math.round(nearest),
      ageMinutes, staleness,
      line: `km ${fromKm}–${toKm} · ${advisory.sourceKey} · ${advisory.headline} · ${age}${flag} · ADVISORY — review before departure`,
    });
  }

  placed.sort((a, b) => a.fromKm - b.fromKm);
  const anyStale = placed.some(p => p.staleness === "stale");
  const outcome: RouteAdvisoryImpact["outcome"] =
    unsearchableKm >= totalKm && totalKm > 0 ? "unsearchable"
    : placed.length === 0 ? "no_advisories"
    : anyStale ? "advisories_and_stale"
    : "advisories";

  const summary =
    outcome === "unsearchable"
      ? `This route has no usable geometry, so no advisory could be placed on it. That is not the same as no advisories.`
      : outcome === "no_advisories"
        ? `No advisory from the collected feeds touches this route${unsearchableKm > 0 ? `, though ${round1(unsearchableKm)} km of it could not be searched` : ""}. Nothing found is not nothing happening.`
        : `${placed.length} advisory(ies) touch this route${anyStale ? ", at least one of them older than its publisher's own refresh interval" : ""}. None of them changes whether this route is legal.`;

  return { determination: "advisory_only", totalKm, placed, unplaced, unsearchableKm: round1(unsearchableKm), outcome, summary };
}

/**
 * The lines a driver or dispatcher reads. Advisories first, then what could not
 * be placed — because "we could not place this" is information a person needs,
 * and hiding it would make the screen look more complete than the data is.
 */
export function advisoryLines(impact: RouteAdvisoryImpact): string[] {
  return [
    ...impact.placed.map(p => p.line),
    ...impact.unplaced.filter(u => u.reason !== "out_of_window").map(u => `UNPLACED · ${u.detail}`),
  ];
}
