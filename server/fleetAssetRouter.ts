/**
 * Fleet & Equipment Portfolio — the asset core procedures, spread into the `fleet` router
 * (`server/fleetPortfolioRouter.ts`) so the client reads one `trpc.fleet.*` surface.
 *
 * Identity, lifecycle, components, the list, the detail, the unit-side readiness and the driver's own
 * assigned units. Every procedure keys to a unit the caller's organization owns and answers NOT_FOUND
 * otherwise, worded as for a unit that does not exist (server/unitScope.ts). Who acted is always the
 * authenticated caller; `fleet.myAssignedUnits` takes no unit id from the driver at all.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { roleProcedure } from "./_core/trpc";
import { actingScopeFor, getDb, operatorForUserInScope, unitInScope } from "./db";
import { unitComponents, units } from "../drizzle/schema";
import { driverNotice } from "./_core/fleetPortfolio";
import { assetClassSchema, assetIdentitySchema, componentRelationshipSchema, lifecycleStatusSchema, assetTypeSchema } from "../shared/fleetAssetTypes";
import { operationalStateFor, orgRefOf } from "./fleetPortfolioService";
import {
  assetDetail, attachComponent, componentsOf, createAsset, detachComponent, identityOf, lifecycleOf, listAssets, setLifecycle,
  unitRow, unitSideReadiness, unitsAssignedTo, updateAsset,
} from "./fleetAssetService";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
const notFound = (unitId: number) => new TRPCError({ code: "NOT_FOUND", message: `Unit ${unitId} not found` });
/** The unit row, if the caller's organization owns it; otherwise NOT_FOUND as for a unit that does not exist. */
async function unitInCallerScope(userId: number, unitId: number) {
  const scope = await actingScopeFor(userId);
  if (!(await unitInScope(unitId, scope))) throw notFound(unitId);
  const u = await unitRow(await dbOrThrow(), unitId);
  if (!u) throw notFound(unitId);
  return { u, scope, orgRef: orgRefOf(scope.tenantId) };
}
/** The role a write is recorded under: the first of the caller's roles that holds the permission's grant, by convention the first role. */
const actingRole = (roles: readonly string[]) => roles[0] ?? "unknown";
/** The offline allowance a driver's unit card carries (design §B.11): the server's answer holds this long at most. */
const CARD_HOURS = 24;

