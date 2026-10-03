/**
 * Mechanic Portal checkpoint 2 — a defect, from the report to the return to service, as one lifecycle.
 *
 *   unit → defect → work order → hold → repair tasks → release (repair evidence)
 *        → independent return to service → derived operational state → dispatch readiness
 *
 * Every act here writes a `maintenanceDefectEvents` row in the same transaction as the change it
 * records, with the actor and the role they acted in. Holds are the Fleet & Equipment Portfolio's
 * `unitHolds` (placed and released through `fleetPortfolioService`, never a second table); the unit's
 * state is the portfolio's projection; readiness reads holds and defects as it always has.
 *
 * Two facts, two records — not one fact twice:
 *   - a **critical defect** says the unit is unrepaired: readiness's `critical_defect` /
 *     `mechanic_release_missing`, cleared by a standing release that names it;
 *   - the defect's **hold** says the unit has not yet been returned to service by a second person:
 *     `unit_hold_<type>`, cleared only by `returnToService`, which is refused to the technician who
 *     signed the release and to whoever placed the hold, and which applies the portfolio's hold
 *     authority (a safety hold is released by safety or management).
 *
 * The callers have already proved the unit is the caller's organization's (`server/unitScope.ts`,
 * `workOrderInScope`); nothing here reads a tenant from the request.
 */
