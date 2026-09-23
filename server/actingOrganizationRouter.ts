/**
 * 0170 — the organizations I belong to, and the one I am acting as.
 *
 * `resolveActingScope` refuses a user with live memberships in more than one
 * organization, because picking one would silently decide which company a
 * request writes into. That refusal is correct and stays. Without a way to
 * record a choice, though, it also means a genuinely multi-organization
 * person — a contractor administrator, a consultant across client companies,
 * an auditor with delegated access, the owner of two fleets — cannot use the
 * system at all. These two procedures are that way, and nothing more.
 *
 * ## What `actAs` is not
 *
 * It is not "become this tenant". The caller names a membership REF, not an
 * organization, and the server looks that membership up among the caller's own
 * currently active ones. A membership that is not the caller's, has ended, or
 * has not started is NOT_FOUND — the same answer, so a caller cannot use this
 * to discover which membership references exist.
 *
 * The write confers nothing. `resolveActingScope` re-reads the selection on
 * every request and re-validates it against the memberships live at that
 * moment, so revoking a membership takes effect immediately without anything
 * here being cleaned up.
 *
 * ## Why these are universal
 *
 * `organization.act_own` sits with the other `_own` permissions every role
 * holds. Both procedures read and write only `ctx.user.id`'s own memberships;
 * gating them by domain role would mean a driver who works for two companies
 * could not say which one they are driving for today, which is the case this
 * exists to serve.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { actingOrganizationSelections, organizationMemberships, organizations } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** The caller's own memberships that are live right now. Never anybody else's. */
async function activeMembershipsFor(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, userId: number, now: Date) {
  const rows = await db.select({
    membershipRef: organizationMemberships.membershipRef,
    orgRef: organizationMemberships.orgRef,
    membershipType: organizationMemberships.membershipType,
    branchId: organizationMemberships.branchId,
    effectiveFrom: organizationMemberships.effectiveFrom,
    effectiveTo: organizationMemberships.effectiveTo,
    name: organizations.name,
  })
    .from(organizationMemberships)
    .leftJoin(organizations, eq(organizations.orgRef, organizationMemberships.orgRef))
    .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  // The same effective-date window resolveActingScope applies, so this list and
  // that resolution can never disagree about what is live.
  return rows.filter(r => r.effectiveFrom.getTime() <= now.getTime() && (!r.effectiveTo || r.effectiveTo.getTime() > now.getTime()));
}

export const actingOrganizationRouter = router({
  /**
   * Which organizations I belong to, and which one I am acting as.
   *
   * `acting` is resolved rather than read back from the selection row, so it is
   * the answer the rest of the system would give for this caller — including
   * `null` when they belong to several and have chosen none, which is the state
   * that needs a choice rather than an error message.
   */
  memberships: roleProcedure("organization.memberships")
    .query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const now = new Date();
      const mine = await activeMembershipsFor(db, ctx.user.id, now);

      let acting: { orgRef: string; membershipRef: string | null; derivedFrom: string } | null = null;
      let mustChoose = false;
      try {
        const scope = await resolveActingScope(db, ctx.user.id, now);
        acting = { orgRef: scope.tenantId, membershipRef: scope.membershipRef, derivedFrom: scope.derivedFrom };
      } catch {
        // Several memberships and no usable selection. That is this procedure's
        // whole reason to exist, so it is a state to report, not to rethrow.
        mustChoose = true;
      }

      return {
        acting,
        mustChoose,
        memberships: mine.map(m => ({
          membershipRef: m.membershipRef,
          orgRef: m.orgRef,
          organizationName: m.name ?? null,
          membershipType: m.membershipType,
          branchId: m.branchId,
        })),
      };
    }),

  /**
   * Act as one of my organizations from now on.
   *
   * Named by membership, because a membership is the thing that grants the
   * access; naming the organization alone would let a caller ask about one they
   * only used to belong to.
   */
  actAs: roleProcedure("organization.actAs")
    .input(z.object({ membershipRef: z.string().min(1).max(64) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const now = new Date();
      const mine = await activeMembershipsFor(db, ctx.user.id, now);
      const chosen = mine.find(m => m.membershipRef === input.membershipRef);
      // Not mine, ended, not yet started, or no such membership — one answer, so
      // this cannot be used to enumerate membership references.
      if (!chosen) throw new TRPCError({ code: "NOT_FOUND", message: "No active membership of yours has that reference" });

      await db.insert(actingOrganizationSelections)
        .values({ userId: ctx.user.id, orgRef: chosen.orgRef, membershipRef: chosen.membershipRef, selectedAt: now, selectedByUserId: ctx.user.id })
        .onDuplicateKeyUpdate({ set: { orgRef: chosen.orgRef, membershipRef: chosen.membershipRef, selectedAt: now, selectedByUserId: ctx.user.id } });

      // Resolved, not echoed: what the caller gets back is what every other
      // procedure will now see, which is the only answer worth returning.
      const scope = await resolveActingScope(db, ctx.user.id, now);
      return { orgRef: scope.tenantId, membershipRef: scope.membershipRef, derivedFrom: scope.derivedFrom };
    }),
});
