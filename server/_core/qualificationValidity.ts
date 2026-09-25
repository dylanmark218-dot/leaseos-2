/**
 * v22.20 — one place that decides whether a qualification counts.
 *
 * Pure. No network.
 *
 * `documentValidity` was written as the canonical answer to "is this in force"
 * and then nothing imported it, while four routers each decided the same
 * question inline: open shifts, readiness, the crew forecast and the calendar.
 * Four correct-looking implementations of one rule is how they stop agreeing —
 * the same shape as two receipt vocabularies and two never-automatic floors,
 * and this one was already live.
 *
 * A holding is not a document version, so this adapts rather than pretends:
 * a qualification row carries the same three facts the engine needs — was it
 * verified, from when, until when — and the engine decides from those.
 */

import { validityOf, type DocumentVersion, type Validity } from "./documentValidity";
import type { DocumentType } from "./documentExtraction";

/** The columns of `workerQualifications` this rule actually reads. */
export type QualificationHolding = {
  holdingRef: string;
  code: string;
  verificationState: "unverified" | "extracted" | "verified" | "rejected" | "superseded";
  issuedAt: Date | null;
  expiresAt: Date | null;
  recordedAt: Date;
};

/**
 * Present a holding to the engine as the version it is.
 *
 * `recordedAt` becomes the version ordinal because holdings have no version
 * number: the most recently recorded one is the current claim, which is what
 * the routers were each computing by hand.
 */
const asVersion = (h: QualificationHolding, index: number): DocumentVersion => ({
  documentRef: h.holdingRef,
  version: index + 1,
  type: h.code as DocumentType,
  subjectRef: h.code,
  // The engine calls the not-yet-checked state `uploaded`; the column calls it
  // `unverified`. Same fact, two words, and this adapter is the only place they
  // meet — a mismatch that would otherwise be translated at each call site.
  state: h.verificationState === "unverified" ? "uploaded" : h.verificationState,
  effectiveFrom: h.issuedAt,
  expiresAt: h.expiresAt,
  verifiedByUserId: null,
  verifiedAt: null,
  supersededByVersion: null,
  uploadedAt: h.recordedAt,
});

/**
 * Whether a person holds a given qualification at a moment.
 *
 * Returns the engine's own verdict, so "verified with no expiry recorded" comes
 * back as `in_force` or not by the same rule everywhere rather than by whatever
 * each caller remembered.
 */
export function qualificationValidity(holdings: readonly QualificationHolding[], code: string, at: Date): Validity {
  const forCode = holdings
    .filter(h => h.code === code)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
    .map(asVersion);
  return validityOf(forCode, at);
}

/**
 * The stricter reading the operational paths want.
 *
 * A ticket the work requires counts only while it is in force *and* has an
 * establishable end — currency that cannot be established is not currency.
 * `validityOf` now says the same thing itself (`incomplete`, unless the type is
 * named in `EXPIRY_OPTIONAL_TYPES`); the `expiresAt == null` check below stays so
 * that a type ever added to that list still cannot clear a ticket this path needs
 * a date for.
 */
export type NotHeldCode = "unknown" | "unverified" | "expired" | "rejected";

export function countsAsHeld(
  holdings: readonly QualificationHolding[], code: string, at: Date,
): { held: boolean; reason: string; code: NotHeldCode | null } {
  const v = qualificationValidity(holdings, code, at);
  if (v.state === "none") return { held: false, code: "unknown", reason: `No ${code} on record — unknown is not satisfied` };
  if (v.state === "rejected") return { held: false, code: "rejected", reason: `${code} was reviewed and rejected` };
  if (v.state === "unverified") {
    // Naming which non-verified state it is: "extracted" and "uploaded" are
    // both short of an assertion, and a reader chasing it needs to know which.
    const actual = holdings.filter(h => h.code === code).sort((x, y) => y.recordedAt.getTime() - x.recordedAt.getTime())[0];
    const word = actual?.verificationState === "extracted" ? "extracted" : "unverified";
    return { held: false, code: "unverified", reason: `${code} is on file but ${word}; nobody has checked it against the certificate` };
  }
  // Checked, but its effective date has not come: not held yet. The code stays "unverified", which
  // is what this case reported before the engine named it separately.
  if (v.state === "not_yet_effective") return { held: false, code: "unverified", reason: `${code} ${v.reason.replace(/^Version \d+ /, "")}` };
  if (v.state === "incomplete" || v.expiresAt == null) return { held: false, code: "unknown", reason: `${code} is verified with no expiry recorded — currency cannot be established` };
  if (v.state === "expired") return { held: false, code: "expired", reason: `${code} expired ${Math.abs(v.daysRemaining ?? 0)} day(s) before this` };
  return { held: true, code: null, reason: v.reason };
}

/** Which of a required set a person is missing, with the reason for each. */
export function missingFrom(
  holdings: readonly QualificationHolding[],
  required: readonly string[],
  at: Date,
): { code: string; reason: string; why: NotHeldCode }[] {
  return required
    .map(qualification => ({ qualification, ...countsAsHeld(holdings, qualification, at) }))
    .filter(r => !r.held)
    .map(r => ({ code: r.qualification, reason: r.reason, why: r.code! }));
}
