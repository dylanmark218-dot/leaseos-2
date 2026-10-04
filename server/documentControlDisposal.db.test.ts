/**
 * Document Control, Checkpoint G (manual) — the facility's paper, registered against the disposal record it evidences.
 *
 * Scope ruled 2026-10-04: G on A–C only. A person enters the facility's number; no extraction, no
 * template, no screen (D, E, F, H held). The disposal domain stays authoritative for its facts; the
 * register records the paper, who issued it and which disposal record it evidences, and the disposal
 * domain's verifier names who checked the record against it.
 *
 * Identifiers kept apart throughout: the register's DOC- reference and any LeaseOS control number are
 * internal; the facility's ticket number and a scale ticket number are the issuer's evidence; the
 * disposal ticket's DSP- number, the field ticket's FT- number and the billing book's BB- number belong
 * to their domains. None is copied into another.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 289_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const one = async (q: string, p: unknown[]) => ((await pool.query<mysql.RowDataPacket[]>(q, p))[0][0]) as mysql.RowDataPacket;

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function evidence(userId: number, hash: string) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, storageKey, mimeType, capturedAt, capturedBy, status, recordType) VALUES (?,?,?,?,NOW(),?,'needs_review','disposal_ticket')", [`scan ${hash.slice(0, 8)}`, "disposal", `${userId}/evidence/${hash.slice(0, 12)}.jpg`, "image/jpeg", userId]);
  return r.insertId;
}
async function facility(name: string, precision = "verified_site") { const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, facilityType, status, coordinatePrecision) VALUES (?,?,'open',?)", [name, "disposal", precision]); return r.insertId; }
async function job(orgRef: string | null) { const code = `JOB-${rnd()}`; const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (orgRef, jobCode, type, customer, location, status) VALUES (?,?,?,?,?,'dispatched')", [orgRef, code, "Hydrovac", "Fixture Energy", "LSD 1-2-3-4"]); return { id: r.insertId, code }; }
async function load(jobId: number) { const n = `L-${rnd()}`; const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId) VALUES (?,?)", [n, jobId]); return { id: r.insertId, loadNumber: n }; }
/** A disposal record as the disposal domain writes one: needs_review, its own DSP number, the facility's number beside it. */
async function disposalTicket(o: { jobId: number; loadId: number; facilityId: number; facilityTicketNumber: string | null; netKg?: number }) {
  const ticketNumber = `DSP-TEST-${rnd()}`;
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO disposalTickets (ticketNumber, loadId, jobId, facilityId, facilityTicketNumber, netKg, quantity, quantityUnit, verificationStatus, source, confidence) VALUES (?,?,?,?,?,?,?,?,'needs_review','photo_ocr','medium')",
    [ticketNumber, o.loadId, o.jobId, o.facilityId, o.facilityTicketNumber, o.netKg ?? 8120.5, 9.4, "m3"]);
  return { id: r.insertId, ticketNumber };
}
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
async function accountRef(orgRef: string | null) {
  const [book] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Fixture books', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, orgRef]);
  const acctRef = `ACCT-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, delayBillingRulesJson, postSiteBillingRuleJson) VALUES (?, ?, ?, ?, ?)", [acctRef, Number(book.insertId), `Fixture ${acctRef}`, JSON.stringify({ customer_hold: "billable" }), JSON.stringify({ rule: "not_billable" })]);
  return acctRef;
}
async function device(orgRef: string, userId: number) { const ref = `DEV-${rnd()}`; await pool.execute("INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId, createdAt) VALUES (?,?,?,'android',?,'hardware',1,'active',NOW(),?,NOW())", [ref, userId, orgRef, `fp-${ref}`, userId]); return ref; }

/** One business with its people, a facility, a job, two loads at that facility and the disposal record of each. */
async function world() {
  const orgRef = await org();
  const office = await member(orgRef, ["office"]), mgr = await member(orgRef, ["management"]), driver = await member(orgRef, ["driver"]), accountant = await member(orgRef, ["external_accountant"]);
  await callerFor(mgr).documentControl.definitions.catalogSeed();
  const fac = await facility(`Facility XYZ ${rnd()}`);
  const j = await job(orgRef);
  const l1 = await load(j.id), l2 = await load(j.id);
  const ftn1 = `87${rnd().slice(0, 4)}`, ftn2 = `88${rnd().slice(0, 4)}`;
  const t1 = await disposalTicket({ jobId: j.id, loadId: l1.id, facilityId: fac, facilityTicketNumber: ftn1 });
  const t2 = await disposalTicket({ jobId: j.id, loadId: l2.id, facilityId: fac, facilityTicketNumber: ftn2 });
  return { orgRef, office, mgr, driver, accountant, fac, j, l1, l2, t1, t2, ftn1, ftn2 };
}
type World = Awaited<ReturnType<typeof world>>;

/** The facility's paper for one load, captured and then confirmed by the office against the disposal record. */
async function receipt(w: World, o: { ticket: { id: number; ticketNumber: string }; loadId: number; number: string; bytes: string; issuerFacilityId?: number | null; overrideReason?: string; definitionKey?: "external_disposal_receipt" | "scale_ticket"; referenceType?: "facility_ticket_number" | "scale_ticket_number" }) {
  const c = callerFor(w.office);
  const issuer = { issuerKind: "facility" as const, issuerFacilityId: o.issuerFacilityId === undefined ? w.fac : o.issuerFacilityId, issuerName: "Facility XYZ" };
  const reg = await c.documentControl.documents.intake({
    definitionKey: o.definitionKey ?? "external_disposal_receipt", title: `Facility ticket ${o.number}`, originKind: "external_scanned", issuer,
    evidenceRecordId: await evidence(w.office, sha(o.bytes)), contentHash: sha(o.bytes), importChannel: "office_upload",
    externalReferences: [{ referenceType: o.referenceType ?? "facility_ticket_number", referenceValue: o.number, duplicateOverrideReason: o.overrideReason }],
    links: [{ recordType: "job", recordRef: w.j.code }, { recordType: "load", recordRef: "load", recordId: o.loadId }, { recordType: "disposal_ticket", recordRef: o.ticket.ticketNumber, recordId: o.ticket.id, role: "official_record" }],
    requestedState: "captured",
  });
  const conf = await c.documentControl.documents.confirm({ documentRef: reg.documentRef, issuedAt: new Date("2026-09-20T15:00:00Z") });
  return { ...reg, controlState: conf.controlState };
}
async function ticketRow(id: number) { return one("SELECT ticketNumber, loadId, jobId, facilityId, facilityTicketNumber, netKg, quantity, quantityUnit, verificationStatus, source, evidenceRefs, verifiedByUserId, verifiedAt, verificationNote FROM disposalTickets WHERE id = ?", [id]); }
async function documentRow(documentRef: string) { return one("SELECT documentRef, contentHash, controlState, controlNumber, status, title, issuerKind, issuerFacilityId, definitionKey, version FROM commercialDocuments WHERE documentRef = ?", [documentRef]); }

d("G — the facility's paper is registered against the disposal record it evidences", () => {
  it("keeps every number in its own place: the facility's number is the facility's, mirrored from the disposal record, and no LeaseOS number is minted for it", async () => {
    const w = await world();
    const before = await ticketRow(w.t1.id);
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `paper-${w.ftn1}` });
    expect(r.controlState).toBe("confirmed");
    expect(r.controlNumber).toBeNull();
    expect(r.documentRef).toMatch(/^DOC-/);
    const v = await callerFor(w.office).documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.document).toMatchObject({ controlNumber: null, originKind: "external_scanned", issuerKind: "facility", issuerFacilityId: w.fac, definitionKey: "external_disposal_receipt" });
    // The facility's number on the document is the disposal record's column, mirrored — the domain stays authoritative.
    const ref = v.references.find(x => x.referenceType === "facility_ticket_number")!;
    expect(ref).toMatchObject({ referenceValue: w.ftn1, mirrorOfTable: "disposalTickets", mirrorOfId: w.t1.id, mirrorOfColumn: "facilityTicketNumber", confirmationStatus: "confirmed" });
    // The disposal record's facts are untouched: the register records the paper, it does not write the domain.
    expect(await ticketRow(w.t1.id)).toEqual(before);
    // The only ledger number this document holds is its archival DOC reference; no DSP, FT or BB number moved for it.
    const [alloc] = await pool.query<mysql.RowDataPacket[]>("SELECT sequenceType FROM numberAllocations WHERE recordType = 'commercialDocument' AND recordId = (SELECT id FROM commercialDocuments WHERE documentRef = ?)", [r.documentRef]);
    expect(alloc.map(a => a.sequenceType)).toEqual(["DOC"]);
  }, 60_000);

  it("keeps a scale ticket's number as a scale ticket number — never written into, compared with, or mirrored as the facility's ticket number", async () => {
    const w = await world();
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: `S-${rnd()}`, bytes: `scale-${rnd()}`, definitionKey: "scale_ticket", referenceType: "scale_ticket_number" });
    const v = await callerFor(w.office).documentControl.documents.get({ documentRef: r.documentRef });
    expect(v.references[0]).toMatchObject({ referenceType: "scale_ticket_number", mirrorOfTable: null, mirrorOfColumn: null });
    expect((await ticketRow(w.t1.id)).facilityTicketNumber).toBe(w.ftn1);
  }, 60_000);

  it("refuses a document whose links or issuer disagree with the disposal record it names: another load, another facility, another number", async () => {
    const w = await world();
    // The paper names load 2's record but is linked to load 1.
    await expect(receipt(w, { ticket: w.t2, loadId: w.l1.id, number: w.ftn2, bytes: `x-${rnd()}` })).rejects.toThrow(/load/i);
    // Issued by another facility than the one the disposal record names.
    const other = await facility(`Other facility ${rnd()}`);
    await expect(receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `y-${rnd()}`, issuerFacilityId: other })).rejects.toThrow(/facility/i);
    // The facility's number on the paper is not the number on the disposal record.
    await expect(receipt(w, { ticket: w.t1, loadId: w.l1.id, number: "999999", bytes: `z-${rnd()}` })).rejects.toThrow(/number/i);
    // A disposal record on another business's job is not found at all.
    const b = await org(); const jB = await job(b); const lB = await load(jB.id);
    const tB = await disposalTicket({ jobId: jB.id, loadId: lB.id, facilityId: w.fac, facilityTicketNumber: "424242" });
    await expect(receipt(w, { ticket: tB, loadId: w.l1.id, number: "424242", bytes: `b-${rnd()}` })).rejects.toThrow(/not in this business's records/);
  }, 60_000);

  it("refuses a facility number with nothing in it, and a malformed number never moves an internal sequence", async () => {
    const w = await world();
    const [[before]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM commercialDocuments WHERE bookOrgRef = ?", [w.orgRef]);
    await expect(callerFor(w.office).documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "blank number", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(w.office, sha("blank")), contentHash: sha(`blank-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: "  #  " }] })).rejects.toThrow(/reference|number/i);
    const [[after]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM commercialDocuments WHERE bookOrgRef = ?", [w.orgRef]);
    expect(Number(after!.n)).toBe(Number(before!.n));
  }, 60_000);
});

