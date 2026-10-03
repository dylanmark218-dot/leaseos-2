/**
 * F1 — tenant isolation for money, proved against a real database.
 *
 * Two organizations, each with its own book and a full set of money records created through the API
 * by its own people. Organization B's caller holds every finance role there is (controller,
 * management, office, shop lead) — and still cannot read, change, approve or export anything of
 * Organization A's: each attempt answers NOT_FOUND, with the same message a record that does not
 * exist gets, and A's row is unchanged afterwards. Roles answer "may this person do this kind of
 * thing"; the chain caller → organization → book → record answers "in which books".
 *
 * Also here: a revoked role never counts toward an approval; an approval ledger row of one book is
 * never reused for another; a void is refused in a closed period and allowed once it is reopened;
 * a record assigned to no book is nobody's, and is backfilled only when its evidence proves one book.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

vi.mock("./storage", () => ({
  storagePut: vi.fn(async (key: string) => ({ key })),
  storageGetSignedUrl: vi.fn(async (key: string) => `https://storage.test/${key}`),
}));

import { appRouter } from "./routers";
import { decide } from "./_core/commercialApprovalService";
import { getDb } from "./db";
import { assignProvenBook, classifyOwnership, legacyFinanceOwnershipAudit } from "./financeLegacyOwnership";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 285_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[], revoked: string[] = []) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  for (const role of revoked) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt, revokedAt) VALUES (?,?,'global',1,NOW(),NOW())", [userId, role]);
  return userId;
}
const one = async (sql: string, params: unknown[]) => ((await pool.query<mysql.RowDataPacket[]>(sql, params))[0][0]) as mysql.RowDataPacket;
const NOT_FOUND = { code: "NOT_FOUND" };

type World = Awaited<ReturnType<typeof world>>;
/** One organization's books, created the way that organization's people create them. */
/**
 * `priorCredits`: credit numbers are per organization (v23.32, 0233), so every organization's first credit is
 * CR-<year>-000001. Giving A an earlier credit makes A's fixture credit a number B never holds — "B decides A's
 * credit" then names a credit that is not in B's books, rather than B's own credit under the same number.
 */
async function world(orgRef: string | null, opts: { priorCredits?: number } = {}) {
  const controller = await member(orgRef, ["controller"]), bookkeeper = await member(orgRef, ["bookkeeper"]);
  const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, ?, 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, `Books ${orgRef ?? "legacy"}`, orgRef]);
  const entityId = Number(ent.insertId);
  const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef, createdAt) VALUES (?, 'hydrovac', 'Acme Energy', 'LSD 04-12-045-08W4', 'on_site', ?, NOW())", [`JOB-${rnd()}`, orgRef]);
  const jobId = Number(job.insertId);
  const accountRef = `CUST-${rnd()}`;
  const [acct] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO customerAccounts (accountRef, financialEntityId, name, creditLimitCents) VALUES (?, ?, 'Acme Energy', 5000000)", [accountRef, entityId]);
  const [bb] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, ?, 'Acme Energy', 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, jobId]);
  const invoiceNumber = `INV-${rnd()}`;
  await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, ?, 'Acme Energy', ?, 100000, 5000, 105000, 'CAD', 'sent', '2026-09-04 00:00:00')", [invoiceNumber, entityId, bb.insertId, jobId, acct.insertId]);
  const vendorRef = `VEN-${rnd()}`;
  const [ven] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, bookOrgRef, name, category, status) VALUES (?, ?, ?, 'tires', 'active')", [vendorRef, orgRef, `Tire Co ${rnd()}`]);
  const billRef = `BILL-${rnd()}`;
  await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, recordedByUserId, approvedByUserId, vendorInvoiceNumber, invoiceDate, receivedAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?, ?, ?, ?, ?, ?, '2026-08-10', NOW(), 'CAD', 40000, 2000, 42000, 'match', 'ready_to_pay')", [billRef, entityId, ven.insertId, bookkeeper, bookkeeper, `VI-${rnd()}`]);
  const pay = await callerFor(bookkeeper).ar.paymentRecord({ financialEntityId: entityId, customer: "Acme Energy", receivedAt: new Date("2026-09-10T00:00:00Z"), amountCents: 50_000, method: "eft" });
  for (let i = 0; i < (opts.priorCredits ?? 0); i++) await callerFor(bookkeeper).ar.creditRequest({ invoiceNumber, amountCents: 1_000, reason: "an earlier credit on the same invoice" });
  const credit = await callerFor(bookkeeper).ar.creditRequest({ invoiceNumber, amountCents: 10_000, reason: "standby hour conceded after review" });
  const bank = await callerFor(bookkeeper).bank.accountRegister({ financialEntityId: entityId, name: "Operating" });
  const gst = await callerFor(bookkeeper).gst.returnPrepare({ financialEntityId: entityId, period: "2026-Q3", jurisdiction: "CA-AB" });
  const tank = await callerFor(controller).fuel.tankRegister({ financialEntityId: entityId, name: "Yard tank", jurisdiction: "CA-AB", fuelType: "diesel", capacityLitres: 5000 });
  const ifta = await callerFor(bookkeeper).ifta.quarterPrepare({ financialEntityId: entityId, quarter: "2026-Q3" });
  const asset = await callerFor(bookkeeper).asset.register({ financialEntityId: entityId, kind: "equipment", description: "Steam trailer", acquiredAt: new Date("2026-07-02T00:00:00Z"), acquisitionCostCents: 2_500_000 });
  const pkg = await callerFor(controller).audit.packagePrepare({ kind: "tax", subjectRef: String(entityId), recipient: "External accountant", purpose: "year-end review" });
  return { orgRef, controller, bookkeeper, entityId, jobId, accountRef, accountId: Number(acct.insertId), invoiceNumber, vendorId: Number(ven.insertId), vendorRef, billRef, paymentRef: pay.paymentRef, creditRef: credit.creditRef, bankRef: bank.accountRef, gstRef: gst.returnRef, tankRef: tank.tankRef, iftaRef: ifta.returnRef, assetRef: asset.assetRef, packageRef: pkg.packageRef };
}

