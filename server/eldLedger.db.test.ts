/**
 * 0220 — the canonical ELD event ledger, against a real database.
 *
 * Every case goes through the production door: `device.enroll` + `device.activate` for identity,
 * `eld.eventsAppend` with a real P-256 signature for the push, raw SQL only to inspect rows and to
 * attempt the mutations the triggers must refuse. Nothing here reimplements the store.
 *
 * A skipped suite is a failure, not a pass: the precondition is asserted unconditionally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { appRouter } from "./routers";
import { getDb, grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { fingerprintP256Spki } from "./_core/deviceSignature";
import { canonicalEldBatch, hashEldEvent } from "./_core/eld/ledger";
import { appendEldEvents } from "./_core/eld/eldLedgerStore";
import type { EldEventInput } from "../shared/eld/eldEvent";
import { FlagConnectivity, MemoryKeystore, SettableClock } from "../client/src/runtime/adapters/memory";
import { canonicalEldBatchText, EldOutbox, MemoryEldEventStore, wireEvent, type EldAppendInput, type EldAppendResponse, type EldTransport } from "../client/src/runtime/eldOutbox";

const URL = process.env.DATABASE_URL;

describe("ELD ledger — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped ledger suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 1_800_000 + Math.floor(Math.random() * 40_000);   // a band no other suite draws from (testIdBands.test.ts)
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
afterAll(async () => { if (pool) await pool.end(); });

/* ---- identity fixtures ---- */

type DeviceKey = { spki: string; fingerprint: string; pem: string };
function deviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, fingerprint: fingerprintP256Spki(spki), pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

async function org(): Promise<string> {
  const orgRef = key("org").slice(0, 40);
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `Org ${orgRef}`]);
  return orgRef;
}

async function userIn(orgRef: string, role: DomainRole) {
  const id = nextUser();
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [key("mem").slice(0, 60), orgRef, id]);
  return id;
}

async function operatorFor(userId: number, ownerOrgRef: string | null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, 'D. Reid', DATE_ADD(NOW(), INTERVAL 400 DAY))", [userId]);
  const operatorId = Number(r.insertId);
  if (ownerOrgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'operator', ?, 1)", [ownerOrgRef, operatorId]);
  return operatorId;
}

/** A unit, returned by the number a device would state; the id stays on the server. */
async function unitIn(ownerOrgRef: string | null) {
  const unitNumber = key("U").slice(0, 30);
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [unitNumber]);
  const unitId = Number(r.insertId);
  if (ownerOrgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [ownerOrgRef, unitId]);
  return { unitId, unitNumber };
}

/** An enrolled, activated device for `userId`, whose org is the user's acting scope. */
async function deviceFor(userId: number) {
  const k = deviceKey();
  const en = await callerFor(userId).device.enroll({ platform: "android", publicKeySpkiBase64: k.spki, keystoreAttestation: "hardware", encryptedStorageAttested: true });
  await callerFor(userId).device.activate({ deviceRef: en.deviceRef });
  return { deviceRef: en.deviceRef, k };
}

/** A driver in a fresh org, with an operator record owned by that org and one active device. */
async function driverScenario() {
  const orgRef = await org();
  const userId = await userIn(orgRef, "driver");
  const operatorId = await operatorFor(userId, orgRef);
  const dev = await deviceFor(userId);
  return { orgRef, userId, operatorId, ...dev };
}

/* ---- events and batches ---- */

const T0 = Date.UTC(2026, 8, 11, 14, 0, 0);
const ev = (seq: number, o: Partial<EldEventInput> = {}): EldEventInput => ({
  eventRef: randomUUID(), deviceSequence: seq, eventType: "duty_status_change", dutyStatus: "on_duty", recordOrigin: "driver",
  eventAtMs: T0 + seq * 60_000, previousEventHash: null, ...o,
});

function signedBatch(dev: { deviceRef: string; k: DeviceKey }, events: EldEventInput[], o: { claimFingerprint?: string; batchRef?: string } = {}) {
  const signedAt = new Date();
  const nonce = key("n").padEnd(24, "0");
  const batchRef = o.batchRef ?? key("ELDB");
  const payload = canonicalEldBatch({ deviceRef: dev.deviceRef, batchRef, signedAt, nonce, events });
  const signatureP1363Base64 = cryptoSign("sha256", payload, { key: createPrivateKey(dev.k.pem), dsaEncoding: "ieee-p1363" }).toString("base64");
  return { deviceRef: dev.deviceRef, signedWithFingerprint: o.claimFingerprint ?? dev.k.fingerprint, signedAt, nonce, signatureP1363Base64, batchRef, events };
}

