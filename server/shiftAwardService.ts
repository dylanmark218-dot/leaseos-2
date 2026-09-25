/**
 * 0206 — Checkpoint 3: the marketplace award.
 *
 * Design §5.5. An award binds the slot a post names, through the canonical binding
 * (`applyBinding`, unchanged), behind a readiness check the dispatcher recorded for exactly this
 * subject and slot. It is not `dispatch.award`: no booking, no `usedForAward`, no
 * `assignment_approved`. The dispatcher runs that on the same check to book the resources; this
 * fills the post.
 *
 * What it refuses, and how:
 *
 *   - an unlinked post, a post that is not open or closed, a cancelled slot, a terminal posting;
 *   - a check for another subject or slot, a check the recompute no longer agrees with
 *     (`assessEligibilityValidity`, 30 minutes), and any finding no live grant covers
 *     (`uncoveredFindings`): a `*_unknown` finding is a finding, and with no grant it is uncovered.
 *     Unknown never passes;
 *   - a person whose latest offer was declined, withdrawn or expired, and a person who was never
 *     offered — unless the dispatcher gives a reason. Interest confers no claim; its absence is no
 *     bar; a refusal on record is answered, not overridden by silence.
 *
 * Every business refusal is a `shiftPostEvents` row (`award_refused`, with its code) that commits
 * whether or not the rest rolled back — the `assignment_blocked` precedent. The lock order is
 * posting → role → post → offers: the first two are the binding's own, the last two come after so
 * a `setRoleAssignment` running concurrently on the same posting queues rather than deadlocks.
 *
 * Idempotency is the binding's: a retry after commit meets a changed head event (`CONFLICT`) or a
 * filled post (`post_not_awardable`). No second key sits beside that.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, jobInScope, listActiveUserRoleNames, operatorInScope } from "./db";
import { dispatchEligibilityChecks, dispatchPostings, dispatchRoles, operators, shiftOffers, shiftPosts } from "../drizzle/schema";
import type { ActingScope } from "./_core/actingScope";
import type { Tx } from "./_core/dbTypes";
import { assessEligibilityValidity, type StoredEligibilityCheck } from "./_core/dispatchAward";
import { APPROVED_OVERRIDE_POLICIES, asFinding, uncoveredFindings } from "./_core/complianceFinding";
import type { DispatchBlocker } from "./_core/dispatchReadiness";
import { composeReadiness } from "./readinessComposer";
import { checkInScope, loadGrantedOverrides } from "./dispatchEnforcementService";
import { setRoleAssignmentIn, type AssignmentOutcome } from "./dispatchRoleService";
import { effectiveOfferStatus, isLiveOffer, type OfferStatus } from "./_core/openShifts";
import { postEvent, statusNow } from "./openShiftsService";
import { enqueueBoardEvent } from "./_core/boardOutbox";

export type AwardRefusalCode =
  | "post_unlinked" | "post_not_awardable" | "no_operator_record" | "check_subject_mismatch"
  | "readiness_stale" | "readiness_refused" | "offer_not_live" | "offer_unanswered" | "no_offer";

export type ShiftAwardResult =
  | { ok: true; postRef: string; roleId: number; eventId: number; lastEventId: number; planningState: string; staffing: AssignmentOutcome["staffing"]; jobRoomChannelRef: string | null; notSelected: number[]; explanation: string }
  | { ok: false; postRef: string; code: AwardRefusalCode; refusals: string[]; explanation: string };

export type ShiftAwardInput = {
  postRef: string;
  userId: number;
  unitId: number | null;
  trailerId: number | null;
  checkId: number;
  expectedLastEventId: number | null;
  reason: string | null;
  actorUserId: number;
  scope: ActingScope;
};

const AWARD_CHECK_MAX_AGE_MINUTES = 30;

export async function awardPost(input: ShiftAwardInput): Promise<ShiftAwardResult> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const now = new Date();
  const roles = await listActiveUserRoleNames(input.actorUserId);
  const actorRole = roles.includes("management") ? "manager" : roles.includes("dispatcher") ? "dispatcher" : roles[0] ?? "user";
  const scope = { tenantId: input.scope.tenantId };

  const refuse = async (code: AwardRefusalCode, refusals: string[]): Promise<ShiftAwardResult> => {
    await postEvent(db, { postRef: input.postRef, eventType: "award_refused", actorUserId: input.actorUserId, actorRole, subjectUserId: input.userId, detail: `${code}: ${refusals.join(" | ")}`.slice(0, 600), at: now });
    return { ok: false, postRef: input.postRef, code, refusals, explanation: refusals.join(". ") + "." };
  };

  /* ---- reads, outside the lock: the same shape as dispatch.award ---- */
  const post = (await db.select().from(shiftPosts).where(eq(shiftPosts.postRef, input.postRef)).limit(1))[0];
  if (!post || post.tenantId !== input.scope.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });
  if (post.dispatchRoleId == null || post.dispatchPostingId == null) return refuse("post_unlinked", ["The post names no dispatch slot — link it to the role it fills before awarding"]);

  const role = (await db.select().from(dispatchRoles).where(eq(dispatchRoles.id, post.dispatchRoleId)).limit(1))[0];
  const posting = role ? (await db.select().from(dispatchPostings).where(eq(dispatchPostings.id, role.postingId)).limit(1))[0] : undefined;
  if (!role || !posting || posting.id !== post.dispatchPostingId || !(await jobInScope(posting.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Role ${post.dispatchRoleId} not found` });

  const op = (await db.select().from(operators).where(eq(operators.userId, input.userId)).limit(1))[0];
  if (!op || !(await operatorInScope(op.id, scope))) return refuse("no_operator_record", [`No operator record is linked to user ${input.userId}; a person with no operator record cannot be bound to a slot`]);

  const check = (await db.select().from(dispatchEligibilityChecks).where(eq(dispatchEligibilityChecks.id, input.checkId)).limit(1))[0];
  if (!check || !checkInScope(check, scope)) throw new TRPCError({ code: "NOT_FOUND", message: "Eligibility check not found" });
  const mismatches: string[] = [];
  if (check.operatorId !== op.id) mismatches.push(`check is for operator ${check.operatorId}, not ${op.id}`);
  if ((check.unitId ?? null) !== (input.unitId ?? null)) mismatches.push(`check is for unit ${check.unitId ?? "none"}, not ${input.unitId ?? "none"}`);
  if ((check.trailerId ?? null) !== (input.trailerId ?? null)) mismatches.push(`check is for trailer ${check.trailerId ?? "none"}, not ${input.trailerId ?? "none"}`);
  if (check.postingId !== posting.id) mismatches.push(`check is for posting ${check.postingId ?? "none"}, not ${posting.id}`);
  if ((check.roleId ?? null) !== role.id) mismatches.push(`check is for role ${check.roleId ?? "none"}, not ${role.id}`);
  if (mismatches.length) return refuse("check_subject_mismatch", mismatches);

  // The facts are recomputed here, never accepted from the caller — the award's own rule.
  const current = await composeReadiness({ operatorId: op.id, unitId: input.unitId, trailerId: input.trailerId, jobId: posting.jobId, postingId: posting.id, routeApprovalRef: check.routeApprovalRef }, now);
  const grants = await loadGrantedOverrides(db, check.id);
  const stored: StoredEligibilityCheck = {
    checkId: check.id, operatorId: check.operatorId, verdict: check.verdict,
    blockers: check.blockersJson ? (JSON.parse(check.blockersJson) as DispatchBlocker[]) : [],
    evaluatedAt: check.evaluatedAt, explanation: "",
    // A row with no fingerprint is treated as invalid, never as valid.
    fingerprint: check.fingerprint || "MISSING",
  };

  /* ---- the transaction ---- */
  let result: ShiftAwardResult;
  try {
    result = await db.transaction(async (tx: Tx): Promise<ShiftAwardResult> => {
      // 1. The posting: the canonical lock every binding and award takes first.
      const lockedPosting = (await tx.select().from(dispatchPostings).where(eq(dispatchPostings.id, posting.id)).for("update").limit(1))[0];
      if (!lockedPosting) throw new TRPCError({ code: "NOT_FOUND", message: `Role ${role.id} not found` });
      // 2. The role.
      const lockedRole = (await tx.select().from(dispatchRoles).where(eq(dispatchRoles.id, role.id)).for("update").limit(1))[0]!;
      // 3. The post — after the dispatch rows, never before.
      const lockedPost = (await tx.select().from(shiftPosts).where(eq(shiftPosts.id, post.id)).for("update").limit(1))[0]!;
      // 4. Every live offer on the post.
      const offers = await tx.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, post.postRef), inArray(shiftOffers.status, ["offered", "accepted"]))).for("update").limit(200);

      const refuseIn = async (code: AwardRefusalCode, refusals: string[]): Promise<ShiftAwardResult> => {
        // Written inside the transaction and committed with it: the refusal is the only write.
        await postEvent(tx, { postRef: post.postRef, eventType: "award_refused", actorUserId: input.actorUserId, actorRole, subjectUserId: input.userId, detail: `${code}: ${refusals.join(" | ")}`.slice(0, 600), at: now });
        return { ok: false, postRef: post.postRef, code, refusals, explanation: refusals.join(". ") + "." };
      };

      const postStatus = statusNow(lockedPost, now);
      if (postStatus !== "open" && postStatus !== "closed") return refuseIn("post_not_awardable", [`The post is ${postStatus}`]);
      if (lockedRole.status === "cancelled") return refuseIn("post_not_awardable", [`Role ${role.id} is cancelled`]);
      if (lockedPosting.planningState === "cancelled" || lockedPosting.planningState === "completed") return refuseIn("post_not_awardable", [`Posting ${posting.id} is ${lockedPosting.planningState}`]);

      const validity = assessEligibilityValidity(stored, current.facts, now, AWARD_CHECK_MAX_AGE_MINUTES);
      if (!validity.valid) return refuseIn("readiness_stale", [validity.reason]);

      const findings = stored.blockers.map(b => asFinding(b, stored.evaluatedAt));
      const uncovered = uncoveredFindings(findings, grants, now, APPROVED_OVERRIDE_POLICIES);
      if (uncovered.length) return refuseIn("readiness_refused", uncovered);

      const mine = offers.filter(o => o.userId === input.userId).map(o => ({ ...o, effective: effectiveOfferStatus({ status: o.status, expiresAt: o.expiresAt }, now) }));
      const live = mine.find(o => isLiveOffer(o.effective));
      if (!live) {
        const latest = (await tx.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, post.postRef), eq(shiftOffers.userId, input.userId))).limit(50))
          .sort((a, b) => b.id - a.id)[0];
        const latestStatus: OfferStatus | null = latest ? effectiveOfferStatus({ status: latest.status, expiresAt: latest.expiresAt }, now) : null;
        // A recorded answer is not overridden by a reason (§5.5, D-1): the dispatcher withdraws nothing and
        // issues a new offer, and the award follows that. A reason stands in only where no offer ever existed.
        if (latestStatus) return refuseIn("offer_not_live", [`${input.userId}'s latest offer on this post is ${latestStatus}; issue a new offer before awarding`]);
        if (!latestStatus && !input.reason?.trim()) return refuseIn("no_offer", [`${input.userId} was never offered this post; awarding without an offer needs a reason`]);
      } else if (live.effective === "offered" && !input.reason?.trim()) {
        // §5.5, D-1: the award follows an accepted offer. One the person has not answered is not a yes;
        // a dispatcher who has one another way (the phone, the yard) says so, and the reason is recorded.
        return refuseIn("offer_unanswered", [`${input.userId} has not answered the offer; awarding before they accept needs a reason`]);
      }

      // 5. The binding — the canonical one, unchanged, inside this transaction.
      const bound = await setRoleAssignmentIn(tx, {
        roleId: role.id, operatorId: op.id, unitId: input.unitId, trailerId: input.trailerId,
        expectedLastEventId: input.expectedLastEventId, reason: input.reason,
        actorUserId: input.actorUserId, actorRole, scope,
      });

      // 6. The marketplace rows: the winner's offer awarded, every other live offer not selected, the post filled.
      const notSelected: number[] = [];
      for (const o of offers) {
        if (o.userId === input.userId) {
          await tx.update(shiftOffers).set({ status: "awarded", awardEventId: bound.eventId, respondedAt: o.respondedAt ?? now }).where(eq(shiftOffers.id, o.id));
        } else {
          await tx.update(shiftOffers).set({ status: "not_selected" }).where(eq(shiftOffers.id, o.id));
          notSelected.push(o.userId);
          await postEvent(tx, { postRef: post.postRef, eventType: "not_selected", actorUserId: input.actorUserId, actorRole, subjectUserId: o.userId, detail: o.offerRef, at: now });
        }
      }
      await tx.update(shiftPosts).set({ status: "filled", filledAt: now, filledByUserId: input.actorUserId }).where(eq(shiftPosts.id, post.id));
      await postEvent(tx, { postRef: post.postRef, eventType: "awarded", actorUserId: input.actorUserId, actorRole, subjectUserId: input.userId,
        // The marketplace's own record says how the person's yes arrived: in the app, or — an unanswered
        // offer — outside it, with the dispatcher's reason (the binding's event keeps the reason too).
        detail: `role ${role.id} event ${bound.eventId} check ${check.id}${live
          ? ` offer ${live.offerRef} ${live.effective === "accepted" ? "accepted in the app" : `unanswered in the app; acceptance recorded by the dispatcher: ${input.reason}`}`
          : ` without an offer: ${input.reason}`}`.slice(0, 600), at: now });

      // 7. The event, in the same transaction; refs only.
      await enqueueBoardEvent(tx, {
        eventType: "work.awarded", aggregateType: "shiftPost", aggregateId: post.postRef, transition: `awarded:${bound.eventId}`,
        tenantId: input.scope.tenantId, actorUserId: input.actorUserId, occurredAt: now, jobId: String(posting.jobId),
        payload: {
          recipientUserIds: [input.userId, ...notSelected], title: `Filled: ${post.title}`,
          line: `${post.title} has been awarded. Open the post for your outcome.`, deepLink: `/work/${post.postRef}`,
          refs: { postRef: post.postRef, roleId: role.id, eventId: bound.eventId, checkId: check.id, jobRoom: bound.jobRoom?.channelRef ?? null },
        },
      });

      return {
        ok: true, postRef: post.postRef, roleId: role.id, eventId: bound.eventId, lastEventId: bound.lastEventId, planningState: bound.planningState, staffing: bound.staffing,
        jobRoomChannelRef: bound.jobRoom?.channelRef ?? null, notSelected,
        explanation: `Awarded on eligibility check ${check.id} (${validity.ageMinutes} min old, dependencies unchanged); slot ${role.id} bound to operator ${op.id}. The posting's own award (booking) and pre-departure gate are unchanged.`,
      };
    });
  } catch (e) {
    // The binding's own refusals (a stale head token, a sibling slot holding the same person or
    // unit, a cancelled slot) roll the transaction back; the refusal is still evidence.
    if (e instanceof TRPCError) {
      await postEvent(db, { postRef: input.postRef, eventType: "award_refused", actorUserId: input.actorUserId, actorRole, subjectUserId: input.userId, detail: `${e.code}: ${e.message}`.slice(0, 600), at: now });
    }
    throw e;
  }
  return result;
}
