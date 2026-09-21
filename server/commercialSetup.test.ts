import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { applyIncrement, goLiveReadiness, poExposure, priceQuantity, projectDecision, rateSheetGaps, resolveRate, simulateMargin, type ChargeDefinition } from "./_core/rateResolution";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

let seq = 1;
const def = (o: Partial<ChargeDefinition> & Pick<ChargeDefinition, "scopeLevel">): ChargeDefinition => ({
  id: seq, definitionRef: `CHG-${seq++}`, rateKind: "sell", serviceCode: "hydrovac", resourceClass: null, unitId: null, pricingMethod: "per_unit", unit: "hour", rateMillis: 325_000, flatCents: null, basisPoints: null, multiplierMillis: null,
  minimumQuantityMillis: null, minimumChargeCents: null, billingIncrementMillis: null, roundingMode: "nearest", measurementBasis: "any", conditionKey: null,
  customerAccountId: null, vendorId: null, projectRef: null, siteRef: null, contractRef: null, jobId: null, branchCode: null,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null, approvalStatus: "approved", version: 1, sourceClause: null, sourceKind: "human", ...o,
});
const at = new Date("2026-09-10T12:00:00Z");

describe("the resolver never picks something close", () => {
  const company = def({ scopeLevel: "company", rateMillis: 275_000 });
  const abc = def({ scopeLevel: "customer_contract", customerAccountId: 7, rateMillis: 255_000, sourceClause: "MSA §4.2" });
  const horizon = def({ scopeLevel: "project_site", customerAccountId: 7, projectRef: "HORIZON", rateMillis: 265_000 });
  const job = def({ scopeLevel: "job_override", customerAccountId: 7, jobId: 8812, rateMillis: 285_000, sourceKind: "negotiated" });
  it("resolves the most specific approved definition and says why", () => {
    const r = resolveRate([company, abc, horizon, job], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 7, projectRef: "HORIZON", jobId: 8812 });
    expect(r.outcome === "resolved" && r.definition.rateMillis).toBe(285_000);
    expect(r.outcome === "resolved" && r.scopeLevel).toBe("job_override");
    const r2 = resolveRate([company, abc, horizon, job], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 7, projectRef: "HORIZON", jobId: 9000 });
    expect(r2.outcome === "resolved" && r2.definition.rateMillis).toBe(265_000);                 // a different job: the project rate
    const r3 = resolveRate([company, abc, horizon, job], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 7 });
    expect(r3.outcome === "resolved" && r3.definition.rateMillis).toBe(255_000);                 // no project: the contract
    const r4 = resolveRate([company, abc, horizon, job], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 9 });
    expect(r4.outcome === "resolved" && r4.definition.rateMillis).toBe(275_000);                 // another customer: company standard
    expect(r4.reasons[0]).toContain("Resolved at company");
  });
  it("answers UNKNOWN when nothing applies, and a proposal prices nothing", () => {
    expect(resolveRate([abc], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 9 }).outcome).toBe("unknown");
    const proposed = def({ scopeLevel: "company", approvalStatus: "proposed" });
    const r = resolveRate([proposed], { rateKind: "sell", serviceCode: "hydrovac", at });
    expect(r.outcome).toBe("unknown");
    expect(r.reasons[0]).toContain("proposed definition(s) apply but are not approved");
    expect(resolveRate([company], { rateKind: "sell", serviceCode: "septic_pumping", at }).outcome).toBe("unknown");
  });
  it("reports a CONFLICT when two approved definitions sit at the same level", () => {
    const po = def({ scopeLevel: "po_afe", customerAccountId: 7, rateMillis: 325_000 });
    const po2 = def({ scopeLevel: "po_afe", customerAccountId: 7, rateMillis: 310_000 });
    const r = resolveRate([company, po, po2], { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 7 });
    expect(r.outcome).toBe("conflict");
    expect(r.outcome === "conflict" && r.candidates.map(c => c.rateMillis)).toEqual([325_000, 310_000]);
  });
  it("reproduces history: a December job prices at the 2026 rate after the 2027 rate supersedes it", () => {
    const r2026 = def({ scopeLevel: "company", rateMillis: 300_000, effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2027-01-01T00:00:00Z"), approvalStatus: "superseded" });
    const r2027 = def({ scopeLevel: "company", rateMillis: 325_000, effectiveFrom: new Date("2027-01-01T00:00:00Z"), version: 2 });
    const feb = resolveRate([r2026, r2027], { rateKind: "sell", serviceCode: "hydrovac", at: new Date("2027-02-01T00:00:00Z") });
    expect(feb.outcome === "resolved" && feb.definition.rateMillis).toBe(325_000);
    const dec = resolveRate([r2026, r2027], { rateKind: "sell", serviceCode: "hydrovac", at: new Date("2026-12-15T00:00:00Z") });
    expect(dec.outcome === "resolved" && dec.definition.rateMillis).toBe(300_000);                 // superseded, but in effect in December
    const expired = resolveRate([r2026], { rateKind: "sell", serviceCode: "hydrovac", at: new Date("2027-02-01T00:00:00Z") });
    expect(expired.outcome).toBe("unknown");
  });
  it("keeps vendor payables apart from sell rates and lets a vendor carry customer-specific rates", () => {
    const std = def({ scopeLevel: "company", rateKind: "vendor_payable", vendorId: 3, rateMillis: 210_000 });
    const forAbc = def({ scopeLevel: "customer_contract", rateKind: "vendor_payable", vendorId: 3, customerAccountId: 7, rateMillis: 225_000 });
    const forSite = def({ scopeLevel: "project_site", rateKind: "vendor_payable", vendorId: 3, customerAccountId: 7, siteRef: "10-22", rateMillis: 235_000 });
    const emergency = def({ scopeLevel: "company", rateKind: "vendor_payable", vendorId: 3, conditionKey: "emergency", rateMillis: 260_000 });
    const all = [company, abc, std, forAbc, forSite, emergency];
    expect((resolveRate(all, { rateKind: "vendor_payable", serviceCode: "hydrovac", at, vendorId: 3 }) as { definition: ChargeDefinition }).definition.rateMillis).toBe(210_000);
    expect((resolveRate(all, { rateKind: "vendor_payable", serviceCode: "hydrovac", at, vendorId: 3, customerAccountId: 7 }) as { definition: ChargeDefinition }).definition.rateMillis).toBe(225_000);
    expect((resolveRate(all, { rateKind: "vendor_payable", serviceCode: "hydrovac", at, vendorId: 3, customerAccountId: 7, siteRef: "10-22" }) as { definition: ChargeDefinition }).definition.rateMillis).toBe(235_000);
    expect((resolveRate(all, { rateKind: "vendor_payable", serviceCode: "hydrovac", at, vendorId: 3, conditionKey: "emergency" }) as { definition: ChargeDefinition }).definition.rateMillis).toBe(260_000);
    expect(resolveRate(all, { rateKind: "vendor_payable", serviceCode: "hydrovac", at, vendorId: 4 }).outcome).toBe("unknown");     // another vendor: no rate
    expect((resolveRate(all, { rateKind: "sell", serviceCode: "hydrovac", at, customerAccountId: 7, vendorId: 3 }) as { definition: ChargeDefinition }).definition.rateKind).toBe("sell");
  });
});

