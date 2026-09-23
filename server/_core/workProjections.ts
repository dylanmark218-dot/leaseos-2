/**
 * 0170 — how the other contexts reach the calendar and the board.
 *
 * Pure. No network, no database.
 *
 * Every function here takes a result another engine already produced and returns what the
 * calendar should show, what task should be proposed and what reminder should be set. None of
 * them decides anything the source engine decides: the HOS adapter is handed a determination and
 * never a duty log; the credential adapter is handed a verified expiry and never a certificate
 * image. If the source says UNKNOWN, the entry says UNKNOWN. That is the rule that keeps two
 * authoritative records from diverging — the calendar has none of its own.
 *
 * PROJECTED is the word for every estimate here. A duty window that ends "around 18:00" is an
 * arithmetic projection from an authoritative clock, and it reads as one so that a driver never
 * takes the calendar's arithmetic for the legal answer.
 */

import { project, severityOf, type EventSource } from "./calendarProjection";
import { type CalendarEntry, type EventCategory, type EventState, layerFor } from "./calendarEvents";
import type { HosDetermination } from "./hos";
import type { ReminderLevel } from "./reminders";
import type { TaskPriority } from "./workTasks";

export type TaskProposal = {
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueAt: Date | null;
  assigneeUserId: number;
  requiresCompletionEvidence: boolean;
  source: EventSource;
  /** Where "open" takes the person. Derived from the source. */
  deepLink: string;
  /** Idempotency: one open task per condition however often the source is re-read. */
  dedupeKey: string;
};

export type ReminderProposal = {
  title: string;
  fireAt: Date;
  level: ReminderLevel;
  ownerUserId: number;
  source: EventSource;
  dedupeKey: string;
};

export type Proposal = { entries: CalendarEntry[]; tasks: TaskProposal[]; reminders: ReminderProposal[] };

const entry = (args: Parameters<typeof project>[0] & { state: EventState; category: EventCategory }): CalendarEntry => {
  const { state, category, ...rest } = args;
  return { ...project(rest), state, category, basis: "projection", link: null, taskRef: null, timezone: null };
};

const empty = (): Proposal => ({ entries: [], tasks: [], reminders: [] });

/* ---------------------------- Dispatch ---------------------------- */

export type DispatchBookingInput = {
  bookingRef: string;
  jobRef: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** `tentative` projects; `confirmed` confirms; the rest are cancelled. */
  bookingState: "tentative" | "confirmed" | "released" | "cancelled";
  ownerUserId: number;
};

/** An assignment is dispatch's decision; the calendar shows it and says how firm it is. */
export function fromDispatchBooking(b: DispatchBookingInput): Proposal {
  const state: EventState = b.bookingState === "confirmed" ? "confirmed" : b.bookingState === "tentative" ? "projected" : "cancelled";
  const out = empty();
  out.entries.push(entry({
    layer: layerFor("dispatch"), category: "dispatch", state,
    title: state === "cancelled" ? `Released — ${b.title}` : state === "projected" ? `${b.title} (tentative)` : b.title,
    detail: `Job ${b.jobRef}`, at: b.startsAt, endsAt: b.endsAt, allDay: false,
    severity: "informational", visibility: "operational", ownerUserId: b.ownerUserId,
    source: { sourceType: "resourceBooking", sourceRef: b.bookingRef, generatedBy: "dispatch_projection" },
  }));
  return out;
}

/* ------------------------------ HOS ------------------------------- */

export type HosInput = {
  determination: HosDetermination;
  /** When the clocks were read. The projection is only as current as this. */
  asOf: Date;
  ownerUserId: number;
  /** The record the determination was made from, for the link. */
  sourceRef: string;
};

/**
 * What the HOS engine found, on the calendar.
 *
 * Reads the determination and only the determination. A verified limit with minutes remaining
 * projects an end of window, labelled as arithmetic; an exceeded limit is REQUIRED rest, which is
 * the engine's finding and not this file's; an unknown stays unknown and is shown, because a
 * clock nobody has verified against a rule is not a clock that is fine.
 */
