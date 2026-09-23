/**
 * Document Control — the register's rules (DC-B, 0179).
 *
 * The authoritative controlled record is the 0144 `commercialDocuments` row,
 * extended with what a reader must always be able to tell: how the document
 * came to exist (`originKind`), who issued it (`issuerKind` + resolution),
 * which definition governs it, whether it carries a LeaseOS control number,
 * and where it is in its review/issue lifecycle (`controlState`). This module
 * holds the pure rules; `documentRegisterService` applies them inside a
 * transaction.
 *
 * Three rules never bend:
 *   1. LeaseOS is never the issuer. A LeaseOS-rendered ticket is issued by the tenant.
 *   2. An externally issued document never carries a LeaseOS-minted number.
 *   3. An external document cannot skip confirmation; a rendered one enters issued.
 */
import { createHash } from "node:crypto";
import {
  EXTERNAL_ORIGINS, MINTING_POLICIES, RENDERED_ORIGINS, TEMPLATE_ORIGINS,
  type DocumentLinkKind, type EffectiveDefinition, type ExternalReferenceType, type IssuerKind, type OriginKind,
} from "./documentDefinitions";

export const CONTROL_STATES = ["captured", "needs_classification", "proposed", "confirmed", "issued", "void", "withdrawn"] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

export const IMPORT_CHANNELS = ["device_sync", "office_upload", "portal", "api", "email", "system"] as const;
export type ImportChannel = (typeof IMPORT_CHANNELS)[number];

export const REFERENCE_SOURCES = ["ocr_proposed", "human_entered", "portal_submitted", "api_imported", "domain_mirrored"] as const;
export type ReferenceSource = (typeof REFERENCE_SOURCES)[number];

export const CONFIRMATION_STATUSES = ["proposed", "confirmed", "rejected"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const LINK_SOURCES = ["human", "domain", "ocr_proposed"] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];
export const LINK_CONFIRMATIONS = ["proposed", "confirmed"] as const;

