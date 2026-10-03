/**
 * Live end-to-end check of the six tenant-boundary fixes, over real HTTP.
 *
 * WHY THIS EXISTS. Every tenant-scope suite on this branch drives the router
 * through `appRouter.createCaller`, which constructs the context by hand. That
 * skips the HTTP transport, the session cookie, `authenticateRequest`, the
 * superjson transformer and the whole tRPC middleware chain — so a boundary that
 * holds in the tests could still be bypassed by a real request if any of that
 * layer resolved identity differently. This drives the SAME built artifact a
 * deployment runs, with minted session JWTs, and asks the questions an attacker
 * would ask.
 *
 * It asserts the same thing the suites do, in the same shape: a foreign id must
 * be answered exactly as a fictional one, and the caller's own work must still
 * succeed. It seeds its own two organizations; `scripts/live-tenant-boundary.sh`
 * recreates the database, starts the artifact and the storage double, and runs it.
 *
 * Verified to be capable of failing: with the operator scope removed from
 * `createSyncPackage` and the artifact rebuilt, the S3 check reports
 * `queued=7` — tenant A reading tenant B's item count over real HTTP. A harness
 * that has never failed is not evidence that anything holds.
 */
import mysql from "mysql2/promise";
import { SignJWT } from "jose";
import { createHash, generateKeyPairSync, createPrivateKey, sign as cryptoSign } from "node:crypto";

const BASE = process.env.SMOKE_BASE;
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const APP_ID = process.env.VITE_APP_ID;
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 4 });

const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
/**
 * A guard against the trap the first run of this harness fell into: when the
 * session did not authenticate, every call answered UNAUTHORIZED, so "a foreign id
 * is answered exactly as a fictional one" held trivially and reported PASS. An
 * equality check is only evidence if the two answers came from the code under
 * test, so any UNAUTHORIZED below fails the run outright.
 */
const authentic = (name, ...calls) => {
  const bad = calls.filter(c => c.code === "UNAUTHORIZED" || String(c.message ?? "").includes("No authenticated user"));
  if (bad.length) check(`${name} — reached the procedure at all`, false, "UNAUTHORIZED: the harness is not authenticated, so nothing below it is evidence");
  return bad.length === 0;
};

