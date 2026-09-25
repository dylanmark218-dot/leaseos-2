import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { reconcileBank, reconciliationStatement, type BankLine, type Movement } from "./_core/bankReconciliation";
import { aging, allocatePayment, invoiceBalanceCents, writeOffDecision, type ArInvoice } from "./_core/accountsReceivable";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const at = (iso: string) => new Date(iso);
const mv = (over: Partial<Movement> & { id: number; amountCents: number }): Movement => ({ kind: "customer_payment", ref: `M-${over.id}`, at: at("2026-09-05T00:00:00Z"), alreadyMatched: false, ...over });
const ln = (over: Partial<BankLine> & { lineNo: number; amountCents: number }): BankLine => ({ postedAt: at("2026-09-06T00:00:00Z"), description: null, reference: null, ...over });
const END = at("2026-09-30T23:59:59Z");

describe("a bank line explains one movement, or it is a finding", () => {
  it("matches by amount within the window, prefers a shared reference, refuses to guess between twins, and names the unknowns", () => {
    const movements = [
      mv({ id: 1, amountCents: 105_000, ref: "PAY-A" }),
      mv({ id: 2, amountCents: 20_000, ref: "PAY-B" }), mv({ id: 3, amountCents: 20_000, ref: "PAY-C" }),
      mv({ id: 4, amountCents: -42_000, kind: "vendor_bill", ref: "BILL-9" }),
      mv({ id: 5, amountCents: 7_500, ref: "PAY-OLD", at: at("2026-08-10T00:00:00Z") }),
    ];
    const lines = [
      ln({ lineNo: 1, amountCents: 105_000 }),
      ln({ lineNo: 2, amountCents: 20_000, reference: "PAY-C" }),
      ln({ lineNo: 3, amountCents: 20_000 }),
      ln({ lineNo: 4, amountCents: -42_000 }),
      ln({ lineNo: 5, amountCents: 7_500 }),
      ln({ lineNo: 6, amountCents: 9_999 }),
      ln({ lineNo: 7, amountCents: -1_250 }),
    ];
    const r = reconcileBank({ lines, movements, windowDays: 5, periodEnd: END });
    expect(r.results.map(x => [x.lineNo, x.outcome, x.matched?.ref ?? null])).toEqual([
      [1, "matched", "PAY-A"],
      [2, "matched", "PAY-C"],          // the reference chose between twins
      [3, "matched", "PAY-B"],          // and the other twin is what is left
      [4, "matched", "BILL-9"],
      [5, "timing_difference", null],   // 27 days: same amount, outside the window
      [6, "unmatched", null],
      [7, "unmatched", null],
    ]);
    expect(r.results[5].reason).toContain("Unknown deposit of $99.99");
    expect(r.results[6].reason).toContain("Unknown withdrawal of $12.50");
    expect(r.counts).toEqual({ matched: 4, unmatched: 2, ambiguous: 0, timing_difference: 1 });
  });

  it("does not confuse a payment and a bill that share a numeric id — the bug the ledger scenario found", () => {
    const movements = [mv({ id: 7, amountCents: 50_000, ref: "PAY-7" }), mv({ id: 7, amountCents: -9_000, kind: "vendor_bill", ref: "BILL-7" })];
    const r = reconcileBank({ lines: [ln({ lineNo: 1, amountCents: 50_000 })], movements, windowDays: 5, periodEnd: END });
    expect(r.results[0].matched?.ref).toBe("PAY-7");
    expect(r.outstandingWithdrawals.map(m => m.ref)).toEqual(["BILL-7"]);
  });

  it("calls twins with no reference ambiguous, and lists what the statement has not shown as outstanding or in transit", () => {
    const movements = [mv({ id: 2, amountCents: 20_000, ref: "PAY-B" }), mv({ id: 3, amountCents: 20_000, ref: "PAY-C" }), mv({ id: 4, amountCents: -42_000, kind: "vendor_bill", ref: "BILL-9" }), mv({ id: 6, amountCents: 3_000, ref: "PAY-LATE", at: at("2026-10-02T00:00:00Z") })];
    const r = reconcileBank({ lines: [ln({ lineNo: 1, amountCents: 20_000 })], movements, windowDays: 5, periodEnd: END });
    expect(r.results[0].outcome).toBe("ambiguous");
    expect(r.results[0].reason).toContain("PAY-B, PAY-C");
    expect(r.outstandingWithdrawals.map(m => m.ref)).toEqual(["BILL-9"]);
    expect(r.depositsInTransit.map(m => m.ref).sort()).toEqual(["PAY-B", "PAY-C"]); // the late one is after the period
  });

  it("reconciles: bank closing less outstanding plus in transit equals book, or the difference is the thing to explain", () => {
    const movements = [mv({ id: 1, amountCents: 100_000, ref: "PAY-A" }), mv({ id: 2, amountCents: -30_000, kind: "vendor_bill", ref: "BILL-1" }), mv({ id: 3, amountCents: -5_000, kind: "vendor_bill", ref: "BILL-2" })];
    const lines = [ln({ lineNo: 1, amountCents: 100_000 }), ln({ lineNo: 2, amountCents: -30_000 })];
    const rec = reconcileBank({ lines, movements, windowDays: 5, periodEnd: END });
    const s = reconciliationStatement({ bankClosingCents: 170_000, bookOpeningCents: 100_000, movements, periodEnd: END, rec, lines });
    expect(s.adjustedBankCents).toBe(165_000);     // 170,000 − the 5,000 cheque not yet cleared
    expect(s.bookClosingCents).toBe(165_000);      // 100,000 + 100,000 − 30,000 − 5,000
    expect(s.differenceCents).toBe(0);
    expect(s.reconciled).toBe(true);
    const off = reconciliationStatement({ bankClosingCents: 170_000, bookOpeningCents: 100_000, movements, periodEnd: END, rec: reconcileBank({ lines: [...lines, ln({ lineNo: 3, amountCents: -1_250 })], movements, windowDays: 5, periodEnd: END }), lines: [...lines, ln({ lineNo: 3, amountCents: -1_250 })] });
    expect(off.reconciled).toBe(false);
    expect(off.unexplained.unknownWithdrawals).toBe(1);
  });
});

