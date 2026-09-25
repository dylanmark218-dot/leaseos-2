import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

/**
 * Procedure metadata. `moneyScoped` marks a procedure whose handler receives the caller's money
 * boundary (`ctx.money`); `financeScopeCoverage.test.ts` reads the mark from the live router, so a
 * finance procedure added without it fails CI rather than a code review.
 *
 * F1.3 — `platformGoverned` marks a procedure that changes (or reads) configuration shared by every
 * organization, gated on platform authority by `platformOrOrganizationProcedure` ("global_target": only
 * when the request targets the global row). `bootstrap` records the one exception, and the condition that
 * ends it. Set only by that wrapper.
 */
export type ProcedureMeta = { moneyScoped?: true; platformGoverned?: "global_target"; bootstrap?: "zero_organizations" };

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
  type Permission,
  type RoleGrant, type ProcedureName } from "./recordsAuthorization";
import { listActiveUserRoles, recordAuthorizationDecision } from "../db";

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
      const roles = await enforceDomainPermission(procedureName, permission, ctx.user?.id ?? null);
      return next({
        ctx: { ...ctx, user: ctx.user!, roles },
      });
    })
  );
}

/**
 * The domain-permission decision behind `roleProcedure`, recorded, denials included. Returns the
 * effective roles; throws UNAUTHORIZED / FORBIDDEN otherwise.
 */
async function enforceDomainPermission(procedureName: ProcedureName, permission: Permission, userId: number | null) {
  const grants: RoleGrant[] = userId
    ? await listActiveUserRoles(userId)
    : [];
  const decision = authorize({ userId, grants, permission });

  const auditId = await recordAuthorizationDecision({
    actorUserId: userId,
    procedureName,
    permission,
    rolesHeld:
      grants
        .map(g => (g.scopeRef ? `${g.role}@${g.scopeRef}` : g.role))
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

  return decision.effectiveRoles;
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
 * F1.3 — platform governance: configuration shared by every organization
 * ================================================================== */

import { platformAuthorityProven } from "../platformAuthority";
import { singleOwnershipDomain } from "../ownershipDomain";

/**
 * Who authorized a governed call. `platform`: `users.role = "admin"`, read from the users row now.
 * `bootstrap`: no organization exists yet, and the caller holds the domain permission. `organization`:
 * the domain permission, for a target the handler must still prove the caller's organization owns.
 */
export type GovernedAuthority = "platform" | "organization" | "bootstrap";
export const PLATFORM_AUTHORITY_REQUIRED = "PLATFORM_AUTHORITY_REQUIRED";

/** Record a platform-authority decision in the same trail `roleProcedure` writes, then refuse or allow. */
async function enforcePlatformAuthority(procedureName: string, userId: number | null, what: string): Promise<void> {
  const allowed = userId != null && (await platformAuthorityProven(userId));
  await recordAuthorizationDecision({
    actorUserId: userId, procedureName, permission: "platform.authority", rolesHeld: allowed ? "platform_admin" : null,
    outcome: allowed ? "allowed" : userId == null ? "denied_unauthenticated" : "denied_permission",
    detail: allowed ? null : `${what} is platform configuration`, occurredAt: new Date(),
  });
  if (userId == null) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: `${PLATFORM_AUTHORITY_REQUIRED}: ${what} is shared by every organization; only a platform administrator may change it. An organization role is not platform authority.` });
}

/**
 * A procedure that serves both one organization's row and the global row every organization falls back
 * to (dispatch enforcement). The request's target picks the gate:
 *
 *   own target (`targetsGlobal` false) → the domain permission, as `roleProcedure`; the handler proves
 *     the organization owns the target. Platform authority does not bypass this.
 *   global target, platform authority → allowed, with no domain role needed.
 *   global target, zero organizations → BOOTSTRAP: the domain permission, as before organizations
 *     existed. It ends the moment the first organization row exists, for everyone, permanently.
 *   global target, otherwise → FORBIDDEN.
 *
 * The target is read from the raw input only to choose the gate; the handler re-checks the parsed target
 * against `ctx.authority` (`assertGovernedTarget`), so a raw/parsed mismatch cannot cross gates.
 */
export function platformOrOrganizationProcedure(procedureName: ProcedureName, what: string, targetsGlobal: (rawInput: unknown) => boolean) {
  const permission = permissionForProcedure(procedureName);
  if (!permission) throw new Error(`No permission mapped for procedure "${procedureName}" — add it to RECORDS_PROCEDURE_PERMISSIONS`);
  return t.procedure.meta({ platformGoverned: "global_target", bootstrap: "zero_organizations" }).use(async ({ ctx, next, getRawInput }) => {
    const userId = ctx.user?.id ?? null;
    let authority: GovernedAuthority;
    let roles: string[] = [];
    if (!targetsGlobal(await getRawInput())) {
      roles = await enforceDomainPermission(procedureName, permission, userId);
      authority = "organization";
    } else if (userId != null && (await platformAuthorityProven(userId))) {
      await enforcePlatformAuthority(procedureName, userId, what);
      authority = "platform";
    } else if (await singleOwnershipDomain()) {
      roles = await enforceDomainPermission(procedureName, permission, userId);
      authority = "bootstrap";
    } else {
      await enforcePlatformAuthority(procedureName, userId, what);   // records the refusal, then throws
      throw new TRPCError({ code: "FORBIDDEN", message: `${PLATFORM_AUTHORITY_REQUIRED}: ${what}` });
    }
    return next({ ctx: { ...ctx, user: ctx.user!, roles, authority } });
  });
}

/** The handler half: a global target needs platform or bootstrap authority; an own target, organization authority. */
export function assertGovernedTarget(authority: GovernedAuthority, targetsGlobal: boolean, what: string): void {
  if (targetsGlobal ? authority === "organization" : authority !== "organization")
    throw new TRPCError({ code: "FORBIDDEN", message: `${PLATFORM_AUTHORITY_REQUIRED}: ${what}` });
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
