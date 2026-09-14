import { beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";

// v21.6 — the server now computes an evidence hash from the bytes in storage,
// never from the device's word for it. The object store is remote, so these
// scenarios keep bytes in memory and the pushes below refer to real uploads.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import {
  admitPackage, detectConflict, planStoragePressure, roadsidePackagePermits,
  verifyPackageItems, KEY_ROTATION_GRACE_HOURS, type FieldDeviceRecord, type KeyEvent, type LocalRecord,
} from "./_core/fieldDevice";
import { appRouter } from "./routers";
import { __seedServerVersion } from "./deviceRouter";
import { grantUserRole } from "./db";
import { UNIVERSAL_PERMISSIONS, authorize, type DomainRole } from "./_core/recordsAuthorization";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NOW = new Date("2026-09-10T12:00:00Z");
const KEY_A = sha("key-a"), KEY_B = sha("key-b"), KEY_X = sha("key-x");

const device = (over: Partial<FieldDeviceRecord> = {}): FieldDeviceRecord => ({
  deviceRef: "DEV-1", userId: 9, status: "active", keyFingerprint: KEY_A,
  encryptedStorageAttested: true, keystoreAttestation: "hardware", ...over,
});

/* ------------------------------------------------------------------ */
/* Admission                                                            */
/* ------------------------------------------------------------------ */

describe("a package is admitted before any byte is examined", () => {
  const hist: KeyEvent[] = [{ keyFingerprint: KEY_A, eventType: "enrolled", validFrom: new Date("2026-01-01T00:00:00Z") }];

  it("admits an active device signing with its current key", () => {
    expect(admitPackage({ device: device(), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: hist, now: NOW }).admitted).toBe(true);
  });

  it("refuses unknown, revoked, suspended and not-yet-activated devices", () => {
    expect(admitPackage({ device: null, claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: [], now: NOW }).admitted).toBe(false);
    for (const status of ["revoked", "suspended", "enrolled"] as const) {
      const r = admitPackage({ device: device({ status }), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: hist, now: NOW });
      expect(r.admitted, status).toBe(false);
      if (!r.admitted) expect(r.disposition).toBe("rejected");
    }
  });

  it("refuses a device enrolled to another user, whatever it signs with", () => {
    const r = admitPackage({ device: device({ userId: 4 }), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: hist, now: NOW });
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toContain("another user");
  });

  it("refuses a key the device never held, and a key reported compromised", () => {
    expect(admitPackage({ device: device(), claimedUserId: 9, signedWithFingerprint: KEY_X, keyHistory: hist, now: NOW }).admitted).toBe(false);
    const comp: KeyEvent[] = [...hist, { keyFingerprint: KEY_A, eventType: "compromised", validFrom: NOW, validUntil: NOW }];
    const r = admitPackage({ device: device(), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: comp, now: NOW });
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.reason).toContain("compromised");
  });

  it("accepts a just-retired key inside the grace window and refuses it outside", () => {
    const retiredAt = new Date(NOW.getTime() - 10 * 3_600_000);
    const rotated: KeyEvent[] = [
      { keyFingerprint: KEY_A, eventType: "retired", validFrom: retiredAt, validUntil: retiredAt },
      { keyFingerprint: KEY_B, eventType: "rotated", validFrom: retiredAt },
    ];
    const inside = admitPackage({ device: device({ keyFingerprint: KEY_B }), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: rotated, now: NOW });
    expect(inside.admitted).toBe(true);
    const late = new Date(retiredAt.getTime() + (KEY_ROTATION_GRACE_HOURS + 1) * 3_600_000);
    const outside = admitPackage({ device: device({ keyFingerprint: KEY_B }), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: rotated, now: late });
    expect(outside.admitted).toBe(false);
  });

  it("admits but flags a device that has not attested encrypted storage", () => {
    const r = admitPackage({ device: device({ encryptedStorageAttested: false }), claimedUserId: 9, signedWithFingerprint: KEY_A, keyHistory: hist, now: NOW });
    expect(r.admitted).toBe(true);
    if (r.admitted) expect(r.note).toContain("not attested");
  });
});

/* ------------------------------------------------------------------ */
/* Three-way hashes                                                     */
/* ------------------------------------------------------------------ */

