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
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { contractorSettlements, employeePayrollProfiles, financialEntities, payPeriods, payRuns, payrollAdjustments, payrollDisputes } from "../../drizzle/schema";
import { AmbiguousOrganization, RevivedFallbackRefused, SINGLE_TENANT_ID, resolveActingScopeStrict } from "./actingScope";

type Db = MySql2Database<Record<string, unknown>>;
export type MoneyScope = { tenantId: string };

export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export function entityScopeWhere(scope: MoneyScope) {
  return scope.tenantId === SINGLE_TENANT_ID ? or(isNull(financialEntities.orgRef), eq(financialEntities.orgRef, SINGLE_TENANT_ID)) : eq(financialEntities.orgRef, scope.tenantId);
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

/**
 * F1 — the money boundary for one request: the acting organization and the books it owns.
 *
 * Established once, from server-owned context, by `moneyScoped()` in `trpc.ts`; a handler reads it
 * from `ctx.money` and never from input. Holding a finance role in another organization changes
 * nothing here — the chain is caller → organization → book → record, and roles are checked
 * separately by `roleProcedure`.
 */
export type FinanceScope = MoneyScope & { entityIds: readonly number[] };

export async function financeScopeFor(db: Db, userId: number): Promise<FinanceScope> {
  let tenantId: string;
  // P0-A3 — the strict resolver (P0-A1): a membership that ended, lapsed or was suspended is not
  // replaced by the single-tenant fallback, and no role grant revives it. Money follows the same
  // rule as hours of service, telematics and operating zones.
  try { tenantId = (await resolveActingScopeStrict(db as never, userId)).tenantId; }
  catch (e) {
    // Two live memberships: which company's books this request touches has to be established, not guessed.
    if (e instanceof AmbiguousOrganization) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
    if (e instanceof RevivedFallbackRefused) throw new TRPCError({ code: "FORBIDDEN", message: "No active organization membership" });
    throw e;
  }
  const scope = { tenantId };
  return { ...scope, entityIds: await entityIdsInScope(db, scope) };
}

/**
 * Whether the book is one the caller's organization owns. A record assigned to no book (NULL) is in
 * nobody's scope — not the single tenant's, not the first organization to ask. Legacy rows like that
 * are found by `legacyFinanceOwnershipAudit` and assigned explicitly, never at read time.
 */
export function ownsEntity(fs: FinanceScope, financialEntityId: number | null | undefined): financialEntityId is number {
  return financialEntityId != null && fs.entityIds.includes(financialEntityId);
}
/** The book, if the caller owns it; otherwise "<what> not found", the same answer a missing row gets. */
export function requireOwnedEntity(fs: FinanceScope, financialEntityId: number | null | undefined, what: string): number {
  if (!ownsEntity(fs, financialEntityId)) throw notFound(what);
  return financialEntityId;
}
/** WHERE clause: rows keyed to a book the caller owns. No books means no rows, never all rows. */
export function ownedEntityWhere(column: MySqlColumn, fs: FinanceScope): SQL {
  return fs.entityIds.length ? inArray(column, [...fs.entityIds]) : sql`false`;
}
/**
 * WHERE clause for rows keyed to an organization by `bookOrgRef` (vendors 0149, commercial office 0133):
 * the single tenant's rows carry NULL or "default", an organization's carry its ref.
 */
export function bookOrgWhere(column: MySqlColumn, fs: FinanceScope): SQL {
  return fs.tenantId === SINGLE_TENANT_ID ? or(isNull(column), eq(column, SINGLE_TENANT_ID))! : eq(column, fs.tenantId);
}
export function ownsBookOrg(fs: FinanceScope, bookOrgRef: string | null | undefined): boolean {
  return fs.tenantId === SINGLE_TENANT_ID ? bookOrgRef == null || bookOrgRef === SINGLE_TENANT_ID : bookOrgRef === fs.tenantId;
}

/**
 * F1.1 — the same boundary for routers outside finance (compliance, requirements, calibration, dispatch):
 * the caller's acting organization must own this entity. Any other id answers "<what> not found". The
 * entity is the company's legal entity (0146), not a finance concept, so no finance context is involved.
 */
export async function assertCallerOwnsEntity(db: Db, userId: number, financialEntityId: number, what = `Financial entity ${financialEntityId}`): Promise<void> {
  const fs = await financeScopeFor(db, userId);
  if (!ownsEntity(fs, financialEntityId)) throw /^No such |not found$/.test(what) ? new TRPCError({ code: "NOT_FOUND", message: what }) : notFound(what);
}
