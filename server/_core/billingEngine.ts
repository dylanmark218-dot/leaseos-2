/**
 * v23.32 — Billing, Invoicing and Accounts Receivable: every rule, no database.
 *
 * `server/billingService.ts` reads rows, calls these, and writes the outcome in one transaction with its audit
 * row and outbox event. Nothing here touches money as a float: amounts are integer cents, quantities integer
 * thousandths (millis), tax rates integer basis points.
 *
 *   - A workspace or an invoice moves only through its transition table. There is no "set status".
 *   - Readiness is a pure function of facts: hard blockers stop billing; warnings are shown and do not.
 *   - A charge is billed in slices; the last slice takes the remainder, so the slices always sum to the charge.
 *   - A receivable is derived (original − paid − credited ± adjusted); nothing stores a balance to be edited.
 */
import { createHash } from "node:crypto";

/* ================================================================ workspace */

export const WORKSPACE_STATES = [
  "not_ready", "awaiting_documents", "awaiting_signatures", "awaiting_disposal", "awaiting_commercial", "ready",
  "under_review", "approved_for_invoicing", "invoiced", "partially_paid", "paid", "disputed", "credited",
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** The pre-review states readiness may put a job in. A re-evaluation moves freely among them. */
export const READINESS_STATES: readonly WorkspaceState[] = ["not_ready", "awaiting_documents", "awaiting_signatures", "awaiting_disposal", "awaiting_commercial", "ready"];
/** States in which the job's invoices exist and its AR picture drives the state. */
export const POST_INVOICE_STATES: readonly WorkspaceState[] = ["invoiced", "partially_paid", "paid", "disputed", "credited"];

const T: Record<WorkspaceState, readonly WorkspaceState[]> = {
  not_ready: READINESS_STATES,
  awaiting_documents: READINESS_STATES,
  awaiting_signatures: READINESS_STATES,
  awaiting_disposal: READINESS_STATES,
  awaiting_commercial: READINESS_STATES,
  ready: [...READINESS_STATES, "under_review"],
  // a reviewer returns the job (back to readiness) or approves it
  under_review: [...READINESS_STATES, "approved_for_invoicing", "invoiced"],
  // approval is withdrawn by re-evaluation when something changed underneath; or the job is invoiced
  approved_for_invoicing: [...READINESS_STATES, "invoiced"],
  // after invoicing, the AR picture moves the job; remaining or new charges go back through review (supplemental);
  // a void of the job's only invoice returns it to approved-for-invoicing
  invoiced: ["partially_paid", "paid", "disputed", "credited", "approved_for_invoicing", "under_review"],
  partially_paid: ["invoiced", "paid", "disputed", "credited", "under_review"],
  paid: ["partially_paid", "invoiced", "disputed", "credited", "under_review"],
  disputed: ["invoiced", "partially_paid", "paid", "credited", "approved_for_invoicing", "under_review"],
  credited: ["invoiced", "partially_paid", "paid", "disputed", "approved_for_invoicing", "under_review"],
};

export function workspaceTransition(from: WorkspaceState, to: WorkspaceState): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: true };
  return T[from].includes(to) ? { ok: true } : { ok: false, reason: `A job's billing cannot move from ${from} to ${to}` };
}

/* ================================================================ readiness */

export type ReadinessCode =
  | "commercial_context_missing" | "commercial_snapshot_missing" | "rate_sheet_unresolved" | "reference_missing" | "credit_hold"
  | "job_not_complete" | "no_field_ticket" | "ticket_not_closed" | "signature_missing" | "signature_refused" | "signature_stale" | "line_disputed" | "line_not_presented"
  | "disposal_ticket_missing" | "disposal_ticket_unverified"
  | "charges_not_prepared" | "charge_unpriced" | "charge_override_pending" | "manual_charge_pending" | "no_billable_amount"
  | "billing_hold" | "currency_mismatch" | "partially_billed";

