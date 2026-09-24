/**
 * 0172 — credential lifecycle: wallet, renewal and recertification.
 *
 * Pure. No database, no network, no clock except the one passed in.
 *
 * Five questions, answered separately and never folded into "trained = yes":
 *
 *   1. what has this worker studied            — Academy assignments/attempts
 *   2. what have they demonstrated             — practical evaluations
 *   3. what verified credentials do they hold  — `workerQualifications`, read
 *                                                through the canonical rule in
 *                                                `qualificationValidity.ts`
 *   4. what is expiring or needs review        — this module
 *   5. what external training must be arranged — `externalTrainingHandoff.ts`
 *
 * This module never decides whether a credential satisfies work. That answer
 * belongs to `countsAsHeld`/`countsAsHeldUnder`; everything here is about
 * dates, labels and who to tell.
 *
 * Policies are source records, not constants scattered through routers. A
 * policy states which KIND of date governs a credential. It never supplies an
 * expiry the certificate does not carry: `typicalValidityMonths` is shown to a
 * reader as context ("current certificates are typically valid up to 3
 * years") and is never added to an issue date to manufacture a legal expiry.
 */
import { stableHash } from "./trainingAcademy";
import { addCalendarMonths, ACADEMY_REGULATORY_PROFILES } from "./trainingAcademyRegulatory";
import { DEFAULT_ESCALATION, stepAt, thresholdsOf, type EscalationPolicy, type EscalationUrgency } from "./complianceOperations";
import { countsAsHeldUnder, type HeldPolicy, type HeldVerdict, type QualificationHolding, type RequirementScope } from "./qualificationValidity";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

/** Who stands behind the credential. Distinct from the Academy's course boundary on purpose. */
export type WalletBoundary = "employer_issued" | "company_competency" | "regulator_issued" | "external_provider" | "study_only";

/**
 * Which kind of date governs this credential.
 *  - `actual_expiry`          the certificate/licence carries its own expiry; LeaseOS reads it, never computes it
 *  - `server_profile_expiry`  LeaseOS issues it and computes the expiry from a versioned regulatory profile (TDG road)
 *  - `no_expiry_endorsement`  no renewal by rule; currency comes from the licence it sits on (Alberta Q)
 *  - `employer_review`        no statutory expiry; the employer may set a review date, labelled as company policy (WHMIS)
 *  - `unknown`                nobody has established the rule yet — the answer is UNKNOWN, not "no expiry"
 */
export type LifecycleKind = "actual_expiry" | "server_profile_expiry" | "no_expiry_endorsement" | "employer_review" | "unknown";

export type HandoffCapability =
  | "H2S_ALIVE" | "FIRST_AID_BASIC" | "FIRST_AID_INTERMEDIATE" | "FIRST_AID_ADVANCED"
  | "CLASS1" | "CLASS2" | "CLASS3" | "CLASS4" | "AIR_BRAKE_Q"
  | "FALL_PROTECTION" | "CONFINED_SPACE" | "GROUND_DISTURBANCE";

export const HANDOFF_CAPABILITIES: readonly HandoffCapability[] = [
  "H2S_ALIVE", "FIRST_AID_BASIC", "FIRST_AID_INTERMEDIATE", "FIRST_AID_ADVANCED",
  "CLASS1", "CLASS2", "CLASS3", "CLASS4", "AIR_BRAKE_Q",
  "FALL_PROTECTION", "CONFINED_SPACE", "GROUND_DISTURBANCE",
];

export type CredentialPolicySeed = {
  policyRef: string;
  qualificationCode: string;
  displayName: string;
  jurisdiction: string;
  policyVersion: number;
  boundary: WalletBoundary;
  lifecycle: LifecycleKind;
  /** Context only. Never added to an issue date. */
  typicalValidityMonths: number | null;
  /** For `server_profile_expiry`: which Academy regulatory profile computes it. */
  regulatoryProfileRef: string | null;
  /** For `no_expiry_endorsement`: held only while one of these is held. */
  parentAnyOf: string[] | null;
  /** External training LeaseOS cannot issue and must hand off. Null for internal credentials. */
  handoffCapabilities: HandoffCapability[] | null;
  /** Authoritative sources (Academy source records) — never a preferred provider. */
  sourceRefs: string[];
  /** Renewal-pathway conditions stated by the issuer, versioned with the policy. Null = none recorded. */
  renewalPathway: { label: string; condition: "current_verified_certificate_not_expired"; sourceRef: string } | null;
  reminderTemplate: string;
  notes: string;
  effectiveAt: string;
};

/**
 * Company-configurable, per tenant. These are notification thresholds and
 * company policy, and are labelled as such everywhere they appear.
 */
