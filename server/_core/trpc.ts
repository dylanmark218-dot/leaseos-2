import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

/**
 * Procedure metadata. `moneyScoped` marks a procedure whose handler receives the caller's money
 * boundary (`ctx.money`); `financeScopeCoverage.test.ts` reads the mark from the live router, so a
 * finance procedure added without it fails CI rather than a code review.
 */
export type ProcedureMeta = { moneyScoped?: true };

const t = initTRPC.context<TrpcContext>().meta<ProcedureMeta>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  })
);

/* ==================================================================
 * Domain role enforcement (B20.2)
 * ================================================================== */

import {
  authorize,
  isSensitivePermission,
  permissionForProcedure,
  SESSION_PROCEDURE_PERMISSIONS,
  type Permission,
  type RoleGrant, type ProcedureName, type SessionProcedureName } from "./recordsAuthorization";
import { listActiveUserRoles, listRoleGrantsInActingOrganization, recordAuthorizationDecision } from "../db";
import { AmbiguousOrganization, MembershipRevoked } from "./actingScope";

/**
 * Enforces a domain permission server-side.
 *
 * `protectedProcedure` only asks whether someone is logged in. Every records,
 * safety and maintenance procedure needs to ask *who* — and to ask it here
 * rather than trusting a disabled button, because a disabled button is a
 * suggestion and this is the gate.
 *
 * Every decision is recorded, denials included. A refused attempt to open an
 * incident investigation is exactly what an audit wants to see, and exactly
 * what a permissive system never captures.
 */
export function roleProcedure(procedureName: ProcedureName) {
  const permission: Permission | null = permissionForProcedure(procedureName);

  if (!permission) {
    // Wiring-time failure, not a runtime fallback. An unmapped procedure must
    // not quietly degrade to authenticated-only.
    throw new Error(
      `No permission mapped for procedure "${procedureName}" — add it to RECORDS_PROCEDURE_PERMISSIONS`
    );
  }

  return t.procedure.use(
    t.middleware(async ({ ctx, next }) => {
      const userId = ctx.user?.id ?? null;

      // B23.1 — the decision is made IN an organization, or it is not made.
      //
      // The gate resolves which company this request is acting for and loads
      // only the grants that company issued. A role granted by another
      // employer is not "outvoted" here, it is absent: it never enters the set
      // the decision is computed from. That is what makes the boundary hold
      // for all ~650 gated procedures without any of them being edited.
      //
      // The two refusals `resolveActingScope` raises are authority answers,
      // not faults, and are translated below rather than escaping as a 500.
      let grants: RoleGrant[] = [];
      let organization: string | null = null;
      try {
        if (userId) {
          const scoped = await listRoleGrantsInActingOrganization(userId);
          grants = scoped.grants;
          organization = scoped.organization;
        }
      } catch (error) {
        const refusal = organizationRefusal(error);
        if (!refusal) throw error;
        await recordAuthorizationDecision({
          actorUserId: userId,
          procedureName,
          permission,
          rolesHeld: null,
          outcome: "denied_scope",
          detail: refusal.message.slice(0, 400),
          occurredAt: new Date(),
        });
        throw refusal;
      }

      const decision = authorize({ userId, grants, permission, organization });

      const auditId = await recordAuthorizationDecision({
        actorUserId: userId,
        procedureName,
        permission,
        // The organization is part of the decision now, so it is part of the
        // record of it. An access review that cannot tell which company a
        // refusal happened in cannot review anything.
        rolesHeld:
          [
            organization ? `@${organization}` : null,
            ...grants.map(g => (g.scopeRef ? `${g.role}/${g.scopeRef}` : g.role)),
          ]
            .filter(Boolean)
            .join(",")
            .slice(0, 300) || null,
        outcome: decision.outcome,
        detail: decision.detail?.slice(0, 400) ?? null,
        occurredAt: new Date(),
      });

      // Audit failure policy, stated rather than accidental.
      //
      // Sensitive actions fail closed: granting a role, releasing a legal hold
      // or signing a mechanic release with no record of who authorized it is
      // worse than refusing. Ordinary reads proceed — losing an access log line
      // is not a reason to take the records vault offline — and the gap is
      // still visible because the decision row is simply absent.
      if (decision.allowed && auditId === undefined && isSensitivePermission(permission)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            `Authorization trail could not be recorded for ${permission} — refused rather than acting unrecorded`,
        });
      }

      if (!decision.allowed) {
        throw new TRPCError({
          code:
            decision.outcome === "denied_unauthenticated"
              ? "UNAUTHORIZED"
              : "FORBIDDEN",
          // Named, like every other gate in the system. "Not permitted" tells
          // an operator nothing they can act on.
          message: decision.detail ?? `Requires ${permission}`,
        });
      }

      // v23.26 — an unresolved organization is a question, not a crash.
      //
      // `resolveActingScope` refuses rather than guesses when a person is a
      // live member of two companies and has selected neither. That refusal is
      // correct and stays; what was wrong is that it surfaced as an
      // INTERNAL_SERVER_ERROR, which tells the shell nothing it can act on and
      // tells an operator the system is broken when it is in fact protecting
      // them. Translated once, here, so every one of the ~100 tenant-scoped
      // procedures behind this gate gets the actionable answer — and again for
      // the handlers that resolve their own scope after the gate has passed.
      try {
        return await next({
          ctx: {
            ...ctx,
            user: ctx.user!,
            roles: decision.effectiveRoles,
            // B23.1 — the organization the gate decided in, for handlers that
            // would otherwise resolve it a second time and could resolve it
            // differently.
            organization,
          },
        });
      } catch (error) {
        const refusal = organizationRefusal(error);
        if (refusal) throw refusal;
        throw error;
      }
    })
  );
}

