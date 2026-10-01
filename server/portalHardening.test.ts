import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { credentialCheck, encryptSecret, decryptSecret, failureUpdate, invitationCheck, totpCode, LOCKOUT_AFTER } from "./_core/externalIdentityPolicy";
import { billedView, decideAdjustment } from "./_core/clientAdjustments";
import { renderPdf, sha256Hex, ticketLines } from "./_core/ticketPdf";
import type { SiteSnapshot, PostSiteAuthorization } from "./_core/siteCloseout";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

// The object store is remote; rendered PDFs live in memory for these scenarios.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

/*
 * Both keys, because from 0193 portal MFA spans both stores. `LEASEOS_KEY_MFA_V1` is what new
 * enrolments are written under; `LEASEOS_PORTAL_MFA_KEY` remains decrypt-only for identities whose
 * seed has not been migrated yet, and for webhook secrets, which S2-E has not moved.
 *
 * Distinct material on purpose: if they were the same, a regression that wrote new secrets under
 * the legacy key would still pass here, which is exactly what this separation exists to prevent.
 */
process.env.LEASEOS_PORTAL_MFA_KEY = "a".repeat(64);
process.env.LEASEOS_KEY_MFA_V1 = "d".repeat(64);

const NOW = new Date("2026-09-10T12:00:00Z");
const idRow = (over = {}) => ({ status: "active" as const, acceptedAt: new Date("2026-09-01T00:00:00Z"), tokenExpiresAt: new Date("2026-12-01T00:00:00Z"), lockedUntil: null, failedAttempts: 0, mfaEnabled: false, ...over });

describe("who may use a token, and why not", () => {
  it("refuses revoked, suspended, unaccepted, locked and expired identities by name", () => {
    expect(credentialCheck(idRow(), NOW)).toEqual({ allowed: true, reason: null });
    expect(credentialCheck(idRow({ status: "revoked" }), NOW).reason).toBe("Portal identity is revoked");
    expect(credentialCheck(idRow({ status: "invited", acceptedAt: null }), NOW).reason).toBe("Invitation not yet accepted");
    expect(credentialCheck(idRow({ lockedUntil: new Date("2026-09-10T12:10:00Z") }), NOW).reason).toContain("Locked after 5 failed attempts");
    expect(credentialCheck(idRow({ tokenExpiresAt: new Date("2026-09-01T00:00:00Z") }), NOW).reason).toContain("Token expired");
    expect(invitationCheck({ status: "invited", invitationExpiresAt: new Date("2026-09-09T00:00:00Z"), acceptedAt: null }, NOW).reason).toContain("Invitation expired");
    expect(invitationCheck({ status: "active", invitationExpiresAt: null, acceptedAt: NOW }, NOW).reason).toContain("already accepted");
  });
  it("locks on the fifth failure and not before", () => {
    expect(failureUpdate(3, NOW).lockedUntil).toBeNull();
    expect(failureUpdate(LOCKOUT_AFTER - 1, NOW).lockedUntil?.toISOString()).toBe("2026-09-10T12:15:00.000Z");
  });
  it("keeps the MFA secret only encrypted, and round-trips it", () => {
    const key = Buffer.from("a".repeat(64), "hex");
    const enc = encryptSecret("JBSWY3DPEHPK3PXP", key);
    expect(enc).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc, key)).toBe("JBSWY3DPEHPK3PXP");
  });
});

