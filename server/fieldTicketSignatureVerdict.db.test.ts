/**
 * SPINE item 2 — field-ticket signature status: one verdict, read by billing and by closeout.
 *
 * Owner's ruling (2026-10-01): the site sign-off is the canonical source of signature status; billing
 * consumes it and never answers "is this ticket signed?" from a raw signature row, a non-null column, an
 * older revision or a name. A signature on anything but the current frozen revision does not satisfy;
 * unknown is never signed; "no signature" is never "not required".
 *
 * Each case builds a ticket through the real site-sign path, then shapes the signature records the way a
 * real failure would leave them, and asks the real `invoicing.draftFromTicket` and `closeout.state`. On
 * the code before `fieldTicketSignatureVerdict` the cases marked DISAGREED failed: invoicing read "any
 * accepted signature row" and so drafted on records that do not establish a signature for the current
 * revision.
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
let seq = 921_000_000 + Math.floor(Math.random() * 50_000);
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

type Case = {
  name: string; sign: boolean;
  /** Shape the records after signing (or not). */
  shape?: (s: Awaited<ReturnType<typeof ticket>>) => Promise<void>;
  /** The billing blocker the verdict must produce, or null when the prerequisite is satisfied. */
  billing: RegExp | null;
  /** The closeout blocker, or null. */
  closeout: RegExp | null;
  disagreedBefore?: true;
};
const sql = (q: string, p: unknown[]) => pool.execute(q, p as never);

const CASES: Case[] = [
  { name: "the current frozen revision, correctly signed", sign: true, billing: null, closeout: null },
  { name: "no signature", sign: false, billing: /Ticket is not signed/, closeout: /Site ticket not signed/ },
  { name: "a signature on a revision that was never frozen (the previous revision's slot)", sign: true, disagreedBefore: true,
    shape: async s => { await sql("UPDATE fieldTicketSignatures SET revision = 2 WHERE fieldTicketId = ?", [s.ticketId]); },
    billing: /Signature does not cover the current revision/, closeout: /Site signature not established/ },
  { name: "the frozen revision changed after the signature (payload no longer matches)", sign: true, disagreedBefore: true,
    shape: async s => { await sql("UPDATE fieldTicketRevisions SET snapshotHash = ? WHERE fieldTicketId = ? AND revision = 1", ["0".repeat(64), s.ticketId]); },
    billing: /Signature does not cover the current revision/, closeout: /Site signature not established/ },
  { name: "an amendment revision after the signature", sign: true, disagreedBefore: true,
    shape: async s => { await sql("INSERT INTO fieldTicketRevisions (documentRef, fieldTicketId, revision, kind, snapshotJson, snapshotHash, generatedAt) VALUES (?, ?, 2, 'amendment', '{}', ?, NOW())", [`${s.ticketNumber}-R2`, s.ticketId, "a".repeat(64)]); },
    billing: /Signature does not cover the current revision/, closeout: /Site signature not established/ },
  { name: "the ticket marked amended after signature", sign: true,
    shape: async s => { await sql("UPDATE fieldTickets SET status = 'amended_after_signature' WHERE id = ?", [s.ticketId]); },
    billing: /amended after signature/, closeout: /Site signature not established/ },
  { name: "two signatures on one ticket (a second signatory is not a workflow this tree has)", sign: true, disagreedBefore: true,
    shape: async s => { await sql("INSERT INTO fieldTicketSignatures (fieldTicketId, revision, result, signerName, capturedAt, payloadHash, signatureMethod) SELECT fieldTicketId, revision, result, 'Second Person', capturedAt, payloadHash, signatureMethod FROM fieldTicketSignatures WHERE fieldTicketId = ?", [s.ticketId]); },
    billing: /Signature not established/, closeout: /Site signature not established/ },
  { name: "the ticket says signed but no signature is on file (unknown)", sign: false,
    shape: async s => { await sql("UPDATE fieldTickets SET signatureStatus = 'accepted' WHERE id = ?", [s.ticketId]); },
    billing: /Signature not established/, closeout: /Site signature not established/ },
  { name: "a signature on file while the ticket says unsigned (unknown)", sign: true, disagreedBefore: true,
    shape: async s => { await sql("UPDATE fieldTickets SET signatureStatus = 'unsigned' WHERE id = ?", [s.ticketId]); },
    billing: /Signature not established/, closeout: /Site signature not established/ },
  { name: "the representative refused", sign: true,
    shape: async s => { await sql("UPDATE fieldTicketSignatures SET result = 'refused' WHERE fieldTicketId = ?", [s.ticketId]); await sql("UPDATE fieldTickets SET signatureStatus = 'refused' WHERE id = ?", [s.ticketId]); },
    billing: /Customer refused the site ticket/, closeout: /Customer refused the site ticket/ },
  { name: "no representative on site — not a waiver", sign: true,
    shape: async s => { await sql("UPDATE fieldTicketSignatures SET result = 'no_representative' WHERE fieldTicketId = ?", [s.ticketId]); await sql("UPDATE fieldTickets SET signatureStatus = 'no_representative' WHERE id = ?", [s.ticketId]); },
    billing: /No customer representative signed/, closeout: /Site signature not established/ },
];

d("billing and closeout read one signature verdict", () => {
  for (const c of CASES) {
    it(`${c.name}${c.disagreedBefore ? " [DISAGREED before]" : ""}`, async () => {
      const s = await ticket({ sign: c.sign });
      if (c.sign) {
        // Every line accepted, so the only thing standing between this ticket and a draft is the signature.
        for (const lineId of [s.lineA, s.lineB]) await callerFor(s.office).closeout.lineDecide({ ticketNumber: s.ticketNumber, lineId, disposition: "accepted" });
      }
      await c.shape?.(s);
      const draft = await callerFor(s.office).invoicing.draftFromTicket({ ticketNumber: s.ticketNumber });
      const blockers = draft.drafted === false ? draft.blockers : [];
      const signatureBlockers = blockers.filter(b => /sign|refused|representative|amended|revision/i.test(b));
      if (c.billing) expect(signatureBlockers.join(" | ")).toMatch(c.billing);
      else expect(signatureBlockers).toEqual([]);

      const state = await callerFor(s.office).closeout.state({ ticketNumber: s.ticketNumber });
      const closeoutSignature = state.blockers.filter(b => /sign|refused/i.test(b));
      if (c.closeout) expect(closeoutSignature.join(" | ")).toMatch(c.closeout);
      else expect(closeoutSignature).toEqual([]);
    }, 120_000);
  }
});