export type ReadinessIssue = { code: ReadinessCode; severity: "blocker" | "warning"; message: string; subject?: string | null; group: "commercial" | "documents" | "signatures" | "disposal" | "charges" | "hold" };

export type TicketFact = { ticketNumber: string; status: string; signature: { state: string; satisfied: boolean; reason: string }; lineCount: number; disputedLines: number; unpresentedLines: number };
export type ChargeFact = { chargeRef: string; status: string; pricingOutcome: string; amountCents: number | null; billableQuantityMillis: number | null; billedQuantityMillis: number; billedAmountCents: number; overrideStatus: string; sourceKind: string; currency: string; reasons: string[] };
export type ReadinessFacts = {
  jobId: number; jobCode: string; jobStatus: string;
  commercial: { available: true; snapshotRef: string; currency: string; blockers: { code: string; message: string }[] } | { available: false; reasons: string[] };
  tickets: TicketFact[];
  disposal: { required: boolean; tickets: { ticketNumber: string; verificationStatus: string }[] };
  charges: ChargeFact[] | null;
  hold: { active: boolean; reason: string | null };
};
export type Readiness = { jobId: number; ready: boolean; blockers: ReadinessIssue[]; warnings: ReadinessIssue[]; suggestedState: WorkspaceState; billableCents: number; remainingCents: number; hash: string };

/**
 * evaluateBillingReadiness, the rule half. Deterministic: the same facts give the same blockers in the same order
 * and the same hash. The suggested state names the FIRST unmet group in the order a job is closed out:
 * commercial → documents → signatures → disposal → charges.
 */
