/**
 * GST/HST — the API. Prepared by one person, finalized by another, with every
 * review item acknowledged by code on the record.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, getDb, mintedIn } from "./db";
import { expenseRecords, fuelTransactions, gstAdjustments, gstReturns, invoices, taxRegistrations, vendorBills } from "../drizzle/schema";
import { buildGstReturn, finalizeDecision, gstPeriodBounds, type Adjustment, type PurchaseRecord, type SaleRecord } from "./_core/gstReturn";
import { determine } from "./_core/taxRuleEngine";
import { loadTaxRules } from "./payrollService";
import { GST_RATE_RULE_TYPE, GST_RATE_SEEDS } from "./_core/gstSeeds";
import { assertPeriodOpen } from "./periodCloseService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const PERIOD = z.string().regex(/^\d{4}-(Q[1-4]|\d{2})$/);
const JUR = z.string().regex(/^CA(-[A-Z]{2})?$/);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cents = (n: number | null | undefined) => Math.round((n ?? 0) * 100);

async function loadReturn(financialEntityId: number, period: string, jurisdiction: string, includeUnassignedInvoices: boolean) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const { start, end } = gstPeriodBounds(period);
  const [inv, bills, expenses, fuel, adj, regs, rules] = await Promise.all([
    db.select().from(invoices).where(and(gte(invoices.createdAt, new Date(start.getTime() - 366 * 86_400_000)), lt(invoices.createdAt, new Date(end.getTime() + 366 * 86_400_000)))),
    db.select().from(vendorBills).where(and(eq(vendorBills.financialEntityId, financialEntityId), gte(vendorBills.invoiceDate, start), lt(vendorBills.invoiceDate, end))),
    db.select().from(expenseRecords).where(and(eq(expenseRecords.financialEntityId, financialEntityId), gte(expenseRecords.transactionDate, start), lt(expenseRecords.transactionDate, end))),
    db.select().from(fuelTransactions).where(and(eq(fuelTransactions.financialEntityId, financialEntityId), gte(fuelTransactions.occurredAt, start), lt(fuelTransactions.occurredAt, end))),
    db.select().from(gstAdjustments).where(and(eq(gstAdjustments.financialEntityId, financialEntityId), eq(gstAdjustments.period, period))),
    db.select().from(taxRegistrations).where(and(eq(taxRegistrations.financialEntityId, financialEntityId), eq(taxRegistrations.registrationType, "gst_hst"))),
    loadTaxRules(),
  ]);
  const live = inv.filter(i => i.status !== "void").filter(i => { const d = i.issuedAt ?? i.createdAt; return d >= start && d < end; });
  const unassignedExcluded = includeUnassignedInvoices ? 0 : live.filter(i => i.financialEntityId == null).length;
  const sales: SaleRecord[] = live
    .filter(i => i.financialEntityId === financialEntityId || (includeUnassignedInvoices && i.financialEntityId == null))
    .map(i => ({ ref: i.invoiceNumber, issuedAt: i.issuedAt ?? i.createdAt, subtotalCents: i.subtotalCents, taxCents: i.taxCents, treatment: i.gstTreatment, jurisdiction, entityAssigned: i.financialEntityId != null }));
  const purchases: PurchaseRecord[] = [
    ...bills.filter(b => b.status !== "cancelled" && b.status !== "disputed").map(b => ({ ref: b.billRef, kind: "vendor_bill" as const, date: b.invoiceDate, subtotalCents: b.subtotalCents ?? 0, taxCents: b.taxAmountCents ?? 0, hasEvidence: b.evidenceRecordId != null, treatment: b.gstTreatment })),
    ...expenses.filter(e => e.status !== "rejected").map(e => ({ ref: e.expenseRef ?? `EXP-${e.id}`, kind: "expense" as const, date: e.transactionDate, subtotalCents: e.subtotalCents ?? cents(e.subtotal), taxCents: e.salesTaxAmountCents ?? cents(e.salesTaxAmount), hasEvidence: e.evidenceRecordId != null, treatment: null })),
    ...fuel.filter(f => f.status !== "rejected" && f.payerType === "company").map(f => ({ ref: f.fuelRef, kind: "fuel" as const, date: f.occurredAt, subtotalCents: f.subtotalCents ?? 0, taxCents: f.taxAmountCents ?? 0, hasEvidence: f.evidenceRecordId != null, treatment: null })),
  ];
  const adjustments: Adjustment[] = adj.map(a => ({ ref: a.adjustmentRef, line: a.line, amountCents: a.amountCents, reason: a.reason }));
  const reg = regs.sort((a, b) => b.id - a.id)[0];
  const keys = new Set(rules.map(r => r.ruleKey));
  const allRules = [...rules, ...GST_RATE_SEEDS.filter(s => !keys.has(s.ruleKey))];
  const rateFor = (j: string) => determine(allRules, { jurisdiction: j, ruleType: GST_RATE_RULE_TYPE, asOf: start }) as ReturnType<typeof determine> & { parameters?: { ratePercent?: number | null } };
  return buildGstReturn({ period, jurisdiction, registration: reg ? { registered: !!reg.registered, identifierPresent: !!reg.identifierPresent } : null, sales, purchases, adjustments, rateFor, unassignedSalesExcluded: unassignedExcluded });
}

export const gstRouter = router({
  /** Classify a sale or a purchase. A closed period refuses — it changes a filed figure. */
  treatmentSet: roleProcedure("gst.treatmentSet")
    .input(z.object({ kind: z.enum(["invoice", "vendor_bill"]), ref: z.string().min(1).max(64), treatment: z.enum(["taxable", "zero_rated", "exempt"]), source: z.enum(["invoice_terms", "customer_status", "review"]) }))
    .mutation(async ({ ctx, input }) => {
      const scope = await actingScopeFor(ctx.user.id);
        const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.kind === "invoice") {
        const row = (await db.select().from(invoices).where(mintedIn(invoices, invoices.invoiceNumber, input.ref, scope)).limit(1))[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
        if (row.financialEntityId != null) await assertPeriodOpen(row.financialEntityId, row.issuedAt ?? row.createdAt, "Invoice tax treatment");
        await db.update(invoices).set({ gstTreatment: input.treatment, gstTreatmentSource: input.source }).where(eq(invoices.id, row.id));
      } else {
        const row = (await db.select().from(vendorBills).where(eq(vendorBills.billRef, input.ref)).limit(1))[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill not found" });
        await assertPeriodOpen(row.financialEntityId, row.invoiceDate, "Bill tax treatment");
        await db.update(vendorBills).set({ gstTreatment: input.treatment }).where(eq(vendorBills.id, row.id));
      }
      return { kind: input.kind, ref: input.ref, treatment: input.treatment };
    }),

  adjustmentRecord: roleProcedure("gst.adjustmentRecord")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, line: z.enum(["104", "107"]), amountCents: z.number().int().positive(), reason: z.string().min(10).max(400), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await assertPeriodOpen(input.financialEntityId, gstPeriodBounds(input.period).start, "GST adjustment");
      const adjustmentRef = ref("GADJ");
      await db.insert(gstAdjustments).values({ adjustmentRef, financialEntityId: input.financialEntityId, period: input.period, line: input.line, amountCents: input.amountCents, reason: input.reason, evidenceRecordId: input.evidenceRecordId ?? null, recordedByUserId: ctx.user.id, recordedAt: new Date() });
      return { adjustmentRef, line: input.line, amountCents: input.amountCents };
    }),

  return: roleProcedure("gst.return")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, jurisdiction: JUR.default("CA"), includeUnassignedInvoices: z.boolean().default(false) }))
    .query(async ({ input }) => loadReturn(input.financialEntityId, input.period, input.jurisdiction, input.includeUnassignedInvoices)),

  returnPrepare: roleProcedure("gst.returnPrepare")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, jurisdiction: JUR.default("CA"), includeUnassignedInvoices: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const r = await loadReturn(input.financialEntityId, input.period, input.jurisdiction, input.includeUnassignedInvoices);
      const summaryJson = JSON.stringify(r);
      const prior = (await db.select({ id: gstReturns.id, status: gstReturns.status }).from(gstReturns).where(and(eq(gstReturns.financialEntityId, input.financialEntityId), eq(gstReturns.period, input.period))).orderBy(desc(gstReturns.id)).limit(1))[0];
      const supersedes = prior && (prior.status === "finalized" || prior.status === "filed") ? prior.id : null;
      const returnRef = ref("GST");
      await db.insert(gstReturns).values({ returnRef, financialEntityId: input.financialEntityId, period: input.period, periodStart: r.periodStart, periodEnd: r.periodEnd, status: "prepared", summaryJson, payloadHash: sha(summaryJson), determination: r.determination, netTaxCents: r.determination === "blocked" ? null : r.lines.line109NetTaxCents, preparedByUserId: ctx.user.id, preparedAt: new Date(), supersedesReturnId: supersedes });
      return { returnRef, determination: r.determination, netTaxCents: r.determination === "blocked" ? null : r.lines.line109NetTaxCents, exceptions: r.exceptions.length, supersedes };
    }),

  /** Another person, the ledger unchanged since preparation, nothing blocking, every review item acknowledged by code. */
  returnFinalize: roleProcedure("gst.returnFinalize")
    .input(z.object({ returnRef: z.string().min(1).max(64), acknowledgeReviewItems: z.array(z.string().min(1).max(60)).default([]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const row = (await db.select().from(gstReturns).where(eq(gstReturns.returnRef, input.returnRef)).limit(1))[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Return not found" });
      if (row.status !== "prepared") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Return is ${row.status}` });
      if (row.preparedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The preparer may not finalize their own return" });
      const summary = JSON.parse(row.summaryJson) as { rateCheck: { jurisdiction: string } };
      const current = await loadReturn(row.financialEntityId, row.period, summary.rateCheck.jurisdiction, false);
      if (sha(JSON.stringify(current)) !== row.payloadHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The ledger has changed since this return was prepared — prepare it again" });
      const d = finalizeDecision(current, input.acknowledgeReviewItems);
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.update(gstReturns).set({ status: "finalized", finalizedByUserId: ctx.user.id, finalizedAt: new Date(), reviewItemsAcknowledged: JSON.stringify(input.acknowledgeReviewItems) }).where(eq(gstReturns.id, row.id));
      if (row.supersedesReturnId) await db.update(gstReturns).set({ status: "amended" }).where(eq(gstReturns.id, row.supersedesReturnId));
      return { returnRef: row.returnRef, status: "finalized" as const, netTaxCents: current.lines.line109NetTaxCents, acknowledged: input.acknowledgeReviewItems };
    }),
});
