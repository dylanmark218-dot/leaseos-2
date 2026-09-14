import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { claimDecision, claimEligibility, countAdjustment, installDecision, issueDecision, reorderFindings, signedQty, stockPositions, tireRun, treadStatus, workOrderCost, type Movement } from "./_core/fleetShop";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const at = (iso: string) => new Date(iso);
const mv = (over: Partial<Movement> & { kind: Movement["kind"]; qtySigned: number }): Movement => ({ partId: 1, bin: "MAIN", unitCostCents: null, at: at("2026-09-10T08:00:00Z"), ...over });

describe("stock is a derivation over movements", () => {
  it("sums signed movements, weights cost over receives, tracks cores separately, and knows the difference between zero and unknown", () => {
    const pos = stockPositions([
      mv({ kind: "receive", qtySigned: 10, unitCostCents: 4_000, at: at("2026-09-01T00:00:00Z") }),
      mv({ kind: "receive", qtySigned: 10, unitCostCents: 6_000, at: at("2026-09-02T00:00:00Z") }),
      mv({ kind: "issue", qtySigned: -4, unitCostCents: 5_000, at: at("2026-09-03T00:00:00Z") }),
      mv({ kind: "core_out", qtySigned: 4, at: at("2026-09-03T00:00:00Z") }),
      mv({ kind: "core_returned", qtySigned: 3, at: at("2026-09-05T00:00:00Z") }),
      mv({ kind: "adjust_count", qtySigned: -1, at: at("2026-09-06T00:00:00Z") }),
    ]);
    expect(pos).toEqual([{ partId: 1, bin: "MAIN", onHandQty: 15, avgUnitCostCents: 5_000, coresOutstanding: 1, lastMovementAt: at("2026-09-06T00:00:00Z") }]);
    expect(signedQty("issue", 3)).toBe(-3);
    expect(signedQty("receive", 3)).toBe(3);
    expect(() => signedQty("adjust_count", 3)).toThrow(/computed from the counted quantity/);
    expect(issueDecision({ onHandQty: 2, qty: 5, partNumber: "FLT-1" }).refusal).toBe("FLT-1: 2 on hand, 5 requested — short by 3; receive stock or record the shortage");
    expect(countAdjustment(15, 13)).toEqual({ qtySigned: -2, variance: -2, finding: "Count 13 against 15 on record — variance -2; the record is adjusted and the variance kept" });
    const findings = reorderFindings([{ id: 1, partNumber: "A", minQty: 20, maxQty: null }, { id: 2, partNumber: "B", minQty: 1, maxQty: 5 }, { id: 3, partNumber: "C", minQty: 2, maxQty: null }], [...pos, { partId: 2, bin: "MAIN", onHandQty: 9, avgUnitCostCents: null, coresOutstanding: 0, lastMovementAt: null }]);
    expect(findings.map(f => [f.partNumber, f.finding])).toEqual([["A", "below_min"], ["B", "above_max"], ["C", "no_stock_record"]]);
    expect(findings[2].detail).toContain("unknown, not zero");
  });
});

