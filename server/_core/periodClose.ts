/**
 * Period close.
 *
 *   open         records dated in the period may be written
 *   soft_closed  the books are being reviewed; writes are refused unless
 *                the period is reopened; review items may remain
 *   closed       nothing blocking remained when it closed; writes are refused
 *
 * State is the latest action for the period; the history is the record.
 * Readiness is a derivation: the things that block a close are the ledger's
 * open findings, named, with what to do about each.
 */

export type CloseAction = "soft_close" | "close" | "reopen";
export type PeriodState = "open" | "soft_closed" | "closed";
export type CloseRow = { id?: number; period: string; action: CloseAction; at: Date };

export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodBounds(period: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`Period must look like 2026-08, got ${period}`);
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Month ${mo} is not a month`);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

/** Latest action wins; ties on the same second break by id. */
export function periodState(rows: readonly CloseRow[], period: string): PeriodState {
  const latest = [...rows].filter(r => r.period === period).sort((a, b) => b.at.getTime() - a.at.getTime() || (b.id ?? 0) - (a.id ?? 0))[0];
  if (!latest) return "open";
  return latest.action === "close" ? "closed" : latest.action === "soft_close" ? "soft_closed" : "open";
}

export type CloseFinding = { code: string; severity: "blocking" | "review"; count: number; detail: string; action: string };

export type CloseFacts = {
  unmatchedStatementLines: number;
  ambiguousStatementLines: number;
  statementsImported: number;
  billsMismatched: number;
  billsDuplicateSuspected: number;
  billsMissingReceipt: number;
  billsAwaitingApproval: number;
  billsAwaitingCoding: number;
  fuelNeedsReview: number;
  fuelJurisdictionUnknown: number;
  distanceNeedsReview: number;
  tanksOutOfTolerance: { tankRef: string; variancePct: number }[];
  quarterEndMonth: boolean;
  iftaReturnStatus: "none" | "prepared" | "finalized" | "filed" | "amended" | null;
  /** v21.8 — the GST/HST return for the quarter this month ends, if it ends one. */
  gstReturnStatus: "none" | "prepared" | "finalized" | "filed" | "amended" | null;
  expensesDraft: number;
  proposalsAwaitingReadback: number;
  lateArrivalsAfterClose: number;
  /** v21.9 — the bank's view: lines nothing explains, and payments not yet applied. */
  bankLinesUnexplained: number;
  bankStatementsImported: number;
  paymentsUnapplied: number;
};

export function closeReadiness(f: CloseFacts): { verdict: "ready" | "review" | "blocked"; findings: CloseFinding[] } {
  const out: CloseFinding[] = [];
  const add = (code: string, severity: CloseFinding["severity"], count: number, detail: string, action: string) => { if (count > 0) out.push({ code, severity, count, detail, action }); };
  add("statement_lines_unmatched", "blocking", f.unmatchedStatementLines, `${f.unmatchedStatementLines} card purchase(s) with no receipt`, "Find and scan the receipt, or record that there is none");
  add("statement_lines_ambiguous", "blocking", f.ambiguousStatementLines, `${f.ambiguousStatementLines} statement line(s) that could be more than one receipt`, "Resolve each to its receipt");
  add("bills_mismatched", "blocking", f.billsMismatched, `${f.billsMismatched} vendor bill(s) with unresolved match variances`, "Resolve the variances or dispute the bill");
  add("bills_duplicate_suspected", "blocking", f.billsDuplicateSuspected, `${f.billsDuplicateSuspected} vendor bill(s) that may be duplicates`, "Confirm or cancel");
  add("bills_missing_receipt", "review", f.billsMissingReceipt, `${f.billsMissingReceipt} vendor bill(s) without evidence`, "Attach the receipt or work order");
  add("bills_awaiting_approval", "review", f.billsAwaitingApproval, `${f.billsAwaitingApproval} vendor bill(s) matched and awaiting approval`, "Code and approve");
  add("bills_awaiting_coding", "review", f.billsAwaitingCoding, `${f.billsAwaitingCoding} vendor bill(s) not yet coded`, "Match and code");
  add("fuel_needs_review", "review", f.fuelNeedsReview, `${f.fuelNeedsReview} fuel transaction(s) awaiting review`, "Confirm or reject");
  add("fuel_jurisdiction_unknown", "blocking", f.fuelJurisdictionUnknown, `${f.fuelJurisdictionUnknown} fuel transaction(s) with no jurisdiction — IFTA cannot credit them`, "Classify from the receipt or statement");
  add("distance_needs_review", "review", f.distanceNeedsReview, `${f.distanceNeedsReview} distance record(s) not yet verified`, "Verify or reject");
  for (const t of f.tanksOutOfTolerance) out.push({ code: "tank_variance", severity: "blocking", count: 1, detail: `Tank ${t.tankRef} variance ${t.variancePct}% beyond tolerance`, action: "Explain the variance — unrecorded fill, leak or theft — and record it" });
  if (f.quarterEndMonth && f.iftaReturnStatus !== "finalized" && f.iftaReturnStatus !== "filed") out.push({ code: "ifta_return_not_finalized", severity: "review", count: 1, detail: `Quarter-end month and the IFTA return is ${f.iftaReturnStatus ?? "not prepared"}`, action: "Prepare and finalize the return, or record why it waits" });
  if (f.quarterEndMonth && f.gstReturnStatus !== "finalized" && f.gstReturnStatus !== "filed") out.push({ code: "gst_return_not_finalized", severity: "review", count: 1, detail: `Quarter-end month and the GST/HST return is ${f.gstReturnStatus ?? "not prepared"}`, action: "Prepare and finalize the return, or record why it waits" });
  add("expenses_draft", "review", f.expensesDraft, `${f.expensesDraft} expense record(s) still draft`, "Submit or reject");
  add("proposals_awaiting_readback", "review", f.proposalsAwaitingReadback, `${f.proposalsAwaitingReadback} AI-proposed financial record(s) awaiting confirmation`, "Confirm or reject the read-backs");
  add("bank_lines_unexplained", "blocking", f.bankLinesUnexplained, `${f.bankLinesUnexplained} bank statement line(s) nothing explains — unknown deposits, withdrawals or ambiguous matches`, "Match each to its movement, or record what it was");
  if (f.bankStatementsImported === 0) out.push({ code: "bank_statement_not_imported", severity: "review", count: 1, detail: "No bank statement covering this period has been imported", action: "Import the statement and reconcile" });
  add("payments_unapplied", "review", f.paymentsUnapplied, `${f.paymentsUnapplied} customer payment(s) received and not applied to invoices`, "Apply each to its invoices");
  add("late_arrivals_after_close", "review", f.lateArrivalsAfterClose, `${f.lateArrivalsAfterClose} record(s) dated in this period arrived after it was closed`, "Reopen and post, or carry to the next period with a note");
  const blocking = out.some(x => x.severity === "blocking");
  return { verdict: blocking ? "blocked" : out.length ? "review" : "ready", findings: out };
}

export type CloseDecision = { permitted: true } | { permitted: false; refusals: string[] };

/**
 * soft_close: any state but closed; review items may remain, blocking may
 * not. close: nothing blocking, and from open or soft_closed. reopen: only
 * from a closed or soft-closed state, with a reason — the reason is the
 * caller's, checked at the API.
 */
export function decideClose(state: PeriodState, action: CloseAction, readiness: ReturnType<typeof closeReadiness>): CloseDecision {
  const refusals: string[] = [];
  if (action === "reopen") {
    if (state === "open") refusals.push("Period is already open");
    return refusals.length ? { permitted: false, refusals } : { permitted: true };
  }
  if (state === "closed") refusals.push("Period is already closed — reopen it first");
  for (const b of readiness.findings.filter(x => x.severity === "blocking")) refusals.push(`${b.code}: ${b.detail}`);
  if (action === "close" && state === "open" && readiness.findings.some(x => x.severity === "review")) {
    // A hard close skips the review step only when there is nothing to review.
    refusals.push(`Review items remain (${readiness.findings.filter(x => x.severity === "review").map(x => x.code).join(", ")}) — soft-close first, or clear them`);
  }
  return refusals.length ? { permitted: false, refusals } : { permitted: true };
}

/** For write paths: a record dated in a period that is not open may not be written. */
export function writePermitted(state: PeriodState, period: string): { permitted: boolean; reason: string } {
  return state === "open" ? { permitted: true, reason: `Period ${period} is open` } : { permitted: false, reason: `Period ${period} is ${state.replace("_", "-")} — reopen it to post here, or date the record in an open period with a note` };
}