import { and, desc, eq, inArray, max, ne, notInArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  inspections, maintenanceDefectEvents, maintenanceDefects, roadsideServiceEvents, unitHolds,
  workOrderReleases, workOrderTasks, workOrders,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import type { HoldType } from "./_core/fleetPortfolio";
import { placeHold, releaseHold } from "./fleetPortfolioService";

export const lifecycleRef = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;

/**
 * The role a hold records when the defect's severity places it. The person is whoever reported or
 * triaged; the authority is the severity, not their role — so a driver's critical report holds the
 * unit although a driver may not place a hold by hand.
 */
export const DEFECT_HOLD_ROLE = "defect_severity";

export type Severity = "advisory" | "inspection_required" | "critical";
type Actor = { userId: number; role: string };
type EventType = typeof maintenanceDefectEvents.$inferInsert["eventType"];

export async function defectEvent(db: DbOrTx, e: {
  defectId: number; unitId: number; eventType: EventType; actor: Actor; at: Date;
  fromValue?: string | null; toValue?: string | null; reason?: string | null;
  workOrderId?: number | null; releaseId?: number | null; taskId?: number | null; inspectionId?: number | null; holdRef?: string | null;
}): Promise<void> {
  await db.insert(maintenanceDefectEvents).values({
    eventRef: lifecycleRef("DEV"), defectId: e.defectId, unitId: e.unitId, eventType: e.eventType,
    fromValue: e.fromValue ?? null, toValue: e.toValue ?? null, reason: e.reason?.slice(0, 600) ?? null,
    actorUserId: e.actor.userId, actorRole: e.actor.role,
    workOrderId: e.workOrderId ?? null, releaseId: e.releaseId ?? null, taskId: e.taskId ?? null,
    inspectionId: e.inspectionId ?? null, holdRef: e.holdRef ?? null, occurredAt: e.at,
  });
}

/** Run `write` in a transaction (or inside the one the caller already holds). */
async function inTx<T>(db: DbOrTx, write: (tx: DbOrTx) => Promise<T>): Promise<T> {
  if ("transaction" in db) return (db as unknown as { transaction: <R>(f: (tx: DbOrTx) => Promise<R>) => Promise<R> }).transaction(tx => write(tx));
  return write(db);
}

/** The hold a defect's severity calls for: safety for a critical defect; maintenance when triage asks for it. */
export function holdTypeFor(severity: Severity, holdUnit: boolean): HoldType | null {
  if (severity === "critical") return "safety";
  if (severity === "inspection_required" && holdUnit) return "maintenance";
  return null;
}

export async function activeDefectHolds(db: DbOrTx, defectRefs: readonly string[]) {
  if (!defectRefs.length) return [];
  return db.select().from(unitHolds).where(and(eq(unitHolds.sourceKind, "defect"), inArray(unitHolds.sourceRef, [...defectRefs]), eq(unitHolds.status, "active")));
}

export async function defectRow(db: DbOrTx, defectId: number) {
  return (await db.select().from(maintenanceDefects).where(eq(maintenanceDefects.id, defectId)).limit(1))[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

/**
 * A defect as the reporter gave it: their words kept byte for byte, their proposed severity kept as a
 * proposal. Until triage, the proposal stands as the severity (design O-3, recommended default): a
 * reported critical is treated as critical — the failure of the other choice is a truck that should
 * not move — and places the safety hold in the same transaction.
 */
export async function reportDefect(db: DbOrTx, a: {
  unitId: number; orgRef: string | null; title: string; driverStatement: string; severityProposed: Severity;
  source: NonNullable<typeof maintenanceDefects.$inferInsert["source"]>; actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const defectRef = lifecycleRef("DEF");
    const ins = await tx.insert(maintenanceDefects).values({
      unitId: a.unitId, title: a.title, severity: a.severityProposed, status: "open", detail: null,
      reportedAt: a.at, reportedBy: a.actor.userId, defectRef, source: a.source, driverStatement: a.driverStatement,
      severityProposed: a.severityProposed, severityProposedByUserId: a.actor.userId,
    });
    const defectId = Number((ins as unknown as [{ insertId: number }])[0].insertId);
    await defectEvent(tx, { defectId, unitId: a.unitId, eventType: "reported", toValue: a.severityProposed, reason: a.title, actor: a.actor, at: a.at });
    let holdRef: string | null = null;
    const holdType = holdTypeFor(a.severityProposed, false);
    if (holdType) {
      holdRef = await placeHold(tx, {
        unitId: a.unitId, orgRef: a.orgRef, holdType, effect: "out_of_service",
        reason: `Critical defect ${defectRef}: ${a.title} — do not operate until it is repaired and returned to service by a second person`,
        sourceKind: "defect", sourceRef: defectRef, byUserId: a.actor.userId, byRole: DEFECT_HOLD_ROLE,
      });
      await defectEvent(tx, { defectId, unitId: a.unitId, eventType: "hold_placed", toValue: holdType, holdRef, actor: a.actor, at: a.at });
    }
    return { defectId, defectRef, severity: a.severityProposed, holdRef };
  });
}

/* ------------------------------------------------------------------ */
/* Triage                                                              */
/* ------------------------------------------------------------------ */

export type TriagePlan = {
  release: (typeof unitHolds.$inferSelect)[];
  place: { holdType: HoldType; effect: "out_of_service" | "block" } | null;
};

/** What a severity decision does to the defect's holds. Pure; the router checks authority over `release`. */
export function triagePlan(current: readonly (typeof unitHolds.$inferSelect)[], severity: Severity, holdUnit: boolean): TriagePlan {
  const wanted = holdTypeFor(severity, holdUnit);
  const keep = wanted ? current.find(h => h.holdType === wanted) : undefined;
  return {
    release: current.filter(h => h !== keep),
    place: wanted && !keep ? { holdType: wanted, effect: wanted === "safety" ? "out_of_service" : "block" } : null,
  };
}

export async function triageDefect(db: DbOrTx, a: {
  defect: typeof maintenanceDefects.$inferSelect; orgRef: string | null; severity: Severity; reason: string;
  plan: TriagePlan; placedByRole: string; releaseRole: string | null; actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const d = a.defect;
    await tx.update(maintenanceDefects).set({ severity: a.severity, severityDecidedByUserId: a.actor.userId, severityDecidedAt: a.at }).where(eq(maintenanceDefects.id, d.id));
    await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "severity_decided", fromValue: d.severity, toValue: a.severity, reason: a.reason, actor: a.actor, at: a.at });
    const released: string[] = [];
    for (const hold of a.plan.release) {
      if (await releaseHold(tx, { hold, byUserId: a.actor.userId, byRole: a.releaseRole!, reason: `Defect ${d.defectRef} triaged ${a.severity}: ${a.reason}` })) {
        released.push(hold.holdRef);
        await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "hold_released", fromValue: hold.holdType, holdRef: hold.holdRef, reason: a.reason, actor: a.actor, at: a.at });
      }
    }
    let placed: string | null = null;
    if (a.plan.place) {
      placed = await placeHold(tx, {
        unitId: d.unitId, orgRef: a.orgRef, holdType: a.plan.place.holdType, effect: a.plan.place.effect,
        reason: `Defect ${d.defectRef} (${a.severity}): ${d.title} — held until returned to service by a second person`,
        sourceKind: "defect", sourceRef: d.defectRef!, byUserId: a.actor.userId, byRole: a.placedByRole,
      });
      await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "hold_placed", toValue: a.plan.place.holdType, holdRef: placed, actor: a.actor, at: a.at });
    }
    return { released, placed };
  });
}

