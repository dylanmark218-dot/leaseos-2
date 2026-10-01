/**
 * v22.20 — which organization the caller is acting for.
 *
 * The one place this is decided. A caller may say which branch or terminal a
 * policy applies to; they may never say which company, because "I hold a
 * management role somewhere, therefore let me write policy in Tenant B" is the
 * whole class of bug this exists to close.
 *
 * **How the organization is established.** From the caller's active
 * organization membership. A user with no membership falls back to the single
 * tenant this system operated as before memberships existed, and says so in
 * `derivedFrom` rather than letting a reader assume isolation. A user with
 * active memberships in more than one organization is REFUSED rather than
 * resolved: picking one would silently decide which company a request writes
 * into.
 *
 * **Historically.** There was no tenant,
 * organization or membership table in this schema. `ctx` carries a user and
 * their effective roles and no tenant. `userRoleAssignments.scopeType` is
 * `global | branch` — there is no tenant scope to read. The single production
 * writer of `tenantId` hardcodes `"default"`.
 *
 * So this system is single-tenant in fact, and pretending otherwise by trusting
 * a client-supplied tenant was strictly worse than admitting it: it produced a
 * multi-tenant-shaped API with no multi-tenant enforcement behind it. This
 * resolver returns the system's single tenant from server-owned context and
 * refuses to read one from input. When a real membership table exists, this is
 * the one function that changes, and every caller inherits the fix.
 *
 * Branch scope IS server-owned and is enforced: a caller may only scope a
 * policy to a branch they actually hold a grant in.
 */

import { and, eq, isNull } from "drizzle-orm";
import { organizationMemberships, userRoleAssignments } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";

/**
 * The tenant this deployment operates as. Matches what the existing
 * notification writer already stores, so nothing here invents a second
 * tenant namespace.
 */
export const SINGLE_TENANT_ID = "default";

export type ActingScope = {
  tenantId: string;
  /**
   * Where the organization came from. `membership` is the real answer;
   * `single_tenant_fallback` means no organization has been created yet and the
   * system is operating as the one it has always implicitly been. A reader can
   * tell the difference, which was the whole complaint about the old version.
   */
  derivedFrom: "membership" | "single_tenant_fallback";
  membershipRef: string | null;
  /** Branches the caller holds a grant in. Empty means global-only grants. */
  branchRefs: string[];
  /** True when the caller's authority is global rather than branch-confined. */
  global: boolean;
};

/**
 * Resolve what the caller may act for. Never reads tenant, branch or terminal
 * from client input.
 */
export async function resolveActingScope(
  db: DbOrTx,
  userId: number,
  at?: Date,
): Promise<ActingScope> {
  const grants = await db.select({ scopeType: userRoleAssignments.scopeType, scopeRef: userRoleAssignments.scopeRef })
    .from(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, userId), isNull(userRoleAssignments.revokedAt)));
  const branchRefs = Array.from(new Set(
    grants.flatMap(g => (g.scopeType === "branch" && g.scopeRef ? [g.scopeRef] : [])),
  ));
  const global = grants.some((g: { scopeType: string }) => g.scopeType === "global");

  const now = at ?? new Date();
  const memberships = (await db.select().from(organizationMemberships)
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active"))))
    .filter((m: { effectiveFrom: Date; effectiveTo: Date | null }) =>
      m.effectiveFrom.getTime() <= now.getTime() && (!m.effectiveTo || m.effectiveTo.getTime() > now.getTime()));

  const orgs = Array.from(new Set(memberships.map((m: { orgRef: string }) => m.orgRef)));
  if (orgs.length > 1) {
    // Two live memberships and no selection. Picking one would decide, silently,
    // which company's records this request writes into.
    throw new AmbiguousOrganization(
      `This user is an active member of ${orgs.length} organizations (${orgs.join(", ")}). Which one they are acting for has to be established, not guessed.`,
    );
  }
  const [m] = memberships;
  if (orgs.length === 1 && m) {
    // The membership itself, not a second lookup for the org it already gave us:
    // `find` could return undefined and the old code dereferenced it regardless.
    return {
      tenantId: m.orgRef, derivedFrom: "membership", membershipRef: m.membershipRef,
      branchRefs: m.branchId && !branchRefs.includes(m.branchId) ? [...branchRefs, m.branchId] : branchRefs,
      global,
    };
  }
  return { tenantId: SINGLE_TENANT_ID, derivedFrom: "single_tenant_fallback", membershipRef: null, branchRefs, global };
}

/** Thrown rather than resolved, because a wrong organization is worse than a refusal. */
export class AmbiguousOrganization extends Error {}

/**
 * P0-A1 — the fallback is for a deployment that predates memberships, not for a person whose
 * membership ended.
 *
 * `resolveActingScope` answers `single_tenant_fallback` for anyone with no LIVE membership. That
 * is right for a user the membership table has never heard of: the system has always operated as
 * one tenant for them. It is wrong for a user whose membership existed and was ended, suspended,
 * or ran out: their organization revoked them, and letting them back in as "the historical single
 * tenant" is a revival, not a fallback. Historical role grants do not change this — roles say what
 * kind of action a person may take, never which company they may take it in.
 *
 * Added beside the resolver rather than inside it so every existing caller keeps its behaviour
 * until its own checkpoint adopts this; the HOS boundary is the first.
 */
export class RevivedFallbackRefused extends Error {}

export async function resolveActingScopeStrict(db: DbOrTx, userId: number, at?: Date): Promise<ActingScope> {
  const acting = await resolveActingScope(db, userId, at);
  if (acting.derivedFrom !== "single_tenant_fallback") return acting;
  const ever = await db.select({ id: organizationMemberships.id }).from(organizationMemberships)
    .where(eq(organizationMemberships.userId, userId)).limit(1);
  if (ever.length) {
    throw new RevivedFallbackRefused("No active organization membership — a membership that has ended is not replaced by the single-tenant fallback");
  }
  return acting;
}

export type ScopeDecision = { allowed: true; scopeRef: string | null } | { allowed: false; reason: string };

/**
 * May the caller write policy at this scope?
 *
 * A global grant reaches any branch. A branch-confined grant reaches only its
 * own branches — a supervisor at one terminal does not set the rules at
 * another.
 */
export function mayScopePolicyTo(acting: ActingScope, scopeType: "company" | "branch" | "terminal", scopeRef: string | null): ScopeDecision {
  if (scopeType === "company") {
    if (!acting.global) return { allowed: false, reason: "A company-wide policy needs a global grant; this caller's authority is confined to a branch" };
    return { allowed: true, scopeRef: null };
  }
  if (!scopeRef) return { allowed: false, reason: `A ${scopeType} policy names the ${scopeType} it applies to` };
  if (acting.global) return { allowed: true, scopeRef };
  if (scopeType === "branch" && acting.branchRefs.includes(scopeRef)) return { allowed: true, scopeRef };
  return { allowed: false, reason: `This caller holds no grant in ${scopeType} ${scopeRef}` };
}
