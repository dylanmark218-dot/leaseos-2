/**
 * Bank reconciliation and accounts receivable — the API.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { bankAccounts, bankStatementLines, bankStatements, collectionEvents, customerAccounts, customerCredits, customerPayments, fuelStatementLines, fuelStatements, invoices, paymentAllocations, vendorBills, writeOffRequests } from "../drizzle/schema";
import { sql } from "drizzle-orm";
import { reconcileBank, reconciliationStatement, type BankLine, type Movement } from "./_core/bankReconciliation";
import { aging, allocatePayment, invoiceBalanceCents, writeOffDecision, type ArCredit, type ArInvoice } from "./_core/accountsReceivable";
import { assertPeriodOpen } from "./periodCloseService";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cents = (n: number | null | undefined) => Math.round((n ?? 0) * 100);

async function movementsFor(financialEntityId: number, from: Date, to: Date): Promise<Movement[]> {
  const db = await getDb();
  if (!db) return [];
  const pad = 10 * 86_400_000;
  const [pays, bills, stmts] = await Promise.all([
    db.select().from(customerPayments).where(and(eq(customerPayments.financialEntityId, financialEntityId), gte(customerPayments.receivedAt, new Date(from.getTime() - pad)), lte(customerPayments.receivedAt, new Date(to.getTime() + pad)))),
    db.select().from(vendorBills).where(and(eq(vendorBills.financialEntityId, financialEntityId), eq(vendorBills.status, "paid"))),
    db.select().from(fuelStatements).where(and(eq(fuelStatements.financialEntityId, financialEntityId), gte(fuelStatements.periodEnd, new Date(from.getTime() - pad)), lte(fuelStatements.periodEnd, new Date(to.getTime() + pad)))),
  ]);
  const matchedLines = await db.select({ matchedType: bankStatementLines.matchedType, matchedId: bankStatementLines.matchedId }).from(bankStatementLines).where(eq(bankStatementLines.matchOutcome, "matched"));
  const already = new Set(matchedLines.map(l => `${l.matchedType}:${l.matchedId}`));
  const out: Movement[] = [];
  for (const p of pays) if (p.status !== "reversed") out.push({ kind: "customer_payment", id: p.id, ref: p.paymentRef, amountCents: p.amountCents, at: p.receivedAt, alreadyMatched: already.has(`customer_payment:${p.id}`) });
  for (const b of bills) if (b.paymentReleasedAt && b.paymentReleasedAt >= new Date(from.getTime() - pad) && b.paymentReleasedAt <= new Date(to.getTime() + pad)) out.push({ kind: "vendor_bill", id: b.id, ref: b.billRef, amountCents: -b.totalCents, at: b.paymentReleasedAt, alreadyMatched: already.has(`vendor_bill:${b.id}`) });
  for (const s of stmts) {
    const lines = await db.select({ total: fuelStatementLines.total }).from(fuelStatementLines).where(eq(fuelStatementLines.fuelStatementId, s.id));
    const total = lines.reduce((a, l) => a + cents(l.total), 0);
    if (total > 0) out.push({ kind: "fuel_statement", id: s.id, ref: s.statementRef, amountCents: -total, at: s.periodEnd, alreadyMatched: already.has(`fuel_statement:${s.id}`) });
  }
  return out;
}

export const bankRouter = router({
  accountRegister: roleProcedure("bank.accountRegister")
    .input(z.object({ financialEntityId: z.number().int().positive(), name: z.string().min(1).max(120), institution: z.string().max(120).nullable().optional(), lastFour: z.string().regex(/^\d{4}$/).nullable().optional(), currency: z.string().length(3).default("CAD") }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const accountRef = ref("BANK");
      await db.insert(bankAccounts).values({ accountRef, financialEntityId: input.financialEntityId, name: input.name, institution: input.institution ?? null, lastFour: input.lastFour ?? null, currency: input.currency });
      return { accountRef };
    }),

  /** Import once by content; match every line; leave findings as findings. Never creates a movement from a line. */
  statementImport: roleProcedure("bank.statementImport")
    .input(z.object({
      accountRef: z.string().min(1).max(64), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), openingBalanceCents: z.number().int(), closingBalanceCents: z.number().int(),
      lines: z.array(z.object({ postedAt: z.coerce.date(), description: z.string().max(300).nullable().optional(), reference: z.string().max(120).nullable().optional(), amountCents: z.number().int() })).min(1).max(5000),
      windowDays: z.number().int().positive().max(30).default(5), evidenceRecordId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acct = (await db.select().from(bankAccounts).where(eq(bankAccounts.accountRef, input.accountRef)).limit(1))[0];
      if (!acct) throw new TRPCError({ code: "NOT_FOUND", message: "Bank account not found" });
      const sum = input.lines.reduce((a, l) => a + l.amountCents, 0);
      if (input.openingBalanceCents + sum !== input.closingBalanceCents) throw new TRPCError({ code: "BAD_REQUEST", message: `Lines sum to ${sum}; opening ${input.openingBalanceCents} plus lines is not closing ${input.closingBalanceCents} — the statement is incomplete` });
      const contentHash = sha(JSON.stringify({ a: acct.id, s: input.periodStart, e: input.periodEnd, o: input.openingBalanceCents, c: input.closingBalanceCents, l: input.lines.map(l => [l.postedAt, l.amountCents, l.reference ?? null]) }));
      const dup = (await db.select({ statementRef: bankStatements.statementRef }).from(bankStatements).where(eq(bankStatements.contentHash, contentHash)).limit(1))[0];
      if (dup) return { statementRef: dup.statementRef, alreadyImported: true as const };
      await assertPeriodOpen(acct.financialEntityId, input.periodEnd, "Bank statement import");
      const lines: BankLine[] = input.lines.map((l, i) => ({ lineNo: i + 1, postedAt: l.postedAt, amountCents: l.amountCents, description: l.description ?? null, reference: l.reference ?? null }));
      const movements = await movementsFor(acct.financialEntityId, input.periodStart, input.periodEnd);
      const rec = reconcileBank({ lines, movements, windowDays: input.windowDays, periodEnd: input.periodEnd });
      const statementRef = ref("BSTMT");
      const ins = await db.insert(bankStatements).values({ statementRef, bankAccountId: acct.id, periodStart: input.periodStart, periodEnd: input.periodEnd, openingBalanceCents: input.openingBalanceCents, closingBalanceCents: input.closingBalanceCents, lineCount: lines.length, matchedCount: rec.counts.matched, unmatchedCount: rec.counts.unmatched + rec.counts.ambiguous + rec.counts.timing_difference, contentHash, importedByUserId: ctx.user.id, importedAt: new Date(), evidenceRecordId: input.evidenceRecordId ?? null });
      const statementId = Number(ins[0]?.insertId ?? 0);
      for (const r of rec.results) {
        const l = lines[r.lineNo - 1]!;
        const li = await db.insert(bankStatementLines).values({ bankStatementId: statementId, lineNo: r.lineNo, postedAt: l.postedAt, description: l.description, reference: l.reference, amountCents: l.amountCents, matchedType: r.matched?.kind ?? null, matchedId: r.matched?.id ?? null, matchOutcome: r.outcome, matchReason: r.reason });
        if (r.matched?.kind === "customer_payment") await db.update(customerPayments).set({ bankStatementLineId: Number(li[0]?.insertId ?? 0) }).where(eq(customerPayments.id, r.matched.id));
      }
      const stmt = reconciliationStatement({ bankClosingCents: input.closingBalanceCents, bookOpeningCents: input.openingBalanceCents, movements, periodEnd: input.periodEnd, rec, lines });
      return { statementRef, alreadyImported: false as const, counts: rec.counts, findings: rec.results.filter(r => r.outcome !== "matched").map(r => ({ lineNo: r.lineNo, outcome: r.outcome, reason: r.reason })), outstandingWithdrawals: rec.outstandingWithdrawals.map(m => m.ref), depositsInTransit: rec.depositsInTransit.map(m => m.ref), reconciliation: stmt };
    }),

  reconciliation: roleProcedure("bank.reconciliation")
    .input(z.object({ statementRef: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const st = (await db.select().from(bankStatements).where(eq(bankStatements.statementRef, input.statementRef)).limit(1))[0];
      if (!st) throw new TRPCError({ code: "NOT_FOUND", message: "Statement not found" });
      const acct = (await db.select().from(bankAccounts).where(eq(bankAccounts.id, st.bankAccountId)).limit(1))[0]!;
      const rows = await db.select().from(bankStatementLines).where(eq(bankStatementLines.bankStatementId, st.id));
      const lines: BankLine[] = rows.map(r => ({ lineNo: r.lineNo, postedAt: r.postedAt, amountCents: r.amountCents, description: r.description, reference: r.reference }));
      const movements = await movementsFor(acct.financialEntityId, st.periodStart, st.periodEnd);
      const rec = reconcileBank({ lines, movements: movements.map(m => ({ ...m, alreadyMatched: false })), windowDays: 5, periodEnd: st.periodEnd });
      return { statementRef: st.statementRef, ...reconciliationStatement({ bankClosingCents: st.closingBalanceCents, bookOpeningCents: st.openingBalanceCents, movements, periodEnd: st.periodEnd, rec, lines }), lines: rows.map(r => ({ lineNo: r.lineNo, amountCents: r.amountCents, outcome: r.matchOutcome, reason: r.matchReason })) };
    }),
});