describe("a tire is in one place, and its kilometres are known or they are not", () => {
  it("refuses a bad position, a tire installed elsewhere, an occupied position and a trailer tire on a steer axle", () => {
    expect(installDecision({ tireStatus: "in_stock", positionType: "drive", axlePosition: "2LO", occupiedPositions: ["2LI"], tireCurrentlyInstalled: false }).permitted).toBe(true);
    const r = installDecision({ tireStatus: "in_stock", positionType: "trailer", axlePosition: "1X", occupiedPositions: ["1X"], tireCurrentlyInstalled: true });
    expect(r.refusals).toEqual(["Axle position 1X is not of the form 1L, 2LO, 3RI", "Tire is installed elsewhere — remove it first; a tire is in one place", "Position 1X is occupied — remove that tire first", "A trailer tire is not installed on a steer axle"]);
  });
  it("computes km and cost per km only with both odometers and a cost; otherwise says why it cannot", () => {
    expect(tireRun({ installOdometerKm: 120_000, removeOdometerKm: 168_000, installTreadMm: 18, removeTreadMm: 6.5, purchaseCostCents: 62_000 })).toEqual({ kmRun: 48_000, costPerKmCents: 1.29, treadUsedMm: 11.5, determination: "computed", reasons: [] });
    const noKm = tireRun({ installOdometerKm: null, removeOdometerKm: 168_000, installTreadMm: null, removeTreadMm: null, purchaseCostCents: 62_000 });
    expect(noKm).toMatchObject({ kmRun: null, costPerKmCents: null, determination: "unknown" });
    expect(noKm.reasons[0]).toContain("both required");
    expect(tireRun({ installOdometerKm: 120_000, removeOdometerKm: 118_000, installTreadMm: null, removeTreadMm: null, purchaseCostCents: 1 }).reasons[0]).toContain("REVIEW");
    expect(tireRun({ installOdometerKm: 120_000, removeOdometerKm: 168_000, installTreadMm: null, removeTreadMm: null, purchaseCostCents: null }).reasons[0]).toContain("no purchase cost");
    expect(treadStatus(3.2, 2.4)).toBe("approaching_limit");
    expect(treadStatus(2.0, 2.4)).toBe("below_limit");
    expect(treadStatus(null, 2.4)).toBe("unknown");
  });
});

describe("a warranty claim is eligible only under a verified policy, and decided by someone else", () => {
  it("returns unknown without a policy or with an unverified one, expired past coverage, eligible within it", () => {
    const at1 = at("2026-09-10T00:00:00Z");
    expect(claimEligibility({ policy: null, at: at1, kmSincePurchase: 1, hoursSincePurchase: null }).eligibility).toBe("unknown");
    expect(claimEligibility({ policy: { verificationStatus: "unverified", coverageUntil: at("2027-01-01T00:00:00Z"), coverageKm: null, coverageHours: null }, at: at1, kmSincePurchase: 1, hoursSincePurchase: null }).reason).toContain("unverified");
    expect(claimEligibility({ policy: { verificationStatus: "verified", coverageUntil: at("2026-06-01T00:00:00Z"), coverageKm: null, coverageHours: null }, at: at1, kmSincePurchase: 1, hoursSincePurchase: null })).toEqual({ eligibility: "expired", reason: "Coverage ended 2026-06-01" });
    expect(claimEligibility({ policy: { verificationStatus: "verified", coverageUntil: null, coverageKm: 100_000, coverageHours: null }, at: at1, kmSincePurchase: null, hoursSincePurchase: null }).reason).toContain("not on record");
    expect(claimEligibility({ policy: { verificationStatus: "verified", coverageUntil: null, coverageKm: 100_000, coverageHours: null }, at: at1, kmSincePurchase: 48_000, hoursSincePurchase: null }).eligibility).toBe("eligible");
    expect(claimDecision({ raisedByUserId: 1, deciderUserId: 1, decision: "approved", eligibility: "eligible" }).refusals[0]).toContain("may not decide it");
    expect(claimDecision({ raisedByUserId: 1, deciderUserId: 2, decision: "approved", eligibility: "unknown" }).refusals[0]).toContain("verify the policy");
    expect(claimDecision({ raisedByUserId: 1, deciderUserId: 2, decision: "denied", eligibility: "unknown" }).permitted).toBe(true);
  });
});

