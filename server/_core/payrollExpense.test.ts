/**
 * Payroll P4 — the pure rules: the reimbursement machine and its separation from the expense and from payment,
 * amounts and currency, receipts, evidence provenance, duplicates, separation of duties, the contractor boundary, and
 * which run takes which reimbursement.
 */
import { describe, expect, it } from "vitest";
import {
  P4_FORBIDDEN_TARGETS,
  REIMBURSEMENT_STATES,
  canTransitionReimbursement,
  currencyCompatible,
  duplicateSignals,
  employeeReimbursementEligible,
  evidenceFingerprint,
  isLiveClaim,
  isPaid,
  periodTakesReimbursement,
  receiptRequired,
  reimbursableAmount,
  reimbursementApprover,
  selectReimbursements,
  serverClaimState,
  stateContradiction,
  type ReimbursableClaim,
} from "./payrollExpense";
import { EXPENSE_APPROVAL_GATE_KINDS, EXPENSE_EXCEPTION_KINDS, isBlocking } from "./payrollTime";

describe("P4 — the reimbursement machine (1, 2, 3, 4, 5)", () => {
  it("moves only along its edges", () => {
    expect(canTransitionReimbursement("not_applicable", "pending_approval")).toBe(true);
    expect(canTransitionReimbursement("pending_approval", "approved")).toBe(true);
    expect(canTransitionReimbursement("pending_approval", "rejected")).toBe(true);
    expect(canTransitionReimbursement("pending_approval", "withdrawn")).toBe(true);
    expect(canTransitionReimbursement("approved", "scheduled")).toBe(true);
    expect(canTransitionReimbursement("approved", "pending_approval")).toBe(true);
  });
  it("refuses every other move", () => {
    expect(canTransitionReimbursement("pending_approval", "scheduled")).toBe(false);
    expect(canTransitionReimbursement("not_applicable", "approved")).toBe(false);
    expect(canTransitionReimbursement("approved", "reimbursed")).toBe(false);
    expect(canTransitionReimbursement("scheduled", "approved")).toBe(false);
    expect(canTransitionReimbursement("scheduled", "pending_approval")).toBe(false);
    for (const to of REIMBURSEMENT_STATES) {
      expect(canTransitionReimbursement("rejected", to), `rejected→${to}`).toBe(false);
      expect(canTransitionReimbursement("withdrawn", to), `withdrawn→${to}`).toBe(false);
      expect(canTransitionReimbursement("reimbursed", to), `reimbursed→${to}`).toBe(false);
    }
  });
  it("never calls approved or scheduled money paid, and P4 never reaches reimbursed", () => {
    expect(isPaid("approved")).toBe(false);
    expect(isPaid("scheduled")).toBe(false);
    expect(isPaid("reimbursed")).toBe(true);
    expect(P4_FORBIDDEN_TARGETS).toEqual(["reimbursed"]);
    expect(isLiveClaim("rejected")).toBe(false);
    expect(isLiveClaim("withdrawn")).toBe(false);
    expect(isLiveClaim("scheduled")).toBe(true);
  });
  it("refuses contradictory expense/reimbursement combinations", () => {
    const ok = { status: "approved" as const, reimbursementState: "approved" as const, reimbursementRequired: true, paidPersonally: true, employeePayrollProfileId: 4, reimbursementLineId: null };
    expect(stateContradiction(ok)).toBeNull();
    expect(stateContradiction({ ...ok, reimbursementState: "reimbursed", reimbursementLineId: 9, status: "rejected" })).toMatch(/rejected expense/);
    expect(stateContradiction({ ...ok, reimbursementState: "scheduled", employeePayrollProfileId: null })).toMatch(/no claimant/);
    expect(stateContradiction({ ...ok, reimbursementRequired: false })).toMatch(/not paid personally/);
    expect(stateContradiction({ ...ok, reimbursementState: "scheduled" })).toMatch(/no pay-run line/);
    expect(stateContradiction({ ...ok, reimbursementLineId: 3 })).toMatch(/already has a pay-run line/);
    expect(stateContradiction({ ...ok, reimbursementState: "not_applicable", reimbursementLineId: 3 })).toMatch(/not a claim/);
    expect(stateContradiction({ ...ok, reimbursementState: "not_applicable", reimbursementRequired: false, paidPersonally: false, employeePayrollProfileId: null })).toBeNull();
  });
});

