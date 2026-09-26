/**
 * Document Control — the definition registry's vocabulary and rules (DC-A, 0178).
 *
 * A document DEFINITION says how a class of controlled record behaves: whether
 * LeaseOS mints a number for it, whether it may arrive as a scan with no
 * template, who owns the facts it carries, what it may be linked to, and how it
 * is represented to a reader. It is not the document, and it is not the visual
 * template — a template is one way of producing a document under a definition,
 * and a scanned facility receipt is another with no template at all.
 *
 * Everything enforced is a column, not a policy blob, so the database and the
 * type system carry it. The vocabularies below are mirrored by the `mysqlEnum`
 * declarations in `drizzle/schema.ts`; `documentDefinitions.test.ts` holds the
 * two in step.
 *
 * Design: docs/document-control/document-control-design.md §4–§6, §10.
 */
import type { SensitivityTier } from "./restrictedVault";

export const DOCUMENT_CLASSES = ["operational_form", "controlled_credential", "financial_commercial", "regulated_record", "reference_document", "incident_evidence", "unclassified"] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

/** How a document came to exist in LeaseOS. The first five are renderings; the last three are originals LeaseOS merely holds. */
export const ORIGIN_KINDS = ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered", "system_rendered", "external_scanned", "external_digital_import", "reference_document"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];
export const RENDERED_ORIGINS: readonly OriginKind[] = ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered", "system_rendered"];
export const TEMPLATE_ORIGINS: readonly OriginKind[] = ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered"];
export const EXTERNAL_ORIGINS: readonly OriginKind[] = ["external_scanned", "external_digital_import", "reference_document"];

/** Who issued a document. LeaseOS is never an issuer: a LeaseOS-generated ticket is issued by the tenant. */
export const ISSUER_KINDS = ["tenant", "customer", "facility", "vendor", "regulator", "government_authority", "manufacturer", "other_third_party", "unknown"] as const;
export type IssuerKind = (typeof ISSUER_KINDS)[number];

/**
 * Whether LeaseOS mints a business number for the class.
 *
 *   leaseos_series          — required, minted from the definition's series before issue
 *   leaseos_series_optional — minted only where the tenant enables it for the class
 *   domain_managed          — the owning domain mints (FT, INV, DSP, MRO); the register mirrors
 *   external_only           — never; the issuer's identifier is the number and is required
 *   archival_only           — never; the archival DOC- ref is the only LeaseOS identity
 */
export const NUMBERING_POLICIES = ["leaseos_series", "leaseos_series_optional", "domain_managed", "external_only", "archival_only"] as const;
export type NumberingPolicy = (typeof NUMBERING_POLICIES)[number];
/** The policies under which LeaseOS itself may mint a control number for a record. */
export const MINTING_POLICIES: readonly NumberingPolicy[] = ["leaseos_series", "leaseos_series_optional"];

export const EXTERNAL_REFERENCE_POLICIES = ["forbidden", "optional", "required"] as const;
export type ExternalReferencePolicy = (typeof EXTERNAL_REFERENCE_POLICIES)[number];

export const SIGNATURE_POLICIES = ["none", "optional", "required_single", "required_multi", "domain_managed"] as const;
export type SignaturePolicy = (typeof SIGNATURE_POLICIES)[number];

export const REVISION_POLICIES = ["immutable_supersede", "amend_with_reason", "domain_managed", "reference_versioned"] as const;
export type RevisionPolicy = (typeof REVISION_POLICIES)[number];

export const PRINT_POLICIES = ["not_printable", "printable", "controlled_copy"] as const;
export type PrintPolicy = (typeof PRINT_POLICIES)[number];

export const SENSITIVITY_TIERS = ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"] as const satisfies readonly SensitivityTier[];

/**
 * How the record is represented to a reader. The supplied catalog's caveats
 * become behaviour here: an internal compliance record is never shown as an
 * agency form, and the internal waste-manifest companion record must carry the
 * official manifest as an attachment rather than stand in for it.
 */
export const REPRESENTATION_POLICIES = ["internal_record", "official_external_record", "attach_official_record_required"] as const;
export type RepresentationPolicy = (typeof REPRESENTATION_POLICIES)[number];

export const JURISDICTION_POLICIES = ["universal", "configurable_verify_by_jurisdiction"] as const;
export type JurisdictionPolicy = (typeof JURISDICTION_POLICIES)[number];

export const REGULATORY_BASES = ["not_inferred_from_template", "verified_source_cited"] as const;
export type RegulatoryBasis = (typeof REGULATORY_BASES)[number];

export const DEFINITION_STATUSES = ["draft", "active", "retired"] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export const PRIMARY_DOMAIN_OWNERS = ["document_control", "closeout", "custody", "disposal", "compliance", "academy", "fleet", "insurance", "hos", "billing", "safety", "restricted_vault", "expense"] as const;
export type PrimaryDomainOwner = (typeof PRIMARY_DOMAIN_OWNERS)[number];

/** Evidence read categories that exist in `recordsAuthorization` as `evidence.read_<category>`. A new category reaches nobody until granted. */
export const READ_CATEGORIES = ["own", "maintenance", "job_operational", "safety_summary", "commercial", "personnel", "legal"] as const;
export type ReadCategory = (typeof READ_CATEGORIES)[number];

/** Identifiers another issuer assigned. Extensible per tenant like `commercialCategoryTypes`; this is the platform set. */
export const EXTERNAL_REFERENCE_TYPES = ["facility_ticket_number", "scale_ticket_number", "customer_po", "afe", "manifest_number", "regulatory_identifier", "supplier_invoice_number", "bol_number", "customer_job_number", "licence_number", "certificate_number", "policy_number", "permit_number", "receipt_number", "generator_id", "transporter_id", "other"] as const;
export type ExternalReferenceType = (typeof EXTERNAL_REFERENCE_TYPES)[number];

