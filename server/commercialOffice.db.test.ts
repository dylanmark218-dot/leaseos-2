/**
 * P7.1 — Commercial Office configuration (0133), through the router.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

// P7.8 packages write a cover sheet through the storage layer; kept in memory here, as auditPackage.test does.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 240_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

d("the owner's decisions are the seeded defaults", () => {
  it("seeds five role types, five numbering formats, QuickBooks Online, an 18-row ladder, seven profitability dimensions and ten canonical document types — and no load categories", async () => {
    const book = await org(); const office = await member(book, ["office"]);
    const c = callerFor(office);
    expect((await c.commercialOffice.roleTypes.list()).filter(t => t.builtIn).map(t => t.roleKey).sort()).toEqual(["client", "disposal_facility", "subcontractor", "supplier", "vendor"]);
    expect((await c.commercialOffice.numbering.list()).map(n => n.sequenceType).sort()).toEqual(["CLI", "INV", "MF", "PO", "VEN"]);
    expect(await c.commercialOffice.settings.get()).toMatchObject({ accountingTarget: "quickbooks_online", layer: "default" });
    const ladder = await c.commercialOffice.approvals.policies();
    expect(ladder.filter(p => p.bookOrgRef === null).length).toBe(18);
    expect(ladder.every(p => p.source.startsWith("owner_decision_2026-09-17"))).toBe(true);
    expect((await c.commercialOffice.categories.list({ kind: "profitability_dimension" })).length).toBe(7);
    expect((await c.commercialOffice.categories.list({ kind: "load_category" })).length).toBe(0);
    expect((await c.commercialOffice.categories.list({ kind: "document_type" })).filter(t => t.builtIn).length).toBe(10);   // 0144: the canonical document kinds LeaseOS itself produces are built in; a business adds its own
  }, 20_000);
});

d("a business can answer differently", () => {
  it("adds its own role type and category, invisible to another business", async () => {
    const a = await org(), b = await org();
    const mgrA = await member(a, ["management"]), officeB = await member(b, ["office"]);
    await callerFor(mgrA).commercialOffice.roleTypes.create({ roleKey: "landowner", label: "Landowner" });
    await callerFor(mgrA).commercialOffice.categories.create({ kind: "load_category", categoryKey: "produced_water", label: "Produced water" });
    expect((await callerFor(mgrA).commercialOffice.roleTypes.list()).some(t => t.roleKey === "landowner")).toBe(true);
    expect((await callerFor(officeB).commercialOffice.roleTypes.list()).some(t => t.roleKey === "landowner")).toBe(false);
    expect((await callerFor(officeB).commercialOffice.categories.list({ kind: "load_category" })).length).toBe(0);
    // Only the policy permission may define types — office cannot.
    await expect(callerFor(officeB).commercialOffice.roleTypes.create({ roleKey: "x_role", label: "X" })).rejects.toThrow();
  }, 20_000);

  it("numbers a client CLI-000001 by default, and with the business's own prefix once it sets one; a custom role with no numbering policy mints nothing and says so", async () => {
    const a = await org(), counterparty = await org(), counterparty2 = await org();
    const office = await member(a, ["office"]), mgr = await member(a, ["management"]);
    const first = await callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "client" });
    expect(first.commercialNumber).toMatch(/^CLI-\d{6}$/);
    // The same organization can also be a vendor — decision 1.
    const asVendor = await callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "vendor" });
    expect(asVendor.commercialNumber).toMatch(/^VEN-\d{6}$/);
    await expect(callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "client" })).rejects.toThrow(/already holds/);
    // Business-defined numbering: CUST + two-digit year + 4 digits, no separator.
    await callerFor(mgr).commercialOffice.numbering.set({ sequenceType: "CLI", prefix: "CUST", separator: "", yearDigits: 2, sequenceDigits: 4, resetPeriod: "yearly" });
    const second = await callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty2, roleKey: "client" });
    expect(second.commercialNumber).toMatch(/^CUST\d{2}0001$/);
    await callerFor(mgr).commercialOffice.roleTypes.create({ roleKey: "landowner", label: "Landowner" });
    const unnumbered = await callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty2, roleKey: "landowner" });
    expect(unnumbered).toMatchObject({ numbered: false, reason: expect.stringContaining("no numbering policy") });
    await expect(callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty2, roleKey: "not_a_role" })).rejects.toThrow(/not an active role type/);
  }, 30_000);

  it("answers the ladder from the defaults, then from the business's own tiers — and UNKNOWN where those stop short", async () => {
    const a = await org();
    const office = await member(a, ["office"]), mgr = await member(a, ["management"]);
    const dflt = await callerFor(office).commercialOffice.approvals.requirement({ category: "purchase_order", amountCents: 400_000, preparedByUserId: null });
    expect(dflt.requirement).toMatchObject({ state: "KNOWN", approverRole: "controller", layer: "default" });
    expect(dflt.couldApprove).toMatchObject({ allowed: false, reason: "BLOCKED — requires role controller" });   // office prepares; the controller approves
    const controller = await member(a, ["controller"]);
    expect((await callerFor(controller).commercialOffice.approvals.requirement({ category: "purchase_order", amountCents: 400_000, preparedByUserId: null })).couldApprove.allowed).toBe(true);
    // The preparer may not approve their own purchase order.
    const own = await callerFor(office).commercialOffice.approvals.requirement({ category: "purchase_order", amountCents: 400_000, preparedByUserId: office });
    expect(own.couldApprove).toMatchObject({ allowed: false, reason: expect.stringContaining("separation of duties") });
    // The business writes one tier to $1,000; above it the defaults do not fill the gap.
    await callerFor(mgr).commercialOffice.approvals.policySet({ category: "purchase_order", maxAmountCents: 100_000, approverRole: "office" });
    const under = await callerFor(office).commercialOffice.approvals.requirement({ category: "purchase_order", amountCents: 100_000, preparedByUserId: null });
    expect(under.requirement).toMatchObject({ state: "KNOWN", layer: "business" });
    const over = await callerFor(office).commercialOffice.approvals.requirement({ category: "purchase_order", amountCents: 100_001, preparedByUserId: null });
    expect(over.requirement).toMatchObject({ state: "UNKNOWN" });
    expect(over.couldApprove).toMatchObject({ allowed: false, reason: expect.stringContaining("REVIEW") });
    // Other categories still answer from the defaults.
    const bill = await callerFor(office).commercialOffice.approvals.requirement({ category: "vendor_bill", amountCents: 9_000_000, preparedByUserId: null });
    expect(bill.requirement).toMatchObject({ state: "KNOWN", approverRole: "management", secondPersonRequired: true, layer: "default" });
    // Settings override.
    await callerFor(mgr).commercialOffice.settings.set({ accountingTarget: "custom", accountingTargetLabel: "Sage 50 desktop export" });
    expect(await callerFor(office).commercialOffice.settings.get()).toMatchObject({ accountingTarget: "custom", layer: "business" });
    await expect(callerFor(mgr).commercialOffice.settings.set({ accountingTarget: "custom" })).rejects.toThrow(/label/);
  }, 30_000);
});

d("P7.2 — linking records to organizations is a person's act", () => {
  it("links a vendor only to an organization holding the vendor role, keeps the history, and clears the reference on unlink", async () => {
    const book = await org(), counterparty = await org();
    const office = await member(book, ["office"]);
    const [v] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?,?,'parts','active')", [`VEN-${rnd()}`, "Acme Parts Ltd"]);
    // No role yet: refused by name.
    await expect(callerFor(office).commercialOffice.links.set({ recordType: "vendor", recordId: v.insertId, orgRef: counterparty })).rejects.toThrow(/does not hold the vendor role/);
    await callerFor(office).commercialOffice.roles.assign({ orgRef: counterparty, roleKey: "vendor" });
    const link = await callerFor(office).commercialOffice.links.set({ recordType: "vendor", recordId: v.insertId, orgRef: counterparty, note: "confirmed against the account statement" });
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef, name FROM vendors WHERE id = ?", [v.insertId]);
    expect(row[0]).toMatchObject({ orgRef: counterparty, name: "Acme Parts Ltd" });
    await expect(callerFor(office).commercialOffice.links.set({ recordType: "vendor", recordId: v.insertId, orgRef: counterparty })).rejects.toThrow(/already linked/);
    expect((await callerFor(office).commercialOffice.links.list({ orgRef: counterparty })).map(l => l.linkRef)).toContain(link.linkRef);
    await callerFor(office).commercialOffice.links.end({ linkRef: link.linkRef, reason: "wrong legal entity; the vendor is the numbered company" });
    const [after] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef, name FROM vendors WHERE id = ?", [v.insertId]);
    expect(after[0]).toMatchObject({ orgRef: null, name: "Acme Parts Ltd" });   // the captured text survives the unlink
    const history = await callerFor(office).commercialOffice.links.list({ orgRef: counterparty, includeEnded: true });
    expect(history.find(l => l.linkRef === link.linkRef)).toMatchObject({ status: "ended", endReason: expect.stringContaining("numbered company") });
  }, 30_000);

  it("proposes an exact-name candidate for a job's client and applies nothing until a person links it", async () => {
    const book = await org();
    const office = await member(book, ["office"]);
    const clientName = `Fixture Energy ${rnd()}`;
    const clientOrg = `ORG-${rnd()}`;
    await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [clientOrg, clientName]);
    await callerFor(office).commercialOffice.roles.assign({ orgRef: clientOrg, roleKey: "client" });
    const jobCode = `JOB-${rnd()}`;
    await callerFor(office).fieldRoute.jobs.create({ jobCode, type: "Hydrovac", customer: clientName, location: "LSD 04-12-045-08W4" } as never);
    const [j] = await pool.query<mysql.RowDataPacket[]>("SELECT id, customerOrgRef FROM jobs WHERE jobCode = ?", [jobCode]);
    expect(j[0]!.customerOrgRef).toBeNull();
    const c = await callerFor(office).commercialOffice.links.candidates({ recordType: "job_customer" });
    const mine = c.candidates.find(x => x.recordId === Number(j[0]!.id));
    expect(mine).toMatchObject({ orgRef: clientOrg, evidence: "exact_name_match", applied: false });
    const [still] = await pool.query<mysql.RowDataPacket[]>("SELECT customerOrgRef FROM jobs WHERE id = ?", [j[0]!.id]);
    expect(still[0]!.customerOrgRef).toBeNull();   // proposing is not linking
    await callerFor(office).commercialOffice.links.set({ recordType: "job_customer", recordId: Number(j[0]!.id), orgRef: clientOrg });
    const [linked] = await pool.query<mysql.RowDataPacket[]>("SELECT customerOrgRef, customer FROM jobs WHERE id = ?", [j[0]!.id]);
    expect(linked[0]).toMatchObject({ customerOrgRef: clientOrg, customer: clientName });
  }, 30_000);
});

d("P7.3 — a facility statement is matched, never used to edit a ticket", () => {
  it("imports, matches by facility ticket number, carries a variance, leaves the ticket untouched, refuses to close until a person resolves, and refuses a duplicate import", async () => {
    const book = await org(); const office = await member(book, ["office"]);
    const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'open')", [`Class II ${rnd()}`]);
    const facilityId = f.insertId;
    const tno = (n: number) => `DSP-${rnd()}-${n}`;
    await pool.execute("INSERT INTO disposalTickets (ticketNumber, facilityId, facilityTicketNumber, scaleInAt, quantity, quantityUnit, verificationStatus, source) VALUES (?,?,?,?,?,?,'verified','scale_ticket')", [tno(1), facilityId, "FAC-9001", "2026-09-05 14:00:00", 30, "m3"]);
    await pool.execute("INSERT INTO disposalTickets (ticketNumber, facilityId, facilityTicketNumber, scaleInAt, quantity, quantityUnit, verificationStatus, source) VALUES (?,?,?,?,?,?,'verified','scale_ticket')", [tno(2), facilityId, "FAC-9002", "2026-09-06 09:00:00", 12.5, "m3"]);
    const lines = [
      { facilityTicketNumber: "FAC-9001", receivedAt: new Date("2026-09-05T14:10:00Z"), material: null, quantity: 30, quantityUnit: "m3", amountCents: 45000, unitHint: null, manifestHint: null },
      { facilityTicketNumber: "FAC-9002", receivedAt: new Date("2026-09-06T09:05:00Z"), material: null, quantity: 13.4, quantityUnit: "m3", amountCents: 20100, unitHint: null, manifestHint: null },   // 7.2% more than the ticket
      { facilityTicketNumber: "FAC-9999", receivedAt: new Date("2026-09-07T11:00:00Z"), material: null, quantity: 8, quantityUnit: "m3", amountCents: 12000, unitHint: null, manifestHint: null },       // nothing carries it
    ];
    const imp = await callerFor(office).commercialOffice.disposal.statementImport({ facilityId, facilityStatementNumber: "SEP-2026", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), lines });
    expect(imp).toMatchObject({ match: 1, match_with_variance: 1, unmatched: 0 + 1, ambiguous: 0, facilityLinked: false });
    const [t2] = await pool.query<mysql.RowDataPacket[]>("SELECT quantity FROM disposalTickets WHERE facilityTicketNumber = 'FAC-9002' AND facilityId = ?", [facilityId]);
    expect(Number(t2[0]!.quantity)).toBe(12.5);   // the variance lives on the statement line, not on the ticket
    await expect(callerFor(office).commercialOffice.disposal.statementClose({ statementRef: imp.statementRef })).rejects.toThrow(/2 line\(s\) still need a person's resolution: #2 \(match_with_variance\), #3 \(unmatched\)/);
    await expect(callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 2, resolution: "ticket_needs_correction", note: "short" })).rejects.toThrow();
    const r2 = await callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 2, resolution: "ticket_needs_correction", note: "scale slip shows 13.4; driver entered 12.5 from memory" });
    expect(r2).toMatchObject({ ticketChanged: false, note: expect.stringContaining("nothing was changed here") });
    const [t2b] = await pool.query<mysql.RowDataPacket[]>("SELECT quantity FROM disposalTickets WHERE facilityTicketNumber = 'FAC-9002' AND facilityId = ?", [facilityId]);
    expect(Number(t2b[0]!.quantity)).toBe(12.5);
    await callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 3, resolution: "disputed", note: "no LeaseOS ticket for FAC-9999; asking the facility for the manifest" });
    await expect(callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 3, resolution: "accepted", note: "changed my mind about this one" })).rejects.toThrow(/already resolved/);
    expect(await callerFor(office).commercialOffice.disposal.statementClose({ statementRef: imp.statementRef })).toMatchObject({ status: "closed" });
    await expect(callerFor(office).commercialOffice.disposal.statementImport({ facilityId, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), lines })).rejects.toThrow(/already imported/);
  }, 40_000);

  it("accepts an ambiguous line only by choosing one of its candidates", async () => {
    const book = await org(); const office = await member(book, ["office"]);
    const [f] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'open')", [`Class II ${rnd()}`]);
    const facilityId = f.insertId;
    const [a] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO disposalTickets (ticketNumber, facilityId, scaleInAt, quantity, quantityUnit, verificationStatus, source) VALUES (?,?,?,?,?,'verified','scale_ticket')", [`DSP-${rnd()}`, facilityId, "2026-09-10 14:00:00", 30, "m3"]);
    const [b] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO disposalTickets (ticketNumber, facilityId, scaleInAt, quantity, quantityUnit, verificationStatus, source) VALUES (?,?,?,?,?,'verified','scale_ticket')", [`DSP-${rnd()}`, facilityId, "2026-09-10 16:00:00", 30, "m3"]);
    const imp = await callerFor(office).commercialOffice.disposal.statementImport({ facilityId, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), lines: [{ facilityTicketNumber: null, receivedAt: new Date("2026-09-10T15:00:00Z"), material: null, quantity: 30, quantityUnit: "m3", amountCents: null, unitHint: null, manifestHint: null }] });
    expect(imp.ambiguous).toBe(1);
    const { lines } = await callerFor(office).commercialOffice.disposal.statementLines({ statementRef: imp.statementRef });
    expect(lines[0]!.candidateTicketIds?.sort()).toEqual([a.insertId, b.insertId].sort());
    await expect(callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 1, resolution: "accepted", note: "it is the afternoon load" })).rejects.toThrow(/choosing one of its candidates/);
    await expect(callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 1, resolution: "accepted", note: "it is the afternoon load", chosenDisposalTicketId: 999_999_999 })).rejects.toThrow(/choosing one of its candidates/);
    const ok = await callerFor(office).commercialOffice.disposal.lineResolve({ statementRef: imp.statementRef, lineNo: 1, resolution: "accepted", note: "it is the afternoon load per the driver's day log", chosenDisposalTicketId: b.insertId });
    expect(ok.matchedDisposalTicketId).toBe(b.insertId);
  }, 30_000);
});

d("P7.4 — receivables through the approval ladder, and by organization", () => {
  async function invoice(entityId: number, customer: string, totalCents: number, accountId: number | null, dueAt: string) {
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, ?, 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, customer]);
    const invoiceNumber = `INV-${rnd()}`;
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, totalCents, currency, status, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, 1, ?, ?, ?, 0, ?, 'CAD', 'sent', ?)", [invoiceNumber, entityId, book.insertId, customer, accountId, totalCents, totalCents, dueAt]);
    return invoiceNumber;
  }

  it("a $30,000 credit needs two different managers; the controller is stopped at $5,000 by name; the requester never approves; the ledger shows every signature", async () => {
    const book = await org();
    const requester = await member(book, ["controller"]), controller = await member(book, ["controller"]), mgr1 = await member(book, ["management"]), mgr2 = await member(book, ["management"]);
    const entityId = 1_700_000 + Math.floor(Math.random() * 90_000);
    const invoiceNumber = await invoice(entityId, "Fixture Energy", 3_500_000, null, "2026-09-04 00:00:00");
    const req = await callerFor(requester).ar.creditRequest({ financialEntityId: entityId, invoiceNumber, amountCents: 3_000_000, reason: "standby disputed and conceded after the site log review" });
    await expect(callerFor(requester).ar.creditDecide({ creditRef: req.creditRef, decision: "approved" })).rejects.toThrow(/own credit/);
    await expect(callerFor(controller).ar.creditDecide({ creditRef: req.creditRef, decision: "approved" })).rejects.toThrow(/requires role management/);
    const first = await callerFor(mgr1).ar.creditDecide({ creditRef: req.creditRef, decision: "approved" });
    expect(first).toMatchObject({ status: "requested", ledger: { outcome: "awaiting", approvals: 1, required: 2, awaiting: expect.stringContaining("second person") } });
    await expect(callerFor(mgr1).ar.creditDecide({ creditRef: req.creditRef, decision: "approved" })).rejects.toThrow(/already approved/);
    const [still] = await pool.query<mysql.RowDataPacket[]>("SELECT status FROM customerCredits WHERE creditRef = ?", [req.creditRef]);
    expect(still[0]!.status).toBe("requested");
    const second = await callerFor(mgr2).ar.creditDecide({ creditRef: req.creditRef, decision: "approved" });
    expect(second).toMatchObject({ status: "approved", ledger: { outcome: "satisfied", approvals: 2, required: 2 } });
    const ledger = await callerFor(mgr1).commercialOffice.ar.approvalLedger({ subjectType: "customer_credit", subjectRef: req.creditRef });
    expect(ledger).toMatchObject({ status: "satisfied", category: "credit", amountCents: 3_000_000, requirement: { state: "KNOWN", approverRole: "management", secondPersonRequired: true, layer: "default" } });
    expect(ledger!.signatures.map(s => s.userId)).toEqual([mgr1, mgr2]);
    // A small credit: one controller approval is enough, and it is not the requester.
    const small = await callerFor(requester).ar.creditRequest({ financialEntityId: entityId, invoiceNumber, amountCents: 40_000, reason: "duplicate hose charge on the second ticket" });
    expect(await callerFor(controller).ar.creditDecide({ creditRef: small.creditRef, decision: "approved" })).toMatchObject({ status: "approved", ledger: { outcome: "satisfied", approvals: 1, required: 1 } });
  }, 40_000);

  it("a business whose own ladder stops short leaves a write-off in REVIEW rather than borrowing the default", async () => {
    const book = await org();
    const requester = await member(book, ["bookkeeper"]), mgr = await member(book, ["management"]);
    await callerFor(mgr).commercialOffice.approvals.policySet({ category: "write_off", maxAmountCents: 50_000, approverRole: "management" });   // the business covers write-offs only to $500
    const entityId = 1_700_000 + Math.floor(Math.random() * 90_000);
    const invoiceNumber = await invoice(entityId, "Fixture Energy", 800_000, null, "2026-05-01 00:00:00");
    const w = await callerFor(requester).ar.writeOffRequest({ invoiceNumber, amountCents: 80_000, reason: "customer insolvent; trustee confirmed no distribution" });
    await expect(callerFor(mgr).ar.writeOffDecide({ requestRef: w.requestRef, decision: "approved", reason: "trustee letter on file" })).rejects.toThrow(/REVIEW — no business tier covers \$800\.00/);
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT status FROM writeOffRequests WHERE requestRef = ?", [w.requestRef]);
    expect(row[0]!.status).toBe("requested");
  }, 30_000);

  it("ages receivables by the organization a person linked the account to, and reports unlinked accounts by their captured name", async () => {
    const book = await org(), clientOrg = await org();
    const office = await member(book, ["office"]);
    await callerFor(office).commercialOffice.roles.assign({ orgRef: clientOrg, roleKey: "client" });
    const entityId = 1_700_000 + Math.floor(Math.random() * 90_000);
    const [acct] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO customerAccounts (accountRef, financialEntityId, name, paymentTermsDays, status) VALUES (?, ?, 'Fixture Energy', 30, 'active')", [`ACC-${rnd()}`, entityId]);
    await callerFor(office).commercialOffice.links.set({ recordType: "customer_account", recordId: acct.insertId, orgRef: clientOrg });
    await invoice(entityId, "Fixture Energy", 100_000, acct.insertId, "2026-05-01 00:00:00");   // long overdue, linked
    await invoice(entityId, "Fixture Energy", 50_000, acct.insertId, "2037-01-01 00:00:00");    // not yet due, linked (TIMESTAMP tops out in 2038)
    await invoice(entityId, "Somebody Else", 70_000, null, "2026-05-01 00:00:00");             // unlinked
    const a = await callerFor(office).commercialOffice.ar.agingByOrganization({ financialEntityId: entityId, asOf: new Date("2026-09-17T00:00:00Z") });
    const mine = a.organizations.find(o => o.orgRef === clientOrg)!;
    expect(mine).toMatchObject({ linked: true, invoiceCount: 2, totalOutstandingCents: 150_000 });
    expect(mine.buckets.d90_plus).toBe(100_000);
    expect(mine.buckets.current).toBe(50_000);
    expect(a.unlinked.find(u => u.label === "Somebody Else")).toMatchObject({ linked: false, totalOutstandingCents: 70_000 });
    expect(a.note).toContain("customer_account");
  }, 30_000);
});

d("P7.5 — payables through the same ledger, and by organization", () => {
  it("a $40,000 bill takes two managers; the recorder is refused by name; the approver does not release; an unlinked vendor ages by its captured name", async () => {
    const book = await org(), vendorOrg = await org();
    const bookkeeper = await member(book, ["bookkeeper"]), controller = await member(book, ["controller"]), mgr1 = await member(book, ["management"]), mgr2 = await member(book, ["management"]);
    const entityId = 1_800_000 + Math.floor(Math.random() * 90_000);
    const [v] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?,?,'parts','active')", [`VEN-${rnd()}`, `Big Iron ${rnd()}`]);
    await callerFor(bookkeeper).commercialOffice.roles.assign({ orgRef: vendorOrg, roleKey: "vendor" });
    await callerFor(bookkeeper).commercialOffice.links.set({ recordType: "vendor", recordId: v.insertId, orgRef: vendorOrg });
    const billRef = `BILL-${rnd()}`;
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, recordedByUserId, vendorInvoiceNumber, invoiceDate, receivedAt, dueAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?,?,?,?,?, '2026-08-01', '2026-08-02 00:00:00', '2026-08-31 00:00:00', 'CAD', 4000000, 0, 4000000, 'match', 'needs_approval')", [billRef, entityId, v.insertId, bookkeeper, `VI-${rnd()}`]);
    await expect(callerFor(bookkeeper).vendor.billApprove({ billRef, codingCategory: "fleet_capital" })).rejects.toThrow(/separation of duties/);
    await expect(callerFor(controller).vendor.billApprove({ billRef, codingCategory: "fleet_capital" })).rejects.toThrow(/requires role management/);
    const first = await callerFor(mgr1).vendor.billApprove({ billRef, codingCategory: "fleet_capital" });
    expect(first).toMatchObject({ status: "needs_approval", ledger: { outcome: "awaiting", approvals: 1, required: 2 } });
    const second = await callerFor(mgr2).vendor.billApprove({ billRef, codingCategory: "fleet_capital" });
    expect(second).toMatchObject({ status: "ready_to_pay", ledger: { outcome: "satisfied" } });
    // Payment: the bill's approver (mgr2) prepared it and does not release; mgr1 is a different person but the payment tier above $25,000 wants two.
    await expect(callerFor(mgr2).vendor.paymentRelease({ billRef })).rejects.toThrow(/does not release/);
    const rel1 = await callerFor(mgr1).vendor.paymentRelease({ billRef });
    expect(rel1).toMatchObject({ status: "ready_to_pay", ledger: { outcome: "awaiting", required: 2 } });
    const mgr3 = await member(book, ["management"]);
    expect(await callerFor(mgr3).vendor.paymentRelease({ billRef })).toMatchObject({ status: "paid", ledger: { outcome: "satisfied", approvals: 2 } });
    const ledger = await callerFor(mgr1).commercialOffice.ar.approvalLedger({ subjectType: "vendor_bill_payment", subjectRef: billRef });
    expect(ledger!.signatures.map(s => s.userId)).toEqual([mgr1, mgr3]);
    // AP aging: a second, unpaid bill from an unlinked vendor.
    const [v2] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?,?,'parts','active')", [`VEN-${rnd()}`, "Nobody Linked Me Ltd"]);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, dueAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?,?,?,?, '2026-06-01', '2026-06-02 00:00:00', '2026-07-01 00:00:00', 'CAD', 90000, 0, 90000, 'match', 'needs_approval')", [`BILL-${rnd()}`, entityId, v2.insertId, `VI-${rnd()}`]);
    const a = await callerFor(controller).commercialOffice.ap.agingByOrganization({ financialEntityId: entityId, asOf: new Date("2026-09-17T00:00:00Z") });
    expect(a.organizations.find(o => o.orgRef === vendorOrg)).toBeUndefined();   // the linked vendor's only bill is paid
    expect(a.unlinked.find(u => u.label === "Nobody Linked Me Ltd")).toMatchObject({ linked: false, totalCents: 90000, awaitingApprovalCents: 90000, buckets: expect.objectContaining({ d61_90: 90000 }) });
  }, 40_000);
});

d("P7.6 — GL mapping is the business's own; profitability comes only from evidence links", () => {
  async function invoice(entityId: number, customer: string, jobId: number | null, subtotal: number, serviceCode: string, gst: "taxable" | "unknown") {
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, ?, 'invoiced', NOW(), NOW(), NOW())", [`BB-${rnd()}`, customer]);
    const [inv] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO invoices (invoiceNumber, financialEntityId, issuedAt, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status, gstTreatment, dueAt) VALUES (?, ?, '2026-08-05 00:00:00', ?, ?, ?, ?, 0, ?, 'CAD', 'sent', ?, '2026-09-04 00:00:00')", [`INV-${rnd()}`, entityId, book.insertId, jobId, customer, subtotal, subtotal, gst]);
    await pool.execute("INSERT INTO invoiceLines (invoiceId, lineNo, serviceCode, description, quantityMillis, billableQuantityMillis, unit, rateMillis, amountCents, basis) VALUES (?, 1, ?, 'x', 1000, 1000, 'hr', ?, ?, 'test')", [inv.insertId, serviceCode, subtotal * 1000, subtotal]);
  }
  it("refuses a mapping to an account not in the chart, names every unmapped key for a period, and reports READY once the business has mapped its own keys", async () => {
    const book = await org(); const mgr = await member(book, ["management"]);
    const entityId = 1_900_000 + Math.floor(Math.random() * 90_000);
    await invoice(entityId, "Fixture Energy", null, 100_000, "HYDROVAC_HR", "taxable");
    await expect(callerFor(mgr).commercialOffice.gl.mappingSet({ mappingKind: "service_code", mappingKey: "HYDROVAC_HR", glAccountCode: "4000" })).rejects.toThrow(/not in this business's chart/);
    const before = await callerFor(mgr).commercialOffice.gl.exportReadiness({ financialEntityId: entityId, from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(before.state).toBe("BLOCKED");
    expect(before.exported).toBe(false);
    expect(before.blockers.map(b => b.kind)).toEqual(expect.arrayContaining(["chart", "service_code", "gst_output"]));
    await callerFor(mgr).commercialOffice.gl.accountSet({ code: "4000", name: "Hydrovac revenue", kind: "revenue" });
    await callerFor(mgr).commercialOffice.gl.accountSet({ code: "2300", name: "GST collected", kind: "tax" });
    await callerFor(mgr).commercialOffice.gl.mappingSet({ mappingKind: "service_code", mappingKey: "HYDROVAC_HR", glAccountCode: "4000" });
    await callerFor(mgr).commercialOffice.gl.mappingSet({ mappingKind: "gst_output", mappingKey: "taxable", glAccountCode: "2300" });
    const after = await callerFor(mgr).commercialOffice.gl.exportReadiness({ financialEntityId: entityId, from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(after).toMatchObject({ state: "READY", blockers: [] });
    // Another business sees none of this chart.
    const other = await org(); const mgr2 = await member(other, ["management"]);
    expect((await callerFor(mgr2).commercialOffice.gl.list()).accounts.length).toBe(0);
  }, 30_000);

  it("attributes revenue and cost by job and by linked client from evidence, says unit is cost-only, refuses driver by name, and hides a retired dimension", async () => {
    const book = await org(), clientOrg = await org();
    const office = await member(book, ["office"]), mgr = await member(book, ["management"]);
    await callerFor(office).commercialOffice.roles.assign({ orgRef: clientOrg, roleKey: "client" });
    const entityId = 1_900_000 + Math.floor(Math.random() * 90_000);
    const jobCode = `JOB-${rnd()}`;
    await callerFor(office).fieldRoute.jobs.create({ jobCode, type: "Hydrovac", customer: "Fixture Energy", location: "LSD 04-12-045-08W4" } as never);
    const [j] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
    const jobId = Number(j[0]!.id);
    await callerFor(office).commercialOffice.links.set({ recordType: "job_customer", recordId: jobId, orgRef: clientOrg });
    await invoice(entityId, "Fixture Energy", jobId, 500_000, "HYDROVAC_HR", "taxable");
    const [v] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?,?,'parts','active')", [`VEN-${rnd()}`, "Disposal Co"]);
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, vendorInvoiceNumber, invoiceDate, receivedAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status, jobId, unitId) VALUES (?,?,?,?, '2026-08-10', '2026-08-11 00:00:00', 'CAD', 120000, 6000, 126000, 'match', 'ready_to_pay', ?, 42)", [`BILL-${rnd()}`, entityId, v.insertId, `VI-${rnd()}`, jobId]);
    const byJob = await callerFor(office).commercialOffice.profitability.byDimension({ financialEntityId: entityId, dimension: "job", from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(byJob.derivable).toBe(true);
    expect(byJob.rows.find(r => r.key === `job:${jobId}`)).toMatchObject({ revenueCents: 500_000, costCents: 120_000, marginCents: 380_000, marginPct: 76, invoiceCount: 1, billCount: 1 });
    const byClient = await callerFor(office).commercialOffice.profitability.byDimension({ financialEntityId: entityId, dimension: "client", from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(byClient.rows.find(r => r.key === clientOrg)).toMatchObject({ revenueCents: 500_000, costCents: 120_000 });
    const byUnit = await callerFor(office).commercialOffice.profitability.byDimension({ financialEntityId: entityId, dimension: "unit", from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(byUnit).toMatchObject({ derivable: "cost_only", note: expect.stringContaining("allocation, not evidence") });
    expect(byUnit.rows.find(r => r.key === "unit:42")).toMatchObject({ costCents: 120_000, revenueCents: 0 });
    const byDriver = await callerFor(office).commercialOffice.profitability.byDimension({ financialEntityId: entityId, dimension: "driver", from: new Date("2026-08-01"), to: new Date("2026-08-31") });
    expect(byDriver).toMatchObject({ derivable: false, reason: expect.stringContaining("operator") });
    // The business hides branch by retiring it in its own book; the default row stays for everyone else.
    await pool.execute("INSERT INTO commercialCategoryTypes (bookOrgRef, kind, categoryKey, label, builtIn, status, source) VALUES (?, 'profitability_dimension', 'branch', 'Branch', false, 'retired', 'business_defined test')", [book]);
    await expect(callerFor(mgr).commercialOffice.profitability.byDimension({ financialEntityId: entityId, dimension: "branch", from: new Date("2026-08-01"), to: new Date("2026-08-31") })).rejects.toThrow(/not active in this business's book/);
  }, 40_000);
});

d("P7.7 — the commercial document registry over the vault", () => {
  const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex") as string;
  it("registers only with a hash and a pointer, refuses a hash that is not the generated document's, supersedes as a new version carrying links, logs deliveries, assigns retention by policy, and refuses withdrawal under legal hold", async () => {
    const book = await org(), client = await org();
    const office = await member(book, ["office"]), mgr = await member(book, ["management"]);
    const c = callerFor(office);
    // A generated field-ticket document in the vault's neighbour table, with its own hash.
    const genHash = sha("field ticket pdf bytes");
    const [ftd] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO fieldTicketDocuments (documentRef, fieldTicketId, kind, storageKey, contentHash, sourceSnapshotHash, byteLength, generatedAt) VALUES (?, 1, 'invoice', 'documents/ft-1.pdf', ?, ?, 12345, NOW())", [`FTD-${rnd()}`, genHash, sha("snapshot")]);
    await expect(c.commercialOffice.documents.register({ documentType: "invoice", title: "INV-1", contentHash: genHash })).rejects.toThrow(/needs a pointer to its bytes/);
    await expect(c.commercialOffice.documents.register({ documentType: "not_a_type", title: "x", contentHash: genHash, storageKey: "k" })).rejects.toThrow(/not an active document type/);
    await expect(c.commercialOffice.documents.register({ documentType: "invoice", title: "INV-1", contentHash: sha("something else"), fieldTicketDocumentId: ftd.insertId })).rejects.toThrow(/is not the generated document's hash/);
    const invoiceRef = `INV-${rnd()}`, jobCode = `JOB-${rnd()}`;
    const reg = await c.commercialOffice.documents.register({ documentType: "invoice", title: "Invoice for the Fixture job", contentHash: genHash, sourceSnapshotHash: sha("snapshot"), byteLength: 12345, mimeType: "application/pdf", fieldTicketDocumentId: ftd.insertId, counterpartyOrgRef: client, issuedAt: new Date("2026-09-10"), links: [{ recordType: "invoice", recordRef: invoiceRef }, { recordType: "job", recordRef: jobCode }] });
    expect(reg.documentRef).toMatch(/^DOC-/);
    expect(reg.retention).toContain("unknown");
    const byJob = await c.commercialOffice.documents.list({ recordType: "job", recordRef: jobCode });
    expect(byJob.map(d => d.documentRef)).toEqual([reg.documentRef]);
    // Delivery: sent by email, then bounced with a reason; a bounce without a reason is refused.
    const dlv = await c.commercialOffice.documents.deliveryRecord({ documentRef: reg.documentRef, channel: "email", recipientOrgRef: client, recipientAddress: "ap@fixture.example", status: "sent", deliveryEvidence: "message-id 123" });
    await expect(c.commercialOffice.documents.deliveryUpdate({ deliveryRef: dlv.deliveryRef, status: "bounced" })).rejects.toThrow(/needs the reason/);
    await c.commercialOffice.documents.deliveryUpdate({ deliveryRef: dlv.deliveryRef, status: "bounced", failureReason: "mailbox full" });
    // Retention: a policy a person picks; the registry records the class and the policy's statutory-source status honestly.
    const [pol] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO retentionPolicies (policyKey, recordType, companyRetentionMonths, deletionRequiresOfficeReceipt, legalHoldOverridesDeletion, active) VALUES (?, 'commercial_document', 84, true, true, true)", [`commercial-7y-${rnd()}`]);
    await expect(c.commercialOffice.documents.retentionAssign({ documentRef: reg.documentRef, retentionPolicyId: pol.insertId })).rejects.toThrow();   // office holds commercial.write, not commercial.policy
    const ret = await callerFor(mgr).commercialOffice.documents.retentionAssign({ documentRef: reg.documentRef, retentionPolicyId: pol.insertId });
    expect(ret.retentionClass).toMatch(/^commercial-7y-/);
    // Supersede: same hash refused; a corrected invoice becomes v2, the links come along, v1 is superseded and cannot be sent again.
    await expect(c.commercialOffice.documents.supersede({ documentRef: reg.documentRef, reason: "no change at all here", contentHash: genHash, storageKey: "k2" })).rejects.toThrow(/same content hash/);
    const v2 = await c.commercialOffice.documents.supersede({ documentRef: reg.documentRef, reason: "standby line corrected after the site log review", contentHash: sha("corrected pdf"), storageKey: "documents/inv-1-v2.pdf" });
    expect(v2).toMatchObject({ version: 2, supersedes: reg.documentRef, linksCarried: 2 });
    await expect(c.commercialOffice.documents.deliveryRecord({ documentRef: reg.documentRef, channel: "email", status: "sent" })).rejects.toThrow(/is superseded; send the current version/);
    const got = await c.commercialOffice.documents.get({ documentRef: v2.documentRef });
    expect(got.versions.map(v => `${v.version}:${v.status}`)).toEqual([`1:superseded`, `2:current`]);
    expect(got.links.map(l => l.recordType).sort()).toEqual(["invoice", "job"]);
    expect(got.retention).toMatch(/^commercial-7y-/);   // retention carried to the new version
    expect((await c.commercialOffice.documents.list({ recordType: "invoice", recordRef: invoiceRef })).map(d => d.version)).toEqual([2]);
    // Withdraw: refused while the underlying evidence record is under legal hold; allowed otherwise, keeping the row.
    const [held] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, status, legalHold, createdAt) VALUES ('Signed manifest scan', 'contract', NOW(), 'verified', 1, NOW())");
    const mf = await c.commercialOffice.documents.register({ documentType: "manifest", title: "Manifest scan", contentHash: sha("manifest scan"), evidenceRecordId: held.insertId });
    await expect(callerFor(mgr).commercialOffice.documents.withdraw({ documentRef: mf.documentRef, reason: "registered against the wrong job" })).rejects.toThrow(/legal hold/);
    const wd = await callerFor(mgr).commercialOffice.documents.withdraw({ documentRef: v2.documentRef, reason: "issued to the wrong counterparty; reissued" });
    expect(wd.note).toContain("not a deletion");
    expect((await c.commercialOffice.documents.get({ documentRef: v2.documentRef })).document).toMatchObject({ status: "withdrawn", contentHash: sha("corrected pdf") });
  }, 60_000);
});

d("P7.8 — the vendor audit package, from the ledger, the statements and the registry", () => {
  const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex") as string;
  it("bundles the vendor's bills with their approval-ledger signatures by role (user ids withheld), the registry documents linked to it, names a bill approved outside the ladder as a gap, is byte-reproducible, and is released only by a second person after a controller prepared it", async () => {
    const book = await org(), vendorOrg = await org();
    const bookkeeper = await member(book, ["bookkeeper"]), controller = await member(book, ["controller"]), mgr1 = await member(book, ["management"]), mgr2 = await member(book, ["management"]);
    const entityId = 1_700_000 + Math.floor(Math.random() * 90_000);
    const vendorRef = `VEN-${rnd()}`;
    const [v] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO vendors (vendorRef, name, category, status) VALUES (?,?,'parts','active')", [vendorRef, `Big Iron ${rnd()}`]);
    await callerFor(bookkeeper).commercialOffice.roles.assign({ orgRef: vendorOrg, roleKey: "vendor" });
    await callerFor(bookkeeper).commercialOffice.links.set({ recordType: "vendor", recordId: v.insertId, orgRef: vendorOrg });
    const billRef = `BILL-${rnd()}`;
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, recordedByUserId, vendorInvoiceNumber, invoiceDate, receivedAt, dueAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?,?,?,?,?, '2026-08-01', '2026-08-02 00:00:00', '2026-08-31 00:00:00', 'CAD', 4000000, 0, 4000000, 'match', 'needs_approval')", [billRef, entityId, v.insertId, bookkeeper, `VI-${rnd()}`]);
    await callerFor(mgr1).vendor.billApprove({ billRef, codingCategory: "fleet_capital" });
    await callerFor(mgr2).vendor.billApprove({ billRef, codingCategory: "fleet_capital" });
    // A bill that was paid before the ladder existed: no ledger record — the package must say so.
    const legacyRef = `BILL-${rnd()}`;
    await pool.execute("INSERT INTO vendorBills (billRef, financialEntityId, vendorId, recordedByUserId, vendorInvoiceNumber, invoiceDate, receivedAt, dueAt, currency, subtotalCents, taxAmountCents, totalCents, matchOutcome, status) VALUES (?,?,?,?,?, '2026-08-10', '2026-08-11 00:00:00', '2026-09-10 00:00:00', 'CAD', 50000, 0, 50000, 'match', 'paid')", [legacyRef, entityId, v.insertId, bookkeeper, `VI-${rnd()}`]);
    // A registry document linked to the vendor, with a delivery.
    const doc = await callerFor(bookkeeper).commercialOffice.documents.register({ documentType: "remittance", title: "Remittance advice August", contentHash: sha("remittance"), storageKey: "documents/rem-aug.pdf", counterpartyOrgRef: vendorOrg, links: [{ recordType: "vendor", recordRef: vendorRef }] });
    await callerFor(bookkeeper).commercialOffice.documents.deliveryRecord({ documentRef: doc.documentRef, channel: "email", recipientOrgRef: vendorOrg, status: "delivered", deliveryEvidence: "read receipt" });
    const pkg = await callerFor(controller).audit.packagePrepare({ kind: "vendor", subjectRef: vendorRef, periodFrom: new Date("2026-08-01T00:00:00Z"), periodTo: new Date("2026-08-31T23:59:59Z"), recipient: "External accountant — year-end", purpose: "AP substantiation" });
    const got = await callerFor(controller).audit.packageGet({ packageRef: pkg.packageRef });
    const kinds = got.items.map(i => i.itemKind);
    expect(kinds).toEqual(expect.arrayContaining(["vendor", "vendor_bill", "approval_ledger", "registry_document", "gap_note"]));
    const ledger = got.items.find(i => i.itemKind === "approval_ledger")!;
    expect(ledger.title).toMatch(/approved by management #1; approved by management #2/);
    expect(JSON.stringify(ledger)).not.toContain(String(mgr1));   // identities withheld, roles kept
    expect(got.items.find(i => i.itemKind === "gap_note")!.title).toContain(`${legacyRef} is paid with no approval-ledger record`);
    expect(got.items.find(i => i.itemKind === "registry_document")!.title).toContain("1 delivery");
    expect(got.missing).toEqual([]);   // vendor, bills and a ledger are all present
    // Reproducible: preparing the same package again yields the same manifest hash.
    const again = await callerFor(controller).audit.packagePrepare({ kind: "vendor", subjectRef: vendorRef, periodFrom: new Date("2026-08-01T00:00:00Z"), periodTo: new Date("2026-08-31T23:59:59Z"), recipient: "External accountant — year-end", purpose: "AP substantiation" });
    expect((await callerFor(controller).audit.packageGet({ packageRef: again.packageRef })).manifestHash).toBe(got.manifestHash);
    // Release needs a second person.
    await expect(callerFor(controller).audit.packageRelease({ packageRef: pkg.packageRef, note: "releasing to the accountant" })).rejects.toThrow(/preparer may not release/);
    const rel = await callerFor(mgr1).audit.packageRelease({ packageRef: pkg.packageRef, note: "Released to the external accountant for AP substantiation" });
    expect(rel.status).toBe("released");
  }, 60_000);
});

d("P7.9 — the organization master from the office", () => {
  it("creates an organization by name (refusing a duplicate name by pointing at the existing one), lists it with its roles and numbers once a role is assigned, and lists open facility statements with their open-line counts", async () => {
    const book = await org();
    const office = await member(book, ["office"]);
    const name = `North Star Hauling ${rnd()}`;
    const made = await callerFor(office).commercialOffice.organizations.create({ name });
    expect(made.orgRef).toMatch(/^ORG-/);
    await expect(callerFor(office).commercialOffice.organizations.create({ name })).rejects.toThrow(/already exists/);
    const before = (await callerFor(office).commercialOffice.organizations.list({ q: name })).find(o => o.orgRef === made.orgRef)!;
    expect(before.roles).toEqual([]);
    await callerFor(office).commercialOffice.roles.assign({ orgRef: made.orgRef, roleKey: "client" });
    const after = (await callerFor(office).commercialOffice.organizations.list({ roleKey: "client", q: name })).find(o => o.orgRef === made.orgRef)!;
    expect(after.roles).toEqual([expect.objectContaining({ roleKey: "client", commercialNumber: expect.stringMatching(/^CLI-\d{6}$/) })]);
    expect((await callerFor(office).commercialOffice.organizations.list({ roleKey: "vendor", q: name })).some(o => o.orgRef === made.orgRef)).toBe(false);
    const statements = await callerFor(office).commercialOffice.disposal.statements({ status: "open" });
    expect(Array.isArray(statements)).toBe(true);
    for (const st of statements) expect(st.openLines).toBe(st.varianceCount + st.unmatchedCount + st.ambiguousCount);
  }, 30_000);
});