/**
 * The two organization refusals, as named tRPC errors.
 *
 * One function because the gate raises them in two places — resolving the
 * acting organization before the decision, and again from a handler that
 * resolves its own scope afterwards — and two copies of a refusal is two
 * chances for one of them to say something different.
 *
 * Returns null for anything else, so a real fault is never swallowed into a
 * FORBIDDEN that hides it.
 */
function organizationRefusal(error: unknown): TRPCError | null {
  if (error instanceof AmbiguousOrganization) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Choose which organization you are working in before continuing.",
    });
  }
  // A membership that ended is a refusal, and it is the caller's own status
  // rather than a fault — FORBIDDEN, named, not a 500.
  if (error instanceof MembershipRevoked) {
    return new TRPCError({
      code: "FORBIDDEN",
      message: "Your LeaseOS membership is not active.",
    });
  }
  return null;
}

/* ==================================================================
 * v23.26 — sessionProcedure: the "authenticated, not yet authorized" gate.
 *
 * There is exactly one question a signed-in person may ask before holding any
 * domain role: *what am I allowed to open?* `roleProcedure` cannot answer it —
 * it refuses a caller with no role, which is precisely the caller who needs to
 * be told "no LeaseOS workspace is assigned to you yet" rather than shown a
 * blank screen. `publicProcedure` cannot answer it either: the answer names a
 * person's organizations and roles and must never be served to an anonymous
 * request.
 *
 * So: authentication required, no role required, every decision audited
 * through the same table as every other gate, and the set of procedure names
 * that may use it pinned in `SESSION_PROCEDURE_PERMISSIONS`. That last part is
 * what stops this becoming the hole the census exists to catch — a new
 * procedure cannot hide behind a builder the drift guard does not count.
 * ================================================================== */

