/**
 * Records & File Manager — the projection a person browses.
 *
 * Pure. No network, no database. It lives beside `recordsService.ts` rather
 * than under `server/_core/` on purpose: `engineReachability.test.ts` counts
 * every module in `_core` as an engine, and this is not one. It decides no
 * business rule of its own — every fact it reads is already held by the
 * evidence vault (`evidenceRecords`, `evidenceRelationships`, `evidenceSeals`,
 * `syncPackageItems`, `recordRetentionState`, `legalHoldRecords`) and every
 * decision about who may read what is `authorize()`'s. It only says which of
 * those decisions applies to a given record, and how the record is presented
 * once it is visible — the same position `readinessComposer.ts` holds over the
 * readiness engines.
 *
 * Three rules:
 *
 *   A folder is a view, never a permission. The same record can appear under
 *   a job, a unit and an incident without being copied, and appearing in a
 *   folder never makes it readable. Visibility is decided per record, on the
 *   record's own type, before any folder is applied.
 *
 *   Fail closed on the unknown. A record type this module has never heard of
 *   belongs to no read category, so nobody reaches it by category — only its
 *   owner, through `evidence.read_own`. A new type reaches nobody until someone
 *   decides who it belongs to, which is the same rule the category grants follow.
 *
 *   Say why. A search hit names the field that matched; a hidden lifecycle
 *   stage is a named stage, not a missing one.
 */

import type { EvidenceRecordType } from "./_core/evidenceSeal";
import type { Permission } from "./_core/recordsAuthorization";

/** The category reads, as `EVIDENCE_READ_CATEGORIES` names them. */
export type ReadCategory =
  | "evidence.read_maintenance"
  | "evidence.read_job_operational"
  | "evidence.read_safety_summary"
  | "evidence.read_commercial"
  | "evidence.read_personnel"
  | "evidence.read_legal";

/**
 * The policy: which category read reaches each sealed record type.
 *
 * Typed against the seal's own `EvidenceRecordType`, so this is exhaustive by
 * construction — a type added to the seal and not classified here fails the
 * typecheck rather than quietly reaching only its owner (or, worse, being
 * defaulted into a broad category by whoever notices).
 *
 * Grouped by what the record is evidence OF, which is what decides who needs it:
 *
 *   The work and its paperwork — job-operational. Tickets, manifests, the
 *   disposal and scale chain, permits, site photos, the daily log.
 *
 *   The vehicle and its fitness — maintenance. Pre/post-trip inspections,
 *   defects, work orders. A mechanic needs these; billing does not.
 *
 *   What went wrong — safety. Incidents, near misses, tailgate meetings.
 *
 *   Money — commercial. A receipt is a cost record, not a field record.
 *
 * `other` is job-operational, and that is the consequential line in this
 * table. It is the column's default and, today, the type of EVERY row: no
 * production path writes `evidenceRecords.recordType` (upload omits it, and
 * `records.evidence.seal` puts its `recordType` in the sealed manifest without
 * persisting it to the column). `evidence.list` already shows all of those rows
 * under `evidence.read_job_operational`; mapping `other` anywhere narrower would
 * take records away from people who can read them today, and anywhere broader
 * would widen them. So it matches the existing contract exactly.
 */
export const SEALED_TYPE_READ_CATEGORY = {
  daily_log: "evidence.read_job_operational",
  manifest: "evidence.read_job_operational",
  load_ticket: "evidence.read_job_operational",
  disposal_ticket: "evidence.read_job_operational",
  scale_ticket: "evidence.read_job_operational",
  field_ticket: "evidence.read_job_operational",
  permit: "evidence.read_job_operational",
  photo: "evidence.read_job_operational",
  other: "evidence.read_job_operational",
  pre_trip: "evidence.read_maintenance",
  post_trip_dvir: "evidence.read_maintenance",
  defect_report: "evidence.read_maintenance",
  work_order: "evidence.read_maintenance",
  inspection: "evidence.read_maintenance",
  safety_meeting: "evidence.read_safety_summary",
  incident: "evidence.read_safety_summary",
  near_miss: "evidence.read_safety_summary",
  bill_receipt: "evidence.read_commercial",
  // Sign & Attest (SA1). Signing material is never ordinary job paperwork.
  //   signature_strokes: no category, and never browsable at all (see
  //     FILE_MANAGER_EXCLUDED_TYPES) — handwriting the SA1 design keeps from
  //     becoming biometric material, reachable only through Sign & Attest.
  //   signature_render: legal — a reusable image of someone's signature; its
  //     signer still reaches it through evidence.read_own.
  //   signed_artifact: no category BY TYPE. A signed document takes the category
  //     of the document it signs, resolved from Sign & Attest's own linkage
  //     (signingClassification); unresolved, it is owner-only.
  //   attest_receipt: legal — audit material, which does not become visible
  //     because the document it proves is.
  signature_strokes: null,
  signature_render: "evidence.read_legal",
  signed_artifact: null,
  attest_receipt: "evidence.read_legal",
} as const satisfies Record<EvidenceRecordType, ReadCategory | null>;

