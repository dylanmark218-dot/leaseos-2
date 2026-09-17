import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { noticeFor, operationalState, projectReadiness } from "./_core/customerProjections";
import { boardOrder, boardSummary, clearanceView, signOffModel, stateLabel, adjustmentPreview, type JobBoardTicket } from "../client/src/portal/external/viewModels";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
const NOW = at("13:00");

describe("an operational state comes from ticket events, never from speed", () => {
  it("is UNKNOWN with nothing recorded, WORKING with site work open, a hold with a hold open, ON_LOCATION between events, COMPLETE once signed", () => {
    expect(operationalState({ events: [], siteSigned: false, safety: [], now: NOW })).toMatchObject({ state: "UNKNOWN", basis: "No ticket event recorded — nothing establishes a state" });
    expect(operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: null }], siteSigned: false, safety: [], now: NOW }).state).toBe("WORKING");
    expect(operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") }, { eventType: "customer_hold", occurredAt: at("12:00"), endedAt: null }], siteSigned: false, safety: [], now: NOW }).state).toBe("CUSTOMER_HOLD");
    const between = operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") }], siteSigned: false, safety: [], now: NOW });
    expect(between).toMatchObject({ state: "ON_LOCATION" });
    expect(between.basis).toContain("no event open");
    expect(operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00") }], siteSigned: true, safety: [], now: NOW }).state).toBe("COMPLETE");
    expect(operationalState({ events: [{ eventType: "travel_to_disposal", occurredAt: at("12:10"), endedAt: null }], siteSigned: true, safety: [], now: NOW }).state).toBe("EN_ROUTE");
    expect(operationalState({ events: [{ eventType: "disposal", occurredAt: at("12:40"), endedAt: null }], siteSigned: true, safety: [], now: NOW }).state).toBe("UNLOADING");
  });
  it("hides company activity behind COMPLETE after signing, and reports an open safety event as BREAKDOWN or INCIDENT", () => {
    const restocking = operationalState({ events: [{ eventType: "restock", occurredAt: at("20:31"), endedAt: null }], siteSigned: true, safety: [], now: at("20:40") });
    expect(restocking).toMatchObject({ state: "COMPLETE" });
    expect(restocking.basis).toContain("not customer-visible");
    expect(operationalState({ events: [{ eventType: "restock", occurredAt: at("20:31"), endedAt: null }], siteSigned: false, safety: [], now: at("20:40") }).state).toBe("UNKNOWN");
    expect(operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: null }], siteSigned: false, safety: [{ eventType: "vehicle_defect", severity: "warning", status: "open", occurredAt: at("13:22") }], now: NOW })).toMatchObject({ state: "BREAKDOWN" });
    expect(operationalState({ events: [], siteSigned: false, safety: [{ eventType: "near_miss", severity: "critical", status: "acknowledged", occurredAt: at("13:22") }], now: NOW }).state).toBe("INCIDENT");
    expect(operationalState({ events: [{ eventType: "site_work", occurredAt: at("07:31"), endedAt: null }], siteSigned: false, safety: [{ eventType: "near_miss", severity: "critical", status: "resolved", occurredAt: at("09:00") }], now: NOW }).state).toBe("WORKING");
  });
});