export function sessionProcedure(procedureName: SessionProcedureName) {
  const permission = SESSION_PROCEDURE_PERMISSIONS[procedureName];
  if (!permission) {
    throw new Error(
      `No session permission mapped for procedure "${procedureName}" — add it to SESSION_PROCEDURE_PERMISSIONS`
    );
  }

  return t.procedure.use(
    t.middleware(async ({ ctx, next }) => {
      const userId = ctx.user?.id ?? null;
      const now = new Date();

      if (!userId) {
        await recordAuthorizationDecision({
          actorUserId: null,
          procedureName,
          permission,
          rolesHeld: null,
          outcome: "denied_unauthenticated",
          detail: "No authenticated session",
          occurredAt: now,
        });
        throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
      }

      // Recorded as allowed because it IS allowed: being signed in is the whole
      // requirement. What the caller may then DO is decided by every other gate,
      // each of which writes its own row.
      const grants: RoleGrant[] = await listActiveUserRoles(userId);
      await recordAuthorizationDecision({
        actorUserId: userId,
        procedureName,
        permission,
        rolesHeld:
          grants
            .map(g => (g.scopeRef ? `${g.role}@${g.scopeRef}` : g.role))
            .join(",")
            .slice(0, 300) || null,
        outcome: "allowed",
        detail: null,
        occurredAt: now,
      });

      return next({ ctx: { ...ctx, user: ctx.user!, grants } });
    })
  );
}

/* ==================================================================
 * F1 — the money boundary on a role-authorized procedure
 * ================================================================== */

import { financeScopeFor, type FinanceScope } from "./entityScope";
import { getDb } from "../db";

/**
 * `roleProcedure` answers "may this person do this kind of thing"; this answers "in which books".
 * The caller's organization, and the financial entities (books) it owns, are resolved from the
 * membership — never from input — and handed to the handler as `ctx.money`. Every record the handler
 * reads or writes is proved against it (`server/financeScope.ts`); one that fails is "not found".
 *
 * Wraps rather than replaces `roleProcedure(...)` so the permission map, the authorization trail and
 * the pinned procedure counts are untouched.
 */
export function moneyScoped(procedure: ReturnType<typeof roleProcedure>) {
  return procedure.meta({ moneyScoped: true }).use(async ({ ctx, next }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const money: FinanceScope = await financeScopeFor(db, ctx.user.id);
    return next({ ctx: { ...ctx, money } });
  });
}

/* ==================================================================
 * v21.10 — externalProcedure: the portal gate.
 *
 * Built like roleProcedure and no weaker: the permission map is consulted at
 * wiring time; the bearer token in `x-portal-token` (or `Authorization:
 * Portal <token>`) is hashed and resolved to exactly one active identity;
 * the identity's kind decides its permissions and its binding decides its
 * scope — the request never says whose data it wants; every decision is an
 * audit row; a write is refused when the audit row cannot be written.
 * ================================================================== */

import { createHash } from "node:crypto";
import { EXTERNAL_KIND_PERMISSIONS, EXTERNAL_SENSITIVE_PERMISSIONS, externalPermissionForProcedure, type ExternalPermission } from "./recordsAuthorization";
import { findExternalIdentityByAnyTokenHash, findExternalIdentityByInvitationHash, touchExternalIdentity, updateExternalIdentity } from "../db";
import { credentialCheck, failureUpdate, invitationCheck, totpVerify } from "./externalIdentityPolicy";
import { environmentSecretKeys, legacyMfaKey } from "./secretKeys";
import { resolveMfaSeed } from "../mfaSecretService";
import { ENV } from "./env";

export type ExternalContext = { identityId: number; identityRef: string; kind: "customer" | "vendor" | "facility"; accountId: number; displayName: string };

