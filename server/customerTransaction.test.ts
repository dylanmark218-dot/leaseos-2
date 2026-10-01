import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { alertText, wants, DEFAULT_ON } from "./_core/customerAlerts";
import { custodyRows, queueSummary } from "../client/src/portal/external/viewModels";
import { sha256Hex } from "./_core/ticketPdf";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import type { PostSiteAuthorization } from "./_core/siteCloseout";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

describe("alerts are templates on customer-safe kinds, honouring what the customer chose", () => {
  it("defaults the load-level kinds off and the rest on, and a stored preference wins", () => {
    expect(DEFAULT_ON.load_complete).toBe(false);
    expect(DEFAULT_ON.breakdown).toBe(true);
    expect(wants([], "breakdown")).toBe(true);
    expect(wants([{ eventKind: "breakdown", enabled: false }], "breakdown")).toBe(false);
    expect(wants([{ eventKind: "load_complete", enabled: true }], "load_complete")).toBe(true);
  });
  it("names the job and never carries anything but the template and the given detail", () => {
    const t = alertText("delay", { ticketNumber: "FT-1", jobCode: "JOB-9", detail: "customer hold" });
    expect(t.title).toBe("Delay recorded");
    expect(t.body).toContain("JOB-9 (FT-1)");
    expect(t.body).toContain("under review unless a contract rule decides it");
    expect(alertText("r2_available", { ticketNumber: "FT-1" }).body).toContain("R1 is unchanged");
  });
});

