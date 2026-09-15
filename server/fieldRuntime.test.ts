import { beforeAll, describe, expect, it, vi } from "vitest";

// The object store is remote; the scenarios here are about the sync protocol,
// so storage is an in-memory map that keeps exactly the bytes it was given.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));
import mysql from "mysql2/promise";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine, KEY_ROTATION_DAYS, MAX_ITEMS_PER_PACKAGE, prioritizeQueuedCaptures } from "../client/src/runtime/syncEngine";
import { canonicalJson, sha256Hex } from "../client/src/runtime/crypto";
import type { Transport } from "../client/src/runtime/contracts";
import { NATIVE_ONLY_CAPABILITIES } from "../client/src/runtime/adapters/capacitor";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const T0 = new Date("2026-09-10T05:30:00Z");
const bytes = (s: string) => new TextEncoder().encode(s);
const jpeg = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };

function rig(t = T0) {
  const clock = new SettableClock(t);
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  return { clock, keystore, vault, store, outbox: new Outbox(store, vault, clock) };
}

/* ------------------------------------------------------------------ */
/* The outbox: six states, nothing deleted                             */
/* ------------------------------------------------------------------ */

describe("a capture is saved first, and the UI can always say where it is", () => {
  it("moves saved_locally → queued and refuses to queue what is already in flight", async () => {
    const { outbox } = rig();
    const orphan = await outbox.saveDraft({ kind: "fuel_receipt", formKey: "fuel_receipt", title: "Fuel", category: "receipt", fields: { total: 412.5 } });
    await expect(outbox.queue(orphan.localId)).rejects.toThrow(/relates to no job or unit/); // the vault would refuse it; say so now
    const c = await outbox.saveDraft({ kind: "fuel_receipt", formKey: "fuel_receipt", title: "Fuel", category: "receipt", fields: { total: 412.5 }, unitId: 142 });
    expect(c.syncState).toBe("saved_locally");
    expect(c.capturedAt).toBe(T0.toISOString());
    const q = await outbox.queue(c.localId);
    expect(q.syncState).toBe("queued");
    await outbox.markSyncing(c.localId, "PKG-1");
    await expect(outbox.queue(c.localId)).rejects.toThrow(/is syncing/);
    const s = await outbox.status();
    expect(s.counts.syncing).toBe(1);
  });

  it("keeps a device capture time that is not the sync time", async () => {
    const { outbox, clock } = rig();
    const c = await outbox.saveDraft({ kind: "photo", formKey: null, title: "Load", category: "photo", fields: {}, capturedAt: new Date("2026-09-10T02:10:00Z"), jobId: 1 });
    clock.advanceDays(1);
    expect((await outbox.queue(c.localId)).capturedAt).toBe("2026-09-10T02:10:00.000Z");
  });

  it("evicts only synchronized files under storage pressure, and says how many it refused", async () => {
    const { outbox, vault } = rig();
    const a = await outbox.saveDraft({ kind: "photo", formKey: null, title: "a", category: "photo", fields: {}, files: [{ bytes: jpeg(1000), fileName: "a.jpg", mimeType: "image/jpeg" }], jobId: 1 });
    const b = await outbox.saveDraft({ kind: "photo", formKey: null, title: "b", category: "photo", fields: {}, files: [{ bytes: jpeg(1000), fileName: "b.jpg", mimeType: "image/jpeg" }], jobId: 1 });
    await outbox.queue(a.localId); await outbox.markSyncing(a.localId, "P"); await outbox.markSynchronized(a.localId);
    await outbox.queue(b.localId); // queued, not synchronized
    expect(await vault.usageBytes()).toBe(2000);
    const r = await outbox.evictSynchronizedFiles(500);
    expect(r).toEqual({ evicted: 1, freedBytes: 1000, refusedBecauseUnsynced: 1 });
    expect(await vault.usageBytes()).toBe(1000);
    expect((await outbox.status()).counts.queued).toBe(1);
  });
});

