/**
 * P0-A2.1 — an operating zone belongs to the organization that drew it, and a trip is evaluated
 * against its own organization's zones only.
 *
 * The chain this suite defends, read from the schema rather than asserted:
 *
 *   a person   → organizationMemberships (active, in its effective window) → orgRef → operatingZones.orgRef
 *   a position → tripBreadcrumbs.tripId → trips.orgRef (authoritative) → operatingZones.orgRef
 *
 * Reproduced on main `64f784d` before this change (OZ-T1..T5): company A's dispatcher created a
 * zone; company B's list returned it with its name, coordinates and radius; B's driver reporting a
 * position inside it produced a pending enter proposal on B's trip naming A's zone. A zone is one
 * company's operational configuration (its pad, its yard, its home terminal, its radius), so that
 * is a cross-tenant influence on another company's trip timeline, not a shared road fact.
 *
 * Every case goes through `appRouter.createCaller`, the production boundary — the GPS cases through
 * `gps.submitBreadcrumb`, the real path a position takes into the engine. Case numbers OZ-I1..I12
 * are the checkpoint's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { activeOperatingZonesForTrip } from "./operatingZoneScope";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 274_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

/** reference.read + reference.write (operatingZones.list / create) and gps.read. */
const ZONE_ROLES = ["dispatcher"];

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
type Window = { status?: "active" | "suspended" | "ended"; from?: string; to?: string | null };
async function membership(userId: number, orgRef: string, w: Window = {}) {
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, effectiveTo, createdByUserId) VALUES (?,?,?,'employee',?,?,?,1)",
    [`MEM-${rnd()}`, orgRef, userId, w.status ?? "active", w.from ?? "2020-01-01", w.to ?? null],
  );
}
async function grant(userId: number, roles: string[]) {
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
}
async function member(orgRef: string | null, roles = ZONE_ROLES, w: Window = {}) {
  const userId = seq++;
  if (orgRef) await membership(userId, orgRef, w);
  await grant(userId, roles);
  return userId;
}
/** A driver of the organization with an operator record it owns and one active trip it owns. */
async function driverWithActiveTrip(orgRef: string | null) {
  const userId = await member(orgRef, ["driver"]);
  const [op] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?, ?)", [`Driver ${rnd()}`, userId]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, op.insertId]);
  const [t] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (orgRef, tripNumber, operatorId, status, createdAt) VALUES (?, ?, ?, 'in_transit', NOW())", [orgRef, `TR-${rnd()}`, op.insertId]);
  return { userId, tripId: t.insertId };
}
/** A zone written straight into the table with an explicit owner (NULL = legacy, pre-0209). */
async function zoneRow(orgRef: string | null, lat: number, lng: number) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operatingZones (orgRef, name, zoneType, latitude, longitude, radiusMetres, active) VALUES (?, ?, 'loading', ?, ?, 75, 1)", [orgRef, `Zone ${rnd()}`, lat, lng]);
  return r.insertId;
}
/** Coordinates nobody else uses, so a position "inside" is attributable to one zone alone. */
const spot = () => ({ lat: 55 + Math.random() * 4, lng: -118 - Math.random() * 4 });
const outside = (p: { lat: number; lng: number }) => ({ lat: p.lat + 0.02, lng: p.lng + 0.02 });   // ≈2 km away
const at = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng, accuracyMetres: 5, recordedAt: new Date() });
const count = async (sql: string, args: (string | number)[]) => Number(((await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as { n: number }).n);
const one = async <T = Record<string, unknown>>(sql: string, args: (string | number)[]) => (await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as T;
const zoneInput = (name: string, p: { lat: number; lng: number }) => ({ name, zoneType: "loading" as const, latitude: p.lat, longitude: p.lng, radiusMetres: 75 });

d("an operating zone belongs to the organization that drew it", () => {
  it("OZ-I1/I5 — A's zone is stamped with A, listed to A, absent from B's list; an orgRef in the input is refused; a zone with the same name in B is B's own", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const name = `Pad ${rnd()}`;
    const p = spot();
    const zoneA = Number(await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(name, p)));
    expect(await one("SELECT orgRef FROM operatingZones WHERE id = ?", [zoneA])).toEqual({ orgRef: A });
    // The input cannot name the organization — not B's, not A's own, not anyone's.
    await expect(callerFor(dispA).fieldRoute.operatingZones.create({ ...zoneInput(`x ${rnd()}`, p), orgRef: B } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(dispA).fieldRoute.operatingZones.create({ ...zoneInput(`x ${rnd()}`, p), orgRef: A } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await count("SELECT COUNT(*) n FROM operatingZones WHERE orgRef = ?", [B])).toBe(0);
    // Lists: A's rows to A, none of A's to B — and B has no trace that A's zone exists.
    const listA = await callerFor(dispA).fieldRoute.operatingZones.list();
    expect(listA.map(z => z.id)).toContain(zoneA);
    expect(listA.every(z => z.orgRef === A)).toBe(true);
    const listB = await callerFor(dispB).fieldRoute.operatingZones.list();
    expect(listB.some(z => z.id === zoneA || z.name === name)).toBe(false);
    // B drawing its own zone of the same name at the same place: B's row, B's list, not A's.
    const zoneB = Number(await callerFor(dispB).fieldRoute.operatingZones.create(zoneInput(name, p)));
    expect(await one("SELECT orgRef FROM operatingZones WHERE id = ?", [zoneB])).toEqual({ orgRef: B });
    expect((await callerFor(dispB).fieldRoute.operatingZones.list()).map(z => z.id)).toContain(zoneB);
    expect((await callerFor(dispA).fieldRoute.operatingZones.list()).some(z => z.id === zoneB)).toBe(false);
  }, 60_000);

  it("OZ-I4 — the surface has no zone update, deactivate or delete procedure (nothing to scope); it is exactly list and create", () => {
    const names = Object.keys(appRouter._def.procedures).filter(k => k.startsWith("fieldRoute.operatingZones.")).sort();
    expect(names).toEqual(["fieldRoute.operatingZones.create", "fieldRoute.operatingZones.list"]);
  });
});

d("the geofence engine evaluates a trip against its own organization's zones", () => {
  it("OZ-I2/I3/I10/I11 — B's trip ignores A's zone and writes no event for it; A's trip proposes entry into A's zone; the organization comes from the trip", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A);
    const p = spot();
    const zoneA = Number(await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, p)));
    const drvB = await driverWithActiveTrip(B), drvA = await driverWithActiveTrip(A);

    // I2/I11 — B's driver standing inside A's zone: nothing proposed, nothing written, nothing pending for B's dispatch.
    const rB = await callerFor(drvB.userId).fieldRoute.gps.submitBreadcrumb(at(p));
    expect(rB.proposedEvents).toEqual([]);
    expect(await count("SELECT COUNT(*) n FROM zoneEvents WHERE tripId = ?", [drvB.tripId])).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM zoneEvents WHERE zoneId = ?", [zoneA])).toBe(0);
    // I3 — A's driver at the same spot: an enter proposal for A's zone, pending, on A's trip.
    const rA = await callerFor(drvA.userId).fieldRoute.gps.submitBreadcrumb(at(p));
    expect(rA.proposedEvents).toEqual([expect.objectContaining({ zoneId: zoneA, eventType: "enter" })]);
    expect(await one("SELECT tripId, status FROM zoneEvents WHERE zoneId = ?", [zoneA])).toEqual({ tripId: drvA.tripId, status: "pending" });
    // I10 — the engine's zone set is a function of the trip alone.
    expect((await activeOperatingZonesForTrip(drvA.tripId)).map(z => z.id)).toContain(zoneA);
    expect((await activeOperatingZonesForTrip(drvB.tripId)).some(z => z.id === zoneA)).toBe(false);
    expect(await activeOperatingZonesForTrip(900_000_000 + Math.floor(Math.random() * 1_000_000))).toEqual([]);
  }, 60_000);

  it("OZ-I12 — same-organization geofence behaviour is unchanged: enter, then exit, then nothing while outside; an inactive zone is not evaluated", async () => {
    const A = await org();
    const dispA = await member(A);
    const p = spot();
    const zoneA = Number(await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, p)));
    const dormant = Number(await callerFor(dispA).fieldRoute.operatingZones.create({ ...zoneInput(`Dormant ${rnd()}`, p), active: 0 }));
    const drv = await driverWithActiveTrip(A);
    const c = callerFor(drv.userId);
    expect((await c.fieldRoute.gps.submitBreadcrumb(at(p))).proposedEvents).toEqual([expect.objectContaining({ zoneId: zoneA, eventType: "enter" })]);
    expect((await c.fieldRoute.gps.submitBreadcrumb(at(outside(p)))).proposedEvents).toEqual([expect.objectContaining({ zoneId: zoneA, eventType: "exit" })]);
    expect((await c.fieldRoute.gps.submitBreadcrumb(at(outside(p)))).proposedEvents).toEqual([]);
    expect(await count("SELECT COUNT(*) n FROM zoneEvents WHERE zoneId = ?", [dormant])).toBe(0);
    const events = (await pool.execute<mysql.RowDataPacket[]>("SELECT eventType FROM zoneEvents WHERE tripId = ? ORDER BY id", [drv.tripId]))[0].map(r => r.eventType);
    expect(events).toEqual(["enter", "exit"]);
  }, 60_000);
});

