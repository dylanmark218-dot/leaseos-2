/**
 * Payroll P4 — employee expenses and payroll reimbursements (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §27).
 *
 * A view and a workflow over `expenseRecords` + `evidenceRecords`: no second expense table, no third wallet. Own
 * procedures resolve the claimant from the session and take no user, employee or profile id; their inputs are strict.
 * Every operational id is proved through the canonical helper (unit: `requireCallerUnits`; job: `requireJob`; receipt:
 * `requireEvidence`, and it must be the claimant's own capture); a foreign one is "not found" and is recorded.
 *
 * Approval is a financial decision for the payroll office (payroll_admin, hr, controller) — never D10's crew
 * supervisor — and never the claimant's or the submitter's. Approval makes a reimbursement owed; `runCollect` schedules
 * it onto one pay run; neither pays it. Payment is P5's.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { ownsEntity } from "./_core/entityScope";
import { getDb } from "./db";
import { requireEvidence, requireJob } from "./financeScope";
import { requireCallerUnits } from "./unitScope";
import type { Db } from "./_core/dbTypes";
import { REIMBURSEMENT_STATES, employeeReimbursementEligible, isPaid, serverClaimState, type ReimbursementState } from "./_core/payrollExpense";
import { resolveOwnPayrollProfile } from "./payrollService";
import { isOwnerOperator, raiseException, type ProfileRow } from "./payrollTimeService";
import { evidenceRecords } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import * as x from "./payrollExpenseService";

const notFound = (m: string) => new TRPCError({ code: "NOT_FOUND", message: m });
const badRequest = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const REF = z.string().min(3).max(64);
const REASON = z.string().min(5).max(400);
const CENTS = z.number().int().positive().max(100_000_000);
type Money = { tenantId: string; entityIds: readonly number[] };

async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db as unknown as Db;
}

/** The caller's own payroll profile in this organization's books — the claimant, never from input. */
async function claimant(userId: number, money: Money): Promise<ProfileRow> {
  const p = await resolveOwnPayrollProfile(userId);
  if (!p || !ownsEntity(money as never, p.financialEntityId)) throw notFound("No payroll profile is linked to your account in this organization");
  const ok = employeeReimbursementEligible(p.workerClassification, await isOwnerOperator(p));
  if (!ok.allowed) throw badRequest(ok.reason);
  return p;
}

/** A refused foreign id is recorded on the claimant's book, then the refusal stands. */
async function recordForeign(profile: ProfileRow, actorUserId: number, kind: string, id: number | null | undefined, e: unknown): Promise<never> {
  if (id != null && e instanceof TRPCError && e.code === "NOT_FOUND") {
    await raiseException(await dbOrThrow(), { kind: "cross_tenant_reference", financialEntityId: profile.financialEntityId, employeePayrollProfileId: profile.id, subjectType: "expense_submission", subjectRef: `profile:${profile.id}`, discriminator: `${kind}:${id}`, detail: `An expense claim named ${kind} ${id}, which is not this organization's or not the claimant's`, raisedByUserId: actorUserId });
  }
  throw e;
}

/** A receipt the caller's organization can open AND that the claimant captured: a coworker's receipt is not theirs to claim. */
async function ownReceipt(money: Money, evidenceRecordId: number, userId: number) {
  await requireEvidence(money as never, evidenceRecordId);
  const db = await dbOrThrow();
  const e = (await db.select({ capturedBy: evidenceRecords.capturedBy }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceRecordId)).limit(1))[0];
  if (!e || e.capturedBy !== userId) throw notFound("Evidence record not found");
}

async function ownClaim(expenseRef: string, profileId: number) {
  const e = await x.loadExpenseByRef(expenseRef);
  if (!e || e.employeePayrollProfileId !== profileId) throw notFound(`Expense ${expenseRef} not found`);
  return e;
}

async function claimInBooks(expenseRef: string, money: Money) {
  const e = await x.loadExpenseByRef(expenseRef);
  if (!e || e.employeePayrollProfileId == null || !ownsEntity(money as never, e.financialEntityId)) throw notFound(`Expense ${expenseRef} not found`);
  return e;
}