describe("the readiness projection passes a verdict and a category, never the record", () => {
  it("maps codes to categories, verdicts to the customer's four words, and unknown codes to 'requirement under review'", () => {
    const p = projectReadiness({ verdict: "ineligible", blockers: [
      { code: "credential_expired:tdg_certificate", severity: "blocking", subject: "operator" },
      { code: "medical_fitness_unknown", severity: "unknown", subject: "operator" },
      { code: "cvip_inspection_due", severity: "review", subject: "truck" },
      { code: "weird_engine_code_9", severity: "review", subject: "job" },
    ] });
    expect(p.verdict).toBe("BLOCKED");
    expect(p.items).toEqual([
      { subject: "worker", verdict: "BLOCKED", category: "TDG certification" },
      { subject: "worker", verdict: "UNKNOWN", category: "fitness for duty" },
      { subject: "unit", verdict: "REVIEW", category: "vehicle inspection" },
      { subject: "job", verdict: "REVIEW", category: "requirement under review" },
    ]);
    expect(projectReadiness({ verdict: "eligible", blockers: [] })).toEqual({ verdict: "READY", items: [] });
    expect(projectReadiness({ verdict: "unknown", blockers: [] }).verdict).toBe("UNKNOWN");
  });
  it("carries none of the words a private record would", () => {
    const p = projectReadiness({ verdict: "ineligible", blockers: [{ code: "driver_abstract_demerits_9", severity: "blocking", subject: "operator" }, { code: "medical_condition_diabetes_flag", severity: "blocking", subject: "operator" }] });
    const text = JSON.stringify(p);
    for (const forbidden of ["demerit", "diabetes", "9", "condition", "label", "document", "expiresAt", "premium"]) expect(text).not.toContain(forbidden);
    expect(p.items.map(i => i.category)).toEqual(["driver abstract", "fitness for duty"]);
  });
});

describe("a notice is a template, never the incident", () => {
  it("templates by kind and severity, drops info-level events, and never carries the title or detail", () => {
    const mech = noticeFor({ eventType: "vehicle_breakdown", severity: "warning", status: "open", occurredAt: NOW });
    expect(mech).toMatchObject({ kind: "mechanical", customerAction: "none" });
    expect(mech!.message).toContain("mechanical event under review");
    const crit = noticeFor({ eventType: "injury_report", severity: "critical", status: "open", occurredAt: NOW });
    expect(crit).toMatchObject({ kind: "incident", customerAction: "may_be_required" });
    expect(JSON.stringify(crit)).not.toContain("injury");
    expect(noticeFor({ eventType: "toolbox_talk", severity: "info", status: "open", occurredAt: NOW })).toBeNull();
    expect(noticeFor({ eventType: "vehicle_breakdown", severity: "warning", status: "resolved", occurredAt: NOW })!.kind).toBe("resolved");
  });
});

