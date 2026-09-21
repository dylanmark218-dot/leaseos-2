/**
 * Regulator ArcGIS layer → facility candidates (pure).
 *
 * A layer's schema is read from the layer itself (`?f=pjson`); a person maps its fields
 * to ours. Geometry becomes a coordinate through the layer's spatial reference: a point
 * as itself, a polygon as the centroid of its outer ring. The result is a candidate with
 * `approximate_site` precision and the regulator as source; a person still verifies it
 * (coordinateVerify) before directions exist. Nothing here guesses a missing field.
 */
import { projectToLatLon } from "./projections";

export type FieldMapping = { id: string; name?: string; operator?: string; licenceNumber?: string; facilityType?: string; status?: string; legalLocation?: string; facilityName?: string };
export type ArcgisFeature = { attributes: Record<string, unknown>; geometry?: { x?: number; y?: number; rings?: number[][][] } | null };
export type FacilityCandidate = {
  facilityKey: string; name: string; operatorNameFromSource: string | null; regulatorRef: string | null; facilityType: string | null; sourceStatus: string | null; legalLocation: string | null;
  latitude: number | null; longitude: number | null; coordinatePrecision: "approximate_site" | "unknown"; coordinateNote: string; attributes: Record<string, unknown>;
};

/** Which mapped fields the layer actually has; missing ones are named, not assumed. */
export function checkMapping(layerFields: string[], mapping: FieldMapping): { ok: boolean; missing: string[] } {
  const have = new Set(layerFields.map(f => f.toUpperCase()));
  const missing = Object.entries(mapping).filter(([, v]) => v && !have.has(String(v).toUpperCase())).map(([k, v]) => `${k} → ${v}`);
  return { ok: missing.length === 0, missing };
}

export function ringCentroid(ring: number[][]): { x: number; y: number } | null {
  if (ring.length < 3) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) { const [x0, y0] = ring[i]!, [x1, y1] = ring[i + 1]!; const f = x0! * y1! - x1! * y0!; area += f; cx += (x0! + x1!) * f; cy += (y0! + y1!) * f; }
  if (Math.abs(area) < 1e-9) { const n = ring.length; return { x: ring.reduce((a, p) => a + p[0]!, 0) / n, y: ring.reduce((a, p) => a + p[1]!, 0) / n }; }
  area *= 0.5; return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function featureToCandidate(source: string, feature: ArcgisFeature, mapping: FieldMapping, wkid: number): { candidate: FacilityCandidate } | { skipped: string } {
  const a = feature.attributes;
  const get = (k?: string) => (k ? a[k] ?? a[k.toUpperCase()] ?? a[k.toLowerCase()] : undefined);
  const id = get(mapping.id);
  if (id === undefined || id === null || String(id).trim() === "") return { skipped: `no ${mapping.id}` };
  const name = get(mapping.facilityName) ?? get(mapping.name);
  const operator = get(mapping.operator);
  let xy: { x: number; y: number } | null = null;
  if (feature.geometry?.x !== undefined && feature.geometry?.y !== undefined) xy = { x: feature.geometry.x!, y: feature.geometry.y! };
  else if (feature.geometry?.rings?.[0]) xy = ringCentroid(feature.geometry.rings[0]);
  const ll = xy ? projectToLatLon(xy.x, xy.y, wkid) : null;
  if (xy && !ll) return { skipped: `unsupported spatial reference WKID ${wkid}` };
  const displayName = name ? String(name) : operator ? `${String(operator)} — ${String(id)}` : String(id);
  return { candidate: {
    facilityKey: `${source}:${String(id).trim()}`, name: displayName, operatorNameFromSource: operator ? String(operator) : null, regulatorRef: get(mapping.licenceNumber) ? String(get(mapping.licenceNumber)) : null,
    facilityType: get(mapping.facilityType) ? String(get(mapping.facilityType)) : null, sourceStatus: get(mapping.status) ? String(get(mapping.status)) : null, legalLocation: get(mapping.legalLocation) ? String(get(mapping.legalLocation)) : null,
    latitude: ll ? Math.round(ll.latitude * 1e5) / 1e5 : null, longitude: ll ? Math.round(ll.longitude * 1e5) / 1e5 : null, coordinatePrecision: ll ? "approximate_site" : "unknown",
    coordinateNote: ll ? (feature.geometry?.rings ? `centroid of the regulator's facility polygon (WKID ${wkid}); site, not an entrance` : `the regulator's facility point (WKID ${wkid}); site, not an entrance`) : "no geometry on the feature",
    attributes: a,
  } };
}

/** The Saskatchewan Petroleum facilities layer, from the fields verified on 2026-09-17. */
export const SK_FACILITIES = {
  source: "sk_facilities", layerUrl: "https://gis.saskatchewan.ca/egis/rest/services/Economy/Petroleum/FeatureServer/17", licenceKey: "sk_unrestricted_use_v2", wkid: 2957,
  mapping: { id: "LICENCENUM", operator: "OWNERNAME", licenceNumber: "LICENCENUM", facilityType: "LICTYPE", status: "LICSTATUS", legalLocation: "SURFACELOC" } as FieldMapping,
  fields: ["OBJECTID", "SITEID", "LICENCENUM", "LICDATE", "LICTYPE", "LICSTATUS", "OWNERBAID", "OWNERNAME", "SURFACELOC", "FIELDOFFIC", "INFRAID", "INFRSTATUS", "CONSDATE", "DECOMDATE", "ISRETRO", "GEOMETRYSO", "DATAEXTRAC"],
};
/** Whether a source status reads as operating; anything else stays unknown rather than being called closed. */
export function lifecycleFromStatus(status: string | null): "operating" | "suspended" | "closed" | "unknown" {
  const s = (status ?? "").toUpperCase();
  if (!s) return "unknown";
  if (/ACTIVE|OPERAT|ISSUED|LICEN[CS]ED/.test(s) && !/INACTIVE|SUSPEND/.test(s)) return "operating";
  if (/SUSPEND/.test(s)) return "suspended";
  if (/ABANDON|CANCEL|CLOSED|DECOMMISSION|REVOK|EXPIR/.test(s)) return "closed";
  return "unknown";
}
