/**
 * 0175 CP8 — every customer-facing moment lands on the outbox, once, beside the in-app alert.
 *
 * The delivery channel is whatever subscribes to `domainEventOutbox` (the production worker, the
 * workflow rules, a webhook subscription, later an email or SMS channel); nothing here delivers.
 * What this proves: each hook writes its event in the same transaction as the domain write, under
 * the job's organization, keyed so a retried commit cannot write it twice — and a moment that does
 * not change state (a re-present, a second site_work) writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { enqueueCustomerEvent } from "./_core/customerEvents";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

const DB_URL = process.env.DATABASE_URL;
describe("customer events — preconditions", () => { it("runs against a real database", () => { expect(DB_URL, "DATABASE_URL must be set").toBeTruthy(); }); });

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 661_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const trackingCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-tracking-token": token, "user-agent": "LeaseOS-test/1.0" }, socket: { remoteAddress: "198.51.100.9" } } as never, res: {} as never, user: null as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
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
async function job(orgRef: string) {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress) VALUES (?,?,'Hydrovac excavation','hydrovac','Northgate Energy','10-22-045-06-W5','on_site',0)", [orgRef, jobCode]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return { id: Number(r[0]!.id), jobCode };
}
async function account(orgRef: string) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (orgRef, entityRef, legalName, taxpayerType, jurisdiction, fiscalYearEndMonth, fiscalYearEndDay) VALUES (?,?,'Fixture Co','corporation','AB',12,31)", [orgRef, `ENT-${rnd()}`]);
  const accountRef = `CUST-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [accountRef, e.insertId, `Client ${accountRef}`]);
  const [a] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [accountRef]);
  return { id: Number(a[0]!.id), accountRef, entityId: Number(e.insertId) };
}
/** An approved sell rate for the account, through the commercial setup procedures: $185.00/h. */
async function rate(office: number, controller: number, entityId: number, accountRef: string) {
  const r = await caller(office).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "VAC-HR", pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000, scopeLevel: "customer_contract", customerAccountRef: accountRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "MSA §4" });
  await caller(controller).commercialSetup.definitionApprove({ definitionRef: r.definitionRef });
}
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
async function identity(controller: number, accountRef: string) {
  const inv = await caller(controller).portalAdmin.identityInvite({ kind: "customer", accountRef, email: `${rnd().toLowerCase()}@client.example`, displayName: "M. Johnson" });
  await portalCaller(inv.invitationToken).portal.invitationAccept();
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT identityRef FROM externalIdentities WHERE customerAccountId = (SELECT id FROM customerAccounts WHERE accountRef = ?) ORDER BY id DESC LIMIT 1", [accountRef]);
  return r[0]?.identityRef as string | undefined;
}
type OutboxRow = { eventId: string; eventType: string; aggregateType: string; aggregateId: string; tenantId: string; jobId: string | null; actorSource: string; actorUserId: string | null; payload: Record<string, unknown> };
async function outbox(tenantId: string): Promise<OutboxRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT eventId, eventType, aggregateType, aggregateId, tenantId, jobId, actorSource, actorUserId, payloadJson FROM domainEventOutbox WHERE tenantId = ? AND aggregateType = 'customerJob' ORDER BY id", [tenantId]);
  return rows.map(r => ({ ...(r as Omit<OutboxRow, "payload">), payload: JSON.parse(r.payloadJson as string) as Record<string, unknown> }));
}

