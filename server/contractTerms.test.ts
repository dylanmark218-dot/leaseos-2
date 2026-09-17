import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { approvalDecision, decideBillable, termsInEffect, type Terms } from "./_core/contractTerms";
import { composeSiteSnapshot } from "./_core/siteCloseout";
import { setWebhookPoster } from "./webhookDispatchService";
import { createWorkerPorts } from "./_core/workflowRuntime";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";
import type { PostSiteAuthorization } from "./_core/siteCloseout";

process.env.LEASEOS_PORTAL_MFA_KEY = "c".repeat(64);
const at = (hhmm: string, day = "2026-09-10") => new Date(`${day}T${hhmm}:00Z`);
const TERMS: Terms = { termsRef: "TERMS-ABC-2", version: 2, title: "MSA 2026", standbyBillable: "yes", standbyFreeMinutes: 30, customerHoldBillable: "yes", weatherHoldBillable: "no", travelToDisposalBillable: "yes", disposalQueueBillable: "yes", disposalBillable: "yes", returnTravelBillable: "no", clauses: { standby: "§4.3", weather_hold: "§4.5", return_travel: "§6.1" }, effectiveFrom: at("00:00", "2026-01-01"), effectiveTo: null, status: "approved" };

describe("a contract term decides, cites its clause, and never touches the clock", () => {
  it("answers each review kind from the terms; grace reduces billable minutes; no terms means REVIEW", () => {
    expect(decideBillable({ eventType: "standby", occurredAt: at("12:00"), durationMinutes: 75, terms: TERMS })).toEqual({ customerBillable: "yes", billableMinutes: 45, ruleRef: "TERMS-ABC-2 v2 §4.3", reason: "MSA 2026 §4.3: standby billable after the first 30 min — 45 of 75 min billable" });
    expect(decideBillable({ eventType: "standby", occurredAt: at("12:00"), durationMinutes: 20, terms: TERMS })).toMatchObject({ customerBillable: "no", billableMinutes: 0 });
    expect(decideBillable({ eventType: "standby", occurredAt: at("12:00"), durationMinutes: null, terms: TERMS })).toMatchObject({ customerBillable: "yes", billableMinutes: null });
    expect(decideBillable({ eventType: "weather_hold", occurredAt: at("12:00"), durationMinutes: 60, terms: TERMS })).toEqual({ customerBillable: "no", billableMinutes: 0, ruleRef: "TERMS-ABC-2 v2 §4.5", reason: "MSA 2026 §4.5: weather hold is not billable" });
    expect(decideBillable({ eventType: "return_travel", occurredAt: at("12:00"), durationMinutes: 50, terms: TERMS })).toMatchObject({ customerBillable: "no" });
    expect(decideBillable({ eventType: "disposal", occurredAt: at("12:00"), durationMinutes: 50, terms: TERMS })).toMatchObject({ customerBillable: "yes", billableMinutes: 50 });
    expect(decideBillable({ eventType: "standby", occurredAt: at("12:00"), durationMinutes: 75, terms: null })).toMatchObject({ customerBillable: "review", ruleRef: null });
    expect(decideBillable({ eventType: "site_work", occurredAt: at("12:00"), durationMinutes: 75, terms: TERMS }).reason).toContain("No contract term covers this event kind");
  });
  it("uses only approved terms in effect on the date, the latest version; approval is a second person's with the document", () => {
    const old = { ...TERMS, version: 1, termsRef: "TERMS-ABC-1", status: "superseded" as const };
    const draft = { ...TERMS, version: 3, termsRef: "TERMS-ABC-3", status: "draft" as const };
    const expired = { ...TERMS, version: 4, termsRef: "TERMS-ABC-4", effectiveTo: at("00:00", "2026-06-30") };
    expect(termsInEffect([old, TERMS, draft, expired], at("12:00"))?.termsRef).toBe("TERMS-ABC-2");
    expect(termsInEffect([draft], at("12:00"))).toBeNull();
    expect(approvalDecision({ recordedByUserId: 1, approverUserId: 1, status: "draft", sourceDocumentEvidenceId: null }).refusals).toEqual(["The person who recorded the terms may not approve them", "Approval needs the contract document in the evidence vault"]);
  });
  it("sums billable minutes in the snapshot while the standby clock stays whole", () => {
    const base = { id: 0, source: null, confidence: null, detail: null } as const;
    const snap = composeSiteSnapshot({ ticket: { ticketNumber: "FT-1", jobId: null, customer: "ABC", site: null, unitId: null, operatorId: null }, lines: [], events: [
      { ...base, id: 1, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("12:00"), customerBillable: "yes" },
      { ...base, id: 2, eventType: "standby", occurredAt: at("12:00"), endedAt: at("13:15"), customerBillable: "yes", billableMinutes: 45, billingRuleRef: "TERMS-ABC-2 v2 §4.3" },
    ], siteWorkCompleteAt: at("13:15") });
    expect(snap.snapshot.standbyHours).toBe(1.25);                           // the clock
    expect(snap.snapshot.siteBillableHours).toBe(5.75);                      // 5 h work + 45 min of the standby
    expect(snap.snapshot.standbyBillable).toBe("yes");
    expect(snap.findings).toContain("standby decided by TERMS-ABC-2 v2 §4.3");
  });
});