/* ------------------------------------------------------------------ */
/* Send to shop, and the repair as tasks                               */
/* ------------------------------------------------------------------ */

const PRIORITY: Record<Severity, "routine" | "urgent" | "critical"> = { advisory: "routine", inspection_required: "urgent", critical: "critical" };
const LIVE_WORK_ORDER = ["closed", "cancelled"] as const;

export async function liveWorkOrderFor(db: DbOrTx, defectId: number) {
  return (await db.select({ id: workOrders.id, workOrderNumber: workOrders.workOrderNumber, status: workOrders.status }).from(workOrders)
    .where(and(eq(workOrders.defectId, defectId), notInArray(workOrders.status, [...LIVE_WORK_ORDER]))).limit(1))[0] ?? null;
}

export async function sendToShop(db: DbOrTx, a: {
  defect: typeof maintenanceDefects.$inferSelect; firstTask: { kind: typeof workOrderTasks.$inferInsert["kind"]; title: string; instructions: string | null };
  actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const d = a.defect;
    const workOrderNumber = lifecycleRef("WO");
    const ins = await tx.insert(workOrders).values({
      workOrderNumber, unitId: d.unitId, defectId: d.id, status: "open", priority: PRIORITY[d.severity as Severity],
      openedAt: a.at, openedByUserId: a.actor.userId,
    });
    const workOrderId = Number((ins as unknown as [{ insertId: number }])[0].insertId);
    const taskRef = lifecycleRef("TASK");
    const t = await tx.insert(workOrderTasks).values({
      taskRef, workOrderId, unitId: d.unitId, seq: 1, kind: a.firstTask.kind, title: a.firstTask.title,
      instructions: a.firstTask.instructions, defectId: d.id, createdByUserId: a.actor.userId,
    });
    const taskId = Number((t as unknown as [{ insertId: number }])[0].insertId);
    if (d.status === "open") await tx.update(maintenanceDefects).set({ status: "in_progress", workOrderNumber }).where(eq(maintenanceDefects.id, d.id));
    else await tx.update(maintenanceDefects).set({ workOrderNumber }).where(eq(maintenanceDefects.id, d.id));
    await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "sent_to_shop", fromValue: d.status, toValue: workOrderNumber, workOrderId, actor: a.actor, at: a.at });
    await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "task_added", toValue: taskRef, workOrderId, taskId, reason: a.firstTask.title, actor: a.actor, at: a.at });
    return { workOrderId, workOrderNumber, taskRef };
  });
}

export async function addTask(db: DbOrTx, a: {
  workOrder: { id: number; unitId: number; defectId: number | null }; defectId: number | null;
  kind: typeof workOrderTasks.$inferInsert["kind"]; title: string; instructions: string | null; actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const seq = Number((await tx.select({ n: max(workOrderTasks.seq) }).from(workOrderTasks).where(eq(workOrderTasks.workOrderId, a.workOrder.id)))[0]?.n ?? 0) + 1;
    const taskRef = lifecycleRef("TASK");
    const ins = await tx.insert(workOrderTasks).values({
      taskRef, workOrderId: a.workOrder.id, unitId: a.workOrder.unitId, seq, kind: a.kind, title: a.title,
      instructions: a.instructions, defectId: a.defectId, createdByUserId: a.actor.userId,
    });
    const taskId = Number((ins as unknown as [{ insertId: number }])[0].insertId);
    const about = a.defectId ?? a.workOrder.defectId;
    if (about != null) await defectEvent(tx, { defectId: about, unitId: a.workOrder.unitId, eventType: "task_added", toValue: taskRef, workOrderId: a.workOrder.id, taskId, reason: a.title, actor: a.actor, at: a.at });
    return { taskRef, seq };
  });
}

export type TaskStatus = typeof workOrderTasks.$inferSelect["status"];
const NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in_progress", "done", "not_required", "deferred"],
  in_progress: ["done", "not_required", "deferred"],
  deferred: ["in_progress"],
  done: [], not_required: [],
};

