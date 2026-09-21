/**
 * P4.1 router 9 — spatial. Vehicle profiles, route evaluation, approvals, requests and the last
 * position key to a unit and follow its owner (coreRecordOwnership); a route request also names
 * a job, which follows jobs.orgRef. Road restrictions, structures and routing-source status are
 * facts about the world and stay shared on purpose; so do lease/well locations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 265_000_000 + Math.floor(Math.random() * 50_000);
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
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}
const profile = (unitId: number) => ({ unitId, heightM: 4.1, widthM: 2.6, lengthM: 12.4, emptyWeightKg: 18_500, axleGroups: [{ name: "steer", axles: 1, emptyKg: 5_500, loadedKg: 6_800 }, { name: "drive", axles: 2, emptyKg: 9_000, loadedKg: 17_000 }], source: "shop_measured" as const });

d("spatial records follow the unit's owner", () => {
  it("sets a vehicle profile, requests a route and reads the last position only for a unit in scope; another organization, or the single tenant, finds nothing", async () => {
    const A = await org(), B = await org();
    const mechA = await member(A, ["mechanic"]), mechB = await member(B, ["mechanic"]);
    const dispA = await member(A, ["dispatcher"]), dispB = await member(B, ["dispatcher"]), legacyDisp = await member(null, ["dispatcher"]);
    const unitA = await unitOwnedBy(A), unitNone = await unitOwnedBy(null);
    await expect(callerFor(mechB).spatial.vehicleProfileSet(profile(unitA))).rejects.toMatchObject({ code: "NOT_FOUND", message: `Unit ${unitA} not found` });
    await expect(callerFor(mechA).spatial.vehicleProfileSet(profile(unitA))).resolves.toBeTruthy();
    await expect(callerFor(dispB).spatial.routeRequest({ unitId: unitA, originRef: "Nisku yard", destinationRef: "10-22-045-06-W5" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(legacyDisp).spatial.routeRequest({ unitId: unitA, originRef: "Nisku yard", destinationRef: "10-22-045-06-W5" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispA).spatial.routeRequest({ unitId: unitA, originRef: "Nisku yard", destinationRef: "10-22-045-06-W5" })).resolves.toBeTruthy();
    await expect(callerFor(dispB).spatial.lastPosition({ unitId: unitA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispA).spatial.lastPosition({ unitId: unitA })).resolves.toBeDefined();
    // The single tenant's unowned unit: the legacy dispatcher sees it, A's does not.
    await expect(callerFor(legacyDisp).spatial.lastPosition({ unitId: unitNone })).resolves.toBeDefined();
    await expect(callerFor(dispA).spatial.lastPosition({ unitId: unitNone })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Shared facts about the world stay readable by anyone with the permission.
    await expect(callerFor(dispB).spatial.routingSourceStatus()).resolves.toBeDefined();
  }, 60_000);
});
