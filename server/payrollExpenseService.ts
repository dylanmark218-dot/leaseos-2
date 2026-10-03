/**
 * Payroll P4 — data access for employee expense claims and payroll reimbursements, over the existing `expenseRecords`
 * domain (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §27). The rules are in `_core/payrollExpense.ts`.
 *
 * A claim is an `expenseRecords` row with a claimant and a `reimbursementState`; there is no second expense table and
 * no second wallet. Every write that decides a claim locks the expense row first; submissions lock the claimant's
 * payroll profile so a device replay and a duplicate receipt are decided on a consistent view; collection locks the
 * candidate rows so two runs cannot both take one expense, and the unique `payRunLines.expenseRecordId` stands behind it.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  compensationAgreements,
  compensationAgreementVersions,
  employeePayrollProfiles,
  evidenceRecords,
  evidenceVersions,
  expenseCategories,
  expenseRecords,
  fuelTransactions,
  payGroups,
  payRunLines,
  payrollExceptions,
  paySchedules,
} from "../drizzle/schema";
import type { Db, DbOrTx, Tx } from "./_core/dbTypes";
import { dateText } from "./payrollCompensationService";
import { versionInForce } from "./_core/payrollCompensation";
import { EXPENSE_APPROVAL_GATE_KINDS, localDate } from "./_core/payrollTime";
import {
  DEFAULT_PAYROLL_CURRENCY,
  currencyCompatible,
  duplicateSignals,
  evidenceFingerprint,
  isLiveClaim,
  receiptRequired,
  reimbursableAmount,
  reimbursementApprover,
  selectReimbursements,
  stateContradiction,
  type DuplicateSignal,
  type EvidenceFacts,
  type ReimbursementState,
} from "./_core/payrollExpense";
import { raiseException, scheduleChainFor, type ProfileRow } from "./payrollTimeService";
import type { DateText } from "./_core/payrollSchedule";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db as unknown as Db;
}
export type ExpenseRow = typeof expenseRecords.$inferSelect;
const SUBJECT = "expense";
const isDuplicate = (e: unknown): boolean => {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    const x = c as { code?: unknown; errno?: unknown };
    if (x.code === "ER_DUP_ENTRY" || x.errno === 1062) return true;
  }
  return false;
};

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function loadExpenseByRef(expenseRef: string) {
  const db = await dbOrThrow();
  return (await db.select().from(expenseRecords).where(eq(expenseRecords.expenseRef, expenseRef)).limit(1))[0] ?? null;
}

export async function listClaimsForProfile(profileId: number) {
  const db = await dbOrThrow();
  return db.select().from(expenseRecords).where(eq(expenseRecords.employeePayrollProfileId, profileId)).orderBy(desc(expenseRecords.id)).limit(500);
}

export async function listClaimsInBooks(entityIds: readonly number[], states?: readonly ReimbursementState[]) {
  if (!entityIds.length) return [];
  const db = await dbOrThrow();
  const where = [inArray(expenseRecords.financialEntityId, [...entityIds]), sql`${expenseRecords.employeePayrollProfileId} IS NOT NULL`];
  if (states?.length) where.push(inArray(expenseRecords.reimbursementState, [...states]));
  return db.select().from(expenseRecords).where(and(...where)).orderBy(desc(expenseRecords.id)).limit(500);
}

export async function openExpenseExceptions(h: DbOrTx, expenseRef: string) {
  return h.select().from(payrollExceptions).where(and(eq(payrollExceptions.subjectType, SUBJECT), eq(payrollExceptions.subjectRef, expenseRef), eq(payrollExceptions.state, "open")));
}

/** The receipt's current facts: its version, seal and storage, and the content hash of that version. */
export async function evidenceFacts(h: DbOrTx, evidenceId: number, lock = false): Promise<EvidenceFacts | null> {
  const q = h.select({ id: evidenceRecords.id, currentVersion: evidenceRecords.currentVersion, sealState: evidenceRecords.sealState, storageKey: evidenceRecords.storageKey }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId)).limit(1);
  const e = (await (lock ? q.for("update") : q))[0];
  if (!e) return null;
  const v = (await h.select({ contentHash: evidenceVersions.contentHash }).from(evidenceVersions)
    .where(and(eq(evidenceVersions.evidenceRecordId, evidenceId), eq(evidenceVersions.version, e.currentVersion))).limit(1))[0];
  return { ...e, contentHash: v?.contentHash ?? null };
}