export function externalProcedure(procedureName: string) {
  const permission: ExternalPermission | null = externalPermissionForProcedure(procedureName);
  if (!permission) throw new Error(`No external permission mapped for procedure "${procedureName}" — add it to EXTERNAL_PROCEDURE_PERMISSIONS`);
  return t.procedure.use(
    t.middleware(async ({ ctx, next }) => {
      const headers = (ctx.req as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers ?? {};
      const raw = headers["x-portal-token"] ?? (typeof headers["authorization"] === "string" && headers["authorization"].startsWith("Portal ") ? headers["authorization"].slice(7) : undefined);
      const token = Array.isArray(raw) ? raw[0] : raw;
      const now = new Date();
      const refuse = async (outcome: string, detail: string, code: "UNAUTHORIZED" | "FORBIDDEN") => {
        await recordAuthorizationDecision({ actorUserId: null, procedureName, permission, rolesHeld: "external", outcome, subjectType: "externalIdentity", subjectId: null, detail, occurredAt: now });
        throw new TRPCError({ code, message: detail });
      };
      if (!token) return refuse("denied_unauthenticated", "No portal token", "UNAUTHORIZED");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      // v21.12 — invitation acceptance comes through this gate under its own permission, on the INVITATION token.
      let identity: NonNullable<Awaited<ReturnType<typeof findExternalIdentityByInvitationHash>>>;
      if (permission === "portal.invitation.accept") {
        const inv = await findExternalIdentityByInvitationHash(tokenHash);
        if (!inv) return refuse("denied_unauthenticated", "Unknown invitation", "UNAUTHORIZED");
        const ic = invitationCheck({ status: inv.status, invitationExpiresAt: inv.invitationExpiresAt, acceptedAt: inv.acceptedAt }, now);
        if (!ic.allowed) return refuse("denied_scope", ic.reason!, "FORBIDDEN");
        identity = inv;
      } else {
        const found = await findExternalIdentityByAnyTokenHash(tokenHash, now);
        if (!found) return refuse("denied_unauthenticated", "Unknown portal token", "UNAUTHORIZED");
        identity = found.identity;
        const cc = credentialCheck({ status: identity.status, acceptedAt: identity.acceptedAt, tokenExpiresAt: identity.tokenExpiresAt, lockedUntil: identity.lockedUntil, failedAttempts: identity.failedAttempts, mfaEnabled: identity.mfaEnabled }, now);
        if (!cc.allowed) return refuse("denied_scope", cc.reason!, "FORBIDDEN");
        // MFA, when enabled, guards every sensitive write.
        if (identity.mfaEnabled && EXTERNAL_SENSITIVE_PERMISSIONS.includes(permission)) {
          const codeRaw = headers["x-portal-mfa"]; const code = Array.isArray(codeRaw) ? codeRaw[0] : codeRaw;
          /*
           * 0193 — the seed comes from whichever store this identity uses. `resolveMfaSeed` prefers
           * `mfaSecretRef`, and when one is present but unreadable it throws rather than reading
           * the legacy column, so a damaged or tampered new record cannot hand verification back to
           * a seed the user already replaced.
           *
           * The throw is answered here as a refusal rather than allowed to become a 500: an
           * unreadable secret must deny the request, and it must deny it the same way a missing key
           * always did.
           */
          let seed: string;
          try {
            seed = await resolveMfaSeed(identity, { keys: environmentSecretKeys(), legacyKey: legacyMfaKey(), isProduction: ENV.isProduction });
          } catch {
            return refuse("denied_scope", "MFA is enabled but cannot be verified on this server", "FORBIDDEN");
          }
          if (!code || !totpVerify(seed, code, now)) {
            const f = failureUpdate(identity.failedAttempts, now);
            await updateExternalIdentity(identity.id, f);
            return refuse("denied_scope", f.lockedUntil ? `MFA code rejected — locked until ${f.lockedUntil.toISOString()}` : "MFA code required or rejected", "FORBIDDEN");
          }
          if (identity.failedAttempts > 0) await updateExternalIdentity(identity.id, { failedAttempts: 0, lockedUntil: null });
        }
      }
      const accountId = identity.kind === "customer" ? identity.customerAccountId : identity.kind === "vendor" ? identity.vendorId : identity.facilityId;
      if (accountId == null) return refuse("denied_scope", "Portal identity is bound to no account", "FORBIDDEN");
      if (!EXTERNAL_KIND_PERMISSIONS[identity.kind].includes(permission)) return refuse("denied_no_role", `A ${identity.kind} identity does not hold ${permission}`, "FORBIDDEN");
      const auditId = await recordAuthorizationDecision({ actorUserId: null, procedureName, permission, rolesHeld: `external:${identity.kind}`, outcome: "allowed", subjectType: "externalIdentity", subjectId: identity.identityRef, detail: null, occurredAt: now });
      if (auditId === undefined && EXTERNAL_SENSITIVE_PERMISSIONS.includes(permission)) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Refused: a portal write is not performed when its audit record cannot be written" });
      }
      await touchExternalIdentity(identity.id, now);
      const external: ExternalContext = { identityId: identity.id, identityRef: identity.identityRef, kind: identity.kind, accountId, displayName: identity.displayName };
      return next({ ctx: { ...ctx, external } });
    })
  );
}

