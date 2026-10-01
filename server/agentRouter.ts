/**
 * v22.20 (0100) — agent work that outlives the conversation.
 *
 * `_core/actionGateway.ts` decides; this remembers. The two facts that make
 * this an agent runtime rather than a chat log:
 *
 * **Every action goes through the gateway, and every decision is recorded.** A
 * refusal is a row, not a silence. Six months later "why did nothing happen"
 * has an answer with a reason code attached, which is the difference between an
 * audit trail and a hope.
 *
 * **The run state is the database's, not the model's.** A status is set by
 * transitions this file allows. An agent that could write its own status could
 * write `completed`.
 *
 * Deliberately absent: any capability that executes. This checkpoint proves the
 * boundary holds — request, decide, record, wait — before anything is wired to
 * a real mutation. Executing capabilities land on top of a gateway that has
 * already been shown to refuse correctly, not alongside one that hasn't.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { agentActions, agentApprovals, agentRuns, agentSteps } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { permissionsFor } from "./_core/recordsAuthorization";
import { listActiveUserRoleNames } from "./db";
import {
  buildRegistry, decide, idempotencyKey, NEVER_AUTONOMOUS,
  type ActionRequest, type CapabilityDefinition,
} from "./_core/actionGateway";

/**
 * Hash a payload the same way twice.
 *
 * Keys sorted at every level, so two structurally identical payloads that were
 * serialised in different orders produce one hash. Without that, an approval
 * fails to match a re-send of the very thing that was approved.
 */
function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

/**
 * What the Secretary may currently ask for.
 *
 * Read and prepare only. Nothing here commits anything, which is the point of
 * this checkpoint: prove the gateway refuses correctly before giving it
 * anything that could be wrongly allowed.
 */
const CAPABILITIES: CapabilityDefinition[] = [
  { key: "jobs.read", description: "Read a job", riskLevel: "read", requiredPermissions: ["job.read"], requiresOnline: true, idempotent: true },
  { key: "fleet.readUnit", description: "Read a unit", riskLevel: "read", requiredPermissions: ["fleet.read"], requiresOnline: true, idempotent: true },
  { key: "billing.prepareInvoice", description: "Draft an invoice without issuing it", riskLevel: "prepare", requiredPermissions: ["billing.read"], requiresOnline: true, idempotent: true },
  { key: "messaging.sendReminder", description: "Send an internal reminder", riskLevel: "low_risk_action", requiredPermissions: ["board.post"], requiresOnline: true, idempotent: true },
  { key: "billing.issueInvoice", description: "Issue an invoice to a customer", riskLevel: "approval_required", requiredPermissions: ["billing.write"], requiresOnline: true, idempotent: true },
  { key: "compliance.override", description: "Override a compliance block", riskLevel: "restricted", requiredPermissions: ["billing.write"], requiresOnline: true, idempotent: false },
];
export const AGENT_CAPABILITIES = CAPABILITIES;
const REGISTRY = buildRegistry(CAPABILITIES);