export function evaluateReadiness(f: ReadinessFacts): Readiness {
  const out: ReadinessIssue[] = [];
  const add = (i: ReadinessIssue) => out.push(i);

  if (!f.commercial.available) {
    const noContext = f.commercial.reasons.some(r => /No customer/i.test(r));
    add({ code: noContext ? "commercial_context_missing" : "commercial_snapshot_missing", severity: "blocker", group: "commercial", message: f.commercial.reasons.join("; ") || "The job has no commercial basis to bill from" });
  } else {
    for (const b of f.commercial.blockers) {
      if (b.code === "no_rate_sheet_version") add({ code: "rate_sheet_unresolved", severity: "blocker", group: "commercial", message: b.message });
      else if (b.code === "reference_missing") add({ code: "reference_missing", severity: "blocker", group: "commercial", message: b.message });
      // A credit hold is an ACCOUNTING flag: work already done is still billed. It never blocks billing here, and
      // dispatch's own gate (commercialReadiness) lets emergency work through.
      else if (b.code === "account_on_hold") add({ code: "credit_hold", severity: "warning", group: "commercial", message: `${b.message} — the customer is on credit hold; this invoice may be issued, new work needs approval` });
    }
  }

  if (f.jobStatus !== "complete") add({ code: "job_not_complete", severity: "blocker", group: "documents", message: `Job ${f.jobCode} is ${f.jobStatus.replace(/_/g, " ")}, not complete` });
  if (f.tickets.length === 0) add({ code: "no_field_ticket", severity: "blocker", group: "documents", message: "No field ticket is on file for this job" });
  for (const t of f.tickets) {
    if (t.status !== "closed") add({ code: "ticket_not_closed", severity: "blocker", group: "documents", subject: t.ticketNumber, message: `Field ticket ${t.ticketNumber} is ${t.status.replace(/_/g, " ")} — it is closed before it bills` });
    if (!t.signature.satisfied) {
      const code: ReadinessCode = t.signature.state === "refused" ? "signature_refused" : t.signature.state === "stale" ? "signature_stale" : "signature_missing";
      add({ code, severity: "blocker", group: "signatures", subject: t.ticketNumber, message: `Field ticket ${t.ticketNumber}: ${t.signature.reason}` });
    }
    if (t.unpresentedLines > 0) add({ code: "line_not_presented", severity: "blocker", group: "signatures", subject: t.ticketNumber, message: `Field ticket ${t.ticketNumber}: ${t.unpresentedLines} line(s) were never presented to the customer for acceptance` });
    if (t.disputedLines > 0) add({ code: "line_disputed", severity: "warning", group: "signatures", subject: t.ticketNumber, message: `Field ticket ${t.ticketNumber}: ${t.disputedLines} line(s) disputed by the customer — held out of billing until resolved` });
  }

  if (f.disposal.required) {
    if (f.disposal.tickets.length === 0) add({ code: "disposal_ticket_missing", severity: "blocker", group: "disposal", message: "The rate sheet bills disposal and no disposal ticket is on file for this job" });
    for (const d of f.disposal.tickets) {
      if (d.verificationStatus === "rejected" || d.verificationStatus === "needs_review") add({ code: "disposal_ticket_unverified", severity: "blocker", group: "disposal", subject: d.ticketNumber, message: `Disposal ticket ${d.ticketNumber} is ${d.verificationStatus.replace(/_/g, " ")}` });
      else if (d.verificationStatus === "unverified") add({ code: "disposal_ticket_unverified", severity: "warning", group: "disposal", subject: d.ticketNumber, message: `Disposal ticket ${d.ticketNumber} is not yet verified against the facility's record` });
    }
  }

  let billableCents = 0, remainingCents = 0;
  if (f.charges == null) add({ code: "charges_not_prepared", severity: "blocker", group: "charges", message: "Charges have not been prepared from the evidence yet" });
  else {
    const live = f.charges.filter(c => c.status === "ready" || c.status === "held" || c.status === "proposed");
    for (const c of live) {
      if (c.status === "held" && (c.pricingOutcome !== "priced" && c.pricingOutcome !== "manual")) add({ code: "charge_unpriced", severity: "blocker", group: "charges", subject: c.chargeRef, message: `Charge ${c.chargeRef} cannot be priced (${c.pricingOutcome.replace(/_/g, " ")}): ${c.reasons[c.reasons.length - 1] ?? "no rate"} — never guessed; resolve the rate or override with approval` });
      else if (c.status === "held") add({ code: "charge_unpriced", severity: "blocker", group: "charges", subject: c.chargeRef, message: `Charge ${c.chargeRef} is held` });
      if (c.status === "proposed" && c.sourceKind === "manual") add({ code: "manual_charge_pending", severity: "blocker", group: "charges", subject: c.chargeRef, message: `Manual charge ${c.chargeRef} awaits a second person's approval` });
      if (c.overrideStatus === "pending") add({ code: "charge_override_pending", severity: "blocker", group: "charges", subject: c.chargeRef, message: `Charge ${c.chargeRef} has an override awaiting approval` });
      if (f.commercial.available && c.currency !== f.commercial.currency) add({ code: "currency_mismatch", severity: "blocker", group: "charges", subject: c.chargeRef, message: `Charge ${c.chargeRef} is in ${c.currency}; the job bills in ${f.commercial.currency}` });
      if (c.status === "ready" && c.amountCents != null) {
        billableCents += c.amountCents;
        const remainingQty = (c.billableQuantityMillis ?? 0) - c.billedQuantityMillis;
        if (remainingQty > 0) remainingCents += c.amountCents - c.billedAmountCents;
        if (c.billedQuantityMillis > 0 && remainingQty > 0) add({ code: "partially_billed", severity: "warning", group: "charges", subject: c.chargeRef, message: `Charge ${c.chargeRef} is partly invoiced: ${(remainingQty / 1000).toFixed(3)} remains` });
      }
    }
    if (!live.some(c => c.status === "ready" && (c.billableQuantityMillis ?? 0) > c.billedQuantityMillis)) add({ code: "no_billable_amount", severity: "blocker", group: "charges", message: live.some(c => c.status === "ready") ? "Every ready charge is already invoiced" : "No charge is ready to bill" });
  }

  if (f.hold.active) add({ code: "billing_hold", severity: "blocker", group: "hold", message: `Billing is on hold: ${f.hold.reason ?? "no reason recorded"}` });

  const blockers = out.filter(i => i.severity === "blocker");
  const warnings = out.filter(i => i.severity === "warning");
  const first = (g: ReadinessIssue["group"]) => blockers.some(b => b.group === g);
  const suggestedState: WorkspaceState = blockers.length === 0 ? "ready"
    : first("commercial") ? "awaiting_commercial"
    : first("documents") ? "awaiting_documents"
    : first("signatures") ? "awaiting_signatures"
    : first("disposal") ? "awaiting_disposal"
    : "not_ready";
  const hash = canonicalHash({ jobId: f.jobId, blockers: blockers.map(b => [b.code, b.subject ?? null]), warnings: warnings.map(w => [w.code, w.subject ?? null]), billableCents });
  return { jobId: f.jobId, ready: blockers.length === 0, blockers, warnings, suggestedState, billableCents, remainingCents, hash };
}