/**
 * The currency payroll pays the claimant in on a date: the currency of their compensation version in force, else the
 * repository default. Never converted; a claim in another currency is held.
 */
export async function payrollCurrencyFor(h: DbOrTx, profileId: number, onDate: DateText): Promise<string> {
  const agreements = (await h.select().from(compensationAgreements).where(eq(compensationAgreements.employeePayrollProfileId, profileId)))
    .map(a => ({ ...a, startsOn: dateText(a.startsOn)!, endsOn: dateText(a.endsOn) }))
    .filter(a => a.startsOn <= onDate && (a.endsOn == null || onDate < a.endsOn));
  if (agreements.length !== 1) return DEFAULT_PAYROLL_CURRENCY;
  const versions = (await h.select().from(compensationAgreementVersions).where(eq(compensationAgreementVersions.agreementId, agreements[0]!.id)))
    .map(v => ({ ...v, effectiveFrom: dateText(v.effectiveFrom)!, effectiveUntil: dateText(v.effectiveUntil) }));
  const r = versionInForce(versions.map(v => ({ versionRef: v.versionRef, status: v.status, effectiveFrom: v.effectiveFrom, effectiveUntil: v.effectiveUntil })), onDate);
  return r.kind === "version" ? versions.find(v => v.versionRef === r.version.versionRef)!.currency : DEFAULT_PAYROLL_CURRENCY;
}