/**
 * One link vocabulary. The 24 `evidenceRelationships.entityType` values in
 * snake_case, plus the record kinds documents are linked to that evidence never
 * was. The four older polymorphic-link conventions are mapped, not migrated
 * (design D-DC-06).
 */
export const DOCUMENT_LINK_KINDS = ["operator", "unit", "trailer", "equipment", "job", "trip", "load", "manifest", "disposal_ticket", "field_ticket", "work_order", "incident", "near_miss", "safety_meeting", "invoice", "customer", "facility", "daily_log", "inspection", "expense_record", "financial_entity", "tax_year", "user", "fuel_transaction", "customer_account", "vendor", "billing_book", "purchase_order", "material", "written_program", "document", "dispatch", "organization", "qualification"] as const;
export type DocumentLinkKind = (typeof DOCUMENT_LINK_KINDS)[number];

/** `evidenceRelationships.entityType` (camelCase enum) → the one link vocabulary. */
export const EVIDENCE_ENTITY_TO_LINK_KIND: Record<string, DocumentLinkKind> = {
  operator: "operator", unit: "unit", trailer: "trailer", equipment: "equipment", job: "job", trip: "trip", load: "load", manifest: "manifest",
  disposalTicket: "disposal_ticket", fieldTicket: "field_ticket", workOrder: "work_order", incident: "incident", nearMiss: "near_miss", safetyMeeting: "safety_meeting",
  invoice: "invoice", customer: "customer", facility: "facility", dailyLog: "daily_log", inspection: "inspection", expenseRecord: "expense_record",
  financialEntity: "financial_entity", taxYear: "tax_year", user: "user", fuelTransaction: "fuel_transaction",
};

export const DEFINITION_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** The row shape the registry stores (JSON columns as arrays, not text). */
export type DocumentDefinitionSeed = {
  definitionKey: string;
  documentClass: DocumentClass;
  displayName: string;
  description: string | null;
  primaryDomainOwner: PrimaryDomainOwner;
  allowedOrigins: OriginKind[];
  numberingPolicy: NumberingPolicy;
  numberSeriesType: string | null;
  externalReferencePolicy: ExternalReferencePolicy;
  allowedExternalReferenceTypes: ExternalReferenceType[];
  leaseosTemplateAvailable: boolean;
  customTemplateAllowed: boolean;
  importAllowed: boolean;
  requiredFields: string[];
  optionalFields: string[];
  allowedLinkKinds: DocumentLinkKind[];
  signaturePolicy: SignaturePolicy;
  revisionPolicy: RevisionPolicy;
  printPolicy: PrintPolicy;
  extractionProfileKey: string | null;
  readCategory: ReadCategory;
  sensitivityTier: SensitivityTier;
  jurisdictions: string[];
  jurisdictionPolicy: JurisdictionPolicy;
  regulatoryBasis: RegulatoryBasis;
  representationPolicy: RepresentationPolicy;
  representationNotice: string | null;
  industries: string[];
  packKey: string | null;
  sourcePackageKey: string | null;
  source: string;
};

/** Platform rows a tenant overlay may change. Nothing else on a platform definition bends per tenant. */
export const TENANT_OVERRIDABLE_COLUMNS = ["displayName", "description", "customTemplateAllowed", "numberSeriesType", "printPolicy", "retentionPolicyId", "optionalFields", "allowedLinkKinds", "industries"] as const;

/**
 * A package key that names a document kind the register already has. The
 * package's templates attach to the existing definition; a second definition
 * for the same business document is the duplication this repository exists to
 * avoid.
 */
export const PACKAGE_DEFINITION_ALIASES: Readonly<Record<string, string>> = {
  commercial_invoice: "invoice",
  disposal_ticket_waste_disposal_receipt: "disposal_ticket",
  freight_and_oilfield_manifest: "manifest",
};

/**
 * Package keys longer than the register's 40-character definition key. The
 * short key is ours; `sourcePackageKey` keeps the package's own, so nothing
 * about provenance is lost by the rename.
 */
export const PACKAGE_KEY_RENAMES: Readonly<Record<string, string>> = {
  equipment_rental_contract_and_inventory_log: "equipment_rental_contract",
  dot_fmcsa_registration_and_authority_record: "dot_fmcsa_registration_authority",
  dot_roadside_inspection_compliance_record: "dot_roadside_inspection_record",
  environmental_compliance_spill_reporting_form: "environmental_spill_reporting_form",
  environmental_corrective_action_and_closeout_record: "environmental_corrective_action",
  spill_response_and_site_inspection_checklist: "spill_response_inspection_checklist",
  norm_material_classification_and_disposition_record: "norm_material_classification",
  hazardous_waste_manifest_e_manifest_tracking_log: "hazardous_waste_manifest_tracking_log",
  oilfield_waste_profile_and_characterization_record: "oilfield_waste_profile",
  oilfield_waste_tracking_generator_compliance_form: "oilfield_waste_tracking_form",
  waste_load_and_container_inspection_checklist: "waste_load_inspection_checklist",
  waste_manifest_hazardous_waste_manifest_internal_record: "waste_manifest_internal_record",
};

const ALL_PRODUCING_ORIGINS: OriginKind[] = ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered", "system_rendered", "external_scanned", "external_digital_import"];
const RECEIVED_ONLY_ORIGINS: OriginKind[] = ["external_scanned", "external_digital_import"];

