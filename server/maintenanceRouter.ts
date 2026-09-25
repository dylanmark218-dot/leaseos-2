/**
 * Fleet maintenance — the API. Checkpoint 1 of the Mechanic Portal design
 * (docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md): who owns a work order, and cancelling one.
 *
 * Every procedure keys to a work order and answers "not found" across an organization boundary, never
 * "forbidden". Who acted is always the authenticated caller, never the request body.
 *
 * Holds, meter readings and the unit's operational state are the Fleet & Equipment Portfolio's
 * (`unitHolds`, `unitMeterReadings`, `fleetPortfolio.operationalState`); this router reads them through
 * `fleetPortfolioService` and does not build a second version of any of them.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, listActiveUserRoles, orgScopeWhere, userInScope, workOrderInScope } from "./db";
import { facilities, workOrderAssignments, workOrderReleases, workOrders } from "../drizzle/schema";
import { assignmentHistory, newRef, workOrderRow } from "./maintenanceService";
import { operationalStateFor } from "./fleetPortfolioService";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
async function workOrderOrNotFound(userId: number, workOrderId: number) {
  const scoped = await workOrderInScope(workOrderId, await actingScopeFor(userId));
  if (!scoped) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${workOrderId} not found` });
  const wo = await workOrderRow(await dbOrThrow(), workOrderId);
  if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${workOrderId} not found` });
  return wo;
}

export const maintenanceRouter = router({
  /* ---------------- work orders ---------------- */

  /** Who owns a work order now, and everyone who has. */
  workOrderAssignment: roleProcedure("maintenance.workOrderAssignment")
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const wo = await workOrderOrNotFound(ctx.user.id, input.workOrderId);
      return { workOrderId: wo.id, workOrderNumber: wo.workOrderNumber, status: wo.status, ...(await assignmentHistory(await dbOrThrow(), wo.id)) };
    }),

  /**
   * Assign, reassign or unassign. The assignee is a person who holds a shop role in this organization —
   * a work order owned by a name nobody can log in as is how `technician` came to be free text.
   */
  workOrderAssign: roleProcedure("maintenance.workOrderAssign")
    .input(z.object({ workOrderId: z.number().int().positive(), toUserId: z.number().int().positive().nullable(), shopFacilityId: z.number().int().positive().nullable().optional(), expectedCompletionAt: z.coerce.date().nullable().optional(), reason: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const wo = await workOrderOrNotFound(ctx.user.id, input.workOrderId);
      if (wo.status === "closed" || wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is ${wo.status} — there is nothing left to assign` });
      const db = await dbOrThrow();
      const scope = await actingScopeFor(ctx.user.id);
      if (input.toUserId != null) {
        if (!(await userInScope(input.toUserId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.toUserId} not found` });
        const roles = (await listActiveUserRoles(input.toUserId)).map(r => r.role);
        if (!roles.some(r => r === "mechanic" || r === "shop_lead")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `User ${input.toUserId} holds no shop role — assign a mechanic or a shop lead` });
      }
      if (input.shopFacilityId != null) {
        const f = (await db.select({ id: facilities.id }).from(facilities).where(and(eq(facilities.id, input.shopFacilityId), orgScopeWhere(facilities, scope))).limit(1))[0];
        if (!f) throw new TRPCError({ code: "NOT_FOUND", message: `Facility ${input.shopFacilityId} not found` });
      }
      const { current } = await assignmentHistory(db, wo.id);
      let eventType: "assigned" | "reassigned" | "unassigned";
      if (input.toUserId == null) {
        if (!current) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is not assigned` });
        eventType = "unassigned";
      } else if (!current) eventType = "assigned";
      else {
        const unchanged = current.userId === input.toUserId
          && (input.shopFacilityId === undefined || input.shopFacilityId === current.shopFacilityId)
          && (input.expectedCompletionAt === undefined || (input.expectedCompletionAt?.getTime() ?? null) === (current.expectedCompletionAt?.getTime() ?? null));
        if (unchanged) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is already assigned to user ${input.toUserId} on those terms` });
        eventType = "reassigned";
      }
      const eventRef = newRef("WOA");
      await db.insert(workOrderAssignments).values({
        eventRef, workOrderId: wo.id, unitId: wo.unitId, eventType,
        fromUserId: current?.userId ?? null, toUserId: input.toUserId,
        shopFacilityId: input.shopFacilityId !== undefined ? input.shopFacilityId : (current?.shopFacilityId ?? null),
        expectedCompletionAt: input.expectedCompletionAt !== undefined ? input.expectedCompletionAt : (current?.expectedCompletionAt ?? null),
        reason: input.reason ?? null, actorUserId: ctx.user.id, actorRole: ctx.roles[0] ?? "unknown", occurredAt: new Date(),
      });
      return { eventRef, workOrderId: wo.id, eventType, toUserId: input.toUserId };
    }),

  /**
   * Cancel a work order that will not be done. Cancelling is not closing: nothing was repaired, so the
   * defect it was opened for stays open and a unit held for it stays held. A work order whose release
   * still stands was done, and is closed rather than cancelled.
   */
  workOrderCancel: roleProcedure("maintenance.workOrderCancel")
    .input(z.object({ workOrderId: z.number().int().positive(), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const wo = await workOrderOrNotFound(ctx.user.id, input.workOrderId);
      if (wo.status === "closed" || wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is already ${wo.status}` });
      const db = await dbOrThrow();
      const releases = await db.select().from(workOrderReleases).where(eq(workOrderReleases.workOrderId, wo.id)).orderBy(desc(workOrderReleases.releasedAt), desc(workOrderReleases.id));
      if (releases[0] && releases[0].releaseType !== "revoked") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} carries a standing release — it was done; close it rather than cancel it` });
      }
      const res = await db.update(workOrders).set({ status: "cancelled", cancelledAt: new Date(), cancelledByUserId: ctx.user.id, cancelReason: input.reason })
        .where(and(eq(workOrders.id, wo.id), notInArray(workOrders.status, ["closed", "cancelled"])));
      if ((res as unknown as [{ affectedRows: number }])[0]?.affectedRows !== 1) throw new TRPCError({ code: "CONFLICT", message: `Work order ${wo.workOrderNumber} changed while it was being cancelled` });
      // The unit's state after the cancellation, from the portfolio's one projection.
      const unit = await operationalStateFor(db, wo.unitId);
      return {
        workOrderId: wo.id, workOrderNumber: wo.workOrderNumber, status: "cancelled" as const, unitStatus: unit.status,
        note: wo.defectId
          ? `Defect ${wo.defectId} stays open, and a unit held for it stays held; cancelling the work does not repair it.`
          : "Nothing was repaired under this work order.",
      };
    }),
});

