/**
 * Document Control — the standard families' field mappings (DC-E).
 *
 * Printed labels, as they appear on the supplied forms (read from
 * `data/document-control/extracted_text`), mapped to the semantic registry.
 * A label that only a person can fill maps to a `human_only` key, or to
 * null when no registry key names it yet. A mapping is released as a new
 * template revision by the seeder — the empty revision 1 stays, retired,
 * and every document already rendered on it stays on it.
 *
 * Representative forms first: the freight and safety forms the office prints
 * daily, the disposal and load tickets of the vertical slice, and the four
 * markdown-rendered compliance records whose placeholders the present
 * renderer fills. The remaining families keep their empty revision until a
 * person maps them; nothing is guessed from a PDF.
 */
import type { FieldMapping } from "./documentTemplates";

const m = (fields: [printed: string, semanticKey: string | null, required?: boolean][]): FieldMapping => ({ version: 1, fields: fields.map(([printedField, semanticKey, required]) => ({ printedField, semanticKey, required: !!required })) });

/** Keyed by the family's template key (the package key). */
export const STANDARD_MAPPINGS: Readonly<Record<string, FieldMapping>> = {
  bill_of_lading: m([
    ["Company / issuer", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Issue date / time", "document.issuedAt"], ["Job / load no.", "load.loadNumber"],
    ["Customer PO / AFE", "billing.purchaseOrder"], ["Pickup address / lease / LSD", "job.location"], ["Consignee", "job.customer"], ["Driver", "operator.name", true], ["Unit / trailer", "unit.unitNumber", true],
    ["Total mass / unit", "load.quantity"], ["Quantity basis", "load.measurementMethod"], ["Shipper printed name / role", "signature.customerRepresentative"], ["Driver printed name", "signature.operator"], ["Receiver printed name / role", "acceptance.customer"],
  ]),
  proof_of_delivery: m([
    ["Company / issuer", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Job / load no.", "load.loadNumber"], ["Customer", "job.customer"], ["Delivery address / lease / LSD", "job.location"],
    ["Driver", "operator.name", true], ["Unit / trailer", "unit.unitNumber"], ["Received quantity / unit", "load.quantity"], ["Receiver printed name / role", "acceptance.customer"], ["Driver signature", "signature.operator"],
  ]),
  job_safety_analysis: m([
    ["Company", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Date / time", "document.issuedAt"], ["Site / lease / project", "job.location"], ["Job / dispatch", "job.jobCode"],
    ["Supervisor / assessor", "signature.supervisor", true], ["Units / equipment", "unit.unitNumber"], ["Job steps hazards and controls", "hazard.description", true], ["Controls and responsible person", "hazard.controls", true], ["Crew acknowledgement", "meeting.attendees", true],
  ]),
  tailgate_meeting_log: m([
    ["Company", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Date / time", "document.issuedAt"], ["Site / lease / project", "job.location"], ["Job / dispatch", "job.jobCode"],
    ["Supervisor / lead", "signature.supervisor", true], ["Hazards discussed", "hazard.description", true], ["Controls", "hazard.controls"], ["Attendees", "meeting.attendees", true],
  ]),
  daily_safety_report: m([
    ["Company", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Date", "document.issuedAt"], ["Site / lease / project", "job.location"], ["Job / dispatch", "job.jobCode"], ["Supervisor", "signature.supervisor", true], ["Units / equipment", "unit.unitNumber"],
  ]),
  incident_report: m([
    ["Company", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Date / time of incident", "external.issuedAt", true], ["Site / lease / location", "job.location"], ["Job / dispatch", "job.jobCode"], ["Unit", "unit.unitNumber"], ["Person reporting", "signature.operator", true], ["Description", "text.free", true],
  ]),
  oilfield_load_ticket_load_record: m([
    ["Company / issuer", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Job / load no.", "load.loadNumber", true], ["Customer", "job.customer"], ["Lease / LSD", "job.location"], ["Driver", "operator.name", true], ["Unit", "unit.unitNumber", true],
    ["Product", "load.material"], ["Quantity / unit", "load.quantity"], ["Measurement", "load.measurementMethod"], ["Customer PO / AFE", "billing.afeNumber"], ["Customer representative", "signature.customerRepresentative"],
  ]),
  disposal_ticket_waste_disposal_receipt: m([
    ["Company / issuer", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Job / load no.", "load.loadNumber", true], ["Disposal facility", "facility.name", true], ["Facility ticket no.", "external.facilityTicketNumber"],
    ["Driver", "operator.name", true], ["Unit", "unit.unitNumber", true], ["Product / waste stream", "load.material"], ["Gross (kg)", "scale.grossKg"], ["Tare (kg)", "scale.tareKg"], ["Net (kg)", "scale.netKg"], ["Facility acceptance", "acceptance.facility"],
  ]),
  waste_pickup_transfer_ticket: m([
    ["Company / issuer", "organization.legalName", true], ["Record no.", "document.controlNumber"], ["Job / load no.", "load.loadNumber"], ["Generator / lease", "job.location"], ["Driver", "operator.name", true], ["Unit", "unit.unitNumber", true], ["Waste stream", "load.material"], ["Quantity / unit", "load.quantity"], ["Receiving facility", "facility.name"], ["Receiver signature", "acceptance.facility"],
  ]),
  lumber_hotshot_delivery_ticket: m([
    ["Company / issuer", "organization.legalName", true], ["Ticket no.", "document.controlNumber"], ["Job", "job.jobCode"], ["Customer", "job.customer"], ["Delivery location", "job.location"], ["Driver", "operator.name", true], ["Unit", "unit.unitNumber"], ["Customer PO", "billing.purchaseOrder"], ["Received by", "acceptance.customer"],
  ]),
  // The four markdown-rendered compliance records: placeholders as printed fields.
  dot_fmcsa_registration_and_authority_record: m([
    ["title", "document.title"], ["documentRef", "document.documentRef"], ["carrierLegalName", "organization.legalName", true], ["jurisdiction", "jurisdiction.code", true], ["verificationStatus", null], ["usdotNumber", null], ["mcNumber", null],
  ]),
  environmental_compliance_spill_reporting_form: m([
    ["title", "document.title"], ["incidentRef", "document.documentRef"], ["jurisdiction", "jurisdiction.code", true], ["reportingCompany", "organization.legalName"], ["siteOrLeaseName", "job.location"], ["unitNumber", "unit.unitNumber"], ["driverName", "operator.name"], ["releaseVolume", "reading.value"], ["verificationStatus", null],
  ]),
  norm_survey_and_handling_record: m([
    ["title", "document.title"], ["documentRef", "document.documentRef"], ["jurisdiction", "jurisdiction.code", true], ["siteOrLeaseName", "job.location"], ["wellOrEquipmentId", "unit.unitNumber"], ["surveyorName", "signature.supervisor"], ["backgroundReading", "reading.value"], ["maxGammaReading", "reading.value"], ["handlingStatus", null],
  ]),
  oilfield_waste_tracking_generator_compliance_form: m([
    ["title", "document.title"], ["documentRef", "document.documentRef"], ["jurisdiction", "jurisdiction.code", true], ["generatorLegalName", "organization.legalName"], ["leaseOrSiteName", "job.location"], ["transporterName", "organization.legalName"],
    ["driverName", "operator.name"], ["unitNumber", "unit.unitNumber"], ["wasteType", "load.material"], ["quantity", "load.quantity"], ["quantityUnit", "load.quantityUnit"], ["destinationFacilityName", "facility.name"], ["destinationFacilityId", "facility.regulatorRef"], ["receivingTicketNumber", "external.facilityTicketNumber"], ["pickupDate", "external.issuedAt"], ["verificationStatus", null],
  ]),
};