describe("nothing altered on the way back", () => {
  const c = sha("photo-bytes"), m = sha("manifest");
  const item = (over: Partial<Parameters<typeof verifyPackageItems>[0]["items"][number]> = {}) => ({
    evidenceRecordId: 1, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m, ...over,
  });

  it("verifies when declared, received and sealed agree", () => {
    const seals = new Map([[1, { evidenceRecordId: 1, contentHash: c, manifestHash: m }]]);
    const r = verifyPackageItems({ items: [item()], seals });
    expect(r.packageOutcome).toBe("hash_verified");
    expect(r.verdicts[0].reason).toContain("sealed hashes agree");
  });

  it("rejects bytes that differ from what the device declared", () => {
    const r = verifyPackageItems({ items: [item({ computedContentHash: sha("tampered") })], seals: new Map() });
    expect(r.packageOutcome).toBe("failed");
    expect(r.verdicts[0].reason).toContain("altered in transit or on device");
  });

  it("rejects bytes that match the declaration but not the seal on record", () => {
    // Device and transit agree with each other — and both disagree with what
    // was sealed at capture. The seal wins.
    const seals = new Map([[1, { evidenceRecordId: 1, contentHash: sha("original"), manifestHash: m }]]);
    const r = verifyPackageItems({ items: [item()], seals });
    expect(r.packageOutcome).toBe("failed");
    expect(r.verdicts[0].reason).toContain("seal on record");
  });

  it("fails the whole package if any one item fails", () => {
    const r = verifyPackageItems({ items: [item(), item({ evidenceRecordId: 2, computedManifestHash: sha("x") })], seals: new Map() });
    expect(r.packageOutcome).toBe("failed");
    expect(r.verdicts.map(v => v.outcome)).toEqual(["verified", "rejected"]);
  });
});

/* ------------------------------------------------------------------ */
/* Conflicts                                                            */
/* ------------------------------------------------------------------ */

describe("a conflict is a person's decision, not a merge", () => {
  const base = { version: 3, values: { netKg: 22800, note: "ok" } };

  it("fast-forwards when the server is unchanged", () => {
    const r = detectConflict({ deviceBase: base, deviceNow: { version: 3, values: { netKg: 22800, note: "edited" } }, server: base, materialFields: ["netKg"] });
    expect(r.conflict).toBe(false);
    if (!r.conflict) expect(r.fastForward).toBe(true);
  });

  it("merges when the two sides changed different fields", () => {
    const r = detectConflict({
      deviceBase: base, deviceNow: { version: 3, values: { netKg: 22800, note: "edited" } },
      server: { version: 4, values: { netKg: 22790, note: "ok" } }, materialFields: ["netKg"],
    });
    expect(r.conflict).toBe(false);
  });

  it("conflicts when both sides changed a material field differently", () => {
    const r = detectConflict({
      deviceBase: base, deviceNow: { version: 3, values: { netKg: 22700, note: "ok" } },
      server: { version: 4, values: { netKg: 22790, note: "ok" } }, materialFields: ["netKg"],
    });
    expect(r.conflict).toBe(true);
    if (r.conflict) {
      expect(r.material).toBe(true);
      expect(r.conflictingFields).toEqual(["netKg"]);
      expect(r.deviceValues.netKg).toBe(22700);
      expect(r.serverValues.netKg).toBe(22790);
    }
  });

  it("does not conflict when both sides made the same change", () => {
    const r = detectConflict({ deviceBase: base, deviceNow: { version: 3, values: { netKg: 22790, note: "ok" } }, server: { version: 4, values: { netKg: 22790, note: "ok" } }, materialFields: ["netKg"] });
    expect(r.conflict).toBe(false);
  });

  it("refuses to guess when the device claims a base the server never reached", () => {
    const r = detectConflict({ deviceBase: { version: 9, values: {} }, deviceNow: { version: 9, values: {} }, server: { version: 4, values: {} }, materialFields: [] });
    expect(r.conflict).toBe(true);
    if (r.conflict) expect(r.reason).toContain("refusing to guess");
  });
});

/* ------------------------------------------------------------------ */
/* Storage pressure                                                     */
/* ------------------------------------------------------------------ */

