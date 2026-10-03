/**
 * Capital assets, CCA and the asset twin — the API.
 */
import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { ownedEntityWhere, requireOwnedEntity, type FinanceScope } from "./_core/entityScope";
import { assetInScope, ccaScheduleInScope, requireEvidence, requireUnit, vendorBillIdInScope } from "./financeScope";
import { getDb } from "./db";
import { capitalAssets, ccaClassBalances, ccaSchedules, financialEntities, fuelTransactions, partMovements, tireInstallations, tires, trips, workOrders } from "../drizzle/schema";
import { assetTwin, buildSchedule, capitalizationProposal, fiscalYearFor, type ClassRule } from "./_core/capitalAssets";
import { tireRun, workOrderCost } from "./_core/fleetShop";
import { determine } from "./_core/taxRuleEngine";
import { loadTaxRules } from "./payrollService";
import { CCA_CLASS_SEEDS, CCA_RULE_TYPE } from "./_core/ccaSeeds";
import { assertPeriodOpen } from "./periodCloseService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
/** F1 — an asset in the caller's books, or "Asset not found". */
async function assetByRef(fs: FinanceScope, assetRef: string) { return assetInScope(await dbOrThrow(), fs, assetRef); }

async function rateLookup() {
  const rules = await loadTaxRules();
  const keys = new Set(rules.map(r => r.ruleKey));
  const all = [...rules, ...CCA_CLASS_SEEDS.filter(s => !keys.has(s.ruleKey))].filter(r => r.ruleType === CCA_RULE_TYPE);
  return (ccaClass: string) => {
    const forClass = all.filter(r => r.parameters.ccaClass === ccaClass);
    return determine(forClass, { jurisdiction: "CA", ruleType: CCA_RULE_TYPE, asOf: new Date() }) as ReturnType<typeof determine> & { parameters?: Partial<ClassRule> };
  };
}

async function scheduleFor(financialEntityId: number, asOf: Date) {
  const db = await dbOrThrow();
  const ent = (await db.select().from(financialEntities).where(eq(financialEntities.id, financialEntityId)).limit(1))[0];
  if (!ent) throw new TRPCError({ code: "NOT_FOUND", message: "Financial entity not found" });
  const fy = fiscalYearFor(asOf, ent.fiscalYearEndMonth ?? 12, ent.fiscalYearEndDay ?? 31);
  const assets = await db.select().from(capitalAssets).where(eq(capitalAssets.financialEntityId, financialEntityId));
  const priorEnd = new Date(fy.start.getTime() - 1);
  const balances = await db.select().from(ccaClassBalances).where(and(eq(ccaClassBalances.financialEntityId, financialEntityId), eq(ccaClassBalances.fiscalYearEnd, priorEnd)));
  const rateFor = await rateLookup();
  const s = buildSchedule({ fiscalYearStart: fy.start, fiscalYearEnd: fy.end, assets: assets.map(a => ({ assetRef: a.assetRef, ccaClass: a.ccaClassCandidate, ccaClassVerified: a.ccaClassVerificationStatus === "verified", acquiredAt: a.acquiredAt, acquisitionCostCents: a.acquisitionCostCents, disposedAt: a.disposedAt, disposalProceedsCents: a.disposalProceedsCents, status: a.status })), openingByClass: new Map(balances.map(b => [b.ccaClass, b.closingUccCents])), rateFor });
  return { fiscalYear: fy, priorBalancesFound: balances.length, ...s };
}

