/**
 * One place that decides whether a compliance document is in force (v22.23 B28; wired in C1b-3).
 *
 * Pure. No network.
 *
 * `complianceDocuments` expiry used to be decided inline in four places: the documentExpiry widget
 * tile, the compliance passport, the readiness composer's credential choice and the dispatch
 * credential blocker. Each was correct-looking and each disagreed with the others somewhere
 * (docs/compliance/checkpoints/C1B_3_DOCUMENT_VALIDITY_AND_QUALIFICATION_READS.md). All four now ask
 * this module, and this module asks `documentValidity.readExpiry` — so there is one choice of the
 * governing row and one expiry calculation, and each caller keeps only its own presentation.
 *
 * A compliance row is not a document version, so this adapts rather than pretends. Rows carry no
 * version number, and the rule every live caller already used is kept: **verified beats
 * needs_review beats rejected, then the latest expiry** (a missing expiry sorts last). That is also
 * what the old adapter got wrong — it took the most recently captured row, which none of the live
 * callers did, and it had no production caller to notice.
 */

import { readExpiry, type ExpiryClass, type ValidityState } from "./documentValidity";

export type ClaimVerification = "needs_review" | "verified" | "rejected";

/** The columns of a `complianceDocuments` row this rule reads. Callers pass their own row shape. */
export type ComplianceClaim = {
  docType: string;
  expiresAt?: Date | null;
  verificationStatus: ClaimVerification;
};

export type ClaimValidity<T extends ComplianceClaim = ComplianceClaim> = {
  /** The engine's vocabulary: in_force | expiring | expired | unverified | rejected | none. */
  state: ValidityState;
  /** The row that governs, or null when there is none. */
  claim: T | null;
  /** The governing row's expiry reading, whatever its verification — callers decide the precedence. */
  expiry: ExpiryClass | null;
  expiresAt: Date | null;
  daysRemaining: number | null;
};

const RANK: Readonly<Record<ClaimVerification, number>> = { verified: 2, needs_review: 1, rejected: 0 };

/** The governing row: verified, then needs_review, then rejected; within a rank the latest expiry. Stable. */
export function governingClaim<T extends ComplianceClaim>(rows: readonly T[]): T | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) =>
    RANK[b.verificationStatus] - RANK[a.verificationStatus] || (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0]!;
}

/**
 * The verdict over rows the caller has already matched (a passport requirement matches by key or by
 * any of several document types). `noticeDays` is the caller's warning window; `<= 0` means none.
 */
export function claimValidity<T extends ComplianceClaim>(rows: readonly T[], at: Date, noticeDays = 30): ClaimValidity<T> {
  const claim = governingClaim(rows);
  if (!claim) return { state: "none", claim: null, expiry: null, expiresAt: null, daysRemaining: null };
  const { expiry, daysRemaining } = readExpiry(claim.expiresAt, at, noticeDays);
  const expiresAt = claim.expiresAt ?? null;
  if (claim.verificationStatus === "rejected") return { state: "rejected", claim, expiry, expiresAt, daysRemaining };
  if (claim.verificationStatus === "needs_review") return { state: "unverified", claim, expiry, expiresAt, daysRemaining };
  const state: ValidityState = expiry === "expired" ? "expired" : expiry === "expiring" ? "expiring" : "in_force";
  return { state, claim, expiry, expiresAt, daysRemaining };
}

/** The verdict for one or more document types, from those types' rows alone. */
export function complianceDocumentValidity<T extends ComplianceClaim>(
  rows: readonly T[], docTypes: string | readonly string[], at: Date, noticeDays = 30,
): ClaimValidity<T> {
  const types = typeof docTypes === "string" ? [docTypes] : docTypes;
  return claimValidity(rows.filter((r) => types.includes(r.docType)), at, noticeDays);
}

/**
 * A verification value from outside the column's enum (a serialized row, a missing field) is not
 * evidence of anything: it reads as needs_review, never as verified.
 */
export const asClaimVerification = (v: string | null | undefined): ClaimVerification =>
  v === "verified" ? "verified" : v === "rejected" ? "rejected" : "needs_review";
