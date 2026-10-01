/**
 * P0-A2 — telematics belongs to the organization that owns the unit.
 *
 * The chain this suite defends, read from the schema rather than asserted:
 *
 *   caller → organizationMemberships (active, in its effective window) → orgRef
 *          → coreRecordOwnership(recordType = 'unit', recordId) → units.id
 *          → telemetrySnapshots.unitId · faultCodes.unitId · drivingEvents.unitId
 *   and, for the GPS trace and geofence proposals,
 *          → trips.orgRef → tripBreadcrumbs.tripId · zoneEvents.tripId
 *
 * No telemetry row carries an organization of its own. A caller-supplied unit id, fault id, event
 * reference, trip id or zone-event id is never authority; across the boundary the answer is the
 * same not-found a nonexistent id gets — never "forbidden", never a company name — so another
 * organization's ids cannot be confirmed to exist. Every case goes through
 * `appRouter.createCaller`, the production boundary, not a helper.
 *
 * Case numbers (TEL-T1 … TEL-T20) are the P0-A2 checkpoint's; several share one `it` where the
 * fixture is the same.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 273_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const machine = (key: string) => appRouter.createCaller({ req: { headers: { "x-integration-key": key } } as never, res: {} as never, user: null as never });

/** Together: telematics.read, telematics.fault.acknowledge, safety.event.review, safety.video.read, gps.read, gps.confirm. */
const TEL_ROLES = ["dispatcher", "mechanic", "safety", "management"];

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
async function member(orgRef: string | null, roles = TEL_ROLES, w: Window = {}) {
  const userId = seq++;
  if (orgRef) await membership(userId, orgRef, w);
  await grant(userId, roles);
  return userId;
}
async function unitOwnedBy(orgRef: string | null) {
  const unitNumber = `U-${rnd()}`;
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, inspectionStatus, maintenanceStatus, createdAt) VALUES (?, 'vac truck', 'current', 'clear', NOW())", [unitNumber]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'unit',?,1)", [orgRef, r.insertId]);
  return { id: r.insertId, unitNumber };
}
async function operatorOwnedBy(orgRef: string | null, userId: number | null = null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId) VALUES (?, ?)", [`Driver ${rnd()}`, userId]);
  if (orgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, r.insertId]);
  return r.insertId;
}
/** A machine client and one accepted inbound row for it — what every telemetry row has to name. */
async function feed(orgRef: string | null) {
  const [c] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO integrationClients (orgRef, clientRef, name, kind, keyHash, scopesJson, createdByUserId) VALUES (?,?,?,'telematics',?,'[\"vehicle_telemetry\",\"fault_code\",\"safety_event\",\"video_clip\"]',1)",
    [orgRef, `INTG-${rnd()}`, `feed ${rnd()}`, createHash("sha256").update(rnd() + rnd()).digest("hex")],
  );
  const [e] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO inboundEvents (orgRef, inboundRef, clientId, feed, idempotencyKey, payloadJson, payloadHash, status, receivedAt) VALUES (?,?,?,'vehicle_telemetry',?,'{}',?,'accepted',NOW())",
    [orgRef, `INB-${rnd()}`, c.insertId, rnd(), createHash("sha256").update(rnd()).digest("hex")],
  );
  return { clientId: c.insertId, inboundEventId: e.insertId };
}
async function snapshot(unitId: number, f: { clientId: number; inboundEventId: number }, odometerKm: number) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO telemetrySnapshots (unitId, recordedAt, odometerKm, sourceClientId, inboundEventId) VALUES (?, NOW(), ?, ?, ?)", [unitId, odometerKm, f.clientId, f.inboundEventId]);
  return r.insertId;
}
async function fault(unitId: number, f: { clientId: number }, code: string, status: "active" | "acknowledged" | "cleared" = "active") {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO faultCodes (unitId, protocol, code, firstSeenAt, lastSeenAt, status, sourceClientId) VALUES (?, 'j1939', ?, NOW(), NOW(), ?, ?)", [unitId, code, status, f.clientId]);
  return r.insertId;
}
async function event(unitId: number, f: { clientId: number; inboundEventId: number }, withVideo = false) {
  const eventRef = `DRV-${rnd()}`;
  await pool.execute("INSERT INTO drivingEvents (eventRef, unitId, kind, recordedAt, videoClipRef, videoClipHash, sourceClientId, inboundEventId) VALUES (?, ?, 'harsh_brake', NOW(), ?, ?, ?, ?)", [eventRef, unitId, withVideo ? `cam/${rnd()}` : null, withVideo ? "a".repeat(64) : null, f.clientId, f.inboundEventId]);
  return eventRef;
}
async function trip(orgRef: string | null, unitId: number | null, operatorId: number | null = null, status = "in_transit") {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO trips (orgRef, tripNumber, unitId, operatorId, status, createdAt) VALUES (?, ?, ?, ?, ?, NOW())", [orgRef, `TR-${rnd()}`, unitId, operatorId, status]);
  return r.insertId;
}
async function zone() {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operatingZones (name, zoneType, latitude, longitude) VALUES (?, 'loading', 53.5, -113.5)", [`Zone ${rnd()}`]);
  return r.insertId;
}
async function zoneEvent(tripId: number, zoneId: number, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO zoneEvents (tripId, zoneId, eventType, detectedAt, distanceMetres, status) VALUES (?, ?, 'enter', NOW(), 12, 'pending')", [tripId, zoneId]);
    ids.push(r.insertId);
  }
  return ids;
}
async function breadcrumb(tripId: number, unitId: number | null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO tripBreadcrumbs (tripId, unitId, latitude, longitude, recordedAt) VALUES (?, ?, 53.5, -113.5, NOW())", [tripId, unitId]);
  return r.insertId;
}
const count = async (sql: string, args: (string | number)[]) => Number(((await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as { n: number }).n);
const one = async <T = Record<string, unknown>>(sql: string, args: (string | number)[]) => (await pool.execute<mysql.RowDataPacket[]>(sql, args))[0][0] as T;
const unitNotFound = (id: number) => ({ code: "NOT_FOUND", message: `Unit ${id} not found` });
const tripNotFound = (id: number) => ({ code: "NOT_FOUND", message: `Trip ${id} not found` });
const FAULT_NOT_FOUND = { code: "NOT_FOUND", message: "Fault not found" };
const EVENT_NOT_FOUND = { code: "NOT_FOUND", message: "Event not found" };
const ghostId = () => 900_000_000 + Math.floor(Math.random() * 1_000_000);

d("telematics reads are refused across the organization boundary", () => {
  it("TEL-T1/T2/T3 — the unit view: a foreign unit is refused exactly like a nonexistent one; the owner is served, including a unit with no telemetry yet", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B), quietA = await unitOwnedBy(A);
    const fA = await feed(A), fB = await feed(B);
    await snapshot(unitA.id, fA, 168_400); await snapshot(unitB.id, fB, 99_000);
    await fault(unitA.id, fA, "SPN-100"); await fault(unitB.id, fB, "SPN-200"); await fault(unitB.id, fB, "SPN-201");
    const ghost = ghostId();

    // T1 — B's unit by id: refused, and refused as not-found. A null `latest` would still say "exists".
    await expect(callerFor(dispA).telematics.unit({ unitId: unitB.id })).rejects.toMatchObject(unitNotFound(unitB.id));
    // T2 — a nonexistent id gets the identical code and message shape.
    await expect(callerFor(dispA).telematics.unit({ unitId: ghost })).rejects.toMatchObject(unitNotFound(ghost));
    // T3 — the owner is served: A's snapshot, A's one fault, nothing of B's.
    const own = await callerFor(dispA).telematics.unit({ unitId: unitA.id });
    expect(own.latest).toMatchObject({ odometerKm: 168_400 });
    expect(own.faults.map(f => f.code)).toEqual(["SPN-100"]);
    // An owned unit that has reported nothing is still the owner's: null telemetry, not a refusal.
    await expect(callerFor(dispA).telematics.unit({ unitId: quietA.id })).resolves.toMatchObject({ unitId: quietA.id, latest: null, faults: [] });
  }, 60_000);

  it("TEL-T4/T5 — the fault list is tenant-filtered in the query: no foreign rows, no foreign counts, with or without a status filter", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fA = await feed(A), fB = await feed(B);
    const idsA = [await fault(unitA.id, fA, "A-1"), await fault(unitA.id, fA, "A-2", "acknowledged")];
    const idsB = [await fault(unitB.id, fB, "B-1"), await fault(unitB.id, fB, "B-2"), await fault(unitB.id, fB, "B-3", "acknowledged"), await fault(unitB.id, fB, "B-4", "cleared")];

    const listA = await callerFor(dispA).telematics.faults({});
    expect(listA.faults.map(f => f.id).sort()).toEqual([...idsA].sort());
    expect(listA.faults.some(f => idsB.includes(f.id) || f.unitId === unitB.id)).toBe(false);
    const activeA = await callerFor(dispA).telematics.faults({ status: "active" });
    expect(activeA.faults.map(f => f.id)).toEqual([idsA[0]]);
    const clearedA = await callerFor(dispA).telematics.faults({ status: "cleared" });
    expect(clearedA.faults).toEqual([]);
    // B sees B's — more rows than A, so a global limit could not hide the leak.
    const listB = await callerFor(dispB).telematics.faults({});
    expect(listB.faults.map(f => f.id).sort()).toEqual([idsB[0], idsB[1], idsB[2]].sort());
    expect(listB.faults.every(f => f.unitId === unitB.id)).toBe(true);
  }, 60_000);

  it("TEL-T6/T7 — the review queue is the caller's organization only: no foreign unit in the queue, no foreign event in the list", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fA = await feed(A), fB = await feed(B);
    const evA = await event(unitA.id, fA);
    const evB = [await event(unitB.id, fB), await event(unitB.id, fB, true), await event(unitB.id, fB)];

    const qA = await callerFor(dispA).telematics.reviewQueue();
    expect(qA.queue.map(g => g.unitId)).toEqual([unitA.id]);
    expect(qA.events.map(e => e.eventRef)).toEqual([evA]);
    expect(qA.events.some(e => evB.includes(e.eventRef) || e.unitId === unitB.id)).toBe(false);
    const qB = await callerFor(dispB).telematics.reviewQueue();
    expect(qB.queue).toEqual([expect.objectContaining({ unitId: unitB.id, count: 3, withVideo: 1 })]);
    expect(qB.events.map(e => e.eventRef).sort()).toEqual([...evB].sort());
  }, 60_000);
});