/** A real session for this user: the same claims `verifySession` requires. */
async function session(openId, name) {
  return new SignJWT({ openId, appId: APP_ID, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    // Inside ACCESS_TOKEN_TTL_MS (15 min). A longer expiry is assessed as a
    // pre-S1 long-lived session and refused past the cutover grace window — the
    // first version of this harness minted an hour and was correctly rejected.
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .sign(SECRET);
}

/** One tRPC mutation over HTTP, as this session. Returns what the caller can observe. */
async function call(token, path, input) {
  const res = await fetch(`${BASE}/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json().catch(() => null);
  if (body?.error) {
    return { ok: false, code: body.error.json?.data?.code ?? String(res.status), message: body.error.json?.message ?? "" };
  }
  return { ok: true, code: "OK", value: body?.result?.data?.json ?? null };
}

// ── Seed: two organizations that share nothing ───────────────────────────────
async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function person(orgRef, roles) {
  const openId = `smoke-${rnd()}${rnd()}`;
  const [u] = await pool.execute("INSERT INTO users (openId, name, role) VALUES (?,?,'user')", [openId, `P ${openId}`]);
  const userId = u.insertId;
  await pool.execute(
    "INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)",
    [`MEM-${rnd()}`, orgRef, userId],
  );
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, grantedByUserId, grantedAt) VALUES (?,?,'organization',?,1,NOW())",
      [userId, role, orgRef],
    );
  }
  const [op] = await pool.execute("INSERT INTO operators (name, userId) VALUES (?,?)", [`Op ${openId}`, userId]);
  return { userId, openId, operatorId: op.insertId, token: await session(openId, `P ${openId}`) };
}
async function evidenceIn(orgRef, userId) {
  const [job] = await pool.execute(
    "INSERT INTO jobs (jobCode, type, customer, location, orgRef) VALUES (?,?,?,?,?)",
    [`JOB-${rnd()}`, "hydrovac", "Northgate Energy Ltd.", "16-22-079-11 W6M", orgRef],
  );
  const [ev] = await pool.execute(
    "INSERT INTO evidenceRecords (jobId, title, category, storageKey, capturedAt, capturedBy, status) VALUES (?,?,?,?,NOW(),?,'needs_review')",
    [job.insertId, `Ticket ${rnd()}`, "field_ticket", `evidence/${rnd()}/photo.jpg`, userId],
  );
  return ev.insertId;
}
function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const fingerprint = createHash("sha256").update(Buffer.from(spki, "base64")).digest("hex");
  return { spki, fingerprint, pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}
async function deviceIn(orgRef, userId) {
  const deviceRef = `DEV-${rnd()}-${rnd()}`;
  const key = deviceKey();
  await pool.execute(
    `INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, publicKeySpkiBase64, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId)
     VALUES (?,?,?,'android',?,?,'hardware',1,'active',NOW(),?)`,
    [deviceRef, userId, orgRef, key.fingerprint, key.spki, userId],
  );
  return { deviceRef, key };
}

console.log("\nseeding two organizations that share nothing…");
const A = await org(), B = await org();
const alice = await person(A, ["driver", "safety", "office"]);
const bob = await person(B, ["driver", "safety", "office"]);
const bEvidence = await evidenceIn(B, bob.userId);
const bDevice = await deviceIn(B, bob.userId);
const bVendorRef = `VEN-${rnd()}`;
await pool.execute("INSERT INTO vendors (vendorRef, bookOrgRef, name, category, status) VALUES (?,?,?,'parts','active')", [bVendorRef, B, `B's vendor ${rnd()}`]);
const [bVendor] = await pool.execute("SELECT id FROM vendors WHERE vendorRef = ?", [bVendorRef]);
const bVendorId = bVendor[0].id;

console.log(`org A = ${A} (alice user ${alice.userId}), org B = ${B} (bob user ${bob.userId})\n`);

// ── 0. The session layer itself works, or nothing below means anything ───────
const me = await fetch(`${BASE}/api/trpc/auth.me`, { headers: { authorization: `Bearer ${alice.token}` } }).then(r => r.json());
check("a minted session authenticates over HTTP (auth.me answers a user, not null)",
  Boolean(me?.result?.data?.json?.id), `id=${me?.result?.data?.json?.id ?? "null"}`);
const anon = await fetch(`${BASE}/api/trpc/auth.me`).then(r => r.json());
check("an anonymous caller is still anonymous", anon?.result?.data?.json === null);

// ── F6. A device refusal says nothing about whether the device exists ────────
const fictionalRef = `DEV-${rnd()}-${rnd()}`;
const f6foreign = await call(alice.token, "device.revoke", { deviceRef: bDevice.deviceRef, reason: "probing another tenant" });
const f6fiction = await call(alice.token, "device.revoke", { deviceRef: fictionalRef, reason: "probing another tenant" });
authentic("F6", f6foreign, f6fiction);
check("F6 — revoking another organization's device answers NOT_FOUND", f6foreign.code === "NOT_FOUND", `got ${f6foreign.code}`);
check("F6 — and is indistinguishable from a device that does not exist",
  f6foreign.code === f6fiction.code && f6foreign.message === f6fiction.message);
const [devRow] = await pool.execute("SELECT status, revokedAt FROM fieldDevices WHERE deviceRef = ?", [bDevice.deviceRef]);
check("F6 — B's device was not partially revoked", devRow[0].status === "active" && devRow[0].revokedAt === null);

// ── S1. A sync package may not name another organization's evidence ──────────
const aDevice = await deviceIn(A, alice.userId);
await pool.execute(
  "INSERT INTO deviceKeyEvents (fieldDeviceId, keyFingerprint, publicKeySpkiBase64, eventType, validFrom, recordedByUserId) SELECT id, keyFingerprint, publicKeySpkiBase64, 'enrolled', NOW(), ? FROM fieldDevices WHERE deviceRef = ?",
  [alice.userId, aDevice.deviceRef],
);
const hash = (c = "a") => c.repeat(64);
function signedPackage(dev, evidenceRecordId) {
  const items = [{
    evidenceRecordId, declaredContentHash: hash("b"), declaredManifestHash: hash("c"),
    computedContentHash: hash("b"), computedManifestHash: hash("c"),
    captureAuthorizationClaim: "authorized", captureAuthorizationReason: null,
  }];
  const packageRef = `PKG-${rnd()}`;
  const queuedAt = new Date().toISOString(), signedAt = new Date().toISOString();
  return { deviceRef: dev.deviceRef, packageRef, queuedAt, signedWithFingerprint: dev.key.fingerprint,
           signedAt, nonce: `n-${rnd()}${rnd()}`, signatureP1363Base64: "s".repeat(96), items, recordUpdates: [] };
}
const s1foreign = await call(alice.token, "sync.receivePackage", signedPackage(aDevice, bEvidence));
const s1fiction = await call(alice.token, "sync.receivePackage", signedPackage(aDevice, 2_000_000_000));
const blank = v => JSON.stringify(v, (k, x) => (k === "packageRef" ? "<pkg>" : k === "evidenceRecordId" ? "<id>" : x));
authentic("S1", s1foreign, s1fiction);
check("S1 — naming another organization's evidence is answered exactly as a fictional id",
  s1foreign.code === s1fiction.code && blank(s1foreign.value ?? s1foreign.message) === blank(s1fiction.value ?? s1fiction.message),
  `${s1foreign.code}`);
for (const t of ["syncReceipts", "syncPackageItems"]) {
  const [rows] = await pool.execute(`SELECT COUNT(*) AS n FROM ${t} WHERE evidenceRecordId = ?`, [bEvidence]);
  check(`S1 — nothing was written to ${t} against B's evidence`, Number(rows[0].n) === 0, `${rows[0].n} rows`);
}

// ── F1. A commercial link may only name a record this caller can see ─────────
const C = await org();
await pool.execute(
  `INSERT INTO organizationCommercialRoles (roleRef, bookOrgRef, orgRef, roleKey, status, effectiveFrom, assignedByUserId)
   VALUES (?,?,?,'vendor','active','2020-01-01',?)`,
  [`ROLE-${rnd()}`, A, C, alice.userId],
);
const f1 = await call(alice.token, "commercialOffice.links.set", {
  recordType: "vendor", recordId: bVendorId, orgRef: C,
});
authentic("F1", f1);
check("F1 — linking another organization's vendor is refused", !f1.ok, `${f1.code}: ${f1.message.slice(0, 70)}`);
check("F1 — and the refusal does not name B's book", !f1.message.includes(B), f1.message.includes(B) ? "LEAKED orgRef" : "");

// ── S4. An offline capture reference is not a shared namespace ───────────────
const SAME = `capture-${rnd()}-${rnd()}`;
const up = (who, title) => call(who.token, "fieldRoute.evidence.upload", {
  title, category: "field_ticket", fileName: "photo.jpg", mimeType: "image/jpeg",
  dataBase64: Buffer.from(`bytes for ${title}`).toString("base64"), clientCaptureRef: SAME,
});
const upB = await up(bob, "B's ticket");
const upA = await up(alice, "A's ticket");
authentic("S4", upA, upB);
check("S4 — B's upload succeeded", upB.ok, upB.ok ? "" : `${upB.code}: ${upB.message.slice(0, 70)}`);
check("S4 — A's colliding capture reference is not answered with B's record",
  upA.ok && upA.value?.id !== upB.value?.id && !upA.value?.alreadyUploaded,
  upA.ok ? `A=${upA.value?.id} B=${upB.value?.id} alreadyUploaded=${upA.value?.alreadyUploaded}` : `${upA.code}`);
const again = await up(alice, "A's ticket");
check("S4 — A retrying its own reference still deduplicates",
  again.ok && again.value?.id === upA.value?.id && again.value?.alreadyUploaded === true);

// ── S3. A queued package reference is not a shared namespace ─────────────────
const SHARED = `PKG-${rnd()}-${rnd()}`;
await pool.execute(
  "INSERT INTO syncPackages (packageRef, deviceId, operatorId, state, itemCount, queuedAt) VALUES (?,?,?,'queued',7,NOW())",
  [SHARED, `DEV-${rnd()}`, bob.operatorId],
);
const aEvidence = await evidenceIn(A, alice.userId);
const s3collide = await call(alice.token, "records.evidence.queueSend", { packageRef: SHARED, deviceId: `DEV-${rnd()}`, evidenceIds: [aEvidence] });
const s3fresh = await call(alice.token, "records.evidence.queueSend", { packageRef: `PKG-${rnd()}-${rnd()}`, deviceId: `DEV-${rnd()}`, evidenceIds: [aEvidence] });
const blankPkg = v => JSON.stringify(v, (k, x) => (k === "packageRef" ? "<pkg>" : x));
authentic("S3", s3collide, s3fresh);
check("S3 — colliding with B's package reference is answered exactly as not colliding",
  s3collide.ok === s3fresh.ok && blankPkg(s3collide.value ?? s3collide.message) === blankPkg(s3fresh.value ?? s3fresh.message),
  `${s3collide.code} queued=${s3collide.value?.queued ?? "-"} (B's count is 7)`);
check("S3 — B's queued package was not re-counted or re-attributed",
  await pool.execute("SELECT itemCount FROM syncPackages WHERE packageRef = ? AND operatorId = ?", [SHARED, bob.operatorId])
    .then(([r]) => Number(r[0]?.itemCount) === 7));

// ── Verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed over real HTTP`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
}
await pool.end();
process.exit(failed.length ? 1 : 0);