const rowByRef = async (eventRef: string) => (await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM eldEvents WHERE eventRef = ?", [eventRef]))[0][0];
const countByRef = async (eventRef: string) => Number((await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents WHERE eventRef = ?", [eventRef]))[0][0].n);
const conflictsFor = async (canonicalEventRef: string) => (await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM eldEventIngestConflicts WHERE canonicalEventRef = ?", [canonicalEventRef]))[0];

type Accepted = Extract<Awaited<ReturnType<ReturnType<typeof callerFor>["eld"]["eventsAppend"]>>, { state: "accepted" }>;
const accepted = (r: Awaited<ReturnType<ReturnType<typeof callerFor>["eld"]["eventsAppend"]>>): Accepted => {
  expect(r.state, JSON.stringify(r)).toBe("accepted");
  return r as Accepted;
};

/* ================================================================== */

d("a device appends its own events, in its own organization", () => {
  it("records a valid event with the device's organization and the device user's operator, and the hash the device can recompute", async () => {
    const s = await driverScenario();
    const unit = await unitIn(s.orgRef);
    const e = ev(0, { unitNumber: unit.unitNumber, latitudeE7: 535000000, longitudeE7: -1135000000, locationAccuracyMm: 4200, locationSource: "gps", odometerM: 120_450_500, engineHoursMillis: 8_123_400, eventUtcOffsetMinutes: -360 });
    const r = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    expect(r.counts).toEqual({ inserted: 1, replayed: 0, conflict: 0 });
    expect(r.orgRef).toBe(s.orgRef);
    expect(r.operatorId).toBe(s.operatorId);
    const row = await rowByRef(e.eventRef);
    expect(row.orgRef).toBe(s.orgRef);
    expect(row.operatorId).toBe(s.operatorId);
    expect(Number(row.deviceSequence)).toBe(0);
    expect(row.sourceKind).toBe("field_device");
    expect(row.recordOrigin).toBe("driver");
    expect(row.dutyStatus).toBe("on_duty");
    // The unit was resolved from its number, and the fixed-scale integers became the derived columns.
    expect(row.unitId).toBe(unit.unitId);
    expect(row.latitude).toBeCloseTo(53.5, 9);
    expect(row.longitude).toBeCloseTo(-113.5, 9);
    expect(row.locationAccuracyM).toBeCloseTo(4.2, 9);
    expect(row.odometerKm).toBeCloseTo(120_450.5, 9);
    expect(row.engineHours).toBeCloseTo(8_123.4, 9);
    expect(new Date(row.eventAt).getTime()).toBe(T0);
    expect(row.eventUtcOffsetMinutes).toBe(-360);
    expect(row.fieldDeviceId).not.toBeNull();
    // Deterministic across the boundary: the device's own computation equals what the server stored.
    const local = hashEldEvent(s.deviceRef, e);
    expect(row.payloadHash).toBe(local.payloadHash);
    expect(row.eventHash).toBe(local.eventHash);
    expect(row.canonicalJson).toBe(local.canonicalJson);
    expect(row.hashVersion).toBe("eld-h1");
    expect(r.events[0]).toMatchObject({ outcome: "inserted", code: "inserted", eventHash: local.eventHash });
  });

  it("takes the organization from the enrolled device — a client cannot name one, at the envelope or in an event", async () => {
    const s = await driverScenario();
    // Envelope: the router's input is strict.
    await expect(callerFor(s.userId).eld.eventsAppend({ ...signedBatch(s, [ev(0)]), orgRef: "someone-else" } as never)).rejects.toThrow();
    // Event: the schema is strict, and the batch is refused whole with nothing written.
    const spiked = { ...ev(1), orgRef: "someone-else" } as unknown as EldEventInput;
    const r = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [spiked]));
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.code).toBe("schema_invalid");
    expect(await countByRef(spiked.eventRef)).toBe(0);
  });

  it("never reads a driver's name as identity: a payload that carries one is refused, and the operator is the device user's", async () => {
    const s = await driverScenario();
    for (const extra of [{ operatorName: "Somebody Else" }, { operatorRef: "Somebody Else" }, { operatorId: 999_999 }, { unitId: 1 }]) {
      const e = { ...ev(0), ...extra } as unknown as EldEventInput;
      const r = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e]));
      expect(r.state, JSON.stringify(extra)).toBe("refused");
      expect(r.state === "refused" && r.code).toBe("schema_invalid");
      expect(await countByRef(e.eventRef)).toBe(0);
    }
    const clean = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [clean])));
    expect((await rowByRef(clean.eventRef)).operatorId).toBe(s.operatorId);
  });

  it("refuses a device bound to another organization than the caller is acting for", async () => {
    const s = await driverScenario();
    const other = await org();
    // The user's membership moves to another organization; the device stays bound to the first.
    await pool.execute("UPDATE organizationMemberships SET orgRef = ? WHERE userId = ?", [other, s.userId]);
    await expect(callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0)]))).rejects.toThrow(/not bound to the active organization/);
  });

  it("refuses when the device user's operator record is owned by another organization", async () => {
    const orgRef = await org();
    const userId = await userIn(orgRef, "driver");
    await operatorFor(userId, await org());               // owned elsewhere
    const dev = await deviceFor(userId);
    const r = await callerFor(userId).eld.eventsAppend(signedBatch(dev, [ev(0)]));
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.code).toBe("operator_not_in_organization");
  });

  it("refuses a duty status from a device whose user has no operator record, and accepts a non-duty observation", async () => {
    const orgRef = await org();
    const userId = await userIn(orgRef, "driver");
    const dev = await deviceFor(userId);
    const duty = await callerFor(userId).eld.eventsAppend(signedBatch(dev, [ev(0)]));
    expect(duty.state === "refused" && duty.code).toBe("operator_unresolved");
    const power = accepted(await callerFor(userId).eld.eventsAppend(signedBatch(dev, [ev(0, { eventType: "engine_power_up", dutyStatus: null })])));
    expect(power.operatorId).toBeNull();
    expect(power.counts.inserted).toBe(1);
  });

  it("checks a stated unit against the organization rather than believing it", async () => {
    const s = await driverScenario();
    const foreign = await unitIn(await org());
    const r1 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitNumber: foreign.unitNumber })]));
    expect(r1.state === "refused" && r1.code).toBe("unit_not_in_organization");
    const r2 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitNumber: "NO-SUCH-UNIT" })]));
    expect(r2.state === "refused" && r2.code).toBe("unit_unknown");
    const own = await unitIn(s.orgRef);
    const r3 = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitNumber: own.unitNumber })])));
    expect(r3.counts.inserted).toBe(1);
    expect((await rowByRef(r3.events[0]!.eventRef)).unitId).toBe(own.unitId);
  });
});

d("the device is the identity, and it is looked up", () => {
  it("refuses an unknown device, a device enrolled to another user, a device not yet activated, and a bad signature", async () => {
    const s = await driverScenario();
    const stranger = { deviceRef: "DEV-NOBODY", k: s.k };
    const unknown = await callerFor(s.userId).eld.eventsAppend(signedBatch(stranger, [ev(0)]));
    expect(unknown.state === "refused" && unknown.reason).toMatch(/not enrolled/);

    // Another driver in the same organization cannot push through this device.
    const other = await userIn(s.orgRef, "driver");
    await operatorFor(other, s.orgRef);
    const notMine = await callerFor(other).eld.eventsAppend(signedBatch(s, [ev(0)]));
    expect(notMine.state === "refused" && notMine.reason).toMatch(/enrolled to another user/);

    // Enrolled but not activated.
    const k2 = deviceKey();
    const en = await callerFor(s.userId).device.enroll({ platform: "android", publicKeySpkiBase64: k2.spki, keystoreAttestation: "hardware", encryptedStorageAttested: true });
    const early = await callerFor(s.userId).eld.eventsAppend(signedBatch({ deviceRef: en.deviceRef, k: k2 }, [ev(0)]));
    expect(early.state === "refused" && early.reason).toMatch(/not yet activated/);

    // Signed with a key the device never held.
    const forged = signedBatch({ deviceRef: s.deviceRef, k: deviceKey() }, [ev(0)], { claimFingerprint: s.k.fingerprint });
    const bad = await callerFor(s.userId).eld.eventsAppend(forged);
    expect(bad.state === "refused" && bad.reason).toMatch(/Invalid device batch signature/);

    // Nothing above wrote a row.
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents WHERE orgRef = ?", [s.orgRef]);
    expect(Number(n[0].n)).toBe(0);
  });

  it("refuses a reused nonce", async () => {
    const s = await driverScenario();
    const b = signedBatch(s, [ev(0)]);
    accepted(await callerFor(s.userId).eld.eventsAppend(b));
    await expect(callerFor(s.userId).eld.eventsAppend(b)).rejects.toThrow(/nonce was already used/);
  });
});

