/**
 * v22.17 — Communications on the route.
 *
 * Pure. No network, no database.
 *
 * A frequency is not a permission to transmit. That sentence is the whole
 * module. LeaseOS can know that Weyer GP is 168.840 MHz and still have no
 * business telling a driver to key up on it: the channel has to exist in a
 * regulatory record, the company has to hold an authorization, the truck has
 * to carry a radio that can legally work it, and the position has to be
 * inside the geography the authorization covers. Four gates, each answerable
 * yes / no / unknown, and `authorized` only when every one says yes.
 *
 * Two questions are kept apart here exactly as `roadGraph` and
 * `routeEvaluation` keep theirs apart:
 *
 *   WHICH CHANNEL APPLIES   — resolved from candidates by authority, then
 *                             freshness. The posted road sign outranks every
 *                             database in this building.
 *   MAY WE TRANSMIT ON IT   — a separate answer, and frequently `unknown`.
 *
 * Communications is deliberately NOT a fifth routing axis. The four axes
 * answer whether a truck may travel a road; whether the driver can call for
 * help on it is a different question with a different failure mode, and
 * collapsing them would let a good radio plan argue a truck onto a bridge.
 * The plan travels beside the verdict, never inside it.
 */

import type { DispatchBlocker } from "./dispatchReadiness";
import { haversineMetres, type LngLat } from "./geoImport";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

/**
 * Who says so, strongest first. BC states plainly that its channel maps are
 * planning tools and the posted road sign governs, so the sign sits above
 * every dataset we could import — including the regulator's own.
 */
export const AUTHORITY_TIERS = [
  "posted_sign",
  "operator_instruction",
  "regulatory_authority",
  "planning_map",
  "company_entry",
  "driver_observation",
  "community_reference",
  "unverified_submission",
] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];

/** Lower is stronger. A tier not in the list is weaker than everything named. */
export const authorityRank = (t: AuthorityTier): number => {
  const i = AUTHORITY_TIERS.indexOf(t);
  return i === -1 ? AUTHORITY_TIERS.length : i;
};

export const AUTHORITY_LABELS: Record<AuthorityTier, string> = {
  posted_sign: "the channel posted on the road",
  operator_instruction: "the road operator's own instruction",
  regulatory_authority: "a regulator's authorization record",
  planning_map: "a provincial planning map",
  company_entry: "a company entry",
  driver_observation: "a driver's observation",
  community_reference: "a community reference database",
  unverified_submission: "an unverified submission",
};

/**
 * What kind of service a channel belongs to. These are not interchangeable:
 * a resource-road channel is traffic safety, a loading channel is a worksite,
 * and a public-safety or amateur allocation is neither and never appears on a
 * driver's operational channel list.
 */
export type RadioServiceClass =
  | "bc_resource_road"
  | "bc_loading"
  | "land_mobile_b1"
  | "company_private"
  | "operator_private"
  | "cb_grs"
  | "frs_gmrs"
  | "public_safety"
  | "amateur";

/** Service classes a commercial driver may be offered as an operational channel. */
export const OPERATIONAL_SERVICE_CLASSES: readonly RadioServiceClass[] = [
  "bc_resource_road",
  "bc_loading",
  "land_mobile_b1",
  "company_private",
  "operator_private",
  "cb_grs",
  "frs_gmrs",
];

/** Neither of these is a trucking channel, whatever a scanner site lists. */
export const NEVER_OPERATIONAL: readonly RadioServiceClass[] = ["public_safety", "amateur"];

export type RadioSystemType = "simplex" | "repeater" | "trunked" | "cb";

export type VerificationStatus = "unverified" | "verified" | "superseded";

/** Jurisdiction evidence is separate from geometry: a source-wide tag is not a coordinate boundary. */
export type JurisdictionConfidence = "confirmed" | "probable" | "ambiguous" | "unknown";

export type JurisdictionCrossing = {
  fromProvince: string | null;
  toProvince: string | null;
  /** Evidence references, not an invented crossing timestamp. */
  evidenceRefs: string[];
};

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

/**
 * A geographic condition attached to a channel. ISED's western/northern
 * mobile appendix is full of these — a latitude line, a radius around a town —
 * and they are the reason a static "LADD 1..4" menu is unsafe.
 */
export type GeoCondition =
  | { kind: "provinces_permitted"; provinces: string[] }
  | { kind: "excluded_south_of_latitude"; latitude: number; note?: string }
  | { kind: "excluded_north_of_latitude"; latitude: number; note?: string }
  | { kind: "excluded_within_radius"; latitude: number; longitude: number; radiusKm: number; placeName: string }
  | { kind: "posted_use_only"; note?: string };

export type RadioChannel = {
  channelKey: string;
  alias: string;
  serviceClass: RadioServiceClass;
  systemType: RadioSystemType;
  /** Megahertz. A repeater's input differs from its output; simplex repeats one value. */
  rxMHz: number | null;
  txMHz: number | null;
  toneRxHz?: number | null;
  toneTxHz?: number | null;
  bandwidthKHz?: number | null;
  maxPowerW?: number | null;
  licenceRequired: boolean;
  conditions: GeoCondition[];
  sourceKey: string;
  sourceCitation: string;
  sourceVersion?: string | null;
  verificationStatus: VerificationStatus;
  /**
   * v22.18 — Weatheradio was shut down while its transmitter frequencies stayed
   * published on the same site. A frequency database without this flag will
   * cheerfully tell a driver to rely on a service that no longer transmits, and
   * the driver will find out at the worst possible moment. Absent reads active,
   * so every existing record keeps its meaning.
   */
  serviceStatus?: "active" | "retired" | null;
  retiredNote?: string | null;
};

export type CompanyAuthorization = {
  channelKey: string;
  authorized: boolean;
  licenceRef?: string | null;
  licenceExpiresAt?: Date | null;
  provinces?: string[] | null;
  /** Empty or absent means every unit; a list means only these. */
  approvedUnitIds?: number[] | null;
  verificationStatus: VerificationStatus;
};

/** What is actually bolted into the truck, and whether it has been programmed for this. */
export type UnitRadioCapability = {
  unitId: number;
  vhf: boolean;
  uhf: boolean;
  cb: boolean;
  satellite: boolean;
  cellular: boolean;
  /** The shop's programming profile. A radio that has never been programmed cannot hold a posted channel. */
  programmingProfileRef?: string | null;
  programmedChannelKeys?: string[] | null;
  verificationStatus: VerificationStatus;
};