d("an ended membership is a hard boundary; two live memberships fail closed", () => {
  it("OZ-I6/I7 — an ex-member cannot list or create, with every historical grant or a fresh one; nothing is written", async () => {
    const A = await org();
    const dispA = await member(A);
    await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot()));
    const before = await count("SELECT COUNT(*) n FROM operatingZones", []);
    const refused = { code: "FORBIDDEN", message: "No active organization membership" };
    const ex = await member(A, ZONE_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await expect(callerFor(ex).fieldRoute.operatingZones.list()).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot()))).rejects.toMatchObject(refused);
    // I7 — a new role grant after the membership ended changes nothing: roles are not tenancy.
    await grant(ex, ["management", "office"]);
    await expect(callerFor(ex).fieldRoute.operatingZones.list()).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot()))).rejects.toMatchObject(refused);
    // Nor a membership that lapsed by its window, nor a suspended one.
    const lapsed = await member(A, ZONE_ROLES, { status: "active", from: "2020-01-01", to: "2021-01-01" });
    await expect(callerFor(lapsed).fieldRoute.operatingZones.list()).rejects.toMatchObject(refused);
    const suspended = await member(A, ZONE_ROLES, { status: "suspended" });
    await expect(callerFor(suspended).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot()))).rejects.toMatchObject(refused);
    expect(await count("SELECT COUNT(*) n FROM operatingZones", [])).toBe(before);
  }, 60_000);

  it("OZ-I8 — acting as A reaches A's zones only; acting as B reaches B's only; two live memberships are refused, never unioned", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const zoneA = Number(await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot())));
    const zoneB = Number(await callerFor(dispB).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot())));
    const person = seq++;
    await grant(person, ZONE_ROLES);
    await membership(person, A, { from: "2020-01-01" });
    await membership(person, B, { status: "ended", from: "2019-01-01", to: "2019-12-31" });
    let ids = (await callerFor(person).fieldRoute.operatingZones.list()).map(z => z.id);
    expect(ids).toContain(zoneA); expect(ids).not.toContain(zoneB);
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = '2025-01-01' WHERE userId = ? AND orgRef = ?", [person, A]);
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, B]);
    ids = (await callerFor(person).fieldRoute.operatingZones.list()).map(z => z.id);
    expect(ids).toContain(zoneB); expect(ids).not.toContain(zoneA);
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, A]);
    const before = await count("SELECT COUNT(*) n FROM operatingZones", []);
    await expect(callerFor(person).fieldRoute.operatingZones.list()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(person).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, spot()))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await count("SELECT COUNT(*) n FROM operatingZones", [])).toBe(before);
  }, 60_000);
});

