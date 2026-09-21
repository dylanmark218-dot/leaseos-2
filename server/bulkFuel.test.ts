import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { fuelAnomalies, reconcileStatement, reconcileTank, type LedgerFuel } from "./_core/bulkFuel";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const at = (iso: string) => new Date(iso);
const h = (base: string, hours: number) => new Date(at(base).getTime() + hours * 3_600_000);

/* ------------------------------------------------------------------ */
/* Tank                                                                 */
/* ------------------------------------------------------------------ */

describe("what should be in the tank, and what is", () => {
  const opening = { at: at("2026-09-01T06:00:00Z"), litresOnHand: 6000, method: "stick" };
  const closing = { at: at("2026-09-08T06:00:00Z"), litresOnHand: 4980, method: "stick" };
  const movements = [
    { kind: "purchase" as const, litres: 3000, at: at("2026-09-03T10:00:00Z") },
    { kind: "dispense" as const, litres: 2500, at: at("2026-09-04T07:00:00Z") },
    { kind: "dispense" as const, litres: 1500, at: at("2026-09-06T07:00:00Z") },
    { kind: "dispense" as const, litres: 400, at: at("2026-08-30T07:00:00Z") },   // before the window
  ];

  it("computes expected = opening + in − out over the window only, and the variance against the reading", () => {
    const r = reconcileTank({ opening, closing, movements, capacityLitres: 10_000, tolerancePct: 2 });
    expect(r.purchasedLitres).toBe(3000);
    expect(r.dispensedLitres).toBe(4000);
    expect(r.expectedLitres).toBe(5000);
    expect(r.varianceLitres).toBe(-20);
    expect(r.variancePct).toBe(-0.4);
    expect(r.withinTolerance).toBe(true);
  });

  it("names fuel that left without a dispense", () => {
    const r = reconcileTank({ opening, closing: { ...closing, litresOnHand: 4600 }, movements, capacityLitres: 10_000, tolerancePct: 2 });
    expect(r.withinTolerance).toBe(false);
    expect(r.reason).toContain("400 L (8%) left the tank without a dispense");
  });

  it("refuses to call an over-capacity expectation reconciled, and needs two readings", () => {
    // 9,000 on hand plus a 3,000 L delivery with nothing dispensed is 12,000 L in a 10,000 L tank.
    const r = reconcileTank({ opening: { ...opening, litresOnHand: 9000 }, closing, movements: movements.filter(m => m.kind === "purchase"), capacityLitres: 10_000, tolerancePct: 2 });
    expect(r.expectedLitres).toBe(12000);
    expect(r.withinTolerance).toBe(false);
    expect(r.reason).toContain("exceeds the tank's 10000 L capacity");
    expect(reconcileTank({ opening: null, closing, movements, capacityLitres: 10_000, tolerancePct: 2 }).expectedLitres).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Statement                                                            */
/* ------------------------------------------------------------------ */

describe("which statement lines have no receipt", () => {
  const ledger: LedgerFuel[] = [
    { id: 1, fuelRef: "F-1", cardLastFour: "1234", occurredAt: at("2026-09-02T08:00:00Z"), total: 450.25, quantity: 300, unitNumber: "142", statementLineId: null },
    { id: 2, fuelRef: "F-2", cardLastFour: "1234", occurredAt: at("2026-09-05T18:30:00Z"), total: 170, quantity: 100, unitNumber: "142", statementLineId: null },
    { id: 3, fuelRef: "F-3", cardLastFour: "9876", occurredAt: at("2026-09-06T09:00:00Z"), total: 200, quantity: 120, unitNumber: "188", statementLineId: null },
    { id: 4, fuelRef: "F-4", cardLastFour: "9876", occurredAt: at("2026-09-06T09:20:00Z"), total: 200, quantity: 120, unitNumber: "188", statementLineId: null },
    { id: 5, fuelRef: "F-5", cardLastFour: "1234", occurredAt: at("2026-09-07T12:00:00Z"), total: 88, quantity: 50, unitNumber: "142", statementLineId: 77 },
  ];
  const lines = [
    { lineNo: 1, cardLastFour: "1234", occurredAt: at("2026-09-02T08:05:00Z"), total: 450.25, quantity: 300, unitHint: "142" },
    { lineNo: 2, cardLastFour: "1234", occurredAt: at("2026-09-05T18:00:00Z"), total: 170, quantity: 101, unitHint: null },
    { lineNo: 3, cardLastFour: "1234", occurredAt: at("2026-09-09T07:00:00Z"), total: 312.4, quantity: 210, unitHint: null },
    { lineNo: 4, cardLastFour: "9876", occurredAt: at("2026-09-06T09:10:00Z"), total: 200, quantity: 120, unitHint: null },
  ];

  it("matches, matches with variance, leaves the receiptless purchase as the finding, and refuses to guess between twins", () => {
    const r = reconcileStatement({ lines, ledger, windowHours: 36 });
    expect(r.results.map(x => [x.lineNo, x.outcome, x.matchedFuelId])).toEqual([
      [1, "match", 1],
      [2, "match_with_variance", 2],
      [3, "unmatched", null],
      [4, "ambiguous", null],
    ]);
    expect(r.results[2].reason).toContain("nobody scanned it");
    expect(r.results[3].reason).toContain("F-3, F-4");
    expect(r.counts).toEqual({ match: 1, match_with_variance: 1, unmatched: 1, ambiguous: 1 });
  });

  it("does not offer a transaction already matched to another line, and lists card receipts the statement never claimed", () => {
    const r = reconcileStatement({ lines: [{ lineNo: 1, cardLastFour: "1234", occurredAt: at("2026-09-07T12:00:00Z"), total: 88, quantity: 50, unitHint: null }], ledger, windowHours: 36 });
    expect(r.results[0].outcome).toBe("unmatched"); // F-5 is taken by line 77
    const wide = reconcileStatement({ lines, ledger, windowHours: 36 });
    expect(wide.receiptsWithoutLine.map(t => t.fuelRef)).toEqual(["F-3", "F-4"]); // ambiguous twins stay unclaimed
  });
});

/* ------------------------------------------------------------------ */
/* Anomalies                                                            */
/* ------------------------------------------------------------------ */

describe("which fills do not add up", () => {
  const b = "2026-09-01T06:00:00Z";
  it("flags a fill bigger than the tank, two fills an hour apart, and an odometer that went backwards", () => {
    const a = fuelAnomalies({
      fills: [
        { fuelRef: "A", unitId: 1, occurredAt: h(b, 0), quantityLitres: 300, odometerKm: 100_000, cardLastFour: "1" },
        { fuelRef: "B", unitId: 1, occurredAt: h(b, 1), quantityLitres: 250, odometerKm: 99_950, cardLastFour: "1" },
        { fuelRef: "C", unitId: 1, occurredAt: h(b, 30), quantityLitres: 620, odometerKm: 100_400, cardLastFour: "1" },
      ],
      tankCapacityByUnit: new Map([[1, 600]]),
    });
    expect(a.map(x => [x.code, x.fuelRef])).toEqual([["fills_too_close", "B"], ["odometer_regressed", "B"], ["fill_exceeds_capacity", "C"]]);
  });

  it("flags consumption far off the unit's own median, once there is a history to compare with", () => {
    // 200 L per 500 km is 40 L/100 km; 420 L is 84 — beyond twice the median. Exactly twice is not "far off".
    const fills = [0, 1, 2, 3, 4, 5].map(i => ({ fuelRef: `F${i}`, unitId: 2, occurredAt: h(b, i * 48), quantityLitres: i === 4 ? 420 : 200, odometerKm: 50_000 + i * 500, cardLastFour: null }));
    const a = fuelAnomalies({ fills, tankCapacityByUnit: new Map() });
    expect(a.map(x => x.code)).toEqual(["consumption_outlier"]);
    expect(a[0].fuelRef).toBe("F4");
    expect(a[0].detail).toContain("84 L/100 km against the unit's median 40");
    const exact = fuelAnomalies({ fills: fills.map(f => (f.fuelRef === "F4" ? { ...f, quantityLitres: 400 } : f)), tankCapacityByUnit: new Map() });
    expect(exact).toEqual([]);
  });

  it("is quiet on a normal unit and ignores fills with no unit", () => {
    expect(fuelAnomalies({ fills: [{ fuelRef: "X", unitId: null, occurredAt: h(b, 0), quantityLitres: 5000, odometerKm: null, cardLastFour: null }], tankCapacityByUnit: new Map() })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow                                             */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("yard work versus finance work", () => {
  it("lets a driver dispense and nothing else; imports are the bookkeeper's and controller's", () => {
    expect(authorize({ userId: 1, roles: ["driver"], permission: "fuel.dispense.record" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "fuel.review" }).allowed).toBe(false);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "fuel.statement.import" }).allowed).sort()).toEqual(["bookkeeper", "controller"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 880000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a yard tank and a card statement, through the ledger", () => {
  it("dispenses into IFTA, reconciles the tank, imports a statement once, and leaves the receiptless purchase as the finding", async () => {
    const shopLead = await withRole("shop_lead");
    const driver = await withRole("driver");
    const bookkeeper = await withRole("bookkeeper");
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'truck', 'ABC', 'clear')", [key("142").slice(0, 30)]);
    const unitId = Number(u.insertId);
    // Derived from an auto-increment, not drawn from `Math.random() * 40000`.
    //
    // The assertions below read `ifta.quarter` for this entity, which aggregates
    // every CA-AB litre it holds in the quarter — so two fixtures landing on one
    // id do not read as two tests, they read as one test that dispensed twice.
    // This failed in CI as "expected 600 to be 300" on a commit that changed only
    // a markdown file, and passed on the commits either side of it.
    //
    // `loadQuarter` is correctly scoped by financialEntityId, so the id itself was
    // the only shared thing. A real auto-increment cannot repeat within a run,
    // which removes the collision rather than making it rarer.
    const entityId = 950000 + unitId;

    // A tank in Alberta. A stated dispense enters needs_review; a metered one whose meter disagrees is refused.
    const tank = await callerFor(shopLead).fuel.tankRegister({ financialEntityId: entityId, name: "Yard tank 1", location: "Nisku yard", jurisdiction: "CA-AB", fuelType: "diesel", capacityLitres: 10000, varianceTolerancePct: 2 });
    await expect(callerFor(driver).fuel.dispenseRecord({ tankRef: tank.tankRef, unitId, litres: 300, quantitySource: "meter", meterBefore: 1000, meterAfter: 1290, occurredAt: new Date("2026-08-12T07:00:00Z") })).rejects.toThrow(/Meter says 290/);
    const disp = await callerFor(driver).fuel.dispenseRecord({ tankRef: tank.tankRef, unitId, litres: 300, quantitySource: "meter", meterBefore: 1000, meterAfter: 1300, odometerKm: 120000, occurredAt: new Date("2026-08-12T07:00:00Z") });
    expect(disp.jurisdiction).toBe("CA-AB");
    expect(disp.status).toBe("confirmed");
    const [ft] = await pool.execute<mysql.RowDataPacket[]>("SELECT purpose, financialTreatment, jurisdiction, jurisdictionSource, quantity, unitId FROM fuelTransactions WHERE fuelRef = ?", [disp.fuelRef]);
    expect(ft[0]).toMatchObject({ purpose: "bulk_tank_dispense", financialTreatment: "bulk_fuel_inventory", jurisdiction: "CA-AB", jurisdictionSource: "bulk_tank_location", quantity: 300, unitId });

    // IFTA sees the dispense as tax-paid litres in Alberta, on the unit.
    const q = await callerFor(bookkeeper).ifta.quarter({ financialEntityId: entityId, quarter: "2026-Q3" });
    expect(q.jurisdictions.find(j => j.jurisdiction === "CA-AB")!.taxPaidLitres).toBe(300);
    expect(q.units[0].litres).toBe(300);

    // Readings and a purchase: expected = 6000 + 3000 − 300 = 8700; measured 8650 → −50 L, −0.6%, within 2%.
    await callerFor(shopLead).fuel.readingRecord({ tankRef: tank.tankRef, readAt: new Date("2026-08-10T06:00:00Z"), litresOnHand: 6000, method: "stick" });
    await pool.execute("INSERT INTO fuelTransactions (fuelRef, financialEntityId, bulkFuelTankId, occurredAt, fuelType, quantity, quantityUnit, totalCents, payerType, purpose, financialTreatment, reimbursementStatus, privateToFueler, hosRuleConclusion, status) VALUES (?, ?, ?, '2026-08-11 10:00:00', 'diesel', 3000, 'L', 420000, 'company', 'bulk_tank_purchase', 'bulk_fuel_inventory', 'not_applicable', 0, 'unknown', 'confirmed')", [key("FUEL").slice(0, 60), entityId, tank.tankId]);
    await callerFor(shopLead).fuel.readingRecord({ tankRef: tank.tankRef, readAt: new Date("2026-08-15T06:00:00Z"), litresOnHand: 8650, method: "stick" });
    const rec = await callerFor(shopLead).fuel.tankReconcile({ tankRef: tank.tankRef });
    expect(rec.expectedLitres).toBe(8700);
    expect(rec.varianceLitres).toBe(-50);
    expect(rec.withinTolerance).toBe(true);
    await expect(callerFor(shopLead).fuel.readingRecord({ tankRef: tank.tankRef, readAt: new Date(), litresOnHand: 12000, method: "stick" })).rejects.toThrow(/exceeds the tank/);

    // A card account with two cards; two receipts on the ledger, one on a card, plus one the statement will not know.
    const [acct] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fuelAccounts (accountRef, financialEntityId, name, fuelType, kind, status) VALUES (?, ?, 'Cardlock', 'diesel', 'fleet', 'active')", [key("ACCT").slice(0, 40), entityId]);
    const [card] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fleetFuelCards (cardRef, financialEntityId, provider, providerToken, lastFour, assignedUnitId, fuelAccountId, status) VALUES (?, ?, 'Cardlock Co', ?, '4321', ?, ?, 'active')", [key("CARD").slice(0, 40), entityId, key("tok"), unitId, Number(acct.insertId)]);
    const r1 = key("FUEL").slice(0, 60), r2 = key("FUEL").slice(0, 60);
    const FC = "payerType, purpose, financialTreatment, reimbursementStatus, privateToFueler, hosRuleConclusion, status";
    const FV = "'company', 'company_vehicle_operation', 'company_operating_expense', 'not_applicable', 0, 'unknown', 'confirmed'";
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, fleetCardId, fuelAccountId, occurredAt, fuelType, quantity, quantityUnit, totalCents, evidenceRecordId, ${FC}) VALUES (?, ?, ?, ?, ?, '2026-09-02 08:00:00', 'diesel', 300, 'L', 45025, 1, ${FV})`, [r1, entityId, unitId, Number(card.insertId), Number(acct.insertId)]);
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, fleetCardId, fuelAccountId, occurredAt, fuelType, quantity, quantityUnit, totalCents, evidenceRecordId, ${FC}) VALUES (?, ?, ?, ?, ?, '2026-09-05 18:30:00', 'diesel', 100, 'L', 17000, 1, ${FV})`, [r2, entityId, unitId, Number(card.insertId), Number(acct.insertId)]);

    const stmt = { financialEntityId: entityId, fuelAccountId: Number(acct.insertId), provider: "Cardlock Co", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z"), lines: [
      { transactionAt: new Date("2026-09-02T08:03:00Z"), cardLastFour: "4321", merchant: "Cardlock Nisku", jurisdiction: "CA-AB" as const, quantity: 300, quantityUnit: "L", total: 450.25 },
      { transactionAt: new Date("2026-09-05T18:00:00Z"), cardLastFour: "4321", merchant: "Cardlock Red Deer", jurisdiction: "CA-AB" as const, quantity: 101, quantityUnit: "L", total: 170 },
      { transactionAt: new Date("2026-09-09T07:00:00Z"), cardLastFour: "4321", merchant: "Cardlock Hinton", jurisdiction: "CA-AB" as const, quantity: 210, quantityUnit: "L", total: 312.4 },
    ] };
    const imp = await callerFor(bookkeeper).fuel.statementImport(stmt);
    expect(imp.alreadyImported).toBe(false);
    if (!imp.alreadyImported) {
      expect(imp.counts).toEqual({ match: 1, match_with_variance: 1, unmatched: 1, ambiguous: 0 });
      expect(imp.unmatched).toEqual([{ lineNo: 3, outcome: "unmatched", reason: "No receipt on the ledger for this purchase — nobody scanned it" }]);
    }
    // The matched receipts are linked and reconciled, and the statement supplied the jurisdiction the receipt lacked.
    const [linked] = await pool.execute<mysql.RowDataPacket[]>("SELECT fuelRef, status, statementLineId, jurisdiction, jurisdictionSource FROM fuelTransactions WHERE fuelRef IN (?, ?) ORDER BY fuelRef", [r1, r2].sort());
    expect(linked.every(x => x.status === "reconciled" && x.statementLineId != null && x.jurisdiction === "CA-AB" && x.jurisdictionSource === "fleet_card_statement")).toBe(true);
    // Importing the same statement again does nothing new.
    const again = await callerFor(bookkeeper).fuel.statementImport(stmt);
    expect(again.alreadyImported).toBe(true);
    if (again.alreadyImported && !imp.alreadyImported) expect(again.statementRef).toBe(imp.statementRef);

    // A person later captures the missing receipt and resolves line 3 to it; a second resolution of a matched line is refused.
    const r3 = key("FUEL").slice(0, 60);
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, fleetCardId, fuelAccountId, occurredAt, fuelType, quantity, quantityUnit, totalCents, ${FC}) VALUES (?, ?, ?, ?, ?, '2026-09-09 07:00:00', 'diesel', 210, 'L', 31240, ${FV})`, [r3, entityId, unitId, Number(card.insertId), Number(acct.insertId)]);
    const statementRef = imp.alreadyImported ? "" : imp.statementRef;
    const res = await callerFor(bookkeeper).fuel.statementLineResolve({ statementRef, lineNo: 3, fuelRef: r3, reason: "Receipt found in the cab, scanned 12 Sept" });
    expect(res.outcome).toBe("match_with_variance");
    await expect(callerFor(bookkeeper).fuel.statementLineResolve({ statementRef, lineNo: 1, fuelRef: r3, reason: "Trying to reuse it" })).rejects.toThrow(/already matched/);

    // Anomalies over the period: two fills on the same unit within the hour would be flagged; these are days apart.
    const an = await callerFor(bookkeeper).fuel.anomalies({ financialEntityId: entityId, from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z") });
    expect(an.anomalies.filter(a => a.code === "fills_too_close")).toEqual([]);
  });
});