async function invoiceByNumber(n: string): Promise<ArInvoice & { financialEntityId: number | null }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const i = (await db.select().from(invoices).where(eq(invoices.invoiceNumber, n)).limit(1))[0];
  if (!i) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
  return { id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer, totalCents: i.totalCents, dueAt: i.dueAt, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, disputed: i.status === "disputed" || i.disputedAt != null, financialEntityId: i.financialEntityId, customerAccountId: i.customerAccountId };
}

/** v21.9.1 — the customer's identity within an entity: found or created server-side, never supplied as an id by the caller. */
async function resolveCustomerAccount(financialEntityId: number, name: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const existing = (await db.select({ id: customerAccounts.id }).from(customerAccounts).where(and(eq(customerAccounts.financialEntityId, financialEntityId), eq(customerAccounts.name, name))).limit(1))[0];
  if (existing) return existing.id;
  const ins = await db.insert(customerAccounts).values({ accountRef: ref("CUST"), financialEntityId, name });
  return Number(ins[0]?.insertId ?? 0);
}

export const arRouter = router({
  paymentRecord: roleProcedure("ar.paymentRecord")
    .input(z.object({ financialEntityId: z.number().int().positive(), customer: z.string().min(1).max(220), receivedAt: z.coerce.date(), amountCents: z.number().int().positive(), method: z.enum(["eft", "cheque", "card", "cash", "other"]), reference: z.string().max(120).nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await assertPeriodOpen(input.financialEntityId, input.receivedAt, "Customer payment");
      const customerAccountId = await resolveCustomerAccount(input.financialEntityId, input.customer);
      const paymentRef = ref("PAY");
      await db.insert(customerPayments).values({ paymentRef, financialEntityId: input.financialEntityId, customer: input.customer, customerAccountId, receivedAt: input.receivedAt, amountCents: input.amountCents, method: input.method, reference: input.reference ?? null, recordedByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null });
      return { paymentRef, status: "unapplied" as const };
    }),

  /**
   * Cash application. Never crosses entities or customers, never exceeds the
   * payment or the invoice — and v21.9.1: decided inside one transaction with
   * the payment and invoice rows locked, balances recomputed under the lock.
   * Two simultaneous allocations of the same remaining balance: one succeeds.
   */
  paymentAllocate: roleProcedure("ar.paymentAllocate")
    .input(z.object({ paymentRef: z.string().min(1).max(64), invoiceNumber: z.string().min(1).max(64), amountCents: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      return db.transaction(async tx => {
        const p = (await tx.select().from(customerPayments).where(eq(customerPayments.paymentRef, input.paymentRef)).for("update").limit(1))[0];
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
        if (p.status === "reversed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payment was reversed" });
        const i = (await tx.select().from(invoices).where(eq(invoices.invoiceNumber, input.invoiceNumber)).for("update").limit(1))[0];
        if (!i) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
        // An invoice that predates customer accounts takes the payment's account on first application — same entity, same name — and keeps it.
        let invoiceAccountId = i.customerAccountId;
        if (invoiceAccountId == null && i.financialEntityId === p.financialEntityId && i.customer === p.customer) invoiceAccountId = p.customerAccountId;
        const inv: ArInvoice = { id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer, totalCents: i.totalCents, dueAt: i.dueAt, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, disputed: i.status === "disputed" || i.disputedAt != null, financialEntityId: i.financialEntityId, customerAccountId: invoiceAccountId };
        const [allocs, invAllocs, creds] = await Promise.all([
          tx.select().from(paymentAllocations).where(eq(paymentAllocations.customerPaymentId, p.id)),
          tx.select().from(paymentAllocations).where(eq(paymentAllocations.invoiceId, inv.id)),
          tx.select().from(customerCredits).where(eq(customerCredits.invoiceId, inv.id)),
        ]);
        const d = allocatePayment({ payment: { id: p.id, customer: p.customer, amountCents: p.amountCents, financialEntityId: p.financialEntityId, customerAccountId: p.customerAccountId }, alreadyAllocatedCents: allocs.reduce((a, x) => a + x.amountCents, 0), invoice: inv, invoiceAllocations: invAllocs.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })), credits: creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status })), amountCents: input.amountCents });
        if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
        await tx.insert(paymentAllocations).values({ customerPaymentId: p.id, invoiceId: inv.id, amountCents: input.amountCents, allocatedByUserId: ctx.user.id, allocatedAt: new Date() });
        await tx.update(invoices).set({ status: d.invoiceStatusAfter, ...(i.customerAccountId == null && invoiceAccountId != null ? { customerAccountId: invoiceAccountId } : {}) }).where(eq(invoices.id, inv.id));
        await tx.update(customerPayments).set({ status: d.paymentUnallocatedAfterCents === 0 ? "applied" : "partially_applied" }).where(eq(customerPayments.id, p.id));
        return { paymentRef: p.paymentRef, invoiceNumber: inv.invoiceNumber, invoiceBalanceAfterCents: d.invoiceBalanceAfterCents, paymentUnallocatedAfterCents: d.paymentUnallocatedAfterCents, invoiceStatus: d.invoiceStatusAfter };
      });
    }),

  creditRequest: roleProcedure("ar.creditRequest")
    .input(z.object({ financialEntityId: z.number().int().positive().optional(), customer: z.string().min(1).max(220).optional(), invoiceNumber: z.string().max(64).nullable().optional(), amountCents: z.number().int().positive(), reason: z.string().min(10).max(400), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // v21.9.1 — a credit against an invoice takes its entity and customer FROM the invoice; the caller does not say whose it is.
      const inv = input.invoiceNumber ? await invoiceByNumber(input.invoiceNumber) : null;
      let financialEntityId: number, customer: string, customerAccountId: number | null;
      if (inv) {
        if (inv.financialEntityId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Invoice ${inv.invoiceNumber} carries no financial entity — assign it before crediting` });
        financialEntityId = inv.financialEntityId; customer = inv.customer; customerAccountId = inv.customerAccountId ?? (await resolveCustomerAccount(financialEntityId, customer));
      } else {
        if (!input.financialEntityId || !input.customer) throw new TRPCError({ code: "BAD_REQUEST", message: "A credit not tied to an invoice needs the entity and the customer" });
        financialEntityId = input.financialEntityId; customer = input.customer; customerAccountId = await resolveCustomerAccount(financialEntityId, customer);
      }
      const creditRef = ref("CR");
      await db.insert(customerCredits).values({ creditRef, financialEntityId, customer, customerAccountId, invoiceId: inv?.id ?? null, amountCents: input.amountCents, reason: input.reason, requestedByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null });
      return { creditRef, status: "requested" as const, financialEntityId, customer };
    }),

  creditDecide: roleProcedure("ar.creditDecide")
    .input(z.object({ creditRef: z.string().min(1).max(64), decision: z.enum(["approved", "refused"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const c = (await db.select().from(customerCredits).where(eq(customerCredits.creditRef, input.creditRef)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Credit not found" });
      if (c.status !== "requested") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Credit is ${c.status}` });
      if (c.requestedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The requester may not decide their own credit" });
      await db.update(customerCredits).set({ status: input.decision, approvedByUserId: ctx.user.id, approvedAt: new Date() }).where(eq(customerCredits.id, c.id));
      return { creditRef: c.creditRef, status: input.decision };
    }),

  collectionEvent: roleProcedure("ar.collectionEvent")
    .input(z.object({ invoiceNumber: z.string().min(1).max(64), eventType: z.enum(["reminder_sent", "statement_sent", "call", "promise_to_pay", "dispute_noted", "escalated"]), note: z.string().max(600).optional(), promisedAmountCents: z.number().int().positive().optional(), promisedAt: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const inv = await invoiceByNumber(input.invoiceNumber);
      if (input.eventType === "promise_to_pay" && (input.promisedAmountCents == null || !input.promisedAt)) throw new TRPCError({ code: "BAD_REQUEST", message: "A promise to pay needs an amount and a date" });
      await db.insert(collectionEvents).values({ invoiceId: inv.id, eventType: input.eventType, note: input.note ?? null, promisedAmountCents: input.promisedAmountCents ?? null, promisedAt: input.promisedAt ?? null, byUserId: ctx.user.id, at: new Date() });
      return { invoiceNumber: inv.invoiceNumber, eventType: input.eventType };
    }),

  writeOffRequest: roleProcedure("ar.writeOffRequest")
    .input(z.object({ invoiceNumber: z.string().min(1).max(64), amountCents: z.number().int().positive(), reason: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const inv = await invoiceByNumber(input.invoiceNumber);
      const requestRef = ref("WO");
      await db.insert(writeOffRequests).values({ requestRef, invoiceId: inv.id, amountCents: input.amountCents, reason: input.reason, requestedByUserId: ctx.user.id, requestedAt: new Date() });
      await db.insert(collectionEvents).values({ invoiceId: inv.id, eventType: "write_off_requested", note: input.reason, byUserId: ctx.user.id, at: new Date() });
      return { requestRef, status: "requested" as const };
    }),

  /** Approval becomes a credit on the invoice, by the controller, never by the requester. */
  writeOffDecide: roleProcedure("ar.writeOffDecide")
    .input(z.object({ requestRef: z.string().min(1).max(64), decision: z.enum(["approved", "refused"]), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const w = (await db.select().from(writeOffRequests).where(eq(writeOffRequests.requestRef, input.requestRef)).limit(1))[0];
      if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "Write-off request not found" });
      if (w.status !== "requested") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Request is ${w.status}` });
      const invRow = (await db.select().from(invoices).where(eq(invoices.id, w.invoiceId)).limit(1))[0]!;
      // v21.9.1 — a legacy invoice with no entity is refused, not credited to an invented entity 0.
      if (invRow.financialEntityId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Invoice ${invRow.invoiceNumber} carries no financial entity — assign it before deciding a write-off` });
      const [allocs, creds] = await Promise.all([db.select().from(paymentAllocations).where(eq(paymentAllocations.invoiceId, w.invoiceId)), db.select().from(customerCredits).where(eq(customerCredits.invoiceId, w.invoiceId))]);
      const balance = invoiceBalanceCents({ id: invRow.id, invoiceNumber: invRow.invoiceNumber, customer: invRow.customer, totalCents: invRow.totalCents, dueAt: invRow.dueAt, issuedAt: invRow.issuedAt ?? invRow.createdAt, status: invRow.status, disputed: false }, allocs.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })), creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status })) as ArCredit[]);
      const d = writeOffDecision({ requestedByUserId: w.requestedByUserId, deciderUserId: ctx.user.id, amountCents: w.amountCents, invoiceBalanceCents: balance });
      if (!d.permitted) throw new TRPCError({ code: input.decision === "approved" && d.refusals[0]?.includes("own") ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.update(writeOffRequests).set({ status: input.decision, decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionReason: input.reason }).where(eq(writeOffRequests.id, w.id));
      await db.insert(collectionEvents).values({ invoiceId: w.invoiceId, eventType: "write_off_decided", note: `${input.decision}: ${input.reason}`, byUserId: ctx.user.id, at: new Date() });
      if (input.decision === "approved") {
        const creditRef = ref("CR");
        await db.insert(customerCredits).values({ creditRef, financialEntityId: invRow.financialEntityId, customer: invRow.customer, customerAccountId: invRow.customerAccountId, invoiceId: invRow.id, amountCents: w.amountCents, reason: `Write-off ${w.requestRef}: ${w.reason}`, requestedByUserId: w.requestedByUserId, approvedByUserId: ctx.user.id, approvedAt: new Date(), status: "approved" });
        if (balance - w.amountCents === 0) await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, invRow.id));
        return { requestRef: w.requestRef, status: "approved" as const, creditRef, invoiceBalanceAfterCents: balance - w.amountCents };
      }
      return { requestRef: w.requestRef, status: "refused" as const };
    }),

  aging: roleProcedure("ar.aging")
    .input(z.object({ financialEntityId: z.number().int().positive(), asOf: z.coerce.date().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const inv = await db.select().from(invoices).where(eq(invoices.financialEntityId, input.financialEntityId));
      const ids = inv.map(i => i.id);
      const [allocs, creds, pays] = await Promise.all([
        ids.length ? db.select().from(paymentAllocations).where(inArray(paymentAllocations.invoiceId, ids)) : [],
        db.select().from(customerCredits).where(eq(customerCredits.financialEntityId, input.financialEntityId)),
        db.select().from(customerPayments).where(eq(customerPayments.financialEntityId, input.financialEntityId)),
      ]);
      const payAllocs = pays.length ? await db.select().from(paymentAllocations).where(inArray(paymentAllocations.customerPaymentId, pays.map(p => p.id))) : [];
      const allocatedByPayment = new Map<number, number>();
      for (const a of payAllocs) allocatedByPayment.set(a.customerPaymentId, (allocatedByPayment.get(a.customerPaymentId) ?? 0) + a.amountCents);
      return aging({
        invoices: inv.map(i => ({ id: i.id, invoiceNumber: i.invoiceNumber, customer: i.customer, totalCents: i.totalCents, dueAt: i.dueAt, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, disputed: i.status === "disputed" || i.disputedAt != null })),
        allocations: allocs.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })),
        credits: creds.map(c => ({ invoiceId: c.invoiceId, customer: c.customer, amountCents: c.amountCents, status: c.status })),
        payments: pays.filter(p => p.status !== "reversed").map(p => ({ id: p.id, customer: p.customer, amountCents: p.amountCents })),
        paymentAllocatedCents: allocatedByPayment, asOf: input.asOf ?? new Date(),
      });
    }),
});
