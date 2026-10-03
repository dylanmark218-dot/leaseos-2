/**
 * Payroll and finance service.
 *
 * The own-pay boundary is the whole point of this file. `employeePayrollProfileId`
 * is never an input to a self-service procedure — the server resolves it from
 * the session user. A client that can name whose payslip it is asking for can
 * name anyone's.
 *
 * Wage rates, banking details and tax identifiers never leave here inside a
 * generic object that might end up in a log line. Self-service reads return
 * purpose-built shapes.
 */

import { and, desc, eq, gte, lte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import type { Tx } from "./_core/dbTypes";
import { collectReimbursementsInTx, type ReimbursementCollection } from "./payrollExpenseService";
import { dateText as dateTextOf } from "./payrollCompensationService";
import {
  contractorSettlementLines,
  contractorSettlements,
  employeePayrollProfiles,
  expenseAllocations,
  expenseRecords,
  financialEntities,
  operators,
  payPeriods,
  payRates,
  payrollAdjustments,
  payrollDisputes,
  payrollEarningEvents,
  payrollTimeEntries,
  payrollTimeReconciliations,
  payRunLines,
  payRuns,
  personalTaxDocuments,
  taxRegistrations,
  taxRules,
  taxRuleSources,
} from "../drizzle/schema";
import type { TaxRule } from "./_core/taxRuleEngine";
import type { PayRate } from "./_core/payrollEngine";

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * The caller's own payroll profile, derived from the session. Returns null
 * rather than throwing so a caller with no profile simply sees nothing.
 */
export async function resolveOwnPayrollProfile(userId: number) {
  const db = await getDb();
  if (!db) return null;

  const direct = await db
    .select()
    .from(employeePayrollProfiles)
    .where(eq(employeePayrollProfiles.userId, userId))
    .limit(1);
  if (direct[0]) return direct[0];

  // Fall back to the operator record linked to this user.
  const op = await db
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.userId, userId))
    .limit(1);
  if (!op[0]) return null;

  const viaOperator = await db
    .select()
    .from(employeePayrollProfiles)
    .where(eq(employeePayrollProfiles.operatorId, op[0].id))
    .limit(1);
  return viaOperator[0] ?? null;
}

export async function listPayrollProfiles(entityIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (entityIds && entityIds.length === 0) return [];
  // Deliberately narrow: no rate, no banking, no tax identifier.
  return db
    .select({
      id: employeePayrollProfiles.id,
      employeeNumber: employeePayrollProfiles.employeeNumber,
      employmentType: employeePayrollProfiles.employmentType,
      payrollStatus: employeePayrollProfiles.payrollStatus,
      payGroupId: employeePayrollProfiles.payGroupId,
      defaultPayMethod: employeePayrollProfiles.defaultPayMethod,
      effectiveFrom: employeePayrollProfiles.effectiveFrom,
    })
    .from(employeePayrollProfiles)
    .where(entityIds ? inArray(employeePayrollProfiles.financialEntityId, entityIds) : undefined)
    .limit(500);
}

export async function upsertPayrollProfile(
  values: typeof employeePayrollProfiles.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(employeePayrollProfiles).values(values);
  return r[0]?.insertId;
}

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */

export async function listPayRates(earningType?: string, profileIds?: number[]): Promise<PayRate[]> {
  const db = await getDb();
  if (!db) return [];
  if (profileIds && profileIds.length === 0) return [];
  const scopeCond = profileIds ? inArray(payRates.employeePayrollProfileId, profileIds) : undefined;
  const rows = earningType
    ? await db.select().from(payRates).where(scopeCond ? and(eq(payRates.earningType, earningType), scopeCond) : eq(payRates.earningType, earningType))
    : await db.select().from(payRates).where(scopeCond).limit(500);
  return rows.map(r => ({
    rateKey: r.rateKey,
    version: r.version,
    earningType: r.earningType,
    calculation: r.calculation,
    rate: r.rate,
    unit: r.unit,
    effectiveFrom: r.effectiveFrom,
    effectiveUntil: r.effectiveUntil,
    minimumMeasurementAuthority:
      (r.minimumMeasurementAuthority as PayRate["minimumMeasurementAuthority"]) ??
      null,
  }));
}

