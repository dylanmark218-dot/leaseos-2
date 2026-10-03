import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { buildIftaQuarter, finalizeDecision, quarterBounds, splitTripDistance, type DistanceRecord, type FuelRecord } from "./_core/iftaEngine";
import { IFTA_RATE_SEEDS } from "./_core/iftaSeeds";
import { determine } from "./_core/taxRuleEngine";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";
import { FORMS } from "./_core/aiProposal";

const Q = "2026-Q3";
const at = (iso: string) => new Date(iso);
const dist = (over: Partial<DistanceRecord> = {}): DistanceRecord => ({ unitId: 142, jurisdiction: "CA-AB", distanceKm: 1000, periodStart: at("2026-07-10T00:00:00Z"), periodEnd: at("2026-07-11T00:00:00Z"), source: "odometer_split", verificationStatus: "verified", ...over });
const fuel = (over: Partial<FuelRecord> = {}): FuelRecord => ({ fuelRef: "F", unitId: 142, occurredAt: at("2026-07-10T08:00:00Z"), quantityLitres: 400, jurisdiction: "CA-AB", jurisdictionSource: "receipt", receiptEvidenceId: 1, odometerKm: null, fuelType: "diesel", ...over });
const unknownRates = (j: string) => determine(IFTA_RATE_SEEDS, { jurisdiction: j, ruleType: "ifta_fuel_tax_rate", asOf: at("2026-07-01T00:00:00Z") }) as never;
const verifiedRates = (rates: Record<string, number>) => (j: string) => (rates[j] != null ? { outcome: "determined" as const, parameters: { ratePerLitre: rates[j] } } : unknownRates(j));

/* ------------------------------------------------------------------ */
/* Bounds and splits                                                    */
/* ------------------------------------------------------------------ */

