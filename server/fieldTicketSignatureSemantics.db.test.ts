/**
 * SPINE item 2, field-ticket signature status — the owner's ruling, pinned.
 *
 * A signature is a historical fact: what the representative signed, who, when, over which snapshot.
 * `recordSignature` writes it once, at signing, and nothing derives it again. Line decisions made
 * afterwards (accept, dispute, correct) are a separate fact about each line; they never rewrite the
 * signature, and they cannot create one.
 *
 * Whether a ticket may be invoiced is a different question with a different answer: a valid signature
 * AND every line resolved under the customer's terms AND the existing billing requirements. That answer
 * is `draftFromTicket` (`_core/invoiceDraft.ts`), reached through `invoicing.draftFromTicket`. A
 * signature alone is necessary, never sufficient.
 *
 * The rejected alternative was `deriveSignatureStatus` (`_core/fieldTicket.ts`), which recomputed the
 * status from the line dispositions. It had no production caller and is removed; the structural guard
 * `spineItem2Duplicates.test.ts` keeps it removed.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

vi.mock("./storage", () => ({
  storagePut: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async () => Buffer.from(""),
}));
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 920_000_000 + Math.floor(Math.random() * 50_000);
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const at = (hhmm: string) => new Date(`2026-09-10T${hhmm}:00Z`);

/**
 * A ticket with two priced service lines for a customer whose contract does NOT allow partial invoices,
 * optionally signed through the real site-sign path.
 */