export async function categoryActive(categoryId: number): Promise<boolean> {
  const db = await dbOrThrow();
  const c = (await db.select({ active: expenseCategories.active }).from(expenseCategories).where(eq(expenseCategories.id, categoryId)).limit(1))[0];
  return !!c?.active;
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

export type ClaimFacts = {
  vendorName: string | null;
  transactionDate: Date;
  currency: string;
  totalCents: number;
  subtotalCents: number | null;
  salesTaxCents: number | null;
  reimbursementCents: number | null;
  categoryId: number | null;
  jobId: number | null;
  unitId: number | null;
  evidenceRecordId: number | null;
  notes: string | null;
  paidPersonally: boolean;
};

export type SubmitClaimArgs = {
  profile: ProfileRow;
  actorUserId: number;
  submit: boolean;
  facts: ClaimFacts;
  clientCaptureRef: string | null;
  capturedAt: Date | null;
  deviceRef: string | null;
  /** Promote this existing own draft (an assistant-created receipt, a saved draft) instead of inserting. */
  promote: { id: number } | null;
  /** A corrected resubmission of one's own rejected or withdrawn claim; the old row is kept as it is. */
  supersedes: { id: number } | null;
};

export type SubmitClaimOutcome =
  | { outcome: "created"; expenseRef: string; reimbursementState: ReimbursementState; exceptions: string[]; duplicates: DuplicateSignal[] }
  | { outcome: "replayed"; expenseRef: string; reimbursementState: ReimbursementState }
  | { outcome: "refused"; code: "CONFLICT" | "PRECONDITION_FAILED" | "BAD_REQUEST"; message: string };

/**
 * Record (or promote) an expense and, when it was paid personally, open its reimbursement claim. One transaction:
 * the claimant's profile is locked, a capture replay returns the first claim, the receipt's facts are fingerprinted,
 * duplicates are classified against the book's claims and fuel receipts, and the claim and its review exceptions are
 * written. A company-paid expense is recorded as an expense and never becomes a claim.
 */
export async function submitClaim(a: SubmitClaimArgs): Promise<SubmitClaimOutcome> {
  const db = await dbOrThrow();
  const f = a.facts;
  const amount = f.paidPersonally ? reimbursableAmount({ totalCents: f.totalCents, claimedCents: f.reimbursementCents }) : null;
  if (amount && !amount.ok) return { outcome: "refused", code: "BAD_REQUEST", message: amount.reason };
  const claiming = a.submit && f.paidPersonally;
  try {
    return await db.transaction(async (tx: Tx): Promise<SubmitClaimOutcome> => {
      await tx.select({ id: employeePayrollProfiles.id }).from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, a.profile.id)).for("update").limit(1);
      if (a.clientCaptureRef && !a.promote) {
        const prior = (await tx.select({ expenseRef: expenseRecords.expenseRef, reimbursementState: expenseRecords.reimbursementState }).from(expenseRecords)
          .where(and(eq(expenseRecords.employeePayrollProfileId, a.profile.id), eq(expenseRecords.clientCaptureRef, a.clientCaptureRef))).limit(1))[0];
        if (prior) return { outcome: "replayed", expenseRef: prior.expenseRef, reimbursementState: prior.reimbursementState };
      }
      const ev = f.evidenceRecordId != null ? await evidenceFacts(tx, f.evidenceRecordId) : null;
      if (f.evidenceRecordId != null && !ev) return { outcome: "refused", code: "PRECONDITION_FAILED", message: "The receipt is gone" };
      const state: ReimbursementState = claiming ? "pending_approval" : "not_applicable";
      // Duplicates: the book's claims (live or not, for capture replays) and fuel receipts on the same evidence.
      let duplicates: DuplicateSignal[] = [];
      if (claiming) {
        const others = await tx.select().from(expenseRecords)
          .where(and(eq(expenseRecords.financialEntityId, a.profile.financialEntityId), sql`${expenseRecords.employeePayrollProfileId} IS NOT NULL`)).limit(2000);
        // Fuel on the same receipt, and fuel this person paid for personally (fuel keeps its own reimbursement flag).
        const fuel = await tx.select({ id: fuelTransactions.id, expenseRecordId: fuelTransactions.expenseRecordId, evidenceRecordId: fuelTransactions.evidenceRecordId, totalCents: fuelTransactions.totalCents, occurredAt: fuelTransactions.occurredAt }).from(fuelTransactions)
          .where(and(eq(fuelTransactions.financialEntityId, a.profile.financialEntityId), or(
            f.evidenceRecordId != null ? eq(fuelTransactions.evidenceRecordId, f.evidenceRecordId) : sql`false`,
            and(eq(fuelTransactions.fueledByUserId, a.actorUserId), eq(fuelTransactions.payerType, "worker_personal")),
          ))).limit(200);
        duplicates = duplicateSignals({
          claim: { employeePayrollProfileId: a.profile.id, clientCaptureRef: a.clientCaptureRef, evidenceRecordId: f.evidenceRecordId, contentHash: ev?.contentHash ?? null, vendorName: f.vendorName, totalCents: f.totalCents, transactionDate: f.transactionDate, expenseRef: a.promote ? undefined : undefined },
          others: others.filter(o => o.id !== a.promote?.id && o.id !== a.supersedes?.id).map(o => ({
            expenseRef: o.expenseRef, employeePayrollProfileId: o.employeePayrollProfileId, clientCaptureRef: o.clientCaptureRef, evidenceRecordId: o.evidenceRecordId,
            contentHash: o.evidenceContentHash, vendorName: o.vendorName, totalCents: o.totalCents, transactionDate: o.transactionDate, live: isLiveClaim(o.reimbursementState),
          })),
          fuelReceipts: fuel.filter(x => x.expenseRecordId == null || x.expenseRecordId !== a.promote?.id).map(x => ({ ref: `fuelTransactions:${x.id}`, evidenceRecordId: x.evidenceRecordId, contentHash: null, totalCents: x.totalCents, occurredAt: x.occurredAt })),
        });
        const same = duplicates.find(d => d.kind === "same_evidence");
        if (same) return { outcome: "refused", code: "CONFLICT", message: `This receipt is already claimed on ${same.otherRef}; one receipt is one claim` };
      }
      const values = {
        financialEntityId: a.profile.financialEntityId,
        vendorName: f.vendorName, transactionDate: f.transactionDate, currency: f.currency.toUpperCase(),
        // The integer cents are authoritative; the legacy doubles are derived from them (the 0062 shadows agree).
        total: f.totalCents / 100, totalCents: f.totalCents,
        subtotal: f.subtotalCents != null ? f.subtotalCents / 100 : null, subtotalCents: f.subtotalCents,
        salesTaxAmount: f.salesTaxCents != null ? f.salesTaxCents / 100 : null, salesTaxAmountCents: f.salesTaxCents,
        categoryId: f.categoryId, categorySource: "human" as const,
        paidByUserId: a.actorUserId, paidPersonally: f.paidPersonally, reimbursementRequired: f.paidPersonally,
        jobId: f.jobId, unitId: f.unitId, evidenceRecordId: f.evidenceRecordId,
        status: a.submit ? ("submitted" as const) : ("draft" as const),
        employeePayrollProfileId: a.profile.id, reimbursementState: state,
        reimbursementCents: f.paidPersonally && amount?.ok ? amount.cents : null,
        claimNotes: f.notes, capturedAt: a.capturedAt, deviceRef: a.deviceRef,
        submittedByUserId: a.submit ? a.actorUserId : null, submittedAt: a.submit ? new Date() : null,
        evidenceFingerprint: ev ? evidenceFingerprint(ev) : null, evidenceContentHash: ev?.contentHash ?? null,
      };
      const bad = stateContradiction({ status: values.status, reimbursementState: state, reimbursementRequired: values.reimbursementRequired, paidPersonally: values.paidPersonally, employeePayrollProfileId: a.profile.id, reimbursementLineId: null });
      if (bad) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `Refused: ${bad}` };
      let expenseRef: string;
      if (a.promote) {
        const cur = (await tx.select().from(expenseRecords).where(eq(expenseRecords.id, a.promote.id)).for("update").limit(1))[0];
        if (!cur || cur.status !== "draft" || cur.reimbursementState !== "not_applicable") return { outcome: "refused", code: "PRECONDITION_FAILED", message: "Only an open draft becomes a claim" };
        await tx.update(expenseRecords).set({ ...values, clientCaptureRef: cur.clientCaptureRef }).where(eq(expenseRecords.id, cur.id));
        expenseRef = cur.expenseRef;
      } else {
        expenseRef = ref("EXP-CLAIM");
        await tx.insert(expenseRecords).values({ ...values, expenseRef, clientCaptureRef: a.clientCaptureRef, createdByUserId: a.actorUserId, supersedesExpenseId: a.supersedes?.id ?? null });
      }
      const exceptions: string[] = [];
      if (claiming) {
        const base = { financialEntityId: a.profile.financialEntityId, employeePayrollProfileId: a.profile.id, subjectType: SUBJECT, subjectRef: expenseRef, raisedByUserId: a.actorUserId };
        if (receiptRequired({ evidenceRecordId: f.evidenceRecordId })) { await raiseException(tx, { ...base, kind: "receipt_required", detail: "An employee reimbursement claim needs a receipt; none is attached" }); exceptions.push("receipt_required"); }
        for (const d of duplicates.filter(x => x.kind !== "same_capture")) {
          await raiseException(tx, { ...base, kind: "duplicate_expense", discriminator: `${d.kind}:${d.otherRef}`, detail: `Possible duplicate of ${d.otherRef}: ${d.detail}. Review it; nothing is rejected automatically` });
          if (!exceptions.includes("duplicate_expense")) exceptions.push("duplicate_expense");
        }
        const payrollCurrency = await payrollCurrencyFor(tx, a.profile.id, localDate(new Date(), "UTC"));
        if (!currencyCompatible(values.currency, payrollCurrency)) {
          await raiseException(tx, { ...base, kind: "reimbursement_currency_mismatch", detail: `Claimed in ${values.currency}; payroll pays this person in ${payrollCurrency}. No conversion is made` });
          exceptions.push("reimbursement_currency_mismatch");
        }
      }
      return { outcome: "created", expenseRef, reimbursementState: state, exceptions, duplicates };
    });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    if (a.clientCaptureRef) {
      const prior = (await db.select({ expenseRef: expenseRecords.expenseRef, reimbursementState: expenseRecords.reimbursementState }).from(expenseRecords)
        .where(and(eq(expenseRecords.employeePayrollProfileId, a.profile.id), eq(expenseRecords.clientCaptureRef, a.clientCaptureRef))).limit(1))[0];
      if (prior) return { outcome: "replayed", expenseRef: prior.expenseRef, reimbursementState: prior.reimbursementState };
    }
    return { outcome: "refused", code: "CONFLICT", message: "This receipt is already on a live claim; one receipt is one claim" };
  }
}

