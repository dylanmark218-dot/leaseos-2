/**
 * SPINE item 3 — after reconnect the server decides, whatever the device knew or claimed.
 *
 *   offline observation → stored historical claim → sync → current session → current acting scope
 *   → current permission → accept / refuse
 *
 * Each capture here is made through the gated outbox (HS1 + the one offline rule) and carries
 * `captureAuthorizationClaim: "authorized"` — the strongest thing a device can say. It is evidence of
 * what the device believed, never authority: a worker whose organization changed, or whose permission
 * was revoked, is refused by the server exactly as if the claim were "unknown".
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import mysql from "mysql2/promise";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock, memoryProbes } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import { captureGate } from "../client/src/runtime/capabilities";
import type { Transport } from "../client/src/runtime/contracts";
import { appRouter } from "./routers";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 925_000_000 + Math.floor(Math.random() * 50_000);
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function join(orgRef: string, userId: number) {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
}
async function driverIn(orgRef: string) {
  const userId = seq++;
  await join(orgRef, userId);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, 'driver', 'global', 1, NOW())", [userId]);
  return userId;
}

/** The device talks to the real router as `userId`. */
function transportFor(userId: number): Transport {
  const c = callerFor(userId);
  return {
    async enroll(i) { const r = await c.device.enroll({ platform: i.platform, publicKeySpkiBase64: i.publicKeySpkiBase64, keystoreAttestation: i.keystoreAttestation, displayName: i.displayName ?? null }); return { deviceRef: r.deviceRef, status: r.status }; },
    async activate(i) { const r = await c.device.activate(i); return { status: r.status }; },
    async rotateKey(i) { const r = await c.device.rotateKey(i); return { status: String((r as { status?: string }).status ?? "rotated") }; },
    async uploadEvidence(i) { const r = await c.fieldRoute.evidence.upload({ title: i.title, category: i.category, fileName: i.fileName, mimeType: i.mimeType, dataBase64: i.dataBase64, latitude: i.latitude, longitude: i.longitude, notes: i.notes, clientCaptureRef: i.clientCaptureRef, capturedAt: i.capturedAt }); return { id: Number(r.id), alreadyUploaded: (r as { alreadyUploaded?: boolean }).alreadyUploaded }; },
    async sealEvidence(i) { const r = await c.records.evidence.seal({ evidenceId: i.evidenceId, contentHash: i.contentHash, recordType: i.recordType, relationships: i.relationships as never, deviceId: i.deviceId, devicePlatform: i.devicePlatform }); return { ok: true as const, alreadySealed: false, manifestHash: (r as { manifestHash?: string }).manifestHash ?? null }; },
    async receivePackage(i) { return c.sync.receivePackage(i) as never; },
  };
}

/** A tablet enrolled by `userId` while online, then offline for a capture made through the gated outbox. */
async function tabletFor(userId: number) {
  const clock = new SettableClock(new Date());
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const net = new FlagConnectivity(true);
  const engine = new SyncEngine({ store, vault, keystore, transport: transportFor(userId), connectivity: net, clock, platform: "android" });
  const enrolled = await engine.enroll("Tablet");
  await engine.activate();
  net.isOnline = false;
  const outbox = new Outbox(store, vault, clock, captureGate({ probes: memoryProbes(), connectivity: net }));
  const capture = await outbox.saveDraft({
    kind: "defect_report", formKey: "defect_report", title: "Hose weeping at PTO", category: "defect", fields: { severity: "minor" }, unitId: 142,
    captureAuthorizationClaim: "authorized", captureAuthorizationReason: "Device had a valid session when the defect was recorded",
  });
  await outbox.queue(capture.localId);
  return { engine, store, net, clock, deviceRef: enrolled.deviceRef, capture };
}
const accepted = async (deviceRef: string) => Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM syncPackages WHERE deviceId = ? AND state = 'hash_verified'", [deviceRef]))[0][0].n);

d("reconnect is re-authorized on the server; a historical claim is not authority", () => {
  it("a worker still in the organization, still permitted: the capture is accepted and its claim kept as history, not upgraded or used", async () => {
    const A = await org();
    const t = await tabletFor(await driverIn(A));
    t.net.isOnline = true; t.clock.set(new Date());
    const r = await t.engine.syncOnce();
    expect(r.synchronized, (await t.store.getCapture(t.capture.localId))!.lastError ?? "").toBe(1);
    expect(await accepted(t.deviceRef)).toBe(1);
    const [[item]] = await pool.query<mysql.RowDataPacket[]>("SELECT i.captureAuthorizationClaim FROM syncPackageItems i JOIN syncPackages p ON p.id = i.syncPackageId WHERE p.deviceId = ?", [t.deviceRef]);
    expect(item.captureAuthorizationClaim).toBe("authorized");
  }, 60_000);

  it("a worker whose organization changed while offline is refused by the device's organization binding, claim notwithstanding", async () => {
    const A = await org(), B = await org();
    const driver = await driverIn(A);
    const t = await tabletFor(driver);
    // Offline, the worker moves: A's membership ends, B's begins. The tablet still says "authorized".
    await pool.execute("UPDATE organizationMemberships SET status = 'ended', effectiveTo = NOW() WHERE userId = ? AND orgRef = ?", [driver, A]);
    await join(B, driver);
    t.net.isOnline = true; t.clock.set(new Date());
    // The server refuses the package outright. Under HS5's queue rules (shared/clientContract.ts) a
    // FORBIDDEN is a real refusal: the capture is retained as failed with the server's reason — never
    // deleted, never resent under another organization — and nothing is accepted.
    const r = await t.engine.syncOnce();
    expect(r).toMatchObject({ synchronized: 0, failed: 1, reason: "Device is not bound to the active organization" });
    const kept = (await t.store.getCapture(t.capture.localId))!;
    expect(kept.syncState).toBe("failed");
    expect(kept.lastError).toBe("Device is not bound to the active organization");
    expect(kept.captureAuthorizationClaim).toBe("authorized");   // still only history
    expect(await accepted(t.deviceRef)).toBe(0);
  }, 60_000);

  it("a worker whose permission was revoked while offline is refused, claim notwithstanding — nothing is received", async () => {
    const A = await org();
    const driver = await driverIn(A);
    const t = await tabletFor(driver);
    await pool.execute("UPDATE userRoleAssignments SET revokedAt = NOW(), revokedByUserId = 1 WHERE userId = ?", [driver]);
    t.net.isOnline = true; t.clock.set(new Date());
    const r = await t.engine.syncOnce();
    expect(r.synchronized).toBe(0);
    expect((await t.store.getCapture(t.capture.localId))!.syncState).not.toBe("synchronized");
    expect(await accepted(t.deviceRef)).toBe(0);
    const ref = `${t.deviceRef}:${t.capture.localId}`;
    expect(Number((await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE clientCaptureRef = ?", [ref]))[0][0].n)).toBe(0);
  }, 60_000);
});