d("idempotency and conflict", () => {
  it("exact UUID replay: a second delivery of the same event writes nothing and points at the record", async () => {
    const s = await driverScenario();
    const e = ev(0);
    const first = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    const again = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [{ ...e }])));
    expect(again.counts).toEqual({ inserted: 0, replayed: 1, conflict: 0 });
    expect(again.events[0]).toMatchObject({ outcome: "replayed", code: "replayed", eventId: first.events[0]!.eventId, eventHash: first.events[0]!.eventHash });
    expect(await countByRef(e.eventRef)).toBe(1);
    expect(await conflictsFor(e.eventRef)).toHaveLength(0);
  });

  it("UUID collision: different content under the same UUID leaves the record untouched and preserves the attempt", async () => {
    const s = await driverScenario();
    const e = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    const before = await rowByRef(e.eventRef);
    const altered = { ...e, dutyStatus: "driving" as const };
    const r = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [altered])));
    expect(r.counts).toEqual({ inserted: 0, replayed: 0, conflict: 1 });
    expect(r.events[0]).toMatchObject({ outcome: "conflict", code: "conflict_event_ref", eventId: before.id });
    expect(r.events[0]!.conflictRef).toMatch(/^ELDC-/);
    const after = await rowByRef(e.eventRef);
    expect(after).toEqual(before);                         // byte-for-byte the same row
    expect(await countByRef(e.eventRef)).toBe(1);
    const c = await conflictsFor(e.eventRef);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ collisionKind: "event_ref", canonicalEventId: before.id, canonicalEventHash: before.eventHash, attemptedEventRef: e.eventRef, orgRef: s.orgRef });
    expect(c[0].attemptedEventHash).toBe(hashEldEvent(s.deviceRef, altered).eventHash);
    expect(c[0].attemptedCanonicalJson).toBe(hashEldEvent(s.deviceRef, altered).canonicalJson);
  });

  it("exact (device, sequence) replay in a later delivery is idempotent", async () => {
    const s = await driverScenario();
    const e = ev(4);
    const first = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    const later = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e], { batchRef: key("RETRY") })));
    expect(later.counts.replayed).toBe(1);
    expect(later.events[0]!.eventId).toBe(first.events[0]!.eventId);
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents WHERE fieldDeviceId = (SELECT id FROM fieldDevices WHERE deviceRef = ?) AND deviceSequence = 4", [s.deviceRef]);
    expect(Number(n[0].n)).toBe(1);
  });

  it("(device, sequence) collision: a different event under the same sequence is preserved as a conflict, once, and the record stands", async () => {
    const s = await driverScenario();
    const e = ev(7);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    const before = await rowByRef(e.eventRef);
    const rival = ev(7, { dutyStatus: "off_duty" });      // new UUID, same sequence
    const r = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [rival])));
    expect(r.events[0]).toMatchObject({ outcome: "conflict", code: "conflict_device_sequence", eventId: before.id });
    expect(await countByRef(rival.eventRef)).toBe(0);
    expect(await rowByRef(e.eventRef)).toEqual(before);
    // The same conflicting copy sent again is the same evidence, not a second row.
    const r2 = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [rival])));
    expect(r2.events[0]!.conflictRef).toBe(r.events[0]!.conflictRef);
    const c = await conflictsFor(e.eventRef);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ collisionKind: "device_sequence", attemptedEventRef: rival.eventRef, attemptedDeviceSequence: 7 });
  });
});

d("a declared hash is compared, never believed", () => {
  it("accepts a correct declaration, refuses a wrong one, and refuses the true hash of other content", async () => {
    const s = await driverScenario();
    const e = ev(0);
    const mine = hashEldEvent(s.deviceRef, e).eventHash;
    const ok = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [{ ...e, declaredEventHash: mine }])));
    expect(ok.events[0]).toMatchObject({ outcome: "inserted", eventHash: mine });

    const forged = { ...ev(1), declaredEventHash: "a".repeat(64) };
    const r1 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [forged]));
    expect(r1.state === "refused" && r1.code).toBe("declared_hash_mismatch");
    expect(await countByRef(forged.eventRef)).toBe(0);

    // Content altered after the device hashed it: the declaration is the hash of what it meant to send.
    const meant = ev(2, { dutyStatus: "off_duty" });
    const altered = { ...meant, dutyStatus: "driving" as const, declaredEventHash: hashEldEvent(s.deviceRef, meant).eventHash };
    const r2 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [altered]));
    expect(r2.state === "refused" && r2.code).toBe("declared_hash_mismatch");
    expect(r2.state === "refused" && r2.problems[0]!.detail).toMatch(/device declared .* its bytes hash to/);
    expect(await countByRef(altered.eventRef)).toBe(0);
  });
});

d("conflict evidence is content evidence, not a counter", () => {
  it("records the first conflicting payload once, treats its exact repeat as the same evidence, and a different conflicting payload as new evidence", async () => {
    const s = await driverScenario();
    const e = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    const before = await rowByRef(e.eventRef);
    const conflictA = { ...e, dutyStatus: "driving" as const };
    const first = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [conflictA])));
    const again = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [conflictA])));
    const third = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [conflictA])));
    expect(first.events[0]!.conflictRef).toMatch(/^ELDC-/);
    expect(again.events[0]!.conflictRef).toBe(first.events[0]!.conflictRef);
    expect(third.events[0]!.conflictRef).toBe(first.events[0]!.conflictRef);
    expect(again.events[0]).toMatchObject({ outcome: "conflict", code: "conflict_event_ref", eventId: before.id });
    expect(await conflictsFor(e.eventRef)).toHaveLength(1);

    const conflictB = { ...e, dutyStatus: "sleeper_berth" as const };
    const other = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [conflictB])));
    expect(other.events[0]!.conflictRef).not.toBe(first.events[0]!.conflictRef);
    const rows = await conflictsFor(e.eventRef);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.attemptedEventHash).sort()).toEqual([hashEldEvent(s.deviceRef, conflictA).eventHash, hashEldEvent(s.deviceRef, conflictB).eventHash].sort());
    // Through all of it the canonical row did not move, and no row carries a count or a last-seen time.
    expect(await rowByRef(e.eventRef)).toEqual(before);
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(["attemptCount", "lastSeenAt"]));
  });
});