d("G — duplicates: exact, possible, and what cannot be assessed", () => {
  it("refuses the same bytes again even on another load; needs a reason for different bytes on the same load; accepts the same facility number on another load", async () => {
    const w = await world();
    const bytes = `paper-${rnd()}`;
    await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes });
    // A second photograph of the very same paper — identical bytes — is the same document, whatever it is linked to.
    await expect(receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes })).rejects.toThrow(/identical bytes/);
    // A second, different image of the same ticket on the same load: a possible duplicate, accepted only with a recorded reason.
    await expect(receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `${bytes}-rescan` })).rejects.toThrow(/REVIEW|recorded reason/);
    const second = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `${bytes}-rescan`, overrideReason: "back page of the same facility ticket, photographed separately" });
    const v = await callerFor(w.office).documentControl.documents.get({ documentRef: second.documentRef });
    expect(v.references[0]!.duplicateOfDocumentId).not.toBeNull();
    // The facility reuses its number on another load (another year's pad, another lane): that is a different disposal, not a duplicate.
    const t3 = await disposalTicket({ jobId: w.j.id, loadId: w.l2.id, facilityId: w.fac, facilityTicketNumber: w.ftn1 });
    const third = await receipt(w, { ticket: t3, loadId: w.l2.id, number: w.ftn1, bytes: `other-load-${rnd()}` });
    expect(third.controlState).toBe("confirmed");
    // Two images of one ticket never become two disposals: the disposal domain still has one record for load 1.
    const [[n]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM disposalTickets WHERE loadId = ?", [w.l1.id]);
    expect(Number(n!.n)).toBe(1);
  }, 60_000);

  it("fails closed when the document cannot be assessed: a facility issuer with no facility named cannot evidence a disposal record", async () => {
    const w = await world();
    await expect(receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `anon-${rnd()}`, issuerFacilityId: null })).rejects.toThrow(/cannot be assessed|names the facility/);
  }, 60_000);
});