/**
 * Types the seal does not know yet, classified in advance — every one into a
 * NARROW category, never job-operational. Nothing writes them today. They are
 * here so that when personnel, legal or invoice documents arrive as evidence
 * they land with HR, legal or the office, not with everybody who reads tickets.
 * Removing one does not open it: it falls back to owner-only.
 */
export const FORWARD_TYPE_READ_CATEGORY = {
  invoice: "evidence.read_commercial",
  credential: "evidence.read_personnel",
  training_record: "evidence.read_personnel",
  employment_record: "evidence.read_personnel",
  legal_correspondence: "evidence.read_legal",
} as const satisfies Record<string, Exclude<ReadCategory, "evidence.read_job_operational">>;

/** `null` is a decision, not a gap: classified, and deliberately in no category. */
export const READ_CATEGORY_BY_RECORD_TYPE: Readonly<Record<string, ReadCategory | null>> = {
  ...SEALED_TYPE_READ_CATEGORY,
  ...FORWARD_TYPE_READ_CATEGORY,
};

/**
 * Exact match, own keys only. "Photo", " photo", "load-ticket" and
 * "__proto__" are not record types and reach no category; normalising them
 * here would be a second, looser classifier.
 */
export function readCategoryFor(recordType: string): ReadCategory | null {
  return Object.prototype.hasOwnProperty.call(READ_CATEGORY_BY_RECORD_TYPE, recordType)
    ? READ_CATEGORY_BY_RECORD_TYPE[recordType] ?? null
    : null;
}

/* ------------------------------------------------------------------ *
 * Sealing: the client's word for what a record is, normalized
 * ------------------------------------------------------------------ */

/**
 * The field device's capture kinds (client/src/runtime/contracts.ts
 * `CaptureKind`) that name a sealed record type. The kind is the device's
 * vocabulary, not the vault's: `pretrip` is not `pre_trip`, and nothing the
 * device sends is written as a record type without passing through here.
 */
export const CAPTURE_KIND_RECORD_TYPE = {
  pretrip: "pre_trip",
  posttrip: "post_trip_dvir",
  tailgate: "safety_meeting",
  fuel_receipt: "bill_receipt",
  expense_receipt: "bill_receipt",
  load_ticket: "load_ticket",
  disposal_ticket: "disposal_ticket",
  photo: "photo",
  incident: "incident",
  defect_report: "defect_report",
  // A field signature capture carries the raw stroke document (SIGN_ATTEST_DESIGN §6.2: files =
  // [strokes.json, render.svg]). It is sealed as the most restrictive signing type, never as `other`,
  // which every job-operational reader can browse.
  signature: "signature_strokes",
} as const satisfies Record<string, EvidenceRecordType>;

/** Types only Sign & Attest produces. A sealing client may not name them. */
const SIGNING_ONLY_TYPES: readonly EvidenceRecordType[] = ["signature_strokes", "signature_render", "signed_artifact", "attest_receipt"];

export type NormalizedRecordType = {
  recordType: EvidenceRecordType;
  /** How it was decided — for the seal's caller and for tests, never for authorization. */
  basis: "capture_kind" | "canonical" | "unrecognized";
};

/**
 * What a seal request's `recordType` becomes. Exact match only — "PRETRIP",
 * " pretrip" and "pre-trip" are not capture kinds, and normalizing them here
 * would be a second, looser vocabulary. Anything unrecognized is `other`, the
 * column's default and what every record has been until now: it can never
 * reach a category it did not already have, and an unknown string can never
 * become a new one.
 */
export function normalizeSealRecordType(raw: string): NormalizedRecordType {
  if (Object.prototype.hasOwnProperty.call(CAPTURE_KIND_RECORD_TYPE, raw)) {
    return { recordType: CAPTURE_KIND_RECORD_TYPE[raw as keyof typeof CAPTURE_KIND_RECORD_TYPE], basis: "capture_kind" };
  }
  if (Object.prototype.hasOwnProperty.call(SEALED_TYPE_READ_CATEGORY, raw) && !SIGNING_ONLY_TYPES.includes(raw as EvidenceRecordType)) {
    return { recordType: raw as EvidenceRecordType, basis: "canonical" };
  }
  return { recordType: "other", basis: "unrecognized" };
}