d("the ledger is append-only at the database", () => {
  it("refuses UPDATE and DELETE of a canonical event, and of a conflict row", async () => {
    const s = await driverScenario();
    const e = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e])));
    await expect(pool.execute("UPDATE eldEvents SET dutyStatus = 'driving' WHERE eventRef = ?", [e.eventRef])).rejects.toThrow(/append-only/);
    await expect(pool.execute("UPDATE eldEvents SET annotation = 'x' WHERE eventRef = ?", [e.eventRef])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM eldEvents WHERE eventRef = ?", [e.eventRef])).rejects.toThrow(/never deleted/);
    expect((await rowByRef(e.eventRef)).dutyStatus).toBe("on_duty");

    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [{ ...e, dutyStatus: "driving" }])));
    const [c] = await conflictsFor(e.eventRef);
    await expect(pool.execute("UPDATE eldEventIngestConflicts SET attemptedCanonicalJson = '{}' WHERE id = ?", [c.id])).rejects.toThrow(/never edited/);
    await expect(pool.execute("DELETE FROM eldEventIngestConflicts WHERE id = ?", [c.id])).rejects.toThrow(/never deleted/);
  });

  it("represents a correction as an additional event naming the original, which does not change", async () => {
    const s = await driverScenario();
    const original = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [original])));
    const before = await rowByRef(original.eventRef);
    const correction = ev(1, { eventType: "correction", dutyStatus: null, supersedesEventRef: original.eventRef, annotation: "started on duty at 13:45, not 14:00", previousEventHash: before.eventHash });
    const r = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [correction])));
    expect(r.counts.inserted).toBe(1);
    const c = await rowByRef(correction.eventRef);
    expect(c.supersedesEventRef).toBe(original.eventRef);
    expect(c.eventType).toBe("correction");
    expect(await rowByRef(original.eventRef)).toEqual(before);
    expect(r.integrity.verifiedLinks).toBe(1);
  });
});

d("offline delivery: order is reconstructed, gaps are reported, nothing is invented", () => {
  it("accepts a later sequence before its predecessor, then verifies the link when the predecessor arrives", async () => {
    const s = await driverScenario();
    const e0 = ev(0), h0 = hashEldEvent(s.deviceRef, e0);
    const e1 = ev(1, { previousEventHash: h0.eventHash }), h1 = hashEldEvent(s.deviceRef, e1);
    const e2 = ev(2, { previousEventHash: h1.eventHash });
    // Only the newest arrives first.
    const late = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e2])));
    expect(late.counts.inserted).toBe(1);
    expect(late.integrity.unverifiableLinks).toEqual([{ eventRef: e2.eventRef, deviceSequence: 2, declaredPreviousEventHash: h1.eventHash }]);
    expect(late.integrity.gaps).toEqual([]);                 // one row: nothing to be a gap yet
    // Then the rest, out of order inside the batch as well.
    const rest = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e1, e0])));
    expect(rest.counts.inserted).toBe(2);
    expect(rest.integrity).toMatchObject({ eventCount: 3, gaps: [], unverifiableLinks: [], chainMismatches: [], verifiedLinks: 2, lowestSequence: 0, highestSequence: 2 });
    // The stored claims are exactly what the device declared.
    expect((await rowByRef(e2.eventRef)).previousEventHash).toBe(h1.eventHash);
    expect((await rowByRef(e0.eventRef)).previousEventHash).toBeNull();
  });

  it("reports a sequence gap and a chain mismatch, and leaves both as they are", async () => {
    const s = await driverScenario();
    const e0 = ev(0), h0 = hashEldEvent(s.deviceRef, e0);
    const e1 = ev(1, { previousEventHash: h0.eventHash });
    const e3 = ev(3, { previousEventHash: "f".repeat(64) });
    const e4 = ev(4, { previousEventHash: "0".repeat(64) });   // disagrees with what e3 hashes to
    const r = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e0, e1, e3, e4])));
    expect(r.counts.inserted).toBe(4);
    expect(r.integrity.gaps).toEqual([{ from: 2, to: 2 }]);
    expect(r.integrity.unverifiableLinks.map(u => u.deviceSequence)).toEqual([3]);
    expect(r.integrity.chainMismatches).toEqual([{ eventRef: e4.eventRef, deviceSequence: 4, declaredPreviousEventHash: "0".repeat(64), predecessorEventHash: hashEldEvent(s.deviceRef, e3).eventHash }]);
    expect(r.integrity.verifiedLinks).toBe(1);
    // Nothing was manufactured for sequence 2.
    const [n] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents WHERE fieldDeviceId = (SELECT id FROM fieldDevices WHERE deviceRef = ?)", [s.deviceRef]);
    expect(Number(n[0].n)).toBe(4);
    // The office reads the same picture; another organization's office reads nothing.
    const safety = await userIn(s.orgRef, "safety");
    const view = await callerFor(safety).eld.deviceIntegrity({ deviceRef: s.deviceRef });
    expect(view.gaps).toEqual([{ from: 2, to: 2 }]);
    const elsewhere = await userIn(await org(), "safety");
    await expect(callerFor(elsewhere).eld.deviceIntegrity({ deviceRef: s.deviceRef })).rejects.toThrow(/not found/);
  });
});

d("a batch is one transaction", () => {
  it("writes nothing when one event in the batch is malformed", async () => {
    const s = await driverScenario();
    const good = ev(0), bad = { ...ev(1), eventAtMs: 2_147_483_647_001 };   // past the storable range: refused before any write, never a failed insert
    const r = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [good, bad]));
    expect(r.state === "refused" && r.code).toBe("schema_invalid");
    expect(r.state === "refused" && r.problems.map(p => p.eventRef)).toEqual([bad.eventRef]);
    expect(await countByRef(good.eventRef)).toBe(0);
  });

  it("rolls back every canonical row and every conflict row when the transaction fails after the writes", async () => {
    const s = await driverScenario();
    const db = (await getDb())!;
    const [device] = (await pool.execute<mysql.RowDataPacket[]>("SELECT id, deviceRef, userId, orgRef, status FROM fieldDevices WHERE deviceRef = ?", [s.deviceRef]))[0];
    const existing = ev(0);
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [existing])));
    const fresh = ev(1), rival = { ...existing, dutyStatus: "sleeper_berth" as const };
    let seen = 0;
    await expect(appendEldEvents(db, {
      device: { id: device.id, deviceRef: device.deviceRef, userId: device.userId, orgRef: device.orgRef, status: device.status },
      claimedUserId: s.userId, events: [fresh, rival], receivedAt: new Date(), sourceRef: "TEST",
      withinTransaction: async (_tx, written) => { seen = written.length; throw new Error("downstream refused"); },
    })).rejects.toThrow(/downstream refused/);
    expect(seen).toBe(1);                                    // the row WAS written inside the transaction …
    expect(await countByRef(fresh.eventRef)).toBe(0);        // … and is gone with it
    expect(await conflictsFor(existing.eventRef)).toHaveLength(0);
    expect(await countByRef(existing.eventRef)).toBe(1);     // the earlier record is unaffected
  });
});

/* ================================================================== */
/* ELD checkpoint 2b — hours of service read from the ledger           */
/* ================================================================== */