export const assetRouter = router({
  /** Register an asset against the unit or trailer the shop already has. It enters pending capital review; the review decides capitalize or expense. */
  register: moneyScoped(roleProcedure("asset.register"))
    .input(z.object({ financialEntityId: z.number().int().positive(), kind: z.enum(["unit", "trailer", "equipment", "building", "leasehold", "other"]), unitId: z.number().int().positive().nullable().optional(), trailerId: z.number().int().positive().nullable().optional(), description: z.string().min(1).max(220), acquiredAt: z.coerce.date(), acquisitionCostCents: z.number().int().positive(), acquisitionVendorBillId: z.number().int().positive().nullable().optional(), acquisitionEvidenceRecordId: z.number().int().positive().nullable().optional(), financing: z.enum(["owned", "financed", "leased"]).default("owned"), lender: z.string().max(160).nullable().optional(), financedPrincipalCents: z.number().int().nonnegative().nullable().optional(), expectedLifeKm: z.number().int().positive().nullable().optional(), expectedLifeYears: z.number().int().positive().max(50).nullable().optional(), capitalizationThresholdCents: z.number().int().nonnegative().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId, trailerId: input.trailerId });   // CP1.5 — both UNIQUE here: a foreign unit took the owner's slot
      const db = await dbOrThrow();
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      if (input.acquisitionVendorBillId != null) await vendorBillIdInScope(await dbOrThrow(), ctx.money, input.acquisitionVendorBillId, input.financialEntityId);
      await requireEvidence(ctx.money, input.acquisitionEvidenceRecordId);
      if (input.kind === "unit" && !input.unitId) throw new TRPCError({ code: "BAD_REQUEST", message: "A unit asset must name the unit the shop maintains — one truck, one identity" });
      if (input.financing !== "owned" && input.financedPrincipalCents == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Financed or leased assets need the principal" });
      if (input.unitId) { const dup = (await db.select({ assetRef: capitalAssets.assetRef }).from(capitalAssets).where(eq(capitalAssets.unitId, input.unitId)).limit(1))[0]; if (dup) throw new TRPCError({ code: "CONFLICT", message: `Unit ${input.unitId} is already asset ${dup.assetRef}` }); }
      await assertPeriodOpen(input.financialEntityId, input.acquiredAt, "Asset acquisition");
      const proposal = capitalizationProposal({ costCents: input.acquisitionCostCents, thresholdCents: input.capitalizationThresholdCents ?? null, description: input.description });
      const assetRef = ref("ASSET");
      await db.insert(capitalAssets).values({ assetRef, financialEntityId: input.financialEntityId, kind: input.kind, unitId: input.unitId ?? null, trailerId: input.trailerId ?? null, description: input.description, acquiredAt: input.acquiredAt, acquisitionCostCents: input.acquisitionCostCents, acquisitionVendorBillId: input.acquisitionVendorBillId ?? null, acquisitionEvidenceRecordId: input.acquisitionEvidenceRecordId ?? null, financing: input.financing, lender: input.lender ?? null, financedPrincipalCents: input.financedPrincipalCents ?? null, expectedLifeKm: input.expectedLifeKm ?? null, expectedLifeYears: input.expectedLifeYears ?? null, recordedByUserId: ctx.user.id });
      return { assetRef, status: "pending_capital_review" as const, proposal };
    }),

  /** Capitalize or expense — decided by someone other than the recorder. */
  capitalReview: moneyScoped(roleProcedure("asset.capitalReview"))
    .input(z.object({ assetRef: z.string().min(1).max(64), decision: z.enum(["capitalize", "expense"]), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assetByRef(ctx.money, input.assetRef);
      if (a.status !== "pending_capital_review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Asset is ${a.status}` });
      if (a.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded the asset may not decide its capital review" });
      await db.update(capitalAssets).set({ status: input.decision === "capitalize" ? "in_service" : "expensed", capitalReviewedByUserId: ctx.user.id, capitalReviewedAt: new Date(), capitalReviewReason: input.reason }).where(eq(capitalAssets.id, a.id));
      return { assetRef: a.assetRef, status: input.decision === "capitalize" ? "in_service" as const : "expensed" as const };
    }),

  /** A class candidate with its source. It is not a tax fact until verified. */
  ccaClassSet: moneyScoped(roleProcedure("asset.ccaClassSet"))
    .input(z.object({ assetRef: z.string().min(1).max(64), ccaClass: z.string().min(1).max(20), source: z.enum(["accountant", "owner_stated", "system_inferred"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assetByRef(ctx.money, input.assetRef);
      await db.update(capitalAssets).set({ ccaClassCandidate: input.ccaClass, ccaClassSource: input.source, ccaClassVerificationStatus: "unverified", ccaClassVerifiedByUserId: null }).where(eq(capitalAssets.id, a.id));
      return { assetRef: a.assetRef, ccaClass: input.ccaClass, verificationStatus: "unverified" as const };
    }),

  ccaClassVerify: moneyScoped(roleProcedure("asset.ccaClassVerify"))
    .input(z.object({ assetRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assetByRef(ctx.money, input.assetRef);
      if (!a.ccaClassCandidate) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No class candidate to verify" });
      if (a.ccaClassSource !== "accountant") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The candidate is ${a.ccaClassSource?.replace(/_/g, " ")} — only an accountant-sourced class is verified` });
      await db.update(capitalAssets).set({ ccaClassVerificationStatus: "verified", ccaClassVerifiedByUserId: ctx.user.id }).where(eq(capitalAssets.id, a.id));
      return { assetRef: a.assetRef, ccaClass: a.ccaClassCandidate, verificationStatus: "verified" as const };
    }),

  dispose: moneyScoped(roleProcedure("asset.dispose"))
    .input(z.object({ assetRef: z.string().min(1).max(64), disposedAt: z.coerce.date(), proceedsCents: z.number().int().nonnegative(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const a = await assetByRef(ctx.money, input.assetRef);
      if (a.status === "disposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Already disposed" });
      await requireEvidence(ctx.money, input.evidenceRecordId);
      if (input.disposedAt < a.acquiredAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Disposed before acquired" });
      await assertPeriodOpen(a.financialEntityId, input.disposedAt, "Asset disposal");
      await db.update(capitalAssets).set({ status: "disposed", disposedAt: input.disposedAt, disposalProceedsCents: input.proceedsCents, disposalEvidenceRecordId: input.evidenceRecordId ?? null }).where(eq(capitalAssets.id, a.id));
      return { assetRef: a.assetRef, status: "disposed" as const, proceedsCents: input.proceedsCents, note: input.proceedsCents > a.acquisitionCostCents ? "Proceeds exceed cost — the excess is a capital gain, outside the CCA schedule" : null };
    }),

  list: moneyScoped(roleProcedure("asset.list")).input(z.object({ financialEntityId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
    const rows = await db.select().from(capitalAssets).where(eq(capitalAssets.financialEntityId, input.financialEntityId)).orderBy(desc(capitalAssets.acquiredAt));
    return { assets: rows.map(a => ({ assetRef: a.assetRef, kind: a.kind, unitId: a.unitId, description: a.description, acquiredAt: a.acquiredAt, acquisitionCostCents: a.acquisitionCostCents, financing: a.financing, ccaClass: a.ccaClassCandidate, ccaClassVerified: a.ccaClassVerificationStatus === "verified", status: a.status })) };
  }),

  schedule: moneyScoped(roleProcedure("cca.schedule")).input(z.object({ financialEntityId: z.number().int().positive(), asOf: z.coerce.date().optional() })).query(async ({ ctx, input }) => { requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`); return scheduleFor(input.financialEntityId, input.asOf ?? new Date()); }),

  schedulePrepare: moneyScoped(roleProcedure("cca.schedulePrepare")).input(z.object({ financialEntityId: z.number().int().positive(), asOf: z.coerce.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
    const s = await scheduleFor(input.financialEntityId, input.asOf ?? new Date());
    const summaryJson = JSON.stringify(s);
    const prior = (await db.select({ id: ccaSchedules.id, status: ccaSchedules.status }).from(ccaSchedules).where(and(eq(ccaSchedules.financialEntityId, input.financialEntityId), eq(ccaSchedules.fiscalYearEnd, s.fiscalYear.end))).orderBy(desc(ccaSchedules.id)).limit(1))[0];
    const scheduleRef = ref("CCA");
    await db.insert(ccaSchedules).values({ scheduleRef, financialEntityId: input.financialEntityId, fiscalYearEnd: s.fiscalYear.end, summaryJson, payloadHash: sha(summaryJson), determination: s.determination, totalCcaClaimCents: s.totalClaimCents, preparedByUserId: ctx.user.id, preparedAt: new Date(), supersedesScheduleId: prior?.status === "reviewed" ? prior.id : null });
    return { scheduleRef, determination: s.determination, totalCcaClaimCents: s.totalClaimCents, reasons: s.reasons };
  }),

  /** Reviewed by another person; the ledger unchanged since preparation; only a fully computed schedule carries balances forward. */
  scheduleReview: moneyScoped(roleProcedure("cca.scheduleReview")).input(z.object({ scheduleRef: z.string().min(1).max(64), note: z.string().min(5).max(400) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const row = await ccaScheduleInScope(db, ctx.money, input.scheduleRef);
    if (row.status !== "prepared") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Schedule is ${row.status}` });
    if (row.preparedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The preparer may not review their own schedule" });
    const current = await scheduleFor(row.financialEntityId, new Date(row.fiscalYearEnd.getTime() - 1));
    if (sha(JSON.stringify(current)) !== row.payloadHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The asset register has changed since this schedule was prepared — prepare it again" });
    if (current.determination !== "computed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The schedule is ${current.determination}: ${current.reasons.join("; ")} — it cannot be reviewed as a tax fact` });
    await db.update(ccaSchedules).set({ status: "reviewed", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewNote: input.note }).where(eq(ccaSchedules.id, row.id));
    if (row.supersedesScheduleId) await db.update(ccaSchedules).set({ status: "superseded" }).where(eq(ccaSchedules.id, row.supersedesScheduleId));
    for (const p of current.pools) if (p.closingUccCents != null) await db.insert(ccaClassBalances).values({ financialEntityId: row.financialEntityId, ccaClass: p.ccaClass, fiscalYearEnd: row.fiscalYearEnd, closingUccCents: p.closingUccCents, fromScheduleId: row.id }).onDuplicateKeyUpdate({ set: { closingUccCents: p.closingUccCents, fromScheduleId: row.id } });
    return { scheduleRef: row.scheduleRef, status: "reviewed" as const, totalCcaClaimCents: current.totalClaimCents, balancesCarried: current.pools.length };
  }),

  /** One unit, everything it has cost and done, and everything that is unknown about it. */
  twin: moneyScoped(roleProcedure("asset.twin")).input(z.object({ unitId: z.number().int().positive(), labourRateCentsPerHour: z.number().int().positive().nullable().optional() })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    // F1 — the unit must be the caller's (coreRecordOwnership); its asset and fuel are read from the caller's books only.
    await requireUnit(ctx.money, input.unitId);
    const asOf = new Date();
    const asset = (await db.select().from(capitalAssets).where(and(eq(capitalAssets.unitId, input.unitId), ownedEntityWhere(capitalAssets.financialEntityId, ctx.money))).limit(1))[0];
    const fuel = await db.select({ totalCents: fuelTransactions.totalCents, quantity: fuelTransactions.quantity, payerType: fuelTransactions.payerType, status: fuelTransactions.status }).from(fuelTransactions).where(and(eq(fuelTransactions.unitId, input.unitId), ownedEntityWhere(fuelTransactions.financialEntityId, ctx.money)));
    const companyFuel = fuel.filter(f => f.payerType === "company" && f.status !== "rejected");
    const fuelCents = companyFuel.length ? companyFuel.reduce((a, f) => a + f.totalCents, 0) : null;
    const litres = companyFuel.length ? companyFuel.reduce((a, f) => a + (f.quantity ?? 0), 0) : null;
    const wos = await db.select().from(workOrders).where(eq(workOrders.unitId, input.unitId));
    const issues = wos.length ? await db.select().from(partMovements).where(and(inArray(partMovements.workOrderId, wos.map(w => w.id)), eq(partMovements.kind, "issue"))) : [];
    const costs = wos.map(w => workOrderCost({ laborMinutes: w.laborMinutes ?? 0, labourRateCentsPerHour: input.labourRateCentsPerHour ?? null, issues: issues.filter(i => i.workOrderId === w.id).map(i => ({ qty: -i.qtySigned, unitCostCents: i.unitCostCents })) }));
    const shop = { partsCents: costs.reduce((a, c) => a + c.partsCents, 0), labourCents: costs.every(c => c.labourCents != null) ? costs.reduce((a, c) => a + (c.labourCents ?? 0), 0) : null, reasons: Array.from(new Set(costs.flatMap(c => c.reasons))) };
    const insts = await db.select().from(tireInstallations).where(eq(tireInstallations.unitId, input.unitId));
    const tireRows = insts.length ? await db.select().from(tires).where(inArray(tires.id, Array.from(new Set(insts.map(i => i.tireId))))) : [];
    const runs = insts.map(i => tireRun({ installOdometerKm: i.installOdometerKm, removeOdometerKm: i.removeOdometerKm, installTreadMm: i.installTreadMm, removeTreadMm: i.removeTreadMm, purchaseCostCents: tireRows.find(t => t.id === i.tireId)?.purchaseCostCents ?? null }));
    const tripRows = await db.select({ distanceKm: trips.distanceKm, status: trips.status }).from(trips).where(and(eq(trips.unitId, input.unitId), isNotNull(trips.distanceKm)));
    const distanceKm = tripRows.length ? tripRows.reduce((a, t) => a + (t.distanceKm ?? 0), 0) : null;
    const hours = wos.map(w => w.engineHours).filter((h): h is number => h != null);
    const engineHours = hours.length ? Math.max(...hours) : null;
    const downtime = wos.filter(w => w.completedAt).reduce((a, w) => a + (w.completedAt!.getTime() - w.openedAt.getTime()) / 3_600_000, 0);
    const twin = assetTwin({ asset: asset ? { acquisitionCostCents: asset.acquisitionCostCents, acquiredAt: asset.acquiredAt, expectedLifeKm: asset.expectedLifeKm, expectedLifeYears: asset.expectedLifeYears, financing: asset.financing, status: asset.status } : null, fuel: { cents: fuelCents, litres, transactions: companyFuel.length }, shop, tires: { costPerKmCentsKnown: runs.map(r => r.costPerKmCents).filter((c): c is number => c != null), unknownRuns: runs.filter(r => r.kmRun == null).length }, distanceKm, engineHours, downtimeHours: wos.length ? Math.round(downtime * 10) / 10 : null, trips: tripRows.length, asOf });
    return { unitId: input.unitId, asset: asset ? { assetRef: asset.assetRef, status: asset.status, acquisitionCostCents: asset.acquisitionCostCents, financing: asset.financing, ccaClass: asset.ccaClassCandidate, ccaClassVerified: asset.ccaClassVerificationStatus === "verified" } : null, activity: { trips: tripRows.length, distanceKm, engineHours, workOrders: wos.length }, ...twin };
  }),
});