/** Take back one's own draft or pending claim. The row, its receipt link and its history stay; the receipt is released. */
export async function withdrawClaim(args: { id: number; actorUserId: number; reason: string }): Promise<boolean> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx) => {
    const e = (await tx.select().from(expenseRecords).where(eq(expenseRecords.id, args.id)).for("update").limit(1))[0];
    if (!e) return false;
    const draft = e.status === "draft" && e.reimbursementState === "not_applicable";
    if (!(draft || e.reimbursementState === "pending_approval")) return false;
    await tx.update(expenseRecords).set({
      reimbursementState: draft ? "not_applicable" : "withdrawn",
      // The employee retracted the expense: it is not a business expense the books should carry as submitted.
      status: "rejected",
      withdrawnByUserId: args.actorUserId, withdrawnAt: new Date(), withdrawReason: args.reason,
    }).where(eq(expenseRecords.id, e.id));
    await tx.update(payrollExceptions).set({ state: "resolved", resolvedByUserId: args.actorUserId, resolvedAt: new Date(), resolutionNote: "The claim was withdrawn" })
      .where(and(eq(payrollExceptions.subjectType, SUBJECT), eq(payrollExceptions.subjectRef, e.expenseRef), eq(payrollExceptions.state, "open")));
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

export type DecisionOutcome =
  | { outcome: "done"; expenseRef: string; reimbursementState: ReimbursementState }
  | { outcome: "refused"; code: "FORBIDDEN" | "PRECONDITION_FAILED"; message: string };

/**
 * Approve a pending claim: payroll now owes the employee. Not payment. In one transaction: the expense locked; the
 * claimant, the submitter and an unknown submitter refused; the currency checked (never converted); open blocking
 * exceptions that need a person stop it; the receipt re-read under lock and unchanged since submission; the amount
 * re-checked; then approved, and the accounting status brought to approved with it.
 */
export async function approveClaim(args: { id: number; actorUserId: number }): Promise<DecisionOutcome> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx): Promise<DecisionOutcome> => {
    const e = (await tx.select().from(expenseRecords).where(eq(expenseRecords.id, args.id)).for("update").limit(1))[0]!;
    const profile = (await tx.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, e.employeePayrollProfileId!)).limit(1))[0]!;
    const base = { financialEntityId: e.financialEntityId, employeePayrollProfileId: profile.id, subjectType: SUBJECT, subjectRef: e.expenseRef, raisedByUserId: args.actorUserId };
    const sod = reimbursementApprover({ actorUserId: args.actorUserId, claimantUserId: profile.userId, submittedByUserId: e.submittedByUserId });
    if (!sod.allowed) {
      await raiseException(tx, { ...base, kind: "self_approval_blocked", discriminator: String(args.actorUserId), detail: "The claimant or submitter tried to approve this reimbursement" });
      return { outcome: "refused", code: "FORBIDDEN", message: sod.reason };
    }
    if (e.reimbursementState !== "pending_approval") return { outcome: "refused", code: "PRECONDITION_FAILED", message: `The reimbursement is ${e.reimbursementState}; only a pending claim is approved` };
    if (!(e.status === "submitted" || e.status === "review" || e.status === "approved")) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `The expense is ${e.status}; a reimbursement is approved only on a submitted expense` };
    const today = localDate(new Date(), "UTC");
    const payrollCurrency = await payrollCurrencyFor(tx, profile.id, today);
    if (!currencyCompatible(e.currency, payrollCurrency)) {
      await raiseException(tx, { ...base, kind: "reimbursement_currency_mismatch", detail: `Claimed in ${e.currency}; payroll pays this person in ${payrollCurrency}. No conversion is made` });
      return { outcome: "refused", code: "PRECONDITION_FAILED", message: `Claimed in ${e.currency}; payroll pays in ${payrollCurrency}. LeaseOS makes no currency conversion — correct the claim or reimburse it outside payroll` };
    }
    const gate = (await openExpenseExceptions(tx, e.expenseRef)).filter(x => EXPENSE_APPROVAL_GATE_KINDS.includes(x.kind));
    if (gate.length) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `Resolve first: ${gate.map(g => `${g.kind} (${g.exceptionRef})`).join(", ")}` };
    if (e.evidenceRecordId != null) {
      const ev = await evidenceFacts(tx, e.evidenceRecordId, true);
      const now = ev ? evidenceFingerprint(ev) : null;
      if (now !== e.evidenceFingerprint) {
        await raiseException(tx, { ...base, kind: "evidence_changed_after_submission", discriminator: now ?? "gone", detail: ev ? "The receipt was amended or re-sealed after the claim was submitted; resubmit the claim from the current receipt" : "The receipt is gone" });
        return { outcome: "refused", code: "PRECONDITION_FAILED", message: "The receipt changed after the claim was submitted" };
      }
    }
    const amount = reimbursableAmount({ totalCents: e.totalCents, claimedCents: e.reimbursementCents });
    if (!amount.ok) return { outcome: "refused", code: "PRECONDITION_FAILED", message: amount.reason };
    const next = { status: "approved" as const, reimbursementState: "approved" as const };
    const bad = stateContradiction({ ...next, reimbursementRequired: e.reimbursementRequired, paidPersonally: e.paidPersonally, employeePayrollProfileId: e.employeePayrollProfileId, reimbursementLineId: e.reimbursementLineId });
    if (bad) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `Refused: ${bad}` };
    await tx.update(expenseRecords).set({ ...next, reimbursementApprovedByUserId: args.actorUserId, reimbursementApprovedAt: new Date(), reimbursementCents: amount.cents }).where(eq(expenseRecords.id, e.id));
    await tx.update(payrollExceptions).set({ state: "resolved", resolvedByUserId: args.actorUserId, resolvedAt: new Date(), resolutionNote: "Approved by someone else" })
      .where(and(eq(payrollExceptions.subjectType, SUBJECT), eq(payrollExceptions.subjectRef, e.expenseRef), eq(payrollExceptions.state, "open"), eq(payrollExceptions.kind, "self_approval_blocked")));
    return { outcome: "done", expenseRef: e.expenseRef, reimbursementState: "approved" };
  });
}

