/**
 * Compliance Master Registry — the passport.
 *
 * A requirement is a rule row: it says why it applies, where, from when, from
 * which source, and what evidence satisfies it. A credential is a document
 * with an expiry and a verification status. A passport is the evaluation of
 * every applicable requirement against the credentials on hand, and the
 * answer to "is this subject ready for this work, here, today?"
 *
 * Three rules do the work:
 *
 *   An unverified REQUIREMENT yields UNKNOWN. LeaseOS does not know what the
 *   law requires until somebody has checked, so it cannot say the subject
 *   meets it. Unknown never rounds up to ready.
 *
 *   A missing DOCUMENT is not an expired CREDENTIAL. A proof-of-insurance card
 *   nobody uploaded does not mean the truck is uninsured; a licence past its
 *   expiry date does mean the driver cannot drive. Each requirement declares
 *   which it is.
 *
 *   Privacy is a projection. Dispatch learns "commercially eligible: yes";
 *   it never learns why not.
 */

export type RequirementStatus = "unverified" | "verified" | "superseded" | "withdrawn";
export type CredentialVerification = "needs_review" | "verified" | "rejected";

export type Requirement = {
  requirementKey: string;
  version: number;
  family: string;
  title: string;
  subjectType: "operator" | "unit" | "trailer" | "carrier" | "job" | "user" | "equipment" | "attachment" | "work_context";
  jurisdiction: string;
  /** v20.22 — a requirement in a pack applies only where the pack is active. */
  packKey?: string | null;
  appliesWhen?: Record<string, unknown> | null;
  satisfiedByDocTypes: readonly string[];
  renewalIntervalDays?: number | null;
  warnDaysBeforeExpiry: number;
  missingSeverity: "review" | "blocked";
  verificationStatus: RequirementStatus;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
};

export type Credential = {
  docType: string;
  requirementKey?: string | null;
  issuedAt?: Date | null;
  expiresAt?: Date | null;
  verificationStatus: CredentialVerification;
  privateDetail: boolean;
  jurisdiction?: string | null;
};

export type Subject = {
  subjectType: Requirement["subjectType"];
  jurisdiction: string;
  /** Attributes the applicability predicate is evaluated against. */
  attributes: Record<string, unknown>;
};

export type ItemStatus =
  | "satisfied"
  | "expiring"
  | "expired"
  | "missing"
  | "evidence_unverified"
  | "evidence_rejected"
  /**
   * Private evidence that does not satisfy the requirement. The effect is the
   * same as the state it replaces; the reason is not, because the reason is the
   * private part.
   */
  | "evidence_withheld"
  | "requirement_unverified"
  | "not_applicable";

export type PassportItem = {
  requirementKey: string;
  family: string;
  title: string;
  status: ItemStatus;
  /** What the status contributes to the overall verdict. */
  effect: "none" | "review" | "blocked" | "unknown";
  expiresAt: Date | null;
  daysToExpiry: number | null;
  reason: string;
};

export type PassportVerdict = "ready" | "review" | "blocked" | "unknown";

export type Passport = {
  subjectType: Subject["subjectType"];
  verdict: PassportVerdict;
  items: PassportItem[];
  satisfied: number;
  applicable: number;
  reasons: string[];
};

/* ------------------------------------------------------------------ */
/* Applicability                                                        */
/* ------------------------------------------------------------------ */

/**
 * Does this requirement apply to this subject? Jurisdiction must match, the
 * rule must be in force, and every predicate key must hold. Predicates are
 * simple on purpose: equality, or a `*AtLeast` / `*AtMost` numeric bound.
 */
