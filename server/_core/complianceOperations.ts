/**
 * 0174 — training compliance operations: escalation, wallet status, delivery,
 * source review, and sweep failures. Pure.
 *
 * Nothing here decides whether a credential satisfies work — that remains the
 * canonical rule (`qualificationValidity` / `heldForWork`). Nothing here decides
 * a credential's expiry — that remains the credential and its policy
 * (`credentialLifecycle`). This module decides who is told, how urgently, what
 * a worker sees, and how a failure of the machinery is reported without being
 * mistaken for a fact about the credential.
 */
import type { HandoffStatus } from "./externalTrainingHandoff";
import type { LifecycleFacts } from "./credentialLifecycle";
import type { HeldVerdict } from "./qualificationValidity";

/* ------------------------------------------------------------------ */
/* Escalation policy — company policy, never law                        */
/* ------------------------------------------------------------------ */

export type EscalationRecipient = "employee" | "supervisor" | "safety" | "hr" | "management";
export type EscalationUrgency = "awareness" | "notice" | "urgent" | "critical" | "exception";
export type EscalationStep = { threshold: number | "expired"; recipients: EscalationRecipient[]; urgency: EscalationUrgency };
/**
 * A company's notification ladder for one credential category. The thresholds say
 * when to tell people; they never say when a credential expires. `label` is shown
 * wherever the ladder is, so nobody reads it as a regulatory period.
 */
export type EscalationPolicy = { label: string; steps: EscalationStep[] };

export const COMPANY_POLICY_LABEL = "Company notification policy — these thresholds are when people are told, not when anything expires.";

export const DEFAULT_ESCALATION: EscalationPolicy = {
  label: COMPANY_POLICY_LABEL,
  steps: [
    { threshold: 120, recipients: ["employee"], urgency: "awareness" },
    { threshold: 90, recipients: ["employee"], urgency: "notice" },
    { threshold: 60, recipients: ["employee", "supervisor"], urgency: "notice" },
    { threshold: 30, recipients: ["employee", "safety", "hr"], urgency: "notice" },
    { threshold: 14, recipients: ["employee", "supervisor", "safety", "hr"], urgency: "urgent" },
    { threshold: 7, recipients: ["employee", "supervisor", "safety", "hr"], urgency: "critical" },
    { threshold: 1, recipients: ["employee", "supervisor", "safety", "hr"], urgency: "critical" },
    { threshold: "expired", recipients: ["employee", "supervisor", "safety", "hr"], urgency: "exception" },
  ],
};

/** Credential categories a company can give different ladders. */
export type CredentialCategory = "safety_ticket" | "driver_licence" | "company_review" | "regulated_employer" | "medical" | "other";
export function categoryOf(code: string, lifecycle: string | null): CredentialCategory {
  if (lifecycle === "employer_review") return "company_review";
  if (code.startsWith("DRIVER_LICENCE")) return "driver_licence";
  if (code === "COMMERCIAL_MEDICAL_FITNESS") return "medical";
  if (code === "TDG_ROAD") return "regulated_employer";
  if (["H2S_ALIVE", "FIRST_AID"].includes(code)) return "safety_ticket";
  return "other";
}

/** The company's ladder for a category, else its default ladder, else LeaseOS's default. */
export function escalationFor(
  byCategory: Partial<Record<CredentialCategory | "default", EscalationPolicy>> | null | undefined,
  category: CredentialCategory,
): EscalationPolicy {
  const p = byCategory?.[category] ?? byCategory?.default ?? DEFAULT_ESCALATION;
  return { label: COMPANY_POLICY_LABEL, steps: p.steps };
}

