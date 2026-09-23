/**
 * The sync, dedup and offline axis of the cross-tenant matrix.
 *
 * Offline-first is where shared identifier namespaces hurt most, because the
 * identifiers are chosen by the DEVICE, before the server has any say, and then
 * used for idempotency — which is precisely a rule that says "these two things
 * are the same record". Two companies whose devices pick the same string must
 * not be merged by it, must not be able to deny each other by taking it, and
 * must not learn anything about each other from the collision.
 *
 * The checkpoint's invariant, applied here: no caller may receive, infer,
 * mutate, link or SYNCHRONIZE another organization's data merely because two
 * records share a reference number or device state.
 *
 * Kept apart from crossTenantIsolation.db.test.ts because these fixtures are
 * about the device wire protocol rather than the record matrix, and because the
 * two suites collide on nothing: this one seeds its own devices and evidence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

// The evidence paths write through the storage layer; kept in memory here, as
// commercialOffice.db.test and auditPackage.test do. Declared before the router
// import so the mock is in place when the module graph loads.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { canonicalDevicePackage, fingerprintP256Spki } from "./_core/deviceSignature";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
// Its own window, per the rule the other suites follow: overlapping user-id
// windows eventually show up as one extra granted role in somebody's assertion.
let seq = 662_000_000 + Math.floor(Math.random() * 40_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org(): Promise<string> {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `org ${orgRef}`]);
  return orgRef;
}

async function member(orgRef: string, roles: string[]): Promise<number> {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())",
      [userId, role],
    );
  }
  return userId;
}

/**
 * A real key pair, because these packages have to get PAST signature
 * verification to reach the checks being tested. Same shape as the helper in
 * fieldDevice.test.ts, which is where the wire format is pinned.
 */
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
  // The admission check reads the key history, not just the column.
  await pool.execute(
    "INSERT INTO deviceKeyEvents (fieldDeviceId, keyFingerprint, publicKeySpkiBase64, eventType, validFrom, recordedByUserId) VALUES (?,?,?,'enrolled',NOW(),?)",
    [res.insertId, key.fingerprint, key.spki, userId],
  );
  return { deviceRef, id: res.insertId, key };
}

