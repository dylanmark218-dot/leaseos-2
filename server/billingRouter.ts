/**
 * v23.32 — Billing, Invoicing and Accounts Receivable: the tRPC door.
 *
 * Every procedure is money-scoped over a role procedure: role-authorized by name in the caller's organization, and
 * its books resolved server-side by the strict F1 resolver (financeScopeFor) — an ended, lapsed or suspended
 * membership is FORBIDDEN, never revived by the single-tenant fallback. Nothing here writes a row: the service owns
 * the transactions, the audit rows and the outbox events. The UI decides nothing; these checks are the boundary.
 *
 * Domain operations (the spec's names → these procedures): prepareBilling → prepare; recalculateBilling →
 * recalculate; approveInvoice → invoiceApprove; issueInvoice → invoiceIssue; recordPayment → paymentRecord;
 * allocatePayment → paymentAllocate; reverseAllocation → allocationReverse; createCredit → creditCreate;
 * approveCredit → creditDecide; openDispute → disputeOpen; resolveDispute → disputeResolve.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import type { FinanceScope } from "./_core/entityScope";
import { getDb } from "./db";
import * as svc from "./billingService";
import { decide as ledgerDecide } from "./_core/commercialApprovalService";

const rolesOf = (ctx: unknown) => ((ctx as { roles?: readonly string[] }).roles ?? []) as readonly string[];
const actorOf = (ctx: { user: { id: number } }) => ({ userId: ctx.user.id, roles: rolesOf(ctx) });
/** The billing scope from the money scope moneyScoped resolved — never from input. */
async function scopeOf(money: FinanceScope): Promise<svc.BillingScope> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return { db, scope: { tenantId: money.tenantId }, entityIds: [...money.entityIds], tenantId: money.tenantId };
}

const NUMBER = z.string().min(1).max(64);
const REF = z.string().min(1).max(64);
const REASON = z.string().trim().min(5).max(400);
const JOB = z.number().int().positive();
const CENTS = z.number().int();