/** A channel bound to a piece of road, for a window, by somebody. */
export type RoadRadioAssignment = {
  assignmentRef: string;
  segmentId: string;
  channelKey: string;
  authorityTier: AuthorityTier;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  /** Calling convention, in the operator's own words where there is one. */
  callDirectionLoaded?: "increasing_km" | "decreasing_km" | null;
  callIntervalKm?: number | null;
  mustCallKm?: number[] | null;
  roadName?: string | null;
  observedAt?: Date | null;
  verificationStatus: VerificationStatus;
  supersedesAssignmentRef?: string | null;
};

/** Communication availability over a segment, from whatever said so. */
export type CoverageObservation = {
  segmentId: string;
  medium: "cellular" | "satellite" | "radio";
  /** `available` and `unavailable` are both evidence. Absence of a row is neither. */
  state: "available" | "intermittent" | "unavailable";
  sourceKey: string;
  authorityTier: AuthorityTier;
  observedAt?: Date | null;
  verificationStatus: VerificationStatus;
};

/* ------------------------------------------------------------------ */
/* Effective windows                                                    */
/* ------------------------------------------------------------------ */

export type WindowState = "in_force" | "not_yet_in_force" | "expired" | "always";

/**
 * Deliberately identical in behaviour to `structures.windowState` — `from`
 * inclusive, `to` exclusive — so a temporary radio change and a spring road
 * ban expire by the same arithmetic and nobody has to remember two rules.
 */
export function windowState(d: { effectiveFrom?: Date | null; effectiveTo?: Date | null }, at: Date): WindowState {
  if (!d.effectiveFrom && !d.effectiveTo) return "always";
  if (d.effectiveFrom && at.getTime() < d.effectiveFrom.getTime()) return "not_yet_in_force";
  if (d.effectiveTo && at.getTime() >= d.effectiveTo.getTime()) return "expired";
  return "in_force";
}

export const inForce = (d: { effectiveFrom?: Date | null; effectiveTo?: Date | null }, at: Date): boolean => {
  const s = windowState(d, at);
  return s === "in_force" || s === "always";
};

/* ------------------------------------------------------------------ */
/* Which channel applies                                                */
/* ------------------------------------------------------------------ */

export type AssignmentOutcome = "chosen" | "outranked" | "not_in_force" | "superseded";

export type ResolvedAssignment = {
  chosen: RoadRadioAssignment | null;
  /** Every candidate and why it did or did not win. This is the explanation. */
  considered: { assignmentRef: string; authorityTier: AuthorityTier; outcome: AssignmentOutcome; reason: string }[];
  reasons: string[];
};

/**
 * Resolve the channel for one segment. Authority first, freshness second —
 * never nearest, never newest-wins. A three-day-old posted sign beats a
 * regulator's dataset published this morning, because the sign is what the
 * driver is standing in front of.
 */
export function resolveAssignment(candidates: readonly RoadRadioAssignment[], at: Date): ResolvedAssignment {
  const considered: ResolvedAssignment["considered"] = [];
  const live: RoadRadioAssignment[] = [];

  for (const c of candidates) {
    if (c.verificationStatus === "superseded") {
      considered.push({ assignmentRef: c.assignmentRef, authorityTier: c.authorityTier, outcome: "superseded", reason: "Superseded by a later assignment" });
      continue;
    }
    const state = windowState(c, at);
    if (state !== "in_force" && state !== "always") {
      considered.push({
        assignmentRef: c.assignmentRef,
        authorityTier: c.authorityTier,
        outcome: "not_in_force",
        reason: state === "expired" ? "Its effective window has ended" : "Its effective window has not started",
      });
      continue;
    }
    live.push(c);
  }

  const freshness = (a: RoadRadioAssignment) => a.observedAt?.getTime() ?? 0;
  /**
   * At equal authority, the more specific record governs — the same principle
   * v22.15 applied to restrictions, where the most restrictive rule wins rather
   * than whichever was recorded last.
   *
   * A dated window is more specific than a standing assignment: an operator who
   * moves a haul road to another channel for one week has said something about
   * that week that the permanent record does not. Ordering on freshness alone
   * let the standing record govern whenever the two were recorded in the same
   * second, which is exactly what happens when both come from one document —
   * and the driver would have been briefed on the old channel for the whole
   * week the change was in force.
   */
  const bounded = (a: RoadRadioAssignment) => (a.effectiveFrom || a.effectiveTo ? 0 : 1);
  live.sort((a, b) => authorityRank(a.authorityTier) - authorityRank(b.authorityTier) || bounded(a) - bounded(b) || freshness(b) - freshness(a));
  const chosen = live[0] ?? null;

  for (const c of live) {
    if (c === chosen) {
      considered.push({ assignmentRef: c.assignmentRef, authorityTier: c.authorityTier, outcome: "chosen", reason: `Governs: ${AUTHORITY_LABELS[c.authorityTier]}${bounded(c) === 0 ? ", in force for this date" : ""}` });
    } else {
      const sameTier = c.authorityTier === chosen!.authorityTier;
      considered.push({
        assignmentRef: c.assignmentRef,
        authorityTier: c.authorityTier,
        outcome: "outranked",
        reason: sameTier
          ? bounded(chosen!) === 0 && bounded(c) === 1
            ? "Outranked by a dated assignment in force for this date, from the same authority"
            : "Outranked by a more recently observed record from the same authority"
          : `Outranked by ${AUTHORITY_LABELS[chosen!.authorityTier]}`,
      });
    }
  }

  const reasons = chosen
    ? [`${chosen.channelKey} on ${chosen.roadName ?? chosen.segmentId}, from ${AUTHORITY_LABELS[chosen.authorityTier]}`]
    : ["No channel assignment is in force for this segment"];
  if (chosen && chosen.authorityTier !== "posted_sign") reasons.push("The channel posted on the road governs over this record — verify the sign.");
  return { chosen, considered, reasons };
}

/* ------------------------------------------------------------------ */
/* Geography                                                            */
/* ------------------------------------------------------------------ */

