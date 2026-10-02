/**
 * S1 — a sync package may not name another organization's evidence.
 *
 * The device sends `evidenceRecordId` as a bare integer per item, and nothing
 * scoped it. The server then read that record's seal, fetched the stored object
 * out of the blob store, hashed its bytes, wrote `syncPackageItems` and
 * `syncReceipts` rows against it, and returned a **per-item verdict** saying
 * whether the hash the caller DECLARED matched.
 *
 * That is a confirmation oracle over another company's sealed evidence content,
 * and every one of those reads happened before anything could have refused it.
 * The rule this lineage applies elsewhere is the other way round: filter by
 * tenant BEFORE reading or processing tenant material.
 *
 * `evidenceInScope` is the authoritative chain this repository already carries —
 * job, else capturing user, else the single tenant only — rather than a join that
 * happens to be available. It answers null for "no such record" and "not yours"
 * alike, so the refusal below cannot tell the two apart, and it covers the whole
 * package naming no id: saying WHICH item was out of scope would rebuild the
 * oracle one record at a time.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

import { canonicalDevicePackage, fingerprintP256Spki } from "./_core/deviceSignature";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 933_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}

/** A real key pair: these packages must get PAST signature verification to reach the evidence read. */
type DeviceKey = { spki: string; fingerprint: string; pem: string };
function deviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { spki, fingerprint: fingerprintP256Spki(spki), pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}
type Device = { deviceRef: string; id: number; key: DeviceKey };
async function deviceIn(orgRef: string, userId: number): Promise<Device> {
  const deviceRef = `DEV-${rnd()}-${rnd()}`;
  const key = deviceKey();
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, publicKeySpkiBase64, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId)
     VALUES (?,?,?,'android',?,?, 'hardware', 1, 'active', NOW(), ?)`,
    [deviceRef, userId, orgRef, key.fingerprint, key.spki, userId],
  );
  // Admission reads the key history, not just the column.
  await pool.execute(
    "INSERT INTO deviceKeyEvents (fieldDeviceId, keyFingerprint, publicKeySpkiBase64, eventType, validFrom, recordedByUserId) VALUES (?,?,?,'enrolled',NOW(),?)",
    [res.insertId, key.fingerprint, key.spki, userId],
  );
  return { deviceRef, id: res.insertId, key };
}
/** Evidence owned by `orgRef` through the authoritative chain: its job. */
async function evidenceIn(orgRef: string, userId: number) {
  const [job] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${rnd()}`, "hydrovac", "Northgate Energy Ltd.", "16-22-079-11 W6M", orgRef],
  );
  const [ev] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO evidenceRecords (jobId, title, category, storageKey, capturedAt, capturedBy, status) VALUES (?,?,?,?,NOW(),?, 'needs_review')",
    [job.insertId, `Ticket ${rnd()}`, "field_ticket", `evidence/${rnd()}/photo.jpg`, userId],
  );
  return ev.insertId;
}

const hash = (c = "a") => c.repeat(64);
/** A genuinely signed package from `dev`, naming one evidence record per id given. */
function pkg(dev: Device, ...evidenceRecordIds: number[]) {
  const items = evidenceRecordIds.map(evidenceRecordId => ({
    evidenceRecordId, declaredContentHash: hash("b"), declaredManifestHash: hash("c"),
    computedContentHash: hash("b"), computedManifestHash: hash("c"),
    captureAuthorizationClaim: "authorized" as const, captureAuthorizationReason: null,
  }));
  const packageRef = `PKG-${rnd()}`;
  const queuedAt = new Date(), signedAt = new Date(), nonce = `n-${rnd()}${rnd()}`;
  const payload = canonicalDevicePackage({ deviceRef: dev.deviceRef, packageRef, queuedAt, signedAt, nonce, items, recordUpdates: [] });
  const signatureP1363Base64 = cryptoSign("sha256", payload, { key: createPrivateKey(dev.key.pem), dsaEncoding: "ieee-p1363" }).toString("base64");
  return { deviceRef: dev.deviceRef, packageRef, queuedAt, signedWithFingerprint: dev.key.fingerprint, signedAt, nonce, signatureP1363Base64, items, recordUpdates: [] };
}

/**
 * The server's answer with the caller's OWN choices blanked out.
 *
 * Two calls necessarily differ in what the caller picked — its package reference
 * and the evidence id it asked about — so those are blanked by KEY and everything
 * else must match exactly. Blanked by key rather than by substituting the value's
 * text: on a freshly migrated database an evidence id is a single digit, and
 * replacing "1" everywhere in the JSON rewrites unrelated counts.
 */
const say = (value: unknown) =>
  JSON.stringify(value, (k, v) => (k === "packageRef" ? "<pkg>" : k === "evidenceRecordId" ? "<id>" : v));
const observable = async (p: Promise<unknown>) =>
  p.then(v => ({ code: "OK", value: v }), (e: { code?: string; message: string }) => ({ code: String(e.code), value: e.message }));

d("S1 — a sync package may not name another organization's evidence", () => {
  it("refuses before reading it, and says nothing that distinguishes it from a fictional id", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]);
    const ownerB = await member(B, ["driver"]);
    const devA = await deviceIn(A, driverA);
    const bsEvidence = await evidenceIn(B, ownerB);

    const foreign = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, bsEvidence) as never));
    const fictional = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, 2_000_000_000) as never));

    expect(foreign.code).toBe(fictional.code);
    expect(say(foreign.value)).toBe(say(fictional.value));

    // And nothing was processed against B's record.
    for (const t of ["syncReceipts", "syncPackageItems"]) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ${t} WHERE evidenceRecordId = ?`, [bsEvidence],
      );
      expect(Number(rows[0].n), t).toBe(0);
    }
  }, 30_000);

  it("still processes a package naming the device's own organization's evidence", async () => {
    // The counter-test: the gate must not refuse everything. Both packages are
    // properly signed, so the only difference is whose evidence they name.
    const A = await org();
    const driverA = await member(A, ["driver"]);
    const devA = await deviceIn(A, driverA);
    const mine = await evidenceIn(A, driverA);

    const own = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, mine) as never));
    const foreign = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, 2_000_000_001) as never));
    expect(say(own.value)).not.toBe(say(foreign.value));
  }, 30_000);

  it("checks every item, not just the first one it looks at", async () => {
    // A package carries up to 500 items. Checking only the first — or stopping at
    // the first that passes — would let a caller hide a foreign id behind one of
    // their own, which is the whole attack with one extra line of JSON.
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]);
    const ownerB = await member(B, ["driver"]);
    const devA = await deviceIn(A, driverA);
    const mine = await evidenceIn(A, driverA);
    const bsEvidence = await evidenceIn(B, ownerB);

    const hidden = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, mine, bsEvidence) as never));
    const decoy = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, mine, 2_000_000_002) as never));
    expect(hidden.code).toBe(decoy.code);
    expect(say(hidden.value)).toBe(say(decoy.value));

    for (const t of ["syncReceipts", "syncPackageItems"]) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ${t} WHERE evidenceRecordId = ?`, [bsEvidence],
      );
      expect(Number(rows[0].n), t).toBe(0);
    }
  }, 30_000);
});