/** Reject a pending claim with a reason. It stays visible; a corrected claim is a new submission that names it. */
export async function rejectClaim(args: { id: number; actorUserId: number; reason: string }): Promise<DecisionOutcome> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx): Promise<DecisionOutcome> => {
    const e = (await tx.select().from(expenseRecords).where(eq(expenseRecords.id, args.id)).for("update").limit(1))[0]!;
    const profile = (await tx.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, e.employeePayrollProfileId!)).limit(1))[0]!;
    const sod = reimbursementApprover({ actorUserId: args.actorUserId, claimantUserId: profile.userId, submittedByUserId: e.submittedByUserId });
    if (!sod.allowed) return { outcome: "refused", code: "FORBIDDEN", message: sod.reason.replace("approves", "decides") };
    if (e.reimbursementState !== "pending_approval") return { outcome: "refused", code: "PRECONDITION_FAILED", message: `The reimbursement is ${e.reimbursementState}; only a pending claim is rejected` };
    await tx.update(expenseRecords).set({ reimbursementState: "rejected", status: "rejected", reimbursementRejectedByUserId: args.actorUserId, reimbursementRejectedAt: new Date(), reimbursementRejectedReason: args.reason }).where(eq(expenseRecords.id, e.id));
    return { outcome: "done", expenseRef: e.expenseRef, reimbursementState: "rejected" };
  });
}

