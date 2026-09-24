/**
 * 0175 CP5 — the open-ticket billing lifecycle, stored.
 *
 * One ticket walks the whole life through the real routers: opened, lines accrue (priced through the
 * rate engine), presented, accepted by signature, finalized behind a hash, amended beside the frozen
 * revision, invoiced. Along the way: concurrent line writes are serialized and counted; a stale
 * version is refused; a frozen ticket refuses edits; tenant B can touch none of it; every step is on
 * the ledger and the chain verifies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
describe("open-ticket billing — preconditions", () => { it("runs against a real database", () => { expect(DB_URL, "DATABASE_URL must be set").toBeTruthy(); }); });

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 657_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const at = (hhmm: string, day = "2026-09-24") => new Date(`${day}T${hhmm}:00Z`);

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 12 }); });
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
/** An approved sell rate for the account, through the commercial setup procedures: $185.00/h, priced per hour. */
async function rate(office: number, controller: number, entityId: number, accountRef: string, serviceCode = "VAC-HR", rateMillis = 185_000) {
  const r = await caller(office).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode, pricingMethod: "per_unit", unit: "hour", rateMillis, scopeLevel: "customer_contract", customerAccountRef: accountRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "MSA §4" });
  await caller(controller).commercialSetup.definitionApprove({ definitionRef: r.definitionRef });
}
const ledger = async (office: number, jobId: number) => (await caller(office).clientServices.auditTrail({ jobId })).events.map(e => e.eventType).reverse();

