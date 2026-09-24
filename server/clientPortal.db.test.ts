/**
 * 0175 CP7 — the authenticated client portal, through the external gate, against the database.
 *
 * Two customer accounts in organization A, each with a portal identity, and a job in organization B.
 * A1 sees the job assigned to it and the job a ticket bills to it, and nothing else; A2 sees neither
 * of A1's; a job reference from another account is "no such job on this account"; documents released on
 * A1's job download for A1 and are "not found" for A2; the dashboard counts what waits on the customer;
 * approval through the portal lands as a portal-identity action; contacts list only the account's people.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { appRouter } from "./routers";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

const DB_URL = process.env.DATABASE_URL;
describe("client portal — preconditions", () => { it("runs against a real database", () => { expect(DB_URL, "DATABASE_URL must be set").toBeTruthy(); }); });

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 659_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
// Yesterday, so an ended event is in the past whatever the container clock says.
const at = (hhmm: string, day = "2026-09-23") => new Date(`${day}T${hhmm}:00Z`);

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, role: string) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function job(orgRef: string, status = "on_site") {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'Hydrovac excavation','hydrovac','Northgate Energy','10-22-045-06-W5',?,0)", [orgRef, jobCode, status]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return { id: Number(r[0]!.id), jobCode };
}
async function account(orgRef: string, locationSharing = "none") {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (orgRef, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,'Fixture Co','corporation','AB',12,31)", [orgRef, `ENT-${rnd()}`]);
  const accountRef = `CUST-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, locationSharing) VALUES (?,?,?,?)", [accountRef, e.insertId, `Client ${accountRef}`, locationSharing]);
  const [a] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [accountRef]);
  return { id: Number(a[0]!.id), accountRef, entityId: Number(e.insertId) };
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
/** A portal identity on an account: invited by the controller, accepted once; the bearer token is what the portal uses. */
async function identity(controller: number, accountRef: string, name: string) {
  const inv = await caller(controller).portalAdmin.identityInvite({ kind: "customer", accountRef, email: `${rnd().toLowerCase()}@client.example`, displayName: name });
  return (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;
}

d("the authenticated client portal", () => {
  it("shows an identity only its account's jobs, tickets, documents and people — and none of another account's", async () => {
    const A = await org(); const B = await org();
    const office = await member(A, "office"); const controller = await member(A, "controller"); const officeB = await member(B, "office");
    const a1 = await account(A, "approximate"); const a2 = await account(A);
    const assigned = await job(A); const ticketed = await job(A); const scheduled = await job(A, "dispatched"); const other = await job(A); const jobB = await job(B);
    const u = await unit(A);
    await caller(office).clientServices.jobCustomerAssign({ jobId: assigned.id, customerAccountRef: a1.accountRef });
    await caller(office).clientServices.jobCustomerAssign({ jobId: scheduled.id, customerAccountRef: a1.accountRef });
    await caller(office).clientServices.jobCustomerAssign({ jobId: other.id, customerAccountRef: a2.accountRef });
    await pool.execute("INSERT INTO dispatchPostings (postingNumber, jobId, planningState, priority, crewSize, scheduledStart) VALUES (?,?,'staffed','normal',1,?)", [`POST-${rnd()}`, scheduled.id, new Date(Date.now() + 2 * 86_400_000)]);   // the day after tomorrow, whatever day it is
    // A ticket billing to a1 on a job that was never assigned: reachable through the ticket.
    const c = caller(office).closeout;
    const t = await c.ticketOpen({ jobId: ticketed.id, customerAccountRef: a1.accountRef, unitId: u, serviceDescription: "Hydrovac excavation" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") });
    const l1 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", description: "Truck service", quantity: 4.5, quantityUnit: "hour" });
    await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "Internal cost basis", quantity: 1, quantityUnit: "each", customerVisible: false });
    await caller(office).clientServices.ticketPresent({ ticketNumber: t.ticketNumber });
    // A trip with a fresh breadcrumb on the assigned job.
    const [trip] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, jobId, unitId, status, startedAt) VALUES (?,?,?,'in_transit',?)", [`T-${rnd()}`, assigned.id, u, at("06:40")]);
    await pool.execute("INSERT INTO tripBreadcrumbs (tripId, unitId, latitude, longitude, speedKmh, headingDegrees, source, recordedAt) VALUES (?,?,53.123456,-116.654321,80,90,'gps',?)", [trip.insertId, u, new Date(Date.now() - 3 * 60_000)]);
    // A document released on the ticketed job.
    const bytes = Buffer.from("%PDF-1.4 client portal fixture");
    const key = `tickets/${t.ticketNumber}/R1-${sha(bytes).slice(0, 12)}.pdf`; objects.set(key, bytes);
    const [ft] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]);
    await pool.execute("INSERT INTO fieldTicketDocuments (documentRef, fieldTicketId, kind, storageKey, contentHash, sourceSnapshotHash, byteLength, generatedByUserId, generatedAt) VALUES (?,?,'site_ticket_r1',?,?,?,?,?,NOW())", [`${t.ticketNumber}-R1-PDF`, ft[0]!.id, key, sha(bytes), "s".repeat(64), bytes.length, office]);
    const [doc] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTicketDocuments WHERE documentRef = ?", [`${t.ticketNumber}-R1-PDF`]);
    const rel = await caller(office).clientServices.documentRelease({ jobId: ticketed.id, sourceType: "fieldTicketDocument", sourceId: Number(doc[0]!.id), kind: "signed_field_ticket", title: "Signed field ticket R1" });
    // A link with a named contact on the assigned job, and a signatory on file.
    await caller(office).clientServices.trackingLinkCreate({ jobId: assigned.id, contactKind: "consultant", contactName: "K. Osei", contactPhone: "780-555-0177" });
    await pool.execute("INSERT INTO signatoryAuthorities (authorityRef, customerAccountId, signatoryName, signatoryRole, recordedByUserId) VALUES (?,?,'R. Patel','Site supervisor',?)", [`AUTH-${rnd()}`, a1.id, office]);

    const tok1 = await identity(controller, a1.accountRef, "M. Johnson");
    const tok2 = await identity(controller, a2.accountRef, "P. Singh");
    const p1 = portalCaller(tok1).portal; const p2 = portalCaller(tok2).portal;

    // (1) Jobs: a1 sees the assigned, the ticketed and the scheduled job; a2 sees only its own; nobody sees B's.
    const jobs1 = await p1.clientJobs({ bucket: "all" });
    expect(jobs1.jobs.map(j => j.jobReference).sort()).toEqual([assigned.jobCode, scheduled.jobCode, ticketed.jobCode].sort());
    expect(jobs1.jobs.find(j => j.jobReference === scheduled.jobCode)!.bucket).toBe("scheduled");
    expect(jobs1.jobs.find(j => j.jobReference === ticketed.jobCode)!.status.label).toBe("On Location");
    expect((await p1.clientJobs({ bucket: "scheduled" })).jobs.map(j => j.jobReference)).toEqual([scheduled.jobCode]);
    expect((await p2.clientJobs({ bucket: "all" })).jobs.map(j => j.jobReference)).toEqual([other.jobCode]);
    const text = JSON.stringify(jobs1);
    for (const forbidden of [other.jobCode, jobB.jobCode, String(assigned.id), "Internal cost basis"]) expect(text, forbidden).not.toContain(forbidden);

    // (2) Job detail: by reference, scoped; another account's reference is "no such job on this account"; location follows the account's setting.
    const detail = await p1.clientJob({ jobReference: assigned.jobCode });
    expect(detail).toMatchObject({ jobReference: assigned.jobCode, unit: { unitNumber: expect.any(String) }, location: { mode: "approximate", position: { latitude: 53.12, longitude: -116.65, precision: "approximate" }, stale: false }, live: { available: true } });
    expect((await p2.clientJob({ jobReference: other.jobCode })).location.mode).toBe("none");
    await expect(p2.clientJob({ jobReference: assigned.jobCode })).rejects.toThrow(/No such job on this account/);
    await expect(p1.clientJob({ jobReference: jobB.jobCode })).rejects.toThrow(/No such job on this account/);
    await expect(p1.clientJobLoads({ jobReference: other.jobCode })).rejects.toThrow(/No such job on this account/);
    expect((await p1.clientJobLoads({ jobReference: assigned.jobCode })).total).toBe(0);

    // (3) Tickets: a1's ticket with the internal line hidden and the estimate labelled; a2 has none.
    const tickets1 = await p1.clientTickets();
    expect(tickets1.tickets.map(x => [x.jobReference, x.ticketNumber, x.status])).toEqual([[ticketed.jobCode, t.ticketNumber, "AWAITING_CUSTOMER_REVIEW"]]);
    expect(tickets1.tickets[0]!.lines.map(l => l.description)).toEqual(["Truck service"]);
    expect(JSON.stringify(tickets1)).not.toContain("Internal cost basis");
    expect((await p2.clientTickets()).tickets).toEqual([]);

    // (4) Dashboard: what waits on the customer.
    const dash = await p1.clientDashboard();
    expect(dash).toMatchObject({ jobs: { active: 2, scheduled: 1, completed: 0, total: 3 }, awaitingCustomerAction: 1, openTickets: 1, invoices: { outstanding: 0, outstandingCents: 0, disputed: 0 } });
    expect(dash.recentDocuments.map(x => [x.documentRef, x.jobReference])).toEqual([[`${t.ticketNumber}-R1-PDF`, ticketed.jobCode]]);
    expect((await p2.clientDashboard()).jobs).toEqual({ active: 1, scheduled: 0, completed: 0, total: 1 });

    // (5) Actions through the portal: approve by hash as a portal identity; a2 cannot touch a1's ticket.
    await expect(p2.clientTicketAct({ ticketNumber: t.ticketNumber, kind: "acknowledge" })).rejects.toThrow(/No such ticket on this account/);
    const hash = tickets1.tickets[0]!.snapshotHash!;
    await expect(p1.clientTicketAct({ ticketNumber: t.ticketNumber, kind: "approve", snapshotHash: "0".repeat(64) })).rejects.toThrow(/changed since you reviewed it/);
    const approved = await p1.clientTicketAct({ ticketNumber: t.ticketNumber, kind: "approve", snapshotHash: hash, customerPoNumber: "PO-778" });
    expect(approved).toMatchObject({ kind: "approve", billingState: "CUSTOMER_ACCEPTED" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT kind, actorKind, representativeName, customerPoNumber, externalIdentityId FROM customerTicketActions WHERE fieldTicketId = ?", [ft[0]!.id]);
    expect(rows.map(r => [r.kind, r.actorKind, r.representativeName, r.customerPoNumber])).toEqual([["approve", "portal_identity", "M. Johnson", "PO-778"]]);
    expect(rows[0]!.externalIdentityId).not.toBeNull();
    await expect(p1.clientTicketDispute({ ticketNumber: t.ticketNumber, comment: "Truck arrived 30 min late" })).resolves.toMatchObject({ kind: "dispute", billingState: "DISPUTED" });
    expect(l1.lineId).toBeGreaterThan(0);

    // (6) Documents: released ones on the account's jobs; download after the hash check; a2 gets "not found".
    const docs1 = await p1.clientDocuments();
    expect(docs1.documents.map(x => [x.releaseRef, x.jobReference])).toEqual([[rel.releaseRef, ticketed.jobCode]]);
    const dl = await p1.clientDocumentDownload({ releaseRef: rel.releaseRef });
    expect(Buffer.from(dl.dataBase64, "base64").equals(bytes)).toBe(true);
    expect((await p2.clientDocuments()).documents).toEqual([]);
    await expect(p2.clientDocumentDownload({ releaseRef: rel.releaseRef })).rejects.toThrow(/Document not found/);
    await caller(office).clientServices.documentWithdraw({ releaseRef: rel.releaseRef, reason: "wrong revision" });
    await expect(p1.clientDocumentDownload({ releaseRef: rel.releaseRef })).rejects.toThrow(/Document not found/);

    // (7) Contacts: the account's portal users, signatories and job contacts; nothing of a2's.
    const contacts = await p1.clientContacts();
    expect(contacts.portalUsers.map(x => [x.displayName, x.you])).toEqual([["M. Johnson", true]]);
    expect(contacts.signatories.map(x => x.name)).toEqual(["R. Patel"]);
    expect(contacts.jobContacts).toEqual([{ jobReference: assigned.jobCode, kind: "consultant", name: "K. Osei", email: null, phone: "780-555-0177" }]);
    expect(JSON.stringify(await p2.clientContacts())).not.toContain("K. Osei");

    // (8) B's office cannot see A's ledger of these actions; A's ledger carries the portal identity.
    const trail = (await caller(office).clientServices.auditTrail({ jobId: ticketed.id })).events;
    expect(trail.filter(e => e.externalIdentityId != null).map(e => e.eventType).reverse()).toEqual(["customer_approval", "customer_dispute", "customer_document_downloaded"]);
    await expect(caller(officeB).clientServices.auditTrail({ jobId: ticketed.id })).rejects.toThrow(/not found/i);
    // A portal identity without a token, or a vendor identity, reaches none of it.
    await expect(portalCaller("nope").portal.clientDashboard()).rejects.toThrow(/Unknown portal token/);
  }, 120_000);
});