describe("pricing keeps what was measured and says what was billed", () => {
  it("applies the increment and the minimum in the record, not to the measurement", () => {
    const d = def({ scopeLevel: "company", rateMillis: 310_000, minimumQuantityMillis: 4_000, billingIncrementMillis: 250, sourceClause: "MSA §3.1" });
    const res = resolveRate([d], { rateKind: "sell", serviceCode: "hydrovac", at });
    const short = priceQuantity(res, { quantityMillis: 2_500, unit: "hour", measurementSource: "clock" });
    expect(short).toMatchObject({ outcome: "priced", billableQuantityMillis: 4_000, minimumApplied: true, amountCents: 124_000 });
    expect(short.inputs.measuredQuantityMillis).toBe(2_500);
    expect(short.reasons).toContain("Minimum 4 hour per MSA §3.1: 2.5 raised to 4");
    const long = priceQuantity(res, { quantityMillis: 7_133, unit: "hour", measurementSource: "clock" });   // 7 h 08 min
    expect(long).toMatchObject({ billableQuantityMillis: 7_250, incrementApplied: true, minimumApplied: false, amountCents: 224_750 });
    expect(applyIncrement(7_133, 500, "up").billableMillis).toBe(7_500);
    expect(applyIncrement(7_133, 500, "down").billableMillis).toBe(7_000);
  });
  it("refuses to convert units without a sourced rule, and records the rule when one is supplied", () => {
    const perTonne = def({ scopeLevel: "company", serviceCode: "dirt_hauling", unit: "tonne", rateMillis: 14_500, measurementBasis: "certified_scale" });
    const res = resolveRate([perTonne], { rateKind: "sell", serviceCode: "dirt_hauling", at });
    const refused = priceQuantity(res, { quantityMillis: 18_000, unit: "m3", measurementSource: "certified_scale" });
    expect(refused.outcome).toBe("conversion_review");
    expect(refused.reasons.at(-1)).toContain("CONVERSION REQUIRES REVIEW");
    const converted = priceQuantity(res, { quantityMillis: 18_000, unit: "m3", measurementSource: "certified_scale", conversion: { fromUnit: "m3", toUnit: "tonne", factorMillis: 1_600, source: "Contract schedule C: clay 1.6 t/m³", material: "clay" } });
    expect(converted).toMatchObject({ outcome: "priced", billableQuantityMillis: 28_800, amountCents: 41_760 });
    expect(converted.inputs.conversion).toMatchObject({ factorMillis: 1_600, source: "Contract schedule C: clay 1.6 t/m³" });
    const estimate = priceQuantity(res, { quantityMillis: 28_800, unit: "tonne", measurementSource: "operator_estimate" });
    expect(estimate.outcome).toBe("measurement_review");                                               // the contract accepts a certified scale
  });
  it("prices pass-through disposal at cost plus markup and applies a minimum charge", () => {
    const markup = def({ scopeLevel: "customer_contract", customerAccountId: 7, serviceCode: "disposal_passthrough", pricingMethod: "percentage_markup", unit: "none", rateMillis: null, basisPoints: 1_200 });
    const r = priceQuantity(resolveRate([markup], { rateKind: "sell", serviceCode: "disposal_passthrough", at, customerAccountId: 7 }), { quantityMillis: 1_000, unit: "none", measurementSource: "facility_ticket", passThroughCents: 84_000 });
    expect(r).toMatchObject({ outcome: "priced", amountCents: 94_080, formula: "passThrough($840.00) + 12%" });
    const none = priceQuantity(resolveRate([markup], { rateKind: "sell", serviceCode: "disposal_passthrough", at, customerAccountId: 7 }), { quantityMillis: 1_000, unit: "none", measurementSource: "facility_ticket" });
    expect(none.outcome).toBe("unknown_rate");
    const septic = def({ scopeLevel: "company", serviceCode: "septic_removal", unit: "m3", rateMillis: 42_000, minimumChargeCents: 65_000 });
    const small = priceQuantity(resolveRate([septic], { rateKind: "sell", serviceCode: "septic_removal", at }), { quantityMillis: 3_000, unit: "m3", measurementSource: "tank_calibration" });
    expect(small).toMatchObject({ amountCents: 65_000, minimumApplied: true });
  });
  it("shows the customer the sell price only, the vendor its payable only, and management the spread", () => {
    expect(projectDecision("customer", { sellCents: 310_000, vendorCents: 225_000, internalCostCents: 198_000 })).toEqual({ sellCents: 310_000 });
    expect(projectDecision("vendor", { sellCents: 310_000, vendorCents: 225_000, internalCostCents: 198_000 })).toEqual({ vendorCents: 225_000 });
    expect(projectDecision("management", { sellCents: 310_000, vendorCents: 225_000, internalCostCents: 198_000 })).toMatchObject({ sellCents: 310_000, vendorCents: 225_000, marginCents: 85_000 });
    expect(projectDecision("customer", { sellCents: 310_000, vendorCents: 225_000, internalCostCents: null, openBook: true })).toMatchObject({ vendorCents: 225_000, marginCents: 85_000 });
  });
});