export const LINK_ROLES = ["subject", "supporting", "origin_ticket", "scale_ticket", "facility_acceptance", "signature", "photo", "authorization", "attachment", "official_record"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** Every write to the register appends one of these; the timeline is read from them, never inferred from the row. */
export const DOCUMENT_EVENT_TYPES = [
  "document.captured", "document.classified", "document.proposed", "document.confirmed", "document.issued", "document.superseded", "document.withdrawn", "document.voided",
  "document.amended", "document.reference_added", "document.reference_confirmed", "document.reference_rejected", "document.link_added", "document.link_confirmed", "document.link_removed",
  "document.number_reserved", "document.number_issued", "document.number_voided", "document.printed", "document.reprinted", "document.viewed", "document.downloaded", "document.template_bound",
] as const;
export type DocumentEventType = (typeof DOCUMENT_EVENT_TYPES)[number];

export type IssuerInput = { issuerKind: IssuerKind; issuerOrgRef?: string | null; issuerFacilityId?: number | null; issuerName?: string | null };

/** The issuer as a comparison key: a facility by id, an organization by ref, else the normalised name, else unknown. Two facilities may both issue "12345". */
export function issuerScopeKey(i: IssuerInput): string {
  if (i.issuerFacilityId != null) return `facility:${i.issuerFacilityId}`;
  if (i.issuerOrgRef) return `org:${i.issuerOrgRef}`;
  if (i.issuerName && i.issuerName.trim()) return `name:${normaliseIssuerName(i.issuerName)}`;
  return `unknown:${i.issuerKind}`;
}

export function normaliseIssuerName(name: string): string {
  return name.toLowerCase().replace(/\b(inc|ltd|llc|corp|co|limited|incorporated|company)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** A reference value as compared: trimmed, upper-cased, internal whitespace collapsed. The raw form is kept beside it. */
export function normaliseReferenceValue(v: string): string {
  return v.trim().replace(/\s+/g, " ").toUpperCase();
}

export const DOCUMENT_REF_HASH = (s: string) => createHash("sha256").update(s).digest("hex");

/** The disposal domain's own `source` words, translated to an origin. Its column is not migrated; the register says the same thing in the one vocabulary. */
export const ORIGIN_FROM_DISPOSAL_SOURCE: Readonly<Record<string, OriginKind>> = { photo_ocr: "external_scanned", facility_portal: "external_digital_import" };

export type RegisterInput = {
  definition: EffectiveDefinition;
  originKind: OriginKind;
  issuer: IssuerInput;
  templateRevisionRef: string | null;
  controlNumber: string | null;
  requestedState: ControlState;
  externalReferences: { referenceType: ExternalReferenceType | string; referenceValue: string }[];
  links: { recordType: DocumentLinkKind | string }[];
  evidenceRecordId: number | null;
  fieldTicketDocumentId: number | null;
  storageKey: string | null;
};

/**
 * The invariants of §5 of the design, as named refusals. Every register write
 * runs this; the service adds the checks that need the database (scope,
 * duplicate content, existing rows).
 */
export function registerRefusals(input: RegisterInput): string[] {
  const out: string[] = [];
  const d = input.definition;
  if (d.status !== "active") out.push(`definition ${d.definitionKey} is ${d.status}`);
  if (!d.allowedOrigins.includes(input.originKind)) out.push(`definition ${d.definitionKey} does not allow origin ${input.originKind}`);
  const rendered = RENDERED_ORIGINS.includes(input.originKind);
  const external = EXTERNAL_ORIGINS.includes(input.originKind);
  if (rendered && input.issuer.issuerKind !== "tenant") out.push(`a ${input.originKind} document is issued by the tenant; LeaseOS never issues and never presents a third party as having issued what it rendered`);
  if (TEMPLATE_ORIGINS.includes(input.originKind) && !input.templateRevisionRef) out.push(`origin ${input.originKind} needs the template revision it was rendered from`);
  if (!TEMPLATE_ORIGINS.includes(input.originKind) && input.templateRevisionRef) out.push(`origin ${input.originKind} has no template; a template revision was given`);
  if (external && !d.importAllowed) out.push(`definition ${d.definitionKey} does not accept imported or scanned documents`);
  if (external && input.issuer.issuerKind === "tenant" && input.originKind !== "external_scanned") out.push(`an imported document issued by the tenant itself is a rendering or a scan, not an import`);
  if (input.controlNumber) {
    if (!MINTING_POLICIES.includes(d.numberingPolicy) && d.numberingPolicy !== "domain_managed") out.push(`definition ${d.definitionKey} (${d.numberingPolicy}) carries no LeaseOS control number`);
    if (input.issuer.issuerKind !== "tenant") out.push(`a control number can only belong to a document the tenant issued; this one is issued by ${input.issuer.issuerKind}`);
    if (external) out.push(`an ${input.originKind} document never carries a LeaseOS control number`);
  }
  if (d.numberingPolicy === "leaseos_series" && input.requestedState === "issued" && !input.controlNumber) out.push(`definition ${d.definitionKey} requires a control number before issue`);
  if (d.numberingPolicy === "domain_managed" && input.requestedState === "issued" && !input.controlNumber) out.push(`definition ${d.definitionKey} is numbered by its domain (${d.numberSeriesType}); register it with that number`);
  if (external && (input.requestedState === "issued")) out.push(`an external document is confirmed, never issued: LeaseOS did not produce it`);
  if (rendered && !["issued", "proposed"].includes(input.requestedState)) out.push(`a rendered document enters issued (or proposed, when it awaits a signature), not ${input.requestedState}`);
  if (d.externalReferencePolicy === "forbidden" && input.externalReferences.length) out.push(`definition ${d.definitionKey} carries no external references`);
  if (d.externalReferencePolicy === "required" && ["confirmed", "issued"].includes(input.requestedState) && !input.externalReferences.length) out.push(`definition ${d.definitionKey} requires the issuer's reference before it is confirmed`);
  for (const r of input.externalReferences) if (!d.allowedExternalReferenceTypes.includes(r.referenceType as ExternalReferenceType)) out.push(`reference type ${r.referenceType} is not allowed on ${d.definitionKey}`);
  for (const l of input.links) if (!d.allowedLinkKinds.includes(l.recordType as DocumentLinkKind)) out.push(`link kind ${l.recordType} is not allowed on ${d.definitionKey}`);
  if (!input.evidenceRecordId && !input.fieldTicketDocumentId && !input.storageKey) out.push("a document needs a pointer to its bytes: an evidence record, a generated field-ticket document, or a storage key");
  if (external && !input.evidenceRecordId) out.push("an external document's bytes are the original evidence: it needs the evidence record, not a bare storage key");
  if (d.documentClass === "unclassified" && input.requestedState !== "captured" && input.requestedState !== "needs_classification") out.push("an unclassified document is captured or awaiting classification; it is confirmed only under a definition");
  return out;
}

/** The lifecycle. Every transition names the act that causes it; anything not listed is refused. */
const TRANSITIONS: Readonly<Record<string, ControlState>> = {
  "captured:classify": "needs_classification",
  "captured:propose": "proposed",
  "captured:confirm": "confirmed",
  "needs_classification:propose": "proposed",
  "needs_classification:confirm": "confirmed",
  "proposed:confirm": "confirmed",
  "proposed:issue": "issued",
  "confirmed:issue": "issued",
  "captured:void": "void",
  "needs_classification:void": "void",
  "proposed:void": "void",
  "confirmed:withdraw": "withdrawn",
  "issued:withdraw": "withdrawn",
};

export function nextControlState(from: ControlState, act: "classify" | "propose" | "confirm" | "issue" | "void" | "withdraw"): { ok: true; to: ControlState } | { ok: false; reason: string } {
  const to = TRANSITIONS[`${from}:${act}`];
  const past: Record<typeof act, string> = { classify: "classified", propose: "proposed", confirm: "confirmed", issue: "issued", void: "voided", withdraw: "withdrawn" };
  if (!to) return { ok: false, reason: `a ${from} document cannot be ${past[act]}` };
  return { ok: true, to };
}

/** Which acts a person may take on a row in a state, for the screen and for the tests. */
export function actsFrom(from: ControlState): string[] {
  return Object.keys(TRANSITIONS).filter(k => k.startsWith(`${from}:`)).map(k => k.split(":")[1]!);
}

/** A row that may still change its facts. Once issued or withdrawn, a correction is a new revision or an amendment, never an update. */
export function factsMutable(state: ControlState): boolean {
  return state === "captured" || state === "needs_classification" || state === "proposed";
}

/** Duplicate references within one issuer: identical bytes are the same document; different bytes need a person's word. */
export function referenceDuplicateVerdict(args: { sameIssuerSameValue: { documentId: number; contentHash: string }[]; contentHash: string }): { outcome: "unique" | "exact_duplicate" | "possible_duplicate"; matches: number[] } {
  if (!args.sameIssuerSameValue.length) return { outcome: "unique", matches: [] };
  const exact = args.sameIssuerSameValue.filter(m => m.contentHash === args.contentHash);
  if (exact.length) return { outcome: "exact_duplicate", matches: exact.map(m => m.documentId) };
  return { outcome: "possible_duplicate", matches: args.sameIssuerSameValue.map(m => m.documentId) };
}

/** What a reader is told about where a document came from — one sentence, never inferred from a mutable field. */
export function provenanceSentence(row: { originKind: OriginKind | null; issuerKind: IssuerKind | null; issuerName: string | null; templateRevisionRef: string | null; controlNumber: string | null }): string {
  if (!row.originKind) return "Origin unrecorded (registered before Document Control kept provenance).";
  const issuer = row.issuerKind === "tenant" ? "issued by this company" : row.issuerKind === "unknown" ? "issuer not yet confirmed" : `issued by ${row.issuerName ?? row.issuerKind}`;
  const how = RENDERED_ORIGINS.includes(row.originKind) ? (row.templateRevisionRef ? `rendered by LeaseOS from template revision ${row.templateRevisionRef}` : "rendered by LeaseOS from a frozen snapshot") : row.originKind === "external_scanned" ? "scanned from paper; the original scan is held as evidence" : row.originKind === "external_digital_import" ? "imported as received; the original file is held as evidence" : "held as a reference document";
  const num = row.controlNumber ? `; LeaseOS control number ${row.controlNumber}` : "; no LeaseOS number";
  return `${how[0]!.toUpperCase()}${how.slice(1)}, ${issuer}${num}.`;
}
