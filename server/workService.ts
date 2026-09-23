/**
 * 0170 — the work calendar, the task board and the reminder engine, against the database.
 *
 * The engines in `_core` decide (recurrence, workTasks, reminders, calendarEvents,
 * workProjections); this file reads rows, hands them to those engines, and writes what they
 * returned. It is also the one place that turns a fired reminder into a delivery record, and the
 * sweep the worker runs.
 *
 * Every write here is idempotent by a derived key: a notification is one `workflowNotifications`
 * row per firing per channel, an action is one `reminderActions` row per `actionRef`, and a
 * sweep that runs twice over the same minute inserts nothing the second time. That is the
 * property the offline device and the restarting worker both rely on.
 *
 * The organization is derived (resolveActingScope) and never read from input; `orgRef` NULL is
 * the historical single tenant, the 0132 convention.
 */

import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { TRPCError } from "@trpc/server";
import {
  calendarEventParticipants, calendarEvents, domainEventOutbox, recurrenceRules, reminderActions, reminders, workAuditEvents,
  workTaskChecklistItems, workTaskDependencies, workTasks, workflowNotifications,
  type CalendarEventRow, type RecurrenceRuleRow, type ReminderRow, type WorkTaskRow,
} from "../drizzle/schema";
import { SINGLE_TENANT_ID, type ActingScope } from "./_core/actingScope";
import type { DbOrTx } from "./_core/dbTypes";
import type { NotificationState } from "./_core/escalation";
import { createHash } from "node:crypto";
import { type RecurrenceRule } from "./_core/recurrence";
import {
  acknowledge, advanceIfRecurring, cancel as cancelReminder, channelsFor, complete as completeReminder, escalationFor, fire, isMissed, markMissed,
  notificationKeyFor, parseEscalationPolicy, planDeviceActions, reschedule as rescheduleReminder, snooze as snoozeReminder,
  type DeviceAction, type ReminderChanges, type ReminderOutcome, type ReminderShape,
} from "./_core/reminders";
import { isTerminal, type TaskShape } from "./_core/workTasks";
import type { PersistedEvent } from "./_core/calendarEvents";

/* ------------------------------------------------------------------ */
/* Scope and references                                                 */
/* ------------------------------------------------------------------ */

/** The stored organization: NULL for the historical single tenant (0132). */
export const orgRefFor = (acting: ActingScope): string | null => acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId;

/** The WHERE clause that keeps a read inside the caller's organization. */
export function orgWhere(column: MySqlColumn, acting: ActingScope): SQL {
  const org = orgRefFor(acting);
  return org === null ? isNull(column) : eq(column, org);
}

export const workRef = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export class WorkRefusal extends TRPCError {}
const refuse = (code: "NOT_FOUND" | "FORBIDDEN" | "PRECONDITION_FAILED" | "BAD_REQUEST", message: string) => new TRPCError({ code, message });

/* ------------------------------------------------------------------ */
/* Recurrence rules                                                     */
/* ------------------------------------------------------------------ */

export function ruleFromRow(row: RecurrenceRuleRow): RecurrenceRule {
  return {
    frequency: row.frequency, intervalCount: row.intervalCount,
    byWeekday: row.byWeekdayJson ? (JSON.parse(row.byWeekdayJson) as RecurrenceRule["byWeekday"]) : null,
    byMonthDay: row.byMonthDay, ordinalWeek: row.ordinalWeek, ordinalWeekday: row.ordinalWeekday as RecurrenceRule["ordinalWeekday"],
    timezone: row.timezone, anchorAt: row.anchorAt, untilAt: row.untilAt, occurrenceLimit: row.occurrenceLimit,
  };
}

export async function loadRule(d: DbOrTx, ruleRef: string | null): Promise<RecurrenceRule | null> {
  if (!ruleRef) return null;
  const row = (await d.select().from(recurrenceRules).where(eq(recurrenceRules.ruleRef, ruleRef)).limit(1))[0];
  return row ? ruleFromRow(row) : null;
}

export async function loadRules(d: DbOrTx, refs: readonly (string | null)[]): Promise<Map<string, RecurrenceRule>> {
  const wanted = Array.from(new Set(refs.filter((r): r is string => !!r)));
  const out = new Map<string, RecurrenceRule>();
  if (!wanted.length) return out;
  for (const row of await d.select().from(recurrenceRules).where(inArray(recurrenceRules.ruleRef, wanted))) out.set(row.ruleRef, ruleFromRow(row));
  return out;
}

