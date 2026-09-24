/**
 * B23.2 — People & Access.
 *
 * Who belongs to THIS organization, and what they may do here.
 *
 * The survey that opened this checkpoint found that nothing in LeaseOS had ever
 * created an `organizationMemberships` row: B23.0 resolved an identity into a
 * company and B23.1 scoped every grant to the company that issued it, both on
 * top of a table only test fixtures wrote to. This router is the missing origin
 * of that chain.
 *
 * Three rules hold everywhere in this file:
 *
 *   THE ORGANIZATION IS NEVER AN INPUT. It comes from `actingScopeFor`, which
 *   reads it from the caller's verified membership. There is no parameter an
 *   administrator could use to name another company, so "grant into Org B" is
 *   not a permission they are missing — it is not a thing this API can express.
 *
 *   A REFUSAL IS NOT A DIRECTORY. Anything belonging to another organization
 *   answers NOT_FOUND, never FORBIDDEN, and no message names another company,
 *   its people or its roles.
 *
 *   THE SERVER RECOMPUTES. Workspaces are never stored; they are derived from
 *   the roles on every read, so revoking the last role removes the workspace
 *   with no second write to forget.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import {
  acceptInvitationTransactionally,
  actingScopeFor,
  cancelInvitation,
  createInvitation,
  endOrganizationMembership,
  getDb,
  grantUserRole,
  listInvitations,
  listOrganizationPeople,
  listUnresolvedLegacyForOrganization,
  organizationStatus,
  personInOrganization,
  rememberDefaultWorkspace,
  revokeRoleWithAdminGuard,
} from "./db";
import {
  defaultWorkspaceCheck,
  digestToken,
  invitationExpiry,
  invitationView,
  lastAdministratorCheck,
  newToken,
  personAccess,
  ROLE_DESCRIPTIONS,
  workspaceOptionsForRoles,
} from "./_core/peopleAccess";
import { GRANTABLE_ROLES } from "./recordsRouter";
import { userRoleAssignments } from "../drizzle/schema";

/** Walks the cause chain: drizzle wraps the driver error that carries the code. */
function isDuplicateKey(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 6; depth++) {
    const asObj = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (asObj.code === "ER_DUP_ENTRY") return true;
    if (typeof asObj.message === "string" && /duplicate entry/i.test(asObj.message)) return true;
    e = asObj.cause;
  }
  return false;
}

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** The acting organization, and the fact that it is trading. */
async function actingOrganization(userId: number) {
  const scope = await actingScopeFor(userId);
  const org = await organizationStatus(scope.tenantId);
  return { orgRef: scope.tenantId, name: org?.name ?? scope.tenantId, active: org?.active ?? true };
}

const roleEnum = z.enum(GRANTABLE_ROLES);

