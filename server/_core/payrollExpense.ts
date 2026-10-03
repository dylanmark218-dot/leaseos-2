/**
 * Payroll P4 — employee expenses and payroll reimbursements, pure
 * (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §27).
 *
 * Three things are kept apart on purpose:
 *
 *   an EXPENSE        — money was spent; `expenseRecords.status` (draft → submitted → review → approved/rejected → posted)
 *   a REIMBURSEMENT   — payroll owes the employee; `expenseRecords.reimbursementState` (this module)
 *   a PAYMENT         — the reimbursement went out with a finalized, paid payroll (P5 decides; nothing here does)
 *
 *   not_applicable ─► pending_approval ─► approved ─► scheduled ─► reimbursed (P5 only)
 *                          │                 │
 *                          ├► rejected       └► pending_approval (returned for correction, before scheduling)
 *                          └► withdrawn
 *
 * Scheduling puts exactly one reimbursement line on an eligible pay run. It is not payment: `scheduled` never becomes
 * `reimbursed` in P4, and no transition here produces `reimbursed`.
 */
import { canonicalJson, sha256 } from "./commercialLifecycle";
import { findDuplicateCandidates } from "./expenseTreatment";
import { addDays, type DateText } from "./payrollSchedule";

export const REIMBURSEMENT_STATES = ["not_applicable", "pending_approval", "approved", "scheduled", "reimbursed", "rejected", "withdrawn"] as const;
export type ReimbursementState = (typeof REIMBURSEMENT_STATES)[number];

/** Every legal move, and nothing else. `scheduled → reimbursed` is P5's, and no P4 path takes it. */
const TRANSITIONS: Readonly<Record<ReimbursementState, readonly ReimbursementState[]>> = {
  not_applicable: ["pending_approval"],
  pending_approval: ["approved", "rejected", "withdrawn"],
  approved: ["scheduled", "pending_approval"],
  scheduled: ["reimbursed"],
  reimbursed: [],
  rejected: [],
  withdrawn: [],
};
export const canTransitionReimbursement = (from: ReimbursementState, to: ReimbursementState) => TRANSITIONS[from].includes(to);
/** The P4 surface never performs these. */
export const P4_FORBIDDEN_TARGETS: readonly ReimbursementState[] = ["reimbursed"];
/** A claim that still holds its receipt (and its client capture) against another claim. */
export const isLiveClaim = (s: ReimbursementState) => s === "pending_approval" || s === "approved" || s === "scheduled" || s === "reimbursed";
/** Has payroll paid it? Only a finalized payment says yes — never approval, never scheduling. */
export const isPaid = (s: ReimbursementState) => s === "reimbursed";

export type ExpenseStatus = "draft" | "submitted" | "review" | "approved" | "rejected" | "posted";

/**
 * The combinations of accounting status and reimbursement state that may never exist. Every write checks the row
 * it would produce against this, so the two lifecycles cannot contradict each other.
 */