/** Validate a ladder a company submits. Thresholds are notification days, 1–730, strictly decreasing, employee always told. */
export function validateEscalation(p: EscalationPolicy): string[] {
  const b: string[] = [];
  const days = p.steps.filter(s => s.threshold !== "expired").map(s => s.threshold as number);
  if (!p.steps.length) b.push("A ladder needs at least one step");
  if (days.some(d => !Number.isInteger(d) || d < 1 || d > 730)) b.push("Thresholds are whole days from 1 to 730");
  if (days.some((d, i) => i > 0 && d >= days[i - 1]!)) b.push("Thresholds must be listed from the widest to the tightest");
  if (p.steps.some(s => !s.recipients.includes("employee"))) b.push("The employee is told at every step — escalation adds people, it never removes the holder");
  return b;
}

/** The step that applies at this many days (or expired), or null before the widest threshold. */
export function stepAt(policy: EscalationPolicy, threshold: number | "expired"): EscalationStep | null {
  return policy.steps.find(s => s.threshold === threshold) ?? null;
}
export function thresholdsOf(policy: EscalationPolicy): number[] {
  return policy.steps.filter(s => s.threshold !== "expired").map(s => s.threshold as number);
}
/** Next escalation after the current threshold, for the renewal queue. */
export function nextEscalation(policy: EscalationPolicy, daysRemaining: number | null): { threshold: number | "expired"; inDays: number | null; recipients: EscalationRecipient[] } | null {
  if (daysRemaining == null) return null;
  const upcoming = policy.steps.filter(s => s.threshold === "expired" ? daysRemaining >= 0 : (s.threshold as number) < daysRemaining);
  const next = upcoming.sort((a, b) => (b.threshold === "expired" ? -1 : b.threshold as number) - (a.threshold === "expired" ? -1 : a.threshold as number))[0];
  if (!next) return null;
  return { threshold: next.threshold, inDays: next.threshold === "expired" ? daysRemaining + 1 : daysRemaining - (next.threshold as number), recipients: next.recipients };
}

/* ------------------------------------------------------------------ */
/* What the worker sees                                                 */
/* ------------------------------------------------------------------ */

export type WalletStatus = "VALID" | "EXPIRING" | "EXPIRED" | "UNVERIFIED" | "COMPANY_REVIEW_DUE" | "UNKNOWN";
export type RenewalStatus = "RENEWAL_REQUESTED" | "BOOKED" | "AWAITING_DOCUMENT" | "NONE";

/**
 * One credential, as the worker should read it. The credential's own status
 * (VALID/EXPIRING/EXPIRED/UNVERIFIED/COMPANY_REVIEW_DUE/UNKNOWN) and the renewal
 * in progress are two separate fields: a renewal request never extends validity,
 * and a company review date is never called an expiry.
 */
