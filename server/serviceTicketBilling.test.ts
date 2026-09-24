/**
 * 0175 CP5 — the open-ticket billing lifecycle: pure decisions.
 */
import { describe, expect, it } from "vitest";
import { BILLING_STATES, type BillingState } from "../drizzle/schema";
import { billingTransition, composeFinalSnapshot, finalizeCheck, hashOf, lineWritePermitted, ticketTotals, versionCheck } from "./_core/serviceTicketBilling";

describe("the billing state machine", () => {
  it("walks the intended path and refuses every other step by name", () => {
    const step = (from: BillingState, a: Parameters<typeof billingTransition>[1]) => { const r = billingTransition(from, a); return r.ok ? r.to : `refused: ${r.reason}`; };
    expect(step("DRAFT", "open")).toBe("OPEN");
    expect(step("OPEN", "present")).toBe("AWAITING_CUSTOMER_REVIEW");
    expect(step("AWAITING_CUSTOMER_REVIEW", "accept")).toBe("CUSTOMER_ACCEPTED");
    expect(step("AWAITING_CUSTOMER_REVIEW", "dispute")).toBe("DISPUTED");
    expect(step("DISPUTED", "present")).toBe("AWAITING_CUSTOMER_REVIEW");
    expect(step("DISPUTED", "reopen")).toBe("OPEN");
    expect(step("CUSTOMER_ACCEPTED", "finalize")).toBe("FINALIZED");
    expect(step("FINALIZED", "invoice")).toBe("INVOICED");
    expect(step("INVOICED", "invoice_voided")).toBe("FINALIZED");
    expect(step("OPEN", "void")).toBe("VOID");
    // Refused, named.
    expect(step("DRAFT", "accept")).toMatch(/^refused: A ticket that is draft cannot be accepted/);
    expect(step("DRAFT", "finalize")).toMatch(/cannot be finalized/);
    expect(step("INVOICED", "void")).toMatch(/cannot be voided/);
    expect(step("INVOICED", "reopen")).toMatch(/cannot be reopened/);
    expect(step("VOID", "open")).toMatch(/cannot be opened/);
    expect(step("FINALIZED", "reopen")).toMatch(/cannot be reopened/);
    // Idempotent where it is safe.
    expect(billingTransition("OPEN", "open")).toEqual({ ok: true, to: "OPEN", changed: false });
    expect(billingTransition("FINALIZED", "finalize")).toEqual({ ok: true, to: "FINALIZED", changed: false });
    // Every state is in the table.
    for (const s of BILLING_STATES) expect(typeof billingTransition(s, "void").ok).toBe("boolean");
  });
  it("lets the office finalize an unaccepted ticket only by name and with a reason", () => {
    expect(finalizeCheck({ state: "CUSTOMER_ACCEPTED", withoutCustomerAcceptance: false, reason: null, lineCount: 2 })).toEqual({ permitted: true, refusals: [], overrides: null });
    const silent = finalizeCheck({ state: "AWAITING_CUSTOMER_REVIEW", withoutCustomerAcceptance: false, reason: null, lineCount: 2 });
    expect(silent.permitted).toBe(false);
    expect(silent.refusals[0]).toMatch(/customer has not accepted/);
    expect(finalizeCheck({ state: "DISPUTED", withoutCustomerAcceptance: true, reason: "  ", lineCount: 2 }).refusals).toEqual(["Finalizing without customer acceptance needs a reason"]);
    expect(finalizeCheck({ state: "DISPUTED", withoutCustomerAcceptance: true, reason: "Customer confirmed by phone, R. Patel, 2026-09-24", lineCount: 2 })).toMatchObject({ permitted: true, overrides: "Customer confirmed by phone, R. Patel, 2026-09-24" });
    expect(finalizeCheck({ state: "CUSTOMER_ACCEPTED", withoutCustomerAcceptance: false, reason: null, lineCount: 0 }).refusals).toEqual(["A ticket with no lines has nothing to finalize"]);
    expect(finalizeCheck({ state: "OPEN", withoutCustomerAcceptance: true, reason: "x", lineCount: 1 }).refusals[0]).toMatch(/cannot be finalized/);
  });
  it("permits line writes while the customer has not accepted a hash, and never once the ticket is frozen", () => {
    expect(["DRAFT", "OPEN", "AWAITING_CUSTOMER_REVIEW", "DISPUTED"].map(s => lineWritePermitted(s as BillingState).permitted)).toEqual([true, true, true, true]);
    expect(lineWritePermitted("CUSTOMER_ACCEPTED").reason).toMatch(/reopen it before changing a line/);
    expect(lineWritePermitted("FINALIZED").reason).toMatch(/an amendment, never an edit/);
    expect(lineWritePermitted("INVOICED").reason).toMatch(/a credit against the invoice/);
    expect(lineWritePermitted("VOID").permitted).toBe(false);
    expect(versionCheck(null, 7).ok).toBe(true);
    expect(versionCheck(7, 7).ok).toBe(true);
    expect(versionCheck(6, 7)).toEqual({ ok: false, reason: "The ticket changed since you read it (version 6 → 7) — reload and try again" });
  });
  it("derives totals every time: customer figures count only customer-visible priced lines", () => {
    const t = ticketTotals([
      { customerVisible: true, priced: true, amountCents: 83_250 },
      { customerVisible: true, priced: true, amountCents: 18_500 },
      { customerVisible: false, priced: true, amountCents: 4_110 },
      { customerVisible: true, priced: false, amountCents: null },
      { customerVisible: true, priced: true, amountCents: -5_000, amendsLineId: 1 },
    ]);
    expect(t).toEqual({ subtotalCents: 100_860, customerSubtotalCents: 96_750, internalCents: 4_110, pricedLines: 4, unpricedLines: 1, visibleLines: 4, amendmentLines: 1 });
  });
  it("freezes the same lines to the same hash, and a changed line or a superseded predecessor to a different one", () => {
    const lines = [{ id: 1, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "h", customerVisible: true, disposition: "accepted", pricingDecisionRef: "PR-1", amountCents: 83_250, amendsLineId: null }];
    const base = { kind: "final" as const, ticketNumber: "FT-1", billingVersion: 5, lines, siteSnapshotHash: "s".repeat(64), signaturePayloadHash: "s".repeat(64), supersedesRevisionHash: null, finalizedWithoutCustomerAcceptance: null, at: "2026-09-24T14:00:00.000Z" };
    const a = composeFinalSnapshot(base); const b = composeFinalSnapshot({ ...base, lines: [...lines] });
    expect(a.hash).toBe(b.hash);
    expect(a.snapshot.billing.subtotalCents).toBe(83_250);
    expect(composeFinalSnapshot({ ...base, lines: [{ ...lines[0]!, amountCents: 83_251 }] }).hash).not.toBe(a.hash);
    expect(composeFinalSnapshot({ ...base, kind: "amendment", supersedesRevisionHash: a.hash }).hash).not.toBe(a.hash);
    expect(hashOf({ b: 1, a: 2 })).toBe(hashOf({ a: 2, b: 1 }));
  });
});
