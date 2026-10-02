/**
 * Universal surfaces — the API.
 *
 * Five surfaces every portal shares: what needs attention, what is mine to
 * do, what is my day, find anything, and what happened to this thing. All
 * five read existing records; none writes. Each item on each surface carries
 * the permission a person needs to act on or read it, and the feed a caller
 * receives is filtered to that — the router does the filtering, not the UI.
 */

import { z } from "zod";
import { ACCESS_SCOPE_NOTICE, walkEvidenceChain, type ChainNodeKind } from "./_core/evidenceChainWalk";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoleNames } from "./db";
import { financeScopeFor } from "./_core/entityScope";
import { TRPCError } from "@trpc/server";

/**
 * P0-A3 — search, the chain and the timeline read records of every kind, money included, so they
 * carry the caller's organization and books (the strict money boundary) into the service, where
 * every query is filtered to them. Permission says what kinds of record a person may see; scope says
 * whose. Both hold.
 */
async function scopeFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return financeScopeFor(db, userId);
}
import { authorize, isDomainRole, type Permission, type RoleGrant } from "./_core/recordsAuthorization";
import { deriveExceptions, summarize, visibleTo } from "./_core/exceptionCentre";
import { CHAIN_READ_PERMISSION, loadExceptionSources, loadInbox, loadTimeline, resolveChainAround, searchEverything } from "./surfacesService";
import { composeSession } from "./_core/portalComposition";

/**
 * B23.1A — why these synthetic grants carry no organization, and why that is
 * correct here rather than a gap.
 *
 * `listActiveUserRoleNames` resolves the caller's acting organization and
 * returns names only from grants that organization issued, dropping
 * branch-confined and quarantined ones. So the filtering has already happened
 * by the time these names exist, and what comes back means "roles you hold,
 * here, unconfined". Rebuilding them as `{ role, scopeRef: null }` and letting
 * `authorize` read the absent `scopeType` as platform-global widens nothing:
 * the set it is applied to is already this organization's.
 *
 * The rule to keep: this projection must be fed from an organization-scoped
 * source. A caller that swapped in `listActiveUserRoles` or
 * `listRoleNamesAnyScope` here would be handing `authorize` another company's
 * roles with the evidence of where they came from stripped off.
 */
async function grantsFor(userId: number): Promise<{ roles: string[]; grants: RoleGrant[] }> {
  const roles = (await listActiveUserRoleNames(userId)).filter(isDomainRole);
  return { roles, grants: roles.map(role => ({ role, scopeRef: null })) };
}

const may = (userId: number, grants: RoleGrant[]) => {
  const cache = new Map<string, boolean>();
  return (p: string) => {
    if (!cache.has(p)) cache.set(p, authorize({ userId, grants, permission: p as Permission }).allowed);
    return cache.get(p)!;
  };
};

/**
 * TEN-INBOX-1 — the inbox and My Day take nothing from the caller: the person and the organization are the
 * session's. A request that names one (or anything else) is refused, not silently ignored.
 */
const NO_INPUT = z.object({}).strict().optional();