export function walletStatus(args: {
  facts: LifecycleFacts;
  verdict: HeldVerdict;
  handoff: { status: HandoffStatus; requestedAt: Date; appointmentAt: Date | null } | null;
  now: Date;
  expiringWithinDays?: number;
}): { status: WalletStatus; renewal: RenewalStatus; line: string; renewalSteps: { label: string; done: boolean }[]; validityNote: string } {
  const within = args.expiringWithinDays ?? 30;
  const f = args.facts;
  const days = f.legalExpiry ? Math.ceil((f.legalExpiry.getTime() - args.now.getTime()) / 86_400_000) : null;
  let status: WalletStatus;
  if (f.basis === "unknown_unverified") status = "UNVERIFIED";
  else if (f.basis === "employer_review") status = f.employerReviewAt && f.employerReviewAt.getTime() - args.now.getTime() <= within * 86_400_000 ? "COMPANY_REVIEW_DUE" : "VALID";
  else if (f.basis === "no_expiry_by_rule") status = args.verdict.held ? "VALID" : "UNKNOWN";
  else if (f.basis === "actual_expiry" || f.basis === "server_profile_expiry") status = days != null && days < 0 ? "EXPIRED" : days != null && days <= within ? "EXPIRING" : "VALID";
  else status = "UNKNOWN";

  const h = args.handoff;
  const renewal: RenewalStatus = !h ? "NONE"
    : h.status === "BOOKED" ? "BOOKED"
    : ["TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED"].includes(h.status) ? "AWAITING_DOCUMENT"
    : ["ACTIVE", "VERIFIED", "CANCELLED", "NOT_REQUIRED"].includes(h.status) ? "NONE"
    : "RENEWAL_REQUESTED";
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const renewalSteps = h ? [
    { label: `Requested ${fmt(h.requestedAt)}`, done: true },
    { label: ["REQUESTED", "ACTION_REQUIRED", "UNKNOWN"].includes(h.status) ? "Admin reviewing" : "Admin reviewed", done: !["REQUESTED", "ACTION_REQUIRED", "UNKNOWN"].includes(h.status) },
    { label: ["PROVIDER_SELECTED", "BOOKING_IN_PROGRESS", "BOOKED", "TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED", "VERIFIED", "ACTIVE"].includes(h.status) ? "Provider selected" : "Provider not yet selected", done: ["PROVIDER_SELECTED", "BOOKING_IN_PROGRESS", "BOOKED", "TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED", "VERIFIED", "ACTIVE"].includes(h.status) },
    { label: h.appointmentAt ? `Booked for ${fmt(h.appointmentAt)}` : "Not booked yet", done: ["BOOKED", "TRAINING_COMPLETED", "DOCUMENT_PENDING", "DOCUMENT_UPLOADED_UNVERIFIED", "VERIFIED", "ACTIVE"].includes(h.status) },
    { label: "New certificate verified", done: ["VERIFIED", "ACTIVE"].includes(h.status) },
  ] : [];
  const line = status === "COMPANY_REVIEW_DUE" ? `Company policy review due ${f.employerReviewAt ? fmt(f.employerReviewAt) : ""} — not an expiry`
    : status === "EXPIRED" ? `Expired ${f.legalExpiry ? fmt(f.legalExpiry) : ""}`
    : status === "EXPIRING" ? `Expires ${f.legalExpiry ? fmt(f.legalExpiry) : ""} (${days} day(s))`
    : status === "UNVERIFIED" ? "Uploaded — waiting for safety/admin to verify"
    : status === "UNKNOWN" ? "UNKNOWN — cannot be established from verified records"
    : f.legalExpiry ? `Valid until ${fmt(f.legalExpiry)}` : "Valid";
  const validityNote = renewal === "NONE" ? "" : `Your current credential counts only until its own expiry${f.legalExpiry ? ` (${fmt(f.legalExpiry)})` : ""}. A renewal request or booking does not extend it.`;
  return { status, renewal, line, renewalSteps, validityNote };
}

/**
 * Dispatch's explanation of a renewal already in motion. Explanation only: it is
 * appended to a NOT-held verdict's recovery text and never changes the verdict —
 * a request, a booking or an upload does not make anyone READY.
 */