/**
 * Create a rate as a new version. An existing rate is never updated in place —
 * a March payslip has to remain explainable after a July increase.
 */
export async function createPayRateVersion(args: {
  rateKey: string;
  earningType: string;
  calculation: "hourly" | "quantity_times_rate" | "percentage" | "flat" | "formula";
  rate: number;
  unit: "hour" | "km" | "load" | "tonne" | "m3" | "percent" | "each";
  effectiveFrom: Date;
  minimumMeasurementAuthority?: string | null;
  approvedByUserId: number;
  payGroupId?: number | null;
  employeePayrollProfileId?: number | null;
}) {
  const db = await getDb();
  if (!db) return undefined;

  const existing = await db
    .select({ version: payRates.version, id: payRates.id })
    .from(payRates)
    .where(eq(payRates.rateKey, args.rateKey))
    .orderBy(desc(payRates.version))
    .limit(1);

  const nextVersion = (existing[0]?.version ?? 0) + 1;

  // Close the prior version's window rather than deleting it.
  if (existing[0]) {
    await db
      .update(payRates)
      .set({ effectiveUntil: args.effectiveFrom })
      .where(eq(payRates.id, existing[0].id));
  }

  const r = await db.insert(payRates).values({
    rateKey: args.rateKey,
    version: nextVersion,
    earningType: args.earningType,
    calculation: args.calculation,
    rate: args.rate,
    unit: args.unit,
    effectiveFrom: args.effectiveFrom,
    minimumMeasurementAuthority: args.minimumMeasurementAuthority ?? null,
    approvedByUserId: args.approvedByUserId,
    approvedAt: new Date(),
    supersedesRateId: existing[0]?.id ?? null,
    payGroupId: args.payGroupId ?? null,
    employeePayrollProfileId: args.employeePayrollProfileId ?? null,
  });
  return { id: r[0]?.insertId, version: nextVersion };
}

/* ------------------------------------------------------------------ */
/* Time and earnings                                                   */
/* ------------------------------------------------------------------ */

export async function listOwnTimeEntries(profileId: number, from: Date, to: Date) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(payrollTimeEntries)
    .where(
      and(
        eq(payrollTimeEntries.employeePayrollProfileId, profileId),
        gte(payrollTimeEntries.startedAt, from),
        lte(payrollTimeEntries.startedAt, to)
      )
    )
    .orderBy(desc(payrollTimeEntries.startedAt))
    .limit(500);
}

export async function submitTimeEntry(
  values: typeof payrollTimeEntries.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payrollTimeEntries).values(values);
  return r[0]?.insertId;
}

export async function listEarnings(args: {
  payPeriodId?: number;
  profileId?: number;
  profileIds?: number[];   // 0146: the profiles the acting scope may see
}) {
  const db = await getDb();
  if (!db) return [];
  if (args.profileIds && args.profileIds.length === 0) return [];
  const conds = [
    args.profileId != null ? eq(payrollEarningEvents.employeePayrollProfileId, args.profileId) : undefined,
    args.payPeriodId != null ? eq(payrollEarningEvents.payPeriodId, args.payPeriodId) : undefined,
    args.profileIds ? inArray(payrollEarningEvents.employeePayrollProfileId, args.profileIds) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const q = db.select().from(payrollEarningEvents);
  return conds.length ? q.where(and(...conds)).limit(500) : q.limit(500);
}

export async function insertEarning(
  values: typeof payrollEarningEvents.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payrollEarningEvents).values(values);
  return r[0]?.insertId;
}

export async function recordReconciliation(
  values: typeof payrollTimeReconciliations.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payrollTimeReconciliations).values(values);
  return r[0]?.insertId;
}

/* ------------------------------------------------------------------ */
/* Periods and runs                                                    */
/* ------------------------------------------------------------------ */

export async function listPayPeriods(entityIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (entityIds && entityIds.length === 0) return [];
  return db.select().from(payPeriods).where(entityIds ? inArray(payPeriods.financialEntityId, entityIds) : undefined).orderBy(desc(payPeriods.startsOn)).limit(200);
}