export const billingRouter = router({
  /* ---------------- workspace, readiness, charges ---------------- */
  dashboard: moneyScoped(roleProcedure("billing.dashboard")).input(z.object({ accountRef: REF.optional(), q: z.string().max(80).optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ ctx, input }) => svc.dashboard(await scopeOf(ctx.money), input ?? {})),
  workspace: moneyScoped(roleProcedure("billing.workspace")).input(z.object({ jobId: JOB }))
    .query(async ({ ctx, input }) => svc.workspaceGet(await scopeOf(ctx.money), input.jobId)),
  readiness: moneyScoped(roleProcedure("billing.readiness")).input(z.object({ jobId: JOB }))
    .query(async ({ ctx, input }) => svc.evaluateBillingReadiness(await scopeOf(ctx.money), input.jobId)),
  readinessRefresh: moneyScoped(roleProcedure("billing.readinessRefresh")).input(z.object({ jobId: JOB }))
    .mutation(async ({ ctx, input }) => svc.readinessRefresh(await scopeOf(ctx.money), actorOf(ctx), input.jobId)),
  prepare: moneyScoped(roleProcedure("billing.prepare")).input(z.object({ jobId: JOB }))
    .mutation(async ({ ctx, input }) => svc.prepareBilling(await scopeOf(ctx.money), actorOf(ctx), input)),
  recalculate: moneyScoped(roleProcedure("billing.recalculate")).input(z.object({ jobId: JOB, reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.recalculateBilling(await scopeOf(ctx.money), actorOf(ctx), input)),
  chargeAddManual: moneyScoped(roleProcedure("billing.chargeAddManual"))
    .input(z.object({ jobId: JOB, description: z.string().trim().min(3).max(300), serviceCode: z.string().max(60).nullable().optional(), quantityMillis: z.number().int().positive().max(1_000_000_000), unit: z.string().min(1).max(20), amountCents: z.number().int().positive().max(1_000_000_000), reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.chargeAddManual(await scopeOf(ctx.money), actorOf(ctx), input)),
  chargeManualDecide: moneyScoped(roleProcedure("billing.chargeManualDecide")).input(z.object({ chargeRef: REF, decision: z.enum(["approve", "refuse"]), note: REASON }))
    .mutation(async ({ ctx, input }) => svc.chargeManualDecide(await scopeOf(ctx.money), actorOf(ctx), input)),
  chargeOverrideRequest: moneyScoped(roleProcedure("billing.chargeOverrideRequest")).input(z.object({ chargeRef: REF, amountCents: z.number().int().nonnegative().max(1_000_000_000), quantityMillis: z.number().int().positive().max(1_000_000_000).nullable().optional(), reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.chargeOverrideRequest(await scopeOf(ctx.money), actorOf(ctx), input)),
  chargeOverrideDecide: moneyScoped(roleProcedure("billing.chargeOverrideDecide")).input(z.object({ chargeRef: REF, decision: z.enum(["approve", "refuse"]), note: REASON }))
    .mutation(async ({ ctx, input }) => svc.chargeOverrideDecide(await scopeOf(ctx.money), actorOf(ctx), input)),
  reviewSubmit: moneyScoped(roleProcedure("billing.reviewSubmit")).input(z.object({ jobId: JOB, note: z.string().max(600).nullable().optional() }))
    .mutation(async ({ ctx, input }) => svc.reviewSubmit(await scopeOf(ctx.money), actorOf(ctx), input)),
  reviewDecide: moneyScoped(roleProcedure("billing.reviewDecide")).input(z.object({ jobId: JOB, decision: z.enum(["approve", "return"]), note: REASON }))
    .mutation(async ({ ctx, input }) => svc.reviewDecide(await scopeOf(ctx.money), actorOf(ctx), input)),
  holdSet: moneyScoped(roleProcedure("billing.holdSet")).input(z.object({ jobId: JOB, active: z.boolean(), reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.holdSet(await scopeOf(ctx.money), actorOf(ctx), input)),

  /* ---------------- invoices ---------------- */
  invoiceDraft: moneyScoped(roleProcedure("billing.invoiceDraft"))
    .input(z.object({ jobIds: z.array(JOB).min(1).max(50), slices: z.array(z.object({ chargeRef: REF, quantityMillis: z.number().int().positive() })).max(500).optional(), jurisdiction: z.string().min(2).max(20).optional(), purchaseOrder: z.string().max(80).nullable().optional(), afeNumber: z.string().max(80).nullable().optional(), note: z.string().max(400).nullable().optional() }))
    .mutation(async ({ ctx, input }) => svc.invoiceDraft(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceRecalculate: moneyScoped(roleProcedure("billing.invoiceRecalculate")).input(z.object({ invoiceNumber: NUMBER, jurisdiction: z.string().min(2).max(20).optional() }))
    .mutation(async ({ ctx, input }) => svc.invoiceRecalculate(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceSubmit: moneyScoped(roleProcedure("billing.invoiceSubmit")).input(z.object({ invoiceNumber: NUMBER, expectedRowVersion: z.number().int().nonnegative().optional() }))
    .mutation(async ({ ctx, input }) => svc.invoiceSubmit(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceReturn: moneyScoped(roleProcedure("billing.invoiceReturn")).input(z.object({ invoiceNumber: NUMBER, reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.invoiceReturn(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceApprove: moneyScoped(roleProcedure("billing.invoiceApprove")).input(z.object({ invoiceNumber: NUMBER, expectedRowVersion: z.number().int().nonnegative().optional() }))
    .mutation(async ({ ctx, input }) => svc.invoiceApprove(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceIssue: moneyScoped(roleProcedure("billing.invoiceIssue")).input(z.object({ invoiceNumber: NUMBER }))
    .mutation(async ({ ctx, input }) => svc.invoiceIssue(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceVoid: moneyScoped(roleProcedure("billing.invoiceVoid")).input(z.object({ invoiceNumber: NUMBER, reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.invoiceVoid(await scopeOf(ctx.money), actorOf(ctx), input)),
  invoiceGet: moneyScoped(roleProcedure("billing.invoiceGet")).input(z.object({ invoiceNumber: NUMBER }))
    .query(async ({ ctx, input }) => svc.invoiceGet(await scopeOf(ctx.money), input.invoiceNumber, true)),
  invoicesList: moneyScoped(roleProcedure("billing.invoicesList")).input(z.object({ status: z.array(z.enum(["draft", "in_review", "approved", "sent", "viewed", "disputed", "partially_paid", "paid", "void"])).max(9).optional(), accountRef: REF.optional(), q: z.string().max(80).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ ctx, input }) => svc.invoicesList(await scopeOf(ctx.money), input ?? {})),

  /* ---------------- receivables ---------------- */
  receivables: moneyScoped(roleProcedure("billing.receivables")).input(z.object({ accountRef: REF.optional(), asOf: z.coerce.date().optional() }).optional())
    .query(async ({ ctx, input }) => svc.receivables(await scopeOf(ctx.money), input ?? {})),
  customerBalance: moneyScoped(roleProcedure("billing.customerBalance")).input(z.object({ accountRef: REF }))
    .query(async ({ ctx, input }) => svc.customerBalance(await scopeOf(ctx.money), input.accountRef)),
  unappliedPayments: moneyScoped(roleProcedure("billing.unappliedPayments")).input(z.object({ accountRef: REF.optional() }).optional())
    .query(async ({ ctx, input }) => svc.unappliedPayments(await scopeOf(ctx.money), input?.accountRef)),
  paymentRecord: moneyScoped(roleProcedure("billing.paymentRecord"))
    .input(z.object({ financialEntityId: z.number().int().positive(), accountRef: REF, receivedAt: z.coerce.date(), amountCents: z.number().int().positive().max(10_000_000_000), currency: z.string().length(3).optional(), method: z.enum(["eft", "cheque", "card", "cash", "other", "wire", "import"]), reference: z.string().max(120).nullable().optional(), payerName: z.string().max(220).nullable().optional(), notes: z.string().max(600).nullable().optional(), source: z.enum(["manual", "import", "bank_match", "portal"]).optional(), idempotencyKey: z.string().min(8).max(120).nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => svc.paymentRecord(await scopeOf(ctx.money), actorOf(ctx), input)),
  paymentAllocate: moneyScoped(roleProcedure("billing.paymentAllocate")).input(z.object({ paymentRef: REF, invoiceNumber: NUMBER, amountCents: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => svc.paymentAllocate(await scopeOf(ctx.money), actorOf(ctx), input)),
  allocationReverse: moneyScoped(roleProcedure("billing.allocationReverse")).input(z.object({ allocationRef: REF, reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.allocationReverse(await scopeOf(ctx.money), actorOf(ctx), input)),
  paymentReverse: moneyScoped(roleProcedure("billing.paymentReverse")).input(z.object({ paymentRef: REF, reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.paymentReverse(await scopeOf(ctx.money), actorOf(ctx), input)),
  creditCreate: moneyScoped(roleProcedure("billing.creditCreate")).input(z.object({ invoiceNumber: NUMBER, amountCents: z.number().int().positive(), reason: z.string().trim().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => svc.creditCreate(await scopeOf(ctx.money), actorOf(ctx), input)),
  creditDecide: moneyScoped(roleProcedure("billing.creditDecide")).input(z.object({ creditRef: REF, decision: z.enum(["approved", "refused"]), note: REASON }))
    .mutation(async ({ ctx, input }) => {
      const s = await scopeOf(ctx.money);
      const subject = await svc.creditDecisionSubject(s, ctx.user.id, input.creditRef);
      // P7.4 — the approval ladder (0133) decides who, and how many people, this amount needs; the actor is the session's.
      const ledger = await ledgerDecide(s.db, { actorUserId: ctx.user.id, category: "credit", subjectType: "customer_credit", subjectRef: subject.subjectRef, amountCents: subject.amountCents, preparedByUserId: subject.preparedByUserId, decision: input.decision, note: input.note });
      return svc.creditDecide(s, actorOf(ctx), input, ledger);
    }),
  adjustmentRequest: moneyScoped(roleProcedure("billing.adjustmentRequest")).input(z.object({ invoiceNumber: NUMBER, amountCents: CENTS.refine(v => v !== 0, "non-zero"), reasonCode: z.enum(["late_fee", "rounding", "fx", "correction", "other"]), reason: REASON }))
    .mutation(async ({ ctx, input }) => svc.adjustmentRequest(await scopeOf(ctx.money), actorOf(ctx), input)),
  adjustmentDecide: moneyScoped(roleProcedure("billing.adjustmentDecide")).input(z.object({ adjustmentRef: REF, decision: z.enum(["approved", "refused"]), note: REASON }))
    .mutation(async ({ ctx, input }) => svc.adjustmentDecide(await scopeOf(ctx.money), actorOf(ctx), input)),
  disputeOpen: moneyScoped(roleProcedure("billing.disputeOpen")).input(z.object({ invoiceNumber: NUMBER, lineNo: z.number().int().positive().nullable().optional(), amountCents: z.number().int().positive().nullable().optional(), reason: REASON, notes: z.string().max(4000).nullable().optional(), documentRefs: z.array(z.string().max(80)).max(20).optional(), raisedByName: z.string().max(180).nullable().optional() }))
    .mutation(async ({ ctx, input }) => svc.disputeOpen(await scopeOf(ctx.money), actorOf(ctx), input)),
  disputeResolve: moneyScoped(roleProcedure("billing.disputeResolve")).input(z.object({ caseNumber: REF, outcome: z.enum(["upheld", "credited", "partial", "withdrawn"]), creditAmountCents: z.number().int().positive().nullable().optional(), narrative: z.string().trim().min(10).max(2000) }))
    .mutation(async ({ ctx, input }) => svc.disputeResolve(await scopeOf(ctx.money), actorOf(ctx), input)),
  overdueSweep: moneyScoped(roleProcedure("billing.overdueSweep")).input(z.object({}).optional())
    .mutation(async ({ ctx }) => svc.overdueSweep(await scopeOf(ctx.money), actorOf(ctx))),

  /* ---------------- accounting integration boundary ---------------- */
  exportQueue: moneyScoped(roleProcedure("billing.exportQueue")).input(z.object({ status: z.enum(["pending", "exported", "failed", "conflict", "superseded"]).optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ ctx, input }) => svc.exportQueue(await scopeOf(ctx.money), input ?? {})),
  exportMark: moneyScoped(roleProcedure("billing.exportMark")).input(z.object({ syncRef: REF, outcome: z.enum(["exported", "failed", "conflict", "pending"]), externalId: z.string().max(120).nullable().optional(), externalSystem: z.string().max(40).nullable().optional(), error: z.string().max(600).nullable().optional() }))
    .mutation(async ({ ctx, input }) => svc.exportMark(await scopeOf(ctx.money), actorOf(ctx), input)),
});
