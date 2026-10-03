/**
 * SEC-1 — the device and sync procedures act only on the caller's organization's evidence.
 *
 * - device.verifySeal found a seal by evidence id and WROTE the verification result onto it, with
 *   no organization check;
 * - sync.resolveConflict found a conflict by reference and recorded a resolution on it;
 * - sync.receivePackage bound the device to the caller's organization but never checked the
 *   evidence ids inside the signed package: it read another organization's stored bytes to hash
 *   them, wrote package items and receipts against those records, and returned a verdict per item;
 * - evidence.upload's duplicate path looked a capture reference up globally and returned another
 *   person's evidence id and storage key to whoever sent the same reference.
 * Across the boundary each now answers as a missing record does. Baseline V8 (device rows), V11.
 */
import { createHash, webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
/*
 * Every stored object reads back as the same bytes, and every fixture seal is over those bytes — so
 * a router that reads another organization's evidence would VERIFY it. Without this the object is
 * unreadable in a test environment, both cases are rejected for the same reason, and the test
 * cannot tell a guarded router from an unguarded one.
 */
vi.mock("./storage", async (orig) => ({ ...(await orig<typeof import("./storage")>()), storageRead: vi.fn(async () => Buffer.from("payload")) }));
import { appRouter } from "./routers";
import { canonicalJson } from "../client/src/runtime/crypto";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 946_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const hex64 = (s: string) => createHash("sha256").update(s).digest("hex");
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
/** Evidence owned through its job, with a seal on it. */
async function sealedEvidence(orgRef: string, capturedBy: number, clientCaptureRef: string | null = null) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture", "Somewhere", orgRef]);
  const [e] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO evidenceRecords (jobId, title, category, capturedAt, capturedBy, storageKey, clientCaptureRef, status, createdAt) VALUES (?, 'Load photo', 'photo', NOW(), ?, ?, ?, 'needs_review', NOW())",
    [j.insertId, capturedBy, `${capturedBy}/evidence/${rnd()}.jpg`, clientCaptureRef],
  );
  await pool.execute(
    "INSERT INTO evidenceSeals (evidenceRecordId, canonicalManifest, contentHash, manifestHash, sealedAt, sealedByUserId) VALUES (?, '{}', ?, ?, NOW(), ?)",
    [e.insertId, hex64("payload"), hex64(`m${e.insertId}`), capturedBy],
  );
  return e.insertId;
}
/** A real enrolled, active device for `userId`, and the key that signs for it. */
async function device(userId: number) {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey));
  const enrolled = await callerFor(userId).device.enroll({ platform: "android", publicKeySpkiBase64: spki.toString("base64"), keystoreAttestation: "software", displayName: "Tablet" });
  await callerFor(userId).device.activate({ deviceRef: enrolled.deviceRef });
  return { deviceRef: enrolled.deviceRef as string, privateKey: keys.privateKey, fingerprint: createHash("sha256").update(spki).digest("hex") };
}

d("the device and sync procedures act only on the caller's organization's evidence", () => {
  it("seal verification and conflict resolution answer not-found across the boundary and write nothing", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A, ["safety", "office", "management"]), officeB = await member(B, ["safety", "office", "management"]);
    const driverB = await member(B, ["driver"]);
    const evB = await sealedEvidence(B, driverB);

    await expect(callerFor(officeA).sync.verifySeal({ evidenceRecordId: evB })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [[seal]] = (await pool.query("SELECT serverVerifiedAt FROM evidenceSeals WHERE evidenceRecordId = ?", [evB])) as unknown as [[{ serverVerifiedAt: Date | null }]];
    expect(seal.serverVerifiedAt).toBeNull();

    const devB = await device(driverB);
    const [[{ id: devId }]] = (await pool.query("SELECT id FROM fieldDevices WHERE deviceRef = ?", [devB.deviceRef])) as unknown as [[{ id: number }]];
    const conflictRef = `CONF-${rnd()}`;
    await pool.execute(
      "INSERT INTO syncConflicts (conflictRef, fieldDeviceId, recordType, recordRef, deviceBaseVersion, serverVersion, conflictingFieldsJson, deviceValuesJson, serverValuesJson, detectedAt) VALUES (?,?, 'daily_log', 'LOG-1', 1, 2, '[]', '{}', '{}', NOW())",
      [conflictRef, devId],
    );
    await expect(callerFor(officeA).sync.resolveConflict({ conflictRef, resolution: "resolved_server", note: "not ours to decide" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeB).sync.resolveConflict({ conflictRef, resolution: "resolved_server", note: "server wins" })).resolves.toMatchObject({ status: "resolved_server" });
  }, 60_000);

  it("a signed package naming another organization's evidence gets exactly what a nonexistent id gets", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]), driverB = await member(B, ["driver"]);
    const evB = await sealedEvidence(B, driverB);
    const dev = await device(driverA);

    // B's evidence is sealed with these exact hashes. Read, it would verify against its seal; a
    // record that does not exist has no seal. The two verdicts must be indistinguishable.
    const push = async (evidenceRecordId: number) => {
      const packageRef = `PKG-${rnd()}`, queuedAt = new Date(), signedAt = new Date();
      const nonce = webcrypto.getRandomValues(new Uint8Array(24)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
      const items = [{ evidenceRecordId, declaredContentHash: hex64("payload"), declaredManifestHash: hex64(`m${evB}`), computedContentHash: hex64("payload"), computedManifestHash: hex64(`m${evB}`), captureAuthorizationClaim: "authorized" as const }];
      const payload = canonicalJson({ deviceRef: dev.deviceRef, packageRef, queuedAt: queuedAt.toISOString(), signedAt: signedAt.toISOString(), nonce, items, recordUpdates: [] });
      const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.privateKey, new TextEncoder().encode(payload))).toString("base64");
      return callerFor(driverA).sync.receivePackage({
        deviceRef: dev.deviceRef, signedWithFingerprint: dev.fingerprint, signedAt, nonce, signatureP1363Base64: signature, signedPayloadJson: payload,
        packageRef, queuedAt, items, recordUpdates: [],
      });
    };
    const foreign = await push(evB);
    const missing = await push(2_000_000_000);
    const verdict = (r: Awaited<ReturnType<typeof push>>) => (r as unknown as { itemVerdicts: { outcome: string; reason: string | null }[] }).itemVerdicts[0];
    expect(verdict(foreign).outcome).toBe("rejected");
    expect(verdict(foreign).reason).toBe(verdict(missing).reason);
  }, 60_000);

  it("a capture reference is idempotent for its own uploader only", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]), driverB = await member(B, ["driver"]);
    const captureRef = `TAB-B:${rnd()}`;
    const evB = await sealedEvidence(B, driverB, captureRef);

    const upload = (userId: number) => callerFor(userId).fieldRoute.evidence.upload({
      title: "Load photo", category: "photo", fileName: "load.jpg", mimeType: "image/jpeg", dataBase64: Buffer.from("x").toString("base64"), clientCaptureRef: captureRef,
    } as never);
    const err = await upload(driverA).then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect(String(err?.message)).not.toContain(String(evB));
    // The owner's retry is still the idempotent reply it always was.
    await expect(upload(driverB)).resolves.toMatchObject({ id: evB, alreadyUploaded: true });
  }, 60_000);
});
