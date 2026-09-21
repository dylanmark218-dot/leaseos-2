/**
 * v22.14 — Legal land in both directions, entrances as records, and the
 * imported road fabric as evaluator input.
 *
 * Pure: no database, no network. Three things the fabrics of v22.13 can
 * answer that they could not before —
 *   • a GPS fix read back as a legal land description,
 *   • an entrance's confidence as a count of what has actually reached it,
 *   • an imported road segment expressed as attributes the four-axis
 *     evaluator already understands, where an absent attribute stays
 *     absent so the evaluator reads UNKNOWN rather than pass.
 */
import type { RequiredCheck } from "./routingCompiler";
import type { DataConfidence, SegmentAttribute } from "./routeEvaluation";
import { distanceToPathMetres, pointInRing, type LngLat, type SurfaceKind } from "./geoImport";

/* ---- GPS → legal land ---- */

export type ParcelShape = { pid: string; descriptor: string; identity: string; meridian: number; rangeNumber: number; township: number; sectionNumber: number; quarterSection: string | null; legalSubdivision: number | null; roadAllowance: string | null; ring: LngLat[]; centroid: LngLat };
export type ReverseFix =
  | { outcome: "located"; parcel: ParcelShape; metresFromCentroid: number; onRoadAllowance: boolean; reasons: string[] }
  | { outcome: "outside_imported_grid"; candidates: number; reasons: string[] };

/**
 * Which parcel is this position in? Land wins over a road allowance when the
 * rings overlap at their shared edge, because a truck on a road allowance is
 * still *at* the adjoining land — and the answer says which it was.
 */
export function reverseLookup(position: LngLat, parcels: readonly ParcelShape[]): ReverseFix {
  const hits = parcels.filter(p => pointInRing(position, p.ring));
  if (!hits.length) return { outcome: "outside_imported_grid", candidates: parcels.length, reasons: [parcels.length ? `Position is inside none of the ${parcels.length} imported parcel(s) near it — the grid covering this position is not imported` : "No ATS grid is imported near this position"] };
  const land = hits.filter(p => !p.roadAllowance || p.roadAllowance.trim() === "");
  const parcel = land[0] ?? hits[0]!;
  const onRoadAllowance = !land.length;
  const metres = Math.round(haversine(position, parcel.centroid));
  const reasons = [`Position is inside ${parcel.descriptor}`];
  if (onRoadAllowance) reasons.push(`The position is on a road allowance (${parcel.roadAllowance}), not on the land it adjoins`);
  if (hits.length > 1) reasons.push(`${hits.length} imported parcels contain this position; the land parcel was taken`);
  return { outcome: "located", parcel, metresFromCentroid: metres, onRoadAllowance, reasons };
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---- an entrance's confidence ---- */

export type AccessConfirmation = { outcome: "reached" | "could_not_reach" | "reached_with_difficulty"; configurationFingerprint: string | null; operatorId: number | null; observedAt: Date };
export type AccessConfidence = { level: "confirmed" | "probable" | "reported" | "proposed" | "disputed"; reached: number; failed: number; difficult: number; distinctOperators: number; lastReachedAt: Date | null; matchingConfiguration: "exact" | "similar" | "none"; reasons: string[] };

/**
 * What has actually reached this entrance, counted. A confirmation is
 * evidence, not a verdict: a single passage never becomes "confirmed", and a
 * failure against successes is a dispute a person settles.
 */
export function accessConfidence(args: { status: "proposed" | "confirmed" | "rejected" | "superseded"; confirmations: readonly AccessConfirmation[]; configurationFingerprint?: string | null }): AccessConfidence {
  const reached = args.confirmations.filter(c => c.outcome === "reached");
  const difficult = args.confirmations.filter(c => c.outcome === "reached_with_difficulty");
  const failed = args.confirmations.filter(c => c.outcome === "could_not_reach");
  const operators = new Set(args.confirmations.map(c => c.operatorId).filter(o => o != null));
  const lastReached = [...reached, ...difficult].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0]?.observedAt ?? null;
  const reasons: string[] = [];
  let matching: AccessConfidence["matchingConfiguration"] = "none";
  if (args.configurationFingerprint) {
    const successes = [...reached, ...difficult];
    if (successes.some(c => c.configurationFingerprint === args.configurationFingerprint)) { matching = "exact"; reasons.push(`This exact configuration has reached it (${args.configurationFingerprint})`); }
    else if (successes.some(c => c.configurationFingerprint)) { matching = "similar"; reasons.push("Other configurations have reached it; this one has not — a different truck's passage does not prove this one's"); }
    else reasons.push("No configuration recorded on any passage");
  }
  let level: AccessConfidence["level"];
  if (failed.length && failed.length >= reached.length) { level = "disputed"; reasons.unshift(`${failed.length} report(s) of not reaching it against ${reached.length} of reaching it — a person settles this`); }
  else if (args.status === "confirmed" && reached.length >= 3 && operators.size >= 2) { level = "confirmed"; reasons.unshift(`Confirmed by a person and reached ${reached.length} time(s) by ${operators.size} operators`); }
  else if (args.status === "confirmed") { level = "probable"; reasons.unshift(`Confirmed by a person; reached ${reached.length} time(s) by ${operators.size} operator(s) — more passages would raise it`); }
  else if (reached.length + difficult.length > 0) { level = "reported"; reasons.unshift(`Reached ${reached.length + difficult.length} time(s) but not yet confirmed by a person`); }
  else { level = "proposed"; reasons.unshift("Derived from the grid and the road fabric; nothing has reached it yet"); }
  if (difficult.length) reasons.push(`${difficult.length} passage(s) reported difficulty`);
  return { level, reached: reached.length, failed: failed.length, difficult: difficult.length, distinctOperators: operators.size, lastReachedAt: lastReached, matchingConfiguration: matching, reasons };
}

