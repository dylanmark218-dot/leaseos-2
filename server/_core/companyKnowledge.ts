/**
 * AIL-1B — company intelligence: the rules, with no database.
 *
 * What an organization "knows" is a governed record (`organizationKnowledgeEntries`, 0214), never
 * model memory (R-1). This file decides the shape of an entry and the moves its lifecycle may make;
 * the router (`server/companyKnowledgeRouter.ts`) decides ownership and provenance against the
 * database. Nothing here, and nothing in the router, approves an entry on its own: there is no
 * threshold, count or confidence that promotes anything. Frequency is not truth.
 *
 * An approved entry is DATA. When a later checkpoint admits entries into a model context it does so
 * as `record_data` through contextAdmission, which can never instruct (AIL-1A.1); nothing here gives
 * an entry authority over policy, prompts, permissions or the Constitution.
 */

export const KNOWLEDGE_KINDS = [
  "terminology", "alias", "sop", "facility_convention", "customer_convention", "preference", "knowledge_gap", "verified_correction",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const SUBJECT_TYPES = ["none", "facility", "customer", "form_field"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const SOURCE_KINDS = ["person_statement", "verified_correction", "company_document"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type EntryState = "proposed" | "approved" | "rejected" | "superseded" | "retired";

/** Which subject each kind may be about. A convention is always about its facility or customer; a correction is always about a form field. */
export const SUBJECTS_FOR_KIND: Record<KnowledgeKind, readonly SubjectType[]> = {
  terminology: ["none", "facility", "customer"],
  alias: ["none", "facility", "customer"],
  sop: ["none"],
  facility_convention: ["facility"],
  customer_convention: ["customer"],
  preference: ["none", "form_field"],
  knowledge_gap: ["none", "facility", "customer"],
  verified_correction: ["form_field"],
};

/** Which sources each kind may come from. A verified correction comes only from a correction a person made; nothing else may claim to be one. */
export const SOURCES_FOR_KIND: Record<KnowledgeKind, readonly SourceKind[]> = {
  terminology: ["person_statement", "company_document"],
  alias: ["person_statement", "company_document"],
  sop: ["company_document", "person_statement"],
  facility_convention: ["person_statement", "company_document"],
  customer_convention: ["person_statement", "company_document"],
  preference: ["person_statement", "company_document"],
  knowledge_gap: ["person_statement"],
  verified_correction: ["verified_correction"],
};

export type EntryShape = {
  kind: KnowledgeKind; term: string; meaning: string;
  subjectType: SubjectType; subjectRef: string | null;
  sourceKind: SourceKind; sourceRef: string | null;
};

export type ShapeRefusal =
  | "term_empty" | "meaning_empty" | "subject_not_allowed_for_kind" | "subject_ref_mismatch"
  | "source_not_allowed_for_kind" | "source_ref_required" | "source_ref_not_allowed" | "form_field_malformed";

/** `formKey.fieldKey`, both plain identifiers. */
export const FORM_FIELD = /^[a-z][a-z0-9_]{0,59}\.[a-zA-Z][a-zA-Z0-9_]{0,79}$/;

/**
 * The comparison key for a term: Unicode-normalized, case-folded, whitespace collapsed, surrounding
 * punctuation dropped. "Bluebird  #4" and "bluebird #4" are one term; "Bluebird" and "Bluebird #4" are two.
 */
export function termKey(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/^[\s.,;:!?'"()[\]{}<>*_~-]+|[\s.,;:!?'"()[\]{}<>*_~-]+$/g, "").slice(0, 220);
}

/** The refusal for an entry's shape, or null. Mirrors the migration's CHECKs, so the database is the second line, not the first. */
export function shapeRefusal(e: EntryShape): ShapeRefusal | null {
  if (!termKey(e.term)) return "term_empty";
  if (!e.meaning.trim()) return "meaning_empty";
  if (!SUBJECTS_FOR_KIND[e.kind].includes(e.subjectType)) return "subject_not_allowed_for_kind";
  if ((e.subjectType === "none") !== (e.subjectRef == null)) return "subject_ref_mismatch";
  if (e.subjectType === "form_field" && !FORM_FIELD.test(e.subjectRef ?? "")) return "form_field_malformed";
  if (!SOURCES_FOR_KIND[e.kind].includes(e.sourceKind)) return "source_not_allowed_for_kind";
  if (e.sourceKind !== "person_statement" && !e.sourceRef) return "source_ref_required";
  if (e.sourceKind === "person_statement" && e.sourceRef != null) return "source_ref_not_allowed";
  return null;
}

/** The moves a lifecycle may make. Rejected, superseded and retired are final; nothing returns to proposed. */
const MOVES: Record<EntryState, readonly EntryState[]> = {
  proposed: ["approved", "rejected"],
  approved: ["superseded", "retired"],
  rejected: [], superseded: [], retired: [],
};
export const mayMove = (from: EntryState, to: EntryState) => MOVES[from].includes(to);

/** Two people: whoever proposed an entry may not be the one who approves or rejects it. */
export const mayReview = (proposedByUserId: number, reviewerUserId: number) => proposedByUserId !== reviewerUserId;

/**
 * A verified correction must point at a field a person actually corrected on that committed record:
 * the receipt's form matches, and the sealed manifest holds the field with status `corrected`.
 */
export function correctionInManifest(manifestJson: string, receiptFormKey: string, subjectRef: string): boolean {
  const [formKey, fieldKey] = subjectRef.split(".");
  if (formKey !== receiptFormKey || !fieldKey) return false;
  let fields: unknown;
  try { fields = JSON.parse(manifestJson); } catch { return false; }
  return Array.isArray(fields) && fields.some(f => !!f && typeof f === "object" && (f as { key?: unknown }).key === fieldKey && (f as { status?: unknown }).status === "corrected");
}

/** The same key an approval supersedes against: one approved meaning per term, kind and subject. */
export const supersessionKey = (e: { kind: string; termKey: string; subjectType: string; subjectRef: string | null }) =>
  `${e.kind}\u0000${e.termKey}\u0000${e.subjectType}\u0000${e.subjectRef ?? ""}`;
