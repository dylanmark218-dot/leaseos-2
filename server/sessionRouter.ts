/**
 * v23.26 — the session surface: one identity, several jobs.
 *
 * Three procedures and one contract. Everything a signed-in person's shell
 * needs to know about itself — who they are, which company they are acting
 * for, which workspaces are open to them, which capabilities are effective in
 * the one they are in — arrives from `session.context` in a single normalized
 * answer, computed server-side from the membership and grant tables.
 *
 * ## What this surface is not
 *
 * It is not an authorization API. Nothing it returns is proof of anything. The
 * `capabilities` list is there so a screen can hide a button it would be
 * pointless to press; every one of those buttons still calls a procedure that
 * goes through `roleProcedure` and re-derives the same decision from the same
 * tables. Delete the list, hand-craft the request, and the answer does not
 * change — which is the property `sessionWorkspace.db.test.ts` exists to prove
 * and `workspaceAccess.test.ts` exists to explain.
 *
 * ## Why the selections are stored where they are
 *
 * The ORGANIZATION lands in a cookie, because roughly a hundred tenant-scoped
 * readers call `resolveActingScope(db, userId)` with no way to pass one, and a
 * selection those readers do not see is a selection that does not work. It is
 * re-verified against the membership table on every request, so the cookie
 * carries a claim and never an authority.
 *
 * The WORKSPACE does not need a cookie: the route already names it, and the
 * client sends it as an input that this surface checks. What persists is the
 * *preference* — `organizationMemberships.defaultWorkspace`, written only
 * after the selection has been authorized, and re-checked against live access
 * before it is ever honoured.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, sessionProcedure } from "./_core/trpc";
import { safeRedirectPath } from "@shared/_core/redirect";
import { acceptInvitationTransactionally } from "./db";
import { digestToken } from "./_core/peopleAccess";
import { listMembershipFacts, rememberDefaultWorkspace } from "./db";
import type { RoleGrant } from "./_core/recordsAuthorization";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { issueOrganizationSelectionCookie } from "./_core/organizationSelectionCookie";
import {
  decideWorkspaceSelection,
  resolveSessionContext,
  workspaceLanding,
  type SessionContext,
} from "./_core/workspaceAccess";

/**
 * The workspace a request asks for.
 *
 * A bare bounded string rather than `z.enum(WORKSPACE_ORDER)`: an unknown key
 * has to reach the resolver so it can be refused by name, exactly as the widget
 * router refuses an unregistered widget key. "Invalid enum value" tells an
 * operator who mistyped a URL nothing they can act on.
 */
const workspaceInput = z.string().min(1).max(64);
const orgRefInput = z.string().min(1).max(40);

/**
 * The whole answer, computed from server-loaded facts. Never from the request.
 *
 * `grants` comes from the gate, which already loaded them to write its audit
 * row — the same values the decision will be made on, read once.
 */
async function contextFor(args: {
  user: { id: number; name: string | null; email: string | null };
  grants: readonly RoleGrant[];
  requestedOrgRef?: string | null;
  requestedWorkspace?: string | null;
}): Promise<SessionContext> {
  return resolveSessionContext({
    user: args.user,
    memberships: await listMembershipFacts(args.user.id),
    grants: args.grants,
    requestedOrgRef: args.requestedOrgRef ?? null,
    requestedWorkspace: args.requestedWorkspace ?? null,
    now: new Date(),
    singleTenantId: SINGLE_TENANT_ID,
  });
}

