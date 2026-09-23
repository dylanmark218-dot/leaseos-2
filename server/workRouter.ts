/**
 * 0170 — the work calendar, the task board and the reminder engine, reachable.
 *
 * The engines decide; `workService` writes; this exposes. Three things this layer holds because
 * only the request knows them:
 *
 * **The caller is the owner of anything personal.** A personal event, task or reminder is created
 * for `ctx.user.id` and nobody else; the body never names an owner. Company work names an
 * assignee and needs the assign permission, which is a different procedure under a different
 * permission rather than a flag on the same one.
 *
 * **Somebody else's calendar is read as a scheduler, never as themselves.** `calendarFor` runs the
 * same projection `calendar.mine` does and passes it through the operational audience, so a
 * private appointment arrives as Unavailable with its window and nothing else. `availability`
 * goes one step further and returns a type with no field for a title at all.
 *
 * **The tenant is derived.** `resolveActingScope` on every call; no input names an organization.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, eq, inArray, desc } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { calendarEventParticipants, calendarEvents, crewMembers, reminders, workTaskAttachments, workTaskChecklistItems, workTaskComments, workTaskDependencies, workTasks, resourceBookings, operators, workerQualifications } from "../drizzle/schema";
import { resolveActingScope, type ActingScope } from "./_core/actingScope";
import type { Db, Tx } from "./_core/dbTypes";
import { permissionsFor } from "./_core/recordsAuthorization";
import { buildEvents } from "./calendarRouter";
import { forAudience, type Audience, type VisibleEvent } from "./_core/calendarProjection";
import { CALENDAR_VIEWS, EVENT_CATEGORIES, actionable, availabilityFor, filterForView, fromProjection, toEntries, type CalendarEntry } from "./_core/calendarEvents";
import { isOnShift } from "./_core/calendarProjection";
import { isValidTimezone, validateRule, type RecurrenceRule, type Weekday } from "./_core/recurrence";
import { TASK_ACTIONS, availableActions, isOverdue, mayViewTask, transitionTask, type TaskAction } from "./_core/workTasks";
import {
  SNOOZE_CHOICE_KINDS, acknowledge, cancel as cancelReminder, computeFireAt, reschedule as rescheduleReminder, snooze as snoozeReminder,
  toDeviceEntry, validateReminderInput, type DeviceAction, type ReminderInput, type SnoozeChoice,
} from "./_core/reminders";
import { planReminder, type ReminderCommand } from "./_core/reminderCommands";
import { fromDispatchBooking } from "./_core/workProjections";
import {
  applyDeviceActions, applyReminderOutcome, audit, auditTrail, completeRemindersFor, emitWorkEvent, insertRule, isParticipant, loadEvent, loadEventsFor,
  loadReminder, loadRule, loadTask, openChecklistCount, openDependencies, orgRefFor, orgWhere, persistedEvent, queueNotification, recordReminderAction,
  reminderShape, sweepWork, taskShape, workRef,
} from "./workService";

async function db(): Promise<Db> { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }
const MAX_DAYS = 120;
const DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* Input shapes                                                         */
/* ------------------------------------------------------------------ */

const TZ = z.string().min(1).max(64).refine(isValidTimezone, "Unknown time zone");
const WEEKDAY = z.number().int().min(0).max(6);
const RULE = z.object({
  frequency: z.enum(["daily", "weekdays", "weekly", "monthly"]),
  intervalCount: z.number().int().min(1).max(366).optional(),
  byWeekday: z.array(WEEKDAY).max(7).optional(),
  byMonthDay: z.number().int().min(1).max(31).optional(),
  ordinalWeek: z.number().int().min(-1).max(4).optional(),
  ordinalWeekday: WEEKDAY.optional(),
  timezone: TZ,
  anchorAt: z.coerce.date(),
  untilAt: z.coerce.date().optional(),
  occurrenceLimit: z.number().int().min(1).max(1000).optional(),
});
type RuleInput = z.infer<typeof RULE>;
const toRule = (r: RuleInput): RecurrenceRule => ({
  frequency: r.frequency, intervalCount: r.intervalCount ?? 1, byWeekday: (r.byWeekday as Weekday[] | undefined) ?? null, byMonthDay: r.byMonthDay ?? null,
  ordinalWeek: r.ordinalWeek ?? null, ordinalWeekday: (r.ordinalWeekday as Weekday | undefined) ?? null, timezone: r.timezone, anchorAt: r.anchorAt, untilAt: r.untilAt ?? null, occurrenceLimit: r.occurrenceLimit ?? null,
});
const ESCALATION = z.object({
  policyRef: z.string().min(1).max(60),
  levels: z.array(z.object({ afterMinutes: z.number().int().min(0).max(100_000), roles: z.array(z.string().min(1).max(40)).min(1).max(8) })).min(1).max(8),
  mandatoryRoles: z.array(z.string().max(40)).max(8).default([]),
});
const SNOOZE = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: z.enum(["5m", "15m", "30m", "1h"]) }),
  z.object({ kind: z.literal("tonight") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("custom"), at: z.coerce.date() }),
  z.object({ kind: z.literal("after_current_job") }),
  z.object({ kind: z.literal("when_back_on_duty") }),
]);
const LEVEL = z.enum(["normal", "important", "alarm", "compliance"]);
const PRIORITY = z.enum(["low", "normal", "high", "critical"]);
const REF = z.string().min(1).max(64);
const AT = z.coerce.date().default(() => new Date());

/* ------------------------------------------------------------------ */
/* Who the caller is, for the engines                                   */
/* ------------------------------------------------------------------ */

type Caller = { userId: number; acting: ActingScope; mayAssign: boolean; mayVerify: boolean; maySchedule: boolean };
async function caller(d: Db, ctx: { user: { id: number }; roles?: readonly string[] }): Promise<Caller> {
  const held = new Set(permissionsFor(ctx.roles ?? []));
  return { userId: ctx.user.id, acting: await resolveActingScope(d, ctx.user.id), mayAssign: held.has("work.assign"), mayVerify: held.has("work.verify"), maySchedule: held.has("work.scheduling") };
}