describe("cash application never crosses customers or exceeds a balance", () => {
  const inv = (over: Partial<ArInvoice> = {}): ArInvoice => ({ id: 1, invoiceNumber: "INV-1", customer: "Acme", totalCents: 105_000, dueAt: at("2026-08-31T00:00:00Z"), issuedAt: at("2026-08-01T00:00:00Z"), status: "sent", disputed: false, financialEntityId: 1, ...over });
  const pay = { id: 9, customer: "Acme", amountCents: 100_000 };

  it("allocates, tracks the invoice and the payment, and settles the invoice at zero", () => {
    const d = allocatePayment({ payment: pay, alreadyAllocatedCents: 0, invoice: inv(), invoiceAllocations: [], credits: [], amountCents: 100_000 });
    expect(d).toEqual({ permitted: true, invoiceBalanceAfterCents: 5_000, paymentUnallocatedAfterCents: 0, invoiceStatusAfter: "partially_paid" });
    const d2 = allocatePayment({ payment: { ...pay, id: 10, amountCents: 5_000 }, alreadyAllocatedCents: 0, invoice: inv(), invoiceAllocations: [{ invoiceId: 1, amountCents: 100_000 }], credits: [], amountCents: 5_000 });
    expect(d2.permitted && d2.invoiceStatusAfter).toBe("paid");
  });

  it("refuses another customer's invoice, more than the payment has, and more than the invoice is owed", () => {
    const cross = allocatePayment({ payment: pay, alreadyAllocatedCents: 0, invoice: inv({ customer: "Bravo" }), invoiceAllocations: [], credits: [], amountCents: 1_000 });
    expect(cross.permitted).toBe(false);
    if (!cross.permitted) expect(cross.refusals[0]).toContain("never crosses customers");
    const over = allocatePayment({ payment: pay, alreadyAllocatedCents: 90_000, invoice: inv(), invoiceAllocations: [], credits: [], amountCents: 20_000 });
    expect(over.permitted).toBe(false);
    if (!over.permitted) expect(over.refusals[0]).toContain("$100.00 unallocated");
    const beyond = allocatePayment({ payment: { ...pay, amountCents: 200_000 }, alreadyAllocatedCents: 0, invoice: inv(), invoiceAllocations: [], credits: [{ invoiceId: 1, customer: "Acme", amountCents: 5_000, status: "approved" }], amountCents: 100_001 });
    expect(beyond.permitted).toBe(false);
    if (!beyond.permitted) expect(beyond.refusals[0]).toContain("overpayment stays unapplied");
  });

  it("v21.9.1 — refuses to cross entities even when the customer NAME matches, and refuses an invoice with no entity", () => {
    const payA = { ...pay, financialEntityId: 1, customerAccountId: 11 };
    const invB = inv({ financialEntityId: 2, customerAccountId: 22 }); // Company B's "Acme"
    const cross = allocatePayment({ payment: payA, alreadyAllocatedCents: 0, invoice: invB, invoiceAllocations: [], credits: [], amountCents: 1_000 });
    expect(cross.permitted).toBe(false);
    if (!cross.permitted) expect(cross.refusals[0]).toContain("never crosses entities");
    const sameEntityOtherAccount = allocatePayment({ payment: payA, alreadyAllocatedCents: 0, invoice: inv({ financialEntityId: 1, customerAccountId: 12 }), invoiceAllocations: [], credits: [], amountCents: 1_000 });
    expect(sameEntityOtherAccount.permitted).toBe(false);
    if (!sameEntityOtherAccount.permitted) expect(sameEntityOtherAccount.refusals[0]).toContain("customer account 11");
    const noEntity = allocatePayment({ payment: payA, alreadyAllocatedCents: 0, invoice: inv({ financialEntityId: null }), invoiceAllocations: [], credits: [], amountCents: 1_000 });
    expect(noEntity.permitted).toBe(false);
    if (!noEntity.permitted) expect(noEntity.refusals[0]).toContain("carries no financial entity");
    expect(allocatePayment({ payment: payA, alreadyAllocatedCents: 0, invoice: inv({ financialEntityId: 1, customerAccountId: 11 }), invoiceAllocations: [], credits: [], amountCents: 1_000 }).permitted).toBe(true);
  });

  it("counts only approved credits against a balance", () => {
    expect(invoiceBalanceCents(inv(), [], [{ invoiceId: 1, customer: "Acme", amountCents: 5_000, status: "requested" }])).toBe(105_000);
    expect(invoiceBalanceCents(inv(), [], [{ invoiceId: 1, customer: "Acme", amountCents: 5_000, status: "approved" }])).toBe(100_000);
  });

  it("ages by due date, keeps disputes in their own bucket, and reports unapplied cash", () => {
    const asOf = at("2026-12-01T00:00:00Z");
    const a = aging({
      invoices: [inv({ id: 1, invoiceNumber: "A", dueAt: at("2026-11-20T00:00:00Z") }), inv({ id: 2, invoiceNumber: "B", dueAt: at("2026-10-10T00:00:00Z"), totalCents: 40_000 }), inv({ id: 3, invoiceNumber: "C", dueAt: at("2026-08-01T00:00:00Z"), totalCents: 23_300, disputed: true }), inv({ id: 4, invoiceNumber: "D", dueAt: at("2026-07-01T00:00:00Z"), totalCents: 10_000 }), inv({ id: 5, invoiceNumber: "V", status: "void" })],
      allocations: [{ invoiceId: 1, amountCents: 5_000 }], credits: [], payments: [{ id: 9, customer: "Acme", amountCents: 12_000 }], paymentAllocatedCents: new Map([[9, 5_000]]), asOf,
    });
    expect(a.buckets).toEqual({ current: 100_000, d31_60: 40_000, d61_90: 0, d90_plus: 10_000, disputed: 23_300 });
    expect(a.totalOutstandingCents).toBe(173_300);
    expect(a.unappliedPaymentsCents).toBe(7_000);
    expect(a.invoices[0].invoiceNumber).toBe("D"); // oldest first
    expect(a.byCustomer[0]).toEqual({ customer: "Acme", outstandingCents: 173_300, oldestDays: 153, disputedCents: 23_300 });
  });

  it("keeps the requester from deciding their own write-off, and the write-off within the balance", () => {
    expect(writeOffDecision({ requestedByUserId: 1, deciderUserId: 1, amountCents: 100, invoiceBalanceCents: 500 }).refusals[0]).toContain("own write-off");
    expect(writeOffDecision({ requestedByUserId: 1, deciderUserId: 2, amountCents: 600, invoiceBalanceCents: 500 }).refusals[0]).toContain("exceeds the balance");
    expect(writeOffDecision({ requestedByUserId: 1, deciderUserId: 2, amountCents: 500, invoiceBalanceCents: 500 }).permitted).toBe(true);
  });
});

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("the collector follows up; the controller authorizes", () => {
  it("separates write-off requesting from deciding, and credit requesting from deciding", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "ar.writeoff.decide" }).allowed).sort()).toEqual(["controller", "management"]);   // P7.4: the ladder (0133) puts management above $5,000 for write-offs; the ledger enforces the tier and separation of duties
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "ar.credit.decide" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(authorize({ userId: 1, roles: ["bookkeeper"], permission: "ar.writeoff.request" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["bookkeeper"], permission: "ar.writeoff.decide" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 1_500_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("cash, through the ledger", () => {
  it("receives a payment, applies it, imports the bank statement that shows it, leaves the unknown withdrawal as the finding, ages what is left, and writes off only by a second person", async () => {
    const bookkeeper = await withRole("bookkeeper");
    const controller = await withRole("controller");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, 'Acme', 'invoiced', NOW(), NOW(), NOW())", [key("BB").slice(0, 40)]);
    const inv1 = key("INV").slice(0, 40), inv2 = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, 1, 'Acme', 100000, 5000, 105000, 'CAD', 'sent', '2026-09-04 00:00:00')", [inv1, entityId, Number(book.insertId)]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-05-01 00:00:00', ?, 1, 'Acme', 20000, 1000, 21000, 'CAD', 'sent', '2026-05-31 00:00:00')", [inv2, entityId, Number(book.insertId)]);

    // A payment, received and unapplied; applied to the newer invoice; the remainder to the old one.
    const pay = await callerFor(bookkeeper).ar.paymentRecord({ financialEntityId: entityId, customer: "Acme", receivedAt: new Date("2026-09-10T00:00:00Z"), amountCents: 110_000, method: "eft", reference: "EFT-7781" });
    expect(pay.status).toBe("unapplied");
    const a1 = await callerFor(bookkeeper).ar.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: inv1, amountCents: 105_000 });
    expect(a1).toMatchObject({ invoiceBalanceAfterCents: 0, paymentUnallocatedAfterCents: 5_000, invoiceStatus: "paid" });
    await expect(callerFor(bookkeeper).ar.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: inv2, amountCents: 6_000 })).rejects.toThrow(/\$50.00 unallocated/);
    const a2 = await callerFor(bookkeeper).ar.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: inv2, amountCents: 5_000 });
    expect(a2).toMatchObject({ invoiceBalanceAfterCents: 16_000, paymentUnallocatedAfterCents: 0, invoiceStatus: "partially_paid" });
    const [prow] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM customerPayments WHERE paymentRef = ?", [pay.paymentRef]);
    expect(prow[0].status).toBe("applied");

    // The bank statement: the deposit matches the payment; a service fee nobody recorded is the finding; a paid bill has not cleared.
    const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (name, category) VALUES (?, 'tires')", [key("V").slice(0, 60)]);
    const billRef = key("BILL").slice(0, 40);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, subtotalCents, taxAmountCents, totalCents, matchOutcome, status, paymentReleasedAt) VALUES (?, ?, ?, ?, '2026-09-12 00:00:00', NOW(), 40000, 2000, 42000, 'match', 'paid', '2026-09-28 00:00:00')", [billRef, entityId, Number(ven.insertId), key("VI").slice(0, 40)]);
    const acct = await callerFor(bookkeeper).bank.accountRegister({ financialEntityId: entityId, name: "Operating", institution: "ATB", lastFour: "4471" });
    const bad = callerFor(bookkeeper).bank.statementImport({ accountRef: acct.accountRef, periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z"), openingBalanceCents: 500_000, closingBalanceCents: 600_000, lines: [{ postedAt: new Date("2026-09-11T00:00:00Z"), amountCents: 110_000 }] });
    await expect(bad).rejects.toThrow(/statement is incomplete/);
    const imp = await callerFor(bookkeeper).bank.statementImport({ accountRef: acct.accountRef, periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z"), openingBalanceCents: 500_000, closingBalanceCents: 608_750, lines: [
      { postedAt: new Date("2026-09-11T00:00:00Z"), amountCents: 110_000, description: "EFT ACME", reference: "EFT-7781" },
      { postedAt: new Date("2026-09-15T00:00:00Z"), amountCents: -1_250, description: "SERVICE FEE" },
    ] });
    expect(imp.alreadyImported).toBe(false);
    if (!imp.alreadyImported) {
      expect(imp.counts).toEqual({ matched: 1, unmatched: 1, ambiguous: 0, timing_difference: 0 });
      expect(imp.findings[0].reason).toContain("Unknown withdrawal of $12.50");
      expect(imp.outstandingWithdrawals).toEqual([billRef]);            // paid on the 28th, not yet on the statement
      expect(imp.reconciliation.lessOutstandingWithdrawalsCents).toBe(-42_000);
      expect(imp.reconciliation.adjustedBankCents).toBe(608_750 - 42_000);
      expect(imp.reconciliation.bookClosingCents).toBe(500_000 + 110_000 - 42_000);
      expect(imp.reconciliation.differenceCents).toBe(-1_250);         // the fee the books do not have
      expect(imp.reconciliation.reconciled).toBe(false);
    }
    const [linked] = await pool.execute<mysql.RowDataPacket[]>("SELECT bankStatementLineId FROM customerPayments WHERE paymentRef = ?", [pay.paymentRef]);
    expect(linked[0].bankStatementLineId).not.toBeNull();
    const again = await callerFor(bookkeeper).bank.statementImport({ accountRef: acct.accountRef, periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T23:59:59Z"), openingBalanceCents: 500_000, closingBalanceCents: 608_750, lines: [{ postedAt: new Date("2026-09-11T00:00:00Z"), amountCents: 110_000, description: "EFT ACME", reference: "EFT-7781" }, { postedAt: new Date("2026-09-15T00:00:00Z"), amountCents: -1_250, description: "SERVICE FEE" }] });
    expect(again.alreadyImported).toBe(true);

    // The close now knows about the unexplained fee.
    const close = await callerFor(bookkeeper).period.readiness({ financialEntityId: entityId, period: "2026-09" });
    expect(close.findings.some(f => f.code === "bank_lines_unexplained")).toBe(true);

    // Aging as of December: the old invoice's $160.00 is 90+; a collection call and a promise are recorded.
    const ag = await callerFor(bookkeeper).ar.aging({ financialEntityId: entityId, asOf: new Date("2026-12-01T00:00:00Z") });
    expect(ag.buckets.d90_plus).toBe(16_000);
    expect(ag.totalOutstandingCents).toBe(16_000);
    await callerFor(bookkeeper).ar.collectionEvent({ invoiceNumber: inv2, eventType: "call", note: "AP says cheque in the mail" });
    await expect(callerFor(bookkeeper).ar.collectionEvent({ invoiceNumber: inv2, eventType: "promise_to_pay" })).rejects.toThrow(/amount and a date/);

    // v21.9.1 — Company B has an "Acme" too. Its payment cannot touch Company A's invoice, by identity, not by name.
    const entityB = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Second Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a second real book
    const payB = await callerFor(bookkeeper).ar.paymentRecord({ financialEntityId: entityB, customer: "Acme", receivedAt: new Date("2026-09-12T00:00:00Z"), amountCents: 16_000, method: "eft" });
    await expect(callerFor(bookkeeper).ar.paymentAllocate({ paymentRef: payB.paymentRef, invoiceNumber: inv2, amountCents: 16_000 })).rejects.toThrow(/never crosses entities/);
    const [acctRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT financialEntityId, name FROM customerAccounts WHERE name = 'Acme' AND financialEntityId IN (?, ?) ORDER BY financialEntityId", [entityId, entityB]);
    expect(acctRows.map(r => Number(r.financialEntityId))).toEqual([entityId, entityB]); // one account per entity
    const [inv2acct] = await pool.execute<mysql.RowDataPacket[]>("SELECT customerAccountId FROM invoices WHERE invoiceNumber = ?", [inv2]);
    expect(inv2acct[0].customerAccountId).not.toBeNull(); // took Company A's account on first application

    // A credit against an invoice takes its entity and customer from the invoice — the caller does not say whose it is.
    const cr = await callerFor(bookkeeper).ar.creditRequest({ invoiceNumber: inv2, amountCents: 100, reason: "Goodwill for the late delivery" });
    expect(cr).toMatchObject({ financialEntityId: entityId, customer: "Acme" });
    await expect(callerFor(bookkeeper).ar.creditRequest({ amountCents: 100, reason: "No invoice, no entity, no customer" })).rejects.toThrow(/needs the entity and the customer/);

    // Two simultaneous allocations of the same remaining balance: exactly one succeeds.
    const inv3 = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-09-20 00:00:00', ?, 1, 'Acme', 10000, 500, 10500, 'CAD', 'sent', '2026-10-20 00:00:00')", [inv3, entityId, Number(book.insertId)]);
    const payC = await callerFor(bookkeeper).ar.paymentRecord({ financialEntityId: entityId, customer: "Acme", receivedAt: new Date("2026-09-25T00:00:00Z"), amountCents: 10_500, method: "cheque" });
    const race = await Promise.allSettled([1, 2, 3].map(() => callerFor(bookkeeper).ar.paymentAllocate({ paymentRef: payC.paymentRef, invoiceNumber: inv3, amountCents: 10_500 })));
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter(r => r.status === "rejected")).toHaveLength(2);
    const [allocRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n, COALESCE(SUM(amountCents),0) AS total FROM paymentAllocations WHERE invoiceId = (SELECT id FROM invoices WHERE invoiceNumber = ?)", [inv3]);
    expect(Number(allocRows[0].n)).toBe(1);
    expect(Number(allocRows[0].total)).toBe(10_500);

    // A write-off: requested by the bookkeeper, refused to the bookkeeper, decided by the controller — and it becomes a credit that settles the invoice.
    const wo = await callerFor(bookkeeper).ar.writeOffRequest({ invoiceNumber: inv2, amountCents: 16_000, reason: "Customer insolvent; trustee confirms no distribution" });
    await expect(callerFor(bookkeeper).ar.writeOffDecide({ requestRef: wo.requestRef, decision: "approved", reason: "x" })).rejects.toBeTruthy();
    const dec = await callerFor(controller).ar.writeOffDecide({ requestRef: wo.requestRef, decision: "approved", reason: "Trustee letter on file" });
    expect(dec.status).toBe("approved");
    if (dec.status === "approved") expect(dec.invoiceBalanceAfterCents).toBe(0);
    const [inv2row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM invoices WHERE invoiceNumber = ?", [inv2]);
    expect(inv2row[0].status).toBe("paid");
    const after = await callerFor(bookkeeper).ar.aging({ financialEntityId: entityId, asOf: new Date("2026-12-01T00:00:00Z") });
    expect(after.totalOutstandingCents).toBe(0);
    const [events] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType FROM collectionEvents WHERE invoiceId = (SELECT id FROM invoices WHERE invoiceNumber = ?) ORDER BY id", [inv2]);
    expect(events.map(e => e.eventType)).toEqual(["call", "write_off_requested", "write_off_decided"]);
  });
});