export async function openPayPeriod(values: typeof payPeriods.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payPeriods).values(values);
  return r[0]?.insertId;
}

export async function listPayRuns(entityIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (entityIds && entityIds.length === 0) return [];
  return db.select().from(payRuns).where(entityIds ? inArray(payRuns.financialEntityId, entityIds) : undefined).orderBy(desc(payRuns.createdAt)).limit(200);
}

export async function loadPayRun(payRunRef: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(payRuns)
    .where(eq(payRuns.payRunRef, payRunRef))
    .limit(1);
  return rows[0] ?? null;
}

export async function createPayRun(values: typeof payRuns.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payRuns).values(values);
  return r[0]?.insertId;
}

export async function setPayRunState(args: {
  payRunRef: string;
  state: "draft" | "collecting" | "review" | "approved" | "processing" | "paid" | "closed" | "amended";
  approvedByUserId?: number | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(payRuns)
    .set({
      state: args.state,
      ...(args.state === "approved"
        ? { approvedByUserId: args.approvedByUserId ?? null, approvedAt: new Date() }
        : {}),
      ...(args.state === "paid" ? { paidAt: new Date(), lockedAt: new Date() } : {}),
    })
    .where(eq(payRuns.payRunRef, args.payRunRef));
}

export async function insertPayRunLine(values: typeof payRunLines.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payRunLines).values(values);
  return r[0]?.insertId;
}

/* ------------------------------------------------------------------ */
/* Adjustments and disputes                                            */
/* ------------------------------------------------------------------ */

export async function requestAdjustment(
  values: typeof payrollAdjustments.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payrollAdjustments).values(values);
  return r[0]?.insertId;
}

export async function approveAdjustment(args: {
  adjustmentRef: string;
  approvedByUserId: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(payrollAdjustments)
    .set({
      status: "approved",
      approvedByUserId: args.approvedByUserId,
      approvedAt: new Date(),
    })
    .where(eq(payrollAdjustments.adjustmentRef, args.adjustmentRef));
}

export async function raiseDispute(values: typeof payrollDisputes.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payrollDisputes).values(values);
  return r[0]?.insertId;
}

export async function listDisputes(profileIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (profileIds && profileIds.length === 0) return [];
  return db.select().from(payrollDisputes).where(profileIds ? inArray(payrollDisputes.employeePayrollProfileId, profileIds) : undefined).orderBy(desc(payrollDisputes.createdAt)).limit(200);
}

/**
 * Resolve a dispute. The employee's original statement and the originally
 * recorded value are untouched — the resolution is added alongside them.
 */
export async function resolveDispute(args: {
  disputeRef: string;
  status: "approved" | "declined" | "information_requested";
  resolvedByUserId: number;
  note: string;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(payrollDisputes)
    .set({
      status: args.status,
      resolvedByUserId: args.resolvedByUserId,
      resolvedAt: new Date(),
      resolutionNote: args.note,
    })
    .where(eq(payrollDisputes.disputeRef, args.disputeRef));
}

/* ------------------------------------------------------------------ */
/* Contractor settlement — a separate ledger                            */
/* ------------------------------------------------------------------ */

export async function listSettlements(entityIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (entityIds && entityIds.length === 0) return [];
  return db
    .select()
    .from(contractorSettlements)
    .where(entityIds ? inArray(contractorSettlements.payingEntityId, entityIds) : undefined)
    .orderBy(desc(contractorSettlements.createdAt))
    .limit(200);
}

export async function createSettlement(args: {
  settlement: typeof contractorSettlements.$inferInsert;
  lines: Array<Omit<typeof contractorSettlementLines.$inferInsert, "contractorSettlementId">>;
}) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(contractorSettlements).values(args.settlement);
  const id = Number(r[0]?.insertId);
  if (id && args.lines.length > 0) {
    await db
      .insert(contractorSettlementLines)
      .values(args.lines.map(l => ({ ...l, contractorSettlementId: id })));
  }
  return id;
}

