/**
 * CP1.5 — the one refusal for a mutation that names a unit.
 *
 * The rule is `unitInScope` (db.ts): a unit exists AND its owner in `coreRecordOwnership` is the
 * caller's organization — or, for the historical single tenant, it has no owner. This module adds
 * nothing to that rule; it is the single place a mutation turns "not in scope" into a refusal, so
 * every unit-taking write refuses in the same words:
 *
 *   NOT_FOUND  "Unit <id> not found"   (or "Trailer <id> not found" for a trailer argument)
 *
 * Another organization's unit and a unit that does not exist are indistinguishable — same code, same
 * message — and the refusal comes before anything is read about the unit or written anywhere.
 * A role grants what a caller may do, never whose units they may do it to; nothing here consults a
 * role. `recordBelongsToOrganization` is not a substitute: it answers "unowned" for an id that does
 * not exist, so on its own it lets the historical tenant name units that are not there.
 *
 * Guarded by `server/unitScopeGuard.test.ts`: a router mutation whose input names a unit must call
 * this (or an equivalent canonical scope check) or be listed there with the reason it need not.
 */
import { TRPCError } from "@trpc/server";
import { actingScopeFor, unitInScope, type TenantScope } from "./db";

export type UnitArgument = "Unit" | "Trailer";

export function unitNotFound(unitId: number, label: UnitArgument = "Unit"): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `${label} ${unitId} not found` });
}

/** Refuse, as not found, a unit the scope may not see. `null`/`undefined` names no unit and passes. */
export async function requireUnitInScope(unitId: number | null | undefined, scope: TenantScope, label: UnitArgument = "Unit"): Promise<void> {
  if (unitId == null) return;
  if (!(await unitInScope(unitId, scope))) throw unitNotFound(unitId, label);
}

/** Every named unit, in order; the first one out of scope is the refusal. */
export async function requireUnitsInScope(unitIds: readonly (number | null | undefined)[], scope: TenantScope, label: UnitArgument = "Unit"): Promise<void> {
  for (const id of unitIds) await requireUnitInScope(id, scope, label);
}

/** The same check with the caller's acting scope resolved here — for procedures that hold no scope yet. */
export async function requireCallerUnits(userId: number, units: { unitId?: number | null; trailerId?: number | null; unitIds?: readonly number[] | null }): Promise<TenantScope> {
  const scope = await actingScopeFor(userId);
  await requireUnitInScope(units.unitId, scope, "Unit");
  await requireUnitInScope(units.trailerId, scope, "Trailer");
  if (units.unitIds) await requireUnitsInScope(units.unitIds, scope, "Unit");
  return scope;
}