export const peopleRouter = router({
  /**
   * The role catalogue this surface may confer, with what each one means.
   *
   * Served from the server so the client cannot hold a second role registry
   * that drifts from `GRANTABLE_ROLES`. The workspace preview beside each role
   * is computed through the canonical resolver, not written by hand.
   */
  roleCatalogue: roleProcedure("people.roleCatalogue").query(async () => ({
    roles: GRANTABLE_ROLES.map(role => ({
      role,
      description: ROLE_DESCRIPTIONS[role] ?? "",
      workspaces: workspaceOptionsForRoles([role]).map(w => ({ key: w.key, label: w.label })),
    })),
  })),

  /** Everyone with a membership here. Never anyone else, and never their roles elsewhere. */
  list: roleProcedure("people.list").query(async ({ ctx }) => {
    const org = await actingOrganization(ctx.user.id);
    const now = new Date();
    const people = await listOrganizationPeople(org.orgRef);
    return {
      organization: { orgRef: org.orgRef, name: org.name },
      people: people.map(p =>
        personAccess({
          userId: p.userId,
          displayName: p.displayName,
          membership: {
            membershipRef: p.membershipRef,
            status: p.status,
            membershipType: p.membershipType,
            defaultWorkspace: p.defaultWorkspace,
            effectiveFrom: p.effectiveFrom,
            effectiveTo: p.effectiveTo,
          },
          organizationActive: org.active,
          rolesInThisOrganization: p.roles,
          now,
        })
      ),
    };
  }),

  /** One person's access here. Not found is the answer for anyone who is not. */
  detail: roleProcedure("people.detail")
    .input(z.object({ userId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const org = await actingOrganization(ctx.user.id);
      const person = await personInOrganization(org.orgRef, input.userId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const now = new Date();
      const access = personAccess({
        userId: person.userId,
        displayName: person.displayName,
        membership: {
          membershipRef: person.membershipRef,
          status: person.status,
          membershipType: person.membershipType,
          defaultWorkspace: person.defaultWorkspace,
          effectiveFrom: person.effectiveFrom,
          effectiveTo: person.effectiveTo,
        },
        organizationActive: org.active,
        rolesInThisOrganization: person.roles,
        now,
      });
      return {
        organization: { orgRef: org.orgRef, name: org.name },
        person: access,
        // The workspaces these roles open, with labels — the same computation
        // the session resolver runs, so the preview is not a separate promise.
        workspaceOptions: workspaceOptionsForRoles(access.roles).map(w => ({ key: w.key, label: w.label })),
      };
    }),

  /**
   * Set exactly which roles a member holds here.
   *
   * A set rather than add/remove: an administrator ticking boxes is describing
   * the end state, and computing the difference on the server means two
   * administrators cannot interleave an add and a remove into something neither
   * of them asked for.
   *
   * Grants are written through the same shape B23.1 established —
   * organization-confined, organization taken from the actor's scope. There is
   * no input here that could produce `scopeType: 'global'`, so a tenant
   * administrator cannot mint platform authority even by malformed request.
   */
  setRoles: roleProcedure("people.setRoles")
    .input(
      z.object({
        userId: z.number().int(),
        roles: z.array(roleEnum).max(GRANTABLE_ROLES.length),
        reason: z.string().min(3).max(300).default("access updated"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const org = await actingOrganization(ctx.user.id);
      const person = await personInOrganization(org.orgRef, input.userId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });

      // Both as Set<string>: `person.roles` comes from the database as strings,
      // and every member of `wanted` is already proved grantable by the zod enum.
      const wanted = new Set<string>(input.roles);
      const held = new Set<string>(person.roles);
      // Array.from rather than spreading a Set: this tsconfig targets a level
      // where Set iteration needs downlevelIteration.
      const toGrant = Array.from(wanted).filter(r => !held.has(r));
      const toRevoke = Array.from(held).filter(r => !wanted.has(r));

      const now = new Date();
      for (const role of toRevoke) {
        const result = await revokeRoleWithAdminGuard({
          orgRef: org.orgRef,
          targetUserId: input.userId,
          role,
          actorUserId: ctx.user.id,
          reason: input.reason,
          now,
        });
        if (!result.ok) {
          const refusal = lastAdministratorCheck({ remainingAfterChange: 0, organizationName: org.name });
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: refusal.reason! });
        }
      }
      for (const role of toGrant) {
        await grantUserRole({
          userId: input.userId,
          role: role as never,
          scopeType: "organization",
          orgRef: org.orgRef,
          scopeRef: null,
          grantedByUserId: ctx.user.id,
          grantedAt: now,
        });
      }

      // A default workspace that the new role set no longer opens is cleared
      // rather than left to rot. `workspaceAccess` would ignore it anyway; this
      // stops the administrator seeing a preference that means nothing.
      const stillValid = defaultWorkspaceCheck({ requested: person.defaultWorkspace, roles: input.roles });
      if (!stillValid.allowed && person.defaultWorkspace) {
        await rememberDefaultWorkspace({ membershipRef: person.membershipRef, workspace: null as never });
      }

      return {
        userId: input.userId,
        organization: org.orgRef,
        granted: toGrant.sort(),
        revoked: toRevoke.sort(),
        workspaces: workspaceOptionsForRoles(input.roles).map(w => w.key),
        defaultWorkspaceCleared: !stillValid.allowed && !!person.defaultWorkspace,
      };
    }),

  /** A landing preference, accepted only if the member's roles actually open it. */
  setDefaultWorkspace: roleProcedure("people.setDefaultWorkspace")
    .input(z.object({ userId: z.number().int(), workspace: z.string().max(60).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const org = await actingOrganization(ctx.user.id);
      const person = await personInOrganization(org.orgRef, input.userId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      const check = defaultWorkspaceCheck({ requested: input.workspace, roles: person.roles });
      if (!check.allowed) throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
      await rememberDefaultWorkspace({
        membershipRef: person.membershipRef,
        workspace: input.workspace as never,
      });
      return { userId: input.userId, defaultWorkspace: input.workspace };
    }),

  /**
   * End someone's access to THIS organization.
   *
   * Never "delete Dylan". The LeaseOS identity is one account that may belong to
   * several employers, and this ends one of those relationships: membership
   * `ended`, this organization's grants revoked, everything at every other
   * employer untouched.
   */
  removeFromOrganization: roleProcedure("people.removeFromOrganization")
    .input(z.object({ userId: z.number().int(), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const org = await actingOrganization(ctx.user.id);
      const result = await endOrganizationMembership({
        orgRef: org.orgRef,
        targetUserId: input.userId,
        actorUserId: ctx.user.id,
        reason: input.reason,
        now: new Date(),
      });
      if (!result.ok && result.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      }
      if (!result.ok) {
        const refusal = lastAdministratorCheck({ remainingAfterChange: 0, organizationName: org.name });
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: refusal.reason! });
      }
      return { userId: input.userId, organization: org.orgRef, rolesRevoked: result.rolesRevoked };
    }),

  invitations: router({
    /** This organization's invitations. `expired` is computed, never stored. */
    list: roleProcedure("people.invitations.list").query(async ({ ctx }) => {
      const org = await actingOrganization(ctx.user.id);
      const now = new Date();
      const rows = await listInvitations(org.orgRef);
      return {
        organization: { orgRef: org.orgRef, name: org.name },
        invitations: rows.map(r => ({
          ...r,
          view: invitationView({ orgRef: org.orgRef, status: r.status, expiresAt: r.expiresAt, acceptedAt: r.acceptedAt }, now),
        })),
      };
    }),

    /**
     * Invite somebody into this organization.
     *
     * Returns the raw token ONCE. It is stored only as a SHA-256 digest and is
     * written to no log and no audit row — the administrator who created it is
     * the only party that ever sees it, and they pass it on themselves.
     *
     * There is no email delivery because LeaseOS has no mail infrastructure;
     * inventing SMTP configuration would be worse than saying so. The link is
     * the deliverable, and where it goes is the administrator's decision.
     */
    create: roleProcedure("people.invitations.create")
      .input(
        z.object({
          email: z.string().email().max(320).optional(),
          displayName: z.string().min(1).max(180).optional(),
          roles: z.array(roleEnum).min(1).max(GRANTABLE_ROLES.length),
          defaultWorkspace: z.string().max(60).nullable().default(null),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const org = await actingOrganization(ctx.user.id);
        const check = defaultWorkspaceCheck({ requested: input.defaultWorkspace, roles: input.roles });
        if (!check.allowed) throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });

        const now = new Date();
        const raw = newToken();
        // A prefix of its own, deliberately: the three-letter invoice prefix is
        // canonical and comes from the row-locked sequence because people read it
        // aloud. An invitation reference is machinery nobody quotes over a radio, so
        // the ad-hoc generator is right for it — under a name that cannot be
        // mistaken for an invoice.
        const invitationRef = ref("INVITE");
        try {
          await createInvitation({
            orgRef: org.orgRef,
            invitationRef,
            tokenDigest: digestToken(raw),
            emailHint: input.email ?? null,
            displayNameHint: input.displayName ?? null,
            roles: input.roles,
            defaultWorkspace: input.defaultWorkspace,
            expiresAt: invitationExpiry(now),
            invitedByUserId: ctx.user.id,
            now,
          });
        } catch (error) {
          // The unique `pendingKey` is what actually prevents two live
          // invitations for one person — a read-then-write check would race.
          //
          // The duplicate has to be recognised through the CAUSE CHAIN: drizzle
          // rethrows as "Failed query: insert into ..." and the driver's
          // ER_DUP_ENTRY sits underneath, so testing `error.message` alone
          // turned a clean CONFLICT into a 500.
          if (isDuplicateKey(error)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "There is already a pending invitation for that address in this organization — cancel it first, or resend that one.",
            });
          }
          throw error;
        }

        return {
          invitationRef,
          organization: org.orgRef,
          roles: [...input.roles].sort(),
          expiresAt: invitationExpiry(now),
          /** Shown once. Never stored, never logged. */
          token: raw,
        };
      }),

    /** Cancel a pending invitation of this organization's. */
    cancel: roleProcedure("people.invitations.cancel")
      .input(z.object({ invitationRef: z.string().min(1).max(64), reason: z.string().min(3).max(300) }))
      .mutation(async ({ ctx, input }) => {
        const org = await actingOrganization(ctx.user.id);
        const cancelled = await cancelInvitation({
          orgRef: org.orgRef,
          invitationRef: input.invitationRef,
          cancelledByUserId: ctx.user.id,
          reason: input.reason,
          now: new Date(),
        });
        if (!cancelled) {
          // Another company's invitation, an accepted one and an already
          // cancelled one are the same answer on purpose.
          throw new TRPCError({ code: "NOT_FOUND", message: "No pending invitation with that reference" });
        }
        return { invitationRef: input.invitationRef, status: "cancelled" as const };
      }),
  }),

  accessResolution: router({
    /**
     * Quarantined grants held by people who work here.
     *
     * There is no such thing as "this organization's quarantined grants" — an
     * `unscoped_legacy` row belongs to no organization, which is why it
     * authorizes nowhere. This is the honest substitute, and the same predicate
     * `records.roles.resolveLegacy` enforces, so the list cannot offer a row the
     * mutation would refuse.
     *
     * Deliberately one at a time, and deliberately silent about origin: it
     * never suggests the grant might belong to another company, because saying
     * so would tell one employer about another.
     */
    list: roleProcedure("people.accessResolution.list").query(async ({ ctx }) => {
      const org = await actingOrganization(ctx.user.id);
      const rows = await listUnresolvedLegacyForOrganization(org.orgRef, new Date());
      return {
        organization: { orgRef: org.orgRef, name: org.name },
        needsResolution: rows,
        note:
          "These grants were written before roles carried an organization. They authorize nothing until an " +
          "administrator re-issues them here, deliberately, one at a time.",
      };
    }),
  }),
});

/**
 * Live `management` grants in an organization, for the last-administrator
 * invariant's tests. Exported here rather than from `db.ts` because it exists
 * for this surface's rule and has no other caller.
 */
export async function countManagementGrants(orgRef: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: userRoleAssignments.id })
    .from(userRoleAssignments)
    .where(
      and(
        eq(userRoleAssignments.orgRef, orgRef),
        eq(userRoleAssignments.role, "management" as never),
        isNull(userRoleAssignments.revokedAt)
      )
    );
  return rows.length;
}