d("G — several loads and repeat trips stay several", () => {
  it("two loads to the same facility: two disposal records, two papers, each mirrored to its own record; a document number is never a load's identity", async () => {
    const w = await world();
    const r1 = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `l1-${rnd()}` });
    const r2 = await receipt(w, { ticket: w.t2, loadId: w.l2.id, number: w.ftn2, bytes: `l2-${rnd()}` });
    const c = callerFor(w.office);
    const forL1 = await c.documentControl.documents.list({ recordType: "load", recordId: w.l1.id });
    const forL2 = await c.documentControl.documents.list({ recordType: "load", recordId: w.l2.id });
    expect(forL1.map(x => x.documentRef)).toEqual([r1.documentRef]);
    expect(forL2.map(x => x.documentRef)).toEqual([r2.documentRef]);
    const m1 = (await c.documentControl.documents.get({ documentRef: r1.documentRef })).references[0]!;
    const m2 = (await c.documentControl.documents.get({ documentRef: r2.documentRef })).references[0]!;
    expect([m1.mirrorOfId, m2.mirrorOfId]).toEqual([w.t1.id, w.t2.id]);
    const [lds] = await pool.query<mysql.RowDataPacket[]>("SELECT loadNumber FROM loads WHERE id IN (?,?) ORDER BY id", [w.l1.id, w.l2.id]);
    expect(lds.map(l => l.loadNumber)).toEqual([w.l1.loadNumber, w.l2.loadNumber]);
  }, 60_000);
});