/* ================================================================ charges */

/** How a ticket line's measurement method reads as the rate engine's measurement basis (linePricing's vocabulary). */
export const MEASUREMENT_TO_BASIS: Record<string, string> = { meter: "meter", scale: "certified_scale", loadsense_calibrated: "load_sensor", loadsense_uncalibrated: "load_sensor", gauge: "tank_calibration", estimate: "operator_estimate", customer_stated: "customer_measurement", system_timed: "clock", unknown: "manual_entry" };

/** A charge's status from what the engine could do with it. Only a priced charge is ready; everything else is held with its reason. */
export function chargeStatusFor(outcome: string, amountCents: number | null, billableQuantityMillis: number | null): { status: "ready" | "held"; holdReason: string | null } {
  if (outcome === "priced" && amountCents != null && billableQuantityMillis != null && billableQuantityMillis > 0) return { status: "ready", holdReason: null };
  if (outcome === "priced" && (billableQuantityMillis ?? 0) <= 0) return { status: "held", holdReason: "Zero billable quantity" };
  return { status: "held", holdReason: `Pricing ${outcome.replace(/_/g, " ")}` };
}

/** An override replaces the billing amount (and optionally the quantity) only once a second person approves; it may never fall below what is already invoiced. */
export function overrideCheck(args: { requestedByUserId: number; deciderUserId?: number; amountCents: number; quantityMillis: number | null; billedAmountCents: number; billedQuantityMillis: number; currentQuantityMillis: number | null }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.amountCents < 0) r.push("An override amount is never negative — a reduction after invoicing is a credit note");
  if (args.amountCents < args.billedAmountCents) r.push(`$${(args.billedAmountCents / 100).toFixed(2)} of this charge is already invoiced; the override cannot go below it`);
  const q = args.quantityMillis ?? args.currentQuantityMillis;
  if (q == null || q <= 0) r.push("An overridden charge bills a positive quantity");
  else if (q < args.billedQuantityMillis) r.push(`${(args.billedQuantityMillis / 1000).toFixed(3)} of this charge is already invoiced; the quantity cannot go below it`);
  if (args.deciderUserId != null && args.deciderUserId === args.requestedByUserId) r.push("The person who requested an override does not approve it");
  return { permitted: r.length === 0, refusals: r };
}

export type Sliceable = { billableQuantityMillis: number; amountCents: number; billedQuantityMillis: number; billedAmountCents: number };
/**
 * The next slice of a charge. `requestedMillis` null = everything remaining. The amount is proportional, and the
 * slice that finishes the charge takes the exact remainder, so the slices sum to the charge to the cent.
 */
