/**
 * F6 — a device refusal must not say whether the device exists.
 *
 * The rule this lineage already follows elsewhere (db.ts, the records API, the
 * finance boundary) is that a record outside the caller's scope answers
 * NOT_FOUND: "no such id" and "an id that is another organization's" are the
 * same answer, because any difference between them is an oracle. Walk the id
 * space, keep whatever answers differently, and you have enumerated another
 * company's fleet without ever being allowed to read one of its rows.
 *
 * The device router answered FORBIDDEN instead, and only on SOME procedures —
 * which is the part worth pinning rather than the part that is obvious.
 * `activate` and `rotateKey` check `userId` before the organization, so a
 * foreign device already fell out as "not found for this user" — an accident of
 * ordering, not a rule, and one a refactor could undo. `revoke` has no `userId`
 * check by design (revoking is an administrative act over the organization's
 * fleet, not over your own handset), so the organization was the only boundary
 * left and its mismatch was observable. `sync.receivePackage` was doubly wrong:
 * a deviceRef that exists nowhere was told it was a legacy device needing
 * re-enrolment, which is both an oracle and untrue.
 *
 * These tests compare the two answers to each other rather than asserting a
 * message, so they survive rewording, and they assert NOT_FOUND so that a
 * shared-but-wrong answer does not pass either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 931_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
/** A device enrolled in `orgRef`, held by `userId`. */
async function deviceIn(orgRef: string, userId: number) {
  const deviceRef = `DEV-${rnd()}-${rnd()}`;
  await pool.execute(
    `INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, publicKeySpkiBase64, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId)
     VALUES (?,?,?,'android',?,?, 'hardware', 1, 'active', NOW(), ?)`,
    [deviceRef, userId, orgRef, `fp${rnd()}${rnd()}`, `spki${rnd()}`, userId],
  );
  return deviceRef;
}
/** What the caller can actually observe of a refusal. */
const observable = async (p: Promise<unknown>) =>
  p.then(() => ({ code: "OK", message: "" }), (e: { code?: string; message: string }) => ({ code: String(e.code), message: e.message }));

d("F6 — a device refusal does not tell you whether the device exists", () => {
  it("answers a revoke for another organization's device exactly as for no device at all", async () => {
    const A = await org(), B = await org();
    const safetyA = await member(A, ["safety"]);
    const ownerB = await member(B, ["safety"]);
    const bs = await deviceIn(B, ownerB);

    const foreign = await observable(callerFor(safetyA).device.revoke({ deviceRef: bs, reason: "probing another tenant" }));
    const fictional = await observable(callerFor(safetyA).device.revoke({ deviceRef: `DEV-${rnd()}-${rnd()}`, reason: "probing another tenant" }));

    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign).toEqual(fictional);

    // And the refusal was not a partial success.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status, revokedAt, revokedByUserId FROM fieldDevices WHERE deviceRef = ?", [bs],
    );
    expect(rows[0].status).toBe("active");
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].revokedByUserId).toBeNull();
  }, 30_000);

  it("answers a sync package for another organization's device exactly as for no device at all", async () => {
    const A = await org(), B = await org();
    const driverA = await member(A, ["driver"]);
    const ownerB = await member(B, ["safety"]);
    const bs = await deviceIn(B, ownerB);

    const hash = (c = "a") => c.repeat(64);
    const pkg = (deviceRef: string) => ({
      deviceRef, signedWithFingerprint: hash(), signedAt: new Date(), nonce: `n-${rnd()}${rnd()}`,
      signatureP1363Base64: "s".repeat(96), packageRef: `PKG-${rnd()}`, queuedAt: new Date(),
      items: [{
        evidenceRecordId: 1, declaredContentHash: hash(), declaredManifestHash: hash(),
        computedContentHash: hash(), computedManifestHash: hash(),
        captureAuthorizationClaim: "authorized" as const, captureAuthorizationReason: null,
      }],
      recordUpdates: [],
    });

    const foreign = await observable(callerFor(driverA).sync.receivePackage(pkg(bs) as never));
    const fictional = await observable(callerFor(driverA).sync.receivePackage(pkg(`DEV-${rnd()}-${rnd()}`) as never));

    expect(foreign.code).toBe("NOT_FOUND");
    expect(foreign).toEqual(fictional);
  }, 30_000);

  it("keeps activate and rotateKey indistinguishable too, which they already were", async () => {
    // Pinned although they already hold: what protects them is a `userId` check
    // that happens to run first, and a reordering would silently reopen this.
    const A = await org(), B = await org();
    const safetyA = await member(A, ["safety"]);
    const ownerB = await member(B, ["safety"]);
    const bs = await deviceIn(B, ownerB);
    const nothing = `DEV-${rnd()}-${rnd()}`;

    expect(await observable(callerFor(safetyA).device.activate({ deviceRef: bs })))
      .toEqual(await observable(callerFor(safetyA).device.activate({ deviceRef: nothing })));
    expect(await observable(callerFor(safetyA).device.rotateKey({ deviceRef: bs, newPublicKeySpkiBase64: "k".repeat(120) })))
      .toEqual(await observable(callerFor(safetyA).device.rotateKey({ deviceRef: nothing, newPublicKeySpkiBase64: "k".repeat(120) })));
  }, 30_000);
});