/** Forward only, and a finished task carries what was found and what was done. Pure. */
export function taskTransitionRefusal(from: TaskStatus, to: TaskStatus, f: { findings?: string | null; correctiveAction?: string | null; deferredReason?: string | null }): string | null {
  if (!NEXT[from].includes(to)) return `A task goes ${from} → ${NEXT[from].join(" / ") || "nowhere: it is finished"}, not → ${to}`;
  if (to === "done" && !f.correctiveAction?.trim()) return "A done task states the corrective action taken";
  if (to === "not_required" && !f.findings?.trim()) return "A task marked not required states why (the findings)";
  if (to === "deferred" && !f.deferredReason?.trim()) return "A deferred task states the reason it is deferred";
  return null;
}

export async function setTaskStatus(db: DbOrTx, a: {
  task: typeof workOrderTasks.$inferSelect; workOrderDefectId: number | null; to: TaskStatus;
  findings: string | null; correctiveAction: string | null; deferredReason: string | null; actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const finished = a.to === "done" || a.to === "not_required";
    const r = await tx.update(workOrderTasks).set({
      status: a.to,
      ...(a.findings != null ? { findings: a.findings } : {}),
      ...(a.correctiveAction != null ? { correctiveAction: a.correctiveAction } : {}),
      ...(a.deferredReason != null ? { deferredReason: a.deferredReason } : {}),
      ...(finished ? { completedByUserId: a.actor.userId, completedAt: a.at } : {}),
    }).where(and(eq(workOrderTasks.id, a.task.id), eq(workOrderTasks.status, a.task.status)));
    if ((r as unknown as [{ affectedRows: number }])[0]?.affectedRows !== 1) return false;
    const about = a.task.defectId ?? a.workOrderDefectId;
    if (about != null) await defectEvent(tx, { defectId: about, unitId: a.task.unitId, eventType: "task_status", fromValue: a.task.status, toValue: a.to, workOrderId: a.task.workOrderId, taskId: a.task.id, reason: a.correctiveAction ?? a.findings ?? a.deferredReason, actor: a.actor, at: a.at });
    return true;
  });
}

export async function unfinishedTasks(db: DbOrTx, workOrderId: number) {
  return db.select({ taskRef: workOrderTasks.taskRef, title: workOrderTasks.title, status: workOrderTasks.status }).from(workOrderTasks)
    .where(and(eq(workOrderTasks.workOrderId, workOrderId), inArray(workOrderTasks.status, ["open", "in_progress"])));
}

/* ------------------------------------------------------------------ */
/* The release — the one door                                          */
/* ------------------------------------------------------------------ */

/** The release row and a `released` event for each defect it names, together. */
export async function appendRelease(db: DbOrTx, values: typeof workOrderReleases.$inferInsert, a: { namedDefectIds: readonly number[]; actor: Actor; at: Date }) {
  return inTx(db, async tx => {
    const ins = await tx.insert(workOrderReleases).values(values);
    const releaseId = Number((ins as unknown as [{ insertId: number }])[0].insertId);
    if (a.namedDefectIds.length) {
      const named = await tx.select({ id: maintenanceDefects.id, unitId: maintenanceDefects.unitId }).from(maintenanceDefects)
        .where(and(inArray(maintenanceDefects.id, [...a.namedDefectIds]), eq(maintenanceDefects.unitId, values.unitId)));
      for (const d of named) await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "released", toValue: values.releaseType, workOrderId: values.workOrderId, releaseId, reason: values.repairSummary, actor: a.actor, at: a.at });
    }
    return releaseId;
  });
}

/* ------------------------------------------------------------------ */
/* Return to service                                                   */
/* ------------------------------------------------------------------ */

export async function releasesFor(db: DbOrTx, workOrderId: number) {
  return db.select().from(workOrderReleases).where(eq(workOrderReleases.workOrderId, workOrderId)).orderBy(desc(workOrderReleases.releasedAt), desc(workOrderReleases.id));
}

/**
 * The second person's verification, and everything it settles, in one transaction: the inspection;
 * each defect the release names resolved on that release (unless already resolved); the defects' holds
 * released by the inspector; any roadside event those defects came from closed; the work order closed.
 * A failed verification records the inspection and changes nothing else.
 */
