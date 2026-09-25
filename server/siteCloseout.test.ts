import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { classifyDelay, closeoutState, composeSiteSnapshot, lineDecision, postSiteSupplement, signatureDecision, whyTheseHours, type PostSiteAuthorization, type SignatoryAuthority, type TicketEvent, type TicketLine } from "./_core/siteCloseout";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
let seq = 1;
const ev = (eventType: TicketEvent["eventType"], from: string, to: string | null, over: Partial<TicketEvent> = {}): TicketEvent => ({ id: seq++, eventType, occurredAt: at(from), endedAt: to ? at(to) : null, customerBillable: eventType === "site_work" ? "yes" : ["post_trip", "restock", "washout", "fuel", "paperwork", "break"].includes(eventType) ? "no" : "review", source: "driver_stated", confidence: "medium", detail: null, ...over });
const line = (over: Partial<TicketLine> & { id: number }): TicketLine => ({ lineKind: "load", description: `Load ${over.id}`, quantity: 12.3, quantityUnit: "m3", measurementMethod: "meter", disposition: "not_presented", operatorStatement: null, customerStatement: null, ...over });
const ticket = { ticketNumber: "FT-8812", jobId: 1, customer: "ABC Energy", site: "10-22-045-06-W5", unitId: 142, operatorId: 7 };
const AUTH: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };
const johnson: SignatoryAuthority = { signatoryName: "M. Johnson", mayConfirmWork: true, maySignTicket: true, mayApproveStandby: true, extraWorkLimitCents: 500_000, mayApproveInvoice: false, mayChangeRates: false, validTo: null, status: "active" };

describe("the site snapshot freezes what was known and agreed at the lease", () => {
  const siteEvents = [ev("site_work", "07:31", "12:00"), ev("standby", "12:00", "13:15"), ev("site_work", "13:15", "17:06"), ev("post_trip", "19:55", "20:08")];
  it("counts only the customer-billing clock, keeps standby at review until a rule decides, and hashes the same thing twice", () => {
    const a = composeSiteSnapshot({ ticket, lines: [line({ id: 1 }), line({ id: 2 }), line({ id: 3, lineKind: "standby", description: "Standby", quantity: 1.25, quantityUnit: "h" })], events: siteEvents, siteWorkCompleteAt: at("17:06"), postSiteRequired: true });
    expect(a.snapshot.siteBillableHours).toBe(8.33);      // 4.48 + 3.85 — standby is not in it
    expect(a.snapshot.standbyHours).toBe(1.25);
    expect(a.snapshot.standbyBillable).toBe("review");
    expect(a.snapshot.arrivalAt).toBe("2026-09-10T07:31:00.000Z");
    expect(a.snapshot.loads).toBe(2);
    expect(a.snapshot.events.map(e => e.eventType)).toEqual(["site_work", "standby", "site_work"]); // post-trip is not a site event
    expect(a.findings).toEqual(["Standby is on the ticket but no contract rule decides whether the customer pays for it — REVIEW"]);
    const b = composeSiteSnapshot({ ticket, lines: [line({ id: 3, lineKind: "standby", description: "Standby", quantity: 1.25, quantityUnit: "h" }), line({ id: 2 }), line({ id: 1 })].reverse(), events: [...siteEvents].reverse(), siteWorkCompleteAt: at("17:06"), postSiteRequired: true });
    expect(b.hash).not.toBe(a.hash); // line order is part of what was presented
    expect(composeSiteSnapshot({ ticket, lines: [line({ id: 1 }), line({ id: 2 }), line({ id: 3, lineKind: "standby", description: "Standby", quantity: 1.25, quantityUnit: "h" })], events: siteEvents, siteWorkCompleteAt: at("17:06"), postSiteRequired: true }).hash).toBe(a.hash);
  });
  it("refuses to be signed with an open site event", () => {
    const r = composeSiteSnapshot({ ticket, lines: [], events: [ev("site_work", "07:31", null)], siteWorkCompleteAt: at("17:06"), postSiteRequired: false });
    expect(r.snapshot.unclosedSiteEvents).toBe(1);
    expect(r.findings[0]).toContain("still open");
  });
});