export async function insertRule(d: DbOrTx, rule: RecurrenceRule, acting: ActingScope, userId: number): Promise<string> {
  const ruleRef = workRef("RRL");
  await d.insert(recurrenceRules).values({
    ruleRef, orgRef: orgRefFor(acting), frequency: rule.frequency, intervalCount: rule.intervalCount ?? 1,
    byWeekdayJson: rule.byWeekday && rule.byWeekday.length ? JSON.stringify(rule.byWeekday) : null,
    byMonthDay: rule.byMonthDay ?? null, ordinalWeek: rule.ordinalWeek ?? null, ordinalWeekday: rule.ordinalWeekday ?? null,
    timezone: rule.timezone, anchorAt: rule.anchorAt, untilAt: rule.untilAt ?? null, occurrenceLimit: rule.occurrenceLimit ?? null, createdByUserId: userId,
  });
  return ruleRef;
}

/* ------------------------------------------------------------------ */
/* Audit, notifications, actions — all idempotent                       */
/* ------------------------------------------------------------------ */

export type AuditInput = {
  acting: ActingScope;
  subjectKind: "task" | "event" | "reminder";
  subjectRef: string;
  action: string;
  actorUserId: number | null;
  actorSource?: "human" | "system" | "device";
  visibility: "private" | "operational";
  /** Written only for operational subjects. A private subject's row carries no content. */
  detail?: Record<string, unknown> | null;
  at: Date;
};

export async function audit(d: DbOrTx, input: AuditInput): Promise<void> {
  await d.insert(workAuditEvents).values({
    orgRef: orgRefFor(input.acting), subjectKind: input.subjectKind, subjectRef: input.subjectRef, action: input.action,
    actorUserId: input.actorUserId, actorSource: input.actorSource ?? "human", visibility: input.visibility,
    detailJson: input.visibility === "operational" && input.detail ? JSON.stringify(input.detail).slice(0, 4000) : null,
    occurredAt: input.at,
  });
}

/** Drizzle wraps the driver's error; the code is on the cause. Either way, a duplicate key is the answer "already there", not a failure. */
const isDuplicate = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err.code === "ER_DUP_ENTRY" || /Duplicate entry/.test(String(err.message ?? ""))) return true;
  return err.cause ? isDuplicate(err.cause) : false;
};

/** One delivery record per key. Returns false when the key already existed — the recipient was already told. */
export async function queueNotification(d: DbOrTx, n: {
  key: string; tenantId: string; recipientUserId: number | null; recipientRole: string | null;
  title: string; body: string | null; deepLink: string | null; channel: "in_app" | "push" | "email" | "sms"; at: Date;
}): Promise<boolean> {
  try {
    await d.insert(workflowNotifications).values({
      notificationKey: n.key.slice(0, 200), tenantId: n.tenantId, recipientUserId: n.recipientUserId, recipientRole: n.recipientRole,
      title: n.title.slice(0, 220), body: n.body, deepLink: n.deepLink, channel: n.channel, status: "queued", queuedAt: n.at,
    });
    return true;
  } catch (e) {
    if (isDuplicate(e)) return false;
    throw e;
  }
}

/** One action row per ref. Returns false for a replay. */
export async function recordReminderAction(d: DbOrTx, a: {
  actionRef: string; reminderRef: string; action: "created" | "fired" | "acknowledged" | "snoozed" | "rescheduled" | "missed" | "completed" | "cancelled" | "escalated" | "advanced";
  actorUserId: number | null; actorSource: "human" | "system" | "device"; deviceRef?: string | null; occurredAt: Date; effectiveAt?: Date | null; detail?: string | null;
}): Promise<boolean> {
  try {
    await d.insert(reminderActions).values({
      actionRef: a.actionRef.slice(0, 120), reminderRef: a.reminderRef, action: a.action, actorUserId: a.actorUserId, actorSource: a.actorSource,
      deviceRef: a.deviceRef ?? null, occurredAt: a.occurredAt, effectiveAt: a.effectiveAt ?? null, detail: a.detail?.slice(0, 400) ?? null,
    });
    return true;
  } catch (e) {
    if (isDuplicate(e)) return false;
    throw e;
  }
}