export function sliceCharge(c: Sliceable, requestedMillis: number | null): { ok: true; quantityMillis: number; amountCents: number; completes: boolean } | { ok: false; reason: string } {
  const remainingQty = c.billableQuantityMillis - c.billedQuantityMillis;
  const remainingAmt = c.amountCents - c.billedAmountCents;
  if (remainingQty <= 0) return { ok: false, reason: "Nothing of this charge remains to invoice" };
  const q = requestedMillis ?? remainingQty;
  if (!Number.isInteger(q) || q <= 0) return { ok: false, reason: "A slice bills a positive whole number of thousandths" };
  if (q > remainingQty) return { ok: false, reason: `Requested ${(q / 1000).toFixed(3)} but only ${(remainingQty / 1000).toFixed(3)} remains unbilled` };
  if (q === remainingQty) return { ok: true, quantityMillis: q, amountCents: remainingAmt, completes: true };
  const amt = Math.round(c.amountCents * q / c.billableQuantityMillis);
  return { ok: true, quantityMillis: q, amountCents: Math.min(amt, remainingAmt), completes: false };
}

/* ================================================================ tax */

export type TaxDecision = { taxCode: string; taxRateBps: number; determined: boolean; reason: string };
/**
 * The tax a customer's invoice carries, from the customer's tax status (frozen in the commercial snapshot) and a
 * VERIFIED rate rule. A taxable customer with an unverified rate is not taxed at a remembered 5%: the invoice is
 * drafted UNDETERMINED and cannot be approved until the rate is verified (P9).
 */
export function taxDecision(args: { taxStatus: string; jurisdiction: string; rate: { outcome: "determined" | "unverified" | "missing"; ratePercent: number | null; kind?: string | null } }): TaxDecision {
  if (args.taxStatus === "exempt") return { taxCode: "EXEMPT", taxRateBps: 0, determined: true, reason: "Customer is tax-exempt" };
  if (args.taxStatus === "zero_rated") return { taxCode: "ZERO_RATED", taxRateBps: 0, determined: true, reason: "Customer's supply is zero-rated" };
  if (args.taxStatus !== "taxable") return { taxCode: "UNDETERMINED", taxRateBps: 0, determined: false, reason: "The customer's tax status is unknown — set it on the customer before approval" };
  if (args.rate.outcome !== "determined" || args.rate.ratePercent == null) return { taxCode: "UNDETERMINED", taxRateBps: 0, determined: false, reason: `The GST/HST rate for ${args.jurisdiction} is ${args.rate.outcome} — a taxable invoice is not approved on an unverified rate` };
  const bps = Math.round(args.rate.ratePercent * 100);
  return { taxCode: `${(args.rate.kind ?? "gst").toUpperCase()}-${args.jurisdiction}`, taxRateBps: bps, determined: true, reason: `${(args.rate.kind ?? "gst").toUpperCase()} ${args.rate.ratePercent}% for ${args.jurisdiction}` };
}
/** Tax on a line, half-up, integer arithmetic. */
export function lineTaxCents(amountCents: number, rateBps: number): number {
  if (rateBps === 0 || amountCents === 0) return 0;
  return Math.floor((amountCents * rateBps + 5_000) / 10_000);
}

/* ================================================================ invoice */

export type InvoiceStatus = "draft" | "in_review" | "approved" | "sent" | "viewed" | "disputed" | "partially_paid" | "paid" | "void";
export type InvoiceEvent = "submit" | "return" | "approve" | "issue" | "void";
const INV: Record<InvoiceEvent, { from: readonly InvoiceStatus[]; to: InvoiceStatus }> = {
  submit: { from: ["draft"], to: "in_review" },
  return: { from: ["in_review"], to: "draft" },
  approve: { from: ["in_review"], to: "approved" },
  issue: { from: ["approved"], to: "sent" },
  void: { from: ["draft", "in_review", "approved", "sent", "viewed", "disputed"], to: "void" },
};
/** Only these events move an invoice's workflow; AR states (partially_paid, paid, disputed) follow from AR records. */
export function invoiceTransition(from: string, event: InvoiceEvent): { ok: true; to: InvoiceStatus } | { ok: false; reason: string } {
  const t = INV[event];
  if (!(t.from as readonly string[]).includes(from)) return { ok: false, reason: `An invoice that is ${from.replace(/_/g, " ")} cannot be ${event === "issue" ? "issued" : event === "submit" ? "submitted for review" : event === "return" ? "returned to draft" : `${event}d`}` };
  return { ok: true, to: t.to };
}
/** Issued invoices are never rewritten: lines, amounts and tax change only while drafting. */
export const INVOICE_EDITABLE: readonly string[] = ["draft"];