d("F1 — Organization B cannot touch Organization A's money", () => {
  let A: World, B: World, attacker: number;
  beforeAll(async () => {
    A = await world(await org(), { priorCredits: 1 });
    B = await world(await org());
    attacker = await member(B.orgRef, ["controller", "management", "office", "shop_lead"]);
  }, 60_000);

  const as = () => callerFor(attacker);
  const attempts: [string, () => Promise<unknown>][] = [
    // AR — read
    ["read A's invoice", () => as().invoicing.get({ invoiceNumber: A.invoiceNumber })],
    ["age A's receivables", () => as().ar.aging({ financialEntityId: A.entityId })],
    // AR — change
    ["void A's invoice", () => as().invoicing.void({ invoiceNumber: A.invoiceNumber, reason: "attempted by another organization" })],
    ["send A's invoice", () => as().invoicing.send({ invoiceNumber: A.invoiceNumber })],
    ["set tax treatment on A's invoice", () => as().gst.treatmentSet({ kind: "invoice", ref: A.invoiceNumber, treatment: "exempt", source: "review" })],
    ["record a payment into A's book", () => as().ar.paymentRecord({ financialEntityId: A.entityId, customer: "Acme Energy", receivedAt: new Date("2026-09-11T00:00:00Z"), amountCents: 1, method: "eft" })],
    ["apply A's payment to A's invoice", () => as().ar.paymentAllocate({ paymentRef: A.paymentRef, invoiceNumber: A.invoiceNumber, amountCents: 1 })],
    ["raise a credit on A's invoice", () => as().ar.creditRequest({ invoiceNumber: A.invoiceNumber, amountCents: 1, reason: "attempted by another organization" })],
    ["decide A's credit (B's credentials satisfying A's approval)", () => as().ar.creditDecide({ creditRef: A.creditRef, decision: "approved" })],
    ["request a write-off on A's invoice", () => as().ar.writeOffRequest({ invoiceNumber: A.invoiceNumber, amountCents: 1, reason: "attempted by another organization" })],
    // AP
    ["match A's vendor bill", () => as().vendor.billMatch({ billRef: A.billRef })],
    ["approve A's vendor bill", () => as().vendor.billApprove({ billRef: A.billRef, codingCategory: "tires" })],
    ["release payment on A's vendor bill", () => as().vendor.paymentRelease({ billRef: A.billRef })],
    ["set tax treatment on A's bill", () => as().gst.treatmentSet({ kind: "vendor_bill", ref: A.billRef, treatment: "exempt", source: "review" })],
    ["request a purchase in A's book", () => as().purchasing.request({ financialEntityId: A.entityId, vendorId: A.vendorId, category: "tires", reason: "attempt", estimatedAmount: 10 })],
    ["record a bill into A's book", () => as().vendor.billRecord({ financialEntityId: A.entityId, vendorId: A.vendorId, vendorInvoiceNumber: `X-${rnd()}`, invoiceDate: new Date("2026-09-01T00:00:00Z"), subtotal: 10, taxAmount: 0, total: 10, lines: [{ lineNo: 1, lineType: "other", description: "x", quantity: 1, unitPrice: 10, amount: 10 }] })],
    // Bank
    ["register a bank account in A's book", () => as().bank.accountRegister({ financialEntityId: A.entityId, name: "Theirs" })],
    ["import a statement into A's bank account", () => as().bank.statementImport({ accountRef: A.bankRef, periodStart: new Date("2026-06-01T00:00:00Z"), periodEnd: new Date("2026-06-30T00:00:00Z"), openingBalanceCents: 0, closingBalanceCents: 1, lines: [{ postedAt: new Date("2026-06-02T00:00:00Z"), amountCents: 1 }] })],
    // Period
    ["read A's close readiness", () => as().period.readiness({ financialEntityId: A.entityId, period: "2026-08" })],
    ["close A's period", () => as().period.close({ financialEntityId: A.entityId, period: "2026-08", action: "close", reason: "attempted by another organization" })],
    ["reopen A's period", () => as().period.reopen({ financialEntityId: A.entityId, period: "2026-08", reason: "attempted by another organization" })],
    // GST
    ["read A's GST return", () => as().gst.return({ financialEntityId: A.entityId, period: "2026-Q3", jurisdiction: "CA-AB" })],
    ["prepare A's GST return", () => as().gst.returnPrepare({ financialEntityId: A.entityId, period: "2026-Q3", jurisdiction: "CA-AB" })],
    ["finalize A's GST return", () => as().gst.returnFinalize({ returnRef: A.gstRef, acknowledgeReviewItems: [] })],
    // Fuel / IFTA
    ["read A's fuel anomalies", () => as().fuel.anomalies({ financialEntityId: A.entityId, from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T00:00:00Z") })],
    ["reconcile A's tank", () => as().fuel.tankReconcile({ tankRef: A.tankRef })],
    ["register a tank in A's book", () => as().fuel.tankRegister({ financialEntityId: A.entityId, name: "x", jurisdiction: "CA-AB", fuelType: "diesel", capacityLitres: 1 })],
    ["read A's IFTA quarter", () => as().ifta.quarter({ financialEntityId: A.entityId, quarter: "2026-Q3" })],
    ["finalize A's IFTA return", () => as().ifta.quarterFinalize({ returnRef: A.iftaRef })],
    // Assets
    ["list A's assets", () => as().asset.list({ financialEntityId: A.entityId })],
    ["dispose of A's asset", () => as().asset.dispose({ assetRef: A.assetRef, disposedAt: new Date("2026-09-01T00:00:00Z"), proceedsCents: 1 })],
    ["read A's CCA schedule", () => as().asset.schedule({ financialEntityId: A.entityId })],
    // Commercial terms
    ["change A's customer credit terms", () => as().commercial.termsSet({ accountRef: A.accountRef, creditLimitCents: 999_999_999, status: "active" })],
    ["run A's billing check", () => as().commercial.billingCheck({ accountRef: A.accountRef, invoiceTotalCents: 1 })],
    ["invite a portal identity onto A's customer", () => as().portalAdmin.identityInvite({ kind: "customer", accountRef: A.accountRef, email: "x@example.com", displayName: "x" })],
    // Audit packages
    ["prepare a tax package of A's book", () => as().audit.packagePrepare({ kind: "tax", subjectRef: String(A.entityId), recipient: "Someone", purpose: "attempted by another organization" })],
    ["prepare a vendor package of A's vendor", () => as().audit.packagePrepare({ kind: "vendor", subjectRef: A.vendorRef, recipient: "Someone", purpose: "attempted by another organization" })],
    ["read A's audit package", () => as().audit.packageGet({ packageRef: A.packageRef })],
    ["download A's audit package", () => as().audit.packageDownload({ packageRef: A.packageRef, purpose: "attempted by another organization" })],
    ["release A's audit package", () => as().audit.packageRelease({ packageRef: A.packageRef, note: "attempted" })],
  ];

  it.each(attempts)("refuses to %s — NOT_FOUND, whatever B's roles", async (_label, attempt) => {
    await expect(attempt()).rejects.toMatchObject(NOT_FOUND);
  });

  it("answers exactly what a record that does not exist answers — the refusal confirms nothing", async () => {
    const refusal = (p: Promise<unknown>) => p.then(() => "no refusal", (e: Error) => e.message);
    expect(await refusal(as().invoicing.get({ invoiceNumber: A.invoiceNumber }))).toBe(await refusal(as().invoicing.get({ invoiceNumber: `INV-NOPE-${rnd()}` })));
    expect(await refusal(as().vendor.billApprove({ billRef: A.billRef, codingCategory: "x" }))).toBe(await refusal(as().vendor.billApprove({ billRef: `BILL-NOPE-${rnd()}`, codingCategory: "x" })));
  });

  it("leaves every one of A's records exactly as A left it", async () => {
    expect((await one("SELECT status, gstTreatment FROM invoices WHERE invoiceNumber = ?", [A.invoiceNumber]))).toMatchObject({ status: "sent", gstTreatment: "unknown" });
    expect((await one("SELECT status FROM vendorBills WHERE billRef = ?", [A.billRef])).status).toBe("ready_to_pay");
    expect((await one("SELECT status FROM customerCredits WHERE creditRef = ? AND financialEntityId = ?", [A.creditRef, A.entityId])).status).toBe("requested");
    expect((await one("SELECT COUNT(*) AS n FROM commercialApprovals WHERE subjectRef IN (?, ?) AND bookOrgRef = ?", [A.creditRef, `${A.creditRef}@${A.orgRef}`, A.orgRef])).n).toBe(0);
    expect((await one("SELECT COUNT(*) AS n FROM periodCloses WHERE financialEntityId = ?", [A.entityId])).n).toBe(0);
    expect((await one("SELECT status FROM gstReturns WHERE returnRef = ?", [A.gstRef])).status).toBe("prepared");
    expect((await one("SELECT status FROM iftaReturns WHERE returnRef = ?", [A.iftaRef])).status).toBe("prepared");
    expect((await one("SELECT creditLimitCents FROM customerAccounts WHERE accountRef = ?", [A.accountRef])).creditLimitCents).toBe(5_000_000);
    expect((await one("SELECT COUNT(*) AS n FROM customerPayments WHERE financialEntityId = ?", [A.entityId])).n).toBe(1);
    expect((await one("SELECT COUNT(*) AS n FROM bankAccounts WHERE financialEntityId = ?", [A.entityId])).n).toBe(1);
    expect((await one("SELECT status FROM capitalAssets WHERE assetRef = ?", [A.assetRef])).status).toBe("pending_capital_review");
    expect((await one("SELECT COUNT(*) AS n FROM auditPackageAccess a JOIN auditPackages p ON p.id = a.packageId WHERE p.packageRef = ? AND a.userId = ?", [A.packageRef, attacker])).n).toBe(0);
  });

  it("lists none of A's audit packages to B, and all of B's own", async () => {
    const list = (await as().audit.packageList({})).packages.map(p => p.packageRef);
    expect(list).toContain(B.packageRef);
    expect(list).not.toContain(A.packageRef);
  });

  it("still lets each organization work its own books", async () => {
    expect((await callerFor(A.controller).invoicing.get({ invoiceNumber: A.invoiceNumber })).invoiceNumber).toBe(A.invoiceNumber);
    expect((await callerFor(A.bookkeeper).ar.aging({ financialEntityId: A.entityId })).buckets).toBeDefined();
    expect((await callerFor(A.controller).audit.packageGet({ packageRef: A.packageRef })).packageRef).toBe(A.packageRef);
    expect((await as().invoicing.get({ invoiceNumber: B.invoiceNumber })).invoiceNumber).toBe(B.invoiceNumber);
    const terms = await as().commercial.termsSet({ accountRef: B.accountRef, creditLimitCents: 6_000_000 });
    expect(terms.accountRef).toBe(B.accountRef);
  });
});

d("F1 — the approval ladder counts only grants in force, in the book they belong to", () => {
  it("a revoked management role does not satisfy a credit that requires management; an active one does", async () => {
    const A = await world(await org());
    const revokedMgr = await member(A.orgRef, ["controller"], ["management"]);   // may decide credits (controller), but management is revoked
    const mgr = await member(A.orgRef, ["management"]);
    // v23.32 — a credit is never approved beyond what the invoice has outstanding, so the $10,000 credit sits on a $20,000 invoice.
    const bigInvoice = `INV-${rnd()}`;
    const [[book]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM billingBooks WHERE jobId = ?", [A.jobId]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, ?, 'Acme Energy', ?, 2000000, 0, 2000000, 'CAD', 'sent', '2026-09-04 00:00:00')", [bigInvoice, A.entityId, book!.id, A.jobId, A.accountId]);
    const big = await callerFor(A.bookkeeper).ar.creditRequest({ invoiceNumber: bigInvoice, amountCents: 1_000_000, reason: "rate dispute conceded on the whole month" });
    // $10,000 is in the management tier of the default ladder. The revoked grant must not be read as management.
    await expect(callerFor(revokedMgr).ar.creditDecide({ creditRef: big.creditRef, decision: "approved" })).rejects.toThrow(/requires role management/);
    expect((await one("SELECT COUNT(*) AS n FROM commercialApprovalSignatures s JOIN commercialApprovals a ON a.id = s.commercialApprovalId WHERE a.subjectRef = ? AND s.userId = ?", [`${big.creditRef}@${A.orgRef}`, revokedMgr])).n).toBe(0);
    const ok = await callerFor(mgr).ar.creditDecide({ creditRef: big.creditRef, decision: "approved" });
    expect(ok).toMatchObject({ status: "approved", ledger: { outcome: "satisfied" } });
  }, 60_000);

  it("a ledger row recorded in Book B is never reused to satisfy the same subject identifier in Book A", async () => {
    const aOrg = await org(), bOrg = await org();
    const aController = await member(aOrg, ["controller"]), bController = await member(bOrg, ["controller"]);
    const db = (await getDb())!;
    const subjectRef = `SHARED-${rnd()}`;
    const inB = await decide(db as never, { actorUserId: bController, category: "credit", subjectType: "customer_credit", subjectRef, amountCents: 5_000, preparedByUserId: null, decision: "approved" });
    expect(inB.outcome).toBe("satisfied");
    const inA = await decide(db as never, { actorUserId: aController, category: "credit", subjectType: "customer_credit", subjectRef, amountCents: 5_000, preparedByUserId: null, decision: "approved" });
    expect(inA).toMatchObject({ outcome: "blocked", reason: expect.stringContaining("belongs to another book") });
    const row = await one("SELECT bookOrgRef, status FROM commercialApprovals WHERE subjectType = 'customer_credit' AND subjectRef = ?", [subjectRef]);
    expect(row).toMatchObject({ bookOrgRef: bOrg, status: "satisfied" });
    expect((await one("SELECT COUNT(*) AS n FROM commercialApprovalSignatures s JOIN commercialApprovals a ON a.id = s.commercialApprovalId WHERE a.subjectRef = ? AND s.userId = ?", [subjectRef, aController])).n).toBe(0);
  }, 30_000);
});

d("F1 — a void obeys the period close", () => {
  it("refuses to void an invoice issued in a closed period, changes nothing, and allows it once the controller reopens the period", async () => {
    const A = await world(await org());
    // The repository's close path: review items (no bank statement yet) → soft close, then close from soft-closed.
    await callerFor(A.bookkeeper).period.close({ financialEntityId: A.entityId, period: "2026-08", action: "soft_close", reason: "August under review; bank statement to follow" });
    const closed = await callerFor(A.bookkeeper).period.close({ financialEntityId: A.entityId, period: "2026-08", action: "close", reason: "August reconciled and reviewed" });
    expect(closed.to).toBe("closed");
    await expect(callerFor(A.controller).invoicing.void({ invoiceNumber: A.invoiceNumber, reason: "issued in error" })).rejects.toThrow(/Void of invoice .*Period 2026-08 is closed/);
    expect((await one("SELECT status, voidedAt FROM invoices WHERE invoiceNumber = ?", [A.invoiceNumber]))).toMatchObject({ status: "sent", voidedAt: null });
    await callerFor(A.controller).period.reopen({ financialEntityId: A.entityId, period: "2026-08", reason: "void of an invoice issued in error" });
    // The pending credit request is not approved, so voidCheck has nothing against the void.
    const v = await callerFor(A.controller).invoicing.void({ invoiceNumber: A.invoiceNumber, reason: "issued in error" });
    expect(v).toMatchObject({ voided: true });
  }, 60_000);

  it("refuses the void in a soft-closed period too — the same rule every dated finance write follows", async () => {
    const A = await world(await org());
    await callerFor(A.bookkeeper).period.close({ financialEntityId: A.entityId, period: "2026-08", action: "soft_close", reason: "August soft close for review" });
    await expect(callerFor(A.controller).invoicing.void({ invoiceNumber: A.invoiceNumber, reason: "issued in error" })).rejects.toThrow(/soft-closed/);
    expect((await one("SELECT status FROM invoices WHERE invoiceNumber = ?", [A.invoiceNumber])).status).toBe("sent");
  }, 60_000);
});

d("F1 — a record assigned to no book is nobody's until its evidence proves one", () => {
  async function unassigned(accountId: number | null, jobId: number | null) {
    const n = `INV-L-${rnd()}`;
    const [bb] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, ?, 'Legacy', 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, jobId ?? 0]);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, NULL, '2026-06-01 00:00:00', ?, ?, 'Legacy', ?, 1000, 0, 1000, 'CAD', 'sent')", [n, bb.insertId, jobId ?? 0, accountId]);
    return n;
  }

  it("answers NOT_FOUND to the organization its evidence points at, to the single tenant, and to anyone else", async () => {
    const A = await world(await org());
    const legacy = await member(null, ["controller"]);
    const n = await unassigned(A.accountId, A.jobId);
    await expect(callerFor(A.controller).invoicing.get({ invoiceNumber: n })).rejects.toMatchObject(NOT_FOUND);
    await expect(callerFor(legacy).invoicing.get({ invoiceNumber: n })).rejects.toMatchObject(NOT_FOUND);
    await expect(callerFor(A.controller).ar.collectionEvent({ invoiceNumber: n, eventType: "call" })).rejects.toMatchObject(NOT_FOUND);
    await expect(callerFor(A.bookkeeper).gst.return({ financialEntityId: A.entityId, period: "2026-Q2", includeUnassignedInvoices: true })).rejects.toThrow(/cannot be claimed into a return/);
  }, 60_000);

  it("classifies by evidence: proven by one book, ambiguous across two, unproven with none — and backfills only the proven one, explicitly, with an event", async () => {
    const A = await world(await org()), B = await world(await org());
    const proven = await unassigned(A.accountId, A.jobId);
    const ambiguous = await unassigned(A.accountId, B.jobId);          // A's customer, B's job: two books
    const unproven = await unassigned(null, null);
    const audit = await legacyFinanceOwnershipAudit(pool);
    const byNumber = new Map([...audit.proven, ...audit.ambiguous, ...audit.unproven].map(r => [r.invoiceNumber, r]));
    expect(byNumber.get(proven)).toMatchObject({ verdict: "PROVEN", financialEntityId: A.entityId });
    expect(byNumber.get(ambiguous)).toMatchObject({ verdict: "AMBIGUOUS" });
    expect(byNumber.get(unproven)).toMatchObject({ verdict: "UNPROVEN" });

    expect(await assignProvenBook(pool, ambiguous, { userId: null, label: "test", reason: "attempted backfill of an ambiguous row" })).toMatchObject({ assigned: false, refusal: expect.stringContaining("AMBIGUOUS") });
    expect(await assignProvenBook(pool, unproven, { userId: null, label: "test", reason: "attempted backfill of an unproven row" })).toMatchObject({ assigned: false });
    expect((await one("SELECT financialEntityId FROM invoices WHERE invoiceNumber = ?", [ambiguous])).financialEntityId).toBeNull();

    expect(await assignProvenBook(pool, proven, { userId: A.controller, label: "test", reason: "customer account and job both prove Book A" })).toEqual({ assigned: true, financialEntityId: A.entityId });
    expect((await callerFor(A.controller).invoicing.get({ invoiceNumber: proven })).financialEntityId).toBe(A.entityId);
    await expect(callerFor(B.controller).invoicing.get({ invoiceNumber: proven })).rejects.toMatchObject(NOT_FOUND);
    const ev = await one("SELECT eventType, payloadJson FROM domainEventOutbox WHERE eventType = 'finance.legacy_book_assigned' AND payloadJson LIKE ?", [`%${proven}%`]);
    expect(JSON.parse(ev.payloadJson)).toMatchObject({ invoiceNumber: proven, financialEntityId: A.entityId, previous: null });
    expect(await assignProvenBook(pool, proven, { userId: null, label: "test", reason: "second attempt on the same row" })).toMatchObject({ assigned: false, refusal: expect.stringContaining("already belongs") });
  }, 90_000);
});