export async function approveSettlement(args: {
  settlementRef: string;
  approvedByUserId: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(contractorSettlements)
    .set({
      state: "approved",
      approvedByUserId: args.approvedByUserId,
      approvedAt: new Date(),
    })
    .where(eq(contractorSettlements.settlementRef, args.settlementRef));
}

/* ------------------------------------------------------------------ */
/* Finance and tax                                                     */
/* ------------------------------------------------------------------ */

export async function listFinancialEntities(entityIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  if (entityIds && entityIds.length === 0) return [];
  return db.select().from(financialEntities).where(entityIds ? inArray(financialEntities.id, entityIds) : undefined).limit(200);
}

export async function createFinancialEntity(
  values: typeof financialEntities.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(financialEntities).values(values);
  return r[0]?.insertId;
}

export async function loadFinancialEntity(entityRef: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(financialEntities)
    .where(eq(financialEntities.entityRef, entityRef))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRegistrations(financialEntityId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(taxRegistrations)
    .where(eq(taxRegistrations.financialEntityId, financialEntityId));
}

export async function listExpenses(financialEntityId?: number) {
  const db = await getDb();
  if (!db) return [];
  const q = db.select().from(expenseRecords);
  return financialEntityId != null
    ? q.where(eq(expenseRecords.financialEntityId, financialEntityId)).limit(500)
    : q.limit(500);
}

export async function createExpense(args: {
  expense: typeof expenseRecords.$inferInsert;
  allocations: Array<Omit<typeof expenseAllocations.$inferInsert, "expenseRecordId">>;
}) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(expenseRecords).values(args.expense);
  const id = Number(r[0]?.insertId);
  if (id && args.allocations.length > 0) {
    await db
      .insert(expenseAllocations)
      .values(args.allocations.map(a => ({ ...a, expenseRecordId: id })));
  }
  return id;
}

export async function setExpenseTreatment(args: {
  expenseRef: string;
  treatment:
    | "potentially_deductible" | "capital_asset" | "inventory"
    | "employee_reimbursement" | "personal" | "mixed_use"
    | "non_deductible" | "taxable_benefit_review";
  determinedByUserId: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(expenseRecords)
    .set({
      taxTreatment: args.treatment,
      treatmentDeterminedByUserId: args.determinedByUserId,
      treatmentDeterminedAt: new Date(),
    })
    .where(eq(expenseRecords.expenseRef, args.expenseRef));
}

/**
 * Load tax rules for the engine. Source verification state travels with each
 * rule so an unverified rule cannot be mistaken for a usable one downstream.
 */
export async function loadTaxRules(jurisdiction?: string): Promise<TaxRule[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = jurisdiction
    ? await db.select().from(taxRules).where(eq(taxRules.jurisdiction, jurisdiction))
    : await db.select().from(taxRules).limit(1000);

  const sources = await db.select().from(taxRuleSources);
  const byId = new Map(sources.map(s => [s.id, s]));

  return rows.map(r => {
    const src = r.sourceId != null ? byId.get(r.sourceId) : undefined;
    let parameters: Record<string, unknown> = {};
    try {
      parameters = r.parametersJson ? JSON.parse(r.parametersJson) : {};
    } catch {
      parameters = {};
    }
    return {
      ruleKey: r.ruleKey,
      version: r.version,
      jurisdiction: r.jurisdiction,
      taxYear: r.taxYear,
      entityType: r.entityType,
      ruleType: r.ruleType,
      parameters,
      effectiveFrom: r.effectiveFrom,
      effectiveUntil: r.effectiveUntil,
      status: r.status,
      source: src
        ? {
            sourceKey: src.sourceKey,
            authority: src.authority,
            reference: src.reference,
            verifiedAt: src.verifiedAt,
          }
        : null,
    };
  });
}

/**
 * Load a rule together with its source.
 *
 * A rule may only be stored as `verified` when its source is itself verified
 * and names an authority — otherwise it is stored `unverified` regardless of
 * what the caller asked for, and the engine will keep returning UNKNOWN.
 */
export async function upsertTaxRule(args: {
  ruleKey: string;
  jurisdiction: string;
  ruleType: string;
  taxYear?: number | null;
  entityType?: string | null;
  parameters: Record<string, unknown>;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
  requestedStatus: "unverified" | "verified";
  source: {
    sourceKey: string;
    authority: string;
    reference?: string | null;
    verifiedByUserId?: number | null;
    verified: boolean;
  };
}): Promise<{ ruleId: number | undefined; storedStatus: string; note?: string }> {
  const db = await getDb();
  if (!db) return { ruleId: undefined, storedStatus: "unverified" };

  const existingSrc = await db
    .select()
    .from(taxRuleSources)
    .where(eq(taxRuleSources.sourceKey, args.source.sourceKey))
    .limit(1);

  let sourceId = existingSrc[0]?.id;
  if (!sourceId) {
    const sr = await db.insert(taxRuleSources).values({
      sourceKey: args.source.sourceKey,
      authority: args.source.authority,
      reference: args.source.reference ?? null,
      retrievedAt: new Date(),
      verifiedAt: args.source.verified ? new Date() : null,
      verifiedByUserId: args.source.verifiedByUserId ?? null,
      status: args.source.verified ? "verified" : "unverified",
    });
    sourceId = Number(sr[0]?.insertId);
  }

  const sourceIsVerified =
    args.source.verified && args.source.authority.trim().length > 0;

  const storedStatus: "verified" | "unverified" =
    args.requestedStatus === "verified" && sourceIsVerified
      ? "verified"
      : "unverified";

  const prior = await db
    .select({ version: taxRules.version })
    .from(taxRules)
    .where(eq(taxRules.ruleKey, args.ruleKey))
    .orderBy(desc(taxRules.version))
    .limit(1);

  const r = await db.insert(taxRules).values({
    ruleKey: args.ruleKey,
    version: (prior[0]?.version ?? 0) + 1,
    jurisdiction: args.jurisdiction,
    taxYear: args.taxYear ?? null,
    entityType: args.entityType ?? null,
    ruleType: args.ruleType,
    parametersJson: JSON.stringify(args.parameters),
    effectiveFrom: args.effectiveFrom,
    effectiveUntil: args.effectiveUntil ?? null,
    sourceId,
    status: storedStatus,
  });

  return {
    ruleId: r[0]?.insertId ? Number(r[0].insertId) : undefined,
    storedStatus,
    note:
      storedStatus === "unverified" && args.requestedStatus === "verified"
        ? "Stored unverified: a rule cannot be verified unless its source is verified and names an authority"
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Private personal tax organizer                                      */
/* ------------------------------------------------------------------ */

export async function listOwnTaxDocuments(userId: number) {
  const db = await getDb();
  if (!db) return [];
  // Scoped by construction — the owner is the session user.
  return db
    .select()
    .from(personalTaxDocuments)
    .where(eq(personalTaxDocuments.ownerUserId, userId))
    .limit(500);
}

export async function addOwnTaxDocument(
  values: typeof personalTaxDocuments.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(personalTaxDocuments).values(values);
  return r[0]?.insertId;
}

/**
 * Share a personal tax document with a company entity.
 *
 * Only the owner can do this, and only for their own document. The employer
 * never gains access by holding a broad finance role.
 */
export async function shareOwnTaxDocument(args: {
  documentId: number;
  ownerUserId: number;
  entityId: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "No database" };

  const rows = await db
    .select({ id: personalTaxDocuments.id })
    .from(personalTaxDocuments)
    .where(
      and(
        eq(personalTaxDocuments.id, args.documentId),
        eq(personalTaxDocuments.ownerUserId, args.ownerUserId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    return { ok: false, reason: "Not your document" };
  }

  await db
    .update(personalTaxDocuments)
    .set({
      sharedWithEntityId: args.entityId,
      sharedAt: new Date(),
      sharedByUserId: args.ownerUserId,
    })
    .where(eq(personalTaxDocuments.id, args.documentId));
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* P0 — statements, legacy rate ownership, trail, approval, collection  */
/* ------------------------------------------------------------------ */

import { authorizationDecisions, payGroups } from "../drizzle/schema";
import { sql } from "drizzle-orm";
import { payRunMayCollect, selectCollectible, type CollectibleEarning } from "./_core/payrollEngine";

/**
 * The runs that carry a line for THIS profile, in THIS book. A run with no line for the
 * profile is not the profile's statement, whatever state it is in; a run in another book
 * never appears, whatever profile it carries.
 */
export async function listOwnStatements(args: { profileId: number; financialEntityId: number }) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      payRunRef: payRuns.payRunRef,
      state: payRuns.state,
      paidAt: payRuns.paidAt,
      lineCount: sql<number>`count(${payRunLines.id})`,
      amountCents: sql<number>`coalesce(sum(${payRunLines.amountCents}), 0)`,
    })
    .from(payRuns)
    .innerJoin(payRunLines, and(eq(payRunLines.payRunId, payRuns.id), eq(payRunLines.employeePayrollProfileId, args.profileId)))
    .where(and(eq(payRuns.financialEntityId, args.financialEntityId), inArray(payRuns.state, ["paid", "closed", "amended"])))
    .groupBy(payRuns.id, payRuns.payRunRef, payRuns.state, payRuns.paidAt)
    .orderBy(desc(payRuns.paidAt))
    .limit(24);
  return rows.map(r => ({ ...r, lineCount: Number(r.lineCount), amountCents: Number(r.amountCents) }));
}

/** The newest version of a legacy rate key, with the columns that say whose it is. */
export async function loadLatestPayRate(rateKey: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: payRates.id, version: payRates.version, employeePayrollProfileId: payRates.employeePayrollProfileId, payGroupId: payRates.payGroupId })
    .from(payRates)
    .where(eq(payRates.rateKey, rateKey))
    .orderBy(desc(payRates.version))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The book a legacy rate belongs to, through its profile or its pay group. A rate attached to
 * neither has no book and is nobody's to supersede (the F1 rule for no-book rows).
 */
export async function payRateOwnerEntityId(rate: { employeePayrollProfileId: number | null; payGroupId: number | null }): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  if (rate.employeePayrollProfileId != null) {
    const p = (await db.select({ financialEntityId: employeePayrollProfiles.financialEntityId }).from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, rate.employeePayrollProfileId)).limit(1))[0];
    return p?.financialEntityId ?? null;
  }
  if (rate.payGroupId != null) {
    const g = (await db.select({ financialEntityId: payGroups.financialEntityId }).from(payGroups).where(eq(payGroups.id, rate.payGroupId)).limit(1))[0];
    return g?.financialEntityId ?? null;
  }
  return null;
}

