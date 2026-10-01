/**
 * v23.31 — the commercial vocabulary shared by server and client.
 *
 * Extensible by code, validated by code. A rate line's kind is one of these or a custom key
 * (`custom:<slug>`); nothing here is a column, so adding a kind is a line in a list, not a
 * migration. Pricing method and unit stay on the charge definition — a kind is a label for
 * what the line is for, never a formula.
 */

export const RATE_LINE_KINDS = [
  "hourly_equipment", "hourly_operator", "unit_operator_combined", "kilometre", "mileage", "per_load", "per_trip",
  "minimum_callout", "minimum_hours", "travel_time", "mobilization", "demobilization", "standby", "waiting_time",
  "loading_time", "unloading_time", "disposal_time", "disposal_charge", "disposal_pass_through",
  "environmental_surcharge", "fuel_surcharge", "percentage_surcharge", "flat_surcharge",
  "after_hours", "night_shift", "weekend", "statutory_holiday", "specialized_equipment", "additional_equipment",
  "helper", "quantity_charge", "misc",
] as const;
export type RateLineKind = (typeof RATE_LINE_KINDS)[number];
export const CUSTOM_LINE_KIND = /^custom:[a-z][a-z0-9_]{1,30}$/;
export const isRateLineKind = (k: string): boolean => (RATE_LINE_KINDS as readonly string[]).includes(k) || CUSTOM_LINE_KIND.test(k);

export const RATE_LINE_KIND_LABELS: Record<RateLineKind, string> = {
  hourly_equipment: "Hourly — equipment", hourly_operator: "Hourly — operator", unit_operator_combined: "Hourly — unit + operator",
  kilometre: "Per kilometre", mileage: "Per mile", per_load: "Per load", per_trip: "Per trip", minimum_callout: "Minimum callout",
  minimum_hours: "Minimum hours", travel_time: "Travel time", mobilization: "Mobilization", demobilization: "Demobilization",
  standby: "Standby", waiting_time: "Waiting time", loading_time: "Loading time", unloading_time: "Unloading time",
  disposal_time: "Disposal time", disposal_charge: "Disposal charge", disposal_pass_through: "Disposal pass-through",
  environmental_surcharge: "Environmental surcharge", fuel_surcharge: "Fuel surcharge", percentage_surcharge: "Percentage surcharge",
  flat_surcharge: "Flat surcharge", after_hours: "After hours", night_shift: "Night shift", weekend: "Weekend",
  statutory_holiday: "Statutory holiday", specialized_equipment: "Specialized equipment", additional_equipment: "Trailer / additional equipment",
  helper: "Helper / swamper", quantity_charge: "Quantity charge", misc: "Miscellaneous",
};

/** What a rate line may be conditioned on, beyond the scope it names. Read by rateApplicability.ts. */
export const CONDITION_KINDS = [
  "equipment_class", "unit_type", "service_type", "job_type", "region", "province", "shift", "weekday",
  "quantity", "distance_km", "disposal_facility", "material", "dg_class", "customer_reference_kind",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];
export const CONDITION_OPERATORS = ["eq", "in", "gte", "lte", "between"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const SHIFT_VALUES = ["day", "night", "after_hours", "weekend", "statutory_holiday"] as const;

export const CONTACT_ROLE_KEYS = [
  "dispatcher", "consultant", "field_consultant", "billing", "accounts_payable", "safety", "operations_manager", "emergency", "site_contact", "other",
] as const;
export type ContactRoleKey = (typeof CONTACT_ROLE_KEYS)[number];

export const PARTY_ROLES = [
  "operator_producer", "prime_contractor", "consultant_company", "disposal_company", "site_contact", "consultant_contact", "dispatcher_contact", "billing_contact", "emergency_contact",
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
/** A party role that names a person (a contact row) rather than a company. */
export const CONTACT_PARTY_ROLES: readonly PartyRole[] = ["site_contact", "consultant_contact", "dispatcher_contact", "billing_contact", "emergency_contact"];

export const REFERENCE_KINDS = ["po", "work_order", "afe", "customer_job_number", "cost_centre", "project_number", "uwi", "other"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const CUSTOMER_TYPES = ["producer_operator", "oilfield_service", "prime_contractor", "consultant", "disposal_company", "municipality", "construction", "trucking", "other"] as const;
export const CONTRACT_TYPES = ["msa", "rate_agreement", "service_agreement", "work_order", "purchase_order", "framework", "other"] as const;
export const CONTRACT_STATUSES = ["draft", "pending_approval", "active", "suspended", "expired", "terminated", "superseded"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const SHEET_VERSION_STATUSES = ["draft", "pending_approval", "approved", "rejected", "superseded", "retired"] as const;
export type SheetVersionStatus = (typeof SHEET_VERSION_STATUSES)[number];

/** The customer-safe / field-safe subset never carries these. Kept as one list so a test can assert it. */
export const CONFIDENTIAL_COMMERCIAL_FIELDS = ["rateMillis", "flatCents", "basisPoints", "multiplierMillis", "minimumChargeCents", "creditLimitCents", "paymentTermsDays", "marginBps"] as const;
