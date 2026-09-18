/**
 * P8.5 — the restricted records vault.
 *
 * Three owner decisions shape everything here, and each one is a refusal to do the easy thing:
 *
 *   **Administration role alone is not access.** Holding the role gets a person as far as the
 *   prompt. Opening a record needs a purpose-bound grant for *that record*, and it expires. A
 *   sector-wide grant would mean one break-glass at 9am opens everything for the rest of the day,
 *   which is a login, not a break-glass.
 *
 *   **The audit event is written before the content is served.** If that write fails, access
 *   fails. An access log that can be outrun by the read it describes is not an access log — it is
 *   a log that is complete exactly when nothing has gone wrong.
 *
 *   **The system proposes an internal investigation; it never compels one.** A company may decide a
 *   matter is handled in-house. What is recorded is that a proposal was raised and deliberately
 *   declined, by whom and when — never any investigation content, because declining creates no
 *   investigation to have content. The owner's words: we don't have the right to say how they run
 *   their company.
 */

/** Book 17 PRV-CLS-001. Stored on the record, never inferred at read time. */
export type SensitivityTier = "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED" | "HIGHLY_RESTRICTED";

/** The tiers that live in the restricted sector, and are therefore gated. */
export const RESTRICTED_TIERS: readonly SensitivityTier[] = ["RESTRICTED", "HIGHLY_RESTRICTED"];
export const isRestricted = (tier: SensitivityTier): boolean => RESTRICTED_TIERS.includes(tier);

export type MatterType =
  | "INSURANCE_CLAIM" | "WCB_CLAIM" | "REGULATORY_REPORT" | "POLICE_FILE"
  | "CLIENT_NOTICE" | "THIRD_PARTY_CLAIM" | "INTERNAL_INVESTIGATION" | "LITIGATION";

/**
 * §3.1 — the tier each matter type carries. WCB is its own chain, deliberately not a variety of
 * insurance claim: it has its own lifecycle, its own deadlines and its own privacy boundary, and
 * folding it into insurance is how a supervisor ends up reading a diagnosis.
 */
export const TIER_OF_MATTER: Readonly<Record<MatterType, SensitivityTier>> = {
  INSURANCE_CLAIM: "CONFIDENTIAL",
  WCB_CLAIM: "CONFIDENTIAL",
  REGULATORY_REPORT: "CONFIDENTIAL",
  POLICE_FILE: "CONFIDENTIAL",
  CLIENT_NOTICE: "CONFIDENTIAL",
  THIRD_PARTY_CLAIM: "CONFIDENTIAL",
  LITIGATION: "CONFIDENTIAL",
  // The one restricted matter: an internal investigation is the company's own deliberation.
  INTERNAL_INVESTIGATION: "RESTRICTED",
};

/**
 * §12 — a tracking number that does not encode its category.
 *
 * `INV-2026-0003` tells anyone who glances at a spreadsheet that this incident produced an
 * investigation, which is the single fact the restricted sector exists to keep. One prefix for
 * every matter type, and the type is a property of the row rather than of the string.
 */
export const matterTrackingNumber = (seq: number, year = new Date().getUTCFullYear()): string =>
  `MTR-${year}-${String(seq).padStart(6, "0")}`;

/** §12 — the category must not be readable from the number, for any matter type. */
export function trackingNumberLeaksCategory(trackingNumber: string): boolean {
  return /INV|WCB|INS|POL|LIT|CLAIM|INVEST|REG/i.test(trackingNumber.replace(/^MTR-/, ""));
}

/* ------------------------------------------------------------------ */
/* Break-glass                                                         */
/* ------------------------------------------------------------------ */

export type AccessDecision =
  | { allowed: true; grantId: number; mustLogBeforeServing: true }
  /** Book 12's structured denial: a code and a reason a person can act on. */
  | { allowed: false; code: AccessDenialCode; reason: string; promptRequired: boolean };

export type AccessDenialCode =
  | "NO_RESTRICTED_PERMISSION"
  | "BREAK_GLASS_REQUIRED"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_FOR_ANOTHER_RECORD";

