/**
 * P4.1 router 10, second slice — the monolith's records that carry, or now carry, an owner:
 * assistant proposals (through their job, trip or unit), compliance artifacts and tailgates
 * (through the job), manifests (orgRef from 0129, written for the first time), billing rate
 * cards (orgRef from 0148). Route contexts are road facts and stay shared. Operating zones were
 * treated the same way here until P0-A2.1 (0209) found they are one organization's geofences that
 * drive its own trip timeline; they now carry orgRef — see tenantScopeOperatingZones.db.test.ts.
 * Across the boundary: "not found", never "forbidden".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 272_000_000 + Math.floor(Math.random() * 50_000);
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
async function tripOwnedBy(orgRef: string | null) { const [t] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (tripNumber, tripType, status, orgRef) VALUES (?,'one_way','planned',?)", [`TRP-${rnd()}`, orgRef]); return t.insertId; }
async function unitOwnedBy(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, u.insertId]);
  return u.insertId;
}

d("the monolith's owned records", () => {
  it("hides a proposal through its trip, stamps and filters manifests and rate cards by organization, and refuses updates across the boundary", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A, ["management"]), mgrB = await member(B, ["management"]), legacy = await member(null, ["management"]);
    const tripA = await tripOwnedBy(A), unitA = await unitOwnedBy(A);
    // A proposal of A's (on A's trip): A reads it, B does not find it. Since AIL-1A (0210) the proposal
    // carries its own organization, stamped at draft from the acting scope.
    const proposalId = `PRP-${rnd()}`;
    await pool.execute("INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, targetRecordId, eventDateLocal, utcOffsetMinutes, tripId, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES (?, 'membership', ?, 'unload_stop', 1, 'Unload stop', ?, 1, '2026-09-09', -360, ?, ?, 'confirmed readback', 1, 'awaiting_readback')", [A, proposalId, `TRIP-${tripA} unload stop`, tripA, mgrA]);
    await expect(callerFor(mgrB).fieldRoute.assistant.get({ proposalId })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Proposal ${proposalId} not found` });
    await expect(callerFor(legacy).fieldRoute.assistant.get({ proposalId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrA).fieldRoute.assistant.get({ proposalId })).resolves.toBeTruthy();
    // Manifests: created by A, stamped with A, listed only by A; creation against A's unit from B is not found.
    const marker = rnd();
    const mid = await callerFor(mgrA).fieldRoute.manifests.create({ manifestNumber: `MF-${marker}`, material: "Used drilling fluid", unitId: unitA, driver: "Test Driver" } as never);
    expect(mid).toBeDefined();
    const [mrow] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM manifests WHERE manifestNumber = ?", [`MF-${marker}`]);
    expect(mrow[0]!.orgRef).toBe(A);
    expect((await callerFor(mgrA).fieldRoute.manifests.list()).some(m => m.manifestNumber === `MF-${marker}`)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.manifests.list()).some(m => m.manifestNumber === `MF-${marker}`)).toBe(false);
    expect((await callerFor(legacy).fieldRoute.manifests.list()).some(m => m.manifestNumber === `MF-${marker}`)).toBe(false);
    await expect(callerFor(mgrB).fieldRoute.manifests.create({ manifestNumber: `MF-${rnd()}`, material: "x", unitId: unitA, driver: "x" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Unit ${unitA} not found` });
    // Rate cards: A's is A's; B cannot see or update it; the single tenant's carries no organization.
    const rcName = `Card ${rnd()}`;
    const rcId = await callerFor(mgrA).fieldRoute.billing.rateCards.create({ name: rcName, unitType: "hydrovac", hourlyRate: 32500, dailyRate: 260000, jumpHourRate: 0, disposalRate: 1800, specialtyEquipmentRate: 0, currency: "CAD" } as never);
    expect((await callerFor(mgrA).fieldRoute.billing.rateCards.list()).some(r => r.name === rcName)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.billing.rateCards.list()).some(r => r.name === rcName)).toBe(false);
    await expect(callerFor(mgrB).fieldRoute.billing.rateCards.update({ id: Number(rcId), hourlyRate: 1 } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Rate card ${rcId} not found` });
    const legacyCard = `Card ${rnd()}`;
    await callerFor(legacy).fieldRoute.billing.rateCards.create({ name: legacyCard, unitType: "hydrovac", hourlyRate: 1, dailyRate: 1, jumpHourRate: 0, disposalRate: 0, specialtyEquipmentRate: 0, currency: "CAD" } as never);
    const [lrow] = await pool.query<mysql.RowDataPacket[]>("SELECT orgRef FROM billingRateCards WHERE name = ?", [legacyCard]);
    expect(lrow[0]!.orgRef).toBeNull();
    expect((await callerFor(mgrA).fieldRoute.billing.rateCards.list()).some(r => r.name === legacyCard)).toBe(false);
  }, 60_000);
});