function unwrap(r: x.SubmitClaimOutcome) {
  if (r.outcome === "refused") throw new TRPCError({ code: r.code, message: r.message });
  if (r.outcome === "replayed") return { expenseRef: r.expenseRef, reimbursementState: r.reimbursementState, replayed: true as const, exceptions: [] as string[], duplicates: [] as unknown[] };
  return { expenseRef: r.expenseRef, reimbursementState: r.reimbursementState, replayed: false as const, exceptions: r.exceptions, duplicates: r.duplicates };
}

function decided(r: x.DecisionOutcome) {
  if (r.outcome === "refused") throw new TRPCError({ code: r.code, message: r.message });
  return { expenseRef: r.expenseRef, reimbursementState: r.reimbursementState, paid: isPaid(r.reimbursementState) };
}

/** A claim as its claimant and the payroll office see it. `paid` is true only once payroll has paid it (never in P4). */
function claimView(e: x.ExpenseRow) {
  return {
    expenseRef: e.expenseRef, status: e.status, reimbursementState: e.reimbursementState, paid: isPaid(e.reimbursementState as ReimbursementState),
    vendorName: e.vendorName, transactionDate: e.transactionDate, currency: e.currency, totalCents: e.totalCents, reimbursementCents: e.reimbursementCents,
    paidPersonally: e.paidPersonally, categoryId: e.categoryId, jobId: e.jobId, unitId: e.unitId, evidenceRecordId: e.evidenceRecordId, claimNotes: e.claimNotes,
    clientCaptureRef: e.clientCaptureRef, capturedAt: e.capturedAt, submittedAt: e.submittedAt,
    approvedByUserId: e.reimbursementApprovedByUserId, approvedAt: e.reimbursementApprovedAt,
    rejectedAt: e.reimbursementRejectedAt, rejectedReason: e.reimbursementRejectedReason, returnedAt: e.reimbursementReturnedAt, returnReason: e.reimbursementReturnReason,
    withdrawnAt: e.withdrawnAt, withdrawReason: e.withdrawReason, reimbursementPayRunId: e.reimbursementPayRunId, reimbursementLineId: e.reimbursementLineId,
    supersedesExpenseId: e.supersedesExpenseId,
  };
}

