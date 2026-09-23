/**
 * 0170 — reminders as a resource, not a timestamp.
 *
 * Pure. No network, no database.
 *
 * A reminder has a life: scheduled, fired, snoozed, acknowledged, missed, completed, cancelled.
 * Every move is a row (`reminderActions`) and every firing is a delivery record under a derived
 * key (`workflowNotifications`), so a sweep that runs twice, a device that replays a snooze it
 * already sent, and a worker that restarts mid-batch all insert nothing the second time.
 *
 * Three rules the engine holds that a notification queue would not:
 *
 *   **A personal reminder never escalates.** Not "escalates only when configured": the input
 *   validator refuses a personal reminder that carries an escalation policy, and the ladder
 *   returns nothing for one however it is asked. A driver's note to bring a respirator is not
 *   dispatch's business.
 *
 *   **Snoozing a compliance reminder is recorded and bounded.** The office may see that a
 *   post-trip reminder was snoozed three times; the fourth snooze is refused. An ordinary
 *   reminder snoozes as often as its owner likes.
 *
 *   **The device gets a schedule, not authority.** What goes to the phone is enough to show a
 *   local notification with no service — the reference, the time, the words, the snooze choices —
 *   and what comes back is an action with an idempotency key the server applies once. The phone
 *   never decides that a compliance reminder is done; it reports that a person tapped Done, and
 *   the server records who and when.
 */

import { DEFAULT_CRITICAL_POLICY, escalationOutcome, type EscalationOutcome, type EscalationPolicy, type NotificationState } from "./escalation";
import { nextOccurrenceAfter, zonedParts, zonedToUtc, type RecurrenceRule } from "./recurrence";

export type ReminderKind = "personal" | "company";
export type ReminderLevel = "normal" | "important" | "alarm" | "compliance";
export type ReminderState = "scheduled" | "fired" | "snoozed" | "acknowledged" | "missed" | "completed" | "cancelled";
export type ReminderRelativeTo = "none" | "task_due" | "event_start" | "source_date";
export type NotificationChannel = "in_app" | "push" | "email" | "sms";

export const TERMINAL_REMINDER_STATES: readonly ReminderState[] = ["acknowledged", "completed", "cancelled"];

/** What the engine needs to know about a reminder. A row satisfies this; so does a fixture. */
export type ReminderShape = {
  reminderRef: string;
  kind: ReminderKind;
  level: ReminderLevel;
  state: ReminderState;
  ownerUserId: number;
  fireAt: Date;
  lastFiredAt: Date | null;
  requiresAcknowledgement: boolean;
  missedAfterMinutes: number;
  snoozeCount: number;
  timezone: string;
  recurrence: RecurrenceRule | null;
  escalationPolicy: EscalationPolicy | null;
};

/* ------------------------------------------------------------------ */
/* Input rules                                                          */
/* ------------------------------------------------------------------ */

export type ReminderInput = {
  kind: ReminderKind;
  level: ReminderLevel;
  ownerUserId: number;
  createdByUserId: number;
  relativeTo: ReminderRelativeTo;
  offsetMinutes: number | null;
  /** The absolute time, when `relativeTo` is `none`. */
  at: Date | null;
  /** The subject's own time, when `relativeTo` is not `none`. */
  subjectAt: Date | null;
  recurrence: RecurrenceRule | null;
  escalationPolicy: EscalationPolicy | null;
  requiresAcknowledgement: boolean;
};

export type FireAtOutcome = { ok: true; fireAt: Date } | { ok: false; reason: string };

/** When it first fires. Relative reminders need the thing they are relative to. */
export function computeFireAt(input: Pick<ReminderInput, "relativeTo" | "offsetMinutes" | "at" | "subjectAt" | "recurrence">): FireAtOutcome {
  if (input.recurrence) return { ok: true, fireAt: input.recurrence.anchorAt };
  if (input.relativeTo === "none") {
    if (!input.at) return { ok: false, reason: "An absolute reminder needs a time" };
    return { ok: true, fireAt: input.at };
  }
  if (!input.subjectAt) return { ok: false, reason: `A reminder relative to ${input.relativeTo.replace("_", " ")} needs that time to exist first` };
  const offset = input.offsetMinutes ?? 0;
  return { ok: true, fireAt: new Date(input.subjectAt.getTime() + offset * 60_000) };
}

