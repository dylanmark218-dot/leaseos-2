/**
 * v22.20 — money dates on a calendar that does not own them.
 */
import { describe, expect, it } from "vitest";
import {
  ageing, EventMisconfigured, obligationOf, projectFinancial, reaches,
  requestDateChange, validateEvent, type CompanyEvent, type FinancialProjection,
} from "./_core/financialCalendar";

const NOW = new Date("2026-10-20T09:00:00Z");
const src = (t: string, r: string) => ({ sourceType: t, sourceRef: r, generatedBy: "financial_projection" });

const invoice = (o: Partial<FinancialProjection> = {}): FinancialProjection => projectFinancial({
  kind: "ar_payment_due", at: new Date("2026-10-20T00:00:00Z"), label: "AR-421 due",
  amountCents: 482_17, counterparty: "a customer", severity: "due",
  owner: "customerInvoice", source: src("customerInvoice", "AR-421"), ...o,
});

describe("the calendar shows the date; it does not hold it", () => {
  it("marks every projection read-only, structurally", () => {
    expect(invoice().readOnly).toBe(true);
    // There is no shape of this type that can be written back.
    expect(Object.keys(invoice())).not.toContain("setAt");
  });

  it("refuses to move a date and names the workflow that can", () => {
    const r = requestDateChange(invoice());
    expect(r.applied).toBe(false);
    expect(r.sourceRef).toBe("AR-421");
    expect(r.workflow).toContain("accounts receivable");
    expect(r.reason).toContain("owns this date. The calendar shows it; it does not hold it");
  });

  it("names a different workflow for each kind of owner", () => {
    expect(requestDateChange(invoice({ owner: "vendorBill", source: src("vendorBill", "AP-887") })).workflow).toContain("accounts payable");
    expect(requestDateChange(invoice({ owner: "payrollPeriod", source: src("payrollPeriod", "PP-9") })).workflow).toContain("payroll configuration");
    expect(requestDateChange(invoice({ owner: "taxFiling", source: src("taxFiling", "GST-Q3") })).workflow).toContain("not ours to move");
  });

  it("keeps the reference so the event opens the invoice", () => {
    expect(invoice().source).toMatchObject({ sourceType: "customerInvoice", sourceRef: "AR-421" });
  });
});

describe("ageing comes from the invoice's own due date", () => {
  it("bands a receivable by how late it is", () => {
    expect(ageing(new Date("2026-11-30T00:00:00Z"), NOW)).toMatchObject({ band: "current", daysOverdue: 0 });
    expect(ageing(new Date("2026-10-25T00:00:00Z"), NOW)).toMatchObject({ band: "due_soon", daysOverdue: 0 });
    expect(ageing(new Date("2026-10-08T00:00:00Z"), NOW)).toMatchObject({ band: "overdue_1_30", daysOverdue: 12 });
    expect(ageing(new Date("2026-09-10T00:00:00Z"), NOW)).toMatchObject({ band: "overdue_31_60", daysOverdue: 40 });
    expect(ageing(new Date("2026-07-01T00:00:00Z"), NOW).band).toBe("overdue_61_plus");
  });

  it("reports no overdue days for something not yet due", () => {
    expect(ageing(new Date("2026-10-21T00:00:00Z"), NOW).daysOverdue).toBe(0);
  });
});

const event = (o: Partial<CompanyEvent> = {}): CompanyEvent => ({
  eventRef: "CE-1", title: "Safety stand-down", at: NOW, endsAt: null,
  eventClass: "requires_acknowledgement", audience: "company", audienceRef: null,
  source: src("companyEvent", "CE-1"), acknowledgementDueBy: new Date("2026-10-22T00:00:00Z"),
  taskTemplate: null, ...o,
});

describe("three kinds of company event, not one", () => {
  it("asks nothing of a social invitation", () => {
    const o = obligationOf(event({ title: "Christmas party", eventClass: "informational" }), [], 7);
    expect(o.obligation).toBe("none");
    expect(o.note).toContain("Nothing is required");
  });

  it("asks for a name against a safety stand-down, and stops once given", () => {
    const outstanding = obligationOf(event(), [], 7);
    expect(outstanding).toMatchObject({ obligation: "acknowledge", outstanding: true });
    expect(outstanding.obligation === "acknowledge" && outstanding.note).toContain("by 2026-10-22");

    const done = obligationOf(event(), [7], 7);
    expect(done).toMatchObject({ obligation: "acknowledge", outstanding: false });
  });

  it("raises work for a payroll cutoff rather than a note to read", () => {
    const o = obligationOf(event({ title: "Payroll cutoff", eventClass: "produces_task", taskTemplate: "complete_outstanding_paperwork" }), [], 7);
    expect(o).toMatchObject({ obligation: "task", template: "complete_outstanding_paperwork" });
    expect(o.note).toContain("raises work to complete");
  });
});

describe("an event that cannot do what its class claims is refused", () => {
  it("refuses a task event that names no task", () => {
    expect(() => validateEvent(event({ eventClass: "produces_task", taskTemplate: null })))
      .toThrow(EventMisconfigured);
  });

  it("refuses a scoped event that names no scope", () => {
    expect(() => validateEvent(event({ audience: "branch", audienceRef: null }))).toThrow(/names none/);
  });

  it("refuses a window that ends before it begins", () => {
    expect(() => validateEvent(event({ endsAt: new Date("2026-10-19T00:00:00Z") }))).toThrow(/ends before it begins/);
  });

  it("accepts a well-formed event of each class", () => {
    expect(() => validateEvent(event())).not.toThrow();
    expect(() => validateEvent(event({ eventClass: "informational" }))).not.toThrow();
    expect(() => validateEvent(event({ eventClass: "produces_task", taskTemplate: "t" }))).not.toThrow();
  });
});

describe("who an event reaches", () => {
  it("reaches everybody for a company event, and only its own branch or crew otherwise", () => {
    const person = { branchId: "B-NORTH", crewRef: "CREW-B" };
    expect(reaches(event(), person)).toBe(true);
    expect(reaches(event({ audience: "branch", audienceRef: "B-NORTH" }), person)).toBe(true);
    expect(reaches(event({ audience: "branch", audienceRef: "B-SOUTH" }), person)).toBe(false);
    expect(reaches(event({ audience: "crew", audienceRef: "CREW-B" }), person)).toBe(true);
    expect(reaches(event({ audience: "crew", audienceRef: "CREW-C" }), person)).toBe(false);
  });

  it("does not reach somebody with no branch when the event is scoped to one", () => {
    expect(reaches(event({ audience: "branch", audienceRef: "B-NORTH" }), { branchId: null, crewRef: null })).toBe(false);
  });
});
