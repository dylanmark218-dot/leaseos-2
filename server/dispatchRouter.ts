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
import { commercialScope, jobSnapshotCaptureIfReady } from "./customerCommercialService";
import { financeScopeFor } from "./_core/entityScope";
import { getDb, jobInScope, listActiveUserRoleNames } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { assertEntityInScope } from "./_core/entityScope";
import { singleOwnershipDomain } from "./ownershipDomain";
import { platformAuthorityProven } from "./platformAuthority";
import { dispatchEligibilityChecks, dispatchEnforcementSettings, dispatchOverrides, dispatchPostings, operators } from "../drizzle/schema";
import { assertReadinessSubjectInScope, checkInScope, dispatchScopeFor, loadEnforcementMode, loadGrantedOverrides } from "./dispatchEnforcementService";
import { asFinding, resolveOverridePolicy } from "./_core/complianceFinding";
import { asChecklist, composeReadiness } from "./readinessComposer";
import { requestOverride, type DispatchBlocker, type OverrideRequest } from "./_core/dispatchReadiness";
import { awardAssignment } from "./_core/dispatchTransaction";
import { addRole, clearRoleAssignment, createPosting, listRoles, scopeOf, setRoleAssignment } from "./dispatchRoleService";

// v22.18 — a readiness may name the route it is about. Optional, so every
// caller that does not keeps exactly the behaviour it had.
const SUBJECT = z.object({ operatorId: z.number().int().positive(), unitId: z.number().int().positive().nullable(), trailerId: z.number().int().positive().nullable().optional(), jobId: z.number().int().positive().nullable().optional(), routeApprovalRef: z.string().max(64).nullable().optional(), loneWorker: z.boolean().optional() });

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

/** A role slot draft, as a caller may describe one. */
const ROLE_DRAFT = z.object({
  roleCode: z.string().min(1).max(60),
  roleLabel: z.string().min(1).max(180).optional(),
  required: z.boolean().optional(),
  requiredEquipmentClass: z.string().max(60).nullable().optional(),
  requiredTrailerClass: z.string().max(60).nullable().optional(),
});

/**
 * How long a WARNING_ONLY acknowledgement counts. It cannot outlive the longest check reuse window
 * `award` accepts (240 min), and a fresh check needs its own acknowledgements anyway.
 */
const ACKNOWLEDGEMENT_VALIDITY_MINUTES = 240;

async function scopedDb(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return { db, scope: await dispatchScopeFor(userId) };
}

/**
 * The enforcement setting a caller may read or write. An entity row must belong to the caller's
 * organization (NOT_FOUND otherwise).
 *
 * The global row (no entity) is the fallback for every organization without a mode of its own, and the
 * mode of the legacy path. F1.3 — it is PLATFORM-GOVERNED: once any organization exists, only platform
 * authority (`platformAuthorityProven`, read from the users row) may change it. Being unaffiliated is
 * not authority. While no organization exists, the one tenant governs its own deployment, as before.
 * Reading it keeps C1a's rule (the single tenant, not an organization), plus platform authority.
 */
async function assertEnforcementScope(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, scope: Awaited<ReturnType<typeof dispatchScopeFor>>, financialEntityId: number | null, userId: number, access: "read" | "write") {
  if (financialEntityId != null) return assertEntityInScope(db, financialEntityId, scope);
  if (await platformAuthorityProven(userId)) return;
  if (access === "write") {
    if (await singleOwnershipDomain()) return;
    throw new TRPCError({ code: "FORBIDDEN", message: "The global dispatch enforcement setting is the fallback for every organization; only platform authority may change it — name your own entity" });
  }
  if (scope.tenantId !== SINGLE_TENANT_ID) throw new TRPCError({ code: "FORBIDDEN", message: "The global dispatch enforcement setting is not an organization's to read — name your own entity" });
}

/** A stored check the caller's organization may act on, or "not found". */
async function scopedCheck(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, checkId: number, scope: Awaited<ReturnType<typeof dispatchScopeFor>>) {
  const check = (await db.select().from(dispatchEligibilityChecks).where(eq(dispatchEligibilityChecks.id, checkId)).limit(1))[0];
  if (!check || !checkInScope(check, scope)) throw new TRPCError({ code: "NOT_FOUND", message: "Eligibility check not found" });
  return check;
}

