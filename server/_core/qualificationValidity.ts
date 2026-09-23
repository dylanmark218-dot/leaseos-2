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
 * Oldest first. `recordedAt` is stored to the second, so a renewal recorded in the same second as the
 * holding it replaces ties with it; a superseded holding was replaced by a later one, so on a tie it
 * sorts first and the replacement is the current claim. (0172 — found when a renewal test recorded
 * both inside one second and the superseded row came back as current.)
 */
export const byRecordedThenSuperseded = (a: QualificationHolding, b: QualificationHolding) =>
  a.recordedAt.getTime() - b.recordedAt.getTime()
  || (a.verificationState === "superseded" ? -1 : 0) - (b.verificationState === "superseded" ? -1 : 0);

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
    .sort(byRecordedThenSuperseded)
    .map(asVersion);
  return validityOf(forCode, at);
}

/**
 * The stricter reading the operational paths want.
 *
 * A ticket the work requires counts only while it is in force *and* has an
 * establishable end. `validityOf` reports a verified holding with no expiry as
 * in force with no expiry, which is the right answer for a document library and
 * the wrong one for "may this person haul dangerous goods today" — currency
 * that cannot be established is not currency.
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
    const actual = holdings.filter(h => h.code === code).sort((x, y) => byRecordedThenSuperseded(y, x))[0];
    const word = actual?.verificationState === "extracted" ? "extracted" : "unverified";
    return { held: false, code: "unverified", reason: `${code} is on file but ${word}; nobody has checked it against the certificate` };
  }
  if (v.expiresAt == null) return { held: false, code: "unknown", reason: `${code} is verified with no expiry recorded — currency cannot be established` };
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

/* ------------------------------------------------------------------ */
/* 0172 — the same rule, told what kind of credential it is reading.  */
/* ------------------------------------------------------------------ */

/**
 * `countsAsHeld` refuses a verified holding with no expiry, and for a ticket
 * that has one that is right. Two credentials the wallet now carries are not
 * that shape, and each has a different reason:
 *
 *  - an endorsement with no renewal by rule (Alberta's Q) never has an expiry
 *    to record, so "no expiry recorded" is not missing currency — its currency
 *    is the licence it sits on, and it is held only while that licence is;
 *  - a provincially restricted Class 1 is in force, but not for work that
 *    leaves the province, so the restriction has to be read against the job.
 *
 * Neither is a second validity rule. Both call `countsAsHeld` and
 * `qualificationValidity` for the in-force question and add only the one fact
 * the plain rule cannot know. With no policy and no scope this returns exactly
 * what `countsAsHeld` returns.
 */
export type HoldingExpiryBasis = "actual_expiry_required" | "no_expiry_by_rule";
export type HeldPolicy = {
  expiryBasis: HoldingExpiryBasis;
  /** For `no_expiry_by_rule`: held only while at least one of these is held. */
  parentAnyOf?: readonly string[] | null;
};
export type RequirementScope = { interprovincial?: boolean };
export type HeldVerdict = { held: boolean; reason: string; code: NotHeldCode | "restricted" | null };

/** Restriction codes that mean "this province only". Kept as data; the wallet writes these. */
export const PROVINCIAL_RESTRICTION_CODES = ["PROVINCIAL_RESTRICTION", "AB_PROVINCIAL_RESTRICTION"] as const;

/** The holding the canonical rule considers in force, so its restrictions can be read. */
export function holdingInForce<T extends QualificationHolding>(holdings: readonly T[], code: string, at: Date): T | null {
  const v = qualificationValidity(holdings, code, at);
  if (v.version == null || (v.state !== "in_force" && v.state !== "expiring" && v.state !== "expired")) return null;
  const ordered = holdings.filter(h => h.code === code).sort(byRecordedThenSuperseded);
  return ordered[v.version - 1] ?? null;
}

export function countsAsHeldUnder(
  holdings: readonly (QualificationHolding & { restrictions?: readonly string[] | null })[],
  code: string,
  at: Date,
  policy?: HeldPolicy | null,
  scope?: RequirementScope | null,
): HeldVerdict {
  let verdict: HeldVerdict = countsAsHeld(holdings, code, at);
  if (!verdict.held && policy?.expiryBasis === "no_expiry_by_rule") {
    const v = qualificationValidity(holdings, code, at);
    if ((v.state === "in_force" || v.state === "expiring") && v.expiresAt == null) {
      const parents = policy.parentAnyOf ?? [];
      const parent = parents.map(p => ({ p, r: countsAsHeld(holdings, p, at) })).find(x => x.r.held);
      verdict = parent
        ? { held: true, code: null, reason: `${code} verified; no renewal by rule, and ${parent.p} is held` }
        : parents.length
          ? { held: false, code: "unknown", reason: `${code} is verified and has no renewal by rule, but it is only valid on a current licence — none of ${parents.join(", ")} is held` }
          : verdict;
    }
  }
  if (verdict.held && scope?.interprovincial) {
    const h = holdingInForce(holdings, code, at);
    const restricted = (h?.restrictions ?? []).some(r => (PROVINCIAL_RESTRICTION_CODES as readonly string[]).includes(r));
    if (restricted) return { held: false, code: "restricted", reason: `${code} is provincially restricted; this work requires interprovincial operating authority` };
  }
  return verdict;
}