d("legacy rows follow the 0132/0148 convention: NULL is the historical single tenant's", () => {
  it("OZ-I9 — a pre-0209 zone is listed to the never-a-member fallback only, written NULL by it, evaluated for a legacy trip only, and never for a member's trip", async () => {
    const A = await org();
    const dispA = await member(A);
    const p = spot();
    const legacyZone = await zoneRow(null, p.lat, p.lng);
    const zoneA = Number(await callerFor(dispA).fieldRoute.operatingZones.create(zoneInput(`Pad ${rnd()}`, p)));
    // Listing: A's member never sees the legacy zone; the fallback user never sees A's.
    expect((await callerFor(dispA).fieldRoute.operatingZones.list()).some(z => z.id === legacyZone)).toBe(false);
    const legacyUser = await member(null);
    const legacyList = await callerFor(legacyUser).fieldRoute.operatingZones.list();
    expect(legacyList.map(z => z.id)).toContain(legacyZone);
    expect(legacyList.some(z => z.id === zoneA || z.orgRef != null)).toBe(false);
    // Writing: the fallback user's zone carries no organization, as its trips and rate cards do.
    const written = Number(await callerFor(legacyUser).fieldRoute.operatingZones.create(zoneInput(`Legacy ${rnd()}`, spot())));
    expect(await one("SELECT orgRef FROM operatingZones WHERE id = ?", [written])).toEqual({ orgRef: null });
    // Evaluating: A's trip at the spot proposes A's zone only; a legacy (ownerless) trip proposes the legacy zone only.
    const drvA = await driverWithActiveTrip(A);
    expect((await callerFor(drvA.userId).fieldRoute.gps.submitBreadcrumb(at(p))).proposedEvents.map(e => e.zoneId)).toEqual([zoneA]);
    const drvLegacy = await driverWithActiveTrip(null);
    expect((await callerFor(drvLegacy.userId).fieldRoute.gps.submitBreadcrumb(at(p))).proposedEvents.map(e => e.zoneId)).toEqual([legacyZone]);
    expect(await count("SELECT COUNT(*) n FROM zoneEvents WHERE zoneId = ? AND tripId = ?", [legacyZone, drvA.tripId])).toBe(0);
    // An ex-member is not the fallback: the legacy zone is not theirs either.
    const ex = await member(A, ZONE_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await expect(callerFor(ex).fieldRoute.operatingZones.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
