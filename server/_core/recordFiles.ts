/**
 * Records & File Manager — the projection a person browses.
 *
 * Pure. No network, no database. Not a new engine: every fact it reads is
 * already held by the evidence vault (`evidenceRecords`, `evidenceRelationships`,
 * `evidenceSeals`, `syncPackageItems`, `recordRetentionState`, `legalHoldRecords`)
 * and every decision about who may read what is `authorize()`'s. This module
 * only says which of those decisions applies to a given record, and how the
 * record is presented once it is visible.
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

import type { Permission } from "./recordsAuthorization";

/** The category reads, as `EVIDENCE_READ_CATEGORIES` names them. */
export type ReadCategory =
  | "evidence.read_maintenance"
  | "evidence.read_job_operational"
  | "evidence.read_safety_summary"
  | "evidence.read_commercial"
  | "evidence.read_personnel"
  | "evidence.read_legal";

/**
 * Which category read reaches each record type.
 *
 * Written out rather than derived. `other` is job-operational because that is
 * what the upload path has always produced and what `evidence.list` has always
 * shown under `evidence.read_job_operational`; changing that here would take
 * records away from the people who file them.
 */
export const READ_CATEGORY_BY_RECORD_TYPE: Readonly<Record<string, ReadCategory>> = {
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
  invoice: "evidence.read_commercial",
  credential: "evidence.read_personnel",
  training_record: "evidence.read_personnel",
  employment_record: "evidence.read_personnel",
  legal_correspondence: "evidence.read_legal",
};

export function readCategoryFor(recordType: string): ReadCategory | null {
  return Object.prototype.hasOwnProperty.call(READ_CATEGORY_BY_RECORD_TYPE, recordType)
    ? READ_CATEGORY_BY_RECORD_TYPE[recordType]!
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