export type CompanyCredentialSettings = {
  warningThresholdDays: number[];
  /** Company-policy review interval for credentials with `employer_review` lifecycle. */
  employerReviewMonths: number | null;
  /** Company-policy refresher recommendation. Not an expiry. */
  recommendedRefresherMonths: number | null;
};

export const DEFAULT_WARNING_THRESHOLDS: readonly number[] = [120, 90, 60, 30, 14, 7, 1];

/* ------------------------------------------------------------------ */
/* Seeded policies                                                      */
/* ------------------------------------------------------------------ */

const EFFECTIVE = "2026-09-23T00:00:00.000Z";
const LICENCES = ["DRIVER_LICENCE_CLASS_1", "DRIVER_LICENCE_CLASS_2", "DRIVER_LICENCE_CLASS_3", "DRIVER_LICENCE_CLASS_4", "DRIVER_LICENCE_CLASS_5"];

const licencePolicy = (cls: 1 | 2 | 3 | 4): CredentialPolicySeed => ({
  policyRef: `POL-AB-LICENCE-CLASS${cls}-V1`,
  qualificationCode: `DRIVER_LICENCE_CLASS_${cls}`,
  displayName: `Alberta Class ${cls} operator's licence`,
  jurisdiction: "CA-AB",
  policyVersion: 1,
  boundary: "regulator_issued",
  lifecycle: "actual_expiry",
  typicalValidityMonths: null,
  regulatoryProfileRef: null,
  parentAnyOf: null,
  handoffCapabilities: [`CLASS${cls}` as HandoffCapability],
  sourceRefs: cls === 1 ? ["SRC-AB-C1LP", "SRC-AB-COMMERCIAL-GUIDE"] : ["SRC-AB-COMMERCIAL-GUIDE", "SRC-AB-DRIVER-TRAINING-SCHOOLS"],
  renewalPathway: null,
  reminderTemplate: `Driver licence renewal required. The verified Class ${cls} licence expires {DATE}.`,
  notes: cls === 1
    ? "Track the actual verified licence expiry and restrictions. A provincially restricted Alberta Class 1 is recorded as a restriction on the holding and does not satisfy work that requires interprovincial operating authority."
    : "Track the actual verified licence expiry and restrictions. LeaseOS study does not issue a licence or road-test result.",
  effectiveAt: EFFECTIVE,
});