d("eld.hosStatus reads hours from the ledger, and only the caller's own unless the office asks", () => {
  const MIN = 60_000;
  const AT = new Date(T0 + 150 * MIN);

  it("counts a driver's own clocks from the events the device pushed, and answers UNKNOWN with the reason", async () => {
    const s = await driverScenario();
    const e0 = ev(0, { eventAtMs: T0, dutyStatus: "on_duty" });
    const e1 = ev(1, { eventAtMs: T0 + 30 * MIN, dutyStatus: "driving" });
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e0, e1])));
    const before = Number((await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents"))[0][0].n);

    const r = await callerFor(s.userId).eld.hosStatus({ at: AT });
    expect(r.operatorId).toBe(s.operatorId);
    expect(r.engineVersion).toBe("hos-engine/2c");
    expect(r.projection.entryEventRefs).toEqual([e0.eventRef, e1.eventRef]);
    // Hand-computed: on duty 14:00, driving 14:30, read at 16:30.
    expect(r.clocks).toMatchObject({ shiftOnDutyMinutes: 150, shiftDriveMinutes: 120, continuousDriveMinutes: 120, currentStatus: "driving", currentStatusMinutes: 120 });
    // No operating context was stated, so no schedule is selected and nothing is determined.
    expect(r.verdict).toBe("unknown");
    expect(r.reasonCodes).toEqual(expect.arrayContaining(["HOS_PROFILE_UNKNOWN", "HOS_MECHANICS_DEFAULTED", "HOS_TIMEZONE_UNKNOWN", "HOS_OPEN_STATUS"]));
    expect(r.remaining).toEqual({ drivingMinutes: null, onDutyMinutes: null, shiftWindowMinutes: null, cycleMinutes: null, basisRuleIds: [] });
    expect(r.window.rowsRead).toBe(2);
    // A read writes nothing.
    expect(Number((await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM eldEvents"))[0][0].n)).toBe(before);
  });

  it("applies a correction pushed by the device as a retraction, with the replacement status the device recorded", async () => {
    const s = await driverScenario();
    const e0 = ev(0, { eventAtMs: T0, dutyStatus: "on_duty" });
    const e1 = ev(1, { eventAtMs: T0 + 30 * MIN, dutyStatus: "driving" });
    const c = ev(2, { eventAtMs: T0 + 40 * MIN, eventType: "correction", dutyStatus: null, supersedesEventRef: e1.eventRef, annotation: "was on duty, not driving" });
    const replacement = ev(3, { eventAtMs: T0 + 30 * MIN, dutyStatus: "on_duty" });
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [e0, e1, c, replacement])));

    const r = await callerFor(s.userId).eld.hosStatus({ at: AT });
    expect(r.projection.supersededEventRefs).toEqual([e1.eventRef]);
    expect(r.projection.correctionsApplied).toEqual([{ correctionEventRef: c.eventRef, supersedesEventRef: e1.eventRef }]);
    expect(r.projection.entryEventRefs).toEqual([e0.eventRef, replacement.eventRef]);
    expect(r.clocks).toMatchObject({ continuousDriveMinutes: 0, shiftDriveMinutes: 0, currentStatus: "on_duty" });
    expect(r.reasonCodes).toContain("HOS_CORRECTION_APPLIED");
    // The original is still on the ledger, unchanged.
    expect((await rowByRef(e1.eventRef)).dutyStatus).toBe("driving");
  });

  it("counts a status that was already running when the window opened, from the window's start", async () => {
    const s = await driverScenario();
    const longOff = ev(0, { eventAtMs: T0 - 20 * 86_400_000, dutyStatus: "off_duty" });
    const onDuty = ev(1, { eventAtMs: T0, dutyStatus: "on_duty" });
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [longOff, onDuty])));
    const r = await callerFor(s.userId).eld.hosStatus({ at: new Date(T0 + 60 * MIN), lookbackDays: 1 });
    expect(r.projection.entryEventRefs).toEqual([longOff.eventRef, onDuty.eventRef]);
    // Trailing 24 hours from 15:00: off duty 15:00 the day before until 14:00 = 23 hours.
    expect(r.clocks.dailyOffDutyMinutes).toBe(23 * 60);
    expect(r.clocks.dailyOnDutyMinutes).toBe(60);
  });

  it("flags a sequence gap in the device's chain that falls inside the window", async () => {
    const s = await driverScenario();
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [
      ev(0, { eventAtMs: T0, dutyStatus: "on_duty" }), ev(1, { eventAtMs: T0 + 10 * MIN, dutyStatus: "driving" }), ev(3, { eventAtMs: T0 + 60 * MIN, dutyStatus: "on_duty" }),
    ])));
    const r = await callerFor(s.userId).eld.hosStatus({ at: AT });
    expect(r.window.chainGaps).toEqual([expect.objectContaining({ fromSequence: 2, toSequence: 2, fromAt: new Date(T0 + 10 * MIN), toAt: new Date(T0 + 60 * MIN) })]);
    expect(r.reasonCodes).toContain("HOS_DATA_GAP");
  });

  it("lets the office read any operator in its organization, refuses a colleague without eld.read, and hides other organizations", async () => {
    const s = await driverScenario();
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { eventAtMs: T0, dutyStatus: "on_duty" })])));

    const safety = await userIn(s.orgRef, "safety");
    const read = await callerFor(safety).eld.hosStatus({ operatorId: s.operatorId, at: AT });
    expect(read.operatorId).toBe(s.operatorId);
    expect(read.window.rowsRead).toBe(1);

    const colleague = await userIn(s.orgRef, "driver");
    await operatorFor(colleague, s.orgRef);
    await expect(callerFor(colleague).eld.hosStatus({ operatorId: s.operatorId, at: AT })).rejects.toThrow(/needs eld\.read/);

    const elsewhere = await userIn(await org(), "safety");
    await expect(callerFor(elsewhere).eld.hosStatus({ operatorId: s.operatorId, at: AT })).rejects.toThrow(/not found/);
  });

  it("refuses rather than guesses when the caller has no operator record and names none", async () => {
    const orgRef = await org();
    const office = await userIn(orgRef, "office");
    await expect(callerFor(office).eld.hosStatus({ at: AT })).rejects.toThrow(/No operator record/);
  });

  it("takes no organization or device from the caller", async () => {
    const s = await driverScenario();
    await expect(callerFor(s.userId).eld.hosStatus({ at: AT, orgRef: "elsewhere" } as never)).rejects.toThrow();
  });
});

/* ================================================================== */
/* ELD checkpoint 2c — the designated duty day                         */
/* ================================================================== */

