/**
 * A trip may not name a unit the caller's organization cannot see.
 *
 * `fieldRoute.trips.create` took `unitId` from the request and wrote it, unchecked. A dispatcher in one
 * organization could create a trip on another organization's truck — and every reader that trusts a
 * trip's unit (IFTA distance, the unit's timeline, billing projections, the asset twin's distance) would
 * then attribute that trip to a unit its owner never dispatched. The unit is scoped the way every other
 * unit-keyed write is, through `coreRecordOwnership`, and out of scope is "not found": a refusal that
 * said "forbidden" would confirm the other organization's unit exists.
 *
 * Written RED against the unfixed procedure, through the real router and a real database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const URL = process.env.DATABASE_URL;

describe("trip unit scope — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped tenant-boundary suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 198_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
beforeAll(() => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?, ?, 'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}
/** A user holding `roles` globally, and a member of `orgRef` (null: no membership — the historical single tenant). */
async function person(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?, ?, ?, 'employee', 'active', '2020-01-01', 1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, ?, 'global', 1, NOW())", [userId, role]);
  return userId;
}
async function unit(orgRef: string | null) {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')", [`U-${rnd()}`]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, u.insertId]);
  return Number(u.insertId);
}
const tripRows = async (tripNumber: string) =>
  (await pool.execute<mysql.RowDataPacket[]>("SELECT id, unitId, orgRef FROM trips WHERE tripNumber = ?", [tripNumber]))[0];
const tripsOnUnit = async (unitId: number) =>
  Number((await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM trips WHERE unitId = ?", [unitId]))[0][0].n);
const newTrip = (unitId: number | undefined) => ({ tripNumber: `T-${rnd()}-${rnd()}`.slice(0, 50), unitId, odometerStartKm: 120_000, startedAt: new Date("2026-09-20T07:00:00Z") });

/** What the caller learns from a refusal, with the unit id itself taken out. */
async function refusal(p: Promise<unknown>, unitId: number) {
  const e = await p.then(() => null, (x: unknown) => x as { code?: string; message?: string });
  expect(e, "expected the create to be refused").not.toBeNull();
  return { code: e!.code, message: String(e!.message).replace(String(unitId), "<id>") };
}

d("a trip may not name a unit the caller's organization cannot see", () => {
  it("serves the owner, and refuses another organization's unit exactly as it refuses a unit that does not exist — writing nothing", async () => {
    const A = await org(), B = await org();
    const dispatcherA = await person(A, ["dispatcher"]);
    const dispatcherB = await person(B, ["dispatcher"]);
    const unitA = await unit(A);

    // Same organization: the trip is written, on that unit, in that organization.
    const own = newTrip(unitA);
    const id = await caller(dispatcherA).fieldRoute.trips.create(own);
    expect(Number(id)).toBeGreaterThan(0);
    expect(await tripRows(own.tripNumber)).toEqual([expect.objectContaining({ unitId: unitA, orgRef: A })]);

    // Another organization's unit: NOT_FOUND, and nothing is written.
    const foreign = newTrip(unitA);
    const before = await tripsOnUnit(unitA);
    const across = await refusal(caller(dispatcherB).fieldRoute.trips.create(foreign), unitA);
    expect(across.code).toBe("NOT_FOUND");
    expect(await tripRows(foreign.tripNumber)).toEqual([]);
    expect(await tripsOnUnit(unitA)).toBe(before);

    // A unit that does not exist at all: the same answer, word for word, so the refusal reveals nothing.
    const [[{ maxId }]] = await pool.execute<mysql.RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM units") as unknown as [[{ maxId: number }]];
    const ghost = Number(maxId) + 10_000;
    const missing = newTrip(ghost);
    const nowhere = await refusal(caller(dispatcherB).fieldRoute.trips.create(missing), ghost);
    expect(nowhere).toEqual(across);
    expect(await tripRows(missing.tripNumber)).toEqual([]);
  }, 60_000);

  it("follows the existing ownership rules for the historical single tenant", async () => {
    const A = await org();
    const legacy = await person(null, ["dispatcher"]);
    const member = await person(A, ["dispatcher"]);
    const unowned = await unit(null), owned = await unit(A);

    // A caller with no membership acts as the historical single tenant: it sees unowned units…
    const t1 = newTrip(unowned);
    expect(Number(await caller(legacy).fieldRoute.trips.create(t1))).toBeGreaterThan(0);
    expect(await tripRows(t1.tripNumber)).toEqual([expect.objectContaining({ unitId: unowned, orgRef: null })]);
    // …and not an organization's unit.
    const t2 = newTrip(owned);
    expect((await refusal(caller(legacy).fieldRoute.trips.create(t2), owned)).code).toBe("NOT_FOUND");
    expect(await tripRows(t2.tripNumber)).toEqual([]);
    // An organization's member does not see the historical tenant's unowned unit either.
    const t3 = newTrip(unowned);
    expect((await refusal(caller(member).fieldRoute.trips.create(t3), unowned)).code).toBe("NOT_FOUND");
    expect(await tripRows(t3.tripNumber)).toEqual([]);
  }, 60_000);

  it("does not let authorization stand in for ownership: every role that may create a trip is refused across the boundary", async () => {
    const A = await org(), B = await org();
    const unitA = await unit(A);
    // Every role holding trip.write, and a caller holding all of them at once, in organization B.
    for (const roles of [["driver"], ["dispatcher"], ["office"], ["management"], ["driver", "dispatcher", "office", "management"]]) {
      const who = await person(B, roles);
      const t = newTrip(unitA);
      expect((await refusal(caller(who).fieldRoute.trips.create(t), unitA)).code, roles.join("+")).toBe("NOT_FOUND");
      expect(await tripRows(t.tripNumber)).toEqual([]);
    }
    expect(await tripsOnUnit(unitA)).toBe(0);
  }, 60_000);

  it("still creates a trip that names no unit", async () => {
    const A = await org();
    const t = newTrip(undefined);
    expect(Number(await caller(await person(A, ["dispatcher"])).fieldRoute.trips.create(t))).toBeGreaterThan(0);
    expect(await tripRows(t.tripNumber)).toEqual([expect.objectContaining({ unitId: null, orgRef: A })]);
  }, 60_000);
});