/**
 * v22.20 — the road as it actually lies, not one representative point.
 *
 * A single LngLat per segment cannot decide a geographic authorization. An edge
 * running from 53.60N to 53.40N crosses the 53°30′ line: pick the start and the
 * whole thing looks authorized, pick the end and it looks excluded, pick the
 * midpoint and you have classified a road by a coin toss. The radius rules are
 * worse — both endpoints can sit outside a 100 km exclusion while the road
 * between them runs straight through it.
 *
 * So conditions are evaluated over the ordered geometry, and jurisdiction comes
 * from the segment rather than from one route-wide assertion by the caller —
 * which a route from Alberta into BC would make wrong for half its length.
 */
export type SegmentGeography = {
  segmentId: string;
  /** Derived from evidence about the road, never from the caller. */
  province: string | null;
  /**
   * Optional for backwards-compatible pure callers. Database-backed geography always
   * supplies it. `probable` is evidence, not authorization; `ambiguous` means the
   * segment crosses a jurisdiction boundary; `unknown` means no jurisdiction was
   * established.
   */
  jurisdictionConfidence?: JurisdictionConfidence;
  jurisdictionCandidates?: readonly string[];
  jurisdictionEvidenceRefs?: readonly string[];
  crossing?: JurisdictionCrossing | null;
  /** Ordered road geometry. Two points is a straight edge; more is the real shape. */
  path: readonly LngLat[];
  buildRef?: string | null;
  geometryHash?: string | null;
};

/**
 * `crosses` is its own answer. A segment that is authorized for part of its
 * length and not for the rest is neither, and the honest first response is to
 * refuse to call it authorized rather than to pick a representative point.
 */
export type ConditionResult = "permitted" | "excluded" | "crosses" | "requires_posting" | "unknown";

export type ConditionFinding = {
  condition: GeoCondition;
  result: ConditionResult;
  /** The arithmetic, stated. "39 km south of the line", not "restricted". */
  reason: string;
};

/** Metres from a point to a line segment, on a local plane. Road edges are short. */
export function pointToSegmentMetres(p: LngLat, a: LngLat, b: LngLat): number {
  const lat0 = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_540;
  const px = (p[0] - a[0]) * mx, py = (p[1] - a[1]) * my;
  const bx = (b[0] - a[0]) * mx, by = (b[1] - a[1]) * my;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return haversineMetres(p, a);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const dx = px - t * bx, dy = py - t * by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Nearest and farthest approach of a polyline to a centre. The nearest may fall
 * in the interior of an edge — which is the whole point, since that is how a
 * road passes through an exclusion circle whose endpoints it never enters. The
 * farthest is always at a vertex, because distance is convex along a straight
 * line.
 */
export function polylineRangeMetres(centre: LngLat, path: readonly LngLat[]): { nearest: number; farthest: number } {
  if (!path.length) return { nearest: Number.NaN, farthest: Number.NaN };
  if (path.length === 1) { const d = haversineMetres(centre, path[0]); return { nearest: d, farthest: d }; }
  let nearest = Number.POSITIVE_INFINITY;
  let farthest = 0;
  for (let i = 0; i < path.length - 1; i++) nearest = Math.min(nearest, pointToSegmentMetres(centre, path[i], path[i + 1]));
  for (const v of path) farthest = Math.max(farthest, haversineMetres(centre, v));
  return { nearest, farthest };
}

const dms = (deg: number): string => {
  const d = Math.floor(Math.abs(deg));
  const m = Math.floor((Math.abs(deg) - d) * 60);
  const s = Math.round(((Math.abs(deg) - d) * 60 - m) * 60);
  return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″`;
};

/**
 * Evaluate one condition over a segment's actual geometry.
 *
 * The rule, in order: no geometry is UNKNOWN; geometry wholly on the permitted
 * side is permitted; geometry wholly inside an exclusion is excluded; geometry
 * that crosses the boundary is `crosses` — never "authorized", because half a
 * road is not a permission.
 */
export function evaluateConditionOverGeography(condition: GeoCondition, geo: SegmentGeography | null): ConditionFinding {
  if (condition.kind === "posted_use_only") {
    return { condition, result: "requires_posting", reason: condition.note ?? "Authorized only where this channel is posted on the road" };
  }
  if (!geo || !geo.path.length) {
    return { condition, result: "unknown", reason: "A geographic condition applies and this segment's road geometry is not on record — no point was guessed in its place" };
  }
  if (condition.kind === "provinces_permitted") {
    // The jurisdiction of the road, not of the route. A source-wide jurisdiction
    // tag is only probable evidence: it cannot prove that a polyline did not cross
    // the provincial border. Legacy pure callers that omit confidence keep their
    // explicit province semantics; the database resolver always supplies it.
    const confidence = geo.jurisdictionConfidence ?? (geo.province ? "confirmed" : "unknown");
    const candidates = Array.from(new Set(geo.jurisdictionCandidates ?? (geo.province ? [geo.province] : [])));
    if (confidence === "ambiguous") {
      const named = candidates.length ? candidates.join(" / ") : "more than one jurisdiction";
      return { condition, result: "crosses", reason: `This segment crosses a jurisdiction boundary (${named}) — no single provincial authorization covers the whole segment` };
    }
    if (confidence === "probable") {
      return { condition, result: "unknown", reason: `The road source suggests ${geo.province ?? (candidates.join(" / ") || "a jurisdiction")}, but source-wide jurisdiction metadata is not coordinate-level boundary evidence — authorization is withheld` };
    }
    if (confidence === "unknown" || !geo.province) return { condition, result: "unknown", reason: `Permitted in ${condition.provinces.join(", ")} — this segment's jurisdiction is not established by coordinate-level road evidence` };
    return condition.provinces.includes(geo.province)
      ? { condition, result: "permitted", reason: `${geo.province} is confirmed among the permitted provinces (${condition.provinces.join(", ")})` }
      : { condition, result: "excluded", reason: `Confirmed in ${geo.province}, which is not among the permitted provinces (${condition.provinces.join(", ")})` };
  }

  if (condition.kind === "excluded_south_of_latitude" || condition.kind === "excluded_north_of_latitude") {
    const south = condition.kind === "excluded_south_of_latitude";
    const lats = geo.path.map(pt => pt[1]);
    const lo = Math.min(...lats), hi = Math.max(...lats);
    const wholly_excluded = south ? hi < condition.latitude : lo > condition.latitude;
    const wholly_permitted = south ? lo >= condition.latitude : hi <= condition.latitude;
    const side = south ? "south" : "north";
    if (wholly_excluded) return { condition, result: "excluded", reason: `Excluded ${side} of ${dms(condition.latitude)}N; this segment lies entirely ${side} of it (${lo.toFixed(4)}N to ${hi.toFixed(4)}N)${condition.note ? ` (${condition.note})` : ""}` };
    if (wholly_permitted) return { condition, result: "permitted", reason: `Entirely clear of the ${dms(condition.latitude)}N exclusion (${lo.toFixed(4)}N to ${hi.toFixed(4)}N)` };
    return { condition, result: "crosses", reason: `This segment crosses ${dms(condition.latitude)}N (${lo.toFixed(4)}N to ${hi.toFixed(4)}N) — authorization changes along it, so no single answer covers the whole segment` };
  }

  // excluded_within_radius
  const centre: LngLat = [condition.longitude, condition.latitude];
  const { nearest, farthest } = polylineRangeMetres(centre, geo.path);
  const r = condition.radiusKm * 1000;
  const km = (m: number) => Math.round(m / 100) / 10;
  if (farthest <= r) return { condition, result: "excluded", reason: `Excluded within ${condition.radiusKm} km of ${condition.placeName}; this segment lies entirely inside (${km(nearest)}–${km(farthest)} km away)` };
  if (nearest > r) return { condition, result: "permitted", reason: `${km(nearest)} km from ${condition.placeName} at its closest, outside the ${condition.radiusKm} km exclusion` };
  return { condition, result: "crosses", reason: `This segment enters the ${condition.radiusKm} km exclusion around ${condition.placeName} (closest approach ${km(nearest)} km) without lying wholly inside it` };
}

