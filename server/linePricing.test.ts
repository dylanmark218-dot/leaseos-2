/**
 * v22.8 — The paths that bill write the decision they reference.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { normaliseUnit, MEASUREMENT_BASIS } from "./_core/linePricing";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

describe("the line vocabulary maps onto the pricing vocabulary, and nothing else", () => {
  it("normalises units and measurement methods, and refuses what it does not know", () => {
    expect(normaliseUnit("hrs")).toBe("hour");
    expect(normaliseUnit("m³")).toBe("m3");
    expect(normaliseUnit("T")).toBe("tonne");
    expect(normaliseUnit("bbl")).toBeNull();                                             // barrels are not in the vocabulary: no silent conversion
    expect(MEASUREMENT_BASIS.scale).toBe("certified_scale");
    expect(MEASUREMENT_BASIS.estimate).toBe("operator_estimate");
    expect(MEASUREMENT_BASIS.system_timed).toBe("clock");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 4_700_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a field-ticket line is priced as it is recorded", () => {
  it("writes the decision, keeps the line a fact, records an unknown rate without stopping the field, and names the blockers", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = 4_800_000 + Math.floor(Math.random() * 90_000);
    // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [entityId, `FE-${entityId}`, `entity ${entityId}`]);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const cs = callerFor(office).commercialSetup;
    const rate = await cs.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 320_000, minimumQuantityMillis: 4_000, billingIncrementMillis: 250, scopeLevel: "customer_contract", customerAccountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "ABC MSA §4.2" });
    await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: rate.definitionRef });
    const c = callerFor(driver).closeout;
    const [fixtureUnit260] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId: Number(job.insertId), customerAccountRef: acctRef, unitId: fixtureUnit260.insertId, operatorId: 7, serviceDescription: "Hydrovac daylighting" });
    const priced = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "hydrovac", description: "Truck time", quantity: 7.133, quantityUnit: "hrs", measurementMethod: "system_timed" });
    expect(priced.pricing).toMatchObject({ outcome: "priced", amountCents: 232_000 });          // 7.133 → 7.25 h × $320
    const [line] = await pool.execute<mysql.RowDataPacket[]>("SELECT quantity, quantityUnit, serviceCode, pricingDecisionRef FROM fieldTicketLines WHERE id = ?", [priced.lineId]);
    expect(Number(line[0].quantity)).toBe(7.133);                                             // the line keeps the fact
    expect(line[0].pricingDecisionRef).toBe((priced.pricing as { decisionRef: string }).decisionRef);
    const unknown = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "extra_hose", description: "Additional 20 m hose", quantity: 1, quantityUnit: "each", measurementMethod: "customer_stated" });
    expect(unknown.pricing).toMatchObject({ outcome: "unknown_rate", amountCents: null });     // recorded, not refused
    expect((unknown.pricing as { reasons: string[] }).reasons.at(-1)).toContain("RATE UNKNOWN");
    const noUnit = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "load", serviceCode: "hydrovac", description: "Slurry", quantity: 12, quantityUnit: "bbl", measurementMethod: "gauge" });
    expect(noUnit.pricing).toEqual({ skipped: 'unit "bbl" is not in the pricing vocabulary' });
    const plain = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "Note to office", measurementMethod: "unknown" });
    expect(plain.pricing).toEqual({ skipped: "no service named" });
    const view = await cs.ticketPricing({ ticketNumber: t.ticketNumber });
    expect(view.pricedCents).toBe(232_000);
    expect(view.lines.find(l => l.lineId === priced.lineId)).toMatchObject({ outcome: "priced", billableQuantityMillis: 7_250, scopeLevel: "customer_contract" });
    expect(view.blockers).toHaveLength(3);
    expect(view.blockers.find(b => b.includes("Additional 20 m hose"))).toContain("UNKNOWN RATE");
    expect(view.blockers.find(b => b.includes("Note to office"))).toContain("no service named");
  });
});

d("a vendor bill line is priced against the agreed payable", () => {
  it("records the decision and the variance per unit, and lists the lines that do not match", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const entityId = 4_900_000 + Math.floor(Math.random() * 90_000);
    // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [entityId, `FE-${entityId}`, `entity ${entityId}`]);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const vendorRef = key("VEN").slice(0, 40);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?, 'XYZ Vac Services', 'subcontractor', 'active')", [vendorRef]);
    const cs = callerFor(office).commercialSetup;
    const std = await cs.definitionPropose({ financialEntityId: entityId, rateKind: "vendor_payable", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 210_000, scopeLevel: "company", vendorRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human" });
    const abc = await cs.definitionPropose({ financialEntityId: entityId, rateKind: "vendor_payable", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 225_000, scopeLevel: "customer_contract", customerAccountRef: acctRef, vendorRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "XYZ subcontract, ABC schedule" });
    for (const r of [std, abc]) await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: r.definitionRef });
    const bill = await callerFor(office).vendor.billRecord({ financialEntityId: entityId, vendorId: Number(ven.insertId), vendorInvoiceNumber: key("XYZ").slice(0, 40), invoiceDate: new Date("2026-09-10T00:00:00Z"), serviceDate: new Date("2026-09-09T00:00:00Z"), customerAccountRef: acctRef, subtotal: 2_400, taxAmount: 120, total: 2_520, lines: [
      { lineNo: 1, lineType: "labour", serviceCode: "hydrovac", unit: "hr", description: "Hydrovac 10 h", quantity: 10, unitPrice: 240, amount: 2_400 },
      { lineNo: 2, lineType: "tax", description: "GST", quantity: 1, unitPrice: 120, amount: 120 },
    ] });
    expect(bill.rateVariances).toEqual([expect.objectContaining({ lineNo: 1, serviceCode: "hydrovac", billedUnitPriceCents: 24_000, agreedRateCents: 22_500, varianceCents: 1_500, outcome: "priced" })]);   // billed $240 against the ABC-specific $225
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT serviceCode, pricingDecisionRef, rateVarianceCents FROM vendorBillLines WHERE vendorBillId = (SELECT id FROM vendorBills WHERE billRef = ?) AND lineNo = 1", [bill.billRef]);
    expect(row[0]).toMatchObject({ serviceCode: "hydrovac", rateVarianceCents: 1_500 });
    const decision = await cs.decisionGet({ decisionRef: row[0].pricingDecisionRef });
    expect(decision).toMatchObject({ rateKind: "vendor_payable", subjectKind: "vendor_bill_line", scopeLevel: "customer_contract", amountCents: 225_000 });   // what is owed at the agreed rate, beside what was billed
    const variances = await cs.vendorRateVariances({ financialEntityId: entityId, vendorRef });
    expect(variances.variances).toEqual([expect.objectContaining({ billRef: bill.billRef, lineNo: 1, varianceCents: 1_500 })]);
    const exact = await callerFor(office).vendor.billRecord({ financialEntityId: entityId, vendorId: Number(ven.insertId), vendorInvoiceNumber: key("XYZ").slice(0, 40), invoiceDate: new Date("2026-09-11T00:00:00Z"), customerAccountRef: acctRef, subtotal: 225, taxAmount: 0, total: 225, lines: [{ lineNo: 1, lineType: "labour", serviceCode: "hydrovac", unit: "hr", description: "Hydrovac 1 h", quantity: 1, unitPrice: 225, amount: 225 }] });
    expect(exact.rateVariances[0]).toMatchObject({ varianceCents: 0 });
    const after = await cs.vendorRateVariances({ financialEntityId: entityId, vendorRef });
    expect(after.variances.map(v => v.billRef)).toEqual([bill.billRef]);                       // the exact line is not a variance
  });
});