/** A configuration fingerprint: what was driven, not who drove it. */
export function configurationFingerprint(v: { grossWeightKg: number; heightM: number; widthM: number; lengthM: number; axleGroups: number; trailerKind?: string | null }): string {
  return [v.trailerKind?.toUpperCase().replace(/[^A-Z0-9]/g, "") || "UNIT", `${v.axleGroups}AX`, `${(v.grossWeightKg / 1000).toFixed(1)}T`, `${v.heightM.toFixed(2)}H`, `${v.widthM.toFixed(2)}W`, `${v.lengthM.toFixed(1)}L`].join("|");
}

/* ---- imported roads → evaluator attributes ---- */

export type ImportedRoad = { objectId: number; name: string | null; highwayNumber: string | null; roadClass: string | null; featureTypeLabel: string | null; surfaceKind: SurfaceKind; lanes: number | null; lengthMetres: number; path: LngLat[]; sourceKey: string; sourceLayer: string; retrievedAt: Date; geometrySource: string | null; /** The provider's own stable id where it is not the numeric objectId (OSM: `way/1234567`). */ sourceFeatureId?: string | null };

/** Surfaces a loaded commercial unit may travel, and what each implies operationally. */
const SURFACE_SUITABILITY: Record<SurfaceKind, { textValue: string; operational: "suitable" | "review" | "unsuitable" }> = {
  paved: { textValue: "paved", operational: "suitable" },
  gravel: { textValue: "gravel", operational: "suitable" },
  dry_weather: { textValue: "dry_weather", operational: "review" },
  winter: { textValue: "winter_road", operational: "review" },
  ramp: { textValue: "interchange_ramp", operational: "suitable" },
  driveway: { textValue: "driveway", operational: "unsuitable" },
  ferry: { textValue: "ferry_crossing", operational: "unsuitable" },
  ford: { textValue: "ford", operational: "unsuitable" },
  other: { textValue: "other", operational: "review" },
  unknown: { textValue: "unknown", operational: "review" },
};

/**
 * One imported road as evaluator input.
 *
 * The province's road layer states a surface and a class. It states **no**
 * weight, axle, clearance, width or length limit — so this emits **no
 * attribute** for those checks, and the evaluator reads them as UNKNOWN.
 * A verified restriction row, recorded separately, is what turns any of them
 * into a pass. The map's silence is never a permission.
 */
