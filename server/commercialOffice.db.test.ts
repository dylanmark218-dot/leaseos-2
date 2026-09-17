/**
 * P7.1 — Commercial Office configuration (0133), through the router.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

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
  it("seeds five role types, five numbering formats, QuickBooks Online, an 18-row ladder and seven profitability dimensions — and no load categories or document types", async () => {
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
    expect((await c.commercialOffice.categories.list({ kind: "document_type" })).length).toBe(0);
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
    expect(dflt.requirement).toMatchObject({ state: "KNOWN", approverRole: "office", layer: "default" });
    expect(dflt.couldApprove.allowed).toBe(true);
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