d("eld.dutyDayDesignate records where a duty day begins, as history that is only ever extended", () => {
  const MIN = 60_000;
  const designationRow = async (ref: string) => (await pool.execute<mysql.RowDataPacket[]>("SELECT * FROM eldDutyDayDesignations WHERE designationRef = ?", [ref]))[0][0];

  it("records a designation under the database's own zone name and version, and keeps it immutable", async () => {
    const s = await driverScenario();
    const safety = await userIn(s.orgRef, "safety");
    const r = await callerFor(safety).eld.dutyDayDesignate({ operatorId: s.operatorId, timezone: "america/regina", dayStartMinutes: 360, reason: "Home terminal: Regina yard" });
    expect(r).toMatchObject({ orgRef: s.orgRef, operatorId: s.operatorId, timezone: "America/Regina", dayStartMinutes: 360, tzVersion: "2026c", recordedByUserId: safety, reason: "Home terminal: Regina yard" });
    expect(r.designationRef).toMatch(/^ELDDD-/);
    expect(r.effectiveFrom.getTime()).toBe(r.recordedAt.getTime());          // omitted means "from now", by the server's clock

    await expect(pool.execute("UPDATE eldDutyDayDesignations SET dayStartMinutes = 0 WHERE designationRef = ?", [r.designationRef])).rejects.toThrow(/history/);
    await expect(pool.execute("DELETE FROM eldDutyDayDesignations WHERE designationRef = ?", [r.designationRef])).rejects.toThrow(/never deleted/);
    expect((await designationRow(r.designationRef)).dayStartMinutes).toBe(360);
    await expect(pool.execute("INSERT INTO eldDutyDayDesignations (designationRef, orgRef, operatorId, timezone, dayStartMinutes, effectiveFrom, reason, recordedByUserId, recordedAt) VALUES (?,?,?,?,1440,NOW(3),'x',1,NOW(3))",
      [key("ELDDD").slice(0, 60), s.orgRef, s.operatorId, "America/Regina"])).rejects.toThrow(/start_range|CONSTRAINT/i);
  });

  it("refuses a backdated designation, one not after the latest, an unknown zone and a fixed offset", async () => {
    const s = await driverScenario();
    const safety = await userIn(s.orgRef, "safety");
    const base = { operatorId: s.operatorId, timezone: "America/Regina", dayStartMinutes: 0, reason: "terminal" };
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, effectiveFrom: new Date(Date.now() - 60 * MIN) })).rejects.toThrow(/backdated/);
    await callerFor(safety).eld.dutyDayDesignate({ ...base, effectiveFrom: new Date(Date.now() + 86_400_000) });
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, effectiveFrom: new Date(Date.now() + 60 * MIN) })).rejects.toThrow(/not_after_latest/);
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, timezone: "Mars/Olympus_Mons" })).rejects.toThrow(/timezone_unknown/);
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, timezone: "+05:00" })).rejects.toThrow(/timezone_unknown/);
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, dayStartMinutes: 1440 })).rejects.toThrow();
    await expect(callerFor(safety).eld.dutyDayDesignate({ ...base, reason: "   " })).rejects.toThrow();
    const history = await callerFor(safety).eld.dutyDayHistory({ operatorId: s.operatorId });
    expect(history).toHaveLength(1);
  });

  it("is safety's or management's to record, the office's to read, and invisible across organizations", async () => {
    const s = await driverScenario();
    const base = { operatorId: s.operatorId, timezone: "America/Regina", dayStartMinutes: 0, reason: "terminal" };
    await expect(callerFor(s.userId).eld.dutyDayDesignate(base)).rejects.toThrow(/grants eld\.dutyday\.designate/);
    await expect(callerFor(await userIn(s.orgRef, "dispatcher")).eld.dutyDayDesignate(base)).rejects.toThrow(/grants eld\.dutyday\.designate/);
    const mgmt = await userIn(s.orgRef, "management");
    await callerFor(mgmt).eld.dutyDayDesignate(base);
    expect(await callerFor(await userIn(s.orgRef, "dispatcher")).eld.dutyDayHistory({ operatorId: s.operatorId })).toHaveLength(1);
    await expect(callerFor(s.userId).eld.dutyDayHistory({ operatorId: s.operatorId })).rejects.toThrow(/grants eld\.read/);

    const elsewhere = await userIn(await org(), "safety");
    await expect(callerFor(elsewhere).eld.dutyDayDesignate(base)).rejects.toThrow(/not found/i);
    await expect(callerFor(elsewhere).eld.dutyDayHistory({ operatorId: s.operatorId })).rejects.toThrow(/not found/i);
    await expect(callerFor(mgmt).eld.dutyDayHistory({ operatorId: 2_000_000_000 })).rejects.toThrow(/not found/i);
    await expect(callerFor(mgmt).eld.dutyDayDesignate({ ...base, orgRef: "elsewhere" } as never)).rejects.toThrow();
  });

  it("reaches eld.hosStatus: the day's clocks are shown, the designation is named, and the daily answer stays UNKNOWN", async () => {
    const s = await driverScenario();
    // A Regina day (UTC−06:00 all year) chosen to have begun three whole minutes-aligned hours ago,
    // so the expected clocks are literals whatever time the suite runs.
    const dayStart = Math.floor(Date.now() / MIN) * MIN - 180 * MIN;
    const startLocalMinutes = ((Math.floor(dayStart / MIN) % 1440) - 360 + 1440) % 1440;
    const safety = await userIn(s.orgRef, "safety");
    const des = await callerFor(safety).eld.dutyDayDesignate({ operatorId: s.operatorId, timezone: "America/Regina", dayStartMinutes: startLocalMinutes, reason: "Regina yard" });
    accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [
      ev(0, { eventAtMs: dayStart - 30 * MIN, dutyStatus: "on_duty" }),
      ev(1, { eventAtMs: dayStart + 60 * MIN, dutyStatus: "driving" }),
    ])));
    const at = new Date(dayStart + 200 * MIN);                                // after the designation took effect
    const r = await callerFor(s.userId).eld.hosStatus({ at });
    expect(r.engineVersion).toBe("hos-engine/2c");
    expect(r.dutyDay).toMatchObject({ designationRef: des.designationRef, drivingMinutes: 140, onDutyMinutes: 200, offDutyMinutes: 0, sleeperMinutes: 0, unrecordedMinutes: 0, designationChangedDuringDay: true });
    expect(r.dutyDay!.window).toMatchObject({ timezone: "America/Regina", dayStartMinutes: startLocalMinutes, lengthMinutes: 1440 });
    expect(r.dutyDay!.window.from.getTime()).toBe(dayStart);
    expect(r.reasonCodes).not.toContain("HOS_TIMEZONE_UNKNOWN");
    expect(r.verdict).toBe("unknown");

    // Before the designation took effect there was no designated day, and there still is not.
    const earlier = await callerFor(s.userId).eld.hosStatus({ at: new Date(dayStart + 60 * MIN) });
    expect(earlier.dutyDay).toBeNull();
    expect(earlier.reasonCodes).toContain("HOS_TIMEZONE_UNKNOWN");
  });

  it("uses the designation in force at the instant asked about, so a later one never rewrites an earlier answer", async () => {
    const s = await driverScenario();
    const safety = await userIn(s.orgRef, "safety");
    const first = await callerFor(safety).eld.dutyDayDesignate({ operatorId: s.operatorId, timezone: "America/Regina", dayStartMinutes: 0, reason: "Regina yard" });
    const second = await callerFor(safety).eld.dutyDayDesignate({ operatorId: s.operatorId, timezone: "America/Winnipeg", dayStartMinutes: 300, effectiveFrom: new Date(Date.now() + 2 * 86_400_000), reason: "Moved to the Winnipeg terminal" });
    const inFirst = await callerFor(s.userId).eld.hosStatus({ at: new Date(Date.now() + 86_400_000) });
    const inSecond = await callerFor(s.userId).eld.hosStatus({ at: new Date(Date.now() + 3 * 86_400_000) });
    expect(inFirst.dutyDay).toMatchObject({ designationRef: first.designationRef, window: expect.objectContaining({ timezone: "America/Regina" }) });
    expect(inSecond.dutyDay).toMatchObject({ designationRef: second.designationRef, window: expect.objectContaining({ timezone: "America/Winnipeg", dayStartMinutes: 300 }) });
    expect((await callerFor(safety).eld.dutyDayHistory({ operatorId: s.operatorId })).map(h => h.designationRef)).toEqual([first.designationRef, second.designationRef]);
  });
});