/** Send an approved, not-yet-scheduled claim back to review, with a reason. A scheduled one is corrected by adjustment (P5). */
export async function returnClaim(args: { id: number; actorUserId: number; reason: string }): Promise<DecisionOutcome> {
  const db = await dbOrThrow();
  return db.transaction(async (tx: Tx): Promise<DecisionOutcome> => {
    const e = (await tx.select().from(expenseRecords).where(eq(expenseRecords.id, args.id)).for("update").limit(1))[0]!;
    if (e.reimbursementState !== "approved" || e.reimbursementLineId != null) return { outcome: "refused", code: "PRECONDITION_FAILED", message: `The reimbursement is ${e.reimbursementState}; only an approved, unscheduled claim is returned (a scheduled one is corrected by adjustment)` };
    await tx.update(expenseRecords).set({
      reimbursementState: "pending_approval", status: "submitted", reimbursementApprovedByUserId: null, reimbursementApprovedAt: null,
      reimbursementReturnedByUserId: args.actorUserId, reimbursementReturnedAt: new Date(), reimbursementReturnReason: args.reason,
    }).where(eq(expenseRecords.id, e.id));
    return { outcome: "done", expenseRef: e.expenseRef, reimbursementState: "pending_approval" };
  });
}

/* ------------------------------------------------------------------ */
/* Scheduling: the reimbursement half of runCollect                    */
/* ------------------------------------------------------------------ */