/** Which checks approval needs, beyond the transition. */
export function approvalCheck(args: { submittedByUserId: number | null; draftedByUserId: number | null; approverUserId: number; taxCode: string | null; lineCount: number; totalCents: number; subtotalCents: number; taxCents: number; lineSumCents: number; lineTaxSumCents: number }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.lineCount === 0) r.push("The invoice has no lines");
  if (args.submittedByUserId === args.approverUserId) r.push("The person who submitted an invoice for review does not approve it");
  if (args.taxCode == null || args.taxCode === "UNDETERMINED") r.push("The invoice's tax is undetermined — verify the rate or the customer's tax status, then recalculate");
  if (args.lineSumCents !== args.subtotalCents) r.push(`Lines sum to ${args.lineSumCents} but the subtotal is ${args.subtotalCents}`);
  if (args.lineTaxSumCents !== args.taxCents) r.push(`Line tax sums to ${args.lineTaxSumCents} but the invoice tax is ${args.taxCents}`);
  if (args.subtotalCents + args.taxCents !== args.totalCents) r.push("Subtotal plus tax does not equal the total");
  return { permitted: r.length === 0, refusals: r };
}

/* ================================================================ receivables */

export type ArStatus = "open" | "partially_paid" | "paid" | "overdue" | "disputed" | "credit_pending" | "closed";
export type ReceivableInput = {
  totalCents: number; status: string; dueAt: Date | null; issuedAt: Date | null;
  /** Whether the invoice has been issued to the customer (see `isIssued`). Only an issued invoice is a receivable. */
  issued: boolean;
  netAllocatedCents: number; approvedCreditCents: number; pendingCreditCents: number; approvedAdjustmentCents: number;
  openDispute: boolean; asOf: Date;
};
export type Receivable = { originalCents: number; paidCents: number; creditedCents: number; adjustedCents: number; outstandingCents: number; dueAt: Date | null; daysOverdue: number; arStatus: ArStatus; bucket: AgingBucket | "disputed" | null };
export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
const DAY = 86_400_000;

/** Days past due, whole days, by the due date; 0 when not yet due or no due date. */
export function daysPastDue(dueAt: Date | null, asOf: Date): number {
  if (!dueAt) return 0;
  return Math.max(0, Math.floor((asOf.getTime() - dueAt.getTime()) / DAY));
}
/** Aging is by DUE date: current = not yet due; then 1–30, 31–60, 61–90 and 90+ days overdue. */
export function agingBucket(dueAt: Date | null, asOf: Date): AgingBucket {
  const d = daysPastDue(dueAt, asOf);
  return d === 0 ? "current" : d <= 30 ? "d1_30" : d <= 60 ? "d31_60" : d <= 90 ? "d61_90" : "d90_plus";
}
/** An invoice's receivable, derived — never stored and edited. Draft, in-review and void invoices are not receivables. */
export function receivable(i: ReceivableInput): Receivable {
  const paid = i.netAllocatedCents, credited = i.approvedCreditCents, adjusted = i.approvedAdjustmentCents;
  const outstanding = i.totalCents + adjusted - paid - credited;
  const issued = i.issued && i.status !== "void";
  const days = daysPastDue(i.dueAt, i.asOf);
  let s: ArStatus;
  if (i.status === "void") s = "closed";
  else if (outstanding <= 0) s = credited > 0 && paid === 0 ? "closed" : paid > 0 ? "paid" : "closed";
  else if (i.openDispute || i.status === "disputed") s = "disputed";
  else if (i.pendingCreditCents > 0) s = "credit_pending";
  else if (days > 0 && issued) s = "overdue";
  else if (paid > 0) s = "partially_paid";
  else s = "open";
  const bucket = !issued || outstanding <= 0 ? null : s === "disputed" ? "disputed" : agingBucket(i.dueAt, i.asOf);
  return { originalCents: i.totalCents, paidCents: paid, creditedCents: credited, adjustedCents: adjusted, outstandingCents: outstanding, dueAt: i.dueAt, daysOverdue: days, arStatus: s, bucket };
}
/**
 * Whether an invoice is issued. A billing invoice is issued by `issue` (status sent and after); a field-ticket
 * invoice (pre-0233) was issued by finalize, which set `issuedAt` with status approved.
 */