describe("a signature says what it exercised, and whether it was allowed to", () => {
  it("records what is within authority, refuses invoice approval the consultant does not hold, and refuses a changed ticket", () => {
    const ok = signatureDecision({ requested: ["work_confirmation", "time_confirmation", "standby_approval"], authority: johnson, extraWorkCents: 0, signedAt: at("17:14"), snapshotHashAtSigning: "h", currentSnapshotHash: "h" });
    expect(ok).toMatchObject({ permitted: true, exercised: ["work_confirmation", "time_confirmation", "standby_approval"], refused: [], withinAuthority: "yes" });
    const partial = signatureDecision({ requested: ["work_confirmation", "invoice_approval", "change_order_authorization"], authority: johnson, extraWorkCents: 720_000, signedAt: at("17:14"), snapshotHashAtSigning: "h", currentSnapshotHash: "h" });
    expect(partial.permitted).toBe(true);
    expect(partial.exercised).toEqual(["work_confirmation"]);
    expect(partial.refused.map(r => r.reason)).toEqual(["M. Johnson may not exercise invoice approval", "Extra work $7200.00 exceeds M. Johnson's limit of $5000.00"]);
    expect(partial.withinAuthority).toBe("no");
    const changed = signatureDecision({ requested: ["work_confirmation"], authority: johnson, extraWorkCents: 0, signedAt: at("17:14"), snapshotHashAtSigning: "h", currentSnapshotHash: "h2" });
    expect(changed.refusals[0]).toContain("changed between review and signature");
    const unknown = signatureDecision({ requested: ["work_confirmation"], authority: null, extraWorkCents: 0, signedAt: at("17:14"), snapshotHashAtSigning: "h", currentSnapshotHash: "h" });
    expect(unknown).toMatchObject({ permitted: true, withinAuthority: "unknown" });
    const revoked = signatureDecision({ requested: ["work_confirmation"], authority: { ...johnson, status: "revoked" }, extraWorkCents: 0, signedAt: at("17:14"), snapshotHashAtSigning: "h", currentSnapshotHash: "h" });
    expect(revoked.permitted).toBe(false);
  });
  it("keeps both sides of a disputed line", () => {
    const l = line({ id: 3, lineKind: "standby", description: "Standby", quantity: 1.25, quantityUnit: "h", operatorStatement: "Waited on wireline from 12:00" });
    expect(lineDecision(l, { disposition: "disputed" }).refusal).toContain("needs the customer's statement");
    const d = lineDecision(l, { disposition: "disputed", customerQuantity: 0.75, customerStatement: "Operations resumed at 14:20." });
    expect(d.line.operatorStatement).toBe("Waited on wireline from 12:00");
    expect(d.line.quantity).toBe(1.25);
    expect(d.line.customerStatement).toBe("Accepted 0.75 h of 1.25. Operations resumed at 14:20.");
  });
});

