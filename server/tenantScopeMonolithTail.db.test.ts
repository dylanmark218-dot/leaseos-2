/**
 * P4.1 router 10, fourth slice — the last of the monolith: a document review resolves through
 * the document's owner; a transfer acknowledgement follows the tracking number it names (a
 * number naming nothing known is the single tenant's); a scan audit follows the scanned subject.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 278_000_000 + Math.floor(Math.random() * 50_000);
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
async function tripOwnedBy(orgRef: string | null) { const n = `TRP-${rnd()}`; await pool.execute("INSERT INTO trips (tripNumber, tripType, status, orgRef) VALUES (?,'one_way','planned',?)", [n, orgRef]); return n; }

d("the monolith's tail: document review, transfers, scans", () => {
  it("reviews only a document whose owner is in scope, lists and creates transfers by the tracking number's owner, and lists and creates scans by the scanned subject's owner", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A, ["management", "safety"]), mgrB = await member(B, ["management", "safety"]), legacy = await member(null, ["management", "safety"]);
    const unitA = await unitOwnedBy(A);
    // A compliance document on A's unit: B cannot review it; A can.
    const [doc] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt) VALUES ('unit', ?, 'insurance', 'Insurance certificate', NOW())", [unitA]);
    await expect(callerFor(mgrB).fieldRoute.identity.documents.review({ id: doc.insertId, status: "verified" })).rejects.toMatchObject({ code: "NOT_FOUND", message: `Document ${doc.insertId} not found` });
    await expect(callerFor(legacy).fieldRoute.identity.documents.review({ id: doc.insertId, status: "verified" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mgrA).fieldRoute.identity.documents.review({ id: doc.insertId, status: "verified" })).resolves.toBe(true);
    // Transfers: keyed by a tracking number — A's trip number is A's; B cannot log a transfer of it or see it.
    const tripA = await tripOwnedBy(A);
    await expect(callerFor(mgrB).fieldRoute.complianceEngine.transfers.create({ trackingNumber: tripA, channel: "email", recipient: "ap@example.com", attachmentCount: 1, deliveryStatus: "pending" } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `${tripA} not found` });
    await callerFor(mgrA).fieldRoute.complianceEngine.transfers.create({ trackingNumber: tripA, channel: "email", recipient: "ap@example.com", attachmentCount: 1, deliveryStatus: "pending" } as never);
    expect((await callerFor(mgrA).fieldRoute.complianceEngine.transfers.list()).some(t => t.trackingNumber === tripA)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.complianceEngine.transfers.list()).some(t => t.trackingNumber === tripA)).toBe(false);
    expect((await callerFor(legacy).fieldRoute.complianceEngine.transfers.list()).some(t => t.trackingNumber === tripA)).toBe(false);
    // A tracking number naming nothing known is unowned: the single tenant's, invisible to A.
    const orphan = `DT-${rnd()}`;
    await callerFor(legacy).fieldRoute.complianceEngine.transfers.create({ trackingNumber: orphan, channel: "email", recipient: "x@example.com", attachmentCount: 0, deliveryStatus: "pending" } as never);
    expect((await callerFor(legacy).fieldRoute.complianceEngine.transfers.list()).some(t => t.trackingNumber === orphan)).toBe(true);
    expect((await callerFor(mgrA).fieldRoute.complianceEngine.transfers.list()).some(t => t.trackingNumber === orphan)).toBe(false);
    // Scans: a scan of A's unit is A's.
    await expect(callerFor(mgrB).fieldRoute.scans.create({ scanType: "qr", subjectType: "unit", subjectId: unitA, scannedAt: new Date(), latitude: 53.5, longitude: -113.3 } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await callerFor(mgrA).fieldRoute.scans.create({ scanType: "qr", subjectType: "unit", subjectId: unitA, scannedAt: new Date(), latitude: 53.5, longitude: -113.3 } as never);
    expect((await callerFor(mgrA).fieldRoute.scans.list()).some(s => s.subjectType === "unit" && s.subjectId === unitA)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.scans.list()).some(s => s.subjectType === "unit" && s.subjectId === unitA)).toBe(false);
  }, 60_000);
});

d("by-id updates resolve their parent", () => {
  it("refuses a trip-stop update and a route decision across the boundary through the trip they belong to", async () => {
    const A = await org(), B = await org();
    const mgrA = await member(A, ["management"]), mgrB = await member(B, ["management"]);
    const tripNumber = await tripOwnedBy(A);
    const [t] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM trips WHERE tripNumber = ?", [tripNumber]);
    const tripId = Number(t[0]!.id);
    const stopId = await callerFor(mgrA).fieldRoute.tripStops.create({ tripId, stopType: "load", sequence: 1, setupMinutes: 15, waitMinutes: 4, durationMinutes: 38 } as never);
    await expect(callerFor(mgrB).fieldRoute.tripStops.update({ id: Number(stopId), waitMinutes: 9 } as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip stop ${stopId} not found` });
    await expect(callerFor(mgrA).fieldRoute.tripStops.update({ id: Number(stopId), waitMinutes: 9 } as never)).resolves.toBeDefined();
    const decision = { tripId: tripNumber, selectedRoute: "Hwy 43 → RR 60", vehicleType: "hydrovac", gvwTonnes: 30, axleCount: 5, heightMetres: 4, widthMetres: 3, lengthMetres: 12 };
    await expect(callerFor(mgrB).fieldRoute.routeDecisions.create(decision as never)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Trip ${tripNumber} not found` });
    await expect(callerFor(mgrA).fieldRoute.routeDecisions.create(decision as never)).resolves.toBeDefined();
    expect((await callerFor(mgrA).fieldRoute.routeDecisions.list()).some(r => r.tripId === tripNumber)).toBe(true);
    expect((await callerFor(mgrB).fieldRoute.routeDecisions.list()).some(r => r.tripId === tripNumber)).toBe(false);
  }, 60_000);
});