d("telematics mutations prove ownership independently of the permission", () => {
  it("TEL-T8/T9 — acknowledge and clear: a foreign fault is refused like a nonexistent one, nothing is written; the owner's mechanic is served", async () => {
    const A = await org(), B = await org();
    const mechA = await member(A);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fA = await feed(A), fB = await feed(B);
    const faultA = await fault(unitA.id, fA, "SPN-100");
    const faultB = await fault(unitB.id, fB, "SPN-200");
    const ackedB = await fault(unitB.id, fB, "SPN-201", "acknowledged");
    const ghost = ghostId();
    const defectsB = await count("SELECT COUNT(*) n FROM maintenanceDefects WHERE unitId = ?", [unitB.id]);

    // T8 — acknowledging B's fault with the right permission and the wrong company.
    await expect(callerFor(mechA).telematics.faultAcknowledge({ faultId: faultB, severity: "critical", title: "Low oil pressure", detail: "Confirmed at the gauge" })).rejects.toMatchObject(FAULT_NOT_FOUND);
    await expect(callerFor(mechA).telematics.faultAcknowledge({ faultId: ghost, severity: "critical", title: "Low oil pressure", detail: "Confirmed at the gauge" })).rejects.toMatchObject(FAULT_NOT_FOUND);
    // T9 — clearing B's fault.
    await expect(callerFor(mechA).telematics.faultClear({ faultId: faultB, reason: "Feels fine now" })).rejects.toMatchObject(FAULT_NOT_FOUND);
    await expect(callerFor(mechA).telematics.faultClear({ faultId: ackedB, reason: "Feels fine now" })).rejects.toMatchObject(FAULT_NOT_FOUND);
    await expect(callerFor(mechA).telematics.faultClear({ faultId: ghost, reason: "Feels fine now" })).rejects.toMatchObject(FAULT_NOT_FOUND);
    // Nothing of B's changed: no defect opened on B's unit, both faults as they were.
    expect(await count("SELECT COUNT(*) n FROM maintenanceDefects WHERE unitId = ?", [unitB.id])).toBe(defectsB);
    expect(await one("SELECT status, severityDetermination, acknowledgedByUserId FROM faultCodes WHERE id = ?", [faultB])).toEqual({ status: "active", severityDetermination: "unknown", acknowledgedByUserId: null });
    expect(await one("SELECT status FROM faultCodes WHERE id = ?", [ackedB])).toEqual({ status: "acknowledged" });

    // The same calls on the caller's own fault succeed.
    const ack = await callerFor(mechA).telematics.faultAcknowledge({ faultId: faultA, severity: "advisory", title: "Sensor drift", detail: "Logged for the next service" });
    expect(ack).toMatchObject({ faultId: faultA, severity: "advisory" });
    expect(await one("SELECT unitId FROM maintenanceDefects WHERE id = ?", [ack.defectId])).toEqual({ unitId: unitA.id });
  }, 60_000);

  it("TEL-T10/T11 — review and video: a foreign event reference is refused like a nonexistent one; no review is written and no video access is logged", async () => {
    const A = await org(), B = await org();
    const safetyA = await member(A);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fA = await feed(A), fB = await feed(B);
    const evA = await event(unitA.id, fA);
    const evB = await event(unitB.id, fB, true);
    const ghostRef = `DRV-${rnd()}`;

    // T10 — reviewing B's event.
    await expect(callerFor(safetyA).telematics.eventReview({ eventRef: evB, decision: "escalated", note: "Possible contact with a pump jack — incident" })).rejects.toMatchObject(EVENT_NOT_FOUND);
    await expect(callerFor(safetyA).telematics.eventReview({ eventRef: ghostRef, decision: "escalated", note: "Possible contact with a pump jack — incident" })).rejects.toMatchObject(EVENT_NOT_FOUND);
    // T11 — viewing B's video: the look itself is the sensitive act, and it is not logged as taken.
    await expect(callerFor(safetyA).telematics.videoView({ eventRef: evB, purpose: "Review before coaching" })).rejects.toMatchObject(EVENT_NOT_FOUND);
    await expect(callerFor(safetyA).telematics.videoView({ eventRef: ghostRef, purpose: "Review before coaching" })).rejects.toMatchObject(EVENT_NOT_FOUND);
    expect(await one("SELECT reviewStatus, reviewedByUserId FROM drivingEvents WHERE eventRef = ?", [evB])).toEqual({ reviewStatus: "unreviewed", reviewedByUserId: null });
    expect(await count("SELECT COUNT(*) n FROM videoAccessLog WHERE userId = ?", [safetyA])).toBe(0);

    // The caller's own event is reviewed.
    await expect(callerFor(safetyA).telematics.eventReview({ eventRef: evA, decision: "coached", note: "Talked through following distance on lease roads" })).resolves.toMatchObject({ eventRef: evA, reviewStatus: "coached" });
  }, 60_000);
});

