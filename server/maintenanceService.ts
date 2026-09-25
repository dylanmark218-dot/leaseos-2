/**
 * Fleet maintenance — reads over who owns a work order.
 *
 * Checkpoint 1 of the Mechanic Portal design (docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md).
 * Holds, meters and the unit's operational state belong to the Fleet & Equipment Portfolio
 * (docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md) and are read through
 * `fleetPortfolioService` — `placeHold` / `releaseHold` with `sourceKind: "defect" | "work_order"` and
 * `operationalStateFor` are the seams mechanic checkpoint 2 uses.
 */
import { desc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { workOrderAssignments, workOrders } from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";

export const newRef = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;

/** The current assignee of a work order is the newest assignment event. Nothing updates one. */
export async function assignmentHistory(db: DbOrTx, workOrderId: number) {
  const rows = await db.select().from(workOrderAssignments).where(eq(workOrderAssignments.workOrderId, workOrderId))
    .orderBy(desc(workOrderAssignments.occurredAt), desc(workOrderAssignments.id));
  const current = rows[0] && rows[0].eventType !== "unassigned"
    ? { userId: rows[0].toUserId, shopFacilityId: rows[0].shopFacilityId, expectedCompletionAt: rows[0].expectedCompletionAt, since: rows[0].occurredAt }
    : null;
  return { current, history: rows };
}

export async function workOrderRow(db: DbOrTx, workOrderId: number) {
  return (await db.select().from(workOrders).where(eq(workOrders.id, workOrderId)).limit(1))[0] ?? null;
}