export type VisibilityBasis = "category" | "own";

export type FileVisibility =
  | { visible: true; basis: VisibilityBasis; category: ReadCategory | null }
  | { visible: false; reason: string };

/**
 * Whether the caller may see this record in the file manager.
 *
 * `held` is the set of permissions `authorize()` already allowed for the
 * caller — computed by the router from the caller's grants, never from the
 * request. Ownership facts come from the database: the operator relationship
 * the seal covers, or the capturing user.
 */
/** Types the File Manager never shows, to anyone — owner included. Reached only through their own workflow. */
export const FILE_MANAGER_EXCLUDED_TYPES: readonly EvidenceRecordType[] = ["signature_strokes"];

/**
 * What Sign & Attest's own tables say a record is — read server-side from
 * attestMarks and attestArtifacts, never from the record's type column or
 * the request. It wins over `recordType`: a stroke document sealed before
 * capture kinds were normalized is stored as `other`, and it is still strokes.
 */
export type SigningRole = "strokes" | "rendered_mark" | "signed_document" | "receipt";
export type SigningLink = {
  role: SigningRole;
  /** For a signed document: the category of the document it signs, or null when that cannot be resolved. */
  inheritedCategory: ReadCategory | null;
};

/** The record type each signing role is, for classification. */
const SIGNING_ROLE_TYPE: Readonly<Record<SigningRole, EvidenceRecordType>> = {
  strokes: "signature_strokes",
  rendered_mark: "signature_render",
  signed_document: "signed_artifact",
  receipt: "attest_receipt",
};

/**
 * The category a signed document inherits from what was signed. Signing never
 * widens a document's audience: the signed copy is read by exactly whoever
 * reads the original.
 *   evidence_record      → that record's own category (null if it is itself signing material)
 *   field_ticket_revision → a field ticket's category
 *   commercial_document   → commercial
 * Any other subject is unresolved: null, owner-only.
 */
export function signedSubjectCategory(subject: { subjectType: string; subjectRecordType: string | null; subjectIsSigningMaterial: boolean }): ReadCategory | null {
  switch (subject.subjectType) {
    case "evidence_record":
      if (subject.subjectIsSigningMaterial || subject.subjectRecordType == null) return null;
      if (FILE_MANAGER_EXCLUDED_TYPES.includes(subject.subjectRecordType as EvidenceRecordType)) return null;
      return readCategoryFor(subject.subjectRecordType);
    case "field_ticket_revision":
      return readCategoryFor("field_ticket");
    case "commercial_document":
      return "evidence.read_commercial";
    default:
      return null;
  }
}

export type RecordClassification =
  | { excluded: true }
  | { excluded: false; category: ReadCategory | null; effectiveType: string };

/** One answer to "what is this record, for reading": the signing linkage first, then the type column. */
export function classifyRecord(args: { recordType: string; signing?: SigningLink | null }): RecordClassification {
  const effectiveType = args.signing ? SIGNING_ROLE_TYPE[args.signing.role] : args.recordType;
  if (FILE_MANAGER_EXCLUDED_TYPES.includes(effectiveType as EvidenceRecordType)) return { excluded: true };
  const category = args.signing?.role === "signed_document" ? args.signing.inheritedCategory : readCategoryFor(effectiveType);
  return { excluded: false, category, effectiveType };
}

/**
 * Whether the caller may see this record in the file manager.
 *
 * `held` is the set of permissions `authorize()` already allowed for the
 * caller — computed by the router from the caller's grants, never from the
 * request. Ownership facts come from the database: the operator relationship
 * the seal covers, or the capturing user. `signing` comes from Sign & Attest's
 * own tables, loaded by the service.
 */
