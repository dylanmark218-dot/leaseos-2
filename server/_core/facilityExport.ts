import { toMapFeatures, type FacilitySeedRow } from "./facilitySeed";

const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
export function toCsv(rows: FacilitySeedRow[]): string {
  const columns = ["facilityKey", "name", "municipality", "province", "facilityType", "latitude", "longitude", "coordinatePrecision", "disposition", "coordinateSourceUrl"];
  return [columns.map(quote).join(","), ...rows.map(row => columns.map(column => quote(row[column])).join(","))].join("\r\n") + "\r\n";
}
export function toGeoJson(rows: FacilitySeedRow[]) {
  return { type: "FeatureCollection" as const, features: toMapFeatures(rows).map(feature => ({
    type: "Feature" as const, id: feature.facilityKey,
    geometry: { type: "Point" as const, coordinates: [feature.longitude!, feature.latitude!] },
    properties: { facilityKey: feature.facilityKey, name: feature.name, facilityType: feature.facilityType,
      coordinatePrecision: feature.coordinatePrecision, routable: feature.routable, verificationState: feature.verificationState },
  })) };
}