export function isIssued(i: { origin: string; status: string; issuedAt: Date | null }): boolean {
  if (i.status === "void" || i.status === "draft" || i.status === "in_review") return false;
  if (i.origin === "billing_charges") return i.status !== "approved";
  return i.issuedAt != null || i.status !== "approved";
}
/** The invoice status AR records imply, for an issued invoice. Disputes and voids are not decided here. */
export function invoiceStatusFromBalance(current: string, r: { outstandingCents: number; paidCents: number }, delivery: "approved" | "sent" | "viewed"): string {
  if (["draft", "in_review", "void", "disputed"].includes(current)) return current;
  if (r.outstandingCents <= 0) return "paid";
  if (r.paidCents > 0) return "partially_paid";
  return delivery;
}
/** Where an issued invoice stands in delivery, from its own timestamps (the state AR returns it to). */
export function deliveryState(i: { sentAt: Date | null; viewedAt: Date | null }): "approved" | "sent" | "viewed" {
  return i.viewedAt ? "viewed" : i.sentAt ? "sent" : "approved";
}
export type AgingRow = { key: string; outstandingCents: number; bucket: AgingBucket | "disputed" };
export function agingTotals(rows: readonly AgingRow[]): Record<AgingBucket | "disputed" | "total", number> {
  const t = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, disputed: 0, total: 0 };
  for (const r of rows) { t[r.bucket] += r.outstandingCents; t.total += r.outstandingCents; }
  return t;
}