export function fileVisibility(args: {
  held: ReadonlySet<Permission>;
  recordType: string;
  isOwner: boolean;
  signing?: SigningLink | null;
}): FileVisibility {
  const c = classifyRecord(args);
  if (c.excluded) return { visible: false, reason: "Signature stroke data is reached only through Sign & Attest" };
  if (c.category && args.held.has(c.category)) return { visible: true, basis: "category", category: c.category };
  if (args.isOwner && args.held.has("evidence.read_own")) return { visible: true, basis: "own", category: c.category };
  return {
    visible: false,
    reason: c.category
      ? `Requires ${c.category}${args.isOwner ? " or evidence.read_own" : ""}`
      : `Record type "${c.effectiveType}" belongs to no read category — only its owner reaches it`,
  };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export type LifecycleStage =
  | "draft"
  | "sealed"
  | "queued"
  | "server_received"
  | "hash_verified"
  | "office_accepted"
  | "device_released"
  | "integrity_failed";

export const LIFECYCLE_ORDER: readonly LifecycleStage[] = [
  "draft", "sealed", "queued", "server_received", "hash_verified", "office_accepted", "device_released",
];

export const LIFECYCLE_LABELS: Readonly<Record<LifecycleStage, string>> = {
  draft: "Draft",
  sealed: "Sealed",
  queued: "Queued to send",
  server_received: "Server received",
  hash_verified: "Hash verified",
  office_accepted: "Office accepted",
  device_released: "Device copy released",
  integrity_failed: "Integrity check failed",
};

/**
 * Where a record is on capture → seal → send → verify → accept.
 *
 * A hash mismatch is its own stage rather than "received": received-but-wrong
 * is the one outcome an operator must act on, and folding it into progress
 * would hide it. Waiting for coverage is `queued`, never a failure.
 */
export type IntegrityState = "verified" | "failed" | "unknown";

/**
 * The office's integrity state for a record — one rule, shared by the lifecycle
 * the File Manager shows and by acceptance, so the two can never disagree.
 *
 *   failed   the latest send was a hash mismatch, or the server's check of the
 *            current seal found the content or manifest altered. A failure is
 *            named, and wins over any earlier success.
 *   verified the latest send, the current seal's server check, or the office's
 *            recorded receipt (officeIntegrityVerifiedAt) verified it.
 *   unknown  nothing has checked it — an office upload that never travelled
 *            through a device package, or one whose stored object could not
 *            be read (content_unavailable is not a mismatch anybody observed).
 */
export function integrityState(args: {
  syncState: "pending" | "received" | "verified" | "mismatch" | null;
  sealVerification: "pending" | "verified" | "hash_mismatch" | "manifest_mismatch" | "content_unavailable" | null;
  officeIntegrityVerifiedAt?: Date | null;
}): IntegrityState {
  if (args.syncState === "mismatch" || args.sealVerification === "hash_mismatch" || args.sealVerification === "manifest_mismatch") return "failed";
  if (args.syncState === "verified" || args.sealVerification === "verified" || args.officeIntegrityVerifiedAt) return "verified";
  return "unknown";
}

export function lifecycleStage(args: {
  sealState: "draft" | "sealed" | "amended" | "superseded";
  syncState: "pending" | "received" | "verified" | "mismatch" | null;
  sealVerification: "pending" | "verified" | "hash_mismatch" | "manifest_mismatch" | "content_unavailable" | null;
  /** When a person at the office accepted it (recordRetentionState.officeReviewedAt). */
  officeReviewedAt: Date | null;
  /** When the device let go of its copy; only ever after acceptance, receipt and integrity. */
  deviceCopyDeletedAt?: Date | null;
}): LifecycleStage {
  if (args.sealState === "draft") return "draft";
  const integrity = integrityState({ syncState: args.syncState, sealVerification: args.sealVerification });
  if (integrity === "failed") return "integrity_failed";
  // Acceptance is a person's decision and counts only on a verified record: an
  // accepted record whose bytes never verified is still shown where it really is.
  if (integrity === "verified" && args.officeReviewedAt) return args.deviceCopyDeletedAt ? "device_released" : "office_accepted";
  if (integrity === "verified") return "hash_verified";
  if (args.syncState === "received") return "server_received";
  if (args.syncState === "pending") return "queued";
  return "sealed";
}

/* ------------------------------------------------------------------ *
 * Virtual folders
 * ------------------------------------------------------------------ */

export type FolderKey =
  | "all"
  | "field_tickets"
  | "loads_disposal"
  | "photos"
  | "safety"
  | "maintenance"
  | "billing"
  | "personnel"
  | "other"
  | "needs_filing"
  | "needs_review"
  | "legal_hold"
  | "drafts";

/** Type folders: saved views over record types. A record sits in exactly one. */
const TYPE_FOLDERS: ReadonlyArray<{ key: FolderKey; label: string; types: readonly string[] }> = [
  { key: "field_tickets", label: "Field tickets", types: ["field_ticket", "daily_log", "permit"] },
  { key: "loads_disposal", label: "Loads & disposal", types: ["load_ticket", "disposal_ticket", "scale_ticket", "manifest"] },
  { key: "photos", label: "Photos", types: ["photo"] },
  { key: "safety", label: "Safety", types: ["safety_meeting", "incident", "near_miss"] },
  { key: "maintenance", label: "Maintenance", types: ["pre_trip", "post_trip_dvir", "defect_report", "work_order", "inspection"] },
  { key: "billing", label: "Billing", types: ["bill_receipt", "invoice"] },
  { key: "personnel", label: "Personnel", types: ["credential", "training_record", "employment_record"] },
];

/** Work queues: a record can be in any number of these at once. */
const QUEUE_FOLDERS: ReadonlyArray<{ key: FolderKey; label: string }> = [
  { key: "needs_filing", label: "Needs filing" },
  { key: "needs_review", label: "Needs review" },
  { key: "drafts", label: "Drafts" },
  { key: "legal_hold", label: "Legal hold" },
];

export const FOLDER_LABELS: Readonly<Record<FolderKey, string>> = {
  all: "All records",
  other: "Other",
  ...Object.fromEntries(TYPE_FOLDERS.map(f => [f.key, f.label])),
  ...Object.fromEntries(QUEUE_FOLDERS.map(f => [f.key, f.label])),
} as Record<FolderKey, string>;

export const TYPE_FOLDER_KEYS: readonly FolderKey[] = [...TYPE_FOLDERS.map(f => f.key), "other"];
export const QUEUE_FOLDER_KEYS: readonly FolderKey[] = QUEUE_FOLDERS.map(f => f.key);

export function typeFolderFor(recordType: string): FolderKey {
  return TYPE_FOLDERS.find(f => f.types.includes(recordType))?.key ?? "other";
}

/** What a folder needs to know about a record. */
export type FolderFacts = {
  recordType: string;
  status: "needs_review" | "verified" | "unverified";
  sealState: "draft" | "sealed" | "amended" | "superseded";
  legalHold: boolean;
  /** Relationships other than the operator one the server adds itself. */
  entityRelationshipCount: number;
  jobId: number | null;
};

export function inFolder(folder: FolderKey, r: FolderFacts): boolean {
  switch (folder) {
    case "all": return true;
    // A record tied to no job and no entity is unfindable at audit — the same
    // reason sealing refuses one. It is a work queue, not a junk drawer.
    case "needs_filing": return r.jobId == null && r.entityRelationshipCount === 0;
    case "needs_review": return r.status === "needs_review";
    case "drafts": return r.sealState === "draft";
    case "legal_hold": return r.legalHold;
    default: return typeFolderFor(r.recordType) === folder;
  }
}

export function folderCounts(records: readonly FolderFacts[]): Record<FolderKey, number> {
  const out = Object.fromEntries(
    (["all", ...TYPE_FOLDER_KEYS, ...QUEUE_FOLDER_KEYS] as FolderKey[]).map(k => [k, 0])
  ) as Record<FolderKey, number>;
  for (const r of records) {
    for (const k of Object.keys(out) as FolderKey[]) if (inFolder(k, r)) out[k]++;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export type SearchableRecord = {
  title: string;
  trackingNumber: string | null;
  recordType: string;
  category: string;
  notes: string | null;
  relationships: ReadonlyArray<{ entityType: string; entityRef: string | null; entityId: number | null }>;
};

export type SearchMatch = { matched: boolean; reasons: string[] };

/**
 * Every term must match somewhere; each match names where. Terms are
 * whitespace-separated and case-insensitive. An empty query matches everything
 * and gives no reason — there is nothing to explain.
 */
export function matchRecord(query: string, r: SearchableRecord): SearchMatch {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { matched: true, reasons: [] };

  const fields: Array<[string, string]> = [
    ["tracking number", r.trackingNumber ?? ""],
    ["title", r.title],
    ["record type", r.recordType.replace(/_/g, " ")],
    ["category", r.category],
    ["notes", r.notes ?? ""],
    ...r.relationships.map(
      rel => [`related ${rel.entityType}`, `${rel.entityRef ?? ""} ${rel.entityId ?? ""}`] as [string, string]
    ),
  ];

  const reasons = new Set<string>();
  for (const term of terms) {
    const hit = fields.find(([, value]) => value.toLowerCase().includes(term));
    if (!hit) return { matched: false, reasons: [] };
    reasons.add(`${hit[0]} matches "${term}"`);
  }
  return { matched: true, reasons: Array.from(reasons) };
}