export function requirementApplies(req: Requirement, subject: Subject, now: Date): boolean {
  if (req.subjectType !== subject.subjectType) return false;
  if (req.jurisdiction !== "*" && req.jurisdiction !== subject.jurisdiction) return false;
  if (req.effectiveFrom > now) return false;
  if (req.effectiveUntil && req.effectiveUntil <= now) return false;
  if (req.verificationStatus === "superseded" || req.verificationStatus === "withdrawn") return false;
  const pred = req.appliesWhen ?? {};
  for (const [k, v] of Object.entries(pred)) {
    if (k.endsWith("AtLeast")) {
      const attr = subject.attributes[k.replace(/AtLeast$/, "")];
      if (typeof attr !== "number" || attr < (v as number)) return false;
    } else if (k.endsWith("AtMost")) {
      const attr = subject.attributes[k.replace(/AtMost$/, "")];
      if (typeof attr !== "number" || attr > (v as number)) return false;
    } else if (k.endsWith("In")) {
      const attr = subject.attributes[k.replace(/In$/, "")];
      if (!Array.isArray(v) || !v.includes(attr as never)) return false;
    } else {
      if (JSON.stringify(subject.attributes[k] ?? null) !== JSON.stringify(v ?? null)) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* One requirement against the credentials                             */
/* ------------------------------------------------------------------ */

export function evaluateRequirement(args: {
  requirement: Requirement;
  credentials: readonly Credential[];
  now: Date;
}): PassportItem {
  const r = args.requirement;
  const base = { requirementKey: r.requirementKey, family: r.family, title: r.title };

  if (r.verificationStatus === "unverified") {
    return {
      ...base, status: "requirement_unverified", effect: "unknown", expiresAt: null, daysToExpiry: null,
      reason: `Requirement "${r.title}" has not been verified against its source — LeaseOS cannot say whether it is met`,
    };
  }

  const candidates = args.credentials.filter(c =>
    (c.requirementKey && c.requirementKey === r.requirementKey) || r.satisfiedByDocTypes.includes(c.docType)
  );
  if (candidates.length === 0) {
    return {
      ...base, status: "missing", effect: r.missingSeverity, expiresAt: null, daysToExpiry: null,
      reason: r.missingSeverity === "blocked"
        ? `No ${r.title} on record — required before work`
        : `No ${r.title} document on record — the underlying credential may exist; office to obtain proof`,
    };
  }

  // Best candidate: verified beats needs_review beats rejected; then latest expiry.
  const rank = (c: Credential) => (c.verificationStatus === "verified" ? 2 : c.verificationStatus === "needs_review" ? 1 : 0);
  const best = [...candidates].sort((a, b) => rank(b) - rank(a) || (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0]!;

  /**
   * `privateDetail` was declared on Credential and read nowhere — a field that
   * looks like a filter and is not one, which is worse than no field at all,
   * because the next person to read the type will assume it is honoured.
   *
   * It is honoured here, for the states that disclose *why* a requirement is
   * unmet. "Evidence was rejected on review" against a requirement titled
   * "Commercial medical (45–65: every 3 years)" tells a dispatcher that a named
   * person failed a medical. The passport's job is to answer whether the person
   * may work; the reason belongs with HR, and `medicalFitnessForDispatch` already
   * makes exactly that distinction — this brings the passport into line with it.
   *
   * Deliberately narrow. `satisfied`, `expiring` and `expired` keep their dates,
   * because the expiry of a medical is already released to this same permission
   * by `compliance.medicalEligibility` as `reviewDue`; withholding it here would
   * remove a renewal reminder without closing anything.
   */
  const withheld = (effect: PassportItem["effect"], expiresAt: Date | null): PassportItem => ({
    ...base,
    status: "evidence_withheld",
    effect,
    expiresAt,
    daysToExpiry: null,
    reason: `${r.title} is not satisfied. The evidence is held privately — the reason is with the office, not on this passport.`,
  });

  if (best.verificationStatus === "rejected" && candidates.every(c => c.verificationStatus === "rejected")) {
    if (best.privateDetail) return withheld("blocked", null);
    return { ...base, status: "evidence_rejected", effect: "blocked", expiresAt: best.expiresAt ?? null, daysToExpiry: null, reason: `${r.title} evidence was rejected on review` };
  }

  const expiresAt = best.expiresAt ?? null;
  const days = expiresAt ? Math.floor((expiresAt.getTime() - args.now.getTime()) / 86_400_000) : null;

  if (expiresAt && expiresAt <= args.now) {
    return { ...base, status: "expired", effect: "blocked", expiresAt, daysToExpiry: days, reason: `${r.title} expired ${Math.abs(days!)} day(s) ago` };
  }
  if (best.verificationStatus === "needs_review") {
    if (best.privateDetail) return withheld("review", expiresAt);
    return { ...base, status: "evidence_unverified", effect: "review", expiresAt, daysToExpiry: days, reason: `${r.title} is on record but has not been verified` };
  }
  // A warn window of zero means "never warn": a 24-hour inspection is valid
  // or it is not, and twelve hours left is not an exception to raise. Without
  // this, floor(0.5 days) = 0 <= 0 would flag every daily item as expiring.
  if (r.warnDaysBeforeExpiry > 0 && days !== null && days <= r.warnDaysBeforeExpiry) {
    return { ...base, status: "expiring", effect: "review", expiresAt, daysToExpiry: days, reason: `${r.title} expires in ${days} day(s)` };
  }
  return { ...base, status: "satisfied", effect: "none", expiresAt, daysToExpiry: days, reason: `${r.title} current${days !== null ? ` (${days} days)` : ""}` };
}

/* ------------------------------------------------------------------ */
/* The passport                                                         */
/* ------------------------------------------------------------------ */

const EFFECT_RANK: Record<PassportItem["effect"], number> = { none: 0, review: 1, unknown: 2, blocked: 3 };

export function buildPassport(args: {
  subject: Subject;
  requirements: readonly Requirement[];
  credentials: readonly Credential[];
  now: Date;
}): Passport {
  const applicable = args.requirements.filter(r => requirementApplies(r, args.subject, args.now));
  const items = applicable.map(r => evaluateRequirement({ requirement: r, credentials: args.credentials, now: args.now }));
  const worst = items.reduce<PassportItem["effect"]>((w, i) => (EFFECT_RANK[i.effect] > EFFECT_RANK[w] ? i.effect : w), "none");

  // Blocked beats unknown beats review. But unknown never rounds up: a passport
  // with any unknown item and nothing blocking is UNKNOWN, not review.
  const verdict: PassportVerdict = worst === "blocked" ? "blocked" : worst === "unknown" ? "unknown" : worst === "review" ? "review" : "ready";
  return {
    subjectType: args.subject.subjectType,
    verdict, items,
    satisfied: items.filter(i => i.status === "satisfied").length,
    applicable: items.length,
    reasons: items.filter(i => i.effect !== "none").map(i => i.reason),
  };
}

/* ------------------------------------------------------------------ */
/* Composition and projections                                          */
/* ------------------------------------------------------------------ */

const VERDICT_RANK: Record<PassportVerdict, number> = { ready: 0, review: 1, unknown: 2, blocked: 3 };

/** A job is ready only when everything it depends on is. Worst wins; unknown does not round up. */
export function composeJobPassport(parts: Record<string, Passport | null>): { verdict: PassportVerdict; parts: Record<string, PassportVerdict | "absent">; reasons: string[] } {
  let worst: PassportVerdict = "ready";
  const out: Record<string, PassportVerdict | "absent"> = {};
  const reasons: string[] = [];
  for (const [name, p] of Object.entries(parts)) {
    if (!p) { out[name] = "absent"; if (VERDICT_RANK.unknown > VERDICT_RANK[worst]) worst = "unknown"; reasons.push(`${name}: no passport — unknown`); continue; }
    out[name] = p.verdict;
    if (VERDICT_RANK[p.verdict] > VERDICT_RANK[worst]) worst = p.verdict;
    for (const r of p.reasons) reasons.push(`${name}: ${r}`);
  }
  return { verdict: worst, parts: out, reasons };
}

/**
 * What dispatch may know about a driver's medical fitness. The credential
 * row is private detail; this is the only shape that leaves HR.
 */
export function medicalFitnessForDispatch(credential: Credential | null, now: Date): { eligible: "yes" | "no" | "unknown"; reviewDue: Date | null } {
  if (!credential) return { eligible: "unknown", reviewDue: null };
  if (credential.verificationStatus === "rejected") return { eligible: "no", reviewDue: credential.expiresAt ?? null };
  if (credential.expiresAt && credential.expiresAt <= now) return { eligible: "no", reviewDue: credential.expiresAt };
  if (credential.verificationStatus === "needs_review") return { eligible: "unknown", reviewDue: credential.expiresAt ?? null };
  return { eligible: "yes", reviewDue: credential.expiresAt ?? null };
}

/** Everything a private credential must never expose beyond HR. */
export const PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED = ["title", "identifier", "storageKey", "storageUrl", "source", "notes"] as const;

/* ------------------------------------------------------------------ */
/* Trip inspection validity                                             */
/* ------------------------------------------------------------------ */

export type InspectionValidity = {
  status: "valid" | "expired" | "none";
  validUntil: Date | null;
  hoursRemaining: number | null;
  reason: string;
};

/**
 * The validity window is a requirement parameter, not a constant. With no
 * verified window, the status is reported against whatever window was
 * supplied and the caller knows it was unverified.
 */
export function tripInspectionValidity(args: { completedAt: Date | null; now: Date; validityHours: number }): InspectionValidity {
  if (!args.completedAt) return { status: "none", validUntil: null, hoursRemaining: null, reason: "No trip inspection on record" };
  const validUntil = new Date(args.completedAt.getTime() + args.validityHours * 3_600_000);
  const hours = (validUntil.getTime() - args.now.getTime()) / 3_600_000;
  if (hours <= 0) return { status: "expired", validUntil, hoursRemaining: 0, reason: `Inspection from ${args.completedAt.toISOString()} expired ${Math.round(-hours)}h ago` };
  return { status: "valid", validUntil, hoursRemaining: Math.round(hours * 10) / 10, reason: `Valid for another ${Math.round(hours * 10) / 10}h` };
}

/* ------------------------------------------------------------------ */
/* Renewal                                                              */
/* ------------------------------------------------------------------ */

export function nextRenewalDue(args: { lastObtainedAt: Date | null; intervalDays: number | null }): { dueAt: Date | null; reason: string } {
  if (!args.intervalDays) return { dueAt: null, reason: "No renewal interval on the requirement — cannot compute a due date" };
  if (!args.lastObtainedAt) return { dueAt: null, reason: "Never obtained — due now" };
  return { dueAt: new Date(args.lastObtainedAt.getTime() + args.intervalDays * 86_400_000), reason: `Every ${args.intervalDays} days from last obtained` };
}

/**
 * Whether an abstract may be requested: a signed, unwithdrawn, in-date consent
 * for that purpose. Access to abstracts is regulated; the consent is the record.
 */
export function abstractRequestPermitted(args: {
  consent: { signedAt: Date; validUntil?: Date | null; withdrawnAt?: Date | null; consentType: string } | null;
  now: Date;
}): { permitted: boolean; reason: string } {
  const c = args.consent;
  if (!c) return { permitted: false, reason: "No written consent on record — an abstract cannot be requested" };
  if (c.withdrawnAt && c.withdrawnAt <= args.now) return { permitted: false, reason: "Consent withdrawn" };
  if (c.validUntil && c.validUntil <= args.now) return { permitted: false, reason: "Consent expired" };
  if (!["driver_abstract", "commercial_driver_abstract"].includes(c.consentType)) return { permitted: false, reason: "Consent on record is for a different purpose" };
  return { permitted: true, reason: `Consent signed ${c.signedAt.toISOString().slice(0, 10)}` };
}
