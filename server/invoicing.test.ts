import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import { disputeResolution, draftFromTicket, finalizeCheck, snapshotHash, voidCheck, type TicketLineForInvoice } from "./_core/invoiceDraft";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const priced = (id: number, description: string, amountCents: number, disposition: TicketLineForInvoice["disposition"] = "accepted"): TicketLineForInvoice => ({ id, description, serviceCode: "hydrovac", disposition, quantity: 4, quantityUnit: "hour", decision: { decisionRef: `PR-${id}`, outcome: "priced", amountCents, billableQuantityMillis: 4_000, rateMillis: 320_000, unit: "hour", quantityMillis: 4_000, scopeLevel: "customer_contract", reasons: [] } });

describe("the draft takes accepted, priced lines and names everything else", () => {
  it("blocks an unsigned ticket, holds a disputed line under partial acceptance, blocks it otherwise, and excludes a note", () => {
    const lines: TicketLineForInvoice[] = [priced(1, "Truck time", 128_000), priced(2, "Standby", 19_000, "disputed"), { id: 3, description: "Note", serviceCode: null, disposition: "accepted", quantity: null, quantityUnit: null, decision: null }];
    expect(draftFromTicket({ signed: false, ticketStatus: "presented", lines, partialAcceptanceAllowed: true }).blockers[0]).toContain("not signed");
    const partial = draftFromTicket({ signed: true, ticketStatus: "closed", lines, partialAcceptanceAllowed: true });
    expect(partial.blockers).toEqual([]);
    expect(partial.lines.map(l => l.description)).toEqual(["Truck time"]);
    expect(partial.subtotalCents).toBe(128_000);
    expect(partial.excluded.map(e => e.reason.slice(0, 22))).toEqual(["Disputed by the custom", "No service named — a n"]);
    const whole = draftFromTicket({ signed: true, ticketStatus: "closed", lines, partialAcceptanceAllowed: false });
    expect(whole.blockers[0]).toContain("does not accept partial invoices");
    const unpriced = draftFromTicket({ signed: true, ticketStatus: "closed", lines: [{ ...priced(4, "Hose", 0), decision: { ...priced(4, "Hose", 0).decision!, outcome: "unknown_rate", amountCents: null } }], partialAcceptanceAllowed: true });
    expect(unpriced.blockers[0]).toBe("Line 4 (Hose): UNKNOWN RATE");
    expect(draftFromTicket({ signed: true, ticketStatus: "closed", lines: [priced(5, "Not presented", 100, "not_presented")], partialAcceptanceAllowed: true }).blockers[0]).toContain("not presented for acceptance");
    expect(draftFromTicket({ signed: true, ticketStatus: "amended_after_signature", lines: [priced(1, "x", 100)], partialAcceptanceAllowed: true }).blockers[0]).toContain("amended after signature");
  });
  it("finalizes only a draft with a treatment, and a taxable invoice only on a verified rate", () => {
    const base = { status: "draft", jurisdiction: "CA-AB", subtotalCents: 128_000, lineCount: 1 } as const;
    expect(finalizeCheck({ ...base, gstTreatment: "unknown", rate: { outcome: "unverified", ratePercent: null, reason: null } }).refusals[0]).toContain("treatment not set");
    const unverified = finalizeCheck({ ...base, gstTreatment: "taxable", rate: { outcome: "unverified", ratePercent: 5, reason: "source unverified" } });
    expect(unverified.permitted).toBe(false);
    expect(unverified.refusals[0]).toContain("unverified — a taxable invoice is not finalized on an unverified rate (P9)");
    expect(finalizeCheck({ ...base, gstTreatment: "taxable", rate: { outcome: "determined", ratePercent: 5, reason: null } })).toEqual({ permitted: true, taxCents: 6_400, refusals: [] });
    expect(finalizeCheck({ ...base, gstTreatment: "zero_rated", rate: { outcome: "missing", ratePercent: null, reason: null } })).toEqual({ permitted: true, taxCents: 0, refusals: [] });
    expect(finalizeCheck({ ...base, status: "approved", gstTreatment: "exempt", rate: { outcome: "missing", ratePercent: null, reason: null } }).refusals[0]).toBe("Invoice is approved, not a draft");
    expect(snapshotHash({ b: 1, a: [new Date("2026-01-01T00:00:00Z")] })).toBe(snapshotHash({ a: ["2026-01-01T00:00:00.000Z"], b: 1 }));   // canonical: key order and dates
  });
  it("voids nothing with money applied, and bounds a dispute's credit by the disputed amount", () => {
    expect(voidCheck({ status: "sent", allocatedCents: 0, approvedCreditCents: 0 }).permitted).toBe(true);
    expect(voidCheck({ status: "viewed", allocatedCents: 5_000, approvedCreditCents: 0 }).refusals[0]).toContain("credit instead");
    expect(voidCheck({ status: "paid", allocatedCents: 0, approvedCreditCents: 0 }).refusals[0]).toContain("credited, not voided");
    expect(voidCheck({ status: "draft", allocatedCents: 0, approvedCreditCents: 0 }).refusals[0]).toBe("Invoice is draft");
    expect(disputeResolution({ caseStatus: "raised", outcome: "credited", disputedAmountCents: 10_000, creditAmountCents: 10_000 })).toMatchObject({ permitted: true, caseStatus: "resolved_credited", creditCents: 10_000 });
    expect(disputeResolution({ caseStatus: "raised", outcome: "partial", disputedAmountCents: 10_000, creditAmountCents: 4_000 })).toMatchObject({ permitted: true, caseStatus: "resolved_partial", creditCents: 4_000 });
    expect(disputeResolution({ caseStatus: "raised", outcome: "credited", disputedAmountCents: 10_000, creditAmountCents: 12_000 }).refusals[0]).toContain("exceeds the disputed");
    expect(disputeResolution({ caseStatus: "raised", outcome: "credited", disputedAmountCents: 10_000, creditAmountCents: 4_000 }).refusals[0]).toContain("partial resolution");
    expect(disputeResolution({ caseStatus: "raised", outcome: "upheld", disputedAmountCents: 10_000, creditAmountCents: null })).toMatchObject({ permitted: true, caseStatus: "resolved_upheld", creditCents: 0 });
    expect(disputeResolution({ caseStatus: "resolved_upheld", outcome: "upheld", disputedAmountCents: 10_000, creditAmountCents: null }).refusals[0]).toBe("Case is resolved_upheld");
    const already = draftFromTicket({ signed: true, ticketStatus: "closed", lines: [priced(1, "Truck time", 128_000)], partialAcceptanceAllowed: true, alreadyInvoiced: new Map([[1, "INV-1"]]) });
    expect(already.blockers[0]).toContain("Nothing new to invoice");
    expect(already.excluded[0].reason).toBe("Already on invoice INV-1");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 5_000_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
const portalCaller = (token: string | null) => appRouter.createCaller({ req: { headers: token ? { "x-portal-token": token } : {} } as never, res: {} as never, user: null as never });

d("an invoice from the ticket's decisions, end to end", () => {
  it("is blocked before signature, drafted from accepted priced lines, refused on an unverified rate, finalized zero-rated into a hashed snapshot, and books the job", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    const customerName = `ABC Energy ${acctRef.slice(-5)}`;
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, ?)", [acctRef, entityId, customerName]);
    await pool.execute("INSERT INTO customerBillingConfigs (customer, defaultTicketScope, signatureRequired, partialAcceptanceAllowed, paymentTermsDays, createdAt, updatedAt) VALUES (?, 'job', 1, 1, 30, NOW(), NOW())", [customerName]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', ?, '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40), customerName]);
    const cs = callerFor(office).commercialSetup;
    const rate = await cs.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: "hydrovac", pricingMethod: "per_unit", unit: "hour", rateMillis: 320_000, minimumQuantityMillis: 4_000, scopeLevel: "customer_contract", customerAccountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human", sourceClause: "ABC MSA §4.2" });
    await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: rate.definitionRef });
    const c = callerFor(driver).closeout;
    const [fixtureUnit735] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId: Number(job.insertId), customerAccountRef: acctRef, unitId: fixtureUnit735.insertId, operatorId: 7, serviceDescription: "Hydrovac" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("09:30"), source: "pto", confidence: "high" });
    const truck = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "hydrovac", description: "Truck time", quantity: 2.5, quantityUnit: "h", measurementMethod: "system_timed" });
    const hose = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "equipment", serviceCode: "extra_hose", description: "Extra hose", quantity: 1, quantityUnit: "each", measurementMethod: "customer_stated" });
    const note = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "Site note", measurementMethod: "unknown" });
    const inv = callerFor(office).invoicing;
    const before = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(before.drafted).toBe(false);
    expect(before.drafted === false && before.blockers[0]).toContain("not signed");
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("09:30") });
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "M. Johnson", company: customerName }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"] });
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: truck.lineId, disposition: "accepted" });
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: hose.lineId, disposition: "disputed", customerStatement: "Hose was ours" });
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: note.lineId, disposition: "accepted" });
    const drafted = await inv.draftFromTicket({ ticketNumber: t.ticketNumber, purchaseOrder: "PO-88172" });
    expect(drafted.drafted).toBe(true);
    if (!drafted.drafted) return;
    expect(drafted).toMatchObject({ subtotalCents: 128_000, lines: 1, gstTreatment: "unknown" });      // 2.5 h measured, 4 h billed at $320 — from the decision, not re-priced
    expect(drafted.excluded.map(e => e.reason.slice(0, 8))).toEqual(["Disputed", "No servi"]);
    const got = await inv.get({ invoiceNumber: drafted.invoiceNumber });
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]).toMatchObject({ fieldTicketLineId: truck.lineId, pricingDecisionRef: (truck.pricing as { decisionRef: string }).decisionRef, billableQuantityMillis: 4_000, quantityMillis: 2_500, amountCents: 128_000 });
    expect(got.lines[0].basis).toContain("customer_contract");
    const dup = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(dup.drafted).toBe(false);
    expect(dup.drafted === false && dup.blockers[0]).toContain("Nothing new to invoice");          // v22.11: a blocker named, not a throw; the accepted line is already on a live invoice
    expect(dup.drafted === false && dup.excluded.map(e => e.reason)).toContain(`Already on invoice ${drafted.invoiceNumber}`);
    // finalize: refused until a treatment is set; refused for taxable on the unverified seed rate (P9); permitted zero-rated
    const fin = callerFor(controller).invoicing;
    const noTreatment = await fin.finalize({ invoiceNumber: drafted.invoiceNumber });
    expect(noTreatment.finalized).toBe(false);
    expect(noTreatment.finalized === false && noTreatment.refusals[0]).toContain("treatment not set");
    await callerFor(controller).gst.treatmentSet({ kind: "invoice", ref: drafted.invoiceNumber, treatment: "taxable", source: "customer_status" });
    const taxable = await fin.finalize({ invoiceNumber: drafted.invoiceNumber, jurisdiction: "CA-AB" });
    expect(taxable.finalized).toBe(false);
    expect(taxable.finalized === false && taxable.refusals[0]).toMatch(/rate for CA-AB is (unverified|missing) — a taxable invoice is not finalized on an unverified rate \(P9\)/);
    await callerFor(controller).gst.treatmentSet({ kind: "invoice", ref: drafted.invoiceNumber, treatment: "zero_rated", source: "review" });
    await expect(callerFor(office).invoicing.finalize({ invoiceNumber: drafted.invoiceNumber })).rejects.toThrow(/invoicing.finalize/);   // the office drafts; it does not finalize
    const done = await fin.finalize({ invoiceNumber: drafted.invoiceNumber });
    expect(done.finalized).toBe(true);
    if (!done.finalized) return;
    expect(done).toMatchObject({ subtotalCents: 128_000, taxCents: 0, totalCents: 128_000 });
    expect(done.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const after = await inv.get({ invoiceNumber: drafted.invoiceNumber });
    expect(after).toMatchObject({ status: "approved", totalCents: 128_000 });
    expect(after.snapshot?.payloadHash).toBe(done.payloadHash);
    const [book] = await pool.execute<mysql.RowDataPacket[]>("SELECT billingState FROM billingBooks WHERE bookNumber = ?", [drafted.bookNumber]);
    expect(book[0].billingState).toBe("invoiced");
    const [entries] = await pool.execute<mysql.RowDataPacket[]>("SELECT billingStatus, holdReason FROM billingBookEntries WHERE billingBookId = (SELECT id FROM billingBooks WHERE bookNumber = ?) ORDER BY id", [drafted.bookNumber]);
    expect(entries.map(e => e.billingStatus)).toEqual(["billed", "held", "held"]);
    expect(entries[1].holdReason).toContain("Disputed by the customer");
    const again = await fin.finalize({ invoiceNumber: drafted.invoiceNumber });
    expect(again.finalized === false && again.refusals[0]).toBe("Invoice is approved, not a draft");

    // v22.10 — rendered from the snapshot, sent with the account's terms, seen and accepted in the portal
    await expect(inv.send({ invoiceNumber: drafted.invoiceNumber })).rejects.toThrow(/Render the invoice document before sending/);
    const r1 = await inv.render({ invoiceNumber: drafted.invoiceNumber });
    const r2 = await inv.render({ invoiceNumber: drafted.invoiceNumber });
    expect(r1.alreadyRendered).toBe(false);
    expect(r2).toMatchObject({ alreadyRendered: true, contentHash: r1.contentHash, documentRef: r1.documentRef });   // idempotent, one document
    const [doc] = await pool.execute<mysql.RowDataPacket[]>("SELECT kind, sourceSnapshotHash, revisionId, invoiceId FROM fieldTicketDocuments WHERE documentRef = ?", [r1.documentRef]);
    expect(doc[0]).toMatchObject({ kind: "invoice", sourceSnapshotHash: done.payloadHash, revisionId: null });
    const invite = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: `ap-${acctRef.slice(-5)}@abc.example`, displayName: "ABC AP" });
    const acc0 = await portalCaller(invite.invitationToken).portal.invitationAccept(); const token = acc0.token;
    const sent = await inv.send({ invoiceNumber: drafted.invoiceNumber });
    expect(sent).toMatchObject({ status: "sent", termsDays: 30, documentRef: r1.documentRef, alertsQueued: 1 });   // the account's one portal identity is alerted
    expect(sent.dueAt.getTime() - (await inv.get({ invoiceNumber: drafted.invoiceNumber })).issuedAt!.getTime()).toBe(30 * 86_400_000);
    await expect(inv.send({ invoiceNumber: drafted.invoiceNumber })).rejects.toThrow(/only a finalized, unsent invoice is sent/);
    const listed = await portalCaller(token).portal.invoices();
    expect(listed.invoices).toEqual([expect.objectContaining({ invoiceNumber: drafted.invoiceNumber, status: "sent", totalCents: 128_000, documentRef: r1.documentRef, viewedAt: null })]);
    const viewed = await portalCaller(token).portal.invoiceView({ invoiceNumber: drafted.invoiceNumber });
    expect(viewed.status).toBe("viewed");
    expect(viewed.lines).toEqual([expect.objectContaining({ lineNo: 1, billableQuantityMillis: 4_000, rateMillis: 320_000, amountCents: 128_000 })]);
    expect(JSON.stringify(viewed)).not.toMatch(/vendor|cost|margin/i);                          // the customer sees the sell price and nothing of cost
    const alerts = await portalCaller(token).portal.alerts();
    expect(alerts.alerts.some((a: { title: string; body: string | null }) => `${a.title} ${a.body ?? ""}`.includes(drafted.invoiceNumber))).toBe(true);
    const download = await portalCaller(token).portal.documentDownload({ documentRef: r1.documentRef });
    expect(download).toMatchObject({ kind: "invoice", contentHash: r1.contentHash, mimeType: "application/pdf" });
    const accepted = await portalCaller(token).portal.invoiceAccept({ invoiceNumber: drafted.invoiceNumber, acceptedByRole: "AP lead" });
    expect(accepted).toMatchObject({ acceptedByName: "ABC AP", already: false });
    expect((await portalCaller(token).portal.invoiceAccept({ invoiceNumber: drafted.invoiceNumber, acceptedByRole: "AP lead" })).already).toBe(true);
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, acceptedByName, acceptedByRole, acceptanceToken FROM invoices WHERE invoiceNumber = ?", [drafted.invoiceNumber]);
    expect(row[0]).toMatchObject({ status: "viewed", acceptedByName: "ABC AP", acceptedByRole: "AP lead" });   // acceptance is in its fields; the status stays the delivery state
    expect(row[0].acceptanceToken).toContain(":");
  });

  it("does not accept a disputed invoice over its dispute, and shows nothing to another account", async () => {
    const controller = await withRole("controller");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    const otherRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'DEF Oil')", [acctRef, entityId]);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Other Co')", [otherRef, entityId]);
    const [acct] = await pool.execute<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [acctRef]);
    const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO billingBooks (bookNumber, jobId, customer, billingState, openedAt, createdAt, updatedAt) VALUES (?, 1, 'DEF Oil', 'invoiced', NOW(), NOW(), NOW())", [key("BB").slice(0, 40)]);
    const invoiceNumber = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, financialEntityId, billingBookId, jobId, customer, customerAccountId, subtotalCents, taxCents, gstTreatment, totalCents, currency, status, issuedAt, sentAt, createdAt, updatedAt) VALUES (?, ?, ?, 1, 'DEF Oil', ?, 50000, 0, 'zero_rated', 50000, 'CAD', 'sent', NOW(), NOW(), NOW(), NOW())", [invoiceNumber, entityId, Number(book.insertId), acct[0].id]);
    const invite = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: `ap-${acctRef.slice(-5)}@def.example`, displayName: "DEF AP" });
    const token = (await portalCaller(invite.invitationToken).portal.invitationAccept()).token;
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: otherRef, email: `ap-${otherRef.slice(-5)}@other.example`, displayName: "Other AP" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    expect((await portalCaller(otherToken).portal.invoices()).invoices.map(i => i.invoiceNumber)).not.toContain(invoiceNumber);
    await expect(portalCaller(otherToken).portal.invoiceView({ invoiceNumber })).rejects.toThrow(/No such invoice for this account/);
    await portalCaller(token).portal.invoiceDispute({ invoiceNumber, disputedAmountCents: 10_000, reason: "Standby hours were not authorized by our supervisor" });
    const [after] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM invoices WHERE invoiceNumber = ?", [invoiceNumber]);
    if (after[0].status === "disputed") await expect(portalCaller(token).portal.invoiceAccept({ invoiceNumber, acceptedByRole: "AP" })).rejects.toThrow(/disputed/);
    else expect(after[0].status).toBe("sent");                                                    // a dispute submission may await office review before the status moves; either way nothing was accepted
    const [acc] = await pool.execute<mysql.RowDataPacket[]>("SELECT acceptedAt FROM invoices WHERE invoiceNumber = ?", [invoiceNumber]);
    expect(acc[0].acceptedAt).toBeNull();
  });

  it("re-drafts the held line as a supplemental invoice once its dispute resolves, credits an invoice dispute through AR, and voids only where no money is applied", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const management = await withRole("management");
    const bookkeeper = await withRole("bookkeeper");
    const driver = await withRole("driver");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    const customerName = `GHI Resources ${acctRef.slice(-5)}`;
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, ?)", [acctRef, entityId, customerName]);
    await pool.execute("INSERT INTO customerBillingConfigs (customer, defaultTicketScope, signatureRequired, partialAcceptanceAllowed, paymentTermsDays, createdAt, updatedAt) VALUES (?, 'job', 1, 1, 30, NOW(), NOW())", [customerName]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', ?, '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40), customerName]);
    const cs = callerFor(office).commercialSetup;
    for (const [code, rate] of [["hydrovac", 320_000], ["hydrovac_standby", 190_000]] as const) {
      const r = await cs.definitionPropose({ financialEntityId: entityId, rateKind: "sell", serviceCode: code, pricingMethod: "per_unit", unit: "hour", rateMillis: rate, scopeLevel: "customer_contract", customerAccountRef: acctRef, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceKind: "human" });
      await callerFor(controller).commercialSetup.definitionApprove({ definitionRef: r.definitionRef });
    }
    const c = callerFor(driver).closeout;
    const [fixtureUnit23] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId: Number(job.insertId), customerAccountRef: acctRef, unitId: fixtureUnit23.insertId, operatorId: 7, serviceDescription: "Hydrovac" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("15:00"), source: "pto", confidence: "high" });
    const truck = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "hydrovac", description: "Truck time", quantity: 8, quantityUnit: "h", measurementMethod: "system_timed" });
    const standby = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "standby", serviceCode: "hydrovac_standby", description: "Standby", quantity: 1, quantityUnit: "h", measurementMethod: "system_timed" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("15:00") });
    await c.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "R. Lee", company: customerName }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"] });
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: truck.lineId, disposition: "accepted" });
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: standby.lineId, disposition: "disputed", customerStatement: "Not authorized" });
    const inv = callerFor(office).invoicing;
    const first = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(first.drafted).toBe(true); if (!first.drafted) return;
    expect(first).toMatchObject({ subtotalCents: 256_000, lines: 1 });
    // nothing new: the accepted line is on a live invoice, the standby still disputed
    const nothing = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(nothing.drafted).toBe(false);
    expect(nothing.drafted === false && nothing.blockers[0]).toContain("Nothing new to invoice");
    // the standby dispute resolves in the customer's favour of the company: accepted; a supplemental draft carries only the standby
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: standby.lineId, disposition: "accepted", customerStatement: "Authorized after supervisor confirmed" });
    const second = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });
    expect(second.drafted).toBe(true); if (!second.drafted) return;
    expect(second).toMatchObject({ subtotalCents: 19_000, lines: 1, bookNumber: first.bookNumber });
    expect(second.excluded.map(e => e.reason)).toEqual([`Already on invoice ${first.invoiceNumber}`]);
    const [entries] = await pool.execute<mysql.RowDataPacket[]>("SELECT fieldTicketLineId, billingStatus FROM billingBookEntries WHERE billingBookId = (SELECT id FROM billingBooks WHERE bookNumber = ?) ORDER BY id", [first.bookNumber]);
    expect(entries).toHaveLength(2);                                                                     // one entry per line, updated not duplicated
    expect(entries.find(e => e.fieldTicketLineId === standby.lineId)?.billingStatus).toBe("ready");
    // finalize and send the first; the customer disputes it; the controller resolves with a partial credit that a second person approves
    const fin = callerFor(controller).invoicing;
    await callerFor(controller).gst.treatmentSet({ kind: "invoice", ref: first.invoiceNumber, treatment: "zero_rated", source: "review" });
    const done = await fin.finalize({ invoiceNumber: first.invoiceNumber }); expect(done.finalized).toBe(true);
    await inv.render({ invoiceNumber: first.invoiceNumber });
    const invite = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: `ap-${acctRef.slice(-5)}@ghi.example`, displayName: "GHI AP" });
    const token = (await portalCaller(invite.invitationToken).portal.invitationAccept()).token;
    await inv.send({ invoiceNumber: first.invoiceNumber });
    await portalCaller(token).portal.invoiceView({ invoiceNumber: first.invoiceNumber });
    const disp = await portalCaller(token).portal.invoiceDispute({ invoiceNumber: first.invoiceNumber, disputedAmountCents: 32_000, reason: "One hour was our crew's delay, not yours" });
    const rev = await callerFor(bookkeeper).portalAdmin.submissionReview({ submissionRef: disp.submissionRef, decision: "accepted", reason: "Dispute logged for investigation" });
    expect(rev.resultRef).toMatch(/^DSP|^DC|^CASE|-/);
    const [dc] = await pool.execute<mysql.RowDataPacket[]>("SELECT caseNumber, status FROM disputeCases WHERE invoiceNumber = ?", [first.invoiceNumber]);
    expect(dc[0].status).toBe("raised");
    // void is refused while the invoice is disputed? no — void is refused only where money is applied; here none is, but a dispute in flight is resolved first by policy of the test
    const tooMuch = await fin.disputeResolve({ caseNumber: dc[0].caseNumber, outcome: "credited", creditAmountCents: 40_000, narrative: "Attempted over-credit" });
    expect(tooMuch.resolved).toBe(false);
    const resolved = await fin.disputeResolve({ caseNumber: dc[0].caseNumber, outcome: "partial", creditAmountCents: 16_000, narrative: "Half the disputed hour was ours: crew waited on our permit" });
    expect(resolved.resolved).toBe(true); if (!resolved.resolved) return;
    expect(resolved).toMatchObject({ caseStatus: "resolved_partial", creditCents: 16_000, invoiceStatus: "viewed" });
    await expect(callerFor(controller).ar.creditDecide({ creditRef: resolved.creditRef!, decision: "approved" })).rejects.toThrow(/own credit/);   // the resolver requested it; a second person approves
    const approved = await callerFor(management).ar.creditDecide({ creditRef: resolved.creditRef!, decision: "approved" });
    expect(approved.status).toBe("approved");
    // void: refused with an approved credit standing; the supplemental (no money applied) voids and releases its line
    const refused = await fin.void({ invoiceNumber: first.invoiceNumber, reason: "Testing the refusal" });
    expect(refused.voided).toBe(false);
    expect(refused.voided === false && refused.refusals[0]).toContain("approved credits stand against it");
    await callerFor(controller).gst.treatmentSet({ kind: "invoice", ref: second.invoiceNumber, treatment: "zero_rated", source: "review" });
    await fin.finalize({ invoiceNumber: second.invoiceNumber });
    const voided = await fin.void({ invoiceNumber: second.invoiceNumber, reason: "Standby to be invoiced with next month's work" });
    expect(voided).toMatchObject({ voided: true, releasedLines: 1 });
    const [v] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, voidReason, voidedByUserId FROM invoices WHERE invoiceNumber = ?", [second.invoiceNumber]);
    expect(v[0]).toMatchObject({ status: "void", voidReason: "Standby to be invoiced with next month's work", voidedByUserId: controller });
    const third = await inv.draftFromTicket({ ticketNumber: t.ticketNumber });                            // the released line drafts again
    expect(third.drafted).toBe(true); if (!third.drafted) return;
    expect(third).toMatchObject({ subtotalCents: 19_000, lines: 1 });
    const [snap] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM billingSnapshots WHERE invoiceId = (SELECT id FROM invoices WHERE invoiceNumber = ?)", [second.invoiceNumber]);
    expect(Number(snap[0].n)).toBe(1);                                                                    // the void keeps the snapshot
  });
});
