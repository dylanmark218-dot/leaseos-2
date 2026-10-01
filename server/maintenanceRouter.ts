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
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, listActiveUserRoles, orgScopeWhere, unitInScope, userInScope, workOrderInScope } from "./db";
import { facilities, maintenanceDefects, unitHolds, workOrderAssignments, workOrderReleases, workOrderTasks, workOrders } from "../drizzle/schema";
import { assignmentHistory, newRef, workOrderRow } from "./maintenanceService";
import { operationalStateFor, orgRefOf } from "./fleetPortfolioService";
import { actingRoleFor, driverNotice, mayPlaceHold, mayReleaseHold } from "./_core/fleetPortfolio";
import { currentReleaseEvidenceFor, defectIdsNamedBy } from "./_core/mechanicRelease";
import { permissionsFor, type Permission } from "./_core/recordsAuthorization";
import { requireCallerUnits } from "./unitScope";
import {
  activeDefectHolds, addTask, DEFECT_HOLD_ROLE, defectHistory, defectRow, liveWorkOrderFor, lifecycleRef, recordReturnToService,
  releasesFor, reportDefect, sendToShop, setTaskStatus, taskTransitionRefusal, triageDefect, triagePlan, unfinishedTasks,
} from "./defectLifecycleService";

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

/** The role the caller acts in for this permission — the first of theirs that holds it. */
const roleHolding = (roles: readonly string[], permission: Permission) => roles.find(r => permissionsFor([r]).includes(permission)) ?? roles[0] ?? "unknown";

/** A defect the caller's organization may see — through its unit — or "not found", like one that does not exist. */
async function defectOrNotFound(userId: number, defectId: number) {
  const db = await dbOrThrow();
  const d = await defectRow(db, defectId);
  if (!d || !(await unitInScope(d.unitId, await actingScopeFor(userId)))) throw new TRPCError({ code: "NOT_FOUND", message: `Defect ${defectId} not found` });
  return d;
}

