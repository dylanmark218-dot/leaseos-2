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
 * **Historically.** There was no tenant, organization or membership table in
 * this schema. `ctx` carried a user and their effective roles and no tenant, so
 * the system was single-tenant in fact, and pretending otherwise by trusting a
 * client-supplied tenant was strictly worse than admitting it: it produced a
 * multi-tenant-shaped API with no multi-tenant enforcement behind it. This
 * resolver returned the system's single tenant from server-owned context and
 * refused to read one from input, and said that when a real membership table
 * existed, this would be the one function that changed and every caller would
 * inherit the fix.
 *
 * **v22.20 (0086)** created `organizations` and `organizationMemberships`, and
 * **v23.26** is that promised change:
 *
 *   - the organization's own status is consulted, so a suspended or closed
 *     company resolves for nobody;
 *   - a person whose every membership has ended is REFUSED rather than dropped
 *     into the single-tenant fallback, because the fallback is for a deployment
 *     that never had organizations, not for an ex-employee;
 *   - a caller who is a live member of several organizations may SELECT one,
 *     and the selection is verified against this same query before it decides
 *     anything — so the ~100 callers of this function inherit the selection
 *     without any of them being edited.
 *
 * `userRoleAssignments.scopeType` is still `global | branch` and carries no
 * organization, so a person who is a member of two companies takes their role
 * names into both. Membership and the tenant-scoped queries are what isolate
 * the DATA; scoping a GRANT to an organization is the next migration, and
 * `LEASEOS_B23_0_IDENTITY_AND_WORKSPACES.md` records it as outstanding rather
 * than implying it is done.
 *
 * Branch scope IS server-owned and is enforced: a caller may only scope a
 * policy to a branch they actually hold a grant in.
 */

import { and, eq, isNull } from "drizzle-orm";
import { organizationMemberships, organizations, userRoleAssignments } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { requestedOrganization } from "./organizationSelection";

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

export type ActingScopeOptions = {
  /** Evaluate memberships as of this instant. Defaults to now. */
  at?: Date;
  /**
   * v23.26 — the organization the caller SAYS they are working in.
   *
   * A request, not an assertion. It is honoured only when this user has a live
   * membership in it, and it is the tie-breaker for nothing else: a caller with
   * one membership resolves to that one however loudly the request names
   * another, and a caller naming an organization they do not belong to is
   * treated as having named nothing — which, for a multi-organization caller,
   * still ends in `AmbiguousOrganization`.
   *
   * When omitted it falls back to the request-scoped selection (the cookie the
   * organization chooser writes), so the ~100 tenant-scoped readers that call
   * `resolveActingScope(db, userId)` inherit the selection without each having
   * to thread it. Outside a request there is no selection and behaviour is
   * exactly what it was.
   */
  preferredOrgRef?: string | null;
};

/**
 * Resolve what the caller may act for. Never reads tenant, branch or terminal
 * from client input — a named organization is checked against the membership
 * table before it is allowed to decide anything.
 */
export async function resolveActingScope(
  db: DbOrTx,
  userId: number,
  options?: ActingScopeOptions,
): Promise<ActingScope> {
  const at = options?.at;
  const grants = await db.select({ scopeType: userRoleAssignments.scopeType, scopeRef: userRoleAssignments.scopeRef })
    .from(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, userId), isNull(userRoleAssignments.revokedAt)));
  const branchRefs = Array.from(new Set(
    grants.flatMap(g => (g.scopeType === "branch" && g.scopeRef ? [g.scopeRef] : [])),
  ));
  // B23.1 — `global` here has always meant "this caller's authority is not
  // confined to a branch", which is the only question `mayScopePolicyTo` asks
  // it. 0170 split the old `global` into `global` (platform-wide) and
  // `organization` (the ordinary case), so testing for the literal string
  // would have quietly answered "no" for every administrator in the system and
  // refused every company-wide policy write. A quarantined grant authorizes
  // nothing, so it confers nothing here either.
  const global = grants.some(
    (g: { scopeType: string }) => g.scopeType === "global" || g.scopeType === "organization",
  );

  const now = at ?? new Date();
  // v23.26 — the organization's own status is part of the answer. A membership in
  // a suspended or closed company is not a live membership: the company is not
  // trading, and resolving a request into it would let work continue inside a
  // tenant an administrator has deliberately stopped.
  const rows = await db.select({ m: organizationMemberships, orgStatus: organizations.status })
    .from(organizationMemberships)
    .leftJoin(organizations, eq(organizations.orgRef, organizationMemberships.orgRef))
    .where(eq(organizationMemberships.userId, userId));
  const memberships = rows
    .filter((r: { m: { status: string } }) => r.m.status === "active")
    // A membership pointing at no organization row is unresolvable, not
    // permissive: there is no status to check, so it does not count.
    .filter((r: { orgStatus: string | null }) => r.orgStatus === "active")
    .map((r: { m: typeof organizationMemberships.$inferSelect }) => r.m)
    .filter((m: { effectiveFrom: Date; effectiveTo: Date | null }) =>
      m.effectiveFrom.getTime() <= now.getTime() && (!m.effectiveTo || m.effectiveTo.getTime() > now.getTime()));

  const orgs = Array.from(new Set(memberships.map((m: { orgRef: string }) => m.orgRef)));

  // Had a membership, has none live. Refused rather than fallen back: the
  // fallback exists for a deployment that never had organizations, not for a
  // person whose organization ended their access.
  if (orgs.length === 0 && rows.length > 0) {
    throw new MembershipRevoked(
      "This user holds no active organization membership. Access ends with the membership, not with the role grant.",
    );
  }

  const requested = options?.preferredOrgRef ?? requestedOrganization();
  if (orgs.length > 1) {
    // A selection, but only if it is one of theirs. Verified here rather than
    // trusted at the edge, so a forged cookie names an organization this query
    // has already proved the caller belongs to or it names nothing at all.
    const selected = requested ? memberships.find((m: { orgRef: string }) => m.orgRef === requested) : undefined;
    if (selected) {
      return {
        tenantId: selected.orgRef, derivedFrom: "membership", membershipRef: selected.membershipRef,
        branchRefs: selected.branchId && !branchRefs.includes(selected.branchId) ? [...branchRefs, selected.branchId] : branchRefs,
        global,
      };
    }
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
 * v23.26 — thrown when every membership this person had is over.
 *
 * Before this, an ex-employee kept their role grants (revoking a membership
 * does not revoke a grant) and fell through to the single-tenant fallback, so
 * the server resolved them into the historical tenant and carried on. Their
 * old employer's records were still out of reach — those are scoped to an
 * organization they no longer match — but "carried on" was the wrong answer to
 * "this person no longer works here", and a deployment that still holds
 * unowned single-tenant rows would have served them.
 *
 * Someone who NEVER had a membership is a different case and is untouched: the
 * single-tenant fallback exists for deployments that predate organizations, and
 * removing it would lock out every such user.
 */
export class MembershipRevoked extends Error {}

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
