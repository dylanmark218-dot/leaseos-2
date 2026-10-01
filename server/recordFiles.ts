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
  // Sign & Attest (SA1). Deliberately NO category — owner-only through
  // evidence.read_own — until Sign & Attest decides who browses them. A stroke
  // document is handwriting the SA1 design keeps from becoming biometric
  // material; a rendered mark is a reusable image of someone's signature; a
  // signed artifact can be a field ticket or an HR consent, which its type
  // cannot tell apart; a receipt is audit material. SA1 reads them through its
  // own procedures, so nobody loses access by this.
  signature_strokes: null,
  signature_render: null,
  signed_artifact: null,
  attest_receipt: null,
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
export function fileVisibility(args: {
  held: ReadonlySet<Permission>;
  recordType: string;
  isOwner: boolean;
}): FileVisibility {
  const category = readCategoryFor(args.recordType);
  if (category && args.held.has(category)) return { visible: true, basis: "category", category };
  if (args.isOwner && args.held.has("evidence.read_own")) return { visible: true, basis: "own", category };
  return {
    visible: false,
    reason: category
      ? `Requires ${category}${args.isOwner ? " or evidence.read_own" : ""}`
      : `Record type "${args.recordType}" belongs to no read category — only its owner reaches it`,
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
  | "integrity_failed";

export const LIFECYCLE_ORDER: readonly LifecycleStage[] = [
  "draft", "sealed", "queued", "server_received", "hash_verified", "office_accepted",
];

export const LIFECYCLE_LABELS: Readonly<Record<LifecycleStage, string>> = {
  draft: "Draft",
  sealed: "Sealed",
  queued: "Queued to send",
  server_received: "Server received",
  hash_verified: "Hash verified",
  office_accepted: "Office accepted",
  integrity_failed: "Integrity check failed",
};

/**
 * Where a record is on capture → seal → send → verify → accept.
 *
 * A hash mismatch is its own stage rather than "received": received-but-wrong
 * is the one outcome an operator must act on, and folding it into progress
 * would hide it. Waiting for coverage is `queued`, never a failure.
 */
export function lifecycleStage(args: {
  sealState: "draft" | "sealed" | "amended" | "superseded";
  syncState: "pending" | "received" | "verified" | "mismatch" | null;
  sealVerification: "pending" | "verified" | "hash_mismatch" | "manifest_mismatch" | "content_unavailable" | null;
  officeReviewedAt: Date | null;
}): LifecycleStage {
  if (args.sealState === "draft") return "draft";
  if (
    args.syncState === "mismatch" ||
    args.sealVerification === "hash_mismatch" ||
    args.sealVerification === "manifest_mismatch"
  ) return "integrity_failed";
  const verified = args.syncState === "verified" || args.sealVerification === "verified";
  if (verified && args.officeReviewedAt) return "office_accepted";
  if (verified) return "hash_verified";
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
