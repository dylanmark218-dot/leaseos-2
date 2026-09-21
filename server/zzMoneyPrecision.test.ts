/**
 * v22.3 — Money precision.
 *
 * Money is integer minor units. The older tables carry it as double; those
 * columns are grandfathered here — the list is derived from the live schema
 * and pinned, so a NEW double money column fails the gate, and a
 * grandfathered one that disappears must be removed from the list on
 * purpose. The two highest-traffic ledgers carry integer shadows now,
 * backfilled by migration and dual-written; every row must reconcile.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { fromCents, reconcile, toCents, toMillis } from "./_core/money";

/** The columns that still hold money as double. v22.3: forty. v22.5: vendor bills and their lines retired theirs — thirty-five. v22.6: fuel retired its five — thirty. Shrink this list; never grow it. */
const GRANDFATHERED_DOUBLE_MONEY = [
  "contractorSettlementLines.amount", "contractorSettlementLines.rateApplied", "contractorSettlements.deductionTotal", "contractorSettlements.grossAmount", "contractorSettlements.netAmount",
  "customerRecoveryProposals.companyCost",
  "expenseAllocations.amount", "expenseRecords.salesTaxAmount", "expenseRecords.subtotal", "expenseRecords.total",
  "fuelStatementLines.total", 
  "fundingClaims.claimedAmount", "fundingClaims.eligibleCost", "fundingOpportunities.estimatedAmount",
  "insuranceClaimCosts.amount", "insuranceClaimRecoveries.amount", "insuranceClaims.approvedAmount", "insuranceClaims.deductible", "insuranceClaims.estimatedLoss", "insurancePolicies.annualPremium", "insurancePolicies.deductible", "insurancePolicyCoverages.deductible", "insurancePolicyCoverages.limitAmount",
  "payRates.rate", "payrollAdjustments.amount", "payrollEarningEvents.calculatedAmount", "payrollEarningEvents.rateApplied", "payRunLines.amount", "payRunLines.rateApplied",
  "purchaseAuthorizations.estimatedAmount",
  
].sort();

/** Column names that look like money. Quantities and minutes are excluded by name. */
// Case-insensitive, as MySQL's REGEXP is: grossAmount is money.
const MONEY_NAME = /(amount|total|subtotal|price|rate$|rate[A-Z]|cost|premium|deductible|balance|paid|owing|fee|charge|wage|salary|pay$|tax|revenue|budget|loss|credit|debit)/i;
const NOT_MONEY = /(minutes|quantity|qty|km|hours|litres|pct|percent|ratio|factor|km$)/i;

/** Every double money column and its integer shadow: amounts in cents, per-unit rates in thousandths. Every row must agree. */
const SHADOWED: [string, string, string, number][] = [
  ["contractorSettlements", "deductionTotal", "deductionTotalCents", 100], ["contractorSettlements", "grossAmount", "grossAmountCents", 100], ["contractorSettlements", "netAmount", "netAmountCents", 100],
  ["contractorSettlementLines", "amount", "amountCents", 100], ["contractorSettlementLines", "rateApplied", "rateAppliedMillis", 1000],
  ["customerRecoveryProposals", "companyCost", "companyCostCents", 100],
  ["expenseAllocations", "amount", "amountCents", 100], ["expenseRecords", "salesTaxAmount", "salesTaxAmountCents", 100], ["expenseRecords", "subtotal", "subtotalCents", 100], ["expenseRecords", "total", "totalCents", 100],
  ["fuelStatementLines", "total", "totalCents", 100],
  ["fundingClaims", "claimedAmount", "claimedAmountCents", 100], ["fundingClaims", "eligibleCost", "eligibleCostCents", 100], ["fundingOpportunities", "estimatedAmount", "estimatedAmountCents", 100],
  ["insuranceClaimCosts", "amount", "amountCents", 100], ["insuranceClaimRecoveries", "amount", "amountCents", 100], ["insuranceClaims", "approvedAmount", "approvedAmountCents", 100], ["insuranceClaims", "deductible", "deductibleCents", 100], ["insuranceClaims", "estimatedLoss", "estimatedLossCents", 100],
  ["insurancePolicies", "annualPremium", "annualPremiumCents", 100], ["insurancePolicies", "deductible", "deductibleCents", 100], ["insurancePolicyCoverages", "deductible", "deductibleCents", 100], ["insurancePolicyCoverages", "limitAmount", "limitAmountCents", 100],
  ["payRates", "rate", "rateMillis", 1000], ["payrollAdjustments", "amount", "amountCents", 100], ["payrollEarningEvents", "calculatedAmount", "calculatedAmountCents", 100], ["payrollEarningEvents", "rateApplied", "rateAppliedMillis", 1000], ["payRunLines", "amount", "amountCents", 100], ["payRunLines", "rateApplied", "rateAppliedMillis", 1000],
  ["purchaseAuthorizations", "estimatedAmount", "estimatedAmountCents", 100],
];