export const CREDENTIAL_POLICIES: readonly CredentialPolicySeed[] = [
  {
    policyRef: "POL-TDG-ROAD-V1", qualificationCode: "TDG_ROAD", displayName: "TDG training certificate · road", jurisdiction: "CA", policyVersion: 1,
    boundary: "employer_issued", lifecycle: "server_profile_expiry", typicalValidityMonths: null, regulatoryProfileRef: "REG-TDG-ROAD-V1",
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-TDG-ROAD-2026"], renewalPathway: null,
    reminderTemplate: "TDG road training certificate expires {DATE}. Re-training and a new employer certificate are required through the Academy.",
    notes: "Employer-issued through the Academy. Expiry is computed server-side from REG-TDG-ROAD-V1; never from a caller. Road scope only — never applied to air.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-WHMIS-EMPLOYER-V1", qualificationCode: "WHMIS_EMPLOYER", displayName: "WHMIS · employer education + workplace-specific training", jurisdiction: "CA-AB", policyVersion: 1,
    boundary: "employer_issued", lifecycle: "employer_review", typicalValidityMonths: null, regulatoryProfileRef: "REG-WHMIS-EMPLOYER-V1",
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-WHMIS-AB-2026", "SRC-CCOHS-WHMIS-TRAINING"], renewalPathway: null,
    reminderTemplate: "Company policy: WHMIS training review due {DATE}. This is an employer review date, not a legal expiry.",
    notes: "No generic government WHMIS certificate expiry exists and none is manufactured. Track the employer training version and workplace-specific instruction; a review date, when set, is company policy.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-AB-FIRST-AID-V1", qualificationCode: "FIRST_AID", displayName: "Alberta workplace First Aid", jurisdiction: "CA-AB", policyVersion: 1,
    boundary: "external_provider", lifecycle: "actual_expiry", typicalValidityMonths: 36, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: ["FIRST_AID_BASIC", "FIRST_AID_INTERMEDIATE", "FIRST_AID_ADVANCED"], sourceRefs: ["SRC-AB-FIRST-AID-AGENCIES"], renewalPathway: null,
    reminderTemplate: "Recertification should be arranged before expiry. The verified First Aid certificate expires {DATE}.",
    notes: "External certificate from an approved Alberta training agency. Track the verified certificate's actual expiry; current certificates may be valid up to 3 years, which is context and never a computed date.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-ESC-H2S-ALIVE-V1", qualificationCode: "H2S_ALIVE", displayName: "H2S Alive® (Energy Safety Canada)", jurisdiction: "CA", policyVersion: 1,
    boundary: "external_provider", lifecycle: "actual_expiry", typicalValidityMonths: 36, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: ["H2S_ALIVE"], sourceRefs: ["SRC-ESC-H2S-ALIVE"],
    renewalPathway: { label: "H2S Alive® Blended Renewal (online theory + in-person skills assessment at an authorized provider)", condition: "current_verified_certificate_not_expired", sourceRef: "SRC-ESC-H2S-ALIVE" },
    reminderTemplate: "Renewal required. Current H2S Alive certificate expires {DATE}.",
    notes: "External-track only. Current ESC certification is valid for 3 years — read from the verified certificate. Blended renewal is shown only while the provider's recorded condition holds, and the provider decides.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-AB-AIR-BRAKE-Q-V1", qualificationCode: "AIR_BRAKE_Q", displayName: "Alberta air-brake (Q) endorsement", jurisdiction: "CA-AB", policyVersion: 1,
    boundary: "regulator_issued", lifecycle: "no_expiry_endorsement", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: LICENCES, handoffCapabilities: ["AIR_BRAKE_Q"], sourceRefs: ["SRC-AB-AIR-BRAKE"], renewalPathway: null,
    reminderTemplate: "",
    notes: "Once added to an Alberta licence there is currently no recurring renewal requirement for Q. No expiry reminders are generated; the endorsement is held only while a valid licence carrying it is held.",
    effectiveAt: EFFECTIVE,
  },
  licencePolicy(1), licencePolicy(2), licencePolicy(3), licencePolicy(4),
  {
    policyRef: "POL-AB-MEDICAL-FITNESS-V1", qualificationCode: "COMMERCIAL_MEDICAL_FITNESS", displayName: "Commercial driver medical fitness (compliance fact only)", jurisdiction: "CA-AB", policyVersion: 1,
    boundary: "regulator_issued", lifecycle: "actual_expiry", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-AB-DRIVER-MEDICAL"], renewalPathway: null,
    reminderTemplate: "Medical fitness evidence for the commercial licence is due by {DATE}.",
    notes: "Stores only that the requirement is met, by whom it was verified and until when. No diagnosis, condition or medical detail is stored in LeaseOS.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-COMPANY-LOAD-SECUREMENT-V1", qualificationCode: "LOAD_SECUREMENT_COMPETENT", displayName: "Load securement · company competency", jurisdiction: "COMPANY", policyVersion: 1,
    boundary: "company_competency", lifecycle: "employer_review", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-COMPANY-POLICY-TEMPLATE"], renewalPathway: null,
    reminderTemplate: "Company policy: load securement competency review due {DATE}.",
    notes: "Company competency. Theory plus a practical sign-off by a different, authorized evaluator.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-COMPANY-CORE-V1", qualificationCode: "COMPANY_CORE", displayName: "Company orientation", jurisdiction: "COMPANY", policyVersion: 1,
    boundary: "company_competency", lifecycle: "employer_review", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-COMPANY-POLICY-TEMPLATE"], renewalPathway: null,
    reminderTemplate: "Company policy: orientation review due {DATE}.",
    notes: "Company-specific training; review interval is company policy.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-COMPANY-FIELD-V1", qualificationCode: "COMPANY_FIELD_COMPETENT", displayName: "Company field safety & equipment procedures", jurisdiction: "COMPANY", policyVersion: 1,
    boundary: "company_competency", lifecycle: "employer_review", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-COMPANY-FIELD-TEMPLATE"], renewalPathway: null,
    reminderTemplate: "Company policy: field procedures review due {DATE}.",
    notes: "Company competency: knowledge plus a practical sign-off by a different, authorized evaluator.",
    effectiveAt: EFFECTIVE,
  },
  {
    policyRef: "POL-ERG-KNOWLEDGE-V1", qualificationCode: "ERG_KNOWLEDGE", displayName: "ERG knowledge (study)", jurisdiction: "CA", policyVersion: 1,
    boundary: "study_only", lifecycle: "unknown", typicalValidityMonths: null, regulatoryProfileRef: null,
    parentAnyOf: null, handoffCapabilities: null, sourceRefs: ["SRC-ERG-2024"], renewalPathway: null,
    reminderTemplate: "", notes: "Knowledge only. Never a credential.", effectiveAt: EFFECTIVE,
  },
];

export function policyHash(p: CredentialPolicySeed): string { return stableHash(p); }
export function policyFor(code: string, policies: readonly CredentialPolicySeed[] = CREDENTIAL_POLICIES): CredentialPolicySeed | null {
  return policies.filter(p => p.qualificationCode === code).sort((a, b) => b.policyVersion - a.policyVersion)[0] ?? null;
}