export const fleetAssetProcedures = {
  /** The fleet, filtered, each unit with its derived state. Capped; the cap is stated in the answer. */
  list: roleProcedure("fleet.list")
    .input(z.object({
      lifecycle: lifecycleStatusSchema.nullable().optional(), assetClass: assetClassSchema.nullable().optional(), assetType: assetTypeSchema.nullable().optional(),
      branchRef: z.string().max(64).nullable().optional(), q: z.string().max(80).nullable().optional(),
      status: z.enum(["available", "warning", "maintenance_hold", "out_of_service", "indeterminate"]).nullable().optional(),
    }).default({}))
    .query(async ({ ctx, input }) => listAssets(await dbOrThrow(), await actingScopeFor(ctx.user.id), input)),

  /** One unit: identity, lifecycle, state, holds, components, meters, documents, insurance, defects, work orders, inspections, assignment. */
  get: roleProcedure("fleet.get")
    .input(z.object({ unitId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const { u } = await unitInCallerScope(ctx.user.id, input.unitId);
      const d = await assetDetail(await dbOrThrow(), u);
      return { ...d, driverNotice: driverNotice(d.state) };
    }),

  /** "Why can't this unit leave?" — the unit's side only, through the one classification; not a dispatch verdict. */
  unitReadiness: roleProcedure("fleet.unitReadiness")
    .input(z.object({ unitId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const { u } = await unitInCallerScope(ctx.user.id, input.unitId);
      return unitSideReadiness(await dbOrThrow(), u);
    }),

  /** Register a unit with its identity. Sensitive. The class is derived from the type; the legacy vehicle type from the type too. */
  assetCreate: roleProcedure("fleet.assetCreate")
    .input(z.object({ unitNumber: z.string().trim().min(1).max(40) }).merge(assetIdentitySchema))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const db = await dbOrThrow();
      const { unitNumber, ...identity } = input;
      // `units.unitNumber` is unique across the database (design O-2): a taken number is a conflict, named.
      const taken = (await db.select({ id: units.id }).from(units).where(eq(units.unitNumber, unitNumber)).limit(1))[0];
      if (taken) throw new TRPCError({ code: "CONFLICT", message: `Unit number ${unitNumber} is already in use` });
      const unitId = await createAsset(db, { unitNumber, identity, scope, byUserId: ctx.user.id, byRole: actingRole(ctx.roles) });
      return { unitId, unitNumber };
    }),

  /** Change identity fields. Sensitive. Lifecycle and holds have their own acts and are refused here at the schema. */
  assetUpdate: roleProcedure("fleet.assetUpdate")
    .input(z.object({ unitId: z.number().int().positive() }).merge(assetIdentitySchema.partial()).strict())
    .mutation(async ({ ctx, input }) => {
      const { u } = await unitInCallerScope(ctx.user.id, input.unitId);
      const { unitId: _id, ...patch } = input;
      const changed = await updateAsset(await dbOrThrow(), { unit: u, patch, byUserId: ctx.user.id, byRole: actingRole(ctx.roles) });
      const after = await unitRow(await dbOrThrow(), u.id);
      return { unitId: u.id, changed, identity: identityOf(after ?? u) };
    }),

  /**
   * Record a lifecycle change, with the reason. Sensitive; a person's act (never an agent's). Returning a
   * retired or sold unit to the fleet is management's alone. Conditional on the status the caller saw.
   */
  lifecycleSet: roleProcedure("fleet.lifecycleSet")
    .input(z.object({ unitId: z.number().int().positive(), to: lifecycleStatusSchema, reason: z.string().trim().min(5).max(400), expectedFrom: lifecycleStatusSchema.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { u } = await unitInCallerScope(ctx.user.id, input.unitId);
      if (input.expectedFrom && input.expectedFrom !== u.lifecycleStatus) throw new TRPCError({ code: "CONFLICT", message: `Unit ${u.unitNumber} is ${u.lifecycleStatus}, not ${input.expectedFrom}: re-read it` });
      const db = await dbOrThrow();
      const r = await setLifecycle(db, { unit: u, to: input.to, reason: input.reason, roles: ctx.roles, byUserId: ctx.user.id, byRole: actingRole(ctx.roles) });
      if (!r.ok) throw new TRPCError({ code: r.code === "conflict" ? "CONFLICT" : "PRECONDITION_FAILED", message: r.reason });
      const state = await operationalStateFor(db, u.id);
      return { unitId: u.id, lifecycle: lifecycleOf((await unitRow(db, u.id))!), status: state.status, driverNotice: driverNotice(state) };
    }),

  /** Every relation the unit takes part in — carrying and carried — with history when asked. */
  components: roleProcedure("fleet.components")
    .input(z.object({ unitId: z.number().int().positive(), includeHistory: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const { u } = await unitInCallerScope(ctx.user.id, input.unitId);
      return { unitId: u.id, components: await componentsOf(await dbOrThrow(), u.id, input.includeHistory) };
    }),

  /** Attach a component to a unit. Sensitive. Both units are the caller's; the rules are in _core/fleetAssets.ts. */
  componentAttach: roleProcedure("fleet.componentAttach")
    .input(z.object({ parentUnitId: z.number().int().positive(), childUnitId: z.number().int().positive(), relationship: componentRelationshipSchema, removable: z.boolean().default(true), installedAt: z.coerce.date().default(() => new Date()), workOrderId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { u: parent, orgRef } = await unitInCallerScope(ctx.user.id, input.parentUnitId);
      const { u: child } = await unitInCallerScope(ctx.user.id, input.childUnitId);
      if (input.installedAt.getTime() > Date.now() + 5 * 60_000) throw new TRPCError({ code: "BAD_REQUEST", message: "An installation cannot be recorded in the future" });
      const r = await attachComponent(await dbOrThrow(), { parent, child, relationship: input.relationship, removable: input.removable, installedAt: input.installedAt, workOrderId: input.workOrderId ?? null, orgRef, byUserId: ctx.user.id, byRole: actingRole(ctx.roles) });
      if (!r.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: r.reason });
      return { componentRef: r.componentRef, parentUnitId: parent.id, childUnitId: child.id };
    }),

  /** Detach one component, once, with the reason. Sensitive. The relation stays as history. */
  componentDetach: roleProcedure("fleet.componentDetach")
    .input(z.object({ componentRef: z.string().min(1).max(96), reason: z.string().trim().min(5).max(400), workOrderId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const rel = (await db.select().from(unitComponents).where(eq(unitComponents.componentRef, input.componentRef)).limit(1))[0];
      // Another organization's relation is a relation that does not exist.
      if (!rel || !(await unitInScope(rel.parentUnitId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Component ${input.componentRef} not found` });
      if (rel.removedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Component ${rel.componentRef} was already detached` });
      const removed = await detachComponent(db, { relation: rel, reason: input.reason, workOrderId: input.workOrderId ?? null, byUserId: ctx.user.id, byRole: actingRole(ctx.roles) });
      if (!removed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Component ${rel.componentRef} was detached by someone else a moment ago` });
      return { componentRef: rel.componentRef, parentUnitId: rel.parentUnitId, childUnitId: rel.childUnitId };
    }),

  /**
   * The driver's own: the units and trailers bound to the caller's operator in a live slot — what D-11
   * lets a driver see — each with its state and the words a driver reads. Takes no unit id; the slot
   * model is the one source of "assigned". Carries how long the answer holds, for the phone.
   */
  myAssignedUnits: roleProcedure("fleet.myAssignedUnits")
    .query(async ({ ctx }) => {
      const scope = await actingScopeFor(ctx.user.id);
      const op = await operatorForUserInScope(ctx.user.id, scope);
      if (op.kind === "none") throw new TRPCError({ code: "NOT_FOUND", message: "No operator record is linked to your user in this organization" });
      if (op.kind === "ambiguous") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "More than one operator record names your user in this organization; a person has to resolve which is yours" });
      const db = await dbOrThrow();
      const bound = await unitsAssignedTo(db, op.operatorId);
      const now = new Date();
      const cards = await Promise.all(bound.map(async b => {
        const u = await unitRow(db, b.unitId);
        if (!u || !(await unitInScope(u.id, scope))) return null;
        const state = await operationalStateFor(db, u.id);
        return { unitId: u.id, unitNumber: u.unitNumber, role: b.role, jobId: b.jobId, assetClass: u.assetClass, assetType: u.assetType, lifecycleStatus: u.lifecycleStatus, status: state.status, since: state.since, driverNotice: driverNotice(state), reasons: state.reasons.map(r => ({ code: r.code, label: r.label, status: r.status })) };
      }));
      return {
        operatorId: op.operatorId, units: cards.filter((c): c is NonNullable<typeof c> => c != null),
        cache: { generatedAt: now, validUntil: new Date(now.getTime() + CARD_HOURS * 3_600_000), staleRule: "A cached card past validUntil reads STALE — reconnect to confirm; a held unit stays held" },
      };
    }),
};