/**
 * Evaluate one condition against a position. An exclusion is honoured whether
 * or not the row carrying it is verified: the conservative direction for a
 * restriction is to apply it, and the conservative direction for a permission
 * is to withhold it. Those are opposite, and both are handled here.
 */
export function evaluateCondition(
  condition: GeoCondition,
  position: LngLat | null,
  province: string | null,
  /**
   * v22.20 — how the province was established. Defaults to `confirmed` so the
   * primitive keeps its own meaning ("given this province, here is the answer");
   * the policy about who may assert a province lives in `transmitAuthorization`,
   * which passes `probable` for one that came from a caller rather than a road.
   */
  provinceConfidence: JurisdictionConfidence = "confirmed",
): ConditionFinding {
  if (condition.kind === "posted_use_only") {
    return { condition, result: "requires_posting", reason: condition.note ?? "Authorized only where this channel is posted on the road" };
  }
  if (condition.kind === "provinces_permitted") {
    if (!province) return { condition, result: "unknown", reason: `Permitted in ${condition.provinces.join(", ")} — the position's province is not established` };
    if (!condition.provinces.includes(province)) {
      // Fail-safe in both directions: if the assertion is right the channel is
      // excluded, and if it is wrong the truck is somewhere nobody has
      // established. Neither is a permission.
      return { condition, result: "excluded", reason: `Not authorized in ${province} — permitted in ${condition.provinces.join(", ")} only` };
    }
    return provinceConfidence === "confirmed"
      ? { condition, result: "permitted", reason: `${province} is among the permitted provinces (${condition.provinces.join(", ")})` }
      : { condition, result: "unknown", reason: `${province} is among the permitted provinces (${condition.provinces.join(", ")}), but it was asserted by the caller rather than established from the road — a device reporting its own province is evidence, not proof` };
  }
  if (!position) return { condition, result: "unknown", reason: "A geographic condition applies and no position was supplied to check it against" };
  const [lng, lat] = position;

  if (condition.kind === "excluded_south_of_latitude") {
    const deltaKm = Math.round(Math.abs(lat - condition.latitude) * 111);
    return lat < condition.latitude
      ? { condition, result: "excluded", reason: `Excluded south of ${dms(condition.latitude)}N; this position is ${lat.toFixed(4)}N — ${deltaKm} km south of the line${condition.note ? ` (${condition.note})` : ""}` }
      : { condition, result: "permitted", reason: `North of the ${dms(condition.latitude)}N exclusion by ${deltaKm} km` };
  }
  if (condition.kind === "excluded_north_of_latitude") {
    const deltaKm = Math.round(Math.abs(lat - condition.latitude) * 111);
    return lat > condition.latitude
      ? { condition, result: "excluded", reason: `Excluded north of ${dms(condition.latitude)}N; this position is ${lat.toFixed(4)}N — ${deltaKm} km north of the line` }
      : { condition, result: "permitted", reason: `South of the ${dms(condition.latitude)}N exclusion by ${deltaKm} km` };
  }
  // excluded_within_radius
  const km = Math.round(haversineMetres(position, [condition.longitude, condition.latitude]) / 100) / 10;
  return km <= condition.radiusKm
    ? { condition, result: "excluded", reason: `Excluded within ${condition.radiusKm} km of ${condition.placeName}; this position is ${km} km away` }
    : { condition, result: "permitted", reason: `${km} km from ${condition.placeName}, outside the ${condition.radiusKm} km exclusion` };
}

/* ------------------------------------------------------------------ */
/* May we transmit                                                      */
/* ------------------------------------------------------------------ */

export type TransmitStatus = "authorized" | "not_authorized" | "requires_posted_channel" | "unknown";

export type Gate = { gate: "channel_record" | "service_class" | "geography" | "company_authorization" | "unit_capability"; result: "yes" | "no" | "unknown" | "requires_posting"; reason: string };

export type TransmitAuthorization = {
  channelKey: string;
  status: TransmitStatus;
  gates: Gate[];
  conditions: ConditionFinding[];
  reasons: string[];
};

export type TransmitContext = {
  channel: RadioChannel | null;
  channelKey: string;
  companyAuthorization?: CompanyAuthorization | null;
  unit?: UnitRadioCapability | null;
  position?: LngLat | null;
  province?: string | null;
  /**
   * The segment's own geometry and jurisdiction. When present it decides, and a
   * caller-supplied province cannot override it — the road knows where it is
   * and the caller is asserting.
   */
  geography?: SegmentGeography | null;
  at: Date;
  /** True when the governing assignment came from a sign posted on this road. */
  postedOnThisRoad?: boolean;
};

/**
 * The four gates, plus the one that keeps a public-safety allocation off a
 * driver's screen. `authorized` requires every gate to say yes; a single
 * `no` is `not_authorized`; otherwise the answer is `unknown`, and unknown is
 * never quietly upgraded.
 */