describe("guardrails, purchase orders, gaps and readiness", () => {
  const guardrails = { targetMarginBps: 3_000, warningMarginBps: 2_000, minimumAuthorityMarginBps: 1_500, discountAuthority: { sales: 2_500, management: 2_000, controller: 0 } };
  it("bands a proposed price and names who must approve it", () => {
    const ok = simulateMargin({ sellCents: 2_304_000, costCents: 1_588_000, guardrails, roles: ["sales"] });
    expect(ok).toMatchObject({ band: "target", approvalRequired: null });
    expect(ok.marginBps).toBe(3_108);
    const low = simulateMargin({ sellCents: 2_124_000, costCents: 1_588_000, guardrails, roles: ["sales"] });   // $295/h: 25.2% → warning; sales floor 25%
    expect(low.band).toBe("warning");
    expect(low.approvalRequired).toBeNull();
    const lower = simulateMargin({ sellCents: 1_980_000, costCents: 1_588_000, guardrails, roles: ["sales"] });  // 19.8%: below warning; management floor 20% → controller
    expect(lower.band).toBe("below_minimum");
    expect(lower.approvalRequired).toBe("controller");
    expect(simulateMargin({ sellCents: 100, costCents: null, guardrails, roles: ["management"] }).band).toBe("unknown");
  });
  it("warns before a PO is overrun and names the overrun", () => {
    const e = poExposure({ authorizedCents: 5_000_000, billedCents: 3_820_000, committedCents: 0, estimateCents: 1_540_000, validTo: null, at });
    expect(e).toMatchObject({ status: "overrun", overrunCents: 360_000 });
    expect(e.reasons[0]).toContain("Projected PO overrun: $3600.00");
    expect(poExposure({ authorizedCents: 5_000_000, billedCents: 1_000_000, committedCents: 0, estimateCents: 500_000, validTo: null, at }).status).toBe("within");
    expect(poExposure({ authorizedCents: 5_000_000, billedCents: 4_000_000, committedCents: 0, estimateCents: 600_000, validTo: null, at }).status).toBe("warning");
    expect(poExposure({ authorizedCents: 5_000_000, billedCents: 0, committedCents: 0, estimateCents: 1, validTo: new Date("2026-06-30T00:00:00Z"), at }).status).toBe("expired");
  });
  it("names what a rate sheet leaves unanswered rather than guessing it", () => {
    const sheet = [def({ scopeLevel: "company" }), def({ scopeLevel: "company", serviceCode: "hydrovac_standby", rateMillis: 190_000 }), def({ scopeLevel: "company", serviceCode: "hydrovac_disposal", pricingMethod: "percentage_markup", unit: "none", rateMillis: null, basisPoints: 1_200 })];
    expect(rateSheetGaps(sheet).map(g => g.key)).toEqual(["minimum", "increment", "after_hours", "travel"]);
  });
  it("projects readiness as a percentage with exactly what is missing", () => {
    const r = goLiveReadiness({ services: ["hydrovac", "vac_hauling"], approvedSell: 4, proposedSell: 2, approvedVendor: 1, vendorsWithoutRates: 1, customersWithoutRates: 0, unitsWithoutCost: 3, guardrailsSet: true, termsApproved: 1, customers: 2 });
    expect(r.percent).toBe(63);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["2 sell proposal(s) awaiting approval", "1 vendor(s) without a payable rate", "3 unit(s) without an internal cost"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 4_400_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("commercial setup, end to end", () => {
  it("proposes, refuses self-approval, approves by a second person, resolves, prices with a decision record, and reports readiness", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const management = await withRole("management");
    const entityId = 4_500_000 + Math.floor(Math.random() * 90_000);
    // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [entityId, key("FE"), `entity ${entityId}`]);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const vendorRef = key("VEN").slice(0, 40);
    await pool.execute("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?, 'XYZ Vac Services', 'subcontractor', 'active')", [vendorRef]);
    const c = callerFor(office).commercialSetup;
    // an AI extraction is a proposal like any other — and it names the document it was read from, or it is not proposed (rule reviewed on arrival, v22.7)
    await expect(c.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 275_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "ai_extracted", sourceClause: "Company rate sheet p.1" })).rejects.toThrow(/names the source document/);
    const [sheet] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, status, createdAt) VALUES ('Company rate sheet 2026', 'contract', NOW(), 'needs_review', NOW())");
    const company = await c.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 275_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "ai_extracted", sourceDocumentEvidenceId: Number(sheet.insertId), sourceClause: "Company rate sheet p.1" });
    const abc = await c.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 320_000, minimumQuantityMillis: 4_000, billingIncrementMillis: 250, scopeLevel: "customer_contract", customerAccountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "ABC MSA 2026 §4.2" });
    const payable = await c.definitionPropose({ financialEntityId: entityId, rateKind: "vendor_payable", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 225_000, scopeLevel: "customer_contract", customerAccountRef: acctRef, vendorRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human" });
    expect(company.message).toContain("prices nothing until a different person approves");
    await expect(callerFor(office).commercialSetup.definitionApprove({ definitionRef: abc.definitionRef })).rejects.toThrow(/commercial.rates.approve/);   // the office proposes; it does not approve
    const own = await callerFor(controller).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac_standby", pricingMethod: "per_unit", unit: "hour", rateMillis: 190_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human" });
    await expect(callerFor(controller).commercialSetup.definitionApprove({ definitionRef: own.definitionRef })).rejects.toThrow(/second person/);       // the proposer does not approve their own
    await callerFor(management).commercialSetup.definitionApprove({ definitionRef: own.definitionRef });
    // unapproved: unknown
    const before = await c.rateResolve({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef });
    expect(before.outcome).toBe("unknown");
    for (const r of [company, abc, payable]) await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: r.definitionRef });
    const res = await c.rateResolve({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef });
    expect(res).toMatchObject({ outcome: "resolved", scopeLevel: "customer_contract", rateMillis: 320_000, sourceClause: "ABC MSA 2026 §4.2" });
    // a short day priced: measured 2.5 h, billed 4 h, the record says why
    const dec = await c.pricingDecide({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef, subjectKind: "field_ticket_line", subjectRef: "FT-1/L1", quantityMillis: 2_500, unit: "hour", measurementSource: "clock" });
    expect(dec).toMatchObject({ outcome: "priced", amountCents: 128_000, billableQuantityMillis: 4_000, minimumApplied: true, definitionRef: abc.definitionRef });
    const stored = await c.decisionGet({ decisionRef: dec.decisionRef });
    expect(stored.inputs).toMatchObject({ measuredQuantityMillis: 2_500, measuredUnit: "hour", measurementSource: "clock" });
    expect(stored.reasons.some((r: string) => r.includes("Minimum 4 hour per ABC MSA 2026 §4.2"))).toBe(true);
    // the vendor payable from the same event, its own decision
    const pay = await c.pricingDecide({ financialEntityId: entityId, rateKind: "vendor_payable", serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef, vendorRef, subjectKind: "vendor_bill_line", subjectRef: "VB-1/L1", quantityMillis: 10_000, unit: "hour", measurementSource: "clock" });
    expect(pay).toMatchObject({ outcome: "priced", amountCents: 225_000 });
    // the office sees no margin: the permission is management's
    await expect(callerFor(office).commercialSetup.marginSimulate({ financialEntityId: entityId, serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef, vendorRef, quantityMillis: 10_000, unit: "hour" })).rejects.toThrow(/commercial.margin.view/);
    await callerFor(management).commercialSetup.profileSet({ financialEntityId: entityId, services: ["hydrovac", "vac_hauling"], targetMarginBps: 3_000, warningMarginBps: 2_000, minimumAuthorityMarginBps: 1_500, discountAuthority: { office: 2_500, management: 2_000, controller: 0 } });
    const sim = await callerFor(management).commercialSetup.marginSimulate({ financialEntityId: entityId, serviceCode: "hydrovac", at: new Date("2026-09-10T00:00:00Z"), customerAccountRef: acctRef, vendorRef, quantityMillis: 10_000, unit: "hour", proposedSellRateMillis: 295_000 });
    expect(sim).toMatchObject({ contractSellCents: 320_000, proposedSellCents: 295_000, costCents: 225_000, differenceCents: -25_000 });
    expect(sim.simulation).toMatchObject({ band: "warning", approvalRequired: null });
    expect(sim.view).toMatchObject({ sellCents: 295_000, vendorCents: 225_000, marginCents: 70_000 });
    await pool.execute("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'hydrovac', 'due', 'review', NOW())", [key("U").slice(0, 20)]);   // a unit with no internal cost
    const ready = await c.goLiveReadiness({ financialEntityId: entityId });
    expect(ready.checks.find(x => x.key === "sell_rates")?.ok).toBe(true);
    expect(ready.checks.find(x => x.key === "guardrails")?.ok).toBe(true);
    expect(ready.ready).toBe(false);
    expect(ready.missing.some(m => /unit\(s\) without an internal cost/.test(m))).toBe(true);
  });
  it("refuses an AI-extracted or imported rate that names no source document, and takes one that does as a proposal only", async () => {
    const office = await withRole("office");
    const entityId = 4_400_000 + Math.floor(Math.random() * 90_000);
    // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [entityId, key("FE"), `entity ${entityId}`]);
    await expect(callerFor(office).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 325_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "ai_extracted" })).rejects.toThrow(/names the source document/);
    const proposed = await callerFor(office).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 325_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "ai_extracted", sourceDocumentEvidenceId: 1, sourceClause: "ABC Energy Master Rate Sheet p.4" });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT approvalStatus, sourceKind, sourceDocumentEvidenceId FROM chargeDefinitions WHERE definitionRef = ?", [proposed.definitionRef]);
    expect(row[0]).toMatchObject({ approvalStatus: "proposed", sourceKind: "ai_extracted", sourceDocumentEvidenceId: 1 });    // read from a document, priced by no one yet
  });

  it("supersedes a rate at year end and still prices the December job at the old rate", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const entityId = 4_600_000 + Math.floor(Math.random() * 90_000);
    // P4.1: a financial entity is the money boundary (0146) and must exist; this one is unowned — the historical single tenant's.
    await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,?,'corporation','AB',12,31)", [entityId, key("FE"), `entity ${entityId}`]);
    const c = callerFor(office).commercialSetup;
    const r26 = await c.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "vac_truck", pricingMethod: "per_unit", unit: "hour", rateMillis: 300_000, scopeLevel: "company", effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: new Date("2027-01-01T00:00:00Z"), sourceKind: "human" });
    await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: r26.definitionRef });
    const r27 = await c.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "vac_truck", pricingMethod: "per_unit", unit: "hour", rateMillis: 325_000, scopeLevel: "company", effectiveFrom: new Date("2027-01-01T00:00:00Z"), sourceKind: "human" });
    const approved = await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: r27.definitionRef, supersedesDefinitionRef: r26.definitionRef });
    expect(approved.version).toBe(2);
    const dec = await c.rateResolve({ financialEntityId: entityId, rateKind: "sell", serviceCode: "vac_truck", at: new Date("2026-12-15T00:00:00Z") });
    expect(dec).toMatchObject({ outcome: "resolved", rateMillis: 300_000, version: 1 });      // the December job still prices at the 2026 rate
    const jan = await c.rateResolve({ financialEntityId: entityId, rateKind: "sell", serviceCode: "vac_truck", at: new Date("2027-01-15T00:00:00Z") });
    expect(jan).toMatchObject({ outcome: "resolved", rateMillis: 325_000, version: 2 });
    const list = await c.definitionList({ financialEntityId: entityId, serviceCode: "vac_truck" });
    expect(list.map(x => x.approvalStatus).sort()).toEqual(["approved", "superseded"]);
  });
});
