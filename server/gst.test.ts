import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { buildGstReturn, finalizeDecision, gstPeriodBounds, type PurchaseRecord, type SaleRecord } from "./_core/gstReturn";
import { GST_RATE_SEEDS } from "./_core/gstSeeds";
import { determine } from "./_core/taxRuleEngine";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const Q = "2026-Q3";
const at = (iso: string) => new Date(iso);
const sale = (over: Partial<SaleRecord> & { ref: string }): SaleRecord => ({ issuedAt: at("2026-08-10T00:00:00Z"), subtotalCents: 100_000, taxCents: 5_000, treatment: "taxable", jurisdiction: "CA-AB", entityAssigned: true, ...over });
const buy = (over: Partial<PurchaseRecord> & { ref: string }): PurchaseRecord => ({ kind: "vendor_bill", date: at("2026-08-12T00:00:00Z"), subtotalCents: 40_000, taxCents: 2_000, hasEvidence: true, treatment: "taxable", ...over });
const unknownRate = (j: string) => determine(GST_RATE_SEEDS, { jurisdiction: j, ruleType: "gst_hst_rate", asOf: at("2026-07-01T00:00:00Z") }) as never;
const verified = (pct: number) => (_j: string) => ({ outcome: "determined" as const, parameters: { ratePercent: pct } });
const registered = { registered: true, identifierPresent: true };

describe("periods", () => {
  it("accepts a quarter or a month", () => {
    expect(gstPeriodBounds("2026-Q3").end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(gstPeriodBounds("2026-08").start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(() => gstPeriodBounds("Q3")).toThrow(/2026-Q3/);
  });
});

describe("the lines are facts; the rate is a check", () => {
  it("assembles 101, 105, 108 and 109 from invoices and evidenced purchases", () => {
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5),
      sales: [sale({ ref: "INV-1" }), sale({ ref: "INV-2", subtotalCents: 50_000, taxCents: 0, treatment: "zero_rated" }), sale({ ref: "INV-old", issuedAt: at("2026-06-30T00:00:00Z") })],
      purchases: [buy({ ref: "BILL-1" }), buy({ ref: "FUEL-1", kind: "fuel", taxCents: 1_500 })],
      adjustments: [] });
    expect(r.lines).toEqual({ line101SalesCents: 150_000, line105CollectedCents: 5_000, line104AdjustmentsCents: 0, line108ItcCents: 3_500, line107AdjustmentsCents: 0, line109NetTaxCents: 1_500 });
    expect(r.rateCheck).toEqual({ status: "checked", jurisdiction: "CA-AB", ratePercent: 5, salesChecked: 1, salesDiffering: 0 });
    expect(r.determination).toBe("ready");
  });

  it("withholds input tax credits without evidence, and names each", () => {
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5), sales: [sale({ ref: "INV-1" })], purchases: [buy({ ref: "BILL-1" }), buy({ ref: "EXP-9", kind: "expense", taxCents: 300, hasEvidence: false })], adjustments: [] });
    expect(r.lines.line108ItcCents).toBe(2_000);
    expect(r.itc).toEqual({ claimedCents: 2_000, withheldNoEvidenceCents: 300, withheldNotRegisteredCents: 0, purchasesWithEvidence: 1, purchasesWithout: 1 });
    expect(r.exceptions.map(e => [e.code, e.subject])).toEqual([["itc_withheld_no_evidence", "EXP-9"]]);
    expect(r.determination).toBe("review");
  });

  it("claims nothing when the company is not registered, and says the return may not be theirs to file", () => {
    const none = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: null, rateFor: verified(5), sales: [sale({ ref: "INV-1" })], purchases: [buy({ ref: "BILL-1" })], adjustments: [] });
    expect(none.lines.line108ItcCents).toBe(0);
    expect(none.itc.withheldNotRegisteredCents).toBe(2_000);
    expect(none.determination).toBe("blocked");
    expect(none.exceptions.find(e => e.code === "not_registered")!.detail).toContain("may not be a return this entity files");
  });

  it("blocks on an unclassified sale and on tax charged on an exempt one; reviews a taxable sale with no tax", () => {
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5), sales: [sale({ ref: "A", treatment: "unknown" }), sale({ ref: "B", treatment: "exempt", taxCents: 500 }), sale({ ref: "C", taxCents: 0 })], purchases: [], adjustments: [] });
    expect(r.exceptions.map(e => [e.code, e.severity])).toEqual([["sale_treatment_unknown", "blocking"], ["tax_charged_on_untaxable_sale", "blocking"], ["no_tax_on_taxable_sale", "review"]]);
    expect(r.determination).toBe("blocked");
  });

  it("checks collected tax against a verified rate and names the sale that differs", () => {
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5), sales: [sale({ ref: "OK" }), sale({ ref: "OFF", taxCents: 4_000 })], purchases: [], adjustments: [] });
    expect(r.rateCheck.salesDiffering).toBe(1);
    expect(r.exceptions[0]).toEqual({ code: "collected_tax_differs_from_rate", severity: "review", subject: "OFF", detail: "Invoiced $40.00 tax; 5% of $1000.00 is $50.00" });
  });

  it("reports line 105 as invoiced and unchecked on the seeded, unverified rate — it does not invent five percent", () => {
    expect(GST_RATE_SEEDS.every(s => s.status === "unverified" && s.parameters.ratePercent === null)).toBe(true);
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: unknownRate, sales: [sale({ ref: "INV-1", taxCents: 4_000 })], purchases: [], adjustments: [] });
    expect(r.lines.line105CollectedCents).toBe(4_000);
    expect(r.rateCheck.status).toBe("unverified");
    expect(r.rateCheck.salesChecked).toBe(0);
    expect(r.exceptions.map(e => e.code)).toEqual(["rate_unverified"]);
    expect(r.determination).toBe("review");
  });

  it("applies adjustments to net tax and turns a negative into a refund figure", () => {
    const r = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5), sales: [sale({ ref: "INV-1" })], purchases: [buy({ ref: "B", taxCents: 9_000 })], adjustments: [{ ref: "A1", line: "104", amountCents: 250, reason: "r" }, { ref: "A2", line: "107", amountCents: 100, reason: "r" }] });
    expect(r.lines.line109NetTaxCents).toBe(5_000 + 250 - 9_000 - 100); // −3,850: a refund
  });
});