/* ------------------------------------------------------------------ */
/* Road sources — what each one may claim, and under whose name         */
/* ------------------------------------------------------------------ */

/**
 * A road source and the standing its data has.
 *
 * This exists because `roadAsSegment` used to stamp `confidence: "authority_confirmed"`
 * unconditionally and mint `AB-ACCESS-<objectId>` for every caller. That was correct while the only
 * source was Alberta's own access-road layer, and it becomes wrong the moment a second source
 * arrives: an OpenStreetMap `surface=gravel` is a contributor's observation, and routed through
 * that function it would reach the evaluator indistinguishable from a provincial statement — which
 * is the one thing that turns REVIEW into PASS.
 *
 * So the standing lives with the source, not with the function that formats it.
 */
/**
 * How a source's roads are joined into a graph — a property of the data, not a preference.
 *
 * `shared_node_ids`: the source gives every vertex an id, so two ways connect exactly when they
 * share one. Snapping such a source would be worse than pointless: a highway and the overpass above
 * it cross at identical coordinates, and joining them invents a turn that does not exist on the
 * ground. Alberta's extract leaves only 0.1% of ways meeting nothing, so there is nothing to close.
 *
 * `coordinate_snap`: the source gives coordinates and no vertex identity, so a junction can only be
 * recognised by position. Two surveys of the same intersection disagree by a metre or two, and
 * without a tolerance every one of those becomes a false dead end.
 *
 * Getting this backwards fails in both directions and neither is loud. A coordinate source through
 * exact matching produces a graph of disconnected fragments; an id-bearing source through snapping
 * produces a graph with junctions nobody can drive.
 */
export type RoadTopologyStrategy = "shared_node_ids" | "coordinate_snap";

export type RoadSourceStanding = {
  /** Namespace for segment identity. Two sources must never mint the same segment id. */
  idPrefix: string;
  /** How this source's roads join. Null where the source is unknown — see `standingFor`. */
  topology: RoadTopologyStrategy | null;
  /**
   * What this source's claims are worth. `unverified` is the honest default for open map data: it
   * may be perfectly accurate and it is still nobody's legal statement.
   */
  confidence: DataConfidence;
  /**
   * The jurisdiction the source establishes, or null when it establishes none. Null stays null —
   * a caller's location is not evidence of whose rules apply.
   */
  jurisdiction: string | null;
};

export const ROAD_SOURCE_STANDING: Record<string, RoadSourceStanding> = {
  /*
   * Alberta's own layer, and it keeps its historical `AB-ACCESS-` prefix deliberately. Segment ids
   * are referenced by stored route evidence, fingerprints and decisions; re-minting them would
   * orphan every route already approved against them, to fix an identity that was never ambiguous
   * while this was the only source.
   */
  ats_road_allowance: { idPrefix: "AB-ACCESS-", confidence: "authority_confirmed", jurisdiction: "CA-AB", topology: "coordinate_snap" },
  /** Geofabrik's Alberta extract: excellent topology, and not an authority on anything. */
  geofabrik_osm_ab: { idPrefix: "OSM-AB-", confidence: "unverified", jurisdiction: "CA-AB", topology: "shared_node_ids" },
  /**
   * Geofabrik's British Columbia extract. Same standing, different province — and the jurisdiction
   * is the whole reason this registry exists rather than a constant: a BC road is governed by BC,
   * and the evaluator has to be told so by the source rather than by whoever called it.
   *
   * BC's numbers are worse than Alberta's where it counts. 490,986 vehicle ways carry 108
   * `maxweight` tags, 5 `maxaxleload`, 14 `maxlength` — and **zero** `maxwidth`, in a province
   * whose Forest Service Roads are exactly where a wide load gets stopped. 10,157 bridges are
   * mapped and about one percent of them state a capacity.
   */
  geofabrik_osm_bc: { idPrefix: "OSM-BC-", confidence: "unverified", jurisdiction: "CA-BC", topology: "shared_node_ids" },

  /**
   * Geofabrik's Saskatchewan extract — the sparsest of the three, and the one that settles the
   * argument. 263,951 vehicle ways carry **nine** `maxweight` tags and **zero** `maxaxleload`,
   * `maxwidth` and `maxlength`. `hgv` appears 121 times against Alberta's 14,934, and `hazmat`
   * exactly once in the province.
   *
   * Surface is the opposite story at 83% coverage, which is the shape of all three: OSM is good at
   * what a road IS and silent on what may use it.
   */
  geofabrik_osm_sk: { idPrefix: "OSM-SK-", confidence: "unverified", jurisdiction: "CA-SK", topology: "shared_node_ids" },
};