export type ReimbursementCollection = { collected: number; amountCents: number; skipped: Array<{ id: number; reason: string }> };

/**
 * Inside `collectApprovedEarnings`'s transaction (run and period already locked): lock the book's approved, unlined
 * claims, select by the pure rule, and for each write exactly one `reimbursement` line and mark the claim `scheduled`
 * with the run and line. Never `reimbursed`: payment is P5's.
 */
export async function collectReimbursementsInTx(tx: Tx, run: { id: number; financialEntityId: number }, period: { state: string; payScheduleId: number | null; periodEndDate: DateText | null }): Promise<ReimbursementCollection> {
  const claims = await tx.select().from(expenseRecords)
    .where(and(eq(expenseRecords.financialEntityId, run.financialEntityId), eq(expenseRecords.reimbursementState, "approved"), isNull(expenseRecords.reimbursementLineId)))
    .orderBy(expenseRecords.id).for("update");
  if (!claims.length) return { collected: 0, amountCents: 0, skipped: [] };
  const profileIds = Array.from(new Set(claims.map(c => c.employeePayrollProfileId).filter((x): x is number => x != null)));
  const profiles = profileIds.length ? await tx.select().from(employeePayrollProfiles).where(inArray(employeePayrollProfiles.id, profileIds)) : [];
  const scheduleOf = new Map<number, number | null>();
  const zoneOf = new Map<number, string>();
  const currencyOf = new Map<number, string>();
  for (const p of profiles) {
    const chain = await scheduleChainFor(tx, p);
    scheduleOf.set(p.id, chain.ok ? chain.scheduleId : null);
    zoneOf.set(p.id, chain.ok ? chain.timezone : "UTC");
    currencyOf.set(p.id, await payrollCurrencyFor(tx, p.id, localDate(new Date(), chain.ok ? chain.timezone : "UTC")));
  }
  const blocking = await tx.select({ ref: payrollExceptions.subjectRef }).from(payrollExceptions)
    .where(and(eq(payrollExceptions.subjectType, SUBJECT), eq(payrollExceptions.state, "open"), inArray(payrollExceptions.subjectRef, claims.map(c => c.expenseRef)), inArray(payrollExceptions.kind, [...EXPENSE_APPROVAL_GATE_KINDS, "reimbursement_currency_mismatch"])));
  const blockedRefs = new Map<string, number>();
  for (const b of blocking) blockedRefs.set(b.ref, (blockedRefs.get(b.ref) ?? 0) + 1);
  const decision = selectReimbursements({
    run, period,
    payrollCurrency: pid => currencyOf.get(pid) ?? DEFAULT_PAYROLL_CURRENCY,
    claims: claims.map(c => ({
      id: c.id, reimbursementState: c.reimbursementState, reimbursementCents: c.reimbursementCents, currency: c.currency, financialEntityId: c.financialEntityId,
      claimantProfileId: c.employeePayrollProfileId, claimantScheduleId: c.employeePayrollProfileId != null ? scheduleOf.get(c.employeePayrollProfileId) ?? null : null,
      approvedOn: c.reimbursementApprovedAt ? localDate(c.reimbursementApprovedAt, c.employeePayrollProfileId != null ? zoneOf.get(c.employeePayrollProfileId) ?? "UTC" : "UTC") : null,
      alreadyLined: c.reimbursementLineId != null, blockingExceptions: blockedRefs.get(c.expenseRef) ?? 0,
    })),
  });
  let amountCents = 0;
  for (const pick of decision.collect) {
    const c = claims.find(x => x.id === pick.id)!;
    const cents = c.reimbursementCents!;
    const r = await tx.insert(payRunLines).values({
      payRunId: run.id, employeePayrollProfileId: c.employeePayrollProfileId!, lineType: "reimbursement", earningType: null, payrollEarningEventId: null,
      quantity: null, rateApplied: null, rateAppliedMillis: null, amount: cents / 100, amountCents: cents, taxRuleId: null,
      // A reimbursement repays an expense; it is not a statutory computation.
      ruleStatus: "not_applicable", expenseRecordId: c.id,
    });
    const lineId = Number(r[0]?.insertId);
    const bad = stateContradiction({ status: c.status, reimbursementState: "scheduled", reimbursementRequired: c.reimbursementRequired, paidPersonally: c.paidPersonally, employeePayrollProfileId: c.employeePayrollProfileId, reimbursementLineId: lineId });
    if (bad) throw Object.assign(new Error(`Refused: ${bad}`), { code: "PRECONDITION_FAILED" });
    await tx.update(expenseRecords).set({ reimbursementState: "scheduled", reimbursementPayRunId: run.id, reimbursementLineId: lineId }).where(eq(expenseRecords.id, c.id));
    amountCents += cents;
  }
  return { collected: decision.collect.length, amountCents, skipped: decision.skipped };
}

