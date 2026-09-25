/**
 * v22.23 B28 — one place that decides whether a compliance document is in force.
 *
 * Pure. No network.
 *
 * The same note `qualificationValidity` opens with applies again, one table
 * over: `documentValidity` is the canonical answer to "is this in force", and
 * `complianceDocuments` expiry is currently decided inline in at least two
 * places — `credentialState` in the readiness composer and the credential block
 * of the exception centre — each correct-looking and separately maintained. The
 * widget board would have made a third. This adapts instead.
 *
 * A compliance row is not a document version, so this adapts rather than
 * pretends: the row carries the three facts the engine needs — was it verified,
 * from when, until when — and the engine decides from those.
 */

import { validityOf, type DocumentVersion, type Validity, type ValidityState } from "./documentValidity";
import type { DocumentType } from "./documentExtraction";

/** The columns of `complianceDocuments` this rule actually reads. */
export type ComplianceDocumentRow = {
  id: number;
  docType: string;
  title: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  verificationStatus: "needs_review" | "verified" | "rejected";
  capturedAt: Date;
};

/** One document, with the engine's verdict on it. */
export type ExpiringDocument = {
  documentId: number;
  docType: string;
  title: string;
  state: ValidityState;
  expiresAt: Date | null;
  daysRemaining: number | null;
  reason: string;
};

/**
 * Present a compliance row to the engine as the version it is.
 *
 * `capturedAt` becomes the version ordinal because these rows carry no version
 * number: the most recently captured one is the current claim. The column's
 * `needs_review` is the engine's `uploaded` — one fact, two words, and this
 * adapter is the only place they meet.
 */
const asVersion = (r: ComplianceDocumentRow, index: number): DocumentVersion => ({
  documentRef: String(r.id),
  version: index + 1,
  type: r.docType as DocumentType,
  subjectRef: r.docType,
  state: r.verificationStatus === "needs_review" ? "uploaded" : r.verificationStatus,
  effectiveFrom: r.issuedAt,
  expiresAt: r.expiresAt,
  verifiedByUserId: null,
  verifiedAt: null,
  supersededByVersion: null,
  uploadedAt: r.capturedAt,
});

/** The engine's verdict for one document type, from that type's rows alone. */
export function complianceDocumentValidity(
  rows: readonly ComplianceDocumentRow[], docType: string, at: Date, noticeDays = 30,
): Validity {
  const forType = rows
    .filter(r => r.docType === docType)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    .map(asVersion);
  return validityOf(forType, at, noticeDays);
}

/**
 * Every document type the subject holds, worst first.
 *
 * Ordered by how much it matters rather than by name, because a tile shows the
 * first few rows and the first few rows should be the ones that stop work.
 * `in_force` is last and `none` is absent: a type with no rows cannot appear in
 * a list derived from rows, and claiming otherwise would need a requirement
 * list this function was not given.
 */
const SEVERITY: Readonly<Record<ValidityState, number>> = {
  expired: 0, rejected: 1, incomplete: 2, not_yet_effective: 3, expiring: 4, unverified: 5, in_force: 6, none: 7,
};

export function documentExpiry(
  rows: readonly ComplianceDocumentRow[], at: Date, noticeDays = 30,
): readonly ExpiringDocument[] {
  const byType = new Map<string, ComplianceDocumentRow[]>();
  for (const r of rows) {
    const list = byType.get(r.docType);
    if (list) list.push(r); else byType.set(r.docType, [r]);
  }
  const out: ExpiringDocument[] = [];
  for (const [docType, group] of Array.from(byType.entries())) {
    const v = complianceDocumentValidity(group, docType, at, noticeDays);
    const newest = group.slice().sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0]!;
    out.push({
      documentId: newest.id, docType, title: newest.title,
      state: v.state, expiresAt: v.expiresAt, daysRemaining: v.daysRemaining, reason: v.reason,
    });
  }
  return out.sort((a, b) =>
    SEVERITY[a.state] - SEVERITY[b.state] ||
    (a.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (b.daysRemaining ?? Number.MAX_SAFE_INTEGER) ||
    a.docType.localeCompare(b.docType));
}