export function stateContradiction(r: {
  status: ExpenseStatus;
  reimbursementState: ReimbursementState;
  reimbursementRequired: boolean;
  paidPersonally: boolean;
  employeePayrollProfileId: number | null;
  reimbursementLineId: number | null;
}): string | null {
  const s = r.reimbursementState;
  if (s === "not_applicable") return r.reimbursementLineId != null ? "a reimbursement line exists for an expense that is not a claim" : null;
  if (r.employeePayrollProfileId == null) return `a ${s} reimbursement has no claimant`;
  if (!r.reimbursementRequired || !r.paidPersonally) return `a ${s} reimbursement on an expense that was not paid personally for reimbursement`;
  if ((s === "approved" || s === "scheduled" || s === "reimbursed") && r.status === "rejected") return `a ${s} reimbursement on a rejected expense`;
  if ((s === "scheduled" || s === "reimbursed") && r.reimbursementLineId == null) return `a ${s} reimbursement with no pay-run line`;
  if ((s === "pending_approval" || s === "approved" || s === "rejected" || s === "withdrawn") && r.reimbursementLineId != null) return `a ${s} reimbursement already has a pay-run line`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Amount and currency                                                 */
/* ------------------------------------------------------------------ */

/**
 * The amount payroll may owe: what the employee says they personally paid, in integer cents, never more than the
 * expense total and never zero or negative. An OCR reading is not an amount; the employee states it and the approver
 * verifies it against the receipt.
 */
export function reimbursableAmount(args: { totalCents: number | null; claimedCents: number | null }): { ok: true; cents: number } | { ok: false; reason: string } {
  const { totalCents, claimedCents } = args;
  if (totalCents == null || !Number.isSafeInteger(totalCents)) return { ok: false, reason: "The expense has no integer total" };
  const cents = claimedCents ?? totalCents;
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "The reimbursement amount is not a whole number of cents" };
  if (cents <= 0) return { ok: false, reason: "A reimbursement is a positive amount" };
  if (cents > totalCents) return { ok: false, reason: `The reimbursement (${cents}) exceeds the expense total (${totalCents}); a larger amount needs an adjustment` };
  return { ok: true, cents };
}

/** No conversion is ever made: a claim in another currency than payroll pays in is held for review. */
export function currencyCompatible(expenseCurrency: string, payrollCurrency: string): boolean {
  return expenseCurrency.trim().toUpperCase() === payrollCurrency.trim().toUpperCase();
}
/** The repository default where no compensation version names a currency (expenseRecords and 0226 both default to it). */
export const DEFAULT_PAYROLL_CURRENCY = "CAD";

/* ------------------------------------------------------------------ */
/* Receipts, evidence provenance, duplicates                           */
/* ------------------------------------------------------------------ */

/**
 * The narrow receipt rule: every employee reimbursement claim needs a receipt. No category policy exists in the
 * schema (expenseCategories has no receipt flag), so the rule is not configurable in P4; a missing receipt is a
 * blocking review signal, never a deletion or an automatic rejection.
 */
export function receiptRequired(claim: { evidenceRecordId: number | null }): boolean {
  return claim.evidenceRecordId == null;
}

export type EvidenceFacts = { id: number; currentVersion: number; sealState: string; storageKey: string | null; contentHash: string | null };

/** What the receipt was when it was submitted. A new version, a seal change or new content changes it. */
export function evidenceFingerprint(e: EvidenceFacts): string {
  return sha256(canonicalJson({ v: 1, id: e.id, currentVersion: e.currentVersion, sealState: e.sealState, storageKey: e.storageKey, contentHash: e.contentHash }));
}

export type DuplicateSignal = { kind: "same_evidence" | "same_content" | "same_capture" | "similar_claim" | "fuel_receipt"; otherRef: string; detail: string };

/**
 * Classify a claim against the claimant's and the book's other live claims. `same_capture` is a replay (the caller
 * returns the first claim); `same_evidence` is refused outright (one receipt, one claim); the rest are review signals
 * (`duplicate_expense`), never an accusation and never an automatic rejection.
 */
