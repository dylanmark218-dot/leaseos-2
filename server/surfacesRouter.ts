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
import { listActiveUserRoleNames } from "./db";
import { authorize, isDomainRole, type Permission, type RoleGrant } from "./_core/recordsAuthorization";
import { deriveExceptions, forTenant, summarize, visibleTo } from "./_core/exceptionCentre";
import { getDb } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";

/** 0172 — the caller's organization, for tenant-tagged exceptions. */
async function actingTenant(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) return SINGLE_TENANT_ID;
  return (await resolveActingScope(db, userId)).tenantId;
}
import { CHAIN_READ_PERMISSION, loadExceptionSources, loadInbox, loadTimeline, resolveChainAround, searchEverything } from "./surfacesService";
import { composeSession } from "./_core/portalComposition";

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

export const surfacesRouter = router({
  /** Needs attention — derived from state, filtered to what the caller may act on. */
  exceptions: roleProcedure("surfaces.exceptions")
    .input(z.object({ category: z.string().max(40).optional(), limit: z.number().int().positive().max(500).default(200) }).optional())
    .query(async ({ ctx, input }) => {
      const { grants } = await grantsFor(ctx.user.id);
      const all = deriveExceptions(await loadExceptionSources());
      let mine = forTenant(visibleTo({ exceptions: all, userId: ctx.user.id, grants }), await actingTenant(ctx.user.id));
      if (input?.category) mine = mine.filter(x => x.category === input.category);
      return { summary: summarize(mine), items: mine.slice(0, input?.limit ?? 200) };
    }),

  /** Mine to do. Self-scoped; no user id in the input. */
  inbox: roleProcedure("surfaces.inbox").query(async ({ ctx }) => {
    const { roles, grants } = await grantsFor(ctx.user.id);
    const can = may(ctx.user.id, grants);
    const items = await loadInbox({ userId: ctx.user.id, roles, canApprovePurchases: can("purchasing.approve"), canResolveConflicts: can("sync.resolve_conflict"), canReviewAssistant: can("assistant.review") });
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { total: items.length, counts, items };
  }),

  /** My day: what am I doing, what needs attention, what am I waiting for, what should I do next. */
  myDay: roleProcedure("surfaces.myDay").query(async ({ ctx }) => {
    const { roles, grants } = await grantsFor(ctx.user.id);
    const can = may(ctx.user.id, grants);
    const [inbox, exceptions] = await Promise.all([
      loadInbox({ userId: ctx.user.id, roles, canApprovePurchases: can("purchasing.approve"), canResolveConflicts: can("sync.resolve_conflict"), canReviewAssistant: can("assistant.review") }),
      (async () => forTenant(visibleTo({ exceptions: deriveExceptions(await loadExceptionSources()), userId: ctx.user.id, grants }), await actingTenant(ctx.user.id)))(),
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
      const hits = (await searchEverything(input.q)).filter(h => can(h.readPermission));
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
      const { found, unreadable } = await resolveChainAround({ kind: input.entityType, id: input.entityId }, can);
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
      const events = (await loadTimeline(input)).filter(e => can(e.readPermission));
      return { entityType: input.entityType, entityId: input.entityId, total: events.length, events };
    }),
});