async function ticket(opts: { sign: boolean }) {
  const office = await withRole("office"), controller = await withRole("controller"), driver = await withRole("driver");
  const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);
  const acctRef = key("CUST").slice(0, 40);
  const customerName = `Sig Energy ${acctRef.slice(-5)}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, ?)", [acctRef, entityId, customerName]);
  await pool.execute("INSERT INTO customerBillingConfigs (customer, defaultTicketScope, signatureRequired, partialAcceptanceAllowed, paymentTermsDays, createdAt, updatedAt) VALUES (?, 'job', 1, 0, 30, NOW(), NOW())", [customerName]);
  const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', ?, '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40), customerName]);
  const rate = await callerFor(office).commercialSetup.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 320_000, scopeLevel: "customer_contract", customerAccountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "MSA §4.2" });
  await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: rate.definitionRef });
  const [unit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);
  const c = callerFor(driver).closeout;
  const t = await c.ticketOpen({ jobId: Number(job.insertId), customerAccountRef: acctRef, unitId: unit.insertId, operatorId: 7, serviceDescription: "Hydrovac" });
  await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("11:00"), source: "pto", confidence: "high" });
  const a = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "hydrovac", description: "Truck time", quantity: 2, quantityUnit: "h", measurementMethod: "system_timed" });
  const b = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "hydrovac", description: "Washout time", quantity: 2, quantityUnit: "h", measurementMethod: "system_timed" });
  if (opts.sign) {
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("11:00") });
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "M. Johnson", company: customerName }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"] });
  }
  const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]);
  return { ticketNumber: t.ticketNumber as string, ticketId: Number(row.id), jobId: Number(job.insertId), lineA: a.lineId as number, lineB: b.lineId as number, office };
}

/** Everything the signature recorded, and the ticket's copy of its status. */
async function signatureEvidence(ticketId: number) {
  const [sigs] = await pool.query<mysql.RowDataPacket[]>("SELECT id, revision, result, signerName, signerCompany, capturedAt, payloadHash, signedScopeStatement FROM fieldTicketSignatures WHERE fieldTicketId = ? ORDER BY id", [ticketId]);
  const [[t]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, signatureStatus FROM fieldTickets WHERE id = ?", [ticketId]);
  return { signatures: sigs, ticket: t };
}
const invoiceCount = async (jobId: number) => Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM invoices WHERE jobId = ?", [jobId]))[0][0].n);

d("a signature is the historical state created at signing", () => {
  it("stays signed, unchanged, when a line is disputed and when that decision is corrected", async () => {
    const s = await ticket({ sign: true });
    const signed = await signatureEvidence(s.ticketId);
    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures[0]).toMatchObject({ result: "accepted", signerName: "M. Johnson" });
    expect(signed.ticket.signatureStatus).toBe("accepted");
    const lines = callerFor(s.office).closeout;

    // Every line disputed: a recomputing rule would now read "refused". The record does not move.
    await lines.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineA, disposition: "disputed", customerStatement: "Not our hours" });
    await lines.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineB, disposition: "disputed", customerStatement: "Not our hours" });
    expect(await signatureEvidence(s.ticketId)).toEqual(signed);

    // Corrected to accepted, then one back to disputed ("partially accepted" under a recomputing rule): still unchanged.
    await lines.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineA, disposition: "accepted" });
    expect(await signatureEvidence(s.ticketId)).toEqual(signed);
    await lines.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineB, disposition: "accepted" });
    expect(await signatureEvidence(s.ticketId)).toEqual(signed);
  }, 120_000);

  it("cannot be manufactured from line decisions: an unsigned ticket's lines are not decided, and it stays unsigned and uninvoiceable", async () => {
    const s = await ticket({ sign: false });
    const before = await signatureEvidence(s.ticketId);
    expect(before.signatures).toHaveLength(0);
    for (const lineId of [s.lineA, s.lineB]) {
      await expect(callerFor(s.office).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId, disposition: "accepted" }))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Lines are decided against a signed ticket" });
    }
    expect(await signatureEvidence(s.ticketId)).toEqual(before);
    // Even with every line accepted underneath it (written directly, bypassing the procedure), no signature appears and the draft refuses.
    await pool.execute("UPDATE fieldTicketLines SET disposition = 'accepted' WHERE fieldTicketId = ?", [s.ticketId]);
    const draft = await callerFor(s.office).invoicing.draftFromTicket({ ticketNumber: s.ticketNumber });
    expect(draft.drafted).toBe(false);
    expect(draft.drafted === false && draft.blockers).toContain("Ticket is not signed — an invoice is drawn from a signed ticket");
    expect(await signatureEvidence(s.ticketId)).toEqual(before);
    expect(await invoiceCount(s.jobId)).toBe(0);
  }, 120_000);
});

d("invoice readiness is signature AND resolved lines AND the existing billing requirements", () => {
  it("a signed ticket with undecided lines is not ready", async () => {
    const s = await ticket({ sign: true });
    const draft = await callerFor(s.office).invoicing.draftFromTicket({ ticketNumber: s.ticketNumber });
    expect(draft.drafted).toBe(false);
    if (draft.drafted) return;
    expect(draft.blockers).toEqual([
      `Line ${s.lineA} (Truck time) was not presented for acceptance`,
      `Line ${s.lineB} (Washout time) was not presented for acceptance`,
    ]);
    expect(await invoiceCount(s.jobId)).toBe(0);
  }, 120_000);

  it("a signed ticket with a disputed line is not ready where the contract refuses partial invoices — the signature still reads accepted", async () => {
    const s = await ticket({ sign: true });
    const o = callerFor(s.office);
    await o.closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineA, disposition: "accepted" });
    await o.closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineB, disposition: "disputed", customerStatement: "Washout was ours" });
    const draft = await o.invoicing.draftFromTicket({ ticketNumber: s.ticketNumber });
    expect(draft.drafted).toBe(false);
    expect(draft.drafted === false && draft.blockers).toEqual([`Line ${s.lineB} (Washout time) is disputed and this customer does not accept partial invoices`]);
    expect((await signatureEvidence(s.ticketId)).ticket.signatureStatus).toBe("accepted");
    expect(await invoiceCount(s.jobId)).toBe(0);
  }, 120_000);

  it("a signed ticket with every line accepted and priced is ready, and drafting leaves the signature as it was", async () => {
    const s = await ticket({ sign: true });
    const o = callerFor(s.office);
    await o.closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineA, disposition: "accepted" });
    await o.closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId: s.lineB, disposition: "accepted" });
    const before = await signatureEvidence(s.ticketId);
    const draft = await o.invoicing.draftFromTicket({ ticketNumber: s.ticketNumber });
    expect(draft.drafted).toBe(true);
    expect(draft.drafted && draft.lines).toBe(2);
    expect(await signatureEvidence(s.ticketId)).toEqual(before);
  }, 120_000);
});
