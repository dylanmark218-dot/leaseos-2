/**
 * Fleet & Equipment Portfolio — the component relations a unit carries, read for the readiness
 * composer and the portfolio alike. Imports only the schema, so the composer can read it without a
 * cycle through the service (the service imports the composer's loaders, not the reverse).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { maintenanceDefects, unitComponents, unitHolds, units } from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import type { ComponentState } from "./_core/fleetAssets";

/** The components attached to a unit now, each with the two facts that hold the parent (O-9). */
export async function componentStatesFor(db: DbOrTx, parentUnitId: number): Promise<ComponentState[]> {
  const rows = await db.select({ c: unitComponents, child: { id: units.id, unitNumber: units.unitNumber } })
    .from(unitComponents).innerJoin(units, eq(units.id, unitComponents.childUnitId))
    .where(and(eq(unitComponents.parentUnitId, parentUnitId), isNull(unitComponents.removedAt)));
  if (!rows.length) return [];
  const childIds = rows.map(r => r.child.id);
  const [critical, safety] = await Promise.all([
    db.select({ unitId: maintenanceDefects.unitId }).from(maintenanceDefects)
      .where(and(inArray(maintenanceDefects.unitId, childIds), eq(maintenanceDefects.severity, "critical"), inArray(maintenanceDefects.status, ["open", "in_progress"]))),
    db.select({ unitId: unitHolds.unitId }).from(unitHolds)
      .where(and(inArray(unitHolds.unitId, childIds), eq(unitHolds.status, "active"), eq(unitHolds.dispatchEffect, "out_of_service"))),
  ]);
  const crit = new Set(critical.map(r => r.unitId)), oos = new Set(safety.map(r => r.unitId));
  return rows.map(r => ({
    componentRef: r.c.componentRef, childUnitId: r.child.id, childUnitNumber: r.child.unitNumber,
    relationship: r.c.relationship, removable: r.c.removable, criticalDefectOpen: crit.has(r.child.id), safetyHold: oos.has(r.child.id),
  }));
}

/** A version string for the fingerprint: the relations and the two facts, order-independent. */
export const componentVersionOf = (states: readonly ComponentState[]) =>
  states.map(s => `${s.componentRef}:${s.criticalDefectOpen ? "crit" : "ok"}:${s.safetyHold ? "oos" : "ok"}`).sort().join("|") || "none";