export const surfacesRouter = router({
  /**
   * Needs attention — derived from state, filtered to what the caller may act on.
   * TEN-EXC-1: the organization comes from the session only; an input that names one (or any other
   * unknown field) is refused, not silently dropped.
   */
  exceptions: roleProcedure("surfaces.exceptions")
    .input(z.object({ category: z.string().max(40).optional(), limit: z.number().int().positive().max(500).default(200) }).strict().optional())
    .query(async ({ ctx, input }) => {
      const { grants } = await grantsFor(ctx.user.id);
      const all = deriveExceptions(await loadExceptionSources(new Date(), await scopeFor(ctx.user.id)));
      let mine = visibleTo({ exceptions: all, userId: ctx.user.id, grants });
      if (input?.category) mine = mine.filter(x => x.category === input.category);
      return { summary: summarize(mine), items: mine.slice(0, input?.limit ?? 200) };
    }),

  /** Mine to do. Self-scoped; no user id in the input. */
  inbox: roleProcedure("surfaces.inbox").input(NO_INPUT).query(async ({ ctx }) => {
    const { roles, grants } = await grantsFor(ctx.user.id);
    const can = may(ctx.user.id, grants);
    const items = await loadInbox({ userId: ctx.user.id, roles, canApprovePurchases: can("purchasing.approve"), canResolveConflicts: can("sync.resolve_conflict"), canReviewAssistant: can("assistant.review") });
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { total: items.length, counts, items };
  }),

  /** My day: what am I doing, what needs attention, what am I waiting for, what should I do next. */
  myDay: roleProcedure("surfaces.myDay").input(NO_INPUT).query(async ({ ctx }) => {
    const { roles, grants } = await grantsFor(ctx.user.id);
    const can = may(ctx.user.id, grants);
    const [inbox, exceptions] = await Promise.all([
      loadInbox({ userId: ctx.user.id, roles, canApprovePurchases: can("purchasing.approve"), canResolveConflicts: can("sync.resolve_conflict"), canReviewAssistant: can("assistant.review") }),
      (async () => visibleTo({ exceptions: deriveExceptions(await loadExceptionSources(new Date(), await scopeFor(ctx.user.id))), userId: ctx.user.id, grants }))(),
    ]);
    const session = composeSession(roles as never);
    const waitingFor = inbox.filter(i => i.kind === "my_request" || i.kind === "ai_proposal");
    const toDo = inbox.filter(i => i.kind !== "my_request");
    const critical = exceptions.filter(e => e.severity === "critical");
    const next = critical[0] ? { kind: "exception" as const, title: critical[0].title, action: critical[0].action, deepLink: critical[0].deepLink }
      : toDo[0] ? { kind: "inbox" as const, title: toDo[0].title, action: toDo[0].kind.replace(/_/g, " "), deepLink: toDo[0].deepLink }
      : null;
    return {
      portals: session.portals.map(p => p.portal),
      attention: summarize(exceptions),
      toDo: { count: toDo.length, items: toDo.slice(0, 10) },
      waitingFor: { count: waitingFor.length, items: waitingFor.slice(0, 10) },
      next,
    };
  }),

  /** Find anything by tracking number or text. Hits are filtered to what the caller may read. */
  search: roleProcedure("surfaces.search")
    .input(z.object({ q: z.string().min(2).max(120) }))
    .query(async ({ ctx, input }) => {
      const { grants } = await grantsFor(ctx.user.id);
      const can = may(ctx.user.id, grants);
      const hits = (await searchEverything(input.q, await scopeFor(ctx.user.id))).filter(h => can(h.readPermission));
      return { q: input.q, total: hits.length, hits };
    }),

  /**
   * P3.6 — resolve a number, then walk the chain it sits in.
   *
   * Somebody holding a tracking number is almost never asking whether it exists. They are asking
   * what it belongs to: a dispatcher with a disposal ticket wants the load, trip, job and customer;
   * a driver on the phone has one number written on his hand.
   *
   * Owner decision (2026-09-19) on what the caller may not see: the hop is **absent**. Not a
   * redacted node, not a placeholder, not a count, not its position. And the access-scope notice is
   * on **every** chain, because a notice that appeared only when something was withheld would be
   * the disclosure — its presence would confirm a record exists.
   */
  chain: roleProcedure("surfaces.chain")
    .input(z.object({ entityType: z.enum(["load", "disposal_ticket"]), entityId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const { grants } = await grantsFor(ctx.user.id);
      const can = may(ctx.user.id, grants);
      // The anchor itself is subject to the same rule: no permission, nothing to say.
      if (!can(CHAIN_READ_PERMISSION[input.entityType]!)) {
        return {
          anchor: null, nodes: [], gaps: [], accessScopeNotice: ACCESS_SCOPE_NOTICE,
          explanation: "No chain is available for that reference within your access scope.",
        };
      }
      const { found, unreadable } = await resolveChainAround({ kind: input.entityType, id: input.entityId }, can, await scopeFor(ctx.user.id));
      const walk = walkEvidenceChain({
        anchorKind: input.entityType as ChainNodeKind,
        found: found as Parameters<typeof walkEvidenceChain>[0]["found"],
        unreadable: unreadable as ChainNodeKind[],
      });
      return { ...walk, anchor: walk.anchor };
    }),

  /** What happened to this thing, in order. Events filtered to what the caller may read. */
  timeline: roleProcedure("surfaces.timeline")
    .input(z.object({ entityType: z.enum(["unit", "job", "trip", "load"]), entityId: z.number().int().positive(), limit: z.number().int().positive().max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const { grants } = await grantsFor(ctx.user.id);
      const can = may(ctx.user.id, grants);
      const events = (await loadTimeline(input, await scopeFor(ctx.user.id))).filter(e => can(e.readPermission));
      return { entityType: input.entityType, entityId: input.entityId, total: events.length, events };
    }),
});