describe("a device under pressure never deletes what the office has not accepted", () => {
  const past = new Date("2026-08-01T00:00:00Z"), future = new Date("2026-12-01T00:00:00Z");
  const rec = (over: Partial<LocalRecord>): LocalRecord => ({ evidenceRecordId: 1, bytes: 1_000_000, syncState: "office_accepted", hashVerified: true, deviceRetainUntil: past, legalHold: false, ...over });

  it("deletes only accepted, verified, past-retention, unheld records — largest first", () => {
    const plan = planStoragePressure({ freeBytes: 100, targetFreeBytes: 2_000_100, now: NOW, records: [
      rec({ evidenceRecordId: 1, bytes: 1_500_000 }),
      rec({ evidenceRecordId: 2, bytes: 3_000_000, syncState: "queued" }),          // unsynced
      rec({ evidenceRecordId: 3, bytes: 2_000_000, hashVerified: false }),          // not verified
      rec({ evidenceRecordId: 4, bytes: 2_000_000, deviceRetainUntil: future }),    // still retained
      rec({ evidenceRecordId: 5, bytes: 2_000_000, legalHold: true }),              // held
      rec({ evidenceRecordId: 6, bytes: 800_000 }),
    ]});
    expect(plan.deletable).toEqual([1, 6]);
    expect(plan.bytesFreed).toBe(2_300_000);
    expect(plan.stillShort).toBe(0);
  });

  it("runs out of room and says why rather than widening the criteria", () => {
    const plan = planStoragePressure({ freeBytes: 0, targetFreeBytes: 10_000_000, now: NOW, records: [
      rec({ evidenceRecordId: 1, bytes: 1_000_000 }),
      rec({ evidenceRecordId: 2, bytes: 9_000_000, syncState: "waiting_for_service" }),
    ]});
    expect(plan.deletable).toEqual([1]);
    expect(plan.stillShort).toBe(9_000_000);
    expect(plan.blockedReason).toContain("will not be deleted");
    expect(plan.blockedReason).toContain("synchronize to free space");
  });

  it("does nothing when not under pressure", () => {
    expect(planStoragePressure({ freeBytes: 5, targetFreeBytes: 1, now: NOW, records: [rec({})] }).deletable).toEqual([]);
  });
});