d("G — verification is the disposal domain's act, named, scoped and evidenced", () => {
  it("refuses to verify without the facility's confirmed paper; records who and when once it is there; tells the document; touches no fact", async () => {
    const w = await world();
    const c = callerFor(w.office);
    await expect(c.commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" })).rejects.toThrow(/facility's paper|confirmed document/);
    // A captured, unconfirmed scan is not evidence yet.
    const captured = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "captured only", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(w.office, sha("cap")), contentHash: sha(`cap-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: w.ftn1 }], links: [{ recordType: "disposal_ticket", recordRef: w.t1.ticketNumber, recordId: w.t1.id }], requestedState: "captured" });
    await expect(c.commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" })).rejects.toThrow(/facility's paper|confirmed document/);
    await c.documentControl.documents.void({ documentRef: captured.documentRef, reason: "replaced by a clean scan of the same paper" });
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `clean-${rnd()}` });
    const docBefore = await documentRow(r.documentRef);
    const [[loadBefore]] = await pool.query<mysql.RowDataPacket[]>("SELECT chainState FROM loads WHERE id = ?", [w.l1.id]);
    const out = await c.commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified", note: "net weight agrees with the facility's paper" });
    expect(out).toMatchObject({ ticketNumber: w.t1.ticketNumber, verificationStatus: "verified", alreadyVerified: false, documentsTold: 1 });
    const t = await ticketRow(w.t1.id);
    expect(t).toMatchObject({ verificationStatus: "verified", verifiedByUserId: w.office, verificationNote: "net weight agrees with the facility's paper", facilityTicketNumber: w.ftn1, netKg: 8120.5 });
    expect(t.verifiedAt).not.toBeNull();
    // The document hears; nothing on it changed.
    expect(await documentRow(r.documentRef)).toEqual(docBefore);
    const tl = (await c.documentControl.documents.get({ documentRef: r.documentRef })).timeline;
    expect(tl.at(-1)).toMatchObject({ eventType: "document.domain_verified", actorUserId: w.office });
    // The voided scan stays in the register and was not told.
    expect((await c.documentControl.documents.get({ documentRef: captured.documentRef })).timeline.map(e => e.eventType)).not.toContain("document.domain_verified");
    // Verification does not move the load: no production path drives chainState, and G does not start one.
    const [[loadAfter]] = await pool.query<mysql.RowDataPacket[]>("SELECT chainState FROM loads WHERE id = ?", [w.l1.id]);
    expect(loadAfter!.chainState).toBe(loadBefore!.chainState);
    // Verifying again is the same answer; a verified record is not re-decided here.
    expect(await c.commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" })).toMatchObject({ alreadyVerified: true });
    await expect(c.commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "rejected", note: "changed my mind about it" })).rejects.toThrow(/already verified/);
  }, 60_000);

  it("is an office act: a driver and an external accountant may not verify; another business finds nothing; a rejection needs its reason", async () => {
    const w = await world();
    await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `p-${rnd()}` });
    await expect(callerFor(w.driver).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" })).rejects.toThrow(/disposal.verify|FORBIDDEN|Requires/);
    await expect(callerFor(w.accountant).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" })).rejects.toThrow(/disposal.verify|FORBIDDEN|Requires/);
    const b = await org(); const officeB = await member(b, ["office"]);
    // A client-supplied orgRef is not an input; it cannot widen the caller's scope.
    await expect(callerFor(officeB).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified", orgRef: w.orgRef } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(w.office).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t2.ticketNumber, outcome: "rejected" })).rejects.toThrow(/reason/);
    const rej = await callerFor(w.office).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t2.ticketNumber, outcome: "rejected", note: "facility says this load was turned away" });
    expect(rej.verificationStatus).toBe("rejected");
    expect((await ticketRow(w.t1.id)).verificationStatus).toBe("needs_review");
  }, 60_000);

  it("takes no authority from the facility directory: an approximate, unlisted facility neither blocks nor grants verification, and nothing is written there", async () => {
    const w = await world();
    const approx = await facility(`Approximate pin ${rnd()}`, "approximate_site");
    const lx = await load(w.j.id);
    const tx = await disposalTicket({ jobId: w.j.id, loadId: lx.id, facilityId: approx, facilityTicketNumber: "777001" });
    const counts = async () => one("SELECT (SELECT COUNT(*) FROM facilityCapabilities WHERE facilityId = ?) AS caps, (SELECT COUNT(*) FROM loadFacilityAssessments WHERE facilityId = ?) AS assessments, (SELECT coordinatePrecision FROM facilities WHERE id = ?) AS precisionNow", [approx, approx, approx]);
    const before = await counts();
    // The directory listing alone verifies nothing.
    await expect(callerFor(w.office).commercialOffice.disposal.verifyTicket({ ticketNumber: tx.ticketNumber, outcome: "verified" })).rejects.toThrow(/facility's paper|confirmed document/);
    await receipt({ ...w, fac: approx }, { ticket: tx, loadId: lx.id, number: "777001", bytes: `ap-${rnd()}` });
    await callerFor(w.office).commercialOffice.disposal.verifyTicket({ ticketNumber: tx.ticketNumber, outcome: "verified" });
    // Verifying what happened does not make the facility routable, accepted or assessed.
    expect(await counts()).toEqual(before);
    expect(before.precisionNow).toBe("approximate_site");
  }, 60_000);
});

d("G — closeout and billing consume the verified record; registration alone completes nothing", () => {
  it("a disposal line naming the job's DSP record bills a verified one only; another job's record is refused; a number that is not ours is kept as typed", async () => {
    const w = await world();
    const unit = await unitOwnedBy(w.orgRef); const acct = await accountRef(w.orgRef);
    const ft = await callerFor(w.driver).closeout.ticketOpen({ jobId: w.j.id, customerAccountRef: acct, unitId: unit, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    const stateBefore = await callerFor(w.driver).closeout.state({ ticketNumber: ft.ticketNumber });
    // Registering and confirming the facility's paper completes nothing: the record still needs review and closeout is where it was.
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `bill-${rnd()}` });
    expect((await ticketRow(w.t1.id)).verificationStatus).toBe("needs_review");
    expect(await callerFor(w.driver).closeout.state({ ticketNumber: ft.ticketNumber })).toEqual(stateBefore);
    const line = (n: string) => callerFor(w.driver).closeout.lineAdd({ ticketNumber: ft.ticketNumber, lineKind: "disposal", description: "disposal", quantity: 9.4, quantityUnit: "m3", measurementMethod: "scale", sourceTrackingNumber: n } as never);
    await expect(line(w.t1.ticketNumber)).rejects.toThrow(/needs_review|verified/);
    // Another job of this business: the record exists but is not this ticket's to bill.
    const j2 = await job(w.orgRef); const l3 = await load(j2.id);
    const other = await disposalTicket({ jobId: j2.id, loadId: l3.id, facilityId: w.fac, facilityTicketNumber: "515151" });
    await expect(line(other.ticketNumber)).rejects.toThrow(/another job/);
    // Another business's DSP number reveals nothing: it is kept as typed, like any facility's own number.
    const b = await org(); const jB = await job(b); const lB = await load(jB.id);
    const foreign = await disposalTicket({ jobId: jB.id, loadId: lB.id, facilityId: w.fac, facilityTicketNumber: "616161" });
    await expect(line(foreign.ticketNumber)).resolves.toBeTruthy();
    // Verified, the line enters — and the evidence it rests on is unchanged by being billed.
    await callerFor(w.office).commercialOffice.disposal.verifyTicket({ ticketNumber: w.t1.ticketNumber, outcome: "verified" });
    const ticketBefore = await ticketRow(w.t1.id); const docBefore = await documentRow(r.documentRef);
    await expect(line(w.t1.ticketNumber)).resolves.toBeTruthy();
    expect(await ticketRow(w.t1.id)).toEqual(ticketBefore);
    expect(await documentRow(r.documentRef)).toEqual(docBefore);
  }, 60_000);
});

d("G — tenant boundary on the disposal path", () => {
  it("another business cannot read, confirm, void or link to the document, and its office cannot attach its own paper to this business's disposal record", async () => {
    const w = await world();
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `t-${rnd()}` });
    const b = await org(); const officeB = await member(b, ["office"]); const mgrB = await member(b, ["management"]);
    await callerFor(mgrB).documentControl.definitions.catalogSeed();
    const cB = callerFor(officeB);
    await expect(cB.documentControl.documents.get({ documentRef: r.documentRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cB.documentControl.documents.void({ documentRef: r.documentRef, reason: "not yours to void at all" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cB.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "B's paper", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(officeB, sha("b")), contentHash: sha(`b-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: w.ftn1 }], links: [{ recordType: "disposal_ticket", recordRef: w.t1.ticketNumber, recordId: w.t1.id }] })).rejects.toThrow(/not in this business's records/);
    await expect(cB.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "B's paper", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(officeB, sha("b2")), contentHash: sha(`b2-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: w.ftn1 }], links: [{ recordType: "load", recordRef: "load", recordId: w.l1.id }] })).rejects.toThrow(/not in this business's records/);
    // A driver captures; only the office confirms.
    const cap = await callerFor(w.driver).documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "driver photo", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(w.driver, sha("drv")), contentHash: sha(`drv-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: w.ftn2, source: "human_entered" }], links: [{ recordType: "disposal_ticket", recordRef: w.t2.ticketNumber, recordId: w.t2.id }], requestedState: "captured" });
    await expect(callerFor(w.driver).documentControl.documents.confirm({ documentRef: cap.documentRef })).rejects.toThrow(/document.confirm|FORBIDDEN|Requires/);
  }, 60_000);
});