/**
 * A source nobody has registered claims nothing.
 *
 * Not a permissive default with a warning attached: an unregistered source reaching the evaluator
 * as `unverified` with no jurisdiction is a route that reads REVIEW, which is the correct answer to
 * "we do not know what this data is worth."
 */
/**
 * What an edge built before `0164` reports. Those rows are backfilled with their real source, so
 * this is for an edge that somehow has none: it resolves to unverified with no jurisdiction, which
 * reads REVIEW rather than silently borrowing Alberta's standing.
 */
export const UNREGISTERED_SOURCE = "unregistered_road_source";

export function standingFor(sourceKey: string): RoadSourceStanding {
  return ROAD_SOURCE_STANDING[sourceKey]
    // `topology: null` rather than a default. Both strategies are wrong half the time, so an
    // unregistered source has to be answered for rather than assumed into one of them.
    ?? { idPrefix: `${sourceKey}:`, confidence: "unverified", jurisdiction: null, topology: null };
}

export function roadAsSegment(road: ImportedRoad): { segmentId: string; label: string; lengthKm: number; attributes: SegmentAttribute[]; silentChecks: RequiredCheck[] } {
  const standing = standingFor(road.sourceKey);
  const s = SURFACE_SUITABILITY[road.surfaceKind];
  const retrieved = road.retrievedAt.toISOString();
  const attributes: SegmentAttribute[] = [{
    check: "surface_condition",
    textValue: s.textValue,
    jurisdiction: standing.jurisdiction,
    source: `${road.sourceKey}: ${road.sourceLayer}`,
    sourceVersion: road.geometrySource ?? null,
    /*
     * From the source, never from this function. Alberta states the surface on its own layer, so
     * that is authority-confirmed and nothing more than the surface. An OSM contributor stating the
     * same word is unverified — accurate, very possibly, and still nobody's legal statement.
     */
    confidence: standing.confidence,
    verifiedAt: retrieved,
  }];
  const silentChecks: RequiredCheck[] = ["road_weight_restriction", "axle_group_limit", "bridge_capacity", "bridge_axle_limit", "overhead_clearance", "bridge_clearance", "width_restriction", "length_restriction", "seasonal_closure", "road_ban_level"];
  return {
    // Namespaced by source: an ATS OBJECTID and an OSM way id may be the same number.
    segmentId: `${standing.idPrefix}${road.sourceFeatureId ?? road.objectId}`,
    label: road.name ?? road.highwayNumber ?? road.featureTypeLabel ?? `Access road ${road.objectId}`,
    lengthKm: Math.round(road.lengthMetres) / 1000,
    attributes,
    silentChecks,
  };
}

/** The ordered roads a straight corridor between two points touches, nearest first, within a width. */
export function corridorSegments(from: LngLat, to: LngLat, roads: readonly ImportedRoad[], widthMetres = 1_500): { road: ImportedRoad; metresFromCorridor: number }[] {
  const samples: LngLat[] = [];
  const steps = Math.max(2, Math.min(40, Math.ceil(haversine(from, to) / 2_000)));
  for (let i = 0; i <= steps; i++) samples.push([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);
  const scored = roads.map(road => {
    let nearest = Number.POSITIVE_INFINITY;
    for (const s of samples) { const d = distanceToPathMetres(s, road.path).metres; if (d < nearest) nearest = d; }
    return { road, metresFromCorridor: Math.round(nearest) };
  }).filter(x => x.metresFromCorridor <= widthMetres);
  return scored.sort((a, b) => a.metresFromCorridor - b.metresFromCorridor);
}
