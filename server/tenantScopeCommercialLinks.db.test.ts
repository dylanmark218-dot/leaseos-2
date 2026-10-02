/**
 * P7.2 — a commercial link may only name a record the caller's book can already see.
 *
 * `commercialOffice.links.set` takes a bare integer `recordId` and, inside a
 * transaction, WRITES the organization reference onto that row:
 *
 *     await tx.update(vendors).set({ orgRef: input.orgRef }).where(eq(vendors.id, input.recordId));
 *
 * The counterparty organization was checked — it has to hold the matching role
 * in the caller's own book — but the RECORD never was: it was fetched by primary
 * key alone. So a caller in book A could pass the id of a book-B vendor,
 * customer account or job and rewrite it. That is a cross-tenant write reachable
 * by guessing an id, and it also plants a link row in A's book pointing at B's
 * record.
 *
 * The rule is "you may link what you can already see", so each record type
 * reuses the visibility its own reads use rather than a new, stricter one: the
 * vendor and the book's own rows, the customer account through its financial
 * entity (the money boundary), the job through `orgScopeWhere`. Facilities stay
 * deliberately unscoped — the disposal directory is shared reference data, and
 * its first-come rule is enforced by the active-link check instead.
 *
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 930_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
/** A vendor kept in `book`'s own commercial book, as `createVendor` writes one. */
async function vendorInBook(book: string | null) {
  const [v] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO vendors (vendorRef, name, category, status, bookOrgRef) VALUES (?,?,'parts','active',?)",
    [`VEN-${rnd()}`, `Vendor ${rnd()}`, book],
  );
  return v.insertId;
}
async function jobOwnedBy(orgRef: string | null) {
  const [j] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${rnd()}`, "hydrovac", "Northgate Energy Ltd.", "16-22-079-11 W6M", orgRef],
  );
  return j.insertId;
}
/** A customer account on `orgRef`'s own financial entity — the money boundary (F1.1). */
async function accountOnEntityOf(orgRef: string) {
  const [e] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?,?,'corporation','CA-AB',?)",
    [`FE-${rnd()}`, `Books ${rnd()}`, orgRef],
  );
  const [a] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO customerAccounts (accountRef, financialEntityId, name, paymentTermsDays, status) VALUES (?,?,?,30,'active')",
    [`ACC-${rnd()}`, e.insertId, `Customer ${rnd()}`],
  );
  return { accountId: a.insertId, entityId: e.insertId };
}
async function facility() {
  const [f] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO facilities (name, status) VALUES (?,'open')", [`Facility ${rnd()}`],
  );
  return f.insertId;
}
/** Give `book` a counterparty that genuinely holds `roleKey`, so only the record side is under test. */
async function counterpartyFor(officeUser: number, roleKey: string) {
  const orgRef = await org();
  await callerFor(officeUser).commercialOffice.roles.assign({ orgRef, roleKey });
  return orgRef;
}

d("a commercial link may only name a record this book can see", () => {
  it("refuses to rewrite another book's vendor, and leaves the row untouched", async () => {
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const officeB = await member(bookB, ["office", "management"]);
    void officeB;
    const bsVendor = await vendorInBook(bookB);
    const counterparty = await counterpartyFor(officeA, "vendor");

    await expect(
      callerFor(officeA).commercialOffice.links.set({ recordType: "vendor", recordId: bsVendor, orgRef: counterparty }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The write is the real damage: B's vendor must still carry no organization,
    // and no link row may exist against it.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT bookOrgRef, orgRef FROM vendors WHERE id = ?", [bsVendor]);
    expect(rows[0].bookOrgRef).toBe(bookB);
    expect(rows[0].orgRef).toBeNull();
    const [links] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM organizationRecordLinks WHERE recordType = 'vendor' AND recordId = ?", [bsVendor],
    );
    expect(Number(links[0].n)).toBe(0);
  }, 30_000);

  it("refuses to rewrite another organization's job as this book's client", async () => {
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const bsJob = await jobOwnedBy(bookB);
    const counterparty = await counterpartyFor(officeA, "client");

    await expect(
      callerFor(officeA).commercialOffice.links.set({ recordType: "job_customer", recordId: bsJob, orgRef: counterparty }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef, customerOrgRef FROM jobs WHERE id = ?", [bsJob]);
    expect(rows[0].orgRef).toBe(bookB);
    expect(rows[0].customerOrgRef).toBeNull();
  }, 30_000);

  it("still links a vendor the book does own", async () => {
    // The counter-test: tightening must not close the ordinary flow.
    const bookA = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const mine = await vendorInBook(bookA);
    const counterparty = await counterpartyFor(officeA, "vendor");

    const link = await callerFor(officeA).commercialOffice.links.set({
      recordType: "vendor", recordId: mine, orgRef: counterparty,
    });
    expect(link.linkRef).toMatch(/^OLINK-/);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef FROM vendors WHERE id = ?", [mine]);
    expect(rows[0].orgRef).toBe(counterparty);
  }, 30_000);

  it("refuses to rewrite a customer account whose financial entity is another organization's", async () => {
    /*
     * The money boundary, not the book: a customer account is keyed to a
     * financial entity (0146), and F1.1's rule is that the caller's acting
     * organization must own that entity. Found by mutation — dropping the
     * `ownsEntity` check left every other test in this file green, because
     * nothing here linked a customer account at all.
     */
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const bs = await accountOnEntityOf(bookB);
    const counterparty = await counterpartyFor(officeA, "client");

    await expect(
      callerFor(officeA).commercialOffice.links.set({ recordType: "customer_account", recordId: bs.accountId, orgRef: counterparty }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef FROM customerAccounts WHERE id = ?", [bs.accountId]);
    expect(rows[0].orgRef).toBeNull();
  }, 30_000);

  it("still links a customer account on the book's own entity", async () => {
    const bookA = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const mine = await accountOnEntityOf(bookA);
    const counterparty = await counterpartyFor(officeA, "client");

    const link = await callerFor(officeA).commercialOffice.links.set({
      recordType: "customer_account", recordId: mine.accountId, orgRef: counterparty,
    });
    expect(link.linkRef).toMatch(/^OLINK-/);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT orgRef FROM customerAccounts WHERE id = ?", [mine.accountId]);
    expect(rows[0].orgRef).toBe(counterparty);
  }, 30_000);

  it("answers a vendor that exists nowhere exactly as one in another book", async () => {
    // Otherwise the refusal is an existence oracle over the vendor id space.
    const bookA = await org(), bookB = await org();
    const officeA = await member(bookA, ["office", "management"]);
    const bsVendor = await vendorInBook(bookB);
    const counterparty = await counterpartyFor(officeA, "vendor");
    const say = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; message: string }) => `${e.code}`);

    const foreign = await say(callerFor(officeA).commercialOffice.links.set({ recordType: "vendor", recordId: bsVendor, orgRef: counterparty }));
    const fictional = await say(callerFor(officeA).commercialOffice.links.set({ recordType: "vendor", recordId: 2_000_000_000, orgRef: counterparty }));
    expect(foreign).toBe("NOT_FOUND");
    expect(foreign).toBe(fictional);
  }, 30_000);
});
