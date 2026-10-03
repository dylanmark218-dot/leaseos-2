/**
 * P4.1 router 6 — closeout (field tickets) keys to jobs, which belong to an organization (0132).
 * A ticket is in scope through its job — or its unit's owner when it has no job — and answers
 * "not found" across the boundary, never "forbidden". Opening a ticket on another organization's
 * job is refused the same way. The historical single tenant sees only what nobody owns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 255_000_000 + Math.floor(Math.random() * 50_000);
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
async function jobOwnedBy(orgRef: string | null) {
  const jobCode = `JOB-${rnd()}`;
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [jobCode, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]);
  return j.insertId;
}
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
/** A customer account in a book the organization owns (P0-A3: a ticket bills only to an account in the caller's own book). */
async function accountRef(orgRef: string | null) {
  const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Fixture books', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgRef]);
  const acctRef = `ACCT-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, delayBillingRulesJson, postSiteBillingRuleJson) VALUES (?, ?, ?, ?, ?)", [acctRef, Number(book.insertId), `Fixture ${acctRef}`, JSON.stringify({ customer_hold: "billable" }), JSON.stringify({ rule: "not_billable" })]);
  return acctRef;
}

d("closeout belongs to the organization that owns the job", () => {
  it("opens a ticket only on a job in scope, serves the ticket's owner, answers not-found to another organization and to the single tenant, and still serves an unowned job to the single tenant", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]), driverB = await member(B, ["driver"]), legacy = await member(null, ["driver"]);
    const jobA = await jobOwnedBy(A), jobNone = await jobOwnedBy(null);
    const unitA = await unitOwnedBy(A), unitNone = await unitOwnedBy(null);
    const acct = await accountRef(A), acctNone = await accountRef(null);
    // Another organization's driver cannot open a ticket on A's job: not found.
    await expect(callerFor(driverB).closeout.ticketOpen({ jobId: jobA, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Job ${jobA} not found` });
    // A's driver opens it; then reads its state; B and the single tenant do not find it.
    const t = await callerFor(driverA).closeout.ticketOpen({ jobId: jobA, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    await expect(callerFor(driverA).closeout.state({ ticketNumber: t.ticketNumber })).resolves.toBeTruthy();
    await expect(callerFor(driverB).closeout.state({ ticketNumber: t.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Ticket ${t.ticketNumber} not found` });
    await expect(callerFor(legacy).closeout.state({ ticketNumber: t.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverB).closeout.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "HV-HR", description: "truck hours", quantity: 2 } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An unowned job: the single tenant opens and reads; A's driver does not find it.
    const u = await callerFor(legacy).closeout.ticketOpen({ jobId: jobNone, customerAccountRef: acctNone, unitId: unitNone, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    // P0-A3: A's driver cannot bill A's own job to another company's (or an ownerless) customer account.
    await expect(callerFor(driverA).closeout.ticketOpen({ jobId: jobA, customerAccountRef: acctNone, unitId: unitA, operatorId: 7, serviceDescription: "x", postSiteRequired: false } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: "Customer account not found" });
    await expect(callerFor(legacy).closeout.state({ ticketNumber: u.ticketNumber })).resolves.toBeTruthy();
    await expect(callerFor(driverA).closeout.state({ ticketNumber: u.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverA).closeout.ticketOpen({ jobId: jobNone, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "x", postSiteRequired: false } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

/*
 * closeout.lineDecide was the one ticket procedure that never proved the ticket was in the caller's
 * organization: it loaded the ticket by number and wrote the line. These pin that a line decision,
 * like every sibling, answers "not found" across the boundary and changes nothing.
 */
d("a line decision belongs to the organization that owns the ticket", () => {
  /** A signed ticket on A's job with one service line — lineDecide refuses unsigned tickets. */
  async function signedTicketIn(orgRef: string) {
    const driver = await member(orgRef, ["driver"]);
    const t = await callerFor(driver).closeout.ticketOpen({ jobId: await jobOwnedBy(orgRef), customerAccountRef: await accountRef(orgRef), unitId: await unitOwnedBy(orgRef), operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    await callerFor(driver).closeout.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "HV-HR", description: "truck hours", quantity: 2 } as never);
    const [[ticket]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]);
    // The records the site sign-off writes (closeoutRouter.recordSignature): the frozen R1, a signature on its
    // hash, and the ticket's own record — a signature row alone is not a signed ticket.
    const hash = "a".repeat(64);
    await pool.execute("INSERT INTO fieldTicketRevisions (documentRef, fieldTicketId, revision, kind, snapshotJson, snapshotHash, generatedAt) VALUES (?, ?, 1, 'site_signed', '{}', ?, NOW())", [`${t.ticketNumber}-R1`, ticket.id, hash]);
    await pool.execute("INSERT INTO fieldTicketSignatures (fieldTicketId, revision, result, signerName, payloadHash, capturedAt) VALUES (?, 1, 'accepted', 'M. Johnson', ?, NOW())", [ticket.id, hash]);
    await pool.execute("UPDATE fieldTickets SET status = 'closed', signatureStatus = 'accepted' WHERE id = ?", [ticket.id]);
    const [[line]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTicketLines WHERE fieldTicketId = ? ORDER BY id LIMIT 1", [ticket.id]);
    return { ticketNumber: t.ticketNumber as string, ticketId: Number(ticket.id), lineId: Number(line.id) };
  }
  const lineState = async (lineId: number) =>
    (await pool.query<mysql.RowDataPacket[]>("SELECT disposition, customerStatement FROM fieldTicketLines WHERE id = ?", [lineId]))[0][0];
  const ticketState = async (ticketId: number) =>
    (await pool.query<mysql.RowDataPacket[]>("SELECT status, signatureStatus FROM fieldTickets WHERE id = ?", [ticketId]))[0][0];
  const signatureRows = async (ticketId: number) =>
    (await pool.query<mysql.RowDataPacket[]>("SELECT id, result, signerName, capturedAt FROM fieldTicketSignatures WHERE fieldTicketId = ? ORDER BY id", [ticketId]))[0];

  it("lets the owning organization's office decide a line", async () => {
    const A = await org();
    const s = await signedTicketIn(A);
    const officeA = await member(A, ["office"]);
    const r = await callerFor(officeA).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineId, disposition: "accepted" });
    expect(r.disposition).toBe("accepted");
    expect((await lineState(s.lineId)).disposition).toBe("accepted");
  }, 60_000);

  it("refuses another organization's office that knows the exact ticket and line, and changes nothing", async () => {
    const A = await org(), B = await org();
    const s = await signedTicketIn(A);
    const officeB = await member(B, ["office"]);
    const beforeLine = await lineState(s.lineId), beforeTicket = await ticketState(s.ticketId), beforeSig = await signatureRows(s.ticketId);
    await expect(callerFor(officeB).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineId, disposition: "disputed", customerStatement: "Not ours" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Ticket ${s.ticketNumber} not found` });
    expect(await lineState(s.lineId)).toEqual(beforeLine);
    expect(await ticketState(s.ticketId)).toEqual(beforeTicket);
    expect(await signatureRows(s.ticketId)).toEqual(beforeSig);
    // The attempt still went through the procedure's authorization audit, like every call.
    const [audit] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM authorizationDecisions WHERE actorUserId = ? AND procedureName = 'closeout.lineDecide'", [officeB]);
    expect(Number(audit[0].n)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("gives no authority for an organization named in the input", async () => {
    const A = await org(), B = await org();
    const s = await signedTicketIn(A);
    const officeB = await member(B, ["office"]);
    for (const claim of [{ orgRef: A }, { organization: A }, { tenantId: A }]) {
      await expect(callerFor(officeB).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineId, disposition: "accepted", ...claim } as never))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await lineState(s.lineId)).disposition).toBe("not_presented");
  }, 60_000);

  it("refuses the historical single tenant on an owned ticket — absence of membership grants nothing", async () => {
    const A = await org();
    const s = await signedTicketIn(A);
    const legacyOffice = await member(null, ["office"]);
    await expect(callerFor(legacyOffice).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineId, disposition: "accepted" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await lineState(s.lineId)).disposition).toBe("not_presented");
  }, 60_000);
});
