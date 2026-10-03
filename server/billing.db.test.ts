/**
 * v23.32 — Billing, Invoicing and Accounts Receivable, through the database.
 *
 * Proven here against MariaDB, through the real routers: a signed, priced ticket becomes a charge priced from the
 * job's FROZEN commercial snapshot; the job is reviewed and approved by different people; an invoice is drafted
 * (one job, several jobs, a slice of a charge), approved by someone else, issued, paid, reversed, disputed and
 * credited — and every one of those refuses another organization, a former member, a driver, a self-approval, a
 * race and a double bill, with the database itself holding the line where the service could be raced.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 360_000_000 + Math.floor(Math.random() * 50_000);
/** Explicit financial-entity ids, in their own declared band. */
let entitySeq = 2_300_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 8 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const year = new Date().getUTCFullYear();

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = userSeq++;
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  return userId;
}
async function entity(orgRef: string) {
  const id = entitySeq++;
  await pool.execute("INSERT INTO financialEntities (id, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay, orgRef) VALUES (?,?,?,'corporation','AB',12,31,?)", [id, `FE-${rnd()}`, `entity ${rnd()}`, orgRef]);
  return id;
}
async function tenant() {
  const orgRef = await org();
  const financialEntityId = await entity(orgRef);
  const [office, management, controller, bookkeeper, dispatcher, driver, auditor] = [
    await member(orgRef, ["office"]), await member(orgRef, ["management"]), await member(orgRef, ["controller"]), await member(orgRef, ["bookkeeper"]),
    await member(orgRef, ["dispatcher"]), await member(orgRef, ["driver"]), await member(orgRef, ["auditor"]),
  ];
  return { orgRef, financialEntityId, office, management, controller, bookkeeper, dispatcher, driver, auditor };
}
type T = Awaited<ReturnType<typeof tenant>>;

/** A customer with an approved $185/h sheet (4 h minimum, quarter-hour increment). */
async function customer(t: T, o: { taxStatus?: "taxable" | "zero_rated" | "exempt" | "unknown"; paymentTermsDays?: number } = {}) {
  const c = await callerFor(t.office).customerCommercial.customers.create({ financialEntityId: t.financialEntityId, name: `Bighorn ${rnd()}`, taxStatus: o.taxStatus ?? "zero_rated", paymentTermsDays: o.paymentTermsDays ?? 30 });
  const sheet = await callerFor(t.office).customerCommercial.rateSheets.create({ accountRef: c.accountRef, name: "Hydrovac rates", effectiveFrom: new Date("2026-01-01T00:00:00Z") });
  await callerFor(t.office).customerCommercial.rateSheets.lineAdd({ versionRef: sheet.versionRef, serviceCode: "hydrovac_hour", lineKind: "hourly_equipment", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000, minimumQuantityMillis: 4000, billingIncrementMillis: 250, sourceClause: "§4.1" });
  await callerFor(t.office).customerCommercial.rateSheets.versionSubmit({ versionRef: sheet.versionRef, event: "submit" });
  await callerFor(t.controller).customerCommercial.rateSheets.versionDecide({ versionRef: sheet.versionRef, event: "approve" });
  return { accountRef: c.accountRef, accountId: Number((await pool.query<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [c.accountRef]))[0][0]!.id), rateSheetRef: sheet.rateSheetRef, versionRef: sheet.versionRef };
}
type Line = { serviceCode: string | null; hours: number; disposition?: "accepted" | "disputed" | "not_presented"; unit?: string };
/** A complete job, its commercial basis frozen, and a closed, signed field ticket with the given lines. */
async function billableJob(t: T, c: Awaited<ReturnType<typeof customer>>, lines: Line[] = [{ serviceCode: "hydrovac_hour", hours: 5.5 }], o: { snapshot?: boolean; signed?: boolean } = {}) {
  const jobCode = `JOB-${rnd()}`;
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location, status) VALUES (?,?,?,?,?, 'complete')", [t.orgRef, jobCode, "Hydrovac", "free text", "LSD 4-12"]);
  const jobId = j.insertId;
  await callerFor(t.dispatcher).customerCommercial.jobs.contextSet({ jobId, accountRef: c.accountRef, rateSheetRef: c.rateSheetRef });
  if (o.snapshot !== false) await callerFor(t.dispatcher).customerCommercial.jobs.snapshotCapture({ jobId, reason: "activation" });
  const ticketNumber = `FT-${rnd()}`;
  const signed = o.signed !== false;
  const [ft] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fieldTickets (ticketNumber, scope, jobId, customerAccountId, status, signatureStatus, startedAt, completedAt) VALUES (?, 'job', ?, ?, 'closed', ?, '2026-09-10 08:00:00', '2026-09-10 16:00:00')", [ticketNumber, jobId, c.accountId, signed ? "accepted" : "unsigned"]);
  if (signed) {
    await pool.execute("INSERT INTO fieldTicketRevisions (documentRef, fieldTicketId, revision, kind, snapshotJson, snapshotHash, generatedAt) VALUES (?, ?, 1, 'site_signed', '{}', 'h1', '2026-09-10 16:00:00')", [`${ticketNumber}-R1`, ft.insertId]);
    await pool.execute("INSERT INTO fieldTicketSignatures (fieldTicketId, revision, result, signerName, payloadHash, capturedAt) VALUES (?, 1, 'accepted', 'M. Johnson', 'h1', '2026-09-10 16:05:00')", [ft.insertId]);
  }
  for (const l of lines) await pool.execute("INSERT INTO fieldTicketLines (fieldTicketId, lineKind, serviceCode, description, quantity, quantityUnit, measurementMethod, disposition) VALUES (?, 'service', ?, ?, ?, ?, 'system_timed', ?)", [ft.insertId, l.serviceCode, `Hydrovac excavation ${l.hours} h`, l.hours, l.unit ?? "hr", l.disposition ?? "accepted"]);
  return { jobId, jobCode, ticketNumber, fieldTicketId: ft.insertId };
}
/** Prepare, submit (office), approve (management): the job is approved for invoicing. */
async function approvedJob(t: T, c: Awaited<ReturnType<typeof customer>>, lines?: Line[]) {
  const j = await billableJob(t, c, lines);
  await callerFor(t.office).billing.prepare({ jobId: j.jobId });
  await callerFor(t.office).billing.reviewSubmit({ jobId: j.jobId });
  await callerFor(t.management).billing.reviewDecide({ jobId: j.jobId, decision: "approve", note: "Ticket and rates checked" });
  return j;
}
/** Draft (office), submit (office), approve (controller), issue (office). */
async function issuedInvoice(t: T, jobIds: number[]) {
  const dr = await callerFor(t.office).billing.invoiceDraft({ jobIds });
  await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: dr.invoiceNumber });
  await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber });
  await callerFor(t.office).billing.invoiceIssue({ invoiceNumber: dr.invoiceNumber });
  return dr;
}
/** An organization's events of one type for one aggregate. Numbers are per organization, so the tenant is part of the key. */
const outbox = async (type: string, aggregateId: string, tenantId: string) => (await pool.query<mysql.RowDataPacket[]>("SELECT payloadJson FROM domainEventOutbox WHERE eventType = ? AND aggregateId = ? AND tenantId = ?", [type, aggregateId, tenantId]))[0];
const auditTypes = async (financialEntityId: number) => (await pool.query<mysql.RowDataPacket[]>("SELECT DISTINCT eventType FROM commercialAuditEvents WHERE financialEntityId = ?", [financialEntityId]))[0].map(r => r.eventType as string);