describe("P4 — amounts and currency (9, 10, 11, 18)", () => {
  it("owes at most what was paid personally, in positive integer cents", () => {
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: null })).toEqual({ ok: true, cents: 4_250 });
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: 3_000 })).toEqual({ ok: true, cents: 3_000 });
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: 4_251 })).toMatchObject({ ok: false, reason: /exceeds/ });
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: 0 })).toMatchObject({ ok: false });
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: -5 })).toMatchObject({ ok: false });
    expect(reimbursableAmount({ totalCents: 4_250, claimedCents: 12.5 })).toMatchObject({ ok: false });
    expect(reimbursableAmount({ totalCents: null, claimedCents: 100 })).toMatchObject({ ok: false });
  });
  it("never converts a currency", () => {
    expect(currencyCompatible("cad", "CAD")).toBe(true);
    expect(currencyCompatible("USD", "CAD")).toBe(false);
  });
});

describe("P4 — receipts, provenance and duplicates (6, 7, 8, 19)", () => {
  it("requires a receipt on every claim, as a blocking review signal", () => {
    expect(receiptRequired({ evidenceRecordId: null })).toBe(true);
    expect(receiptRequired({ evidenceRecordId: 7 })).toBe(false);
    expect(isBlocking("receipt_required")).toBe(true);
    expect(EXPENSE_APPROVAL_GATE_KINDS).toEqual(["duplicate_expense", "receipt_required", "evidence_changed_after_submission"]);
    expect(EXPENSE_EXCEPTION_KINDS).toContain("reimbursement_currency_mismatch");
  });
  it("fingerprints a receipt so an amendment, a seal or new content shows", () => {
    const e = { id: 7, currentVersion: 1, sealState: "draft", storageKey: "k/1", contentHash: "a".repeat(64) };
    expect(evidenceFingerprint(e)).toBe(evidenceFingerprint({ ...e }));
    expect(evidenceFingerprint({ ...e, currentVersion: 2 })).not.toBe(evidenceFingerprint(e));
    expect(evidenceFingerprint({ ...e, sealState: "sealed" })).not.toBe(evidenceFingerprint(e));
    expect(evidenceFingerprint({ ...e, contentHash: "b".repeat(64) })).not.toBe(evidenceFingerprint(e));
  });
  const claim = { employeePayrollProfileId: 4, clientCaptureRef: "dev:1", evidenceRecordId: 7, contentHash: "c".repeat(64), vendorName: "Esso Grande Prairie", totalCents: 8_430, transactionDate: new Date("2026-03-03T12:00:00Z") };
  const other = (over: Record<string, unknown>) => ({ expenseRef: "EXP-1", employeePayrollProfileId: 4, clientCaptureRef: null, evidenceRecordId: null, contentHash: null, vendorName: "Other", totalCents: 1, transactionDate: new Date("2026-01-01T00:00:00Z"), live: true, ...over });
  it("classifies an exact replay, the same receipt, the same image, a similar claim and a fuel receipt", () => {
    expect(duplicateSignals({ claim, others: [other({ clientCaptureRef: "dev:1", live: false })] }).map(d => d.kind)).toEqual(["same_capture"]);
    expect(duplicateSignals({ claim, others: [other({ evidenceRecordId: 7 })] }).map(d => d.kind)).toEqual(["same_evidence"]);
    expect(duplicateSignals({ claim, others: [other({ contentHash: "c".repeat(64) })] }).map(d => d.kind)).toEqual(["same_content"]);
    expect(duplicateSignals({ claim, others: [other({ vendorName: "Esso Grande Prairie", totalCents: 8_430, transactionDate: new Date("2026-03-04T12:00:00Z") })] }).map(d => d.kind)).toEqual(["similar_claim"]);
    expect(duplicateSignals({ claim, others: [], fuelReceipts: [{ ref: "fuel:1", evidenceRecordId: 7, contentHash: null }] }).map(d => d.kind)).toEqual(["fuel_receipt"]);
    expect(duplicateSignals({ claim, others: [], fuelReceipts: [{ ref: "fuel:2", evidenceRecordId: null, contentHash: null, totalCents: 8_430, occurredAt: new Date("2026-03-02T09:00:00Z") }] }).map(d => d.kind)).toEqual(["fuel_receipt"]);
  });
  it("ignores dead claims, other claimants' similar spending, and genuinely different purchases", () => {
    expect(duplicateSignals({ claim, others: [other({ evidenceRecordId: 7, live: false })] })).toEqual([]);
    expect(duplicateSignals({ claim, others: [other({ employeePayrollProfileId: 9, vendorName: "Esso Grande Prairie", totalCents: 8_430, transactionDate: claim.transactionDate })] })).toEqual([]);
    expect(duplicateSignals({ claim, others: [other({ vendorName: "Esso Grande Prairie", totalCents: 1_200, transactionDate: new Date("2026-02-01T00:00:00Z") })] })).toEqual([]);
  });
});