const CATALOG_SOURCE = "document_control_template_catalog_2026-09-23";
const SYSTEM_SOURCE = "leaseos_system_definition (0178)";

const NOTICE_INTERNAL_COMPLIANCE = "Internal LeaseOS compliance record. Not an official FMCSA, DOT or other agency form or filing.";
const NOTICE_WASTE_MANIFEST = "Internal companion record. Not the official EPA Uniform Hazardous Waste Manifest; where an official manifest or e-Manifest applies, attach or link the official record.";
const NOTICE_TRACKING_LOG = "Internal tracking log. Not the official manifest; the official record is linked, not replaced.";
const NOTICE_JURISDICTION = "Internal record. Jurisdiction-specific requirements are not established by this template; verify them for the operating jurisdiction.";

/**
 * The definitions LeaseOS itself needs before any catalog is imported: the ten
 * document kinds 0144 seeded as categories, the received-document kinds the
 * extraction engine already classifies, and the home of anything that arrives
 * unrecognised. Migration 0178 inserts these same rows; the seeder re-asserts
 * them so the two cannot drift.
 */
export const SYSTEM_DEFINITIONS: readonly DocumentDefinitionSeed[] = [
  def({ definitionKey: "invoice", documentClass: "financial_commercial", displayName: "Invoice", primaryDomainOwner: "billing", allowedOrigins: ["system_rendered", "leaseos_generated", "organization_template"], numberingPolicy: "domain_managed", numberSeriesType: "INV", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["customer_po", "afe", "customer_job_number"], signaturePolicy: "domain_managed", revisionPolicy: "domain_managed", readCategory: "commercial", allowedLinkKinds: ["job", "invoice", "customer", "customer_account", "billing_book", "field_ticket", "load"], importAllowed: false, description: "The tenant's invoice to a customer, rendered from the frozen billing snapshot. Numbered by invoicing." }),
  def({ definitionKey: "credit_note", documentClass: "financial_commercial", displayName: "Credit note", primaryDomainOwner: "billing", allowedOrigins: ["system_rendered", "leaseos_generated"], numberingPolicy: "domain_managed", numberSeriesType: "CR", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["customer_po"], signaturePolicy: "domain_managed", revisionPolicy: "domain_managed", readCategory: "commercial", allowedLinkKinds: ["invoice", "customer", "customer_account", "job"], importAllowed: false }),
  def({ definitionKey: "statement", documentClass: "financial_commercial", displayName: "Statement of account", primaryDomainOwner: "billing", allowedOrigins: ["system_rendered"], numberingPolicy: "archival_only", externalReferencePolicy: "forbidden", signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "commercial", allowedLinkKinds: ["customer", "customer_account", "financial_entity"], importAllowed: false }),
  def({ definitionKey: "manifest", documentClass: "regulated_record", displayName: "Manifest / chain of custody", primaryDomainOwner: "custody", allowedOrigins: ALL_PRODUCING_ORIGINS, numberingPolicy: "domain_managed", numberSeriesType: "MRO", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["manifest_number", "regulatory_identifier", "generator_id", "transporter_id"], signaturePolicy: "domain_managed", revisionPolicy: "domain_managed", printPolicy: "controlled_copy", readCategory: "job_operational", allowedLinkKinds: ["job", "trip", "load", "manifest", "unit", "operator", "facility", "customer"], description: "The custody record. Sealed by departure; changed only by a two-person amendment." }),
  def({ definitionKey: "field_ticket", documentClass: "operational_form", displayName: "Field ticket", primaryDomainOwner: "closeout", allowedOrigins: ["system_rendered", "leaseos_generated", "organization_template", "customer_template", "external_scanned"], numberingPolicy: "domain_managed", numberSeriesType: "FT", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["customer_po", "afe", "customer_job_number"], signaturePolicy: "domain_managed", revisionPolicy: "domain_managed", readCategory: "job_operational", allowedLinkKinds: ["job", "trip", "load", "field_ticket", "unit", "operator", "customer", "customer_account", "billing_book", "invoice"], description: "The customer-signed service record. Revisions are frozen snapshots owned by closeout." }),
  def({ definitionKey: "disposal_ticket", documentClass: "operational_form", displayName: "Disposal / facility ticket", primaryDomainOwner: "disposal", allowedOrigins: ALL_PRODUCING_ORIGINS, numberingPolicy: "domain_managed", numberSeriesType: "DSP", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["facility_ticket_number", "scale_ticket_number", "manifest_number"], signaturePolicy: "optional", revisionPolicy: "domain_managed", readCategory: "job_operational", extractionProfileKey: "disposal_ticket", allowedLinkKinds: ["job", "trip", "load", "disposal_ticket", "manifest", "unit", "operator", "facility", "customer", "billing_book"], description: "LeaseOS's record of a disposal. The facility's own paper is a separate external_disposal_receipt linked to it." }),
  def({ definitionKey: "vendor_bill", documentClass: "financial_commercial", displayName: "Vendor bill", primaryDomainOwner: "billing", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "external_only", externalReferencePolicy: "required", allowedExternalReferenceTypes: ["supplier_invoice_number", "customer_po"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "commercial", allowedLinkKinds: ["vendor", "organization", "financial_entity", "work_order", "purchase_order", "unit", "job"], description: "A supplier's invoice to the tenant. The supplier's number is the number." }),
  def({ definitionKey: "purchase_order", documentClass: "financial_commercial", displayName: "Purchase order", primaryDomainOwner: "billing", allowedOrigins: ["system_rendered", "leaseos_generated", "organization_template"], numberingPolicy: "domain_managed", numberSeriesType: "PO", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["other"], signaturePolicy: "optional", revisionPolicy: "immutable_supersede", readCategory: "commercial", allowedLinkKinds: ["vendor", "organization", "financial_entity", "unit", "job", "purchase_order"], importAllowed: false }),
  def({ definitionKey: "remittance", documentClass: "financial_commercial", displayName: "Remittance advice", primaryDomainOwner: "billing", allowedOrigins: ["system_rendered", "external_digital_import", "external_scanned"], numberingPolicy: "archival_only", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["other"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "commercial", allowedLinkKinds: ["customer", "customer_account", "invoice", "vendor", "financial_entity"] }),
  def({ definitionKey: "audit_package", documentClass: "reference_document", displayName: "Audit package", primaryDomainOwner: "document_control", allowedOrigins: ["system_rendered"], numberingPolicy: "archival_only", externalReferencePolicy: "forbidden", signaturePolicy: "none", revisionPolicy: "immutable_supersede", printPolicy: "controlled_copy", readCategory: "legal", allowedLinkKinds: ["job", "unit", "operator", "customer", "incident", "vendor", "financial_entity"], importAllowed: false, description: "A released package asserts nothing new; it names and hashes what the chain holds." }),
  def({ definitionKey: "external_disposal_receipt", documentClass: "operational_form", displayName: "External disposal receipt (facility-issued)", primaryDomainOwner: "disposal", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "external_only", externalReferencePolicy: "required", allowedExternalReferenceTypes: ["facility_ticket_number", "scale_ticket_number", "manifest_number"], signaturePolicy: "none", revisionPolicy: "amend_with_reason", readCategory: "job_operational", extractionProfileKey: "disposal_ticket", allowedLinkKinds: ["job", "trip", "load", "disposal_ticket", "manifest", "unit", "operator", "facility"], description: "The facility's own ticket, as handed to the driver. Its number is the facility's; LeaseOS never mints one for it." }),
  def({ definitionKey: "scale_ticket", documentClass: "operational_form", displayName: "Scale ticket (externally issued)", primaryDomainOwner: "disposal", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "external_only", externalReferencePolicy: "required", allowedExternalReferenceTypes: ["scale_ticket_number", "facility_ticket_number"], signaturePolicy: "none", revisionPolicy: "amend_with_reason", readCategory: "job_operational", extractionProfileKey: "disposal_ticket", allowedLinkKinds: ["job", "trip", "load", "disposal_ticket", "unit", "operator", "facility"] }),
  def({ definitionKey: "fuel_receipt", documentClass: "financial_commercial", displayName: "Fuel receipt", primaryDomainOwner: "expense", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "archival_only", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["receipt_number"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "commercial", extractionProfileKey: "fuel_receipt", allowedLinkKinds: ["fuel_transaction", "expense_record", "unit", "operator", "trip", "job", "financial_entity"], description: "A vendor's slip. The fuel transaction it evidences is the fact; the receipt is not a deduction." }),
  def({ definitionKey: "expense_receipt", documentClass: "financial_commercial", displayName: "Expense receipt", primaryDomainOwner: "expense", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "archival_only", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["receipt_number"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "commercial", extractionProfileKey: "expense_receipt", allowedLinkKinds: ["expense_record", "operator", "user", "trip", "job", "financial_entity"] }),
  def({ definitionKey: "unclassified_external_document", documentClass: "unclassified", displayName: "Unclassified external document", primaryDomainOwner: "document_control", allowedOrigins: RECEIVED_ONLY_ORIGINS, numberingPolicy: "archival_only", externalReferencePolicy: "optional", allowedExternalReferenceTypes: ["other"], signaturePolicy: "none", revisionPolicy: "immutable_supersede", readCategory: "job_operational", allowedLinkKinds: ["job", "trip", "load", "unit", "operator", "facility", "customer"], description: "Where a scan or upload lives until a person says what it is. Never dropped for failing to match a template." }),
];

function def(p: Partial<DocumentDefinitionSeed> & Pick<DocumentDefinitionSeed, "definitionKey" | "documentClass" | "displayName" | "primaryDomainOwner" | "allowedOrigins" | "numberingPolicy" | "externalReferencePolicy" | "signaturePolicy" | "revisionPolicy" | "readCategory" | "allowedLinkKinds">): DocumentDefinitionSeed {
  return {
    description: null,
    numberSeriesType: null,
    allowedExternalReferenceTypes: [],
    leaseosTemplateAvailable: false,
    customTemplateAllowed: true,
    importAllowed: p.allowedOrigins.some(o => EXTERNAL_ORIGINS.includes(o)),
    requiredFields: [],
    optionalFields: [],
    printPolicy: "printable",
    extractionProfileKey: null,
    sensitivityTier: "INTERNAL",
    jurisdictions: ["*"],
    jurisdictionPolicy: "universal",
    regulatoryBasis: "not_inferred_from_template",
    representationPolicy: "internal_record",
    representationNotice: null,
    industries: [],
    packKey: "core",
    sourcePackageKey: null,
    source: SYSTEM_SOURCE,
    ...p,
  };
}

/** One entry of `data/document-control/document_definitions.seed.json`, as supplied. */
export type PackageVariant = { variant: number; source_collection: string; files: string[]; template_code_or_doc_ref: string | null; revision_detected: string | null; pages: number | null; sha256_pdf?: string; sha256_docx?: string };
export type PackageDefinitionEntry = {
  document_definition_key: string;
  display_name: string;
  category: string;
  template_available: boolean;
  template_required_for_document_control: boolean;
  scan_import_allowed: boolean;
  supported_origins: string[];
  numbering_policy_candidate: string;
  jurisdiction_policy: string;
  regulatory_authority: string;
  structured_definition_seed: { source_key: string; version: number; field_count: number; family: string; packKey: string; ownerType: string } | null;
  variants: PackageVariant[];
};

export const PACKAGE_CATEGORIES = ["safety_daily_operations", "incident_evidence", "freight_transportation", "oilfield_waste", "carrier_compliance_permits", "norm_radiological", "environmental_compliance", "assets_niche"] as const;
export type PackageCategory = (typeof PACKAGE_CATEGORIES)[number];

const REQUIRED_MULTI_SIGNATURE = new Set(["job_safety_analysis", "tailgate_meeting_log", "toolbox_talk", "safety_meeting_minutes", "pre_job_safety_checklist", "hazard_assessment"]);
const REQUIRED_SINGLE_SIGNATURE = new Set(["bill_of_lading", "proof_of_delivery", "rate_and_load_confirmation", "lumber_hotshot_delivery_ticket", "waste_pickup_transfer_ticket", "oilfield_load_ticket_load_record", "norm_material_transfer_chain_of_custody", "hazard_communication_sds_acknowledgment", "equipment_rental_contract_and_inventory_log", "returnable_asset_tracking_rental_receipt"]);
const CONFIDENTIAL_KEYS = new Set(["accident_investigation_report", "injury_report"]);

/** Package structured seeds map onto FORMS keys that Checkpoint E adds; recorded here so extraction knows the profile. */
const STRUCTURED_FORM_KEYS: Readonly<Record<string, string>> = {
  environmental_compliance_spill_reporting_form: "environmental_spill_report",
  norm_survey_and_handling_record: "norm_survey_handling",
  oilfield_waste_tracking_generator_compliance_form: "oilfield_waste_tracking_generator",
};

/** A detected template code is a series type only when it is a clean short token. "FOR" is the word FORM, mis-read. */
export function seriesTypeFromTemplateCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(c) || c === "FOR") return null;
  return c;
}

function classFor(category: PackageCategory, key: string): DocumentClass {
  switch (category) {
    case "safety_daily_operations": return "operational_form";
    case "incident_evidence": return "incident_evidence";
    case "freight_transportation": return key === "commercial_invoice" ? "financial_commercial" : "operational_form";
    case "oilfield_waste": return key === "hazardous_waste_manifest_e_manifest_tracking_log" || key === "waste_manifest_hazardous_waste_manifest_internal_record" ? "regulated_record" : "operational_form";
    case "carrier_compliance_permits": return "regulated_record";
    case "norm_radiological": return "regulated_record";
    case "environmental_compliance": return /incident_report|spill_reporting_form/.test(key) ? "incident_evidence" : "regulated_record";
    case "assets_niche": return key === "equipment_rental_contract_and_inventory_log" || key === "returnable_asset_tracking_rental_receipt" ? "financial_commercial" : "operational_form";
  }
}

function ownerFor(category: PackageCategory, key: string): PrimaryDomainOwner {
  switch (category) {
    case "safety_daily_operations": return "safety";
    case "incident_evidence": return "safety";
    case "freight_transportation": return key === "commercial_invoice" ? "billing" : "document_control";
    case "oilfield_waste":
      if (key === "oilfield_load_ticket_load_record") return "closeout";
      if (/disposal|waste_pickup/.test(key)) return "disposal";
      if (/manifest/.test(key)) return "custody";
      return "document_control";
    case "carrier_compliance_permits": return "compliance";
    case "norm_radiological": return "safety";
    case "environmental_compliance": return "safety";
    case "assets_niche":
      if (key === "lumber_hotshot_delivery_ticket") return "closeout";
      if (key === "hazard_communication_sds_acknowledgment") return "safety";
      return "fleet";
  }
}

function readCategoryFor(category: PackageCategory): ReadCategory {
  switch (category) {
    case "safety_daily_operations": case "incident_evidence": case "norm_radiological": case "environmental_compliance": return "safety_summary";
    case "freight_transportation": case "oilfield_waste": return "job_operational";
    case "carrier_compliance_permits": return "legal";
    case "assets_niche": return "commercial";
  }
}

function linkKindsFor(category: PackageCategory): DocumentLinkKind[] {
  switch (category) {
    case "safety_daily_operations": return ["job", "operator", "unit", "safety_meeting", "customer", "facility"];
    case "incident_evidence": return ["job", "operator", "unit", "incident", "near_miss", "customer", "facility"];
    case "freight_transportation": return ["job", "load", "trip", "unit", "operator", "customer", "customer_account", "invoice", "facility"];
    case "oilfield_waste": return ["job", "load", "trip", "unit", "operator", "facility", "disposal_ticket", "manifest", "customer"];
    case "carrier_compliance_permits": return ["organization", "unit", "operator", "financial_entity"];
    case "norm_radiological": return ["job", "load", "unit", "facility", "operator", "equipment", "material"];
    case "environmental_compliance": return ["job", "incident", "unit", "operator", "facility"];
    case "assets_niche": return ["job", "unit", "equipment", "customer", "vendor", "load"];
  }
}

function externalTypesFor(category: PackageCategory, key: string): ExternalReferenceType[] {
  if (category === "carrier_compliance_permits") return ["regulatory_identifier", "policy_number", "permit_number", "certificate_number"];
  if (category === "oilfield_waste") return ["facility_ticket_number", "scale_ticket_number", "manifest_number", "generator_id", "transporter_id", "regulatory_identifier"];
  if (category === "freight_transportation") return ["bol_number", "customer_po", "afe", "customer_job_number", "scale_ticket_number"];
  if (category === "norm_radiological") return ["regulatory_identifier", "manifest_number", "certificate_number"];
  if (category === "environmental_compliance") return ["regulatory_identifier"];
  if (category === "incident_evidence") return ["regulatory_identifier"];
  if (key === "lumber_hotshot_delivery_ticket") return ["customer_po", "customer_job_number"];
  if (key === "equipment_rental_contract_and_inventory_log" || key === "returnable_asset_tracking_rental_receipt") return ["customer_po", "other"];
  return [];
}

function representationFor(category: PackageCategory, key: string): { policy: RepresentationPolicy; notice: string | null } {
  if (category === "carrier_compliance_permits") return { policy: "internal_record", notice: NOTICE_INTERNAL_COMPLIANCE };
  if (key === "waste_manifest_hazardous_waste_manifest_internal_record") return { policy: "attach_official_record_required", notice: NOTICE_WASTE_MANIFEST };
  if (key === "hazardous_waste_manifest_e_manifest_tracking_log") return { policy: "internal_record", notice: NOTICE_TRACKING_LOG };
  if (category === "norm_radiological" || category === "environmental_compliance" || category === "oilfield_waste") return { policy: "internal_record", notice: NOTICE_JURISDICTION };
  return { policy: "internal_record", notice: null };
}

/**
 * Turn a supplied catalog entry into a definition row. The package's candidate
 * vocabulary is translated, not adopted: `CONTROLLED_SEQUENCE_CANDIDATE`
 * becomes a series the tenant may enable, and anything the package marked for
 * review lands on the archival ref only — the option that fabricates nothing.
 *
 * Returns null for an aliased key: its templates attach to the existing
 * definition and no new definition is created.
 */
export function definitionFromPackageEntry(entry: PackageDefinitionEntry): DocumentDefinitionSeed | null {
  if (PACKAGE_DEFINITION_ALIASES[entry.document_definition_key]) return null;
  const key = entry.document_definition_key;
  const definitionKey = resolvePackageKey(key);
  if (!DEFINITION_KEY_PATTERN.test(definitionKey)) throw new Error(`Catalog key "${key}" resolves to "${definitionKey}", which is not a valid definition key`);
  const category = entry.category as PackageCategory;
  if (!PACKAGE_CATEGORIES.includes(category)) throw new Error(`Catalog entry ${key} has unknown category "${entry.category}"`);

  let numberingPolicy: NumberingPolicy;
  let externalReferencePolicy: ExternalReferencePolicy;
  switch (entry.numbering_policy_candidate) {
    case "CONTROLLED_SEQUENCE_CANDIDATE": numberingPolicy = "leaseos_series_optional"; externalReferencePolicy = "optional"; break;
    case "CONTROLLED_SEQUENCE_WITH_EXTERNAL_REFERENCES": numberingPolicy = "leaseos_series_optional"; externalReferencePolicy = "optional"; break;
    case "INTERNAL_CONTROL_NUMBER_PLUS_OFFICIAL_EXTERNAL_REFERENCE_WHEN_APPLICABLE": numberingPolicy = "leaseos_series_optional"; externalReferencePolicy = "optional"; break;
    case "ARCHIVAL_OR_EXTERNAL_REFERENCE_REVIEW_REQUIRED": numberingPolicy = "archival_only"; externalReferencePolicy = "optional"; break;
    default: throw new Error(`Catalog entry ${key} has unknown numbering candidate "${entry.numbering_policy_candidate}"`);
  }
  const externalTypes = externalTypesFor(category, key);
  if (externalTypes.length === 0) externalReferencePolicy = "forbidden";

  const codes = entry.variants.map(v => seriesTypeFromTemplateCode(v.template_code_or_doc_ref)).filter((c): c is string => !!c);
  const numberSeriesType = MINTING_POLICIES.includes(numberingPolicy) && codes.length ? codes[0]! : null;

  const rep = representationFor(category, key);
  const documentClass = classFor(category, key);
  return {
    definitionKey,
    documentClass,
    displayName: entry.display_name,
    description: null,
    primaryDomainOwner: ownerFor(category, key),
    allowedOrigins: entry.scan_import_allowed ? [...ALL_PRODUCING_ORIGINS] : ALL_PRODUCING_ORIGINS.filter(o => !EXTERNAL_ORIGINS.includes(o)),
    numberingPolicy,
    numberSeriesType,
    externalReferencePolicy,
    allowedExternalReferenceTypes: externalTypes,
    leaseosTemplateAvailable: entry.template_available,
    customTemplateAllowed: true,
    importAllowed: entry.scan_import_allowed,
    requiredFields: [],
    optionalFields: [],
    allowedLinkKinds: linkKindsFor(category),
    signaturePolicy: REQUIRED_MULTI_SIGNATURE.has(key) ? "required_multi" : REQUIRED_SINGLE_SIGNATURE.has(key) ? "required_single" : "optional",
    revisionPolicy: documentClass === "incident_evidence" ? "amend_with_reason" : "immutable_supersede",
    printPolicy: documentClass === "regulated_record" ? "controlled_copy" : "printable",
    extractionProfileKey: STRUCTURED_FORM_KEYS[key] ?? null,
    readCategory: readCategoryFor(category),
    sensitivityTier: CONFIDENTIAL_KEYS.has(key) ? "CONFIDENTIAL" : "INTERNAL",
    jurisdictions: category === "carrier_compliance_permits" ? ["US"] : ["*"],
    jurisdictionPolicy: entry.jurisdiction_policy === "CONFIGURABLE_VERIFY_BY_JURISDICTION" ? "configurable_verify_by_jurisdiction" : "universal",
    regulatoryBasis: "not_inferred_from_template",
    representationPolicy: rep.policy,
    representationNotice: rep.notice,
    industries: category === "oilfield_waste" || category === "norm_radiological" ? ["oilfield"] : category === "freight_transportation" ? ["general_freight", "oilfield"] : [],
    packKey: category === "carrier_compliance_permits" ? "us" : "core",
    sourcePackageKey: key,
    source: `${CATALOG_SOURCE} (${category}/${key})`,
  };
}

/** The definition key a package key resolves to: itself, or the existing kind it aliases. */
export function resolvePackageKey(packageKey: string): string {
  return PACKAGE_DEFINITION_ALIASES[packageKey] ?? PACKAGE_KEY_RENAMES[packageKey] ?? packageKey;
}

/**
 * The invariants every definition row must satisfy before it is written.
 * Returned as named refusals rather than thrown, so a seed can report every
 * problem at once.
 */
export function definitionRefusals(d: DocumentDefinitionSeed): string[] {
  const out: string[] = [];
  if (!DEFINITION_KEY_PATTERN.test(d.definitionKey)) out.push(`key "${d.definitionKey}" is not a valid definition key`);
  if (d.allowedOrigins.length === 0) out.push(`${d.definitionKey}: no origin may produce it`);
  for (const o of d.allowedOrigins) if (!ORIGIN_KINDS.includes(o)) out.push(`${d.definitionKey}: unknown origin ${o}`);
  const hasExternal = d.allowedOrigins.some(o => EXTERNAL_ORIGINS.includes(o));
  if (hasExternal !== d.importAllowed) out.push(`${d.definitionKey}: importAllowed=${d.importAllowed} disagrees with its origins`);
  if (d.numberingPolicy === "external_only" && d.externalReferencePolicy !== "required") out.push(`${d.definitionKey}: external_only numbering needs a required external reference`);
  if (d.numberingPolicy === "external_only" && d.allowedOrigins.some(o => RENDERED_ORIGINS.includes(o))) out.push(`${d.definitionKey}: LeaseOS cannot render a document whose number belongs to an external issuer`);
  if (d.numberingPolicy === "domain_managed" && !d.numberSeriesType) out.push(`${d.definitionKey}: domain_managed numbering must name the domain's series`);
  if (d.numberingPolicy === "archival_only" && d.numberSeriesType) out.push(`${d.definitionKey}: archival_only numbering carries no series`);
  if (d.externalReferencePolicy === "forbidden" && d.allowedExternalReferenceTypes.length) out.push(`${d.definitionKey}: forbidden external references but types are listed`);
  if (d.externalReferencePolicy !== "forbidden" && !d.allowedExternalReferenceTypes.length) out.push(`${d.definitionKey}: external references allowed but no type is listed`);
  for (const t of d.allowedExternalReferenceTypes) if (!EXTERNAL_REFERENCE_TYPES.includes(t)) out.push(`${d.definitionKey}: unknown external reference type ${t}`);
  for (const k of d.allowedLinkKinds) if (!DOCUMENT_LINK_KINDS.includes(k)) out.push(`${d.definitionKey}: unknown link kind ${k}`);
  if (!READ_CATEGORIES.includes(d.readCategory)) out.push(`${d.definitionKey}: unknown read category ${d.readCategory}`);
  if (!PRIMARY_DOMAIN_OWNERS.includes(d.primaryDomainOwner)) out.push(`${d.definitionKey}: unknown domain owner ${d.primaryDomainOwner}`);
  if (d.representationPolicy === "attach_official_record_required" && !d.representationNotice) out.push(`${d.definitionKey}: a record that must carry the official one needs the notice that says so`);
  if (d.jurisdictions.length === 0) out.push(`${d.definitionKey}: no jurisdiction`);
  if (d.jurisdictions.some(j => !/^(\*|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/.test(j))) out.push(`${d.definitionKey}: jurisdiction codes must be "*" or ISO-3166 style`);
  if (!d.source) out.push(`${d.definitionKey}: no source`);
  return out;
}

/** The name a reader sees. The notice, when the definition carries one, is part of the name — not a footnote a screen may drop. */
export function representationLabel(d: Pick<DocumentDefinitionSeed, "displayName" | "representationPolicy" | "representationNotice">): string {
  return d.representationNotice ? `${d.displayName} — ${d.representationNotice}` : d.displayName;
}

/** The stored row, JSON columns as text — what drizzle hands back. */
export type DocumentDefinitionRow = {
  id: number; definitionRef: string; orgRef: string | null; scopeKey: string; definitionKey: string; definitionVersion: number; status: DefinitionStatus;
  documentClass: DocumentClass; displayName: string; description: string | null; primaryDomainOwner: string; allowedOriginsJson: string;
  numberingPolicy: NumberingPolicy; numberSeriesType: string | null; externalReferencePolicy: ExternalReferencePolicy; allowedExternalReferenceTypesJson: string;
  leaseosTemplateAvailable: boolean; customTemplateAllowed: boolean; importAllowed: boolean; requiredFieldsJson: string; optionalFieldsJson: string; allowedLinkKindsJson: string;
  signaturePolicy: SignaturePolicy; revisionPolicy: RevisionPolicy; printPolicy: PrintPolicy; extractionProfileKey: string | null; retentionPolicyId: number | null; workflowKey: string | null;
  readCategory: string; sensitivityTier: SensitivityTier; jurisdictionsJson: string; jurisdictionPolicy: JurisdictionPolicy; regulatoryBasis: RegulatoryBasis;
  representationPolicy: RepresentationPolicy; representationNotice: string | null; industriesJson: string; packKey: string | null; sourcePackageKey: string | null; source: string;
};

/** MariaDB returns JSON/text columns as strings; read them as the arrays they are, failing closed on anything else. */
export function jsonStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string") return [];
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/** The effective definition a reader sees: the platform row with the tenant overlay's permitted columns applied, and nothing else. */
export type EffectiveDefinition = DocumentDefinitionSeed & { definitionRef: string; definitionVersion: number; status: DefinitionStatus; retentionPolicyId: number | null; workflowKey: string | null; layer: "platform" | "tenant" | "tenant_authored"; overlayRef: string | null };

export function rowToDefinition(row: DocumentDefinitionRow): EffectiveDefinition {
  return {
    definitionRef: row.definitionRef, definitionVersion: row.definitionVersion, status: row.status,
    definitionKey: row.definitionKey, documentClass: row.documentClass, displayName: row.displayName, description: row.description,
    primaryDomainOwner: row.primaryDomainOwner as PrimaryDomainOwner, allowedOrigins: jsonStringArray(row.allowedOriginsJson) as OriginKind[],
    numberingPolicy: row.numberingPolicy, numberSeriesType: row.numberSeriesType, externalReferencePolicy: row.externalReferencePolicy,
    allowedExternalReferenceTypes: jsonStringArray(row.allowedExternalReferenceTypesJson) as ExternalReferenceType[],
    leaseosTemplateAvailable: row.leaseosTemplateAvailable, customTemplateAllowed: row.customTemplateAllowed, importAllowed: row.importAllowed,
    requiredFields: jsonStringArray(row.requiredFieldsJson), optionalFields: jsonStringArray(row.optionalFieldsJson), allowedLinkKinds: jsonStringArray(row.allowedLinkKindsJson) as DocumentLinkKind[],
    signaturePolicy: row.signaturePolicy, revisionPolicy: row.revisionPolicy, printPolicy: row.printPolicy, extractionProfileKey: row.extractionProfileKey,
    retentionPolicyId: row.retentionPolicyId, workflowKey: row.workflowKey, readCategory: row.readCategory as ReadCategory, sensitivityTier: row.sensitivityTier,
    jurisdictions: jsonStringArray(row.jurisdictionsJson), jurisdictionPolicy: row.jurisdictionPolicy, regulatoryBasis: row.regulatoryBasis,
    representationPolicy: row.representationPolicy, representationNotice: row.representationNotice, industries: jsonStringArray(row.industriesJson),
    packKey: row.packKey, sourcePackageKey: row.sourcePackageKey, source: row.source,
    layer: row.orgRef ? "tenant_authored" : "platform", overlayRef: null,
  };
}

/**
 * Apply a tenant overlay to a platform definition. Only the columns in
 * TENANT_OVERRIDABLE_COLUMNS move; `allowedLinkKinds` may only widen. A tenant
 * cannot loosen numbering, origins, signature, revision or sensitivity of a
 * platform definition — those are the invariants a reader of any tenant's
 * records relies on.
 */
export function applyOverlay(platform: EffectiveDefinition, overlay: DocumentDefinitionRow | null): EffectiveDefinition {
  if (!overlay) return platform;
  const o = rowToDefinition(overlay);
  const merged: EffectiveDefinition = { ...platform, layer: "tenant", overlayRef: overlay.definitionRef };
  merged.displayName = o.displayName;
  merged.description = o.description ?? platform.description;
  merged.customTemplateAllowed = o.customTemplateAllowed;
  merged.numberSeriesType = o.numberSeriesType ?? platform.numberSeriesType;
  merged.printPolicy = o.printPolicy;
  merged.retentionPolicyId = o.retentionPolicyId ?? platform.retentionPolicyId;
  merged.optionalFields = o.optionalFields.length ? o.optionalFields : platform.optionalFields;
  merged.allowedLinkKinds = Array.from(new Set([...platform.allowedLinkKinds, ...o.allowedLinkKinds]));
  merged.industries = o.industries.length ? o.industries : platform.industries;
  return merged;
}

/** The numbering policies a tenant may give a definition it authors itself. The others belong to LeaseOS's own domains. */
export const TENANT_AUTHORABLE_NUMBERING: readonly NumberingPolicy[] = ["leaseos_series_optional", "external_only", "archival_only"];

/** A stable digest of the policy columns, so a seeder can tell "unchanged" from "the constant moved". */
export function definitionPolicyDigest(d: DocumentDefinitionSeed): string {
  const canon = {
    documentClass: d.documentClass, displayName: d.displayName, description: d.description, primaryDomainOwner: d.primaryDomainOwner, allowedOrigins: [...d.allowedOrigins].sort(),
    numberingPolicy: d.numberingPolicy, numberSeriesType: d.numberSeriesType, externalReferencePolicy: d.externalReferencePolicy, allowedExternalReferenceTypes: [...d.allowedExternalReferenceTypes].sort(),
    leaseosTemplateAvailable: d.leaseosTemplateAvailable, customTemplateAllowed: d.customTemplateAllowed, importAllowed: d.importAllowed, requiredFields: d.requiredFields, optionalFields: d.optionalFields,
    allowedLinkKinds: [...d.allowedLinkKinds].sort(), signaturePolicy: d.signaturePolicy, revisionPolicy: d.revisionPolicy, printPolicy: d.printPolicy, extractionProfileKey: d.extractionProfileKey,
    readCategory: d.readCategory, sensitivityTier: d.sensitivityTier, jurisdictions: [...d.jurisdictions].sort(), jurisdictionPolicy: d.jurisdictionPolicy, regulatoryBasis: d.regulatoryBasis,
    representationPolicy: d.representationPolicy, representationNotice: d.representationNotice, industries: [...d.industries].sort(), packKey: d.packKey, sourcePackageKey: d.sourcePackageKey, source: d.source,
  };
  return JSON.stringify(canon);
}
