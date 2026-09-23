/**
 * The dispatch gate — B12, reachable.
 *
 * The engine, the tables and the award transaction existed; no procedure
 * reached them, and the assignment paths that were reachable had no gate.
 * These six make the gate the way to dispatch:
 *
 *   readiness        preview, no write — what would the verdict be?
 *   evaluate         records an eligibility check: verdict, named blockers,
 *                    a fingerprint of the facts it saw, who evaluated
 *   overrideRequest  a person asks to override a named blocker, with a reason
 *   overrideGrant    a named authority grants it — never the requester, never
 *                    for a blocker that is overridable by no one
 *   award            binds the assignment to a recorded check: the facts are
 *                    recomputed here and the award is refused if they changed
 *                    or the check aged out
 *   whatAmIMissing   the operator's own checklist — the AI Secretary's answer
 *
 * The caller supplies identities. Every fact is loaded here.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, jobInScope, listActiveUserRoleNames, operatorInScope, unitInScope } from "./db";
import { dispatchEligibilityChecks, dispatchEnforcementSettings, dispatchOverrides, dispatchPostings, operators } from "../drizzle/schema";
import { loadEnforcementMode } from "./dispatchEnforcementService";
import { assertEntityInScope } from "./_core/entityScope";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { asChecklist, composeReadiness } from "./readinessComposer";
import { requestOverride, type DispatchBlocker, type OverrideRequest } from "./_core/dispatchReadiness";
import { awardAssignment } from "./_core/dispatchTransaction";
import type { GrantedOverride } from "./_core/dispatchAward";

// v22.18 — a readiness may name the route it is about. Optional, so every
// caller that does not keeps exactly the behaviour it had.
const SUBJECT = z.object({ operatorId: z.number().int().positive(), unitId: z.number().int().positive().nullable(), trailerId: z.number().int().positive().nullable().optional(), jobId: z.number().int().positive().nullable().optional(), routeApprovalRef: z.string().max(64).nullable().optional(), loneWorker: z.boolean().optional() });

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/**
 * The subject identities, checked against the caller's organization.
 *
 * "The caller supplies identities. Every fact is loaded here." was true, and
 * that was the hole: none of the supplied identities was checked. A dispatcher
 * in one organization could name another's operator, unit, trailer or job, and
 * `composeReadiness` would load and return that operator's licence, medical and
 * hours-of-service state — a cross-tenant read of exactly the compliance data
 * this system exists to protect — then record an eligibility check about them
 * and award them to a posting.
 *
 * Trailers are rows in `units`, so they take the same ownership path.
 *
 * Every refusal is NOT_FOUND. "Not yours" and "no such record" must not be
 * distinguishable, which is the rule `db.ts` states for these lookups, and
 * anything else would let a caller enumerate another organization's fleet by
 * integer id.
 */
async function assertSubjectInScope(
  scope: { tenantId: string },
  s: { operatorId: number; unitId?: number | null; trailerId?: number | null; jobId?: number | null },
): Promise<void> {
  if (!(await operatorInScope(s.operatorId, scope))) throw notFound(`Operator ${s.operatorId}`);
  if (s.unitId != null && !(await unitInScope(s.unitId, scope))) throw notFound(`Unit ${s.unitId}`);
  if (s.trailerId != null && !(await unitInScope(s.trailerId, scope))) throw notFound(`Trailer ${s.trailerId}`);
  if (s.jobId != null && !(await jobInScope(s.jobId, scope))) throw notFound(`Job ${s.jobId}`);
}

/**
 * A recorded check the caller may act on. `dispatchEligibilityChecks` carries no
 * organization of its own, so the check is in scope exactly when its subject is
 * — which is the authoritative path rather than a convenient join.
 */