d("the GPS trace and geofence proposals follow the trip's organization", () => {
  it("TEL-T12/T13 — zone events without a trip are the caller's trips only; a foreign trip or zone event is refused like a nonexistent one, with nothing confirmed", async () => {
    const A = await org(), B = await org();
    const dispA = await member(A), dispB = await member(B);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const tripA = await trip(A, unitA.id), tripB = await trip(B, unitB.id);
    const z = await zone();
    const zeA = await zoneEvent(tripA, z, 2);
    const zeB = await zoneEvent(tripB, z, 5);
    await breadcrumb(tripA, unitA.id); await breadcrumb(tripB, unitB.id);
    const ghostTrip = ghostId(), ghostZe = ghostId();

    // T12 — the unfiltered lists (dispatch view) are A's rows only; B has more rows than A.
    const all = await callerFor(dispA).fieldRoute.gps.zoneEvents();
    expect(all.map(e => e.id).sort()).toEqual([...zeA].sort());
    expect(all.some(e => e.tripId === tripB)).toBe(false);
    const pending = await callerFor(dispA).fieldRoute.gps.pendingZoneEvents();
    expect(pending.map(e => e.id).sort()).toEqual([...zeA].sort());
    const allB = await callerFor(dispB).fieldRoute.gps.zoneEvents({});
    expect(allB).toHaveLength(5);
    expect(allB.every(e => e.tripId === tripB)).toBe(true);
    // T13 — a foreign trip id is refused like a nonexistent one, on every trip-keyed read.
    await expect(callerFor(dispA).fieldRoute.gps.zoneEvents({ tripId: tripB })).rejects.toMatchObject(tripNotFound(tripB));
    await expect(callerFor(dispA).fieldRoute.gps.zoneEvents({ tripId: ghostTrip })).rejects.toMatchObject(tripNotFound(ghostTrip));
    await expect(callerFor(dispA).fieldRoute.gps.pendingZoneEvents({ tripId: tripB })).rejects.toMatchObject(tripNotFound(tripB));
    await expect(callerFor(dispA).fieldRoute.gps.breadcrumbs({ tripId: tripB })).rejects.toMatchObject(tripNotFound(tripB));
    await expect(callerFor(dispA).fieldRoute.gps.breadcrumbs({ tripId: ghostTrip })).rejects.toMatchObject(tripNotFound(ghostTrip));
    await expect(callerFor(dispA).fieldRoute.gps.breadcrumbs({ tripId: tripA })).resolves.toHaveLength(1);
    // Confirming B's proposal: refused as not-found, and B's row is untouched.
    const zeNotFound = (id: number) => ({ code: "NOT_FOUND", message: `Zone event ${id} not found` });
    await expect(callerFor(dispA).fieldRoute.gps.confirmZoneEvent({ id: zeB[0]!, action: "confirm" })).rejects.toMatchObject(zeNotFound(zeB[0]!));
    await expect(callerFor(dispA).fieldRoute.gps.confirmZoneEvent({ id: ghostZe, action: "confirm" })).rejects.toMatchObject(zeNotFound(ghostZe));
    expect(await one("SELECT status, confirmedBy FROM zoneEvents WHERE id = ?", [zeB[0]!])).toEqual({ status: "pending", confirmedBy: null });
    await expect(callerFor(dispA).fieldRoute.gps.confirmZoneEvent({ id: zeA[0]!, action: "confirm" })).resolves.toEqual({ success: true });
  }, 60_000);
});