/** How the canonical held rule should read this code. No policy = the strict default. */
export function heldPolicyFor(policy: CredentialPolicySeed | null): HeldPolicy | null {
  if (!policy) return null;
  if (policy.lifecycle === "no_expiry_endorsement") return { expiryBasis: "no_expiry_by_rule", parentAnyOf: policy.parentAnyOf ?? [] };
  return { expiryBasis: "actual_expiry_required" };
}

/** The one entry point operational code uses: canonical rule + the policy's expiry basis + the job's scope. */
export function heldForWork(holdings: readonly (QualificationHolding & { restrictions?: readonly string[] | null })[], code: string, at: Date, scope?: RequirementScope | null, policies: readonly CredentialPolicySeed[] = CREDENTIAL_POLICIES): HeldVerdict {
  return countsAsHeldUnder(holdings, code, at, heldPolicyFor(policyFor(code, policies)), scope);
}

/* ------------------------------------------------------------------ */
/* Lifecycle facts                                                      */
/* ------------------------------------------------------------------ */

export type WalletHolding = QualificationHolding & {
  userId?: number;
  restrictions?: readonly string[] | null;
  supersededByHoldingRef?: string | null;
};

export type LifecycleBasis =
  | "actual_expiry"          // a verified credential with its own expiry
  | "server_profile_expiry"  // LeaseOS-computed from a regulatory profile
  | "no_expiry_by_rule"      // e.g. Q — nothing to remind
  | "employer_review"        // company-policy review date (not a legal expiry)
  | "unknown_unverified"     // on file but nobody verified it
  | "unknown_no_expiry"      // verified, expiry needed but none recorded
  | "unknown_policy"         // no rule established for this code
  | "not_held";

export type LifecycleFacts = {
  code: string;
  basis: LifecycleBasis;
  /** A legal/certificate expiry. Only ever read from a verified holding. */
  legalExpiry: Date | null;
  /** Company policy. Labelled so it cannot be mistaken for a legal expiry. */
  employerReviewAt: Date | null;
  recommendedRefresherAt: Date | null;
  /** When the issuer's renewal pathway can be used, if recorded. */
  renewalWindow: { label: string; availableNow: "yes" | "no" | "UNKNOWN_VERIFY_WITH_PROVIDER"; sourceRef: string } | null;
  /** The date reminders count down to, and what kind of date it is. */
  reminderTarget: { at: Date; kind: "legal_expiry" | "employer_review" } | null;
  labels: string[];
};

function currentVerified(holdings: readonly WalletHolding[], code: string): WalletHolding | null {
  return holdings
    .filter(h => h.code === code && h.verificationState === "verified" && !h.supersededByHoldingRef)
    .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0] ?? null;
}

export function lifecycleFacts(args: {
  code: string;
  holdings: readonly WalletHolding[];
  policy: CredentialPolicySeed | null;
  settings?: Partial<CompanyCredentialSettings> | null;
  now: Date;
}): LifecycleFacts {
  const { code, policy, now } = args;
  const settings = args.settings ?? {};
  const base: LifecycleFacts = { code, basis: "not_held", legalExpiry: null, employerReviewAt: null, recommendedRefresherAt: null, renewalWindow: null, reminderTarget: null, labels: [] };
  const mine = args.holdings.filter(h => h.code === code);
  const verified = currentVerified(mine, code);
  if (!verified) {
    if (mine.some(h => h.verificationState === "unverified" || h.verificationState === "extracted")) {
      return { ...base, basis: "unknown_unverified", labels: ["Uploaded — verification required. An uploaded or OCR-read certificate is not a verified credential."] };
    }
    return base;
  }
  if (!policy || policy.lifecycle === "unknown") {
    return { ...base, basis: "unknown_policy", legalExpiry: verified.expiresAt, labels: ["No renewal rule has been established for this credential — UNKNOWN, not 'no expiry'."] };
  }
  const refresher = settings.recommendedRefresherMonths && verified.issuedAt ? addCalendarMonths(verified.issuedAt, settings.recommendedRefresherMonths) : null;
  const common = { ...base, recommendedRefresherAt: refresher, labels: refresher ? [`Company policy: refresher recommended by ${refresher.toISOString().slice(0, 10)} (not an expiry)`] : [] };

  switch (policy.lifecycle) {
    case "no_expiry_endorsement":
      return { ...common, basis: "no_expiry_by_rule", labels: [...common.labels, "No recurring renewal requirement by rule. Still held only while a valid licence carrying it is held."] };
    case "employer_review": {
      const months = settings.employerReviewMonths ?? null;
      const from = verified.issuedAt ?? verified.recordedAt;
      const review = months ? addCalendarMonths(from, months) : null;
      return {
        ...common, basis: "employer_review", employerReviewAt: review,
        // A legal expiry that the holding genuinely carries is still reported, but never invented.
        legalExpiry: verified.expiresAt,
        reminderTarget: review ? { at: review, kind: "employer_review" } : null,
        labels: [...common.labels, review ? `Company policy review due ${review.toISOString().slice(0, 10)} — not a legal expiry` : "No statutory expiry. The company has not set a review interval."],
      };
    }
    case "server_profile_expiry":
    case "actual_expiry": {
      if (!verified.expiresAt) return { ...common, basis: "unknown_no_expiry", labels: [...common.labels, "Verified, but no expiry is recorded — currency cannot be established."] };
      let renewalWindow: LifecycleFacts["renewalWindow"] = null;
      if (policy.renewalPathway) {
        const available = verified.expiresAt.getTime() > now.getTime() ? "UNKNOWN_VERIFY_WITH_PROVIDER" as const : "no" as const;
        renewalWindow = { label: policy.renewalPathway.label, availableNow: available, sourceRef: policy.renewalPathway.sourceRef };
      }
      return {
        ...common, basis: policy.lifecycle === "server_profile_expiry" ? "server_profile_expiry" : "actual_expiry",
        legalExpiry: verified.expiresAt, renewalWindow,
        reminderTarget: { at: verified.expiresAt, kind: "legal_expiry" },
        labels: [...common.labels, `Certificate expires ${verified.expiresAt.toISOString().slice(0, 10)}`],
      };
    }
  }
}