describe("cost says what it knows", () => {
  it("is a floor when a part has no cost and unknown labour when no rate is configured", () => {
    expect(workOrderCost({ laborMinutes: 90, labourRateCentsPerHour: 12_000, issues: [{ qty: 2, unitCostCents: 5_000 }] })).toEqual({ partsCents: 10_000, partsUnknownCount: 0, labourCents: 18_000, labourMinutes: 90, totalCents: 28_000, determination: "computed", reasons: [] });
    const partial = workOrderCost({ laborMinutes: 90, labourRateCentsPerHour: null, issues: [{ qty: 2, unitCostCents: 5_000 }, { qty: 1, unitCostCents: null }] });
    expect(partial).toMatchObject({ partsCents: 10_000, partsUnknownCount: 1, labourCents: null, totalCents: null, determination: "partial" });
    expect(partial.reasons).toEqual(["1 issued part(s) have no cost on record — parts cost is a floor, not a total", "Labour rate not configured — labour cost unknown"]);
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who counts, who decides, who verifies", () => {
  it("keeps counts to the shop lead, warranty decisions above the shop, and recall verification to the shop lead and safety", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "shop.parts.count" }).allowed)).toEqual(["shop_lead"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "shop.warranty.decide" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "shop.recall.verify" }).allowed).sort()).toEqual(["safety", "shop_lead"]);
    expect(authorize({ userId: 1, roles: ["mechanic"], permission: "shop.parts.move" }).allowed).toBe(true);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_800_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a day in the shop", () => {
  it("receives, issues to a work order with cores, refuses a short issue, counts with a kept variance, runs a tire through two installs, raises and decides a claim by two people, records a recall unverified, and costs the unit honestly", async () => {
    const mechanic = await withRole("mechanic");
    const lead = await withRole("shop_lead");
    const controller = await withRole("controller");
    const safety = await withRole("safety");
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
    const unitId = Number(un.insertId);
    const woNo = key("WO").slice(0, 40);
    await pool.execute("INSERT INTO workOrders (workOrderNumber, unitId, status, priority, openedAt, laborMinutes, createdAt, updatedAt) VALUES (?, ?, 'open', 'routine', NOW(), 90, NOW(), NOW())", [woNo, unitId]);
    const shop = callerFor(mechanic).shop;
    const alt = key("ALT").slice(0, 40);
    await callerFor(lead).shop.partCreate({ partNumber: alt, description: "Alternator, reman", category: "electrical", isCore: true, coreChargeCents: 15_000, minQty: 2, maxQty: 6 });
    await expect(callerFor(lead).shop.partCreate({ partNumber: key("X").slice(0, 40), description: "x", category: "other", isCore: true })).rejects.toThrow(/needs its core charge/);

    // Received twice at different costs; on hand 3 at the weighted average.
    await shop.partReceive({ partNumber: alt, qty: 1, unitCostCents: 40_000 });
    const r2 = await shop.partReceive({ partNumber: alt, qty: 2, unitCostCents: 46_000 });
    expect(r2).toMatchObject({ onHandQty: 3, avgUnitCostCents: 44_000 });
    // Issued to the work order at the average; the core goes out with it; a short issue is refused by the shortfall.
    const iss = await shop.partIssue({ partNumber: alt, qty: 1, workOrderNumber: woNo });
    expect(iss).toMatchObject({ onHandQty: 2, issuedAtAvgCostCents: 44_000 });
    expect(iss.coreMovementRef).toMatch(/^MOV-/);
    await expect(shop.partIssue({ partNumber: alt, qty: 5, workOrderNumber: woNo })).rejects.toThrow(/short by 3/);
    // Core returned; a second return beyond what is outstanding is refused.
    expect((await shop.coreReturn({ partNumber: alt, qty: 1 })).coresOutstanding).toBe(0);
    await expect(shop.coreReturn({ partNumber: alt, qty: 1 })).rejects.toThrow(/0 core\(s\) outstanding/);
    // A count finds one fewer: the lead adjusts; the mechanic cannot count; the stock view names the reorder.
    await expect(shop.partCount({ partNumber: alt, countedQty: 1, reason: "Monthly count" })).rejects.toBeTruthy();
    const cnt = await callerFor(lead).shop.partCount({ partNumber: alt, countedQty: 1, reason: "Monthly count" });
    expect(cnt).toMatchObject({ variance: -1 });
    const st = await shop.stock({ partNumber: alt });
    expect(st.positions[0]).toMatchObject({ onHandQty: 1, avgUnitCostCents: 44_000, coresOutstanding: 0 });
    expect(st.reorder[0]).toMatchObject({ partNumber: alt, finding: "below_min", detail: "1 on hand, minimum 2" });
    const [ledger] = await pool.execute<mysql.RowDataPacket[]>("SELECT kind, qtySigned FROM partMovements WHERE partId = (SELECT id FROM parts WHERE partNumber = ?) ORDER BY id", [alt]);
    expect(ledger.map(l => [l.kind, Number(l.qtySigned)])).toEqual([["receive", 1], ["receive", 2], ["issue", -1], ["core_out", 1], ["core_returned", 1], ["adjust_count", -1]]); // nothing overwritten

    // A tire: registered with cost, installed with an odometer, measured, removed with an odometer → cost per km; then reinstalled on another unit without an odometer → unknown.
    const serial = key("TS").slice(0, 40);
    await shop.tireRegister({ serial, size: "11R22.5", positionType: "drive", purchaseCostCents: 62_000 });
    const ins = await shop.tireInstall({ serial, unitId, axlePosition: "2LO", installedAt: new Date("2026-03-01T00:00:00Z"), installOdometerKm: 120_000, installTreadMm: 18 });
    expect(ins.findings).toEqual([]);
    await expect(shop.tireInstall({ serial, unitId, axlePosition: "2LI", installedAt: new Date(), installOdometerKm: 1 })).rejects.toThrow(/installed elsewhere/);
    const meas = await shop.tireMeasure({ serial, measuredAt: new Date("2026-06-01T00:00:00Z"), treadMm: 11, pressureKpa: 690, odometerKm: 145_000 });
    expect(meas).toEqual({ treadStatus: "ok", limitMm: 2.4 });
    const rem = await shop.tireRemove({ serial, removedAt: new Date("2026-09-01T00:00:00Z"), removeOdometerKm: 168_000, removeTreadMm: 6.5, removalReason: "rotation" });
    expect(rem).toMatchObject({ kmRun: 48_000, costPerKmCents: 1.29, treadUsedMm: 11.5, determination: "computed" });
    const [un2] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
    const ins2 = await shop.tireInstall({ serial, unitId: Number(un2.insertId), axlePosition: "3RI", installedAt: new Date("2026-09-02T00:00:00Z") });
    expect(ins2.findings[0]).toContain("UNKNOWN");
    const hist = await shop.tireHistory({ serial });
    expect(hist.installations).toHaveLength(2);
    expect(hist.lifetime.determination).toBe("unknown");                     // the second run has no odometers, so the lifetime does not pretend

    // Warranty: an unverified policy makes a claim unknown; approval is refused on unknown; the raiser cannot decide; the controller denies with a reason; a verified policy's claim is approved and credited to a warranty_credit line.
    const pol = await shop.warrantyPolicyRecord({ subjectType: "tire", subjectId: 1, coverageKm: 100_000, terms: "Casing warranty" });
    expect(pol.verificationStatus).toBe("unverified");
    const claim = await shop.warrantyClaimRaise({ policyRef: pol.policyRef, tireSerial: serial, claimedCents: 30_000, reason: "Belt separation at 48,000 km", kmSincePurchase: 48_000 });
    expect(claim.eligibility).toBe("unknown");
    await expect(callerFor(controller).shop.warrantyClaimDecide({ claimRef: claim.claimRef, decision: "approved", reason: "looks fine" })).rejects.toThrow(/verify the policy/);
    await expect(callerFor(mechanic).shop.warrantyClaimDecide({ claimRef: claim.claimRef, decision: "denied", reason: "self" })).rejects.toBeTruthy();
    expect((await callerFor(controller).shop.warrantyClaimDecide({ claimRef: claim.claimRef, decision: "denied", reason: "Policy terms not on file" })).status).toBe("denied");
    await expect(shop.warrantyPolicyRecord({ subjectType: "tire", subjectId: 1, coverageKm: 100_000, verified: true })).rejects.toThrow(/source document/);
    const vpol = await shop.warrantyPolicyRecord({ subjectType: "tire", subjectId: 1, coverageKm: 100_000, verified: true, sourceDocumentEvidenceId: 1 });
    const claim2 = await shop.warrantyClaimRaise({ policyRef: vpol.policyRef, tireSerial: serial, claimedCents: 30_000, reason: "Belt separation at 48,000 km", kmSincePurchase: 48_000 });
    expect(claim2.eligibility).toBe("eligible");
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'tires')", [key("V").slice(0, 60)]);
    const [bill] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?, 1, ?, ?, NOW(), NOW(), -30000, 0, -30000, 'match', 'received')", [key("BILL").slice(0, 40), Number(ven.insertId), key("VI").slice(0, 40)]);
    const [line] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendorBillLines (vendorBillId, lineNo, lineType, description, quantity, unitPriceCents, amountCents, coreStatus, createdAt) VALUES (?, 1, 'warranty_credit', 'Casing credit', 1, -30000, -30000, 'not_applicable', NOW())", [Number(bill.insertId)]);
    const dec = await callerFor(controller).shop.warrantyClaimDecide({ claimRef: claim2.claimRef, decision: "approved", reason: "Vendor credit received", creditVendorBillLineId: Number(line.insertId), creditedCents: 30_000 });
    expect(dec.status).toBe("credited");

    // A recall: recorded unverified by the mechanic; a unit cannot be cleared of it until verified; the recorder cannot verify; safety verifies; the same notice twice is one.
    const rc = await shop.recallRecord({ source: "OEM", sourceRef: "SB-2026-114", summary: "Steering shaft yoke inspection on affected serial range", unitIds: [unitId] });
    expect(rc).toMatchObject({ duplicate: false, verificationStatus: "unverified", unitsMarkedUnknown: 1 });
    expect((await shop.recallRecord({ source: "OEM", sourceRef: "SB-2026-114", summary: "Steering shaft yoke inspection on affected serial range" })).duplicate).toBe(true);
    await expect(shop.recallUnitDecide({ recallRef: rc.recallRef, unitId, status: "not_affected" })).rejects.toThrow(/verify the notice first/);
    await expect(callerFor(lead).shop.recallVerify({ recallRef: rc.recallRef })).resolves.toMatchObject({ verificationStatus: "verified" });
    await expect(shop.recallUnitDecide({ recallRef: rc.recallRef, unitId, status: "completed" })).rejects.toThrow(/needs the work order/);
    expect((await shop.recallUnitDecide({ recallRef: rc.recallRef, unitId, status: "completed", workOrderNumber: woNo })).status).toBe("completed");

    // Tools: checked out once, refused twice, returned needing calibration.
    const tool = key("T").slice(0, 40);
    await shop.toolRegister({ serial: tool, description: "Torque wrench 3/4" });
    await shop.toolCheckout({ serial: tool, workerUserId: mechanic });
    await expect(shop.toolCheckout({ serial: tool, workerUserId: lead })).rejects.toThrow(/checked out/);
    expect((await shop.toolReturn({ serial: tool, condition: "needs_calibration" })).status).toBe("out_for_calibration");

    // The unit's cost: the alternator at its average, labour unknown without a rate, then computed with one; tire runs listed with their determinations.
    const uc = await shop.unitCost({ unitId });
    expect(uc.totals).toMatchObject({ partsCents: 44_000, labourCents: null, shopCents: null, determination: "partial" });
    expect(uc.reasons).toContain("Labour rate not configured — labour cost unknown");
    const uc2 = await shop.unitCost({ unitId, labourRateCentsPerHour: 12_000 });
    expect(uc2.totals).toMatchObject({ partsCents: 44_000, labourCents: 18_000, shopCents: 62_000 });
    expect(uc2.tires[0]).toMatchObject({ serial, axlePosition: "2LO", kmRun: 48_000, costPerKmCents: 1.29 });
    expect(safety).toBeGreaterThan(0);
  });
});