describe("F1 — legacy ownership classification (pure)", () => {
  it("proves one book only when every piece of evidence agrees", () => {
    expect(classifyOwnership([{ source: "customer_account", ref: "C", entityIds: [7] }, { source: "job_organization", ref: "J", entityIds: [7, 8] }])).toMatchObject({ verdict: "PROVEN", financialEntityId: 7 });
    expect(classifyOwnership([{ source: "job_organization", ref: "J", entityIds: [9] }])).toMatchObject({ verdict: "PROVEN", financialEntityId: 9 });
  });
  it("quarantines disagreement and absence rather than choosing", () => {
    expect(classifyOwnership([{ source: "customer_account", ref: "C", entityIds: [7] }, { source: "payment_allocation", ref: "P", entityIds: [8] }]).verdict).toBe("AMBIGUOUS");
    expect(classifyOwnership([{ source: "customer_account", ref: "C", entityIds: [7] }, { source: "job_organization", ref: "J", entityIds: [8] }]).verdict).toBe("AMBIGUOUS");
    expect(classifyOwnership([{ source: "job_organization", ref: "J", entityIds: [8, 9] }]).verdict).toBe("AMBIGUOUS");
    expect(classifyOwnership([]).verdict).toBe("UNPROVEN");
    expect(classifyOwnership([{ source: "job_organization", ref: "J", entityIds: [] }]).verdict).toBe("UNPROVEN");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// F1.1 — insurance, the book-id procedures outside finance, funding, and inventory that cannot be owned
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const ALL_ROLES = ["controller", "management", "office", "shop_lead", "mechanic", "safety", "bookkeeper", "dispatcher"];
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
async function ownedUnit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}

/** One organization's insurance, compliance, calibration, funding and dispatch records, made by its own people. */
async function world11(orgRef: string) {
  const people = { office: await member(orgRef, ["office"]), mgr: await member(orgRef, ["management"]), safety: await member(orgRef, ["safety"]), mechanic: await member(orgRef, ["mechanic"]), controller: await member(orgRef, ["controller"]), bookkeeper: await member(orgRef, ["bookkeeper"]) };
  const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Carrier Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgRef]);
  const entityId = Number(ent.insertId);
  const unitId = await ownedUnit(orgRef);
  const pol = await callerFor(people.office).insurance.policyRecord({ financialEntityId: entityId, policyType: "commercial_auto", insurerName: "XYZ Insurance", policyNumber: `PN-${rnd()}`, effectiveAt: days(-100), expiresAt: days(265), annualPremium: 180000, deductible: 5000, coverages: [{ coverageType: "commercial_auto", limitAmount: 5_000_000 }] });
  await callerFor(people.office).insurance.coverageAssign({ policyRef: pol.policyRef, entities: [{ entityType: "unit", entityId: unitId }], coveredFrom: days(-100) });
  await callerFor(people.mgr).insurance.coverageVerify({ policyRef: pol.policyRef, outcome: "coverage_verified" });
  const claim = await callerFor(people.safety).insurance.claimOpen({ policyRef: pol.policyRef, unitId, lossOccurredAt: days(-3), claimType: "collision", estimatedLoss: 40000 });
  await callerFor(people.controller).insurance.claimCostRecord({ claimRef: claim.claimRef, costType: "tow", amount: 850, incurredAt: days(-2) });
  const programKey = `SAFETY-${rnd()}`;
  await callerFor(people.safety).compliance.programPublish({ programKey, title: "Safety manual", programType: "safety", financialEntityId: entityId, effectiveFrom: days(-30) });
  const dev = await callerFor(people.mechanic).calibration.deviceRegister({ financialEntityId: entityId, deviceType: "truck_scale", measures: "gross_weight", unitOfMeasure: "kg", calibrationIntervalDays: 180 });
  await callerFor(people.mechanic).calibration.eventRecord({ deviceRef: dev.deviceRef, eventType: "calibrated", performedAt: days(-60) });
  const calibrationEventId = Number((await one("SELECT id FROM calibrationEvents WHERE measurementDeviceId = ? ORDER BY id DESC LIMIT 1", [dev.deviceId])).id);
  const expenseRef = `EXP-${rnd()}`;
  await callerFor(people.bookkeeper).finance.expenseCreate({ expenseRef, financialEntityId: entityId, total: 120, transactionDate: days(-5) });
  const opportunityRef = `OPP-${rnd()}`;
  await pool.execute("INSERT INTO fundingOpportunities (opportunityRef, financialEntityId, fundingProgramId, matchStrength, status) VALUES (?, ?, 1, 'possible', 'estimated')", [opportunityRef, entityId]);
  await callerFor(people.mgr).dispatch.enforcementSet({ financialEntityId: entityId, mode: "advisory", reason: "our own company's dispatch, advisory for now" });
  return { orgRef, ...people, entityId, unitId, policyRef: pol.policyRef, claimRef: claim.claimRef, programKey, deviceRef: dev.deviceRef, calibrationEventId, expenseRef, opportunityRef };
}

d("F1.1 — Organization B cannot touch Organization A's insurance, compliance, calibration, funding or dispatch records", () => {
  let A: Awaited<ReturnType<typeof world11>>, B: Awaited<ReturnType<typeof world11>>, attacker: number;
  beforeAll(async () => {
    A = await world11(await org());
    B = await world11(await org());
    attacker = await member(B.orgRef, ALL_ROLES);
  }, 90_000);
  const as = () => callerFor(attacker);
  const attempts: [string, () => Promise<unknown>][] = [
    // insurance — policies
    ["record a policy into A's book", () => as().insurance.policyRecord({ financialEntityId: A.entityId, policyType: "cargo", insurerName: "x", policyNumber: `X-${rnd()}`, effectiveAt: days(-1), expiresAt: days(300), coverages: [{ coverageType: "cargo" }] })],
    ["assign coverage on A's policy", () => as().insurance.coverageAssign({ policyRef: A.policyRef, entities: [{ entityType: "unit", entityId: B.unitId }], coveredFrom: days(-1) })],
    ["cover A's unit under B's own policy", () => as().insurance.coverageAssign({ policyRef: B.policyRef, entities: [{ entityType: "unit", entityId: A.unitId }], coveredFrom: days(-1) })],
    ["verify A's policy", () => as().insurance.coverageVerify({ policyRef: A.policyRef, outcome: "coverage_unknown" })],
    ["read coverage for A's unit in A's book", () => as().insurance.coverageForEntity({ financialEntityId: A.entityId, entityType: "unit", entityId: A.unitId })],
    ["read coverage for A's unit through B's book", () => as().insurance.coverageForEntity({ financialEntityId: B.entityId, entityType: "unit", entityId: A.unitId })],
    ["match customer requirements against A's book", () => as().insurance.requirementMatch({ financialEntityId: A.entityId, customerRef: "Acme" })],
    ["issue a certificate on A's policy", () => as().insurance.certificateIssue({ policyRef: A.policyRef, recipientCustomerRef: "Acme" })],
    ["read A's renewal calendar", () => as().insurance.renewalCalendar({ financialEntityId: A.entityId })],
    // insurance — claims
    ["open a claim on A's policy", () => as().insurance.claimOpen({ policyRef: A.policyRef, lossOccurredAt: days(-1), claimType: "glass" })],
    ["record a cost on A's claim", () => as().insurance.claimCostRecord({ claimRef: A.claimRef, costType: "repair", amount: 1, incurredAt: days(-1) })],
    ["record a recovery on A's claim", () => as().insurance.claimRecoveryRecord({ claimRef: A.claimRef, recoveryType: "denied", amount: 1 })],
    ["read A's claim financials", () => as().insurance.claimFinancials({ claimRef: A.claimRef })],
    // compliance / requirements / calibration
    ["publish a program into A's company", () => as().compliance.programPublish({ programKey: A.programKey, title: "Attempted manual", programType: "safety", financialEntityId: A.entityId, effectiveFrom: days(-1) })],
    ["record a carrier profile review for A", () => as().compliance.profileReviewRecord({ financialEntityId: A.entityId, jurisdiction: "CA-AB", profileObtainedAt: days(-1), inspectionsOnProfile: 0, convictionsOnProfile: 0, collisionsOnProfile: 0, knownInspections: 0, knownConvictions: 0, knownCollisions: 0 })],
    ["activate a compliance pack for A", () => as().requirement.packActivate({ financialEntityId: A.entityId, packKey: "ab.ground_disturbance" })],
    ["evaluate a work context against A's company", () => as().requirement.workAuthorization({ financialEntityId: A.entityId, jurisdiction: "CA-AB", worker: null, equipment: null, work: { workType: "hauling", attributes: {} } })],
    ["authorize an operator on equipment for A", () => as().requirement.authorize({ userId: A.safety, financialEntityId: A.entityId, equipmentType: "hydrovac" })],
    ["register a device into A's company", () => as().calibration.deviceRegister({ financialEntityId: A.entityId, deviceType: "truck_scale", measures: "gross_weight", unitOfMeasure: "kg" })],
    ["record a calibration event on A's device", () => as().calibration.eventRecord({ deviceRef: A.deviceRef, eventType: "verified", performedAt: days(-1) })],
    ["read the impact of A's device", () => as().calibration.impact({ deviceRef: A.deviceRef })],
    ["sweep A's calibration event", () => as().requirement.calibrationSweep({ calibrationEventId: A.calibrationEventId })],
    // dispatch
    ["set A's dispatch enforcement", () => as().dispatch.enforcementSet({ financialEntityId: A.entityId, mode: "off", reason: "attempted by another organization" })],
    ["read A's dispatch enforcement", () => as().dispatch.enforcementGet({ financialEntityId: A.entityId })],
    // funding / expenses
    ["advance A's funding opportunity", () => as().funding.opportunityAdvance({ opportunityRef: A.opportunityRef, to: "potential" })],
    ["record a funding claim on A's expense", () => as().funding.claimRecord({ claimRef: `C-${rnd()}`, programKey: "x", expenseRef: A.expenseRef, eligibleCost: 1, claimedAmount: 1 })],
    ["set tax treatment on A's expense", () => as().finance.expenseSetTreatment({ expenseRef: A.expenseRef, treatment: "personal" })],
  ];

  it.each(attempts)("refuses to %s", async (_label, attempt) => {
    const e = await attempt().then(() => null, (x: { code?: string; message?: string }) => x);
    expect(e, "the attempt succeeded").not.toBeNull();
    // NOT_FOUND — or, for a funding claim whose program key is unknown, "No such program" before the expense is reached (also NOT_FOUND).
    expect(e!.code).toBe("NOT_FOUND");
  });

  it("never lets B's own-book program supersede A's program with the same key (the key is refused as taken)", async () => {
    await expect(callerFor(B.safety).compliance.programPublish({ programKey: A.programKey, title: "B's manual", programType: "safety", financialEntityId: B.entityId, effectiveFrom: days(-1) })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await pool.query<mysql.RowDataPacket[]>("SELECT financialEntityId, supersededAt FROM writtenProgramVersions WHERE programKey = ? ORDER BY id", [A.programKey]);
    expect(rows[0].find(r => r.financialEntityId === A.entityId)!.supersededAt).toBeNull();
  });

  it("lists only the caller's own funding opportunities", async () => {
    const list = (await as().funding.opportunitiesList()).map(o => o.opportunityRef);
    expect(list).toContain(B.opportunityRef);
    expect(list).not.toContain(A.opportunityRef);
  });

  it("refuses the global dispatch mode to an organization, to set or to read (main's rule, C1a)", async () => {
    await expect(callerFor(B.mgr).dispatch.enforcementSet({ mode: "off", reason: "attempt to change every company's dispatch" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(B.mgr).dispatch.enforcementGet()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leaves A's insurance, calibration, funding and expense records as A left them", async () => {
    expect((await one("SELECT coverageVerificationStatus FROM insurancePolicies WHERE policyRef = ?", [A.policyRef])).coverageVerificationStatus).toBe("coverage_verified");
    expect((await one("SELECT COUNT(*) AS n FROM insuranceClaims c JOIN insurancePolicies p ON p.id = c.insurancePolicyId WHERE p.policyRef = ?", [A.policyRef])).n).toBe(1);
    expect((await one("SELECT COUNT(*) AS n FROM insuranceClaimRecoveries r JOIN insuranceClaims c ON c.id = r.insuranceClaimId WHERE c.claimRef = ?", [A.claimRef])).n).toBe(0);
    expect((await one("SELECT COUNT(*) AS n FROM insuranceCoveredEntities e JOIN insurancePolicies p ON p.id = e.insurancePolicyId WHERE e.entityType = 'unit' AND e.entityId = ? AND p.policyRef = ?", [A.unitId, B.policyRef])).n).toBe(0);
    expect((await one("SELECT COUNT(*) AS n FROM calibrationEvents e JOIN measurementDevices d ON d.id = e.measurementDeviceId WHERE d.deviceRef = ?", [A.deviceRef])).n).toBe(1);
    expect((await one("SELECT status FROM fundingOpportunities WHERE opportunityRef = ?", [A.opportunityRef])).status).toBe("estimated");
    expect((await one("SELECT COUNT(*) AS n FROM fundingClaims WHERE expenseRef = ?", [A.expenseRef])).n).toBe(0);
    expect((await one("SELECT mode FROM dispatchEnforcementSettings WHERE financialEntityId = ? ORDER BY id DESC LIMIT 1", [A.entityId])).mode).toBe("advisory");
  });

  it("still lets each organization work its own records", async () => {
    expect((await callerFor(A.controller).insurance.claimFinancials({ claimRef: A.claimRef })).claimRef).toBe(A.claimRef);
    expect((await callerFor(A.office).insurance.renewalCalendar({ financialEntityId: A.entityId })).calendar.length).toBeGreaterThan(0);
    expect((await callerFor(A.office).insurance.certificateIssue({ policyRef: A.policyRef, recipientCustomerRef: "Acme" })).certificateRef).toBeTruthy();
    expect((await callerFor(A.mgr).dispatch.enforcementGet({ financialEntityId: A.entityId })).mode).toBe("advisory");
    expect((await callerFor(A.office).insurance.coverageForEntity({ financialEntityId: A.entityId, entityType: "unit", entityId: A.unitId })).assessments.length).toBeGreaterThan(0);
    expect((await callerFor(A.mgr).funding.opportunitiesList()).map(o => o.opportunityRef)).toContain(A.opportunityRef);
  });
});

d("F1.1 — inventory and other rows with no owner fail closed once organizations exist", () => {
  it("knows the deployment is not one ownership domain (organizations exist here)", async () => {
    const { singleOwnershipDomain } = await import("./ownershipDomain");
    await org();
    expect(await singleOwnershipDomain()).toBe(false);
  });

  it("refuses every ownerless shop operation — to an organization's shop lead AND to the historical single tenant — and writes nothing", async () => {
    const orgA = await org();
    const lead = await member(orgA, ["shop_lead", "mechanic", "controller", "management"]);
    const legacy = await member(null, ["shop_lead", "mechanic", "controller", "management"]);
    const unitId = await ownedUnit(orgA);
    const [wo] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO workOrders (workOrderNumber, unitId, status, openedAt) VALUES (?, ?, 'open', NOW())", [`WO-${rnd()}`, unitId]);
    const woNumber = (await one("SELECT workOrderNumber FROM workOrders WHERE id = ?", [wo.insertId])).workOrderNumber as string;
    const before = Number((await one("SELECT COUNT(*) AS n FROM partMovements", [])).n);
    const partsBefore = Number((await one("SELECT COUNT(*) AS n FROM parts", [])).n);
    for (const who of [lead, legacy]) {
      const c = callerFor(who).shop;
      const ops: [string, () => Promise<unknown>][] = [
        ["stock", () => c.stock({})],
        ["partCount", () => c.partCount({ partNumber: "FILTER-OIL", countedQty: 0, reason: "zero someone else's stock" })],
        ["partIssue", () => c.partIssue({ partNumber: "FILTER-OIL", qty: 6, workOrderNumber: woNumber })],
        ["partReceive", () => c.partReceive({ partNumber: "FILTER-OIL", qty: 1, unitCostCents: 100 })],
        ["partReturn", () => c.partReturn({ partNumber: "FILTER-OIL", qty: 1, reason: "return" })],
        ["coreReturn", () => c.coreReturn({ partNumber: "FILTER-OIL", qty: 1 })],
        ["partCreate", () => c.partCreate({ partNumber: `P-${rnd()}`, description: "filter", category: "filter" })],
        ["tireRegister", () => c.tireRegister({ serial: `T-${rnd()}`, size: "11R22.5" })],
        ["tireInstall", () => c.tireInstall({ serial: "T-ANY", unitId, axlePosition: "LF", installedAt: new Date() })],
        ["tireRemove", () => c.tireRemove({ serial: "T-ANY", removedAt: new Date(), removalReason: "worn" })],
        ["tireMeasure", () => c.tireMeasure({ serial: "T-ANY", measuredAt: new Date() })],
        ["tireHistory", () => c.tireHistory({ serial: "T-ANY" })],
        ["toolRegister", () => c.toolRegister({ serial: `TL-${rnd()}`, description: "torque wrench" })],
        ["toolCheckout", () => c.toolCheckout({ serial: "TL-ANY", workerUserId: who })],
        ["toolReturn", () => c.toolReturn({ serial: "TL-ANY", condition: "good" })],
        ["warrantyPolicyRecord", () => c.warrantyPolicyRecord({ subjectType: "part", subjectId: 1, coverageUntil: days(300) } as never)],
        ["warrantyClaimRaise", () => c.warrantyClaimRaise({ policyRef: "WPOL-ANY", claimedCents: 100, reason: "failed early, claim it" })],
        ["warrantyClaimDecide", () => c.warrantyClaimDecide({ claimRef: "WCLM-ANY", decision: "approved", reason: "approve it" })],
      ];
      for (const [name, op] of ops) await expect(op(), name).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
    }
    expect(Number((await one("SELECT COUNT(*) AS n FROM partMovements", [])).n)).toBe(before);
    expect(Number((await one("SELECT COUNT(*) AS n FROM parts", [])).n)).toBe(partsBefore);
    // The scoped shop keeps working: the unit's own work-order cost is the unit owner's to read.
    await expect(callerFor(lead).shop.workOrderCost({ workOrderNumber: woNumber })).resolves.toBeTruthy();
  }, 60_000);

  it("refuses customer insurance requirements (free-text, ownerless) and equipment credentials, and changes nothing", async () => {
    const orgA = await org();
    const office = await member(orgA, ["office", "management"]);
    const cust = `Cust ${rnd()}`;
    await pool.execute("INSERT INTO insuranceRequirements (customerRef, coverageType, minimumLimit, additionalInsuredRequired) VALUES (?, 'commercial_auto', 1000000, 0)", [cust]);
    await expect(callerFor(office).insurance.requirementSet({ customerRef: cust, requirements: [{ coverageType: "cargo" }] })).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
    expect((await one("SELECT coverageType FROM insuranceRequirements WHERE customerRef = ?", [cust])).coverageType).toBe("commercial_auto");
    const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Own Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgA]);
    await expect(callerFor(office).insurance.requirementMatch({ financialEntityId: Number(ent.insertId), customerRef: cust })).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
    await expect(callerFor(office).requirement.workAuthorization({ financialEntityId: Number(ent.insertId), jurisdiction: "CA-AB", worker: null, equipment: { id: 1, equipmentType: "hydrovac", attributes: {} }, work: { workType: "hauling", attributes: {} } })).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
  }, 30_000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// F1.2 — compliance subjects: operators, units, trailers, jobs, people and carriers are the caller's own
// ══════════════════════════════════════════════════════════════════════════════════════════════════
/** One organization's compliance subjects and the credentials its own people filed against them. */
async function world12(orgRef: string) {
  const people = { office: await member(orgRef, ["office"]), hr: await member(orgRef, ["hr"]), dispatcher: await member(orgRef, ["dispatcher"]) };
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [`Op ${rnd()}`]);
  const operatorId = Number(op.insertId);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, operatorId]);
  const unitId = await ownedUnit(orgRef);
  const jobCode = `J-${rnd()}`;
  const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'water_haul','transport','Acme','LSD','dispatched',0)", [orgRef, jobCode]);
  const [ent] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Carrier Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgRef]);
  const [ev] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, capturedBy) VALUES ('Licence scan', 'compliance', NOW(), ?)", [people.office]);
  const cred = await callerFor(people.office).compliance.credentialRecord({ ownerType: "operator", ownerId: operatorId, docType: "driver_licence", title: "Class 1 licence", expiresAt: days(400), evidenceRecordId: Number(ev.insertId) });
  await callerFor(people.hr).compliance.credentialRecord({ ownerType: "operator", ownerId: operatorId, docType: "medical_fitness", title: "Medical — see HR", expiresAt: days(400), privateDetail: true });
  return { orgRef, ...people, operatorId, unitId, jobId: Number(job.insertId), entityId: Number(ent.insertId), evidenceId: Number(ev.insertId), credentialId: cred.credentialId };
}

