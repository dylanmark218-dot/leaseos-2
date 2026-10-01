/**
 * HS1 — what this runtime can actually do, probed rather than assumed.
 *
 * Frozen in `docs/hybrid-seam/HS_CONTRACTS.md` §1, with one deliberate change:
 * the frozen signature was `capabilities()` with no argument. The network entry
 * needs the runtime's own `Connectivity` — the same flag the sync engine obeys —
 * and reading a browser global instead would let the matrix and the engine
 * disagree about whether the device is online. So the probes are passed in, and
 * `nativeProbes(connectivity)` builds the device's set from the per-binding
 * `available()` probes `adapters/capacitor.ts` already exposes.
 *
 * A false entry means the capability will throw `NotOnDeviceError`, never that
 * it will degrade. A probe that throws is answered `false`: a capability that
 * cannot say whether it is there is not there.
 */

import type { Connectivity } from "./contracts";
import {
  capacitorCamera, capacitorGeolocation, capacitorKeystore, capacitorStore, capacitorVault,
} from "./adapters/capacitor";

export type CapabilityMatrix = {
  localStore: boolean;      // encrypted SQLite on device
  fileVault: boolean;
  keystore: boolean;
  camera: boolean;
  location: boolean;
  network: boolean;
};

export type CapabilityProbes = { readonly [K in keyof CapabilityMatrix]: () => Promise<boolean> };

const ENTRIES: readonly (keyof CapabilityMatrix)[] = ["localStore", "fileVault", "keystore", "camera", "location", "network"];

async function probe(p: () => Promise<boolean>): Promise<boolean> {
  try { return (await p()) === true; } catch { return false; }
}

export async function capabilities(probes: CapabilityProbes): Promise<CapabilityMatrix> {
  const answers = await Promise.all(ENTRIES.map(k => probe(probes[k])));
  const out = {} as CapabilityMatrix;
  ENTRIES.forEach((k, i) => { out[k] = answers[i]; });
  return out;
}

/** The device's probes: the native bindings, and the runtime's own connectivity. */
export function nativeProbes(connectivity: Connectivity): CapabilityProbes {
  return {
    localStore: capacitorStore().available,
    fileVault: capacitorVault().available,
    keystore: capacitorKeystore().available,
    camera: capacitorCamera().available,
    location: capacitorGeolocation().available,
    network: () => connectivity.online(),
  };
}
