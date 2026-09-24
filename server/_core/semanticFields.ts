/**
 * Document Control — the semantic field registry (DC-E).
 *
 * One vocabulary for "the driver's name", "the unit number", "the job code",
 * so a LeaseOS standard form, a business's own PDF and a customer's form all
 * map their printed labels to the same authoritative LeaseOS value. Nothing
 * here is a new domain field: every auto-fillable key names the table and
 * column it is read from, and the noun is the repository's (`operator`, not
 * driver; `job.jobCode`; `unit.unitNumber`).
 *
 * Three authorities, and the line between them is the AI Secretary boundary
 * (design §11):
 *
 *   auto_fill   — read from LeaseOS Records; a rendering may pre-fill it.
 *   human_only  — a person types it: signatures, hazards, weights and
 *                 readings, acceptance, another issuer's number. No renderer
 *                 and no model supplies it.
 *   server_only — the server sets it at issue: the control number, the
 *                 archival ref, the issue timestamp. Neither a person nor a
 *                 template may supply it.
 *
 * Adding a key is a code change with a test. It is not tenant-configurable.
 */
import type { FieldType } from "./aiProposal";
import type { FieldMapping } from "./documentTemplates";

export type FieldAuthority = "auto_fill" | "human_only" | "server_only";

export type SemanticField = {
  key: string;
  label: string;
  type: FieldType;
  authority: FieldAuthority;
  /** `table.column` the value is read from, for auto_fill. */
  source: string | null;
  precisionSensitive?: boolean;
  note?: string;
};

const f = (key: string, label: string, type: FieldType, authority: FieldAuthority, source: string | null, extra: Partial<SemanticField> = {}): SemanticField => ({ key, label, type, authority, source, ...extra });