export type ExistingGrant = {
  id: number;
  userId: number;
  recordType: string;
  recordId: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

/**
 * Whether this person may open this record right now.
 *
 * The prompt is the gate, not a banner: a person without a grant is *denied* with
 * `BREAK_GLASS_REQUIRED` and `promptRequired`, and the caller must take them through the prompt and
 * create a grant. Returning "allowed, but please show a warning" would leave the decision in the
 * UI, where a second client, an export job or a support script simply would not ask.
 */
export function evaluateRestrictedAccess(args: {
  holdsRestrictedPermission: boolean;
  userId: number;
  recordType: string;
  recordId: number;
  grants: readonly ExistingGrant[];
  now: Date;
}): AccessDecision {
  if (!args.holdsRestrictedPermission) {
    return {
      allowed: false, code: "NO_RESTRICTED_PERMISSION", promptRequired: false,
      reason: "This record is in the restricted sector and your roles do not include permission to read that tier. Holding an administration role is not by itself access to it.",
    };
  }
  // Bound to the person AND the record: a grant for another record is not a lesser grant, it is a
  // different one, and saying so by name keeps "I had a grant open" from meaning anything.
  const mine = args.grants.filter(g => g.userId === args.userId && g.recordType === args.recordType && g.recordId === args.recordId);
  const live = mine.find(g => g.revokedAt == null && g.expiresAt.getTime() > args.now.getTime());
  if (live) return { allowed: true, grantId: live.id, mustLogBeforeServing: true };

  const revoked = mine.find(g => g.revokedAt != null);
  const expired = mine.find(g => g.revokedAt == null && g.expiresAt.getTime() <= args.now.getTime());
  if (revoked) {
    return {
      allowed: false, code: "GRANT_REVOKED", promptRequired: true,
      reason: "Your grant for this record was revoked. Revocation takes effect immediately; opening it again needs a new purpose.",
    };
  }
  if (expired) {
    return {
      allowed: false, code: "GRANT_EXPIRED", promptRequired: true,
      reason: "Your grant for this record has expired. Expiry is enforced here, not by hiding the link, so a stale tab cannot outlive it.",
    };
  }
  return {
    allowed: false, code: "BREAK_GLASS_REQUIRED", promptRequired: true,
    reason: "Opening this record needs a stated purpose. The prompt is the gate: state why you need it, and the grant, this access and every later read under it are logged.",
  };
}

/** A purpose that explains nothing a year later is not a purpose. */
export function validatePurpose(purpose: string): { ok: true } | { ok: false; reason: string } {
  const p = purpose.trim();
  if (p.length < 20) {
    return { ok: false, reason: "State the purpose in a sentence — at least twenty characters. A word like \"audit\" or \"review\" will not explain this access to anyone reading it later, including you." };
  }
  if (/^(audit|review|check|investigation|work|admin|test)$/i.test(p)) {
    return { ok: false, reason: "That is a category, not a purpose. Say what you are trying to establish and why this record is the one that answers it." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The investigation proposal                                          */
/* ------------------------------------------------------------------ */

export type ProposalTrigger = { rule: string; policy: string | null; because: string };

/**
 * §5.3 — proposals come from stated rules, not from a model's judgement.
 *
 * A rule can be read, argued with and changed by the company. "The AI thought this looked serious"
 * can be none of those, and an investigation proposed on that basis is a proposal nobody can
 * contest. These conditions are all facts the incident record already carries.
 */
export function proposeInternalInvestigation(incident: {
  injuryReported?: boolean | null;
  emergencyServicesAttended?: boolean | null;
  policeAttended?: boolean | null;
  environmentalRelease?: boolean | null;
  dangerousGoodsInvolved?: boolean | null;
  workStopped?: boolean | null;
  unitHeld?: boolean | null;
  severity?: string | null;
}): ProposalTrigger | null {
  if (incident.injuryReported) return { rule: "injury_reported", policy: "Book 10 / Book 39", because: "an injury was reported on this incident" };
  if (incident.emergencyServicesAttended) return { rule: "emergency_services_attended", policy: "Book 49", because: "emergency services attended" };
  if (incident.environmentalRelease) return { rule: "environmental_release", policy: "Book 10", because: "an environmental release was recorded" };
  if (incident.dangerousGoodsInvolved) return { rule: "dangerous_goods_involved", policy: "Book 09", because: "dangerous goods were involved" };
  if (incident.workStopped || incident.unitHeld) return { rule: "work_stopped_or_unit_held", policy: "Book 02", because: "work was stopped or the unit was held" };
  if (incident.policeAttended) return { rule: "police_attended", policy: "Book 49", because: "police attended" };
  if ((incident.severity ?? "").toLowerCase() === "critical") return { rule: "critical_severity", policy: "Book 49", because: "the incident is recorded as critical" };
  return null;
}

export type Disposition = "PENDING" | "OPENED" | "HANDLED_INTERNALLY" | "NOT_WARRANTED" | "DEFERRED";

/**
 * §5.2 — what a decision may record.
 *
 * Declining records that a proposal was raised and deliberately declined. It records no content,
 * because there is no investigation to have content. A reason is **optional**: a company handling a
 * matter in-house owes the system an answer about whether, not an essay about why.
 */
export function declineRecordsOnly(disposition: Disposition): readonly string[] {
  if (disposition === "OPENED") return ["the matter row, and the investigation's own lifecycle"];
  return ["that a proposal was raised", "which rule raised it", "who decided", "when", "the disposition", "a reason, if one was given"];
}

/** The decline must never create an investigation. A helper the router and its tests share. */
export const createsInvestigation = (d: Disposition): boolean => d === "OPENED";