/** Cash application: never across books, customers or currencies; never beyond the payment's unapplied amount or the invoice's outstanding balance. */
export function allocationCheck(args: {
  payment: { status: string; amountCents: number; netAllocatedCents: number; financialEntityId: number; customerAccountId: number | null; currency: string };
  invoice: { status: string; issued: boolean; outstandingCents: number; financialEntityId: number | null; customerAccountId: number | null; currency: string };
  amountCents: number;
}): { permitted: boolean; refusals: string[]; paymentUnappliedAfterCents: number; invoiceOutstandingAfterCents: number } {
  const r: string[] = [];
  const unapplied = args.payment.amountCents - args.payment.netAllocatedCents;
  if (args.payment.status === "reversed") r.push("The payment was reversed");
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) r.push("An allocation is a positive amount in cents");
  if (args.invoice.financialEntityId !== args.payment.financialEntityId) r.push("The payment and the invoice are in different books");
  if (args.invoice.customerAccountId == null || args.invoice.customerAccountId !== args.payment.customerAccountId) r.push("The payment and the invoice belong to different customers");
  if (args.invoice.currency !== args.payment.currency) r.push(`The payment is in ${args.payment.currency}; the invoice is in ${args.invoice.currency}`);
  if (!args.invoice.issued) r.push(`The invoice is ${args.invoice.status.replace(/_/g, " ")} — only an issued invoice is paid`);
  if (args.amountCents > unapplied) r.push(`Only ${unapplied} cents of the payment are unapplied`);
  if (args.amountCents > args.invoice.outstandingCents) r.push(`The invoice has only ${args.invoice.outstandingCents} cents outstanding — the rest stays unapplied on the payment`);
  return { permitted: r.length === 0, refusals: r, paymentUnappliedAfterCents: unapplied - args.amountCents, invoiceOutstandingAfterCents: args.invoice.outstandingCents - args.amountCents };
}
/** A credit note never takes an invoice below zero, counting the credits already pending. */
export function creditCheck(args: { invoiceStatus: string; issued: boolean; outstandingCents: number; pendingCreditCents: number; amountCents: number; requestedByUserId?: number; deciderUserId?: number; deciding: boolean }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (!args.issued) r.push(`The invoice is ${args.invoiceStatus.replace(/_/g, " ")} and not issued — a draft is corrected by recalculating it, an unissued invoice by voiding it; a credit note corrects an issued invoice`);
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) r.push("A credit is a positive amount in cents");
  const room = args.outstandingCents - (args.deciding ? 0 : args.pendingCreditCents);
  if (args.amountCents > room) r.push(`The credit of ${args.amountCents} cents exceeds the ${room} cents still outstanding${args.deciding ? "" : " after pending credits"}`);
  if (args.deciding && args.requestedByUserId === args.deciderUserId) r.push("The person who requested a credit does not approve it");
  return { permitted: r.length === 0, refusals: r };
}
export function adjustmentCheck(args: { invoiceStatus: string; issued: boolean; outstandingCents: number; amountCents: number; requestedByUserId?: number; deciderUserId?: number; deciding: boolean }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (!args.issued) r.push(`The invoice is ${args.invoiceStatus.replace(/_/g, " ")} — only an issued invoice's receivable is adjusted`);
  if (!Number.isInteger(args.amountCents) || args.amountCents === 0) r.push("An adjustment is a non-zero amount in cents");
  if (args.amountCents < 0 && -args.amountCents > args.outstandingCents) r.push("A reducing adjustment never takes the receivable below zero — that is a credit note");
  if (args.deciding && args.requestedByUserId === args.deciderUserId) r.push("The person who requested an adjustment does not approve it");
  return { permitted: r.length === 0, refusals: r };
}
export function disputeOpenCheck(args: { invoiceStatus: string; issued: boolean; outstandingCents: number; amountCents: number | null; lineAmountCents: number | null }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (!args.issued) r.push(`The invoice is ${args.invoiceStatus.replace(/_/g, " ")}; only an issued invoice is disputed`);
  if (args.amountCents != null) {
    if (args.amountCents <= 0) r.push("A disputed amount is positive");
    if (args.lineAmountCents != null && args.amountCents > args.lineAmountCents) r.push("The disputed amount exceeds the line");
    if (args.amountCents > args.outstandingCents) r.push("The disputed amount exceeds what is outstanding");
  }
  return { permitted: r.length === 0, refusals: r };
}

/* ================================================================ accounting boundary */

export function canonicalHash(payload: unknown): string {
  const canonical = (v: unknown): unknown => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
/** The export record for an external ledger: stable ids, integer cents, no customer-confidential provenance. */
export function exportPayload(kind: "invoice" | "payment" | "credit_note" | "adjustment" | "allocation", record: Record<string, unknown>): { payload: Record<string, unknown>; hash: string } {
  const payload = { schema: `leaseos-ar-export/1/${kind}`, ...record };
  return { payload, hash: canonicalHash(payload) };
}
export type SyncStatus = "pending" | "exported" | "failed" | "conflict" | "superseded";
export function syncTransition(from: SyncStatus, to: SyncStatus): boolean {
  const ok: Record<SyncStatus, readonly SyncStatus[]> = { pending: ["exported", "failed", "conflict", "superseded"], failed: ["pending", "exported", "failed", "conflict", "superseded"], conflict: ["pending", "exported", "superseded"], exported: ["superseded"], superseded: [] };
  return ok[from].includes(to);
}
