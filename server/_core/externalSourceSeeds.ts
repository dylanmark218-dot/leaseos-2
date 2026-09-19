/**
 * Verified external source records.
 *
 * This is the research turned into data the runtime actually consumes. Every
 * field traces to a publisher page checked on the retrieval date below; nothing
 * here is inferred. Where a publisher did not state something, the field is
 * null or `"unknown"` and the licence gate treats it as a refusal rather than a
 * permission.
 *
 * **Eight sources are verified. Three are not.** AER ST37, AER ST102 and
 * Alberta 511 are not published under a standard open licence — they are
 * governed by their own terms of use, and neither commercial fleet use nor
 * offline redistribution to field tablets could be confirmed. They stay
 * `unverified`, which under `evaluateSourceUsage` means inspection only.
 *
 * The research summary said "nine of eleven are clean" while separately
 * flagging three as unresolved. Eleven minus three is eight. Seeding nine would
 * have marked one blocked source usable, so the count is corrected here and a
 * test holds it.
 */

import type { ExternalDataSource } from "./externalDataRegistry";

/** Every field below was checked against the publisher on this date. */
export const SOURCE_RETRIEVAL_DATE = new Date("2026-09-09T00:00:00Z");

const OGL_CANADA_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – Canada";
const OGL_ALBERTA_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – Alberta";
const OGL_BC_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – British Columbia";

/**
 * Sources whose licence, attribution, commercial-use and redistribution terms
 * were confirmed against the publisher.
 */
export const VERIFIED_DATA_SOURCES: readonly ExternalDataSource[] = [
  {
    sourceKey: "osm",
    displayName: "OpenStreetMap",
    authority: "OpenStreetMap Foundation",
    category: "base_map",
    jurisdiction: "global",
    licenceName: "Open Database License (ODbL) v1.0",
    licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attributionRequired: true,
    attributionText: "© OpenStreetMap contributors",
    // The one copyleft in the set. Share-alike attaches to a Derivative
    // Database — which is what an offline extract bundled to a tablet is. The
    // rendered map itself is a Produced Work and needs attribution only.
    shareAlikeObligation: true,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "nrn",
    displayName: "National Road Network (NRN) — Alberta",
    authority: "Natural Resources Canada / Statistics Canada",
    category: "road_network",
    jurisdiction: "CA-AB",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: OGL_CANADA_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Publisher states maintenance is aimed at "at least one update a year".
    updateIntervalHours: 8760,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "canvec",
    displayName: "CanVec",
    authority: "Natural Resources Canada",
    category: "road_network",
    jurisdiction: "CA",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: OGL_CANADA_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 1440,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "ats",
    displayName: "Alberta Township System v4.1 Polygons",
    authority: "Government of Alberta — Provincial Geospatial Centre",
    category: "land_grid",
    jurisdiction: "CA-AB",
    licenceName: "Open Government Licence – Alberta",
    licenceUrl: "https://open.alberta.ca/licence",
    attributionRequired: true,
    attributionText: OGL_ALBERTA_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Base survey grid; publisher states no update interval.
    updateIntervalHours: null,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "ats_road_allowance",
    displayName: "ATS Section with Road Allowance",
    authority: "Government of Alberta — Provincial Geospatial Centre",
    category: "land_grid",
    jurisdiction: "CA-AB",
    licenceName: "Open Government Licence – Alberta",
    licenceUrl: "https://open.alberta.ca/licence",
    attributionRequired: true,
    attributionText: OGL_ALBERTA_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: null,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "drivebc_open511",
    displayName: "Open511-DriveBC API",
    authority: "Government of British Columbia — Ministry of Transportation",
    category: "road_conditions",
    jurisdiction: "CA-BC",
    licenceName: "Open Government Licence – British Columbia",
    licenceUrl:
      "https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc",
    attributionRequired: true,
    attributionText: OGL_BC_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    // No numeric limit published. Null means the planner fetches once rather
    // than assuming a limit that was never stated.
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 1,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "msc_geomet",
    displayName: "MSC GeoMet",
    authority: "Environment and Climate Change Canada — Meteorological Service",
    category: "weather",
    jurisdiction: "CA",
    licenceName: "ECCC Data Server End-use Licence",
    licenceUrl: "https://eccc-msc.github.io/open-data/licence/readme_en/",
    attributionRequired: true,
    attributionText: "Contains data provided by Environment and Climate Change Canada",
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    // Soft guidance rather than a hard throttle: roughly 1 request/second.
    rateLimitCalls: 86400,
    rateLimitWindowSeconds: 86400,
    updateIntervalHours: 1,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    sourceKey: "cwfis",
    displayName: "Canadian Wildland Fire Information System",
    authority: "Natural Resources Canada — Canadian Forest Service",
    category: "wildfire",
    jurisdiction: "CA",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: OGL_CANADA_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: SOURCE_RETRIEVAL_DATE,
    status: "verified",
  },
];

/**
 * Sources that could NOT be verified. Blocked for everything but inspection.
 *
 * All three carry `attributionText: null` deliberately as a second barrier: even
 * if someone flipped `status` to verified without doing the legal work, the
 * attribution check would still refuse operational use.
 */