d("a signed, priced ticket to cash: readiness, review, invoice, issue, payment, reversal", () => {
  it("runs the whole path, each act by the right person, each recorded", async () => {
    const t = await tenant();
    const c = await customer(t, { paymentTermsDays: 45 });
    const j = await billableJob(t, c);

    // Readiness before charges: a named blocker, not an error.
    const r0 = await callerFor(t.office).billing.readiness({ jobId: j.jobId });
    expect(r0.ready).toBe(false);
    expect(r0.blockers.map(b => b.code)).toEqual(["charges_not_prepared"]);

    // Prepare: priced by the commercial engine from the job's frozen snapshot — 5.5 h × $185 = $1,017.50.
    const prep = await callerFor(t.office).billing.prepare({ jobId: j.jobId });
    expect(prep.created).toHaveLength(1);
    expect(prep.created[0]).toMatchObject({ status: "ready", amountCents: 101_750, outcome: "priced" });
    expect(prep.state).toBe("ready");
    expect(await outbox("billing.ready", String(j.jobId), t.orgRef)).toHaveLength(1);
    const ws = await callerFor(t.office).billing.workspace({ jobId: j.jobId });
    const charge = ws.charges[0]!;
    expect(charge).toMatchObject({ sourceKind: "field_ticket_line", commercialSnapshotRef: ws.commercial!.snapshotRef, rateSheetVersionRef: c.versionRef, unit: "hour", quantityMillis: 5_500, billableQuantityMillis: 5_500, rateMillis: 185_000, pricingMethod: "per_unit" });
    expect(charge.definitionRef).toBeTruthy(); expect(charge.scopeLevel).toBeTruthy();
    expect(charge.reasons[0]).toMatch(/Priced against snapshot/);

    // Review: submitted by the office, never approved by the person who submitted it.
    await callerFor(t.office).billing.reviewSubmit({ jobId: j.jobId, note: "ready" });
    await expect(callerFor(t.management).billing.reviewSubmit({ jobId: j.jobId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const dual = await member(t.orgRef, ["office", "management"]);
    await callerFor(dual).billing.reviewDecide({ jobId: j.jobId, decision: "return", note: "Re-check the hours" });
    await callerFor(dual).billing.reviewSubmit({ jobId: j.jobId });
    await expect(callerFor(dual).billing.reviewDecide({ jobId: j.jobId, decision: "approve", note: "self-approval" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(t.office).billing.reviewDecide({ jobId: j.jobId, decision: "approve", note: "Not mine to approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ap = await callerFor(t.management).billing.reviewDecide({ jobId: j.jobId, decision: "approve", note: "Ticket and rates checked" });
    expect(ap.state).toBe("approved_for_invoicing");

    // Draft: the organization's own INV series, provenance on the line, the charge consumed.
    const dr = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] });
    expect(dr).toMatchObject({ invoiceNumber: `INV-${year}-000001`, status: "draft", subtotalCents: 101_750, taxCents: 0, totalCents: 101_750, taxCode: "ZERO_RATED", taxDetermined: true, lines: 1 });
    const [[alloc]] = await pool.query<mysql.RowDataPacket[]>("SELECT state, recordType, recordId, scopeKey FROM numberAllocations WHERE formattedNumber = ? AND scopeKey = ?", [dr.invoiceNumber, t.orgRef]);
    expect(alloc).toMatchObject({ state: "issued", recordType: "invoice", scopeKey: t.orgRef });
    expect(alloc!.recordId).toBeGreaterThan(0);
    const g0 = await callerFor(t.office).billing.invoiceGet({ invoiceNumber: dr.invoiceNumber });
    expect(g0.lines[0]).toMatchObject({ description: "Hydrovac excavation 5.5 h", amountCents: 101_750, taxCode: "ZERO_RATED", taxCents: 0 });
    expect(g0.lines[0]!.provenance).toMatchObject({ chargeRef: charge.chargeRef, jobId: j.jobId, evidence: { fieldTicketLineId: charge.sourceId }, commercialSnapshotRef: charge.commercialSnapshotRef, rateSheetVersionRef: c.versionRef, rateLine: { definitionRef: charge.definitionRef } });
    expect(g0.lines[0]!.description).not.toMatch(/CHG-|JCS-|RSHT/);   // the customer's description carries no internal provenance
    const consumed = (await pool.query<mysql.RowDataPacket[]>("SELECT billedQuantityMillis, billedAmountCents FROM billableCharges WHERE chargeRef = ?", [charge.chargeRef]))[0][0]!;
    expect(consumed).toMatchObject({ billedQuantityMillis: 5_500, billedAmountCents: 101_750 });
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("invoiced");
    // A draft is not a receivable: no payment, no credit, no dispute.
    await expect(callerFor(t.office).billing.creditCreate({ invoiceNumber: dr.invoiceNumber, amountCents: 100, reason: "Too early for a credit" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // Submit → approve (someone else) → issue.
    await expect(callerFor(t.office).billing.invoiceIssue({ invoiceNumber: dr.invoiceNumber })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await callerFor(dual).billing.invoiceSubmit({ invoiceNumber: dr.invoiceNumber });
    await expect(callerFor(dual).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/submitted/) });   // dual (office + management) submitted it
    const selfApprover = await member(t.orgRef, ["controller"]);
    await callerFor(selfApprover).billing.invoiceReturn({ invoiceNumber: dr.invoiceNumber, reason: "Approver re-submits" });
    await callerFor(selfApprover).billing.invoiceSubmit({ invoiceNumber: dr.invoiceNumber });
    await expect(callerFor(selfApprover).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/submitted/) });
    const appr = await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber });
    expect(appr.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await outbox("invoice.approved", dr.invoiceNumber, t.orgRef)).toHaveLength(1);
    // the database refuses a self-approval even past the service
    await expect(pool.execute("UPDATE invoices SET approvedByUserId = submittedByUserId WHERE invoiceNumber = ? AND numberScope = ?", [dr.invoiceNumber, t.orgRef])).rejects.toThrow(/CONSTRAINT|check/i);
    const iss = await callerFor(t.office).billing.invoiceIssue({ invoiceNumber: dr.invoiceNumber });
    expect(iss.status).toBe("sent");
    expect(Math.round((iss.dueAt.getTime() - iss.issuedAt.getTime()) / 86_400_000)).toBe(45);
    expect(iss.document.registered).toBe(true);
    expect(await outbox("invoice.issued", dr.invoiceNumber, t.orgRef)).toHaveLength(1);
    const [[doc]] = await pool.query<mysql.RowDataPacket[]>("SELECT controlState, controlNumber FROM commercialDocuments WHERE documentRef = ?", [iss.document.documentRef]);
    expect(doc).toMatchObject({ controlState: "issued", controlNumber: dr.invoiceNumber });
    // An issued invoice is never rewritten.
    await expect(callerFor(t.office).billing.invoiceRecalculate({ invoiceNumber: dr.invoiceNumber })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/never rewritten/) });

    // Payment: idempotent on its key; a card number is refused.
    await expect(callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 100, method: "card", reference: "4111 1111 1111 1111" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const key = `EFT-${rnd()}-import-1`;
    const p1 = await callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 150_000, method: "eft", reference: "EFT 7781", payerName: "Bighorn AP", source: "import", idempotencyKey: key });
    const p1again = await callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 150_000, method: "eft", reference: "EFT 7781", source: "import", idempotencyKey: key });
    expect(p1again).toMatchObject({ paymentRef: p1.paymentRef, replayed: true });
    await expect(callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 999, method: "eft", idempotencyKey: key })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await outbox("payment.received", p1.paymentRef, t.orgRef)).toHaveLength(1);

    // Allocation: partial, then over the invoice refused (the rest stays unapplied), then the rest.
    await expect(callerFor(t.office).billing.paymentAllocate({ paymentRef: p1.paymentRef, invoiceNumber: dr.invoiceNumber, amountCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });   // the office records; the bookkeeper applies
    const a1 = await callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: p1.paymentRef, invoiceNumber: dr.invoiceNumber, amountCents: 50_000 });
    expect(a1).toMatchObject({ invoiceStatus: "partially_paid", invoiceOutstandingAfterCents: 51_750, paymentUnappliedAfterCents: 100_000, paymentStatus: "partially_applied" });
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("partially_paid");
    await expect(callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: p1.paymentRef, invoiceNumber: dr.invoiceNumber, amountCents: 60_000 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/only 51750 cents outstanding/) });
    const a2 = await callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: p1.paymentRef, invoiceNumber: dr.invoiceNumber, amountCents: 51_750 });
    expect(a2).toMatchObject({ invoiceStatus: "paid", invoiceOutstandingAfterCents: 0, paymentUnappliedAfterCents: 48_250 });
    expect(await outbox("invoice.paid", dr.invoiceNumber, t.orgRef)).toHaveLength(1);
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("paid");
    const un = await callerFor(t.office).billing.unappliedPayments({ accountRef: c.accountRef });
    expect(un).toEqual([expect.objectContaining({ paymentRef: p1.paymentRef, unappliedCents: 48_250 })]);

    // Reversal: a negative row naming the allocation, once.
    await expect(callerFor(t.office).billing.allocationReverse({ allocationRef: a2.allocationRef, reason: "Applied to the wrong invoice" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rv = await callerFor(t.bookkeeper).billing.allocationReverse({ allocationRef: a2.allocationRef, reason: "Applied to the wrong invoice" });
    expect(rv).toMatchObject({ invoiceStatus: "partially_paid", invoiceOutstandingAfterCents: 51_750, paymentUnappliedAfterCents: 100_000 });
    await expect(callerFor(t.bookkeeper).billing.allocationReverse({ allocationRef: a2.allocationRef, reason: "Again, by mistake" })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = (await pool.query<mysql.RowDataPacket[]>("SELECT pa.amountCents, pa.reversesAllocationId FROM paymentAllocations pa JOIN customerPayments p ON p.id = pa.customerPaymentId WHERE p.paymentRef = ? ORDER BY pa.id", [p1.paymentRef]))[0];
    expect(rows.map(r => r.amountCents)).toEqual([50_000, 51_750, -51_750]);
    await expect(pool.execute("INSERT INTO paymentAllocations (customerPaymentId, invoiceId, amountCents, allocatedByUserId, allocatedAt) SELECT customerPaymentId, invoiceId, -5, 1, NOW() FROM paymentAllocations WHERE allocationRef = ?", [a1.allocationRef])).rejects.toThrow(/CONSTRAINT|check/i);
    // A payment with money applied is not reversed until its allocations are.
    await expect(callerFor(t.controller).billing.paymentReverse({ paymentRef: p1.paymentRef, reason: "Cheque returned NSF" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // The receivable, aged by due date: not yet due is current.
    const rec = await callerFor(t.office).billing.receivables({ accountRef: c.accountRef });
    expect(rec.invoices.map(i => i.invoiceNumber)).toEqual([dr.invoiceNumber]);
    expect(rec.totals).toMatchObject({ current: 51_750, d1_30: 0, total: 51_750 });
    expect(rec.unappliedCents).toBe(100_000);
    const bal = await callerFor(t.office).billing.customerBalance({ accountRef: c.accountRef });
    expect(bal).toMatchObject({ outstandingCents: 51_750, overdueCents: 0, unappliedCents: 100_000, netOwingCents: -48_250 });
    expect(bal.recentPayments[0]).toMatchObject({ paymentRef: p1.paymentRef });

    // The accounting boundary carries the invoice, the payment and the allocations; marking is idempotent.
    const q = await callerFor(t.bookkeeper).billing.exportQueue({ status: "pending" });
    const mine = q.filter(r => [dr.invoiceNumber, p1.paymentRef, a1.allocationRef, a2.allocationRef].includes(r.entityRef) || r.entityRef.startsWith("ALR-"));
    expect(new Set(mine.map(r => r.entityType))).toEqual(new Set(["invoice", "payment", "allocation"]));
    const invExport = mine.find(r => r.entityType === "invoice")!;
    await expect(callerFor(t.bookkeeper).billing.exportMark({ syncRef: invExport.syncRef, outcome: "exported" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await callerFor(t.bookkeeper).billing.exportMark({ syncRef: invExport.syncRef, outcome: "failed", error: "QBO timeout" });
    await callerFor(t.bookkeeper).billing.exportMark({ syncRef: invExport.syncRef, outcome: "exported", externalId: "QBO-991", externalSystem: "quickbooks" });
    expect(await callerFor(t.bookkeeper).billing.exportMark({ syncRef: invExport.syncRef, outcome: "exported", externalId: "QBO-991" })).toMatchObject({ replayed: true });
    await expect(callerFor(t.bookkeeper).billing.exportMark({ syncRef: invExport.syncRef, outcome: "pending" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [[ex]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, externalId, attempts, lastError FROM accountingSyncRecords WHERE syncRef = ?", [invExport.syncRef]);
    expect(ex).toMatchObject({ status: "exported", externalId: "QBO-991", attempts: 2, lastError: null });

    // Every act is on the existing ledger.
    expect(await auditTypes(t.financialEntityId)).toEqual(expect.arrayContaining(["charges_prepared", "charge_prepared", "review_submitted", "review_returned", "review_approved", "invoice_created", "charge_invoiced", "invoice_submitted", "invoice_returned", "invoice_approved", "invoice_issued", "payment_recorded", "payment_allocated", "invoice_settled", "allocation_reversed", "export_failed", "export_exported"]));
  }, 120_000);
});

d("rates fail closed: never current, default, stale or guessed", () => {
  it("holds an unpriceable line with the engine's reasons; an override needs a second person; no snapshot, no pricing", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await billableJob(t, c, [{ serviceCode: "hydrovac_hour", hours: 3 }, { serviceCode: "steam_hour", hours: 2 }, { serviceCode: "hydrovac_hour", hours: 1, unit: "furlong" }]);
    const prep = await callerFor(t.office).billing.prepare({ jobId: j.jobId });
    expect(prep.created.map(x => [x.status, x.outcome])).toEqual([["ready", "priced"], ["held", "unknown_rate"], ["held", "unknown_rate"]]);
    expect(prep.created[0]!.amountCents).toBe(74_000);   // 3 h raised to the 4 h minimum, §4.1
    expect(prep.readiness.blockers.map(b => b.code)).toEqual(["charge_unpriced", "charge_unpriced"]);
    expect(prep.state).toBe("not_ready");
    const ws = await callerFor(t.office).billing.workspace({ jobId: j.jobId });
    expect(ws.charges[1]!.reasons.join(" ")).toMatch(/steam_hour|No approved|no definition|unknown/i);
    expect(ws.charges[2]!.reasons.join(" ")).toMatch(/furlong/);
    await expect(callerFor(t.office).billing.reviewSubmit({ jobId: j.jobId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/never guessed/) });

    // An override is requested with a reason and decided by someone else; the old and new values are on the ledger.
    const held = ws.charges[1]!.chargeRef;
    await callerFor(t.office).billing.chargeOverrideRequest({ chargeRef: held, amountCents: 40_000, quantityMillis: 2_000, reason: "Steam rate agreed by email 2026-09-09" });
    await expect(callerFor(t.office).billing.chargeOverrideDecide({ chargeRef: held, decision: "approve", note: "self approve" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const dual = await member(t.orgRef, ["office", "management"]);
    await callerFor(dual).billing.chargeOverrideRequest({ chargeRef: ws.charges[2]!.chargeRef, amountCents: 18_500, quantityMillis: 1_000, reason: "Unit typo on ticket — 1 hour" });
    await expect(callerFor(dual).billing.chargeOverrideDecide({ chargeRef: ws.charges[2]!.chargeRef, decision: "approve", note: "my own" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/requested an override/) });
    await callerFor(t.management).billing.chargeOverrideDecide({ chargeRef: held, decision: "approve", note: "Email on file" });
    await callerFor(t.management).billing.chargeOverrideDecide({ chargeRef: ws.charges[2]!.chargeRef, decision: "refuse", note: "Re-ticket it" });
    const [[ov]] = await pool.query<mysql.RowDataPacket[]>("SELECT changesJson, actorUserId, reason FROM commercialAuditEvents WHERE subjectRef = ? AND eventType = 'override_approved'", [held]);
    expect(JSON.parse(ov!.changesJson)).toMatchObject({ amountCents: { from: null, to: 40_000 } });
    expect(ov!.actorUserId).toBe(t.management);
    // The database refuses an override decided by its requester, whatever the service does.
    await expect(pool.execute("UPDATE billableCharges SET overrideDecidedByUserId = overrideRequestedByUserId WHERE chargeRef = ?", [held])).rejects.toThrow(/CONSTRAINT|check/i);

    // A manual charge is proposed, then approved by another person.
    const m = await callerFor(t.office).billing.chargeAddManual({ jobId: j.jobId, description: "Disposal pass-through, facility ticket 4471", quantityMillis: 1_000, unit: "each", amountCents: 12_500, reason: "Facility statement line not imported" });
    await expect(callerFor(t.office).billing.chargeManualDecide({ chargeRef: m.chargeRef, decision: "approve", note: "self-approval" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pool.execute("UPDATE billableCharges SET status = 'ready', approvedByUserId = createdByUserId WHERE chargeRef = ?", [m.chargeRef])).rejects.toThrow(/CONSTRAINT|check/i);
    await callerFor(t.management).billing.chargeManualDecide({ chargeRef: m.chargeRef, decision: "approve", note: "Statement attached" });

    // No frozen basis: billing never prices from live rates.
    const nosnap = await billableJob(t, c, undefined, { snapshot: false });
    await expect(callerFor(t.office).billing.prepare({ jobId: nosnap.jobId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/never prices from live rates/) });
    expect((await callerFor(t.office).billing.readiness({ jobId: nosnap.jobId })).blockers[0]).toMatchObject({ code: "commercial_snapshot_missing" });
  }, 120_000);
});

d("double billing is impossible: the service refuses, and the database refuses what races past it", () => {
  it("one live charge per evidence line, consumption never beyond the charge, a ticket line on one path only", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    const again = await callerFor(t.office).billing.prepare({ jobId: j.jobId }).catch(e => e);
    expect(again).toMatchObject({ code: "PRECONDITION_FAILED" });   // approved for invoicing: return the review first
    const [[ch]] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM billableCharges WHERE jobId = ? AND status = 'ready'", [j.jobId]);
    // A second live charge for the same evidence line: the generated live-source UNIQUE refuses it.
    await expect(pool.execute("INSERT INTO billableCharges (chargeRef, financialEntityId, jobId, customerAccountId, sourceKind, sourceId, description, quantityMillis, unit, currency, pricingOutcome, reasonsJson, status, createdByUserId, amountCents, billableQuantityMillis) VALUES (?, ?, ?, ?, 'field_ticket_line', ?, 'dup', 1000, 'hour', 'CAD', 'priced', '[]', 'ready', 1, 100, 1000)", [`CHG-DUP-${rnd()}`, t.financialEntityId, j.jobId, ch!.customerAccountId, ch!.sourceId])).rejects.toThrow(/Duplicate entry/);
    // Consumption beyond the charge: the CHECK refuses it.
    await expect(pool.execute("UPDATE billableCharges SET billedQuantityMillis = billableQuantityMillis + 1 WHERE id = ?", [ch!.id])).rejects.toThrow(/CONSTRAINT|check/i);
    await expect(pool.execute("UPDATE billableCharges SET billedAmountCents = amountCents + 1, billedQuantityMillis = 1 WHERE id = ?", [ch!.id])).rejects.toThrow(/CONSTRAINT|check/i);
    // The field-ticket path will not draft a line that carries a live billing charge — before or after it is invoiced.
    const before = await callerFor(t.office).invoicing.draftFromTicket({ ticketNumber: j.ticketNumber });
    expect(before.drafted).toBe(false);
    expect(before.excluded[0]!.reason).toMatch(/Already on invoice billing charge CHG-/);
    const dr = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] });
    const after = await callerFor(t.office).invoicing.draftFromTicket({ ticketNumber: j.ticketNumber });
    expect(after.drafted).toBe(false);
    expect(after.excluded[0]!.reason).toBe(`Already on invoice ${dr.invoiceNumber}`);
    // A charge appears once per invoice.
    const [[inv]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM invoices WHERE invoiceNumber = ? AND numberScope = ?", [dr.invoiceNumber, t.orgRef]);
    await expect(pool.execute("INSERT INTO invoiceLines (invoiceId, lineNo, description, quantityMillis, billableQuantityMillis, unit, amountCents, basis, billableChargeId, jobId, taxCode, taxRateBps, taxCents) VALUES (?, 9, 'dup', 1, 1, 'hour', 1, 'x', ?, ?, 'ZERO_RATED', 0, 0)", [inv!.id, ch!.id, j.jobId])).rejects.toThrow(/Duplicate entry/);
    // Nothing is left to bill on this job.
    await expect(callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 90_000);
});

d("partial billing and multi-job invoices", () => {
  it("bills a slice, then the rest under a supplemental review; one invoice for two jobs; the slices sum to the charge", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j1 = await approvedJob(t, c, [{ serviceCode: "hydrovac_hour", hours: 5.5 }]);
    const j2 = await approvedJob(t, c, [{ serviceCode: "hydrovac_hour", hours: 4 }]);
    const ws1 = await callerFor(t.office).billing.workspace({ jobId: j1.jobId });
    const ch1 = ws1.charges[0]!;
    // One invoice: 2 h of job 1's 5.5 h, and all of job 2.
    const dr1 = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j1.jobId, j2.jobId], slices: [{ chargeRef: ch1.chargeRef, quantityMillis: 2_000 }, { chargeRef: (await callerFor(t.office).billing.workspace({ jobId: j2.jobId })).charges[0]!.chargeRef, quantityMillis: 4_000 }] });
    expect(dr1).toMatchObject({ subtotalCents: 37_000 + 74_000, lines: 2, jobs: [j1.jobCode, j2.jobCode] });
    const g1 = await callerFor(t.office).billing.invoiceGet({ invoiceNumber: dr1.invoiceNumber });
    expect(g1.jobs.map(x => x.jobCode).sort()).toEqual([j1.jobCode, j2.jobCode].sort());
    expect(g1.lines[0]!.description).toMatch(/part: 2\.000 of 5\.500 hour/);
    // More than remains is refused; the rest needs a supplemental review (job 1 is invoiced).
    await expect(callerFor(t.office).billing.invoiceDraft({ jobIds: [j1.jobId] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/review is approved/) });
    await callerFor(t.office).billing.reviewSubmit({ jobId: j1.jobId, note: "remaining 3.5 h" });
    await callerFor(t.management).billing.reviewDecide({ jobId: j1.jobId, decision: "approve", note: "remaining hours" });
    await expect(callerFor(t.office).billing.invoiceDraft({ jobIds: [j1.jobId], slices: [{ chargeRef: ch1.chargeRef, quantityMillis: 3_501 }] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/only 3\.500 remains/) });
    const dr2 = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j1.jobId] });
    expect(dr2.subtotalCents).toBe(101_750 - 37_000);
    expect(dr2.invoiceNumber).not.toBe(dr1.invoiceNumber);
    const [[sum]] = await pool.query<mysql.RowDataPacket[]>("SELECT SUM(amountCents) AS s, SUM(billableQuantityMillis) AS q FROM invoiceLines WHERE billableChargeId = ?", [ch1.id]);
    expect(Number(sum!.s)).toBe(101_750); expect(Number(sum!.q)).toBe(5_500);
    // Different customers are never on one invoice.
    const other = await customer(t);
    const j3 = await approvedJob(t, other);
    const j4 = await approvedJob(t, c);
    await expect(callerFor(t.office).billing.invoiceDraft({ jobIds: [j3.jobId, j4.jobId] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/different customers/) });
  }, 120_000);
});

d("concurrency: races resolve to exactly one winner", () => {
  it("two drafts of one job, two numbers at once, two issues of one invoice, two allocations of one payment, two credits on one invoice", async () => {
    const t = await tenant();
    const c = await customer(t);
    // Two drafts of the same approved job: one invoice.
    const j = await approvedJob(t, c);
    const both = await Promise.allSettled([callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] }), callerFor(t.bookkeeper).billing.invoiceDraft({ jobIds: [j.jobId] })]);
    expect(both.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const [[n1]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM invoiceLines il JOIN billableCharges c ON c.id = il.billableChargeId WHERE c.jobId = ?", [j.jobId]);
    expect(Number(n1!.n)).toBe(1);
    // Five drafts of five jobs at once: five distinct numbers from the organization's series, gap-free on the ledger.
    const jobs = [];
    for (let i = 0; i < 5; i++) jobs.push(await approvedJob(t, c));
    const drafts = await Promise.all(jobs.map(x => callerFor(t.office).billing.invoiceDraft({ jobIds: [x.jobId] })));
    const nums = drafts.map(x => x.invoiceNumber).concat((both.find(x => x.status === "fulfilled") as PromiseFulfilledResult<{ invoiceNumber: string }>).value.invoiceNumber).sort();
    expect(new Set(nums).size).toBe(6);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6].map(n => `INV-${year}-${String(n).padStart(6, "0")}`));
    const [[ledger]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n, COUNT(DISTINCT sequence) AS d FROM numberAllocations WHERE scopeKey = ? AND sequenceType = 'INV'", [t.orgRef]);
    expect(Number(ledger!.n)).toBe(6); expect(Number(ledger!.d)).toBe(6);
    // Two issues of the same approved invoice: one.
    const target = drafts[0]!.invoiceNumber;
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: target });
    await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: target });
    const issues = await Promise.allSettled([callerFor(t.office).billing.invoiceIssue({ invoiceNumber: target }), callerFor(t.bookkeeper).billing.invoiceIssue({ invoiceNumber: target })]);
    expect(issues.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(await outbox("invoice.issued", target, t.orgRef)).toHaveLength(1);
    // Two allocations racing for the same unapplied $600 of a $1,000 payment against two invoices: one.
    const second = drafts[1]!.invoiceNumber;
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: second });
    await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: second });
    await callerFor(t.office).billing.invoiceIssue({ invoiceNumber: second });
    const pay = await callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 100_000, method: "cheque", reference: "CHQ 1001" });
    await callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: target, amountCents: 40_000 });
    const race = await Promise.allSettled([
      callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: target, amountCents: 60_000 }),
      callerFor(t.controller).billing.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: second, amountCents: 60_000 }),
    ]);
    expect(race.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const [[net]] = await pool.query<mysql.RowDataPacket[]>("SELECT SUM(pa.amountCents) AS s FROM paymentAllocations pa JOIN customerPayments p ON p.id = pa.customerPaymentId WHERE p.paymentRef = ?", [pay.paymentRef]);
    expect(Number(net!.s)).toBe(100_000);
    // Two credits on one invoice, each for 60% of what is outstanding: one is approved, the other refused.
    const third = drafts[2]!.invoiceNumber;
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: third });
    await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: third });
    await callerFor(t.office).billing.invoiceIssue({ invoiceNumber: third });
    const cr1 = await callerFor(t.office).billing.creditCreate({ invoiceNumber: third, amountCents: 60_000, reason: "Standby not owed — 60%" });
    await expect(callerFor(t.office).billing.creditCreate({ invoiceNumber: third, amountCents: 60_000, reason: "Second credit beyond the balance" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const cr2 = await callerFor(t.office).ar.creditRequest({ invoiceNumber: third, amountCents: 60_000, reason: "Legacy path request, beyond the balance" });   // the AR path does not pre-check
    const decided = await Promise.allSettled([
      callerFor(t.controller).billing.creditDecide({ creditRef: cr1.creditRef, decision: "approved", note: "Agreed with customer" }),
      callerFor(t.management).ar.creditDecide({ creditRef: cr2.creditRef, decision: "approved" }),
    ]);
    expect(decided.filter(x => x.status === "rejected")).toHaveLength(1);
    const [[cred]] = await pool.query<mysql.RowDataPacket[]>("SELECT SUM(amountCents) AS s FROM customerCredits c JOIN invoices i ON i.id = c.invoiceId WHERE i.invoiceNumber = ? AND i.numberScope = ? AND c.status = 'approved'", [third, t.orgRef]);
    expect(Number(cred!.s)).toBe(60_000);
    expect(cr1.creditRef).toMatch(new RegExp(`^CR-${year}-\\d{6}$`));
  }, 180_000);
});