d("F1.2 — Organization B cannot read or file compliance records against Organization A's subjects", () => {
  let A: Awaited<ReturnType<typeof world12>>, B: Awaited<ReturnType<typeof world12>>, attacker: number;
  beforeAll(async () => {
    A = await world12(await org());
    B = await world12(await org());
    attacker = await member(B.orgRef, [...ALL_ROLES, "hr"]);
  }, 60_000);
  const as = () => callerFor(attacker).compliance;
  const passport = (subjectType: "operator" | "unit" | "trailer" | "carrier" | "job" | "user", subjectId: number) => as().passport({ subjectType, subjectId, jurisdiction: "CA-AB" });
  const attempts: [string, () => Promise<unknown>][] = [
    ["read the passport of A's operator", () => passport("operator", A.operatorId)],
    ["read the passport of A's unit", () => passport("unit", A.unitId)],
    ["read the passport of A's unit as a trailer", () => passport("trailer", A.unitId)],
    ["read the passport of A's job", () => passport("job", A.jobId)],
    ["read the passport of A's person", () => passport("user", A.office)],
    ["read the passport of A's company as a carrier", () => passport("carrier", A.entityId)],
    ["compose a job passport with A's operator beside B's own unit", () => as().jobPassport({ jurisdiction: "CA-AB", carrier: null, operator: { id: A.operatorId }, unit: { id: B.unitId } })],
    ["compose a job passport with A's carrier", () => as().jobPassport({ jurisdiction: "CA-AB", carrier: { id: A.entityId }, operator: null, unit: null })],
    ["compose a job passport with A's trailer", () => as().jobPassport({ jurisdiction: "CA-AB", carrier: null, operator: null, unit: null, trailer: { id: A.unitId } })],
    ["read the medical eligibility of A's operator", () => as().medicalEligibility({ operatorId: A.operatorId })],
    ["file a credential against A's operator", () => as().credentialRecord({ ownerType: "operator", ownerId: A.operatorId, docType: "driver_licence", title: "Planted licence" })],
    ["file a credential against A's unit", () => as().credentialRecord({ ownerType: "unit", ownerId: A.unitId, docType: "vehicle_registration", title: "Planted registration" })],
    ["file a credential against A's company", () => as().credentialRecord({ ownerType: "carrier", ownerId: A.entityId, docType: "sfc", title: "Planted SFC" })],
    ["file a credential against A's job", () => as().credentialRecord({ ownerType: "job", ownerId: A.jobId, docType: "permit", title: "Planted permit" })],
    ["file a credential for B's own operator on A's evidence", () => as().credentialRecord({ ownerType: "operator", ownerId: B.operatorId, docType: "driver_licence", title: "Borrowed scan", evidenceRecordId: A.evidenceId })],
    ["verify A's credential", () => as().credentialVerify({ credentialId: A.credentialId, outcome: "rejected" })],
    ["record consent for A's person", () => as().consentRecord({ subjectUserId: A.office, consentType: "driver_abstract", purpose: "pull A's driver abstract", signedAt: days(-1) })],
    ["record consent for B's own person on A's signature evidence", () => as().consentRecord({ subjectUserId: B.office, consentType: "driver_abstract", purpose: "borrowed signature", signedAt: days(-1), signatureEvidenceRecordId: A.evidenceId })],
  ];

  it.each(attempts)("refuses to %s", async (_label, attempt) => {
    const e = await attempt().then(() => null, (x: { code?: string }) => x);
    expect(e, "the attempt succeeded").not.toBeNull();
    expect(e!.code).toBe("NOT_FOUND");
  });

  it("answers another company's subject exactly as it answers one that does not exist", async () => {
    const foreign = await passport("operator", A.operatorId).catch((x: Error) => x.message);
    const missing = await passport("operator", 2_000_000_000).catch((x: Error) => x.message);
    expect(foreign).toBe(missing);
    const foreignCred = await as().credentialVerify({ credentialId: A.credentialId, outcome: "verified" }).catch((x: Error) => x.message);
    const missingCred = await as().credentialVerify({ credentialId: 2_000_000_000, outcome: "verified" }).catch((x: Error) => x.message);
    expect(foreignCred).toBe(missingCred);
  });

  it("refuses equipment credentials while equipment carries no owner", async () => {
    await expect(as().credentialRecord({ ownerType: "equipment", ownerId: 1, docType: "annual_inspection", title: "Planted inspection" })).rejects.toThrow(/OWNERSHIP_UNRESOLVED/);
  });

  it("leaves A's credentials and consents as A left them", async () => {
    expect((await one("SELECT verificationStatus, verifiedByUserId FROM complianceDocuments WHERE id = ?", [A.credentialId])).verificationStatus).toBe("needs_review");
    expect(Number((await one("SELECT COUNT(*) AS n FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ?", [A.operatorId])).n)).toBe(2);
    expect(Number((await one("SELECT COUNT(*) AS n FROM complianceDocuments WHERE (ownerType = 'unit' AND ownerId = ?) OR (ownerType = 'carrier' AND ownerId = ?) OR (ownerType = 'job' AND ownerId = ?) OR evidenceRecordId = ?", [A.unitId, A.entityId, A.jobId, A.evidenceId])).n)).toBe(1); // A's own licence, on A's own evidence
    expect(Number((await one("SELECT COUNT(*) AS n FROM complianceConsents WHERE subjectUserId = ? OR requestedByUserId = ?", [A.office, attacker])).n)).toBe(0);
  });

  it("still lets each organization work its own subjects", async () => {
    expect((await callerFor(A.dispatcher).compliance.passport({ subjectType: "operator", subjectId: A.operatorId, jurisdiction: "CA-AB" })).verdict).toBeTruthy();
    // Each owner path resolves for its own organization — a refusal that only works by accident fails here.
    for (const [subjectType, subjectId] of [["carrier", A.entityId], ["unit", A.unitId], ["trailer", A.unitId], ["job", A.jobId], ["user", A.office]] as const)
      expect((await callerFor(A.dispatcher).compliance.passport({ subjectType, subjectId, jurisdiction: "CA-AB" })).verdict, subjectType).toBeTruthy();
    expect((await callerFor(A.dispatcher).compliance.jobPassport({ jurisdiction: "CA-AB", carrier: { id: A.entityId }, operator: { id: A.operatorId }, unit: { id: A.unitId }, trailer: { id: A.unitId } })).verdict).toBeTruthy();
    expect((await callerFor(A.dispatcher).compliance.medicalEligibility({ operatorId: A.operatorId })).eligible).toBe("unknown");
    expect((await callerFor(A.office).compliance.credentialVerify({ credentialId: A.credentialId, outcome: "verified" })).verificationStatus).toBe("verified");
    expect((await callerFor(A.office).compliance.consentRecord({ subjectUserId: A.hr, consentType: "driver_abstract", purpose: "annual abstract", signedAt: days(-1), signatureEvidenceRecordId: A.evidenceId })).consentRef).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// F1.3 — the global dispatch mode is platform-governed
// ══════════════════════════════════════════════════════════════════════════════════════════════════
d("F1.3 — once organizations exist, only platform authority changes the global dispatch mode", () => {
  /** A caller whose session claims `claimed`; what counts is the users row, if any. */
  const session = (userId: number, claimed: "user" | "admin") => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: claimed } as never });
  const usersRow = (userId: number, role: "user" | "admin") => pool.execute("INSERT INTO users (id, openId, role) VALUES (?, ?, ?)", [userId, `f13-${userId}-${rnd()}`, role]);
  const book = async (orgRef: string) => Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Dispatch Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgRef]))[0].insertId);
  const latestGlobal = async () => (await one("SELECT mode, setByUserId FROM dispatchEnforcementSettings WHERE financialEntityId IS NULL ORDER BY setAt DESC, id DESC LIMIT 1", [])) as { mode: string; setByUserId: number };
  let orgA: string, orgB: string, admin: number, orgAdmin: number, unaffiliated: number, mgrA: number, mgrB: number, bookA: number, bookA2: number, bookB: number;

  beforeAll(async () => {
    orgA = await org(); orgB = await org();
    admin = await member(null, ["management"]); await usersRow(admin, "admin");            // platform admin, no membership
    orgAdmin = await member(orgA, ["management"]); await usersRow(orgAdmin, "admin");      // platform admin who also works for A
    unaffiliated = await member(null, ["management"]); await usersRow(unaffiliated, "user"); // ordinary, unaffiliated, holds the permission
    mgrA = await member(orgA, ["management"]); mgrB = await member(orgB, ["management"]);
    bookA = await book(orgA); bookA2 = await book(orgA); bookB = await book(orgB);
  }, 30_000);
  afterAll(async () => { if (admin) await session(admin, "admin").dispatch.enforcementSet({ mode: "off", reason: "F1.3 teardown — restore the global default" }); });

  it("1. lets a platform administrator set the global mode — unaffiliated or a member of an organization", async () => {
    expect((await session(admin, "admin").dispatch.enforcementSet({ mode: "advisory", reason: "platform: advisory everywhere by default" })).scope).toBe("global");
    expect((await session(orgAdmin, "admin").dispatch.enforcementSet({ mode: "advisory", reason: "platform: same default, set by an admin in org A" })).scope).toBe("global");
    expect(await latestGlobal()).toMatchObject({ mode: "advisory", setByUserId: orgAdmin });
  });

  it("2. refuses an ordinary unaffiliated user, though they hold the dispatch permission", async () => {
    await expect(session(unaffiliated, "user").dispatch.enforcementSet({ mode: "off", reason: "unaffiliated, so surely mine to change" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(session(mgrA, "user").dispatch.enforcementSet({ mode: "off", reason: "org A trying the global switch" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("3. lets Organization A's authorized user set A's own mode", async () => {
    expect((await session(mgrA, "user").dispatch.enforcementSet({ financialEntityId: bookA, mode: "enforced", reason: "A enforces its own dispatch" })).scope).toBe(bookA);
  });

  it("4. refuses Organization A's user on Organization B's mode, as not found", async () => {
    await expect(session(mgrA, "user").dispatch.enforcementSet({ financialEntityId: bookB, mode: "off", reason: "A switching B's gate off" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(session(mgrA, "user").dispatch.enforcementGet({ financialEntityId: bookB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(session(mgrB, "user").dispatch.enforcementSet({ financialEntityId: bookB, mode: "advisory", reason: "B sets its own mode" })).resolves.toBeTruthy();
  });

  it("5. resolves an organization with no mode of its own through the global fallback", async () => {
    expect(await session(mgrA, "user").dispatch.enforcementGet({ financialEntityId: bookA2 })).toMatchObject({ mode: "advisory", source: "global" });
  });

  it("6. lets an organization's explicit mode override the global one", async () => {
    expect(await session(mgrA, "user").dispatch.enforcementGet({ financialEntityId: bookA })).toMatchObject({ mode: "enforced", source: "entity" });
    expect((await latestGlobal()).mode).toBe("advisory");
  });

  it("7. cannot be bypassed: a claimed session role, extra input, a demotion, a missing users row, or no domain permission", async () => {
    const before = await latestGlobal();
    // A session that claims admin, over a users row that says otherwise.
    await expect(session(unaffiliated, "admin").dispatch.enforcementSet({ mode: "off", reason: "my session says admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Authority smuggled in the input: stripped, and it would not count anyway.
    await expect(session(unaffiliated, "user").dispatch.enforcementSet({ mode: "off", reason: "input says admin", role: "admin", platformAdmin: true, isAdmin: true } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An explicit null entity is the global row, not a loophole.
    await expect(session(mgrA, "user").dispatch.enforcementSet({ financialEntityId: null, mode: "off", reason: "null entity, maybe unchecked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // No users row at all.
    const ghost = await member(null, ["management"]);
    await expect(session(ghost, "admin").dispatch.enforcementSet({ mode: "off", reason: "no row, but my session says admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Platform authority is not a domain permission: an admin without it is refused by the role gate.
    const bareAdmin = await member(null, []); await usersRow(bareAdmin, "admin");
    await expect(session(bareAdmin, "admin").dispatch.enforcementSet({ mode: "off", reason: "admin, but no dispatch permission" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Demotion takes effect on the next call, though the session was minted while they were an admin.
    const demoted = await member(null, ["management"]); await usersRow(demoted, "admin");
    await session(demoted, "admin").dispatch.enforcementSet({ mode: "advisory", reason: "while still an administrator" });
    await pool.execute("UPDATE users SET role = 'user' WHERE id = ?", [demoted]);
    await expect(session(demoted, "admin").dispatch.enforcementSet({ mode: "off", reason: "after demotion, same session" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await latestGlobal()).toMatchObject({ mode: before.mode, setByUserId: demoted });
    expect((await latestGlobal()).mode).toBe("advisory");
  });

  it("keeps C1a's read rule: an organization member cannot read the global row; the single tenant and platform authority can", async () => {
    await expect(session(mgrA, "user").dispatch.enforcementGet()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await session(unaffiliated, "user").dispatch.enforcementGet()).mode).toBe("advisory");
    expect((await session(orgAdmin, "admin").dispatch.enforcementGet()).mode).toBe("advisory");
  });
});