/** The TDG road expiry is computed from the installed profile; this re-exposes that, never a local constant. */
export function serverProfileExpiry(policy: CredentialPolicySeed, issuedAt: Date): Date | null {
  if (policy.lifecycle !== "server_profile_expiry" || !policy.regulatoryProfileRef) return null;
  const profile = ACADEMY_REGULATORY_PROFILES.find(p => p.profileRef === policy.regulatoryProfileRef);
  return profile?.validityMonths == null ? null : addCalendarMonths(issuedAt, profile.validityMonths);
}

/* ------------------------------------------------------------------ */
/* Warning thresholds and reminders                                     */
/* ------------------------------------------------------------------ */

export type ThresholdHit = { threshold: number | "expired"; daysRemaining: number };

export function normalizeThresholds(t: readonly number[] | null | undefined): number[] {
  const src = t && t.length ? t : DEFAULT_WARNING_THRESHOLDS;
  return Array.from(new Set(src.filter(n => Number.isInteger(n) && n >= 1 && n <= 730))).sort((a, b) => b - a);
}

/** The tightest threshold crossed at `now`, or null if the date is still beyond the widest. */
export function crossedThreshold(target: Date, now: Date, thresholds: readonly number[]): ThresholdHit | null {
  const days = Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
  if (days < 0 || target.getTime() <= now.getTime()) return { threshold: "expired", daysRemaining: Math.min(days, 0) };
  const hit = normalizeThresholds(thresholds).filter(t => days <= t).sort((a, b) => a - b)[0];
  return hit == null ? null : { threshold: hit, daysRemaining: days };
}

export type ReminderRecipient = { kind: "user"; userId: number } | { kind: "role"; role: "safety" | "hr" | "management" };
export type PlannedReminder = {
  notificationKey: string;
  recipient: ReminderRecipient;
  holdingRef: string;
  code: string;
  threshold: number | "expired";
  targetKind: "legal_expiry" | "employer_review";
  escalation: "employee" | "supervisor_safety_admin";
  /** 0187 — from the company's escalation ladder. */
  urgency?: EscalationUrgency;
  title: string;
  body: string;
};

const fmt = (d: Date) => d.toISOString().slice(0, 10);

/**
 * What reminders are due for one person's credential now.
 *
 * The key names the holding, the kind of date, the threshold and the
 * recipient — so the 30-day warning for this certificate to this person has
 * exactly one key, however many times the sweep runs. A renewal is a new
 * holding and so a fresh set of keys; the old holding's keys stop being
 * produced the moment it is superseded.
 */