export const sessionRouter = router({
  /**
   * Who am I, where am I, and what may I open?
   *
   * The one contract the shell reads. `workspace` and `organization` are what
   * the client currently believes; both are checked against the tables before
   * they influence a single field of the answer, and a value that does not
   * check out is dropped rather than reported — a chooser opening is the right
   * response to a stale selection, not an error banner.
   */
  context: sessionProcedure("session.context")
    .input(
      z
        .object({
          workspace: workspaceInput.optional(),
          organization: orgRefInput.optional(),
          /**
           * Where the person was trying to go before they were sent to sign in.
           * Returned normalized so the client navigates to a checked path and
           * never to whatever was in the query string.
           */
          intendedPath: z.string().max(512).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const context = await contextFor({
        user: ctx.user,
        grants: ctx.grants,
        requestedOrgRef: input?.organization ?? null,
        requestedWorkspace: input?.workspace ?? null,
      });
      return {
        ...context,
        // Checked here rather than in the browser: the client that asks is the
        // client that would be redirected, so it is not the one to decide.
        intendedPath: input?.intendedPath
          ? safeRedirectPath(
              input.intendedPath,
              context.activeWorkspace ? workspaceLanding(context.activeWorkspace) : "/"
            )
          : null,
      };
    }),

  /**
   * Act for this organization from now on.
   *
   * Refused unless the caller has a live membership in it — the check runs
   * against the table, in this request, and the cookie is written only after it
   * passes. A caller with a single membership may still call this; naming their
   * own organization is a no-op and naming another one is refused, which is the
   * same answer a multi-organization caller gets.
   */
  selectOrganization: sessionProcedure("session.selectOrganization")
    .input(z.object({ organization: orgRefInput }))
    .mutation(async ({ ctx, input }) => {
      const memberships = await listMembershipFacts(ctx.user.id);
      const context = resolveSessionContext({
        user: ctx.user,
        memberships,
        grants: ctx.grants,
        requestedOrgRef: input.organization,
        requestedWorkspace: null,
        now: new Date(),
        singleTenantId: SINGLE_TENANT_ID,
      });

      if (context.activeOrganization?.orgRef !== input.organization) {
        // Named as a refusal to act, not as a fact about the organization. This
        // message is identical whether the organization exists and they are not
        // in it, or does not exist at all — an error string is not a directory
        // of a deployment's tenants.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have an active membership in that organization.",
        });
      }

      issueOrganizationSelectionCookie(ctx.req, ctx.res, input.organization);
      return context;
    }),

  /**
   * Enter this workspace.
   *
   * The switch a multi-workspace person makes without signing out. It grants
   * nothing: the decision is recomputed here from the roles and capabilities
   * just loaded, and the only durable effect of success is that the person's
   * membership remembers where they were. A refusal names the reason and
   * nothing else about the account.
   */
  selectWorkspace: sessionProcedure("session.selectWorkspace")
    .input(z.object({ workspace: workspaceInput, organization: orgRefInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const context = await contextFor({
        user: ctx.user,
        grants: ctx.grants,
        requestedOrgRef: input.organization ?? null,
      });

      if (context.state === "organization_required") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Choose which organization you are working in before opening a workspace.",
        });
      }

      const decision = decideWorkspaceSelection({
        requested: input.workspace,
        available: context.availableWorkspaces,
      });
      if (!decision.allowed) {
        throw new TRPCError({
          code: decision.outcome === "unknown_workspace" ? "BAD_REQUEST" : "FORBIDDEN",
          message: decision.reason,
        });
      }

      // A preference, written after the authorization it depends on, on the
      // membership it belongs to. Absent for the historical single tenant,
      // which has no membership row to remember anything on.
      if (context.activeOrganization?.membershipRef) {
        await rememberDefaultWorkspace({
          membershipRef: context.activeOrganization.membershipRef,
          workspace: decision.workspace,
        });
      }

      return {
        workspace: decision.workspace,
        landing: decision.landing,
        capabilities: context.availableWorkspaces.find(w => w.key === decision.workspace)?.capabilities ?? [],
      };
    }),
  /**
   * B23.2 — join an organization that invited you.
   *
   * This is the one People & Access act that cannot be a `roleProcedure`: the
   * person accepting holds nothing in the organization they are joining, which
   * is the entire point of an invitation. `sessionProcedure` is the gate built
   * for exactly that case, and its procedure list is closed in code and pinned
   * by the census, so adding one is a deliberate act rather than a default.
   *
   * The claim is the TOKEN plus the authenticated identity — never an email
   * address. `GetUserInfoResponse` carries `email` with no verification flag,
   * so LeaseOS cannot tell an address somebody proved from one they typed;
   * matching on it would let anyone who knows a colleague's address take their
   * place. The token is verified against a stored SHA-256 digest inside the
   * transaction that creates the membership, so a cancel landing mid-flight
   * loses and a second acceptance finds the row already accepted.
   *
   * ONE IDENTITY. Acceptance binds to `ctx.user.id`, which the session already
   * resolved from the OAuth `openId`. Somebody who already works for another
   * company gains a second membership on the same account — no second user row
   * is created here, or anywhere but the OAuth upsert.
   */
  acceptInvitation: sessionProcedure("session.acceptInvitation")
    .input(z.object({ token: z.string().min(16).max(200) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.id) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first, then open the invitation link again" });
      }
      const now = new Date();
      const result = await acceptInvitationTransactionally({
        tokenDigest: digestToken(input.token),
        acceptingUserId: ctx.user.id,
        membershipRef: `MEM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        now,
      });
      if (!result.ok) {
        // Each refusal is a sentence somebody can act on, and none of them
        // says anything about another organization.
        const message =
          result.reason === "expired"
            ? "That invitation has expired — ask for a new one"
            : result.reason === "already_member"
              ? "You are already a member of that organization"
              : result.reason === "not_pending"
                ? "That invitation has already been used or was cancelled"
                : "That invitation is not valid";
        throw new TRPCError({
          code: result.reason === "already_member" ? "CONFLICT" : "NOT_FOUND",
          message,
        });
      }
      return {
        organization: result.orgRef,
        roles: [...result.roles].sort(),
        membershipRef: result.membershipRef,
      };
    }),
});
