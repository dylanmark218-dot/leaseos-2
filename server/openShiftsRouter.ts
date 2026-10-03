/**
 * v22.20 (0091) — open shifts, reachable. 0206 — Open Work: the post linked to its slot.
 *
 * `_core/openShifts.ts` decides: who could take a post, what interest is and is not, where a post
 * and an offer may go from where they are. `openShiftsService.ts` reads what those rules need.
 * This router stores and serves, and decides nothing twice — the eligibility read that used to live
 * here inline, beside the engine that answered the same question, is gone (SPINE plan, ordering §2).
 *
 * Four rules this router keeps:
 *
 * **Interest is not assignment.** A response records that a person would take the work. It
 * reserves nothing. An offer is a dispatcher's act and an acceptance is the person's statement;
 * neither binds a slot. The award (Checkpoint 3) is the only thing that does, through the canonical
 * binding, behind a readiness check.
 *
 * **A post is not a job.** It may exist before a job does. Until it is linked to a dispatch slot it
 * collects responses and offers and cannot be filled.
 *
 * **One rule decides who may take work** (SPINE item 2, owner's ruling). `_core/openShifts.ts`
 * `shiftEligibility`, over the records `openShiftsService.personFacts` reads, is the one answer to
 * "may this person take this shift?". This router enforces it and judges nothing itself:
 * `shifts.eligibility` and `shifts.expressInterest` ask it directly, and `respond`, `offer` and the
 * candidate pool ask it through the service. Unknown refuses exactly as a failed check does; the
 * preview only says which of the two it was. `spineItem2Duplicates.test.ts` keeps it that way.
 *
 * **Availability is a declaration.** It is read by the candidate pool and by nothing that decides
 * whether a truck leaves the yard.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, jobInScope, listActiveUserRoleNames, userInScope } from "./db";
import { dispatchPostings, dispatchRoles, shiftInterests, shiftOffers, shiftPostEvents, shiftPosts, workerAvailability } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID, type ActingScope } from "./_core/actingScope";
import type { DbOrTx, Tx } from "./_core/dbTypes";
import {
  canTransitionOffer, canTransitionPost, effectiveOfferStatus, expressInterest, intendToAssign, isLiveOffer, isTerminalPost, NotEligible, RESPONSE_KINDS, responseVolunteers, shiftEligibility, summarize,
  type AvailabilityPreferences, type Candidate, type OfferStatus, type PostStatus,
} from "./_core/openShifts";
import {
  crewsOf, declarationsFor, declarersCovering, eligibilityOf, liveOffersFor, personFacts, postEvent, previewFor, ref, statusNow, toShiftPost, type Preview, type ShiftPostRow,
} from "./openShiftsService";
import { enqueueBoardEvent } from "./_core/boardOutbox";
import { awardPost } from "./shiftAwardService";
import { requireCallerUnits } from "./unitScope";

async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const RESPONSE = z.enum(["interested", "available", "request_assignment", "declined"]);
const PREFERENCES = z.object({
  regions: z.array(z.string().min(1).max(60)).max(20).default([]),
  equipmentClasses: z.array(z.string().min(1).max(60)).max(20).default([]),
  jobTypes: z.array(z.string().min(1).max(60)).max(20).default([]),
  maxDistanceKm: z.number().int().min(1).max(5000).nullable().default(null),
  overnight: z.boolean().nullable().default(null),
  nights: z.boolean().nullable().default(null),
  weekends: z.boolean().nullable().default(null),
  overtime: z.boolean().nullable().default(null),
});

const actorRoleOf = (roles: readonly string[]) => roles[0] ?? "user";

/** A post the acting organization may see, or "no such post". Another organization's does not exist. */
async function postInScope(d: DbOrTx, postRef: string, acting: ActingScope): Promise<ShiftPostRow> {
  const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, postRef)).limit(1))[0];
  if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });
  return post;
}

/** The same, read under lock inside a transaction: every mutation of a post re-reads it this way. */
async function lockPost(tx: Tx, postRef: string, acting: ActingScope): Promise<ShiftPostRow> {
  const post = (await tx.select().from(shiftPosts).where(eq(shiftPosts.postRef, postRef)).for("update").limit(1))[0];
  if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });
  return post;
}