export async function loadPayGroup(payGroupId: number) {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(payGroups).where(eq(payGroups.id, payGroupId)).limit(1))[0] ?? null;
}

/**
 * Who originated a payroll record, read from the authorization trail. The handler writes a
 * second, subject-bearing `allowed` row beside the gate's own (the assistant-commit precedent),
 * so the question "who created run X" has an answer without a schema change.
 */
export async function findOriginator(args: { subjectType: "payRun" | "payrollEarning"; subjectId: string; procedureName: string }): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ actorUserId: authorizationDecisions.actorUserId })
    .from(authorizationDecisions)
    .where(and(eq(authorizationDecisions.subjectType, args.subjectType), eq(authorizationDecisions.subjectId, args.subjectId), eq(authorizationDecisions.procedureName, args.procedureName), eq(authorizationDecisions.outcome, "allowed")))
    .orderBy(authorizationDecisions.id)
    .limit(1);
  return rows[0]?.actorUserId ?? null;
}

type TrailRow = { actorUserId: number; procedureName: string; permission: string; subjectType: "payRun" | "payrollEarning"; subjectId: string; detail: string };

/**
 * Create a pay run and its originator row in one transaction. A run whose creator could not
 * be recorded is not created: separation of duties later depends on this row existing.
 */
/**
 * P2 lock, re-read inside the insert's transaction with the period row locked, so an approval that lands between the
 * router's check and the insert cannot let a row into a locked period (the approval's guarded UPDATE waits on this).
 */
