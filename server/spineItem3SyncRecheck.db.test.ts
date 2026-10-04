/**
 * SPINE item 3 follow-up — on reconnect the server re-checks the offline policy itself.
 *
 *   queued capture → sync.receivePackage → admission, scope, hashes → the operation the SERVER's seal
 *   recorded → the one requiresOnline declaration, via mayRunWithoutServer → accept / refuse
 *
 * The device's gate (#143) is UX and offline correctness. This is authority: a stale or modified
 * client that labels, classifies or flags its way past its own gate is refused here, and a policy
 * that changed after capture applies as it is now. Passing it authorizes nothing; who may act is still
 * decided by admission, the acting scope and the procedure permission, which run first.
 *
 * Organization change and permission revocation between capture and sync are already pinned against
 * the gated outbox by `spineItem3Reconnect.db.test.ts`; they are not repeated here.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

/* The policy as the server sees it at sync. Overridable per test, to show the current answer wins. */
const serverPolicy = vi.hoisted(() => ({ nowRequiresOnline: new Set<string>() }));
vi.mock("./_core/captureOperations", async orig => {
  const real = await orig<typeof import("./_core/captureOperations")>();
  return {
    ...real,
    capturePolicyFor: (kind: string | null | undefined) => {
      const p = real.capturePolicyFor(kind);
      return p && kind && serverPolicy.nowRequiresOnline.has(kind) ? { ...p, requiresOnline: true } : p;
    },
  };
});