const ALL: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];
describe("who records terms and who approves them", () => {
  it("keeps approval with controller, management and legal", () => {
    expect(ALL.filter(r => authorize({ userId: 1, roles: [r], permission: "closeout.terms.approve" }).allowed).sort()).toEqual(["controller", "legal", "management"]);
    expect(authorize({ userId: 1, roles: ["office"], permission: "closeout.terms.record" }).allowed).toBe(true);
    expect(authorize({ userId: 1, roles: ["office"], permission: "closeout.terms.approve" }).allowed).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 3_800_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const AUTH: PostSiteAuthorization = { disposalRequired: true, travelToDisposal: true, disposalWait: true, disposalUnload: true, returnTravel: "per_contract", capRule: "none", restockingBillable: false, postTripBillable: false };

d("the closeout, decided by terms", () => {
  it("leaves standby in review without terms, decides and cites once terms are approved by a second person, applies the grace, re-decides open review events on demand, and refuses to touch a signed ticket", async () => {
    const office = await withRole("office");
    const controller = await withRole("controller");
    const driver = await withRole("driver");
    const entityId = 3_900_000 + Math.floor(Math.random() * 90_000);
    const acctRef = key("CUST").slice(0, 40);
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name) VALUES (?, ?, 'ABC Energy')", [acctRef, entityId]);
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt) VALUES (?, 'hydrovac', 'hydrovac', 'ABC Energy', '10-22-045-06-W5', 'on_site', 0, NOW())", [key("JOB").slice(0, 40)]);
    const jobId = Number(job.insertId);
    const c = callerFor(driver).closeout;

    // Before terms: standby is REVIEW.
    const [fixtureUnit669] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t1 = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit669.insertId, operatorId: 7, serviceDescription: "Hydrovac", postSiteRequired: true });
    await c.eventRecord({ ticketNumber: t1.ticketNumber, eventType: "site_work", occurredAt: at("07:00"), endedAt: at("12:00"), source: "pto", confidence: "high" });
    const sb1 = await c.eventRecord({ ticketNumber: t1.ticketNumber, eventType: "standby", occurredAt: at("12:00"), endedAt: at("13:15"), detail: "Waiting on wireline" });
    expect(sb1).toMatchObject({ customerBillable: "review", billingRuleRef: null });

    // Terms recorded by the office, approved by the controller against the contract document; the office cannot approve; a draft decides nothing.
    const terms = await callerFor(office).closeout.termsRecord({ customerAccountRef: acctRef, title: "MSA 2026", standbyBillable: "yes", standbyFreeMinutes: 30, customerHoldBillable: "yes", weatherHoldBillable: "no", travelToDisposalBillable: "yes", disposalQueueBillable: "yes", disposalBillable: "yes", returnTravelBillable: "no", clauses: { standby: "§4.3", weather_hold: "§4.5" }, effectiveFrom: new Date("2026-01-01T00:00:00Z"), sourceDocumentEvidenceId: 1 });
    expect(terms).toMatchObject({ version: 1, status: "draft" });
    await expect(callerFor(office).closeout.termsApprove({ termsRef: terms.termsRef })).rejects.toBeTruthy();
    expect((await callerFor(office).closeout.termsApply({ ticketNumber: t1.ticketNumber })).decided).toBe(0);
    expect((await callerFor(controller).closeout.termsApprove({ termsRef: terms.termsRef })).status).toBe("approved");

    // Applied on demand: the standby is decided with its clause; 45 of 75 minutes billable; the clock untouched; the snapshot says which rule decided.
    const applied = await callerFor(office).closeout.termsApply({ ticketNumber: t1.ticketNumber });
    expect(applied).toMatchObject({ decided: 1, stillReview: 0 });
    expect(applied.results[0]).toMatchObject({ eventId: sb1.eventId, customerBillable: "yes", ruleRef: `${terms.termsRef} v1 §4.3` });
    const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT durationMinutes, billableMinutes, billingRuleRef FROM fieldTicketEvents WHERE id = ?", [sb1.eventId]);
    expect(row[0]).toMatchObject({ durationMinutes: 75, billableMinutes: 45 });
    const prep = await c.sitePrepare({ ticketNumber: t1.ticketNumber, siteWorkCompleteAt: at("13:15") });
    expect(prep.snapshot).toMatchObject({ standbyHours: 1.25, siteBillableHours: 5.75, standbyBillable: "yes" });
    expect(prep.findings).toContain(`standby decided by ${terms.termsRef} v1 §4.3`);

    // A new ticket after approval: decided at record time; a weather hold is not billable and says why; an open standby is decided when it closes.
    const [fixtureUnit430] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, ?)", [`U-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, "hydrovac"]);   // P4.1: a ticket names a real unit the caller may see; 142 was a placeholder no unit had
    const t2 = await c.ticketOpen({ jobId, customerAccountRef: acctRef, unitId: fixtureUnit430.insertId, operatorId: 7, serviceDescription: "Hydrovac day 2", postSiteRequired: true });
    const wx = await c.eventRecord({ ticketNumber: t2.ticketNumber, eventType: "weather_hold", occurredAt: at("09:00", "2026-09-11"), endedAt: at("10:00", "2026-09-11") });
    expect(wx).toMatchObject({ customerBillable: "no", billingRuleRef: `${terms.termsRef} v1 §4.5` });
    const open = await c.eventRecord({ ticketNumber: t2.ticketNumber, eventType: "standby", occurredAt: at("10:00", "2026-09-11") });
    expect(open).toMatchObject({ customerBillable: "yes", billingRuleRef: `${terms.termsRef} v1 §4.3` });
    await c.eventClose({ ticketNumber: t2.ticketNumber, eventId: open.eventId, endedAt: at("10:20", "2026-09-11") });
    const [closed] = await pool.execute<mysql.RowDataPacket[]>("SELECT customerBillable, billableMinutes FROM fieldTicketEvents WHERE id = ?", [open.eventId]);
    expect(closed[0]).toMatchObject({ customerBillable: "no", billableMinutes: 0 });               // 20 min, within the 30-min grace

    // A signed ticket's answers stand.
    await c.siteSign({ ticketNumber: t1.ticketNumber, snapshotHash: prep.snapshotHash, signer: { name: "M. Johnson", company: "ABC Energy" }, method: "drawn", authorities: ["work_confirmation", "time_confirmation"], postSiteAuthorization: AUTH });
    await expect(callerFor(office).closeout.termsApply({ ticketNumber: t1.ticketNumber })).rejects.toThrow(/its snapshot stands/);
  });
});