describe("the money helper", () => {
  it("rounds half away from zero, refuses non-finite, and round-trips", () => {
    expect(toCents(412.5)).toBe(41250);
    expect(toCents(0.005)).toBe(1);
    expect(toCents(-0.005)).toBe(-1);
    expect(toCents(1.005)).toBe(101);            // 1.005 in binary is 1.00499…; the epsilon keeps the intended cent
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(null)).toBeNull();
    expect(() => toCents(Number.NaN)).toThrow(/Not a money amount/);
    expect(fromCents(41250)).toBe(412.5);
    expect(reconcile(412.5, 41250)).toEqual({ agrees: true, finding: null });
    expect(reconcile(412.5, 41249).finding).toBe("double 412.5 → 41250 cents, shadow holds 41249");
    expect(reconcile(null, 5).agrees).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

d("double money is grandfathered, never new", () => {
  it("matches exactly the grandfathered list across every column in the schema", async () => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT CONCAT(table_name, '.', column_name) AS col FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type IN ('double', 'float', 'decimal')");
    const live = rows.map(r => String(r.col)).filter(c => MONEY_NAME.test(c.split(".")[1]!) && !NOT_MONEY.test(c.split(".")[1]!)).sort();
    const added = live.filter(c => !GRANDFATHERED_DOUBLE_MONEY.includes(c));
    const gone = GRANDFATHERED_DOUBLE_MONEY.filter(c => !live.includes(c));
    expect(added, "A new money column is a double. Store money as integer minor units (…Cents); the grandfathered list only shrinks.").toEqual([]);
    expect(gone, "A grandfathered double money column is gone. If it was migrated to cents on purpose, remove it from the list here.").toEqual([]);
  });
  it("keeps the retired ledgers retired: vendor bills and fuel carry no double money and their integer totals are NOT NULL", async () => {
    const [dbl] = await pool.execute<mysql.RowDataPacket[]>("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('vendorBills', 'vendorBillLines', 'fuelTransactions') AND data_type IN ('double', 'float', 'decimal')");
    expect(dbl.map(r => String(r.column_name)).filter(c => MONEY_NAME.test(c) && !NOT_MONEY.test(c))).toEqual([]);   // quantity is a quantity
    const [nn] = await pool.execute<mysql.RowDataPacket[]>("SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name = 'vendorBills' AND column_name = 'totalCents') OR (table_name = 'vendorBillLines' AND column_name = 'amountCents') OR (table_name = 'fuelTransactions' AND column_name = 'totalCents'))");
    expect(nn.map(r => `${r.table_name}.${r.column_name}:${r.is_nullable}`).sort()).toEqual(["fuelTransactions.totalCents:NO", "vendorBillLines.amountCents:NO", "vendorBills.totalCents:NO"]);
    const [trg] = await pool.execute<mysql.RowDataPacket[]>("SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table IN ('vendorBills', 'vendorBillLines', 'fuelTransactions')");
    expect(trg).toEqual([]);                                                                   // nothing left that references the doubles
  });
  it("declares an integer shadow for every shadowed pair", async () => {
    expect(SHADOWED).toHaveLength(GRANDFATHERED_DOUBLE_MONEY.length);        // every grandfathered double has a shadow
    for (const [table, , cents] of SHADOWED) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?", [table, cents]);
      expect(rows[0]?.data_type, `${table}.${cents}`).toBe("int");
    }
  });
  it("has the database fill a shadow for a write that bypasses the application, on insert and on update", async () => {
    const [ins] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO expenseRecords (expenseRef, financialEntityId, transactionDate, currency, subtotal, salesTaxAmount, total, categorySource, businessUsePercent, paidPersonally, reimbursementRequired, status, createdAt) VALUES (?, 1, NOW(), 'CAD', 400, 12.5, 412.5, 'human', 100, 0, 0, 'draft', NOW())", [`EXP-RAW-${Date.now().toString(36)}`]);
    const [a] = await pool.execute<mysql.RowDataPacket[]>("SELECT totalCents FROM expenseRecords WHERE id = ?", [ins.insertId]);
    expect(Number(a[0].totalCents)).toBe(41250);                                              // filled by the trigger, not by the writer
    await pool.execute("UPDATE expenseRecords SET total = 99.99 WHERE id = ?", [ins.insertId]);
    const [b] = await pool.execute<mysql.RowDataPacket[]>("SELECT totalCents FROM expenseRecords WHERE id = ?", [ins.insertId]);
    expect(Number(b[0].totalCents)).toBe(9999);                                               // re-derived when the double changed alone
    await pool.execute("UPDATE expenseRecords SET total = 10.00, totalCents = 1000 WHERE id = ?", [ins.insertId]);
    const [c] = await pool.execute<mysql.RowDataPacket[]>("SELECT totalCents FROM expenseRecords WHERE id = ?", [ins.insertId]);
    expect(Number(c[0].totalCents)).toBe(1000);                                               // an explicit shadow stands
  });
  it("keeps a rate's shadow in thousandths so a pay rate is not rounded to the cent", async () => {
    const [ins] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO payRates (rateKey, version, earningType, calculation, rate, unit, effectiveFrom, approvedByUserId, approvedAt, createdAt) VALUES (CONCAT('RATE-', UNIX_TIMESTAMP(), '-', FLOOR(RAND() * 1000)), 1, 'hourly_pay', 'hourly', 41.375, 'hour', '2026-01-01', 1, NOW(), NOW())");
    const [r] = await pool.execute<mysql.RowDataPacket[]>("SELECT rateMillis FROM payRates WHERE id = ?", [ins.insertId]);
    expect(Number(r[0].rateMillis)).toBe(41375);
    expect(toMillis(1.459)).toBe(1459);
  });
  it("reconciles every row's double to its shadow, to the cent", async () => {
    const findings: string[] = [];
    let rowsChecked = 0;
    for (const [table, dbl, cents, scale] of SHADOWED) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(`SELECT id, \`${dbl}\` AS d, \`${cents}\` AS c FROM \`${table}\``);
      for (const r of rows) {
        rowsChecked++;
        const rc = reconcile(r.d == null ? null : Number(r.d), r.c == null ? null : Number(r.c), scale);
        if (!rc.agrees) findings.push(`${table}#${r.id}.${dbl}: ${rc.finding}`);
      }
    }
    expect(findings, "Every write must set the double and its cents shadow together.").toEqual([]);
    expect(rowsChecked).toBeGreaterThan(0);
  });
});
