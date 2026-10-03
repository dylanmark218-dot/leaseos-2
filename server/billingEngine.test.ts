import { describe, expect, it } from "vitest";
import {
  READINESS_STATES, WORKSPACE_STATES, adjustmentCheck, agingBucket, agingTotals, allocationCheck, approvalCheck, chargeStatusFor, creditCheck, daysPastDue, deliveryState, disputeOpenCheck,
  evaluateReadiness, exportPayload, invoiceStatusFromBalance, invoiceTransition, isIssued, lineTaxCents, overrideCheck, receivable, sliceCharge, syncTransition, taxDecision, workspaceTransition,
  type ReadinessFacts,
} from "./_core/billingEngine";

const signed = { state: "accepted", satisfied: true, reason: "Signed" };
const base = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  jobId: 7, jobCode: "J-7", jobStatus: "complete",
  commercial: { available: true, snapshotRef: "JCS-1", currency: "CAD", blockers: [] },
  tickets: [{ ticketNumber: "FT-1", status: "closed", signature: signed, lineCount: 2, disputedLines: 0, unpresentedLines: 0 }],
  disposal: { required: false, tickets: [] },
  charges: [{ chargeRef: "CHG-1", status: "ready", pricingOutcome: "priced", amountCents: 55_500, billableQuantityMillis: 3_000, billedQuantityMillis: 0, billedAmountCents: 0, overrideStatus: "none", sourceKind: "field_ticket_line", currency: "CAD", reasons: [] }],
  hold: { active: false, reason: null },
  ...over,
});

describe("the billing workspace moves only through its transition table", () => {
  it("names thirteen states and refuses an arbitrary jump", () => {
    expect(WORKSPACE_STATES).toHaveLength(13);
    expect(workspaceTransition("ready", "under_review").ok).toBe(true);
    expect(workspaceTransition("under_review", "approved_for_invoicing").ok).toBe(true);
    expect(workspaceTransition("approved_for_invoicing", "invoiced").ok).toBe(true);
    expect(workspaceTransition("not_ready", "invoiced")).toEqual({ ok: false, reason: "A job's billing cannot move from not_ready to invoiced" });
    expect(workspaceTransition("ready", "approved_for_invoicing").ok).toBe(false);   // review is not skipped
    expect(workspaceTransition("paid", "not_ready").ok).toBe(false);                 // an invoiced job never falls back before invoicing
    for (const s of READINESS_STATES) for (const t of READINESS_STATES) expect(workspaceTransition(s, t).ok).toBe(true);
  });
});

