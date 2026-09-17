/**
 * B24 — the widgets router.
 *
 * EXECUTED, against scratch shims for `_core/trpc`, `_core/recordsAuthorization`
 * and the dependency ports below. That proves the wiring — input validation,
 * identity taken from context rather than payload, role isolation at the
 * boundary, the refusal paths — and proves nothing about the real
 * `roleProcedure`. See `server/widgetsRouter.test.ts`.
 *
 * Deliberately thin. Each procedure resolves the acting role, calls one service
 * function, returns. Everything worth a test lives in `_core/`.
 *
 * The identity rule, which is the whole reason this file is short: `userId`,
 * `tenantId` and the acting role come off the context assembled by
 * authentication and `resolveActingScope`. The request body contributes only
 * what the server cannot know — whether the device has a signal, which unit it
 * is sitting in, and which of the caller's own boards to open.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, roleProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { listActiveUserRoles } from "./db";
import { isDomainRole } from "./_core/recordsAuthorization";
import { engineRoleKey } from "./_core/widgetRoleKeys";

/**
 * The one adaptation from the engine's scratch context to the branch's real one.
 * userId is the authenticated user; tenantId comes from `resolveActingScope`,
 * never from the request; roleKey is the role whose board is opened — the
 * caller may name one of the roles they hold, else their first active domain
 * role. `actorForRole` refuses a role the user does not hold.
 */
type BoardCtx = { userId: number; tenantId: string; roleKey: string };
async function boardCtx(ctx: { user: { id: number } }, requestedRole?: string | null): Promise<BoardCtx> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, ctx.user.id);
  const held = (await listActiveUserRoles(ctx.user.id)).map(g => g.role).filter(isDomainRole).map(engineRoleKey);
  const roleKey = requestedRole ?? held[0];
  if (!roleKey) throw new TRPCError({ code: "FORBIDDEN", message: "No active domain role; a board belongs to a role" });
  return { userId: ctx.user.id, tenantId: scope.tenantId, roleKey };
}
import { actorForRole, type RoleActor, type RoleGrantSource } from "./_core/roleActor";
import { listOfferable, openBoard, saveBoard, type BoardAudit, type TileReader, type WidgetLayoutStore } from "./_core/widgetService";

/**
 * What the router needs from the rest of the server.
 *
 * Injected rather than imported so the router can be executed. In the repo
 * these are `drizzleWidgetLayoutStore(db, scope.tenantId)`, the widget source
 * dispatcher, `recordAuthorizationDecision`, and the per-role grant reader.
 */
export type WidgetDeps = {
  storeFor(tenantId: string): WidgetLayoutStore;
  grants: RoleGrantSource;
  /** A reader bound to the acting user: each tile is read as that person, through its own procedure. */
  readerFor(actor: RoleActor): TileReader;
  audit?: BoardAudit;
};

const deviceClass = z.enum(["phone", "tablet", "desktop"]);

/**
 * Drop absent subject keys instead of passing `undefined` through.
 *
 * zod's `.optional()` emits the key with an undefined value, and under
 * `exactOptionalPropertyTypes` that is not the same as an absent key. It is not
 * a cosmetic difference here: `implicitSubjects[scope] ?? null` reads the same
 * either way, but a present-but-undefined key would survive an `in` check, and
 * the planner's rule is that a scoped tile with no subject renders `unknown`
 * rather than guessing.
 */
const definedSubjects = (
  s: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => e[1] !== undefined));

const subjects = z.object({
  unit: z.string().max(120).optional(),
  trailer: z.string().max(120).optional(),
  job: z.string().max(120).optional(),
  trip: z.string().max(120).optional(),
}).default({});

const layoutItem = z.object({
  instanceRef: z.string().min(1).max(64),
  // Not `z.enum(WIDGET_KEYS)`: an unregistered key has to reach the validator
  // so it can be refused by name. A schema rejection here would say only
  // "invalid enum value", which is the generic refusal the billing rules ban.
  widgetKey: z.string().min(1).max(64),
  variant: z.string().min(1).max(32),
  subjectRef: z.string().max(120).nullish(),
  position: z.number().int().min(0).max(999),
  spanColumns: z.number().int().min(1).max(4).optional(),
  spanRows: z.number().int().min(1).max(3).optional(),
  options: z.record(z.string(), z.unknown()).nullish(),
});

/** The acting role, or a refusal. Never a partially-trusted identity. */
async function actingActor(deps: WidgetDeps, ctx: BoardCtx) {
  const out = await actorForRole(deps.grants, {
    userId: ctx.userId, tenantId: ctx.tenantId, roleKey: ctx.roleKey,
  });
  if (!out.ok) throw new TRPCError({ code: "FORBIDDEN", message: out.detail });
  return out.actor;
}

export function widgetsRouter(deps: WidgetDeps) {
  return router({
    /** What the caller may put on this role's board. */
    offerable: roleProcedure("widgets.offerable")
      .input(z.object({ roleKey: z.string().max(64).optional() }).optional())
      .query(async ({ ctx, input }) => listOfferable(await actingActor(deps, await boardCtx(ctx, input?.roleKey)))),

    /** Open a board. Writes nothing; seeds from the registry when empty. */
    boardResolve: roleProcedure("widgets.boardResolve")
      .input(z.object({
        deviceClass,
        layoutRef: z.string().max(64).optional(),
        connected: z.boolean().default(true),
        subjects,
        roleKey: z.string().max(64).optional(),
      }))
      .query(async ({ ctx, input }) => {
        const actor = await actingActor(deps, await boardCtx(ctx, input.roleKey));
        return openBoard(
          {
            store: deps.storeFor(actor.tenantId),
            read: deps.readerFor(actor),
            ...(deps.audit ? { audit: deps.audit } : {}),
          },
          actor,
          {
            deviceClass: input.deviceClass, connected: input.connected, subjects: definedSubjects(input.subjects),
            ...(input.layoutRef ? { layoutRef: input.layoutRef } : {}),
          },
        );
      }),

    /** Save a board. Returns every rejection, or writes in one transaction. */
    layoutSave: roleProcedure("widgets.layoutSave")
      .input(z.object({
        // Absent means create, and the store assigns the reference.
        layoutRef: z.string().max(64).nullish(),
        deviceClass,
        name: z.string().min(1).max(120),
        isDefault: z.boolean(),
        items: z.array(layoutItem).max(64),
        roleKey: z.string().max(64).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const actor = await actingActor(deps, await boardCtx(ctx, input.roleKey));
        return saveBoard({ store: deps.storeFor(actor.tenantId) }, actor, {
          deviceClass: input.deviceClass, name: input.name, isDefault: input.isDefault,
          items: input.items.map((i) => ({
            instanceRef: i.instanceRef, widgetKey: i.widgetKey, variant: i.variant,
            position: i.position,
            ...(i.subjectRef === undefined ? {} : { subjectRef: i.subjectRef }),
            ...(i.spanColumns === undefined ? {} : { spanColumns: i.spanColumns }),
            ...(i.spanRows === undefined ? {} : { spanRows: i.spanRows }),
            ...(i.options === undefined ? {} : { options: i.options }),
          })),
          ...(input.layoutRef ? { layoutRef: input.layoutRef } : {}),
        });
      }),
  });
}

export type WidgetsRouter = ReturnType<typeof widgetsRouter>;
