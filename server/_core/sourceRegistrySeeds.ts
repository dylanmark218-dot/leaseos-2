/**
 * The endpoints the approved-source registry starts with — only what LeaseOS already reads, at the
 * addresses the repository already uses. Nothing speculative is registered here.
 *
 *   - The facility directory's three regulator layers. Saskatchewan's is the importer's own preset
 *     (`SK_FACILITIES`); the two BC Energy Regulator layers are the ones its importer spec names
 *     (docs/facility-map/IMPORTER_SPECS_2026-09-17.md, fetched through the egress guard 2026-09-24,
 *     and answering again 2026-10-03). Their sources are put up for approval with a seeded request:
 *     a person still approves each one before the importer may fetch from it.
 *   - The Canadian road-information providers, derived from `CANADIAN_TRANSPORT_PROVIDERS` so the
 *     registry and the collector cannot disagree about an address. They are registered disabled
 *     and are not put up for approval: the collector does not consult this registry yet (it keeps
 *     its own licence and owner gates), so an approval here would authorise nothing.
 *
 * A seed never changes a row that exists. Credentials are never seeded: a 511 endpoint records
 * that it needs an API key and binds no `credentialRef` until a person binds one.
 */
import { SK_FACILITIES } from "./arcgisImport";
import type { EndpointInput, RegistryPurpose } from "./sourceRegistry";
import { CANADIAN_TRANSPORT_PROVIDERS } from "./transport/providerRegistry";

export type EndpointSeed = { sourceKey: string; enabled: boolean; endpoint: EndpointInput };
export type ReviewSeed = { sourceKey: string; scope: RegistryPurpose[]; reason: string };

/** `?f=pjson` is served as text/plain and `/query?f=json` as JSON (checked 2026-09-24). */
const ARCGIS_TYPES = ["application/json", "text/plain"];

const arcgisLayer = (sourceKey: string, endpointKey: string, displayName: string, serviceType: "arcgis_feature_server" | "arcgis_map_server", baseUrl: string): EndpointSeed => ({
  sourceKey,
  enabled: true,
  endpoint: {
    endpointKey, displayName, serviceType, httpMethod: "GET", baseUrl, pathMatch: "prefix",
    authScheme: "NONE", credentialRef: null, contentTypes: ARCGIS_TYPES, timeoutMs: null, maxBytes: null,
  },
});

export const FACILITY_LAYER_ENDPOINTS: readonly EndpointSeed[] = [
  arcgisLayer("sk_petroleum_gis", "petroleum_facilities_layer_17", "Petroleum — Facilities (FeatureServer layer 17)", "arcgis_feature_server", SK_FACILITIES.layerUrl),
  arcgisLayer("bcer_gis", "facility_points_layer_0", "PASR — Facility Point Locations (MapServer layer 0)", "arcgis_map_server", "https://geoweb-ags.bc-er.ca/arcgis/rest/services/PASR/PASR_FACILITY_PT/MapServer/0"),
  arcgisLayer("bcer_gis", "sump_locations_layer_0", "Operational — Sump Locations (MapServer layer 0)", "arcgis_map_server", "https://geoweb-ags.bc-er.ca/arcgis/rest/services/OPERATIONAL/SUMP_LOCATIONS_PT/MapServer/0"),
];

/** One endpoint per provider that publishes one; the address is the collector's own, without its query. */
export const TRANSPORT_FEED_ENDPOINTS: readonly EndpointSeed[] = CANADIAN_TRANSPORT_PROVIDERS.flatMap(p => {
  if (!p.endpoint) return [];
  const u = new URL(p.endpoint.url);
  const wfs = /(^|&)service=wfs(&|$)/i.test(u.search.slice(1));
  return [{
    sourceKey: p.sourceKey,
    enabled: false,
    endpoint: {
      endpointKey: wfs ? "roadworks_wfs" : "events",
      displayName: `${p.sourceKey} — ${wfs ? "roadworks WFS" : "events feed"}`,
      serviceType: wfs ? "wfs" : "json_feed",
      httpMethod: "GET",
      baseUrl: `${u.origin}${u.pathname}`,
      pathMatch: "exact",
      authScheme: p.endpoint.credentialStyle.kind === "none" ? "NONE" : "API_KEY",
      credentialRef: null,
      contentTypes: (p.endpoint.acceptHeader ?? "application/json").split(",").map(t => t.split(";")[0]!.trim().toLowerCase()).filter(Boolean),
      timeoutMs: p.endpoint.timeoutMs,
      maxBytes: null,
    },
  }];
});

export const ENDPOINT_SEEDS: readonly EndpointSeed[] = [...FACILITY_LAYER_ENDPOINTS, ...TRANSPORT_FEED_ENDPOINTS];

const FACILITY_EVIDENCE =
  "Seeded from repository evidence: the layer and its licence are recorded in migration 0143 (retrieved 2026-09-17) and " +
  "docs/facility-map/IMPORTER_SPECS_2026-09-17.md; the layer was fetched through the egress guard on 2026-09-24. " +
  "A seed is not an approval: a person approves this source before the facility importer fetches from it.";

/** Sources put up for approval by the seed. A seeded request has no requester; the approver is still a named person. */
export const REVIEW_SEEDS: readonly ReviewSeed[] = [
  { sourceKey: "sk_petroleum_gis", scope: ["facility_directory.arcgis_import"], reason: FACILITY_EVIDENCE },
  { sourceKey: "bcer_gis", scope: ["facility_directory.arcgis_import"], reason: FACILITY_EVIDENCE },
];