d("G — offline numbers: a device block proves identity, not acceptance", () => {
  it("a disposal-owned form numbered from the driver's block is issued by the office after sync; another business cannot consume the block; the driver cannot issue; the number grants nothing", async () => {
    const w = await world();
    const series = `WP${rnd().slice(0, 4)}`;
    await callerFor(w.mgr).documentControl.definitions.overlay({ definitionKey: "waste_pickup_transfer_ticket", changes: { numberSeriesType: series } });
    const dev = await device(w.orgRef, w.driver);
    const block = await callerFor(w.mgr).documentControl.series.allocateDeviceBlock({ sequenceType: series, deviceRef: dev, count: 3 });
    const c = callerFor(w.office);
    const doc = await c.documentControl.documents.registerRendered({ definitionKey: "waste_pickup_transfer_ticket", title: "Transfer ticket written offline", originKind: "system_rendered", contentHash: sha(`wpt-${rnd()}`), storageKey: "wpt/offline.pdf", requestedState: "proposed", links: [{ recordType: "load", recordRef: "load", recordId: w.l1.id }] });
    const deviceNumber = { blockRef: block.allocationRef, sequence: block.firstSequence, deviceRef: dev, idempotencyKey: `cap-${rnd()}` };
    // The driver holds the number but not the act.
    await expect(callerFor(w.driver).documentControl.documents.issue({ documentRef: doc.documentRef, deviceNumber })).rejects.toThrow(/document.issue|FORBIDDEN|Requires/);
    // Another business cannot spend this business's block.
    const b = await org(); const officeB = await member(b, ["office"]); const mgrB = await member(b, ["management"]);
    await callerFor(mgrB).documentControl.definitions.catalogSeed();
    await callerFor(mgrB).documentControl.definitions.overlay({ definitionKey: "waste_pickup_transfer_ticket", changes: { numberSeriesType: series } });
    const docB = await callerFor(officeB).documentControl.documents.registerRendered({ definitionKey: "waste_pickup_transfer_ticket", title: "B", originKind: "system_rendered", contentHash: sha(`wptb-${rnd()}`), storageKey: "wpt/b.pdf", requestedState: "proposed" });
    await expect(callerFor(officeB).documentControl.documents.issue({ documentRef: docB.documentRef, deviceNumber: { ...deviceNumber, idempotencyKey: `cap-${rnd()}` } })).rejects.toThrow(/BLOCKED|not found|block/i);
    // On reconnect the office issues with the device's number, through every server check.
    const issued = await c.documentControl.documents.issue({ documentRef: doc.documentRef, deviceNumber });
    expect(issued).toMatchObject({ controlState: "issued", controlNumber: block.numbers[0], minted: "device_block" });
    // The same device number cannot be spent twice.
    const again = await c.documentControl.documents.registerRendered({ definitionKey: "waste_pickup_transfer_ticket", title: "second", originKind: "system_rendered", contentHash: sha(`wpt2-${rnd()}`), storageKey: "wpt/2.pdf", requestedState: "proposed" });
    await expect(c.documentControl.documents.issue({ documentRef: again.documentRef, deviceNumber: { ...deviceNumber, idempotencyKey: `cap-${rnd()}` } })).rejects.toThrow(/CONFLICT|already|consumed/i);
    // Holding an issued number verifies no disposal record and completes no closeout.
    expect((await ticketRow(w.t1.id)).verificationStatus).toBe("needs_review");
    // Unused numbers stay accounted for: the gap report explains every one once the block is retired.
    await callerFor(w.mgr).documentControl.series.retireDeviceBlock({ blockRef: block.allocationRef, reasonCode: "device_retired", reasonText: "pad returned to the office with two blanks" });
    const gaps = await c.documentControl.series.gapReport({ sequenceType: series, periodKey: String(new Date().getUTCFullYear()) });
    expect(gaps.unexplained).toBe(0);
    expect(gaps.rows.filter(x => x.state === "unused_retired").length).toBe(2);
  }, 90_000);

  it("concurrent issues on one series never share a number", async () => {
    const w = await world();
    const series = `WQ${rnd().slice(0, 4)}`;
    await callerFor(w.mgr).documentControl.definitions.overlay({ definitionKey: "waste_pickup_transfer_ticket", changes: { numberSeriesType: series } });
    const c = callerFor(w.office);
    const docs = await Promise.all(Array.from({ length: 6 }, (_, i) => c.documentControl.documents.registerRendered({ definitionKey: "waste_pickup_transfer_ticket", title: `T${i}`, originKind: "system_rendered", contentHash: sha(`wq-${i}-${rnd()}`), storageKey: `wq/${i}.pdf` })));
    const numbers = docs.map(x => x.controlNumber);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers.every(n => n && n.startsWith(`${series}-`))).toBe(true);
  }, 90_000);
});