describe("evaluateBillingReadiness: hard blockers stop billing, warnings do not", () => {
  it("is ready on complete, signed, priced evidence — and deterministic", () => {
    const a = evaluateReadiness(base()), b = evaluateReadiness(base());
    expect(a).toMatchObject({ ready: true, blockers: [], suggestedState: "ready", billableCents: 55_500, remainingCents: 55_500 });
    expect(a.hash).toBe(b.hash);
  });
  it("names each missing thing with a machine code and a sentence, in close-out order", () => {
    const r = evaluateReadiness(base({ commercial: { available: false, reasons: ["The job's commercial basis has not been snapshotted; capture it before billing"] }, tickets: [], charges: null }));
    expect(r.blockers.map(b => b.code)).toEqual(["commercial_snapshot_missing", "no_field_ticket", "charges_not_prepared", ]);
    expect(r.suggestedState).toBe("awaiting_commercial");
    expect(r.blockers[0]!.message).toMatch(/snapshotted/);
  });
  it("signatures, disposal and charges each put the job in their own waiting state", () => {
    expect(evaluateReadiness(base({ tickets: [{ ticketNumber: "FT-1", status: "closed", signature: { state: "unsigned", satisfied: false, reason: "Ticket is not signed" }, lineCount: 1, disputedLines: 0, unpresentedLines: 0 }] }))).toMatchObject({ suggestedState: "awaiting_signatures", blockers: [{ code: "signature_missing" }] });
    expect(evaluateReadiness(base({ disposal: { required: true, tickets: [] } }))).toMatchObject({ suggestedState: "awaiting_disposal", blockers: [{ code: "disposal_ticket_missing" }] });
    expect(evaluateReadiness(base({ jobStatus: "on_site" }))).toMatchObject({ suggestedState: "awaiting_documents", blockers: [{ code: "job_not_complete" }] });
    const unpriced = evaluateReadiness(base({ charges: [{ chargeRef: "CHG-2", status: "held", pricingOutcome: "unknown_rate", amountCents: null, billableQuantityMillis: null, billedQuantityMillis: 0, billedAmountCents: 0, overrideStatus: "none", sourceKind: "field_ticket_line", currency: "CAD", reasons: ["No approved definition for VAC-HR"] }] }));
    expect(unpriced.blockers.map(b => b.code)).toEqual(["charge_unpriced", "no_billable_amount"]);
    expect(unpriced.blockers[0]!.message).toMatch(/never guessed/);
    expect(unpriced.suggestedState).toBe("not_ready");
  });
  it("a credit hold is a WARNING (work done is billed); a billing hold on the job is a blocker", () => {
    const credit = evaluateReadiness(base({ commercial: { available: true, snapshotRef: "JCS-1", currency: "CAD", blockers: [{ code: "account_on_hold", message: "Acme is on hold" }] } }));
    expect(credit.ready).toBe(true);
    expect(credit.warnings.map(w => w.code)).toEqual(["credit_hold"]);
    expect(evaluateReadiness(base({ hold: { active: true, reason: "Customer disputes the rate card" } }))).toMatchObject({ ready: false, blockers: [{ code: "billing_hold", message: "Billing is on hold: Customer disputes the rate card" }] });
  });
  it("a disputed line warns; an unpresented line blocks; a currency mismatch blocks", () => {
    const t = (d: number, u: number) => base({ tickets: [{ ticketNumber: "FT-1", status: "closed", signature: signed, lineCount: 3, disputedLines: d, unpresentedLines: u }] });
    expect(evaluateReadiness(t(1, 0))).toMatchObject({ ready: true, warnings: [{ code: "line_disputed" }] });
    expect(evaluateReadiness(t(0, 1)).blockers.map(b => b.code)).toEqual(["line_not_presented"]);
    expect(evaluateReadiness(base({ charges: [{ ...base().charges![0]!, currency: "USD" }] })).blockers.map(b => b.code)).toEqual(["currency_mismatch"]);
  });
  it("a fully invoiced job has nothing left; a partly invoiced one warns with what remains", () => {
    const c = base().charges![0]!;
    expect(evaluateReadiness(base({ charges: [{ ...c, billedQuantityMillis: 3_000, billedAmountCents: 55_500 }] })).blockers[0]).toMatchObject({ code: "no_billable_amount", message: "Every ready charge is already invoiced" });
    const part = evaluateReadiness(base({ charges: [{ ...c, billedQuantityMillis: 1_000, billedAmountCents: 18_500 }] }));
    expect(part).toMatchObject({ ready: true, remainingCents: 37_000, warnings: [{ code: "partially_billed" }] });
  });
});

describe("charges: priced or held, never guessed; overrides are a second person's", () => {
  it("only a priced charge with a positive quantity is ready", () => {
    expect(chargeStatusFor("priced", 100, 1000)).toEqual({ status: "ready", holdReason: null });
    expect(chargeStatusFor("unknown_rate", null, null)).toEqual({ status: "held", holdReason: "Pricing unknown rate" });
    expect(chargeStatusFor("conflict", null, null).status).toBe("held");
    expect(chargeStatusFor("priced", 0, 0)).toEqual({ status: "held", holdReason: "Zero billable quantity" });
  });
  it("an override never goes below what is invoiced, and the requester does not approve it", () => {
    const o = { requestedByUserId: 1, amountCents: 50_000, quantityMillis: 3_000, billedAmountCents: 0, billedQuantityMillis: 0, currentQuantityMillis: 3_000 };
    expect(overrideCheck(o).permitted).toBe(true);
    expect(overrideCheck({ ...o, deciderUserId: 1 }).refusals).toEqual(["The person who requested an override does not approve it"]);
    expect(overrideCheck({ ...o, billedAmountCents: 60_000 }).refusals[0]).toMatch(/already invoiced/);
    expect(overrideCheck({ ...o, amountCents: -1 }).refusals[0]).toMatch(/credit note/);
  });
});