describe("P4 — separation of duties and the contractor boundary (12, 13)", () => {
  it("refuses the claimant, the submitter and an unknown submitter", () => {
    expect(reimbursementApprover({ actorUserId: 2, claimantUserId: 1, submittedByUserId: 1 })).toEqual({ allowed: true });
    expect(reimbursementApprover({ actorUserId: 1, claimantUserId: 1, submittedByUserId: 1 })).toMatchObject({ allowed: false });
    expect(reimbursementApprover({ actorUserId: 3, claimantUserId: 1, submittedByUserId: 3 })).toMatchObject({ allowed: false, reason: /submitted/ });
    expect(reimbursementApprover({ actorUserId: 2, claimantUserId: 1, submittedByUserId: null })).toMatchObject({ allowed: false, reason: /not on record/ });
  });
  it("routes an owner-operator away from employee reimbursement", () => {
    expect(employeeReimbursementEligible("EMPLOYEE_DRIVER", false)).toEqual({ allowed: true });
    expect(employeeReimbursementEligible("OWNER_DRIVER", false)).toMatchObject({ allowed: false, reason: /contractor settlement/ });
    expect(employeeReimbursementEligible(null, true)).toMatchObject({ allowed: false });
  });
});

describe("P4 — which run takes a reimbursement (14, 15, 16, 17, 20)", () => {
  const period = { state: "collecting", payScheduleId: 5, periodEndDate: "2026-03-16" };
  const c = (over: Partial<ReimbursableClaim> = {}): ReimbursableClaim => ({ id: 1, reimbursementState: "approved", reimbursementCents: 8_430, currency: "CAD", financialEntityId: 3, claimantProfileId: 4, claimantScheduleId: 5, approvedOn: "2026-03-10", alreadyLined: false, blockingExceptions: 0, ...over });
  const pick = (claims: ReimbursableClaim[], p = period) => selectReimbursements({ run: { financialEntityId: 3 }, period: p, payrollCurrency: () => "CAD", claims });
  it("selects an approved claim for the claimant's next period, deterministically", () => {
    const r = pick([c({ id: 9 }), c({ id: 2 })]);
    expect(r.collect.map(x => x.id)).toEqual([2, 9]);
    expect(r.collect[0]!.reimbursementCents).toBe(8_430);
  });
  it("skips rejected, pending, already scheduled, foreign, mismatched and blocked claims — each by name", () => {
    const r = pick([
      c({ id: 1, reimbursementState: "rejected" }), c({ id: 2, reimbursementState: "pending_approval" }), c({ id: 3, reimbursementState: "scheduled" }),
      c({ id: 4, alreadyLined: true }), c({ id: 5, financialEntityId: 8 }), c({ id: 6, currency: "USD" }), c({ id: 7, blockingExceptions: 1 }),
      c({ id: 8, reimbursementCents: 0 }), c({ id: 10, claimantScheduleId: null }),
    ]);
    expect(r.collect).toEqual([]);
    expect(r.skipped.map(s => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    expect(r.skipped.find(s => s.id === 6)!.reason).toMatch(/USD/);
  });
  it("uses the approval date, never reopens a period that ended before it, and never a locked one", () => {
    expect(periodTakesReimbursement(period, { scheduleId: 5, approvedOn: "2026-03-15" })).toEqual({ ok: true });
    expect(periodTakesReimbursement(period, { scheduleId: 5, approvedOn: "2026-03-16" })).toMatchObject({ ok: false, reason: /ended before/ });
    expect(periodTakesReimbursement({ ...period, state: "approved" }, { scheduleId: 5, approvedOn: "2026-03-01" })).toMatchObject({ ok: false, reason: /approved/ });
    expect(periodTakesReimbursement({ ...period, payScheduleId: 6 }, { scheduleId: 5, approvedOn: "2026-03-01" })).toMatchObject({ ok: false });
    // A 2025 receipt approved this week goes on this week's run, not into 2025's payroll.
    expect(pick([c({ approvedOn: "2026-03-10" })]).collect.length).toBe(1);
  });
});

describe("P4 — offline captures choose nothing", () => {
  it("may be a draft or a submission, and nothing more", () => {
    expect(serverClaimState(undefined)).toEqual({ ok: true, submit: true });
    expect(serverClaimState("draft")).toEqual({ ok: true, submit: false });
    for (const s of ["approved", "scheduled", "reimbursed", "paid"]) expect(serverClaimState(s).ok, s).toBe(false);
  });
});