async function requirePeriodState(tx: Tx, payPeriodId: number, accepted: readonly string[], what: string) {
  const period = (await tx.select({ state: payPeriods.state }).from(payPeriods).where(eq(payPeriods.id, payPeriodId)).for("update").limit(1))[0];
  if (!period || !accepted.includes(period.state)) {
    throw Object.assign(new Error(`Pay period is ${period?.state ?? "missing"}; ${what}`), { code: "PRECONDITION_FAILED" });
  }
}

export async function createPayRunWithTrail(args: { run: typeof payRuns.$inferInsert; trail: TrailRow }) {
  const db = await getDb();
  if (!db) return undefined;
  return db.transaction(async tx => {
    await requirePeriodState(tx, args.run.payPeriodId, ["collecting", "review"], "a pay run is created only on an open or reviewing period");
    const r = await tx.insert(payRuns).values(args.run);
    const id = Number(r[0]?.insertId);
    const t = await tx.insert(authorizationDecisions).values({
      actorUserId: args.trail.actorUserId, procedureName: args.trail.procedureName, permission: args.trail.permission,
      rolesHeld: null, outcome: "allowed", subjectType: args.trail.subjectType, subjectId: args.trail.subjectId, detail: args.trail.detail, occurredAt: new Date(),
    });
    if (!t[0]?.insertId) throw new Error("Refused: the pay run's originator could not be recorded");
    return id;
  });
}