export function planRenewalReminders(args: {
  userId: number;
  code: string;
  holdings: readonly WalletHolding[];
  policy: CredentialPolicySeed | null;
  settings?: Partial<CompanyCredentialSettings> | null;
  now: Date;
  /**
   * 0187 — the company's notification ladder for this credential's category. Defaults to
   * DEFAULT_ESCALATION. Company policy: it says who is told when, never when anything expires.
   */
  escalation?: EscalationPolicy | null;
  /** The worker's supervisor, when one is on record (crew supervisor). Without one, a supervisor step is not sent. */
  supervisorUserId?: number | null;
}): PlannedReminder[] {
  const facts = lifecycleFacts(args);
  if (!facts.reminderTarget || !args.policy) return [];
  if (args.policy.lifecycle === "no_expiry_endorsement" || args.policy.boundary === "study_only") return [];
  const holding = currentVerified(args.holdings, args.code);
  if (!holding) return [];
  const ladder = args.escalation ?? DEFAULT_ESCALATION;
  const thresholds = args.settings?.warningThresholdDays?.length ? args.settings.warningThresholdDays : thresholdsOf(ladder);
  const hit = crossedThreshold(facts.reminderTarget.at, args.now, normalizeThresholds(thresholds));
  if (!hit) return [];
  // The step that governs this threshold: its own, else the nearest wider one on the ladder.
  const step = stepAt(ladder, hit.threshold) ?? (hit.threshold === "expired" ? ladder.steps[ladder.steps.length - 1] : ladder.steps.filter(x => x.threshold !== "expired" && (x.threshold as number) >= (hit.threshold as number)).pop()) ?? { threshold: hit.threshold, recipients: ["employee"], urgency: "notice" as const };
  const kind = facts.reminderTarget.kind;
  const date = fmt(facts.reminderTarget.at);
  const template = args.policy.reminderTemplate || `${args.policy.displayName}: {DATE}`;
  const prefix = step.urgency === "critical" ? "CRITICAL: " : step.urgency === "urgent" ? "URGENT: " : "";
  const title = prefix + (hit.threshold === "expired"
    ? (kind === "legal_expiry" ? `${args.policy.displayName} expired ${date}` : `Company policy review overdue: ${args.policy.displayName}`)
    : (kind === "legal_expiry" ? `${args.policy.displayName} expires in ${hit.daysRemaining} day(s)` : `Company policy review in ${hit.daysRemaining} day(s): ${args.policy.displayName}`));
  const body = template.replaceAll("{DATE}", date);
  const keyOf = (r: ReminderRecipient) => `cred-renew:${holding.holdingRef}:${kind}:${hit.threshold}:${r.kind === "user" ? `u${r.userId}` : `r:${r.role}`}`.slice(0, 200);
  const out: PlannedReminder[] = [];
  const push = (r: ReminderRecipient, escalation: PlannedReminder["escalation"], t: string) =>
    out.push({ notificationKey: keyOf(r), recipient: r, holdingRef: holding.holdingRef, code: args.code, threshold: hit.threshold, targetKind: kind, escalation, urgency: step.urgency, title: t, body });
  push({ kind: "user", userId: args.userId }, "employee", title);
  for (const who of step.recipients) {
    if (who === "employee") continue;
    if (who === "supervisor") {
      if (args.supervisorUserId != null && args.supervisorUserId !== args.userId) push({ kind: "user", userId: args.supervisorUserId }, "supervisor_safety_admin", `${title} — employee ${args.userId}`);
      continue;
    }
    push({ kind: "role", role: who }, "supervisor_safety_admin", `${title} — employee ${args.userId}`);
  }
  return out;
}

/** Idempotent delivery: anything already delivered under the same key is suppressed, never re-sent. */
export function suppressDelivered<T extends { notificationKey: string }>(planned: readonly T[], deliveredKeys: ReadonlySet<string>): { send: T[]; suppressed: T[] } {
  const send: T[] = [], suppressed: T[] = [];
  const seen = new Set<string>();
  for (const p of planned) {
    if (deliveredKeys.has(p.notificationKey) || seen.has(p.notificationKey)) suppressed.push(p);
    else { send.push(p); seen.add(p.notificationKey); }
  }
  return { send, suppressed };
}

/* ------------------------------------------------------------------ */
/* Wallet: record, verify, renew                                        */
/* ------------------------------------------------------------------ */

export type VerificationMethod = "original_sighted" | "document_inspection" | "issuer_registry_check" | "issuer_confirmation" | "ocr_extraction";

/**
 * May this recorded holding become verified?
 *
 * The rules that make the wallet trustworthy, in one place:
 *  - an upload or OCR read is never verification;
 *  - nobody verifies their own credential, and the recorder does not verify what they recorded;
 *  - an external/regulator credential needs a source document;
 *  - an actual-expiry credential needs the actual expiry;
 *  - a LeaseOS-issued employer certificate (TDG road) comes from the Academy, not the wallet;
 *  - study is not a credential.
 */