describe("the sync queue gives safety evidence precedence over bulk media", () => {
  it("puts a newer HOS event ahead of 500 older photos without reordering a tier", () => {
    const base = (kind: "photo" | "hos_event", localId: string, capturedAt: string) => ({
      localId, kind, formKey: null, title: localId, category: kind, fields: {}, files: [],
      capturedAt, gps: null, jobId: 1, unitId: null, captureAuthorizationClaim: "unknown" as const, captureAuthorizationReason: null,
      syncState: "queued" as const, attempts: 0, lastError: null, serverEvidenceId: null, sealed: false, sealManifestHash: null, packagedIn: null, createdAt: capturedAt, updatedAt: capturedAt,
    });
    const photos = Array.from({ length: MAX_ITEMS_PER_PACKAGE }, (_, i) => base("photo", `P-${String(i).padStart(3, "0")}`, `2026-09-10T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`));
    const hos = base("hos_event", "HOS-NEW", "2026-09-11T23:59:00.000Z");
    const selected = prioritizeQueuedCaptures([...photos, hos]).slice(0, MAX_ITEMS_PER_PACKAGE);
    expect(selected[0].localId).toBe("HOS-NEW");
    expect(selected.filter(c => c.kind === "hos_event")).toHaveLength(1);
    expect(selected.filter(c => c.kind === "photo")).toHaveLength(MAX_ITEMS_PER_PACKAGE - 1);
    expect(selected.filter(c => c.kind === "photo").map(c => c.localId).slice(0, 3)).toEqual(["P-000", "P-001", "P-002"]);
  });
});

/* ------------------------------------------------------------------ */
/* The vault: encrypted, hashed, rotatable                              */
/* ------------------------------------------------------------------ */

