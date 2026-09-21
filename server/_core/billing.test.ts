import { describe, expect, it } from "vitest";
import {
  calculateChargeLines,
  evaluateBillingReadiness,
  type BillingReadinessInput,
} from "./billing";

const READY: BillingReadinessInput = {
  tripsTotal: 3,
  tripsComplete: 3,
  loadsTotal: 3,
  loadTicketsPresent: 3,
  disposalTicketsVerified: 3,
  disposalTicketsRequired: 3,
  unconfirmedValues: 0,
  dailyLogsComplete: true,
  fieldTicketStatus: "accepted",
  afeOrPoPresent: true,
  rateCardAssigned: true,
  customerSignatureRequired: true,
  amendmentsAfterSignature: 0,
};

const codes = (i: BillingReadinessInput) =>
  evaluateBillingReadiness(i).blockers.map(b => b.code);

describe("evaluateBillingReadiness", () => {
  it("approves a job with everything in place", () => {
    const r = evaluateBillingReadiness(READY);
    expect(r.state).toBe("approved");
    expect(r.billable).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.completionPercent).toBe(100);
  });

  it("never bills from an unconfirmed inference", () => {
    const r = evaluateBillingReadiness({ ...READY, unconfirmedValues: 2 });
    expect(r.billable).toBe(false);
    expect(codes({ ...READY, unconfirmedValues: 2 })).toContain(
      "unconfirmed_values"
    );
  });

  it("blocks when cost coding is absent, because the customer's AP will reject it", () => {
    const r = evaluateBillingReadiness({ ...READY, afeOrPoPresent: false });
    expect(r.billable).toBe(false);
    expect(r.blockers.find(b => b.code === "no_cost_coding")?.severity).toBe(
      "blocking"
    );
  });

  it("blocks an unsigned field ticket when signature is required", () => {
    expect(codes({ ...READY, fieldTicketStatus: "missing" })).toContain(
      "field_ticket_unsigned"
    );
    expect(codes({ ...READY, fieldTicketStatus: "presented" })).toContain(
      "field_ticket_pending"
    );
  });

  it("treats a refusal as reviewable, not as a hard block", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      fieldTicketStatus: "refused",
    });
    expect(r.billable).toBe(true);
    expect(r.state).toBe("billing_review");
    expect(r.blockers[0].severity).toBe("review");
  });

  it("lets accepted lines bill while disputed ones wait", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      fieldTicketStatus: "partially_accepted",
      disputedLineCount: 1,
    });
    expect(r.billable).toBe(true);
    expect(r.state).toBe("billing_review");
    expect(r.blockers[0].code).toBe("lines_disputed");
    expect(r.blockers[0].label).toContain("1 line(s) disputed");
  });

  it("flags a ticket with no representative on site for office follow-up", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      fieldTicketStatus: "no_representative",
    });
    expect(r.blockers[0].code).toBe("no_rep_onsite");
    expect(r.blockers[0].severity).toBe("review");
  });

  it("ignores signature state entirely when the customer does not require one", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      customerSignatureRequired: false,
      fieldTicketStatus: "missing",
    });
    expect(r.blockers).toEqual([]);
  });

  it("flags edits made after the customer signed", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      amendmentsAfterSignature: 2,
    });
    expect(codes({ ...READY, amendmentsAfterSignature: 2 })).toContain(
      "amended_after_signature"
    );
    expect(r.state).toBe("billing_review");
  });

  it("names every missing item rather than reporting 'incomplete'", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      loadTicketsPresent: 1,
      disposalTicketsVerified: 0,
      dailyLogsComplete: false,
      afeOrPoPresent: false,
    });
    expect(r.blockers.length).toBe(4);
    expect(r.blockers.every(b => b.label.length > 0)).toBe(true);
  });

  it("advances state through the gates as documents arrive", () => {
    expect(evaluateBillingReadiness({ ...READY, tripsComplete: 1 }).state).toBe(
      "draft"
    );
    expect(
      evaluateBillingReadiness({ ...READY, loadTicketsPresent: 1 }).state
    ).toBe("operations_complete");
    expect(
      evaluateBillingReadiness({ ...READY, disposalTicketsVerified: 0 }).state
    ).toBe("documents_complete");
    expect(
      evaluateBillingReadiness({ ...READY, dailyLogsComplete: false }).state
    ).toBe("disposal_verified");
  });

  it("reports partial completion honestly", () => {
    const r = evaluateBillingReadiness({
      ...READY,
      disposalTicketsVerified: 0,
      dailyLogsComplete: false,
    });
    expect(r.completionPercent).toBeGreaterThan(0);
    expect(r.completionPercent).toBeLessThan(100);
  });
});

