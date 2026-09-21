import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { assetTwin, buildSchedule, capitalizationProposal, ccaPool, fiscalYearFor } from "./_core/capitalAssets";
import { CCA_CLASS_SEEDS } from "./_core/ccaSeeds";
import { determine } from "./_core/taxRuleEngine";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const verified = (ratePercent: number, halfYearRule: boolean | null = true) => ({ outcome: "determined" as const, parameters: { ratePercent, halfYearRule, firstYearFactor: null } });
const unverified = (cls: string) => determine(CCA_CLASS_SEEDS.filter(s => s.parameters.ccaClass === cls), { jurisdiction: "CA", ruleType: "cca_class", asOf: new Date("2026-09-10T00:00:00Z") }) as never;

describe("the pool is arithmetic on facts; the claim needs a verified rate", () => {
  it("adds at cost, disposes at the lesser of cost and proceeds, and computes the claim with the half-year rule when the rule says so", () => {
    const r = ccaPool({ ccaClass: "Class 16", openingUccCents: 10_000_000, additions: [{ assetRef: "A", costCents: 20_000_000 }], dispositions: [{ assetRef: "B", costCents: 8_000_000, proceedsCents: 3_000_000 }], classEmptiedAfterDispositions: false }, verified(40, true));
    expect(r).toMatchObject({ additionsCents: 20_000_000, dispositionsCents: 3_000_000, uccBeforeClaimCents: 27_000_000, recaptureCents: 0, terminalLossCents: 0, rate: { status: "verified", ratePercent: 40, halfYearApplied: true }, determination: "computed" });
    // base 10,000,000 + half of net additions 17,000,000 → 18,500,000 × 40% = 7,400,000
    expect(r.ccaClaimCents).toBe(7_400_000);
    expect(r.closingUccCents).toBe(27_000_000 - 7_400_000);
  });
  it("names recapture when the pool goes negative and a terminal loss when the class empties with a balance; proceeds over cost are a gain outside the schedule", () => {
    const rec = ccaPool({ ccaClass: "Class 10", openingUccCents: 1_000_000, additions: [], dispositions: [{ assetRef: "X", costCents: 5_000_000, proceedsCents: 6_000_000 }], classEmptiedAfterDispositions: false }, verified(30));
    expect(rec).toMatchObject({ dispositionsCents: 5_000_000, recaptureCents: 4_000_000, uccBeforeClaimCents: 0, ccaClaimCents: 0, closingUccCents: 0 });
    expect(rec.reasons[0]).toContain("capital gain, outside this schedule");
    const tl = ccaPool({ ccaClass: "Class 10", openingUccCents: 1_000_000, additions: [], dispositions: [{ assetRef: "X", costCents: 5_000_000, proceedsCents: 200_000 }], classEmptiedAfterDispositions: true }, verified(30));
    expect(tl).toMatchObject({ terminalLossCents: 800_000, uccBeforeClaimCents: 0, ccaClaimCents: 0 });
  });
  it("computes the pool but refuses the claim on the seeded, unverified rate — thirty percent is not written anywhere", () => {
    expect(CCA_CLASS_SEEDS.every(s => s.status === "unverified" && s.parameters.ratePercent === null && s.parameters.halfYearRule === null)).toBe(true);
    const r = ccaPool({ ccaClass: "Class 16", openingUccCents: 0, additions: [{ assetRef: "A", costCents: 20_000_000 }], dispositions: [], classEmptiedAfterDispositions: false }, unverified("Class 16"));
    expect(r).toMatchObject({ additionsCents: 20_000_000, uccBeforeClaimCents: 20_000_000, ccaClaimCents: null, closingUccCents: null, determination: "unknown" });
    expect(r.rate.status).toBe("unverified");
    expect(r.reasons[0]).toContain("cannot be computed until a person verifies");
    const noHalf = ccaPool({ ccaClass: "Class 8", openingUccCents: 0, additions: [{ assetRef: "A", costCents: 1_000_000 }], dispositions: [], classEmptiedAfterDispositions: false }, verified(20, null));
    expect(noHalf.determination).toBe("unknown");
    expect(noHalf.reasons[0]).toContain("half-year rule");
  });
  it("builds the schedule per class, leaves unverified classes out by name, and is partial when only some pools compute", () => {
    const s = buildSchedule({ fiscalYearStart: new Date("2025-11-01T00:00:00Z"), fiscalYearEnd: new Date("2026-10-31T23:59:59Z"), assets: [
      { assetRef: "T1", ccaClass: "Class 16", ccaClassVerified: true, acquiredAt: new Date("2026-03-01T00:00:00Z"), acquisitionCostCents: 20_000_000, disposedAt: null, disposalProceedsCents: null, status: "in_service" },
      { assetRef: "T2", ccaClass: "Class 16", ccaClassVerified: false, acquiredAt: new Date("2026-04-01T00:00:00Z"), acquisitionCostCents: 5_000_000, disposedAt: null, disposalProceedsCents: null, status: "in_service" },
      { assetRef: "P", ccaClass: null, ccaClassVerified: false, acquiredAt: new Date("2026-05-01T00:00:00Z"), acquisitionCostCents: 300_000, disposedAt: null, disposalProceedsCents: null, status: "in_service" },
      { assetRef: "E", ccaClass: "Class 8", ccaClassVerified: true, acquiredAt: new Date("2024-01-01T00:00:00Z"), acquisitionCostCents: 900_000, disposedAt: null, disposalProceedsCents: null, status: "expensed" },
    ], openingByClass: new Map([["Class 16", 3_000_000]]), rateFor: cls => cls === "Class 16" ? verified(40) as never : unverified(cls) });
    expect(s.pools.map(p => [p.ccaClass, p.additionsCents, p.ccaClaimCents])).toEqual([["Class 16", 20_000_000, Math.round((3_000_000 + 10_000_000) * 0.4)]]);
    expect(s.unclassified).toEqual([{ assetRef: "T2", reason: "Class Class 16 is a candidate, not verified" }, { assetRef: "P", reason: "No CCA class candidate" }]);
    expect(s.determination).toBe("partial");
    expect(s.totalClaimCents).toBe(5_200_000);
  });
  it("proposes capitalize or expense from a threshold and reviews without one; finds the fiscal year", () => {
    expect(capitalizationProposal({ costCents: 500_000, thresholdCents: 250_000, description: "x" }).proposal).toBe("capitalize");
    expect(capitalizationProposal({ costCents: 100_000, thresholdCents: 250_000, description: "x" }).proposal).toBe("expense");
    expect(capitalizationProposal({ costCents: 100_000, thresholdCents: null, description: "x" })).toMatchObject({ proposal: "review" });
    const fy = fiscalYearFor(new Date("2026-09-10T00:00:00Z"), 10, 31);
    expect(fy.start.toISOString().slice(0, 10)).toBe("2025-11-01");
    expect(fy.end.toISOString().slice(0, 10)).toBe("2026-10-31");
  });
});

