/**
 * 0175 CP3 — the customer-safe tracking API, through the gate, against the database.
 *
 * One job in organization A with a field ticket, events, lines (one internal-only, one priced), three
 * loads, a trip with breadcrumbs, a disposal ticket, a safety event whose title names a person, and
 * two catalogued documents of which one is released. The suite proves the projection reads the
 * canonical records and leaks none of the private ones; that location follows the link's mode and
 * says when it is stale; that an unreleased document is "not found" and a released one is served
 * after its hash check; that the open ticket hides internal-only lines and labels its subtotal as an
 * estimate; and that a link whose scope excludes billing or documents is refused by name.
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
describe("tracking api — preconditions", () => { it("runs against a real database", () => { expect(DB_URL, "DATABASE_URL must be set").toBeTruthy(); }); });

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 656_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const trackingCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-tracking-token": token } } as never, res: {} as never, user: null as never });
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
async function job(orgRef: string, status = "on_site") {
  const jobCode = `JOB-${rnd()}`;
  await pool.execute("INSERT INTO jobs (orgRef, jobCode, type, mode, customer, location, status, progress, eta, driver) VALUES (?,?,'Hydrovac excavation','hydrovac','Northgate Energy','10-22-045-06-W5',?,0,'14:30','Jane Doe 780-555-0100')", [orgRef, jobCode, status]);
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM jobs WHERE jobCode = ?", [jobCode]);
  return { id: Number(r[0]!.id), jobCode };
}
async function account(orgRef: string) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (orgRef, entityRef, legalName, taxpayerType, jurisdiction) VALUES (?,?,'Fixture Co','corporation','CA-AB')", [orgRef, `ENT-${rnd()}`]);
  const accountRef = `CUST-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?,?,?)", [accountRef, e.insertId, `Client ${accountRef}`]);
  const [a] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM customerAccounts WHERE accountRef = ?", [accountRef]);
  return { id: Number(a[0]!.id), accountRef, entityId: Number(e.insertId) };
}
async function unit(orgRef: string) {
  const unitNumber = `U-${rnd()}`;
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, vin, plate) VALUES (?, 'hydrovac', 'VIN-SECRET-1', 'PLATE-SECRET')", [unitNumber]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return { id: Number(u.insertId), unitNumber };
}
async function operator(orgRef: string) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, licenseNumber, emergencyContact, restrictions) VALUES ('Jane Marie Doe', 'AB-12345-XYZ', 'John Doe 780-555-0101', 'corrective lenses')");
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [orgRef, o.insertId]);
  return Number(o.insertId);
}

d("the customer-safe tracking API", () => {
  it("projects the job, its loads, its released documents and its open ticket from the canonical records — and nothing private", async () => {
    const A = await org(); const B = await org();
    const office = await member(A, "office"); const officeB = await member(B, "office");
    const jobA = await job(A); const jobB = await job(B);
    const acct = await account(A);
    const u = await unit(A); const op = await operator(A);
    const [fac] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'unknown')", [`Edson TRD ${rnd()}`]);
    const facName = (await pool.query<mysql.RowDataPacket[]>("SELECT name FROM facilities WHERE id = ?", [fac.insertId]))[0][0]!.name as string;

    // The field ticket, through the canonical closeout chain.
    const c = caller(office).closeout;
    const t = await c.ticketOpen({ jobId: jobA.id, customerAccountRef: acct.accountRef, unitId: u.id, operatorId: op, serviceDescription: "Hydrovac excavation", afeNumber: "AFE-77", postSiteRequired: false });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), detail: "Waiting on wireline — driver says supervisor R. Davis was late", source: "pto", confidence: "high" });
    const visibleLine = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "VAC-HR", description: "Truck service", quantity: 4.5, quantityUnit: "h" });
    const internalLine = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "Internal fuel basis 41.10/h — cost", quantity: 1, quantityUnit: "each" });
    await pool.execute("UPDATE fieldTicketLines SET customerVisible = 0 WHERE id = ?", [internalLine.lineId]);
    // A priced decision for the visible line, as the rate engine would have written it.
    await pool.execute("INSERT INTO pricingDecisions (decisionRef, financialEntityId, rateKind, subjectKind, subjectRef, serviceCode, quantityMillis, unit, measurementSource, outcome, rateMillis, billableQuantityMillis, formula, inputsJson, amountCents, reasonsJson, decidedByUserId) VALUES (?,?,'sell','field_ticket_line',?,'VAC-HR',4500,'hour','clock','priced',185000,4500,'q*r','{}',83250,'[]',?)", [`PR-${rnd()}`, acct.entityId, `line:${visibleLine.lineId}`, office]);
    const [pr] = await pool.query<mysql.RowDataPacket[]>("SELECT decisionRef FROM pricingDecisions WHERE subjectRef = ?", [`line:${visibleLine.lineId}`]);
    await pool.execute("UPDATE fieldTicketLines SET pricingDecisionRef = ? WHERE id = ?", [pr[0]!.decisionRef, visibleLine.lineId]);

    // Loads, a trip with breadcrumbs, a disposal ticket, a safety event naming a person.
    const [trip] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, jobId, unitId, operatorId, destinationFacilityId, status, startedAt, notes) VALUES (?,?,?,?,?,'in_transit',?, 'driver took the long way; HOS at 412 min')", [`T-${rnd()}`, jobA.id, u.id, op, fac.insertId, at("06:40")]);
    const loadNumbers = [`LD-${rnd()}`, `LD-${rnd()}`, `LD-${rnd()}`];
    await pool.execute("INSERT INTO loads (loadNumber, jobId, tripId, unitId, material, quantity, quantityUnit, measurementMethod, chainState, createdAt) VALUES (?,?,?,?,'produced water',12.4,'m3','scale','disposal_verified',?), (?,?,?,?,'slurry',11.8,'m3','customer_stated','in_transit',?), (?,?,NULL,?,NULL,NULL,NULL,'unknown','created',?)",
      [loadNumbers[0], jobA.id, trip.insertId, u.id, at("08:00"), loadNumbers[1], jobA.id, trip.insertId, u.id, at("10:00"), loadNumbers[2], jobA.id, u.id, at("12:00")]);
    const [ld] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM loads WHERE loadNumber = ?", [loadNumbers[0]]);
    await pool.execute("INSERT INTO disposalTickets (ticketNumber, loadId, jobId, tripId, facilityId, facilityTicketNumber, scaleInAt, quantity, quantityUnit, verificationStatus) VALUES (?,?,?,?,?,'SEC-44821',?,12.4,'m3','verified')", [`DSP-${rnd()}`, ld[0]!.id, jobA.id, trip.insertId, fac.insertId, at("09:00")]);
    await pool.execute("INSERT INTO safetyEvents (jobId, eventType, severity, title, detail, occurredAt, status) VALUES (?, 'vehicle_defect', 'warning', 'Hydraulic hose blew on J. Smith', 'Operator reports wrist pain; supervisor R. Davis investigating', ?, 'open')", [jobA.id, at("09:15")]);
    const fresh = new Date(Date.now() - 4 * 60_000);
    await pool.execute("INSERT INTO tripBreadcrumbs (tripId, unitId, latitude, longitude, speedKmh, headingDegrees, accuracyMetres, source, recordedAt) VALUES (?,?,53.123456,-116.654321,82,270,6,'gps',?)", [trip.insertId, u.id, fresh]);

    // Three links: no location; approximate with billing; live with everything.
    const off = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "none", livePreset: "manual" });
    const approx = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "approximate", livePreset: "manual", scope: { billing: true } });
    const live = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "live", livePreset: "manual", scope: { billing: true, act: true } });
    const anon = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "live", livePreset: "manual", scope: { unit: false, operator: false, documents: false } });

    // (1) Status: the customer's vocabulary, from the open safety event first.
    const s = await trackingCaller(live.token).tracking.status();
    expect(s).toMatchObject({ jobReference: jobA.jobCode, customerReference: "AFE-77", serviceType: "Hydrovac excavation (hydrovac)", origin: "10-22-045-06-W5", destination: facName, status: { label: "Attention" }, unit: { unitNumber: u.unitNumber, vehicleType: "hydrovac" }, operatorDisplayName: "Jane", eta: "14:30", ticketNumbers: [t.ticketNumber] });
    expect(s.arrivedAt).toEqual(at("07:31"));
    expect(s.location).toMatchObject({ mode: "live", position: { latitude: 53.123456, longitude: -116.654321, precision: "exact" }, heading: 270, speedKmh: 82, stale: false });
    // Nothing private crossed: the event detail, the safety title, the licence, the contacts, the VIN, the trip notes, the other organization's job.
    const text = JSON.stringify(s);
    for (const forbidden of ["wireline", "Davis", "Hydraulic", "Smith", "wrist", "AB-12345", "780-555", "John Doe", "corrective", "VIN-SECRET", "PLATE-SECRET", "long way", "412", "Doe", jobB.jobCode, String(jobA.id)]) expect(text, forbidden).not.toContain(forbidden);
    // With the safety event resolved, the open site work decides.
    await pool.execute("UPDATE safetyEvents SET status = 'resolved' WHERE jobId = ?", [jobA.id]);
    expect((await trackingCaller(live.token).tracking.status()).status).toMatchObject({ label: "In Progress", basis: "Ticket event site work in progress" });

    // (2) Location follows the link, not the request: none, approximate (rounded, no heading), live; identity flags hide the unit and operator.
    expect((await trackingCaller(off.token).tracking.status()).location).toMatchObject({ mode: "none", position: null });
    const ap = (await trackingCaller(approx.token).tracking.status()).location;
    expect(ap).toMatchObject({ mode: "approximate", position: { latitude: 53.12, longitude: -116.65, precision: "approximate" }, heading: null, speedKmh: null, stale: false });
    const hidden = await trackingCaller(anon.token).tracking.status();
    expect(hidden.unit).toBeNull();
    expect(hidden.operatorDisplayName).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain(u.unitNumber);
    expect(JSON.stringify(hidden)).not.toContain("Jane");

    // (3) A stale fix is named stale, never live.
    await pool.execute("UPDATE tripBreadcrumbs SET recordedAt = ? WHERE tripId = ?", [new Date(Date.now() - 47 * 60_000), trip.insertId]);
    const stale = (await trackingCaller(live.token).tracking.status()).location;
    expect(stale.stale).toBe(true);
    expect(stale.note).toMatch(/4[67] minutes old — stale, not live/);

    // (4) Loads: every load on the job, in sequence, with its disposal ticket and destination.
    const l = await trackingCaller(live.token).tracking.loads();
    expect(l).toMatchObject({ jobReference: jobA.jobCode, total: 3, completed: 1, active: 2 });
    expect(l.items.map(x => [x.sequence, x.loadNumber, x.status])).toEqual([[1, loadNumbers[0], "completed"], [2, loadNumbers[1], "in_transit"], [3, loadNumbers[2], "in_progress"]]);
    expect(l.items[0]).toMatchObject({ disposalTicketNumber: "SEC-44821", disposalVerified: true, destination: facName, measured: "scale" });
    expect(l.items[1]).toMatchObject({ measured: "customer stated", disposalTicketNumber: null });

    // (5) Documents: an unreleased document is not listed and not served; a released one is, after its hash check; a withdrawn one is gone again.
    const bytes = Buffer.from("%PDF-1.4 fixture ticket R1");
    const key = `tickets/${t.ticketNumber}/R1-${sha(bytes).slice(0, 12)}.pdf`;
    objects.set(key, bytes);
    await pool.execute("INSERT INTO fieldTicketDocuments (documentRef, fieldTicketId, kind, storageKey, contentHash, sourceSnapshotHash, byteLength, generatedByUserId, generatedAt) VALUES (?,?,'site_ticket_r1',?,?,?,?,?,NOW())", [`${t.ticketNumber}-R1-PDF`, (await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTickets WHERE ticketNumber = ?", [t.ticketNumber]))[0][0]!.id, key, sha(bytes), "s".repeat(64), bytes.length, office]);
    const [docRow] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM fieldTicketDocuments WHERE documentRef = ?", [`${t.ticketNumber}-R1-PDF`]);
    expect((await trackingCaller(live.token).tracking.documents()).documents).toEqual([]);
    await expect(trackingCaller(live.token).tracking.documentDownload({ releaseRef: "REL-2026-000001" })).rejects.toThrow(/Document not found/);
    // B cannot release A's document onto B's job, nor onto A's job.
    await expect(caller(officeB).clientServices.documentRelease({ jobId: jobB.id, sourceType: "fieldTicketDocument", sourceId: Number(docRow[0]!.id), kind: "signed_field_ticket" })).rejects.toThrow(/Document not found/);
    await expect(caller(officeB).clientServices.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(docRow[0]!.id), kind: "signed_field_ticket" })).rejects.toThrow(/not found/i);
    const rel = await caller(office).clientServices.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(docRow[0]!.id), kind: "signed_field_ticket", title: "Signed field ticket R1" });
    expect(rel).toMatchObject({ documentRef: `${t.ticketNumber}-R1-PDF`, status: "released", alreadyReleased: false });
    expect(rel.releaseRef).toMatch(/^REL-\d{4}-\d{6}$/);
    expect((await caller(office).clientServices.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(docRow[0]!.id), kind: "signed_field_ticket" })).alreadyReleased).toBe(true);
    const listed = (await trackingCaller(live.token).tracking.documents()).documents;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ releaseRef: rel.releaseRef, documentRef: `${t.ticketNumber}-R1-PDF`, kind: "signed_field_ticket", title: "Signed field ticket R1", contentHash: sha(bytes) });
    const dl = await trackingCaller(live.token).tracking.documentDownload({ releaseRef: rel.releaseRef });
    expect(Buffer.from(dl.dataBase64, "base64").equals(bytes)).toBe(true);
    expect(dl).toMatchObject({ documentRef: `${t.ticketNumber}-R1-PDF`, mimeType: "application/pdf", contentHash: sha(bytes) });
    // A link without the documents scope is refused by name.
    await expect(trackingCaller(anon.token).tracking.documents()).rejects.toThrow(/does not permit documents/);
    await expect(trackingCaller(anon.token).tracking.documentDownload({ releaseRef: rel.releaseRef })).rejects.toThrow(/does not permit documents/);
    // Tampered bytes are not served.
    objects.set(key, Buffer.from("%PDF-1.4 altered"));
    await expect(trackingCaller(live.token).tracking.documentDownload({ releaseRef: rel.releaseRef })).rejects.toThrow(/does not match its recorded hash/);
    objects.set(key, bytes);
    // Withdrawn: gone from the list and the download, and B cannot withdraw it.
    await expect(caller(officeB).clientServices.documentWithdraw({ releaseRef: rel.releaseRef, reason: "intrusion" })).rejects.toThrow(/not found/i);
    await caller(office).clientServices.documentWithdraw({ releaseRef: rel.releaseRef, reason: "wrong revision released" });
    expect((await trackingCaller(live.token).tracking.documents()).documents).toEqual([]);
    await expect(trackingCaller(live.token).tracking.documentDownload({ releaseRef: rel.releaseRef })).rejects.toThrow(/Document not found/);
    // Re-release reuses the release number.
    expect((await caller(office).clientServices.documentRelease({ jobId: jobA.id, sourceType: "fieldTicketDocument", sourceId: Number(docRow[0]!.id), kind: "signed_field_ticket" })).releaseRef).toBe(rel.releaseRef);
    expect((await caller(office).clientServices.documentReleases({ jobId: jobA.id })).releases.map(r => [r.releaseRef, r.status])).toEqual([[rel.releaseRef, "released"]]);

    // (6) The open ticket: internal-only line hidden, the priced line summed as an estimate, the unpriced named; a link without billing is refused.
    await expect(trackingCaller(off.token).tracking.openTicket()).rejects.toThrow(/does not permit billing/);
    const ot = await trackingCaller(approx.token).tracking.openTicket();
    expect(ot.tickets).toHaveLength(1);
    const tk = ot.tickets[0]!;
    expect(tk).toMatchObject({ ticketNumber: t.ticketNumber, status: "OPEN", customerPoNumber: null, finalized: null, invoiced: null });   // 0175 CP5: work started, so the open ticket is OPEN
    expect(tk.lines.map(x => x.description)).toEqual(["Truck service"]);
    expect(tk.accrued).toMatchObject({ subtotalCents: 83_250, pricedLines: 1, unpricedLines: 0, hiddenLines: 1, isFinal: false });
    expect(tk.accrued.label).toMatch(/not an invoice/);
    expect(JSON.stringify(ot)).not.toContain("41.10");
    expect(JSON.stringify(ot)).not.toContain("fuel basis");

    // (7) Everything the customer did is on A's ledger; B's ledger is untouched.
    const trail = await caller(office).clientServices.auditTrail({ jobId: jobA.id });
    const types = trail.events.map(e => e.eventType);
    expect(types).toContain("customer_document_viewed");
    expect(types).toContain("customer_document_downloaded");
    expect(types).toContain("customer_document_released");
    expect(types).toContain("customer_document_withdrawn");
    expect(types).toContain("customer_ticket_viewed");
    expect(trail.events.find(e => e.eventType === "customer_document_downloaded")!.payload).toMatchObject({ releaseRef: rel.releaseRef, contentHash: sha(bytes) });
    expect(await caller(office).clientServices.auditVerify()).toMatchObject({ ok: true });
    expect((await caller(officeB).clientServices.auditVerify()).rows).toBe(0);
  }, 90_000);

  it("ends live status and position under the link's completion rule while documents stay available", async () => {
    const A = await org();
    const office = await member(A, "office");
    const jobA = await job(A, "complete");
    await pool.execute("UPDATE jobs SET updatedAt = ? WHERE id = ?", [new Date(Date.now() - 30 * 3_600_000), jobA.id]);   // completed 30 h ago
    const day = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "live", livePreset: "24h" });
    const week = await caller(office).clientServices.trackingLinkCreate({ jobId: jobA.id, locationMode: "live", livePreset: "7d" });
    const ended = await trackingCaller(day.token).tracking.status();
    expect(ended.live).toMatchObject({ available: false, reason: "live tracking ended 24 h after completion" });
    expect(ended.location.position).toBeNull();
    expect(ended.eta).toBeNull();
    expect(ended.status.label).toBe("Completed");
    expect((await trackingCaller(day.token).tracking.documents()).documents).toEqual([]);   // still answered, not refused
    expect((await trackingCaller(week.token).tracking.status()).live.available).toBe(true);
  }, 30_000);
});