export function walletVerificationDecision(args: {
  subjectUserId: number;
  verifierUserId: number;
  recordedByUserId: number;
  policy: CredentialPolicySeed | null;
  boundary: WalletBoundary;
  method: VerificationMethod;
  documentRefs: readonly string[];
  expiresAt: Date | null;
  issuedAt: Date | null;
}): { permitted: boolean; blockers: string[] } {
  const b: string[] = [];
  if (args.verifierUserId === args.subjectUserId) b.push("Nobody may verify their own credential");
  if (args.verifierUserId === args.recordedByUserId && args.recordedByUserId !== args.subjectUserId) b.push("The person who recorded this credential may not also verify it");
  if (args.method === "ocr_extraction") b.push("OCR extraction is not verification; a person must check the credential against the document or the issuer");
  if (args.boundary === "study_only") b.push("Study or practice is not a credential and cannot be verified as one");
  if ((args.boundary === "external_provider" || args.boundary === "regulator_issued") && args.documentRefs.length === 0) b.push("An external or regulator-issued credential needs its source document before it can be verified");
  if (args.policy?.lifecycle === "server_profile_expiry" && args.boundary === "employer_issued") b.push(`${args.policy.displayName} is issued by the employer through the Academy with a server-computed expiry; the wallet cannot verify one into existence`);
  if (args.policy?.lifecycle === "actual_expiry" && !args.expiresAt) b.push("This credential carries its own expiry; record the actual expiry from the document before verifying");
  if (args.policy?.lifecycle === "no_expiry_endorsement" && args.expiresAt) b.push("This endorsement has no renewal by rule; do not attach a fabricated expiry — the licence expiry governs");
  if (args.policy?.lifecycle === "employer_review" && args.boundary !== "employer_issued" && args.boundary !== "company_competency") b.push("Employer-review credentials are employer or company records");
  if (args.issuedAt && args.expiresAt && args.expiresAt <= args.issuedAt) b.push("Expiry must be after issue");
  if (args.policy && args.policy.boundary !== args.boundary) b.push(`${args.policy.displayName} is a ${args.policy.boundary.replaceAll("_", " ")} credential, not ${args.boundary.replaceAll("_", " ")}`);
  return { permitted: b.length === 0, blockers: b };
}

/**
 * Where a new credential record may come from. The wallet accepts documents,
 * never Academy completions: a track completion is question 1 ("studied"),
 * and an admin endpoint cannot turn it into question 3 ("holds").
 */
export function walletRecordDecision(args: { boundary: WalletBoundary; evidenceKind: "uploaded_document" | "issuer_record" | "academy_completion" | "practice_result" }): { permitted: boolean; blockers: string[] } {
  const b: string[] = [];
  if (args.evidenceKind === "academy_completion" || args.evidenceKind === "practice_result") b.push("Academy study, practice or mock results are preparation only and cannot be recorded as a licence, endorsement or external certificate");
  if (args.boundary === "study_only") b.push("Study-only records are not wallet credentials");
  return { permitted: b.length === 0, blockers: b };
}

/**
 * Renewal: the new verified holding supersedes the previous verified one(s)
 * of the same code. Nothing is deleted; the old row keeps its facts and gains
 * a pointer forward.
 */
export function supersedePlan(holdings: readonly WalletHolding[], newHolding: WalletHolding): { holdingRef: string; supersededByHoldingRef: string }[] {
  return holdings
    .filter(h => h.code === newHolding.code && h.holdingRef !== newHolding.holdingRef && h.verificationState === "verified" && !h.supersededByHoldingRef)
    .map(h => ({ holdingRef: h.holdingRef, supersededByHoldingRef: newHolding.holdingRef }));
}

/* ------------------------------------------------------------------ */
/* Operational view and recovery                                        */
/* ------------------------------------------------------------------ */

export type RecoveryAction = "request_renewal" | "view_provider_options" | "verify_upload" | "full_licence_required" | "academy_course" | "record_credential";
export type Recovery = { action: RecoveryAction; label: string }[];

export function recoveryFor(verdict: HeldVerdict, code: string, policy: CredentialPolicySeed | null, hasUnverifiedUpload: boolean): Recovery {
  if (verdict.held) return [];
  const external = !!policy?.handoffCapabilities?.length;
  if (verdict.code === "restricted") return [{ action: "full_licence_required", label: "Full (unrestricted) licence authority required for interprovincial work" }];
  if (verdict.code === "unverified" || hasUnverifiedUpload) return [{ action: "verify_upload", label: "Safety/Admin verification required" }];
  if (external) return [{ action: "request_renewal", label: verdict.code === "expired" ? "Request renewal" : "Request training" }, { action: "view_provider_options", label: "View approved/provider options" }];
  if (policy?.boundary === "employer_issued" || policy?.boundary === "company_competency") return [{ action: "academy_course", label: "Complete the current Academy course (and practical sign-off where required)" }];
  return [{ action: "record_credential", label: `Record and verify ${code}` }];
}

/**
 * What dispatch sees: the answer and the way out, nothing else. No
 * certificate numbers, document references, issuer notes or private HR/safety
 * notes — those stay in the wallet's management view.
 */