async function checkInScope(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  scope: { tenantId: string },
  checkId: number,
) {
  const check = (await db.select().from(dispatchEligibilityChecks).where(eq(dispatchEligibilityChecks.id, checkId)).limit(1))[0];
  if (!check) throw notFound(`Eligibility check ${checkId}`);
  try {
    await assertSubjectInScope(scope, { operatorId: check.operatorId, unitId: check.unitId, trailerId: check.trailerId, jobId: check.jobId });
  } catch {
    // Same answer as a check that does not exist.
    throw notFound(`Eligibility check ${checkId}`);
  }
  return check;
}

/** B12's override authority ladder, from the caller's domain roles. */
async function overrideRoleFor(userId: number): Promise<OverrideRequest["requestedByRole"]> {
  const roles = await listActiveUserRoleNames(userId);
  if (roles.includes("controller")) return "administrator";
  if (roles.includes("management")) return "manager";
  if (roles.includes("dispatcher")) return "dispatcher";
  if (roles.includes("mechanic") || roles.includes("shop_lead")) return "mechanic";
  if (roles.includes("office") || roles.includes("safety") || roles.includes("hr")) return "office";
  return "driver";
}

export const dispatchGateRouter = router({
  readiness: roleProcedure("dispatch.readiness")
    .input(SUBJECT)
    .query(async ({ ctx, input }) => {
      await assertSubjectInScope(await actingScopeFor(ctx.user.id), input);
      const r = await composeReadiness({ operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null, jobId: input.jobId ?? null, routeApprovalRef: input.routeApprovalRef ?? null, loneWorker: input.loneWorker });
      return { verdict: r.eligibility.verdict, explanation: r.eligibility.explanation, blockers: r.eligibility.blockers, contributions: r.contributions };
    }),

  evaluate: roleProcedure("dispatch.evaluate")
    .input(SUBJECT.extend({ postingId: z.number().int().positive().nullable().optional(), roleId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // v21.2 — a check is for a posting or for a direct job; it must say which.
      if (!input.postingId && !input.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: "A check needs a postingId or a jobId" });
      const scope = await actingScopeFor(ctx.user.id);
      const posting = input.postingId ? (await db.select({ id: dispatchPostings.id, jobId: dispatchPostings.jobId }).from(dispatchPostings).where(eq(dispatchPostings.id, input.postingId)).limit(1))[0] : null;
      if (input.postingId && !posting) throw notFound(`Posting ${input.postingId}`);
      const now = new Date();
      const jobId = input.jobId ?? posting?.jobId ?? null;
      // The posting's own job counts as a supplied identity: naming a foreign
      // posting must not reach its job either.
      await assertSubjectInScope(scope, { operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId, jobId });
      const r = await composeReadiness({ operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null, jobId, routeApprovalRef: input.routeApprovalRef ?? null, loneWorker: input.loneWorker }, now);
      const ins = await db.insert(dispatchEligibilityChecks).values({
        postingId: input.postingId ?? null, jobId, roleId: input.roleId ?? null, operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null,
        verdict: r.eligibility.verdict, blockersJson: JSON.stringify(r.eligibility.blockers), fingerprint: r.fingerprint,
        // 0152: what was and was not evaluated when this decision was made. Stored, not recomputed:
        // recomputing would answer with today's configuration for yesterday's dispatch.
        capabilitiesJson: JSON.stringify(r.capabilities), capabilityVerdict: r.capabilityVerdict.status,
        // 0153: and the policy each capability was decided under, for the same reason.
        automationPolicyJson: JSON.stringify(r.automationPolicy), evaluatedAt: now, evaluatedByUserId: ctx.user.id,
        routeApprovalRef: input.routeApprovalRef ?? null,
      });
      return { checkId: Number(ins[0]?.insertId ?? 0), verdict: r.eligibility.verdict, explanation: r.eligibility.explanation, blockers: r.eligibility.blockers, fingerprint: r.fingerprint, evaluatedAt: now, contributions: r.contributions };
    }),

  overrideRequest: roleProcedure("dispatch.overrideRequest")
    .input(z.object({ checkId: z.number().int().positive(), blockerCode: z.string().min(2).max(80), reason: z.string().min(10).max(600) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const check = await checkInScope(db, await actingScopeFor(ctx.user.id), input.checkId);
      const blockers = JSON.parse(check.blockersJson ?? "[]") as DispatchBlocker[];
      const blocker = blockers.find(b => b.code === input.blockerCode);
      if (!blocker) throw new TRPCError({ code: "BAD_REQUEST", message: `Blocker ${input.blockerCode} is not on check ${input.checkId}` });
      const role = await overrideRoleFor(ctx.user.id);
      // A request against a non-overridable blocker is recorded and refused, not silently dropped.
      const refusal = blocker.overridable ? null : "This blocker is overridable by no one — the underlying condition must be fixed";
      await db.insert(dispatchOverrides).values({ eligibilityCheckId: check.id, postingId: check.postingId, blockerCode: input.blockerCode, requestedByUserId: ctx.user.id, requestedByRole: role, reason: input.reason, granted: false, refusalReason: refusal, requestedAt: new Date() });
      return { checkId: check.id, blockerCode: input.blockerCode, requestable: !refusal, refusal, requiredAuthority: blocker.overrideAuthority ?? null };
    }),

  overrideGrant: roleProcedure("dispatch.overrideGrant")
    .input(z.object({ checkId: z.number().int().positive(), blockerCode: z.string().min(2).max(80), reason: z.string().min(10).max(600) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const check = await checkInScope(db, await actingScopeFor(ctx.user.id), input.checkId);
      const blocker = (JSON.parse(check.blockersJson ?? "[]") as DispatchBlocker[]).find(b => b.code === input.blockerCode);
      if (!blocker) throw new TRPCError({ code: "BAD_REQUEST", message: `Blocker ${input.blockerCode} is not on check ${input.checkId}` });
      const pending = (await db.select().from(dispatchOverrides).where(and(eq(dispatchOverrides.eligibilityCheckId, check.id), eq(dispatchOverrides.blockerCode, input.blockerCode))).orderBy(desc(dispatchOverrides.requestedAt)).limit(1))[0];
      if (!pending) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No override request on record — a grant answers a request" });
      if (pending.requestedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The requester may not grant their own override" });
      const role = await overrideRoleFor(ctx.user.id);
      const outcome = requestOverride(blocker, { blockerCode: input.blockerCode, requestedByUserId: ctx.user.id, requestedByRole: role, reason: input.reason });
      await db.update(dispatchOverrides).set({ granted: outcome.granted, refusalReason: outcome.granted ? null : outcome.refusal }).where(eq(dispatchOverrides.id, pending.id));
      return outcome.granted
        ? { granted: true as const, checkId: check.id, blockerCode: input.blockerCode, grantedByRole: role }
        : { granted: false as const, checkId: check.id, blockerCode: input.blockerCode, refusal: outcome.refusal };
    }),

  award: roleProcedure("dispatch.award")
    .input(z.object({ checkId: z.number().int().positive(), startsAt: z.coerce.date(), endsAt: z.coerce.date(), maxAgeMinutes: z.number().int().positive().max(240).default(30) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const check = await checkInScope(db, await actingScopeFor(ctx.user.id), input.checkId);
      // v21.2 — a check recorded for a direct job assignment is not a posting award.
      if (check.postingId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This check is for a direct job assignment — use jobUnits.create with its eligibilityCheckId" });
      const posting = (await db.select({ jobId: dispatchPostings.jobId }).from(dispatchPostings).where(eq(dispatchPostings.id, check.postingId)).limit(1))[0];
      const now = new Date();
      // The facts are recomputed here, never accepted from the caller.
      // v22.18 — the recompute asks the same question the check asked, route
      // included. Without the route the facts would be a smaller set than the
      // ones the fingerprint was taken over, and every award would refuse.
      const current = await composeReadiness({ operatorId: check.operatorId, unitId: check.unitId, trailerId: check.trailerId, jobId: posting?.jobId ?? null, routeApprovalRef: check.routeApprovalRef }, now);
      const granted = await db.select().from(dispatchOverrides).where(and(eq(dispatchOverrides.eligibilityCheckId, check.id), eq(dispatchOverrides.granted, true)));
      const grantedOverrides: GrantedOverride[] = granted.map(g => ({ blockerCode: g.blockerCode, grantedByUserId: g.requestedByUserId, grantedByRole: g.requestedByRole, reason: g.reason ?? "", grantedAt: g.requestedAt }));
      const roles = await listActiveUserRoleNames(ctx.user.id);
      const result = await awardAssignment({
        postingId: check.postingId, roleId: check.roleId, operatorId: check.operatorId, unitId: check.unitId, trailerId: check.trailerId,
        eligibilityCheckId: check.id, currentFacts: current.facts, grantedOverrides,
        startsAt: input.startsAt, endsAt: input.endsAt, actorUserId: ctx.user.id, actorRole: roles.includes("management") ? "manager" : "dispatcher", now, maxAgeMinutes: input.maxAgeMinutes,
      });
      return result;
    }),

  /** v21.2 — append a setting row. The history of when enforcement was on is audit trail. */
  enforcementSet: roleProcedure("dispatch.enforcementSet")
    .input(z.object({ mode: z.enum(["off", "advisory", "enforced"]), reason: z.string().min(10).max(400), financialEntityId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const scope = await actingScopeFor(ctx.user.id);
      /*
       * The mode is a safety gate, so who may move it matters as much as the
       * value. A setting with no financial entity is the installation-wide one:
       * a member organization turning it off would turn it off for every other
       * organization too. Only the historical single tenant — a caller with no
       * membership, which is how this system ran before organizations existed —
       * may still set it globally. A member must name one of its own entities.
       */
      if (input.financialEntityId == null) {
        if (scope.tenantId !== SINGLE_TENANT_ID) {
          throw new TRPCError({ code: "FORBIDDEN", message: "An installation-wide enforcement mode is not one organization's to set — name a financial entity in your own organization" });
        }
      } else {
        await assertEntityInScope(db, input.financialEntityId, scope);
      }
      const before = await loadEnforcementMode(input.financialEntityId ?? null);
      await db.insert(dispatchEnforcementSettings).values({ financialEntityId: input.financialEntityId ?? null, mode: input.mode, reason: input.reason, setByUserId: ctx.user.id, setAt: new Date() });
      return { scope: input.financialEntityId ?? "global", previous: before.mode, mode: input.mode };
    }),

  enforcementGet: roleProcedure("dispatch.enforcementGet")
    .input(z.object({ financialEntityId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // Reading the installation-wide mode tells nobody anything about another
      // organization; reading a named entity's does, so that one is scoped.
      if (input?.financialEntityId != null) {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
        await assertEntityInScope(db, input.financialEntityId, await actingScopeFor(ctx.user.id));
      }
      return loadEnforcementMode(input?.financialEntityId ?? null);
    }),

  /** The operator's own readiness, as a checklist. Reads ctx.user.id; nobody else's. */
  whatAmIMissing: roleProcedure("dispatch.whatAmIMissing")
    .input(z.object({ unitId: z.number().int().positive().nullable().optional(), jobId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const me = (await db.select({ id: operators.id }).from(operators).where(eq(operators.userId, ctx.user.id)).limit(1))[0];
      if (!me) return { verdict: "unknown" as const, items: [], note: "No operator record is linked to your user" };
      // The operator is the caller's own, but the unit and job are still
      // supplied: without this an operator could probe another organization's
      // fleet by asking whether it makes them eligible.
      await assertSubjectInScope(await actingScopeFor(ctx.user.id), { operatorId: me.id, unitId: input?.unitId ?? null, jobId: input?.jobId ?? null });
      const r = await composeReadiness({ operatorId: me.id, unitId: input?.unitId ?? null, trailerId: null, jobId: input?.jobId ?? null });
      return { ...asChecklist(r.eligibility), note: undefined };
    }),
});