describe("the post-site supplement is appended only under what was signed", () => {
  const after = [ev("travel_to_disposal", "17:18", "18:04", { source: "gps" }), ev("disposal_queue", "18:04", "18:19"), ev("disposal", "18:19", "18:47"), ev("return_travel", "18:54", "19:39"), ev("post_trip", "19:55", "20:08"), ev("washout", "20:08", "20:31"), ev("restock", "20:31", "20:52"), ev("fuel", "20:52", "21:04")];
  it("includes authorized travel, queue and disposal with their evidence; excludes company activity; holds return travel per contract", () => {
    const s = postSiteSupplement({ authorization: AUTH, events: after, siteWorkCompleteAt: at("17:06"), disposalTicket: { receivedAt: at("18:19"), releasedAt: at("18:47"), ticketNumber: "DT-88192" }, gpsFacilityArrivalAt: at("18:04"), contractReturnTravel: null });
    expect(s.included.map(i => [i.eventType, i.hours, i.evidence])).toEqual([["travel_to_disposal", 0.77, "GPS supported"], ["disposal_queue", 0.25, "Facility geofence"], ["disposal", 0.47, "Disposal ticket DT-88192"]]);
    expect(s.excluded.map(x => x.eventType)).toEqual(["return_travel", "post_trip", "washout", "restock", "fuel"]);
    expect(s.excluded[1].reason).toContain("not customer billable");
    expect(s.postSiteBillableHours).toBe(1.49);
    expect(s.determination).toBe("review");
    expect(s.reasons).toEqual(["Return travel awaits the contract rule"]);
  });
  it("adds return travel when the contract says yes, and flags a ticket that disagrees with GPS without choosing the larger", () => {
    const s = postSiteSupplement({ authorization: AUTH, events: after, siteWorkCompleteAt: at("17:06"), disposalTicket: { receivedAt: at("19:12"), releasedAt: null, ticketNumber: "DT-88192" }, gpsFacilityArrivalAt: at("18:03"), contractReturnTravel: "yes" });
    expect(s.included.map(i => i.eventType)).toEqual(["travel_to_disposal", "disposal_queue", "disposal", "return_travel"]);
    expect(s.postSiteBillableHours).toBe(2.24);
    expect(s.discrepancies[0].detail).toBe("TIME DISCREPANCY — GPS arrival 18:03, ticket received 19:12 (69 min) — REVIEW");
    expect(s.determination).toBe("review");
  });
  it("bills nothing after the lease without a signed basis, and is blocked when disposal was required and no ticket exists", () => {
    const none = postSiteSupplement({ authorization: null, events: after, siteWorkCompleteAt: at("17:06"), disposalTicket: null, gpsFacilityArrivalAt: null, contractReturnTravel: "yes" });
    expect(none.postSiteBillableHours).toBe(0);
    expect(none.determination).toBe("blocked");
    const noTicket = postSiteSupplement({ authorization: AUTH, events: after, siteWorkCompleteAt: at("17:06"), disposalTicket: null, gpsFacilityArrivalAt: null, contractReturnTravel: "yes" });
    expect(noTicket.reasons).toContain("Disposal was required and no disposal ticket is attached");
    expect(noTicket.determination).toBe("blocked");
  });
});

describe("delays are classified by the contract, or held", () => {
  it("never bills a driver break or a breakdown, bills a customer hold when the contract says so, and reviews the rest", () => {
    expect(classifyDelay("driver_break", { driver_break: "billable" })).toEqual({ classification: "non_billable", ruleRef: "leaseos:never_customer_billable" });
    expect(classifyDelay("customer_hold", { customer_hold: "billable" })).toEqual({ classification: "billable", ruleRef: "contract:customer_hold" });
    expect(classifyDelay("weather", null)).toEqual({ classification: "review_required", ruleRef: null });
    expect(classifyDelay("weather", { customer_hold: "billable" })).toEqual({ classification: "review_required", ruleRef: null });
  });
});

