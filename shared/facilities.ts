import { z } from "zod";

export const coordinatePrecisionSchema = z.enum([
  "verified_entrance", "verified_site", "approximate_site", "community_only", "unknown",
]);
export const acceptanceStatusSchema = z.enum(["verified", "confirmation_required", "not_accepted", "unknown"]);
export const compatibilityOutcomeSchema = z.enum([
  "compatible_verified", "facility_confirmation_required", "incompatible", "insufficient_information",
]);
export const wasteCodeSchema = z.enum([
  "domestic_septage", "portable_toilet_waste", "grease_trap_waste", "hydrovac_slurry",
  "drilling_mud", "drill_cuttings", "produced_water", "flowback", "oily_water_emulsion",
  "contaminated_soil", "hazardous_solids", "asbestos", "construction_demolition",
  "commercial_msw", "tires", "scrap_metal", "clean_wood",
]);

export const facilityRecordSchema = z.object({
  facilityKey: z.string().min(1).max(100),
  name: z.string().min(1).max(220),
  operatorKey: z.string().max(100).optional(),
  facilityType: z.string().max(100).optional(),
  address: z.string().max(300).optional(),
  municipality: z.string().max(120).optional(),
  province: z.string().length(2).optional(),
  country: z.string().length(2).default("CA"),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  coordinatePrecision: coordinatePrecisionSchema.default("unknown"),
  coordinateSourceUrl: z.string().url().optional(),
  coordinateVerifiedAt: z.coerce.date().optional(),
  phone: z.string().max(60).optional(),
  dispatchPhone: z.string().max(60).optional(),
  emergencyPhone: z.string().max(60).optional(),
  email: z.string().email().optional(),
  websiteUrl: z.string().url().optional(),
  accountRegistrationUrl: z.string().url().optional(),
  googleMapsPlaceUrl: z.string().url().optional(),
}).superRefine((value, ctx) => {
  const hasCoordinate = value.latitude !== undefined || value.longitude !== undefined;
  if (hasCoordinate && (value.latitude === undefined || value.longitude === undefined))
    ctx.addIssue({ code: "custom", message: "latitude and longitude must be supplied together" });
  if (hasCoordinate && value.coordinatePrecision === "unknown")
    ctx.addIssue({ code: "custom", message: "mapped coordinates require an explicit precision" });
  if (hasCoordinate && !value.coordinateSourceUrl)
    ctx.addIssue({ code: "custom", message: "mapped coordinates require a source URL" });
});

export type CoordinatePrecision = z.infer<typeof coordinatePrecisionSchema>;
export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type CompatibilityOutcome = z.infer<typeof compatibilityOutcomeSchema>;
export type WasteCode = z.infer<typeof wasteCodeSchema>;
export type FacilityRecord = z.infer<typeof facilityRecordSchema>;

export type FacilityMapFeature = Pick<FacilityRecord,
  "facilityKey" | "name" | "facilityType" | "latitude" | "longitude" | "coordinatePrecision"
> & { routable: boolean; verificationState: "verified" | "review_required" | "unknown" };
