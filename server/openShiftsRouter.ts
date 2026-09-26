/**
 * v22.20 (0091) — open shifts, reachable.
 *
 * `_core/openShifts.ts` decides eligibility; this reads the records it needs
 * and exposes the result. Two things it does that the engine cannot.
 *
 * **Approved leave is read, not supplied.** `leaveRequests` exists now, so
 * whether somebody is away that day comes from the record rather than from a
 * caller's account of it.
 *
 * **Qualifications are reported unknown, because there is nowhere to read them
 * from.** This schema has no qualification store: `operators` carries a licence
 * class and expiry inline and nothing else. So a post requiring a ticket cannot
 * be satisfied from stored data, and the honest answer is `unknown` — which
 * blocks, exactly as an expired one would. Returning "eligible" because the
 * check could not run is the failure this whole system is built against, and it
 * would be very easy to write here.
 */
import { readExpiry } from "./_core/documentValidity";
import { effectiveQualifications } from "./qualificationReads";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { leaveRequests, operators, shiftInterests, shiftPosts } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { isAbsent, type LeaveRequest } from "./_core/timeOff";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

export type EligibilityReason = { code: "on_approved_leave" | "qualification_unknown" | "qualification_unverified" | "qualification_expired" | "licence_expired" | "no_licence_recorded"; detail: string };

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

      const reasons: EligibilityReason[] = [];

      /* Approved leave, read from the record. */
      const leave = await d.select().from(leaveRequests).where(and(
        eq(leaveRequests.userId, userId),
        lte(leaveRequests.fromDate, post.startsAt),
        gte(leaveRequests.toDate, post.startsAt),
      )).limit(50);
      const away = leave.some(l => isAbsent({
        requestRef: l.requestRef, userId: l.userId, category: l.category, urgency: l.urgency,
        from: l.fromDate, to: l.toDate,
        partialDay: l.partialFromTime && l.partialToTime ? { fromTime: l.partialFromTime, toTime: l.partialToTime } : null,
        privateNote: null, requestedAt: l.requestedAt, status: l.status,
        decidedByUserId: l.decidedByUserId, decidedAt: l.decidedAt, decisionNote: l.decisionNote,
      } as LeaveRequest) && !l.partialFromTime);
      if (away) reasons.push({ code: "on_approved_leave", detail: "Away that day on leave already recorded" });

      /* Licence, the one credential this schema actually stores. */
      const operator = (await d.select().from(operators).where(eq(operators.id, userId)).limit(1))[0];
      if (!operator?.licenseExpiresAt) {
        reasons.push({ code: "no_licence_recorded", detail: "No licence expiry on record — this cannot be established as current" });
      } else if (readExpiry(operator.licenseExpiresAt, post.startsAt, 0).expiry === "expired") {
        reasons.push({ code: "licence_expired", detail: `Licence expires ${operator.licenseExpiresAt.toISOString().slice(0, 10)}, before this shift` });
      }

      /* Everything else the post asks for, now read from the qualification store. */
      const required = JSON.parse(post.requiredQualificationsJson) as string[];
      if (required.length) {
        // C1b-3: the qualification read adapter (Academy first; legacy only as a marked fallback; the
        // caller's organization). Matching logic below is unchanged.
        const effective = await effectiveQualifications(d, { tenantId: acting.tenantId, userId, at: post.startsAt, codes: required });
        for (const gap of effective.filter(e => !e.held).map(e => ({ code: e.code, reason: e.reason, why: e.notHeld! }))) {
          reasons.push({
            // From the structured verdict, not by reading its prose — the
            // previous version matched on wording and silently reclassified
            // every unverified ticket the moment that wording improved.
            code: gap.why === "expired" ? "qualification_expired"
              : gap.why === "unverified" ? "qualification_unverified"
              : "qualification_unknown",
            detail: gap.reason,
          });
        }
      }

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
      if (post.kind !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That is an assigned post; interest is not how it is filled" });
      if (post.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${post.status}` });

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