d("strict organization scope: another organization is refused everything", () => {
  it("cannot read or touch a job's billing, an invoice, a payment, an allocation, a credit, a dispute, a balance or an export; both may hold INV-…-000001", async () => {
    const a = await tenant(), b = await tenant();
    const ca = await customer(a), cb = await customer(b);
    const ja = await approvedJob(a, ca), jb = await approvedJob(b, cb);
    const ia = await issuedInvoice(a, [ja.jobId]), ib = await issuedInvoice(b, [jb.jobId]);
    expect(ia.invoiceNumber).toBe(`INV-${year}-000001`); expect(ib.invoiceNumber).toBe(ia.invoiceNumber);   // per-organization series
    const pa = await callerFor(a.office).billing.paymentRecord({ financialEntityId: a.financialEntityId, accountRef: ca.accountRef, receivedAt: new Date(), amountCents: 10_000, method: "eft" });
    const al = await callerFor(a.bookkeeper).billing.paymentAllocate({ paymentRef: pa.paymentRef, invoiceNumber: ia.invoiceNumber, amountCents: 10_000 });
    const cr = await callerFor(a.office).billing.creditCreate({ invoiceNumber: ia.invoiceNumber, amountCents: 1_000, reason: "Fuel surcharge waived" });
    const dsp = await callerFor(a.office).billing.disputeOpen({ invoiceNumber: ia.invoiceNumber, lineNo: 1, amountCents: 5_000, reason: "Hours contested" });
    const syncRef = (await callerFor(a.bookkeeper).billing.exportQueue({})).find(r => r.entityRef === pa.paymentRef)!.syncRef;

    // B's own number resolves to B's invoice; A's records are not found.
    expect((await callerFor(b.office).billing.invoiceGet({ invoiceNumber: ia.invoiceNumber })).invoice.customerAccountId).toBe(cb.accountId);
    const NF = { code: "NOT_FOUND" };
    await expect(callerFor(b.office).billing.workspace({ jobId: ja.jobId })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.readiness({ jobId: ja.jobId })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.prepare({ jobId: ja.jobId })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.invoiceDraft({ jobIds: [ja.jobId] })).rejects.toMatchObject(NF);
    await expect(callerFor(b.controller).billing.holdSet({ jobId: ja.jobId, active: true, reason: "not mine" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.paymentRecord({ financialEntityId: a.financialEntityId, accountRef: ca.accountRef, receivedAt: new Date(), amountCents: 1, method: "eft" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.paymentRecord({ financialEntityId: b.financialEntityId, accountRef: ca.accountRef, receivedAt: new Date(), amountCents: 1, method: "eft" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.bookkeeper).billing.paymentAllocate({ paymentRef: pa.paymentRef, invoiceNumber: ib.invoiceNumber, amountCents: 1 })).rejects.toMatchObject(NF);
    await expect(callerFor(b.bookkeeper).billing.allocationReverse({ allocationRef: al.allocationRef, reason: "not mine to reverse" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.controller).billing.paymentReverse({ paymentRef: pa.paymentRef, reason: "not mine to reverse" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.controller).billing.creditDecide({ creditRef: cr.creditRef, decision: "approved", note: "not mine" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.controller).billing.disputeResolve({ caseNumber: dsp.caseNumber, outcome: "upheld", narrative: "not my dispute at all" })).rejects.toMatchObject(NF);
    await expect(callerFor(b.office).billing.customerBalance({ accountRef: ca.accountRef })).rejects.toMatchObject(NF);
    await expect(callerFor(b.bookkeeper).billing.exportMark({ syncRef, outcome: "exported", externalId: "X" })).rejects.toMatchObject(NF);
    // Lists never carry another organization's rows.
    const rb = await callerFor(b.office).billing.receivables({});
    expect(rb.invoices.every(i => i.receivable && i.invoiceNumber === ib.invoiceNumber)).toBe(true);
    expect(rb.unapplied.some(u => u.paymentRef === pa.paymentRef)).toBe(false);
    expect((await callerFor(b.bookkeeper).billing.exportQueue({})).some(r => r.syncRef === syncRef)).toBe(false);
    const dash = await callerFor(b.office).billing.dashboard({});
    expect(JSON.stringify(dash)).not.toContain(ja.jobCode);
    // The pre-existing number lookups are scoped too: under the shared number each organization's AR path reaches its own invoice.
    await callerFor(b.office).ar.collectionEvent({ invoiceNumber: ib.invoiceNumber, eventType: "call", note: "B called B's customer" });
    await callerFor(a.office).ar.collectionEvent({ invoiceNumber: ia.invoiceNumber, eventType: "call", note: "A called A's customer" });
    const notes = (await pool.query<mysql.RowDataPacket[]>("SELECT i.customerAccountId, ce.note FROM collectionEvents ce JOIN invoices i ON i.id = ce.invoiceId WHERE i.invoiceNumber = ? AND i.numberScope IN (?, ?) ORDER BY ce.id", [ia.invoiceNumber, a.orgRef, b.orgRef]))[0];
    expect(notes.map(n => [n.customerAccountId, n.note])).toEqual([[cb.accountId, "B called B's customer"], [ca.accountId, "A called A's customer"]]);
  }, 180_000);
});

d("an ended membership is refused every financial record, even as its only organization", () => {
  it("a former member sees no invoice, balance, payment or rate-backed charge, and cannot create a credit or change anything", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    const inv = await issuedInvoice(t, [j.jobId]);
    const pay = await callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 1_000, method: "eft" });
    const alloc = await callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: pay.paymentRef, invoiceNumber: inv.invoiceNumber, amountCents: 1_000 });
    const [[ships]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM organizationMemberships WHERE userId IN (?, ?)", [t.controller, t.bookkeeper]);
    expect(Number(ships!.n)).toBe(2);   // one organization each: nothing to fall back to but the single tenant
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = NOW() WHERE userId IN (?, ?, ?)", [t.controller, t.bookkeeper, t.office]);
    const NO = { code: "FORBIDDEN" };
    for (const u of [t.controller, t.bookkeeper, t.office]) {
      await expect(callerFor(u).billing.invoiceGet({ invoiceNumber: inv.invoiceNumber })).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.invoicesList({})).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.receivables({})).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.customerBalance({ accountRef: c.accountRef })).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.workspace({ jobId: j.jobId })).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.dashboard({})).rejects.toMatchObject(NO);
      await expect(callerFor(u).billing.unappliedPayments({})).rejects.toMatchObject(NO);
    }
    await expect(callerFor(t.office).billing.creditCreate({ invoiceNumber: inv.invoiceNumber, amountCents: 100, reason: "Former member credit" })).rejects.toMatchObject(NO);
    await expect(callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 100, method: "eft" })).rejects.toMatchObject(NO);
    await expect(callerFor(t.bookkeeper).billing.allocationReverse({ allocationRef: alloc.allocationRef, reason: "Former member reversal" })).rejects.toMatchObject(NO);
    await expect(callerFor(t.controller).billing.invoiceVoid({ invoiceNumber: inv.invoiceNumber, reason: "Former member void" })).rejects.toMatchObject(NO);
    await expect(callerFor(t.bookkeeper).billing.exportQueue({})).rejects.toMatchObject(NO);
    await expect(callerFor(t.office).billing.prepare({ jobId: j.jobId })).rejects.toMatchObject(NO);
    // Nothing moved.
    const [[r]] = await pool.query<mysql.RowDataPacket[]>("SELECT status FROM invoices WHERE invoiceNumber = ? AND numberScope = ?", [inv.invoiceNumber, t.orgRef]);
    expect(r!.status).toBe("partially_paid");
  }, 120_000);
});

