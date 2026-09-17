import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  assessAccrual, decideApproval, fourWayMatch, proposeCustomerRecovery,
  reconcileBillLines, releasePathFor, roadsideConsequences, routeApproval,
  billApprovalReleasesUnit, type SpendingLimit,
} from "./_core/purchasing";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const LIMITS: SpendingLimit[] = [
  { role: "driver", emergencyPurchaseLimit: 500, standardPurchaseLimit: 200, canApproveUpTo: 0 },
  { role: "shop_lead", emergencyPurchaseLimit: 2500, standardPurchaseLimit: 1500, canApproveUpTo: 2500 },
  { role: "management", emergencyPurchaseLimit: 10000, standardPurchaseLimit: 10000, canApproveUpTo: 10000 },
  { role: "controller", emergencyPurchaseLimit: 25000, standardPurchaseLimit: 25000, canApproveUpTo: 25000 },
];

/* ------------------------------------------------------------------ */
/* Spending limits are data; requester ≠ approver                       */
/* ------------------------------------------------------------------ */

describe("spending limits and approval routing", () => {
  it("lets a driver self-authorize a $180 emergency and routes $2,200 to a shop lead or above", () => {
    expect(routeApproval({ amount: 180, emergency: true, requesterRoles: ["driver"], limits: LIMITS }).requiresApproval).toBe(false);
    const r = routeApproval({ amount: 2200, emergency: true, requesterRoles: ["driver"], limits: LIMITS });
    expect(r.requiresApproval).toBe(true);
    expect(r.approverRoles).toEqual(["shop_lead", "management", "controller"]);
  });

  it("uses the emergency limit only for emergencies", () => {
    expect(routeApproval({ amount: 400, emergency: true, requesterRoles: ["driver"], limits: LIMITS }).requiresApproval).toBe(false);
    expect(routeApproval({ amount: 400, emergency: false, requesterRoles: ["driver"], limits: LIMITS }).requiresApproval).toBe(true);
  });

  it("knows nothing about limits that were not configured", () => {
    const r = routeApproval({ amount: 100, emergency: true, requesterRoles: ["driver"], limits: [] });
    expect(r.requiresApproval).toBe(true);
    expect(r.approverRoles).toEqual([]);
    expect(r.reason).toContain("policy-controlled");
  });

  it("refuses the requester approving their own request, whatever their limit", () => {
    const d = decideApproval({ requestedByUserId: 7, approverUserId: 7, approverRoles: ["controller"], estimatedAmount: 100, authorizedMaximum: 100, limits: LIMITS });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("does not approve it");
  });

  it("refuses an approver authorizing beyond their own cap, or below the estimate", () => {
    const over = decideApproval({ requestedByUserId: 7, approverUserId: 8, approverRoles: ["shop_lead"], estimatedAmount: 2200, authorizedMaximum: 3000, limits: LIMITS });
    expect(over.ok).toBe(false);
    const under = decideApproval({ requestedByUserId: 7, approverUserId: 8, approverRoles: ["management"], estimatedAmount: 2200, authorizedMaximum: 1000, limits: LIMITS });
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).toContain("below the estimate");
    const ok = decideApproval({ requestedByUserId: 7, approverUserId: 8, approverRoles: ["shop_lead"], estimatedAmount: 2200, authorizedMaximum: 2500, limits: LIMITS });
    expect(ok.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Bill lines                                                           */
/* ------------------------------------------------------------------ */

const tireBill = () => [
  { lineNo: 1, lineType: "part" as const, description: "Steer tire 11R22.5", quantity: 1, unitPrice: 1250, amount: 1250 },
  { lineNo: 2, lineType: "service_call" as const, description: "Roadside callout", quantity: 1, unitPrice: 350, amount: 350 },
  { lineNo: 3, lineType: "labour" as const, description: "Mount and balance", quantity: 2.5, unitPrice: 170, amount: 425 },
  { lineNo: 4, lineType: "environmental_fee" as const, description: "Tire levy", quantity: 1, unitPrice: 25, amount: 25 },
  { lineNo: 5, lineType: "tax" as const, description: "GST", quantity: 1, unitPrice: 102.5, amount: 102.5 },
];

describe("bill lines must add up, and a core charge stays open", () => {
  it("reconciles the flat-tire bill from the specification", () => {
    const r = reconcileBillLines({ lines: tireBill(), statedSubtotal: 2050, statedTax: 102.5, statedTotal: 2152.5 });
    expect(r.ok, r.refusals.join("; ")).toBe(true);
    expect(r.subtotal).toBe(2050);
  });

  it("refuses a line whose quantity × price is not its amount, and a stated total the lines do not reach", () => {
    const bad = tireBill().map(l => (l.lineNo === 3 ? { ...l, amount: 500 } : l));
    const r = reconcileBillLines({ lines: bad, statedSubtotal: 2050, statedTax: 102.5, statedTotal: 2152.5 });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("Line 3");
  });

  it("requires a credit to be negative and a charge to be positive", () => {
    const lines = [
      { lineNo: 1, lineType: "part" as const, description: "Alternator", quantity: 1, unitPrice: 1400, amount: 1400 },
      { lineNo: 2, lineType: "core_charge" as const, description: "Core", quantity: 1, unitPrice: 450, amount: 450 },
      { lineNo: 3, lineType: "core_credit" as const, description: "Core returned", quantity: 1, unitPrice: 450, amount: 450 },
    ];
    const r = reconcileBillLines({ lines, statedSubtotal: 2300, statedTax: 0, statedTotal: 2300 });
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toContain("core_credit must be negative");
  });

  it("reports the core charge open even when the invoice shows a credit — the credit is a promise", () => {
    const lines = [
      { lineNo: 1, lineType: "part" as const, description: "Alternator", quantity: 1, unitPrice: 1400, amount: 1400 },
      { lineNo: 2, lineType: "core_charge" as const, description: "Core", quantity: 1, unitPrice: 450, amount: 450 },
      { lineNo: 3, lineType: "core_credit" as const, description: "Core returned", quantity: 1, unitPrice: -450, amount: -450 },
    ];
    const r = reconcileBillLines({ lines, statedSubtotal: 1400, statedTax: 0, statedTotal: 1400 });
    expect(r.ok).toBe(true);
    expect(r.openCoreCharges).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Four-way match                                                       */
/* ------------------------------------------------------------------ */

describe("four-way match catches what three-way cannot", () => {
  const base = {
    authorization: { authorizedMaximum: 2500, vendorId: 12, unitId: 142, category: "roadside_tire", quantities: { tire: 2 } },
    operationalEvent: { unitId: 142, occurredAt: new Date("2026-09-30T02:15:00Z"), quantities: { tire: 2 } },
    evidence: { present: true, quantities: { tire: 2 } },
  };

  it("matches when authorized, confirmed, evidenced and billed all agree", () => {
    const m = fourWayMatch({ ...base, bill: { vendorId: 12, unitId: 142, serviceDate: new Date("2026-09-30T04:00:00Z"), total: 2152.5, quantities: { tire: 2 } } });
    expect(m.outcome).toBe("match");
  });

  it("flags two authorized, two confirmed, three billed", () => {
    const m = fourWayMatch({ ...base, bill: { vendorId: 12, unitId: 142, serviceDate: new Date("2026-09-30T04:00:00Z"), total: 2152.5, quantities: { tire: 3 } } });
    expect(m.outcome).toBe("mismatch");
    expect(m.variances.join(" ")).toContain("tire: authorized 2, confirmed 2, evidenced 2, billed 3");
  });

  it("flags a bill above the authorized maximum, a different vendor, and a different unit — against both the authorization and the event", () => {
    const m = fourWayMatch({ ...base, bill: { vendorId: 99, unitId: 218, serviceDate: null, total: 2600, quantities: { tire: 2 } } });
    expect(m.outcome).toBe("mismatch");
    // Vendor, maximum, unit-vs-authorization, unit-vs-event. Four sources
    // means the unit disagreement is reported from both sides.
    expect(m.variances).toHaveLength(4);
    expect(m.variances.filter(v => v.includes("unit 218"))).toHaveLength(2);
  });

  it("is partial, not matched, when evidence or authorization is missing", () => {
    const m = fourWayMatch({ ...base, evidence: { present: false }, bill: { vendorId: 12, unitId: 142, serviceDate: null, total: 2152.5 } });
    expect(m.outcome).toBe("partial");
    expect(m.missing).toContain("receipt or photo evidence");
  });
});

/* ------------------------------------------------------------------ */
/* What a bill does NOT do; recovery; accrual                           */
/* ------------------------------------------------------------------ */

describe("a vendor's invoice never makes a truck dispatch-ready", () => {
  it("returns false for every severity", () => {
    for (const sev of ["advisory", "inspection_required", "critical"] as const) {
      expect(billApprovalReleasesUnit("ready_to_pay", sev)).toBe(false);
    }
  });
  it("names the release path from the existing mechanic-release rule", () => {
    expect(releasePathFor("critical")).toContain("Authenticated mechanic release required");
    expect(releasePathFor("critical")).toContain("nor the vendor bill");
  });
});

describe("a company expense is never a customer charge without a person", () => {
  it("proposes recovery at the contract markup and leaves it in review", () => {
    const r = proposeCustomerRecovery({ companyCost: 500, contract: { passThroughAllowed: true, markupPercent: 10 }, category: "hotel", causedByCustomer: false });
    expect(r.status).toBe("review_required");
    if (r.status === "review_required") {
      expect(r.proposedRecovery).toBe(550);
      expect(r.invoiced).toBe(false);
    }
  });
  it("is not recoverable without a contract, or outside the contract's categories", () => {
    expect(proposeCustomerRecovery({ companyCost: 500, contract: null, category: "hotel", causedByCustomer: false }).status).toBe("not_recoverable");
    expect(proposeCustomerRecovery({ companyCost: 500, contract: { passThroughAllowed: true, recoverableCategories: ["hotel"] }, category: "tires", causedByCustomer: false }).status).toBe("not_recoverable");
  });
  it("proposes review when the customer caused the cost even if pass-through is off", () => {
    const r = proposeCustomerRecovery({ companyCost: 425, contract: { passThroughAllowed: false }, category: "labour", causedByCustomer: true });
    expect(r.status).toBe("review_required");
  });
});

describe("cost belongs to the period the service happened in", () => {
  it("flags September service invoiced in October as an accrual candidate for a controller", () => {
    const a = assessAccrual({ serviceDate: new Date("2026-09-30T02:15:00Z"), invoiceDate: new Date("2026-10-08T00:00:00Z") });
    expect(a.accrualCandidate).toBe(true);
    expect(a.servicePeriod).toBe("2026-09");
    expect(a.requiresControllerApproval).toBe(true);
  });
  it("does not accrue within one period, and follows the invoice with no service date", () => {
    expect(assessAccrual({ serviceDate: new Date("2026-10-02T00:00:00Z"), invoiceDate: new Date("2026-10-08T00:00:00Z") }).accrualCandidate).toBe(false);
    expect(assessAccrual({ serviceDate: null, invoiceDate: new Date("2026-10-08T00:00:00Z") }).servicePeriod).toBe("2026-10");
  });
});

describe("roadside consequences", () => {
  it("makes an immovable truck a critical defect with a mechanic-release path and escalates DG", () => {
    const c = roadsideConsequences({ eventType: "flat_tire", vehicleMovable: "no", dangerousGoods: "unknown", driverSafe: "yes" });
    expect(c.defectSeverity).toBe("critical");
    expect(c.unitAvailable).toBe(false);
    expect(c.releasePath).toContain("mechanic release");
    expect(c.safetyEscalation).toBe(true);
  });
  it("treats unknown movability as inspection-required, never as fine", () => {
    expect(roadsideConsequences({ eventType: "coolant_leak", vehicleMovable: "unknown", dangerousGoods: "no", driverSafe: "yes" }).defectSeverity).toBe("inspection_required");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the chain, end to end                                */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("three grants because they are three people", () => {
  it("lets a driver report and request but never approve or pay", () => {
    const can = (p: Parameters<typeof authorize>[0]["permission"]) => authorize({ userId: 1, roles: ["driver"], permission: p }).allowed;
    expect(can("roadside.report")).toBe(true);
    expect(can("purchasing.request")).toBe(true);
    expect(can("purchasing.approve")).toBe(false);
    expect(can("vendor.bill.approve")).toBe(false);
    expect(can("payment.release")).toBe(false);
  });
  it("reserves payment release to the controller and, above the first tier, management (P7.5 ladder)", () => {
    const holders = ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "payment.release" }).allowed);
    expect(holders.sort()).toEqual(["controller", "management"]);   // P7.5: the payment tiers above $5,000 name management; the ledger enforces tier, second person and separation of duties
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 560000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 6 });
});

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = nextUser();
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}

d("the flat tire, end to end", () => {
  it("driver reports → unit held → shop lead approves $2,500 → bill matched → bookkeeper approves → controller pays → unit still held", async () => {
    const driver = await withRole("driver");
    const shopLead = await withRole("shop_lead");
    const bookkeeper = await withRole("bookkeeper");
    const controller = await withRole("controller");

    const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Tire Co', 'corporation', 'CA-AB', 1)", [key("ENT").slice(0, 40)]);
    const entityId = Number(ent.insertId);
    const [unit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company) VALUES (?, 'truck', 'ABC')", [key("142").slice(0, 30)]);
    const unitId = Number(unit.insertId);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category, emergency24h, status) VALUES (?, 'tires', 1, 'active')", [key("ABC Tire").slice(0, 60)]);
    const vendorId = Number(ven.insertId);
    for (const [role, e, s, a] of [["driver", 500, 200, 0], ["shop_lead", 2500, 1500, 2500], ["controller", 25000, 25000, 25000]] as const) {
      await pool.execute("INSERT INTO spendingLimits (financialEntityId, role, emergencyPurchaseLimit, standardPurchaseLimit, canApproveUpTo, effectiveFrom, setByUserId) VALUES (?, ?, ?, ?, ?, NOW(), 1)", [entityId, role, e, s, a]);
    }

    // 02:15 — driver reports. Immovable, loaded, no DG.
    const rs = await callerFor(driver).roadside.open({
      eventType: "flat_tire", unitId, occurredAt: new Date("2026-09-30T08:15:00Z"),
      vehicleMovable: "no", driverSafe: "yes", loadStatus: "loaded", dangerousGoods: "no", assistanceRequired: true,
      driverStatement: "Blew the right steer near Grande Prairie. Pulled onto the shoulder. I'm okay.",
    });
    expect(rs.defectSeverity).toBe("critical");
    expect(rs.unitAvailable).toBe(false);
    const [def] = await pool.execute<mysql.RowDataPacket[]>("SELECT severity, status, detail FROM maintenanceDefects WHERE id = ?", [rs.defectId]);
    expect(def[0].severity).toBe("critical");
    expect(def[0].detail).toContain("Blew the right steer"); // the driver's words, preserved

    // Driver requests $2,200. Above their $500 emergency limit → waits.
    const pa = await callerFor(driver).purchasing.request({
      financialEntityId: entityId, vendorId, unitId, roadsideEventRef: rs.eventRef,
      category: "roadside_tire", reason: "Steer tire replacement", estimatedAmount: 2200, emergency: true,
    });
    expect(pa.requiresApproval).toBe(true);

    // Driver cannot approve it — not the permission, and not their own request either.
    await expect(callerFor(driver).purchasing.approve({ authorizationRef: pa.authorizationRef, authorizedMaximum: 2500 })).rejects.toBeTruthy();
    // Shop lead approves up to $2,500.
    const approved = await callerFor(shopLead).purchasing.approve({ authorizationRef: pa.authorizationRef, authorizedMaximum: 2500 });
    expect(approved.authorizedMaximum).toBe(2500);

    // Oct 8 — the bill arrives for Sept 30 service. Accrual candidate.
    const bill = await callerFor(bookkeeper).vendor.billRecord({
      financialEntityId: entityId, vendorId, vendorInvoiceNumber: key("48291"),
      invoiceDate: new Date("2026-10-08T00:00:00Z"), serviceDate: new Date("2026-09-30T10:00:00Z"),
      subtotal: 2050, taxAmount: 102.5, total: 2152.5, lines: tireBill(),
      purchaseAuthorizationRef: pa.authorizationRef, roadsideEventRef: rs.eventRef, unitId, evidenceRecordId: 1,
    });
    expect(bill.accrual.accrualCandidate).toBe(true);
    expect(bill.accrual.servicePeriod).toBe("2026-09");

    // Four-way match: authorized 1 tire, driver confirmed 1, billed 1.
    const m = await callerFor(bookkeeper).vendor.billMatch({ billRef: bill.billRef, confirmedQuantities: { tire: 1 }, billedQuantities: { tire: 1 } });
    expect(m.outcome).toBe("match");
    expect(m.status).toBe("needs_approval");

    // P7.5 — the approval ladder (0133/0136): the bookkeeper recorded this bill, so they may
    // not approve it (separation of duties, by name); the controller approves within the
    // first tier. This does NOT release the unit.
    await expect(callerFor(bookkeeper).vendor.billApprove({ billRef: bill.billRef, codingCategory: "fleet_repair_tires" })).rejects.toThrow(/separation of duties/);
    const ap = await callerFor(controller).vendor.billApprove({ billRef: bill.billRef, codingCategory: "fleet_repair_tires" });
    expect(ap.unitReleased).toBe(false);
    expect(ap.status).toBe("ready_to_pay");

    // The controller who approved cannot release payment; a manager can (a different person, within the payment tier).
    await expect(callerFor(controller).vendor.paymentRelease({ billRef: bill.billRef })).rejects.toThrow(/does not release/);
    const manager = await withRole("management");
    const paid = await callerFor(manager).vendor.paymentRelease({ billRef: bill.billRef });
    expect(paid.status).toBe("paid");

    // After all of that: the defect is still open. Nothing in AP touched it.
    const [after] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM maintenanceDefects WHERE id = ?", [rs.defectId]);
    expect(after[0].status).toBe("open");

    // Recovery: the customer's site condition caused the delay. Review, not an invoice.
    const rec = await callerFor(bookkeeper).recovery.propose({ billRef: bill.billRef, jobId: 24198, contract: { passThroughAllowed: false }, category: "labour", causedByCustomer: true });
    expect(rec.status).toBe("review_required");
    const [invoices] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM invoices WHERE jobId = 24198");
    expect(Number(invoices[0].n)).toBe(0);
  });

  it("refuses a bill whose lines do not reconcile, and the same vendor invoice twice", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Dup Co', 'corporation', 'CA-AB', 1)", [key("ENT").slice(0, 40)]);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'parts')", [key("Parts").slice(0, 60)]);
    const base = { financialEntityId: Number(ent.insertId), vendorId: Number(ven.insertId), invoiceDate: new Date(), subtotal: 2050, taxAmount: 102.5, total: 2152.5, lines: tireBill() };

    await expect(callerFor(bookkeeper).vendor.billRecord({ ...base, vendorInvoiceNumber: "X-1", total: 9999 })).rejects.toThrow(/do not reconcile/);
    const inv = key("INV");
    await callerFor(bookkeeper).vendor.billRecord({ ...base, vendorInvoiceNumber: inv });
    await expect(callerFor(bookkeeper).vendor.billRecord({ ...base, vendorInvoiceNumber: inv })).rejects.toThrow(/already recorded/);
  });

  it("refuses to approve a mismatched bill", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const shopLead = await withRole("shop_lead");
    const driver = await withRole("driver");
    const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Mis Co', 'corporation', 'CA-AB', 1)", [key("ENT").slice(0, 40)]);
    const entityId = Number(ent.insertId);
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'tires')", [key("T").slice(0, 60)]);
    const vendorId = Number(ven.insertId);
    await pool.execute("INSERT INTO spendingLimits (financialEntityId, role, emergencyPurchaseLimit, standardPurchaseLimit, canApproveUpTo, effectiveFrom, setByUserId) VALUES (?, 'shop_lead', 2500, 1500, 2500, NOW(), 1)", [entityId]);
    const pa = await callerFor(driver).purchasing.request({ financialEntityId: entityId, vendorId, category: "tires", reason: "Two drive tires", estimatedAmount: 2000, emergency: true });
    await callerFor(shopLead).purchasing.approve({ authorizationRef: pa.authorizationRef, authorizedMaximum: 2000 });
    // Billed above the authorized maximum.
    const bill = await callerFor(bookkeeper).vendor.billRecord({ financialEntityId: entityId, vendorId, vendorInvoiceNumber: key("OVER"), invoiceDate: new Date(), subtotal: 2050, taxAmount: 102.5, total: 2152.5, lines: tireBill(), purchaseAuthorizationRef: pa.authorizationRef, evidenceRecordId: 1 });
    const m = await callerFor(bookkeeper).vendor.billMatch({ billRef: bill.billRef });
    expect(m.outcome).toBe("mismatch");
    expect(m.variances.join(" ")).toContain("exceeds authorized maximum");
    await expect(callerFor(bookkeeper).vendor.billApprove({ billRef: bill.billRef, codingCategory: "tires" })).rejects.toThrow(/unresolved match variances/);
  });
});