/** Insert an earning event and its proposer row in one transaction (same reasoning as the run). */
export async function insertEarningWithTrail(args: { earning: typeof payrollEarningEvents.$inferInsert; trail: TrailRow }) {
  const db = await getDb();
  if (!db) return undefined;
  return db.transaction(async tx => {
    await requirePeriodState(tx, args.earning.payPeriodId, ["collecting"], "earnings are proposed only into an open period");
    const r = await tx.insert(payrollEarningEvents).values(args.earning);
    const id = Number(r[0]?.insertId);
    const t = await tx.insert(authorizationDecisions).values({
      actorUserId: args.trail.actorUserId, procedureName: args.trail.procedureName, permission: args.trail.permission,
      rolesHeld: null, outcome: "allowed", subjectType: args.trail.subjectType, subjectId: args.trail.subjectId, detail: args.trail.detail, occurredAt: new Date(),
    });
    if (!t[0]?.insertId) throw new Error("Refused: the earning's proposer could not be recorded");
    return id;
  });
}

export async function loadEarning(earningRef: string) {
  const db = await getDb();
  if (!db) return null;
  return (await db.select().from(payrollEarningEvents).where(eq(payrollEarningEvents.earningRef, earningRef)).limit(1))[0] ?? null;
}

/**
 * Approve one earning: `pending → approved`, guarded by the current status so two approvers
 * racing produce one approval. A `held` earning is blocked for a stated reason and needs that
 * reason resolved (a new proposal), not an approval.
 */
export async function approveEarning(args: { earningRef: string; approvedByUserId: number }): Promise<"approved" | "not_pending"> {
  const db = await getDb();
  if (!db) return "not_pending";
  const r = await db
    .update(payrollEarningEvents)
    // P3 (0234): the approver and the time are recorded on the row, not only on the trail.
    .set({ status: "approved", approvedByUserId: args.approvedByUserId, approvedAt: new Date() })
    .where(and(eq(payrollEarningEvents.earningRef, args.earningRef), eq(payrollEarningEvents.status, "pending")));
  return (r[0]?.affectedRows ?? 0) === 1 ? "approved" : "not_pending";
}

export type CollectionResult = {
  state: "draft" | "collecting" | "review" | "approved" | "processing" | "paid" | "closed" | "amended";
  /** Earnings collected (P0); `amountCents` is their total. */
  collected: number;
  skipped: Array<{ id: number; reason: string }>;
  amountCents: number;
  /** P4 — approved reimbursements scheduled onto the run (never marked paid here). */
  reimbursements: ReimbursementCollection;
};

/**
 * Collect approved earnings into the run's lines. One transaction, the run row locked, so two
 * collectors cannot both add the same event; an event already carried by ANY run is skipped
 * (an earning is paid once); amounts are copied from the integer shadows. Idempotent: a second
 * call collects nothing and reports why.
 */