/* ==================================================================
 * v21.18 — integrationProcedure: the machine gate.
 *
 * Built like externalProcedure and no weaker: mapped at wiring time; the key
 * in `x-integration-key` hashed and resolved to exactly one active client;
 * lockout after failures; every decision an audit row; a write refused when
 * the audit row cannot be written. The client's SCOPES decide which feeds it
 * may send; the procedure checks them against the payload.
 * ================================================================== */

import { INTEGRATION_SENSITIVE_PERMISSIONS, integrationPermissionForProcedure, type IntegrationPermission } from "./recordsAuthorization";
import { findIntegrationClientByKeyHash, touchIntegrationClient } from "../db";

export type IntegrationContext = { clientId: number; clientRef: string; orgRef: string; kind: string; scopes: string[]; name: string };

export function integrationProcedure(procedureName: string) {
  const permission: IntegrationPermission | null = integrationPermissionForProcedure(procedureName);
  if (!permission) throw new Error(`No integration permission mapped for procedure "${procedureName}" — add it to INTEGRATION_PROCEDURE_PERMISSIONS`);
  return t.procedure.use(
    t.middleware(async ({ ctx, next }) => {
      const headers = (ctx.req as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers ?? {};
      const raw = headers["x-integration-key"]; const key = Array.isArray(raw) ? raw[0] : raw;
      const now = new Date();
      const refuse = async (outcome: string, detail: string, code: "UNAUTHORIZED" | "FORBIDDEN") => {
        await recordAuthorizationDecision({ actorUserId: null, procedureName, permission, rolesHeld: "integration", outcome, subjectType: "integrationClient", subjectId: null, detail, occurredAt: now });
        throw new TRPCError({ code, message: detail });
      };
      if (!key) return refuse("denied_unauthenticated", "No integration key", "UNAUTHORIZED");
      const client = await findIntegrationClientByKeyHash(createHash("sha256").update(key).digest("hex"));
      if (!client) return refuse("denied_unauthenticated", "Unknown integration key", "UNAUTHORIZED");
      if (!client.orgRef) return refuse("denied_scope", "Integration client has no organization binding; re-register it", "FORBIDDEN");
      if (client.status !== "active") return refuse("denied_scope", `Integration client is ${client.status}`, "FORBIDDEN");
      if (client.lockedUntil && now < client.lockedUntil) return refuse("denied_scope", `Integration client is locked until ${client.lockedUntil.toISOString()}`, "FORBIDDEN");
      const auditId = await recordAuthorizationDecision({ actorUserId: null, procedureName, permission, rolesHeld: `integration:${client.kind}`, outcome: "allowed", subjectType: "integrationClient", subjectId: client.clientRef, detail: null, occurredAt: now });
      if (auditId === undefined && INTEGRATION_SENSITIVE_PERMISSIONS.includes(permission)) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Refused: an inbound write is not performed when its audit record cannot be written" });
      await touchIntegrationClient(client.id, now);
      const integration: IntegrationContext = { clientId: client.id, clientRef: client.clientRef, orgRef: client.orgRef, kind: client.kind, scopes: JSON.parse(client.scopesJson) as string[], name: client.name };
      return next({ ctx: { ...ctx, integration } });
    })
  );
}