describe("quarters and splits", () => {
  it("bounds a quarter in UTC and refuses a malformed one", () => {
    const q = quarterBounds("2026-Q3");
    expect(q.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(q.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => quarterBounds("Q3-2026")).toThrow(/2026-Q3/);
  });

  it("splits a trip by fractions that sum to one, and refuses one that does not", () => {
    const ok = splitTripDistance({ distanceKm: 640, distanceSource: "odometer", splits: [{ jurisdiction: "CA-AB", fraction: 0.75 }, { jurisdiction: "CA-BC", fraction: 0.25 }] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.parts).toEqual([{ jurisdiction: "CA-AB", distanceKm: 480, source: "odometer_split" }, { jurisdiction: "CA-BC", distanceKm: 160, source: "odometer_split" }]);
    }
    const bad = splitTripDistance({ distanceKm: 640, distanceSource: "odometer", splits: [{ jurisdiction: "CA-AB", fraction: 0.75 }, { jurisdiction: "CA-BC", fraction: 0.2 }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal).toContain("sum to 0.950");
    const dup = splitTripDistance({ distanceKm: 640, distanceSource: "odometer", splits: [{ jurisdiction: "CA-AB", fraction: 0.5 }, { jurisdiction: "CA-AB", fraction: 0.5 }] });
    expect(dup.ok).toBe(false);
  });

  it("names a stated distance as stated, not as an instrument reading", () => {
    const s = splitTripDistance({ distanceKm: 100, distanceSource: "operator_stated", splits: [{ jurisdiction: "CA-AB", fraction: 1 }] });
    if (s.ok) expect(s.parts[0].source).toBe("operator_stated");
  });
});

/* ------------------------------------------------------------------ */
/* The arithmetic                                                       */
/* ------------------------------------------------------------------ */

describe("the return's arithmetic", () => {
  it("keeps the specification's example: fleet average, taxable litres, net litres, tax at a verified rate", () => {
    const q = buildIftaQuarter({
      quarter: Q,
      distances: [dist({ jurisdiction: "CA-AB", distanceKm: 3000 }), dist({ jurisdiction: "CA-BC", distanceKm: 1000 })],
      fuel: [fuel({ fuelRef: "F1", jurisdiction: "CA-AB", quantityLitres: 1200 }), fuel({ fuelRef: "F2", jurisdiction: "CA-BC", quantityLitres: 100 })],
      rateFor: verifiedRates({ "CA-AB": 0.13, "CA-BC": 0.227 }),
    });
    expect(q.totals).toEqual({ distanceKm: 4000, litres: 1300, kmPerLitre: 3.08, taxDue: expect.any(Number) });
    const ab = q.jurisdictions.find(j => j.jurisdiction === "CA-AB")!;
    const bc = q.jurisdictions.find(j => j.jurisdiction === "CA-BC")!;
    expect(ab.taxableLitres).toBe(974.0);      // 3000 / 3.08
    expect(ab.netLitres).toBe(-226.0);         // bought more in AB than consumed there
    expect(ab.taxDue).toBe(-29.38);
    expect(bc.taxableLitres).toBe(324.7);      // 1000 / 3.08
    expect(bc.netLitres).toBe(224.7);          // consumed in BC on AB fuel
    expect(bc.taxDue).toBe(51.01);
    expect(q.totals.taxDue).toBe(21.63);
    expect(q.determination).toBe("ready");
  });

  it("reports litres and holds tax UNKNOWN on the seeded, unverified rates", () => {
    const q = buildIftaQuarter({ quarter: Q, distances: [dist()], fuel: [fuel()], rateFor: unknownRates });
    expect(q.jurisdictions[0].taxableLitres).toBe(400);
    expect(q.jurisdictions[0].rateStatus).toBe("unverified");
    expect(q.jurisdictions[0].taxDue).toBeNull();
    expect(q.totals.taxDue).toBeNull();
    expect(q.determination).toBe("unknown");
    expect(q.reasons.join(" ")).toContain("CA-AB: fuel tax rate unverified");
    expect(IFTA_RATE_SEEDS.every(r => r.status === "unverified" && r.parameters.ratePerLitre === null)).toBe(true);
  });

  it("names a jurisdiction with no rule at all as missing", () => {
    const q = buildIftaQuarter({ quarter: Q, distances: [dist({ jurisdiction: "US-WY" })], fuel: [fuel({ jurisdiction: "US-WY" })], rateFor: unknownRates });
    expect(q.jurisdictions[0].rateStatus).toBe("missing");
  });

  it("refuses to finalize on unknown tax, and on blocking exceptions", () => {
    const unknown = buildIftaQuarter({ quarter: Q, distances: [dist()], fuel: [fuel()], rateFor: unknownRates });
    expect(finalizeDecision(unknown).permitted).toBe(false);
    expect(finalizeDecision(unknown).refusals[0]).toContain("invented rate");
    const blocked = buildIftaQuarter({ quarter: Q, distances: [dist()], fuel: [fuel({ jurisdiction: null })], rateFor: verifiedRates({ "CA-AB": 0.13 }) });
    expect(finalizeDecision(blocked).permitted).toBe(false);
    expect(finalizeDecision(blocked).refusals.join(" ")).toContain("fuel_jurisdiction_unknown");
  });
});

/* ------------------------------------------------------------------ */
/* Reconciliation and exceptions                                        */
/* ------------------------------------------------------------------ */

describe("reconciliation is honest about its sources", () => {
  it("counts instrument distance separately from stated distance, and verified from unverified", () => {
    const q = buildIftaQuarter({ quarter: Q, distances: [dist({ distanceKm: 800, source: "odometer_split" }), dist({ distanceKm: 200, source: "operator_stated", verificationStatus: "needs_review" })], fuel: [fuel()], rateFor: unknownRates });
    expect(q.reconciliation.distanceInstrumentPct).toBe(80);
    expect(q.reconciliation.distanceVerifiedPct).toBe(80);
    expect(q.exceptions.some(e => e.code === "distance_unverified")).toBe(true);
  });

  it("reconciles recorded distance against odometer readings on the receipts", () => {
    const q = buildIftaQuarter({ quarter: Q, distances: [dist({ distanceKm: 1000 })], fuel: [fuel({ fuelRef: "F1", odometerKm: 120_000, quantityLitres: 200 }), fuel({ fuelRef: "F2", odometerKm: 120_950, quantityLitres: 200, occurredAt: at("2026-08-01T00:00:00Z") })], rateFor: unknownRates });
    expect(q.units[0].odometerImpliedKm).toBe(950);
    expect(q.reconciliation.odometerReconciledPct).toBe(95);
    expect(q.exceptions.some(e => e.code === "odometer_distance_mismatch")).toBe(false);
    const off = buildIftaQuarter({ quarter: Q, distances: [dist({ distanceKm: 1000 })], fuel: [fuel({ fuelRef: "F1", odometerKm: 120_000 }), fuel({ fuelRef: "F2", odometerKm: 120_500, occurredAt: at("2026-08-01T00:00:00Z") })], rateFor: unknownRates });
    expect(off.exceptions.some(e => e.code === "odometer_distance_mismatch")).toBe(true);
    expect(off.exceptions.find(e => e.code === "odometer_distance_mismatch")!.detail).toContain("about 500 km");
  });

  it("gives null, not zero, when there is nothing to reconcile", () => {
    const q = buildIftaQuarter({ quarter: Q, distances: [], fuel: [], rateFor: unknownRates });
    expect(q.reconciliation).toEqual({ receiptsMatchedPct: null, fuelJurisdictionKnownPct: null, distanceInstrumentPct: null, distanceVerifiedPct: null, odometerReconciledPct: null });
    expect(q.exceptions).toEqual([]);
  });

  it("raises fuel without distance as blocking, distance without fuel as review, and straddling records for splitting", () => {
    const q = buildIftaQuarter({
      quarter: Q,
      distances: [dist({ unitId: 1, distanceKm: 500 }), dist({ unitId: 3, periodStart: at("2026-06-28T00:00:00Z"), periodEnd: at("2026-07-02T00:00:00Z") })],
      fuel: [fuel({ fuelRef: "F2", unitId: 2 }), fuel({ fuelRef: "F0", unitId: null }), fuel({ fuelRef: "Fx", unitId: 1, quantityLitres: null })],
      rateFor: unknownRates,
    });
    const codes = q.exceptions.map(e => e.code);
    expect(codes).toContain("unit_fuel_without_distance");   // unit 2
    expect(codes).toContain("unit_distance_without_fuel");   // unit 1 (its only fuel had no litres)
    expect(codes).toContain("fuel_unit_unknown");            // F0
    expect(codes).toContain("fuel_quantity_missing");        // Fx
    expect(codes).toContain("distance_straddles_quarter");   // unit 3
    expect(q.exceptions.find(e => e.code === "unit_fuel_without_distance")!.severity).toBe("blocking");
    expect(q.exceptions.find(e => e.code === "unit_distance_without_fuel")!.severity).toBe("review");
  });
});

/* ------------------------------------------------------------------ */
/* The receipt feeds the return                                         */
/* ------------------------------------------------------------------ */

describe("the receipt says where the litres were bought", () => {
  it("has a jurisdiction field on the fuel receipt form, as printed, not required", () => {
    const f = FORMS["fuel_receipt"]!;
    const j = f.fields.find(x => x.key === "jurisdiction")!;
    expect(j).toBeDefined();
    expect(j.required).toBe(false);
    expect(j.options).toContain("CA-AB");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow                                             */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who records, who verifies, who finalizes", () => {
  it("reserves finalizing to the tax preparer and controller; a driver records distance and nothing else", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "ifta.finalize" }).allowed).sort()).toEqual(["controller", "tax_preparer"]);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "ifta.distance.record" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["driver"], permission: "ifta.read" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 407_000_000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("one unit's quarter, through the ledger", () => {
  it("splits a trip, classifies fuel, builds the quarter, prepares a snapshot, and refuses to finalize on an unverified rate or a moved ledger", async () => {
    const driver = await withRole("driver");
    const office = await withRole("office");
    const bookkeeper = await withRole("bookkeeper");
    const preparer = await withRole("tax_preparer");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'truck', 'ABC', 'clear')", [key("142").slice(0, 30)]);
    const unitId = Number(u.insertId);
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'haul', 'transport', 'Acme', 'x', 'dispatched', 0)", [key("JOB").slice(0, 40)]);
    const [t] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, jobId, unitId, status, startedAt, completedAt, odometerStartKm, odometerEndKm) VALUES (?, ?, ?, 'complete', '2026-07-12 06:00:00', '2026-07-12 18:00:00', 120000, 120640)", [key("TRIP").slice(0, 40), Number(j.insertId), unitId]);
    const tripId = Number(t.insertId);

    // The driver splits the trip: 75% Alberta, 25% BC. Records enter needs_review.
    const split = await callerFor(driver).ifta.tripSplit({ financialEntityId: entityId, tripId, splits: [{ jurisdiction: "CA-AB", fraction: 0.75 }, { jurisdiction: "CA-BC", fraction: 0.25 }] });
    expect(split.distanceSource).toBe("odometer");
    expect(split.parts.map(p => p.distanceKm)).toEqual([480, 160]);
    await expect(callerFor(driver).ifta.tripSplit({ financialEntityId: entityId, tripId, splits: [{ jurisdiction: "CA-AB", fraction: 0.5 }] })).rejects.toThrow(/sum to 0.500/);

    // A driver holds no verify permission at all; and even office, recording a
    // distance itself, may not verify its own record.
    await expect(callerFor(driver).ifta.distanceVerify({ distanceRef: split.distanceRefs[0], outcome: "verified" })).rejects.toThrow(/grants ifta.distance/);
    const own = await callerFor(office).ifta.distanceRecord({ financialEntityId: entityId, unitId, jurisdiction: "CA-SK", distanceKm: 10, periodStart: new Date("2026-07-20T00:00:00Z"), periodEnd: new Date("2026-07-21T00:00:00Z"), source: "operator_stated" });
    await expect(callerFor(office).ifta.distanceVerify({ distanceRef: own.distanceRef, outcome: "verified" })).rejects.toThrow(/may not verify/);
    await callerFor(bookkeeper).ifta.distanceVerify({ distanceRef: own.distanceRef, outcome: "rejected" }); // and out of the quarter
    for (const r of split.distanceRefs) await callerFor(office).ifta.distanceVerify({ distanceRef: r, outcome: "verified" });

    // Two fills on the ledger: one classified from the receipt, one unknown.
    const f1 = key("FUEL").slice(0, 60), f2 = key("FUEL").slice(0, 60);
    const FUEL_COMMON = "payerType, purpose, financialTreatment, reimbursementStatus, privateToFueler, hosRuleConclusion, status";
    const FUEL_COMMON_VALUES = "'company', 'company_vehicle_operation', 'company_operating_expense', 'not_applicable', 0, 'unknown', 'confirmed'";
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, occurredAt, fuelType, quantity, quantityUnit, totalCents, odometerKm, evidenceRecordId, jurisdiction, jurisdictionSource, ${FUEL_COMMON}) VALUES (?, ?, ?, '2026-07-12 06:10:00', 'diesel', 300, 'L', 45000, 120000, 1, 'CA-AB', 'receipt', ${FUEL_COMMON_VALUES})`, [f1, entityId, unitId]);
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, occurredAt, fuelType, quantity, quantityUnit, totalCents, odometerKm, ${FUEL_COMMON}) VALUES (?, ?, ?, '2026-07-12 17:30:00', 'diesel', 100, 'L', 17000, 120640, ${FUEL_COMMON_VALUES})`, [f2, entityId, unitId]);

    // The quarter, before classifying the second fill: one blocking exception, tax unknown.
    const q1 = await callerFor(bookkeeper).ifta.quarter({ financialEntityId: entityId, quarter: Q });
    expect(q1.units[0].byJurisdictionKm).toEqual({ "CA-AB": 480, "CA-BC": 160 });
    expect(q1.totals.litres).toBe(400);
    expect(q1.totals.kmPerLitre).toBe(1.6);
    expect(q1.units[0].odometerImpliedKm).toBe(640);
    expect(q1.reconciliation.odometerReconciledPct).toBe(100);
    expect(q1.reconciliation.receiptsMatchedPct).toBe(50);
    expect(q1.reconciliation.fuelJurisdictionKnownPct).toBe(50);
    expect(q1.exceptions.some(e => e.code === "fuel_jurisdiction_unknown")).toBe(true);
    expect(q1.determination).toBe("unknown");

    // Office classifies the second fill by statement; a statement may not overwrite a receipt.
    await callerFor(office).ifta.fuelJurisdictionSet({ fuelRef: f2, jurisdiction: "CA-BC", source: "operator_stated" });
    await expect(callerFor(office).ifta.fuelJurisdictionSet({ fuelRef: f1, jurisdiction: "CA-BC", source: "operator_stated" })).rejects.toThrow(/does not override/);
    const q2 = await callerFor(bookkeeper).ifta.quarter({ financialEntityId: entityId, quarter: Q });
    expect(q2.exceptions.some(e => e.code === "fuel_jurisdiction_unknown")).toBe(false);
    expect(q2.reconciliation.fuelJurisdictionKnownPct).toBe(100);
    expect(q2.jurisdictions.map(x => [x.jurisdiction, x.taxableLitres, x.taxPaidLitres, x.netLitres, x.rateStatus, x.taxDue])).toEqual([
      ["CA-AB", 300, 300, 0, "unverified", null],
      ["CA-BC", 100, 100, 0, "unverified", null],
    ]);
    expect(q2.determination).toBe("unknown");

    // Prepare: a snapshot with a hash and an honest tax determination. Finalize: refused — the rate is unverified.
    const prep = await callerFor(bookkeeper).ifta.quarterPrepare({ financialEntityId: entityId, quarter: Q });
    expect(prep.determination).toBe("unknown");
    expect(prep.taxDue).toBeNull();
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, taxDetermination, payloadHash FROM iftaReturns WHERE returnRef = ?", [prep.returnRef]);
    expect(row[0].status).toBe("prepared");
    expect(row[0].taxDetermination).toBe("unknown");
    expect(String(row[0].payloadHash)).toMatch(/^[a-f0-9]{64}$/);
    await expect(callerFor(preparer).ifta.quarterFinalize({ returnRef: prep.returnRef })).rejects.toThrow(/invented rate/);
    await expect(callerFor(bookkeeper).ifta.quarterFinalize({ returnRef: prep.returnRef })).rejects.toBeTruthy(); // not permitted, and the preparer anyway

    // The ledger moves after preparation: the snapshot no longer matches; the return must be prepared again.
    await pool.execute("UPDATE fuelTransactions SET quantity = 101 WHERE fuelRef = ?", [f2]);
    await expect(callerFor(preparer).ifta.quarterFinalize({ returnRef: prep.returnRef })).rejects.toThrow(/ledger has changed/);
  });
});
