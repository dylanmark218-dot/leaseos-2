/**
 * 0146 — the financial entity is the tenant boundary for money.
 *
 * Payroll profiles, pay periods, pay runs, contractor settlements, expenses and registrations
 * all key to a financial entity. The acting scope (0132) decides which entities a caller can
 * see: the default scope sees entities with no owner (the historical single tenant's); a
 * member sees the entities their organization owns, and nothing else. A row keyed to an
 * entity outside the scope is "not found" — never "forbidden", which would confirm it exists.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, type Column } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { contractorSettlements, employeePayrollProfiles, financialEntities, payPeriods, payRuns, payrollAdjustments, payrollDisputes } from "../../drizzle/schema";
import { SINGLE_TENANT_ID } from "./actingScope";

type Db = MySql2Database<Record<string, unknown>>;
export type MoneyScope = { tenantId: string };

export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export function entityScopeWhere(scope: MoneyScope) {
  return scope.tenantId === SINGLE_TENANT_ID ? or(isNull(financialEntities.orgRef), eq(financialEntities.orgRef, SINGLE_TENANT_ID)) : eq(financialEntities.orgRef, scope.tenantId);
}
/**
 * 0174 — a query-level filter for a row keyed to a financial entity. An organization sees
 * rows on the entities it owns. The default (single-tenant) scope sees every row that is not
 * on an entity some organization owns — including a row with no entity, or with an entity id
 * that has no entity record, which is how the single tenant's older data looks.
 */
export function financialEntityScopeWhere(db: Db, col: Column, scope: MoneyScope) {
  if (scope.tenantId === SINGLE_TENANT_ID) {
    const owned = db.select({ id: financialEntities.id }).from(financialEntities).where(and(isNotNull(financialEntities.orgRef), ne(financialEntities.orgRef, SINGLE_TENANT_ID)));
    return or(isNull(col), notInArray(col, owned))!;
  }
  return inArray(col, db.select({ id: financialEntities.id }).from(financialEntities).where(eq(financialEntities.orgRef, scope.tenantId)));
}
/** The entity ids this scope may see. Empty means the caller can see no money at all. */
export async function entityIdsInScope(db: Db, scope: MoneyScope): Promise<number[]> {
  return (await db.select({ id: financialEntities.id }).from(financialEntities).where(entityScopeWhere(scope))).map(r => r.id);
}
export async function assertEntityInScope(db: Db, financialEntityId: number, scope: MoneyScope): Promise<void> {
  const row = (await db.select({ id: financialEntities.id }).from(financialEntities).where(and(eq(financialEntities.id, financialEntityId), entityScopeWhere(scope))).limit(1))[0];
  if (!row) throw notFound(`Financial entity ${financialEntityId}`);
}
/** The owner a new entity gets: the acting organization, or none under the default scope. */
export const entityOwnerFor = (scope: MoneyScope) => (scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId);

export async function assertPeriodInScope(db: Db, payPeriodId: number, scope: MoneyScope): Promise<{ id: number; financialEntityId: number }> {
  const p = (await db.select({ id: payPeriods.id, financialEntityId: payPeriods.financialEntityId }).from(payPeriods).where(eq(payPeriods.id, payPeriodId)).limit(1))[0];
  if (!p) throw notFound(`Pay period ${payPeriodId}`);
  try { await assertEntityInScope(db, p.financialEntityId, scope); } catch { throw notFound(`Pay period ${payPeriodId}`); }
  return p;
}
export async function assertProfileInScope(db: Db, employeePayrollProfileId: number, scope: MoneyScope): Promise<{ id: number; financialEntityId: number }> {
  const p = (await db.select({ id: employeePayrollProfiles.id, financialEntityId: employeePayrollProfiles.financialEntityId }).from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, employeePayrollProfileId)).limit(1))[0];
  if (!p) throw notFound(`Payroll profile ${employeePayrollProfileId}`);
  try { await assertEntityInScope(db, p.financialEntityId, scope); } catch { throw notFound(`Payroll profile ${employeePayrollProfileId}`); }
  return p;
}
export async function assertRunInScope(db: Db, payRunRef: string, scope: MoneyScope): Promise<void> {
  const r = (await db.select({ financialEntityId: payRuns.financialEntityId }).from(payRuns).where(eq(payRuns.payRunRef, payRunRef)).limit(1))[0];
  if (!r) throw notFound(`Pay run ${payRunRef}`);
  try { await assertEntityInScope(db, r.financialEntityId, scope); } catch { throw notFound(`Pay run ${payRunRef}`); }
}
export async function assertDisputeInScope(db: Db, disputeRef: string, scope: MoneyScope): Promise<void> {
  const d = (await db.select({ payPeriodId: payrollDisputes.payPeriodId, profileId: payrollDisputes.employeePayrollProfileId }).from(payrollDisputes).where(eq(payrollDisputes.disputeRef, disputeRef)).limit(1))[0];
  if (!d) throw notFound(`Dispute ${disputeRef}`);
  try { if (d.payPeriodId) await assertPeriodInScope(db, d.payPeriodId, scope); else await assertProfileInScope(db, d.profileId, scope); } catch { throw notFound(`Dispute ${disputeRef}`); }
}
export async function assertAdjustmentInScope(db: Db, adjustmentRef: string, scope: MoneyScope): Promise<void> {
  const a = (await db.select({ profileId: payrollAdjustments.employeePayrollProfileId }).from(payrollAdjustments).where(eq(payrollAdjustments.adjustmentRef, adjustmentRef)).limit(1))[0];
  if (!a) throw notFound(`Adjustment ${adjustmentRef}`);
  try { await assertProfileInScope(db, a.profileId, scope); } catch { throw notFound(`Adjustment ${adjustmentRef}`); }
}
export async function assertSettlementInScope(db: Db, settlementRef: string, scope: MoneyScope): Promise<void> {
  const s = (await db.select({ payingEntityId: contractorSettlements.payingEntityId }).from(contractorSettlements).where(eq(contractorSettlements.settlementRef, settlementRef)).limit(1))[0];
  if (!s) throw notFound(`Settlement ${settlementRef}`);
  try { await assertEntityInScope(db, s.payingEntityId, scope); } catch { throw notFound(`Settlement ${settlementRef}`); }
}
/** Period ids for a set of entities — the join key for time entries, disputes, adjustments and earnings. */
export async function periodIdsForEntities(db: Db, entityIds: number[]): Promise<number[]> {
  if (!entityIds.length) return [];
  return (await db.select({ id: payPeriods.id }).from(payPeriods).where(inArray(payPeriods.financialEntityId, entityIds))).map(r => r.id);
}