describe("the customer's view-models", () => {
  const t = (over: Partial<JobBoardTicket> & { ticketNumber: string }): JobBoardTicket => ({ jobCode: null, site: null, unitId: 142, operational: { state: "WORKING", basis: "b", since: null }, arrivalAt: null, siteCloseAt: null, loads: { completed: 2, total: 3 }, material: [], delays: { count: 0, hours: 0, billing: "none" }, underReview: 0, closeout: "WORK_ACTIVE", invoiceReady: false, ...over });
  it("orders the board attention-first and summarizes it, and says why a state is unknown", () => {
    const board = [t({ ticketNumber: "C", operational: { state: "COMPLETE", basis: "signed", since: null }, closeout: "BILLING_READY", invoiceReady: true }), t({ ticketNumber: "A", operational: { state: "BREAKDOWN", basis: "x", since: null } }), t({ ticketNumber: "B", operational: { state: "UNKNOWN", basis: "No ticket event recorded — nothing establishes a state", since: null }, closeout: "SITE_CLOSE_PENDING" }), t({ ticketNumber: "D", operational: { state: "CUSTOMER_HOLD", basis: "h", since: null }, delays: { count: 1, hours: 1.25, billing: "review" } })];
    expect(boardOrder(board).map(x => x.ticketNumber)).toEqual(["A", "D", "B", "C"]);
    expect(boardSummary(board)).toEqual({ active: 0, needingAttention: 1, onHold: 1, complete: 1, unknown: 1, loadsCompleted: 8, delayHours: 1.25, awaitingSignature: 1, invoiceReady: 1 });
    expect(stateLabel({ state: "UNKNOWN", basis: "No ticket event recorded — nothing establishes a state", since: null })).toBe("Unknown — No ticket event recorded — nothing establishes a state");
    expect(stateLabel({ state: "CUSTOMER_HOLD", basis: "h", since: null })).toBe("Customer hold");
  });
  it("tells the signer what the signature covers and what it does not, and previews an adjustment honestly", () => {
    const m = signOffModel({ ticketNumber: "FT-1", siteBillableHours: 9.58, standbyHours: 1.25, standbyBillable: "review", loads: 7, lines: [{ id: 1, lineKind: "time", description: "Hydrovac", quantity: 9.58, unit: "h" }], excluded: [], postSiteRequired: true, authoritiesAvailable: ["work_confirmation", "time_confirmation"] });
    expect(m.sections[0].rows[1]).toBe("Standby 1.25 h — billing under contract review");
    expect(m.signatureCovers).toEqual(["work confirmation", "time confirmation"]);
    expect(m.signatureDoesNotCover[1]).toContain("you sign the BASIS");
    expect(clearanceView({ verdict: "BLOCKED", items: [{ subject: "worker", verdict: "BLOCKED", category: "customer or site orientation" }] }).action).toContain("request a replacement");
    expect(adjustmentPreview({ kind: "hour_equivalent", hourEquivalent: 1, agreedHourlyRateCents: 18_500 })).toEqual({ amountCents: 18_500, note: "1.00 hour-equivalent at the agreed rate — billing value, NOT worked time; no clock changes" });
    expect(adjustmentPreview({ kind: "hour_equivalent", hourEquivalent: 1, agreedHourlyRateCents: null }).amountCents).toBeNull();
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 2_400_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("the customer's live view, through the gate", () => {
  it("shows the board with the state the events establish, pre-clears with a projection that leaks nothing, and notices only the templates", async () => {
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = 2_500_000 + Math.floor(Math.random() * 90_000);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const c = callerFor(driver).closeout;
    const [fixtureUnit251] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit251.insertId, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "site_work", occurredAt: at("07:31"), endedAt: at("12:00"), source: "pto", confidence: "high" });
    await c.eventRecord({ ticketNumber: t.ticketNumber, eventType: "customer_hold", occurredAt: at("12:00"), detail: "Waiting on wireline" });
    await pool.execute("INSERT INTO loads (loadNumber, jobId, material, quantity, quantityUnit, chainState, createdAt) VALUES (?, ?, 'produced water', 12.4, 'm3', 'disposal_verified', NOW()), (?, ?, 'slurry', 11.8, 'm3', 'in_transit', NOW())", [key("LD").slice(0, 40), jobId, key("LD").slice(0, 40), jobId]);
    await pool.execute("INSERT INTO safetyEvents (jobId, eventType, severity, title, detail, occurredAt, status, createdAt) VALUES (?, 'vehicle_defect', 'warning', 'Hydraulic hose blew on J. Smith', 'Operator J. Smith reports pain in wrist; supervisor R. Davis investigating', ?, 'open', NOW())", [jobId, at("13:22")]);
    const inv = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: "mj@abc.example", displayName: "M. Johnson" });
    const token = (await portalCaller(inv.invitationToken).portal.invitationAccept()).token;

    const board = await portalCaller(token).portal.jobBoard();
    const row = board.tickets.find(x => x.ticketNumber === t.ticketNumber)!;
    expect(row.operational.state).toBe("BREAKDOWN");                       // the open mechanical event outranks the hold
    expect(row.loads).toEqual({ completed: 1, total: 2 });
    expect(row.material.map(m => m.material).sort()).toEqual(["produced water", "slurry"]);
    expect(row.delays).toMatchObject({ count: 1, billing: "review" });
    expect(row.closeout).toBe("WORK_ACTIVE");
    // With the safety event resolved, the open hold decides.
    await pool.execute("UPDATE safetyEvents SET status = 'resolved' WHERE jobId = ?", [jobId]);
    const board2 = await portalCaller(token).portal.jobBoard();
    expect(board2.tickets.find(x => x.ticketNumber === t.ticketNumber)!.operational).toMatchObject({ state: "CUSTOMER_HOLD" });

    // Pre-clearance: the operator is one the contractor has no record of, so the worker's items stay UNKNOWN; the unit is
    // real (P4.1 made the fixture name a real unit) and has no inspection, registration or insurance on file, so the
    // whole verdict is BLOCKED — a real unit with nothing verified is blocked, not unknown. Categories only, no detail.
    const pcUnknown = await portalCaller(token).portal.preClearance({ ticketNumber: t.ticketNumber });
    expect(pcUnknown.readiness.verdict).toBe("BLOCKED");
    expect(pcUnknown.readiness.items.filter(i => i.subject === "worker").map(i => i.verdict)).toEqual(expect.arrayContaining(["UNKNOWN"]));
    expect(pcUnknown.readiness.items.filter(i => i.subject === "unit").every(i => i.verdict === "BLOCKED")).toBe(true);
    expect(pcUnknown.readiness.items.every(i => Object.keys(i).sort().join(",") === "category,subject,verdict")).toBe(true);   // nothing leaks past the category
    expect(pcUnknown.basis).toContain("projected: verdict and category only");   // the engine ran; the customer sees only the projection
    // A real operator and unit with no credentials on file: the engine's answer, projected — categories only, nothing free-text.
    const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, createdAt) VALUES (?, NOW())", [key("Op").slice(0, 40)]);
    const [un] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [key("U").slice(0, 20)]);
    const t2 = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: Number(un.insertId), operatorId: Number(op.insertId), serviceDescription: "Second unit", postSiteRequired: false });
    const pc = await portalCaller(token).portal.preClearance({ ticketNumber: t2.ticketNumber });
    expect(["REVIEW", "BLOCKED", "UNKNOWN"]).toContain(pc.readiness.verdict);   // nothing on file is never READY
    expect(pc.readiness.items.length).toBeGreaterThan(0);
    for (const item of pc.readiness.items) { expect(Object.keys(item).sort()).toEqual(["category", "subject", "verdict"]); expect(item.category.length).toBeLessThan(40); }
    expect(JSON.stringify(pc)).not.toMatch(/label|expiresAt|document|licenceNumber|overridable/);

    // Notices: the template, not the title, not the names, not the injury.
    const notices = await portalCaller(token).portal.notices();
    expect(notices.notices).toHaveLength(1);
    expect(notices.notices[0]).toMatchObject({ kind: "resolved" });
    expect([t.ticketNumber, t2.ticketNumber]).toContain(notices.notices[0].ticketNumber); // a job-level event; both tickets are on the job
    const text = JSON.stringify(notices);
    for (const forbidden of ["Smith", "Davis", "wrist", "pain", "Hydraulic"]) expect(text).not.toContain(forbidden);

    // Another account sees none of it.
    const otherRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'Bravo Oil')", [otherRef, entityId]);
    const other = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: otherRef, email: "x@bravo.example", displayName: "Bravo" });
    const otherToken = (await portalCaller(other.invitationToken).portal.invitationAccept()).token;
    expect((await portalCaller(otherToken).portal.jobBoard()).tickets).toEqual([]);
    await expect(portalCaller(otherToken).portal.preClearance({ ticketNumber: t.ticketNumber })).rejects.toThrow(/No such ticket on this account/);
    expect((await portalCaller(otherToken).portal.notices()).notices).toEqual([]);
    const [log] = await pool.execute<mysql.RowDataPacket[]>("SELECT recordType FROM externalAccessLog WHERE externalIdentityId = (SELECT id FROM externalIdentities WHERE identityRef = ?) AND action = 'view' ORDER BY id", [inv.identityRef]);
    expect(log.map(l => l.recordType)).toEqual(["jobBoard", "jobBoard", "preClearance", "preClearance", "notices"]);
  });
});