describe("a client adjustment is billing value, never worked time", () => {
  const billing = { siteSubtotalCents: 175_750, siteBillableHours: 9.5, agreedHourlyRateCents: 18_500 };
  it("computes an hour-equivalent at the agreed rate, and refuses one when nothing prices the ticket", () => {
    const d = decideAdjustment({ kind: "hour_equivalent", hourEquivalent: 1, recipientIntent: "crew", reason: "Crew stayed through the storm" }, billing);
    expect(d).toMatchObject({ permitted: true, amountCents: 18_500, hourEquivalentMinutes: 60, payrollTreatment: "proposed", clocksUnchanged: true });
    if (d.permitted) expect(d.basis.note).toContain("NOT worked time");
    const noRate = decideAdjustment({ kind: "hour_equivalent", hourEquivalent: 1, recipientIntent: "company", reason: "x".repeat(6) }, { ...billing, agreedHourlyRateCents: null });
    expect(noRate.permitted).toBe(false);
    if (!noRate.permitted) expect(noRate.refusals[0]).toContain("needs the agreed hourly rate");
  });
  it("computes a percentage of the site subtotal, keeps a tip for the company out of payroll, and holds an unknown recipient", () => {
    const pct = decideAdjustment({ kind: "percent", percent: 10, recipientIntent: "company", reason: "Great job all round" }, billing);
    expect(pct).toMatchObject({ permitted: true, amountCents: 17_575, hourEquivalentMinutes: null, payrollTreatment: "not_applicable" });
    const tip = decideAdjustment({ kind: "tip", amountCents: 5_000, recipientIntent: "unknown", reason: "For the crew, decide who" }, billing);
    expect(tip).toMatchObject({ permitted: true, payrollTreatment: "awaiting_recipient" });
    expect(decideAdjustment({ kind: "tip", amountCents: 5_000, recipientIntent: "named_workers", reason: "for J. Smith" }, billing).permitted).toBe(false);
  });
  it("shows the invoice with the hour-equivalent inside it, and the verified worked hours without", () => {
    const v = billedView(9.58, 2.24, [{ kind: "hour_equivalent", amountCents: 18_500, hourEquivalentMinutes: 60, status: "authorized" }, { kind: "tip", amountCents: 5_000, hourEquivalentMinutes: null, status: "authorized" }, { kind: "flat", amountCents: 9_999, hourEquivalentMinutes: 120, status: "withdrawn" }]);
    expect(v).toMatchObject({ workedHoursVerified: 11.82, hourEquivalentHours: 1, invoiceHours: 12.82, adjustmentCents: 23_500 });
    expect(v.note).toContain("billing value, not worked time");
  });
});

