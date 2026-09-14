/**
 * v22.20 — the package the truck actually carries.
 *
 * The server has sealed, served, acknowledged and staled communication
 * packages since v22.19. None of that helps a driver 60 km up a resource road,
 * because nothing put the package on the device. This does.
 *
 * It is built on the runtime abstractions that already exist — `FileVault` for
 * encrypted bytes, `LocalStore` for metadata — and introduces no second
 * storage system. The only new thing is a narrow port for the one operation
 * `Transport` does not have, so the adapters do not all have to change to add
 * one read.
 *
 * The invariant worth stating plainly: **what the device carries is what the
 * device verified, not what the server said it sent.** Every hash here is
 * recomputed on this side. A package that arrives corrupted is refused and
 * nothing is stored; a package that fails to survive the write is deleted
 * rather than recorded; and the acknowledgement sent back to the server
 * carries the hash read *out of the vault*, so a bad write cannot report
 * success.
 */

import { sha256Hex } from "./crypto";
import type { FileVault, LocalStore } from "./contracts";

/** The one operation Transport lacks. Composed with it, never replacing it. */
export interface CommunicationPackageSource {
  fetchPackage(input: { packageRef: string }): Promise<{
    packageRef: string;
    label: string;
    version: number;
    routeApprovalRef: string | null;
    manifestHash: string;
    /** Canonical JSON of the sealed content, exactly as the server hashed it. */
    contentJson: string;
  }>;
  acknowledgePackage(input: { packageRef: string; storedManifestHash: string; deviceRef: string }): Promise<{ carried: boolean }>;
}

export type CarriedPackage = {
  packageRef: string;
  label: string;
  version: number;
  routeApprovalRef: string | null;
  vaultRef: string;
  /** What the server said the package hashes to. */
  manifestHash: string;
  /** What this device computed after reading its own vault. They must match. */
  storedHash: string;
  bytes: number;
  storedAt: string;
  acknowledged: boolean;
};

export type CarryOutcome =
  | { outcome: "carried"; carried: CarriedPackage }
  | { outcome: "refused"; reason: "manifest_mismatch" | "vault_write_corrupt" | "readback_failed"; detail: string };

const INDEX_KEY = "comms.carriedPackages.v1";
const enc = new TextEncoder();

async function readIndex(store: LocalStore): Promise<CarriedPackage[]> {
  const raw = await store.getMeta(INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as CarriedPackage[]; } catch { return []; }
}

async function writeIndex(store: LocalStore, list: readonly CarriedPackage[]): Promise<void> {
  await store.setMeta(INDEX_KEY, JSON.stringify(list));
}

/**
 * Fetch a package, verify it, store it encrypted, read it back, and only then
 * tell the server it is carried.
 *
 * The read-back is not belt-and-braces. A vault write that silently truncates
 * would otherwise be acknowledged as carried, and the driver would discover it
 * at the moment the package is the only thing they have.
 */
