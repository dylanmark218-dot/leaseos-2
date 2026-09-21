/**
 * P4.1 router 10, third slice — lists that key to a unit (inspections, maintenance defects, unit
 * safety plans) show only the units the scope owns; the manifest chain of custody follows
 * manifests.orgRef, so a manifest that is not the caller's has no chain here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 275_000_000 + Math.floor(Math.random() * 50_000);
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

d("unit-keyed lists and the manifest chain follow the owner", () => {
  it("lists a unit's defects only for its owner (and unowned units only for the single tenant), and hides a manifest's chain of custody across the boundary", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A, ["management"]), mgrB = await member(B, ["management"]), legacy = await member(null, ["management"]);
    const unitA = await unitOwnedBy(A), unitNone = await unitOwnedBy(null);
    const titleA = `Brake light out ${rnd()}`, titleNone = `Wiper motor ${rnd()}`;
    await pool.execute("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, ?, 'advisory', 'open', NOW(), ?)", [unitA, titleA, mgrA]);
    await pool.execute("INSERT INTO maintenanceDefects (unitId, title, severity, status, reportedAt, reportedBy) VALUES (?, ?, 'advisory', 'open', NOW(), ?)", [unitNone, titleNone, legacy]);
    const seesA = async (userId: number) => (await callerFor(userId).fieldRoute.compliance.maintenance.list()).some(m => m.title === titleA);
    const seesNone = async (userId: number) => (await callerFor(userId).fieldRoute.compliance.maintenance.list()).some(m => m.title === titleNone);
    expect(await seesA(mgrA)).toBe(true);
    expect(await seesA(mgrB)).toBe(false);
    expect(await seesA(legacy)).toBe(false);
    expect(await seesNone(legacy)).toBe(true);
    expect(await seesNone(mgrA)).toBe(false);
    // A manifest of A's (created through the scoped procedure, so it is stamped): its chain exists for A, not for B.
    const manifestNumber = `MF-${rnd()}`;
    await callerFor(mgrA).fieldRoute.manifests.create({ manifestNumber, material: "Used drilling fluid", unitId: unitA, driver: "Test Driver" } as never);
    await expect(callerFor(mgrB).manifestCustody.chain({ manifestNumber })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Manifest not found" });
    await expect(callerFor(legacy).manifestCustody.chain({ manifestNumber })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrA).manifestCustody.chain({ manifestNumber })).resolves.toBeDefined();
  }, 60_000);
});