/** Move a post, or refuse with the transition named. Expiry that has happened is persisted first. */
async function movePost(tx: Tx, post: ShiftPostRow, to: PostStatus, set: Partial<typeof shiftPosts.$inferInsert>, now: Date): Promise<PostStatus> {
  const from = statusNow(post, now);
  if (from !== post.status) await tx.update(shiftPosts).set({ status: from }).where(eq(shiftPosts.id, post.id));
  if (!canTransitionPost(from, to)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${from}; it does not go to ${to} from there` });
  await tx.update(shiftPosts).set({ status: to, ...set }).where(eq(shiftPosts.id, post.id));
  return from;
}

const postView = (r: ShiftPostRow, now: Date) => ({
  postRef: r.postRef, title: r.title, kind: r.kind, status: statusNow(r, now), startsAt: r.startsAt, endsAt: r.endsAt,
  location: r.location, regionCode: r.regionCode, requiredRole: r.requiredRole,
  requiredQualifications: JSON.parse(r.requiredQualificationsJson) as string[],
  requiredEquipmentClass: r.requiredEquipmentClass, seats: r.seats, overtime: r.overtime, estimatedHours: r.estimatedHours, priority: r.priority,
  unitId: r.unitId, dispatchPostingId: r.dispatchPostingId, dispatchRoleId: r.dispatchRoleId, linked: r.dispatchRoleId != null,
  publishedAt: r.publishedAt, closesAt: r.closesAt, closedAt: r.closedAt, filledAt: r.filledAt, cancelledAt: r.cancelledAt,
});

export const openShiftsRouter = router({
  /**
   * Post work. Published at once unless `publish: false`, which leaves a draft only its poster's
   * organization sees on the dispatcher's side. A post may name the slot it fills; it need not.
   */
  post: roleProcedure("shifts.post")
    .input(z.object({
      title: z.string().min(2).max(220),
      kind: z.enum(["open", "assigned"]).default("open"),
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      location: z.string().max(220).optional(),
      regionCode: z.string().max(60).optional(),
      requiredRole: z.string().min(2).max(60),
      requiredQualifications: z.array(z.string().max(60)).max(20).default([]),
      requiredEquipmentClass: z.string().max(60).optional(),
      seats: z.number().int().min(1).max(50).default(1),
      overtime: z.boolean().default(false),
      estimatedHours: z.number().int().min(1).max(240).optional(),
      priority: z.enum(["normal", "callout", "hotshot", "emergency"]).default("normal"),
      closesAt: z.coerce.date().optional(),
      unitId: z.number().int().positive().optional(),
      publish: z.boolean().default(true),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      // CP1.5: another organization's unit is not found, before anything is read or written.
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });
      const d = await db();
      if (input.endsAt.getTime() <= input.startsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The shift ends before it begins" });
      if (input.closesAt && input.closesAt.getTime() > input.startsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "A post closes before the work starts, not after" });
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const postRef = ref("OS");
      const now = new Date();
      const status: PostStatus = input.publish ? "open" : "draft";
      await d.transaction(async tx => {
        await tx.insert(shiftPosts).values({
          postRef, tenantId: acting.tenantId, title: input.title, kind: input.kind,
          startsAt: input.startsAt, endsAt: input.endsAt, location: input.location ?? null, regionCode: input.regionCode ?? null,
          requiredRole: input.requiredRole, requiredQualificationsJson: JSON.stringify(input.requiredQualifications),
          requiredEquipmentClass: input.requiredEquipmentClass ?? null,
          seats: input.seats, overtime: input.overtime, estimatedHours: input.estimatedHours ?? null, priority: input.priority,
          closesAt: input.closesAt ?? null, unitId: input.unitId ?? null,
          status, publishedAt: input.publish ? input.at : null,
          postedByUserId: ctx.user.id, postedAt: input.at,
        });
        await postEvent(tx, { postRef, eventType: "created", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), at: now });
        if (input.publish) {
          await postEvent(tx, { postRef, eventType: "published", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), at: now });
          const pool = input.kind === "open" ? await declarersCovering(tx, acting, input.startsAt) : [];
          await enqueueBoardEvent(tx, {
            eventType: "work.posted", aggregateType: "shiftPost", aggregateId: postRef, transition: "published",
            tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now,
            payload: { recipientUserIds: pool, title: `Open work: ${input.title}`, line: `${input.requiredRole} · ${input.startsAt.toISOString().slice(0, 16).replace("T", " ")}${input.overtime ? " · overtime" : ""}`, deepLink: `/work/${postRef}`, refs: { postRef, overtime: input.overtime ? 1 : 0 } },
          });
        }
      });
      return {
        postRef, seats: input.seats, status,
        note: input.requiredQualifications.length
          ? `Posted. Eligibility will check ${input.requiredQualifications.join(", ")} against verified holdings; an unverified or missing one blocks exactly as an expired one does.`
          : "Posted.",
      };
    }),

  /** Publish a draft. */
  publish: roleProcedure("shifts.publish")
    .input(z.object({ postRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      await d.transaction(async tx => {
        const post = await lockPost(tx, input.postRef, acting);
        const from = await movePost(tx, post, "open", { publishedAt: now }, now);
        await postEvent(tx, { postRef: post.postRef, eventType: from === "closed" ? "reopened" : "published", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), at: now });
        await enqueueBoardEvent(tx, {
          eventType: "work.posted", aggregateType: "shiftPost", aggregateId: post.postRef, transition: `published:${now.getTime()}`,
          tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now,
          payload: { recipientUserIds: await declarersCovering(tx, acting, post.startsAt), title: `Open work: ${post.title}`, line: `${post.requiredRole} · ${post.startsAt.toISOString().slice(0, 16).replace("T", " ")}`, deepLink: `/work/${post.postRef}`, refs: { postRef: post.postRef } },
        });
      });
      return { postRef: input.postRef, status: "open" as const };
    }),

  /** Close to new responses. Offers already out stay live; reopening is allowed. */
  close: roleProcedure("shifts.close")
    .input(z.object({ postRef: z.string().min(1).max(64), reason: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      await d.transaction(async tx => {
        const post = await lockPost(tx, input.postRef, acting);
        await movePost(tx, post, "closed", { closedAt: now }, now);
        await postEvent(tx, { postRef: post.postRef, eventType: "closed", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), detail: input.reason ?? null, at: now });
      });
      return { postRef: input.postRef, status: "closed" as const, note: "Closed to new responses. Offers already issued stay live until answered or withdrawn." };
    }),

  /** Cancel. Terminal. Every live offer is withdrawn with it, and everyone who responded is told. */
  cancel: roleProcedure("shifts.cancel")
    .input(z.object({ postRef: z.string().min(1).max(64), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      await d.transaction(async tx => {
        const post = await lockPost(tx, input.postRef, acting);
        await movePost(tx, post, "cancelled", { cancelledAt: now, cancelledByUserId: ctx.user.id, cancelReason: input.reason }, now);
        await postEvent(tx, { postRef: post.postRef, eventType: "cancelled", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), detail: input.reason, at: now });
        const offers = await tx.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, post.postRef), inArray(shiftOffers.status, ["offered", "accepted"]))).for("update").limit(200);
        for (const o of offers) {
          await tx.update(shiftOffers).set({ status: "withdrawn", respondedAt: now }).where(eq(shiftOffers.id, o.id));
          await postEvent(tx, { postRef: post.postRef, eventType: "offer_withdrawn", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: o.userId, detail: "post cancelled", at: now });
        }
        const responders = await tx.select({ userId: shiftInterests.userId }).from(shiftInterests).where(and(eq(shiftInterests.postRef, post.postRef), isNull(shiftInterests.withdrawnAt))).limit(500);
        const recipients = Array.from(new Set([...responders.map(r => r.userId), ...offers.map(o => o.userId)]));
        await enqueueBoardEvent(tx, {
          eventType: "work.cancelled", aggregateType: "shiftPost", aggregateId: post.postRef, transition: "cancelled",
          tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now,
          payload: { recipientUserIds: recipients, title: `Cancelled: ${post.title}`, line: input.reason, deepLink: `/work/${post.postRef}`, refs: { postRef: post.postRef } },
        });
      });
      return { postRef: input.postRef, status: "cancelled" as const };
    }),

  /**
   * Name the slot this post fills. An assignment act (`dispatch.assign`): the role's posting must
   * belong to a job in scope, and the post must want exactly one person — a posting with four
   * trucks is four posts, one per slot, which is how the slot model already says a rig move works.
   */
  link: roleProcedure("shifts.link")
    .input(z.object({ postRef: z.string().min(1).max(64), roleId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      const role = (await d.select().from(dispatchRoles).where(eq(dispatchRoles.id, input.roleId)).limit(1))[0];
      const posting = role ? (await d.select().from(dispatchPostings).where(eq(dispatchPostings.id, role.postingId)).limit(1))[0] : undefined;
      if (!role || !posting || !(await jobInScope(posting.jobId, { tenantId: acting.tenantId }))) throw new TRPCError({ code: "NOT_FOUND", message: `Role ${input.roleId} not found` });
      if (role.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Role ${input.roleId} is cancelled` });
      await d.transaction(async tx => {
        const post = await lockPost(tx, input.postRef, acting);
        const status = statusNow(post, now);
        if (isTerminalPost(status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${status}` });
        if (post.seats !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A linked post fills one slot and so wants one person; post one per slot" });
        if (post.dispatchRoleId != null && post.dispatchRoleId !== input.roleId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is already linked to role ${post.dispatchRoleId}` });
        await tx.update(shiftPosts).set({ dispatchPostingId: posting.id, dispatchRoleId: role.id, requiredEquipmentClass: post.requiredEquipmentClass ?? role.requiredEquipmentClass ?? null }).where(eq(shiftPosts.id, post.id));
        await postEvent(tx, { postRef: post.postRef, eventType: "linked", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), detail: `posting ${posting.postingNumber} role ${role.id} (${role.roleCode})`, at: now });
      });
      return { postRef: input.postRef, dispatchPostingId: posting.id, dispatchRoleId: role.id, roleCode: role.roleCode, note: "Linked. The post can now be filled — by the award, through the slot's own binding, behind a readiness check." };
    }),

  /** Open posts in this organization. Expiry is derived on read. */
  list: roleProcedure("shifts.list")
    .input(z.object({
      from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      overtime: z.boolean().optional(),
      /** Dispatchers see drafts and closed posts too; a driver's board is open work. */
      includeInactive: z.boolean().default(false),
    }).default({ includeInactive: false }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const now = new Date();
      const where = [eq(shiftPosts.tenantId, acting.tenantId)];
      if (!input.includeInactive) where.push(eq(shiftPosts.status, "open"));
      if (input.from) where.push(gte(shiftPosts.startsAt, input.from));
      if (input.to) where.push(lte(shiftPosts.startsAt, input.to));
      if (input.overtime !== undefined) where.push(eq(shiftPosts.overtime, input.overtime));
      const rows = (await d.select().from(shiftPosts).where(and(...where)).orderBy(desc(shiftPosts.startsAt)).limit(200))
        .filter(r => input.includeInactive || statusNow(r, now) === "open");
      const mine = rows.length
        ? await d.select({ postRef: shiftInterests.postRef, response: shiftInterests.response }).from(shiftInterests).where(and(eq(shiftInterests.userId, ctx.user.id), isNull(shiftInterests.withdrawnAt), inArray(shiftInterests.postRef, rows.map(r => r.postRef))))
        : [];
      return {
        posts: rows.map(r => ({ ...postView(r, now), myResponse: mine.find(m => m.postRef === r.postRef)?.response ?? null })),
        note: "A post's card says what it requires; the preview says what is on record. Neither is an assignment.",
      };
    }),

  /** One post: the card, the caller's own preview, and — for the poster's side — its responses and offers. */
  get: roleProcedure("shifts.get")
    .input(z.object({ postRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const now = new Date();
      const post = await postInScope(d, input.postRef, acting);
      const preview = post.kind === "open" ? await previewFor(d, { post, userId: ctx.user.id, scope: acting, now }) : null;
      const events = await d.select().from(shiftPostEvents).where(eq(shiftPostEvents.postRef, post.postRef)).orderBy(asc(shiftPostEvents.occurredAt), asc(shiftPostEvents.id)).limit(200);
      const myOffer = (await d.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, post.postRef), eq(shiftOffers.userId, ctx.user.id))).orderBy(desc(shiftOffers.id)).limit(1))[0];
      return {
        post: postView(post, now),
        me: preview ? {
          eligible: preview.eligible, verdict: preview.verdict, reasons: preview.reasons,
          availability: preview.availability, availabilityNotes: preview.availabilityNotes, interestExpressed: preview.interestExpressed,
          readinessNotEvaluated: preview.readiness?.notEvaluated ?? [], readinessBlockers: preview.readiness?.operatorBlockers ?? [],
        } : null,
        myOffer: myOffer ? { offerRef: myOffer.offerRef, status: effectiveOfferStatus({ status: myOffer.status, expiresAt: myOffer.expiresAt }, now), expiresAt: myOffer.expiresAt } : null,
        history: events.map(e => ({ eventType: e.eventType, actorUserId: e.actorUserId, subjectUserId: e.subjectUserId, detail: e.detail, occurredAt: e.occurredAt })),
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
      const post = await postInScope(d, input.postRef, acting);
      // The one rule (SPINE item 2): the person's own records, never anything the caller sent.
      const shape = toShiftPost(post);
      const verdict = shiftEligibility(shape, await personFacts(d, acting.tenantId, shape, userId));
      // Beside it, not in it: what they declared and what readiness would say.
      const preview = await previewFor(d, { post, userId, scope: acting, now: new Date() });
      return {
        postRef: post.postRef, userId,
        eligible: verdict.eligible,
        reasons: verdict.reasons,
        verdict: preview.verdict,
        availability: preview.availability,
        availabilityNotes: preview.availabilityNotes,
        readiness: preview.readiness,
        note: verdict.eligible
          ? "Eligible from what is on record. The readiness check still runs at assignment."
          : "Not eligible from what is on record. An unknown check blocks exactly as a failed one does.",
      };
    }),

  /**
   * The candidate pool: everyone who responded plus everyone whose declared availability covers the
   * start, each with a preview and its codes. Deterministic order — verdict, then declared state,
   * then who responded first. No score, no automatic choice: the dispatcher decides.
   */
  candidates: roleProcedure("shifts.candidates")
    .input(z.object({ postRef: z.string().min(1).max(64), limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const now = new Date();
      const post = await postInScope(d, input.postRef, acting);
      const responses = await d.select().from(shiftInterests).where(and(eq(shiftInterests.postRef, post.postRef), isNull(shiftInterests.withdrawnAt))).orderBy(asc(shiftInterests.expressedAt)).limit(500);
      const declarers = await declarersCovering(d, acting, post.startsAt);
      const offers = await liveOffersFor(d, post.postRef, now);
      // Everyone who answered, everyone who declared, and everyone dispatch already asked.
      const pool = Array.from(new Set([...responses.map(r => r.userId), ...offers.map(o => o.userId), ...declarers])).slice(0, input.limit);
      const rows: (Preview & { response: string | null; respondedAt: Date | null; offer: OfferStatus | null; crews: string[] })[] = [];
      for (const userId of pool) {
        const preview = await previewFor(d, { post, userId, scope: acting, now });
        const response = responses.find(r => r.userId === userId);
        rows.push({ ...preview, response: response?.response ?? null, respondedAt: response?.expressedAt ?? null, offer: offers.find(o => o.userId === userId)?.effectiveStatus ?? null, crews: await crewsOf(d, userId, acting) });
      }
      const rank = { eligible: 0, unknown: 1, ineligible: 2 } as const;
      const avail = { available_for_overtime: 0, available: 0, on_call: 1, undeclared: 2, unavailable: 3 } as const;
      rows.sort((a, b) => rank[a.verdict] - rank[b.verdict] || avail[a.availability] - avail[b.availability]
        || (a.respondedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.respondedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.userId - b.userId);
      const candidates: Candidate[] = rows.map(r => ({ userId: r.userId, name: `user ${r.userId}`, eligible: r.eligible, reasons: r.reasons.map(x => ({ code: x.code as never, detail: x.detail })) }));
      const summary = summarize(toShiftPost(post), candidates);
      return {
        postRef: post.postRef, seats: post.seats, status: statusNow(post, now),
        candidates: rows.map(r => ({ userId: r.userId, eligible: r.eligible, verdict: r.verdict, reasons: r.reasons, availability: r.availability, availabilityNotes: r.availabilityNotes, response: r.response, respondedAt: r.respondedAt, offer: r.offer, crews: r.crews, readinessNotEvaluated: r.readiness?.notEvaluated ?? [] })),
        barriers: summary.barriers, line: summary.line,
        note: "Ordered by verdict, then declared availability, then who answered first. Nothing here assigns; a dispatcher offers, a person accepts, and the award still runs the readiness check.",
      };
    }),

  /**
   * Say you would take it — or that you would not.
   *
   * One standing response per person per post, replaced in place. Saying you would take it is refused
   * unless the one rule says you may (SPINE item 2) — an unknown refuses exactly as a failed check
   * does. Declining is never refused. A declared availability is not a refusal: it is what you said,
   * and this is what you are saying now. Assigns nothing.
   * Idempotent: the same device mutation twice is one response, and tapping twice is not two claims.
   */
  respond: roleProcedure("shifts.respond")
    .input(z.object({
      postRef: z.string().min(1).max(64), response: RESPONSE.default("interested"), note: z.string().max(400).optional(),
      at: z.coerce.date().default(() => new Date()), deviceCreatedAt: z.coerce.date().optional(), deviceId: z.string().max(64).optional(), clientMutationId: z.string().min(1).max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => respond(ctx.user.id, input)),

  /**
   * The v22.20 door, kept for one release (D-6): interest, and nothing else. The one rule, enforced
   * here as main's ruling has it — the caller's own records, fails closed, writes nothing on refusal.
   */
  expressInterest: roleProcedure("shifts.expressInterest")
    .input(z.object({ postRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const post = toShiftPost(await postInScope(d, input.postRef, acting));
      const candidate = shiftEligibility(post, await personFacts(d, acting.tenantId, post, ctx.user.id));
      try {
        expressInterest({ post, candidate, at: input.at });
      } catch (e) {
        if (e instanceof NotEligible) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        throw e;
      }
      return respond(ctx.user.id, { postRef: input.postRef, response: "interested", at: input.at }, candidate);
    }),

  /** Who has said they would take it. Context for dispatch, not a queue. */
  interests: roleProcedure("shifts.interests")
    .input(z.object({ postRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const post = await postInScope(d, input.postRef, acting);
      const rows = await d.select().from(shiftInterests).where(and(eq(shiftInterests.postRef, input.postRef), isNull(shiftInterests.withdrawnAt))).orderBy(asc(shiftInterests.expressedAt));
      return {
        postRef: post.postRef,
        interested: rows.filter(r => responseVolunteers(r.response)).map(r => ({ userId: r.userId, response: r.response, expressedAt: r.expressedAt })),
        declined: rows.filter(r => !responseVolunteers(r.response)).map(r => ({ userId: r.userId, expressedAt: r.expressedAt })),
        note: "Interest is context. Somebody who never expressed it can be assigned, and somebody who did has no claim.",
      };
    }),

  /**
   * Offer the work to one person. Dispatch's decision, pending the readiness check — the engine's
   * `intendToAssign` says so structurally. Refused unless the one rule says the person may take it
   * (SPINE item 2); an unknown refuses as a failed check does. One live offer per person per post.
   */
  offer: roleProcedure("shifts.offer")
    .input(z.object({ postRef: z.string().min(1).max(64), userId: z.number().int().positive(), expiresAt: z.coerce.date().optional(), note: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      if (!(await userInScope(input.userId, { tenantId: acting.tenantId }))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const postRow = await postInScope(d, input.postRef, acting);
      const candidate = await eligibilityOf(d, { post: postRow, userId: input.userId, scope: acting });
      const responses = await d.select().from(shiftInterests).where(and(eq(shiftInterests.postRef, postRow.postRef), eq(shiftInterests.userId, input.userId), isNull(shiftInterests.withdrawnAt))).limit(1);
      let intent;
      try {
        intent = intendToAssign({ post: toShiftPost(postRow), candidate, interests: responses.filter(r => responseVolunteers(r.response)).map(r => ({ postRef: r.postRef, userId: r.userId, expressedAt: r.expressedAt, assigns: false as const, note: "" })) });
      } catch (e) {
        if (e instanceof NotEligible) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        throw e;
      }
      const offerRef = ref("OFF");
      await d.transaction(async tx => {
        const post = await lockPost(tx, input.postRef, acting);
        const status = statusNow(post, now);
        if (post.kind !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That is an assigned post; it is not offered" });
        if (status !== "open" && status !== "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${status}` });
        const live = (await tx.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, post.postRef), eq(shiftOffers.userId, input.userId), inArray(shiftOffers.status, ["offered", "accepted"]))).for("update").limit(1))[0];
        if (live && effectiveOfferStatus({ status: live.status, expiresAt: live.expiresAt }, now) !== "expired") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${input.userId} already holds a live offer on this post (${live.offerRef}, ${live.status})` });
        }
        if (live) await tx.update(shiftOffers).set({ status: "expired" }).where(eq(shiftOffers.id, live.id));
        await tx.insert(shiftOffers).values({
          offerRef, postRef: post.postRef, userId: input.userId, offeredByUserId: ctx.user.id, offeredAt: now,
          expiresAt: input.expiresAt ?? post.closesAt ?? post.startsAt, status: "offered", responseNote: null,
        });
        await postEvent(tx, { postRef: post.postRef, eventType: "offer_issued", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: input.userId, detail: `${offerRef}${intent.interestExpressed ? " (interest expressed)" : " (no interest expressed)"}`, at: now });
        await enqueueBoardEvent(tx, {
          eventType: "work.offered", aggregateType: "shiftPost", aggregateId: post.postRef, transition: `offered:${offerRef}`,
          tenantId: acting.tenantId, actorUserId: ctx.user.id, occurredAt: now,
          payload: { recipientUserIds: [input.userId], title: `Work offered: ${post.title}`, line: `${post.requiredRole} · ${post.startsAt.toISOString().slice(0, 16).replace("T", " ")}. Accept or decline.`, deepLink: `/work/${post.postRef}`, refs: { postRef: post.postRef, offerRef } },
        });
      });
      return {
        offerRef, postRef: input.postRef, userId: input.userId, requiresReadinessCheck: true as const, interestExpressed: intent.interestExpressed,
        eligible: candidate.eligible,
        note: "Offered. An acceptance is the person's statement; the award binds the slot, and the readiness check runs then.",
      };
    }),

  /** Take an offer back. */
  offerWithdraw: roleProcedure("shifts.offerWithdraw")
    .input(z.object({ offerRef: z.string().min(1).max(64), reason: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      await d.transaction(async tx => {
        const offer = (await tx.select().from(shiftOffers).where(eq(shiftOffers.offerRef, input.offerRef)).for("update").limit(1))[0];
        if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "No such offer" });
        const post = await lockPost(tx, offer.postRef, acting);
        const status = effectiveOfferStatus({ status: offer.status, expiresAt: offer.expiresAt }, now);
        if (!canTransitionOffer(status, "withdrawn")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That offer is ${status}` });
        await tx.update(shiftOffers).set({ status: "withdrawn", respondedAt: now }).where(eq(shiftOffers.id, offer.id));
        await postEvent(tx, { postRef: post.postRef, eventType: "offer_withdrawn", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: offer.userId, detail: input.reason ?? null, at: now });
      });
      return { offerRef: input.offerRef, status: "withdrawn" as const };
    }),

  /**
   * Answer an offer made to you. `accepted` is your statement; it binds nothing. Idempotent by
   * device mutation, and by state: the same answer twice is one answer.
   */
  offerRespond: roleProcedure("shifts.offerRespond")
    .input(z.object({
      offerRef: z.string().min(1).max(64), decision: z.enum(["accepted", "declined"]), note: z.string().max(400).optional(),
      deviceRespondedAt: z.coerce.date().optional(), deviceId: z.string().max(64).optional(), clientMutationId: z.string().min(1).max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const now = new Date();
      return d.transaction(async tx => {
        const offer = (await tx.select().from(shiftOffers).where(eq(shiftOffers.offerRef, input.offerRef)).for("update").limit(1))[0];
        // An offer is the offered person's to answer; anybody else's reference is not found.
        if (!offer || offer.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "No such offer" });
        const post = await lockPost(tx, offer.postRef, acting);
        if (input.deviceId && input.clientMutationId && offer.responseDeviceId === input.deviceId && offer.responseClientMutationId === input.clientMutationId) {
          return { offerRef: offer.offerRef, status: offer.status, replayed: true as const, note: "Already answered; a retried answer is one answer." };
        }
        const status = effectiveOfferStatus({ status: offer.status, expiresAt: offer.expiresAt }, now);
        if (status === input.decision) return { offerRef: offer.offerRef, status, replayed: true as const, note: "Already answered that way." };
        const postStatus = statusNow(post, now);
        if (input.decision === "accepted" && postStatus !== "open" && postStatus !== "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${postStatus}; the offer cannot be accepted` });
        if (!canTransitionOffer(status, input.decision)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That offer is ${status}; it does not go to ${input.decision}` });
        await tx.update(shiftOffers).set({
          status: input.decision, respondedAt: now, deviceRespondedAt: input.deviceRespondedAt ?? null,
          responseDeviceId: input.deviceId ?? null, responseClientMutationId: input.deviceId ? input.clientMutationId ?? null : null, responseNote: input.note ?? null,
        }).where(eq(shiftOffers.id, offer.id));
        await postEvent(tx, { postRef: post.postRef, eventType: input.decision === "accepted" ? "offer_accepted" : "offer_declined", actorUserId: ctx.user.id, actorRole: actorRoleOf(roles), subjectUserId: ctx.user.id, detail: input.note ?? null, at: now, deviceAt: input.deviceRespondedAt ?? null });
        return {
          offerRef: offer.offerRef, status: input.decision, replayed: false as const,
          note: input.decision === "accepted" ? "Accepted — your statement, recorded. The award binds the slot and the readiness check runs then." : "Declined.",
        };
      });
    }),

  /**
   * 0206 — Checkpoint 3: fill the post by binding the slot it names, through the canonical
   * binding, behind the readiness check the dispatcher recorded for this subject and slot.
   * `dispatch.assign` — the binding's own permission; no second way to bind a slot.
   */
  award: roleProcedure("shifts.award")
    .input(z.object({
      postRef: z.string().min(1).max(64),
      userId: z.number().int().positive(),
      unitId: z.number().int().positive().nullable(),
      trailerId: z.number().int().positive().nullable().default(null),
      checkId: z.number().int().positive(),
      expectedLastEventId: z.number().int().positive().nullable(),
      reason: z.string().min(5).max(500).nullable().default(null),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      // CP1.5: the unit and trailer are checked first, not only by the binding inside the award —
      // which comes after the readiness read and the refusal the award records.
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId, trailerId: input.trailerId });
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      return awardPost({ ...input, actorUserId: ctx.user.id, scope: acting });
    }),

  /* ---------------- availability: "Offer Me Work" ---------------- */

  /**
   * Declare your own availability. Appends a declaration and supersedes the previous one for the
   * same window shape; never updates in place. Read by the candidate pool, never by readiness.
   */
  availabilitySet: roleProcedure("shifts.availabilitySet")
    .input(z.object({
      state: z.enum(["available", "unavailable", "on_call", "available_for_overtime"]),
      windowStartsAt: z.coerce.date().nullable().default(null),
      windowEndsAt: z.coerce.date().nullable().default(null),
      preferences: PREFERENCES.nullable().default(null),
      deviceDeclaredAt: z.coerce.date().optional(), deviceId: z.string().max(64).optional(), clientMutationId: z.string().min(1).max(64).optional(),
      /** Recorded on somebody's behalf by a dispatcher — a separate procedure decides who may. */
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      if (input.windowStartsAt && input.windowEndsAt && input.windowEndsAt.getTime() <= input.windowStartsAt.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The window ends before it begins" });
      const now = new Date();
      if (input.deviceId && input.clientMutationId) {
        const prior = (await d.select().from(workerAvailability).where(and(eq(workerAvailability.deviceId, input.deviceId), eq(workerAvailability.clientMutationId, input.clientMutationId))).limit(1))[0];
        if (prior) {
          if (prior.userId !== ctx.user.id) throw new TRPCError({ code: "CONFLICT", message: "That client mutation id was already used by this device for somebody else" });
          return { availabilityRef: prior.availabilityRef, replayed: true as const, note: "Already recorded; a retried declaration is one declaration." };
        }
      }
      const availabilityRef = ref("AV");
      const orgRef = acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId;
      await d.transaction(async tx => {
        // A standing declaration supersedes the previous standing one; a windowed one supersedes a
        // previous declaration over the identical window. Overlapping windows coexist and the
        // latest declared wins at read time (declaredStateAt).
        const prior = await tx.select().from(workerAvailability).where(and(eq(workerAvailability.userId, ctx.user.id), isNull(workerAvailability.supersededAt))).for("update").limit(50);
        for (const p of prior) {
          const same = (p.windowStartsAt?.getTime() ?? null) === (input.windowStartsAt?.getTime() ?? null) && (p.windowEndsAt?.getTime() ?? null) === (input.windowEndsAt?.getTime() ?? null);
          if (same) await tx.update(workerAvailability).set({ supersededAt: now, supersededByRef: availabilityRef }).where(eq(workerAvailability.id, p.id));
        }
        await tx.insert(workerAvailability).values({
          availabilityRef, orgRef, userId: ctx.user.id, state: input.state, windowStartsAt: input.windowStartsAt, windowEndsAt: input.windowEndsAt,
          preferencesJson: input.preferences ? JSON.stringify(input.preferences satisfies AvailabilityPreferences) : null,
          declaredAt: now, deviceDeclaredAt: input.deviceDeclaredAt ?? null, deviceId: input.deviceId ?? null, clientMutationId: input.deviceId ? input.clientMutationId ?? null : null,
          source: "self", recordedByUserId: ctx.user.id,
        });
      });
      return { availabilityRef, replayed: false as const, note: "Recorded. A declaration is what you said you would take; it is not proof you may, and the readiness check still decides that." };
    }),

  /** Your own live declarations. */
  availabilityMine: roleProcedure("shifts.availabilityMine")
    .query(async ({ ctx }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const rows = await declarationsFor(d, ctx.user.id, acting);
      return { declarations: rows.map(r => ({ availabilityRef: r.availabilityRef, state: r.state, windowStartsAt: r.windowStartsAt, windowEndsAt: r.windowEndsAt, preferences: r.preferences, declaredAt: r.declaredAt })) };
    }),

  /** Somebody else's live declarations, for a dispatcher. Another organization's person is not found. */
  availabilityFor: roleProcedure("shifts.availabilityFor")
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      if (!(await userInScope(input.userId, { tenantId: acting.tenantId }))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const rows = await declarationsFor(d, input.userId, acting);
      return { userId: input.userId, declarations: rows.map(r => ({ availabilityRef: r.availabilityRef, state: r.state, windowStartsAt: r.windowStartsAt, windowEndsAt: r.windowEndsAt, preferences: r.preferences, declaredAt: r.declaredAt })) };
    }),
});

/** One response per person per post, replaced in place; the previous answer is history. */
async function respond(userId: number, input: { postRef: string; response: (typeof RESPONSE_KINDS)[number]; note?: string; at: Date; deviceCreatedAt?: Date; deviceId?: string; clientMutationId?: string }, alreadyChecked?: Candidate) {
  const d = await db();
  const acting = await resolveActingScope(d, userId);
  const roles = await listActiveUserRoleNames(userId);
  const now = new Date();
  const postRow = await postInScope(d, input.postRef, acting);
  if (postRow.kind !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That is an assigned post; interest is not how it is filled" });
  const status = statusNow(postRow, now);
  if (status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That post is ${status}` });

  if (input.deviceId && input.clientMutationId) {
    const prior = (await d.select().from(shiftInterests).where(and(eq(shiftInterests.deviceId, input.deviceId), eq(shiftInterests.clientMutationId, input.clientMutationId))).limit(1))[0];
    if (prior) return { postRef: postRow.postRef, response: prior.response, recorded: false, replayed: true as const, assigns: false as const, note: "Already recorded; a retried response is one response." };
  }

  // The one rule (SPINE item 2), from the person's own records: saying you would take it is refused
  // unless you may. Declining is never refused.
  if (responseVolunteers(input.response)) {
    const candidate = alreadyChecked ?? await eligibilityOf(d, { post: postRow, userId, scope: acting });
    try {
      expressInterest({ post: toShiftPost(postRow), candidate, at: input.at });
    } catch (e) {
      if (e instanceof NotEligible) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
      throw e;
    }
  }

  const existing = (await d.select().from(shiftInterests).where(and(
    eq(shiftInterests.postRef, postRow.postRef), eq(shiftInterests.userId, userId),
  )).limit(1))[0];
  if (existing && !existing.withdrawnAt && existing.response === input.response) {
    return { postRef: postRow.postRef, response: existing.response, recorded: false, replayed: false as const, assigns: false as const, note: "Already recorded; tapping twice is not two claims." };
  }
  let recorded = false;
  await d.transaction(async tx => {
    if (existing) {
      await tx.update(shiftInterests).set({
        response: input.response, note: input.note ?? null, expressedAt: input.at, withdrawnAt: null, updatedAt: now,
        deviceCreatedAt: input.deviceCreatedAt ?? null, deviceId: input.deviceId ?? null, clientMutationId: input.deviceId ? input.clientMutationId ?? null : null,
      }).where(eq(shiftInterests.id, existing.id));
      if (!existing.withdrawnAt) await postEvent(tx, { postRef: postRow.postRef, eventType: "response_withdrawn", actorUserId: userId, actorRole: actorRoleOf(roles), subjectUserId: userId, detail: `${existing.response} replaced by ${input.response}`, at: now });
    } else {
      try {
        await tx.insert(shiftInterests).values({
          postRef: postRow.postRef, userId, expressedAt: input.at, response: input.response, note: input.note ?? null,
          deviceCreatedAt: input.deviceCreatedAt ?? null, deviceId: input.deviceId ?? null, clientMutationId: input.deviceId ? input.clientMutationId ?? null : null,
        });
      } catch (e) {
        // UNIQUE(postRef, userId): a concurrent tap won the race. One claim, not two, and not an error.
        const raced = (await tx.select({ id: shiftInterests.id }).from(shiftInterests).where(and(eq(shiftInterests.postRef, postRow.postRef), eq(shiftInterests.userId, userId))).limit(1))[0];
        if (!raced) throw e;
        throw new RacedResponse();
      }
    }
    await postEvent(tx, { postRef: postRow.postRef, eventType: "response_recorded", actorUserId: userId, actorRole: actorRoleOf(roles), subjectUserId: userId, detail: input.response, at: now, deviceAt: input.deviceCreatedAt ?? null });
    recorded = true;
  }).catch(e => {
    if (e instanceof RacedResponse) return;
    throw e;
  });
  return {
    postRef: postRow.postRef, response: input.response, recorded, replayed: false as const, assigns: false as const,
    note: recorded
      ? input.response === "declined"
        ? "Declined. Recorded, so nobody phones you about it."
        : "Interest recorded. Dispatch assigns the shift and the readiness check runs then — eligibility today says nothing about a certificate expiring tomorrow night."
      : "Already recorded; tapping twice is not two claims.",
  };
}

class RacedResponse extends Error {}

