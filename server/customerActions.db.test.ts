/**
 * 0175 CP6 — what a customer does through a tracking link is a record, never a page visit.
 *
 * Acknowledge, approve (by hash), dispute (with a statement), comment and sign, through the gate,
 * against the database. Each lands as an append-only action row and a ledger entry that carries the
 * link and the hashed client address; approve and dispute move the billing state; a signature goes
 * through the canonical signature chain as `portal_link`. A read never writes an action; a stale
 * hash is refused; a link without the `act` scope is refused by name; a link on another job cannot
 * reach this ticket by number.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
describe("customer actions — preconditions", () => { it("runs against a real database", () => { expect(DB_URL, "DATABASE_URL must be set").toBeTruthy(); }); });

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 658_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const trackingCaller = (token: string, ip = "198.51.100.7") => appRouter.createCaller({ req: { headers: { "x-tracking-token": token, "user-agent": "LeaseOS-test/1.0" }, socket: { remoteAddress: ip } } as never, res: {} as never, user: null as never });
const at = (hhmm: string, day = "2026-09-24") => new Date(`${day}T${hhmm}:00Z`);

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
async function unit(orgRef: string) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}

d("customer actions through a tracking link", () => {
  it("records acknowledgement, approval by hash, dispute, comment and signature — each audited, none from a page visit", async () => {
    const A = await org(); const B = await org();
    const office = await member(A, "office"); const officeB = await member(B, "office");
    const jobA = await job(A); const jobB = await job(B); const acct = await account(A); const u = await unit(A);
    const c = caller(office).closeout; const cs = caller(office).clientServices;
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u, serviceDescription: "Hydrovac excavation" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") });
    await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "hour" });
    const acting = await cs.trackingLinkCreate({ jobId: jobA.id, livePreset: "manual", scope: { billing: true, act: true }, contactKind: "site_supervisor", contactName: "R. Patel" });
    const readOnly = await cs.trackingLinkCreate({ jobId: jobA.id, livePreset: "manual", scope: { billing: true } });
    const otherJob = await caller(officeB).clientServices.trackingLinkCreate({ jobId: jobB.id, livePreset: "manual", scope: { billing: true, act: true } });

    // (1) Reading the ticket writes no action.
    const before = await trackingCaller(acting.token).tracking.openTicket();
    expect(before.tickets[0]!.actions).toEqual({ acknowledge: true, approve: false, dispute: false, comment: true, sign: false });
    expect((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM customerTicketActions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?)", [t.ticketNumber]))[0][0]!.n).toBe(0);

    // (2) A link without `act` is refused by name; a link on another job cannot reach this ticket by number.
    await expect(trackingCaller(readOnly.token).tracking.acknowledge({ ticketNumber: t.ticketNumber, representativeName: "R. Patel" })).rejects.toThrow(/does not permit act/);
    await expect(trackingCaller(otherJob.token).tracking.acknowledge({ ticketNumber: t.ticketNumber, representativeName: "Intruder" })).rejects.toThrow(/No such ticket on this job/);
    await expect(trackingCaller(otherJob.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: "0".repeat(64), representativeName: "Intruder" })).rejects.toThrow(/No such ticket on this job/);

    // (3) Acknowledge: a row and a ledger entry, no state change.
    const ack = await trackingCaller(acting.token).tracking.acknowledge({ ticketNumber: t.ticketNumber, representativeName: "R. Patel", representativeTitle: "Site supervisor" });
    expect(ack).toMatchObject({ kind: "acknowledge", billingState: "OPEN" });
    expect(ack.actionRef).toMatch(/^CTA-/);

    // (4) Approve before presentation is refused; after presentation a stale hash is refused; the right hash accepts and stores the PO.
    await expect(trackingCaller(acting.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: ack.snapshotHash, representativeName: "R. Patel" })).rejects.toThrow(/not awaiting your review/);
    const presented = await cs.ticketPresent({ ticketNumber: t.ticketNumber });
    expect(presented.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "standby", description: "Standby", quantity: 1, quantityUnit: "hour" });   // changes the hash
    await expect(trackingCaller(acting.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: presented.snapshotHash, representativeName: "R. Patel" })).rejects.toThrow(/changed since you reviewed it/);
    const current = (await trackingCaller(acting.token).tracking.openTicket()).tickets[0]!.snapshotHash!;
    await expect(trackingCaller(acting.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: current, representativeName: "   " })).rejects.toThrow(/names the representative/);
    const approved = await trackingCaller(acting.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: current, representativeName: "R. Patel", representativeTitle: "Site supervisor", customerPoNumber: "PO-4500123", comment: "Approved as presented" });
    expect(approved).toMatchObject({ kind: "approve", billingState: "CUSTOMER_ACCEPTED", snapshotHash: current });
    expect((await pool.query<mysql.RowDataPacket[]>("SELECT customerPoNumber, billingState FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]))[0][0]).toMatchObject({ customerPoNumber: "PO-4500123", billingState: "CUSTOMER_ACCEPTED" });

    // (5) Dispute after acceptance: needs a statement; moves to DISPUTED. Comment: a row, no state change.
    await expect(trackingCaller(acting.token).tracking.dispute({ ticketNumber: t.ticketNumber, representativeName: "R. Patel", comment: "" })).rejects.toThrow();
    const disputed = await trackingCaller(acting.token).tracking.dispute({ ticketNumber: t.ticketNumber, snapshotHash: current, representativeName: "R. Patel", comment: "Standby was 30 min, not 1 h — gate log attached" });
    expect(disputed).toMatchObject({ kind: "dispute", billingState: "DISPUTED" });
    const commented = await trackingCaller(acting.token).tracking.comment({ ticketNumber: t.ticketNumber, representativeName: "R. Patel", comment: "Please send the gate log with the revised ticket." });
    expect(commented).toMatchObject({ kind: "comment", billingState: "DISPUTED" });

    // (6) The action rows: kind, actor kind, link, representative, PO, hashed address (never the address), user agent.
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT a.kind, a.actorKind, a.representativeName, a.customerPoNumber, a.comment, a.ipHash, a.userAgent, l.linkRef FROM customerTicketActions a JOIN jobTrackingLinks l ON l.id = a.trackingLinkId WHERE a.fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) ORDER BY a.id", [t.ticketNumber]);
    expect(rows.map(r => [r.kind, r.actorKind, r.representativeName, r.linkRef])).toEqual([["acknowledge", "tracking_link", "R. Patel", acting.linkRef], ["approve", "tracking_link", "R. Patel", acting.linkRef], ["dispute", "tracking_link", "R. Patel", acting.linkRef], ["comment", "tracking_link", "R. Patel", acting.linkRef]]);
    expect(rows[1]!.customerPoNumber).toBe("PO-4500123");
    for (const r of rows) { expect(r.ipHash).toMatch(/^[0-9a-f]{64}$/); expect(r.userAgent).toBe("LeaseOS-test/1.0"); expect(JSON.stringify(r)).not.toContain("198.51.100.7"); }

    // (7) Reopened and re-presented by the office after the dispute, then signed from the link through the canonical chain.
    await cs.ticketReopen({ ticketNumber: t.ticketNumber, reason: "standby corrected per gate log" });
    await cs.lineUpdate({ ticketNumber: t.ticketNumber, lineId: (await cs.ticketBilling({ ticketNumber: t.ticketNumber })).lines.find(l => l.description === "Standby")!.id, quantity: 0.5, reason: "gate log" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("12:00") });
    expect(prep.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    await expect(trackingCaller(readOnly.token).tracking.sign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signerName: "R. Patel", authorities: ["work_confirmation"] })).rejects.toThrow(/does not permit act/);
    await expect(trackingCaller(acting.token).tracking.sign({ ticketNumber: t.ticketNumber, snapshotHash: "1".repeat(64), signerName: "R. Patel", authorities: ["work_confirmation"] })).rejects.toThrow(/changed between review and signature/);
    const signed = await trackingCaller(acting.token).tracking.sign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signerName: "R. Patel", signerTitle: "Site supervisor", authorities: ["work_confirmation", "time_confirmation"] });
    expect(signed).toMatchObject({ documentRef: `${t.ticketNumber}-R1`, revision: 1, withinAuthority: "unknown" });   // no signatory on file for this link: exercised, marked unknown, never assumed
    const [sig] = await pool.query<mysql.RowDataPacket[]>("SELECT signatureMethod, signerName, result, externalIdentityId FROM fieldTicketSignatures WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?)", [t.ticketNumber]);
    expect(sig[0]).toMatchObject({ signatureMethod: "portal_link", signerName: "R. Patel", result: "accepted", externalIdentityId: null });
    const b = await cs.ticketBilling({ ticketNumber: t.ticketNumber });
    expect(b.billingState).toBe("CUSTOMER_ACCEPTED");
    expect(b.actions.map(a => a.kind)).toEqual(["acknowledge", "approve", "dispute", "comment", "sign"]);
    expect(b.actions[4]).toMatchObject({ actorKind: "tracking_link", representativeName: "R. Patel", snapshotHash: prep.snapshotHash });
    // A second signature is a new revision, not a second signature.
    await expect(trackingCaller(acting.token).tracking.sign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signerName: "R. Patel", authorities: ["work_confirmation"] })).rejects.toThrow(/already signed/);

    // (8) The ledger: every action, with the link and the hashed address, in order; the chain verifies; B's is untouched.
    const trail = (await cs.auditTrail({ jobId: jobA.id })).events.reverse();
    const customerEvents = trail.filter(e => e.trackingLinkId != null && e.eventType.startsWith("customer_")).map(e => e.eventType);
    expect(customerEvents).toEqual(["customer_ticket_viewed", "customer_acknowledgement", "customer_ticket_viewed", "customer_approval", "customer_dispute", "customer_comment", "customer_signature"]);   // the second view read the current hash before approving
    expect(trail.find(e => e.eventType === "customer_approval")!.payload).toMatchObject({ representativeName: "R. Patel", customerPoNumber: "PO-4500123", snapshotHash: current, via: "tracking_link" });
    expect(trail.find(e => e.eventType === "customer_dispute")!.payload).toMatchObject({ comment: "Standby was 30 min, not 1 h — gate log attached" });
    expect(await cs.auditVerify()).toMatchObject({ ok: true });
    expect((await caller(officeB).clientServices.auditTrail({ jobId: jobB.id })).events.map(e => e.eventType)).toEqual(["tracking_link_created"]);

    // (9) The link's own access log counted every act, allowed and refused.
    const [access] = await pool.query<mysql.RowDataPacket[]>("SELECT action, outcome FROM jobTrackingLinkAccess WHERE linkId = (SELECT id FROM jobTrackingLinks WHERE linkRef = ?) ORDER BY id", [readOnly.linkRef]);
    expect(access.map(a => [a.action, a.outcome])).toEqual([["tracking.acknowledge", "denied"], ["tracking.sign", "denied"]]);
  }, 90_000);

  it("refuses an action on a closed ticket and never on a voided one, and a revoked link cannot act", async () => {
    const A = await org();
    const office = await member(A, "office");
    const jobA = await job(A); const acct = await account(A); const u = await unit(A);
    const c = caller(office).closeout; const cs = caller(office).clientServices;
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u });
    await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "note", quantity: 1, quantityUnit: "each" });
    const link = await cs.trackingLinkCreate({ jobId: jobA.id, livePreset: "manual", scope: { billing: true, act: true } });
    await cs.ticketPresent({ ticketNumber: t.ticketNumber });
    const hash = (await trackingCaller(link.token).tracking.openTicket()).tickets[0]!.snapshotHash!;
    await trackingCaller(link.token).tracking.approve({ ticketNumber: t.ticketNumber, snapshotHash: hash, representativeName: "R. Patel" });
    await cs.ticketFinalize({ ticketNumber: t.ticketNumber });
    await expect(trackingCaller(link.token).tracking.acknowledge({ ticketNumber: t.ticketNumber, representativeName: "R. Patel" })).rejects.toThrow(/closed/);
    await expect(trackingCaller(link.token).tracking.comment({ ticketNumber: t.ticketNumber, comment: "late" })).rejects.toThrow(/closed/);
    await expect(trackingCaller(link.token).tracking.dispute({ ticketNumber: t.ticketNumber, representativeName: "R. Patel", comment: "too late" })).rejects.toThrow(/cannot be disputed now/);
    const t2 = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u });
    await cs.ticketVoid({ ticketNumber: t2.ticketNumber, reason: "opened in error" });
    await expect(trackingCaller(link.token).tracking.acknowledge({ ticketNumber: t2.ticketNumber, representativeName: "R. Patel" })).rejects.toThrow(/No such ticket on this job/);
    await cs.trackingLinkRevoke({ linkRef: link.linkRef, reason: "done" });
    await expect(trackingCaller(link.token).tracking.comment({ ticketNumber: t.ticketNumber, comment: "x" })).rejects.toThrow(/revoked/);
  }, 60_000);
});