/** Refuses the shapes that would let a reminder do something its kind must not. */
export function validateReminderInput(input: ReminderInput): string[] {
  const out: string[] = [];
  if (input.kind === "personal" && input.escalationPolicy) out.push("A personal reminder never escalates; it may not carry an escalation policy");
  if (input.kind === "personal" && input.ownerUserId !== input.createdByUserId) out.push("A personal reminder belongs to the person who created it");
  if (input.kind === "personal" && input.level === "compliance") out.push("Compliance is a company level; a personal reminder is normal, important or alarm");
  if (input.level === "compliance" && !input.requiresAcknowledgement) out.push("A compliance reminder requires acknowledgement by definition");
  if (input.escalationPolicy && !input.requiresAcknowledgement) out.push("Escalation climbs on the absence of an acknowledgement; a reminder that does not require one cannot escalate");
  if (input.escalationPolicy && input.escalationPolicy.levels.length === 0) out.push("An escalation policy with no levels tells nobody");
  if (input.relativeTo !== "none" && input.offsetMinutes == null) out.push("A relative reminder says how far before or after");
  return out;
}

/* ------------------------------------------------------------------ */
/* Snooze                                                               */
/* ------------------------------------------------------------------ */

export type SnoozePreset = "5m" | "15m" | "30m" | "1h";
export const SNOOZE_PRESET_MINUTES: Record<SnoozePreset, number> = { "5m": 5, "15m": 15, "30m": 30, "1h": 60 };

export type SnoozeChoice =
  | { kind: "preset"; preset: SnoozePreset }
  | { kind: "tonight" }
  | { kind: "tomorrow" }
  | { kind: "custom"; at: Date }
  /** Reserved for a later UI. Resolving them needs the job or the duty state, which this engine does not read. */
  | { kind: "after_current_job" }
  | { kind: "when_back_on_duty" };

export const SNOOZE_CHOICE_KINDS = ["preset", "tonight", "tomorrow", "custom", "after_current_job", "when_back_on_duty"] as const;

export type SnoozeOutcome =
  | { ok: true; until: Date; label: string }
  | { ok: false; reason: string; deferred: boolean };

/** The most times a compliance reminder may be put off. Recorded each time; refused after. */
export const MAX_COMPLIANCE_SNOOZES = 3;
const TONIGHT_HOUR = 20;
const TOMORROW_HOUR = 8;

/** When a snooze ends. "Tonight" and "tomorrow" are wall-clock words, so they need the zone. */
export function snoozeUntil(choice: SnoozeChoice, now: Date, tz: string): SnoozeOutcome {
  switch (choice.kind) {
    case "preset": return { ok: true, until: new Date(now.getTime() + SNOOZE_PRESET_MINUTES[choice.preset] * 60_000), label: choice.preset };
    case "tonight": {
      const p = zonedParts(now, tz);
      const tonight = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: TONIGHT_HOUR, minute: 0, second: 0 }, tz);
      // Past eight already: an hour from now is still "tonight"; eight tomorrow is not.
      return tonight.getTime() > now.getTime() ? { ok: true, until: tonight, label: "tonight" } : { ok: true, until: new Date(now.getTime() + 3_600_000), label: "in an hour (it is already evening)" };
    }
    case "tomorrow": {
      const p = zonedParts(new Date(now.getTime() + 86_400_000), tz);
      return { ok: true, until: zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: TOMORROW_HOUR, minute: 0, second: 0 }, tz), label: "tomorrow morning" };
    }
    case "custom":
      if (choice.at.getTime() <= now.getTime()) return { ok: false, reason: "A snooze ends in the future", deferred: false };
      return { ok: true, until: choice.at, label: choice.at.toISOString() };
    case "after_current_job":
    case "when_back_on_duty":
      return { ok: false, reason: `"${choice.kind.replace(/_/g, " ")}" needs the job or the duty state, which this engine does not read yet`, deferred: true };
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