d("multi-company users act for one organization at a time", () => {
  it("TEL-T14 — acting as A reaches A's telematics only; acting as B reaches B's only; two live memberships are refused, never unioned", async () => {
    const A = await org(), B = await org();
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fA = await feed(A), fB = await feed(B);
    const faultA = await fault(unitA.id, fA, "A-1"), faultB = await fault(unitB.id, fB, "B-1");
    const person = seq++;
    await grant(person, TEL_ROLES);
    await membership(person, A, { from: "2020-01-01" });
    await membership(person, B, { status: "ended", from: "2019-01-01", to: "2019-12-31" });
    await expect(callerFor(person).telematics.unit({ unitId: unitA.id })).resolves.toMatchObject({ unitId: unitA.id });
    await expect(callerFor(person).telematics.unit({ unitId: unitB.id })).rejects.toMatchObject(unitNotFound(unitB.id));
    expect((await callerFor(person).telematics.faults({})).faults.map(f => f.id)).toEqual([faultA]);

    // Switch: A's membership ends, B's becomes the live one.
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = '2025-01-01' WHERE userId = ? AND orgRef = ?", [person, A]);
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, B]);
    await expect(callerFor(person).telematics.unit({ unitId: unitB.id })).resolves.toMatchObject({ unitId: unitB.id });
    await expect(callerFor(person).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(unitNotFound(unitA.id));
    expect((await callerFor(person).telematics.faults({})).faults.map(f => f.id)).toEqual([faultB]);

    // Two live memberships and no selection: refused outright. Not A, not B, not both.
    await pool.execute("UPDATE organizationMemberships SET status = 'active', effectiveFrom = '2020-01-01', effectiveTo = NULL WHERE userId = ? AND orgRef = ?", [person, A]);
    const ambiguous = { code: "PRECONDITION_FAILED" };
    await expect(callerFor(person).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).telematics.faults({})).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).telematics.reviewQueue()).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).fieldRoute.gps.zoneEvents()).rejects.toMatchObject(ambiguous);
    await expect(callerFor(person).telematics.faultAcknowledge({ faultId: faultA, severity: "advisory", title: "Sensor drift" })).rejects.toMatchObject(ambiguous);
  }, 60_000);
});

