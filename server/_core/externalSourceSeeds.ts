/**
 * Verified external source records.
 *
 * This is the research turned into data the runtime actually consumes. Every
 * field traces to a publisher page checked on the retrieval date below; nothing
 * here is inferred. Where a publisher did not state something, the field is
 * null or `"unknown"` and the licence gate treats it as a refusal rather than a
 * permission.
 *
 * **Ten sources are verified. Twenty-five are not.** Ontario 511 and Québec's
 * roadworks cleared on their published licences in the later transport tranche.
 * Alberta 511 and the other unresolved providers stay `unverified`, which
 * under `evaluateSourceUsage` means inspection only, as do every later
 * candidate nobody has yet reviewed.
 *
 * The research summary said "nine of eleven are clean" while separately
 * flagging three as unresolved. Eleven minus three is eight. Seeding nine would
 * have marked one blocked source usable, so the count is corrected here and a
 * test holds it.
 */

import type { ExternalDataSource } from "./externalDataRegistry";

/** Every field below was checked against the publisher on this date. */
export const SOURCE_RETRIEVAL_DATE = new Date("2026-09-09T00:00:00Z");

/**
 * The federal and provincial catalogue candidates added 2026-09-24. What is
 * recorded for them is what the publisher's own page or catalogue entry stated
 * on this date — licence named, rate limit, key requirement, update frequency.
 * That is research, not a licence review, so all seven seed `unverified` and
 * are cleared (or refused) by a person through `geo.sourceReview`, which
 * records who and what they read.
 */
export const CANDIDATE_RETRIEVAL_DATE = new Date("2026-09-24T00:00:00Z");

const OGL_CANADA_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – Canada";
const OGL_ALBERTA_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – Alberta";
const OGL_BC_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – British Columbia";
const OGL_ONTARIO_ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – Ontario";

/**
 * The Canadian 511 tranche was checked against each publisher on this date — a
 * later date than the original eleven, and recorded separately so neither
 * retrieval date is quietly moved to cover the other.
 */
