import { facilityRecordSchema, type FacilityMapFeature } from "../../shared/facilities";

export type FacilitySeedRow = Record<string, unknown> & { sourceBriefNames: string[]; disposition: "verified_facility" | "approximate_facility" | "service_location" | "ambiguous" };
export function validateFacilitySeed(records: FacilitySeedRow[], expectedNames: string[] = []) {
  const errors: string[] = [];
  const accounted = new Set<string>();
  for (const row of records) {
    row.sourceBriefNames.forEach(name => accounted.add(name));
    const parsed = facilityRecordSchema.safeParse(row);
    if (!parsed.success) errors.push(`${String(row.facilityKey ?? row.name)}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    if (row.disposition === "verified_facility" && (row.coordinatePrecision !== "verified_entrance" && row.coordinatePrecision !== "verified_site"))
      errors.push(`${String(row.facilityKey)}: verified facility requires verified coordinates`);
  }
  return { errors, unaccountedSourceNames: expectedNames.filter(name => !accounted.has(name)) };
}
export function toMapFeatures(records: FacilitySeedRow[]): FacilityMapFeature[] {
  return records.flatMap(row => {
    const parsed = facilityRecordSchema.safeParse(row);
    if (!parsed.success || parsed.data.latitude === undefined || parsed.data.longitude === undefined) return [];
    const routable = row.disposition === "verified_facility" && ["verified_entrance", "verified_site"].includes(parsed.data.coordinatePrecision);
    return [{ facilityKey: parsed.data.facilityKey, name: parsed.data.name, facilityType: parsed.data.facilityType,
      latitude: parsed.data.latitude, longitude: parsed.data.longitude, coordinatePrecision: parsed.data.coordinatePrecision,
      routable, verificationState: routable ? "verified" : row.disposition === "approximate_facility" ? "review_required" : "unknown" }];
  });
}