export function transmitAuthorization(ctx: TransmitContext): TransmitAuthorization {
  const gates: Gate[] = [];
  const conditions: ConditionFinding[] = [];
  const { channel } = ctx;

  if (!channel) {
    return {
      channelKey: ctx.channelKey,
      status: "unknown",
      gates: [{ gate: "channel_record", result: "unknown", reason: `${ctx.channelKey} is not in the channel registry — nothing is known about it` }],
      conditions: [],
      reasons: [`${ctx.channelKey} is not a channel LeaseOS holds a record for`],
    };
  }

  /* 0. Does the service still exist? A retired one is not a fallback. */
  if (channel.serviceStatus === "retired") {
    return {
      channelKey: channel.channelKey,
      status: "not_authorized",
      gates: [{ gate: "channel_record", result: "no", reason: `${channel.channelKey} is a retired service and is not a communication option${channel.retiredNote ? ` — ${channel.retiredNote}` : ""}` }],
      conditions: [],
      reasons: [`${channel.alias} no longer transmits. A published frequency for a shut-down service is not a fallback.`],
    };
  }

  /* 1. Is the channel record itself something a person has verified? */
  gates.push(
    channel.verificationStatus === "verified"
      ? { gate: "channel_record", result: "yes", reason: `Channel record verified against ${channel.sourceCitation}` }
      : channel.verificationStatus === "superseded"
        ? { gate: "channel_record", result: "no", reason: "The channel record is superseded" }
        : { gate: "channel_record", result: "unknown", reason: `Channel record is unverified — seeded from ${channel.sourceCitation} and not yet checked against it by a person` }
  );

  /* 2. Is this even a class of channel a commercial driver operates? */
  gates.push(
    NEVER_OPERATIONAL.includes(channel.serviceClass)
      ? { gate: "service_class", result: "no", reason: `${channel.serviceClass.replace(/_/g, " ")} is not a commercial trucking service — it is not offered as an operational channel` }
      : { gate: "service_class", result: "yes", reason: `${channel.serviceClass.replace(/_/g, " ")} is an operational class` }
  );

  /* 3. Geography. Any exclusion is decisive; a posted-use condition is its own answer. */
  let geo: Gate["result"] = "yes";
  let geoReason = "No geographic condition restricts this channel here";
  if (channel.conditions.length) {
    for (const c of channel.conditions) {
      conditions.push(ctx.geography ? evaluateConditionOverGeography(c, ctx.geography) : evaluateCondition(c, ctx.position ?? null, ctx.province ?? null, "probable"));
    }
    const excluded = conditions.find(c => c.result === "excluded");
    // A segment that crosses a boundary is never authorized. Splitting it at the
    // boundary is the mature answer; refusing to call it authorized is the
    // answer that is safe before that exists.
    const crossing = conditions.find(c => c.result === "crosses");
    const unknown = conditions.find(c => c.result === "unknown");
    const posting = conditions.find(c => c.result === "requires_posting");
    if (excluded) { geo = "no"; geoReason = excluded.reason; }
    else if (crossing) { geo = "unknown"; geoReason = crossing.reason; }
    else if (posting) {
      geo = ctx.postedOnThisRoad ? "yes" : "requires_posting";
      geoReason = ctx.postedOnThisRoad ? `${posting.reason} — and it is posted on this road` : posting.reason;
    }
    else if (unknown) { geo = "unknown"; geoReason = unknown.reason; }
    else { geoReason = conditions.map(c => c.reason).join("; "); }
  }
  gates.push({ gate: "geography", result: geo, reason: geoReason });

  /* 4. Does the company hold an authorization, and is it in force? */
  if (!channel.licenceRequired) {
    gates.push({ gate: "company_authorization", result: "yes", reason: "No licence is required for this service" });
  } else {
    const a = ctx.companyAuthorization;
    if (!a) gates.push({ gate: "company_authorization", result: "unknown", reason: "No company authorization is on record for this channel — a known frequency is not a permission to transmit" });
    else if (!a.authorized) gates.push({ gate: "company_authorization", result: "no", reason: "The company is recorded as not authorized on this channel" });
    else if (a.licenceExpiresAt && a.licenceExpiresAt.getTime() <= ctx.at.getTime()) gates.push({ gate: "company_authorization", result: "no", reason: `The company licence${a.licenceRef ? ` ${a.licenceRef}` : ""} expired ${a.licenceExpiresAt.toISOString().slice(0, 10)}` });
    else if (a.provinces?.length) {
      // A province-scoped company licence needs the same jurisdiction proof as a
      // province-scoped channel condition. Before this, the channel geography
      // could be UNKNOWN while the company gate silently skipped its province
      // check because no caller-supplied province was present.
      // A province off the device is the device's claim about where it is. A tablet
      // 5 km inside BC reporting "AB" would otherwise have cleared a province-limited
      // licence, which is the same false certainty the source-level tag had.
      const confidence = ctx.geography?.jurisdictionConfidence ?? (ctx.geography?.province ? "confirmed" : ctx.province ? "probable" : "unknown");
      const p = ctx.geography ? ctx.geography.province : (ctx.province ?? null);
      if (p && !a.provinces.includes(p)) gates.push({ gate: "company_authorization", result: "no", reason: `The company authorization covers ${a.provinces.join(", ")}, not ${p}` });
      else if (confidence !== "confirmed" || !p) gates.push({ gate: "company_authorization", result: "unknown", reason: `The company authorization is limited to ${a.provinces.join(", ")}, but this segment's jurisdiction is ${confidence} rather than confirmed` });
      else if (a.approvedUnitIds?.length && ctx.unit && !a.approvedUnitIds.includes(ctx.unit.unitId)) gates.push({ gate: "company_authorization", result: "no", reason: "This unit is not among the units the authorization covers" });
      else if (a.verificationStatus !== "verified") gates.push({ gate: "company_authorization", result: "unknown", reason: "The company authorization is recorded but unverified against the licence document" });
      else gates.push({ gate: "company_authorization", result: "yes", reason: `Company licence${a.licenceRef ? ` ${a.licenceRef}` : ""} verified and in force for confirmed ${p}` });
    }
    else if (a.approvedUnitIds?.length && ctx.unit && !a.approvedUnitIds.includes(ctx.unit.unitId)) gates.push({ gate: "company_authorization", result: "no", reason: "This unit is not among the units the authorization covers" });
    else if (a.verificationStatus !== "verified") gates.push({ gate: "company_authorization", result: "unknown", reason: "The company authorization is recorded but unverified against the licence document" });
    else gates.push({ gate: "company_authorization", result: "yes", reason: `Company licence${a.licenceRef ? ` ${a.licenceRef}` : ""} verified and in force` });
  }

  /* 5. Does the truck carry — and has the shop programmed — a radio for it? */
  const u = ctx.unit;
  if (!u) gates.push({ gate: "unit_capability", result: "unknown", reason: "No radio capability is recorded for this unit" });
  else {
    const needsCb = channel.serviceClass === "cb_grs";
    const needsUhf = channel.serviceClass === "frs_gmrs" || (channel.rxMHz != null && channel.rxMHz >= 400);
    const has = needsCb ? u.cb : needsUhf ? u.uhf : u.vhf;
    if (!has) gates.push({ gate: "unit_capability", result: "no", reason: `The unit carries no ${needsCb ? "CB" : needsUhf ? "UHF" : "VHF"} radio` });
    else if (u.programmedChannelKeys && u.programmedChannelKeys.length && !u.programmedChannelKeys.includes(channel.channelKey)) {
      gates.push({ gate: "unit_capability", result: "no", reason: `${channel.channelKey} is not in the unit's programming profile${u.programmingProfileRef ? ` ${u.programmingProfileRef}` : ""} — LeaseOS does not program radios` });
    } else if (!u.programmedChannelKeys || !u.programmedChannelKeys.length) {
      gates.push({ gate: "unit_capability", result: "unknown", reason: "The unit's programmed channel list is not recorded — whether this channel is loaded is unknown" });
    } else gates.push({ gate: "unit_capability", result: "yes", reason: `In the unit's programming profile${u.programmingProfileRef ? ` ${u.programmingProfileRef}` : ""}` });
  }

  const status: TransmitStatus = gates.some(g => g.result === "no")
    ? "not_authorized"
    : gates.some(g => g.result === "requires_posting")
      ? "requires_posted_channel"
      : gates.some(g => g.result === "unknown")
        ? "unknown"
        : "authorized";

  const reasons = gates.filter(g => g.result !== "yes").map(g => g.reason);
  if (status === "authorized") reasons.push("Every gate answers yes — select this channel on the authorized radio.");
  return { channelKey: channel.channelKey, status, gates, conditions, reasons };
}

