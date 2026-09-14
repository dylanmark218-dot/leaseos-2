/**
 * v22.20 — carrying the package, proven in Node against the runtime contracts.
 *
 * The native adapters are still stubs; the logic is not. These fakes implement
 * the same `FileVault` and `LocalStore` interfaces the real adapters do, which
 * is how the rest of this runtime is proven.
 */
import { describe, expect, it } from "vitest";
import { carriedPackages, carriedVersionState, carryCommunicationPackage, readCarriedPackage, type CommunicationPackageSource } from "../client/src/runtime/commsVault";
import { sha256Hex } from "../client/src/runtime/crypto";
import type { FileVault, LocalStore } from "../client/src/runtime/contracts";

function fakeVault(opts: { corruptOnWrite?: boolean; mutateAfter?: boolean; failRead?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  let n = 0;
  const vault: FileVault = {
    async put(bytes) {
      const vaultRef = `V-${++n}`;
      files.set(vaultRef, bytes);
      const contentHash = opts.corruptOnWrite ? "0".repeat(64) : await sha256Hex(bytes);
      return { vaultRef, contentHash, bytes: bytes.length };
    },
    async get(vaultRef) {
      if (opts.failRead) throw new Error("vault unavailable");
      const b = files.get(vaultRef);
      if (!b) throw new Error("no such vault entry");
      return opts.mutateAfter ? new TextEncoder().encode("tampered") : b;
    },
    async delete(vaultRef) { files.delete(vaultRef); },
    async usageBytes() { return [...files.values()].reduce((s, b) => s + b.length, 0); },
  };
  return { vault, files };
}

function fakeStore(): LocalStore {
  const meta = new Map<string, string>();
  return {
    putCapture: async () => undefined, getCapture: async () => null, listCaptures: async () => [],
    putPackage: async () => undefined, listPackages: async () => [],
    getMeta: async k => meta.get(k) ?? null,
    setMeta: async (k, v) => { meta.set(k, v); },
  };
}

const CONTENT = JSON.stringify({ formatVersion: 1, totalKm: 13.7, verdict: "unknown", zones: [{ channelKey: "LAD-4", transmit: "unknown" }] });

async function source(over: Partial<{ manifestHash: string; contentJson: string; ackThrows: boolean; ackCarried: boolean }> = {}): Promise<CommunicationPackageSource> {
  const contentJson = over.contentJson ?? CONTENT;
  const manifestHash = over.manifestHash ?? (await sha256Hex(new TextEncoder().encode(contentJson)));
  return {
    async fetchPackage() { return { packageRef: "COMMPKG-1", label: "Fox Creek run", version: 3, routeApprovalRef: "RA-1", manifestHash, contentJson }; },
    async acknowledgePackage() { if (over.ackThrows) throw new Error("offline"); return { carried: over.ackCarried ?? true }; },
  };
}

describe("what the device carries is what the device verified", () => {
  it("stores the package, reads it back, and acknowledges with the hash it read out of the vault", async () => {
    const { vault } = fakeVault();
    const store = fakeStore();
    let ackHash = "";
    const src = await source();
    const spy: CommunicationPackageSource = { ...src, async acknowledgePackage(i) { ackHash = i.storedManifestHash; return { carried: true }; } };

    const r = await carryCommunicationPackage({ source: spy, vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    expect(r.outcome).toBe("carried");
    if (r.outcome !== "carried") return;
    expect(r.carried.acknowledged).toBe(true);
    expect(ackHash).toBe(r.carried.storedHash);
    expect(r.carried.storedHash).toBe(r.carried.manifestHash);
  });

  it("refuses a package that did not survive the journey, and stores nothing", async () => {
    const { vault, files } = fakeVault();
    const store = fakeStore();
    const r = await carryCommunicationPackage({ source: await source({ manifestHash: "a".repeat(64) }), vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    expect(r).toMatchObject({ outcome: "refused", reason: "manifest_mismatch" });
    expect(files.size).toBe(0);
    expect(await carriedPackages(store)).toHaveLength(0);
  });

  it("deletes and refuses when the vault disagrees about what it stored", async () => {
    const { vault, files } = fakeVault({ corruptOnWrite: true });
    const store = fakeStore();
    const r = await carryCommunicationPackage({ source: await source(), vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    expect(r).toMatchObject({ outcome: "refused", reason: "vault_write_corrupt" });
    expect(files.size).toBe(0);
  });

  it("refuses when the bytes cannot be read back, rather than reporting a package it cannot produce", async () => {
    const { vault } = fakeVault({ failRead: true });
    const r = await carryCommunicationPackage({ source: await source(), vault, store: fakeStore(), deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    expect(r).toMatchObject({ outcome: "refused", reason: "readback_failed" });
  });

  it("still carries the package when the acknowledgement fails — losing signal is a reporting gap, not a carrying one", async () => {
    const store = fakeStore();
    const r = await carryCommunicationPackage({ source: await source({ ackThrows: true }), vault: fakeVault().vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    expect(r.outcome).toBe("carried");
    const [held] = await carriedPackages(store);
    expect(held.acknowledged).toBe(false);
    expect(held.packageRef).toBe("COMMPKG-1");
  });
});

describe("reading it with no network at all", () => {
  it("returns the sealed content byte for byte", async () => {
    const { vault } = fakeVault();
    const store = fakeStore();
    await carryCommunicationPackage({ source: await source(), vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    const read = await readCarriedPackage({ vault, store }, "COMMPKG-1");
    expect(read.outcome).toBe("read");
    if (read.outcome !== "read") return;
    expect(read.contentJson).toBe(CONTENT);
    expect(JSON.parse(read.contentJson).zones[0].channelKey).toBe("LAD-4");
  });

  it("says not carried rather than empty when the device never had it", async () => {
    expect(await readCarriedPackage({ vault: fakeVault().vault, store: fakeStore() }, "COMMPKG-NOPE")).toMatchObject({ outcome: "not_carried" });
  });

  it("refuses to show a package that changed after it was stored", async () => {
    const store = fakeStore();
    const good = fakeVault();
    await carryCommunicationPackage({ source: await source(), vault: good.vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    // Same stored index, a vault that now returns something else.
    const tampered = fakeVault({ mutateAfter: true });
    await tampered.vault.put(new TextEncoder().encode(CONTENT), "application/json");
    const read = await readCarriedPackage({ vault: tampered.vault, store }, "COMMPKG-1");
    expect(read.outcome).toBe("tampered");
    if (read.outcome !== "tampered") return;
    expect(read.detail).toContain("no longer matches what was stored");
  });
});

describe("what the driver is told about the version they hold", () => {
  it("names behind, current, none and unknown without guessing", async () => {
    const store = fakeStore();
    await carryCommunicationPackage({ source: await source(), vault: fakeVault().vault, store, deviceRef: "D-1" }, { packageRef: "COMMPKG-1" });
    const [held] = await carriedPackages(store);
    expect(carriedVersionState(held, 4)).toMatchObject({ state: "behind" });
    expect(carriedVersionState(held, 4).reason).toContain("Refresh before leaving coverage");
    expect(carriedVersionState(held, 3)).toMatchObject({ state: "current" });
    expect(carriedVersionState(held, null)).toMatchObject({ state: "unknown" });
    expect(carriedVersionState(undefined, 4)).toMatchObject({ state: "none" });
  });
});
