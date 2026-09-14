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

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "./db";
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

export async function listPayrollProfiles() {
  const db = await getDb();
  if (!db) return [];
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

export async function listPayRates(earningType?: string): Promise<PayRate[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = earningType
    ? await db.select().from(payRates).where(eq(payRates.earningType, earningType))
    : await db.select().from(payRates).limit(500);
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
}) {
  const db = await getDb();
  if (!db) return [];
  const where =
    args.profileId != null
      ? eq(payrollEarningEvents.employeePayrollProfileId, args.profileId)
      : args.payPeriodId != null
        ? eq(payrollEarningEvents.payPeriodId, args.payPeriodId)
        : undefined;
  const q = db.select().from(payrollEarningEvents);
  return where ? q.where(where).limit(500) : q.limit(500);
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

export async function listPayPeriods() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(payPeriods).orderBy(desc(payPeriods.startsOn)).limit(200);
}

export async function openPayPeriod(values: typeof payPeriods.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(payPeriods).values(values);
  return r[0]?.insertId;
}

export async function listPayRuns() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(payRuns).orderBy(desc(payRuns.createdAt)).limit(200);
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

export async function listDisputes() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(payrollDisputes).orderBy(desc(payrollDisputes.createdAt)).limit(200);
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

export async function listSettlements() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(contractorSettlements)
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

export async function listFinancialEntities() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialEntities).limit(200);
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