export function duplicateSignals(args: {
  claim: { expenseRef?: string; employeePayrollProfileId: number; clientCaptureRef: string | null; evidenceRecordId: number | null; contentHash: string | null; vendorName: string | null; totalCents: number; transactionDate: Date };
  others: ReadonlyArray<{ expenseRef: string; employeePayrollProfileId: number | null; clientCaptureRef: string | null; evidenceRecordId: number | null; contentHash: string | null; vendorName: string | null; totalCents: number | null; transactionDate: Date; live: boolean }>;
  /** Fuel the claimant bought personally (and fuel on the same receipt): fuel keeps its own reimbursement flag. */
  fuelReceipts?: ReadonlyArray<{ ref: string; evidenceRecordId: number | null; contentHash: string | null; totalCents?: number | null; occurredAt?: Date | null }>;
}): DuplicateSignal[] {
  const c = args.claim;
  const out: DuplicateSignal[] = [];
  for (const o of args.others) {
    if (o.expenseRef === c.expenseRef) continue;
    if (c.clientCaptureRef && o.clientCaptureRef === c.clientCaptureRef && o.employeePayrollProfileId === c.employeePayrollProfileId) out.push({ kind: "same_capture", otherRef: o.expenseRef, detail: "the same device capture" });
    if (!o.live) continue;
    if (c.evidenceRecordId != null && o.evidenceRecordId === c.evidenceRecordId) out.push({ kind: "same_evidence", otherRef: o.expenseRef, detail: "the same receipt record" });
    else if (c.contentHash && o.contentHash === c.contentHash) out.push({ kind: "same_content", otherRef: o.expenseRef, detail: "an identical receipt image" });
  }
  // The existing heuristic (vendor, amount, date) — a review signal for the same claimant's live claims.
  const similar = findDuplicateCandidates({
    candidate: { vendorName: c.vendorName, total: c.totalCents / 100, transactionDate: c.transactionDate },
    existing: args.others.filter(o => o.live && o.employeePayrollProfileId === c.employeePayrollProfileId && o.expenseRef !== c.expenseRef && o.totalCents != null)
      .map(o => ({ expenseRef: o.expenseRef, vendorName: o.vendorName, total: o.totalCents! / 100, transactionDate: o.transactionDate })),
  });
  for (const s of similar) if (!out.some(x => x.otherRef === s.expenseRef)) out.push({ kind: "similar_claim", otherRef: s.expenseRef, detail: s.reasons.join(", ") });
  for (const f of args.fuelReceipts ?? []) {
    if ((c.evidenceRecordId != null && f.evidenceRecordId === c.evidenceRecordId) || (c.contentHash && f.contentHash === c.contentHash)) out.push({ kind: "fuel_receipt", otherRef: f.ref, detail: "the same receipt is on a fuel transaction" });
    else if (f.totalCents != null && f.totalCents === c.totalCents && f.occurredAt && Math.abs(f.occurredAt.getTime() - c.transactionDate.getTime()) <= 3 * 86_400_000) {
      out.push({ kind: "fuel_receipt", otherRef: f.ref, detail: "a personally paid fuel purchase of the same amount within 3 days" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Separation of duties and the contractor boundary                    */
/* ------------------------------------------------------------------ */

/** Approving a reimbursement is someone else's act: not the claimant's, the submitter's or the creator's, and never unknown. */
export function reimbursementApprover(args: { actorUserId: number; claimantUserId: number | null; submittedByUserId: number | null }): { allowed: true } | { allowed: false; reason: string } {
  if (args.submittedByUserId == null) return { allowed: false, reason: "Who submitted this claim is not on record, so its approval cannot be separated from it" };
  if (args.actorUserId === args.claimantUserId) return { allowed: false, reason: "This is your own reimbursement; someone else approves it" };
  if (args.actorUserId === args.submittedByUserId) return { allowed: false, reason: "You submitted this claim; someone else approves it" };
  return { allowed: true };
}

/** An owner-operator's costs are contractor settlement or accounts payable, never an employee payroll reimbursement. */
export function employeeReimbursementEligible(classification: string | null | undefined, ownerOperator: boolean): { allowed: true } | { allowed: false; reason: string } {
  if (ownerOperator || classification === "OWNER_DRIVER") return { allowed: false, reason: "An owner-operator's expenses go through contractor settlement, not employee payroll reimbursement" };
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* Which run a reimbursement goes on                                   */
/* ------------------------------------------------------------------ */

/**
 * The scheduling rule. An approved reimbursement goes on the first collecting run of the claimant's own schedule
 * whose period ENDS AFTER the approval date (in the schedule's zone). The expense date never picks the period, a
 * period that ended before approval never takes it (no historical payroll is reopened), and a locked period never
 * takes anything.
 */
export function periodTakesReimbursement(period: { state: string; payScheduleId: number | null; periodEndDate: DateText | null }, claim: { scheduleId: number | null; approvedOn: DateText }): { ok: true } | { ok: false; reason: string } {
  if (!(period.state === "collecting" || period.state === "review")) return { ok: false, reason: `the period is ${period.state}` };
  if (claim.scheduleId == null) return { ok: false, reason: "the claimant has no pay schedule" };
  if (period.payScheduleId !== claim.scheduleId) return { ok: false, reason: "the period is not on the claimant's schedule" };
  if (period.periodEndDate == null || !(claim.approvedOn < period.periodEndDate)) return { ok: false, reason: `the period ended before the approval on ${claim.approvedOn}` };
  return { ok: true };
}

/** The last day a period covers — its exclusive end minus one — for messages. */
export const periodLastDay = (periodEndDate: DateText) => addDays(periodEndDate, -1);

export type ReimbursableClaim = {
  id: number;
  reimbursementState: ReimbursementState;
  reimbursementCents: number | null;
  currency: string;
  financialEntityId: number;
  claimantProfileId: number | null;
  claimantScheduleId: number | null;
  approvedOn: DateText | null;
  alreadyLined: boolean;
  blockingExceptions: number;
};

/**
 * Which approved reimbursements a run collects — a separate, deterministic selection beside the earnings one. Only
 * `approved`, in the run's book, with a positive integer amount in the payroll currency, on the claimant's schedule,
 * due by the rule above, with no open blocking exception, and never twice.
 */
export function selectReimbursements(args: {
  run: { financialEntityId: number };
  period: { state: string; payScheduleId: number | null; periodEndDate: DateText | null };
  payrollCurrency: (claimantProfileId: number) => string;
  claims: readonly ReimbursableClaim[];
}): { collect: ReimbursableClaim[]; skipped: Array<{ id: number; reason: string }> } {
  const collect: ReimbursableClaim[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const c of [...args.claims].sort((a, b) => a.id - b.id)) {
    const skip = (reason: string) => skipped.push({ id: c.id, reason });
    if (c.reimbursementState !== "approved") { skip(`reimbursement is ${c.reimbursementState}, not approved`); continue; }
    if (c.alreadyLined) { skip("already on a pay run"); continue; }
    if (c.financialEntityId !== args.run.financialEntityId) { skip("outside the run's book"); continue; }
    if (c.claimantProfileId == null) { skip("no claimant"); continue; }
    if (c.reimbursementCents == null || !Number.isSafeInteger(c.reimbursementCents) || c.reimbursementCents <= 0) { skip("no positive integer amount"); continue; }
    if (!currencyCompatible(c.currency, args.payrollCurrency(c.claimantProfileId))) { skip(`claimed in ${c.currency}, payroll pays in ${args.payrollCurrency(c.claimantProfileId)}`); continue; }
    if (c.blockingExceptions > 0) { skip("an open blocking exception"); continue; }
    if (c.approvedOn == null) { skip("no approval date"); continue; }
    const fit = periodTakesReimbursement(args.period, { scheduleId: c.claimantScheduleId, approvedOn: c.approvedOn });
    if (!fit.ok) { skip(fit.reason); continue; }
    collect.push(c);
  }
  return { collect, skipped };
}

/* ------------------------------------------------------------------ */
/* Offline                                                             */
/* ------------------------------------------------------------------ */

/** A capture may ask to be a draft or a submitted claim. Approval, scheduling and payment are decided on the server. */
export function serverClaimState(claimed: unknown): { ok: true; submit: boolean } | { ok: false; reason: string } {
  if (claimed === undefined || claimed === null || claimed === "submitted") return { ok: true, submit: true };
  if (claimed === "draft") return { ok: true, submit: false };
  return { ok: false, reason: `A capture cannot claim "${String(claimed)}"; approval and payment are decided on the server` };
}