export const TRANSPORT_RETRIEVAL_DATE = new Date("2026-09-24T00:00:00Z");

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
  {
    /*
     * Ontario 511's Developer Resources page says its data "is available to the general public,
     * commercial vendors" and that using it is acceptance of the Open Government Licence, linking
     * to OGL – Ontario, which permits commercial use. So this one clears where Alberta's does not.
     *
     * It still needs a key. The developer page says "Requires a developer key" and "Ten calls every
     * 60 seconds" in the same words as every other 511 on this platform — a licence that permits
     * use is not the same fact as an API that admits anonymous callers.
     */
    sourceKey: "on511",
    displayName: "Ontario 511 Developer API",
    authority: "Government of Ontario — Ministry of Transportation",
    sourceUrl: "https://511on.ca/developers/doc",
    category: "road_conditions",
    jurisdiction: "CA-ON",
    licenceName: "Open Government Licence – Ontario",
    licenceUrl: "https://www.ontario.ca/page/open-government-licence-ontario",
    attributionRequired: true,
    attributionText: OGL_ONTARIO_ATTRIBUTION,
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: TRANSPORT_RETRIEVAL_DATE,
    status: "verified",
  },
  {
    /*
     * Québec 511's roadworks are published through Données Québec as the `travaux-routiers`
     * dataset, CC BY 4.0, by the Ministère des Transports et de la Mobilité durable, as a WFS
     * that answers GeoJSON with no key. CC BY 4.0 permits commercial use and adaptation with
     * credit, a licence notice and an indication of changes — the attribution below carries all
     * three, because LeaseOS normalizes the records and that is a change.
     */
    sourceKey: "qc_mtmd_roadworks",
    displayName: "Québec 511 — Travaux routiers (MTMD, Données Québec)",
    authority: "Gouvernement du Québec — Ministère des Transports et de la Mobilité durable",
    category: "road_conditions",
    jurisdiction: "CA-QC",
    licenceName: "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    licenceUrl: "https://www.donneesquebec.ca/licence/#cc-by",
    attributionRequired: true,
    attributionText:
      "Source : ministère des Transports et de la Mobilité durable du Québec, via Données Québec, sous licence CC BY 4.0 — données normalisées par LeaseOS",
    shareAlikeObligation: false,
    commercialUsePermitted: "yes",
    redistributionPermitted: "yes",
    // No numeric limit published for the WFS.
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Données Québec lists the update frequency as "continuous"; hourly is the most this polls.
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: TRANSPORT_RETRIEVAL_DATE,
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
  {
    /*
     * Same platform, same position as `ab511`: the developer page states the key requirement and
     * "Ten calls every 60 seconds", and its Developer Resources page states no licence. A key buys
     * access; it does not record a right. Written permission request drafted in
     * `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     * Carries winter-road information, which matters in the north.
     */
    sourceKey: "mb511",
    displayName: "Manitoba 511 Developer API",
    authority: "Government of Manitoba — Transportation and Infrastructure",
    category: "road_conditions",
    jurisdiction: "CA-MB",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * Same platform, same position as `ab511`: the developer page states the key requirement and
     * "Ten calls every 60 seconds", and its Developer Resources page states no licence. A key buys
     * access; it does not record a right. Written permission request drafted in
     * `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     */
    sourceKey: "nb511",
    displayName: "New Brunswick 511 Developer API",
    authority: "Government of New Brunswick — Transportation and Infrastructure",
    category: "road_conditions",
    jurisdiction: "CA-NB",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * Same platform, same position as `ab511`: the developer page states the key requirement and
     * "Ten calls every 60 seconds", and its Developer Resources page states no licence. A key buys
     * access; it does not record a right. Written permission request drafted in
     * `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     * The one with weight- and bridge-restriction endpoints, which is why its rights are worth asking for first.
     */
    sourceKey: "yt511",
    displayName: "511 Yukon Developer API",
    authority: "Government of Yukon — Highways and Public Works",
    category: "road_conditions",
    jurisdiction: "CA-YT",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * Same platform, same position as `ab511`: the developer page states the key requirement and
     * "Ten calls every 60 seconds", and its Developer Resources page states no licence. A key buys
     * access; it does not record a right. Written permission request drafted in
     * `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     */
    sourceKey: "nl511",
    displayName: "511 Newfoundland and Labrador Developer API",
    authority: "Government of Newfoundland and Labrador — Transportation and Infrastructure",
    category: "road_conditions",
    jurisdiction: "CA-NL",
    licenceName: null,
    licenceUrl: null,
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: 10,
    rateLimitWindowSeconds: 60,
    updateIntervalHours: 1,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    /*
     * Saskatchewan Highway Hotline publishes no developer API today, and nothing here polls its
     * website: a page scraper is not a licence, and a page layout is not a contract. Registered so
     * the request has somewhere to land — letter drafted in `docs/P6_DATA_PERMISSION_REQUESTS.md`.
     * The rate limit and interval are null because nothing has been published to read them from.
     */
    sourceKey: "sk_highway_hotline",
    displayName: "Saskatchewan Highway Hotline",
    authority: "Government of Saskatchewan — Ministry of Highways",
    category: "road_conditions",
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
    updateIntervalHours: null,
    retrievedAt: TRANSPORT_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  /*
   * 2026-09-24 catalogue candidates. Each licence named below is the one the publisher's
   * page or catalogue entry states; commercial use and redistribution stay `unknown`
   * and attribution text stays null until a person reads the terms and clears
   * the row. Both barriers hold exactly as they do for the rows above.
   */
  {
    sourceKey: "tc_vehicle_recalls",
    displayName: "Transport Canada Vehicle Recalls Database (last 60 days, daily)",
    authority: "Transport Canada",
    sourceUrl: "https://open.canada.ca/data/en/dataset/1991fef6-9dfe-40e2-a0c6-19c60ddf4a02",
    category: "vehicle_recalls",
    jurisdiction: "CA",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Catalogue frequency P1D. The full database is a separate monthly (P1M) file.
    updateIntervalHours: 24,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "hc_recalls_safety_alerts",
    displayName: "Government of Canada Recalls and Safety Alerts (open data feed)",
    authority: "Health Canada",
    sourceUrl: "https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3",
    category: "safety_alerts",
    jurisdiction: "CA",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Catalogue frequency is "continual", which is not an interval. Null keeps
    // freshness unknown rather than inventing one.
    updateIntervalHours: null,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "goc_open_data_api",
    displayName: "Government of Canada Open Data Portal (CKAN API)",
    authority: "Treasury Board of Canada Secretariat",
    sourceUrl: "https://open.canada.ca/data/en/api/3/",
    category: "dataset_catalog",
    jurisdiction: "CA",
    licenceName: "Open Government Licence – Canada",
    licenceUrl: "https://open.canada.ca/en/open-government-licence-canada",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: 24,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "statcan_wds",
    displayName: "Statistics Canada Web Data Service (WDS)",
    authority: "Statistics Canada",
    sourceUrl: "https://www.statcan.gc.ca/en/developers/wds",
    category: "statistics",
    jurisdiction: "CA",
    licenceName: "Statistics Canada Open Licence",
    licenceUrl: "https://www.statcan.gc.ca/en/reference/licence",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Each table has its own release schedule; no single interval applies.
    updateIntervalHours: null,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "statcan_rdaas",
    displayName: "Statistics Canada Reference Data as a Service (RDaaS)",
    authority: "Statistics Canada",
    sourceUrl: "https://www.statcan.gc.ca/en/developers/rdaas",
    category: "statistics",
    jurisdiction: "CA",
    licenceName: "Statistics Canada Open Licence",
    licenceUrl: "https://www.statcan.gc.ca/en/reference/licence",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    updateIntervalHours: null,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "bc_data_catalogue",
    displayName: "BC Data Catalogue (CKAN API)",
    authority: "Government of British Columbia",
    sourceUrl: "https://catalogue.data.gov.bc.ca/",
    category: "dataset_catalog",
    jurisdiction: "CA-BC",
    // Licensing is per dataset — many carry OGL – BC, not all do. The catalogue
    // row names no licence so nothing reads OGL – BC off it for a dataset.
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
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
  {
    sourceKey: "qc_reseau_camionnage",
    displayName: "Réseau de camionnage (Québec heavy-truck network)",
    authority: "Gouvernement du Québec — Ministère des Transports et de la Mobilité durable",
    sourceUrl: "https://www.donneesquebec.ca/recherche/dataset/reseau-camionnage",
    category: "road_network",
    jurisdiction: "CA-QC",
    // Données Québec lists the dataset as CC BY 4.0. The attribution wording
    // that licence requires is exactly what a reviewer records on clearing.
    licenceName: "Creative Commons Attribution 4.0 (CC BY 4.0)",
    licenceUrl: "https://www.donneesquebec.ca/licence/#cc-by",
    attributionRequired: true,
    attributionText: null,
    shareAlikeObligation: false,
    commercialUsePermitted: "unknown",
    redistributionPermitted: "unknown",
    rateLimitCalls: null,
    rateLimitWindowSeconds: null,
    // Catalogue frequency: monthly.
    updateIntervalHours: 720,
    retrievedAt: CANDIDATE_RETRIEVAL_DATE,
    verifiedAt: null,
    status: "unverified",
  },
];

export const ALL_DATA_SOURCES: readonly ExternalDataSource[] = [
  ...VERIFIED_DATA_SOURCES,
  ...UNVERIFIED_DATA_SOURCES,
];

/** Requires an account and key, independent of licence status. */
export const SOURCES_REQUIRING_API_KEY: readonly string[] = ["ab511", "on511", "mb511", "nb511", "yt511", "nl511"];

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
  on511:
    "Throttled at ten calls per sixty seconds and requires a developer key, although the licence is open. Poll into a central cache; never proxy the raw API to devices. The publisher calls the Ontario 511 logo mandatory while OGL – Ontario excludes logos and official marks from the grant, so the logo is not used until Ontario says in writing where it may appear; the licence attribution line is shown instead.",
  qc_mtmd_roadworks:
    "Records are in French with an English description field. CC BY 4.0 requires that changes be indicated — the attribution says the records were normalized.",
  sk_highway_hotline:
    "No developer API is currently published and the website is not scraped. Nothing is collected until Saskatchewan answers the access request.",
  msc_geomet:
    "Do not send no-cache headers, do not bulk-scrape WMS tiles, and set a descriptive User-Agent.",
  nrn: "Spatial resolution is approximately 1:10,000 and is a general estimate across multiple source contributions.",
  tc_vehicle_recalls:
    "A recall match is information for a person to act on, not a determination that a unit is safe or unsafe. Match on VIN or make, model and year; a unit with no match is not thereby recall-free.",
  hc_recalls_safety_alerts:
    "The feed spans consumer, food, health and vehicle notices. Only notices a person matches to a unit or a tool mean anything to the fleet.",
  goc_open_data_api:
    "The catalogue's licence covers the catalogue. Each dataset it lists carries its own licence and is registered and reviewed as its own source before anything imports from it.",
  bc_data_catalogue:
    "Licensing is per dataset and not uniformly OGL – BC. Register each dataset as its own source; the catalogue clears nothing by listing it.",
  statcan_wds:
    "Each table has its own release schedule. Record the table and reference period with any figure shown.",
  qc_reseau_camionnage:
    "Publisher is French-language; road classes and restriction wording are recorded as published and never machine-translated into a routing constraint.",
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
