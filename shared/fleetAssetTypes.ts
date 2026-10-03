/**
 * Fleet & Equipment Portfolio — the controlled vocabulary of machines (design §B.2).
 *
 * `units` is the one Fleet Asset. `assetClass` is the structural discriminator the dispatch gate
 * reads (a trailer slot may not be filled by a truck); `assetType` is the operational vocabulary a
 * person picks from. Both live here, shared by the server and the client, so a screen cannot offer
 * a type the server would refuse. Extending the list is a code change reviewed like one, never a
 * free-text value: `units.vehicleType` stays as the legacy free-text column every older reader
 * still reads, and the create path derives it from the type so the two never disagree for new rows.
 *
 * A unit whose class nobody has set reads `assetClass: null` — unclassified — and is reported as
 * such. It is never guessed from `vehicleType`: a backfill by string-matching is a proposal a fleet
 * manager confirms per unit, not a migration.
 */
import { z } from "zod";

export const ASSET_CLASSES = ["power_unit", "trailer", "mounted_system", "portable_equipment", "component"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_TYPES_BY_CLASS: Record<AssetClass, readonly string[]> = {
  power_unit: ["truck", "tractor", "body_job", "vac_truck", "hydrovac", "tank_truck", "picker", "bed_truck", "winch_tractor", "pilot_vehicle", "service_truck", "pickup"],
  trailer: ["van", "flatdeck", "lowboy", "tanker", "pup", "hot_seat_trailer", "reefer_trailer", "equipment_trailer"],
  mounted_system: ["vacuum_system", "pto", "hydraulic_pump", "refrigeration_unit", "heating_system", "blower", "debris_tank", "water_pump", "tank_body"],
  portable_equipment: ["pressure_washer", "pump", "compressor", "generator", "light_tower", "heater", "misc_field_equipment"],
  component: ["axle_group", "engine", "transmission", "other_component"],
};

export const ASSET_TYPES: readonly string[] = ASSET_CLASSES.flatMap(c => ASSET_TYPES_BY_CLASS[c]);
export const assetClassSchema = z.enum(ASSET_CLASSES);
export const assetTypeSchema = z.enum(ASSET_TYPES as [string, ...string[]]);

/** The class a type belongs to, or null for a type this vocabulary does not know. */
export function assetClassOf(assetType: string): AssetClass | null {
  for (const c of ASSET_CLASSES) if (ASSET_TYPES_BY_CLASS[c].includes(assetType)) return c;
  return null;
}

/** What the legacy free-text `vehicleType` column reads for a new row: the type, as words. */
export const vehicleTypeFor = (assetType: string) => assetType.replace(/_/g, " ");

export const OWNERSHIP_TYPES = ["owned", "leased", "rented", "customer_supplied", "contractor_supplied"] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];
export const ownershipTypeSchema = z.enum(OWNERSHIP_TYPES);

/**
 * Lifecycle is stored; operational state is derived (design §B.3). `transferred` exists so that no
 * later migration has to add it, and is refused until tenant-to-tenant transfer carries an ownership
 * history (owner decision O-4).
 */
export const LIFECYCLE_STATUSES = ["active", "seasonal_storage", "retired", "sold", "transferred"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export const lifecycleStatusSchema = z.enum(LIFECYCLE_STATUSES);

/** A unit in any of these is not in service, whatever its holds say. */
export const OUT_OF_FLEET: readonly LifecycleStatus[] = ["retired", "sold", "transferred"];

/** Component relations (design §B.2): both ends are `units` rows; the relation carries its own history. */
export const COMPONENT_RELATIONSHIPS = ["mounted", "installed", "attached", "towed"] as const;
export type ComponentRelationship = (typeof COMPONENT_RELATIONSHIPS)[number];
export const componentRelationshipSchema = z.enum(COMPONENT_RELATIONSHIPS);

/** Identity a person records on a unit (design §A.14). Every field optional: unknown stays NULL, never a placeholder. */
export const assetIdentitySchema = z.object({
  assetType: assetTypeSchema,
  assetSubtype: z.string().trim().min(1).max(60).nullable().optional(),
  companyAssetNumber: z.string().trim().min(1).max(60).nullable().optional(),
  vin: z.string().trim().min(1).max(80).nullable().optional(),
  serialNumber: z.string().trim().min(1).max(120).nullable().optional(),
  plate: z.string().trim().min(1).max(40).nullable().optional(),
  plateJurisdiction: z.string().trim().min(2).max(8).nullable().optional(),
  make: z.string().trim().min(1).max(80).nullable().optional(),
  model: z.string().trim().min(1).max(80).nullable().optional(),
  modelYear: z.number().int().min(1900).max(2100).nullable().optional(),
  manufacturer: z.string().trim().min(1).max(120).nullable().optional(),
  ownershipType: ownershipTypeSchema.nullable().optional(),
  acquiredAt: z.coerce.date().nullable().optional(),
  homeTerminal: z.string().trim().min(1).max(120).nullable().optional(),
  assignedBranchRef: z.string().trim().min(1).max(64).nullable().optional(),
  assignedDivision: z.string().trim().min(1).max(120).nullable().optional(),
  defaultOperatorId: z.number().int().positive().nullable().optional(),
  regulatoryClass: z.string().trim().min(1).max(60).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});
export type AssetIdentityInput = z.infer<typeof assetIdentitySchema>;