d("customer-facing events on the outbox", () => {
  it("writes one event per customer moment — link, on location, ready for review, approved, disputed, document, finalized, invoice, completed — under the job's organization, and nothing for a moment that changed nothing", async () => {
    const A = await org(); const B = await org();
    const office = await member(A, "office"); const controller = await member(A, "controller");
    const jobA = await job(A); const acct = await account(A); const u = await unit(A);
    const identityRef = await identity(controller, acct.accountRef);
    await rate(office, controller, acct.entityId, acct.accountRef);
    const c = caller(office).closeout; const cs = caller(office).clientServices;
    await cs.jobCustomerAssign({ jobId: jobA.id, customerAccountRef: acct.accountRef });   // the job's customer, so a link without a contact still names the account

    // A ticket, on location: the first site_work raises the event; a second site_work does not.
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u, serviceDescription: "Hydrovac excavation" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("10:00") });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("10:30"), endedAt: at("12:00") });
    const l1 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "hour" });

    // Two links: one created and kept, one created and revoked.
    const acting = await cs.trackingLinkCreate({ jobId: jobA.id, livePreset: "manual", scope: { billing: true, act: true }, contactKind: "site_supervisor", contactName: "R. Patel" });
    const spare = await cs.trackingLinkCreate({ jobId: jobA.id, livePreset: "24h" });
    await cs.trackingLinkRevoke({ linkRef: spare.linkRef, reason: "sent to the wrong contact" });

    // Presented once; a re-present that changes nothing raises nothing.
    const presented = await cs.ticketPresent({ ticketNumber: t.ticketNumber });
    expect(presented.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    await cs.ticketPresent({ ticketNumber: t.ticketNumber });

    // Approved by hash, then disputed — two events, each with its action ref.
    const approved = await trackingCaller(acting.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: presented.snapshotHash, representativeName: "R. Patel" });
    const disputed = await trackingCaller(acting.token).tracking.dispute({ ticketNumber: t.ticketNumber, snapshotHash: presented.snapshotHash, representativeName: "R. Patel", comment: "Truck service was 4 h" });
    // A comment and an acknowledgement change no state: no event.
    await trackingCaller(acting.token).tracking.comment({ ticketNumber: t.ticketNumber, representativeName: "R. Patel", comment: "See gate log" });

    // Reopened, corrected, re-presented (a second ready_for_review under a new hash), signed, and a document released.
    await cs.ticketReopen({ ticketNumber: t.ticketNumber, reason: "corrected per gate log" });
    await cs.lineUpdate({ ticketNumber: t.ticketNumber, lineId: l1.lineId, quantity: 4, reason: "gate log" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("12:00") });
    expect(prep.snapshotHash).not.toBe(presented.snapshotHash);
    const signed = await trackingCaller(acting.token).tracking.sign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signerName: "R. Patel", authorities: ["work_confirmation", "time_confirmation"] });
    const bytes = Buffer.from("%PDF-1.4 outbox fixture");
    const key = `tickets/${t.ticketNumber}/R1-${sha(bytes).slice(0, 12)}.pdf`; objects.set(key, bytes);
    const [ft] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]);
    await pool.execute("INSERT INTO fieldTicketDocuments (documentRef, fieldTicketId, kind, storageKey, contentHash, sourceSnapshotHash, byteLength, generatedByUserId, generatedAt) VALUES (?,?,'site_ticket_r1',?,?,?,?,?,NOW())", [`${t.ticketNumber}-R1-PDF`, ft[0]!.id, key, sha(bytes), prep.snapshotHash, bytes.length, office]);
    const [doc] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTicketDocuments WHERE documentRef = ?", [`${t.ticketNumber}-R1-PDF`]);
    const rel = await cs.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(doc[0]!.id), kind: "signed_field_ticket", title: "Signed field ticket R1" });
    expect((await cs.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(doc[0]!.id), kind: "signed_field_ticket" })).alreadyReleased).toBe(true);   // no second event

    // Finalized (accepted by signature), invoiced, sent; the completion package rendered.
    const fin = await cs.ticketFinalize({ ticketNumber: t.ticketNumber });
    expect(fin).toMatchObject({ finalized: true, billingState: "FINALIZED" });
    await c.lineDecide({ ticketNumber: t.ticketNumber, lineId: l1.lineId, disposition: "accepted" });
    const drafted = await caller(office).invoicing.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(drafted.drafted, JSON.stringify(drafted)).toBe(true);
    if (!drafted.drafted) return;
    await pool.execute("UPDATE invoices SET status = 'approved', issuedAt = NOW() WHERE invoiceNumber = ?", [drafted.invoiceNumber]);
    const [inv] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM invoices WHERE invoiceNumber = ?", [drafted.invoiceNumber]);
    const invBytes = Buffer.from("%PDF-1.4 invoice fixture");
    await pool.execute("INSERT INTO fieldTicketDocuments (documentRef, fieldTicketId, invoiceId, kind, storageKey, contentHash, sourceSnapshotHash, byteLength, generatedByUserId, generatedAt) VALUES (?,?,?,'invoice',?,?,?,?,?,NOW())", [`${drafted.invoiceNumber}-PDF`, ft[0]!.id, inv[0]!.id, `invoices/${drafted.invoiceNumber}.pdf`, sha(invBytes), fin.snapshotHash, invBytes.length, office]);
    const sent = await caller(office).invoicing.send({ invoiceNumber: drafted.invoiceNumber });
    expect(sent.status).toBe("sent");
    const pkg = await c.completionPackageRender({ ticketNumber: t.ticketNumber });
    expect((await c.completionPackageRender({ ticketNumber: t.ticketNumber })).alreadyRendered).toBe(true);   // no second event

    // The outbox, in order: one row per moment, all under A, all on this job, actor = the user who acted (system for a customer's act).
    const rows = await outbox(A);
    expect(rows.map(r => [r.eventType, r.aggregateId])).toEqual([
      ["customer.job.on_location", t.ticketNumber],
      ["customer.tracking_link.created", acting.linkRef],
      ["customer.tracking_link.created", spare.linkRef],
      ["customer.tracking_link.revoked", spare.linkRef],
      ["customer.ticket.ready_for_review", t.ticketNumber],
      ["customer.ticket.approved", t.ticketNumber],
      ["customer.ticket.disputed", t.ticketNumber],
      ["customer.ticket.ready_for_review", t.ticketNumber],
      ["customer.document.released", rel.releaseRef],
      ["customer.ticket.finalized", t.ticketNumber],
      ["customer.invoice.issued", drafted.invoiceNumber],
      ["customer.job.completed", t.ticketNumber],
    ]);
    for (const r of rows) { expect(r.tenantId).toBe(A); expect(r.jobId).toBe(String(jobA.id)); expect(r.payload.customerAccountId).toBe(acct.id); expect(r.eventId).toMatch(/^EVT-[0-9a-f]{30}$/); }
    expect(new Set(rows.map(r => r.eventId)).size).toBe(rows.length);
    expect(rows.filter(r => r.eventType === "customer.ticket.ready_for_review").map(r => r.payload.snapshotHash)).toEqual([presented.snapshotHash, prep.snapshotHash]);
    expect(rows.find(r => r.eventType === "customer.ticket.approved")!).toMatchObject({ actorSource: "system", actorUserId: null, payload: { actionRef: approved.actionRef, via: "tracking_link", representativeName: "R. Patel" } });
    expect(rows.find(r => r.eventType === "customer.ticket.disputed")!.payload).toMatchObject({ actionRef: disputed.actionRef });
    expect(rows.find(r => r.eventType === "customer.tracking_link.created")!).toMatchObject({ actorSource: "human", actorUserId: String(office), payload: { contactName: "R. Patel", scope: { act: true, billing: true } } });
    expect(rows.find(r => r.eventType === "customer.tracking_link.revoked")!.payload).toMatchObject({ reason: "sent to the wrong contact" });
    expect(rows.find(r => r.eventType === "customer.document.released")!.payload).toMatchObject({ documentRef: `${t.ticketNumber}-R1-PDF`, kind: "signed_field_ticket", contentHash: sha(bytes) });
    expect(rows.find(r => r.eventType === "customer.ticket.finalized")!.payload).toMatchObject({ documentRef: fin.documentRef, snapshotHash: fin.snapshotHash });
    expect(rows.find(r => r.eventType === "customer.invoice.issued")!.payload).toMatchObject({ totalCents: drafted.subtotalCents, currency: "CAD", documentRef: `${drafted.invoiceNumber}-PDF` });
    expect(rows.find(r => r.eventType === "customer.job.completed")!.payload).toMatchObject({ documentRef: pkg.documentRef, contentHash: pkg.contentHash });
    // Never a secret in the payload: the link's token is handed out once and is not on the outbox.
    for (const r of rows) { expect(JSON.stringify(r.payload)).not.toContain(acting.token); expect(JSON.stringify(r.payload)).not.toContain(spare.token); }
    // The signature itself is not a customer event (it rides the ticket's state change), and B's outbox is untouched.
    expect(signed.documentRef).toBe(`${t.ticketNumber}-R1`);
    expect(await outbox(B)).toEqual([]);

    // The in-app alerts beside the events: the identity on the account was queued the moments it wants by default.
    expect(identityRef).toBeTruthy();
    const [alerts] = await pool.query<mysql.RowDataPacket[]>("SELECT notificationKey, tenantId FROM workflowNotifications WHERE recipientRole = ? ORDER BY id", [`external:${identityRef}`]);
    const kinds = alerts.map(a => (a.notificationKey as string).split(":")[1]);
    for (const k of ["arrival", "work_start", "on_location", "tracking_link_created", "ticket_ready_for_review", "signoff_ready", "document_ready", "billing_update", "invoice_issued", "job_complete"]) expect(kinds, k).toContain(k);
    expect(kinds.filter(k => k === "on_location")).toHaveLength(1);
    expect(kinds.filter(k => k === "ticket_ready_for_review")).toHaveLength(2);   // two hashes, two alerts; the idempotent re-present queued none
    expect(alerts.filter(a => (a.notificationKey as string).includes(":tracking_link_created:")).map(a => a.tenantId)).toEqual([A, A]);
  }, 120_000);

  it("is idempotent per subject: a retried commit finds its own row", async () => {
    const A = await org();
    const db = (await getDb())!;
    const subjectRef = `TL-${rnd()}`;
    const first = await db.transaction(tx => enqueueCustomerEvent(tx, { eventType: "customer.tracking_link.created", tenantId: A, subjectRef, jobId: 1 }));
    const again = await db.transaction(tx => enqueueCustomerEvent(tx, { eventType: "customer.tracking_link.created", tenantId: A, subjectRef, jobId: 1, payload: { changed: true } }));
    const other = await db.transaction(tx => enqueueCustomerEvent(tx, { eventType: "customer.tracking_link.created", tenantId: A, subjectRef, occurrence: "2", jobId: 1 }));
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ eventId: first.eventId, duplicate: true });
    expect(other.duplicate).toBe(false);
    expect(other.eventId).not.toBe(first.eventId);
    const rows = await outbox(A);
    expect(rows.map(r => r.eventId)).toEqual([first.eventId, other.eventId]);
    expect(rows[0]!.payload).toEqual({ subjectRef, customerAccountId: null });   // the first write stands; the retry changed nothing
  });
});
