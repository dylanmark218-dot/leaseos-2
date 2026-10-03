/**
 * HS1 — what this runtime can actually do, probed rather than assumed.
 *
 * Exactly the surface frozen in `docs/hybrid-seam/HS_CONTRACTS.md` §1: six booleans and
 * `capabilities()`. It aggregates the per-binding `available()` probes in `adapters/capacitor.ts`. A
 * false entry means that capability will throw `NotOnDeviceError`, never that it will degrade.
 *
 * It answers a physical question about the device and nothing else. Whether an operation may run or
 * queue while disconnected is a separate, shared rule; whether a person may do something is the
 * server's procedure gate. Neither reads this matrix to widen anything.
 */

import { capacitorCamera, capacitorGeolocation, capacitorKeystore, capacitorStore, capacitorVault } from "./adapters/capacitor";

/** What this runtime can actually do, probed rather than assumed. */
export type CapabilityMatrix = {
  localStore: boolean;      // encrypted SQLite on device; memory adapter in a browser
  fileVault: boolean;
  keystore: boolean;
  camera: boolean;
  location: boolean;
  network: boolean;
};

/** One probe per matrix entry. Injected in tests; `capabilities()` uses the native bindings. */
export type CapabilityProbes = { [K in keyof CapabilityMatrix]: () => Promise<boolean> };

/**
 * Ask every probe. Only an answer of exactly `true` counts: a probe that throws (the platform could
 * not be detected), or answers anything else, reads unavailable, and the other probes still answer.
 * The result is frozen, so nothing downstream can switch a capability on because it wants one.
 */
export async function probeCapabilities(probes: CapabilityProbes): Promise<CapabilityMatrix> {
  const ask = async (probe: () => Promise<unknown>): Promise<boolean> => {
    try { return (await probe()) === true; } catch { return false; }
  };
  const [localStore, fileVault, keystore, camera, location, network] = await Promise.all([
    ask(probes.localStore), ask(probes.fileVault), ask(probes.keystore),
    ask(probes.camera), ask(probes.location), ask(probes.network),
  ]);
  return Object.freeze({ localStore, fileVault, keystore, camera, location, network });
}

/**
 * The native probes. `network` is whether this runtime has a network transport at all (`fetch`); it
 * is not whether a connection is up right now — that is `Connectivity.online()`.
 */
function nativeProbes(): CapabilityProbes {
  return {
    localStore: capacitorStore().available,
    fileVault: capacitorVault().available,
    keystore: capacitorKeystore().available,
    camera: capacitorCamera().available,
    location: capacitorGeolocation().available,
    network: async () => typeof globalThis.fetch === "function",
  };
}

/**
 * Aggregates the per-binding `available()` probes that `adapters/capacitor.ts`
 * already exposes. A false entry means the capability will throw
 * NotOnDeviceError, never that it will degrade.
 */
export function capabilities(): Promise<CapabilityMatrix> {
  return probeCapabilities(nativeProbes());
}