describe("the twin names what it cannot know", () => {
  it("computes per-km and per-hour cost only when every cost is known, and projects replacement from an owner-stated life", () => {
    const acquiredAt = new Date("2024-01-01T00:00:00Z"), asOf = new Date("2026-01-01T00:00:00Z");
    // 160,000 km in two years is ~219 km/day: a 600,000 km life lands at ~7.5 years, before the ten-year date — so kilometres decide.
    const full = assetTwin({ asset: { acquisitionCostCents: 20_000_000, acquiredAt, expectedLifeKm: 600_000, expectedLifeYears: 10, financing: "owned", status: "in_service" }, fuel: { cents: 6_000_000, litres: 40_000, transactions: 120 }, shop: { partsCents: 1_500_000, labourCents: 900_000, reasons: [] }, tires: { costPerKmCentsKnown: [1.29], unknownRuns: 0 }, distanceKm: 160_000, engineHours: 4_000, downtimeHours: 96, trips: 900, asOf });
    expect(full).toMatchObject({ operatingCostCents: 8_400_000, costPerKmCents: 52.5, costPerHourCents: 2_100, fuelLitresPer100Km: 25, determination: "computed", unknowns: [] });
    expect(full.replacement.basis).toContain("600000 km at the observed 219 km/day");
    expect(full.replacement.projectedAt?.toISOString().slice(0, 7)).toBe("2031-07");
    const partial = assetTwin({ asset: null, fuel: { cents: null, litres: null, transactions: 0 }, shop: { partsCents: 1_500_000, labourCents: null, reasons: ["Labour rate not configured — labour cost unknown"] }, tires: { costPerKmCentsKnown: [], unknownRuns: 1 }, distanceKm: null, engineHours: null, downtimeHours: null, trips: 0, asOf });
    expect(partial).toMatchObject({ operatingCostCents: null, knownCostCents: 1_500_000, costPerKmCents: null, determination: "partial" });
    expect(partial.unknowns).toEqual(["No capital asset record — acquisition cost and life are unknown", "Fuel cost unknown — no company-paid fuel transactions carry a total", "Shop labour cost unknown — no labour rate configured", "1 tire run(s) without both odometers", "Distance unknown — no completed trips with a recorded distance"]);
    expect(partial.replacement).toEqual({ projectedAt: null, basis: "No expected life on the asset — replacement is not projected" });
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who capitalizes, who verifies a class, who reviews the schedule", () => {
  it("keeps the capital review to controller and management, class verification to the tax side, and the schedule review above the preparer", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "asset.capital.review" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "asset.cca.verify" }).allowed).sort()).toEqual(["controller", "external_accountant", "tax_preparer"]);
    expect(authorize({ userId: 1, roles: ["bookkeeper"], permission: "cca.prepare" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["bookkeeper"], permission: "cca.review" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_900_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a year in the asset register", () => {
  it("registers one truck once, capitalizes it by a second person, holds the class as a candidate, refuses the schedule review while the rate is unverified, and reports the twin honestly", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const controller = await withRole("controller");
    const accountant = await withRole("external_accountant");
    const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay, status, createdAt) VALUES (?, 'LeaseOS Hydrovac Ltd.', 'corporation', 'CA-AB', 10, 31, 'active', NOW())", [key("ENT").slice(0, 40)]);
    const entityId = Number(ent.insertId);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
    const unitId = Number(un.insertId);

    // One truck, one identity: a second asset on the same unit is refused. Without a threshold, capitalization is a review.
    const reg = await callerFor(bookkeeper).asset.register({ financialEntityId: entityId, kind: "unit", unitId, description: "2026 vac truck, Unit 142", acquiredAt: new Date("2026-03-01T00:00:00Z"), acquisitionCostCents: 20_000_000, financing: "financed", lender: "Truck Finance Co", financedPrincipalCents: 15_000_000, expectedLifeKm: 800_000, expectedLifeYears: 10 });
    expect(reg).toMatchObject({ status: "pending_capital_review", proposal: { proposal: "review" } });
    await expect(callerFor(bookkeeper).asset.register({ financialEntityId: entityId, kind: "unit", unitId, description: "again", acquiredAt: new Date(), acquisitionCostCents: 1 })).rejects.toThrow(/already asset/);
    await expect(callerFor(bookkeeper).asset.register({ financialEntityId: entityId, kind: "unit", description: "no unit", acquiredAt: new Date(), acquisitionCostCents: 1 })).rejects.toThrow(/one truck, one identity/);
    // The recorder may not capitalize; the controller does.
    await expect(callerFor(bookkeeper).asset.capitalReview({ assetRef: reg.assetRef, decision: "capitalize", reason: "It is a truck" })).rejects.toBeTruthy();
    expect((await callerFor(controller).asset.capitalReview({ assetRef: reg.assetRef, decision: "capitalize", reason: "Heavy truck for hauling" })).status).toBe("in_service");

    // The class is a candidate with a source; an owner-stated one cannot be verified; the accountant's can.
    await callerFor(bookkeeper).asset.ccaClassSet({ assetRef: reg.assetRef, ccaClass: "Class 16", source: "owner_stated" });
    await expect(callerFor(accountant).asset.ccaClassVerify({ assetRef: reg.assetRef })).rejects.toThrow(/only an accountant-sourced class/);
    await callerFor(accountant).asset.ccaClassSet({ assetRef: reg.assetRef, ccaClass: "Class 16", source: "accountant" });
    expect((await callerFor(accountant).asset.ccaClassVerify({ assetRef: reg.assetRef })).verificationStatus).toBe("verified");

    // The schedule: the pool computes, the claim does not — the seeded rate is unverified; preparation records that; review is refused.
    const asOf = new Date("2026-10-15T00:00:00Z");
    const s = await callerFor(bookkeeper).asset.schedule({ financialEntityId: entityId, asOf });
    expect(s.fiscalYear.end.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(s.pools[0]).toMatchObject({ ccaClass: "Class 16", additionsCents: 20_000_000, uccBeforeClaimCents: 20_000_000, ccaClaimCents: null, closingUccCents: null, determination: "unknown" });
    expect(s.pools[0].rate.status).toBe("unverified");
    expect(s.determination).toBe("unknown");
    const prep = await callerFor(bookkeeper).asset.schedulePrepare({ financialEntityId: entityId, asOf });
    expect(prep).toMatchObject({ determination: "unknown", totalCcaClaimCents: null });
    await expect(callerFor(bookkeeper).asset.scheduleReview({ scheduleRef: prep.scheduleRef, note: "own" })).rejects.toBeTruthy();
    await expect(callerFor(controller).asset.scheduleReview({ scheduleRef: prep.scheduleRef, note: "Looks right" })).rejects.toThrow(/cannot be reviewed as a tax fact/);
    const [bal] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM ccaClassBalances WHERE financialEntityId = ?", [entityId]);
    expect(Number(bal[0].n)).toBe(0);                                          // nothing carried forward from an unknown schedule

    // The twin: the asset's cost and life are known; fuel, labour and distance are not, and it says so; replacement is projected from the stated years.
    const twin = await callerFor(bookkeeper).asset.twin({ unitId });
    expect(twin.asset).toMatchObject({ assetRef: reg.assetRef, ccaClass: "Class 16", ccaClassVerified: true, financing: "financed" });
    expect(twin.determination).toBe("unknown");
    expect(twin.unknowns).toContain("Fuel cost unknown — no company-paid fuel transactions carry a total");
    expect(twin.unknowns).toContain("Distance unknown — no completed trips with a recorded distance");
    expect(twin.replacement.projectedAt?.toISOString().slice(0, 4)).toBe("2036");
    // Disposal above cost is noted as a gain outside the schedule; the register carries the proceeds.
    const disp = await callerFor(bookkeeper).asset.dispose({ assetRef: reg.assetRef, disposedAt: new Date("2026-10-20T00:00:00Z"), proceedsCents: 21_000_000 });
    expect(disp.note).toContain("capital gain");
    const s2 = await callerFor(bookkeeper).asset.schedule({ financialEntityId: entityId, asOf });
    expect(s2.pools[0]).toMatchObject({ dispositionsCents: 20_000_000, uccBeforeClaimCents: 0, terminalLossCents: 0 });
    expect(s2.pools[0].reasons.some(r => r.includes("capital gain"))).toBe(true);
    expect(accountant).toBeGreaterThan(0);
  });
});