export async function carryCommunicationPackage(
  deps: { source: CommunicationPackageSource; vault: FileVault; store: LocalStore; deviceRef: string; now?: () => Date },
  input: { packageRef: string },
): Promise<CarryOutcome> {
  const fetched = await deps.source.fetchPackage({ packageRef: input.packageRef });
  const bytes = enc.encode(fetched.contentJson);

  // 1. Does the content hash to what the server said it does?
  const computed = await sha256Hex(bytes);
  if (computed !== fetched.manifestHash) {
    return {
      outcome: "refused",
      reason: "manifest_mismatch",
      detail: `The package did not survive the journey: the server sealed ${fetched.manifestHash.slice(0, 12)}… and this device computed ${computed.slice(0, 12)}…. Nothing was stored.`,
    };
  }

  // 2. Store it, and check the vault agrees about what it stored.
  const put = await deps.vault.put(bytes, "application/json");
  if (put.contentHash !== computed) {
    await deps.vault.delete(put.vaultRef).catch(() => undefined);
    return { outcome: "refused", reason: "vault_write_corrupt", detail: "The vault reported a different hash than the bytes handed to it. The entry was deleted rather than recorded." };
  }

  // 3. Read it back out. What is carried is what can be read, not what was sent.
  let readBack: Uint8Array;
  try {
    readBack = await deps.vault.get(put.vaultRef);
  } catch (e) {
    await deps.vault.delete(put.vaultRef).catch(() => undefined);
    return { outcome: "refused", reason: "readback_failed", detail: `The package could not be read back after writing: ${(e as Error).message}` };
  }
  const storedHash = await sha256Hex(readBack);
  if (storedHash !== computed) {
    await deps.vault.delete(put.vaultRef).catch(() => undefined);
    return { outcome: "refused", reason: "readback_failed", detail: "The bytes read back from the vault do not hash to the package that was written. The entry was deleted." };
  }

  const carried: CarriedPackage = {
    packageRef: fetched.packageRef, label: fetched.label, version: fetched.version,
    routeApprovalRef: fetched.routeApprovalRef, vaultRef: put.vaultRef,
    manifestHash: fetched.manifestHash, storedHash, bytes: put.bytes,
    storedAt: (deps.now?.() ?? new Date()).toISOString(), acknowledged: false,
  };

  // 4. Index it before acknowledging. A device that loses connectivity between
  //    the write and the acknowledgement is still carrying the package, and must
  //    know that it is.
  const index = await readIndex(deps.store);
  const next = [carried, ...index.filter(p => p.packageRef !== carried.packageRef)];
  await writeIndex(deps.store, next);

  // 5. Acknowledge with the hash read out of the vault — never the one fetched.
  try {
    const ack = await deps.source.acknowledgePackage({ packageRef: carried.packageRef, storedManifestHash: storedHash, deviceRef: deps.deviceRef });
    if (ack.carried) {
      carried.acknowledged = true;
      await writeIndex(deps.store, [carried, ...next.filter(p => p.packageRef !== carried.packageRef)]);
    }
  } catch {
    // Offline again already. The package is carried; the server does not know
    // yet, and that is a reporting gap rather than a carrying one.
  }
  return { outcome: "carried", carried };
}

export type ReadOutcome =
  | { outcome: "read"; contentJson: string; carried: CarriedPackage }
  | { outcome: "not_carried" }
  | { outcome: "tampered"; detail: string };

/**
 * Read a carried package with no network at all.
 *
 * The hash is checked again on every read. A vault entry that has changed
 * since it was stored is refused rather than displayed: a driver acting on a
 * communication plan needs it to be the plan that was sealed, and "probably
 * fine" is not a state this system has.
 */
export async function readCarriedPackage(
  deps: { vault: FileVault; store: LocalStore },
  packageRef: string,
): Promise<ReadOutcome> {
  const carried = (await readIndex(deps.store)).find(p => p.packageRef === packageRef);
  if (!carried) return { outcome: "not_carried" };
  let bytes: Uint8Array;
  try {
    bytes = await deps.vault.get(carried.vaultRef);
  } catch (e) {
    return { outcome: "tampered", detail: `The vault entry for this package could not be read: ${(e as Error).message}` };
  }
  const hash = await sha256Hex(bytes);
  if (hash !== carried.storedHash) {
    return { outcome: "tampered", detail: `This package no longer matches what was stored (${carried.storedHash.slice(0, 12)}… became ${hash.slice(0, 12)}…). It will not be shown.` };
  }
  return { outcome: "read", contentJson: new TextDecoder().decode(bytes), carried };
}

/** Everything this device is carrying, newest first. Reads nothing from the network. */
export async function carriedPackages(store: LocalStore): Promise<CarriedPackage[]> {
  return readIndex(store);
}

/**
 * What the driver is carrying for a route, against what they were told exists.
 * The server's own `packageStatus` decides staleness; this answers the narrower
 * question the device can answer alone, which is whether it has the version it
 * was last told about.
 */
export function carriedVersionState(
  carried: CarriedPackage | undefined,
  knownCurrentVersion: number | null,
): { state: "current" | "behind" | "none" | "unknown"; reason: string } {
  if (!carried) return { state: "none", reason: "This device is not carrying a communication package for this route" };
  if (knownCurrentVersion == null) return { state: "unknown", reason: `Carrying version ${carried.version}; this device has not been told what the current version is` };
  if (carried.version < knownCurrentVersion) return { state: "behind", reason: `Carrying version ${carried.version}; version ${knownCurrentVersion} exists. Refresh before leaving coverage.` };
  return { state: "current", reason: `Carrying version ${carried.version}, the latest this device has been told about` };
}
