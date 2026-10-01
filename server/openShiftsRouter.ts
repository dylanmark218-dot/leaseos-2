/**
 * v22.20 (0091) — open shifts, reachable.
 *
 * SPINE item 2 (owner's ruling): `_core/openShifts.ts` `shiftEligibility` is the one answer to
 * "may this person take this shift?". This router reads the records that answer needs — role
 * grants, the organization's roster, approved leave, existing bookings, the person's own operator
 * record and the qualification read adapter's standings — and enforces the verdict. It decides no
 * eligibility itself; `spineItem2Duplicates.test.ts` keeps it that way.
 *
 * Seeing a post (`shifts.read`), saying you would take it (`shifts.interest`) and posting work
 * (`shifts.post`) stay three permissions. Only the work-taking action is gated by eligibility, and
 * an answer that cannot be established refuses.
 */
import { conflictingBookingsWhere } from "./_core/bookingConflict";
import { effectiveQualifications } from "./qualificationReads";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoles, operatorForUserInScope, userInScope } from "./db";
import { crewMembers, crews, leaveRequests, operators, resourceBookings, shiftInterests, shiftPosts, type ShiftPostRow } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { grantsInOrganization } from "./_core/recordsAuthorization";
import { expressInterest, NotEligible, shiftEligibility, type PersonFacts, type ShiftPost } from "./_core/openShifts";
import type { DbOrTx } from "./_core/dbTypes";
import type { LeaveRequest } from "./_core/timeOff";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const asPost = (r: ShiftPostRow): ShiftPost => ({
  postRef: r.postRef, title: r.title, startsAt: r.startsAt, endsAt: r.endsAt, location: r.location,
  requiredRole: r.requiredRole, requiredQualifications: JSON.parse(r.requiredQualificationsJson) as string[],
  seats: r.seats, kind: r.kind, status: r.status,
});

/**
 * The records `shiftEligibility` reads about one person, in the post's organization. Reads only;
 * every judgement is the engine's. Someone outside the organization is not read at all.
 */
async function personFacts(d: DbOrTx, tenantId: string, post: ShiftPost, userId: number): Promise<PersonFacts> {
  const scope = { tenantId };
  const none: PersonFacts = { userId, name: `user ${userId}`, inOrganization: false, roles: [], rosters: [], leave: [], commitments: [], licence: { kind: "none" }, qualifications: [] };
  if (!(await userInScope(userId, scope))) return none;

  const roles = grantsInOrganization(await listActiveUserRoles(userId), tenantId).map(g => g.role);

  const rosterRows = await d.select({ on: crewMembers.rotationOnDays, off: crewMembers.rotationOffDays, anchor: crewMembers.rotationAnchor })
    .from(crewMembers).innerJoin(crews, eq(crews.crewRef, crewMembers.crewRef))
    .where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt), eq(crews.state, "active"),
      tenantId === SINGLE_TENANT_ID ? or(isNull(crews.tenantId), eq(crews.tenantId, SINGLE_TENANT_ID)) : eq(crews.tenantId, tenantId)))
    .limit(50);
  const rosters = rosterRows.map(r => ({ rotation: r.on && r.anchor ? { onDays: r.on, offDays: r.off ?? 0, anchor: r.anchor, label: `${r.on}/${r.off ?? 0}` } : null }));

  const leaveRows = await d.select().from(leaveRequests).where(and(
    eq(leaveRequests.userId, userId), lte(leaveRequests.fromDate, post.startsAt), gte(leaveRequests.toDate, post.startsAt),
  )).limit(50);
  const leave: LeaveRequest[] = leaveRows.map(l => ({
    requestRef: l.requestRef, userId: l.userId, category: l.category, urgency: l.urgency,
    from: l.fromDate, to: l.toDate,
    partialDay: l.partialFromTime && l.partialToTime ? { fromTime: l.partialFromTime, toTime: l.partialToTime } : null,
    privateNote: null, requestedAt: l.requestedAt, status: l.status,
    decidedByUserId: l.decidedByUserId, decidedAt: l.decidedAt, decisionNote: l.decisionNote,
  } as LeaveRequest));

  // The person's own operator record (operators.userId, owned by this organization). Two is a refusal, not a choice.
  const op = await operatorForUserInScope(userId, scope);
  let licence: PersonFacts["licence"] = { kind: op.kind === "ambiguous" ? "ambiguous" : "none" };
  let commitments: PersonFacts["commitments"] = [];
  if (op.kind === "resolved") {
    const row = (await d.select({ licenseExpiresAt: operators.licenseExpiresAt }).from(operators).where(eq(operators.id, op.operatorId)).limit(1))[0];
    licence = { kind: "recorded", expiresAt: row?.licenseExpiresAt ?? null };
    // The one booking-conflict rule (_core/bookingConflict.ts), the same one the award re-checks.
    const booked = await d.select().from(resourceBookings)
      .where(conflictingBookingsWhere({ type: "operator", ref: String(op.operatorId) }, post)).limit(20);
    commitments = booked.map(b => ({ assignmentRef: `booking ${b.id}${b.postingId != null ? ` (posting ${b.postingId})` : ""}`, startsAt: b.startsAt, endsAt: b.endsAt }));
  }

  const qualifications = post.requiredQualifications.length
    ? (await effectiveQualifications(d, { tenantId, userId, at: post.startsAt, codes: post.requiredQualifications }))
      .map(q => ({ code: q.code, held: q.held, notHeld: q.notHeld, reason: q.reason }))
    : [];

  return { userId, name: `user ${userId}`, inOrganization: true, roles, rosters, leave, commitments, licence, qualifications };
}