describe("files are encrypted at rest with per-file keys wrapped by the device key", () => {
  it("stores ciphertext, returns the plaintext hash, and round-trips", async () => {
    const { vault } = rig();
    const plain = bytes("scale ticket 8,700 kg");
    const put = await vault.put(plain, "text/plain");
    expect(put.contentHash).toBe(await sha256Hex(plain));
    const stored = vault.rawStored(put.vaultRef)!;
    expect(Buffer.from(stored).includes(Buffer.from("8,700"))).toBe(false);
    expect(new TextDecoder().decode(await vault.get(put.vaultRef))).toBe("scale ticket 8,700 kg");
  });

  it("still opens files after the device key rotates", async () => {
    const { vault, keystore } = rig();
    const put = await vault.put(bytes("before rotation"), "text/plain");
    const r = await keystore.rotate();
    expect(r.newFingerprint).not.toBe(r.oldFingerprint);
    expect(new TextDecoder().decode(await vault.get(put.vaultRef))).toBe("before rotation");
    const after = await vault.put(bytes("after"), "text/plain");
    expect(new TextDecoder().decode(await vault.get(after.vaultRef))).toBe("after");
  });

  it("hashes a manifest the same regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });

  it("names what only the native shell can do", () => {
    expect(NATIVE_ONLY_CAPABILITIES).toContain("hardware_keystore");
    expect(NATIVE_ONLY_CAPABILITIES).toContain("camera");
  });
});

/* ------------------------------------------------------------------ */
/* The golden scenario, against the real server                        */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 1_200_000 + Math.floor(Math.random() * 50_000);
const nextUser = () => userSeq++;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

/** The device talks to the real router through createCaller. A flaky flag drops the connection mid-sync. */
function transportFor(userId: number, faults: { dropAfterUploads?: number; dropOnSeal?: boolean; corruptUpload?: boolean } = {}): Transport & { uploads: number; seals: number; packages: number } {
  const c = callerFor(userId);
  const t = {
    uploads: 0, seals: 0, packages: 0,
    async enroll(i: Parameters<Transport["enroll"]>[0]) { const r = await c.device.enroll({ platform: i.platform, publicKeySpkiBase64: i.publicKeySpkiBase64, keystoreAttestation: i.keystoreAttestation, displayName: i.displayName ?? null }); return { deviceRef: r.deviceRef, status: r.status }; },
    async activate(i: { deviceRef: string }) { const r = await c.device.activate(i); return { status: r.status }; },
    async rotateKey(i: Parameters<Transport["rotateKey"]>[0]) { const r = await c.device.rotateKey(i); return { status: String((r as { status?: string }).status ?? "rotated") }; },
    async uploadEvidence(i: Parameters<Transport["uploadEvidence"]>[0]) {
      t.uploads++;
      if (faults.dropAfterUploads != null && t.uploads > faults.dropAfterUploads) throw new Error("ECONNRESET: connection dropped mid-sync");
      const data = faults.corruptUpload ? Buffer.from(Buffer.from(i.dataBase64, "base64").toString("binary") + "x", "binary").toString("base64") : i.dataBase64;
      const r = await c.fieldRoute.evidence.upload({ title: i.title, category: i.category, fileName: i.fileName, mimeType: i.mimeType, dataBase64: data, latitude: i.latitude, longitude: i.longitude, notes: i.notes, clientCaptureRef: i.clientCaptureRef, capturedAt: i.capturedAt });
      return { id: Number(r.id), alreadyUploaded: (r as { alreadyUploaded?: boolean }).alreadyUploaded };
    },
    async sealEvidence(i: Parameters<Transport["sealEvidence"]>[0]) {
      t.seals++;
      if (faults.dropOnSeal) throw new Error("ETIMEDOUT during seal");
      try { const r = await c.records.evidence.seal({ evidenceId: i.evidenceId, contentHash: i.contentHash, recordType: i.recordType, relationships: i.relationships as never, deviceId: i.deviceId, devicePlatform: i.devicePlatform }); return { ok: true as const, alreadySealed: false, manifestHash: (r as { manifestHash?: string }).manifestHash ?? null }; }
      catch (e) {
        if (/already (sealed|amended)/i.test(e instanceof Error ? e.message : "")) {
          // A retry after a crash between seal and store: read the seal back.
          const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT manifestHash FROM evidenceSeals WHERE evidenceRecordId = ? ORDER BY version DESC LIMIT 1", [i.evidenceId]);
          return { ok: true as const, alreadySealed: true, manifestHash: rows[0] ? String(rows[0].manifestHash) : null };
        }
        throw e;
      }
    },
    async receivePackage(i: Parameters<Transport["receivePackage"]>[0]) { t.packages++; return c.sync.receivePackage(i) as never; },
  };
  return t;
}

d("a driver starts the day offline", () => {
  it("captures for hours, drops the connection mid-sync, reconnects, and the office receives everything exactly once", async () => {
    const driver = await withRole("driver");
    const safety = await withRole("safety");
    const { clock, keystore, vault, store, outbox } = rig();
    const net = new FlagConnectivity(false);
    const transport = transportFor(driver);
    const engine = new SyncEngine({ store, vault, keystore, transport, connectivity: net, clock, platform: "android" });

    // Enrolled and activated from the tablet while online yesterday — activation is the device's own step.
    net.isOnline = true;
    const enrolled = await engine.enroll("Tablet 7");
    expect((await engine.activate()).status).toBe("active");
    net.isOnline = false;

    // 05:30 pre-trip, 06:10 load photo, 09:40 fuel receipt, 11:15 disposal ticket, 13:00 defect — all offline.
    const pretrip = await outbox.saveDraft({ kind: "pretrip", formKey: null, title: "Pre-trip Unit 142", category: "inspection", fields: { unit: "142", defects: 0, brakes: "ok" }, unitId: 142 });
    clock.set(new Date("2026-09-10T06:10:00Z"));
    const photo = await outbox.saveDraft({ kind: "photo", formKey: null, title: "Load 1 — tank full", category: "photo", fields: {}, files: [{ bytes: jpeg(4096), fileName: "load1.jpg", mimeType: "image/jpeg" }], gps: { latitude: 53.5, longitude: -113.4, accuracyM: 8, fixedAt: clock.now().toISOString(), source: "device_gps" }, jobId: 1, captureAuthorizationClaim: "unauthorized", captureAuthorizationReason: "Authorization context unavailable in the dead zone" });
    clock.set(new Date("2026-09-10T09:40:00Z"));
    const fuel = await outbox.saveDraft({ kind: "fuel_receipt", formKey: "fuel_receipt", title: "Cardlock Nisku", category: "receipt", fields: { total: 412.5, quantity: 275, jurisdiction: "CA-AB" }, files: [{ bytes: jpeg(2048), fileName: "fuel.jpg", mimeType: "image/jpeg" }], unitId: 142 });
    clock.set(new Date("2026-09-10T11:15:00Z"));
    const ticket = await outbox.saveDraft({ kind: "disposal_ticket", formKey: "disposal_ticket", title: "Facility ticket 88192", category: "ticket", fields: { grossKg: 41200, tareKg: 18900, netKg: 22300 }, files: [{ bytes: jpeg(3000), fileName: "ticket.jpg", mimeType: "image/jpeg" }], jobId: 1 });
    clock.set(new Date("2026-09-10T13:00:00Z"));
    const defect = await outbox.saveDraft({ kind: "defect_report", formKey: "defect_report", title: "Hydraulic hose weeping at PTO", category: "defect", fields: { severity: "minor" }, unitId: 142 });
    for (const c of [pretrip, photo, fuel, ticket, defect]) await outbox.queue(c.localId);

    // Offline: sync does nothing, says why, and everything stays queued.
    const off = await engine.syncOnce();
    expect(off.attempted).toBe(false);
    expect(off.reason).toContain("Offline");
    expect((await outbox.status()).counts.queued).toBe(5);
    expect((await outbox.status()).oldestUnsyncedCaptureMinutes).toBeGreaterThan(400); // the pre-trip at 05:30, now 13:00

    // 13:30: signal returns — and drops after two uploads. Two captures sync; three fail with the reason; nothing is lost.
    net.isOnline = true;
    const flaky = transportFor(driver, { dropAfterUploads: 2 });
    const engine2 = new SyncEngine({ store, vault, keystore, transport: flaky, connectivity: net, clock, platform: "android" });
    const first = await engine2.syncOnce();
    expect(first.attempted).toBe(true);
    expect(first.synchronized).toBe(2);
    expect(first.failed).toBe(3);
    const afterDrop = await outbox.status();
    expect(afterDrop.counts.synchronized).toBe(2);
    expect(afterDrop.counts.failed).toBe(3);
    expect((await store.getCapture(fuel.localId))!.lastError).toContain("ECONNRESET");

    // The worker re-queues the failed ones (or the app does on reconnect). The retry re-sends the same
    // capture references: the server returns the same ids, and no duplicate evidence appears.
    for (const c of await store.listCaptures({ syncState: "failed" })) await outbox.queue(c.localId);
    const second = await engine.syncOnce();
    expect(second.synchronized).toBe(3);
    expect(second.failed).toBe(0);
    expect((await outbox.status()).counts.synchronized).toBe(5);
    const refs = [pretrip, photo, fuel, ticket, defect].map(c => `${enrolled.deviceRef}:${c.localId}`);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(`SELECT clientCaptureRef, sealState, capturedAt, createdAt FROM evidenceRecords WHERE clientCaptureRef IN (${refs.map(() => "?").join(",")})`, refs);
    expect(rows).toHaveLength(5);                                          // exactly once each
    expect(rows.every(r => r.sealState === "sealed")).toBe(true);
    const fuelRow = rows.find(r => r.clientCaptureRef === `${enrolled.deviceRef}:${fuel.localId}`)!;
    expect(new Date(fuelRow.capturedAt).toISOString()).toBe("2026-09-10T09:40:00.000Z"); // the device's time
    expect(new Date(fuelRow.createdAt).getTime()).toBeGreaterThan(new Date(fuelRow.capturedAt).getTime()); // the server's

    // The packages are on the server, admitted under the device's fingerprint, every item verified.
    const [pkgs] = await pool.execute<mysql.RowDataPacket[]>("SELECT state, itemCount, signedWithFingerprint FROM syncPackages WHERE deviceId = ? ORDER BY id", [enrolled.deviceRef]);
    expect(pkgs.map(p => p.state)).toEqual(["hash_verified", "hash_verified"]);
    expect(pkgs.map(p => Number(p.itemCount))).toEqual([2, 3]);
    expect(pkgs[0].signedWithFingerprint).toBe(await keystore.fingerprint());

    // Recording and authorization are separate facts. The photo survives and
    // synchronizes, but successful sync does not rewrite its capture-time claim.
    const [authClaims] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT e.clientCaptureRef, i.captureAuthorizationClaim, i.captureAuthorizationReason FROM syncPackageItems i JOIN evidenceRecords e ON e.id=i.evidenceRecordId WHERE e.clientCaptureRef IN (?, ?)",
      [`${enrolled.deviceRef}:${photo.localId}`, `${enrolled.deviceRef}:${fuel.localId}`],
    );
    const photoClaim = authClaims.find(r => r.clientCaptureRef === `${enrolled.deviceRef}:${photo.localId}`)!;
    const fuelClaim = authClaims.find(r => r.clientCaptureRef === `${enrolled.deviceRef}:${fuel.localId}`)!;
    expect(photoClaim.captureAuthorizationClaim).toBe("unauthorized");
    expect(photoClaim.captureAuthorizationReason).toContain("dead zone");
    expect(fuelClaim.captureAuthorizationClaim).toBe("unknown");
  });

  it("marks the right capture failed when the server's bytes do not match the device's seal", async () => {
    const driver = await withRole("driver");
    const { clock, keystore, vault, store, outbox } = rig();
    const net = new FlagConnectivity(true);
    const clean = transportFor(driver);
    const engine = new SyncEngine({ store, vault, keystore, transport: clean, connectivity: net, clock, platform: "ios" });
    await engine.enroll(); await engine.activate();

    // A good capture, synced cleanly.
    const good = await outbox.saveDraft({ kind: "photo", formKey: null, title: "ok", category: "photo", fields: {}, files: [{ bytes: jpeg(500), fileName: "ok.jpg", mimeType: "image/jpeg" }], unitId: 142 });
    await outbox.queue(good.localId);
    const r1 = await engine.syncOnce();
    expect(r1.synchronized, (await store.getCapture(good.localId))!.lastError ?? "").toBe(1);

    // A capture whose bytes are altered between the device and the server: the server recomputes the
    // hash from what it stored, it does not match the seal, and THIS capture — not the good one — fails.
    const corrupt = transportFor(driver, { corruptUpload: true });
    const engineBad = new SyncEngine({ store, vault, keystore, transport: corrupt, connectivity: net, clock, platform: "ios" });
    const bad = await outbox.saveDraft({ kind: "photo", formKey: null, title: "tampered", category: "photo", fields: {}, files: [{ bytes: jpeg(600), fileName: "bad.jpg", mimeType: "image/jpeg" }], unitId: 142 });
    await outbox.queue(bad.localId);
    const r2 = await engineBad.syncOnce();
    expect(r2.synchronized).toBe(0);
    expect(r2.failed).toBe(1);
    const b = (await store.getCapture(bad.localId))!;
    expect(b.syncState).toBe("failed");
    expect(b.lastError).toMatch(/hash|seal|bytes/i);
    expect((await store.getCapture(good.localId))!.syncState).toBe("synchronized");
  });

  it("stops after revocation and keeps the captures, and rotates an old key before pushing", async () => {
    const driver = await withRole("driver");
    const safety = await withRole("safety");
    const { clock, keystore, vault, store, outbox } = rig();
    const net = new FlagConnectivity(true);
    const transport = transportFor(driver);
    const engine = new SyncEngine({ store, vault, keystore, transport, connectivity: net, clock, platform: "android" });
    const e = await engine.enroll(); await engine.activate();

    // Key is 45 days old: the engine rotates before it pushes, and the push is admitted under the new key.
    clock.advanceDays(KEY_ROTATION_DAYS + 15);
    const c1 = await outbox.saveDraft({ kind: "tailgate", formKey: null, title: "Tailgate", category: "safety", fields: { hazards: ["overhead lines"] }, jobId: 1 });
    await outbox.queue(c1.localId);
    const oldFp = await keystore.fingerprint();
    const r1 = await engine.syncOnce();
    expect(r1.rotatedKey).toBe(true);
    expect(r1.synchronized, `${r1.reason} | ${(await store.getCapture(c1.localId))!.lastError ?? ""}`).toBe(1);
    expect(await keystore.fingerprint()).not.toBe(oldFp);

    // The office revokes the device. The next push is refused, the capture is kept as failed with the reason, and the engine stops trying.
    await callerFor(safety).device.revoke({ deviceRef: e.deviceRef, reason: "Tablet reported lost" });
    const c2 = await outbox.saveDraft({ kind: "incident", formKey: null, title: "Near miss", category: "incident", fields: { statement: "Backing, spotter lost sight" }, unitId: 142 });
    await outbox.queue(c2.localId);
    const r2 = await engine.syncOnce();
    expect(r2.deviceStatus).toBe("revoked");
    expect(r2.synchronized).toBe(0);
    const kept = (await store.getCapture(c2.localId))!;
    expect(kept.syncState).toBe("failed");
    expect(kept.lastError).toMatch(/revoked/i);
    const r3 = await engine.syncOnce();
    expect(r3.attempted).toBe(false);
    expect(r3.reason).toContain("recapture on an enrolled device");
    expect((await store.listCaptures()).length).toBe(2); // nothing deleted
  });
});
