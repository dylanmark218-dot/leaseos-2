/**
 * v22.20 (0094) — the calendar, projected from records that now exist.
 *
 * No new tables. That is the point: a calendar with its own event table is a
 * second copy of the truth, and the moment somebody edits the copy the two
 * disagree and nobody knows which is right. Everything here is derived at read
 * time from leave, shift posts, qualification expiries and crew rotations, and
 * every event carries the reference it came from.
 *
 * Two rules this layer enforces that the engine cannot.
 *
 * **Somebody else's private event is not hidden — it is redacted.** Hiding it
 * would show a person as available when they are not, which is worse than
 * saying nothing. A scheduler sees "Unavailable" and the window; they do not
 * see why.
 *
 * **A qualification with no verified expiry projects as unknown, not as fine.**
 * The same rule the eligibility read follows. A compliance tile that goes quiet
 * because a date is missing is the failure this system is built against.
 */
import { effectiveQualifications } from "./qualificationReads";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { crewMembers, crews, leaveRequests, shiftInterests, shiftPosts } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import type { DbOrTx } from "./_core/dbTypes";
import {
  isOnShift, project, severityOf, visibleTo,
  type Audience, type ProjectedEvent,
} from "./_core/calendarProjection";
import { SENSITIVE_CATEGORIES, type LeaveCategory } from "./_core/timeOff";

async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const MAX_DAYS = 120;

/**
 * Build the events for one window.
 *
 * `forUserId` is whose calendar; `audience` decides what is shown of it. The
 * two are separate on purpose — a dispatcher reading a driver's calendar is a
 * normal thing to do and must not be the same as the driver reading it.
 */
