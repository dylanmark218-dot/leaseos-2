/**
 * P4.1 router 10 (the monolith, first slice) — the field runtime keyed to jobs, trips, units and
 * operators: loads, deliveries, safety events, charge lines, job units, evidence, trip stops, GPS,
 * duty records, work orders, unit safety, inspections, maintenance. Lists show only what the
 * scope owns (a row with no job or trip is the single tenant's); creates and updates against
 * another organization's key answer "not found".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 268_000_000 + Math.floor(Math.random() * 50_000);
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
async function jobOwnedBy(orgRef: string | null) { const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]); return j.insertId; }
async function tripOwnedBy(orgRef: string | null) { const [t] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, tripType, status, orgRef) VALUES (?,'one_way','planned',?)", [`TRP-${rnd()}`, orgRef]); return t.insertId; }
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}

d("the field runtime belongs to the organization that owns the job, trip or unit", () => {
  it("lists only the scope's loads, deliveries, safety events, trip stops, work orders; refuses creates against another organization's job, trip or unit; and keeps unowned rows with the single tenant", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A, ["management"]), mgrB = await member(B, ["management"]), legacy = await member(null, ["management"]);
    const jobA = await jobOwnedBy(A), jobNone = await jobOwnedBy(null);
    const tripA = await tripOwnedBy(A);
    const unitA = await unitOwnedBy(A);
    const c = callerFor(mgrA);
    // Creates in scope succeed; the same against A's job from B are not found.
    const load = await c.fieldRoute.compliance.loads.create({ jobId: jobA, material: "Used drilling fluid", isWaste: true, confidence: "low", source: "Operator statement" } as never);
    expect(load).toBeDefined();
    await expect(callerFor(mgrB).fieldRoute.compliance.loads.create({ jobId: jobA, material: "x", isWaste: false, confidence: "low", source: "x" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Job ${jobA} not found` });
    await expect(callerFor(mgrB).fieldRoute.compliance.deliveries.create({ jobId: jobA, recipientRole: "customer", recipient: "x", status: "queued" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrB).fieldRoute.safety.create({ jobId: jobA, eventType: "road_hazard", severity: "warning", title: "Soft shoulder", detail: "km 18", occurredAt: new Date() } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await c.fieldRoute.safety.create({ jobId: jobA, eventType: "road_hazard", severity: "warning", title: `Soft shoulder ${rnd()}`, detail: "km 18", occurredAt: new Date() } as never);
    await expect(callerFor(mgrB).fieldRoute.tripStops.create({ tripId: tripA, stopType: "load", sequence: 1, setupMinutes: 15, waitMinutes: 4, durationMinutes: 38 } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip ${tripA} not found` });
    await c.fieldRoute.tripStops.create({ tripId: tripA, stopType: "load", sequence: 1, setupMinutes: 15, waitMinutes: 4, durationMinutes: 38 } as never);
    await expect(callerFor(mgrB).fieldRoute.gps.breadcrumbs({ tripId: tripA } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrB).fieldRoute.workOrders.list({ unitId: unitA } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Unit ${unitA} not found` });
    await expect(c.fieldRoute.workOrders.list({ unitId: unitA } as never)).resolves.toBeDefined();
    // Lists: A sees its rows, B sees none of them, the single tenant sees only unowned rows.
    expect((await c.fieldRoute.compliance.loads.list()).some(l => l.jobId === jobA)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.compliance.loads.list()).some(l => l.jobId === jobA)).toBe(false);
    expect((await callerFor(legacy).fieldRoute.compliance.loads.list()).some(l => l.jobId === jobA)).toBe(false);
    expect((await c.fieldRoute.safety.list()).some(e => e.jobId === jobA)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.safety.list()).some(e => e.jobId === jobA)).toBe(false);
    expect((await c.fieldRoute.tripStops.list({ tripId: tripA } as never)).length).toBe(1);
    expect((await callerFor(mgrB).fieldRoute.tripStops.list({ tripId: tripA } as never)).length).toBe(0);
    // An unowned job's load is the single tenant's and invisible to A.
    await callerFor(legacy).fieldRoute.compliance.loads.create({ jobId: jobNone, material: "Fresh water", isWaste: false, confidence: "high", source: "meter" } as never);
    expect((await callerFor(legacy).fieldRoute.compliance.loads.list()).some(l => l.jobId === jobNone)).toBe(true);
    expect((await c.fieldRoute.compliance.loads.list()).some(l => l.jobId === jobNone)).toBe(false);
    await expect(c.fieldRoute.compliance.loads.create({ jobId: jobNone, material: "x", isWaste: false, confidence: "low", source: "x" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});