describe("the customer's chain-of-custody rows", () => {
  it("shows a quantity only with its method, and evidence only as far as the ticket's state", () => {
    const rows = custodyRows([
      { loadNumber: "LD-1", material: "produced water", quantity: 12.4, unit: "m3", measurementMethod: "scale", chainState: "disposal_verified", unitId: 142, destination: "Disposal A", disposal: { facilityTicketNumber: "F-1", evidence: "verified", confidence: "high", source: "facility submission" } },
      { loadNumber: "LD-2", material: "slurry", quantity: null, unit: null, measurementMethod: "driver_stated", chainState: "in_transit", unitId: 142, destination: null, disposal: null },
      { loadNumber: "LD-3", material: "slurry", quantity: 11.8, unit: "m3", measurementMethod: "ocr", chainState: "arrived_disposal", unitId: 142, destination: "Disposal B", disposal: { facilityTicketNumber: "F-3", evidence: "needs_review", confidence: "medium", source: "scan — proposed, not certified" } },
    ]);
    expect(rows[0]).toMatchObject({ quantityText: "12.4 m3 (scale)", evidenceTone: "ok" });
    expect(rows[1]).toMatchObject({ quantityText: "quantity not recorded (driver_stated)", evidenceText: "No disposal ticket yet", evidenceTone: "muted" });
    expect(rows[1].route).toContain("destination not recorded");
    expect(rows[2].evidenceText).toContain("scan — proposed, not certified — awaiting the contractor's verification");
    expect(rows[2].evidenceTone).toBe("warn");
    expect(queueSummary({ toSign: [1], toDecide: [1, 2], unreadAlerts: 0 })).toBe("1 ticket to sign · 2 lines to decide");
    expect(queueSummary({ toSign: [], toDecide: [], unreadAlerts: 0 })).toBe("Nothing awaits you");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_600_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const AUTH: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };

d("the customer's transaction, end to end", () => {
  it("is told at each step once, sees the loads as far as their evidence goes, works the queue, signs, gets R1 and the package, and another account gets none of it", async () => {
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const office = await withRole("office");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    const token = (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;
    // The customer does not want load-level noise (default off) and turns delays off explicitly.
    await portalCaller(token).portal.alertPreferencesSet({ eventKind: "delay", enabled: false });
    expect((await portalCaller(token).portal.alertPreferences()).preferences.find(p => p.eventKind === "delay")).toMatchObject({ enabled: false, isDefault: false });

    const c = callerFor(driver).closeout;
    const [fixtureUnit593] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit593.insertId, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: true });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00"), source: "pto", confidence: "high" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "customer_hold", occurredAt: at("12:00"), endedAt: at("13:15"), detail: "Waiting on wireline" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("13:15"), endedAt: at("17:06"), source: "pto", confidence: "high" });
    // Loads: one verified at a facility, one in transit with a driver-stated quantity.
    const [fac] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'open')", [key("F").slice(0, 60)]);
    const [ld1] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO loads (loadNumber, jobId, unitId, material, quantity, quantityUnit, measurementMethod, chainState, createdAt) VALUES (?, ?, 142, 'produced water', 12.4, 'm3', 'scale', 'disposal_verified', ?)", [key("LD").slice(0, 40), jobId, at("10:12")]);
    await pool.execute("INSERT INTO loads (loadNumber, jobId, unitId, material, quantity, quantityUnit, measurementMethod, chainState, createdAt) VALUES (?, ?, 142, 'slurry', 11.8, 'm3', 'customer_stated', 'in_transit', ?)", [key("LD").slice(0, 40), jobId, at("16:40")]);
    await pool.execute("INSERT INTO disposalTickets (ticketNumber, loadId, facilityId, facilityTicketNumber, scaleInAt, netKg, verificationStatus, source, confidence, createdAt) VALUES (?, ?, ?, 'F-88192', ?, 22300, 'verified', 'facility_portal', 'high', NOW())", [key("DSP").slice(0, 40), Number(ld1.insertId), Number(fac.insertId), at("11:15")]);

    const custody = await portalCaller(token).portal.chainOfCustody({ ticketNumber: t.ticketNumber });
    expect(custody.loads).toHaveLength(2);
    expect(custody.loads[0]).toMatchObject({ material: "produced water", measurementMethod: "scale", disposal: { facilityTicketNumber: "F-88192", evidence: "verified", source: "facility submission" } });
    expect(custody.loads[1]).toMatchObject({ material: "slurry", measurementMethod: "customer_stated", disposal: null });
    expect(custody.complete).toBe(false);                                   // the slurry has no ticket
    expect(custody.loads[0].timeline.map(e => e.what)[1]).toContain("Scaled in at");

    // Prepared: the sign-off alert arrives; the queue shows the ticket to sign.
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("17:06") });
    const q1 = await portalCaller(token).portal.approvalQueue();
    expect(q1.toSign.map(x => x.ticketNumber)).toEqual([t.ticketNumber]);
    const alerts1 = (await portalCaller(token).portal.alerts()).alerts.map(a => a.title);
    expect(alerts1).toContain("Ticket ready to sign");
    expect(alerts1).toContain("Crew arrived");
    expect(alerts1).not.toContain("Delay recorded");                        // turned off
    expect(alerts1.filter(x => x === "Crew arrived")).toHaveLength(1);       // once, though site work happened twice

    // Signed from the portal: R1 alert; a second identity on the same account is told too — once each.
    const second = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "ap@abc.example", displayName: "ABC AP" });
    const token2 = (await portalCaller(second.invitationToken).portal.invitationAccept()).token;
    await portalCaller(token).portal.fieldTicketSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, authorities: ["work_confirmation", "time_confirmation"], postSiteAuthorization: AUTH });
    expect((await portalCaller(token).portal.approvalQueue()).toSign).toEqual([]);
    expect((await portalCaller(token2).portal.alerts()).alerts.map(a => a.title)).toContain("Signed ticket available");
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM workflowNotifications WHERE workflowNumber = ? AND title = 'Signed ticket available'", [t.ticketNumber]);
    expect(Number(n[0].n)).toBe(2);                                          // two identities, one each

    // R1 rendered → document alert; the completion package → job complete alert; both downloadable; the timeline shows it all in order and nothing internal.
    const [rev] = await pool.execute<mysql.RowDataPacket[]>("SELECT documentRef FROM fieldTicketRevisions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) AND revision = 1", [t.ticketNumber]);
    const r1 = await callerFor(office).closeout.documentRender({ documentRef: rev[0].documentRef });
    const pkg = await callerFor(office).closeout.completionPackageRender({ ticketNumber: t.ticketNumber });
    expect(pkg.alreadyRendered).toBe(false);
    expect((await callerFor(office).closeout.completionPackageRender({ ticketNumber: t.ticketNumber })).alreadyRendered).toBe(true);
    const dl = await portalCaller(token).portal.documentDownload({ documentRef: pkg.documentRef, purpose: "AP" });
    const bytes = Buffer.from(dl.dataBase64, "base64");
    expect(sha256Hex(bytes)).toBe(pkg.contentHash);
    const text = bytes.toString("latin1");
    expect(text).toContain(`R1  site_signed`);
    expect(text).toContain(`sha256 ${r1.contentHash}`);                      // the package names R1's rendered hash
    expect(text).toContain("F-88192");
    expect(text).toContain("no disposal ticket on file");
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "restock", occurredAt: at("20:31"), endedAt: at("20:52") });
    const tl = await portalCaller(token).portal.jobTimeline({ ticketNumber: t.ticketNumber });
    expect(tl.entries.map(e => e.kind)).toEqual(["event", "event", "event", "signature", "revision", "document", "document"]);
    expect(JSON.stringify(tl.entries)).not.toContain("restock");             // company time is not on the customer's timeline
    expect(tl.note).toContain("never billed to you");                         // and the timeline says so
    const titles = (await portalCaller(token).portal.alerts()).alerts.map(a => a.title);
    expect(titles).toContain("Document ready");
    expect(titles).toContain("Job complete");

    // Acknowledge an alert; the queue's unread count drops; another account cannot acknowledge it.
    const first = (await portalCaller(token).portal.alerts()).alerts[0]!;
    await portalCaller(token).portal.alertAcknowledge({ id: first.id });
    await expect(portalCaller(token2).portal.alertAcknowledge({ id: first.id })).rejects.toThrow(/No such alert for this identity/);
    const otherRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [otherRef, entityId]);
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: otherRef, email: "x@bravo.example", displayName: "Bravo" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    expect((await portalCaller(otherToken).portal.alerts()).alerts).toEqual([]);
    expect((await portalCaller(otherToken).portal.approvalQueue()).toSign).toEqual([]);
    await expect(portalCaller(otherToken).portal.chainOfCustody({ ticketNumber: t.ticketNumber })).rejects.toThrow(/No such ticket on this account/);
    await expect(portalCaller(otherToken).portal.jobTimeline({ ticketNumber: t.ticketNumber })).rejects.toThrow(/No such ticket on this account/);
  });
});
