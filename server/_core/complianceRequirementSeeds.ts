/**
 * Compliance requirement seeds.
 *
 * Every figure below — twelve-month abstracts, medical intervals by age,
 * three-year certificate terms, a 24-hour inspection window, quarterly
 * profile reviews, a 9–12 month new-carrier review — comes from a research
 * summary supplied to the project, not from anyone checking the regulator.
 * So every row is `unverified`, its source names the summary, and the
 * passport engine turns each into UNKNOWN until a person verifies it against
 * the authority and records that.
 *
 * Seeding these is not a claim that they are true. It is a work queue with
 * the shape the engine needs.
 */

import type { Requirement } from "./compliancePassport";

const CLAIMED = "Compliance research summary (unverified) — verify against the named authority before use";
const FROM = new Date("2026-01-01T00:00:00Z");

const req = (r: Omit<Requirement, "version" | "verificationStatus" | "effectiveFrom" | "warnDaysBeforeExpiry"> & { warnDaysBeforeExpiry?: number }): Requirement => ({
  version: 1, verificationStatus: "unverified", effectiveFrom: FROM, warnDaysBeforeExpiry: 30, ...r,
});

export const COMPLIANCE_REQUIREMENT_SEEDS: readonly Requirement[] = [
  /* ---- Driver ---- */
  req({ requirementKey: "ab.driver.licence.class1", family: "driver_licensing", title: "Class 1 driver licence", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { licenceClassRequired: "1" }, satisfiedByDocTypes: ["driver_licence"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.driver.abstract.annual", family: "commercial_abstracts", title: "Commercial driver abstract (hire and every 12 months)", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { commercialDriver: true }, satisfiedByDocTypes: ["commercial_driver_abstract", "driver_abstract"], renewalIntervalDays: 365, missingSeverity: "review" }),
  req({ requirementKey: "ab.driver.experience_record.class1", family: "class1_experience", title: "Class 1 driver experience record", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { licenceClassRequired: "1", gvwKgAtLeast: 11794, airBrakeTrailer: true }, satisfiedByDocTypes: ["class1_experience_record"], missingSeverity: "review" }),
  req({ requirementKey: "ab.driver.medical.under45", family: "medical_fitness", title: "Commercial medical (under 45: every 5 years)", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { commercialDriver: true, ageAtMost: 44 }, satisfiedByDocTypes: ["medical_fitness"], renewalIntervalDays: 1826, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.driver.medical.45to65", family: "medical_fitness", title: "Commercial medical (45–65: every 3 years)", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { commercialDriver: true, ageAtLeast: 45, ageAtMost: 65 }, satisfiedByDocTypes: ["medical_fitness"], renewalIntervalDays: 1096, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.driver.medical.over65", family: "medical_fitness", title: "Commercial medical (over 65: annually)", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { commercialDriver: true, ageAtLeast: 66 }, satisfiedByDocTypes: ["medical_fitness"], renewalIntervalDays: 365, missingSeverity: "blocked" }),
  req({ requirementKey: "ca.tdg.training", family: "dangerous_goods", title: "TDG training certificate (road: 3-year validity)", subjectType: "operator", jurisdiction: "CA",
    appliesWhen: { handlesDangerousGoods: true }, satisfiedByDocTypes: ["tdg_certificate"], renewalIntervalDays: 1096, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.whmis.training", family: "workplace_safety", title: "WHMIS hazardous-product training", subjectType: "operator", jurisdiction: "CA-AB",
    appliesWhen: { handlesHazardousProducts: true }, satisfiedByDocTypes: ["whmis_certificate"], missingSeverity: "review" }),

  /* ---- Unit ---- */
  req({ requirementKey: "ab.unit.registration", family: "vehicle_credentials", title: "Vehicle registration", subjectType: "unit", jurisdiction: "CA-AB",
    satisfiedByDocTypes: ["vehicle_registration"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.unit.insurance_proof", family: "insurance", title: "Proof of commercial auto insurance", subjectType: "unit", jurisdiction: "CA-AB",
    satisfiedByDocTypes: ["insurance_proof", "insurance_card"], missingSeverity: "review" }),
  req({ requirementKey: "ab.unit.cvip.annual", family: "vehicle_credentials", title: "CVIP inspection certificate (annual)", subjectType: "unit", jurisdiction: "CA-AB",
    appliesWhen: { gvwKgAtLeast: 11794 }, satisfiedByDocTypes: ["cvip_certificate"], renewalIntervalDays: 365, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.unit.trip_inspection.24h", family: "trip_compliance", title: "Daily trip inspection (24-hour validity)", subjectType: "unit", jurisdiction: "CA-AB",
    appliesWhen: { commercialVehicle: true }, satisfiedByDocTypes: ["trip_inspection"], renewalIntervalDays: 1, warnDaysBeforeExpiry: 0, missingSeverity: "blocked" }),
  req({ requirementKey: "ca.unit.ifta", family: "interjurisdictional", title: "IFTA decal/licence", subjectType: "unit", jurisdiction: "CA",
    appliesWhen: { interjurisdictional: true }, satisfiedByDocTypes: ["ifta_licence"], missingSeverity: "blocked" }),
  req({ requirementKey: "ca.unit.irp", family: "interjurisdictional", title: "IRP apportioned registration", subjectType: "unit", jurisdiction: "CA",
    appliesWhen: { interjurisdictional: true, gvwKgAtLeast: 11794 }, satisfiedByDocTypes: ["irp_cab_card"], missingSeverity: "blocked" }),

  /* ---- Carrier ---- */
  req({ requirementKey: "ab.carrier.sfc", family: "carrier_authority", title: "Safety Fitness Certificate with operating status (up to 3-year term)", subjectType: "carrier", jurisdiction: "CA-AB",
    appliesWhen: { nscCarrier: true }, satisfiedByDocTypes: ["safety_fitness_certificate"], renewalIntervalDays: 1096, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.carrier.new_carrier_review", family: "carrier_authority", title: "New-carrier compliance review (9–12 months after SFC)", subjectType: "carrier", jurisdiction: "CA-AB",
    appliesWhen: { newCarrier: true }, satisfiedByDocTypes: ["new_carrier_review"], missingSeverity: "review" }),
  req({ requirementKey: "ab.carrier.profile_review.quarterly", family: "carrier_profile", title: "Carrier Profile review (quarterly)", subjectType: "carrier", jurisdiction: "CA-AB",
    appliesWhen: { nscCarrier: true }, satisfiedByDocTypes: ["carrier_profile_review"], renewalIntervalDays: 91, missingSeverity: "review" }),
  req({ requirementKey: "ab.carrier.safety_program", family: "safety_maintenance_programs", title: "Written safety program", subjectType: "carrier", jurisdiction: "CA-AB",
    appliesWhen: { nscCarrier: true }, satisfiedByDocTypes: ["written_safety_program"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.carrier.maintenance_program", family: "safety_maintenance_programs", title: "Written maintenance program", subjectType: "carrier", jurisdiction: "CA-AB",
    appliesWhen: { nscCarrier: true }, satisfiedByDocTypes: ["written_maintenance_program"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.carrier.wcb", family: "wcb_workforce", title: "WCB employer account", subjectType: "carrier", jurisdiction: "CA-AB",
    satisfiedByDocTypes: ["wcb_clearance"], missingSeverity: "review" }),
  req({ requirementKey: "ca.carrier.business_number", family: "corporate_business", title: "CRA Business Number and program accounts", subjectType: "carrier", jurisdiction: "CA",
    satisfiedByDocTypes: ["cra_business_number"], missingSeverity: "review" }),
  req({ requirementKey: "ab.carrier.erp", family: "workplace_safety", title: "Emergency response plan (kept current)", subjectType: "carrier", jurisdiction: "CA-AB",
    satisfiedByDocTypes: ["emergency_response_plan"], missingSeverity: "blocked" }),
];

/** The claim source, recorded on every seeded row. */
export const SEED_SOURCE_REFERENCE = CLAIMED;

/**
 * Regulatory statements from the summary that are NOT requirements — they are
 * facts about applicability, and they too are unverified.
 */
export const APPLICABILITY_CLAIMS_UNVERIFIED: readonly string[] = [
  "Alberta-only, non-federally-regulated carriers are not required to use ELDs solely because of the federal mandate",
  "SFC required at 11,794 kg registered GVW in Alberta, or 4,500 kg when operating outside Alberta",
  "IRP applies to eligible Alberta-based interjurisdictional vehicles meeting axle/weight criteria",
  "Commercial trip inspections are valid for 24 hours and the current day's report must be producible roadside",
];

/* ==================================================================
 * v20.22 — Packs, and the requirements they carry
 * ================================================================== */

import type { Pack } from "./requirementEngine";

/**
 * Packs activate by company profile. Everything else about them is a claim
 * until verified — including whether the pack's rules exist as stated.
 */
export const COMPLIANCE_PACK_SEEDS: readonly Pack[] = [
  { packKey: "core.ab_carrier", title: "Alberta NSC carrier core", jurisdiction: "CA-AB", core: true },
  { packKey: "ab.powered_mobile_equipment", title: "Powered mobile equipment (Alberta OHS)", jurisdiction: "CA-AB", core: false, activatesWhen: { activitiesAny: ["earthworks", "hydrovac", "material_handling", "lifting"] } },
  { packKey: "ab.lifting_devices", title: "Cranes, boom trucks and hoists", jurisdiction: "CA-AB", core: false, activatesWhen: { activitiesAny: ["lifting"] } },
  { packKey: "ab.pressure_equipment", title: "Pressure equipment (ABSA)", jurisdiction: "CA-AB", core: false, activatesWhen: { assetTypesAny: ["pressure_vessel", "boiler"] } },
  { packKey: "ab.confined_space", title: "Confined space entry", jurisdiction: "CA-AB", core: false, activatesWhen: { activitiesAny: ["tank_cleaning", "vessel_entry", "hydrovac"] } },
  { packKey: "ab.ground_disturbance", title: "Ground disturbance", jurisdiction: "CA-AB", core: false, activatesWhen: { activitiesAny: ["excavation", "hydrovac"] } },
  { packKey: "measurement.billing_devices", title: "Calibrated billing measurement", jurisdiction: "*", core: false, activatesWhen: { billsByMeasurement: true } },
];

export const EQUIPMENT_REQUIREMENT_SEEDS: readonly Requirement[] = [
  req({ requirementKey: "ab.pme.operator_authorization", family: "operator_authorization", packKey: "ab.powered_mobile_equipment",
    title: "Powered mobile equipment: trained, competent, familiar with instructions, employer-authorized", subjectType: "work_context", jurisdiction: "CA-AB",
    appliesWhen: { "equipment.poweredMobile": true }, satisfiedByDocTypes: ["equipment_operator_authorization"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.pme.pre_use_inspection", family: "pre_use_inspection", packKey: "ab.powered_mobile_equipment",
    title: "Pre-use equipment inspection", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { poweredMobile: true }, satisfiedByDocTypes: ["pre_use_inspection"], renewalIntervalDays: 1, warnDaysBeforeExpiry: 0, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.lifting.logbook", family: "equipment_logbook", packKey: "ab.lifting_devices",
    title: "Lifting device logbook accompanies equipment", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { liftingDevice: true }, satisfiedByDocTypes: ["equipment_logbook"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.lifting.annual_inspection", family: "lifting_equipment", packKey: "ab.lifting_devices",
    title: "Lifting device annual inspection and certification", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { liftingDevice: true }, satisfiedByDocTypes: ["lifting_device_certification"], renewalIntervalDays: 365, missingSeverity: "blocked" }),
  req({ requirementKey: "ab.lifting.load_chart", family: "lifting_equipment", packKey: "ab.lifting_devices",
    title: "Load chart available to operator", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { liftingDevice: true }, satisfiedByDocTypes: ["load_chart"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.absa.inspection_permit", family: "pressure_equipment", packKey: "ab.pressure_equipment",
    title: "ABSA certificate of inspection permit", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { pressureEquipment: true }, satisfiedByDocTypes: ["absa_inspection_permit"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.absa.relief_device_service", family: "pressure_equipment", packKey: "ab.pressure_equipment",
    title: "Pressure relief device service", subjectType: "equipment", jurisdiction: "CA-AB",
    appliesWhen: { pressureEquipment: true }, satisfiedByDocTypes: ["relief_device_service"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.confined_space.entry_permit", family: "confined_space", packKey: "ab.confined_space",
    title: "Signed confined-space entry permit before entry", subjectType: "work_context", jurisdiction: "CA-AB",
    appliesWhen: { workType: "confined_space_entry" }, satisfiedByDocTypes: ["confined_space_entry_permit"], missingSeverity: "blocked" }),
  req({ requirementKey: "ab.ground_disturbance.locates", family: "ground_disturbance", packKey: "ab.ground_disturbance",
    title: "Utility owner contacted and facilities located before ground disturbance", subjectType: "work_context", jurisdiction: "CA-AB",
    appliesWhen: { workType: "ground_disturbance" }, satisfiedByDocTypes: ["utility_locate"], missingSeverity: "blocked" }),
  req({ requirementKey: "measurement.billing_device_calibrated", family: "calibration", packKey: "measurement.billing_devices",
    title: "Billing measurement device calibrated", subjectType: "equipment", jurisdiction: "*",
    appliesWhen: { billingMeasurementDevice: true }, satisfiedByDocTypes: ["calibration_certificate"], missingSeverity: "review" }),
];
