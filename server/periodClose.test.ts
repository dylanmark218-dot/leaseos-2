import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { closeReadiness, decideClose, periodBounds, periodOf, periodState, writePermitted, type CloseFacts } from "./_core/periodClose";
import { deriveExceptions, type ExceptionSources } from "./_core/exceptionCentre";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const facts = (over: Partial<CloseFacts> = {}): CloseFacts => ({ unmatchedStatementLines: 0, ambiguousStatementLines: 0, statementsImported: 1, billsMismatched: 0, billsDuplicateSuspected: 0, billsMissingReceipt: 0, billsAwaitingApproval: 0, billsAwaitingCoding: 0, fuelNeedsReview: 0, fuelJurisdictionUnknown: 0, distanceNeedsReview: 0, tanksOutOfTolerance: [], quarterEndMonth: false, iftaReturnStatus: null, gstReturnStatus: null, expensesDraft: 0, proposalsAwaitingReadback: 0, lateArrivalsAfterClose: 0, bankLinesUnexplained: 0, bankStatementsImported: 1, paymentsUnapplied: 0, ...over });

describe("periods and state", () => {
  it("names a period from a date and bounds it in UTC", () => {
    expect(periodOf(new Date("2026-08-31T23:59:59Z"))).toBe("2026-08");
    expect(periodOf(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09");
    expect(periodBounds("2026-08").end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(() => periodBounds("2026-13")).toThrow(/not a month/);
  });

  it("derives state from the latest action, breaking same-second ties by id", () => {
    const t = NOW;
    expect(periodState([], "2026-08")).toBe("open");
    expect(periodState([{ id: 1, period: "2026-08", action: "soft_close", at: t }, { id: 2, period: "2026-08", action: "close", at: t }], "2026-08")).toBe("closed");
    expect(periodState([{ id: 3, period: "2026-08", action: "close", at: t }, { id: 4, period: "2026-08", action: "reopen", at: t }], "2026-08")).toBe("open");
    expect(periodState([{ id: 1, period: "2026-07", action: "close", at: t }], "2026-08")).toBe("open");
  });

  it("refuses a write into a period that is not open, with the reason", () => {
    expect(writePermitted("open", "2026-08").permitted).toBe(true);
    expect(writePermitted("closed", "2026-08").reason).toContain("2026-08 is closed — reopen it");
    expect(writePermitted("soft_closed", "2026-08").permitted).toBe(false);
  });
});

describe("what blocks a close, by name", () => {
  it("is ready when nothing is open", () => {
    expect(closeReadiness(facts())).toEqual({ verdict: "ready", findings: [] });
  });

  it("blocks on receiptless purchases, ambiguous lines, mismatched bills, unknown fuel jurisdiction and tank variance; reviews the rest", () => {
    const r = closeReadiness(facts({ unmatchedStatementLines: 2, billsMismatched: 1, billsAwaitingApproval: 3, fuelJurisdictionUnknown: 1, tanksOutOfTolerance: [{ tankRef: "TANK-1", variancePct: -8 }], distanceNeedsReview: 4 }));
    expect(r.verdict).toBe("blocked");
    expect(r.findings.filter(f => f.severity === "blocking").map(f => f.code)).toEqual(["statement_lines_unmatched", "bills_mismatched", "fuel_jurisdiction_unknown", "tank_variance"]);
    expect(r.findings.filter(f => f.severity === "review").map(f => f.code)).toEqual(["bills_awaiting_approval", "distance_needs_review"]);
    expect(r.findings[0].action).toContain("scan the receipt");
  });

  it("asks for the IFTA return in a quarter-end month, and names late arrivals", () => {
    const r = closeReadiness(facts({ quarterEndMonth: true, iftaReturnStatus: "prepared", gstReturnStatus: "none", lateArrivalsAfterClose: 2 }));
    expect(r.verdict).toBe("review");
    expect(r.findings.map(f => f.code)).toEqual(["ifta_return_not_finalized", "gst_return_not_finalized", "late_arrivals_after_close"]);
    expect(closeReadiness(facts({ quarterEndMonth: true, iftaReturnStatus: "finalized", gstReturnStatus: "finalized" })).findings).toEqual([]);
  });
});

describe("the close decision", () => {
  const ready = closeReadiness(facts());
  const review = closeReadiness(facts({ billsAwaitingApproval: 1 }));
  const blocked = closeReadiness(facts({ unmatchedStatementLines: 1 }));

  it("soft-closes over review items, never over blocking ones", () => {
    expect(decideClose("open", "soft_close", review).permitted).toBe(true);
    expect(decideClose("open", "soft_close", blocked).permitted).toBe(false);
  });

  it("hard-closes from open only when there is nothing to review; from soft-closed with review items cleared", () => {
    expect(decideClose("open", "close", ready).permitted).toBe(true);
    const d = decideClose("open", "close", review);
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.refusals[0]).toContain("soft-close first");
    expect(decideClose("soft_closed", "close", ready).permitted).toBe(true);
  });

  it("refuses to close a closed period and to reopen an open one", () => {
    expect(decideClose("closed", "close", ready).permitted).toBe(false);
    expect(decideClose("closed", "reopen", blocked).permitted).toBe(true); // reopening ignores readiness
    expect(decideClose("open", "reopen", ready).permitted).toBe(false);
  });
});

describe("the fuel line reaches the exception centre", () => {
  const empty = (): ExceptionSources => ({ openCalibrationSweeps: [], inspectorRequests: [], now: NOW, criticalDefects: [], roadsideOpen: [], vendorBills: [], purchaseRequests: [], credentialsAwaitingVerification: [], credentialVerdicts: [], aiProposals: [], aiQuestions: [], syncConflicts: [], revokedDevicesWithQueue: [], measurementDevices: [], insurancePolicies: [], carrierProfileReviews: [], ungatedAssignments: [], statementsWithFindings: [], tanksOutOfTolerance: [], periodsSoftClosed: [] });
  it("raises receiptless purchases, unexplained tank variance and a soft-closed period, each gated on the role that acts", () => {
    const xs = deriveExceptions({ ...empty(),
      statementsWithFindings: [{ statementRef: "STMT-1", provider: "Cardlock Co", unmatched: 2, ambiguous: 1, importedAt: NOW }, { statementRef: "STMT-2", provider: "X", unmatched: 0, ambiguous: 0, importedAt: NOW }],
      tanksOutOfTolerance: [{ tankRef: "TANK-1", name: "Yard tank 1", variancePct: -8, varianceLitres: -400, reason: "400 L (8%) left the tank without a dispense — unrecorded fill, leak or theft" }],
      periodsSoftClosed: [{ financialEntityId: 1, period: "2026-08", reviewItems: 3, since: NOW }],
    });
    // Severity first; among equals, no due date and no "since" sorts ahead — the tank precedes the statement.
    expect(xs.map(x => [x.key, x.severity, x.requiredPermission])).toEqual([
      ["tank:TANK-1", "high", "fuel.review"],
      ["statement:STMT-1", "high", "fuel.statement.import"],
      ["period:1:2026-08", "medium", "period.close"],
    ]);
    expect(xs.find(x => x.key === "statement:STMT-1")!.title).toBe("Cardlock Co statement STMT-1: 2 purchase(s) without a receipt, 1 ambiguous");
    expect(xs.find(x => x.key === "tank:TANK-1")!.title).toBe("Tank Yard tank 1: -400 L (-8%) unexplained");
  });
});

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who closes, who reopens", () => {
  it("bookkeeper and controller close; only the controller reopens", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "period.close" }).allowed).sort()).toEqual(["bookkeeper", "controller"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "period.reopen" }).allowed)).toEqual(["controller"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 990000 + Math.floor(Math.random() * 9000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("August, closed", () => {
  it("is blocked by a receiptless purchase, soft-closes once resolved, refuses a dispense dated in it, closes, and reopens with a reason", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const controller = await withRole("controller");
    const shopLead = await withRole("shop_lead");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'truck', 'ABC', 'clear')", [key("142").slice(0, 30)]);
    const unitId = Number(u.insertId);
    const [acct] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fuelAccounts (accountRef, financialEntityId, name, fuelType, kind, status) VALUES (?, ?, 'Cardlock', 'diesel', 'fleet', 'active')", [key("ACCT").slice(0, 40), entityId]);
    const acctId = Number(acct.insertId);

    // An August statement with one purchase nobody scanned.
    const imp = await callerFor(bookkeeper).fuel.statementImport({ financialEntityId: entityId, fuelAccountId: acctId, provider: "Cardlock Co", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T23:59:59Z"), lines: [
      { transactionAt: new Date("2026-08-14T09:00:00Z"), cardLastFour: "4321", merchant: "Cardlock Nisku", jurisdiction: "CA-AB", quantity: 250, quantityUnit: "L", total: 380 },
    ] });
    expect(imp.alreadyImported).toBe(false);
    const statementRef = imp.alreadyImported ? "" : imp.statementRef;

    // Readiness: blocked, by name. The exception centre says so too.
    const r1 = await callerFor(bookkeeper).period.readiness({ financialEntityId: entityId, period: "2026-08" });
    expect(r1.state).toBe("open");
    expect(r1.verdict).toBe("blocked");
    expect(r1.findings.map(f => f.code)).toContain("statement_lines_unmatched");
    await expect(callerFor(bookkeeper).period.close({ financialEntityId: entityId, period: "2026-08", action: "soft_close", reason: "Trying to close with a receipt missing" })).rejects.toThrow(/statement_lines_unmatched/);
    const ex = await callerFor(bookkeeper).surfaces.exceptions({ category: "finance" });
    expect(ex.items.some(x => x.key === `statement:${statementRef}`)).toBe(true);

    // The purchase is confirmed receiptless with a reason; it stops blocking. A late fuel record for August still needs review.
    await callerFor(bookkeeper).fuel.statementLineResolve({ statementRef, lineNo: 3, fuelRef: null, reason: "x" }).catch(() => undefined);
    await callerFor(bookkeeper).fuel.statementLineResolve({ statementRef, lineNo: 1, fuelRef: null, reason: "Driver confirms the receipt was lost; vendor copy requested" });
    const FC = "payerType, purpose, financialTreatment, reimbursementStatus, privateToFueler, hosRuleConclusion, status";
    await pool.execute(`INSERT INTO fuelTransactions (fuelRef, financialEntityId, unitId, occurredAt, fuelType, quantity, quantityUnit, totalCents, jurisdiction, jurisdictionSource, ${FC}) VALUES (?, ?, ?, '2026-08-20 08:00:00', 'diesel', 120, 'L', 19000, 'CA-AB', 'receipt', 'company', 'company_vehicle_operation', 'company_operating_expense', 'not_applicable', 0, 'unknown', 'needs_review')`, [key("FUEL").slice(0, 60), entityId, unitId]);
    const r2 = await callerFor(bookkeeper).period.readiness({ financialEntityId: entityId, period: "2026-08" });
    expect(r2.verdict).toBe("review");
    expect(r2.findings.map(f => f.code)).toEqual(["fuel_needs_review", "bank_statement_not_imported"]); // v21.9 — the close reads the bank too

    // A hard close from open with a review item is refused; a soft close is not. The exception centre now shows the soft-closed period.
    await expect(callerFor(bookkeeper).period.close({ financialEntityId: entityId, period: "2026-08", action: "close", reason: "Month end, books balanced" })).rejects.toThrow(/soft-close first/);
    const sc = await callerFor(bookkeeper).period.close({ financialEntityId: entityId, period: "2026-08", action: "soft_close", reason: "Month end; one fuel receipt still under review" });
    expect(sc).toEqual({ period: "2026-08", from: "open", to: "soft_closed", reviewItems: 2 });
    expect((await callerFor(bookkeeper).surfaces.exceptions({ category: "finance" })).items.some(x => x.key === `period:${entityId}:2026-08`)).toBe(true);

    // Soft-closed: a dispense dated in August is refused; one dated in September is not.
    const tank = await callerFor(shopLead).fuel.tankRegister({ financialEntityId: entityId, name: "Yard", jurisdiction: "CA-AB", fuelType: "diesel", capacityLitres: 5000 });
    await expect(callerFor(shopLead).fuel.dispenseRecord({ tankRef: tank.tankRef, unitId, litres: 50, quantitySource: "stated", occurredAt: new Date("2026-08-25T07:00:00Z") })).rejects.toThrow(/2026-08 is soft-closed/);
    await callerFor(shopLead).fuel.dispenseRecord({ tankRef: tank.tankRef, unitId, litres: 50, quantitySource: "stated", occurredAt: new Date("2026-09-02T07:00:00Z") });

    // Clear the review item; close from soft-closed; a bookkeeper may not reopen; the controller may, with a reason; then it is open again.
    await pool.execute("UPDATE fuelTransactions SET status = 'confirmed' WHERE financialEntityId = ? AND status = 'needs_review'", [entityId]);
    const cl = await callerFor(bookkeeper).period.close({ financialEntityId: entityId, period: "2026-08", action: "close", reason: "Receipt reviewed; August complete" });
    expect(cl.to).toBe("closed");
    await expect(callerFor(bookkeeper).period.close({ financialEntityId: entityId, period: "2026-08", action: "close", reason: "Closing again by mistake" })).rejects.toThrow(/already closed/);
    await expect(callerFor(bookkeeper).period.reopen({ financialEntityId: entityId, period: "2026-08", reason: "Late invoice arrived" })).rejects.toBeTruthy();
    const ro = await callerFor(controller).period.reopen({ financialEntityId: entityId, period: "2026-08", reason: "Late vendor invoice dated 28 Aug arrived 12 Sept" });
    expect(ro).toEqual({ period: "2026-08", from: "closed", to: "open" });
    await callerFor(shopLead).fuel.dispenseRecord({ tankRef: tank.tankRef, unitId, litres: 50, quantitySource: "stated", occurredAt: new Date("2026-08-25T07:00:00Z") });

    // The history is all there: soft_close, close, reopen, each with a reason and the readiness it saw.
    const [hist] = await pool.execute<mysql.RowDataPacket[]>("SELECT action, reason, readinessJson FROM periodCloses WHERE financialEntityId = ? AND period = '2026-08' ORDER BY at, id", [entityId]);
    expect(hist.map(h => h.action)).toEqual(["soft_close", "close", "reopen"]);
    expect(JSON.parse(hist[0].readinessJson).findings.map((f: { code: string }) => f.code)).toEqual(["fuel_needs_review", "bank_statement_not_imported"]);
    expect(hist[2].readinessJson).toBeNull();
  });
});