import mysql from "mysql2/promise";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock, memoryProbes } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import { captureGate } from "../client/src/runtime/capabilities";
import type { Transport } from "../client/src/runtime/contracts";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 937_000_000 + Math.floor(Math.random() * 50_000);
beforeAll(async () => { if (URL) pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function driver() { const id = seq++; await grantUserRole({ userId: id, role: "driver", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

type Tamper = { sealAs?: string; secondSealAs?: string; packageExtras?: Record<string, unknown> };

/** The device talks to the real router. `tamper` is a stale or modified client. */
function transportFor(userId: number, tamper: Tamper = {}): Transport & { secondSealError?: unknown } {
  const c = callerFor(userId);
  const t: Transport & { secondSealError?: unknown } = {
    async enroll(i) { const r = await c.device.enroll({ platform: i.platform, publicKeySpkiBase64: i.publicKeySpkiBase64, keystoreAttestation: i.keystoreAttestation, displayName: i.displayName ?? null }); return { deviceRef: r.deviceRef, status: r.status }; },
    async activate(i) { const r = await c.device.activate(i); return { status: r.status }; },
    async rotateKey(i) { const r = await c.device.rotateKey(i); return { status: String((r as { status?: string }).status ?? "rotated") }; },
    async uploadEvidence(i) { const r = await c.fieldRoute.evidence.upload({ title: i.title, category: i.category, fileName: i.fileName, mimeType: i.mimeType, dataBase64: i.dataBase64, latitude: i.latitude, longitude: i.longitude, notes: i.notes, clientCaptureRef: i.clientCaptureRef, capturedAt: i.capturedAt }); return { id: Number(r.id), alreadyUploaded: (r as { alreadyUploaded?: boolean }).alreadyUploaded }; },
    async sealEvidence(i) {
      const r = await c.records.evidence.seal({ evidenceId: i.evidenceId, contentHash: i.contentHash, recordType: tamper.sealAs ?? i.recordType, relationships: i.relationships as never, deviceId: i.deviceId, devicePlatform: i.devicePlatform });
      if (tamper.secondSealAs) {
        // Relabel attempt: seal the same evidence again as a different operation.
        try { await c.records.evidence.seal({ evidenceId: i.evidenceId, contentHash: i.contentHash, recordType: tamper.secondSealAs, relationships: i.relationships as never }); }
        catch (e) { t.secondSealError = e; }
      }
      return { ok: true as const, alreadySealed: false, manifestHash: (r as { manifestHash?: string }).manifestHash ?? null };
    },
    async receivePackage(i) {
      // Client policy metadata riding on the items. The device signed the items without it.
      const items = tamper.packageExtras ? i.items.map(it => ({ ...it, ...tamper.packageExtras })) : i.items;
      return c.sync.receivePackage({ ...i, items } as never) as never;
    },
  };
  return t;
}

/** Enrolled online, then offline for a defect report made through the gated outbox. */
async function tablet(userId: number, tamper: Tamper = {}) {
  const clock = new SettableClock(new Date());
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const net = new FlagConnectivity(true);
  const transport = transportFor(userId, tamper);
  const engine = new SyncEngine({ store, vault, keystore, transport, connectivity: net, clock, platform: "android" });
  const enrolled = await engine.enroll("Tablet");
  await engine.activate();
  net.isOnline = false;
  const outbox = new Outbox(store, vault, clock, captureGate({ probes: memoryProbes(), connectivity: net }));
  const capture = await outbox.saveDraft({ kind: "defect_report", formKey: "defect_report", title: "Hose weeping", category: "defect", fields: { severity: "minor" }, unitId: 142 });
  await outbox.queue(capture.localId);
  const sync = async () => { net.isOnline = true; clock.set(new Date()); return engine.syncOnce(); };
  return { engine, store, vault, keystore, clock, transport, sync, capture, deviceRef: enrolled.deviceRef };
}
const receiptFor = async (packageRef: string | null) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT r.matched, r.failureDetail FROM syncReceipts r JOIN syncPackages p ON p.id = r.syncPackageId WHERE p.packageRef = ?", [packageRef]))[0];

d("the server re-derives the offline policy from its own seal and the one declaration", () => {
  it("accepts an offline-safe capture the device sealed honestly", async () => {
    const t = await tablet(await driver());
    const r = await t.sync();
    expect(r.synchronized, (await t.store.getCapture(t.capture.localId))!.lastError ?? "").toBe(1);
  }, 60_000);

  it("refuses a connected-required operation a stale client recorded as offline evidence, as a row with the reason", async () => {
    const t = await tablet(await driver(), { sealAs: "board_message" });
    const r = await t.sync();
    expect(r.synchronized).toBe(0);
    const c = (await t.store.getCapture(t.capture.localId))!;
    expect(c.syncState).toBe("failed");
    expect(c.lastError).toMatch(/connected-required/i);
    const [row] = await receiptFor(r.packageRef);
    expect(Number(row.matched)).toBe(0);
    expect(row.failureDetail).toMatch(/offline policy/i);
  }, 60_000);

  it("fails closed on an operation the declaration does not know", async () => {
    const t = await tablet(await driver(), { sealAs: "oos_release" });
    const r = await t.sync();
    expect(r.synchronized).toBe(0);
    expect((await t.store.getCapture(t.capture.localId))!.lastError).toMatch(/not an operation/i);
  }, 60_000);

  it("ignores client policy metadata: offlineAllowed / requiresOnline / an operation key on the item change nothing", async () => {
    const extras = { offlineAllowed: true, requiresOnline: false, operationKey: "defect_report", policyResult: "capture_locally" };
    const refused = await tablet(await driver(), { sealAs: "board_message", packageExtras: extras });
    expect((await refused.sync()).synchronized).toBe(0);
    const accepted = await tablet(await driver(), { packageExtras: { ...extras, offlineAllowed: false, requiresOnline: true } });
    expect((await accepted.sync()).synchronized).toBe(1);
  }, 60_000);

  it("applies the policy as it is at sync: offline-safe when captured, connected-required now, refused", async () => {
    const t = await tablet(await driver());
    serverPolicy.nowRequiresOnline.add("defect_report");
    try {
      const r = await t.sync();
      expect(r.synchronized).toBe(0);
      expect((await t.store.getCapture(t.capture.localId))!.lastError).toMatch(/connected-required/i);
    } finally {
      serverPolicy.nowRequiresOnline.clear();
    }
  }, 60_000);
});

d("the operation identity cannot be changed after it is sealed", () => {
  it("refuses a relabel: the same evidence cannot be sealed again as another operation, and it is judged as first sealed", async () => {
    const t = await tablet(await driver(), { secondSealAs: "board_message" });
    const r = await t.sync();
    expect(String((t.transport.secondSealError as Error | undefined)?.message ?? "")).toMatch(/already sealed/i);
    expect(r.synchronized).toBe(1);
  }, 60_000);

  it("does not duplicate the evidence when the same capture is replayed", async () => {
    const t = await tablet(await driver());
    expect((await t.sync()).synchronized).toBe(1);
    const c = (await t.store.getCapture(t.capture.localId))!;
    await t.store.putCapture({ ...c, syncState: "queued" });   // a device replaying its queue
    await t.sync();
    const ref = `${t.deviceRef}:${t.capture.localId}`;
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE clientCaptureRef = ?", [ref]);
    expect(Number(row.n)).toBe(1);
  }, 60_000);
});

d("passing the offline policy is not authorization", () => {
  it("an offline-safe capture pushed by someone the device is not enrolled to is refused", async () => {
    const owner = await driver(), other = await driver();
    const t = await tablet(owner);
    // The same tablet — same key, same vault, same queue — pushed as another person.
    const theirs = new SyncEngine({ store: t.store, vault: t.vault, keystore: t.keystore, transport: transportFor(other), connectivity: new FlagConnectivity(true), clock: t.clock, platform: "android" });
    t.clock.set(new Date());
    const r = await theirs.syncOnce();
    expect(r.synchronized).toBe(0);
    const c = (await t.store.getCapture(t.capture.localId))!;
    expect(c.syncState).toBe("failed");
    expect(c.lastError).toMatch(/enrolled to another user/);
  }, 60_000);

  it("a caller with no sync permission is refused before any item is examined", async () => {
    const nobody = seq++;
    await expect(callerFor(nobody).sync.receivePackage({
      deviceRef: "DEV-NONE", signedWithFingerprint: "a".repeat(64), signedAt: new Date(), nonce: "n".repeat(24),
      signatureP1363Base64: "A".repeat(88), packageRef: "PKG-NONE", queuedAt: new Date(),
      items: [{ evidenceRecordId: 1, declaredContentHash: "a".repeat(64), declaredManifestHash: "b".repeat(64), computedContentHash: "a".repeat(64), computedManifestHash: "b".repeat(64), captureAuthorizationClaim: "authorized" }],
      recordUpdates: [],
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