d("G — lifecycle keeps every number", () => {
  it("a voided disposal receipt stays in the register and in the ledger; its facility number no longer counts as a prior document", async () => {
    const w = await world();
    const c = callerFor(w.office);
    const cap = await c.documentControl.documents.intake({ definitionKey: "external_disposal_receipt", title: "to void", originKind: "external_scanned", issuer: { issuerKind: "facility", issuerFacilityId: w.fac }, evidenceRecordId: await evidence(w.office, sha("void")), contentHash: sha(`void-${rnd()}`), externalReferences: [{ referenceType: "facility_ticket_number", referenceValue: w.ftn1 }], links: [{ recordType: "disposal_ticket", recordRef: w.t1.ticketNumber, recordId: w.t1.id }], requestedState: "captured" });
    await c.documentControl.documents.void({ documentRef: cap.documentRef, reason: "attached to the wrong disposal record" });
    expect(await documentRow(cap.documentRef)).toMatchObject({ controlState: "void" });
    const [ledger] = await pool.query<mysql.RowDataPacket[]>("SELECT sequenceType, state FROM numberAllocations WHERE formattedNumber = ?", [cap.documentRef]);
    expect(ledger).toEqual([expect.objectContaining({ sequenceType: "DOC" })]);
    // The clean paper is not a duplicate of a void one.
    const r = await receipt(w, { ticket: w.t1, loadId: w.l1.id, number: w.ftn1, bytes: `after-void-${rnd()}` });
    expect(r.controlState).toBe("confirmed");
  }, 60_000);
});