d("roles: drivers see no AR; each act needs its own permission", () => {
  it("refuses the driver and the dispatcher every billing read; the auditor reads but changes nothing", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    const inv = await issuedInvoice(t, [j.jobId]);
    const F = { code: "FORBIDDEN" };
    for (const u of [t.driver, t.dispatcher]) {
      await expect(callerFor(u).billing.dashboard({})).rejects.toMatchObject(F);
      await expect(callerFor(u).billing.workspace({ jobId: j.jobId })).rejects.toMatchObject(F);
      await expect(callerFor(u).billing.invoiceGet({ invoiceNumber: inv.invoiceNumber })).rejects.toMatchObject(F);
      await expect(callerFor(u).billing.receivables({})).rejects.toMatchObject(F);
      await expect(callerFor(u).billing.customerBalance({ accountRef: c.accountRef })).rejects.toMatchObject(F);
      await expect(callerFor(u).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 1, method: "cash" })).rejects.toMatchObject(F);
    }
    // A driver who is also office staff is still denied the billing workspace (deny beats grant).
    const ownerOperator = await member(t.orgRef, ["driver", "office"]);
    await expect(callerFor(ownerOperator).billing.workspace({ jobId: j.jobId })).rejects.toMatchObject(F);
    // The auditor reads; it does not prepare, approve, issue or apply.
    expect((await callerFor(t.auditor).billing.workspace({ jobId: j.jobId })).job.id).toBe(j.jobId);
    expect((await callerFor(t.auditor).billing.invoiceGet({ invoiceNumber: inv.invoiceNumber })).invoice.status).toBe("sent");
    await expect(callerFor(t.auditor).billing.prepare({ jobId: j.jobId })).rejects.toMatchObject(F);
    await expect(callerFor(t.auditor).billing.invoiceApprove({ invoiceNumber: inv.invoiceNumber })).rejects.toMatchObject(F);
    await expect(callerFor(t.auditor).billing.exportMark({ syncRef: "SYN-X", outcome: "exported", externalId: "x" })).rejects.toMatchObject(F);
    // The office drafts but does not approve; management does not mark exports or reverse allocations.
    await expect(callerFor(t.office).billing.invoiceApprove({ invoiceNumber: inv.invoiceNumber })).rejects.toMatchObject(F);
    await expect(callerFor(t.office).billing.holdSet({ jobId: j.jobId, active: true, reason: "office cannot hold" })).rejects.toMatchObject(F);
    await expect(callerFor(t.management).billing.exportMark({ syncRef: "SYN-X", outcome: "exported", externalId: "x" })).rejects.toMatchObject(F);
    await expect(callerFor(t.management).billing.allocationReverse({ allocationRef: "ALC-X", reason: "not management's act" })).rejects.toMatchObject(F);
    await expect(callerFor(t.bookkeeper).billing.paymentReverse({ paymentRef: "PAY-X", reason: "the controller's act only" })).rejects.toMatchObject(F);
  }, 120_000);
});