export const dispatchGateRouter = router({
  /**
   * The creation door — B12's slot model had none.
   *
   * `dispatchPostings` and `dispatchRoles` had zero production INSERTs anywhere in the tree, so the
   * multi-resource model the schema describes ("a rig move is a lead, winch tractors, a bed truck,
   * a picker and pilot vehicles, each assigned independently") could only ever be populated by a
   * test fixture. These three procedures are that door.
   *
   * Creating a posting is planning, not awarding: nothing here writes a booking, an award audit
   * event, or an eligibility check.
   */
  createPosting: roleProcedure("dispatch.createPosting")
    .input(z.object({
      jobId: z.number().int().positive(),
      distribution: z.enum(["direct_assignment", "public_internal_bid", "invite_only", "selected_pool", "on_call", "emergency", "subcontractor_bid"]).optional(),
      roles: z.array(ROLE_DRAFT).max(40).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const posting = await createPosting({
        jobId: input.jobId, distribution: input.distribution, roles: input.roles,
        actorUserId: ctx.user.id, scope: await scopeOf(ctx.user.id),
      });
      // v23.31 — the posting is the job's activation point: freeze its commercial basis now, so a
      // later rate change never moves what this job is billed under. A job with no customer assigned
      // is not refused here (dispatch owns that decision through the readiness gate); a basis that
      // cannot be frozen (no governing sheet version, contract not active) is reported, not thrown.
      // The scope is resolved after the posting exists; a caller whose money scope cannot be established
      // gets the posting and a refused capture, never a lost posting.
      const commercial = await commercialScope(ctx.user.id, financeScopeFor)
        .then(scope => jobSnapshotCaptureIfReady(scope, { userId: ctx.user.id, roles: ((ctx as { roles?: readonly string[] }).roles ?? []) }, input.jobId))
        .catch((e: unknown) => ({ outcome: "refused" as const, detail: e instanceof Error ? e.message : "commercial scope could not be established" }));
      return { ...posting, commercial };
    }),

  addRole: roleProcedure("dispatch.addRole")
    .input(z.object({ postingId: z.number().int().positive() }).and(ROLE_DRAFT))
    .mutation(async ({ ctx, input }) =>
      addRole({
        postingId: input.postingId,
        draft: {
          roleCode: input.roleCode, roleLabel: input.roleLabel, required: input.required,
          requiredEquipmentClass: input.requiredEquipmentClass, requiredTrailerClass: input.requiredTrailerClass,
        },
        scope: await scopeOf(ctx.user.id),
      })),

  /**
   * Every slot for a job, with the precise staffing picture beside the persisted lifecycle value.
   *
   * The two are never merged. `planningState` cannot express zero-of-N — from `staffed` its only
   * legal backward transition is `partially_staffed` — so `staffing` is what a screen should read
   * and `planningState` is reported as itself.
   */
  listRoles: roleProcedure("dispatch.listRoles")
    .input(z.object({
      jobId: z.number().int().positive().optional(),
      postingId: z.number().int().positive().optional(),
      includeHistory: z.boolean().optional(),
    }))
    .query(async ({ ctx, input }) =>
      listRoles({
        jobId: input.jobId, postingId: input.postingId, includeHistory: input.includeHistory,
        scope: await scopeOf(ctx.user.id),
      })),

  /**
   * Bind or rebind one slot. Which of the two it is, is server state rather than caller intent — a
   * caller declaring "this is a reassignment" while the slot was open is describing what they meant
   * to do, not what happened.
   *
   * `.strict()` is load-bearing: an `eligibilityCheckId` is *refused*, not stripped. Silently
   * ignoring it would let a caller believe they had awarded something, which is the precise
   * confusion `jobUnits.create` created by accepting one and setting `usedForAward`.
   */
  setRoleAssignment: roleProcedure("dispatch.setRoleAssignment")
    .input(z.object({
      roleId: z.number().int().positive(),
      operatorId: z.number().int().positive().nullable(),
      unitId: z.number().int().positive().nullable(),
      trailerId: z.number().int().positive().nullable().optional(),
      /** The head of this slot's own history, as the caller last saw it. Null = "it had none". */
      expectedLastEventId: z.number().int().positive().nullable(),
      reason: z.string().max(500).optional(),
    }).strict())
    .mutation(async ({ ctx, input }) =>
      setRoleAssignment({
        roleId: input.roleId,
        operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null,
        expectedLastEventId: input.expectedLastEventId,
        reason: input.reason ?? null,
        actorUserId: ctx.user.id,
        actorRole: await overrideRoleFor(ctx.user.id),
        scope: await scopeOf(ctx.user.id),
      })),

  /** Return a slot to `open`. Always takes a reason, and destroys nothing. */
  clearRoleAssignment: roleProcedure("dispatch.clearRoleAssignment")
    .input(z.object({
      roleId: z.number().int().positive(),
      expectedLastEventId: z.number().int().positive().nullable(),
      reason: z.string().min(1).max(500),
    }).strict())
    .mutation(async ({ ctx, input }) =>
      clearRoleAssignment({
        roleId: input.roleId,
        expectedLastEventId: input.expectedLastEventId,
        reason: input.reason,
        actorUserId: ctx.user.id,
        actorRole: await overrideRoleFor(ctx.user.id),
        scope: await scopeOf(ctx.user.id),
      })),

  readiness: roleProcedure("dispatch.readiness")
    .input(SUBJECT)
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      await assertReadinessSubjectInScope(db, scope, { operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null, jobId: input.jobId ?? null });
      const r = await composeReadiness({ operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null, jobId: input.jobId ?? null, routeApprovalRef: input.routeApprovalRef ?? null, loneWorker: input.loneWorker });
      // 0170 — the P8.1 picture travels with the verdict. The composer has always computed it and
      // `evaluate` has always stored it, but nothing returned it, so a reader could see that
      // dispatch was blocked and not which capabilities answered, which passed, and which were
      // never asked. That last distinction is the whole point of the contract: a verdict assembled
      // from blockers reads an unevaluated capability's silence as consent, and the only thing that
      // stops a screen doing the same is being told what was not evaluated.
      //
      // Passed through as computed. Nothing is reshaped, renamed, filtered or recombined here —
      // `capabilities` and `capabilityVerdict` are already the consumer-facing vocabulary, their
      // `detail` is the same blocker labels this response already carries, and a second shape
      // would be a second place for the statuses to drift. P8.2's policy snapshot is a separate
      // contract and deliberately stays off this wire.
      return { verdict: r.eligibility.verdict, explanation: r.eligibility.explanation, blockers: r.eligibility.blockers, contributions: r.contributions, capabilities: r.capabilities, capabilityVerdict: r.capabilityVerdict };
    }),

  evaluate: roleProcedure("dispatch.evaluate")
    .input(SUBJECT.extend({ postingId: z.number().int().positive().nullable().optional(), roleId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      // v21.2 — a check is for a posting or for a direct job; it must say which.
      if (!input.postingId && !input.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: "A check needs a postingId or a jobId" });
      const posting = input.postingId ? (await db.select({ id: dispatchPostings.id, jobId: dispatchPostings.jobId }).from(dispatchPostings).where(eq(dispatchPostings.id, input.postingId)).limit(1))[0] : null;
      // C1a — a posting another organization owns is indistinguishable from one that does not exist.
      if (input.postingId && (!posting || !(await jobInScope(posting.jobId, scope)))) throw new TRPCError({ code: "NOT_FOUND", message: "Posting not found" });
      if (posting && input.jobId != null && input.jobId !== posting.jobId) throw new TRPCError({ code: "BAD_REQUEST", message: `Posting ${posting.id} is not for job ${input.jobId}` });
      const now = new Date();
      const jobId = input.jobId ?? posting?.jobId ?? null;
      // C1a — every identity named must belong to the caller's organization; the org is the server's.
      await assertReadinessSubjectInScope(db, scope, { operatorId: input.operatorId, unitId: input.unitId, trailerId: input.trailerId ?? null, jobId });
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
        // 0174: the rules these findings were decided under, and whose check this is.
        ruleSetHash: r.ruleSetHash, orgRef: scope.tenantId,
      });
      return { checkId: Number(ins[0]?.insertId ?? 0), verdict: r.eligibility.verdict, explanation: r.eligibility.explanation, blockers: r.eligibility.blockers, fingerprint: r.fingerprint, evaluatedAt: now, contributions: r.contributions };
    }),

  overrideRequest: roleProcedure("dispatch.overrideRequest")
    .input(z.object({
      checkId: z.number().int().positive(), blockerCode: z.string().min(2).max(80), reason: z.string().min(10).max(600),
      /** C1a — for an APPROVED_POLICY_ONLY finding, the owner-approved override policy relied on. */
      policyRef: z.string().min(1).max(120).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      const check = await scopedCheck(db, input.checkId, scope);
      const blockers = JSON.parse(check.blockersJson ?? "[]") as DispatchBlocker[];
      const blocker = blockers.find(b => b.code === input.blockerCode);
      if (!blocker) throw new TRPCError({ code: "BAD_REQUEST", message: `Blocker ${input.blockerCode} is not on check ${input.checkId}` });
      const role = await overrideRoleFor(ctx.user.id);
      const now = new Date();
      // C1a-2 — refused by CLASS, recorded either way. There is no general manager override: an
      // APPROVED_POLICY_ONLY finding is requestable only under an approved policy that covers it.
      const finding = asFinding(blocker, check.evaluatedAt);
      const policy = finding.overrideClass === "APPROVED_POLICY_ONLY" ? resolveOverridePolicy(input.policyRef ?? null, finding, now) : null;
      const refusal = finding.overrideClass === "NEVER_OVERRIDABLE" ? "This blocker is overridable by no one — the underlying condition must be fixed"
        : finding.overrideClass === "INFORMATIONAL" ? "This finding is informational — there is nothing to override"
        : policy && !policy.ok ? policy.refusal
        : null;
      await db.insert(dispatchOverrides).values({
        eligibilityCheckId: check.id, postingId: check.postingId, blockerCode: input.blockerCode, requestedByUserId: ctx.user.id, requestedByRole: role,
        reason: input.reason, granted: false, refusalReason: refusal, requestedAt: now,
        overrideClass: finding.overrideClass, policyRef: input.policyRef ?? null, orgRef: scope.tenantId,
      });
      return {
        checkId: check.id, blockerCode: input.blockerCode, requestable: !refusal, refusal, overrideClass: finding.overrideClass,
        requiredAuthority: finding.overrideClass === "WARNING_ONLY" ? finding.overrideAuthority ?? "manager" : policy?.ok ? policy.policy.grantorMinimumRole : null,
      };
    }),

  overrideGrant: roleProcedure("dispatch.overrideGrant")
    .input(z.object({ checkId: z.number().int().positive(), blockerCode: z.string().min(2).max(80), reason: z.string().min(10).max(600) }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      const check = await scopedCheck(db, input.checkId, scope);
      const blocker = (JSON.parse(check.blockersJson ?? "[]") as DispatchBlocker[]).find(b => b.code === input.blockerCode);
      if (!blocker) throw new TRPCError({ code: "BAD_REQUEST", message: `Blocker ${input.blockerCode} is not on check ${input.checkId}` });
      const pending = (await db.select().from(dispatchOverrides).where(and(eq(dispatchOverrides.eligibilityCheckId, check.id), eq(dispatchOverrides.blockerCode, input.blockerCode))).orderBy(desc(dispatchOverrides.requestedAt)).limit(1))[0];
      if (!pending) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No override request on record — a grant answers a request" });
      if (pending.requestedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The requester may not grant their own override" });
      const role = await overrideRoleFor(ctx.user.id);
      const now = new Date();
      // Decided on the GRANTOR's authority, under the policy the request named.
      const outcome = requestOverride(blocker, { blockerCode: input.blockerCode, requestedByUserId: ctx.user.id, requestedByRole: role, reason: input.reason, policyRef: pending.policyRef }, now);
      /*
       * C1a-3 — the grant is recorded as the grantor's act: who, in what role, when, why, under which
       * policy, for which check and code, and until when. Before 0174 only `granted` flipped, and the
       * award path then named the REQUESTER as the grantor.
       */
      await db.update(dispatchOverrides).set(outcome.granted
        ? {
            granted: true, refusalReason: null,
            grantedByUserId: ctx.user.id, grantedByRole: role, grantedAt: now, grantReason: input.reason,
            overrideClass: outcome.overrideClass, policyRef: outcome.policy?.policyRef ?? null, policyVersion: outcome.policy?.version ?? null,
            scopeJson: JSON.stringify({ checkId: check.id, blockerCode: input.blockerCode, orgRef: scope.tenantId }),
            expiresAt: new Date(now.getTime() + 60_000 * (outcome.policy?.maxValidityMinutes ?? ACKNOWLEDGEMENT_VALIDITY_MINUTES)),
          }
        : { granted: false, refusalReason: outcome.refusal }).where(eq(dispatchOverrides.id, pending.id));
      return outcome.granted
        ? { granted: true as const, checkId: check.id, blockerCode: input.blockerCode, grantedByRole: role, grantedByUserId: ctx.user.id, requestedByUserId: pending.requestedByUserId }
        : { granted: false as const, checkId: check.id, blockerCode: input.blockerCode, refusal: outcome.refusal };
    }),

  award: roleProcedure("dispatch.award")
    .input(z.object({ checkId: z.number().int().positive(), startsAt: z.coerce.date(), endsAt: z.coerce.date(), maxAgeMinutes: z.number().int().positive().max(240).default(30) }))
    .mutation(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      const check = await scopedCheck(db, input.checkId, scope);
      // v21.2 — a check recorded for a direct job assignment is not a posting award.
      if (check.postingId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This check is for a direct job assignment — award applies to a posting. Assign the job's dispatch roles with dispatch.setRoleAssignment, then award the posting those roles belong to" });
      const posting = (await db.select({ jobId: dispatchPostings.jobId }).from(dispatchPostings).where(eq(dispatchPostings.id, check.postingId)).limit(1))[0];
      if (!posting || !(await jobInScope(posting.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: "Posting not found" });
      const now = new Date();
      // The facts are recomputed here, never accepted from the caller.
      // v22.18 — the recompute asks the same question the check asked, route
      // included. Without the route the facts would be a smaller set than the
      // ones the fingerprint was taken over, and every award would refuse.
      // The work end is asked here, where it is known: the driver portfolio judges every mandatory
      // credential through `endsAt`. The work end is not part of the fingerprint, so the check still matches.
      const current = await composeReadiness({ operatorId: check.operatorId, unitId: check.unitId, trailerId: check.trailerId, jobId: posting?.jobId ?? null, routeApprovalRef: check.routeApprovalRef, workEndsAt: input.endsAt }, now);
      // The one gate's own finding, not a second decision: a mandatory credential that lapses before
      // the awarded work ends is a hard block, and no stored check made without the end can clear it.
      const lapsing = current.driverReadiness.items.filter(i => i.enforcement === "mandatory" && i.state === "expires_during_job");
      if (lapsing.length) {
        return { ok: false as const, refusals: lapsing.map(i => `driver_${i.kind}_${i.code}_expires_during_job`), explanation: lapsing.map(i => i.detail).join("; ") };
      }
      // C1a-3 — the grantor recorded at grant time. This used to read `requestedByUserId` into the grantor.
      const grantedOverrides = await loadGrantedOverrides(db, check.id);
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
      const { db, scope } = await scopedDb(ctx.user.id);
      await assertEnforcementScope(db, scope, input.financialEntityId ?? null, ctx.user.id, "write");
      const before = await loadEnforcementMode(input.financialEntityId ?? null);
      await db.insert(dispatchEnforcementSettings).values({ financialEntityId: input.financialEntityId ?? null, mode: input.mode, reason: input.reason, setByUserId: ctx.user.id, setAt: new Date() });
      return { scope: input.financialEntityId ?? "global", previous: before.mode, mode: input.mode };
    }),

  enforcementGet: roleProcedure("dispatch.enforcementGet")
    .input(z.object({ financialEntityId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      await assertEnforcementScope(db, scope, input?.financialEntityId ?? null, ctx.user.id, "read");
      return loadEnforcementMode(input?.financialEntityId ?? null);
    }),

  /** The operator's own readiness, as a checklist. Reads ctx.user.id; nobody else's. */
  whatAmIMissing: roleProcedure("dispatch.whatAmIMissing")
    .input(z.object({ unitId: z.number().int().positive().nullable().optional(), jobId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scopedDb(ctx.user.id);
      const me = (await db.select({ id: operators.id }).from(operators).where(eq(operators.userId, ctx.user.id)).limit(1))[0];
      if (!me) return { verdict: "unknown" as const, items: [], note: "No operator record is linked to your user" };
      // C1a — the operator is the caller's own, but the unit and job are named by the caller.
      await assertReadinessSubjectInScope(db, scope, { operatorId: me.id, unitId: input?.unitId ?? null, jobId: input?.jobId ?? null });
      const r = await composeReadiness({ operatorId: me.id, unitId: input?.unitId ?? null, trailerId: null, jobId: input?.jobId ?? null });
      return { ...asChecklist(r.eligibility), note: undefined };
    }),
});

