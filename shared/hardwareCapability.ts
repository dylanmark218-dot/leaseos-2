/**
 * HS1 — what this device can physically do. One vocabulary for the client runtime and the server.
 *
 * The names are HS1's frozen contract (`docs/hybrid-seam/HS_CONTRACTS.md` §1), not new ones. A false
 * entry means the capability will throw `NotOnDeviceError` (`client/src/runtime/contracts.ts`), never
 * that it will degrade.
 *
 * This answers one question only: CAN THE DEVICE DO IT? It does not say whether an operation may run
 * without the server (`requiresOnline`, `server/_core/actionGateway.ts`) or whether this person may
 * do it (server authorization on reconnect). Hardware can narrow what is available; it never grants
 * anything.
 *
 * Pure. No probing here — `client/src/runtime/capabilities.ts` probes and hands the facts in.
 */

export const HARDWARE_CAPABILITIES = ["localStore", "fileVault", "keystore", "camera", "location", "network"] as const;

export type HardwareCapability = (typeof HARDWARE_CAPABILITIES)[number];

/** What this runtime can actually do, probed rather than assumed. */
export type CapabilityMatrix = Readonly<Record<HardwareCapability, boolean>>;

/**
 * The required capabilities this device lacks, in the order they were asked for. Empty means the
 * hardware question is answered yes — and only that question.
 */
export function missingHardware(matrix: CapabilityMatrix, required: readonly HardwareCapability[]): HardwareCapability[] {
  return required.filter(k => matrix[k] !== true);
}