/* ------------------------------------------------------------------ */
/* The plan along a route                                               */
/* ------------------------------------------------------------------ */

export type PathSegment = { segmentId: string; label: string; lengthKm: number };

export type CommunicationZone = {
  fromKm: number;
  toKm: number;
  segmentIds: string[];
  roadName: string | null;
  channelKey: string | null;
  alias: string | null;
  rxMHz: number | null;
  txMHz: number | null;
  authorityTier: AuthorityTier | null;
  transmit: TransmitStatus;
  transmitReasons: string[];
  callDirectionLoaded: "increasing_km" | "decreasing_km" | null;
  callIntervalKm: number | null;
  mustCallKm: number[];
  /** Present when nothing assigns a channel to this stretch. */
  unknownReason: string | null;
};

export type CoverageRun = { medium: "cellular" | "satellite" | "radio"; availableKm: number; intermittentKm: number; unavailableKm: number; unknownKm: number };

export type CommunicationsVerdict = "covered" | "gaps" | "unknown";

export type CommunicationsPlan = {
  totalKm: number;
  zones: CommunicationZone[];
  changes: { atKm: number; from: string | null; to: string | null; note: string }[];
  mustCall: { atKm: number; channelKey: string | null; roadName: string | null }[];
  coverage: CoverageRun[];
  /** Level 1 cellular data down to Level 5 satellite SOS, with what is actually known at each. */
  ladder: { level: number; medium: string; state: "available" | "intermittent" | "unavailable" | "unknown"; note: string }[];
  verdict: CommunicationsVerdict;
  unknownChannelKm: number;
  noCommunicationKm: number;
  explanation: string;
};