/** Where a claim stands for payroll, in words: approved is owed, scheduled is on a run, neither is paid. */
export async function scheduleFacts(claim: ExpenseRow): Promise<{ claimantScheduleRef: string | null; payrollCurrency: string | null; note: string }> {
  const db = await dbOrThrow();
  if (claim.employeePayrollProfileId == null) return { claimantScheduleRef: null, payrollCurrency: null, note: "Not a reimbursement claim" };
  const profile = (await db.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, claim.employeePayrollProfileId)).limit(1))[0]!;
  const group = profile.payGroupId != null ? (await db.select().from(payGroups).where(eq(payGroups.id, profile.payGroupId)).limit(1))[0] : undefined;
  const schedule = group?.payScheduleId != null ? (await db.select({ scheduleRef: paySchedules.scheduleRef }).from(paySchedules).where(eq(paySchedules.id, group.payScheduleId)).limit(1))[0] : undefined;
  const payrollCurrency = await payrollCurrencyFor(db, profile.id, localDate(new Date(), "UTC"));
  const s = claim.reimbursementState;
  const note = s === "approved" ? (schedule ? "Approved and owed; it goes on the next collecting run of the claimant's schedule whose period ends after the approval date. Not paid." : "Approved and owed, but the claimant has no pay schedule, so no run can take it yet. Not paid.")
    : s === "scheduled" ? "On a pay run. Not paid until that payroll is finalized and paid (P5)."
    : s === "reimbursed" ? "Paid with a finalized payroll."
    : s === "pending_approval" ? "Waiting for approval by the payroll office." : `The claim is ${s}.`;
  return { claimantScheduleRef: schedule?.scheduleRef ?? null, payrollCurrency, note };
}

export async function loadProfile(id: number) {
  const db = await dbOrThrow();
  return (await db.select().from(employeePayrollProfiles).where(eq(employeePayrollProfiles.id, id)).limit(1))[0] ?? null;
}

/** The claim's other expenses sharing evidence, content or vendor/amount/date — the duplicate review list. */
export async function duplicatesFor(claim: ExpenseRow) {
  const db = await dbOrThrow();
  const others = await db.select().from(expenseRecords).where(and(eq(expenseRecords.financialEntityId, claim.financialEntityId), or(sql`${expenseRecords.employeePayrollProfileId} IS NOT NULL`, eq(expenseRecords.paidByUserId, claim.paidByUserId ?? -1)))).limit(2000);
  return duplicateSignals({
    claim: { expenseRef: claim.expenseRef, employeePayrollProfileId: claim.employeePayrollProfileId ?? -1, clientCaptureRef: claim.clientCaptureRef, evidenceRecordId: claim.evidenceRecordId, contentHash: claim.evidenceContentHash, vendorName: claim.vendorName, totalCents: claim.totalCents ?? 0, transactionDate: claim.transactionDate },
    others: others.map(o => ({ expenseRef: o.expenseRef, employeePayrollProfileId: o.employeePayrollProfileId, clientCaptureRef: o.clientCaptureRef, evidenceRecordId: o.evidenceRecordId, contentHash: o.evidenceContentHash, vendorName: o.vendorName, totalCents: o.totalCents, transactionDate: o.transactionDate, live: isLiveClaim(o.reimbursementState) })),
  });
}