export function fromHosDetermination(input: HosInput): Proposal {
  const out = empty();
  const d = input.determination;
  const source: EventSource = { sourceType: "hosDetermination", sourceRef: input.sourceRef, generatedBy: "hos_projection" };
  const base = { layer: layerFor("compliance"), category: "compliance" as EventCategory, visibility: "operational" as const, ownerUserId: input.ownerUserId, allDay: false, source };
  if (d.verdict === "unknown") {
    out.entries.push(entry({ ...base, state: "projected", title: "Hours of service: not determined", detail: d.explanation, at: input.asOf, endsAt: null, severity: "unknown" }));
    return out;
  }
  if (d.verdict === "exceeded") {
    out.entries.push(entry({ ...base, state: "required", title: "Hours of service: limit exceeded — rest required", detail: d.explanation, at: input.asOf, endsAt: null, severity: "blocking" }));
    return out;
  }
  const windows = d.determinations.filter(x => x.result === "within" && x.remainingMinutes != null && (x.limitKey === "shift_elapsed_minutes" || x.limitKey === "daily_on_duty_minutes" || x.limitKey === "daily_drive_minutes" || x.limitKey === "shift_drive_minutes"));
  for (const w of windows) {
    const endsAt = new Date(input.asOf.getTime() + w.remainingMinutes! * 60_000);
    out.entries.push(entry({
      ...base, state: "projected",
      title: `${labelFor(w.limitKey)}: about ${Math.round(w.remainingMinutes!)} min remaining`,
      detail: `Projected from the clock read at ${input.asOf.toISOString().slice(11, 16)} UTC. The HOS engine, not this arithmetic, decides compliance.`,
      at: endsAt, endsAt: null, severity: w.remainingMinutes! <= 60 ? "due" : "informational",
    }));
  }
  const cycles = d.determinations.filter(x => (x.limitKey === "cycle_1_on_duty_minutes" || x.limitKey === "cycle_2_on_duty_minutes") && x.result === "within" && x.remainingMinutes != null);
  for (const c of cycles) {
    if (c.remainingMinutes! <= 8 * 60) {
      out.entries.push(entry({ ...base, state: "recommended", title: `${labelFor(c.limitKey)}: approaching threshold (${Math.round(c.remainingMinutes!)} min left)`, detail: "Plan a reset. Advisory only.", at: input.asOf, endsAt: null, severity: "due" }));
    }
  }
  return out;
}

const labelFor = (key: string) => key.replace(/_minutes$/, "").replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

/* ---------------------------- Payroll ----------------------------- */

export type PayPeriodInput = {
  periodRef: string;
  endsOn: Date;
  /** The cutoff for submissions, when it differs from the period end. */
  cutoffAt: Date | null;
  paydayAt: Date | null;
  state: "draft" | "collecting" | "review" | "approved" | "processing" | "paid" | "closed" | "amended";
  ownerUserId: number;
  /** Whether this person's time is already in. Payroll's answer, not the calendar's. */
  timesheetSubmitted: boolean;
  now: Date;
};

/** The period is payroll's; the calendar shows its cutoff and proposes the one task it implies. */
export function fromPayPeriod(p: PayPeriodInput): Proposal {
  const out = empty();
  const source: EventSource = { sourceType: "payPeriod", sourceRef: p.periodRef, generatedBy: "payroll_projection" };
  const cutoff = p.cutoffAt ?? p.endsOn;
  const collecting = p.state === "draft" || p.state === "collecting";
  out.entries.push(entry({
    layer: layerFor("payroll"), category: "payroll", state: collecting && !p.timesheetSubmitted ? "required" : "confirmed",
    title: p.timesheetSubmitted ? "Payroll cutoff (time submitted)" : "Payroll cutoff — time due",
    detail: null, at: cutoff, endsAt: null, allDay: true,
    severity: p.timesheetSubmitted || !collecting ? "informational" : severityOf({ dueAt: cutoff, now: p.now, blocksWork: false, noticeDays: 3 }),
    visibility: "operational", ownerUserId: p.ownerUserId, source,
  }));
  if (p.paydayAt) {
    out.entries.push(entry({ layer: layerFor("payroll"), category: "payroll", state: "confirmed", title: "Payday", detail: null, at: p.paydayAt, endsAt: null, allDay: true, severity: "informational", visibility: "operational", ownerUserId: p.ownerUserId, source }));
  }
  if (collecting && !p.timesheetSubmitted) {
    out.tasks.push({
      title: `Submit your time for the period ending ${p.endsOn.toISOString().slice(0, 10)}`, description: null, priority: "normal", dueAt: cutoff, assigneeUserId: p.ownerUserId,
      requiresCompletionEvidence: false, source, deepLink: `/payPeriod/${encodeURIComponent(p.periodRef)}`, dedupeKey: `payPeriod:${p.periodRef}:timesheet:${p.ownerUserId}`,
    });
    out.reminders.push({ title: "Payroll cutoff tomorrow — submit your time", fireAt: new Date(cutoff.getTime() - 86_400_000), level: "important", ownerUserId: p.ownerUserId, source, dedupeKey: `payPeriod:${p.periodRef}:reminder:${p.ownerUserId}` });
  }
  return out;
}

