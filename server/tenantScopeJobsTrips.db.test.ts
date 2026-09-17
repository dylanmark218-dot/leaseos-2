/**
 * P4.1 router 1 — jobs and trips are scoped to the acting organization (0132).
 *
 * Organization A's job is invisible to organization B, by code and in the
 * list. A member's created job carries their organization. A row with no
 * owner is the historical single tenant's: visible to a user with no
 * membership (the `default` scope) and to nobody else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 230_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, role: string) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

d("jobs and trips belong to an organization", () => {
  it("hides one organization's job from another, by list and by code, and stamps a member's new job with their organization", async () => {
    const a = await org(), b = await org();
    const dispA = await member(a, "dispatcher"), dispB = await member(b, "dispatcher");
    const jobCode = `JOB-${rnd()}`;
    await callerFor(dispA).fieldRoute.jobs.create({ jobCode, type: "Hydrovac", customer: "Fixture Energy", location: "LSD 04-12-045-08W4" } as never);
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM jobs WHERE jobCode = ?", [jobCode]);
    expect(row[0]?.orgRef).toBe(a);
    expect((await callerFor(dispA).fieldRoute.jobs.list()).some(j => j.jobCode === jobCode)).toBe(true);
    expect((await callerFor(dispB).fieldRoute.jobs.list()).some(j => j.jobCode === jobCode)).toBe(false);
    expect(await callerFor(dispB).fieldRoute.jobs.byCode({ jobCode })).toBeUndefined();
    expect((await callerFor(dispA).fieldRoute.jobs.byCode({ jobCode }))?.jobCode).toBe(jobCode);
  }, 20_000);

  it("leaves a legacy row unowned and visible only to the default scope", async () => {
    const a = await org();
    const dispA = await member(a, "dispatcher");
    const legacyUser = await member(null, "dispatcher");   // no membership: the historical single tenant
    const jobCode = `JOB-LEGACY-${rnd()}`;
    await pool.execute("INSERT INTO jobs (jobCode, type, customer, location, status) VALUES (?,?,?,?,'dispatched')", [jobCode, "Hydrovac", "Legacy Co", "Somewhere"]);
    expect((await callerFor(legacyUser).fieldRoute.jobs.list()).some(j => j.jobCode === jobCode)).toBe(true);
    expect((await callerFor(dispA).fieldRoute.jobs.list()).some(j => j.jobCode === jobCode)).toBe(false);
    // And a job the legacy user creates stays unowned — nothing is guessed about which organization it belongs to.
    const created = `JOB-${rnd()}`;
    await callerFor(legacyUser).fieldRoute.jobs.create({ jobCode: created, type: "Hydrovac", customer: "Legacy Co", location: "Somewhere" } as never);
    const [row] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM jobs WHERE jobCode = ?", [created]);
    expect(row[0]?.orgRef).toBeNull();
  }, 20_000);

  it("scopes trips the same way", async () => {
    const a = await org(), b = await org();
    const dispA = await member(a, "dispatcher"), dispB = await member(b, "dispatcher");
    const tripNumber = `TRP-${rnd()}`;
    await pool.execute("INSERT INTO trips (tripNumber, tripType, status, orgRef) VALUES (?,'one_way','planned',?)", [tripNumber, a]);
    expect((await callerFor(dispA).fieldRoute.trips.list()).some(t => t.tripNumber === tripNumber)).toBe(true);
    expect((await callerFor(dispB).fieldRoute.trips.list()).some(t => t.tripNumber === tripNumber)).toBe(false);
  }, 20_000);
});