export const UNVERIFIED_DATA_SOURCES: readonly ExternalDataSource[] = [
  {
    sourceKey: "aer_st37",
    displayName: "AER ST37: List of Wells in Alberta",
    authority: "Alberta Energy Regulator",
    category: "oilfield_assets",
    jurisdiction: "CA-AB",
    // Not an open licence. AER Terms of Use govern.
    licenceName: "AER Terms of Use / Copyright and Disclaimer",
    licenceUrl: "https://www.aer.ca/copyright-and-disclaimer",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 720,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "aer_st102",
    displayName: "AER ST102: Facility List",
    authority: "Alberta Energy Regulator",
    category: "oilfield_assets",
    jurisdiction: "CA-AB",
    licenceName: "AER Terms of Use / Copyright and Disclaimer",
    licenceUrl: "https://www.aer.ca/copyright-and-disclaimer",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 720,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "ab511",
    displayName: "511 Alberta Developer API",
    authority: "Government of Alberta — Transportation and Economic Corridors",
    category: "road_conditions",
    jurisdiction: "CA-AB",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    // Verified verbatim on the developer page even though the licence is not:
    // "Throttling is enabled. Ten calls every 60 seconds."
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * The directory stores a facility's WM approval number and links out to AER for its status,
     * because a copy of a regulator's record that nobody refreshes is worse than no copy: it looks
     * current. Seeded so a written answer has somewhere to land — P6.8, request drafted in
     * `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     */
    sourceKey: "aer_st107",
    displayName: "AER ST107 — Well and Facility Licence Status",
    authority: "Alberta Energy Regulator",
    category: "oilfield_assets",
    jurisdiction: "CA-AB",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * Believed to be published under a standard unrestricted use licence. Believed is not recorded:
     * until somebody confirms it in writing this stays unknown, because "we understood it was open"
     * is not a licence. P6.9.
     */
    sourceKey: "sk_iris",
    displayName: "Saskatchewan IRIS — Well and Facility Data",
    authority: "Government of Saskatchewan — Ministry of Energy and Resources",
    category: "oilfield_assets",
    jurisdiction: "CA-SK",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /** Same question, second province. P6.9. */
    sourceKey: "mb_petroleum",
    displayName: "Manitoba Petroleum Branch GIS",
    authority: "Government of Manitoba — Petroleum Branch",
    category: "oilfield_assets",
    jurisdiction: "CA-MB",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "ised_b1_western",
    displayName: "ISED B1: Western and Northern Canada Mobile-Only Frequencies",
    authority: "Innovation, Science and Economic Development Canada",
    category: "spectrum",
    jurisdiction: "CA",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    // The appendix is published openly; redistributing it to field tablets as
    // an operational channel bank is a different question and was not confirmed.
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 720,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "ised_bc_rr",
    displayName: "ISED: British Columbia Resource Road Channels (RR and LD)",
    authority: "Innovation, Science and Economic Development Canada",
    category: "spectrum",
    jurisdiction: "CA-BC",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 720,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "ised_cb_grs",
    displayName: "ISED RSS-236: General Radio Service (CB), 26.960-27.410 MHz",
    authority: "Innovation, Science and Economic Development Canada",
    category: "spectrum",
    jurisdiction: "CA",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 8760,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "ised_sms",
    displayName: "ISED Spectrum Management System: downloadable licence data",
    authority: "Innovation, Science and Economic Development Canada",
    category: "spectrum",
    jurisdiction: "CA",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 168,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "bc_resource_road_maps",
    displayName: "BC Resource Road Radio Channel Maps",
    authority: "Province of British Columbia",
    category: "spectrum",
    jurisdiction: "CA-BC",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 168,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "statcan_boundaries",
    displayName: "Statistics Canada — Provincial and Territorial Boundary File",
    authority: "Statistics Canada",
    category: "land_grid",
    jurisdiction: "CA",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    // The layer that would let a coordinate establish a province. Its licence
    // has not been reviewed here, so it is inspection-only and nothing imports
    // from it — which is why `confirmed` remains reachable but unreached.
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 8760,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "crtc_coverage",
    displayName: "CRTC mobile coverage geospatial layers (LTE, 5G, road coverage)",
    authority: "Canadian Radio-television and Telecommunications Commission",
    category: "coverage",
    jurisdiction: "CA",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 720,
    retrievedAt: SOURCE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
];

export const ALL_DATA_SOURCES: readonly ExternalDataSource[] = [
  ...VERIFIED_DATA_SOURCES,
  ...UNVERIFIED_DATA_SOURCES,
];

/** Requires an account and key, independent of licence status. */
export const SOURCES_REQUIRING_API_KEY: readonly string[] = ["ab511"];

/**
 * Publisher-stated caveats that must travel with the data wherever it is shown.
 * These are not our editorial notes — each is something the publisher says.
 */
export const SOURCE_CAVEATS: Record<string, string> = {
  statcan_boundaries:
    "Cartographic boundary files are generalized for mapping. A generalized boundary is close enough to say which province a road is in and not close enough to adjudicate a dispute about a road that runs along one.",
  ised_bc_rr:
    "Publisher states these channels are for use where posted on a BC resource road, and that amateur, marine and user-programmable radios are prohibited on the service. The province separately states its channel maps are planning tools and the posted road sign governs.",
  ised_b1_western:
    "Geographic exclusions are written into the authorization itself — a latitude line, a radius around a town — and several frequencies carry exclusions not captured in the seeds. A channel from this appendix authorizes nothing until its record is verified against the published table.",
  bc_resource_road_maps:
    "Publisher states the maps are planning tools and that the channel posted on the road takes precedence, and posts temporary channel changes separately.",
  crtc_coverage:
    "Coverage layers are modelled predictions published for regulatory purposes, not a guarantee of service at a position.",
  cwfis:
    "Publisher states this is not designed for operational fire management and may not show the most current fire situation. Advisory only — direct users to the provincial or territorial fire agency.",
  aer_st37:
    "Shapefile format is being retired in favour of File Geodatabase after a three-month transition. Ingest FGDB.",
  osm:
    "Share-alike attaches to a Derivative Database. An offline extract bundled to a device is a Derivative Database; the rendered map is a Produced Work needing attribution only.",
  ab511:
    "Throttled at ten calls per sixty seconds. Poll into a central cache; never proxy the raw API to devices.",
  msc_geomet:
    "Do not send no-cache headers, do not bulk-scrape WMS tiles, and set a descriptive User-Agent.",
  nrn: "Spatial resolution is approximately 1:10,000 and is a general estimate across multiple source contributions.",
};

/**
 * Fire is safety-critical, and the wildfire source itself says it is not an
 * operational fire-management product. It may add context to a screen; it may
 * never satisfy a constraint that a route or a job is safe.
 */
export const ADVISORY_ONLY_SOURCES: readonly string[] = ["cwfis"];

export function isAdvisoryOnly(sourceKey: string): boolean {
  return ADVISORY_ONLY_SOURCES.includes(sourceKey);
}

/* ------------------------------------------------------------------ */
/* Software components                                                  */
/* ------------------------------------------------------------------ */

/**
 * Deliberately a separate registry from the data sources.
 *
 * A software licence and a data licence create different obligations, and
 * `evaluateSourceUsage` asks data questions — whether a layer may be
 * redistributed, whether it is fresh enough to satisfy a constraint. Those
 * questions are meaningless about GDAL. Mixing them into one table would let
 * the gate return confident nonsense.
 */
export type SoftwareComponent = {
  componentKey: string;
  displayName: string;
  licenceSpdx: string;
  role: string;
  /** True when the licence permits use in a closed-source commercial product. */
  safeForClosedSourceCommercial: boolean;
  caveat?: string;
};

export const SOFTWARE_COMPONENTS: readonly SoftwareComponent[] = [
  // Split deliberately: the two MapLibre packages carry different BSD variants
  // and treating them as one package would misstate one of them.
  {
    componentKey: "maplibre_gl_js",
    displayName: "MapLibre GL JS",
    licenceSpdx: "BSD-3-Clause",
    role: "Web map rendering",
    safeForClosedSourceCommercial: true,
  },
  {
    componentKey: "maplibre_native",
    displayName: "MapLibre Native",
    licenceSpdx: "BSD-2-Clause",
    role: "Mobile and embedded map rendering",
    safeForClosedSourceCommercial: true,
    caveat: "Based in part on FreeType; retain its notice.",
  },
  {
    componentKey: "valhalla",
    displayName: "Valhalla",
    licenceSpdx: "MIT",
    role: "Truck routing engine",
    safeForClosedSourceCommercial: true,
    caveat:
      "Truck costing accepts height, width, length, weight, axle_load, axle_count and hazmat — the full set the constraint profile emits.",
  },
  {
    componentKey: "martin",
    displayName: "Martin",
    licenceSpdx: "Apache-2.0 OR MIT",
    role: "Vector tile server",
    safeForClosedSourceCommercial: true,
  },
  {
    componentKey: "pelias",
    displayName: "Pelias",
    licenceSpdx: "MIT",
    role: "Geocoder",
    safeForClosedSourceCommercial: true,
  },
  {
    componentKey: "gdal",
    displayName: "GDAL/OGR",
    licenceSpdx: "MIT",
    role: "Format conversion and reprojection",
    safeForClosedSourceCommercial: true,
    caveat:
      "The core is MIT, but a specific build can link GPL/LGPL/proprietary dependencies. Verify the licences of the build actually shipped.",
  },
  {
    componentKey: "turfjs",
    displayName: "Turf.js",
    licenceSpdx: "MIT",
    role: "Client-side spatial predicates",
    safeForClosedSourceCommercial: true,
  },
  {
    componentKey: "postgis",
    displayName: "PostGIS",
    licenceSpdx: "GPL-2.0-or-later",
    role: "Geospatial database extension",
    safeForClosedSourceCommercial: true,
    caveat:
      "Copyleft applies to modifying and distributing PostGIS itself, not to loading data and running queries against an unmodified install. Do not fork it into the product.",
  },
];