/* -------------------------- Credentials --------------------------- */

export type CredentialInput = {
  holdingRef: string;
  code: string;
  /** Null when the record carries none. Unknown, not fine. */
  expiresAt: Date | null;
  verified: boolean;
  ownerUserId: number;
  /** Whether the work this person is scheduled for requires it. Only the caller knows. */
  blocksWork: boolean;
  renewalNoticeDays: number;
  now: Date;
};

/** The credential is the portfolio's; the calendar shows the expiry and proposes the renewal. */
export function fromCredentialExpiry(c: CredentialInput): Proposal {
  const out = empty();
  if (!c.verified) return out;   // an unverified certificate is not a ticket, and projects nothing
  const source: EventSource = { sourceType: "workerQualification", sourceRef: c.holdingRef, generatedBy: "credential_projection" };
  const severity = severityOf({ dueAt: c.expiresAt, now: c.now, blocksWork: c.blocksWork, noticeDays: c.renewalNoticeDays });
  out.entries.push(entry({
    layer: layerFor("compliance"), category: "compliance", state: c.expiresAt ? "required" : "projected",
    title: c.expiresAt ? `${c.code} expires` : `${c.code} — no expiry recorded`, detail: null,
    at: c.expiresAt ?? c.now, endsAt: null, allDay: true, severity, visibility: "operational", ownerUserId: c.ownerUserId, source,
  }));
  if (c.expiresAt && (severity === "due" || severity === "overdue" || severity === "blocking")) {
    out.tasks.push({
      title: `Renew ${c.code}`, description: `Expires ${c.expiresAt.toISOString().slice(0, 10)}${c.blocksWork ? "; work that requires it will be blocked" : ""}`,
      priority: c.blocksWork ? "high" : "normal", dueAt: c.expiresAt, assigneeUserId: c.ownerUserId, requiresCompletionEvidence: true,
      source, deepLink: `/workerQualification/${encodeURIComponent(c.holdingRef)}`, dedupeKey: `workerQualification:${c.holdingRef}:renewal`,
    });
  }
  // The notice is set whenever it is still ahead, whether or not the expiry is close yet: the
  // reminder is the thing that fires later, and setting it only once it is already due would be
  // a reminder that never reminds.
  if (c.expiresAt) {
    const renewBy = new Date(c.expiresAt.getTime() - c.renewalNoticeDays * 86_400_000);
    if (renewBy.getTime() > c.now.getTime()) {
      out.reminders.push({ title: `${c.code} expires in ${c.renewalNoticeDays} days`, fireAt: renewBy, level: "important", ownerUserId: c.ownerUserId, source, dedupeKey: `workerQualification:${c.holdingRef}:notice` });
    }
  }
  return out;
}

/* ----------------------------- Fleet ------------------------------ */

export type MaintenanceDueInput = {
  unitRef: string;
  kind: "cvip" | "service" | "inspection" | "registration" | "permit";
  dueAt: Date | null;
  ownerUserId: number;
  blocksWork: boolean;
  now: Date;
};

