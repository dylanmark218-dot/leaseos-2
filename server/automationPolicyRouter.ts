/**
 * P8.2 — the automation policy surface.
 *
 * Two permissions, and the gap between them is the design:
 *
 *   `automation.policy.manage`         change what governs future decisions — management only;
 *   `automation.override.operational`  take one task toward MORE human involvement — held widely.
 *
 * The second cannot become a route around the first because it only moves one way. Choosing to do
 * something yourself needs no approval; deciding a machine may do it unwatched is a policy change.
 * A single "override" permission would have collapsed those, and an operational convenience would
 * quietly have become an automation decision nobody signed off.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { automationPolicies, capabilityEntitlements } from "../drizzle/schema";
import { evaluateOperationalOverride, snapshotOf, type AutomationMode } from "./_core/automationPolicy";
import { ceilingFor, resolveCapability, writeEntitlement, writePolicy } from "./_core/automationPolicyStore";
import { resolveActingScope } from "./_core/actingScope";

const MODE = z.enum(["AUTO", "HYBRID", "MANUAL"]);
const SCOPE = z.enum(["tenant", "role", "task", "customer"]);

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

export const automationPolicyRouter = router({
  /** What governs this capability right now, with the whole trace — not only the mode. */
  resolve: roleProcedure("automationPolicy.resolve")
    .input(z.object({
      capability: z.string().min(1).max(64),
      role: z.string().max(64).nullish(),
      task: z.string().max(64).nullish(),
      customer: z.string().max(64).nullish(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const acting = await resolveActingScope(db, ctx.user.id);
      const r = await resolveCapability(acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId, input.capability, {
        role: input.role ?? null, task: input.task ?? null, customer: input.customer ?? null,
      });
      return r;
    }),

  /** Change standing policy. Append-only: the previous version is superseded, never rewritten. */
  set: roleProcedure("automationPolicy.set")
    .input(z.object({
      capability: z.string().min(1).max(64),
      scope: SCOPE,
      scopeId: z.string().max(64).nullish(),
      requestedMode: MODE,
      reason: z.string().min(10).max(500),
      source: z.string().min(2).max(64).default("person"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const acting = await resolveActingScope(db, ctx.user.id);
      if (input.scope === "tenant" && input.scopeId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A tenant default names no scope id" });
      }
      if (input.scope !== "tenant" && !input.scopeId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `A ${input.scope} policy must name the ${input.scope} it applies to` });
      }
      const written = await writePolicy({
        orgRef: acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId,
        capability: input.capability, scope: input.scope, scopeId: input.scopeId ?? null,
        requestedMode: input.requestedMode, source: input.source, reason: input.reason, actorUserId: ctx.user.id,
      });
      /*
       * The ceiling is reported back rather than silently applied to the stored row. A person who
       * asked for AUTO under a HYBRID ceiling should be told their request was clamped, not left to
       * discover it from behaviour — and the row keeps what they asked for, because a row that
       * stored the clamped value would report a decision they never made.
       */
      const ceiling = ceilingFor(input.capability);
      const clamped = ceiling != null && input.requestedMode === "AUTO" && ceiling.maxMode !== "AUTO";
      return {
        ...written,
        clamped,
        note: clamped
          ? `Recorded as requested (${input.requestedMode}), but the ${ceiling!.maxMode} safety ceiling governs, so decisions will resolve to ${ceiling!.maxMode}.`
          : `Recorded. Previous version${written.supersededVersionIds.length === 1 ? "" : "s"} superseded, not rewritten: an earlier decision still resolves under the policy that governed it.`,
      };
    }),

  /** Whether a capability is available to this tenant at all. Separate question, separate row. */
  setEntitlement: roleProcedure("automationPolicy.setEntitlement")
    .input(z.object({
      capability: z.string().min(1).max(64),
      state: z.enum(["entitled", "not_entitled"]),
      reason: z.enum(["unlicensed", "disabled", "not_in_product_set"]).nullish(),
      reference: z.string().max(128).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const acting = await resolveActingScope(db, ctx.user.id);
      await writeEntitlement({
        orgRef: acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId,
        capability: input.capability, state: input.state,
        reason: input.reason ?? null, reference: input.reference ?? null, setByUserId: ctx.user.id,
      });
      return {
        capability: input.capability, state: input.state,
        note: input.state === "not_entitled"
          ? "Recorded. This capability now reports NOT_EVALUATED to its consumers; it has no automation mode, which is a different thing from being set to MANUAL."
          : "Recorded. With no automation policy configured it resolves to MANUAL — a missing policy is not permission to automate.",
      };
    }),

  /**
   * A one-task or one-trip move toward more human involvement. Refused in the other direction for
   * everyone holding only this permission, whatever their role.
   */
  operationalOverride: roleProcedure("automationPolicy.operationalOverride")
    .input(z.object({
      capability: z.string().min(1).max(64),
      from: MODE, to: MODE,
      scope: z.enum(["one_task", "one_trip"]),
      reason: z.string().min(5).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const decision = evaluateOperationalOverride({ from: input.from, to: input.to, actorRole: "operational", scope: input.scope });
      if (!decision.allowed) throw new TRPCError({ code: "FORBIDDEN", message: decision.reason });
      return { capability: input.capability, mode: decision.mode, appliesTo: input.scope, note: decision.reason, actorUserId: ctx.user.id };
    }),

  /** The version history behind a capability, so "what governed us in May" is answerable. */
  history: roleProcedure("automationPolicy.history")
    .input(z.object({ capability: z.string().min(1).max(64), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const acting = await resolveActingScope(db, ctx.user.id);
      const orgRef = acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId;
      const rows = await db.select().from(automationPolicies).where(and(
        eq(automationPolicies.capability, input.capability),
        orgRef == null ? isNull(automationPolicies.orgRef) : eq(automationPolicies.orgRef, orgRef),
      )).orderBy(desc(automationPolicies.effectiveFrom)).limit(input.limit);
      const entitlements = await db.select().from(capabilityEntitlements).where(and(
        eq(capabilityEntitlements.capability, input.capability),
        orgRef == null ? isNull(capabilityEntitlements.orgRef) : eq(capabilityEntitlements.orgRef, orgRef),
      )).orderBy(desc(capabilityEntitlements.effectiveFrom)).limit(input.limit);
      return { capability: input.capability, policies: rows, entitlements };
    }),

  /** The snapshot a consequential decision should keep. Exposed so callers do not reinvent it. */
  snapshotFor: roleProcedure("automationPolicy.snapshotFor")
    .input(z.object({ capability: z.string().min(1).max(64), role: z.string().max(64).nullish(), task: z.string().max(64).nullish(), customer: z.string().max(64).nullish() }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const acting = await resolveActingScope(db, ctx.user.id);
      const r = await resolveCapability(acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId, input.capability, {
        role: input.role ?? null, task: input.task ?? null, customer: input.customer ?? null,
      });
      return snapshotOf(r, { actorUserId: ctx.user.id });
    }),
});

export type { AutomationMode };