d("tax is explicit and verified; a void releases, never deletes; a hold stops invoicing only", () => {
  it("drafts a taxable invoice UNDETERMINED, refuses its approval, recalculates once the rate is verified", async () => {
    const t = await tenant();
    const c = await customer(t, { taxStatus: "taxable" });
    const j = await approvedJob(t, c);
    const juris = `CA-T${rnd()}`.slice(0, 12);
    const dr = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId], jurisdiction: juris });
    expect(dr).toMatchObject({ taxCode: "UNDETERMINED", taxCents: 0, taxDetermined: false });
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: dr.invoiceNumber });
    await expect(callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/tax is undetermined/) });
    await callerFor(t.controller).billing.invoiceReturn({ invoiceNumber: dr.invoiceNumber, reason: "Verify the GST rate first" });
    await pool.execute("INSERT INTO taxRules (ruleKey, version, jurisdiction, ruleType, parametersJson, effectiveFrom, status) VALUES (?, 1, ?, 'gst_hst_rate', ?, '2026-01-01 00:00:00', 'verified')", [`gst.rate.test.${rnd()}`, juris, JSON.stringify({ ratePercent: 5, kind: "gst" })]);
    const rc = await callerFor(t.office).billing.invoiceRecalculate({ invoiceNumber: dr.invoiceNumber });
    expect(rc).toMatchObject({ taxCode: `GST-${juris}`, subtotalCents: 101_750, taxCents: 5_088, totalCents: 106_838, taxDetermined: true });
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: dr.invoiceNumber });
    await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: dr.invoiceNumber });
    const g = await callerFor(t.office).billing.invoiceGet({ invoiceNumber: dr.invoiceNumber });
    expect(g.invoice).toMatchObject({ taxCode: `GST-${juris}`, taxRateBps: 500, taxJurisdiction: juris, totalCents: 106_838 });
    expect(g.lines[0]).toMatchObject({ taxRateBps: 500, taxCents: 5_088 });
    // The database refuses a billing invoice whose totals do not add up.
    await expect(pool.execute("UPDATE invoices SET totalCents = totalCents + 1 WHERE invoiceNumber = ? AND numberScope = ?", [dr.invoiceNumber, t.orgRef])).rejects.toThrow(/CONSTRAINT|check/i);
  }, 120_000);

  it("voids a draft: charges released, lines kept and marked, number voided on the ledger and never reused; a paid invoice is credited, not voided", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    const dr = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] });
    await expect(callerFor(t.office).billing.invoiceVoid({ invoiceNumber: dr.invoiceNumber, reason: "Wrong job grouping" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const v = await callerFor(t.management).billing.invoiceVoid({ invoiceNumber: dr.invoiceNumber, reason: "Wrong job grouping" });
    expect(v).toMatchObject({ status: "void", releasedLines: 1 });
    const [[ch]] = await pool.query<mysql.RowDataPacket[]>("SELECT billedQuantityMillis, billedAmountCents FROM billableCharges WHERE jobId = ? AND status = 'ready'", [j.jobId]);
    expect(ch).toMatchObject({ billedQuantityMillis: 0, billedAmountCents: 0 });
    const [[line]] = await pool.query<mysql.RowDataPacket[]>("SELECT il.releasedAt FROM invoiceLines il JOIN invoices i ON i.id = il.invoiceId WHERE i.invoiceNumber = ? AND i.numberScope = ?", [dr.invoiceNumber, t.orgRef]);
    expect(line!.releasedAt).toBeTruthy();
    const [[led]] = await pool.query<mysql.RowDataPacket[]>("SELECT state, reasonText FROM numberAllocations WHERE scopeKey = ? AND formattedNumber = ?", [t.orgRef, dr.invoiceNumber]);
    expect(led).toMatchObject({ state: "voided" }); expect(led!.reasonText).toMatch(/Wrong job grouping/);
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("approved_for_invoicing");
    const dr2 = await callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] });
    expect(dr2.invoiceNumber).not.toBe(dr.invoiceNumber);
    expect(await auditTypes(t.financialEntityId)).toEqual(expect.arrayContaining(["invoice_voided", "charge_released"]));
    // Paid → refused.
    await callerFor(t.office).billing.invoiceSubmit({ invoiceNumber: dr2.invoiceNumber });
    await callerFor(t.controller).billing.invoiceApprove({ invoiceNumber: dr2.invoiceNumber });
    await callerFor(t.office).billing.invoiceIssue({ invoiceNumber: dr2.invoiceNumber });
    const p = await callerFor(t.office).billing.paymentRecord({ financialEntityId: t.financialEntityId, accountRef: c.accountRef, receivedAt: new Date(), amountCents: 101_750, method: "wire" });
    await callerFor(t.bookkeeper).billing.paymentAllocate({ paymentRef: p.paymentRef, invoiceNumber: dr2.invoiceNumber, amountCents: 101_750 });
    await expect(callerFor(t.management).billing.invoiceVoid({ invoiceNumber: dr2.invoiceNumber, reason: "Too late to void" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  }, 120_000);

  it("a billing hold on the job blocks its invoicing, is audited, and lifts", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    await callerFor(t.controller).billing.holdSet({ jobId: j.jobId, active: true, reason: "Customer disputes the rate card" });
    const r = await callerFor(t.office).billing.readiness({ jobId: j.jobId });
    expect(r.blockers.map(b => b.code)).toContain("billing_hold");
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("not_ready");   // the approval does not survive a hold
    await expect(callerFor(t.office).billing.invoiceDraft({ jobIds: [j.jobId] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await callerFor(t.controller).billing.holdSet({ jobId: j.jobId, active: false, reason: "Rate card confirmed" });
    expect((await callerFor(t.office).billing.readiness({ jobId: j.jobId })).ready).toBe(true);
    expect(await auditTypes(t.financialEntityId)).toEqual(expect.arrayContaining(["hold_placed", "hold_released", "review_invalidated"]));
  }, 90_000);
});

d("disputes, credit notes and adjustments: corrections are records, never edits", () => {
  it("disputes one line, refuses a second open dispute on it, resolves partially into a credit note a second person approves; adjusts with approval; flags overdue once", async () => {
    const t = await tenant();
    const c = await customer(t);
    const j = await approvedJob(t, c);
    const inv = await issuedInvoice(t, [j.jobId]);
    const dsp = await callerFor(t.office).billing.disputeOpen({ invoiceNumber: inv.invoiceNumber, lineNo: 1, amountCents: 18_500, reason: "One hour of standby contested", documentRefs: ["EV-ticket-photo"] });
    expect(dsp.status).toBe("raised");
    expect((await callerFor(t.office).billing.invoiceGet({ invoiceNumber: inv.invoiceNumber })).invoice.status).toBe("disputed");
    expect((await callerFor(t.office).billing.workspace({ jobId: j.jobId })).workspace!.state).toBe("disputed");
    await expect(callerFor(t.office).billing.disputeOpen({ invoiceNumber: inv.invoiceNumber, lineNo: 1, reason: "Same line again" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(callerFor(t.office).billing.disputeOpen({ invoiceNumber: inv.invoiceNumber, lineNo: 1, amountCents: 999_999, reason: "Too much" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await outbox("dispute.opened", dsp.caseNumber, t.orgRef)).toHaveLength(1);
    const rec0 = await callerFor(t.office).billing.receivables({});
    expect(rec0.totals.disputed).toBe(101_750);
    const res = await callerFor(t.management).billing.disputeResolve({ caseNumber: dsp.caseNumber, outcome: "partial", creditAmountCents: 9_250, narrative: "Half an hour of standby credited" });
    expect(res).toMatchObject({ status: "resolved_partial", creditCents: 9_250, invoiceStatus: "sent" });
    expect(res.creditRef).toMatch(/^CR-/);
    expect(await outbox("dispute.resolved", dsp.caseNumber, t.orgRef)).toHaveLength(1);
    await expect(callerFor(t.management).billing.creditDecide({ creditRef: res.creditRef!, decision: "approved", note: "self-approval" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await callerFor(t.controller).billing.creditDecide({ creditRef: res.creditRef!, decision: "approved", note: "Agreed with the customer" });
    expect(ok).toMatchObject({ status: "approved", invoiceOutstandingAfterCents: 101_750 - 9_250 });
    expect(await outbox("credit.approved", res.creditRef!, t.orgRef)).toHaveLength(1);
    // An adjustment: a late fee, requested by one, approved by another; the invoice's own total never changes.
    const adj = await callerFor(t.bookkeeper).billing.adjustmentRequest({ invoiceNumber: inv.invoiceNumber, amountCents: 2_500, reasonCode: "late_fee", reason: "Late fee per terms §9" });
    await expect(callerFor(t.bookkeeper).billing.adjustmentDecide({ adjustmentRef: adj.adjustmentRef, decision: "approved", note: "self-approval" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const adOk = await callerFor(t.controller).billing.adjustmentDecide({ adjustmentRef: adj.adjustmentRef, decision: "approved", note: "Per terms" });
    expect(adOk.invoiceOutstandingAfterCents).toBe(101_750 - 9_250 + 2_500);
    const g = await callerFor(t.office).billing.invoiceGet({ invoiceNumber: inv.invoiceNumber });
    expect(g.invoice.totalCents).toBe(101_750);
    expect(g.receivable).toMatchObject({ originalCents: 101_750, creditedCents: 9_250, adjustedCents: 2_500, outstandingCents: 95_000 });
    // Overdue: emitted once, aged 1–30.
    await pool.execute("UPDATE invoices SET dueAt = DATE_SUB(NOW(), INTERVAL 12 DAY) WHERE invoiceNumber = ? AND numberScope = ?", [inv.invoiceNumber, t.orgRef]);
    const s1 = await callerFor(t.office).billing.overdueSweep({});
    expect(s1.notified).toEqual([inv.invoiceNumber]);
    expect((await callerFor(t.office).billing.overdueSweep({})).notified).toEqual([]);
    expect(await outbox("invoice.overdue", inv.invoiceNumber, t.orgRef)).toHaveLength(1);
    const rec = await callerFor(t.office).billing.receivables({});
    expect(rec.totals).toMatchObject({ d1_30: 95_000, current: 0 });
    expect(rec.invoices[0]!.receivable).toMatchObject({ arStatus: "overdue", daysOverdue: 12 });
    expect(await auditTypes(t.financialEntityId)).toEqual(expect.arrayContaining(["dispute_opened", "invoice_disputed", "dispute_resolved", "credit_created", "credit_approved", "adjustment_requested", "adjustment_approved", "invoice_overdue"]));
  }, 120_000);
});