describe("the roadside package is allowlisted", () => {
  it("permits registration, insurance proof, inspection, permits, HOS and shipping documents", () => {
    for (const c of ["vehicle_registration", "insurance_proof", "inspection_certificate", "hos_current", "tdg_document"]) expect(roadsidePackagePermits(c), c).toBe(true);
  });
  it("never includes payroll, billing, premiums or claims reserves", () => {
    for (const c of ["payroll", "billing", "premium", "claims_reserve", "rate_card", "anything_else"]) expect(roadsidePackagePermits(c), c).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow, end to end                                 */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("own-device permissions are universal; revocation is not", () => {
  it("adds three self-scoped device permissions to the universal list", () => {
    expect(UNIVERSAL_PERMISSIONS.slice(0, 5)).toEqual(["tax.read_personal_own", "portal.compose_own", "device.enroll_own", "device.rotate_own", "sync.push_own"]);
  });
  it("reserves device revocation to safety, management and controller", () => {
    const holders = ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "device.manage" }).allowed);
    expect(holders.sort()).toEqual(["controller", "management", "safety"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 480000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 6 });
});
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("enrol, activate, push, rotate, revoke — and the refusals between", () => {
  it("walks a device through its life and refuses at every wrong turn", async () => {
    const driver = await withRole("driver");
    const safety = await withRole("safety");
    const kA = sha(key("k")), kB = sha(key("k"));
    const bytesText = key("bytes");
    const c = sha(bytesText), m = sha(key("manifest"));
    // Four real uploads whose stored bytes hash to `c`, and one whose stored bytes do not.
    const up = async (data: string) => Number((await callerFor(driver).fieldRoute.evidence.upload({ title: "e", category: "photo", fileName: "e.bin", mimeType: "application/octet-stream", dataBase64: Buffer.from(data).toString("base64"), clientCaptureRef: key("cap-________") })).id);
    const ev1 = await up(bytesText), ev2 = await up("tampered on the way in"), ev3 = await up(bytesText), ev4 = await up(bytesText);

    // Enrol. A failed attestation is refused outright.
    await expect(callerFor(driver).device.enroll({ platform: "android", keyFingerprint: kA, keystoreAttestation: "failed" })).rejects.toThrow(/cannot hold LeaseOS keys/);
    const en = await callerFor(driver).device.enroll({ platform: "android", keyFingerprint: kA, keystoreAttestation: "hardware", encryptedStorageAttested: true });
    expect(en.status).toBe("enrolled");

    // Pushing before activation is refused — and the refusal is a row.
    const early = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: kA, packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: 1, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] });
    expect(early.state).toBe("rejected");
    expect(early.reason).toContain("not yet activated");
    const [rej] = await pool.execute<mysql.RowDataPacket[]>("SELECT state, refusalReason FROM syncPackages WHERE packageRef = ?", [early.packageRef]);
    expect(rej[0].state).toBe("rejected");
    expect(rej[0].refusalReason).toContain("not yet activated");

    // Another user cannot activate it.
    const other = await withRole("driver");
    await expect(callerFor(other).device.activate({ deviceRef: en.deviceRef })).rejects.toThrow(/not found for this user/);
    await callerFor(driver).device.activate({ deviceRef: en.deviceRef });

    // A clean push verifies.
    const ok = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: kA, packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: ev1, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] });
    expect(ok.state).toBe("hash_verified");
    expect(ok.verified).toBe(1);

    // A tampered push is received — the device is fine — but the item is rejected.
    const bad = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: kA, packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: ev2, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] }); // the device claims c; the server finds otherwise in storage
    expect(bad.state).toBe("failed");
    expect(bad.rejected).toBe(1);
    const [receipt] = await pool.execute<mysql.RowDataPacket[]>("SELECT matched, failureDetail FROM syncReceipts WHERE evidenceRecordId = ? AND syncPackageId = (SELECT id FROM syncPackages WHERE packageRef = ?)", [ev2, bad.packageRef]);
    expect(Number(receipt[0].matched)).toBe(0);
    // Before v21.6 the server compared the device's declared hash with the device's own "computed"
    // value; now it compares the declaration with what it stored, and the reason says so.
    expect(receipt[0].failureDetail).toMatch(/altered|differs/);

    // Rotate. The old key works inside the grace window; a stranger's key never does.
    const rot = await callerFor(driver).device.rotateKey({ deviceRef: en.deviceRef, newKeyFingerprint: kB });
    expect(rot.retiredFingerprint).toBe(kA);
    const graced = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: kA, packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: ev3, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] });
    expect(graced.state).toBe("hash_verified");
    expect(graced.note).toContain("grace window");
    const stranger = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: sha("stranger"), packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: ev3, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] });
    expect(stranger.state).toBe("rejected");

    // Revoke. The driver cannot; safety can. After that, nothing from it is received.
    await expect(callerFor(driver).device.revoke({ deviceRef: en.deviceRef, reason: "lost" })).rejects.toBeTruthy();
    const rv = await callerFor(safety).device.revoke({ deviceRef: en.deviceRef, reason: "Tablet reported lost", keyCompromised: true });
    expect(rv.status).toBe("revoked");
    const after = await callerFor(driver).sync.receivePackage({ deviceRef: en.deviceRef, signedWithFingerprint: kB, packageRef: key("PKG"), queuedAt: new Date(), items: [{ evidenceRecordId: ev4, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }] });
    expect(after.state).toBe("rejected");
    expect(after.reason).toContain("revoked");
    await expect(callerFor(driver).device.rotateKey({ deviceRef: en.deviceRef, newKeyFingerprint: sha("new") })).rejects.toThrow(/revoked device/);
  });

  it("records a material conflict with both versions and lets office resolve it without deleting either", async () => {
    const driver = await withRole("driver");
    const office = await withRole("office");
    const k = sha(key("k")), c = sha(key("b")), m = sha(key("m"));
    const en = await callerFor(driver).device.enroll({ platform: "android", keyFingerprint: k, keystoreAttestation: "hardware", encryptedStorageAttested: true });
    await callerFor(driver).device.activate({ deviceRef: en.deviceRef });

    const recordRef = key("DSP");
    __seedServerVersion("disposal_ticket", recordRef, { version: 4, values: { netKg: 22790, facilityTicketNumber: "A-1" } });
    const r = await callerFor(driver).sync.receivePackage({
      deviceRef: en.deviceRef, signedWithFingerprint: k, packageRef: key("PKG"), queuedAt: new Date(),
      items: [{ evidenceRecordId: 9, declaredContentHash: c, declaredManifestHash: m, computedContentHash: c, computedManifestHash: m }],
      recordUpdates: [{ recordType: "disposal_ticket", recordRef, baseVersion: 3, baseValues: { netKg: 22800, facilityTicketNumber: "A-1" }, deviceValues: { netKg: 22700, facilityTicketNumber: "A-1" } }],
    });
    expect(r.conflicts).toBe(1);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT conflictRef, material, status, deviceValuesJson, serverValuesJson FROM syncConflicts WHERE recordRef = ?", [recordRef]);
    expect(Number(rows[0].material)).toBe(1);
    expect(rows[0].status).toBe("unresolved");
    expect(JSON.parse(rows[0].deviceValuesJson).netKg).toBe(22700);
    expect(JSON.parse(rows[0].serverValuesJson).netKg).toBe(22790);

    await expect(callerFor(driver).sync.resolveConflict({ conflictRef: rows[0].conflictRef, resolution: "resolved_device", note: "mine" })).rejects.toBeTruthy();
    const res = await callerFor(office).sync.resolveConflict({ conflictRef: rows[0].conflictRef, resolution: "resolved_server", note: "Scale re-read confirmed 22,790" });
    expect(res.bothVersionsRetained).toBe(true);
    const [afterRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, deviceValuesJson, serverValuesJson, resolutionNote FROM syncConflicts WHERE conflictRef = ?", [rows[0].conflictRef]);
    expect(afterRows[0].status).toBe("resolved_server");
    // The loser is still there.
    expect(JSON.parse(afterRows[0].deviceValuesJson).netKg).toBe(22700);
  });
});