describe("three closes, and why the hours are what they are", () => {
  it("walks OPEN → WORK_ACTIVE → SITE_CLOSE_PENDING → SITE_SIGNED/POST_SITE → BILLING_READY, naming each blocker", () => {
    const lines = [line({ id: 1, sourceTrackingNumber: "DT-1" })];
    expect(closeoutState({ events: [], lines, siteWorkCompleteAt: null, signature: null, supplement: null, postSiteRequired: true, loadsWithDisposalEvidence: 1, loads: 1 }).state).toBe("OPEN");
    expect(closeoutState({ events: [ev("site_work", "07:31", null)], lines, siteWorkCompleteAt: null, signature: null, supplement: null, postSiteRequired: true, loadsWithDisposalEvidence: 1, loads: 1 }).state).toBe("WORK_ACTIVE");
    const pending = closeoutState({ events: [ev("site_work", "07:31", "17:06")], lines, siteWorkCompleteAt: at("17:06"), signature: null, supplement: null, postSiteRequired: true, loadsWithDisposalEvidence: 1, loads: 1 });
    expect(pending.state).toBe("SITE_CLOSE_PENDING");
    expect(pending.blockers).toEqual(["Site ticket not signed", "Post-site supplement not prepared"]);
    const sig = { signedAt: at("17:14"), signerName: "M. Johnson", result: "accepted" };
    const active = closeoutState({ events: [ev("site_work", "07:31", "17:06"), ev("travel_to_disposal", "17:18", null)], lines, siteWorkCompleteAt: at("17:06"), signature: sig, supplement: null, postSiteRequired: true, loadsWithDisposalEvidence: 1, loads: 1 });
    expect(active.state).toBe("POST_SITE_ACTIVE");
    expect(active.fieldClosed).toEqual({ at: "2026-09-10T17:14:00.000Z", by: "M. Johnson" });
    const supp = postSiteSupplement({ authorization: AUTH, events: [ev("travel_to_disposal", "17:18", "18:04"), ev("disposal", "18:19", "18:47")], siteWorkCompleteAt: at("17:06"), disposalTicket: { receivedAt: at("18:19"), releasedAt: null, ticketNumber: "DT-1" }, gpsFacilityArrivalAt: null, contractReturnTravel: "no" });
    const ready = closeoutState({ events: [ev("site_work", "07:31", "17:06"), ev("travel_to_disposal", "17:18", "18:04"), ev("disposal", "18:19", "18:47"), ev("post_trip", "19:55", "20:08")], lines, siteWorkCompleteAt: at("17:06"), signature: sig, supplement: supp, postSiteRequired: true, loadsWithDisposalEvidence: 1, loads: 1 });
    expect(ready).toMatchObject({ state: "BILLING_READY", financiallyReady: true, invoiceReady: true, operationallyClosed: { at: "2026-09-10T20:08:00.000Z" } });
    const disputed = closeoutState({ events: [ev("site_work", "07:31", "17:06")], lines: [line({ id: 1, disposition: "disputed", description: "Standby" })], siteWorkCompleteAt: at("17:06"), signature: sig, supplement: null, postSiteRequired: false, loadsWithDisposalEvidence: 0, loads: 0 });
    expect(disputed.state).toBe("SITE_DISPUTED");
    expect(disputed.blockers).toEqual(["Line disputed: Standby — office resolves"]);
  });
  it("explains 11.82 hours to the customer, and lists what is not included", () => {
    const snap = composeSiteSnapshot({ ticket, lines: [], events: [ev("site_work", "07:31", "17:06"), ev("standby", "12:00", "13:15")], siteWorkCompleteAt: at("17:06"), postSiteRequired: true }).snapshot;
    const supp = postSiteSupplement({ authorization: AUTH, events: [ev("travel_to_disposal", "17:18", "18:04", { source: "gps" }), ev("disposal_queue", "18:04", "18:19"), ev("disposal", "18:19", "18:47"), ev("return_travel", "18:54", "19:39"), ev("post_trip", "19:55", "20:08"), ev("restock", "20:31", "20:52")], siteWorkCompleteAt: at("17:06"), disposalTicket: { receivedAt: at("18:19"), releasedAt: null, ticketNumber: "DT-88192" }, gpsFacilityArrivalAt: at("18:04"), contractReturnTravel: "yes" });
    const why = whyTheseHours(snap, "M. Johnson", supp);
    expect(why.sections[0]).toEqual({ title: "SITE WORK", rows: [{ window: "07:31–17:06", what: "Site work", hours: 9.58, evidence: "Signed by M. Johnson" }], subtotal: 9.58 });
    expect(why.sections[1].rows.map(r => [r.window, r.what, r.hours, r.evidence])).toEqual([["17:18–18:04", "travel to disposal", 0.77, "GPS supported"], ["18:04–18:19", "disposal queue", 0.25, "Facility geofence"], ["18:19–18:47", "disposal", 0.47, "Disposal ticket DT-88192"], ["18:54–19:39", "return travel", 0.75, "Driver stated"]]);
    expect(why.totalHours).toBe(11.82);
    expect(why.notIncluded.map(n => n.what)).toEqual(["standby (review)", "post trip — Company activity — recorded for HOS, payroll, maintenance and cost; not customer billable", "restock — Company activity — recorded for HOS, payroll, maintenance and cost; not customer billable"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_000_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a day on the lease, signed before the truck leaves", () => {
  it("freezes R1 at the consultant's signature, appends R2 under the signed basis, keeps restocking off the bill, and lets the customer see why", async () => {
    const driver = await withRole("driver");
    const office = await withRole("office");
    const controller = await withRole("controller");
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB')", [`FE-${Math.random().toString(36).slice(2, 12)}`]))[0].insertId);   // F1 — a real book: a made-up entity id is "not found"
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, delayBillingRulesJson, postSiteBillingRuleJson) VALUES (?, ?, 'ABC Energy', ?, ?)", [acctRef, entityId, JSON.stringify({ customer_hold: "billable" }), JSON.stringify({ returnTravel: "yes" })]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);

    // The consultant's authority: may confirm work, approve standby, authorize extras to $5,000; may not approve invoices.
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    const acc0 = await portalCaller(inv.invitationToken).portal.invitationAccept(); const invToken = acc0.token;
    await callerFor(office).closeout.authoritySet({ customerAccountRef: acctRef, signatoryName: "M. Johnson", signatoryRole: "Site Consultant", externalIdentityRef: inv.identityRef, mayApproveStandby: true, extraWorkLimitCents: 500_000 });

    // The day: arrival, work, a customer hold the contract pays for, work, complete at 17:06.
    const [fixtureUnit] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await callerFor(driver).closeout.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit.insertId, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: true });
    const c = callerFor(driver).closeout;
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00"), source: "pto", confidence: "high" });
    const hold = await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "customer_hold", occurredAt: at("12:00"), endedAt: at("13:15"), detail: "Waiting on wireline" });
    expect(hold.customerBillable).toBe("yes");                                  // the contract rule decided it
    const work2 = await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("13:15"), source: "pto" });
    await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "load", description: "Load 1 — produced water", quantity: 12.4, quantityUnit: "m3", measurementMethod: "meter", sourceTrackingNumber: "DT-88191" });
    const standby = await c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "standby", description: "Standby — wireline", quantity: 1.25, quantityUnit: "h", measurementMethod: "system_timed", operatorStatement: "Waited on wireline from 12:00" });
    const weather = await c.delayRecord({ ticketNumber: t.ticketNumber, kind: "weather", observedAt: at("15:42"), observation: "Heavy snow, visibility reduced, road accumulating", latitude: 53.5, longitude: -113.4, externalSourceStatus: "unavailable" });
    expect(weather.billingClassification).toBe("review_required");             // no weather rule: not invented
    const hazard = await c.delayRecord({ jobId, kind: "road_hazard", hazardType: "icy grade", severity: "high", observedAt: at("16:10"), observation: "Icy downhill grade 18 km north of lease" });
    expect(hazard.broadcast).toBe(true);

    // Cannot sign with an open event. Close it; prepare; the snapshot has a hash.
    await expect(callerFor(driver).closeout.siteSign({ ticketNumber: t.ticketNumber, snapshotHash: "0".repeat(64), signer: { name: "M. Johnson", company: "ABC Energy" }, method: "drawn", authorities: ["work_confirmation"] })).rejects.toThrow(/not been marked complete/);
    await c.eventClose({ ticketNumber: t.ticketNumber, eventId: work2.eventId, endedAt: at("17:06") });
    const prep = await c.sitePrepare({ ticketNumber: t.ticketNumber, siteWorkCompleteAt: at("17:06") });
    expect(prep.snapshot.siteBillableHours).toBe(9.58);                      // 8.33 work + 1.25 hold the contract pays for — the document's figure
    expect(prep.snapshot.postSiteRequired).toBe(true);
    expect(prep.findings).toEqual([]);

    // The consultant signs on their own phone, through the portal: work, time, standby, and the post-site billing basis.
    // Invoice approval is requested too — and refused, recorded, not silently granted.
    await expect(portalCaller(invToken).portal.fieldTicketSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, authorities: ["work_confirmation"] })).rejects.toThrow(/signs the billing basis, not a future number/);
    const signed = await portalCaller(invToken).portal.fieldTicketSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, authorities: ["work_confirmation", "time_confirmation", "standby_approval", "invoice_approval"], postSiteAuthorization: AUTH, gps: { latitude: 53.5, longitude: -113.4 } });
    expect(signed).toMatchObject({ documentRef: `${t.ticketNumber}-R1`, revision: 1, exercised: ["work_confirmation", "time_confirmation", "standby_approval"], withinAuthority: "no" });
    expect(signed.refused[0].reason).toBe("M. Johnson may not exercise invoice approval");
    const [sig] = await pool.execute<mysql.RowDataPacket[]>("SELECT signatureMethod, payloadHash, externalIdentityId, capturedLatitude FROM fieldTicketSignatures WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?)", [t.ticketNumber]);
    // 0158: portal_link, not device_auth. The consultant signed on their OWN phone through a secure
    // link — they have no device enrolled with this company and never could have, so device_auth
    // claimed an authentication that had not happened. The externalIdentityId below is what
    // actually proved who they were.
    expect(sig[0]).toMatchObject({ signatureMethod: "portal_link", payloadHash: prep.snapshotHash, capturedLatitude: 53.5 });
    expect(sig[0].externalIdentityId).not.toBeNull();
    // SPINE item 2 — this is the one signed-scope statement (fieldTicket.buildSignedScopeStatement was an
    // unwired second one and is gone). It records the authority actually exercised and what was refused.
    const [stmt] = await pool.execute<mysql.RowDataPacket[]>("SELECT signedScopeStatement FROM fieldTicketSignatures WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?)", [t.ticketNumber]);
    expect(String(stmt[0].signedScopeStatement)).toMatch(/^Work performed confirmed: .* h site billable, \d+ load\(s\), standby .* h \(.*\)\. Exercised: work_confirmation, time_confirmation, standby_approval\. Not within authority: invoice_approval\. Post-site: billing basis signed/);

    // Frozen: no second signature, no new site event, no edit to lines.
    await expect(c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("17:10"), endedAt: at("17:30") })).rejects.toThrow(/frozen in the signed revision/);
    await expect(c.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "other", description: "extra" })).rejects.toThrow(/supplement, not an edit/);
    await expect(portalCaller(invToken).portal.fieldTicketSign({ ticketNumber: t.ticketNumber, snapshotHash: prep.snapshotHash, authorities: ["work_confirmation"], postSiteAuthorization: AUTH })).rejects.toThrow(/already signed/);

    // The consultant disputes the standby line from the portal: both sides stay.
    const dec = await portalCaller(invToken).portal.fieldTicketLineDecide({ ticketNumber: t.ticketNumber, lineId: standby.lineId, disposition: "disputed", customerQuantity: 0.75, customerStatement: "Operations resumed at 14:20." });
    expect(dec).toMatchObject({ operatorQuantity: 1.25, operatorStatement: "Waited on wireline from 12:00", customerStatement: "Accepted 0.75 h of 1.25. Operations resumed at 14:20." });
    expect((await callerFor(office).closeout.state({ ticketNumber: t.ticketNumber })).state).toBe("SITE_DISPUTED");

    // After the lease: disposal under the signed basis, then the company's own evening.
    for (const [type, from, to, src] of [["travel_to_disposal", "17:18", "18:04", "gps"], ["disposal_queue", "18:04", "18:19", "gps"], ["disposal", "18:19", "18:47", "ticket"], ["return_travel", "18:54", "19:39", "gps"], ["post_trip", "19:55", "20:08", "driver_stated"], ["washout", "20:08", "20:31", "driver_stated"], ["restock", "20:31", "20:52", "driver_stated"], ["fuel", "20:52", "21:04", "driver_stated"]] as const) {
      await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: type, occurredAt: at(from), endedAt: at(to), source: src });
    }
    const [fac] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'open')", [key("F").slice(0, 60)]);
    const dtNumber = key("DT").slice(0, 40);
    await pool.execute("INSERT INTO disposalTickets (ticketNumber, facilityId, facilityTicketNumber, scaleInAt, grossKg, tareKg, netKg, verificationStatus, source, confidence) VALUES (?, ?, 'F-88192', '2026-09-10 18:19:00', 41200, 18900, 22300, 'verified', 'facility_portal', 'high')", [dtNumber, Number(fac.insertId)]);
    const supp = await callerFor(office).closeout.supplementPrepare({ ticketNumber: t.ticketNumber, disposalTicketNumber: dtNumber });
    expect(supp.documentRef).toBe(`${t.ticketNumber}-R2`);
    expect(supp.included.map(i => i.eventType)).toEqual(["travel_to_disposal", "disposal_queue", "disposal", "return_travel"]);
    expect(supp.postSiteBillableHours).toBe(2.24);
    expect(supp.excluded.map(x => x.eventType)).toEqual(["post_trip", "washout", "restock", "fuel"]);
    expect(supp.determination).toBe("ready");
    const [revs] = await pool.execute<mysql.RowDataPacket[]>("SELECT revision, kind, snapshotHash, billableHoursSite, billableHoursPostSite FROM fieldTicketRevisions WHERE fieldTicketId = (SELECT id FROM fieldTickets WHERE ticketNumber = ?) ORDER BY revision", [t.ticketNumber]);
    expect(revs.map(r => [Number(r.revision), r.kind])).toEqual([[1, "site_signed"], [2, "post_site_supplement"]]);
    expect(revs[0].snapshotHash).toBe(prep.snapshotHash);                       // R1 untouched by R2
    expect(revs[0].billableHoursSite).toBe(9.58);
    expect(revs[1].billableHoursPostSite).toBe(2.24);

    // The office resolves the disputed line to what the customer accepted; the ticket becomes billing-ready with the three closes on record.
    await callerFor(office).closeout.lineDecide({ ticketNumber: t.ticketNumber, lineId: standby.lineId, disposition: "accepted", customerStatement: "Resolved at 0.75 h per customer; contractor agrees" });
    const st = await callerFor(office).closeout.state({ ticketNumber: t.ticketNumber });
    expect(st).toMatchObject({ state: "BILLING_READY", financiallyReady: true, invoiceReady: true, fieldClosed: { by: "M. Johnson" }, operationallyClosed: { at: "2026-09-10T21:04:00.000Z" } });
    expect(st.blockers).toEqual([]);

    // The customer sees why: 8.33 + 2.24, and what is not included.
    const view = await portalCaller(invToken).portal.fieldTicketView({ ticketNumber: t.ticketNumber });
    expect(view.detail?.why.totalHours).toBe(11.82);                          // the document's number, exactly
    expect(view.detail?.why.sections.map(s => [s.title, s.subtotal])).toEqual([["SITE WORK", 9.58], ["POST-SITE", 2.24]]);
    expect(view.detail?.why.sections[0].rows.map(r => r.what)).toEqual(["Site work", "customer hold — billable per contract", "Site work"]);
    expect(view.detail?.why.notIncluded.map(n => n.what.split(" — ")[0])).toEqual(["post trip", "washout", "restock", "fuel"]);
    expect(view.detail?.revisions.map(r => r.documentRef)).toEqual([`${t.ticketNumber}-R1`, `${t.ticketNumber}-R2`]);
    // And nothing of another account's.
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: (await (async () => { const r = key("CUST").slice(0, 40); await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [r, entityId]); return r; })()), email: "x@bravo.example", displayName: "Bravo" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    await expect(portalCaller(otherToken).portal.fieldTicketView({ ticketNumber: t.ticketNumber })).rejects.toThrow(/No such ticket on this account/);
  });
});