export type PlanInput = {
  path: readonly PathSegment[];
  assignments: readonly RoadRadioAssignment[];
  channels: readonly RadioChannel[];
  coverage?: readonly CoverageObservation[];
  companyAuthorizations?: readonly CompanyAuthorization[];
  unit?: UnitRadioCapability | null;
  province?: string | null;
  positionBySegment?: Record<string, LngLat>;
  /** Preferred over `positionBySegment` and `province` wherever a segment has it. */
  geographyBySegment?: Record<string, SegmentGeography>;
  at: Date;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Walk the path and build the communication plan: which channel governs each
 * stretch, whether the company may transmit on it, where the channel changes,
 * where the calls are, and where communication is simply not established.
 *
 * A stretch nobody has assigned a channel to is `unknownChannelKm`, never
 * "no radio needed". A stretch with a row saying there is no service is
 * `noCommunicationKm`. Those are different facts and the verdict treats them
 * differently.
 */
export function planCommunications(input: PlanInput): CommunicationsPlan {
  const channelByKey = new Map(input.channels.map(c => [c.channelKey, c]));
  const authByKey = new Map((input.companyAuthorizations ?? []).map(a => [a.channelKey, a]));
  const bySegment = new Map<string, RoadRadioAssignment[]>();
  for (const a of input.assignments) {
    const list = bySegment.get(a.segmentId);
    if (list) list.push(a); else bySegment.set(a.segmentId, [a]);
  }

  const zones: CommunicationZone[] = [];
  let km = 0;
  let unknownChannelKm = 0;

  for (const seg of input.path) {
    const resolved = resolveAssignment(bySegment.get(seg.segmentId) ?? [], input.at);
    const a = resolved.chosen;
    const channel = a ? channelByKey.get(a.channelKey) ?? null : null;
    const auth = a
      ? transmitAuthorization({
          channel,
          channelKey: a.channelKey,
          companyAuthorization: authByKey.get(a.channelKey) ?? null,
          unit: input.unit ?? null,
          position: input.positionBySegment?.[seg.segmentId] ?? null,
          province: input.province ?? null,
          geography: input.geographyBySegment?.[seg.segmentId] ?? null,
          at: input.at,
          postedOnThisRoad: a.authorityTier === "posted_sign",
        })
      : null;
    if (!a) unknownChannelKm += seg.lengthKm;

    const last = zones[zones.length - 1];
    /**
     * Two segments belong to one zone only when everything a driver would act
     * on is the same across both.
     *
     * Merging on channel and authority alone was wrong, and wrong in the
     * direction that matters: LAD-1 north of 53°30′ is authorized and LAD-1
     * south of it is not, from the same operator instruction. Those two
     * segments matched on channel and tier, so they merged, and the merged zone
     * kept the FIRST segment's verdict — reporting a whole stretch as
     * authorized when authorization ended halfway along it. The engine computed
     * the right answer per segment and the presentation threw half of it away.
     *
     * Calling convention is in the test for the same reason: a change of
     * must-call interval or loaded direction mid-zone is a change the driver
     * has to make, and a merge would have swallowed it.
     */
    const sameAnswer =
      last &&
      last.channelKey === (a?.channelKey ?? null) &&
      last.authorityTier === (a?.authorityTier ?? null) &&
      last.transmit === (auth?.status ?? "unknown") &&
      last.transmitReasons.join("|") === (auth?.reasons ?? ["No channel is assigned to this stretch of road"]).join("|") &&
      last.callDirectionLoaded === (a?.callDirectionLoaded ?? null) &&
      last.callIntervalKm === (a?.callIntervalKm ?? null) &&
      last.roadName === (a?.roadName ?? seg.label ?? null);
    if (sameAnswer) {
      last.toKm = round1(km + seg.lengthKm);
      last.segmentIds.push(seg.segmentId);
    } else {
      zones.push({
        fromKm: round1(km),
        toKm: round1(km + seg.lengthKm),
        segmentIds: [seg.segmentId],
        roadName: a?.roadName ?? seg.label ?? null,
        channelKey: a?.channelKey ?? null,
        alias: channel?.alias ?? null,
        rxMHz: channel?.rxMHz ?? null,
        txMHz: channel?.txMHz ?? null,
        authorityTier: a?.authorityTier ?? null,
        transmit: auth?.status ?? "unknown",
        transmitReasons: auth?.reasons ?? ["No channel is assigned to this stretch of road"],
        callDirectionLoaded: a?.callDirectionLoaded ?? null,
        callIntervalKm: a?.callIntervalKm ?? null,
        mustCallKm: a?.mustCallKm ? [...a.mustCallKm] : [],
        unknownReason: a ? null : "No channel assignment is on record for this segment — import the operator's road-use document or record the posted sign",
      });
    }
    km += seg.lengthKm;
  }

  const totalKm = round1(km);
  const changes = zones.slice(1).map((z, i) => ({
    atKm: z.fromKm,
    from: zones[i].channelKey,
    to: z.channelKey,
    note: z.channelKey ? `Change to ${z.channelKey}${z.alias ? ` (${z.alias})` : ""} — verify the posted sign` : "Channel becomes unknown — no assignment on record",
  }));
  const mustCall = zones.flatMap(z => z.mustCallKm.filter(k => k >= z.fromKm && k <= z.toKm).map(k => ({ atKm: k, channelKey: z.channelKey, roadName: z.roadName })));

  /* Coverage, by medium, in kilometres. Silence is `unknownKm`. */
  const coverage: CoverageRun[] = (["cellular", "satellite", "radio"] as const).map(medium => {
    // Accumulate raw and round once. Rounding each addition drifted, and a
    // dispatcher reading coverage kilometres that do not add up to the route's
    // own length has been given a reason to distrust the whole screen.
    const raw = { availableKm: 0, intermittentKm: 0, unavailableKm: 0, unknownKm: 0 };
    for (const seg of input.path) {
      const rows = (input.coverage ?? []).filter(c => c.segmentId === seg.segmentId && c.medium === medium && c.verificationStatus !== "superseded");
      rows.sort((a, b) => authorityRank(a.authorityTier) - authorityRank(b.authorityTier));
      const row = rows[0];
      if (!row) raw.unknownKm += seg.lengthKm;
      else if (row.state === "available") raw.availableKm += seg.lengthKm;
      else if (row.state === "intermittent") raw.intermittentKm += seg.lengthKm;
      else raw.unavailableKm += seg.lengthKm;
    }
    return { medium, availableKm: round1(raw.availableKm), intermittentKm: round1(raw.intermittentKm), unavailableKm: round1(raw.unavailableKm), unknownKm: round1(raw.unknownKm) };
  });

  /* Kilometres where every medium is affirmatively unavailable and no channel governs. */
  let noCommunicationKm = 0;
  for (const seg of input.path) {
    const rows = (input.coverage ?? []).filter(c => c.segmentId === seg.segmentId && c.verificationStatus !== "superseded");
    const media = new Set(rows.filter(r => r.state === "unavailable").map(r => r.medium));
    const hasChannel = !!resolveAssignment(bySegment.get(seg.segmentId) ?? [], input.at).chosen;
    if (media.has("cellular") && media.has("satellite") && !hasChannel) noCommunicationKm += seg.lengthKm;
  }
  noCommunicationKm = round1(noCommunicationKm);

  const ladderState = (m: "cellular" | "radio" | "satellite"): "available" | "intermittent" | "unavailable" | "unknown" => {
    const run = coverage.find(c => c.medium === m)!;
    if (run.unknownKm >= totalKm && totalKm > 0) return "unknown";
    if (run.unavailableKm > 0 || run.unknownKm > 0) return run.availableKm > 0 || run.intermittentKm > 0 ? "intermittent" : "unknown";
    if (run.intermittentKm > 0) return "intermittent";
    return run.availableKm > 0 ? "available" : "unknown";
  };
  const radioLadder: CommunicationsPlan["ladder"][number] = {
    level: 3,
    medium: "authorized road radio",
    state: zones.every(z => z.transmit === "authorized") && zones.length > 0 ? "available" : zones.some(z => z.transmit === "authorized") ? "intermittent" : "unknown",
    note: `${zones.filter(z => z.transmit === "authorized").length} of ${zones.length} zone(s) authorized to transmit`,
  };
  const ladder: CommunicationsPlan["ladder"] = [
    { level: 1, medium: "cellular data", state: ladderState("cellular"), note: `${coverage[0].availableKm} km available, ${coverage[0].unknownKm} km unknown` },
    { level: 2, medium: "cellular voice/SMS", state: ladderState("cellular"), note: "Assumed to follow cellular data coverage — LeaseOS holds no separate voice layer" },
    radioLadder,
    { level: 4, medium: "satellite messaging", state: ladderState("satellite"), note: `${coverage[1].availableKm} km available, ${coverage[1].unknownKm} km unknown` },
    { level: 5, medium: "satellite SOS", state: ladderState("satellite"), note: "Follows the satellite layer; the device's own SOS path is the manufacturer's" },
  ];

  const verdict: CommunicationsVerdict =
    noCommunicationKm > 0 ? "gaps"
    : unknownChannelKm > 0 || coverage.some(c => c.unknownKm > 0) || zones.some(z => z.transmit === "unknown") ? "unknown"
    : zones.every(z => z.transmit === "authorized") ? "covered"
    : "gaps";

  const explanation =
    verdict === "covered"
      ? `${totalKm} km, ${zones.length} radio zone(s), all authorized. ${mustCall.length} must-call point(s). Posted road signs govern.`
      : verdict === "gaps"
        ? `${totalKm} km with ${noCommunicationKm} km where no communication medium is available and no road channel governs. ${zones.filter(z => z.transmit !== "authorized").length} zone(s) are not authorized to transmit.`
        : `${totalKm} km, of which ${round1(unknownChannelKm)} km has no channel on record and ${coverage[0].unknownKm} km has no cellular coverage data. Unknown is not coverage — this route's communication plan is incomplete.`;

  return { totalKm, zones, changes, mustCall, coverage, ladder, verdict, unknownChannelKm: round1(unknownChannelKm), noCommunicationKm, explanation };
}

/* ------------------------------------------------------------------ */
/* What dispatch makes of it                                            */
/* ------------------------------------------------------------------ */

/**
 * Company policy, not a hard-coded rule. A city flatdeck operator does not
 * need a communication plan to leave the yard; a lone worker hauling
 * dangerous goods up a resource road at night does, and the same product has
 * to serve both without pretending one policy fits.
 */
export type CommunicationPolicy = {
  /** An incomplete plan stops dispatch rather than warning about it. */
  unknownPlanBlocks: boolean;
  /** Every zone must be authorized to transmit, not merely known. */
  requireTransmitAuthorization: boolean;
  /** Kilometres of established no-communication the company will accept. */
  toleratedNoCommunicationKm: number;
  /** A person working alone beyond cellular carries a satellite device, or does not go. */
  loneWorkerRequiresSatellite?: boolean;
};

/** What the truck is actually doing, for the rules that only apply sometimes. */
export type OperatingContext = { loneWorker?: boolean; dangerousGoods?: boolean; unitHasSatellite?: boolean | null };

export const ADVISORY_POLICY: CommunicationPolicy = { unknownPlanBlocks: false, requireTransmitAuthorization: false, toleratedNoCommunicationKm: Number.POSITIVE_INFINITY };

/** The plan, translated into B12's blocker vocabulary so dispatch reads one language. */
export function communicationBlockers(plan: CommunicationsPlan, policy: CommunicationPolicy, context: OperatingContext = {}): DispatchBlocker[] {
  const blockers: DispatchBlocker[] = [];
  if (plan.verdict === "unknown") {
    blockers.push({
      code: "communication_plan_unknown",
      label: `Communication plan incomplete — ${plan.unknownChannelKm} km of this route has no channel on record`,
      severity: policy.unknownPlanBlocks ? "blocking" : "unknown",
      subject: "route",
      overridable: true,
      overrideAuthority: "manager",
    });
  }
  if (plan.noCommunicationKm > policy.toleratedNoCommunicationKm) {
    blockers.push({
      code: "communication_gap_exceeds_policy",
      label: `${plan.noCommunicationKm} km with no established communication — the company tolerates ${policy.toleratedNoCommunicationKm} km`,
      severity: "blocking",
      subject: "route",
      overridable: true,
      overrideAuthority: "manager",
    });
  }
  if (policy.loneWorkerRequiresSatellite && context.loneWorker) {
    const cellular = plan.coverage.find(c => c.medium === "cellular")!;
    const beyondCellular = round1(cellular.unavailableKm + cellular.unknownKm);
    if (beyondCellular > 0) {
      // Unknown counts here on purpose. "We do not know whether there is
      // cellular for 40 km" is not a reason to send somebody out there alone
      // without a satellite device; it is the reason to insist on one.
      blockers.push(
        context.unitHasSatellite === true
          ? { code: "lone_worker_satellite_present", label: `${beyondCellular} km beyond established cellular — satellite device recorded on this unit`, severity: "review", subject: "route", overridable: true, overrideAuthority: "dispatcher" }
          : context.unitHasSatellite === false
            ? { code: "lone_worker_no_satellite", label: `Lone worker with ${beyondCellular} km beyond established cellular and no satellite device on this unit`, severity: "blocking", subject: "truck", overridable: true, overrideAuthority: "manager" }
            : { code: "lone_worker_satellite_unknown", label: `Lone worker with ${beyondCellular} km beyond established cellular; whether this unit carries a satellite device is not recorded`, severity: "unknown", subject: "truck", overridable: true, overrideAuthority: "manager" }
      );
    }
  }

  if (policy.requireTransmitAuthorization) {
    const bad = plan.zones.filter(z => z.transmit === "not_authorized");
    const unclear = plan.zones.filter(z => z.transmit === "unknown" || z.transmit === "requires_posted_channel");
    if (bad.length) {
      blockers.push({
        code: "radio_not_authorized",
        label: `Not authorized to transmit on ${bad.map(z => z.channelKey ?? "an unassigned channel").join(", ")}`,
        severity: "blocking",
        subject: "route",
        overridable: false,
      });
    }
    if (unclear.length) {
      blockers.push({
        code: "radio_authorization_unknown",
        label: `Transmit authorization not established for ${unclear.length} zone(s)`,
        severity: "unknown",
        subject: "route",
        overridable: true,
        overrideAuthority: "manager",
      });
    }
  }
  return blockers;
}

/**
 * A stable digest of what the plan stood on, for the route approval's
 * dependency fingerprint. When a road operator changes a channel for a week,
 * every approved route over that segment goes stale by arithmetic instead of
 * by somebody remembering.
 */
export function communicationsFingerprintParts(plan: CommunicationsPlan): unknown {
  return plan.zones.map(z => ({ seg: [...z.segmentIds].sort(), ch: z.channelKey, tier: z.authorityTier, tx: z.transmit })).sort((a, b) => (a.seg[0] ?? "").localeCompare(b.seg[0] ?? ""));
}