describe("partial billing: slices sum to the charge to the cent", () => {
  it("three thirds of $100.00 are 33.33 + 33.33 + 33.34", () => {
    let c = { billableQuantityMillis: 3_000, amountCents: 10_000, billedQuantityMillis: 0, billedAmountCents: 0 };
    const out: number[] = [];
    for (let i = 0; i < 3; i++) { const s = sliceCharge(c, 1_000); if (!s.ok) throw new Error(s.reason); out.push(s.amountCents); c = { ...c, billedQuantityMillis: c.billedQuantityMillis + s.quantityMillis, billedAmountCents: c.billedAmountCents + s.amountCents }; }
    expect(out).toEqual([3_333, 3_333, 3_334]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(sliceCharge(c, 1)).toEqual({ ok: false, reason: "Nothing of this charge remains to invoice" });
  });
  it("refuses more than remains, a non-integer slice, and takes all that remains by default", () => {
    const c = { billableQuantityMillis: 2_500, amountCents: 46_250, billedQuantityMillis: 1_000, billedAmountCents: 18_500 };
    expect(sliceCharge(c, 2_000)).toMatchObject({ ok: false });
    expect(sliceCharge(c, 0.5)).toMatchObject({ ok: false });
    expect(sliceCharge(c, null)).toEqual({ ok: true, quantityMillis: 1_500, amountCents: 27_750, completes: true });
  });
});

describe("tax is explicit: a code, a rate in basis points, an amount — never a remembered 5%", () => {
  it("a taxable customer on an unverified rate is UNDETERMINED and cannot be approved", () => {
    expect(taxDecision({ taxStatus: "taxable", jurisdiction: "CA-AB", rate: { outcome: "unverified", ratePercent: null } })).toMatchObject({ taxCode: "UNDETERMINED", taxRateBps: 0, determined: false });
    expect(taxDecision({ taxStatus: "taxable", jurisdiction: "CA-AB", rate: { outcome: "determined", ratePercent: 5, kind: "gst" } })).toEqual({ taxCode: "GST-CA-AB", taxRateBps: 500, determined: true, reason: "GST 5% for CA-AB" });
    expect(taxDecision({ taxStatus: "exempt", jurisdiction: "CA-AB", rate: { outcome: "missing", ratePercent: null } })).toMatchObject({ taxCode: "EXEMPT", taxRateBps: 0, determined: true });
    expect(taxDecision({ taxStatus: "zero_rated", jurisdiction: "CA-AB", rate: { outcome: "missing", ratePercent: null } }).taxCode).toBe("ZERO_RATED");
    expect(taxDecision({ taxStatus: "unknown", jurisdiction: "CA-AB", rate: { outcome: "determined", ratePercent: 5 } }).determined).toBe(false);
  });
  it("rounds half up in integers", () => {
    expect(lineTaxCents(55_500, 500)).toBe(2_775);
    expect(lineTaxCents(10, 500)).toBe(1);        // 0.5 → 1
    expect(lineTaxCents(9, 500)).toBe(0);         // 0.45 → 0
    expect(lineTaxCents(12_345, 1_300)).toBe(1_605);
    expect(lineTaxCents(1_000, 0)).toBe(0);
  });
});

describe("the invoice workflow: draft → review → approved → issued; corrections are not rewrites", () => {
  it("moves by event only", () => {
    expect(invoiceTransition("draft", "submit")).toEqual({ ok: true, to: "in_review" });
    expect(invoiceTransition("in_review", "approve")).toEqual({ ok: true, to: "approved" });
    expect(invoiceTransition("approved", "issue")).toEqual({ ok: true, to: "sent" });
    expect(invoiceTransition("in_review", "return")).toEqual({ ok: true, to: "draft" });
    expect(invoiceTransition("draft", "approve").ok).toBe(false);
    expect(invoiceTransition("draft", "issue").ok).toBe(false);
    expect(invoiceTransition("paid", "void").ok).toBe(false);
    expect(invoiceTransition("sent", "submit").ok).toBe(false);
  });
  it("approval is a second person's, on determined tax and totals that add up", () => {
    const ok = { submittedByUserId: 1, draftedByUserId: 1, approverUserId: 2, taxCode: "GST-CA-AB", lineCount: 1, totalCents: 105, subtotalCents: 100, taxCents: 5, lineSumCents: 100, lineTaxSumCents: 5 };
    expect(approvalCheck(ok).permitted).toBe(true);
    expect(approvalCheck({ ...ok, approverUserId: 1 }).refusals).toEqual(["The person who submitted an invoice for review does not approve it"]);
    expect(approvalCheck({ ...ok, taxCode: "UNDETERMINED" }).refusals[0]).toMatch(/tax is undetermined/);
    expect(approvalCheck({ ...ok, lineSumCents: 99 }).permitted).toBe(false);
  });
  it("issued means issued: a billing invoice by issue; a field-ticket invoice by finalize's issuedAt", () => {
    expect(isIssued({ origin: "billing_charges", status: "approved", issuedAt: null })).toBe(false);
    expect(isIssued({ origin: "billing_charges", status: "sent", issuedAt: new Date() })).toBe(true);
    expect(isIssued({ origin: "field_ticket", status: "approved", issuedAt: new Date() })).toBe(true);
    expect(isIssued({ origin: "field_ticket", status: "draft", issuedAt: null })).toBe(false);
    expect(isIssued({ origin: "field_ticket", status: "void", issuedAt: new Date() })).toBe(false);
  });
});

describe("receivables are derived, aged by due date", () => {
  const asOf = new Date("2026-10-01T12:00:00Z");
  const due = (daysAgo: number) => new Date(asOf.getTime() - daysAgo * 86_400_000);
  it("buckets: not yet due is current; then 1–30, 31–60, 61–90, 90+", () => {
    expect(agingBucket(due(-5), asOf)).toBe("current");
    expect(agingBucket(due(0), asOf)).toBe("current");
    expect(agingBucket(due(1), asOf)).toBe("d1_30");
    expect(agingBucket(due(30), asOf)).toBe("d1_30");
    expect(agingBucket(due(31), asOf)).toBe("d31_60");
    expect(agingBucket(due(61), asOf)).toBe("d61_90");
    expect(agingBucket(due(91), asOf)).toBe("d90_plus");
    expect(daysPastDue(null, asOf)).toBe(0);
  });
  it("original − paid − credited ± adjusted = outstanding, with the status that follows", () => {
    const r0 = { totalCents: 105_000, status: "sent", dueAt: due(10), issuedAt: due(40), issued: true, netAllocatedCents: 0, approvedCreditCents: 0, pendingCreditCents: 0, approvedAdjustmentCents: 0, openDispute: false, asOf };
    expect(receivable(r0)).toMatchObject({ outstandingCents: 105_000, arStatus: "overdue", bucket: "d1_30", daysOverdue: 10 });
    expect(receivable({ ...r0, netAllocatedCents: 50_000, dueAt: due(-1) })).toMatchObject({ outstandingCents: 55_000, arStatus: "partially_paid", bucket: "current" });
    expect(receivable({ ...r0, netAllocatedCents: 100_000, approvedCreditCents: 5_000 })).toMatchObject({ outstandingCents: 0, arStatus: "paid", bucket: null });
    expect(receivable({ ...r0, approvedAdjustmentCents: 2_500 })).toMatchObject({ outstandingCents: 107_500, adjustedCents: 2_500 });
    expect(receivable({ ...r0, openDispute: true })).toMatchObject({ arStatus: "disputed", bucket: "disputed" });
    expect(receivable({ ...r0, pendingCreditCents: 1_000, dueAt: due(-3) }).arStatus).toBe("credit_pending");
    expect(receivable({ ...r0, approvedCreditCents: 105_000 }).arStatus).toBe("closed");
    expect(receivable({ ...r0, issued: false, status: "approved" }).bucket).toBeNull();
  });
  it("totals by bucket", () => {
    expect(agingTotals([{ key: "a", outstandingCents: 100, bucket: "current" }, { key: "b", outstandingCents: 50, bucket: "d90_plus" }, { key: "c", outstandingCents: 7, bucket: "disputed" }])).toEqual({ current: 100, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 50, disputed: 7, total: 157 });
  });
  it("the invoice's status follows its balance and returns to its delivery state on reversal", () => {
    expect(invoiceStatusFromBalance("sent", { outstandingCents: 0, paidCents: 10 }, "sent")).toBe("paid");
    expect(invoiceStatusFromBalance("sent", { outstandingCents: 5, paidCents: 10 }, "sent")).toBe("partially_paid");
    expect(invoiceStatusFromBalance("paid", { outstandingCents: 15, paidCents: 0 }, "viewed")).toBe("viewed");
    expect(invoiceStatusFromBalance("disputed", { outstandingCents: 0, paidCents: 15 }, "sent")).toBe("disputed");
    expect(deliveryState({ sentAt: new Date(), viewedAt: null })).toBe("sent");
  });
});

describe("cash application, credits, adjustments and disputes refuse what would be wrong", () => {
  const pay = { status: "unapplied", amountCents: 100_000, netAllocatedCents: 0, financialEntityId: 1, customerAccountId: 9, currency: "CAD" };
  const inv = { status: "sent", issued: true, outstandingCents: 60_000, financialEntityId: 1, customerAccountId: 9, currency: "CAD" };
  it("never across books, customers or currencies; never beyond the payment or the invoice", () => {
    expect(allocationCheck({ payment: pay, invoice: inv, amountCents: 60_000 })).toMatchObject({ permitted: true, paymentUnappliedAfterCents: 40_000, invoiceOutstandingAfterCents: 0 });
    expect(allocationCheck({ payment: pay, invoice: inv, amountCents: 60_001 }).refusals[0]).toMatch(/only 60000 cents outstanding/);
    expect(allocationCheck({ payment: { ...pay, netAllocatedCents: 90_000 }, invoice: inv, amountCents: 20_000 }).refusals).toEqual(["Only 10000 cents of the payment are unapplied"]);
    expect(allocationCheck({ payment: pay, invoice: { ...inv, customerAccountId: 8 }, amountCents: 1 }).refusals).toEqual(["The payment and the invoice belong to different customers"]);
    expect(allocationCheck({ payment: pay, invoice: { ...inv, financialEntityId: 2 }, amountCents: 1 }).refusals[0]).toMatch(/different books/);
    expect(allocationCheck({ payment: pay, invoice: { ...inv, currency: "USD" }, amountCents: 1 }).refusals[0]).toMatch(/USD/);
    expect(allocationCheck({ payment: pay, invoice: { ...inv, issued: false, status: "approved" }, amountCents: 1 }).refusals[0]).toMatch(/only an issued invoice is paid/);
    expect(allocationCheck({ payment: { ...pay, status: "reversed" }, invoice: inv, amountCents: 1 }).refusals).toContain("The payment was reversed");
  });
  it("a credit never takes an invoice below zero, counting pending credits; the requester does not approve it", () => {
    expect(creditCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 10_000, pendingCreditCents: 4_000, amountCents: 6_000, deciding: false }).permitted).toBe(true);
    expect(creditCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 10_000, pendingCreditCents: 4_000, amountCents: 6_001, deciding: false }).permitted).toBe(false);
    expect(creditCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 10_000, pendingCreditCents: 0, amountCents: 5_000, requestedByUserId: 3, deciderUserId: 3, deciding: true }).refusals).toEqual(["The person who requested a credit does not approve it"]);
    expect(creditCheck({ invoiceStatus: "draft", issued: false, outstandingCents: 10_000, pendingCreditCents: 0, amountCents: 1, deciding: false }).refusals[0]).toMatch(/credit note corrects an issued invoice/);
  });
  it("an adjustment is non-zero and never below zero; a dispute names an amount it can hold", () => {
    expect(adjustmentCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 100, amountCents: 2_500, deciding: false }).permitted).toBe(true);
    expect(adjustmentCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 100, amountCents: -101, deciding: false }).refusals[0]).toMatch(/credit note/);
    expect(disputeOpenCheck({ invoiceStatus: "sent", issued: true, outstandingCents: 1_000, amountCents: 500, lineAmountCents: 400 }).refusals).toEqual(["The disputed amount exceeds the line"]);
    expect(disputeOpenCheck({ invoiceStatus: "draft", issued: false, outstandingCents: 1_000, amountCents: null, lineAmountCents: null }).permitted).toBe(false);
  });
});

describe("the accounting boundary: stable, hashed, idempotent", () => {
  it("the same fact hashes the same regardless of key order; the export's states move one way", () => {
    expect(exportPayload("invoice", { a: 1, b: 2 }).hash).toBe(exportPayload("invoice", { b: 2, a: 1 }).hash);
    expect(exportPayload("invoice", { a: 1 }).hash).not.toBe(exportPayload("payment", { a: 1 }).hash);
    expect(syncTransition("pending", "exported")).toBe(true);
    expect(syncTransition("failed", "pending")).toBe(true);
    expect(syncTransition("exported", "pending")).toBe(false);
    expect(syncTransition("superseded", "exported")).toBe(false);
  });
});
