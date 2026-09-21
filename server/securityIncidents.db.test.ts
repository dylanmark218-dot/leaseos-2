/**
 * P4.6 — security incidents and privacy breach assessments through the real router (0131).
 *
 * What is proved: the decision is a person's (pending blocks closure, uncertain
 * blocks closure, required creates an obligation that blocks closure until
 * sent with evidence); the timeline is append-only and sequenced; a driver may
 * report and may not assess; the exception centre surfaces an unsent required
 * notification and an undecided assessment; another organization's incident
 * is not found.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 220_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, role: string) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function evidence(title: string) { const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt) VALUES (?,?,NOW())", [title, "notice"]); return e.insertId; }

d("a lost tablet with personal information on it", () => {
  it("is reported by a driver, assessed by safety, and cannot close until the required notification is sent", async () => {
    const a = await org(); const driver = await member(a, "driver"); const safety = await member(a, "safety");
    const opened = await callerFor(driver).securityIncidents.open({ incidentType: "lost_device", severity: "high", title: "Tablet left at the Nisku cardlock", discoveredAt: new Date(), personalInformationSuspected: true, customerDataSuspected: true });
    expect(opened.incidentRef).toMatch(/^SEC-/);
    // A driver reports; a driver does not assess.
    await expect(callerFor(driver).securityIncidents.breachAssess({ incidentRef: opened.incidentRef, jurisdiction: "AB", sensitivity: "high", misuseLikelihood: "unknown", notificationDecision: "uncertain", decisionReason: "Driver should not be able to do this" })).rejects.toThrow();
    // Closing with personal information suspected and no decision is refused, naming why.
    const early = await callerFor(safety).securityIncidents.close({ incidentRef: opened.incidentRef, closedAt: new Date() });
    expect(early.closed).toBe(false);
    expect(early.blockers.join(" ")).toMatch(/no privacy breach assessment/);
    // Uncertain is a decision — and it still blocks closure, by its own reason.
    await callerFor(safety).securityIncidents.timelineAppend({ incidentRef: opened.incidentRef, eventType: "contained", detail: "Remote wipe confirmed by MDM", occurredAt: new Date() });
    await callerFor(safety).securityIncidents.breachAssess({ incidentRef: opened.incidentRef, jurisdiction: "AB", applicableLaw: "PIPA (Alberta)", sensitivity: "high", misuseLikelihood: "unknown", notificationDecision: "uncertain", decisionReason: "Wipe confirmed but the device was unencrypted for eleven hours; harm cannot be ruled out yet" });
    const mid = await callerFor(safety).securityIncidents.close({ incidentRef: opened.incidentRef, closedAt: new Date() });
    expect(mid.closed).toBe(false);
    expect(mid.blockers.join(" ")).toMatch(/uncertain/);
    // A second assessment supersedes the first: notification required, obligation owed, closure blocked until sent.
    await callerFor(safety).securityIncidents.breachAssess({ incidentRef: opened.incidentRef, jurisdiction: "AB", applicableLaw: "PIPA (Alberta)", sensitivity: "high", misuseLikelihood: "moderate", notificationDecision: "required", decisionReason: "Driver licence numbers and home addresses of 14 employees were on the device; real risk of significant harm" });
    const ob = await callerFor(safety).securityIncidents.obligationCreate({ incidentRef: opened.incidentRef, recipientType: "commissioner", recipientRef: "OIPC Alberta", basis: "PIPA s. 34.1 — real risk of significant harm, as assessed", dueAt: new Date(Date.now() + 2 * 86_400_000) });
    const blocked = await callerFor(safety).securityIncidents.close({ incidentRef: opened.incidentRef, closedAt: new Date() });
    expect(blocked.closed).toBe(false);
    expect(blocked.blockers.join(" ")).toMatch(/commissioner.*required and unsent/);
    // The exception centre sees it.
    const { deriveExceptions } = await import("./_core/exceptionCentre");
    const { loadExceptionSources } = await import("./surfacesService");
    const all = deriveExceptions(await loadExceptionSources());
    expect(all.find(x => x.key === `security-notify:${opened.incidentRef}:commissioner`)?.severity).toBe("high");   // due in two days on a high incident; critical once overdue
    // Sent with evidence: closable.
    await callerFor(safety).securityIncidents.obligationSent({ incidentRef: opened.incidentRef, obligationId: ob.obligationId, sentAt: new Date(), evidenceRecordId: await evidence("OIPC notice PDF") });
    const closed = await callerFor(safety).securityIncidents.close({ incidentRef: opened.incidentRef, closedAt: new Date() });
    expect(closed.closed).toBe(true);
    const v = await callerFor(safety).securityIncidents.view({ incidentRef: opened.incidentRef });
    expect(v.events.map(e => e.eventType)).toEqual(["discovered", "contained", "privacy_assessment", "notification_decision", "privacy_assessment", "notification_decision", "notification_sent", "closed"]);
    expect(v.events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.assessments.map(x => x.status)).toEqual(["superseded", "complete"]);
    // Closed: the timeline takes nothing but a reopening.
    await expect(callerFor(safety).securityIncidents.timelineAppend({ incidentRef: opened.incidentRef, eventType: "evidence_added", occurredAt: new Date() })).rejects.toThrow(/closed/);
  }, 30_000);

  it("surfaces an undecided assessment, and hides the incident from another organization", async () => {
    const a = await org(), b = await org(); const safety = await member(a, "safety"); const outsider = await member(b, "safety");
    const opened = await callerFor(safety).securityIncidents.open({ incidentType: "data_exposure", title: "Shared link exposed a field ticket", discoveredAt: new Date(), personalInformationSuspected: true });
    const { deriveExceptions } = await import("./_core/exceptionCentre");
    const { loadExceptionSources } = await import("./surfacesService");
    const all = deriveExceptions(await loadExceptionSources());
    expect(all.find(x => x.key === `security-assess:${opened.incidentRef}`)?.action).toMatch(/uncertain is an answer; pending is not/);
    await expect(callerFor(outsider).securityIncidents.view({ incidentRef: opened.incidentRef })).rejects.toThrow(/not found/);
    expect((await callerFor(outsider).securityIncidents.list()).some(i => i.incidentRef === opened.incidentRef)).toBe(false);
  }, 20_000);
});