/** Company work goes out on the outbox so the workflow engine and webhooks see it. Personal work does not leave the person. */
export async function emitWorkEvent(d: DbOrTx, e: { acting: ActingScope; type: string; aggregateType: "workTask" | "calendarEvent" | "reminder"; aggregateId: string; actorUserId: number | null; payload: Record<string, unknown>; at: Date }): Promise<void> {
  // Derived from the subject, the change and the instant, so a retried write cannot enqueue twice.
  const eventId = `EVT-${createHash("sha256").update(`work:${e.aggregateType}:${e.aggregateId}:${e.type}:${e.at.toISOString()}`).digest("hex").slice(0, 32)}`;
  try {
    await d.insert(domainEventOutbox).values({
    eventId, eventType: e.type, eventVersion: 1, aggregateType: e.aggregateType, aggregateId: e.aggregateId,
    tenantId: e.acting.tenantId, actorSource: e.actorUserId == null ? "system" : "human", actorUserId: e.actorUserId == null ? null : String(e.actorUserId),
    payloadJson: JSON.stringify(e.payload), occurredAt: e.at,
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Reminders                                                            */
/* ------------------------------------------------------------------ */

export type LoadedReminder = ReminderRow & { shape: ReminderShape };

export function reminderShape(row: ReminderRow, rule: RecurrenceRule | null): ReminderShape {
  return {
    reminderRef: row.reminderRef, kind: row.kind, level: row.level, state: row.state, ownerUserId: row.ownerUserId, fireAt: row.fireAt,
    lastFiredAt: row.lastFiredAt, requiresAcknowledgement: row.requiresAcknowledgement, missedAfterMinutes: row.missedAfterMinutes,
    snoozeCount: row.snoozeCount, timezone: row.timezone, recurrence: rule, escalationPolicy: parseEscalationPolicy(row.escalationPolicyJson),
  };
}

export async function loadReminder(d: DbOrTx, reminderRef: string, acting: ActingScope): Promise<LoadedReminder | null> {
  const row = (await d.select().from(reminders).where(and(eq(reminders.reminderRef, reminderRef), orgWhere(reminders.orgRef, acting))).limit(1))[0];
  if (!row) return null;
  return { ...row, shape: reminderShape(row, await loadRule(d, row.recurrenceRuleRef)) };
}

/** Write what the engine decided: the row, the action, the audit. */
export async function applyReminderOutcome(d: DbOrTx, r: LoadedReminder, outcome: ReminderOutcome, who: { actorUserId: number | null; actorSource: "human" | "system" | "device"; deviceRef?: string | null; actionRef?: string | null; acting: ActingScope }, at: Date): Promise<{ applied: boolean; changes: ReminderChanges | null }> {
  if (!outcome.ok) throw refuse("PRECONDITION_FAILED", outcome.reason);
  const actionRef = who.actionRef ?? `${r.reminderRef}:${outcome.action}:${at.toISOString()}:${who.actorSource}`;
  const recorded = await recordReminderAction(d, {
    actionRef, reminderRef: r.reminderRef, action: outcome.action, actorUserId: who.actorUserId, actorSource: who.actorSource, deviceRef: who.deviceRef ?? null,
    occurredAt: at, effectiveAt: outcome.changes.fireAt ?? outcome.changes.snoozedUntil ?? null, detail: outcome.detail,
  });
  if (!recorded) return { applied: false, changes: null };
  await d.update(reminders).set({ ...outcome.changes, version: r.version + 1, updatedAt: at }).where(eq(reminders.id, r.id));
  await audit(d, {
    acting: who.acting, subjectKind: "reminder", subjectRef: r.reminderRef, action: outcome.action, actorUserId: who.actorUserId, actorSource: who.actorSource,
    visibility: r.kind === "personal" ? "private" : "operational", detail: { state: outcome.changes.state, detail: outcome.detail }, at,
  });
  return { applied: true, changes: outcome.changes };
}

/** The reminder fires: the row moves, and one delivery row per channel is queued under a derived key. */
export async function fireReminder(d: DbOrTx, r: LoadedReminder, acting: ActingScope, now: Date): Promise<{ notified: number }> {
  const outcome = fire(r.shape, now);
  const { applied } = await applyReminderOutcome(d, r, outcome, { actorUserId: null, actorSource: "system", acting, actionRef: `${r.reminderRef}:fired:${r.fireAt.toISOString()}` }, now);
  if (!applied) return { notified: 0 };
  let notified = 0;
  for (const channel of channelsFor(r.level)) {
    if (await queueNotification(d, { key: notificationKeyFor(r.reminderRef, now, channel), tenantId: acting.tenantId, recipientUserId: r.ownerUserId, recipientRole: null, title: r.title, body: r.body, deepLink: r.deepLink ?? `/work/reminders/${r.reminderRef}`, channel, at: now })) notified++;
  }
  return { notified };
}

async function notificationsForReminder(d: DbOrTx, reminderRef: string): Promise<NotificationState[]> {
  const rows = await d.select().from(workflowNotifications).where(like(workflowNotifications.notificationKey, `reminder:${reminderRef}:%`));
  return rows.map(n => ({ notificationKey: n.notificationKey, recipientRole: n.recipientRole ?? "assignee", recipientUserId: n.recipientUserId, channel: n.channel, status: n.status, sentAt: n.sentAt ?? n.queuedAt, viewedAt: n.viewedAt, acknowledgedAt: n.acknowledgedAt }));
}

/* ------------------------------------------------------------------ */
/* The sweep                                                            */
/* ------------------------------------------------------------------ */

export type SweepResult = { fired: number; notified: number; missed: number; advanced: number; escalated: number; tasksEscalated: number };

const actingFor = (orgRef: string | null): ActingScope => ({ tenantId: orgRef ?? SINGLE_TENANT_ID, derivedFrom: orgRef ? "membership" : "single_tenant_fallback", membershipRef: null, branchRefs: [], global: true });

/**
 * What the worker runs each heartbeat. Everything is keyed, so running it twice over the same
 * minute changes nothing the second time. Bounded per pass; the next pass picks up the rest.
 */
export async function sweepWork(d: DbOrTx, now: Date, limit = 500): Promise<SweepResult> {
  const result: SweepResult = { fired: 0, notified: 0, missed: 0, advanced: 0, escalated: 0, tasksEscalated: 0 };

  // 1. Fire what is due.
  const due = await d.select().from(reminders).where(and(inArray(reminders.state, ["scheduled", "snoozed"]), lte(reminders.fireAt, now))).orderBy(asc(reminders.fireAt)).limit(limit);
  const rules = await loadRules(d, due.map(r => r.recurrenceRuleRef));
  for (const row of due) {
    const acting = actingFor(row.orgRef);
    const loaded: LoadedReminder = { ...row, shape: reminderShape(row, rules.get(row.recurrenceRuleRef ?? "") ?? null) };
    const { notified } = await fireReminder(d, loaded, acting, now);
    if (notified) { result.fired++; result.notified += notified; }
    // A fired reminder that needs no answer and repeats moves on immediately; one that needs an answer waits for it.
    if (!row.requiresAcknowledgement && loaded.shape.recurrence) {
      const next = advanceIfRecurring({ ...loaded.shape, state: "fired", lastFiredAt: now }, now);
      if (next) {
        const fresh = (await d.select().from(reminders).where(eq(reminders.id, row.id)).limit(1))[0]!;
        const applied = await applyReminderOutcome(d, { ...fresh, shape: loaded.shape }, { ok: true, changes: next, action: "advanced", detail: `next ${next.fireAt!.toISOString()}` }, { actorUserId: null, actorSource: "system", acting, actionRef: `${row.reminderRef}:advanced:${row.fireAt.toISOString()}` }, now);
        if (applied.applied) result.advanced++;
      }
    }
  }

  // 2. Mark missed what was fired, required an answer, and got none in time; a recurring one moves on.
  const fired = await d.select().from(reminders).where(and(eq(reminders.state, "fired"), eq(reminders.requiresAcknowledgement, true))).limit(limit);
  const firedRules = await loadRules(d, fired.map(r => r.recurrenceRuleRef));
  for (const row of fired) {
    const shape = reminderShape(row, firedRules.get(row.recurrenceRuleRef ?? "") ?? null);
    if (!isMissed(shape, now)) continue;
    const acting = actingFor(row.orgRef);
    const applied = await applyReminderOutcome(d, { ...row, shape }, markMissed(shape, now), { actorUserId: null, actorSource: "system", acting, actionRef: `${row.reminderRef}:missed:${row.lastFiredAt!.toISOString()}` }, now);
    if (!applied.applied) continue;
    result.missed++;
    const next = advanceIfRecurring({ ...shape, state: "missed" }, now);
    if (next) {
      const fresh = (await d.select().from(reminders).where(eq(reminders.id, row.id)).limit(1))[0]!;
      const adv = await applyReminderOutcome(d, { ...fresh, shape }, { ok: true, changes: { ...next, missedAt: now }, action: "advanced", detail: `missed; next ${next.fireAt!.toISOString()}` }, { actorUserId: null, actorSource: "system", acting, actionRef: `${row.reminderRef}:advanced:${row.fireAt.toISOString()}` }, now);
      if (adv.applied) result.advanced++;
    }
  }

  // 3. Climb the ladder for company reminders that carry one. Personal reminders are never here:
  //    the engine returns null for them whatever they carry, and the validator refused a policy.
  const climbing = await d.select().from(reminders).where(and(eq(reminders.kind, "company"), inArray(reminders.state, ["fired", "missed"]), sql`${reminders.escalationPolicyJson} IS NOT NULL`)).limit(limit);
  for (const row of climbing) {
    const shape = reminderShape(row, null);
    const outcome = escalationFor(shape, await notificationsForReminder(d, row.reminderRef), now);
    if (!outcome || outcome.acknowledged || !outcome.toNotify.length) continue;
    const acting = actingFor(row.orgRef);
    let told = 0;
    for (const role of outcome.toNotify) {
      const toUser = role === "assignee" ? row.ownerUserId : null;
      const key = `reminder:${row.reminderRef}:${row.lastFiredAt!.toISOString()}:escalation:${role}`;
      if (await queueNotification(d, { key, tenantId: acting.tenantId, recipientUserId: toUser, recipientRole: toUser ? null : role, title: `Unanswered: ${row.title}`, body: `${outcome.reasons[0] ?? "No acknowledgement"}. Owner: user ${row.ownerUserId}.`, deepLink: row.deepLink ?? `/work/reminders/${row.reminderRef}`, channel: "in_app", at: now })) told++;
    }
    if (!told) continue;
    const recorded = await recordReminderAction(d, { actionRef: `${row.reminderRef}:escalated:${row.lastFiredAt!.toISOString()}:${outcome.dueLevel}`, reminderRef: row.reminderRef, action: "escalated", actorUserId: null, actorSource: "system", occurredAt: now, detail: `level ${outcome.dueLevel}: ${outcome.toNotify.join(", ")}` });
    if (recorded) {
      await d.update(reminders).set({ escalationStep: outcome.dueLevel, escalatedAt: now, updatedAt: now }).where(eq(reminders.id, row.id));
      await audit(d, { acting, subjectKind: "reminder", subjectRef: row.reminderRef, action: "escalated", actorUserId: null, actorSource: "system", visibility: "operational", detail: { level: outcome.dueLevel, roles: outcome.toNotify }, at: now });
      result.escalated++;
    }
  }

  // 4. Overdue company tasks with a policy climb from their due date. A personal task carries no policy (refused at creation).
  const overdue = await d.select().from(workTasks).where(and(eq(workTasks.kind, "company"), sql`${workTasks.escalationPolicyJson} IS NOT NULL`, lte(workTasks.dueAt, now), inArray(workTasks.status, ["inbox", "todo", "in_progress", "waiting", "blocked"]))).limit(limit);
  for (const t of overdue) {
    const policy = parseEscalationPolicy(t.escalationPolicyJson);
    if (!policy || !t.dueAt) continue;
    const elapsed = Math.floor((now.getTime() - t.dueAt.getTime()) / 60_000);
    let dueLevel = -1;
    for (let i = 0; i < policy.levels.length; i++) if (elapsed >= policy.levels[i]!.afterMinutes) dueLevel = i;
    if (dueLevel < 0 || dueLevel <= t.escalationStep - 1) continue;
    const acting = actingFor(t.orgRef);
    let told = 0;
    for (let i = 0; i <= dueLevel; i++) {
      for (const role of policy.levels[i]!.roles) {
        const toUser = role === "assignee" ? t.assigneeUserId : null;
        if (role === "assignee" && toUser == null) continue;
        const key = `task:${t.taskRef}:${t.dueAt.toISOString()}:escalation:${role}`;
        if (await queueNotification(d, { key, tenantId: acting.tenantId, recipientUserId: toUser, recipientRole: toUser ? null : role, title: `Overdue: ${t.title}`, body: `Due ${t.dueAt.toISOString()}, ${elapsed} min ago; status ${t.status}.`, deepLink: `/work/tasks/${t.taskRef}`, channel: "in_app", at: now })) told++;
      }
    }
    if (told) {
      await d.update(workTasks).set({ escalationStep: dueLevel + 1, escalatedAt: now, updatedAt: now }).where(eq(workTasks.id, t.id));
      await audit(d, { acting, subjectKind: "task", subjectRef: t.taskRef, action: "escalated", actorUserId: null, actorSource: "system", visibility: "operational", detail: { level: dueLevel, elapsedMinutes: elapsed }, at: now });
      result.tasksEscalated++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* The device's replay                                                  */
/* ------------------------------------------------------------------ */

export type DeviceActionResult = { actionRef: string; outcome: "applied" | "duplicate" | "refused"; reason?: string };

/** Apply what a device did while it was out of coverage — each ref once, in the device's order. */
export async function applyDeviceActions(d: DbOrTx, args: { acting: ActingScope; userId: number; deviceRef: string | null; actions: readonly DeviceAction[]; now: Date }): Promise<DeviceActionResult[]> {
  const refs = args.actions.map(a => a.actionRef).filter(Boolean);
  const already = new Set(refs.length ? (await d.select({ actionRef: reminderActions.actionRef }).from(reminderActions).where(inArray(reminderActions.actionRef, refs))).map(r => r.actionRef) : []);
  const plan = planDeviceActions(args.actions, already);
  const results: DeviceActionResult[] = [
    ...plan.duplicates.map(actionRef => ({ actionRef, outcome: "duplicate" as const })),
    ...plan.malformed.map(m => ({ actionRef: m.actionRef, outcome: "refused" as const, reason: m.reason })),
  ];
  for (const a of plan.apply) {
    const r = await loadReminder(d, a.reminderRef, args.acting);
    if (!r) { results.push({ actionRef: a.actionRef, outcome: "refused", reason: "No such reminder in this organization" }); continue; }
    if (r.ownerUserId !== args.userId) { results.push({ actionRef: a.actionRef, outcome: "refused", reason: "Not this person's reminder" }); continue; }
    const outcome = a.action === "acknowledged" ? acknowledge(r.shape, a.occurredAt)
      : a.action === "completed" ? completeReminder(r.shape, a.occurredAt)
      : snoozeReminder(r.shape, a.snoozeChoice!, a.occurredAt);
    if (!outcome.ok) { results.push({ actionRef: a.actionRef, outcome: "refused", reason: outcome.reason }); continue; }
    const applied = await applyReminderOutcome(d, r, outcome, { actorUserId: args.userId, actorSource: "device", deviceRef: args.deviceRef, actionRef: a.actionRef, acting: args.acting }, a.occurredAt);
    results.push({ actionRef: a.actionRef, outcome: applied.applied ? "applied" : "duplicate" });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

export function taskShape(row: WorkTaskRow): TaskShape {
  return { taskRef: row.taskRef, kind: row.kind, status: row.status, assignmentState: row.assignmentState, createdByUserId: row.createdByUserId, assigneeUserId: row.assigneeUserId, requiresCompletionEvidence: row.requiresCompletionEvidence, completionEvidenceRef: row.completionEvidenceRef, dueAt: row.dueAt };
}

export async function loadTask(d: DbOrTx, taskRef: string, acting: ActingScope): Promise<WorkTaskRow | null> {
  return (await d.select().from(workTasks).where(and(eq(workTasks.taskRef, taskRef), orgWhere(workTasks.orgRef, acting))).limit(1))[0] ?? null;
}

/** Open predecessors, by reference. */
export async function openDependencies(d: DbOrTx, taskRef: string): Promise<string[]> {
  const deps = await d.select().from(workTaskDependencies).where(eq(workTaskDependencies.taskRef, taskRef));
  if (!deps.length) return [];
  const rows = await d.select({ taskRef: workTasks.taskRef, status: workTasks.status }).from(workTasks).where(inArray(workTasks.taskRef, deps.map(x => x.dependsOnTaskRef)));
  const known = new Map(rows.map(r => [r.taskRef, r.status]));
  return deps.map(x => x.dependsOnTaskRef).filter(ref => { const s = known.get(ref); return !s || !(s === "completed" || s === "verified"); });
}

export async function openChecklistCount(d: DbOrTx, taskRef: string): Promise<number> {
  const rows = await d.select({ n: sql<number>`COUNT(*)` }).from(workTaskChecklistItems).where(and(eq(workTaskChecklistItems.taskRef, taskRef), eq(workTaskChecklistItems.done, false)));
  return Number(rows[0]?.n ?? 0);
}

/** When a task closes, the reminders about it close with it. */
export async function completeRemindersFor(d: DbOrTx, subjectKind: "task" | "event", subjectRef: string, acting: ActingScope, actorUserId: number, now: Date): Promise<number> {
  const rows = await d.select().from(reminders).where(and(eq(reminders.subjectKind, subjectKind), eq(reminders.subjectRef, subjectRef), inArray(reminders.state, ["scheduled", "fired", "snoozed", "missed"])));
  let n = 0;
  for (const row of rows) {
    const applied = await applyReminderOutcome(d, { ...row, shape: reminderShape(row, null) }, completeReminder(reminderShape(row, null), now), { actorUserId, actorSource: "human", acting }, now);
    if (applied.applied) n++;
  }
  return n;
}

export const taskIsOpen = (t: Pick<WorkTaskRow, "status">) => !isTerminal(t.status);

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

export function persistedEvent(row: CalendarEventRow, rule: RecurrenceRule | null, acknowledged: boolean): PersistedEvent {
  return {
    eventRef: row.eventRef, kind: row.kind, category: row.category, state: row.state, visibility: row.visibility, ownerUserId: row.ownerUserId,
    title: row.title, detail: row.detail, location: row.location, startsAt: row.startsAt, endsAt: row.endsAt, allDay: row.allDay, timezone: row.timezone,
    requiresAcknowledgement: row.requiresAcknowledgement, acknowledged, taskRef: row.taskRef, sourceType: row.sourceType, sourceRef: row.sourceRef, recurrence: rule,
  };
}

/** Every stored event this person owns or is on, in the window, with recurrence loaded. */
export async function loadEventsFor(d: DbOrTx, args: { userId: number; acting: ActingScope; from: Date; to: Date }): Promise<{ row: CalendarEventRow; rule: RecurrenceRule | null; acknowledged: boolean }[]> {
  const participations = await d.select().from(calendarEventParticipants).where(eq(calendarEventParticipants.userId, args.userId));
  const refs = participations.map(p => p.eventRef);
  const where = and(
    orgWhere(calendarEvents.orgRef, args.acting),
    refs.length ? or(eq(calendarEvents.ownerUserId, args.userId), inArray(calendarEvents.eventRef, refs)) : eq(calendarEvents.ownerUserId, args.userId),
    // Recurring rows have no bounded window of their own; the expansion decides. One-offs are bounded here.
    or(sql`${calendarEvents.recurrenceRuleRef} IS NOT NULL`, and(lte(calendarEvents.startsAt, args.to), sql`COALESCE(${calendarEvents.endsAt}, ${calendarEvents.startsAt}) >= ${args.from}`)),
  );
  const rows = await d.select().from(calendarEvents).where(where).orderBy(asc(calendarEvents.startsAt)).limit(1000);
  const rules = await loadRules(d, rows.map(r => r.recurrenceRuleRef));
  const acked = new Map(participations.map(p => [p.eventRef, !!p.acknowledgedAt]));
  return rows.map(row => ({ row, rule: rules.get(row.recurrenceRuleRef ?? "") ?? null, acknowledged: acked.get(row.eventRef) ?? false }));
}

export async function loadEvent(d: DbOrTx, eventRef: string, acting: ActingScope): Promise<CalendarEventRow | null> {
  return (await d.select().from(calendarEvents).where(and(eq(calendarEvents.eventRef, eventRef), orgWhere(calendarEvents.orgRef, acting))).limit(1))[0] ?? null;
}

export async function isParticipant(d: DbOrTx, eventRef: string, userId: number): Promise<boolean> {
  return (await d.select({ id: calendarEventParticipants.id }).from(calendarEventParticipants).where(and(eq(calendarEventParticipants.eventRef, eventRef), eq(calendarEventParticipants.userId, userId))).limit(1)).length > 0;
}

/** The audit trail for one subject, newest first. Private subjects come back with their action and no content, which is all the row holds. */
export async function auditTrail(d: DbOrTx, subjectKind: "task" | "event" | "reminder", subjectRef: string, acting: ActingScope) {
  return d.select().from(workAuditEvents).where(and(eq(workAuditEvents.subjectKind, subjectKind), eq(workAuditEvents.subjectRef, subjectRef), orgWhere(workAuditEvents.orgRef, acting))).orderBy(desc(workAuditEvents.occurredAt)).limit(200);
}