export async function recordReturnToService(db: DbOrTx, a: {
  workOrder: { id: number; unitId: number; status: string }; release: typeof workOrderReleases.$inferSelect;
  defects: (typeof maintenanceDefects.$inferSelect)[]; holds: (typeof unitHolds.$inferSelect)[];
  outcome: "pass" | "fail"; summary: string; actor: Actor; at: Date;
}) {
  return inTx(db, async tx => {
    const inspectionRef = lifecycleRef("RTS");
    const ins = await tx.insert(inspections).values({
      unitId: a.workOrder.unitId, type: "return_to_service", status: a.outcome === "pass" ? "pass" : "fail", resultSummary: a.summary,
      observedAt: a.at, inspectionRef, outcome: a.outcome, inspectorUserId: a.actor.userId, workOrderId: a.workOrder.id, releaseId: a.release.id,
    });
    const inspectionId = Number((ins as unknown as [{ insertId: number }])[0].insertId);
    if (a.outcome === "fail") {
      for (const d of a.defects) await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "return_to_service_failed", workOrderId: a.workOrder.id, releaseId: a.release.id, inspectionId, reason: a.summary, actor: a.actor, at: a.at });
      return { inspectionRef, outcome: a.outcome, resolvedDefectIds: [] as number[], releasedHoldRefs: [] as string[], closedRoadside: [] as string[] };
    }
    const resolvedDefectIds: number[] = [];
    for (const d of a.defects) {
      await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "returned_to_service", workOrderId: a.workOrder.id, releaseId: a.release.id, inspectionId, reason: a.summary, actor: a.actor, at: a.at });
      if (d.status !== "resolved") {
        const r = await tx.update(maintenanceDefects).set({ status: "resolved", resolvedAt: a.at, resolvedByUserId: a.actor.userId, resolvedByReleaseId: a.release.id, resolutionNote: `Returned to service: ${a.summary}`.slice(0, 400) })
          .where(and(eq(maintenanceDefects.id, d.id), ne(maintenanceDefects.status, "resolved")));
        if ((r as unknown as [{ affectedRows: number }])[0]?.affectedRows === 1) {
          resolvedDefectIds.push(d.id);
          await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "resolved", fromValue: d.status, toValue: "resolved", workOrderId: a.workOrder.id, releaseId: a.release.id, inspectionId, actor: a.actor, at: a.at });
        }
      }
    }
    const releasedHoldRefs: string[] = [];
    for (const hold of a.holds) {
      if (await releaseHold(tx, { hold, byUserId: a.actor.userId, byRole: a.actor.role, reason: `Returned to service (${inspectionRef}) on release ${a.release.id}` })) {
        releasedHoldRefs.push(hold.holdRef);
        const d = a.defects.find(x => x.defectRef === hold.sourceRef);
        if (d) await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "hold_released", fromValue: hold.holdType, holdRef: hold.holdRef, inspectionId, actor: a.actor, at: a.at });
      }
    }
    const closedRoadside: string[] = [];
    const ids = a.defects.map(d => d.id);
    if (ids.length) {
      const open = await tx.select({ id: roadsideServiceEvents.id, eventRef: roadsideServiceEvents.eventRef, maintenanceDefectId: roadsideServiceEvents.maintenanceDefectId }).from(roadsideServiceEvents)
        .where(and(inArray(roadsideServiceEvents.maintenanceDefectId, ids), notInArray(roadsideServiceEvents.status, ["closed", "cancelled"])));
      for (const r of open) {
        await tx.update(roadsideServiceEvents).set({ status: "closed", closedAt: a.at }).where(eq(roadsideServiceEvents.id, r.id));
        closedRoadside.push(r.eventRef);
        const d = a.defects.find(x => x.id === r.maintenanceDefectId)!;
        await defectEvent(tx, { defectId: d.id, unitId: d.unitId, eventType: "roadside_closed", toValue: r.eventRef, inspectionId, actor: a.actor, at: a.at });
      }
    }
    // completedAt is stamped once (shop.workOrderAdvance may already have); closing never moves it.
    await tx.update(workOrders).set({ status: "closed", completedAt: sql`COALESCE(${workOrders.completedAt}, ${a.at})` }).where(and(eq(workOrders.id, a.workOrder.id), ne(workOrders.status, "cancelled")));
    return { inspectionRef, outcome: a.outcome, resolvedDefectIds, releasedHoldRefs, closedRoadside };
  });
}

export async function defectHistory(db: DbOrTx, defectId: number) {
  return db.select().from(maintenanceDefectEvents).where(eq(maintenanceDefectEvents.defectId, defectId)).orderBy(maintenanceDefectEvents.occurredAt, maintenanceDefectEvents.id);
}