export const openShiftsRouter = router({
  /** Post a shift. */
  post: roleProcedure("shifts.post")
    .input(z.object({
      title: z.string().min(2).max(220),
      kind: z.enum(["open", "assigned"]).default("open"),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      location: z.string().max(220).optional(),
      requiredRole: z.string().min(2).max(60),
      requiredQualifications: z.array(z.string().max(60)).max(20).default([]),
      seats: z.number().int().min(1).max(50).default(1),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.endsAt.getTime() <= input.startsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The shift ends before it begins" });
      const acting = await resolveActingScope(d, ctx.user.id);
      const postRef = ref("OS");
      await d.insert(shiftPosts).values({
        postRef, tenantId: acting.tenantId, title: input.title, kind: input.kind,
        startsAt: input.startsAt, endsAt: input.endsAt, location: input.location ?? null,
        requiredRole: input.requiredRole,
        requiredQualificationsJson: JSON.stringify(input.requiredQualifications),
        seats: input.seats, status: "open",
        postedByUserId: ctx.user.id, postedAt: input.at,
      });
      return {
        postRef, seats: input.seats,
        note: input.requiredQualifications.length
          ? `Posted. Eligibility will check ${input.requiredQualifications.join(", ")} against verified holdings; an unverified or missing one blocks exactly as an expired one does.`
          : "Posted.",
      };
    }),

  /** Open posts in this organization. */
  list: roleProcedure("shifts.list")
    .input(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const where = [eq(shiftPosts.tenantId, acting.tenantId), eq(shiftPosts.status, "open")];
      if (input.from) where.push(gte(shiftPosts.startsAt, input.from));
      if (input.to) where.push(lte(shiftPosts.startsAt, input.to));
      const rows = await d.select().from(shiftPosts).where(and(...where)).orderBy(desc(shiftPosts.startsAt)).limit(200);
      return {
        posts: rows.map(r => ({
          postRef: r.postRef, title: r.title, kind: r.kind, startsAt: r.startsAt, endsAt: r.endsAt,
          location: r.location, requiredRole: r.requiredRole,
          requiredQualifications: JSON.parse(r.requiredQualificationsJson) as string[],
          seats: r.seats,
        })),
      };
    }),

  /**
   * Whether one person could take one post, from what is actually on record.
   *
   * Every reason is collected. A qualification that cannot be checked is named
   * as unknown rather than omitted, so the caller can see the difference
   * between "they are fine" and "we could not tell".
   */
  eligibility: roleProcedure("shifts.eligibility")
    .input(z.object({ postRef: z.string().min(1).max(64), userId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const userId = input.userId ?? ctx.user.id;
      const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, input.postRef)).limit(1))[0];
      if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });

      const verdict = shiftEligibility(asPost(post), await personFacts(d, acting.tenantId, asPost(post), userId));
      const reasons = verdict.reasons;

      return {
        postRef: post.postRef, userId,
        eligible: reasons.length === 0,
        reasons,
        note: reasons.length === 0
          ? "Eligible from what is on record. The readiness check still runs at assignment."
          : "Not eligible from what is on record. An unknown check blocks exactly as a failed one does.",
      };
    }),

  /**
   * Say you would take it.
   *
   * Refused unless eligible, and it assigns nothing. Idempotent, because
   * tapping twice is not two claims.
   */
  expressInterest: roleProcedure("shifts.expressInterest")
    .input(z.object({ postRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, input.postRef)).limit(1))[0];
      if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });
      // The one rule, enforced: the caller's own records, never anything they sent. Fails closed.
      const candidate = shiftEligibility(asPost(post), await personFacts(d, acting.tenantId, asPost(post), ctx.user.id));
      try {
        expressInterest({ post: asPost(post), candidate, at: input.at });
      } catch (e) {
        if (e instanceof NotEligible) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        throw e;
      }

      const existing = (await d.select().from(shiftInterests).where(and(
        eq(shiftInterests.postRef, input.postRef), eq(shiftInterests.userId, ctx.user.id), isNull(shiftInterests.withdrawnAt),
      )).limit(1))[0];
      if (existing) {
        return { postRef: post.postRef, recorded: false, assigns: false as const, note: "Already recorded; tapping twice is not two claims." };
      }
      await d.insert(shiftInterests).values({ postRef: input.postRef, userId: ctx.user.id, expressedAt: input.at });
      return {
        postRef: post.postRef, recorded: true, assigns: false as const,
        note: "Interest recorded. Dispatch assigns the shift and the readiness check runs then — eligibility today says nothing about a certificate expiring tomorrow night.",
      };
    }),

  /** Who has said they would take it. Context for dispatch, not a queue. */
  interests: roleProcedure("shifts.interests")
    .input(z.object({ postRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, input.postRef)).limit(1))[0];
      if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });
      const rows = await d.select().from(shiftInterests).where(and(eq(shiftInterests.postRef, input.postRef), isNull(shiftInterests.withdrawnAt)));
      return {
        postRef: post.postRef,
        interested: rows.map(r => ({ userId: r.userId, expressedAt: r.expressedAt })),
        note: "Interest is context. Somebody who never expressed it can be assigned, and somebody who did has no claim.",
      };
    }),
});