const FACTS = z.object({
  vendorName: z.string().min(1).max(220),
  transactionDate: z.coerce.date(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  totalCents: CENTS,
  subtotalCents: z.number().int().nonnegative().optional(),
  salesTaxCents: z.number().int().nonnegative().optional(),
  reimbursementCents: CENTS.optional(),
  categoryId: z.number().int().optional(),
  jobId: z.number().int().optional(),
  unitId: z.number().int().optional(),
  evidenceRecordId: z.number().int().optional(),
  notes: z.string().max(1000).optional(),
  paidPersonally: z.boolean().default(true),
});

export const payrollExpenseRouter = router({
  /* ---------------- The employee's own claims ---------------- */

  myExpensesList: moneyScoped(roleProcedure("payrollExpense.myExpensesList")).query(async ({ ctx }) => {
    const me = await claimant(ctx.user.id, ctx.money);
    return (await x.listClaimsForProfile(me.id)).map(claimView);
  }),

  myExpenseGet: moneyScoped(roleProcedure("payrollExpense.myExpenseGet"))
    .input(z.object({ expenseRef: REF }).strict())
    .query(async ({ ctx, input }) => {
      const me = await claimant(ctx.user.id, ctx.money);
      const e = await ownClaim(input.expenseRef, me.id);
      return { ...claimView(e), standing: (await x.scheduleFacts(e)).note };
    }),

  /**
   * Record one's own expense. Paid personally (the default), it becomes a reimbursement claim pending approval; paid by
   * the company, it is an expense and never a claim. Offline captures carry `clientCaptureRef` (a replay returns the
   * first claim), `capturedAt` and `deviceRef` as the device's claims, and may ask only to be a draft or submitted.
   */
  myExpenseSubmit: moneyScoped(roleProcedure("payrollExpense.myExpenseSubmit"))
    .input(FACTS.extend({
      clientCaptureRef: z.string().min(6).max(80).optional(),
      capturedAt: z.coerce.date().optional(),
      deviceRef: z.string().max(120).optional(),
      captureState: z.string().max(20).optional(),
      supersedesExpenseRef: REF.optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const state = serverClaimState(input.captureState);
      if (!state.ok) throw badRequest(state.reason);
      const me = await claimant(ctx.user.id, ctx.money);
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId }).catch(e => recordForeign(me, ctx.user.id, "unit", input.unitId, e));   // the canonical unit scope
      await requireJob(ctx.money as never, input.jobId).catch(e => recordForeign(me, ctx.user.id, "job", input.jobId, e));
      if (input.evidenceRecordId != null) await ownReceipt(ctx.money, input.evidenceRecordId, ctx.user.id).catch(e => recordForeign(me, ctx.user.id, "evidence", input.evidenceRecordId, e));
      if (input.categoryId != null && !(await x.categoryActive(input.categoryId))) throw badRequest(`Expense category ${input.categoryId} is not active`);
      if (input.subtotalCents != null && input.salesTaxCents != null && input.subtotalCents + input.salesTaxCents !== input.totalCents) throw badRequest("Subtotal and tax do not add up to the total");
      let supersedes: { id: number } | null = null;
      if (input.supersedesExpenseRef) {
        const old = await ownClaim(input.supersedesExpenseRef, me.id);
        if (!(old.reimbursementState === "rejected" || old.reimbursementState === "withdrawn")) throw precondition("Only a rejected or withdrawn claim is corrected by a new submission");
        supersedes = { id: old.id };
      }
      return unwrap(await x.submitClaim({
        profile: me, actorUserId: ctx.user.id, submit: state.submit,
        facts: { vendorName: input.vendorName, transactionDate: input.transactionDate, currency: input.currency, totalCents: input.totalCents, subtotalCents: input.subtotalCents ?? null, salesTaxCents: input.salesTaxCents ?? null, reimbursementCents: input.reimbursementCents ?? null, categoryId: input.categoryId ?? null, jobId: input.jobId ?? null, unitId: input.unitId ?? null, evidenceRecordId: input.evidenceRecordId ?? null, notes: input.notes ?? null, paidPersonally: input.paidPersonally },
        clientCaptureRef: input.clientCaptureRef ?? null, capturedAt: input.capturedAt ?? null, deviceRef: input.deviceRef ?? null, promote: null, supersedes,
      }));
    }),

  /**
   * Make one's own draft (a saved draft, or the draft an assistant made from a photographed receipt) into a claim.
   * The facts are the draft's, confirmed by the employee, who also attaches the receipt and says what they paid. The
   * assistant never approves anything and never names a claimant.
   */
  myExpenseClaimDraft: moneyScoped(roleProcedure("payrollExpense.myExpenseClaimDraft"))
    .input(z.object({ expenseRef: REF, evidenceRecordId: z.number().int().optional(), reimbursementCents: CENTS.optional(), notes: z.string().max(1000).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await claimant(ctx.user.id, ctx.money);
      const d = await x.loadExpenseByRef(input.expenseRef);
      if (!d || !ownsEntity(ctx.money as never, d.financialEntityId) || (d.paidByUserId !== ctx.user.id && d.createdByUserId !== ctx.user.id)) throw notFound(`Expense ${input.expenseRef} not found`);
      if (d.financialEntityId !== me.financialEntityId) throw badRequest("The draft belongs to a different book than your payroll profile");
      if (d.status !== "draft" || d.reimbursementState !== "not_applicable") throw precondition(`The expense is ${d.status}; only one's own open draft becomes a claim`);
      const evidenceRecordId = input.evidenceRecordId ?? d.evidenceRecordId;
      if (evidenceRecordId != null) await ownReceipt(ctx.money, evidenceRecordId, ctx.user.id).catch(e => recordForeign(me, ctx.user.id, "evidence", evidenceRecordId, e));
      if (d.totalCents == null) throw precondition("The draft has no integer total");
      return unwrap(await x.submitClaim({
        profile: me, actorUserId: ctx.user.id, submit: true,
        facts: { vendorName: d.vendorName, transactionDate: d.transactionDate, currency: d.currency, totalCents: d.totalCents, subtotalCents: d.subtotalCents, salesTaxCents: d.salesTaxAmountCents, reimbursementCents: input.reimbursementCents ?? null, categoryId: d.categoryId, jobId: d.jobId, unitId: d.unitId, evidenceRecordId, notes: input.notes ?? d.claimNotes, paidPersonally: true },
        clientCaptureRef: null, capturedAt: null, deviceRef: null, promote: { id: d.id }, supersedes: null,
      }));
    }),

  /** Take back one's own draft or pending claim, with a reason. It stays visible; an approved or scheduled one cannot be taken back. */
  myExpenseWithdraw: moneyScoped(roleProcedure("payrollExpense.myExpenseWithdraw"))
    .input(z.object({ expenseRef: REF, reason: REASON }).strict())
    .mutation(async ({ ctx, input }) => {
      const me = await claimant(ctx.user.id, ctx.money);
      const e = await ownClaim(input.expenseRef, me.id);
      if (!(await x.withdrawClaim({ id: e.id, actorUserId: ctx.user.id, reason: input.reason }))) throw precondition(`The reimbursement is ${e.reimbursementState}; only a draft or pending claim is withdrawn (an approved or scheduled one is corrected by the payroll office)`);
      return { expenseRef: e.expenseRef, reimbursementState: (e.status === "draft" ? "not_applicable" : "withdrawn") as ReimbursementState };
    }),

  /* ---------------- The payroll office ---------------- */

  pendingList: moneyScoped(roleProcedure("payrollExpense.pendingList"))
    .input(z.object({ state: z.enum(REIMBURSEMENT_STATES).default("pending_approval") }).strict().optional())
    .query(async ({ ctx, input }) => {
      const rows = await x.listClaimsInBooks(ctx.money.entityIds, [input?.state ?? "pending_approval"]);
      const out = [];
      for (const e of rows) {
        const p = await x.loadProfile(e.employeePayrollProfileId!);
        out.push({ ...claimView(e), claimant: { employeeNumber: p?.employeeNumber ?? null, userId: p?.userId ?? null }, openExceptions: (await x.openExpenseExceptions(await dbOrThrow(), e.expenseRef)).map(o => ({ exceptionRef: o.exceptionRef, kind: o.kind, severity: o.severity })) });
      }
      return out;
    }),

  expenseGet: moneyScoped(roleProcedure("payrollExpense.expenseGet"))
    .input(z.object({ expenseRef: REF }).strict())
    .query(async ({ ctx, input }) => {
      const e = await claimInBooks(input.expenseRef, ctx.money);
      const p = await x.loadProfile(e.employeePayrollProfileId!);
      const facts = await x.scheduleFacts(e);
      return { ...claimView(e), claimant: { employeeNumber: p?.employeeNumber ?? null, userId: p?.userId ?? null }, standing: facts.note, claimantScheduleRef: facts.claimantScheduleRef, payrollCurrency: facts.payrollCurrency, openExceptions: (await x.openExpenseExceptions(await dbOrThrow(), e.expenseRef)).map(o => ({ exceptionRef: o.exceptionRef, kind: o.kind, severity: o.severity, detail: o.detail })) };
    }),

  /** The claim's possible duplicates: the same receipt, an identical image, the same device capture, a similar claim, fuel. */
  duplicates: moneyScoped(roleProcedure("payrollExpense.duplicates"))
    .input(z.object({ expenseRef: REF }).strict())
    .query(async ({ ctx, input }) => x.duplicatesFor(await claimInBooks(input.expenseRef, ctx.money))),

  /** pending → approved: owed to the employee, not paid. Never by the claimant or the submitter; never past a changed receipt. */
  approve: moneyScoped(roleProcedure("payrollExpense.approve"))
    .input(z.object({ expenseRef: REF }).strict())
    .mutation(async ({ ctx, input }) => decided(await x.approveClaim({ id: (await claimInBooks(input.expenseRef, ctx.money)).id, actorUserId: ctx.user.id }))),

  reject: moneyScoped(roleProcedure("payrollExpense.reject"))
    .input(z.object({ expenseRef: REF, reason: REASON }).strict())
    .mutation(async ({ ctx, input }) => decided(await x.rejectClaim({ id: (await claimInBooks(input.expenseRef, ctx.money)).id, actorUserId: ctx.user.id, reason: input.reason }))),

  /** approved (not yet scheduled) → pending, with a reason: the controlled path back for an approved claim that needs correcting. */
  returnForCorrection: moneyScoped(roleProcedure("payrollExpense.returnForCorrection"))
    .input(z.object({ expenseRef: REF, reason: REASON }).strict())
    .mutation(async ({ ctx, input }) => decided(await x.returnClaim({ id: (await claimInBooks(input.expenseRef, ctx.money)).id, actorUserId: ctx.user.id, reason: input.reason }))),
});