export type ReminderChanges = {
  state: ReminderState;
  fireAt?: Date;
  lastFiredAt?: Date | null;
  snoozedUntil?: Date | null;
  snoozeCount?: number;
  acknowledgedAt?: Date | null;
  missedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
};

export type ReminderAction = "created" | "fired" | "acknowledged" | "snoozed" | "rescheduled" | "missed" | "completed" | "cancelled" | "escalated" | "advanced";

export type ReminderOutcome =
  | { ok: true; changes: ReminderChanges; action: ReminderAction; detail: string | null }
  | { ok: false; reason: string };

const refuse = (reason: string): ReminderOutcome => ({ ok: false, reason });

/** Due means the sweep should fire it: scheduled or snoozed, and the time has come. */
export function isDue(r: Pick<ReminderShape, "state" | "fireAt">, now: Date): boolean {
  return (r.state === "scheduled" || r.state === "snoozed") && r.fireAt.getTime() <= now.getTime();
}

export function fire(r: ReminderShape, now: Date): ReminderOutcome {
  if (!isDue(r, now)) return refuse(`Reminder ${r.reminderRef} is ${r.state} and due ${r.fireAt.toISOString()}; not firing`);
  return { ok: true, changes: { state: "fired", lastFiredAt: now, snoozedUntil: null }, action: "fired", detail: null };
}

/** Missed is a fact about a fired reminder that required an answer and got none in time. */
export function isMissed(r: Pick<ReminderShape, "state" | "requiresAcknowledgement" | "lastFiredAt" | "missedAfterMinutes">, now: Date): boolean {
  return r.state === "fired" && r.requiresAcknowledgement && !!r.lastFiredAt && r.lastFiredAt.getTime() + r.missedAfterMinutes * 60_000 <= now.getTime();
}

export function markMissed(r: ReminderShape, now: Date): ReminderOutcome {
  if (!isMissed(r, now)) return refuse(`Reminder ${r.reminderRef} is not missed`);
  return { ok: true, changes: { state: "missed", missedAt: now }, action: "missed", detail: `no acknowledgement within ${r.missedAfterMinutes} min` };
}

/** A recurring reminder that was answered moves to its next occurrence; a one-off is done. */
export function acknowledge(r: ReminderShape, now: Date): ReminderOutcome {
  if (!(r.state === "fired" || r.state === "snoozed" || r.state === "missed")) return refuse(`Reminder ${r.reminderRef} is ${r.state}; there is nothing to acknowledge`);
  const next = advanceIfRecurring(r, now);
  if (next) return { ok: true, changes: { ...next, acknowledgedAt: now }, action: "advanced", detail: `acknowledged; next ${next.fireAt!.toISOString()}` };
  return { ok: true, changes: { state: "acknowledged", acknowledgedAt: now, snoozedUntil: null }, action: "acknowledged", detail: null };
}

export function snooze(r: ReminderShape, choice: SnoozeChoice, now: Date): ReminderOutcome {
  if (!(r.state === "fired" || r.state === "snoozed" || r.state === "missed" || r.state === "scheduled")) return refuse(`Reminder ${r.reminderRef} is ${r.state}; it cannot be snoozed`);
  if (r.level === "compliance" && r.snoozeCount >= MAX_COMPLIANCE_SNOOZES) return refuse(`A compliance reminder may be snoozed ${MAX_COMPLIANCE_SNOOZES} times and this one has been; acknowledge it or complete the work`);
  const until = snoozeUntil(choice, now, r.timezone);
  if (!until.ok) return refuse(until.reason);
  return { ok: true, changes: { state: "snoozed", fireAt: until.until, snoozedUntil: until.until, snoozeCount: r.snoozeCount + 1 }, action: "snoozed", detail: `until ${until.until.toISOString()} (${until.label})` };
}

