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
  title: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  verificationStatus: "needs_review" | "verified" | "rejected";
  capturedAt: Date;
};

/** One document, with the engine's verdict on it. */
export type ExpiringDocument = {
  documentId: number;
  docType: string;
  title: string | null;
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

/**
 * One type's rows, in version order. `capturedAt` is the ordinal; `id` breaks a tie, because rows
 * captured in the same instant would otherwise take whatever order the database returned them in,
 * and the same records must always yield the same verdict.
 */
const versionsOf = (rows: readonly ComplianceDocumentRow[], docType: string): ComplianceDocumentRow[] =>
  rows.filter(r => r.docType === docType)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id - b.id);

/** The engine's verdict for one document type, from that type's rows alone. */
export function complianceDocumentValidity(
  rows: readonly ComplianceDocumentRow[], docType: string, at: Date, noticeDays = 30,
): Validity {
  return validityOf(versionsOf(rows, docType).map(asVersion), at, noticeDays);
}

/**
 * SPINE item 2 — the one answer every consumer reads: dispatch, the documentExpiry tile, the
 * insurance proof and medical fitness. It is `validityOf`'s verdict, plus the three facts a
 * consumer needs to present it without re-deciding it.
 */
export type ComplianceVerdict = Validity & {
  /** The accepted type whose verdict stands; null only when no type was asked about. */
  docType: string | null;
  /** The row the verdict names, so a consumer can link to it. Null when nothing is on file. */
  documentId: number | null;
  /**
   * `unverified` only: the date the newest unchecked row claims. Nobody has verified it, so it
   * may never CLEAR anything — but a claim that the document has already lapsed is still evidence
   * of expiry, and `claimLapsed` says so. Every other state carries the verdict's own expiry.
   */
  claimedExpiresAt: Date | null;
  claimLapsed: boolean;
};

/**
 * Where several types satisfy one requirement (an inspection is a CVIP certificate or an annual
 * inspection; insurance is proven by a proof or a card), each is judged on its own rows and the
 * most favourable verdict stands, because any one of them satisfies it. Ties keep the order the
 * types were given in.
 */
export const FAVOURABLE: Readonly<Record<ValidityState, number>> = {
  in_force: 0, expiring: 1, incomplete: 2, unverified: 3, not_yet_effective: 4, expired: 5, rejected: 6, none: 7,
};

export function complianceRequirementValidity(
  rows: readonly ComplianceDocumentRow[], docTypes: readonly string[], at: Date, noticeDays = 30,
): ComplianceVerdict {
  return mostFavourableVerdict(docTypes.map(docType => {
    const versions = versionsOf(rows, docType);
    const v = validityOf(versions.map(asVersion), at, noticeDays);
    const named = v.version != null ? versions[v.version - 1] ?? null : null;
    const claimedExpiresAt = v.state === "unverified" ? named?.expiresAt ?? null : v.expiresAt;
    const verdict: ComplianceVerdict = {
      ...v, docType, documentId: named?.id ?? null, claimedExpiresAt,
      claimLapsed: v.state === "unverified" && claimedExpiresAt !== null && claimedExpiresAt.getTime() < at.getTime(),
    };
    return verdict;
  }));
}

/**
 * Of several verdicts on things that each satisfy the same requirement, the one that stands: the
 * most favourable, ties in the order given. Used by `complianceRequirementValidity` across types,
 * and by the passport across the subjects of a work combination. It chooses between verdicts; it
 * never reaches one.
 */
export function mostFavourableVerdict(verdicts: readonly ComplianceVerdict[]): ComplianceVerdict {
  const ranked = verdicts.map((verdict, order) => ({ verdict, order }))
    .sort((a, b) => FAVOURABLE[a.verdict.state] - FAVOURABLE[b.verdict.state] || a.order - b.order);
  return ranked[0]?.verdict ?? {
    state: "none", version: null, expiresAt: null, daysRemaining: null, reason: "No document type was asked about",
    docType: null, documentId: null, claimedExpiresAt: null, claimLapsed: false,
  };
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
    const v = complianceRequirementValidity(group, [docType], at, noticeDays);
    const named = group.find(r => r.id === v.documentId) ?? versionsOf(group, docType)[group.length - 1]!;
    out.push({
      documentId: named.id, docType, title: named.title,
      state: v.state, expiresAt: v.expiresAt, daysRemaining: v.daysRemaining, reason: v.reason,
    });
  }
  return out.sort((a, b) =>
    SEVERITY[a.state] - SEVERITY[b.state] ||
    (a.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (b.daysRemaining ?? Number.MAX_SAFE_INTEGER) ||
    a.docType.localeCompare(b.docType));
}

/**
 * SPINE item 2 — the one answer to "is this person's driver licence in force?".
 *
 * The structured `driver_licence` documents decide, through `complianceRequirementValidity`. Only
 * when they establish nothing (none on file, or only rejected rows) does the flat legacy date
 * `operators.licenseExpiresAt` speak — and then as an UNVERIFIED claim, never a clearance (owner's
 * ruling, 2026-09-25): nobody has checked it against a licence. A legacy date already past is a
 * lapsed claim, which may block.
 *
 * Dispatch (`readinessComposer`), open-shift eligibility and shift readiness all read the licence
 * through this. Before it, open shifts and shift readiness each read the legacy date themselves
 * and treated a future one as in force — so a worker dispatch held at "licence unknown" was shown
 * an open shift as eligible.
 */
export const DRIVER_LICENCE_DOC_TYPES: readonly string[] = ["driver_licence"];

export function driverLicenceVerdict(
  rows: readonly ComplianceDocumentRow[], legacyExpiresAt: Date | null, at: Date,
): ComplianceVerdict & { source: "documents" | "legacy_record" } {
  const v = complianceRequirementValidity(rows, DRIVER_LICENCE_DOC_TYPES, at);
  if ((v.state !== "none" && v.state !== "rejected") || !legacyExpiresAt) return { ...v, source: "documents" };
  return {
    state: "unverified", version: null, expiresAt: null, daysRemaining: null,
    reason: "the date is from the legacy operator record, which nobody has checked against a licence",
    docType: "driver_licence", documentId: null, claimedExpiresAt: legacyExpiresAt,
    claimLapsed: legacyExpiresAt.getTime() < at.getTime(), source: "legacy_record",
  };
}