export const SEMANTIC_FIELDS: readonly SemanticField[] = [
  // The company issuing the paper.
  f("organization.legalName", "Company legal name", "text", "auto_fill", "organizations.name"),
  f("organization.orgRef", "Company reference", "text", "auto_fill", "organizations.orgRef"),
  // The job.
  f("job.jobCode", "Job code", "text", "auto_fill", "jobs.jobCode"),
  f("job.customer", "Customer (as captured on the job)", "text", "auto_fill", "jobs.customer"),
  f("job.location", "Site / lease / LSD (as captured on the job)", "text", "auto_fill", "jobs.location"),
  f("job.type", "Job type", "text", "auto_fill", "jobs.type"),
  // The people and iron.
  f("operator.id", "Operator id", "number", "auto_fill", "operators.id"),
  f("operator.name", "Operator (driver) name", "text", "auto_fill", "operators.name"),
  f("operator.company", "Operator's company", "text", "auto_fill", "operators.company"),
  f("unit.unitNumber", "Unit number", "text", "auto_fill", "units.unitNumber"),
  f("unit.plate", "Unit plate", "text", "auto_fill", "units.plate"),
  f("unit.vehicleType", "Unit type", "text", "auto_fill", "units.vehicleType"),
  f("trailer.number", "Trailer number", "text", "human_only", null, { note: "no trailer binding on a job or load exists yet; typed until one does" }),
  // The load, as recorded — not as measured on the day.
  f("load.loadNumber", "Load number", "text", "auto_fill", "loads.loadNumber"),
  f("load.material", "Material / product", "text", "auto_fill", "loads.material"),
  f("load.quantity", "Load quantity (as recorded on the load)", "quantity", "auto_fill", "loads.quantity", { precisionSensitive: true }),
  f("load.quantityUnit", "Load quantity unit", "text", "auto_fill", "loads.quantityUnit"),
  f("load.measurementMethod", "How the load quantity was measured", "text", "auto_fill", "loads.measurementMethod"),
  f("load.loadTicketNumber", "Load ticket number", "text", "auto_fill", "loads.loadTicketNumber"),
  // The facility.
  f("facility.id", "Facility id", "number", "auto_fill", "facilities.id"),
  f("facility.name", "Facility name", "text", "auto_fill", "facilities.name"),
  f("facility.legalLocation", "Facility legal location", "text", "auto_fill", "facilities.legalLocation"),
  f("facility.regulatorRef", "Facility regulator reference", "text", "auto_fill", "facilities.regulatorRef"),
  // The customer and the money references the office already holds.
  f("customer.name", "Customer account name", "text", "auto_fill", "customerAccounts.name"),
  f("customer.accountRef", "Customer account reference", "text", "auto_fill", "customerAccounts.accountRef"),
  f("billing.afeNumber", "AFE number (from the billing book)", "text", "auto_fill", "billingBooks.afeNumber"),
  f("billing.purchaseOrder", "Customer PO (from the billing book)", "text", "auto_fill", "billingBooks.purchaseOrder"),
  f("billing.costCenter", "Cost centre (from the billing book)", "text", "auto_fill", "billingBooks.costCenter"),
  // The document itself: set by the server at issue.
  f("document.documentRef", "LeaseOS file number (archival ref)", "text", "server_only", "commercialDocuments.documentRef"),
  f("document.controlNumber", "LeaseOS control number", "text", "server_only", "commercialDocuments.controlNumber"),
  f("document.issuedAt", "Issue date / time", "date", "server_only", "commercialDocuments.issuedAt"),
  f("document.title", "Document title", "text", "auto_fill", "commercialDocuments.title"),
  f("document.templateRevisionRef", "Template revision", "text", "server_only", "commercialDocuments.templateRevisionRef"),
  // What only a person may put on paper.
  f("signature.customerRepresentative", "Customer representative signature", "text", "human_only", null),
  f("signature.operator", "Operator signature", "text", "human_only", null),
  f("signature.supervisor", "Supervisor signature", "text", "human_only", null),
  f("meeting.attendees", "Attendees", "text", "human_only", null),
  f("hazard.description", "Hazards identified", "text", "human_only", null),
  f("hazard.controls", "Controls agreed", "text", "human_only", null),
  f("scale.grossKg", "Gross weight (kg)", "number", "human_only", null, { precisionSensitive: true }),
  f("scale.tareKg", "Tare weight (kg)", "number", "human_only", null, { precisionSensitive: true }),
  f("scale.netKg", "Net weight (kg)", "number", "human_only", null, { precisionSensitive: true }),
  f("external.facilityTicketNumber", "Facility ticket number (issued by the facility)", "text", "human_only", null, { precisionSensitive: true }),
  f("external.scaleTicketNumber", "Scale ticket number (issued by the scale)", "text", "human_only", null, { precisionSensitive: true }),
  f("external.issuedAt", "Date printed on the external document", "date", "human_only", null, { precisionSensitive: true }),
  f("acceptance.facility", "Facility acceptance", "text", "human_only", null),
  f("acceptance.customer", "Customer acceptance", "text", "human_only", null),
  f("reading.value", "Instrument reading", "number", "human_only", null, { precisionSensitive: true }),
  f("jurisdiction.code", "Jurisdiction", "text", "human_only", null, { note: "verified per operation; never inferred from a template" }),
  f("text.free", "Free text (typed)", "text", "human_only", null),
] as const;

const BY_KEY = new Map(SEMANTIC_FIELDS.map(s => [s.key, s]));
export function semanticField(key: string): SemanticField | undefined { return BY_KEY.get(key); }
export const SEMANTIC_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/** Every mapped key must exist; a printed field appears once; a server_only key may be mapped (the server fills it) but never marked as something a person supplies. */
export function mappingRefusals(m: FieldMapping): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fld of m.fields) {
    if (seen.has(fld.printedField)) out.push(`printed field "${fld.printedField}" is mapped twice`);
    seen.add(fld.printedField);
    if (fld.semanticKey === null) continue;
    if (!SEMANTIC_KEY_PATTERN.test(fld.semanticKey)) out.push(`"${fld.semanticKey}" is not a semantic key`);
    else if (!BY_KEY.has(fld.semanticKey)) out.push(`"${fld.semanticKey}" is not in the semantic registry`);
  }
  return out;
}

/** What a rendering may do with a mapped field. */
export function authorityOf(semanticKey: string | null): FieldAuthority { return semanticKey ? (BY_KEY.get(semanticKey)?.authority ?? "human_only") : "human_only"; }

/** The auto-fillable keys, grouped by the record they read, for the resolver and the screen. */
export function autoFillSources(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of SEMANTIC_FIELDS) if (s.authority === "auto_fill" && s.source) { const t = s.source.split(".")[0]!; (out[t] ??= []).push(s.key); }
  return out;
}