const SEVERITY = z.enum(["advisory", "inspection_required", "critical"]);
const TASK_KIND = z.enum(["inspect", "diagnose", "repair", "replace", "adjust", "road_test", "other"]);

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

  /* ---------------- checkpoint 2: defect → work order → repair → return to service ---------------- */

  /**
   * Report a defect: the reporter's words kept as said, their severity kept as a proposal. Until triage
   * the proposal stands (design O-3): a reported critical holds the unit at once, with a `unitHolds`
   * safety hold that only an independent return to service lifts.
   */
  defectReport: roleProcedure("maintenance.defectReport")
    .input(z.object({
      unitId: z.number().int().positive(),
      title: z.string().min(3).max(220),
      driverStatement: z.string().min(1).max(4000),
      severityProposed: SEVERITY,
      source: z.enum(["driver_report", "mechanic_inspection", "office"]).default("driver_report"),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = await requireCallerUnits(ctx.user.id, { unitId: input.unitId });
      const db = await dbOrThrow();
      const r = await reportDefect(db, {
        unitId: input.unitId, orgRef: orgRefOf(scope.tenantId), title: input.title, driverStatement: input.driverStatement,
        severityProposed: input.severityProposed, source: input.source,
        actor: { userId: ctx.user.id, role: roleHolding(ctx.roles, "maintenance.write_defect") }, at: new Date(),
      });
      const state = await operationalStateFor(db, input.unitId);
      return { ...r, unitStatus: state.status, driverNotice: driverNotice(state) };
    }),

  /**
   * Decide a defect's severity. Raising it to critical holds the unit (safety, out of service);
   * `holdUnit` on an inspection-required defect holds it for maintenance. Lowering it releases the
   * defect's hold — which the portfolio's hold rule governs: never by whoever placed it, and a safety
   * hold only by safety or management. So a mechanic may raise a defect to critical, and may not take a
   * critical back down alone.
   */
  defectTriage: roleProcedure("maintenance.defectTriage")
    .input(z.object({ defectId: z.number().int().positive(), severity: SEVERITY, reason: z.string().min(5).max(600), holdUnit: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      let d = await defectOrNotFound(ctx.user.id, input.defectId);
      if (d.status === "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Defect ${d.id} is resolved — a new finding is a new defect` });
      const db = await dbOrThrow();
      if (!d.defectRef) {
        // A defect from before 0221 gets its reference the first time it is triaged, so its hold can name it.
        await db.update(maintenanceDefects).set({ defectRef: lifecycleRef("DEF") }).where(and(eq(maintenanceDefects.id, d.id), isNull(maintenanceDefects.defectRef)));
        d = (await defectRow(db, d.id))!;
      }
      const current = await activeDefectHolds(db, [d.defectRef!]);
      const plan = triagePlan(current, input.severity, input.holdUnit);
      for (const h of plan.release) {
        const may = mayReleaseHold({ roles: ctx.roles, holdType: h.holdType, placedByUserId: h.placedByUserId, userId: ctx.user.id, status: h.status });
        if (!may.allowed) throw new TRPCError({ code: "FORBIDDEN", message: `${may.reason} — this decision would release defect ${d.defectRef}'s ${h.holdType} hold` });
      }
      if (plan.place?.holdType === "maintenance" && !mayPlaceHold(ctx.roles, "maintenance").allowed) {
        throw new TRPCError({ code: "FORBIDDEN", message: mayPlaceHold(ctx.roles, "maintenance").reason });
      }
      const scope = await actingScopeFor(ctx.user.id);
      const at = new Date();
      const r = await triageDefect(db, {
        defect: d, orgRef: orgRefOf(scope.tenantId), severity: input.severity, reason: input.reason, plan,
        placedByRole: plan.place?.holdType === "safety" ? DEFECT_HOLD_ROLE : (actingRoleFor(ctx.roles, "maintenance", "place") ?? DEFECT_HOLD_ROLE),
        releaseRole: plan.release[0] ? actingRoleFor(ctx.roles, plan.release[0].holdType, "release") : null,
        actor: { userId: ctx.user.id, role: roleHolding(ctx.roles, "maintenance.defect.triage") }, at,
      });
      const state = await operationalStateFor(db, d.unitId);
      return { defectId: d.id, defectRef: d.defectRef, from: d.severity, severity: input.severity, releasedHoldRefs: r.released, placedHoldRef: r.placed, unitStatus: state.status };
    }),

  /** Open the work order for a defect and its first task, in one transaction. One live work order per defect. */
  defectSendToShop: roleProcedure("maintenance.defectSendToShop")
    .input(z.object({
      defectId: z.number().int().positive(),
      task: z.object({ kind: TASK_KIND.default("repair"), title: z.string().min(3).max(220).optional(), instructions: z.string().max(4000).optional() }).default({ kind: "repair" }),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await defectOrNotFound(ctx.user.id, input.defectId);
      if (d.status === "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Defect ${d.id} is resolved — there is nothing to repair` });
      const db = await dbOrThrow();
      const live = await liveWorkOrderFor(db, d.id);
      if (live) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Defect ${d.id} is already in the shop on ${live.workOrderNumber} (${live.status})` });
      const r = await sendToShop(db, {
        defect: d, firstTask: { kind: input.task.kind, title: input.task.title ?? d.title, instructions: input.task.instructions ?? null },
        actor: { userId: ctx.user.id, role: roleHolding(ctx.roles, "maintenance.defect.send_to_shop") }, at: new Date(),
      });
      return { defectId: d.id, ...r };
    }),

  /** Add a task to a work order. A task that names a defect names one on the same unit. */
  taskAdd: roleProcedure("maintenance.taskAdd")
    .input(z.object({ workOrderId: z.number().int().positive(), kind: TASK_KIND, title: z.string().min(3).max(220), instructions: z.string().max(4000).optional(), defectId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const wo = await workOrderOrNotFound(ctx.user.id, input.workOrderId);
      if (wo.status === "closed" || wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is ${wo.status}` });
      const db = await dbOrThrow();
      if (input.defectId != null) {
        const d = await defectRow(db, input.defectId);
        if (!d || d.unitId !== wo.unitId) throw new TRPCError({ code: "NOT_FOUND", message: `Defect ${input.defectId} not found` });
      }
      return addTask(db, {
        workOrder: { id: wo.id, unitId: wo.unitId, defectId: wo.defectId ?? null }, defectId: input.defectId ?? null,
        kind: input.kind, title: input.title, instructions: input.instructions ?? null,
        actor: { userId: ctx.user.id, role: roleHolding(ctx.roles, "maintenance.task.write") }, at: new Date(),
      });
    }),

  /** Move a task forward. Done states the corrective action; not required states why; deferred states the reason. */
  taskSetStatus: roleProcedure("maintenance.taskSetStatus")
    .input(z.object({
      taskRef: z.string().min(1).max(64), status: z.enum(["in_progress", "done", "not_required", "deferred"]),
      findings: z.string().max(4000).optional(), correctiveAction: z.string().max(4000).optional(), deferredReason: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const task = (await db.select().from(workOrderTasks).where(eq(workOrderTasks.taskRef, input.taskRef)).limit(1))[0];
      if (!task || !(await workOrderInScope(task.workOrderId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Task ${input.taskRef} not found` });
      const wo = (await workOrderRow(db, task.workOrderId))!;
      if (wo.status === "closed" || wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is ${wo.status}` });
      const refusal = taskTransitionRefusal(task.status, input.status, input);
      if (refusal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: refusal });
      const ok = await setTaskStatus(db, {
        task, workOrderDefectId: wo.defectId ?? null, to: input.status,
        findings: input.findings ?? null, correctiveAction: input.correctiveAction ?? null, deferredReason: input.deferredReason ?? null,
        actor: { userId: ctx.user.id, role: roleHolding(ctx.roles, "maintenance.task.write") }, at: new Date(),
      });
      if (!ok) throw new TRPCError({ code: "CONFLICT", message: `Task ${input.taskRef} changed while it was being updated` });
      return { taskRef: input.taskRef, from: task.status, status: input.status };
    }),

  /**
   * Return to service: a second person verifies the released repair. Refused to the technician who
   * signed the release, and — through the portfolio's hold rule — to whoever placed a hold it would lift
   * and to a role that may not release that hold's type (a critical defect's safety hold: safety or
   * management). It needs a standing release that names the work order's defect, and every task
   * finished. A pass resolves the named defects on that release, lifts their holds, closes the roadside
   * events they came from and closes the work order — one transaction. A fail is recorded and changes
   * nothing else. It never lifts a government out-of-service order: that is `enforcement.orderRelease`.
   */
  returnToService: roleProcedure("maintenance.returnToService")
    .input(z.object({ workOrderId: z.number().int().positive(), releaseId: z.number().int().positive(), outcome: z.enum(["pass", "fail"]), summary: z.string().min(5).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const wo = await workOrderOrNotFound(ctx.user.id, input.workOrderId);
      if (wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} was cancelled — nothing was repaired under it` });
      if (wo.status === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order ${wo.workOrderNumber} is closed` });
      const db = await dbOrThrow();
      const releases = await releasesFor(db, wo.id);
      const release = releases.find(r => r.id === input.releaseId);
      if (!release) throw new TRPCError({ code: "NOT_FOUND", message: `Release ${input.releaseId} not found on work order ${wo.workOrderNumber}` });
      if (release.technicianUserId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: `You signed release ${release.id}; returning the unit to service is a second person's verification of that repair` });
      }
      const named = defectIdsNamedBy(release);
      if (!named.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Release ${release.id} names no defect — a return to service verifies the repair of named defects` });
      if (wo.defectId != null && !named.includes(wo.defectId)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Release ${release.id} does not name defect ${wo.defectId}, which this work order was opened for` });
      }
      const stored = releases.map(r => ({ id: r.id, workOrderId: r.workOrderId, releaseType: r.releaseType, testResult: r.testResult, resolvedDefectIds: r.resolvedDefectIds, releasedAt: r.releasedAt }));
      for (const id of named) {
        if (currentReleaseEvidenceFor(id, stored)?.id !== release.id) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Release ${release.id} does not stand for defect ${id} — it was revoked, its test failed, or a later release superseded it` });
        }
      }
      const unfinished = await unfinishedTasks(db, wo.id);
      if (unfinished.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Unfinished tasks on ${wo.workOrderNumber}: ${unfinished.map(t => `${t.taskRef} (${t.status})`).join(", ")}` });
      const defects = (await db.select().from(maintenanceDefects).where(inArray(maintenanceDefects.id, named))).filter(d => d.unitId === wo.unitId);
      const holds = await activeDefectHolds(db, defects.map(d => d.defectRef).filter((r): r is string => !!r));
      if (input.outcome === "pass") {
        for (const h of holds) {
          const may = mayReleaseHold({ roles: ctx.roles, holdType: h.holdType, placedByUserId: h.placedByUserId, userId: ctx.user.id, status: h.status });
          if (!may.allowed) throw new TRPCError({ code: "FORBIDDEN", message: `${may.reason} — ${h.holdRef} holds this unit for defect ${h.sourceRef}` });
        }
      }
      const role = (holds[0] && actingRoleFor(ctx.roles, holds[0].holdType, "release")) || roleHolding(ctx.roles, "maintenance.return_to_service.record");
      const r = await recordReturnToService(db, {
        workOrder: { id: wo.id, unitId: wo.unitId, status: wo.status }, release, defects, holds: input.outcome === "pass" ? holds : [],
        outcome: input.outcome, summary: input.summary, actor: { userId: ctx.user.id, role }, at: new Date(),
      });
      const state = await operationalStateFor(db, wo.unitId);
      return { workOrderId: wo.id, releaseId: release.id, ...r, unitStatus: state.status, driverNotice: driverNotice(state) };
    }),

  /** A defect's whole story: what was said, proposed and decided, every act on it, its work orders' tasks, its holds. */
  defectHistory: roleProcedure("maintenance.defectHistory")
    .input(z.object({ defectId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const d = await defectOrNotFound(ctx.user.id, input.defectId);
      const db = await dbOrThrow();
      const wos = await db.select({ id: workOrders.id, workOrderNumber: workOrders.workOrderNumber, status: workOrders.status }).from(workOrders).where(eq(workOrders.defectId, d.id));
      const tasks = wos.length ? await db.select().from(workOrderTasks).where(inArray(workOrderTasks.workOrderId, wos.map(w => w.id))).orderBy(workOrderTasks.workOrderId, workOrderTasks.seq) : [];
      const holds = d.defectRef ? await db.select().from(unitHolds).where(and(eq(unitHolds.sourceKind, "defect"), eq(unitHolds.sourceRef, d.defectRef))) : [];
      return {
        defect: { id: d.id, defectRef: d.defectRef, unitId: d.unitId, title: d.title, severity: d.severity, severityProposed: d.severityProposed, status: d.status, source: d.source, driverStatement: d.driverStatement, reportedAt: d.reportedAt, resolvedAt: d.resolvedAt, resolvedByReleaseId: d.resolvedByReleaseId },
        events: await defectHistory(db, d.id), workOrders: wos, tasks, holds,
      };
    }),
});