export function reschedule(r: ReminderShape, at: Date, now: Date): ReminderOutcome {
  if (TERMINAL_REMINDER_STATES.includes(r.state)) return refuse(`Reminder ${r.reminderRef} is ${r.state}; create a new one`);
  if (at.getTime() <= now.getTime()) return refuse("A reminder is rescheduled into the future");
  return { ok: true, changes: { state: "scheduled", fireAt: at, snoozedUntil: null, missedAt: null }, action: "rescheduled", detail: `to ${at.toISOString()}` };
}

export function cancel(r: ReminderShape, now: Date): ReminderOutcome {
  if (TERMINAL_REMINDER_STATES.includes(r.state)) return refuse(`Reminder ${r.reminderRef} is already ${r.state}`);
  return { ok: true, changes: { state: "cancelled", cancelledAt: now }, action: "cancelled", detail: null };
}

/** The subject was done. A reminder about finished work is finished. */
export function complete(r: ReminderShape, now: Date): ReminderOutcome {
  if (TERMINAL_REMINDER_STATES.includes(r.state)) return refuse(`Reminder ${r.reminderRef} is already ${r.state}`);
  return { ok: true, changes: { state: "completed", completedAt: now }, action: "completed", detail: null };
}

/** For a recurring reminder: the changes that move it to its next occurrence, or null when there is none or it is not recurring. */
export function advanceIfRecurring(r: ReminderShape, now: Date): ReminderChanges | null {
  if (!r.recurrence) return null;
  const next = nextOccurrenceAfter(r.recurrence, new Date(Math.max(now.getTime(), r.fireAt.getTime())));
  if (!next) return null;
  return { state: "scheduled", fireAt: next, snoozedUntil: null, missedAt: null, lastFiredAt: r.lastFiredAt };
}

/* ------------------------------------------------------------------ */
/* Delivery keys and channels                                           */
/* ------------------------------------------------------------------ */

/** The delivery record's key. Derived, so the same firing on the same channel is one row. */
export const notificationKeyFor = (reminderRef: string, firedAt: Date, channel: NotificationChannel) =>
  `reminder:${reminderRef}:${firedAt.toISOString()}:${channel}`;

/** A normal reminder is an in-app row; anything louder also asks for a push. Email and SMS are not offered yet. */
export function channelsFor(level: ReminderLevel): NotificationChannel[] {
  return level === "normal" ? ["in_app"] : ["in_app", "push"];
}

/* ------------------------------------------------------------------ */
/* Escalation                                                           */
/* ------------------------------------------------------------------ */

/**
 * The ladder for one reminder, or null when there is no ladder to climb.
 *
 * Null for every personal reminder, whatever it carries, and for a company reminder with no
 * policy. Reuses the escalation engine the enforcement surface already runs on; the numbers come
 * from the reminder's own policy. `occurredAt` is the last firing, not the creation.
 */
export function escalationFor(r: ReminderShape, notifications: readonly NotificationState[], now: Date): EscalationOutcome | null {
  if (r.kind === "personal") return null;
  if (!r.escalationPolicy) return null;
  if (!r.lastFiredAt) return null;
  return escalationOutcome({ occurredAt: r.lastFiredAt, notifications, policy: r.escalationPolicy, now });
}

/** A reasonable ladder for a company-required task: the driver, then dispatch, then management. Every number is meant to be overridden. */
export const DEFAULT_TASK_ESCALATION: EscalationPolicy = {
  policyRef: "work.default.task",
  levels: [
    { afterMinutes: 0, roles: ["assignee"] },
    { afterMinutes: 30, roles: ["dispatcher"] },
    { afterMinutes: 90, roles: ["management"] },
  ],
  mandatoryRoles: DEFAULT_CRITICAL_POLICY.mandatoryRoles,
};

