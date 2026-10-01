/**
 * v22.20 (0095) — what is missing before tomorrow, from records.
 *
 * No new tables. Every check is assembled from something already stored, and
 * `readyForShift` reaches the verdict — this file decides none of it.
 *
 * The checks:
 *
 *   LICENCE          from `operators`, the one credential stored inline
 *   QUALIFICATIONS   from the qualification read adapter (C1b-3), verified and unexpired only
 *   LEAVE            from `leaveRequests`, approved or recorded
 *   CREW             from `crewMembers`, whether they are on a crew at all
 *
 * **A check that could not be evaluated is `unknown`, and `unknown` is its own
 * verdict.** "Something is missing" sends a person to fix it; "we could not
 * tell" sends them to whoever can answer. Folding the second into the first
 * wastes an hour on the wrong errand, and folding it into `ready` is how a
 * driver leaves the yard on an endorsement nobody checked.
 *
 * **An empty checklist is not ready.** If nothing was evaluated, the honest
 * answer is that nothing was evaluated.
 */
import { readExpiry } from "./_core/documentValidity";
import { effectiveQualifications } from "./qualificationReads";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { crewMembers, crews, leaveRequests, operators, shiftPosts } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import type { DbOrTx } from "./_core/dbTypes";
import { readyForShift, type ReadinessCheck } from "./_core/shiftReadiness";
import { routeByOwner, type Owner } from "./_core/readinessRouting";

async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

/** Who can resolve each kind of check before the shift. */
const OWNER_OF: Record<string, Owner> = {
  licence: "driver", crew: "dispatch", leave: "dispatch",
};
const ownerOf = (check: ReadinessCheck): Owner =>
  OWNER_OF[check.key.split(":")[0]] ?? (check.key.startsWith("qualification") ? "safety" : "office");

async function checksFor(d: DbOrTx, args: { tenantId: string; userId: number; startsAt: Date; requiredQualifications: readonly string[] }): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];

  /* Licence — the one credential operators store inline. */
  const person = (await d.select().from(operators).where(eq(operators.id, args.userId)).limit(1))[0];
  if (!person) {
    checks.push({ key: "licence", label: "Driver record", state: "unknown", blocksShift: true, reason: "No operator record for this person — nothing about them can be established" });
  } else if (!person.licenseExpiresAt) {
    checks.push({ key: "licence", label: "Licence", state: "unknown", blocksShift: true, reason: "No licence expiry on record" });
  } else if (readExpiry(person.licenseExpiresAt, args.startsAt, 0).expiry === "expired") {
    checks.push({ key: "licence", label: "Licence", state: "failed", blocksShift: true, reason: `Expires ${person.licenseExpiresAt.toISOString().slice(0, 10)}, before this shift` });
  } else {
    checks.push({ key: "licence", label: "Licence", state: "satisfied", blocksShift: true, reason: null });
  }

  /* Qualifications the shift asks for. */
  // C1b-3: through the qualification read adapter — Academy first, legacy holdings only as a marked
  // fallback, in the caller's organization — rather than from the legacy store directly.
  const effective = await effectiveQualifications(d, { tenantId: args.tenantId, userId: args.userId, at: args.startsAt, codes: args.requiredQualifications });
  for (const e of effective) {
    const code = e.code;
    const verdict = { held: e.held, code: e.notHeld, reason: e.reason };
    checks.push(verdict.held
      ? { key: `qualification:${code}`, label: code, state: "satisfied", blocksShift: true, reason: null }
      : {
          key: `qualification:${code}`, label: code,
          state: verdict.code === "expired" ? "failed" : "unknown",
          blocksShift: true, reason: verdict.reason,
        });
  }

  /* Approved leave over the shift is a contradiction worth naming. */
  const leave = await d.select().from(leaveRequests).where(eq(leaveRequests.userId, args.userId)).limit(100);
  const clash = leave.find(l => (l.status === "approved" || l.status === "recorded")
    && l.fromDate.getTime() <= args.startsAt.getTime() && args.startsAt.getTime() <= l.toDate.getTime() && !l.partialFromTime);
  checks.push(clash
    ? { key: "leave", label: "Availability", state: "failed", blocksShift: true, reason: "Away that day on leave already recorded" }
    : { key: "leave", label: "Availability", state: "satisfied", blocksShift: true, reason: null });

  /* Crew membership — advisory, since somebody can work without one. */
  const memberships = await d.select().from(crewMembers).where(and(eq(crewMembers.userId, args.userId), isNull(crewMembers.leftAt))).limit(20);
  checks.push(memberships.length
    ? { key: "crew", label: "Crew", state: "satisfied", blocksShift: false, reason: null }
    : { key: "crew", label: "Crew", state: "failed", blocksShift: false, reason: "Not currently on a crew" });

  return checks;
}

export const readinessRouter = router({
  /**
   * Readiness for a posted shift.
   *
   * The qualifications come from the post, so the question is always "ready for
   * *this*" rather than "ready in general" — which is not a thing anybody can
   * be.
   */
  forShift: roleProcedure("readiness.forShift")
    .input(z.object({ postRef: z.string().min(1).max(64), userId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const userId = input.userId ?? ctx.user.id;
      if (userId !== ctx.user.id) {
        // Reading somebody else's readiness is a scheduling act.
        const scope = await resolveActingScope(d, ctx.user.id);
        if (!scope.tenantId) throw new TRPCError({ code: "FORBIDDEN", message: "No organization" });
      }
      const post = (await d.select().from(shiftPosts).where(eq(shiftPosts.postRef, input.postRef)).limit(1))[0];
      if (!post || post.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such shift post" });

      const required = JSON.parse(post.requiredQualificationsJson) as string[];
      const checks = await checksFor(d, { tenantId: acting.tenantId, userId, startsAt: post.startsAt, requiredQualifications: required });
      const readiness = readyForShift({ shiftStartsAt: post.startsAt, checks });
      const routed = routeByOwner(readiness, ownerOf);

      return {
        postRef: post.postRef, userId,
        verdict: readiness.verdict,
        headline: readiness.headline,
        lines: readiness.lines,
        byOwner: routed.byOwner,
        note: readiness.verdict === "incomplete"
          ? "Incomplete is not the same as not ready. Something missing sends you to fix it; something unknown sends you to whoever can answer."
          : "Readiness is for this shift and its requirements, not readiness in general.",
      };
    }),

  /**
   * Tomorrow, for the caller, against a stated start and requirements.
   *
   * Used where there is no post yet — a supervisor asking a crew to be ready
   * without a posted shift to hang it on.
   */
  forTime: roleProcedure("readiness.forTime")
    .input(z.object({
      startsAt: z.coerce.date(),
      requiredQualifications: z.array(z.string().max(60)).max(20).default([]),
      userId: z.number().int().positive().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const userId = input.userId ?? ctx.user.id;
      const checks = await checksFor(d, { tenantId: acting.tenantId, userId, startsAt: input.startsAt, requiredQualifications: input.requiredQualifications });
      const readiness = readyForShift({ shiftStartsAt: input.startsAt, checks });
      const routed = routeByOwner(readiness, ownerOf);
      return {
        userId, verdict: readiness.verdict, headline: readiness.headline,
        lines: readiness.lines, byOwner: routed.byOwner,
        note: "Assembled from stored records. A check nobody could evaluate is unknown, and unknown is not ready.",
      };
    }),
});
