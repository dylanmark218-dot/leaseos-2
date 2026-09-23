/**
 * 0170 — the canonical ELD event ledger, against a real database.
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

const URL = process.env.DATABASE_URL;

describe("ELD ledger — preconditions", () => {
  it("runs against a real database", () => {
    expect(URL, "DATABASE_URL must be set: a skipped ledger suite proves nothing").toBeTruthy();
  });
});

const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 830_000 + Math.floor(Math.random() * 40_000);
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

async function unitIn(ownerOrgRef: string | null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [key("U").slice(0, 30)]);
  const unitId = Number(r.insertId);
  if (ownerOrgRef) await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [ownerOrgRef, unitId]);
  return unitId;
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

const ev = (seq: number, o: Partial<EldEventInput> = {}): EldEventInput => ({
  eventRef: randomUUID(), deviceSequence: seq, eventType: "duty_status_change", dutyStatus: "on_duty", recordOrigin: "driver",
  eventAt: `2026-09-11T14:${String(seq % 60).padStart(2, "0")}:00.000Z`, previousEventHash: null, ...o,
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
    const e = ev(0, { unitId: await unitIn(s.orgRef), latitude: 53.5, longitude: -113.5, locationSource: "gps", odometerKm: 120_450.5 });
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
    for (const extra of [{ operatorName: "Somebody Else" }, { operatorRef: "Somebody Else" }, { operatorId: 999_999 }]) {
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
    const r1 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitId: foreign })]));
    expect(r1.state === "refused" && r1.code).toBe("unit_not_in_organization");
    const r2 = await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitId: 99_999_999 })]));
    expect(r2.state === "refused" && r2.code).toBe("unit_unknown");
    const own = await unitIn(s.orgRef);
    const r3 = accepted(await callerFor(s.userId).eld.eventsAppend(signedBatch(s, [ev(0, { unitId: own })])));
    expect(r3.counts.inserted).toBe(1);
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
    const good = ev(0), bad = { ...ev(1), eventAt: "not a time" };
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
