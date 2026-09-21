/**
 * M2 — an OpenStreetMap way becomes a LeaseOS road edge, or says why it did not.
 *
 * This is the conversion and nothing else: no database, no file reading, no bulk loading. Given one
 * way's tags and geometry it returns an edge or a refusal, which is the part worth testing against
 * real tag combinations rather than invented ones.
 *
 * Three rules carried from `0164` and the mapping spec, and the whole file is shaped by them:
 *
 *   **A tag is not a limit.** Alberta's extract has 24 `maxweight` tags across 512,979 vehicle
 *   ways; British Columbia has 108, and **zero** `maxwidth`. So absence is the normal case, and
 *   absence is left absent — no nullable column, no zero, no "unlimited". The checks a road cannot
 *   answer stay in `silentChecks`, where the evaluator reads them as UNKNOWN.
 *
 *   **Nothing here is authority-confirmed.** The standing comes from the source registry, and
 *   `geofabrik_osm_*` is `unverified`. Even where OSM *does* state a weight, it is a contributor's
 *   transcription of a sign, and a transcription of a sign is not the sign.
 *
 *   **Identity is namespaced.** `OSM-AB-way/1234567` and an Alberta ATS `AB-ACCESS-1234567` are
 *   different roads that share an integer.
 *
 * ## Validated against the real extract, not only fixtures
 *
 * Run over all 734,600 `highway` ways in `alberta-260910.osm.pbf`:
 *
 * ```
 * imported              508,807     refused, not vehicle   223,334
 * refused, access=no      2,240     refused, unrecognised      219
 * ```
 *
 * The 219 it did not recognise were `rest_area` (105), `busway` (58), `services` (41), `future`,
 * `escape`, `no` — so the class list is effectively complete for Alberta, and the six it misses are
 * refused **by name** rather than guessed at. `rest_area` and `services` are places a truck does go
 * and are worth reconsidering as destinations; they are not through-routes, which is why they are
 * out for now and visible in the skipped report rather than silently absent.
 *
 * The advisory volume it would raise: 14,768 `hgv`, **13,511 `access=private`**, 7,775 bridges,
 * 1,904 `hazmat`, 928 `maxheight`, 26 fords, 23 `maxweight`, 4 `maxaxleload`. That private-access
 * count is the one to plan for — 2.7% of Alberta's imported roads are somebody's to grant, which in
 * oilfield work is the lease approach itself.
 */

import type { LngLat, SurfaceKind } from "./geoImport";

/* ------------------------------------------------------------------ */
/* What counts as a road a truck could be on                           */
/* ------------------------------------------------------------------ */

/**
 * Highway classes that carry motor vehicles.
 *
 * `track` is in deliberately: in Alberta and BC a great many lease approaches, Forest Service Roads
 * and resource roads are tagged `highway=track`, and excluding them would drop exactly the roads
 * this product exists to route on. `service` is in for the same reason — facility yards and
 * wellsite approaches are service roads.
 */
export const VEHICLE_HIGHWAY_CLASSES: readonly string[] = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
  "living_street", "service", "track", "road",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
];

/** Classes that are definitely not for a truck, listed so the refusal can name which. */
export const NON_VEHICLE_HIGHWAY_CLASSES: readonly string[] = [
  "footway", "cycleway", "path", "pedestrian", "steps", "bridleway", "corridor", "via_ferrata",
  "elevator", "platform", "raceway", "proposed", "construction",
];

export type OsmWay = {
  /** The way's own id. `way/1234567` is how OSM refers to it and how the segment id is built. */
  id: number;
  tags: Readonly<Record<string, string>>;
  geometry: readonly LngLat[];
};

export type ImportRefusal = {
  imported: false;
  /** Named so a coverage report can say what was skipped and why, rather than a count. */
  reason: "not_a_highway" | "not_vehicle_accessible" | "geometry_too_short" | "access_forbidden";
  detail: string;
};

export type ImportedEdge = {
  imported: true;
  segmentId: string;
  sourceFeatureId: string;
  label: string;
  surfaceKind: SurfaceKind;
  geometry: readonly LngLat[];
  /** `both` unless OSM states otherwise; a missing `oneway` is two-way, which is OSM's own default. */
  direction: "both" | "forward" | "backward";
  /**
   * Tags kept verbatim. Not parsed into limits here — the evidence compiler decides what a tag is
   * worth, and it can only do that if the tag survives the import unaltered.
   */
  rawTags: Readonly<Record<string, string>>;
  /**
   * Checks this road cannot answer, which for OSM is nearly all of them. Handed to the evaluator so
   * they read UNKNOWN rather than being absent from the conversation.
   */
  silentChecks: readonly string[];
  /** Things worth a person's attention that OSM *does* state. Never a clearance. */
  advisories: readonly string[];
};

export type ImportResult = ImportedEdge | ImportRefusal;

/* ------------------------------------------------------------------ */
/* Surface                                                             */
/* ------------------------------------------------------------------ */

const PAVED = new Set(["asphalt", "paved", "concrete", "chipseal", "concrete:plates", "paving_stones"]);
const GRAVEL = new Set(["gravel", "compacted", "fine_gravel", "pebblestone", "unpaved", "crushed_limestone"]);
const DRY_WEATHER = new Set(["dirt", "earth", "ground", "mud", "sand", "grass", "clay"]);

/**
 * OSM's surface vocabulary onto ours.
 *
 * An untagged surface is **not** assumed paved. On a Range Road or a Forest Service Road that guess
 * would be wrong most of the time and wrong in the expensive direction, so an untagged road is
 * `dry_weather`, which the suitability table already reads as `review`.
 */