export async function collectApprovedEarnings(args: { payRunRef: string }): Promise<CollectionResult | null> {
  const db = await getDb();
  if (!db) return null;
  return db.transaction(async tx => {
    const run = (await tx.select().from(payRuns).where(eq(payRuns.payRunRef, args.payRunRef)).for("update").limit(1))[0];
    if (!run) return null;
    if (!payRunMayCollect(run.state)) {
      throw Object.assign(new Error(`Pay run is ${run.state}; lines may be collected only in draft or collecting`), { code: "PRECONDITION_FAILED" });
    }
    // P2 lock, read under the run's lock: a locked period takes no more lines.
    const period = (await tx.select({ state: payPeriods.state, payScheduleId: payPeriods.payScheduleId, periodEndDate: payPeriods.periodEndDate }).from(payPeriods).where(eq(payPeriods.id, run.payPeriodId)).for("update").limit(1))[0];
    if (!period || !(period.state === "collecting" || period.state === "review")) {
      throw Object.assign(new Error(`Pay period is ${period?.state ?? "missing"}; lines are collected only while the period is open or under review`), { code: "PRECONDITION_FAILED" });
    }
    if (run.state === "draft") {
      await tx.update(payRuns).set({ state: "collecting" }).where(eq(payRuns.id, run.id));
    }
    const candidates = await tx
      .select({
        id: payrollEarningEvents.id,
        status: payrollEarningEvents.status,
        calculatedAmountCents: payrollEarningEvents.calculatedAmountCents,
        rateAppliedMillis: payrollEarningEvents.rateAppliedMillis,
        quantity: payrollEarningEvents.quantity,
        earningType: payrollEarningEvents.earningType,
        employeePayrollProfileId: payrollEarningEvents.employeePayrollProfileId,
        payPeriodId: payrollEarningEvents.payPeriodId,
        financialEntityId: employeePayrollProfiles.financialEntityId,
        existingLineId: payRunLines.id,
      })
      .from(payrollEarningEvents)
      .innerJoin(employeePayrollProfiles, eq(employeePayrollProfiles.id, payrollEarningEvents.employeePayrollProfileId))
      .leftJoin(payRunLines, eq(payRunLines.payrollEarningEventId, payrollEarningEvents.id))
      .where(and(eq(payrollEarningEvents.payPeriodId, run.payPeriodId), eq(employeePayrollProfiles.financialEntityId, run.financialEntityId)));
    const decision = selectCollectible({
      run: { financialEntityId: run.financialEntityId, payPeriodId: run.payPeriodId },
      events: candidates.map<CollectibleEarning>(c => ({
        id: c.id, status: c.status, calculatedAmountCents: c.calculatedAmountCents,
        financialEntityId: c.financialEntityId, payPeriodId: c.payPeriodId, alreadyCollected: c.existingLineId != null,
      })),
    });
    const byId = new Map(candidates.map(c => [c.id, c]));
    let amountCents = 0;
    for (const e of decision.collect) {
      const c = byId.get(e.id)!;
      const cents = e.calculatedAmountCents!;
      amountCents += cents;
      await tx.insert(payRunLines).values({
        payRunId: run.id,
        employeePayrollProfileId: c.employeePayrollProfileId,
        lineType: "earning",
        earningType: c.earningType,
        payrollEarningEventId: c.id,
        quantity: c.quantity,
        // Legacy doubles are derived FROM the shadows here, never the other way around.
        rateApplied: c.rateAppliedMillis != null ? c.rateAppliedMillis / 1000 : null,
        rateAppliedMillis: c.rateAppliedMillis,
        amount: cents / 100,
        amountCents: cents,
        taxRuleId: null,
        // An earning line is not a statutory computation; nothing here is UNKNOWN about it.
        ruleStatus: "not_applicable",
      });
    }
    // P4: approved employee reimbursements, by their own selection, in the same transaction. A reimbursement line is
    // scheduled, not paid; payment is decided when the payroll is finalized (P5).
    const reimbursements = await collectReimbursementsInTx(tx, { id: run.id, financialEntityId: run.financialEntityId }, { state: period.state, payScheduleId: period.payScheduleId, periodEndDate: dateTextOf(period.periodEndDate) });
    return { state: run.state === "draft" ? "collecting" : run.state, collected: decision.collect.length, skipped: decision.skipped, amountCents, reimbursements };
  });
}

/** Lines already on a run, for the caller to see what collection produced. */
export async function listPayRunLines(payRunId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(payRunLines).where(eq(payRunLines.payRunId, payRunId)).limit(2000);
}