export function handoffRecoveryNote(h: { status: HandoffStatus; appointmentAt: Date | null } | null | undefined): string | null {
  if (!h) return null;
  switch (h.status) {
    case "ACTION_REQUIRED": case "REQUESTED": case "ADMIN_REVIEW": case "UNKNOWN": return "Renewal requested — awaiting booking";
    case "PROVIDER_SELECTED": case "BOOKING_IN_PROGRESS": return "Renewal requested — office booking with provider";
    case "BOOKED": return `Renewal booked${h.appointmentAt ? ` for ${h.appointmentAt.toISOString().slice(0, 10)}` : ""} — does not count until the new certificate is verified`;
    case "TRAINING_COMPLETED": case "DOCUMENT_PENDING": return "Training reported complete — certificate not yet uploaded";
    case "DOCUMENT_UPLOADED_UNVERIFIED": return "Certificate uploaded — Safety verification required";
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Delivery boundary                                                    */
/* ------------------------------------------------------------------ */

/**
 * In-app (a `workflowNotifications` row) is the canonical delivery and the only
 * one that exists. EMAIL and SMS are declared so a future integration has a place
 * to plug in; until a real provider is configured they report `not_configured`
 * and nothing is marked sent. An external channel's failure never touches the
 * in-app row.
 */
export type DeliveryChannel = "IN_APP" | "EMAIL" | "SMS";
export type DeliveryOutcome = { channel: DeliveryChannel; status: "recorded" | "not_configured" | "failed"; detail: string };
export type DeliveryAdapter = { channel: DeliveryChannel; configured: boolean; deliver: (n: { recipient: string; title: string; body: string }) => Promise<DeliveryOutcome> };

export const NOT_CONFIGURED = (channel: Exclude<DeliveryChannel, "IN_APP">): DeliveryAdapter => ({
  channel, configured: false,
  deliver: async () => ({ channel, status: "not_configured", detail: `${channel} delivery has no provider configured in this deployment; the in-app notification is the delivery.` }),
});

/** Deliver across the requested channels. IN_APP is always recorded first and survives any other channel's failure. */
export async function deliverAcross(args: {
  channels: readonly DeliveryChannel[];
  inApp: () => Promise<"recorded" | "suppressed">;
  adapters: Partial<Record<Exclude<DeliveryChannel, "IN_APP">, DeliveryAdapter>>;
  message: { recipient: string; title: string; body: string };
}): Promise<{ inApp: "recorded" | "suppressed"; external: DeliveryOutcome[] }> {
  const inApp = await args.inApp();
  const external: DeliveryOutcome[] = [];
  // A suppressed in-app notice was already delivered earlier; its external copies were attempted then.
  if (inApp === "suppressed") return { inApp, external };
  for (const ch of args.channels) {
    if (ch === "IN_APP") continue;
    const adapter = args.adapters[ch] ?? NOT_CONFIGURED(ch);
    try { external.push(await adapter.deliver(args.message)); }
    catch (e) { external.push({ channel: ch, status: "failed", detail: e instanceof Error ? e.message : String(e) }); }
  }
  return { inApp, external };
}

/* ------------------------------------------------------------------ */
/* Source review                                                        */
/* ------------------------------------------------------------------ */

export type SourceReviewState = "unreviewed" | "under_review" | "reviewed" | "superseded" | "rejected";
export type SourceReviewAction = "REVIEW" | "APPROVE" | "REJECT" | "MARK_SUPERSEDED";
export type SourceForReview = {
  sourceRef: string; reviewStatus: SourceReviewState; proposedByUserId: number | null; firstReviewedByUserId: number | null;
  sourceUrl: string | null; edition: string | null; sourceTier: string;
};

/**
 * Two people make a source trusted. One REVIEWs (checks the URL, edition and
 * fingerprint against the authority); a different person APPROVEs. Whoever
 * proposed a new version may do neither alone. Rejection and supersession are
 * final, and a trusted source can only be superseded by a named successor.
 */
export function sourceReviewDecision(args: { action: SourceReviewAction; source: SourceForReview; actorUserId: number; successor?: SourceForReview | null; note: string }): { permitted: boolean; blockers: string[]; next: SourceReviewState | null } {
  const b: string[] = [];
  const s = args.source;
  if (args.note.trim().length < 10) b.push("Record what was checked (at least 10 characters)");
  let next: SourceReviewState | null = null;
  switch (args.action) {
    case "REVIEW":
      if (s.reviewStatus !== "unreviewed") b.push(`Source is ${s.reviewStatus}; only an unreviewed source is taken into review`);
      if (!s.sourceUrl) b.push("A source without an official location cannot be reviewed");
      if (s.proposedByUserId != null && s.proposedByUserId === args.actorUserId) b.push("The person who proposed this source version may not also be its first reviewer");
      next = "under_review";
      break;
    case "APPROVE":
      if (s.reviewStatus !== "under_review") b.push("A source is approved only after a first review");
      if (s.firstReviewedByUserId === args.actorUserId) b.push("The first reviewer may not also approve — a second person does");
      if (s.proposedByUserId != null && s.proposedByUserId === args.actorUserId) b.push("The person who proposed this source version may not approve it");
      if (s.sourceTier === "vendor" || s.sourceTier === "unknown") b.push(`A ${s.sourceTier}-tier source cannot become a trusted training authority`);
      next = "reviewed";
      break;
    case "REJECT":
      if (s.reviewStatus === "reviewed") b.push("A trusted source is superseded by a new version, not rejected");
      if (s.reviewStatus === "rejected" || s.reviewStatus === "superseded") b.push(`Source is already ${s.reviewStatus}`);
      next = "rejected";
      break;
    case "MARK_SUPERSEDED":
      if (s.reviewStatus === "rejected" || s.reviewStatus === "superseded") b.push(`Source is already ${s.reviewStatus}`);
      if (!args.successor) b.push("Name the source version that replaces this one");
      else if (args.successor.sourceRef === s.sourceRef) b.push("A source cannot supersede itself");
      else if (args.successor.reviewStatus === "rejected" || args.successor.reviewStatus === "superseded") b.push("The replacement must be a live source version");
      next = "superseded";
      break;
  }
  return { permitted: b.length === 0, blockers: b, next: b.length ? null : next };
}

export type SourceImpactStatus = "SOURCE_CURRENT" | "SOURCE_SUPERSEDED_REVIEW_REQUIRED" | "SOURCE_UNREVIEWED" | "SOURCE_REJECTED";
export function impactStatus(reviewStatus: SourceReviewState | null | undefined): SourceImpactStatus {
  switch (reviewStatus) {
    case "reviewed": return "SOURCE_CURRENT";
    case "superseded": return "SOURCE_SUPERSEDED_REVIEW_REQUIRED";
    case "rejected": return "SOURCE_REJECTED";
    default: return "SOURCE_UNREVIEWED";
  }
}

/* ------------------------------------------------------------------ */
/* Sweep failures — the machinery, not the credential                   */
/* ------------------------------------------------------------------ */

export type SweepFailureKind = "TENANT_RESOLUTION_FAILED" | "POLICY_MALFORMED" | "LIFECYCLE_EVALUATION_FAILED" | "NOTIFICATION_WRITE_FAILED" | "SOURCE_RESOLUTION_FAILED" | "SWEEP_ABORTED";
export type SweepFailure = { kind: SweepFailureKind; tenantId: string | null; subjectRef: string | null; detail: string };

/**
 * The three things a Training Compliance line can mean, kept apart. A sweep
 * failure is SYSTEM_FAILURE: it proves nothing about the credential, which
 * keeps whatever state the canonical rule gives it.
 */
export type ComplianceSignal = "SYSTEM_FAILURE" | "QUALIFICATION_EXPIRED" | "QUALIFICATION_UNKNOWN";
export function signalFor(x: { failure?: SweepFailure | null; verdict?: HeldVerdict | null }): ComplianceSignal | null {
  if (x.failure) return "SYSTEM_FAILURE";
  if (x.verdict && !x.verdict.held) return x.verdict.code === "expired" ? "QUALIFICATION_EXPIRED" : "QUALIFICATION_UNKNOWN";
  return null;
}

export function describeFailure(f: SweepFailure): string {
  const what: Record<SweepFailureKind, string> = {
    TENANT_RESOLUTION_FAILED: "The renewal sweep could not tell which organization a record belongs to",
    POLICY_MALFORMED: "A renewal policy could not be read",
    LIFECYCLE_EVALUATION_FAILED: "A credential's renewal dates could not be evaluated",
    NOTIFICATION_WRITE_FAILED: "A renewal notice could not be written",
    SOURCE_RESOLUTION_FAILED: "A policy's authoritative source could not be resolved",
    SWEEP_ABORTED: "The renewal sweep stopped before finishing",
  };
  return `SYSTEM FAILURE — ${what[f.kind]}. This says nothing about whether the credential is valid; its status is unchanged.`;
}