d("the open-ticket billing lifecycle", () => {
  it("accrues, presents, is accepted by signature, finalizes behind a hash, amends beside the frozen revision, and invoices — every step audited", async () => {
    const A = await org(); const B = await org();
    const office = await member(A, "office"); const controller = await member(A, "controller"); const officeB = await member(B, "office");
    const jobA = await job(A); const acct = await account(A); const u = await unit(A);
    await rate(office, controller, acct.entityId, acct.accountRef);
    const c = caller(office).closeout;
    const cs = caller(office).clientServices;

    // DRAFT until work starts.
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u, serviceDescription: "Hydrovac excavation" });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("DRAFT");
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00"), source: "pto", confidence: "high" });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("OPEN");

    // Lines accrue and are priced as recorded; the version moves with each; internal-only lines stay internal.
    const l1 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "hour", measurementMethod: "system_timed" });
    expect(l1).toMatchObject({ billingVersion: 2, billingState: "OPEN", pricing: { outcome: "priced", amountCents: 83_250 } });
    const l2 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "Internal fuel basis — cost 41.10/h", quantity: 1, quantityUnit: "each", customerVisible: false, expectedVersion: 2 });
    expect(l2.billingVersion).toBe(3);
    // A stale version is refused; nothing is written.
    await expect(c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "standby", description: "Standby", quantity: 1, quantityUnit: "hour", expectedVersion: 2 })).rejects.toThrow(/changed since you read it \(version 2 → 3\)/);
    const b1 = await cs.ticketBilling({ ticketNumber: t.ticketNumber });
    expect(b1.lines).toHaveLength(2);
    expect(b1.totals).toMatchObject({ subtotalCents: 83_250, customerSubtotalCents: 83_250, pricedLines: 1, unpricedLines: 1, visibleLines: 1 });
    // A line changed by the office is re-priced and audited before/after.
    const upd = await cs.lineUpdate({ ticketNumber: t.ticketNumber, lineId: l1.lineId, expectedVersion: 3, quantity: 5, reason: "clock corrected from PTO log" });
    expect(upd).toMatchObject({ billingVersion: 4, repriced: { outcome: "priced", amountCents: 92_500 } });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).totals.customerSubtotalCents).toBe(92_500);

    // B cannot read, present, finalize or void A's ticket.
    for (const attempt of [
      () => caller(officeB).clientServices.ticketBilling({ ticketNumber: t.ticketNumber }),
      () => caller(officeB).clientServices.ticketPresent({ ticketNumber: t.ticketNumber }),
      () => caller(officeB).clientServices.ticketFinalize({ ticketNumber: t.ticketNumber }),
      () => caller(officeB).clientServices.ticketVoid({ ticketNumber: t.ticketNumber, reason: "intrusion attempt" }),
      () => caller(officeB).clientServices.lineUpdate({ ticketNumber: t.ticketNumber, lineId: l1.lineId, quantity: 99 }),
    ]) await expect(attempt()).rejects.toThrow(/not found/i);

    // Presented: the customer reviews under the hash; a further line is allowed but changes the hash.
    const presented = await cs.ticketPresent({ ticketNumber: t.ticketNumber, customerPoNumber: "PO-4500123" });
    expect(presented.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    await expect(cs.ticketFinalize({ ticketNumber: t.ticketNumber })).resolves.toMatchObject({ finalized: false, refusals: [expect.stringMatching(/customer has not accepted/)] });
    const l3 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "standby", serviceCode: "VAC-HR", description: "Standby", quantity: 1, quantityUnit: "hour" });
    expect(l3.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    const presented2 = await cs.ticketPresent({ ticketNumber: t.ticketNumber });
    expect(presented2.snapshotHash).not.toBe(presented.snapshotHash);

    // The site is prepared and signed with full authority: the signature accepts the open ticket.
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("12:00") });
    expect(prep.billingState).toBe("AWAITING_CUSTOMER_REVIEW");
    await pool.execute("INSERT INTO signatoryAuthorities (authorityRef, customerAccountId, signatoryName, mayConfirmWork, maySignTicket, mayApproveStandby, recordedByUserId) VALUES (?,?,?,1,1,1,?)", [`AUTH-${rnd()}`, acct.id, "R. Patel", office]);
    const signed = await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "R. Patel", company: "Northgate Energy", role: "Site supervisor" }, method: "drawn", authorities: ["work_confirmation", "time_confirmation", "standby_approval"], extraWorkCents: 0, offline: false });
    expect(signed.refused).toEqual([]);
    const b2 = await cs.ticketBilling({ ticketNumber: t.ticketNumber });
    expect(b2.billingState).toBe("CUSTOMER_ACCEPTED");
    expect(b2.actions.map(a => [a.kind, a.actorKind, a.representativeName, a.snapshotHash === prep.snapshotHash])).toEqual([["sign", "internal_user", "R. Patel", true]]);
    // Accepted: a line write is refused until reopened.
    await expect(c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "late", quantity: 1, quantityUnit: "each" })).rejects.toThrow(/signed|reopen/);
    await expect(cs.lineUpdate({ ticketNumber: t.ticketNumber, lineId: l1.lineId, description: "edited" })).rejects.toThrow(/reopen it before changing a line/);

    // Finalized: a `final` revision with a hash; the lines are frozen.
    const fin = await cs.ticketFinalize({ ticketNumber: t.ticketNumber });
    expect(fin).toMatchObject({ finalized: true, alreadyFinalized: false, billingState: "FINALIZED", documentRef: `${t.ticketNumber}-R2`, totals: { customerSubtotalCents: 111_000, internalCents: 0, pricedLines: 2, unpricedLines: 1 } });
    expect(fin.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await cs.ticketFinalize({ ticketNumber: t.ticketNumber })).alreadyFinalized).toBe(true);
    await expect(cs.lineUpdate({ ticketNumber: t.ticketNumber, lineId: l1.lineId, quantity: 1 })).rejects.toThrow(/an amendment, never an edit/);
    await expect(cs.ticketReopen({ ticketNumber: t.ticketNumber, reason: "try" })).rejects.toThrow(/cannot be reopened/);
    // The frozen bytes: the revision's hash still matches its content, and nothing changed the row.
    const [rev] = await pool.query<mysql.RowDataPacket[]>("SELECT snapshotJson, snapshotHash, kind FROM fieldTicketRevisions WHERE documentRef = ?", [`${t.ticketNumber}-R2`]);
    expect(rev[0]!.kind).toBe("final");
    const frozen = JSON.parse(rev[0]!.snapshotJson as string) as { lines: { id: number; amountCents: number | null }[]; billing: { customerSubtotalCents: number } };
    expect(frozen.lines.map(l => l.amountCents)).toEqual([92_500, null, 18_500]);

    // Amended: a new line beside the frozen ones and an `amendment` revision superseding the final; the final is untouched.
    const amend = await cs.ticketAmend({ ticketNumber: t.ticketNumber, reason: "standby over-counted; credit 0.5 h", lineKind: "standby", serviceCode: "VAC-HR", description: "Standby correction", quantity: -0.5, quantityUnit: "hour", amendsLineId: l3.lineId });
    expect(amend).toMatchObject({ documentRef: `${t.ticketNumber}-R3`, supersedesRevisionHash: fin.snapshotHash, totals: { customerSubtotalCents: 101_750, amendmentLines: 1 } });
    const [after] = await pool.query<mysql.RowDataPacket[]>("SELECT snapshotHash, snapshotJson FROM fieldTicketRevisions WHERE documentRef = ?", [`${t.ticketNumber}-R2`]);
    expect(after[0]!.snapshotHash).toBe(fin.snapshotHash);
    expect(after[0]!.snapshotJson).toBe(rev[0]!.snapshotJson);
    const b3 = await cs.ticketBilling({ ticketNumber: t.ticketNumber });
    expect(b3.billingState).toBe("FINALIZED");
    expect(b3.revisions.map(r => [r.revision, r.kind, r.supersedesRevisionId != null])).toEqual([[1, "site_signed", false], [2, "final", false], [3, "amendment", true]]);
    expect(b3.lines.find(l => l.amendsLineId === l3.lineId)).toMatchObject({ amountCents: -9_250 });

    // Invoiced through the existing invoicing path: the lines the customer accepted draft an invoice; the ticket reads INVOICED.
    // Every line is decided (the invoice path refuses an undecided line); the internal note is accepted and then excluded as "not a charge".
    for (const lineId of [l1.lineId, l2.lineId, l3.lineId, amend.lineId]) await caller(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId, disposition: "accepted" });
    const drafted = await caller(office).invoicing.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(drafted, JSON.stringify(drafted)).toMatchObject({ drafted: true, lines: 3, subtotalCents: 101_750 });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("INVOICED");
    await expect(cs.ticketAmend({ ticketNumber: t.ticketNumber, reason: "late fix", lineKind: "other", description: "x" })).rejects.toThrow(/a credit against the invoice/);
    await expect(cs.ticketVoid({ ticketNumber: t.ticketNumber, reason: "cannot void invoiced" })).rejects.toThrow(/cannot be voided/);
    // Voiding the invoice returns the ticket to FINALIZED, audited. A draft invoice is never voided (that is the
    // existing rule), so the fixture stands the invoice up as issued the way `invoicing.finalize` would.
    if (drafted.drafted) {
      await pool.execute("UPDATE invoices SET status = 'approved', issuedAt = NOW() WHERE invoiceNumber = ?", [drafted.invoiceNumber]);
      expect((await caller(controller).invoicing.void({ invoiceNumber: drafted.invoiceNumber, reason: "re-issue with PO" })).voided).toBe(true);   // voiding is the controller's act
    }
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("FINALIZED");

    // The ledger, in order, and its chain.
    const trail = await ledger(office, jobA.id);
    // A re-present that changes no state writes nothing; accepting lines on a finalized ticket changes no state either.
    expect(trail).toEqual([
      "billing_line_added", "billing_line_added", "billing_line_modified",
      "ticket_presented", "billing_line_added",
      "customer_signature",
      "ticket_finalized", "ticket_amended",
      "invoice_generated", "ticket_voided",
    ]);
    expect(await caller(office).clientServices.auditVerify()).toMatchObject({ ok: true });
    const events = (await caller(office).clientServices.auditTrail({ jobId: jobA.id })).events;
    expect(events.find(e => e.eventType === "ticket_finalized")!.payload).toMatchObject({ from: "CUSTOMER_ACCEPTED", to: "FINALIZED", documentRef: `${t.ticketNumber}-R2`, snapshotHash: fin.snapshotHash });
    expect(events.find(e => e.eventType === "billing_line_modified")!.payload).toMatchObject({ before: { quantity: 4.5 }, after: { quantity: 5 }, repriced: { amountCents: 92_500 } });
  }, 120_000);

  it("serializes concurrent line writes under the ticket lock: every line lands, the version counts each one, and the totals add up", async () => {
    const A = await org();
    const office = await member(A, "office"); const controller = await member(A, "controller");
    const jobA = await job(A); const acct = await account(A); const u = await unit(A);
    await rate(office, controller, acct.entityId, acct.accountRef);
    const c = caller(office).closeout;
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u });
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: `Segment ${i + 1}`, quantity: 1, quantityUnit: "hour", measurementMethod: "system_timed" })));
    expect(results.every(r => "outcome" in r.pricing && r.pricing.outcome === "priced")).toBe(true);
    expect(results.map(r => r.billingVersion).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 2));   // 2..N+1, each exactly once
    const b = await caller(office).clientServices.ticketBilling({ ticketNumber: t.ticketNumber });
    expect(b.billingVersion).toBe(N + 1);
    expect(b.lines).toHaveLength(N);
    expect(b.totals).toMatchObject({ subtotalCents: N * 18_500, pricedLines: N, unpricedLines: 0 });
    // Every write is on the ledger once, and the chain has no fork.
    const trail = await ledger(office, jobA.id);
    expect(trail.filter(e => e === "billing_line_added")).toHaveLength(N);
    expect(await caller(office).clientServices.auditVerify()).toMatchObject({ ok: true });
  }, 60_000);

  it("disputes on a disputed line, re-presents, finalizes only by name without acceptance, and voids an uninvoiced ticket", async () => {
    const A = await org();
    const office = await member(A, "office"); const controller = await member(A, "controller");
    const jobA = await job(A); const acct = await account(A); const u = await unit(A);
    await rate(office, controller, acct.entityId, acct.accountRef);
    const c = caller(office).closeout; const cs = caller(office).clientServices;
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") });
    const l1 = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "hour" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("12:00") });
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "Unknown Rep", company: "Northgate Energy" }, method: "drawn", authorities: ["work_confirmation"], extraWorkCents: 0, offline: false });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("CUSTOMER_ACCEPTED");
    // The office records the customer's dispute of a line from paper: the ticket is disputed.
    await c.lineDecide({ ticketNumber: t.ticketNumber, lineId: l1.lineId, disposition: "disputed", customerQuantity: 4, customerStatement: "Truck idle 30 min at gate" });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("DISPUTED");
    expect((await cs.ticketFinalize({ ticketNumber: t.ticketNumber })).refusals[0]).toMatch(/customer has not accepted/);
    expect((await cs.ticketFinalize({ ticketNumber: t.ticketNumber, withoutCustomerAcceptance: true })).refusals).toEqual(["Finalizing without customer acceptance needs a reason"]);
    // Resolved on paper: accepted again.
    await c.lineDecide({ ticketNumber: t.ticketNumber, lineId: l1.lineId, disposition: "accepted", customerStatement: "Resolved at 4.25 h; contractor agrees" });
    expect((await cs.ticketBilling({ ticketNumber: t.ticketNumber })).billingState).toBe("CUSTOMER_ACCEPTED");
    // A second ticket on the same job is voided before anything is invoiced; the ledger carries the reason.
    const t2 = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u });
    await c.lineAdd({ ticketNumber: t2.ticketNumber, lineKind: "other", description: "opened in error", quantity: 1, quantityUnit: "each" });
    expect((await cs.ticketVoid({ ticketNumber: t2.ticketNumber, reason: "duplicate ticket opened in error" })).billingState).toBe("VOID");
    await expect(c.lineAdd({ ticketNumber: t2.ticketNumber, lineKind: "other", description: "after void", quantity: 1, quantityUnit: "each" })).rejects.toThrow(/void/);
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT billingState, voidReason, voidedByUserId FROM fieldTickets WHERE ticketNumber = ?", [t2.ticketNumber]);
    expect(row[0]).toMatchObject({ billingState: "VOID", voidReason: "duplicate ticket opened in error", voidedByUserId: office });
    const trail = await ledger(office, jobA.id);
    expect(trail.filter(e => e.startsWith("customer_"))).toEqual(["customer_signature", "customer_dispute", "customer_approval"]);
    expect(trail.at(-1)).toBe("ticket_voided");
  }, 60_000);
});