/* ================================================================== */
/* ELD checkpoint 2d — the device outbox against the real ledger       */
/* ================================================================== */

d("the device ELD outbox delivers to the real ledger", () => {
  const MIN = 60_000;

  /** A device as the field runtime holds it: its own keystore, enrolled and activated through the production procedures. */
  async function outboxFor(userId: number, o: { online?: boolean; sendAs?: number } = {}) {
    const clock = new SettableClock(new Date());
    const keystore = new MemoryKeystore(clock, "hardware");
    const en = await callerFor(userId).device.enroll({ platform: "android", publicKeySpkiBase64: await keystore.publicKeySpkiBase64(), keystoreAttestation: "hardware", encryptedStorageAttested: true });
    await callerFor(userId).device.activate({ deviceRef: en.deviceRef });
    const store = new MemoryEldEventStore();
    const connectivity = new FlagConnectivity(o.online ?? true);
    const sent: EldAppendInput[] = [];
    let dropAnswer = false;
    const transport: EldTransport = {
      async eventsAppend(input) {
        sent.push(input);
        const r = await callerFor(o.sendAs ?? userId).eld.eventsAppend(input);
        if (dropAnswer) { dropAnswer = false; throw new TypeError("connection reset after the server answered"); }
        return r as EldAppendResponse;
      },
    };
    const outbox = new EldOutbox({ store, keystore, transport, connectivity, clock, deviceRef: async () => en.deviceRef, session: () => ({ orgKey: "acting", userId }), utcOffsetMinutes: () => -360 });
    // Events are observed at fixed times; the clock is put back to real time to sign, as a device does when signal returns.
    const at = (iso: string) => clock.set(new Date(iso));
    const signNow = () => clock.set(new Date());
    return { deviceRef: en.deviceRef, keystore, store, outbox, connectivity, clock, sent, at, signNow, loseNextAnswer: () => { dropAnswer = true; } };
  }

  it("an event recorded offline hours earlier reaches the ledger with the device's time, the device user's operator and the device's organization", async () => {
    const s = await driverScenario();
    // Another operator with the same name in the same organization: a name is never identity.
    await operatorFor(await userIn(s.orgRef, "driver"), s.orgRef);
    const dev = await outboxFor(s.userId, { online: false });
    dev.at("2026-09-11T05:59:00.000Z");
    const before = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "late-1" });
    dev.at("2026-09-11T06:01:00.000Z");
    const after = await dev.outbox.recordDutyStatus({ status: "off_duty", actionKey: "late-2" });
    dev.signNow(); dev.connectivity.isOnline = true;
    expect(await dev.outbox.flush()).toMatchObject({ sent: 2, accepted: 2 });
    const row = await rowByRef(before.event.eventRef);
    expect(row).toMatchObject({ orgRef: s.orgRef, operatorId: s.operatorId, eventHash: before.eventHash, payloadHash: before.payloadHash, deviceSequence: 0, dutyStatus: "on_duty", eventUtcOffsetMinutes: -360 });
    expect(new Date(row.eventAt).toISOString()).toBe("2026-09-11T05:59:00.000Z");
    expect(new Date(row.receivedAt).getTime()).toBeGreaterThan(Date.parse("2026-09-11T06:01:00.000Z"));
    expect((await rowByRef(after.event.eventRef)).previousEventHash).toBe(before.eventHash);
    expect(await dev.outbox.delivery(after.event.eventRef)).toMatchObject({ state: "acknowledged", outcome: "accepted", serverEventId: Number((await rowByRef(after.event.eventRef)).id) });
  });

  it("a lost acknowledgement and a retry leave exactly one canonical row, acknowledged as IDEMPOTENT", async () => {
    const s = await driverScenario();
    const dev = await outboxFor(s.userId);
    dev.at("2026-09-11T14:00:00.000Z");
    const e = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "ack-1" });
    dev.signNow(); dev.loseNextAnswer();
    expect(await dev.outbox.flush()).toMatchObject({ requeued: 1 });
    expect(await countByRef(e.event.eventRef)).toBe(1);
    dev.signNow();
    expect(await dev.outbox.flush({ ignoreBackoff: true })).toMatchObject({ idempotent: 1 });
    expect(await dev.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "acknowledged", outcome: "idempotent", code: "replayed" });
    expect(await countByRef(e.event.eventRef)).toBe(1);
    expect(dev.sent[1]!.events).toEqual(dev.sent[0]!.events);
  });

  it("event 1 may reach the server before event 0, and the chain verifies once both are there", async () => {
    const s = await driverScenario();
    const dev = await outboxFor(s.userId, { online: false });
    dev.at("2026-09-11T14:00:00.000Z");
    const e0 = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "o0" });
    dev.at("2026-09-11T14:30:00.000Z");
    const e1 = await dev.outbox.recordDutyStatus({ status: "off_duty", actionKey: "o1" });
    // Event 1 alone, signed by the same device key, arrives first.
    const signedAt = new Date(); const nonce = key("n").padEnd(24, "0"); const batchRef = key("ELDB");
    const events = [wireEvent(e1)];
    const signatureP1363Base64 = await dev.keystore.signP1363(new TextEncoder().encode(canonicalEldBatchText({ deviceRef: dev.deviceRef, batchRef, signedAt, nonce, events })));
    accepted(await callerFor(s.userId).eld.eventsAppend({ deviceRef: dev.deviceRef, signedWithFingerprint: await dev.keystore.fingerprint(), signedAt, nonce, signatureP1363Base64, batchRef, events }));
    expect((await callerFor(await userIn(s.orgRef, "safety")).eld.deviceIntegrity({ deviceRef: dev.deviceRef })).unverifiableLinks).toHaveLength(1);
    dev.signNow(); dev.connectivity.isOnline = true;
    expect(await dev.outbox.flush()).toMatchObject({ accepted: 1, idempotent: 1 });
    expect(await callerFor(await userIn(s.orgRef, "safety")).eld.deviceIntegrity({ deviceRef: dev.deviceRef })).toMatchObject({ verifiedLinks: 1, unverifiableLinks: [], chainMismatches: [], gaps: [] });
    expect(await countByRef(e0.event.eventRef)).toBe(1);
  });

  it("a clock set back on the device keeps the sequence, and the ledger reports the regression as observed", async () => {
    const s = await driverScenario();
    const dev = await outboxFor(s.userId, { online: false });
    dev.at("2026-09-11T14:00:00.000Z");
    await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "cr-a" });
    dev.at("2026-09-11T13:00:00.000Z");
    const b = await dev.outbox.recordDutyStatus({ status: "off_duty", actionKey: "cr-b" });
    dev.signNow(); dev.connectivity.isOnline = true;
    expect(await dev.outbox.flush()).toMatchObject({ accepted: 2 });
    const integrity = await callerFor(await userIn(s.orgRef, "safety")).eld.deviceIntegrity({ deviceRef: dev.deviceRef });
    expect(integrity.timingInconsistencies).toEqual([expect.objectContaining({ eventRef: b.event.eventRef, deviceSequence: 1 })]);
    expect(integrity.verifiedLinks).toBe(1);
  });

  it("a unit owned by another organization rejects only the event that named it; the others are resent and accepted", async () => {
    const s = await driverScenario();
    const foreign = await unitIn(await org());
    const own = await unitIn(s.orgRef);
    const dev = await outboxFor(s.userId);
    dev.at("2026-09-11T14:00:00.000Z");
    const good = await dev.outbox.record({ eventType: "duty_status_change", recordOrigin: "driver", dutyStatus: "on_duty", unitNumber: own.unitNumber, actionKey: "un-1" });
    const bad = await dev.outbox.record({ eventType: "duty_status_change", recordOrigin: "driver", dutyStatus: "off_duty", unitNumber: foreign.unitNumber, actionKey: "un-2" });
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ rejected: 1, requeued: 1 });
    expect(await dev.outbox.delivery(bad.event.eventRef)).toMatchObject({ state: "rejected", code: "unit_not_in_organization" });
    expect(await countByRef(good.event.eventRef)).toBe(0);                       // nothing in a refused batch is written
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ accepted: 1 });
    expect((await rowByRef(good.event.eventRef)).unitId).toBe(own.unitId);
    expect(await countByRef(bad.event.eventRef)).toBe(0);
    expect(await dev.store.getEvent(bad.event.eventRef)).toEqual(bad);
  });

  it("an ambiguous operator fails closed: every event rejected with operator_ambiguous, none deleted, none written", async () => {
    const s = await driverScenario();
    await operatorFor(s.userId, s.orgRef);                                         // a second operator record for the same user
    const dev = await outboxFor(s.userId);
    dev.at("2026-09-11T14:00:00.000Z");
    const e = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "amb" });
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ rejected: 1 });
    expect(await dev.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "rejected", code: "operator_ambiguous" });
    expect(await countByRef(e.event.eventRef)).toBe(0);
    expect(await dev.store.getEvent(e.event.eventRef)).toEqual(e);
  });

  it("a device used by another signed-in user is refused, and the event is kept", async () => {
    const s = await driverScenario();
    const colleague = await userIn(s.orgRef, "driver");
    await operatorFor(colleague, s.orgRef);
    const dev = await outboxFor(s.userId, { sendAs: colleague });
    dev.at("2026-09-11T14:00:00.000Z");
    const e = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "who" });
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ rejected: 1 });
    expect((await dev.outbox.delivery(e.event.eventRef)).state).toBe("rejected");
    expect(await countByRef(e.event.eventRef)).toBe(0);
  });

  it("a device bound to one organization cannot deliver into another: refused, kept, releasable later", async () => {
    const s = await driverScenario();
    const dev = await outboxFor(s.userId);
    dev.at("2026-09-11T14:00:00.000Z");
    const e = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "org" });
    const other = await org();
    await pool.execute("UPDATE organizationMemberships SET orgRef = ? WHERE userId = ?", [other, s.userId]);
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ rejected: 1 });
    expect(await dev.outbox.delivery(e.event.eventRef)).toMatchObject({ state: "rejected", code: "server_forbidden" });
    expect(await countByRef(e.event.eventRef)).toBe(0);
    await pool.execute("UPDATE organizationMemberships SET orgRef = ? WHERE userId = ?", [s.orgRef, s.userId]);
    await dev.outbox.requeue(e.event.eventRef);
    dev.signNow();
    expect(await dev.outbox.flush()).toMatchObject({ accepted: 1 });
    expect((await rowByRef(e.event.eventRef)).orgRef).toBe(s.orgRef);
  });

  it("an organization or operator written into an event is refused by the strict schema, signature and all", async () => {
    const s = await driverScenario();
    const dev = await outboxFor(s.userId);
    dev.at("2026-09-11T14:00:00.000Z");
    const e = await dev.outbox.recordDutyStatus({ status: "on_duty", actionKey: "spoof" });
    const send = async (events: unknown[], extra: Record<string, unknown> = {}) => {
      const signedAt = new Date(); const nonce = key("n").padEnd(24, "0"); const batchRef = key("ELDB");
      const signatureP1363Base64 = await dev.keystore.signP1363(new TextEncoder().encode(canonicalEldBatchText({ deviceRef: dev.deviceRef, batchRef, signedAt, nonce, events: events as never })));
      return callerFor(s.userId).eld.eventsAppend({ deviceRef: dev.deviceRef, signedWithFingerprint: await dev.keystore.fingerprint(), signedAt, nonce, signatureP1363Base64, batchRef, events, ...extra } as never);
    };
    const tenant = await send([{ ...wireEvent(e), orgRef: await org() }]);
    expect(tenant).toMatchObject({ state: "refused", code: "schema_invalid" });
    const operator = await send([{ ...wireEvent(e), operatorId: 1 }]);
    expect(operator).toMatchObject({ state: "refused", code: "schema_invalid" });
    await expect(send([wireEvent(e)], { orgRef: await org() })).rejects.toThrow();
    expect(await countByRef(e.event.eventRef)).toBe(0);
  });
});
