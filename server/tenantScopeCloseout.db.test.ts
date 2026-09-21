/**
 * P4.1 router 6 — closeout (field tickets) keys to jobs, which belong to an organization (0132).
 * A ticket is in scope through its job — or its unit's owner when it has no job — and answers
 * "not found" across the boundary, never "forbidden". Opening a ticket on another organization's
 * job is refused the same way. The historical single tenant sees only what nobody owns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 255_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function jobOwnedBy(orgRef: string | null) {
  const jobCode = `JOB-${rnd()}`;
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [jobCode, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]);
  return j.insertId;
}
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
async function accountRef() {
  const acctRef = `ACCT-${rnd()}`;
  await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, delayBillingRulesJson, postSiteBillingRuleJson) VALUES (?, ?, ?, ?, ?)", [acctRef, 1_600_000 + Math.floor(Math.random() * 90_000), `Fixture ${acctRef}`, JSON.stringify({ customer_hold: "billable" }), JSON.stringify({ rule: "not_billable" })]);
  return acctRef;
}

d("closeout belongs to the organization that owns the job", () => {
  it("opens a ticket only on a job in scope, serves the ticket's owner, answers not-found to another organization and to the single tenant, and still serves an unowned job to the single tenant", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]), driverB = await member(B, ["driver"]), legacy = await member(null, ["driver"]);
    const jobA = await jobOwnedBy(A), jobNone = await jobOwnedBy(null);
    const unitA = await unitOwnedBy(A), unitNone = await unitOwnedBy(null);
    const acct = await accountRef();
    // Another organization's driver cannot open a ticket on A's job: not found.
    await expect(callerFor(driverB).closeout.ticketOpen({ jobId: jobA, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Job ${jobA} not found` });
    // A's driver opens it; then reads its state; B and the single tenant do not find it.
    const t = await callerFor(driverA).closeout.ticketOpen({ jobId: jobA, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    await expect(callerFor(driverA).closeout.state({ ticketNumber: t.ticketNumber })).resolves.toBeTruthy();
    await expect(callerFor(driverB).closeout.state({ ticketNumber: t.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Ticket ${t.ticketNumber} not found` });
    await expect(callerFor(legacy).closeout.state({ ticketNumber: t.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverB).closeout.lineAdd({ ticketNumber: t.ticketNumber, lineKind: "service", serviceCode: "HV-HR", description: "truck hours", quantity: 2 } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An unowned job: the single tenant opens and reads; A's driver does not find it.
    const u = await callerFor(legacy).closeout.ticketOpen({ jobId: jobNone, customerAccountRef: acct, unitId: unitNone, operatorId: 7, serviceDescription: "Hydrovac excavation", postSiteRequired: false } as never);
    await expect(callerFor(legacy).closeout.state({ ticketNumber: u.ticketNumber })).resolves.toBeTruthy();
    await expect(callerFor(driverA).closeout.state({ ticketNumber: u.ticketNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(driverA).closeout.ticketOpen({ jobId: jobNone, customerAccountRef: acct, unitId: unitA, operatorId: 7, serviceDescription: "x", postSiteRequired: false } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