/** An evidence record owned by `orgRef` through the authoritative chain: its job. */
async function evidenceIn(orgRef: string, userId: number): Promise<number> {
  const [job] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${rnd()}`, "hydrovac", "Northgate Energy Ltd.", "16-22-079-11 W6M", orgRef],
  );
  const [ev] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO evidenceRecords (jobId, title, category, storageKey, capturedAt, capturedBy, status) VALUES (?,?,?,?,NOW(),?, 'needs_review')",
    [job.insertId, `Ticket photo ${rnd()}`, "field_ticket", `evidence/${rnd()}/photo.jpg`, userId],
  );
  return ev.insertId;
}

const hash = (c = "a") => c.repeat(64);

/** A genuinely signed package from `dev`, naming one evidence record. */
function pkg(dev: Device, evidenceRecordId: number, packageRef?: string) {
  const items = [{
    evidenceRecordId, declaredContentHash: hash("b"), declaredManifestHash: hash("c"),
    computedContentHash: hash("b"), computedManifestHash: hash("c"),
    captureAuthorizationClaim: "authorized" as const, captureAuthorizationReason: null,
  }];
  const ref = packageRef ?? `PKG-${rnd()}`;
  const queuedAt = new Date(), signedAt = new Date(), nonce = `n-${rnd()}${rnd()}`;
  const payload = canonicalDevicePackage({ deviceRef: dev.deviceRef, packageRef: ref, queuedAt, signedAt, nonce, items, recordUpdates: [] });
  const signatureP1363Base64 = cryptoSign("sha256", payload, { key: createPrivateKey(dev.key.pem), dsaEncoding: "ieee-p1363" }).toString("base64");
  return { deviceRef: dev.deviceRef, packageRef: ref, queuedAt, signedWithFingerprint: dev.key.fingerprint, signedAt, nonce, signatureP1363Base64, items, recordUpdates: [] };
}

/**
 * The server's answer with the caller's OWN choices blanked out.
 *
 * Two calls necessarily differ in what the caller picked — its package
 * reference and the evidence id it asked about — so those are blanked before
 * comparing and everything else must match exactly. Blanked by KEY rather than
 * by substituting the value's text: on a freshly migrated database an evidence
 * id is a single digit, and replacing "1" everywhere in the JSON rewrites
 * unrelated counts, which made this comparison pass on a database with history
 * and fail on a clean one.
 */
const say = (value: unknown) =>
  JSON.stringify(value, (k, v) => (k === "packageRef" ? "<pkg>" : k === "evidenceRecordId" ? "<id>" : v));

/** What a call produced, reduced to what the caller can actually observe. */
const observable = async (p: Promise<unknown>) =>
  p.then(v => ({ code: "OK", value: v }), (e: { code?: string; message: string }) => ({ code: String(e.code), value: e.message }));

d("S1 — a sync package may not name another organization's evidence", () => {
  /**
   * The device sends `evidenceRecordId` as a bare integer. The server used it
   * to read the evidence seal, to read the stored object out of the blob store
   * and hash its bytes, and to write receipt rows — none of it scoped. The
   * per-item verdict came back to the caller, so a package naming another
   * company's evidence with a guessed hash answered "verified" or "rejected",
   * which is a confirmation oracle over their sealed content.
   *
   * The rule this breaks is the same one the v23.29 webhook work established:
   * filter by tenant BEFORE reading or processing sensitive tenant material.
   */
  it("refuses before reading the other organization's evidence, and says nothing about it", async () => {
    const orgA = await org(), orgB = await org();
    const driverA = await member(orgA, ["driver"]);
    const ownerB = await member(orgB, ["driver"]);
    const devA = await deviceIn(orgA, driverA);
    const bsEvidence = await evidenceIn(orgB, ownerB);

    const foreignPkg = pkg(devA, bsEvidence), fictionalPkg = pkg(devA, 2_000_000_000);
    const foreign = await observable(callerFor(driverA).sync.receivePackage(foreignPkg as never));
    const fictional = await observable(callerFor(driverA).sync.receivePackage(fictionalPkg as never));

    /*
     * Whatever the refusal is, it must be the SAME refusal: an evidence id that
     * is another organization's has to be indistinguishable from one that is
     * nobody's. The two calls necessarily differ in the values the CALLER
     * chose — its own package reference and the id it asked about — so those
     * are blanked before comparing; everything else is the server's answer and
     * must match exactly.
     */
    expect(foreign.code).toBe(fictional.code);
    /*
     * This equality is the whole claim, including for the refusal TEXT: `say`
     * blanks only the two fields the caller chose, so a message that named the
     * id, or a verdict that differed because the record exists, would make the
     * two sides differ. An extra "the answer does not contain the id" check was
     * tried here and removed as unsound — on a freshly migrated database the id
     * is 1, which occurs in `"rejected":1` whatever the server says.
     */
    expect(say(foreign.value)).toBe(say(fictional.value));

    // And nothing was processed against B's record: no receipt, no item row.
    const [receipts] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM syncReceipts WHERE evidenceRecordId = ?", [bsEvidence],
    );
    expect(Number(receipts[0]!.n)).toBe(0);
    const [items] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM syncPackageItems WHERE evidenceRecordId = ?", [bsEvidence],
    );
    expect(Number(items[0]!.n)).toBe(0);
  }, 30_000);

  it("still accepts a package naming the device's own organization's evidence", async () => {
    const orgA = await org();
    const driverA = await member(orgA, ["driver"]);
    const devA = await deviceIn(orgA, driverA);
    const mine = await evidenceIn(orgA, driverA);

    // Both packages are properly signed by the device's own key, so the only
    // thing separating them is whose evidence they name. The caller's own
    // evidence must not get the refusal a stranger's id gets.
    const ownPkg = pkg(devA, mine), foreignPkg = pkg(devA, 2_000_000_001);
    const own = await observable(callerFor(driverA).sync.receivePackage(ownPkg as never));
    const foreign = await observable(callerFor(driverA).sync.receivePackage(foreignPkg as never));
    void ownPkg; void foreignPkg;
    expect(say(own.value)).not.toBe(say(foreign.value));
  }, 30_000);
});

d("S3 — two organizations may choose the same package reference", () => {
  /**
   * `packageRef` is chosen by the device and was globally unique, with no catch
   * around the insert. Tenant A taking a string meant Tenant B's device could
   * never sync a package under it: the insert raised a duplicate-key error the
   * device would retry forever. A shared namespace one tenant can exhaust is a
   * denial of the other, and the error was an existence oracle as well.
   *
   * The nonce got this right from the start — unique per (device, nonce) — and
   * a package reference is the same kind of thing: the device's own counter.
   */
  it("does not let one organization's package reference block another's", async () => {
    const orgA = await org(), orgB = await org();
    const driverA = await member(orgA, ["driver"]), driverB = await member(orgB, ["driver"]);
    const devA = await deviceIn(orgA, driverA), devB = await deviceIn(orgB, driverB);
    const evA = await evidenceIn(orgA, driverA), evB = await evidenceIn(orgB, driverB);
    const SAME = `PKG-${rnd()}`;

    const first = await observable(callerFor(driverA).sync.receivePackage(pkg(devA, evA, SAME) as never));
    const second = await observable(callerFor(driverB).sync.receivePackage(pkg(devB, evB, SAME) as never));

    // Neither is an internal error, and B's answer does not depend on A having
    // gone first: both devices get the same treatment for the same input.
    expect(first.code).not.toBe("INTERNAL_SERVER_ERROR");
    expect(second.code).not.toBe("INTERNAL_SERVER_ERROR");
    expect(second.code).toBe(first.code);

    // Both rows exist, and they are different rows.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT fieldDeviceId FROM syncPackages WHERE packageRef = ? ORDER BY fieldDeviceId", [SAME],
    );
    expect(rows.map(r => Number(r.fieldDeviceId))).toEqual([devA.id, devB.id].sort((a, b) => a - b));
  }, 30_000);
});

d("S4 — an offline capture reference is not a shared namespace", () => {
  /**
   * The worst of the three. `clientCaptureRef` is an 8-to-80 character string
   * the device picks, it was globally unique, and the upload path looked it up
   * with no scope at all to decide "already uploaded". On a collision the
   * server answered another organization's row:
   *
   *     return { id: existing.id, key: existing.storageKey, url: existing.storageUrl,
   *              alreadyUploaded: true }
   *
   * — handing the caller the storage key AND the storage URL of a file that is
   * not theirs, while silently discarding the evidence they were uploading. One
   * request, and it is both a disclosure and a data loss.
   */
  it("does not hand one organization another's stored file because the refs match", async () => {
    const orgA = await org(), orgB = await org();
    const driverA = await member(orgA, ["driver"]), driverB = await member(orgB, ["driver"]);
    const SAME = `capture-${rnd()}-${rnd()}`;
    const upload = (userId: number, title: string) =>
      callerFor(userId).fieldRoute.evidence.upload({
        title, category: "field_ticket", fileName: "photo.jpg", mimeType: "image/jpeg",
        dataBase64: Buffer.from(`bytes for ${title}`).toString("base64"),
        clientCaptureRef: SAME,
      } as never);

    const a = await upload(driverA, "A's ticket") as { id: number; key: string; url: string; alreadyUploaded?: boolean };
    const b = await upload(driverB, "B's ticket") as { id: number; key: string; url: string; alreadyUploaded?: boolean };

    expect(b.id).not.toBe(a.id);
    expect(b.alreadyUploaded).toBeFalsy();
    expect(b.key).not.toBe(a.key);
    if (a.url || b.url) expect(b.url).not.toBe(a.url);

    // B's upload was actually stored, not discarded.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT title, capturedBy FROM evidenceRecords WHERE id = ?", [b.id],
    );
    expect(rows[0]!.title).toBe("B's ticket");
    expect(Number(rows[0]!.capturedBy)).toBe(driverB);
  }, 30_000);

  it("still deduplicates a device retrying its own capture", async () => {
    const orgA = await org();
    const driverA = await member(orgA, ["driver"]);
    const SAME = `capture-${rnd()}-${rnd()}`;
    const upload = () =>
      callerFor(driverA).fieldRoute.evidence.upload({
        title: "Retried ticket", category: "field_ticket", fileName: "photo.jpg", mimeType: "image/jpeg",
        dataBase64: Buffer.from("same bytes").toString("base64"), clientCaptureRef: SAME,
      } as never) as Promise<{ id: number; alreadyUploaded?: boolean }>;

    const first = await upload(), again = await upload();
    expect(again.id).toBe(first.id);
    expect(again.alreadyUploaded).toBe(true);
  }, 30_000);
});