/** The merged calendar for one person: the v22.20 projections plus the rows this subsystem owns. */
async function calendarFor(d: Db, args: { forUserId: number; acting: ActingScope; from: Date; to: Date; audience: Audience; now: Date }): Promise<{ entries: (CalendarEntry & { redacted: boolean })[]; redactedCount: number }> {
  const projected = await buildEvents(d, { tenantId: args.acting.tenantId, forUserId: args.forUserId, from: args.from, to: args.to });
  const stored = await loadEventsFor(d, { userId: args.forUserId, acting: args.acting, from: args.from, to: args.to });
  const bookings = await d.select().from(resourceBookings).where(and(eq(resourceBookings.resourceType, "operator"), inArray(resourceBookings.bookingState, ["tentative", "confirmed"]))).limit(200);
  const op = (await d.select({ id: operators.id }).from(operators).where(eq(operators.userId, args.forUserId)).limit(1))[0];
  const own: CalendarEntry[] = [
    ...projected.map(p => fromProjection(p)),
    // A stored event is on this person's calendar because they own it or are on it, so the entry is
    // theirs to see in full; the audience rule below still redacts it for anybody else.
    ...stored.flatMap(s => toEntries({ ...persistedEvent(s.row, s.rule, s.acknowledged), ownerUserId: args.forUserId }, args.from, args.to, args.now)),
    ...bookings.filter(b => op && b.resourceRef === String(op.id) && b.startsAt < args.to && b.endsAt >= args.from)
      .flatMap(b => fromDispatchBooking({ bookingRef: String(b.id), jobRef: String(b.jobId ?? ""), title: `Dispatch booking${b.jobId ? ` — job ${b.jobId}` : ""}`, startsAt: b.startsAt, endsAt: b.endsAt, bookingState: b.bookingState, ownerUserId: args.forUserId }).entries),
  ];
  const entries: (CalendarEntry & { redacted: boolean })[] = [];
  for (const e of own) {
    const v = forAudience(e, args.audience);
    if (!v) continue;
    entries.push({ ...e, title: v.title, detail: v.detail, redacted: v.redacted });
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { entries, redactedCount: entries.filter(e => e.redacted).length };
}

async function rotationOnFor(d: Db, userId: number, at: Date): Promise<boolean | null> {
  const memberships = await d.select().from(crewMembers).where(eq(crewMembers.userId, userId)).limit(20);
  const live = memberships.filter(m => !m.leftAt && m.rotationOnDays && m.rotationAnchor);
  if (!live.length) return null;
  return live.some(m => isOnShift({ onDays: m.rotationOnDays!, offDays: m.rotationOffDays ?? 0, anchor: m.rotationAnchor!, label: "" }, at));
}

const window = (from: Date, days: number) => ({ from, to: new Date(from.getTime() + days * DAY) });

/* ------------------------------------------------------------------ */
/* The router                                                           */
/* ------------------------------------------------------------------ */

export const workRouter = router({
  /* ============================ calendar ============================ */

  /** The caller's own calendar: projections, stored events, dispatch bookings — in full. */
  calendar: roleProcedure("work.calendar")
    .input(z.object({ from: z.coerce.date(), days: z.number().int().min(1).max(MAX_DAYS).default(14), view: z.enum(CALENDAR_VIEWS).default("my"), now: AT }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const { from, to } = window(input.from, input.days);
      const { entries } = await calendarFor(d, { forUserId: c.userId, acting: c.acting, from, to, audience: { kind: "self", userId: c.userId }, now: input.now });
      const shown = filterForView(entries, input.view);
      return { view: input.view, from, to, entries: shown, actionable: actionable(shown), note: "Projected records carry the reference they came from; stored events carry their own. Nothing here is a copy of a date another engine owns." };
    }),

  /** Somebody else's calendar, for scheduling. Private entries arrive redacted, never absent. */
  calendarFor: roleProcedure("work.calendarFor")
    .input(z.object({ userId: z.number().int().positive(), from: z.coerce.date(), days: z.number().int().min(1).max(MAX_DAYS).default(14), view: z.enum(CALENDAR_VIEWS).default("dispatch"), now: AT }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const { from, to } = window(input.from, input.days);
      const { entries, redactedCount } = await calendarFor(d, { forUserId: input.userId, acting: c.acting, from, to, audience: { kind: "operational", userId: c.userId }, now: input.now });
      const shown = filterForView(entries, input.view);
      return { userId: input.userId, view: input.view, from, to, entries: shown, redactedCount, note: "A private entry is shown as Unavailable with its window intact. Hiding it would show this person as free." };
    }),

  /** AVAILABLE / UNAVAILABLE / ON_DUTY / OFF_DUTY / ASSIGNED / UNKNOWN for a window, with no field for a reason. */
  availability: roleProcedure("work.availability")
    .input(z.object({ userId: z.number().int().positive(), from: z.coerce.date(), to: z.coerce.date(), now: AT }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      if (input.to.getTime() <= input.from.getTime() || input.to.getTime() - input.from.getTime() > MAX_DAYS * DAY) throw new TRPCError({ code: "BAD_REQUEST", message: `The window must be ahead of its start and at most ${MAX_DAYS} days` });
      const { entries } = await calendarFor(d, { forUserId: input.userId, acting: c.acting, from: input.from, to: input.to, audience: { kind: "operational", userId: c.userId }, now: input.now });
      const result = availabilityFor({ userId: input.userId, from: input.from, to: input.to, entries: entries as VisibleEvent[], rotationOn: await rotationOnFor(d, input.userId, input.from) });
      return { ...result, windows: result.windows.map(w => ({ from: w.from, to: w.to, status: w.status, basis: w.basis })) };
    }),

  /** A personal event: the caller's own, private by default. */
  eventCreate: roleProcedure("work.eventCreate")
    .input(z.object({
      title: z.string().min(1).max(220), detail: z.string().max(4000).optional(), location: z.string().max(220).optional(),
      category: z.enum(EVENT_CATEGORIES).default("personal"), startsAt: z.coerce.date(), endsAt: z.coerce.date().optional(), allDay: z.boolean().default(false), timezone: TZ,
      visibility: z.enum(["private", "operational"]).default("private"), recurrence: RULE.optional(), taskRef: REF.optional(), at: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createEvent(tx, c, { ...input, kind: "personal", ownerUserId: c.userId, state: "confirmed", requiresAcknowledgement: false, participants: [] }));
    }),

  /** A company event: a meeting, a training session, a stand-down. Needs the assign permission; may be REQUIRED. */
  companyEventCreate: roleProcedure("work.companyEventCreate")
    .input(z.object({
      title: z.string().min(1).max(220), detail: z.string().max(4000).optional(), location: z.string().max(220).optional(),
      category: z.enum(EVENT_CATEGORIES).default("meeting"), startsAt: z.coerce.date(), endsAt: z.coerce.date().optional(), allDay: z.boolean().default(false), timezone: TZ,
      state: z.enum(["confirmed", "projected", "recommended", "required"]).default("confirmed"), visibility: z.enum(["operational", "administrative"]).default("operational"),
      ownerUserId: z.number().int().positive().optional(), participants: z.array(z.number().int().positive()).max(200).default([]),
      recurrence: RULE.optional(), sourceType: z.string().max(40).optional(), sourceRef: z.string().max(120).optional(), taskRef: REF.optional(), at: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createEvent(tx, c, { ...input, kind: "company", ownerUserId: input.ownerUserId ?? c.userId, requiresAcknowledgement: input.state === "required" }));
    }),

  eventGet: roleProcedure("work.eventGet")
    .input(z.object({ eventRef: REF }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const row = await loadEvent(d, input.eventRef, c.acting);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
      const participants = await d.select().from(calendarEventParticipants).where(eq(calendarEventParticipants.eventRef, row.eventRef));
      const mine = row.ownerUserId === c.userId || participants.some(p => p.userId === c.userId);
      if (!mine && !(row.kind === "company" && c.maySchedule)) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
      const ev = persistedEvent(row, await loadRule(d, row.recurrenceRuleRef), participants.some(p => p.userId === c.userId && !!p.acknowledgedAt));
      // A private event of somebody else's is not readable here at all; the calendar shows it redacted.
      if (row.visibility === "private" && row.ownerUserId !== c.userId) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
      return { event: ev, participants: participants.map(p => ({ userId: p.userId, role: p.participantRole, response: p.response, acknowledgedAt: p.acknowledgedAt })), version: row.version };
    }),

  eventCancel: roleProcedure("work.eventCancel")
    .input(z.object({ eventRef: REF, reason: z.string().max(400).optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const row = await loadEvent(tx, input.eventRef, c.acting);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
        if (row.ownerUserId !== c.userId && row.createdByUserId !== c.userId && !(row.kind === "company" && c.mayAssign)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner, the creator or somebody who assigns company work cancels an event" });
        if (row.state === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already cancelled" });
        await tx.update(calendarEvents).set({ state: "cancelled", cancelledAt: input.at, cancelledByUserId: c.userId, cancelReason: input.reason ?? null, version: row.version + 1, updatedAt: input.at }).where(eq(calendarEvents.id, row.id));
        await audit(tx, { acting: c.acting, subjectKind: "event", subjectRef: row.eventRef, action: "cancelled", actorUserId: c.userId, visibility: row.kind === "personal" ? "private" : "operational", detail: { reason: input.reason ?? null }, at: input.at });
        const closed = await completeRemindersFor(tx, "event", row.eventRef, c.acting, c.userId, input.at);
        if (row.kind === "company") await emitWorkEvent(tx, { acting: c.acting, type: "work.event.cancelled", aggregateType: "calendarEvent", aggregateId: row.eventRef, actorUserId: c.userId, payload: { eventRef: row.eventRef, reason: input.reason ?? null }, at: input.at });
        return { eventRef: row.eventRef, state: "cancelled" as const, remindersClosed: closed };
      });
    }),

  eventReschedule: roleProcedure("work.eventReschedule")
    .input(z.object({ eventRef: REF, startsAt: z.coerce.date(), endsAt: z.coerce.date().optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const row = await loadEvent(tx, input.eventRef, c.acting);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
        if (row.ownerUserId !== c.userId && row.createdByUserId !== c.userId && !(row.kind === "company" && c.mayAssign)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner, the creator or somebody who assigns company work reschedules an event" });
        if (row.state === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A cancelled event is not rescheduled; create a new one" });
        if (row.sourceType && row.sourceRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This event follows ${row.sourceType} ${row.sourceRef}; change the date there and the calendar follows` });
        if (input.endsAt && input.endsAt.getTime() < input.startsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The event ends before it begins" });
        await tx.update(calendarEvents).set({ previousStartsAt: row.startsAt, startsAt: input.startsAt, endsAt: input.endsAt ?? (row.endsAt ? new Date(input.startsAt.getTime() + (row.endsAt.getTime() - row.startsAt.getTime())) : null), rescheduledAt: input.at, rescheduledByUserId: c.userId, version: row.version + 1, updatedAt: input.at }).where(eq(calendarEvents.id, row.id));
        await audit(tx, { acting: c.acting, subjectKind: "event", subjectRef: row.eventRef, action: "rescheduled", actorUserId: c.userId, visibility: row.kind === "personal" ? "private" : "operational", detail: { from: row.startsAt, to: input.startsAt }, at: input.at });
        // Reminders relative to the start follow it.
        const rel = await tx.select().from(reminders).where(and(eq(reminders.subjectKind, "event"), eq(reminders.subjectRef, row.eventRef), eq(reminders.relativeTo, "event_start"), inArray(reminders.state, ["scheduled", "snoozed"])));
        let moved = 0;
        for (const r of rel) {
          const fireAt = new Date(input.startsAt.getTime() + (r.offsetMinutes ?? 0) * 60_000);
          if (fireAt.getTime() <= input.at.getTime()) continue;
          const applied = await applyReminderOutcome(tx, { ...r, shape: reminderShape(r, null) }, rescheduleReminder(reminderShape(r, null), fireAt, input.at), { actorUserId: c.userId, actorSource: "human", acting: c.acting }, input.at);
          if (applied.applied) moved++;
        }
        return { eventRef: row.eventRef, startsAt: input.startsAt, remindersMoved: moved };
      });
    }),

  /** "I have seen this." Only the person on it can say so. */
  eventAcknowledge: roleProcedure("work.eventAcknowledge")
    .input(z.object({ eventRef: REF, at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const row = await loadEvent(d, input.eventRef, c.acting);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
      const p = (await d.select().from(calendarEventParticipants).where(and(eq(calendarEventParticipants.eventRef, row.eventRef), eq(calendarEventParticipants.userId, c.userId))).limit(1))[0];
      if (!p) throw new TRPCError({ code: "FORBIDDEN", message: "You are not on this event; an acknowledgement is the participant's own" });
      if (p.acknowledgedAt) return { eventRef: row.eventRef, acknowledgedAt: p.acknowledgedAt, already: true };
      await d.update(calendarEventParticipants).set({ acknowledgedAt: input.at }).where(eq(calendarEventParticipants.id, p.id));
      await audit(d, { acting: c.acting, subjectKind: "event", subjectRef: row.eventRef, action: "acknowledged", actorUserId: c.userId, visibility: "operational", detail: null, at: input.at });
      return { eventRef: row.eventRef, acknowledgedAt: input.at, already: false };
    }),

  /* ============================== tasks ============================== */

  /** A personal task. The caller's own list; nobody else sees it. */
  taskCreate: roleProcedure("work.taskCreate")
    .input(z.object({
      title: z.string().min(1).max(220), description: z.string().max(4000).optional(), priority: PRIORITY.default("normal"),
      startAt: z.coerce.date().optional(), dueAt: z.coerce.date().optional(), timezone: TZ,
      jobRef: REF.optional(), unitRef: REF.optional(), documentRef: REF.optional(),
      checklist: z.array(z.string().min(1).max(220)).max(50).default([]),
      reminder: z.object({ offsetMinutes: z.number().int().min(-100_000).max(100_000), level: LEVEL.exclude(["compliance"]).default("normal") }).optional(),
      recurrence: RULE.optional(), at: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createTask(tx, c, { ...input, kind: "personal", assigneeUserId: c.userId, visibility: "private", requiresCompletionEvidence: false, requiresAcknowledgement: false, escalationPolicy: null, driverUserId: null, dispatchRef: null, sourceType: null, sourceRef: null, teamRef: null }));
    }),

  /** Company work for somebody. Needs the assign permission; may carry evidence and escalation requirements. */
  companyTaskCreate: roleProcedure("work.companyTaskCreate")
    .input(z.object({
      title: z.string().min(1).max(220), description: z.string().max(4000).optional(), priority: PRIORITY.default("normal"),
      assigneeUserId: z.number().int().positive().optional(), teamRef: REF.optional(),
      startAt: z.coerce.date().optional(), dueAt: z.coerce.date().optional(), timezone: TZ,
      jobRef: REF.optional(), dispatchRef: REF.optional(), driverUserId: z.number().int().positive().optional(), unitRef: REF.optional(), documentRef: REF.optional(),
      sourceType: z.string().max(40).optional(), sourceRef: z.string().max(120).optional(),
      checklist: z.array(z.string().min(1).max(220)).max(50).default([]),
      requiresCompletionEvidence: z.boolean().default(false), requiresAcknowledgement: z.boolean().default(false),
      reminder: z.object({ offsetMinutes: z.number().int().min(-100_000).max(100_000), level: LEVEL.default("important") }).optional(),
      escalationPolicy: ESCALATION.optional(), recurrence: RULE.optional(), at: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createTask(tx, c, { ...input, kind: "company", assigneeUserId: input.assigneeUserId ?? null, visibility: "operational", escalationPolicy: input.escalationPolicy ?? null, driverUserId: input.driverUserId ?? null, dispatchRef: input.dispatchRef ?? null, sourceType: input.sourceType ?? null, sourceRef: input.sourceRef ?? null, teamRef: input.teamRef ?? null }));
    }),

  /** Hand company work to somebody, or to somebody else. */
  taskAssign: roleProcedure("work.taskAssign")
    .input(z.object({ taskRef: REF, assigneeUserId: z.number().int().positive(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const t = await loadTask(tx, input.taskRef, c.acting);
        if (!t || t.kind !== "company") throw new TRPCError({ code: "NOT_FOUND", message: "No such company task" });
        if (["completed", "verified", "cancelled"].includes(t.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The task is ${t.status}` });
        await tx.update(workTasks).set({ assigneeUserId: input.assigneeUserId, assignmentState: "assigned", status: t.status === "inbox" ? "todo" : t.status, acceptedAt: null, version: t.version + 1, updatedAt: input.at }).where(eq(workTasks.id, t.id));
        await audit(tx, { acting: c.acting, subjectKind: "task", subjectRef: t.taskRef, action: "assigned", actorUserId: c.userId, visibility: "operational", detail: { assigneeUserId: input.assigneeUserId, previous: t.assigneeUserId }, at: input.at });
        await queueNotification(tx, { key: `task:${t.taskRef}:assigned:${input.assigneeUserId}:${input.at.toISOString()}`, tenantId: c.acting.tenantId, recipientUserId: input.assigneeUserId, recipientRole: null, title: `Assigned: ${t.title}`, body: t.dueAt ? `Due ${t.dueAt.toISOString()}` : null, deepLink: `/work/tasks/${t.taskRef}`, channel: "in_app", at: input.at });
        await emitWorkEvent(tx, { acting: c.acting, type: "work.task.assigned", aggregateType: "workTask", aggregateId: t.taskRef, actorUserId: c.userId, payload: { taskRef: t.taskRef, assigneeUserId: input.assigneeUserId }, at: input.at });
        return { taskRef: t.taskRef, assigneeUserId: input.assigneeUserId, assignmentState: "assigned" as const };
      });
    }),

  /** My tasks: mine to do, mine to verify, and what I created. Grouped by status; a personal task is only ever its owner's. */
  taskList: roleProcedure("work.taskList")
    .input(z.object({ scope: z.enum(["mine", "created", "team"]).default("mine"), includeClosed: z.boolean().default(false), now: AT }).optional())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const scope = input?.scope ?? "mine";
      const now = input?.now ?? new Date();
      if (scope === "team" && !c.maySchedule) throw new TRPCError({ code: "FORBIDDEN", message: "Reading the team's board needs the scheduling permission" });
      const who = scope === "mine" ? eq(workTasks.assigneeUserId, c.userId)
        : scope === "created" ? eq(workTasks.createdByUserId, c.userId)
        : eq(workTasks.kind, "company");
      const rows = await d.select().from(workTasks).where(and(orgWhere(workTasks.orgRef, c.acting), who, input?.includeClosed ? undefined : inArray(workTasks.status, ["inbox", "todo", "in_progress", "waiting", "blocked", "submitted"]))).orderBy(asc(workTasks.dueAt), desc(workTasks.priority)).limit(500);
      const visible = rows.filter(t => mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule }));
      const submittedForMe = c.mayVerify ? visible.filter(t => t.status === "submitted" && t.assigneeUserId !== c.userId) : [];
      return {
        scope,
        tasks: visible.map(t => ({ ...t, overdue: isOverdue(t, now), deepLink: `/work/tasks/${t.taskRef}` })),
        toVerify: submittedForMe.map(t => t.taskRef),
        counts: visible.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {}),
      };
    }),

  taskGet: roleProcedure("work.taskGet")
    .input(z.object({ taskRef: REF, now: AT }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const t = await loadTask(d, input.taskRef, c.acting);
      if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      const [checklist, deps, comments, attachments, rems, open] = await Promise.all([
        d.select().from(workTaskChecklistItems).where(eq(workTaskChecklistItems.taskRef, t.taskRef)).orderBy(asc(workTaskChecklistItems.sortOrder)),
        d.select().from(workTaskDependencies).where(eq(workTaskDependencies.taskRef, t.taskRef)),
        d.select().from(workTaskComments).where(eq(workTaskComments.taskRef, t.taskRef)).orderBy(asc(workTaskComments.createdAt)).limit(200),
        d.select().from(workTaskAttachments).where(eq(workTaskAttachments.taskRef, t.taskRef)),
        d.select().from(reminders).where(and(eq(reminders.subjectKind, "task"), eq(reminders.subjectRef, t.taskRef), eq(reminders.ownerUserId, c.userId))),
        openDependencies(d, t.taskRef),
      ]);
      const actions = availableActions(taskShape(t), { actor: { userId: c.userId, mayVerify: c.mayVerify, mayAssign: c.mayAssign }, now: input.now, checklistOpen: checklist.filter(i => !i.done).length, dependenciesOpen: open, reason: "…", evidenceRef: t.completionEvidenceRef ?? "…" });
      return { task: { ...t, overdue: isOverdue(t, input.now) }, checklist, dependencies: deps.map(x => ({ dependsOnTaskRef: x.dependsOnTaskRef, open: open.includes(x.dependsOnTaskRef) })), comments, attachments, reminders: rems, actions };
    }),

  /** One move on the state machine. Verification has its own procedure under its own permission. */
  taskTransition: roleProcedure("work.taskTransition")
    .input(z.object({ taskRef: REF, action: z.enum(TASK_ACTIONS.filter(a => a !== "verify" && a !== "return") as [string, ...string[]]), reason: z.string().max(400).optional(), evidenceRef: z.string().max(120).optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => moveTask(tx, c, input.taskRef, input.action as TaskAction, { reason: input.reason ?? null, evidenceRef: input.evidenceRef ?? null, at: input.at }));
    }),

  /** Verify or return submitted company work. Never the assignee's own. */
  taskVerify: roleProcedure("work.taskVerify")
    .input(z.object({ taskRef: REF, decision: z.enum(["verify", "return"]), reason: z.string().max(400).optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => moveTask(tx, c, input.taskRef, input.decision, { reason: input.reason ?? null, evidenceRef: null, at: input.at }));
    }),

  taskChecklistSet: roleProcedure("work.taskChecklistSet")
    .input(z.object({ taskRef: REF, items: z.array(z.string().min(1).max(220)).max(50), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const t = await loadTask(tx, input.taskRef, c.acting);
        if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: false }) && !(t.kind === "company" && c.mayAssign)) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
        if (["completed", "verified", "cancelled"].includes(t.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The task is ${t.status}` });
        await tx.delete(workTaskChecklistItems).where(and(eq(workTaskChecklistItems.taskRef, t.taskRef), eq(workTaskChecklistItems.done, false)));
        const existing = await tx.select().from(workTaskChecklistItems).where(eq(workTaskChecklistItems.taskRef, t.taskRef));
        let order = existing.length;
        for (const label of input.items) await tx.insert(workTaskChecklistItems).values({ itemRef: workRef("TCI"), taskRef: t.taskRef, sortOrder: order++, label });
        await audit(tx, { acting: c.acting, subjectKind: "task", subjectRef: t.taskRef, action: "checklist_set", actorUserId: c.userId, visibility: t.visibility, detail: { items: input.items.length }, at: input.at });
        return { taskRef: t.taskRef, items: existing.length + input.items.length };
      });
    }),

  taskChecklistTick: roleProcedure("work.taskChecklistTick")
    .input(z.object({ itemRef: REF, done: z.boolean(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const item = (await d.select().from(workTaskChecklistItems).where(eq(workTaskChecklistItems.itemRef, input.itemRef)).limit(1))[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "No such checklist item" });
      const t = await loadTask(d, item.taskRef, c.acting);
      if (!t || (t.assigneeUserId !== c.userId && t.createdByUserId !== c.userId)) throw new TRPCError({ code: "NOT_FOUND", message: "No such checklist item" });
      await d.update(workTaskChecklistItems).set({ done: input.done, doneAt: input.done ? input.at : null, doneByUserId: input.done ? c.userId : null }).where(eq(workTaskChecklistItems.id, item.id));
      return { itemRef: item.itemRef, done: input.done };
    }),

  taskComment: roleProcedure("work.taskComment")
    .input(z.object({ taskRef: REF, body: z.string().min(1).max(4000), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const t = await loadTask(d, input.taskRef, c.acting);
      if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      const commentRef = workRef("TCM");
      await d.insert(workTaskComments).values({ commentRef, taskRef: t.taskRef, authorUserId: c.userId, body: input.body, createdAt: input.at });
      return { commentRef };
    }),

  /** Point at evidence the vault already holds, or a document. No bytes travel here. */
  taskAttach: roleProcedure("work.taskAttach")
    .input(z.object({ taskRef: REF, label: z.string().min(1).max(220), evidenceRecordId: z.number().int().positive().optional(), documentRef: REF.optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      if (!input.evidenceRecordId && !input.documentRef) throw new TRPCError({ code: "BAD_REQUEST", message: "An attachment points at an evidence record or a document" });
      const t = await loadTask(d, input.taskRef, c.acting);
      if (!t || (t.assigneeUserId !== c.userId && t.createdByUserId !== c.userId)) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      const attachmentRef = workRef("TAT");
      await d.insert(workTaskAttachments).values({ attachmentRef, taskRef: t.taskRef, evidenceRecordId: input.evidenceRecordId ?? null, documentRef: input.documentRef ?? null, label: input.label, addedByUserId: c.userId, addedAt: input.at });
      await audit(d, { acting: c.acting, subjectKind: "task", subjectRef: t.taskRef, action: "attached", actorUserId: c.userId, visibility: t.visibility, detail: { evidenceRecordId: input.evidenceRecordId ?? null, documentRef: input.documentRef ?? null }, at: input.at });
      return { attachmentRef, completionEvidenceRef: input.evidenceRecordId ? `evidence:${input.evidenceRecordId}` : `document:${input.documentRef}` };
    }),

  taskDependencyAdd: roleProcedure("work.taskDependencyAdd")
    .input(z.object({ taskRef: REF, dependsOnTaskRef: REF, at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      if (input.taskRef === input.dependsOnTaskRef) throw new TRPCError({ code: "BAD_REQUEST", message: "A task does not depend on itself" });
      const [t, dep] = await Promise.all([loadTask(d, input.taskRef, c.acting), loadTask(d, input.dependsOnTaskRef, c.acting)]);
      if (!t || (t.createdByUserId !== c.userId && t.assigneeUserId !== c.userId && !(t.kind === "company" && c.mayAssign))) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      if (!dep || !mayViewTask(dep, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such predecessor" });
      const reverse = await d.select().from(workTaskDependencies).where(and(eq(workTaskDependencies.taskRef, dep.taskRef), eq(workTaskDependencies.dependsOnTaskRef, t.taskRef))).limit(1);
      if (reverse.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That would make the two tasks wait on each other" });
      try { await d.insert(workTaskDependencies).values({ taskRef: t.taskRef, dependsOnTaskRef: dep.taskRef, createdByUserId: c.userId }); } catch { /* already there */ }
      return { taskRef: t.taskRef, dependsOnTaskRef: dep.taskRef };
    }),

  /* ============================ reminders =========================== */

  /** A personal reminder: the caller's own, about a task, an event, or nothing in particular. */
  reminderCreate: roleProcedure("work.reminderCreate")
    .input(z.object({
      title: z.string().min(1).max(220), body: z.string().max(2000).optional(), level: LEVEL.exclude(["compliance"]).default("normal"), timezone: TZ,
      at: z.coerce.date().optional(), subjectKind: z.enum(["task", "event", "standalone"]).default("standalone"), subjectRef: REF.optional(),
      relativeTo: z.enum(["none", "task_due", "event_start"]).default("none"), offsetMinutes: z.number().int().min(-100_000).max(100_000).optional(),
      recurrence: RULE.optional(), now: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createReminder(tx, c, { ...input, kind: "personal", ownerUserId: c.userId, requiresAcknowledgement: false, escalationPolicy: null, missedAfterMinutes: 60, sourceType: null, sourceRef: null }));
    }),

  /** A company reminder for somebody: may require acknowledgement, may be compliance, may escalate. */
  companyReminderCreate: roleProcedure("work.companyReminderCreate")
    .input(z.object({
      ownerUserId: z.number().int().positive(), title: z.string().min(1).max(220), body: z.string().max(2000).optional(), level: LEVEL.default("important"), timezone: TZ,
      at: z.coerce.date().optional(), subjectKind: z.enum(["task", "event", "standalone"]).default("standalone"), subjectRef: REF.optional(),
      relativeTo: z.enum(["none", "task_due", "event_start", "source_date"]).default("none"), offsetMinutes: z.number().int().min(-100_000).max(100_000).optional(),
      sourceType: z.string().max(40).optional(), sourceRef: z.string().max(120).optional(), sourceAt: z.coerce.date().optional(),
      requiresAcknowledgement: z.boolean().default(false), missedAfterMinutes: z.number().int().min(1).max(10_080).default(60),
      escalationPolicy: ESCALATION.optional(), recurrence: RULE.optional(), now: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction((tx: Tx) => createReminder(tx, c, { ...input, kind: "company", requiresAcknowledgement: input.requiresAcknowledgement || input.level === "compliance", escalationPolicy: input.escalationPolicy ?? null, sourceType: input.sourceType ?? null, sourceRef: input.sourceRef ?? null }));
    }),

  /**
   * The contract a voice or AI layer calls. Deterministic: the structure in, the plan out, and a
   * read-back. `commit: false` plans without creating, so the assistant can read it back first.
   */
  reminderCommand: roleProcedure("work.reminderCommand")
    .input(z.object({
      what: z.string().min(1).max(220), level: LEVEL.exclude(["compliance"]).optional(), timezone: TZ, commit: z.boolean().default(false), now: AT,
      when: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("absolute"), at: z.coerce.date() }),
        z.object({ kind: z.literal("relative_to_shift"), offsetMinutes: z.number().int().min(-100_000).max(100_000) }),
        z.object({ kind: z.literal("recurring"), rule: RULE }),
        z.object({ kind: z.literal("before_source"), sourceType: z.string().min(1).max(40), sourceRef: z.string().min(1).max(120), offsetDays: z.number().int().min(0).max(3650) }),
        z.object({ kind: z.literal("after_job"), jobRef: REF }),
        z.object({ kind: z.literal("on_return_to_yard") }),
      ]),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const when: ReminderCommand["when"] = input.when.kind === "recurring" ? { kind: "recurring", rule: toRule(input.when.rule) } : input.when;
      const context = await commandContext(d, c, input.now, when);
      const outcome = planReminder({ what: input.what, when, level: input.level }, { now: input.now, timezone: input.timezone, ...context });
      if (!outcome.ok) return { ok: false as const, reason: outcome.reason, needs: outcome.needs, reminderRef: null };
      if (!input.commit) return { ok: true as const, plan: outcome.plan, reminderRef: null, readBack: outcome.plan.readBack };
      const created = await d.transaction((tx: Tx) => createReminder(tx, c, {
        kind: "personal", ownerUserId: c.userId, title: outcome.plan.title, body: undefined, level: outcome.plan.level, timezone: outcome.plan.timezone,
        at: outcome.plan.recurrence ? undefined : outcome.plan.fireAt, subjectKind: "standalone", subjectRef: undefined,
        relativeTo: "none", offsetMinutes: outcome.plan.offsetMinutes ?? undefined, recurrence: outcome.plan.recurrence ? ruleInput(outcome.plan.recurrence) : undefined,
        requiresAcknowledgement: false, escalationPolicy: null, missedAfterMinutes: 60, sourceType: outcome.plan.sourceType, sourceRef: outcome.plan.sourceRef, now: input.now,
      }));
      return { ok: true as const, plan: outcome.plan, reminderRef: created.reminderRef, readBack: outcome.plan.readBack };
    }),

  reminderList: roleProcedure("work.reminderList")
    .input(z.object({ includeClosed: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const rows = await d.select().from(reminders).where(and(orgWhere(reminders.orgRef, c.acting), eq(reminders.ownerUserId, c.userId), input?.includeClosed ? undefined : inArray(reminders.state, ["scheduled", "fired", "snoozed", "missed"]))).orderBy(asc(reminders.fireAt)).limit(500);
      return { reminders: rows.map(r => ({ ...r, snoozeChoices: SNOOZE_CHOICE_KINDS })) };
    }),

  reminderSnooze: roleProcedure("work.reminderSnooze")
    .input(z.object({ reminderRef: REF, choice: SNOOZE, actionRef: z.string().max(120).optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const r = await ownReminder(tx, c, input.reminderRef);
        const applied = await applyReminderOutcome(tx, r, snoozeReminder(r.shape, input.choice as SnoozeChoice, input.at), { actorUserId: c.userId, actorSource: "human", actionRef: input.actionRef ?? null, acting: c.acting }, input.at);
        return { reminderRef: r.reminderRef, applied: applied.applied, state: applied.changes?.state ?? r.state, fireAt: applied.changes?.fireAt ?? r.fireAt };
      });
    }),

  reminderAcknowledge: roleProcedure("work.reminderAcknowledge")
    .input(z.object({ reminderRef: REF, actionRef: z.string().max(120).optional(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const r = await ownReminder(tx, c, input.reminderRef);
        const applied = await applyReminderOutcome(tx, r, acknowledge(r.shape, input.at), { actorUserId: c.userId, actorSource: "human", actionRef: input.actionRef ?? null, acting: c.acting }, input.at);
        return { reminderRef: r.reminderRef, applied: applied.applied, state: applied.changes?.state ?? r.state, nextFireAt: applied.changes?.state === "scheduled" ? applied.changes.fireAt ?? null : null };
      });
    }),

  reminderCancel: roleProcedure("work.reminderCancel")
    .input(z.object({ reminderRef: REF, at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const r = await ownReminder(tx, c, input.reminderRef, true);
        const applied = await applyReminderOutcome(tx, r, cancelReminder(r.shape, input.at), { actorUserId: c.userId, actorSource: "human", acting: c.acting }, input.at);
        return { reminderRef: r.reminderRef, state: applied.changes?.state ?? r.state };
      });
    }),

  reminderReschedule: roleProcedure("work.reminderReschedule")
    .input(z.object({ reminderRef: REF, fireAt: z.coerce.date(), at: AT }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      return d.transaction(async (tx: Tx) => {
        const r = await ownReminder(tx, c, input.reminderRef, true);
        const applied = await applyReminderOutcome(tx, r, rescheduleReminder(r.shape, input.fireAt, input.at), { actorUserId: c.userId, actorSource: "human", acting: c.acting }, input.at);
        return { reminderRef: r.reminderRef, fireAt: applied.changes?.fireAt ?? r.fireAt };
      });
    }),

  /** What the device holds so it can notify with no service: the caller's open reminders, compactly. */
  deviceSchedule: roleProcedure("work.deviceSchedule")
    .input(z.object({ horizonDays: z.number().int().min(1).max(60).default(14), now: AT }).optional())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const now = input?.now ?? new Date();
      const horizon = new Date(now.getTime() + (input?.horizonDays ?? 14) * DAY);
      const rows = await d.select().from(reminders).where(and(orgWhere(reminders.orgRef, c.acting), eq(reminders.ownerUserId, c.userId), inArray(reminders.state, ["scheduled", "fired", "snoozed", "missed"]))).orderBy(asc(reminders.fireAt)).limit(500);
      const entries = rows.filter(r => r.fireAt.getTime() <= horizon.getTime()).map(r => toDeviceEntry({ ...reminderShape(r, null), version: r.version, title: r.title, body: r.body, deepLink: r.deepLink, subjectKind: r.subjectKind, subjectRef: r.subjectRef }));
      return { fetchedAt: now, horizon, entries, note: "A local notification is the device's to schedule under its operating system's rules; LeaseOS does not bypass them. Actions taken offline replay through deviceActionsApply, each once." };
    }),

  /** What the device did while out of coverage. Each actionRef is applied exactly once. */
  deviceActionsApply: roleProcedure("work.deviceActionsApply")
    .input(z.object({
      deviceRef: z.string().max(64).optional(),
      actions: z.array(z.object({ actionRef: z.string().min(8).max(120), reminderRef: REF, action: z.enum(["acknowledged", "snoozed", "completed"]), occurredAt: z.coerce.date(), snoozeChoice: SNOOZE.optional() })).min(1).max(200),
      now: AT,
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const actions: DeviceAction[] = input.actions.map(a => ({ actionRef: a.actionRef, reminderRef: a.reminderRef, action: a.action, occurredAt: a.occurredAt, snoozeChoice: (a.snoozeChoice as SnoozeChoice | undefined) ?? null }));
      const results = await d.transaction((tx: Tx) => applyDeviceActions(tx, { acting: c.acting, userId: c.userId, deviceRef: input.deviceRef ?? null, actions, now: input.now }));
      return { results, applied: results.filter(r => r.outcome === "applied").length, duplicates: results.filter(r => r.outcome === "duplicate").length, refused: results.filter(r => r.outcome === "refused").length };
    }),

  /** The audit trail of a company subject. A private subject's trail is its owner's and is not served here. */
  audit: roleProcedure("work.audit")
    .input(z.object({ subjectKind: z.enum(["task", "event", "reminder"]), subjectRef: REF }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const c = await caller(d, ctx);
      const rows = (await auditTrail(d, input.subjectKind, input.subjectRef, c.acting)).filter(r => r.visibility === "operational");
      return { subjectKind: input.subjectKind, subjectRef: input.subjectRef, events: rows.map(r => ({ action: r.action, actorUserId: r.actorUserId, actorSource: r.actorSource, detail: r.detailJson ? JSON.parse(r.detailJson) : null, occurredAt: r.occurredAt })), note: "Private subjects are not listed here; their trail holds no content and belongs to their owner." };
    }),

  /** What the worker runs each heartbeat, on demand. Idempotent: run it twice and the second pass changes nothing. */
  sweep: roleProcedure("work.sweep")
    .input(z.object({ now: AT }).optional())
    .mutation(async ({ input }) => {
      const d = await db();
      return sweepWork(d, input?.now ?? new Date());
    }),
});

/* ------------------------------------------------------------------ */
/* Shared write paths                                                   */
/* ------------------------------------------------------------------ */

type EventCreateInput = {
  kind: "personal" | "company"; ownerUserId: number; title: string; detail?: string; location?: string; category: (typeof EVENT_CATEGORIES)[number];
  state: "confirmed" | "projected" | "recommended" | "required"; visibility: "private" | "operational" | "administrative"; startsAt: Date; endsAt?: Date; allDay: boolean; timezone: string;
  requiresAcknowledgement: boolean; participants: number[]; recurrence?: RuleInput; sourceType?: string; sourceRef?: string; taskRef?: string; at: Date;
};

async function createEvent(tx: Tx, c: Caller, input: EventCreateInput) {
  if (input.endsAt && input.endsAt.getTime() < input.startsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The event ends before it begins" });
  if ((input.sourceType && !input.sourceRef) || (!input.sourceType && input.sourceRef)) throw new TRPCError({ code: "BAD_REQUEST", message: "A link names both the record type and its reference" });
  let recurrenceRuleRef: string | null = null;
  if (input.recurrence) {
    const rule = toRule(input.recurrence);
    const problems = validateRule(rule);
    if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: problems.join("; ") });
    recurrenceRuleRef = await insertRule(tx, rule, c.acting, c.userId);
  }
  if (input.taskRef) {
    const t = await loadTask(tx, input.taskRef, c.acting);
    if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such task to block time for" });
  }
  const eventRef = workRef("CAL");
  await tx.insert(calendarEvents).values({
    eventRef, orgRef: orgRefFor(c.acting), kind: input.kind, category: input.category, state: input.state, visibility: input.visibility,
    ownerUserId: input.ownerUserId, createdByUserId: c.userId, title: input.title, detail: input.detail ?? null, location: input.location ?? null,
    startsAt: input.startsAt, endsAt: input.endsAt ?? null, allDay: input.allDay, timezone: input.timezone, recurrenceRuleRef,
    sourceType: input.sourceType ?? null, sourceRef: input.sourceRef ?? null, taskRef: input.taskRef ?? null, requiresAcknowledgement: input.requiresAcknowledgement,
    createdAt: input.at, updatedAt: input.at,
  });
  const people = Array.from(new Set([input.ownerUserId, ...input.participants]));
  for (const userId of people) {
    await tx.insert(calendarEventParticipants).values({ eventRef, userId, participantRole: userId === input.ownerUserId ? "owner" : "required", createdAt: input.at });
    if (input.kind === "company" && userId !== c.userId) {
      await queueNotification(tx, { key: `event:${eventRef}:invited:${userId}`, tenantId: c.acting.tenantId, recipientUserId: userId, recipientRole: null, title: `${input.state === "required" ? "Required: " : ""}${input.title}`, body: `${input.startsAt.toISOString()}${input.location ? ` — ${input.location}` : ""}`, deepLink: `/work/events/${eventRef}`, channel: "in_app", at: input.at });
    }
  }
  await audit(tx, { acting: c.acting, subjectKind: "event", subjectRef: eventRef, action: "created", actorUserId: c.userId, visibility: input.kind === "personal" ? "private" : "operational", detail: { category: input.category, state: input.state, participants: people.length, startsAt: input.startsAt }, at: input.at });
  if (input.kind === "company") await emitWorkEvent(tx, { acting: c.acting, type: "work.event.created", aggregateType: "calendarEvent", aggregateId: eventRef, actorUserId: c.userId, payload: { eventRef, category: input.category, state: input.state, startsAt: input.startsAt, participants: people }, at: input.at });
  return { eventRef, state: input.state, participants: people.length, recurrenceRuleRef };
}

type TaskCreateInput = {
  kind: "personal" | "company"; title: string; description?: string; priority: "low" | "normal" | "high" | "critical"; assigneeUserId: number | null; teamRef: string | null;
  visibility: "private" | "operational"; startAt?: Date; dueAt?: Date; timezone: string; jobRef?: string; dispatchRef: string | null; driverUserId: number | null; unitRef?: string; documentRef?: string;
  sourceType: string | null; sourceRef: string | null; checklist: string[]; requiresCompletionEvidence: boolean; requiresAcknowledgement: boolean;
  reminder?: { offsetMinutes: number; level: "normal" | "important" | "alarm" | "compliance" }; escalationPolicy: z.infer<typeof ESCALATION> | null; recurrence?: RuleInput; at: Date;
};

async function createTask(tx: Tx, c: Caller, input: TaskCreateInput) {
  if (input.dueAt && input.startAt && input.dueAt.getTime() < input.startAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The task is due before it starts" });
  if (input.kind === "personal" && input.escalationPolicy) throw new TRPCError({ code: "BAD_REQUEST", message: "A personal task never escalates" });
  if (input.reminder && !input.dueAt) throw new TRPCError({ code: "BAD_REQUEST", message: "A reminder relative to the due date needs a due date" });
  let recurrenceRuleRef: string | null = null;
  if (input.recurrence) {
    const rule = toRule(input.recurrence);
    const problems = validateRule(rule);
    if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: problems.join("; ") });
    recurrenceRuleRef = await insertRule(tx, rule, c.acting, c.userId);
  }
  const taskRef = workRef("TSK");
  const assigned = input.assigneeUserId != null;
  await tx.insert(workTasks).values({
    taskRef, orgRef: orgRefFor(c.acting), kind: input.kind, status: input.kind === "personal" ? "inbox" : assigned ? "todo" : "inbox",
    assignmentState: input.kind === "personal" ? "accepted" : assigned ? "assigned" : "unassigned", visibility: input.visibility,
    title: input.title, description: input.description ?? null, priority: input.priority, createdByUserId: c.userId, assigneeUserId: input.assigneeUserId, teamRef: input.teamRef,
    startAt: input.startAt ?? null, dueAt: input.dueAt ?? null, timezone: input.timezone,
    jobRef: input.jobRef ?? null, dispatchRef: input.dispatchRef, driverUserId: input.driverUserId, unitRef: input.unitRef ?? null, documentRef: input.documentRef ?? null,
    sourceType: input.sourceType, sourceRef: input.sourceRef, recurrenceRuleRef, requiresAcknowledgement: input.requiresAcknowledgement,
    requiresCompletionEvidence: input.requiresCompletionEvidence, escalationPolicyJson: input.escalationPolicy ? JSON.stringify(input.escalationPolicy) : null,
    createdAt: input.at, updatedAt: input.at,
  });
  let order = 0;
  for (const label of input.checklist) await tx.insert(workTaskChecklistItems).values({ itemRef: workRef("TCI"), taskRef, sortOrder: order++, label, createdAt: input.at });
  await audit(tx, { acting: c.acting, subjectKind: "task", subjectRef: taskRef, action: "created", actorUserId: c.userId, visibility: input.visibility, detail: { priority: input.priority, assigneeUserId: input.assigneeUserId, dueAt: input.dueAt ?? null, requiresCompletionEvidence: input.requiresCompletionEvidence }, at: input.at });
  let reminderRef: string | null = null;
  if (input.reminder && input.dueAt) {
    const created = await createReminder(tx, c, {
      kind: input.kind, ownerUserId: input.assigneeUserId ?? c.userId, title: input.title, body: input.description, level: input.reminder.level, timezone: input.timezone,
      subjectKind: "task", subjectRef: taskRef, relativeTo: "task_due", offsetMinutes: input.reminder.offsetMinutes, subjectAt: input.dueAt,
      requiresAcknowledgement: input.reminder.level === "compliance", escalationPolicy: input.kind === "company" ? input.escalationPolicy : null, missedAfterMinutes: 60, sourceType: null, sourceRef: null, now: input.at, deepLink: `/work/tasks/${taskRef}`,
    });
    reminderRef = created.reminderRef;
  }
  if (input.kind === "company") {
    if (assigned && input.assigneeUserId !== c.userId) {
      await audit(tx, { acting: c.acting, subjectKind: "task", subjectRef: taskRef, action: "assigned", actorUserId: c.userId, visibility: "operational", detail: { assigneeUserId: input.assigneeUserId }, at: input.at });
      await queueNotification(tx, { key: `task:${taskRef}:assigned:${input.assigneeUserId}:${input.at.toISOString()}`, tenantId: c.acting.tenantId, recipientUserId: input.assigneeUserId, recipientRole: null, title: `Assigned: ${input.title}`, body: input.dueAt ? `Due ${input.dueAt.toISOString()}` : null, deepLink: `/work/tasks/${taskRef}`, channel: "in_app", at: input.at });
    }
    await emitWorkEvent(tx, { acting: c.acting, type: assigned ? "work.task.assigned" : "work.task.created", aggregateType: "workTask", aggregateId: taskRef, actorUserId: c.userId, payload: { taskRef, assigneeUserId: input.assigneeUserId, dueAt: input.dueAt ?? null, sourceType: input.sourceType, sourceRef: input.sourceRef }, at: input.at });
  }
  return { taskRef, status: input.kind === "personal" ? "inbox" as const : assigned ? "todo" as const : "inbox" as const, reminderRef, recurrenceRuleRef, deepLink: `/work/tasks/${taskRef}` };
}

async function moveTask(tx: Tx, c: Caller, taskRef: string, action: TaskAction, opts: { reason: string | null; evidenceRef: string | null; at: Date }) {
  const t = await loadTask(tx, taskRef, c.acting);
  if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
  const outcome = transitionTask(taskShape(t), action, {
    actor: { userId: c.userId, mayVerify: c.mayVerify, mayAssign: c.mayAssign }, now: opts.at,
    checklistOpen: await openChecklistCount(tx, t.taskRef), dependenciesOpen: await openDependencies(tx, t.taskRef), reason: opts.reason, evidenceRef: opts.evidenceRef,
  });
  if (!outcome.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: outcome.reason });
  await tx.update(workTasks).set({ ...outcome.changes, version: t.version + 1, updatedAt: opts.at, acknowledgedAt: action === "accept" ? opts.at : t.acknowledgedAt }).where(eq(workTasks.id, t.id));
  await audit(tx, { acting: c.acting, subjectKind: "task", subjectRef: t.taskRef, action: outcome.auditAction, actorUserId: c.userId, visibility: t.visibility, detail: { from: t.status, to: outcome.changes.status, reason: opts.reason }, at: opts.at });
  let remindersClosed = 0;
  if (outcome.changes.status === "completed" || outcome.changes.status === "verified" || outcome.changes.status === "cancelled") remindersClosed = await completeRemindersFor(tx, "task", t.taskRef, c.acting, c.userId, opts.at);
  if (t.kind === "company") {
    if (outcome.changes.status === "submitted") await queueNotification(tx, { key: `task:${t.taskRef}:submitted:${opts.at.toISOString()}`, tenantId: c.acting.tenantId, recipientUserId: t.createdByUserId === c.userId ? null : t.createdByUserId, recipientRole: t.createdByUserId === c.userId ? "dispatcher" : null, title: `Submitted for verification: ${t.title}`, body: null, deepLink: `/work/tasks/${t.taskRef}`, channel: "in_app", at: opts.at });
    if ((outcome.changes.status === "in_progress" && action === "return") && t.assigneeUserId) await queueNotification(tx, { key: `task:${t.taskRef}:returned:${opts.at.toISOString()}`, tenantId: c.acting.tenantId, recipientUserId: t.assigneeUserId, recipientRole: null, title: `Returned: ${t.title}`, body: opts.reason, deepLink: `/work/tasks/${t.taskRef}`, channel: "in_app", at: opts.at });
    await emitWorkEvent(tx, { acting: c.acting, type: `work.task.${outcome.auditAction}`, aggregateType: "workTask", aggregateId: t.taskRef, actorUserId: c.userId, payload: { taskRef: t.taskRef, from: t.status, to: outcome.changes.status, reason: opts.reason, evidenceRef: outcome.changes.completionEvidenceRef ?? null }, at: opts.at });
  }
  return { taskRef: t.taskRef, status: outcome.changes.status, assignmentState: outcome.changes.assignmentState, remindersClosed };
}

type ReminderCreateInput = {
  kind: "personal" | "company"; ownerUserId: number; title: string; body?: string; level: "normal" | "important" | "alarm" | "compliance"; timezone: string;
  at?: Date; subjectKind: "task" | "event" | "standalone"; subjectRef?: string; relativeTo: "none" | "task_due" | "event_start" | "source_date"; offsetMinutes?: number;
  subjectAt?: Date; sourceAt?: Date; sourceType: string | null; sourceRef: string | null; requiresAcknowledgement: boolean; missedAfterMinutes: number;
  escalationPolicy: z.infer<typeof ESCALATION> | null; recurrence?: RuleInput; now: Date; deepLink?: string;
};

async function createReminder(tx: Tx, c: Caller, input: ReminderCreateInput) {
  const rule = input.recurrence ? toRule(input.recurrence) : null;
  if (rule) { const problems = validateRule(rule); if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: problems.join("; ") }); }
  // The subject's own time, when the reminder is relative to it, read from the subject rather than the body.
  let subjectAt: Date | null = input.subjectAt ?? null;
  let deepLink = input.deepLink ?? null;
  if (input.subjectKind === "task") {
    if (!input.subjectRef) throw new TRPCError({ code: "BAD_REQUEST", message: "A reminder about a task names it" });
    const t = await loadTask(tx, input.subjectRef, c.acting);
    if (!t || !mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule })) throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
    if (input.kind === "personal" && t.assigneeUserId !== c.userId && t.createdByUserId !== c.userId) throw new TRPCError({ code: "FORBIDDEN", message: "Not your task" });
    subjectAt = input.relativeTo === "task_due" ? t.dueAt : subjectAt;
    deepLink = deepLink ?? `/work/tasks/${t.taskRef}`;
  } else if (input.subjectKind === "event") {
    if (!input.subjectRef) throw new TRPCError({ code: "BAD_REQUEST", message: "A reminder about an event names it" });
    const e = await loadEvent(tx, input.subjectRef, c.acting);
    if (!e || (e.ownerUserId !== c.userId && !(await isParticipant(tx, e.eventRef, c.userId)) && !(e.kind === "company" && c.mayAssign))) throw new TRPCError({ code: "NOT_FOUND", message: "No such event" });
    subjectAt = input.relativeTo === "event_start" ? e.startsAt : subjectAt;
    deepLink = deepLink ?? `/work/events/${e.eventRef}`;
  }
  if (input.relativeTo === "source_date") subjectAt = input.sourceAt ?? null;
  const spec: ReminderInput = {
    kind: input.kind, level: input.level, ownerUserId: input.ownerUserId, createdByUserId: c.userId, relativeTo: input.relativeTo, offsetMinutes: input.offsetMinutes ?? null,
    at: input.at ?? null, subjectAt, recurrence: rule, escalationPolicy: input.escalationPolicy, requiresAcknowledgement: input.requiresAcknowledgement,
  };
  const problems = validateReminderInput(spec);
  if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: problems.join("; ") });
  const fireAt = computeFireAt(spec);
  if (!fireAt.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: fireAt.reason });
  const recurrenceRuleRef = rule ? await insertRule(tx, rule, c.acting, c.userId) : null;
  const reminderRef = workRef("RMD");
  await tx.insert(reminders).values({
    reminderRef, orgRef: orgRefFor(c.acting), kind: input.kind, level: input.level, ownerUserId: input.ownerUserId, createdByUserId: c.userId,
    subjectKind: input.subjectKind, subjectRef: input.subjectRef ?? null, title: input.title, body: input.body ?? null, deepLink,
    relativeTo: input.relativeTo, offsetMinutes: input.offsetMinutes ?? null, sourceType: input.sourceType, sourceRef: input.sourceRef, timezone: input.timezone,
    fireAt: fireAt.fireAt, originalFireAt: fireAt.fireAt, recurrenceRuleRef, state: "scheduled", requiresAcknowledgement: input.requiresAcknowledgement,
    missedAfterMinutes: input.missedAfterMinutes, escalationPolicyJson: input.escalationPolicy ? JSON.stringify(input.escalationPolicy) : null,
    createdAt: input.now, updatedAt: input.now,
  });
  await recordReminderAction(tx, { actionRef: `${reminderRef}:created`, reminderRef, action: "created", actorUserId: c.userId, actorSource: "human", occurredAt: input.now, effectiveAt: fireAt.fireAt });
  await audit(tx, { acting: c.acting, subjectKind: "reminder", subjectRef: reminderRef, action: "created", actorUserId: c.userId, visibility: input.kind === "personal" ? "private" : "operational", detail: { level: input.level, fireAt: fireAt.fireAt, ownerUserId: input.ownerUserId, requiresAcknowledgement: input.requiresAcknowledgement, escalates: !!input.escalationPolicy }, at: input.now });
  return { reminderRef, fireAt: fireAt.fireAt, state: "scheduled" as const, recurrenceRuleRef };
}

async function ownReminder(tx: Tx, c: Caller, reminderRef: string, creatorMay = false) {
  const r = await loadReminder(tx, reminderRef, c.acting);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "No such reminder" });
  if (r.ownerUserId !== c.userId && !(creatorMay && r.createdByUserId === c.userId)) throw new TRPCError({ code: "NOT_FOUND", message: "No such reminder" });
  return r;
}

const ruleInput = (r: RecurrenceRule): RuleInput => ({
  frequency: r.frequency, intervalCount: r.intervalCount ?? undefined, byWeekday: r.byWeekday ? [...r.byWeekday] : undefined, byMonthDay: r.byMonthDay ?? undefined,
  ordinalWeek: r.ordinalWeek ?? undefined, ordinalWeekday: r.ordinalWeekday ?? undefined, timezone: r.timezone, anchorAt: r.anchorAt, untilAt: r.untilAt ?? undefined, occurrenceLimit: r.occurrenceLimit ?? undefined,
});

/** What the command planner needs from the records: the next shift, the referenced record's date. Looked up, never guessed. */
async function commandContext(d: Db, c: Caller, now: Date, when: ReminderCommand["when"]) {
  const ctx: { nextShiftStartAt?: Date | null; sourceDates?: Record<string, Date | null> } = {};
  if (when.kind === "relative_to_shift") {
    const op = (await d.select({ id: operators.id }).from(operators).where(eq(operators.userId, c.userId)).limit(1))[0];
    const next = op ? (await d.select().from(resourceBookings).where(and(eq(resourceBookings.resourceType, "operator"), eq(resourceBookings.resourceRef, String(op.id)), inArray(resourceBookings.bookingState, ["tentative", "confirmed"]))).orderBy(asc(resourceBookings.startsAt)).limit(50)).find(b => b.startsAt.getTime() > now.getTime()) : undefined;
    ctx.nextShiftStartAt = next?.startsAt ?? null;
  }
  if (when.kind === "before_source") {
    const key = `${when.sourceType}:${when.sourceRef}`;
    ctx.sourceDates = { [key]: await sourceDate(d, c, when.sourceType, when.sourceRef) };
  }
  return ctx;
}

/** The date a referenced record holds. Only the records this slice knows how to read; anything else is "nothing looked up". */
async function sourceDate(d: Db, c: Caller, sourceType: string, sourceRef: string): Promise<Date | null> {
  if (sourceType === "workerQualification") {
    const row = (await d.select({ expiresAt: workerQualifications.expiresAt, userId: workerQualifications.userId, verificationState: workerQualifications.verificationState }).from(workerQualifications).where(eq(workerQualifications.holdingRef, sourceRef)).limit(1))[0];
    if (!row || row.userId !== c.userId) return null;
    return row.verificationState === "verified" ? row.expiresAt : null;
  }
  if (sourceType === "calendarEvent") {
    const e = await loadEvent(d, sourceRef, c.acting);
    return e && (e.ownerUserId === c.userId || await isParticipant(d, e.eventRef, c.userId)) ? e.startsAt : null;
  }
  if (sourceType === "workTask") {
    const t = await loadTask(d, sourceRef, c.acting);
    return t && mayViewTask(t, { userId: c.userId, maySchedule: c.maySchedule }) ? t.dueAt : null;
  }
  return null;
}