/** Fleet decides what is due; this shows it and proposes the task. Mileage triggers arrive as events, not dates. */
export function fromMaintenanceDue(m: MaintenanceDueInput): Proposal {
  const out = empty();
  const source: EventSource = { sourceType: "unit", sourceRef: m.unitRef, generatedBy: `maintenance_projection:${m.kind}` };
  const severity = severityOf({ dueAt: m.dueAt, now: m.now, blocksWork: m.blocksWork, noticeDays: 14 });
  out.entries.push(entry({
    layer: layerFor("maintenance"), category: "maintenance", state: m.dueAt ? "required" : "projected",
    title: m.dueAt ? `Unit ${m.unitRef}: ${m.kind.toUpperCase()} due` : `Unit ${m.unitRef}: ${m.kind.toUpperCase()} — no due date recorded`,
    detail: null, at: m.dueAt ?? m.now, endsAt: null, allDay: true, severity, visibility: "operational", ownerUserId: m.ownerUserId, source,
  }));
  if (m.dueAt && severity !== "informational") {
    out.tasks.push({
      title: `${m.kind.toUpperCase()} for unit ${m.unitRef}`, description: null, priority: severity === "blocking" ? "critical" : "high", dueAt: m.dueAt,
      assigneeUserId: m.ownerUserId, requiresCompletionEvidence: true, source, deepLink: `/unit/${encodeURIComponent(m.unitRef)}`, dedupeKey: `unit:${m.unitRef}:${m.kind}:${m.dueAt.toISOString().slice(0, 10)}`,
    });
  }
  return out;
}

/* --------------------------- Documents ---------------------------- */

export type DocumentOutstandingInput = {
  documentKind: "disposal_ticket" | "field_ticket" | "fuel_receipt" | "manifest" | "other";
  jobRef: string;
  dueAt: Date | null;
  ownerUserId: number;
  now: Date;
};

/** A document somebody owes. The job is the record; the task is the ask. */
export function fromDocumentOutstanding(d: DocumentOutstandingInput): Proposal {
  const out = empty();
  const source: EventSource = { sourceType: "job", sourceRef: d.jobRef, generatedBy: `document_projection:${d.documentKind}` };
  const label = d.documentKind.replace(/_/g, " ");
  out.tasks.push({
    title: `Upload ${label} for job ${d.jobRef}`, description: null, priority: "normal", dueAt: d.dueAt, assigneeUserId: d.ownerUserId,
    requiresCompletionEvidence: true, source, deepLink: `/job/${encodeURIComponent(d.jobRef)}`, dedupeKey: `job:${d.jobRef}:${d.documentKind}:outstanding`,
  });
  if (d.dueAt) {
    out.entries.push(entry({ layer: "paperwork", category: "other", state: "required", title: `${label} due — job ${d.jobRef}`, detail: null, at: d.dueAt, endsAt: null, allDay: true, severity: severityOf({ dueAt: d.dueAt, now: d.now, blocksWork: false, noticeDays: 2 }), visibility: "operational", ownerUserId: d.ownerUserId, source }));
  }
  return out;
}

/* ---------------------------- Safety ------------------------------ */

export type SafetyMeetingInput = {
  meetingRef: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  ownerUserId: number;
  mandatory: boolean;
  acknowledged: boolean;
  now: Date;
};

/** A stand-down needs an acknowledgement; a toolbox talk is informational. Same table, different weight. */
export function fromSafetyMeeting(s: SafetyMeetingInput): Proposal {
  const out = empty();
  out.entries.push(entry({
    layer: layerFor("safety"), category: "safety", state: s.mandatory ? "required" : "confirmed", title: s.title, detail: null,
    at: s.startsAt, endsAt: s.endsAt, allDay: false,
    severity: s.mandatory && !s.acknowledged ? (s.startsAt.getTime() < s.now.getTime() ? "overdue" : "due") : "informational",
    visibility: "operational", ownerUserId: s.ownerUserId,
    source: { sourceType: "safetyMeeting", sourceRef: s.meetingRef, generatedBy: "safety_projection" },
  }));
  return out;
}

/** Merge several proposals, keeping one task and one reminder per dedupe key. */
export function mergeProposals(parts: readonly Proposal[]): Proposal {
  const tasks = new Map<string, TaskProposal>();
  const reminders = new Map<string, ReminderProposal>();
  const entries: CalendarEntry[] = [];
  for (const p of parts) {
    entries.push(...p.entries);
    for (const t of p.tasks) if (!tasks.has(t.dedupeKey)) tasks.set(t.dedupeKey, t);
    for (const r of p.reminders) if (!reminders.has(r.dedupeKey)) reminders.set(r.dedupeKey, r);
  }
  return { entries: entries.sort((a, b) => a.at.getTime() - b.at.getTime()), tasks: Array.from(tasks.values()), reminders: Array.from(reminders.values()) };
}
