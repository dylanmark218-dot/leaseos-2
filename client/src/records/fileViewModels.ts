/**
 * Records & File Manager — presentation only.
 *
 * Labels, dates and the lifecycle strip. Nothing here decides who may see a
 * record: the server already filtered the list, and a record this screen
 * receives is one the caller may read. The folder and lifecycle vocabularies
 * are imported from the server's projection so the two cannot drift.
 */
import {
  FOLDER_LABELS,
  LIFECYCLE_LABELS,
  LIFECYCLE_ORDER,
  QUEUE_FOLDER_KEYS,
  TYPE_FOLDER_KEYS,
  type FolderKey,
  type LifecycleStage,
} from "../../../server/_core/recordFiles";

export { FOLDER_LABELS, LIFECYCLE_LABELS, QUEUE_FOLDER_KEYS, TYPE_FOLDER_KEYS };
export type { FolderKey, LifecycleStage };

const TYPE_LABELS: Record<string, string> = {
  daily_log: "Daily log",
  pre_trip: "Pre-trip inspection",
  post_trip_dvir: "Post-trip DVIR",
  manifest: "Manifest",
  load_ticket: "Load ticket",
  disposal_ticket: "Disposal ticket",
  scale_ticket: "Scale ticket",
  field_ticket: "Field ticket",
  bill_receipt: "Bill / receipt",
  safety_meeting: "Safety meeting",
  incident: "Incident report",
  near_miss: "Near miss",
  defect_report: "Defect report",
  work_order: "Work order",
  inspection: "Inspection",
  permit: "Permit",
  photo: "Photo",
  invoice: "Invoice",
  credential: "Credential",
  training_record: "Training record",
  employment_record: "Employment record",
  legal_correspondence: "Legal correspondence",
  other: "Other",
};

export function recordTypeLabel(recordType: string): string {
  return TYPE_LABELS[recordType] ?? recordType.replace(/_/g, " ");
}

const ENTITY_LABELS: Record<string, string> = {
  operator: "Operator", unit: "Unit", trailer: "Trailer", equipment: "Equipment", job: "Job", trip: "Trip",
  load: "Load", manifest: "Manifest", disposalTicket: "Disposal ticket", fieldTicket: "Field ticket",
  workOrder: "Work order", incident: "Incident", nearMiss: "Near miss", safetyMeeting: "Safety meeting",
  invoice: "Invoice", customer: "Customer", facility: "Facility", dailyLog: "Daily log", inspection: "Inspection",
  expenseRecord: "Expense", financialEntity: "Financial entity", taxYear: "Tax year", user: "User",
  fuelTransaction: "Fuel transaction",
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

/** The reference a person recognizes, else the id, else nothing to show. */
export function entityValue(r: { entityRef: string | null; entityId: number | null }): string {
  return r.entityRef ?? (r.entityId != null ? `#${r.entityId}` : "—");
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function formatDay(d: Date | string | null | undefined): string {
  return formatDate(d).slice(0, 10);
}

/** A hash is shown short and in full on hover; it is never truncated in the data. */
export function shortHash(h: string | null | undefined): string {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—";
}

const READ_LABELS: Record<string, string> = {
  "evidence.read_maintenance": "maintenance",
  "evidence.read_job_operational": "job operational",
  "evidence.read_safety_summary": "safety",
  "evidence.read_commercial": "commercial",
  "evidence.read_personnel": "personnel",
  "evidence.read_legal": "legal",
};

export function readCategoryLabel(p: string | null): string {
  return p ? READ_LABELS[p] ?? p : "owner only";
}

/** One sentence saying what this person's list is made of — so an empty folder is explained, not mysterious. */
export function reachSummary(reach: { categories: readonly string[]; own: boolean }): string {
  const parts = reach.categories.map(c => READ_LABELS[c] ?? c);
  if (reach.own) parts.push("your own records");
  if (parts.length === 0) return "Your roles reach no record category.";
  return `Showing ${parts.join(", ")}.`;
}

export type LifecycleStep = { stage: LifecycleStage; label: string; state: "done" | "current" | "todo" };

/**
 * The capture → accept strip. An integrity failure is not a step on it: it is
 * shown on its own, because "failed" drawn as progress reads like progress.
 */
export function lifecycleSteps(stage: LifecycleStage): LifecycleStep[] {
  const at = LIFECYCLE_ORDER.indexOf(stage);
  return LIFECYCLE_ORDER.map((s, i) => ({
    stage: s,
    label: LIFECYCLE_LABELS[s],
    state: at < 0 ? "todo" : i < at ? "done" : i === at ? "current" : "todo",
  }));
}

export const STATUS_LABELS: Record<"needs_review" | "verified" | "unverified", string> = {
  needs_review: "Needs review",
  verified: "Verified",
  unverified: "Unverified",
};

export const SEAL_LABELS: Record<"draft" | "sealed" | "amended" | "superseded", string> = {
  draft: "Draft",
  sealed: "Sealed",
  amended: "Amended",
  superseded: "Superseded",
};

export const ACCESS_LABELS: Record<string, string> = {
  viewed: "Viewed",
  downloaded: "Downloaded",
  exported: "Exported",
  shared: "Shared",
  printed: "Printed",
  seal_verified: "Seal verified",
};
