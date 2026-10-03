/**
 * Who may decide a compliance credential, and from which state. Pure: the verification service
 * (server/credentialVerificationService.ts) supplies the facts and enforces the answer, and every
 * path that can verify or reject a credential goes through that service.
 *
 * Separation of duties:
 *  - the person the credential is about may never decide it;
 *  - the person who entered it may never decide it;
 *  - an unknown recorder (historical rows) is no exemption: the subject rule still applies, and the
 *    service also consults the portfolio's own upload record.
 *
 * State: only a credential awaiting review can be decided. A rejected credential is not re-decided in
 * place; the holder submits it again, which is a new version in `needs_review` (the canonical validity
 * rule reads versions, so the rejection stays on the record).
 */
export type CredentialDecision = "verified" | "rejected";
export type CredentialState = "needs_review" | "verified" | "rejected";

export type VerificationFacts = {
  verifierUserId: number;
  /** The person the credential is about, when it is about a person. */
  subjectUserId: number | null;
  /** Who entered it: the column when present, else what the portfolio logged; null when unknown. */
  recordedByUserIds: readonly number[];
  state: CredentialState;
};

export type VerificationRefusal =
  | { code: "FORBIDDEN"; reason: "own_credential" | "recorded_it"; message: string }
  | { code: "PRECONDITION_FAILED"; reason: "already_verified" | "rejected_needs_resubmission"; message: string };

export function verificationRefusal(f: VerificationFacts): VerificationRefusal | null {
  if (f.subjectUserId != null && f.subjectUserId === f.verifierUserId) {
    return { code: "FORBIDDEN", reason: "own_credential", message: "You may not verify your own credential" };
  }
  if (f.recordedByUserIds.includes(f.verifierUserId)) {
    return { code: "FORBIDDEN", reason: "recorded_it", message: "The person who recorded or submitted the credential may not verify it" };
  }
  if (f.state === "verified") {
    return { code: "PRECONDITION_FAILED", reason: "already_verified", message: "Credential is already verified" };
  }
  if (f.state === "rejected") {
    return { code: "PRECONDITION_FAILED", reason: "rejected_needs_resubmission", message: "A rejected credential is not decided again; the holder submits it again as a new version for review" };
  }
  return null;
}