describe("finalizing", () => {
  it("refuses blocking items outright, and review items until each is acknowledged by code", () => {
    const blocked = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: verified(5), sales: [sale({ ref: "A", treatment: "unknown" })], purchases: [], adjustments: [] });
    expect(finalizeDecision(blocked, ["sale_treatment_unknown"]).permitted).toBe(false);
    const review = buildGstReturn({ period: Q, jurisdiction: "CA-AB", registration: registered, rateFor: unknownRate, sales: [sale({ ref: "A" })], purchases: [buy({ ref: "B", hasEvidence: false })], adjustments: [] });
    const d1 = finalizeDecision(review, []);
    expect(d1.permitted).toBe(false);
    expect(d1.unacknowledged.sort()).toEqual(["itc_withheld_no_evidence", "rate_unverified"]);
    expect(finalizeDecision(review, ["rate_unverified", "itc_withheld_no_evidence"]).permitted).toBe(true);
  });
});

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who classifies, who prepares, who finalizes", () => {
  it("keeps finalizing to the tax preparer and controller", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "gst.finalize" }).allowed).sort()).toEqual(["controller", "tax_preparer"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "gst.classify" }).allowed).sort()).toEqual(["bookkeeper", "controller", "office"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 1_300_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a quarter's GST/HST, through the ledger", () => {
  it("assembles the return, blocks on an unclassified sale, withholds an ITC without evidence, prepares a snapshot, and finalizes only when acknowledged by another person", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const preparer = await withRole("tax_preparer");
    const entityId = 1_400_000 + Math.floor(Math.random() * 90_000);
    await pool.execute("INSERT INTO taxRegistrations (financialEntityId, registrationType, jurisdiction, registered, registeredAt, identifierPresent) VALUES (?, 'gst_hst', 'CA', 1, '2020-01-01 00:00:00', 1)", [entityId]);
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, 'Acme', 'invoiced', NOW(), NOW(), NOW())", [key("BB").slice(0, 40)]);
    const bookId = Number(book.insertId);
    const inv1 = key("INV").slice(0, 40), inv2 = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, '2026-08-05 00:00:00', ?, 1, 'Acme', 100000, 5000, 105000, 'CAD', 'sent')", [inv1, entityId, bookId]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, '2026-08-20 00:00:00', ?, 1, 'Acme', 20000, 0, 20000, 'CAD', 'sent')", [inv2, entityId, bookId]);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'tires')", [key("V").slice(0, 60)]);
    const bill1 = key("BILL").slice(0, 40), bill2 = key("BILL").slice(0, 40);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, subtotalCents, taxAmountCents, totalCents, matchOutcome, status, evidenceRecordId) VALUES (?, ?, ?, ?, '2026-08-11 00:00:00', NOW(), 40000, 2000, 42000, 'match', 'ready_to_pay', 1)", [bill1, entityId, Number(ven.insertId), key("VI").slice(0, 40)]);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?, ?, ?, ?, '2026-09-02 00:00:00', NOW(), 10000, 500, 10500, 'unmatched', 'missing_receipt')", [bill2, entityId, Number(ven.insertId), key("VI").slice(0, 40)]);

    // Unclassified sales block. The bookkeeper classifies both; the zero-rated one had no tax, correctly.
    const r1 = await callerFor(bookkeeper).gst.return({ financialEntityId: entityId, period: Q, jurisdiction: "CA-AB" });
    expect(r1.determination).toBe("blocked");
    expect(r1.exceptions.filter(e => e.code === "sale_treatment_unknown").map(e => e.subject).sort()).toEqual([inv1, inv2].sort());
    await callerFor(bookkeeper).gst.treatmentSet({ kind: "invoice", ref: inv1, treatment: "taxable", source: "invoice_terms" });
    await callerFor(bookkeeper).gst.treatmentSet({ kind: "invoice", ref: inv2, treatment: "zero_rated", source: "customer_status" });
    const r2 = await callerFor(bookkeeper).gst.return({ financialEntityId: entityId, period: Q, jurisdiction: "CA-AB" });
    expect(r2.determination).toBe("review");
    expect(r2.lines.line101SalesCents).toBe(120_000);
    expect(r2.lines.line105CollectedCents).toBe(5_000);
    expect(r2.lines.line108ItcCents).toBe(2_000);              // the evidenced bill; the receiptless one withheld
    expect(r2.itc.withheldNoEvidenceCents).toBe(500);
    expect(r2.lines.line109NetTaxCents).toBe(3_000);
    expect(r2.rateCheck.status).toBe("unverified");             // the seeded rate — five percent is not invented
    expect(r2.exceptions.map(e => e.code).filter(c => c !== "sales_unassigned_excluded").sort()).toEqual(["itc_withheld_no_evidence", "rate_unverified"]);

    // An adjustment with a reason, then a snapshot. The preparer may not finalize their own; another person must acknowledge each review item.
    await callerFor(bookkeeper).gst.adjustmentRecord({ financialEntityId: entityId, period: Q, line: "104", amountCents: 250, reason: "Recaptured ITC on a personal-use vehicle" });
    const prep = await callerFor(bookkeeper).gst.returnPrepare({ financialEntityId: entityId, period: Q, jurisdiction: "CA-AB" });
    expect(prep.determination).toBe("review");
    expect(prep.netTaxCents).toBe(3_250);
    await expect(callerFor(bookkeeper).gst.returnFinalize({ returnRef: prep.returnRef, acknowledgeReviewItems: ["rate_unverified", "itc_withheld_no_evidence"] })).rejects.toBeTruthy();
    await expect(callerFor(preparer).gst.returnFinalize({ returnRef: prep.returnRef, acknowledgeReviewItems: ["rate_unverified"] })).rejects.toThrow(/not acknowledged:.*itc_withheld_no_evidence/);
    // Other companies' unassigned invoices in this database are excluded and named; the filer acknowledges that too.
    const ack = ["rate_unverified", "itc_withheld_no_evidence", "sales_unassigned_excluded"];
    const fin = await callerFor(preparer).gst.returnFinalize({ returnRef: prep.returnRef, acknowledgeReviewItems: ack });
    expect(fin.status).toBe("finalized");
    expect(fin.netTaxCents).toBe(3_250);
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, reviewItemsAcknowledged, netTaxCents FROM gstReturns WHERE returnRef = ?", [prep.returnRef]);
    expect(row[0].status).toBe("finalized");
    expect(JSON.parse(row[0].reviewItemsAcknowledged)).toEqual(ack);

    // The ledger moves: a receipt arrives for the withheld bill. A new preparation supersedes; finalizing it amends the old one.
    await pool.execute("UPDATE vendorBills SET evidenceRecordId = 2, status = 'ready_to_pay', matchOutcome = 'match' WHERE billRef = ?", [bill2]);
    const prep2 = await callerFor(bookkeeper).gst.returnPrepare({ financialEntityId: entityId, period: Q, jurisdiction: "CA-AB" });
    expect(prep2.netTaxCents).toBe(2_750);
    expect(prep2.supersedes).not.toBeNull();
    await callerFor(preparer).gst.returnFinalize({ returnRef: prep2.returnRef, acknowledgeReviewItems: ["rate_unverified", "sales_unassigned_excluded"] });
    const [old] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM gstReturns WHERE returnRef = ?", [prep.returnRef]);
    expect(old[0].status).toBe("amended");

    // Period close at quarter end asks for the return, and is satisfied.
    const close = await callerFor(bookkeeper).period.readiness({ financialEntityId: entityId, period: "2026-09" });
    expect(close.findings.some(f => f.code === "gst_return_not_finalized")).toBe(false);
  });
});