d("the worker sends the event it processed", () => {
  it("delivers a subscribed webhook from the worker's processEvent, and the retry sweep on heartbeat picks up a failed one when it is due", async () => {
    const controller = await withRole("controller");
    const sub = await callerFor(controller).integration.webhookSubscribe({ name: "ERP", url: "https://erp.example/hook", eventTypes: ["worker.*"] });
    const seen: string[] = [];
    let failing = true;
    setWebhookPoster(async (_url, body) => { seen.push(body); return failing ? { status: 503 } : { status: 200 }; });
    const eventId = key("EV").slice(0, 40);
    await pool.execute("INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, payloadJson, occurredAt, attemptCount, createdAt) VALUES (?, 'worker.test', 1, 'ticket', 'FT-9', 'default', ?, 'system', '{}', NOW(), 0, NOW())", [eventId, key("C").slice(0, 40)]);
    const ports = createWorkerPorts(pool as never, () => new Date("2026-09-10T12:00:00Z"));
    const batch = await ports.claimBatch("worker-test", 50);
    const mine = batch.find(e => e.eventId === eventId);
    expect(mine).toBeTruthy();
    await ports.processEvent(mine!);
    const [d1] = await pool.execute<mysql.RowDataPacket[]>("SELECT attempt, status FROM webhookDeliveries WHERE eventId = ? ORDER BY attempt", [eventId]);
    expect(d1.map(x => [x.attempt, x.status])).toEqual([[1, "failed"]]);                      // sent by the worker, failed, scheduled
    failing = false;
    await ports.heartbeat!("worker-test", new Date("2026-09-10T12:00:30Z"));
    const [d2] = await pool.execute<mysql.RowDataPacket[]>("SELECT attempt, status FROM webhookDeliveries WHERE eventId = ? ORDER BY attempt", [eventId]);
    expect(d2).toHaveLength(1);                                                                // not due yet at +30 s
    await ports.heartbeat!("worker-test", new Date("2026-09-10T12:01:30Z"));
    const [d3] = await pool.execute<mysql.RowDataPacket[]>("SELECT attempt, status FROM webhookDeliveries WHERE eventId = ? ORDER BY attempt", [eventId]);
    expect(d3.map(x => [x.attempt, x.status])).toEqual([[1, "failed"], [2, "delivered"]]);   // due at +1 min, delivered by the sweep
    expect(seen.filter(b => b.includes(eventId))).toHaveLength(2);
    await callerFor(controller).integration.webhookSetStatus({ subscriptionRef: sub.subscriptionRef, status: "revoked" });
  });
});