async function buildEvents(d: DbOrTx, args: { tenantId: string; forUserId: number; from: Date; to: Date }): Promise<ProjectedEvent[]> {
  const events: ProjectedEvent[] = [];

  /* Leave. Sensitive categories are projected private, so the visibility rule
     redacts them for anybody but the owner. */
  const leave = await d.select().from(leaveRequests).where(and(
    eq(leaveRequests.userId, args.forUserId),
    lte(leaveRequests.fromDate, args.to),
    gte(leaveRequests.toDate, args.from),
  )).limit(200);
  for (const l of leave) {
    if (l.status === "declined" || l.status === "cancelled") continue;
    const sensitive = SENSITIVE_CATEGORIES.includes(l.category as LeaveCategory);
    events.push(project({
      layer: sensitive ? "personal" : "shift",
      title: l.status === "recorded" ? "Called off" : `Leave — ${l.category.replace(/_/g, " ")}`,
      detail: l.status === "requested" ? "Requested, not yet decided" : null,
      at: l.fromDate, endsAt: l.toDate, allDay: !l.partialFromTime,
      severity: l.status === "approved" || l.status === "recorded" ? "informational" : "due",
      visibility: sensitive ? "private" : "operational",
      ownerUserId: l.userId,
      source: { sourceType: "leaveRequest", sourceRef: l.requestRef, generatedBy: "leave_projection" },
    }));
  }

  /* Qualification expiries. A verified holding with no expiry is unknown. */
  // C1b-3: from the qualification read adapter (Academy first; legacy only as a marked fallback; this
  // organization). One event per qualification code, for the record that governs it; only verified
  // records appear, as before.
  const quals = await effectiveQualifications(d, { tenantId: args.tenantId, userId: args.forUserId, at: args.from });
  for (const q of quals) {
    if (!q.source || q.state === "none" || q.state === "unverified" || q.state === "rejected") continue;
    if (q.expiresAt && (q.expiresAt < args.from || q.expiresAt > args.to)) continue;
    events.push(project({
      layer: "compliance",
      title: q.expiresAt ? `${q.code} expires` : `${q.code} — no expiry recorded`,
      detail: q.certificateNumber ?? q.academyQualificationRef,
      at: q.expiresAt ?? args.from, endsAt: null, allDay: true,
      // blocksWork is true: a ticket the work requires is a blocking expiry.
      severity: severityOf({ dueAt: q.expiresAt, now: args.from, blocksWork: true }),
      visibility: "operational",
      ownerUserId: q.userId,
      source: {
        sourceType: q.source === "ACADEMY_QUALIFICATION" ? "academyQualification" : "workerQualification",
        sourceRef: q.sourceRef!, generatedBy: "qualification_projection",
      },
    }));
  }

  /* Shifts this person said they would take. Interest, not assignment. */
  const interests = await d.select().from(shiftInterests).where(and(
    eq(shiftInterests.userId, args.forUserId), isNull(shiftInterests.withdrawnAt),
  )).limit(200);
  for (const i of interests) {
    const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, i.postRef)).limit(1))[0];
    if (!post || post.tenantId !== args.tenantId) continue;
    if (post.startsAt < args.from || post.startsAt > args.to) continue;
    events.push(project({
      layer: "dispatch",
      title: `${post.title} — interest expressed`,
      detail: "Not an assignment. Dispatch assigns and the readiness check runs then.",
      at: post.startsAt, endsAt: post.endsAt, allDay: false,
      severity: "informational", visibility: "operational", ownerUserId: args.forUserId,
      source: { sourceType: "shiftPost", sourceRef: post.postRef, generatedBy: "interest_projection" },
    }));
  }

  /* Rotation. One event per on-hitch day, from the member's own pattern. */
  const memberships = await d.select().from(crewMembers).where(and(
    eq(crewMembers.userId, args.forUserId), isNull(crewMembers.leftAt),
  )).limit(50);
  for (const m of memberships) {
    if (!m.rotationOnDays || !m.rotationAnchor) continue;
    const crew = (await d.select().from(crews).where(eq(crews.crewRef, m.crewRef)).limit(1))[0];
    if (!crew || crew.tenantId !== args.tenantId) continue;
    const pattern = { onDays: m.rotationOnDays, offDays: m.rotationOffDays ?? 0, anchor: m.rotationAnchor, label: `${m.rotationOnDays}/${m.rotationOffDays ?? 0}` };
    // Exclusive of `to`: a 14-day window is 14 days, not 15. Including the
    // boundary made a 7/7 rotation report eight on-hitch days in a fortnight,
    // which a crew would have noticed before any test did.
    for (let t = args.from.getTime(); t < args.to.getTime(); t += 86_400_000) {
      const day = new Date(t);
      if (!isOnShift(pattern, day)) continue;
      events.push(project({
        layer: "rotation",
        title: `${crew.name} — on hitch (${pattern.label})`,
        detail: null, at: day, endsAt: null, allDay: true,
        severity: "informational", visibility: "operational", ownerUserId: args.forUserId,
        source: { sourceType: "crewMember", sourceRef: `${m.crewRef}:${m.userId}`, generatedBy: "rotation_projection" },
      }));
    }
  }

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export const calendarRouter = router({
  /** The caller's own calendar, in full. */
  mine: roleProcedure("calendar.mine")
    .input(z.object({ from: z.coerce.date(), days: z.number().int().min(1).max(MAX_DAYS).default(14) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const to = new Date(input.from.getTime() + input.days * 86_400_000);
      const events = await buildEvents(d, { tenantId: acting.tenantId, forUserId: ctx.user.id, from: input.from, to });
      const audience: Audience = { kind: "self", userId: ctx.user.id };
      return {
        events: visibleTo(events, audience),
        note: "Projected from records. Every event carries the reference it came from; the calendar holds none of these dates itself.",
      };
    }),

  /**
   * Somebody else's calendar, for scheduling.
   *
   * A private event is present and redacted rather than absent, because an
   * absent event would show them as free.
   */
  forScheduling: roleProcedure("calendar.forScheduling")
    .input(z.object({ userId: z.number().int().positive(), from: z.coerce.date(), days: z.number().int().min(1).max(MAX_DAYS).default(14) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const to = new Date(input.from.getTime() + input.days * 86_400_000);
      const events = await buildEvents(d, { tenantId: acting.tenantId, forUserId: input.userId, from: input.from, to });
      const visible = visibleTo(events, { kind: "operational", userId: ctx.user.id });
      return {
        userId: input.userId,
        events: visible,
        redactedCount: visible.filter(e => e.redacted).length,
        note: "A private event appears as Unavailable with its window intact. Hiding it would show this person as free.",
      };
    }),

  /** Only what needs somebody to act, for a dispatcher watching a window. */
  exceptions: roleProcedure("calendar.exceptions")
    .input(z.object({ userId: z.number().int().positive(), from: z.coerce.date(), days: z.number().int().min(1).max(MAX_DAYS).default(30) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const to = new Date(input.from.getTime() + input.days * 86_400_000);
      const events = await buildEvents(d, { tenantId: acting.tenantId, forUserId: input.userId, from: input.from, to });
      const visible = visibleTo(events, { kind: "operational", userId: ctx.user.id });
      const actionable = visible.filter(e => e.severity === "blocking" || e.severity === "overdue" || e.severity === "unknown" || e.severity === "due");
      return {
        userId: input.userId,
        events: actionable,
        note: actionable.length
          ? "Blocking, overdue, due and unknown. An unknown is listed because a date nobody has established is not a date that is fine."
          : "Nothing in this window needs action.",
      };
    }),
});
