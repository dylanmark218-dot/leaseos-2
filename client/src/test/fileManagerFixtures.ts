/**
 * Fixtures for the Records & File Manager view — shared by its jsdom suite and
 * the accessibility suite, so both render the same states.
 */
import type { FileDetail, FileManagerViewProps, FileRow } from "../records/FileManagerView";

export const counts = {
  all: 2, field_tickets: 0, loads_disposal: 1, photos: 1, safety: 0, maintenance: 0, billing: 0, personnel: 0, other: 0,
  needs_filing: 1, needs_review: 1, legal_hold: 1, drafts: 0,
};

export const row = (over: Partial<FileRow> = {}): FileRow => ({
  id: 1, trackingNumber: "DT-8842", title: "Fox Creek disposal", recordType: "disposal_ticket",
  capturedAt: new Date("2026-09-23T14:22:00Z"), status: "verified", sealState: "sealed", version: 1, legalHold: false,
  lifecycle: "hash_verified", relationships: [{ entityType: "unit", entityRef: "TRK-27", entityId: 27 }], mine: false,
  matchReasons: [], ...over,
});

export const detail = (over: Partial<FileDetail> = {}): FileDetail => ({
  id: 1, trackingNumber: "DT-8842", title: "Fox Creek disposal", recordType: "disposal_ticket", category: "ticket",
  readCategory: "evidence.read_job_operational", mimeType: "application/pdf", hasContent: true,
  capturedAt: new Date("2026-09-23T14:22:00Z"), receivedAt: new Date("2026-09-23T15:00:00Z"), latitude: null, longitude: null,
  status: "verified", sealState: "amended", version: 2, notes: null, lifecycle: "hash_verified",
  integrity: { contentHash: "a".repeat(64), manifestHash: "b".repeat(64), algorithm: "sha256", sealedAt: new Date("2026-09-23T14:30:00Z"), verification: "verified", serverVerifiedAt: null },
  relationships: [{ entityType: "job", entityRef: "JOB-10483", entityId: 10483, role: null }],
  versions: [
    { version: 2, current: true, contentHash: "c".repeat(64), amendmentReason: "corrected ticket reference", createdAt: new Date("2026-09-24T09:00:00Z"), hasContent: true },
    { version: 1, current: false, contentHash: "a".repeat(64), amendmentReason: null, createdAt: new Date("2026-09-23T14:30:00Z"), hasContent: true },
  ],
  retention: { basis: "company_policy", officeRetainUntil: new Date("2036-09-23T00:00:00Z"), deviceRetainUntil: new Date("2026-10-07T00:00:00Z"), officeReceivedAt: null, officeIntegrityVerifiedAt: null, deviceCopyDeletedAt: null, statutoryCompliance: "not asserted" },
  legalHold: { active: false, holds: [] },
  accessHistory: [{ action: "viewed", actorUserId: 9, actorRole: "office", context: "records.files.get", occurredAt: new Date("2026-09-24T10:00:00Z") }],
  visibleBecause: "category",
  actions: { download: true, verify: false, amend: true },
  ...over,
});

export const fileManagerProps = (over: Partial<FileManagerViewProps> = {}): FileManagerViewProps => ({
  folder: "all", onFolder: () => {}, query: "", onQuery: () => {}, onLoadMore: () => {},
  list: { kind: "loaded", rows: [row(), row({ id: 2, trackingNumber: null, title: "Site photo", recordType: "photo", status: "needs_review", lifecycle: "queued", legalHold: true, mine: true })], counts, hasMore: false, loadingMore: false, loadMoreError: null, reach: { categories: ["evidence.read_job_operational"], own: false, canVerify: false } },
  selectedId: 1, onSelect: () => {},
  detail: { kind: "loaded", detail: detail() },
  onDownload: () => {}, onVerify: () => {}, busy: null, notice: null,
  ...over,
});