export function surfaceFor(tags: Readonly<Record<string, string>>): SurfaceKind {
  if (tags.ford && tags.ford !== "no") return "ford";
  if (tags.highway === "ferry" || tags.route === "ferry") return "ferry";
  if (/_link$/.test(tags.highway ?? "")) return "ramp";
  if (tags.highway === "driveway" || tags.service === "driveway") return "driveway";
  if (tags.winter_road === "yes" || tags.seasonal === "winter") return "winter";

  const s = (tags.surface ?? "").toLowerCase();
  if (PAVED.has(s)) return "paved";
  if (GRAVEL.has(s)) return "gravel";
  if (DRY_WEATHER.has(s)) return "dry_weather";

  // `tracktype` is a firmness grade, useful when `surface` is absent. grade1 is solid; grade4-5 are
  // soft enough that a loaded unit is a judgement call, not a given.
  const grade = tags.tracktype;
  if (grade === "grade1") return "gravel";
  if (grade === "grade2" || grade === "grade3") return "dry_weather";
  if (grade === "grade4" || grade === "grade5") return "dry_weather";

  return "dry_weather";
}

/* ------------------------------------------------------------------ */
/* The checks OSM cannot answer                                        */
/* ------------------------------------------------------------------ */

/**
 * Every legal check a road might be asked, and what it takes to answer it.
 *
 * A check is silent unless the road carries **verified authority evidence** for it — which OSM
 * never does. The tag column exists so a coverage report can say "OSM states a weight here and it
 * still does not clear the road", which is a different and more useful statement than "unknown".
 */
export const LEGAL_CHECKS: readonly { check: string; osmTag: string | null }[] = [
  { check: "road_weight_restriction", osmTag: "maxweight" },
  { check: "axle_group_limit", osmTag: "maxaxleload" },
  { check: "bridge_capacity", osmTag: null },
  { check: "bridge_axle_limit", osmTag: null },
  { check: "overhead_clearance", osmTag: "maxheight" },
  { check: "bridge_clearance", osmTag: null },
  { check: "width_restriction", osmTag: "maxwidth" },
  { check: "length_restriction", osmTag: "maxlength" },
  { check: "seasonal_road_ban", osmTag: null },
  { check: "dangerous_goods_route", osmTag: "hazmat" },
  { check: "truck_route_designation", osmTag: "hgv" },
];

/**
 * An OSM tag that states a limit becomes an **advisory**, never an answer.
 *
 * The distinction is the point. "Nobody has told us the weight limit here" and "OSM says 10 t and
 * nobody has verified it" are different situations for a dispatcher: the second is a reason to look
 * before sending a 52-tonne unit, and neither is permission to send one.
 */
function advisoriesFrom(tags: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const { check, osmTag } of LEGAL_CHECKS) {
    if (osmTag && tags[osmTag]) {
      out.push(`${check}: OpenStreetMap states ${osmTag}=${tags[osmTag]} — unverified, treat as a reason to check rather than a limit to rely on`);
    }
  }
  if (tags.ford && tags.ford !== "no") out.push("ford: this way crosses water at grade; depth and season are not stated");
  if (tags.bridge && tags.bridge !== "no") out.push("bridge: a structure is here; OpenStreetMap states no capacity for it");
  if (tags.access === "private" || tags.access === "permissive") out.push(`access=${tags.access}: permission to use this road is somebody's to give and is not recorded here`);
  return out;
}

/* ------------------------------------------------------------------ */
/* The conversion                                                      */
/* ------------------------------------------------------------------ */

export function importOsmWay(way: OsmWay, source: { sourceKey: string; idPrefix: string }): ImportResult {
  const t = way.tags;
  const hw = t.highway;

  if (!hw) return { imported: false, reason: "not_a_highway", detail: "no highway tag" };
  if (NON_VEHICLE_HIGHWAY_CLASSES.includes(hw)) {
    return { imported: false, reason: "not_vehicle_accessible", detail: `highway=${hw} does not carry motor vehicles` };
  }
  if (!VEHICLE_HIGHWAY_CLASSES.includes(hw)) {
    // An unrecognised class is refused by name rather than guessed at, so a new OSM value shows up
    // in the skipped report instead of silently becoming a road or silently vanishing.
    return { imported: false, reason: "not_vehicle_accessible", detail: `highway=${hw} is not a class this importer recognises` };
  }
  if (t.access === "no" || t.motor_vehicle === "no") {
    return { imported: false, reason: "access_forbidden", detail: `${t.access === "no" ? "access" : "motor_vehicle"}=no` };
  }
  if (way.geometry.length < 2) {
    return { imported: false, reason: "geometry_too_short", detail: `${way.geometry.length} coordinate(s)` };
  }

  const sourceFeatureId = `way/${way.id}`;
  return {
    imported: true,
    segmentId: `${source.idPrefix}${sourceFeatureId}`,
    sourceFeatureId,
    label: t.name ?? t.ref ?? `${hw} ${sourceFeatureId}`,
    surfaceKind: surfaceFor(t),
    geometry: way.geometry,
    direction: t.oneway === "yes" || t.oneway === "1" ? "forward"
      : t.oneway === "-1" || t.oneway === "reverse" ? "backward"
      : "both",
    rawTags: t,
    // Every legal check, always. OSM answers none of them, including the ones it has a tag for.
    silentChecks: LEGAL_CHECKS.map(c => c.check),
    advisories: advisoriesFrom(t),
  };
}