describe("the PDF is made from the frozen snapshot", () => {
  const snap: SiteSnapshot = { minimumApplied: null, ticketNumber: "FT-1", jobId: 1, customer: "ABC Energy", site: "10-22", unitId: 142, operatorId: 7, arrivalAt: "2026-09-10T07:18:00Z", workStartAt: "2026-09-10T07:31:00Z", siteWorkCompleteAt: "2026-09-10T17:06:00Z", loads: 7, siteBillableHours: 9.58, standbyHours: 1.25, standbyBillable: "yes", lines: [{ id: 1, lineKind: "time", description: "Hydrovac", quantity: 9.58, unit: "h", measurementMethod: null }], events: [{ eventType: "site_work", from: "2026-09-10T07:31:00Z", to: "2026-09-10T12:00:00Z", hours: 4.48, customerBillable: "yes" }, { eventType: "restock", from: "2026-09-10T20:31:00Z", to: "2026-09-10T20:52:00Z", hours: 0.35, customerBillable: "no" }], postSiteRequired: true, unclosedSiteEvents: 0 };
  it("is valid, deterministic, and states the source hash, the excluded company activity and the hour-equivalent", () => {
    const doc = { ticketNumber: "FT-1", revision: 1, kind: "site_signed", snapshotHash: "c".repeat(64), generatedAt: NOW, signatory: { name: "M. Johnson", company: "ABC Energy", exercised: ["work_confirmation"], withinAuthority: "yes", signedAt: NOW }, postSiteAuthorization: { disposalRequired: true }, customerComments: ["Well done"], supplement: null, adjustments: [{ kind: "hour_equivalent", amountCents: 18_500, hourEquivalentMinutes: 60, reason: "storm" }] };
    const lines = ticketLines(snap, doc);
    const text = lines.join("\n");
    expect(text).toContain(`Source snapshot ${"c".repeat(64)}`);
    expect(text).toContain("restock: 0.35 h");
    expect(text).toContain("NOT worked time");
    const a = renderPdf("T", lines), b = renderPdf("T", lines);
    expect(a.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(a.toString("latin1")).toContain("%%EOF");
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(renderPdf("T", Array.from({ length: 120 }, (_, i) => `line ${i}`)).toString("latin1")).toContain("/Count 3");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_100_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string | null, mfa?: string) => appRouter.createCaller({ req: { headers: { ...(token ? { "x-portal-token": token } : {}), ...(mfa ? { "x-portal-mfa": mfa } : {}) } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const AUTH: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };

d("the customer's identity, from invitation to revocation", () => {
  it("accepts an invitation once, refuses the bearer before acceptance, rotates with a grace window, locks after failures, requires MFA on sensitive writes once confirmed, and is refused after revocation", async () => {
    const controller = await withRole("controller");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    // The invitation token is not a bearer token, and the identity is not active until accepted.
    await expect(portalCaller(inv.invitationToken).portal.me()).rejects.toThrow(/Unknown portal token/);
    const [pre] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, invitationTokenHash FROM externalIdentities WHERE identityRef = ?", [inv.identityRef]);
    expect(pre[0].status).toBe("invited");
    expect(pre[0].invitationTokenHash).not.toContain(inv.invitationToken);
    const acc = await portalCaller(inv.invitationToken).portal.invitationAccept();
    expect(acc.token.length).toBeGreaterThan(30);
    await expect(portalCaller(inv.invitationToken).portal.invitationAccept()).rejects.toThrow(/Unknown invitation/); // once
    expect((await portalCaller(acc.token).portal.me()).displayName).toBe("M. Johnson");

    // Rotation: the new token works, the old one for the grace window.
    const rot = await portalCaller(acc.token).portal.tokenRotate();
    expect((await portalCaller(rot.token).portal.me()).kind).toBe("customer");
    expect((await portalCaller(acc.token).portal.me()).kind).toBe("customer");
    await pool.execute("UPDATE externalIdentities SET previousTokenExpiresAt = '2026-01-01 00:00:00' WHERE identityRef = ?", [inv.identityRef]);
    await expect(portalCaller(acc.token).portal.me()).rejects.toThrow(/Unknown portal token/);

    // MFA: enrolled, confirmed with a real code; then a sensitive write needs a code, a read does not; wrong codes lock.
    const enr = await portalCaller(rot.token).portal.mfaEnroll();
    expect(enr.otpauth).toContain("otpauth://totp/");
    await expect(portalCaller(rot.token).portal.mfaConfirm({ code: "000000" })).rejects.toThrow(/Code rejected/);
    await portalCaller(rot.token).portal.mfaConfirm({ code: totpCode(enr.secret, new Date()) });
    expect((await portalCaller(rot.token).portal.customerStatement()).account.name).toBe("ABC Energy"); // reads: no MFA header needed
    await expect(portalCaller(rot.token).portal.tokenRotate()).rejects.toThrow(/MFA code required/);   // failure 1: no code
    for (let i = 0; i < 3; i++) await expect(portalCaller(rot.token, "111111").portal.tokenRotate()).rejects.toThrow(/MFA code required or rejected/); // 2, 3, 4
    await expect(portalCaller(rot.token, "111111").portal.tokenRotate()).rejects.toThrow(/locked until/);   // 5: locked
    await expect(portalCaller(rot.token).portal.me()).rejects.toThrow(/Locked after 5 failed attempts/);   // even a read, now
    await pool.execute("UPDATE externalIdentities SET lockedUntil = NULL, failedAttempts = 0 WHERE identityRef = ?", [inv.identityRef]);
    const rot2 = await portalCaller(rot.token, totpCode(enr.secret, new Date())).portal.tokenRotate();
    expect(rot2.token).not.toBe(rot.token);

    // Revoked: refused by name, previous token gone, and the log holds the lifecycle.
    await callerFor(controller).portalAdmin.identityRevoke({ identityRef: inv.identityRef, reason: "Contact left ABC Energy" });
    await expect(portalCaller(rot2.token).portal.me()).rejects.toThrow(/revoked/);
    const [log] = await pool.execute<mysql.RowDataPacket[]>("SELECT action FROM externalAccessLog WHERE externalIdentityId = (SELECT id FROM externalIdentities WHERE identityRef = ?) ORDER BY id", [inv.identityRef]);
    expect(log.map(l => l.action)).toEqual(["accept_invitation", "token_rotate", "mfa_enroll", "mfa_confirm", "view", "token_rotate"]);
  });
});

d("a signed ticket, a bonus, a document, a report", () => {
  it("adds an hour-equivalent that changes billing and no clock, renders R1 from the frozen snapshot, downloads it under audit and account scope, and reports the day from the records", async () => {
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const office = await withRole("office");
    const payroll = await withRole("payroll_admin");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const c = callerFor(driver).closeout;
    const [fixtureUnit133] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit133.insertId, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("17:00"), source: "pto", confidence: "high" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "restock", occurredAt: at("20:31"), endedAt: at("20:52") });
    await c.weatherObserve({ ticketNumber: t.ticketNumber, observedAt: at("15:42"), observerType: "worker", conditions: ["heavy snow", "road accumulating"], visibility: "reduced", roadState: "snow", severity: "moderate", operationalEffect: "Travel speed reduced", gps: { latitude: 53.5, longitude: -113.4 } });
    await expect(c.weatherObserve({ ticketNumber: t.ticketNumber, observedAt: at("15:45"), observerType: "external_source", conditions: ["snow"], severity: "moderate" })).rejects.toThrow(/must be named/);
    await c.roadHazardReport({ ticketNumber: t.ticketNumber, observedAt: at("16:10"), hazard: "snow_ice", severity: "severe", description: "Icy downhill grade 18 km north" });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("17:00") });
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    const token = (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;
    await portalCaller(token).portal.fieldTicketSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, authorities: ["work_confirmation", "time_confirmation"], postSiteAuthorization: null });

    // The clocks before the bonus.
    const [evBefore] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType, occurredAt, endedAt, customerBillable FROM fieldTicketEvents WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) ORDER BY id", [t.ticketNumber]);
    const adj = await portalCaller(token).portal.adjustmentAuthorize({ ticketNumber: t.ticketNumber, kind: "hour_equivalent", hourEquivalent: 1, recipientIntent: "crew", reason: "Crew stayed through the snow", agreedHourlyRateCents: 18_500 });
    expect(adj).toMatchObject({ duplicate: false, amountCents: 18_500, hourEquivalentMinutes: 60, payrollTreatment: "proposed", clocksUnchanged: true });
    const again = await portalCaller(token).portal.adjustmentAuthorize({ ticketNumber: t.ticketNumber, kind: "hour_equivalent", hourEquivalent: 1, recipientIntent: "crew", reason: "Crew stayed through the snow", agreedHourlyRateCents: 18_500 });
    expect(again).toMatchObject({ adjustmentRef: adj.adjustmentRef, duplicate: true });
    const [evAfter] = await pool.execute<mysql.RowDataPacket[]>("SELECT eventType, occurredAt, endedAt, customerBillable FROM fieldTicketEvents WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) ORDER BY id", [t.ticketNumber]);
    expect(evAfter).toEqual(evBefore);                                     // no clock moved
    const [r1] = await pool.execute<mysql.RowDataPacket[]>("SELECT snapshotHash FROM fieldTicketRevisions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) AND revision = 1", [t.ticketNumber]);
    expect(r1[0].snapshotHash).toBe(prep.snapshotHash);                    // R1 unchanged
    const [adjRow] = await pool.execute<mysql.RowDataPacket[]>("SELECT payrollTreatment, payrollAdjustmentRef, basisJson FROM clientAdjustments WHERE adjustmentRef = ?", [adj.adjustmentRef]);
    expect(adjRow[0]).toMatchObject({ payrollTreatment: "proposed", payrollAdjustmentRef: null }); // payroll untouched by the customer
    expect(JSON.parse(adjRow[0].basisJson).note).toContain("NOT worked time");

    // Payroll: a payroll admin proposes it for a profile; it is a REQUEST, not applied.
    const [prof] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO employeePayrollProfiles (workerRef, employmentType, payFrequency, createdAt) VALUES (?, 'employee', 'biweekly', NOW())", [key("W").slice(0, 40)]).catch(() => [{ insertId: 0 }] as never);
    if (Number(prof.insertId) > 0) {
      const pp = await callerFor(payroll).closeout.adjustmentPayrollPropose({ adjustmentRef: adj.adjustmentRef, employeePayrollProfileId: Number(prof.insertId), amountCents: 18_500, note: "Split per crew lead" });
      const [pa] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM payrollAdjustments WHERE adjustmentRef = ?", [pp.payrollAdjustmentRef]);
      expect(pa[0].status).toBe("requested");
    }
    await expect(callerFor(driver).closeout.adjustmentPayrollPropose({ adjustmentRef: adj.adjustmentRef, employeePayrollProfileId: 1, amountCents: 100, note: "driver cannot" })).rejects.toBeTruthy();

    // R1 rendered from the frozen snapshot; a second render returns the same record; the customer downloads it, audited, and another account cannot.
    const [rev] = await pool.execute<mysql.RowDataPacket[]>("SELECT documentRef FROM fieldTicketRevisions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) AND revision = 1", [t.ticketNumber]);
    const pdf = await callerFor(office).closeout.documentRender({ documentRef: rev[0].documentRef });
    expect(pdf.alreadyRendered).toBe(false);
    expect((await callerFor(office).closeout.documentRender({ documentRef: rev[0].documentRef })).alreadyRendered).toBe(true);
    const list = await portalCaller(token).portal.documents();
    expect(list.documents.map(x => [x.kind, x.sourceSnapshotHash])).toEqual([["site_ticket_r1", prep.snapshotHash]]);
    const dl = await portalCaller(token).portal.documentDownload({ documentRef: pdf.documentRef, purpose: "AP filing" });
    const bytes = Buffer.from(dl.dataBase64, "base64");
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    expect(sha256Hex(bytes)).toBe(pdf.contentHash);
    expect(bytes.toString("latin1")).toContain(`Source snapshot ${prep.snapshotHash}`);
    // R1 is the SITE signature: its frozen snapshot holds site-phase events only. The 20:31 restock is not in it —
    // it belongs to the post-site revision's excluded list and to the daily report below, never to the customer's bill.
    expect(bytes.toString("latin1")).toContain("none recorded on this revision"); // parentheses are escaped inside the stream
    expect(bytes.toString("latin1")).not.toContain("restock");
    const otherRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [otherRef, entityId]);
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: otherRef, email: "x@bravo.example", displayName: "Bravo" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    await expect(portalCaller(otherToken).portal.documentDownload({ documentRef: pdf.documentRef })).rejects.toThrow(/No such document on this account/);
    const [dlog] = await pool.execute<mysql.RowDataPacket[]>("SELECT action, recordRef, recordVersion, context FROM externalAccessLog WHERE action = 'download' AND recordRef = ?", [pdf.documentRef]);
    expect(dlog).toHaveLength(1);
    expect(dlog[0]).toMatchObject({ recordVersion: pdf.contentHash, context: "AP filing" });

    // The day, from the records: hours by billing answer, the restock as company-internal, observations counted, value not invented.
    const rep = await portalCaller(token).portal.dailyReport({ date: "2026-09-10" });
    expect(rep.hours).toEqual({ customerBillable: 9.48, underReview: 0, companyInternalNotBilled: 0.35 });
    expect(rep.observations).toEqual({ weather: 1, roadHazards: 1 });
    expect(rep.adjustmentsCents).toBe(18_500);
    expect(rep.estimatedValue.status).toBe("not_computed");
    const obs = await portalCaller(token).portal.observations({ ticketNumber: t.ticketNumber });
    expect(obs.weather[0]).toMatchObject({ source: "worker observation", severity: "moderate", billingTreatment: "review" });
    expect(Object.keys(obs.weather[0])).not.toContain("latitude");        // never coordinates, never who
    expect(obs.roadHazards[0]).toMatchObject({ hazard: "snow_ice", billingTreatment: "review" });
  });
});