/** Transitions LeaseOS permits. Anything else is refused. */
const TRANSITIONS: Record<string, readonly string[]> = {
  created: ["planning", "executing", "cancelled"],
  planning: ["ready", "blocked", "failed", "cancelled"],
  ready: ["executing", "waiting_for_approval", "cancelled"],
  executing: ["executing", "waiting_for_input", "waiting_for_event", "waiting_for_approval", "retry_scheduled", "blocked", "completed", "failed"],
  waiting_for_event: ["executing", "cancelled", "failed"],
  waiting_for_approval: ["executing", "blocked", "cancelled"],
  waiting_for_input: ["executing", "cancelled"],
  retry_scheduled: ["executing", "failed"],
  blocked: ["executing", "cancelled", "failed"],
  paused: ["executing", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export const agentRouter = router({
  /** Start a durable run. The goal lives in the database, not a prompt. */
  start: roleProcedure("agent.start")
    .input(z.object({
      goal: z.string().min(4).max(600),
      agentKey: z.string().max(60).default("secretary"),
      plan: z.array(z.object({ capability: z.string().max(80) })).max(40).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const runRef = ref("AR");
      const unknown = input.plan.map(s => s.capability).filter(c => !REGISTRY.has(c));
      if (unknown.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Not registered capabilities: ${unknown.join(", ")}. A plan cannot name a capability that does not exist.` });
      }
      await d.transaction(async (tx) => {
        await tx.insert(agentRuns).values({
          runRef, tenantId: acting.tenantId, agentKey: input.agentKey, goal: input.goal,
          status: input.plan.length ? "ready" : "created", initiatedByUserId: ctx.user.id,
        });
        for (let i = 0; i < input.plan.length; i++) {
          const step = input.plan[i];
          await tx.insert(agentSteps).values({ runRef, stepNumber: i + 1, capability: step.capability, status: "planned" });
        }
      });
      return { runRef, steps: input.plan.length, note: "The plan is stored. A restart resumes from the last completed step rather than starting again." };
    }),

  /**
   * Ask to do something.
   *
   * The gateway decides and the decision is written whatever it is. An idempotent
   * retry returns the original decision rather than making a second one.
   */
  requestAction: roleProcedure("agent.requestAction")
    .input(z.object({
      runRef: z.string().min(1).max(64),
      capability: z.string().min(1).max(80),
      target: z.object({ entityType: z.string().max(60), entityId: z.string().max(120), revision: z.number().int().nullable().default(null) }),
      /**
       * The payload itself, not a hash of it.
       *
       * A caller-supplied hash proves that the string presented at approval
       * equals the string presented at execution — not that the thing approved
       * equals the thing done. The server canonicalises and hashes, so the
       * approval binds to the payload rather than to the caller's description
       * of it.
       */
      payload: z.record(z.string(), z.unknown()).default({}),
      reasoningSummary: z.string().max(600).default(""),
      evidenceRefs: z.array(z.string().max(64)).max(20).default([]),
      requestId: z.string().max(64).default(() => ref("REQ")),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const run = (await d.select().from(agentRuns).where(eq(agentRuns.runRef, input.runRef)).limit(1))[0];
      if (!run || run.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such run" });

      // Server-owned facts, none of them assertable over the wire.
      //
      // `origin`: a request arriving here is an authorized user asking, full
      // stop. `company_policy` outranks `authorized_user` on the instruction
      // ladder, so accepting it would have been a laundering step waiting for
      // future logic to honour the ranking.
      //
      // `compliance`: a caller saying "compliance: pass" is a claim, and the
      // gateway treats it as authoritative. Until a deterministic engine is
      // called from here, the honest value is none — and the gateway reads a
      // missing verdict as nothing established rather than as approval.
      //
      // `actualRevision`: the caller may say which revision it read; only the
      // server can say which revision is current, and the whole point of the
      // stale check is to catch a human edit the caller has not seen.
      const origin = "authorized_user" as const;
      const compliance = null;
      const actualRevision: number | null = null;
      const payloadHash = canonicalHash(input.payload);

      const request: ActionRequest = {
        requestId: input.requestId, runId: input.runRef, capability: input.capability,
        // Always the agent. An action requested through the agent runtime is
        // the agent acting, whoever asked for it — letting the caller say
        // "user" would walk straight past the capabilities an agent may never
        // perform, since that check turns on exactly this field. A person who
        // wants to do the thing themselves uses the domain procedure, not the
        // agent's mouth.
        actor: { type: "agent", id: `AGENT-${run.agentKey.toUpperCase()}` },
        delegatedByUserId: String(ctx.user.id),
        target: input.target, payloadHash, origin,
        reasoningSummary: input.reasoningSummary, evidenceRefs: input.evidenceRefs,
      };
      const key = idempotencyKey(request);

      const already = (await d.select().from(agentActions).where(eq(agentActions.idempotencyKey, key)).limit(1))[0];
      if (already) {
        // The key identifies the request; the hash identifies what it asked
        // for. Matching on the key alone would let a second call under the same
        // request id carry a different payload and be told "this exact request
        // was already decided" — which would be false, and false in the
        // direction of the caller's choosing. Putting the hash in the key
        // instead would make that a *second* action, which is worse: the retry
        // that was meant to be safe becomes a duplicate.
        if (already.payloadHash !== payloadHash) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${input.requestId} was already decided with a different payload. A retry replays; a changed payload needs its own request id.`,
          });
        }
        return {
          actionRef: already.actionRef, decision: already.decision,
          reasons: JSON.parse(already.decisionReasons) as string[],
          replayed: true,
          note: "This exact request was already decided. A retry returns the original answer rather than deciding twice.",
        };
      }

      // A finished run takes no new action. "Finished" is read from TRANSITIONS
      // rather than listed again: a status with nowhere to go (completed, failed,
      // cancelled — or one the table does not know) would otherwise be reopened
      // by the waiting_for_approval / blocked writes below. A replay has already
      // returned above: it reads back a decision, it does not make one.
      if ((TRANSITIONS[run.status] ?? []).length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `This run is ${run.status} and takes no new action. Start a new run.`,
        });
      }

      // Asking for the first action is what starts the run. Without this a
      // ready run could never reach any waiting state.
      if (run.status === "ready" || run.status === "created") {
        await d.update(agentRuns).set({ status: "executing" }).where(eq(agentRuns.runRef, input.runRef));
      }

      const roles = await listActiveUserRoleNames(ctx.user.id);
      // Fetch by run and capability, not by the hash being asked about: looking
      // it up by the new hash finds nothing and reports "needs a person", which
      // hides the more useful fact that an approval exists and is for something
      // else. The gateway compares and says so.
      const approval = (await d.select().from(agentApprovals).where(and(
        eq(agentApprovals.runRef, input.runRef), eq(agentApprovals.capability, input.capability), eq(agentApprovals.decision, "approved"),
      )).limit(1))[0];

      const decision = decide(request, {
        registry: REGISTRY,
        heldPermissions: permissionsFor(roles),
        online: true,
        compliance,
        actualRevision,
        autoExecute: [],
        approvalForPayloadHash: approval?.payloadHash ?? null,
      });

      const actionRef = ref("ACT");
      await d.insert(agentActions).values({
        actionRef, runRef: input.runRef, capability: input.capability,
        actorType: request.actor.type, actorId: request.actor.id,
        delegatedByUserId: ctx.user.id,
        targetEntityType: input.target.entityType, targetEntityId: input.target.entityId,
        payloadHash, origin,
        decision: decision.decision, decisionReasons: JSON.stringify(decision.reasons),
        outcome: "requested", idempotencyKey: key, requestedAt: new Date(),
      });

      // A decision that needs a person creates the thing they act on.
      let approvalRef: string | null = null;
      if (decision.decision === "require_approval") {
        approvalRef = ref("APR");
        await d.insert(agentApprovals).values({
          approvalRef, runRef: input.runRef, capability: input.capability,
          targetEntityId: input.target.entityId, payloadHash,
          requestedAt: new Date(), decision: "pending",
        });
        await d.update(agentRuns).set({ status: "waiting_for_approval" }).where(eq(agentRuns.runRef, input.runRef));
      }
      if (decision.decision === "compliance_block" || decision.decision === "deny") {
        await d.update(agentRuns).set({ status: "blocked", blockedReason: decision.reasons[0] ?? null }).where(eq(agentRuns.runRef, input.runRef));
      }

      return { actionRef, decision: decision.decision, reasons: decision.reasons, approvalRef, replayed: false };
    }),

  /** A person decides. The approval binds to the payload it was shown. */
  decideApproval: roleProcedure("agent.decideApproval")
    .input(z.object({ approvalRef: z.string().min(1).max(64), decision: z.enum(["approved", "rejected"]), note: z.string().max(600).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const approval = (await d.select().from(agentApprovals).where(eq(agentApprovals.approvalRef, input.approvalRef)).limit(1))[0];
      if (!approval) throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      const run = (await d.select().from(agentRuns).where(eq(agentRuns.runRef, approval.runRef)).limit(1))[0];
      if (!run || run.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      if (approval.decision !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That approval is already ${approval.decision}` });
      if (NEVER_AUTONOMOUS.includes(approval.capability) && run.initiatedByUserId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "The person who asked for this cannot also be the one who approves it" });
      }
      await d.update(agentApprovals)
        .set({ decision: input.decision, decidedByUserId: ctx.user.id, decidedAt: new Date(), note: input.note ?? null })
        .where(and(eq(agentApprovals.approvalRef, input.approvalRef), eq(agentApprovals.decision, "pending")));
      return {
        approvalRef: input.approvalRef, decision: input.decision,
        note: "Bound to the payload that was shown. If it changes, this approval no longer covers it.",
      };
    }),

  /** Park a run until something happens. */
  awaitEvent: roleProcedure("agent.awaitEvent")
    .input(z.object({ runRef: z.string().min(1).max(64), event: z.string().min(1).max(120), filter: z.record(z.string(), z.string()).default({}) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const run = (await d.select().from(agentRuns).where(eq(agentRuns.runRef, input.runRef)).limit(1))[0];
      if (!run || run.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such run" });
      if (!(TRANSITIONS[run.status] ?? []).includes("waiting_for_event")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A run cannot go from ${run.status} to waiting_for_event` });
      }
      await d.update(agentRuns).set({ status: "waiting_for_event", awaitingEvent: input.event, awaitingFilterJson: JSON.stringify(input.filter) })
        .where(eq(agentRuns.runRef, input.runRef));
      return { runRef: input.runRef, awaiting: input.event, note: "Parked. Nothing polls; the event wakes it." };
    }),

  /** The run, its plan, its actions and what it is waiting for. */
  get: roleProcedure("agent.get")
    .input(z.object({ runRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const run = (await d.select().from(agentRuns).where(eq(agentRuns.runRef, input.runRef)).limit(1))[0];
      if (!run || run.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such run" });
      const steps = await d.select().from(agentSteps).where(eq(agentSteps.runRef, input.runRef)).orderBy(asc(agentSteps.stepNumber));
      const actions = await d.select().from(agentActions).where(eq(agentActions.runRef, input.runRef)).orderBy(asc(agentActions.id)).limit(200);
      return {
        runRef: run.runRef, goal: run.goal, status: run.status,
        awaitingEvent: run.awaitingEvent, blockedReason: run.blockedReason,
        steps: steps.map(s => ({ stepNumber: s.stepNumber, capability: s.capability, status: s.status, reason: s.reason })),
        actions: actions.map(a => ({
          actionRef: a.actionRef, capability: a.capability, decision: a.decision,
          reasons: JSON.parse(a.decisionReasons) as string[],
          actorType: a.actorType, actorId: a.actorId, delegatedByUserId: a.delegatedByUserId,
        })),
        note: "Every attempt is here, including the refused ones — a refusal is something that happened.",
      };
    }),
});