export type OperationalQualification = {
  code: string;
  state: "held" | "expired" | "unverified" | "unknown" | "rejected" | "restricted";
  expiresAt: Date | null;
  reason: string;
  recovery: Recovery;
};

export function operationalView(args: {
  holdings: readonly WalletHolding[];
  codes: readonly string[];
  at: Date;
  scope?: RequirementScope | null;
  policies?: readonly CredentialPolicySeed[];
}): OperationalQualification[] {
  const policies = args.policies ?? CREDENTIAL_POLICIES;
  return args.codes.map(code => {
    const policy = policyFor(code, policies);
    const v = heldForWork(args.holdings, code, args.at, args.scope, policies);
    const current = currentVerified(args.holdings, code);
    const hasUpload = args.holdings.some(h => h.code === code && (h.verificationState === "unverified" || h.verificationState === "extracted"));
    return {
      code,
      state: v.held ? "held" : (v.code ?? "unknown"),
      expiresAt: current?.expiresAt ?? null,
      reason: v.reason,
      recovery: recoveryFor(v, code, policy, hasUpload && !v.held),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Dashboard shapes                                                     */
/* ------------------------------------------------------------------ */

export type ComplianceBucket =
  | "expiring_soon" | "expired" | "missing_required" | "uploaded_verification_required"
  | "renewal_requested" | "booking_required" | "booked" | "awaiting_certificate"
  | "qualification_unknown" | "company_training_overdue" | "practical_pending"
  | "onboarding" | "studied_not_held";

/**
 * "Completed H2S study, no verified H2S Alive certificate" — the distinction
 * the dashboard must never blur. Returns every person who has finished a
 * study/track course for a code and does not hold the credential under the
 * canonical rule.
 */
export function studiedButNotHeld(args: {
  studied: readonly { userId: number; qualificationCode: string; courseCode: string; completedAt: Date | null }[];
  holdingsByUser: ReadonlyMap<number, readonly WalletHolding[]>;
  at: Date;
}): { userId: number; qualificationCode: string; courseCode: string; reason: string }[] {
  const out: { userId: number; qualificationCode: string; courseCode: string; reason: string }[] = [];
  for (const s of args.studied) {
    if (!s.completedAt) continue;
    const v = heldForWork(args.holdingsByUser.get(s.userId) ?? [], s.qualificationCode, args.at);
    if (!v.held) out.push({ userId: s.userId, qualificationCode: s.qualificationCode, courseCode: s.courseCode, reason: `Completed ${s.courseCode} study material but holds no verified ${s.qualificationCode}: ${v.reason}` });
  }
  return out;
}

/** "Only 2 of 5 available operators satisfy Job X." */
export function crewCoverage(args: {
  people: readonly { userId: number; holdings: readonly WalletHolding[] }[];
  requiredCodes: readonly string[];
  at: Date;
  scope?: RequirementScope | null;
}): { satisfying: number[]; gaps: { userId: number; missing: { code: string; reason: string }[] }[]; headline: string } {
  const satisfying: number[] = [];
  const gaps: { userId: number; missing: { code: string; reason: string }[] }[] = [];
  for (const p of args.people) {
    const missing = args.requiredCodes.map(code => ({ code, v: heldForWork(p.holdings, code, args.at, args.scope) })).filter(x => !x.v.held).map(x => ({ code: x.code, reason: x.v.reason }));
    if (missing.length) gaps.push({ userId: p.userId, missing }); else satisfying.push(p.userId);
  }
  return { satisfying, gaps, headline: `Only ${satisfying.length} of ${args.people.length} available people satisfy ${args.requiredCodes.join(", ") || "no requirements"}` };
}

/** "3 drivers' H2S certificates expire within 30 days." — upcoming shortage by code and window. */
export function shortageForecast(args: { holdingsByUser: ReadonlyMap<number, readonly WalletHolding[]>; codes: readonly string[]; now: Date; windowDays: readonly number[] }) {
  return args.codes.map(code => {
    const expiring = args.windowDays.map(days => {
      const until = new Date(args.now.getTime() + days * 86_400_000);
      const users = Array.from(args.holdingsByUser.entries()).filter(([, hs]) => {
        const h = currentVerified(hs, code);
        return h?.expiresAt && h.expiresAt > args.now && h.expiresAt <= until;
      }).map(([u]) => u);
      return { days, count: users.length, users };
    });
    const holdersNow = Array.from(args.holdingsByUser.values()).filter(hs => heldForWork(hs, code, args.now).held).length;
    return { code, holdersNow, expiring, headline: expiring.map(e => `${e.count} holder(s) of ${code} expire within ${e.days} days`) };
  });
}