/** Parse a stored policy; refuse the malformed rather than escalate to nobody. */
export function parseEscalationPolicy(json: string | null): EscalationPolicy | null {
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const p = parsed as Partial<EscalationPolicy>;
  if (!p || typeof p.policyRef !== "string" || !Array.isArray(p.levels)) return null;
  const levels = p.levels.filter(l => l && typeof l.afterMinutes === "number" && Array.isArray(l.roles)).map(l => ({ afterMinutes: l.afterMinutes, roles: l.roles.map(String) }));
  if (!levels.length) return null;
  return { policyRef: p.policyRef, levels, mandatoryRoles: Array.isArray(p.mandatoryRoles) ? p.mandatoryRoles.map(String) : [] };
}

/* ------------------------------------------------------------------ */
/* The device                                                           */
/* ------------------------------------------------------------------ */

/**
 * What the phone holds so it can show the reminder with no service.
 *
 * Enough to notify locally and to offer the snooze choices; nothing that would let the phone
 * decide anything. `version` lets a device tell a stale entry from a current one.
 */
export type DeviceScheduleEntry = {
  reminderRef: string;
  version: number;
  fireAt: string;
  title: string;
  body: string | null;
  level: ReminderLevel;
  requiresAcknowledgement: boolean;
  deepLink: string | null;
  subjectKind: "task" | "event" | "standalone";
  subjectRef: string | null;
  /** Whether the device should schedule a local notification for it, subject to the OS's own rules. */
  localNotification: boolean;
  snoozeChoices: readonly ("5m" | "15m" | "30m" | "1h" | "tonight" | "tomorrow" | "custom")[];
};

export const SNOOZE_CHOICES_OFFERED: DeviceScheduleEntry["snoozeChoices"] = ["5m", "15m", "30m", "1h", "tonight", "tomorrow", "custom"];

export function toDeviceEntry(r: ReminderShape & { version: number; title: string; body: string | null; deepLink: string | null; subjectKind: "task" | "event" | "standalone"; subjectRef: string | null }): DeviceScheduleEntry {
  return {
    reminderRef: r.reminderRef, version: r.version, fireAt: r.fireAt.toISOString(), title: r.title, body: r.body, level: r.level,
    requiresAcknowledgement: r.requiresAcknowledgement, deepLink: r.deepLink, subjectKind: r.subjectKind, subjectRef: r.subjectRef,
    localNotification: r.level !== "normal",
    snoozeChoices: SNOOZE_CHOICES_OFFERED,
  };
}

/** What a device reports it did while it could not reach the server. */
export type DeviceAction = {
  /** Minted on the device once per tap. The server applies each ref exactly once. */
  actionRef: string;
  reminderRef: string;
  action: "acknowledged" | "snoozed" | "completed";
  occurredAt: Date;
  snoozeChoice?: SnoozeChoice | null;
};

export type DeviceActionPlan = { apply: DeviceAction[]; duplicates: string[]; malformed: { actionRef: string; reason: string }[] };

/**
 * Which of a replayed batch to apply. Already-applied refs and refs repeated within the batch are
 * duplicates, not errors: the device did nothing wrong by retrying. Applied in the order things
 * happened on the device, not the order they arrived.
 */
export function planDeviceActions(actions: readonly DeviceAction[], alreadyApplied: ReadonlySet<string>): DeviceActionPlan {
  const seen = new Set<string>();
  const plan: DeviceActionPlan = { apply: [], duplicates: [], malformed: [] };
  for (const a of [...actions].sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime())) {
    if (!a.actionRef || a.actionRef.length > 120) { plan.malformed.push({ actionRef: a.actionRef ?? "", reason: "actionRef missing or too long" }); continue; }
    if (alreadyApplied.has(a.actionRef) || seen.has(a.actionRef)) { plan.duplicates.push(a.actionRef); continue; }
    if (a.action === "snoozed" && !a.snoozeChoice) { plan.malformed.push({ actionRef: a.actionRef, reason: "a snooze names its choice" }); continue; }
    seen.add(a.actionRef);
    plan.apply.push(a);
  }
  return plan;
}

export const LEVEL_LABELS: Record<ReminderLevel, string> = { normal: "Normal", important: "Important", alarm: "Alarm", compliance: "Compliance" };