d("an ended membership is a hard boundary", () => {
  it("TEL-T15/T16 — an ex-member with every historical grant, and a fresh grant, reaches nothing of the company's telematics", async () => {
    const A = await org();
    const unitA = await unitOwnedBy(A);
    const fA = await feed(A);
    const faultA = await fault(unitA.id, fA, "A-1");
    const evA = await event(unitA.id, fA, true);
    const tripA = await trip(A, unitA.id);
    const ex = await member(A, TEL_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    // Refused at the scope step, before any id is looked at: the refusal names no organization,
    // no record, and is the same whatever id was sent.
    const refused = { code: "FORBIDDEN", message: "No active organization membership" };
    await expect(callerFor(ex).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.faults({})).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.reviewQueue()).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.faultAcknowledge({ faultId: faultA, severity: "critical", title: "Low oil pressure" })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.faultClear({ faultId: faultA, reason: "Feels fine now" })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.eventReview({ eventRef: evA, decision: "dismissed", note: "Nothing to see in this one" })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).telematics.videoView({ eventRef: evA, purpose: "Review before coaching" })).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.gps.zoneEvents()).rejects.toMatchObject(refused);
    await expect(callerFor(ex).fieldRoute.gps.breadcrumbs({ tripId: tripA })).rejects.toMatchObject(refused);
    expect(await count("SELECT COUNT(*) n FROM videoAccessLog WHERE userId = ?", [ex])).toBe(0);
    // T16 — a new role grant after the membership ended changes nothing: roles are not tenancy.
    await grant(ex, ["controller", "auditor"]);
    await expect(callerFor(ex).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(refused);
    // Nor does a membership that expired by its window rather than by status, nor a suspended one.
    const lapsed = await member(A, TEL_ROLES, { status: "active", from: "2020-01-01", to: "2021-01-01" });
    await expect(callerFor(lapsed).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(refused);
    const suspended = await member(A, TEL_ROLES, { status: "suspended" });
    await expect(callerFor(suspended).telematics.faults({})).rejects.toMatchObject(refused);
  }, 60_000);

  it("TEL-T17 — the legacy single-tenant fallback serves a person who never had a membership, and never revives one whose membership ended", async () => {
    const A = await org();
    const legacyUnit = await unitOwnedBy(null);
    const ownedA = await unitOwnedBy(A);
    const fL = await feed(null), fA = await feed(A);
    const legacyFault = await fault(legacyUnit.id, fL, "L-1");
    const faultA = await fault(ownedA.id, fA, "A-1");
    // Never a member anywhere: the fallback is theirs, and it reaches unowned rows only (every
    // unowned row on this database, which other fixtures also leave behind — so containment, not
    // equality, is what is pinned here; A's row must be absent).
    const legacyUser = await member(null);
    await expect(callerFor(legacyUser).telematics.unit({ unitId: legacyUnit.id })).resolves.toMatchObject({ unitId: legacyUnit.id });
    await expect(callerFor(legacyUser).telematics.unit({ unitId: ownedA.id })).rejects.toMatchObject(unitNotFound(ownedA.id));
    const legacyList = (await callerFor(legacyUser).telematics.faults({})).faults;
    expect(legacyList.map(f => f.id)).toContain(legacyFault);
    expect(legacyList.some(f => f.id === faultA || f.unitId === ownedA.id)).toBe(false);
    // Was a member of A, ended: no fallback. The legacy unit is not theirs either.
    const ex = await member(A, TEL_ROLES, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await expect(callerFor(ex).telematics.unit({ unitId: legacyUnit.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(ex).telematics.faults({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});

d("machine ingestion is bound to the organization that registered the client", () => {
  it("TEL-T18/T19 — a client of A cannot feed B's unit or attach video to B's event; what it feeds for A is A's and invisible to B", async () => {
    const A = await org(), B = await org();
    const ctrlA = await member(A, ["controller", "dispatcher"]), dispB = await member(B, ["controller", "safety"]);
    const unitA = await unitOwnedBy(A), unitB = await unitOwnedBy(B);
    const fB = await feed(B);
    const evB = await event(unitB.id, fB);
    const clientA = await callerFor(ctrlA).integration.clientRegister({ name: "Telematics Co", kind: "telematics", scopes: ["vehicle_telemetry", "fault_code", "safety_event", "video_clip"] });
    const mA = machine(clientA.key);
    const before = {
      snaps: await count("SELECT COUNT(*) n FROM telemetrySnapshots WHERE unitId = ?", [unitB.id]),
      faults: await count("SELECT COUNT(*) n FROM faultCodes WHERE unitId = ?", [unitB.id]),
      events: await count("SELECT COUNT(*) n FROM drivingEvents WHERE unitId = ?", [unitB.id]),
    };

    // T18 — every telemetry feed naming B's unit number: rejected, nothing written to B.
    await expect(mA.inbound.ingest({ feed: "vehicle_telemetry", idempotencyKey: `t-${rnd()}`, payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: unitB.unitNumber, odometerKm: 1 } })).resolves.toMatchObject({ status: "rejected" });
    await expect(mA.inbound.ingest({ feed: "fault_code", idempotencyKey: `f-${rnd()}`, payload: { code: "SPN-100", protocol: "j1939", seenAt: "2026-09-10T08:00:00Z", unitRef: unitB.unitNumber } })).resolves.toMatchObject({ status: "rejected" });
    await expect(mA.inbound.ingest({ feed: "safety_event", idempotencyKey: `e-${rnd()}`, payload: { kind: "harsh_brake", recordedAt: "2026-09-10T08:00:00Z", unitRef: unitB.unitNumber } })).resolves.toMatchObject({ status: "rejected" });
    // T19 — a clip for B's event, by reference, from A's client: rejected; B's event keeps no clip.
    await expect(mA.inbound.ingest({ feed: "video_clip", idempotencyKey: `v-${rnd()}`, payload: { clipRef: "cam/1", clipHash: "b".repeat(64), eventRef: evB } })).resolves.toMatchObject({ status: "rejected" });
    expect(await count("SELECT COUNT(*) n FROM telemetrySnapshots WHERE unitId = ?", [unitB.id])).toBe(before.snaps);
    expect(await count("SELECT COUNT(*) n FROM faultCodes WHERE unitId = ?", [unitB.id])).toBe(before.faults);
    expect(await count("SELECT COUNT(*) n FROM drivingEvents WHERE unitId = ?", [unitB.id])).toBe(before.events);
    expect(await one("SELECT videoClipRef FROM drivingEvents WHERE eventRef = ?", [evB])).toEqual({ videoClipRef: null });

    // What A's client feeds for A's unit is A's: served to A, refused to B as not-found.
    await expect(mA.inbound.ingest({ feed: "vehicle_telemetry", idempotencyKey: `t-${rnd()}`, payload: { recordedAt: "2026-09-10T08:00:00Z", unitRef: unitA.unitNumber, odometerKm: 168_400 } })).resolves.toMatchObject({ status: "accepted" });
    await expect(callerFor(ctrlA).telematics.unit({ unitId: unitA.id })).resolves.toMatchObject({ latest: { odometerKm: 168_400 } });
    await expect(callerFor(dispB).telematics.unit({ unitId: unitA.id })).rejects.toMatchObject(unitNotFound(unitA.id));
  }, 60_000);

  it("TEL-T20 — a driver's position binds to an operator record the acting organization owns: an ex-member is refused, and a record another company owns is not the driver's here", async () => {
    const A = await org(), B = await org();
    const unitB = await unitOwnedBy(B);
    // Drove for B, left, now works for A — the operator record and the active trip are still B's.
    const person = seq++;
    await membership(person, B, { status: "ended", to: "2025-01-01" });
    await membership(person, A);
    await grant(person, ["driver"]);
    const opB = await operatorOwnedBy(B, person);
    const tripB = await trip(B, unitB.id, opB);
    const crumbsBefore = await count("SELECT COUNT(*) n FROM tripBreadcrumbs WHERE tripId = ?", [tripB]);
    await expect(callerFor(person).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await count("SELECT COUNT(*) n FROM tripBreadcrumbs WHERE tripId = ?", [tripB])).toBe(crumbsBefore);
    // An ex-member of B with B's operator record and B's live trip: refused at the scope step.
    const ex = seq++;
    await membership(ex, B, { status: "ended", from: "2020-01-01", to: "2025-01-01" });
    await grant(ex, ["driver"]);
    const opEx = await operatorOwnedBy(B, ex);
    const tripEx = await trip(B, unitB.id, opEx);
    await expect(callerFor(ex).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toMatchObject({ code: "FORBIDDEN", message: "No active organization membership" });
    expect(await count("SELECT COUNT(*) n FROM tripBreadcrumbs WHERE tripId = ?", [tripEx])).toBe(0);
    // Each layer alone. A's member whose operator record is B's, named by an A trip: the record is
    // not theirs here. A's member with A's record, named by a B trip: the trip is not reachable.
    const unitA = await unitOwnedBy(A);
    const recordIsBs = seq++;
    await membership(recordIsBs, A); await grant(recordIsBs, ["driver"]);
    const tripAnamingBsRecord = await trip(A, unitA.id, await operatorOwnedBy(B, recordIsBs));
    await expect(callerFor(recordIsBs).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await count("SELECT COUNT(*) n FROM tripBreadcrumbs WHERE tripId = ?", [tripAnamingBsRecord])).toBe(0);
    const tripIsBs = seq++;
    await membership(tripIsBs, A); await grant(tripIsBs, ["driver"]);
    const tripBnamingAsRecord = await trip(B, unitB.id, await operatorOwnedBy(A, tripIsBs));
    await expect(callerFor(tripIsBs).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await count("SELECT COUNT(*) n FROM tripBreadcrumbs WHERE tripId = ?", [tripBnamingAsRecord])).toBe(0);
    // The member of B whose record and trip are B's is served, and the position lands on B's trip.
    const driverB = await member(B, ["driver"]);
    const opDriverB = await operatorOwnedBy(B, driverB);
    const tripDriverB = await trip(B, unitB.id, opDriverB);
    const r = await callerFor(driverB).fieldRoute.gps.submitBreadcrumb({ latitude: 53.5, longitude: -113.4, recordedAt: new Date() });
    expect(await one("SELECT tripId FROM tripBreadcrumbs WHERE id = ?", [Number(r.breadcrumbId)])).toEqual({ tripId: tripDriverB });
  }, 60_000);
});