describe("calculateChargeLines", () => {
  const sources = [
    {
      description: "Vac truck — hourly",
      quantity: 4.6,
      unit: "h",
      rateCents: 18500,
      derivedFrom: "TR-2026-004821",
      verified: true,
    },
    {
      description: "Disposal — liquid",
      quantity: 8.7,
      unit: "m³",
      rateCents: 4200,
      derivedFrom: "DT-2026-004821-01",
      verified: true,
    },
    {
      description: "Standby",
      quantity: 0.75,
      unit: "h",
      rateCents: 12500,
      derivedFrom: "TR-2026-004821 wait",
      verified: false,
    },
  ];

  it("shows its arithmetic on every line", () => {
    const { lines } = calculateChargeLines(sources);
    expect(lines[0].math).toBe("4.6 h × 185.00 = 851.00");
    expect(lines[0].amountCents).toBe(85100);
  });

  it("excludes unverified sources instead of quietly billing them", () => {
    const { lines, excluded, subtotalCents } = calculateChargeLines(sources);
    expect(lines).toHaveLength(2);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].description).toBe("Standby");
    expect(subtotalCents).toBe(85100 + 36540);
  });

  it("keeps every line traceable to its source record", () => {
    const { lines } = calculateChargeLines(sources);
    expect(lines.every(l => l.derivedFrom.length > 0)).toBe(true);
  });
});

/**
 * P3.2 — the permission half of "accepted lines flow to billing when customer config permits."
 *
 * Found by auditing this row against its original definition. The engine answered "accepted lines
 * may still be billed" for every customer on every ticket; the customer's contract was never
 * consulted, because there was no term to consult.
 */
describe("whether accepted lines may bill is the customer's contract to decide", () => {
  const partially = (partialAcceptanceBillable?: boolean | null) =>
    evaluateBillingReadiness({ ...READY, fieldTicketStatus: "partially_accepted", disputedLineCount: 2, partialAcceptanceBillable } as unknown as BillingReadinessInput);

  const dispute = (r: ReturnType<typeof evaluateBillingReadiness>) => r.blockers.find(b => b.code === "lines_disputed")!;

  it("says the terms permit it when they do", () => {
    expect(dispute(partially(true)).label).toMatch(/this customer's terms permit billing the accepted lines/);
  });

  it("says the whole ticket is required when the terms say so", () => {
    // Billing part of a disputed ticket against such a customer is a dispute generator and
    // arguably a breach.
    expect(dispute(partially(false)).label).toMatch(/require the whole ticket accepted before any of it bills/);
  });

  it("treats an unrecorded term as unrecorded, not as permission", () => {
    // "We never asked" and "the contract allows it" are different facts, and only one of them is a
    // reason to send an invoice.
    for (const unset of [undefined, null]) {
      const label = dispute(partially(unset)).label;
      expect(label).toMatch(/nobody has recorded whether this customer's terms allow billing the accepted lines/);
      expect(label).not.toMatch(/permit billing/);
    }
  });

  it("keeps the finding at review in every case, since none of them is a clean pass", () => {
    for (const v of [true, false, null, undefined]) expect(dispute(partially(v)).severity).toBe("review");
  });
});
