/**
 * SPINE item 3 — HS1 on the device, and the one gate every capture passes before it is saved.
 *
 *   adapter probes ──► capabilities()  (HS1: CAN the device do it)
 *   CAPTURE_OPERATIONS[kind] ──► requiresOnline  (MAY it run without the server — one declaration)
 *   Connectivity ──► online
 *        └──► offlineCapability.runtimeAvailability ──► save locally / refuse
 *
 * What it decides is availability, never authority. A capture this gate lets through is saved in the
 * existing six-state outbox and reaches the server as evidence (or, for a direct capture, as a request
 * to its own procedure); the server authenticates, scopes and authorizes it then. The gate grants no
 * `CaptureAuthorizationClaim` and reads none.
 *
 * Server imports: `server/_core/offlineCapability.ts`, the `actionGateway.ts` it reads
 * `mayRunWithoutServer` from, and `captureOperations.ts` (the one declaration per capture kind) are
 * pure (no database, no network), so the one offline rule runs here rather than being restated for
 * the device — and the server re-checks the same declaration on sync. The runtime otherwise stays free
 * of server modules (`scanSession.ts`).
 */

import { HARDWARE_CAPABILITIES, type CapabilityMatrix, type HardwareCapability } from "@shared/hardwareCapability";
import { runtimeAvailability, type DeviceOperation, type RuntimeAvailability } from "../../../server/_core/offlineCapability";
import { CAPTURE_POLICY } from "../../../server/_core/captureOperations";
import { NotOnDeviceError, type CaptureKind, type Connectivity } from "./contracts";

/** One probe per HS1 capability, supplied by the adapter that owns the binding. */
export type CapabilityProbes = Readonly<Record<HardwareCapability, () => Promise<boolean>>>;

/**
 * HS1's `capabilities()`: aggregate the adapters' `available()` probes. A probe that throws reads as
 * unavailable — a capability the device cannot confirm is one it does not have.
 */
export async function capabilities(probes: CapabilityProbes): Promise<CapabilityMatrix> {
  const entries = await Promise.all(HARDWARE_CAPABILITIES.map(async k => {
    try { return [k, (await probes[k]()) === true] as const; } catch { return [k, false] as const; }
  }));
  return Object.fromEntries(entries) as CapabilityMatrix;
}

/**
 * Every capture kind: its offline declaration plus the hardware it needs.
 *
 * The declaration (`requiresOnline`, risk, draftable) is `server/_core/captureOperations.ts`, the one
 * place it is stated, because the server re-checks the same fact on sync and the device is not an
 * authorization boundary. Only the hardware is added here — HS1 is the device's question and the
 * server never asks it. Hardware is named only where the capture cannot exist without it: every
 * capture needs the local store, evidence with files needs the vault, a photo needs the camera, and a
 * request needs only the store. GPS is attached when present and never required.
 */
const EVIDENCE_HARDWARE: readonly HardwareCapability[] = ["localStore", "fileVault"];
const REQUEST_HARDWARE: readonly HardwareCapability[] = ["localStore"];
const op = (kind: CaptureKind, requiredHardware: readonly HardwareCapability[]): DeviceOperation => ({ ...CAPTURE_POLICY[kind], requiredHardware });

/** Indexing `CAPTURE_POLICY` by `CaptureKind` fails to compile if a kind has no declaration. */
export const CAPTURE_OPERATIONS: Readonly<Record<CaptureKind, DeviceOperation>> = {
  pretrip: op("pretrip", EVIDENCE_HARDWARE), posttrip: op("posttrip", EVIDENCE_HARDWARE), hos_event: op("hos_event", EVIDENCE_HARDWARE),
  job_accept: op("job_accept", EVIDENCE_HARDWARE), load_ticket: op("load_ticket", EVIDENCE_HARDWARE), disposal_ticket: op("disposal_ticket", EVIDENCE_HARDWARE),
  fuel_receipt: op("fuel_receipt", EVIDENCE_HARDWARE), expense_receipt: op("expense_receipt", EVIDENCE_HARDWARE),
  photo: op("photo", [...EVIDENCE_HARDWARE, "camera"]),
  signature: op("signature", EVIDENCE_HARDWARE), incident: op("incident", EVIDENCE_HARDWARE), defect_report: op("defect_report", EVIDENCE_HARDWARE),
  tailgate: op("tailgate", EVIDENCE_HARDWARE), tdg_document: op("tdg_document", EVIDENCE_HARDWARE), voice_note: op("voice_note", EVIDENCE_HARDWARE),
  roadside_enforcement: op("roadside_enforcement", EVIDENCE_HARDWARE), oos_order: op("oos_order", EVIDENCE_HARDWARE),
  scanned_document: op("scanned_document", EVIDENCE_HARDWARE),
  board_message: op("board_message", REQUEST_HARDWARE), board_acknowledgement: op("board_acknowledgement", REQUEST_HARDWARE), shift_response: op("shift_response", REQUEST_HARDWARE),
};

/** What the outbox asks before it saves anything. */
export type CaptureGate = { check(kind: CaptureKind): Promise<RuntimeAvailability> };

/** The gate: HS1 facts from the adapter's probes, connectivity, and the one rule. */
export function captureGate(deps: { probes: CapabilityProbes; connectivity: Connectivity }): CaptureGate {
  return {
    async check(kind) {
      const [hardware, online] = await Promise.all([capabilities(deps.probes), deps.connectivity.online()]);
      return runtimeAvailability(CAPTURE_OPERATIONS[kind], { hardware, online });
    },
  };
}

/** Refuse what the gate refuses, in the runtime's existing words: missing hardware is `NotOnDeviceError`. */
export function refuseUnavailable(kind: CaptureKind, a: RuntimeAvailability): void {
  if (a.outcome !== "unavailable") return;
  if (a.reason === "hardware_missing") throw new NotOnDeviceError(`${kind} capture (needs ${a.missing.join(", ")})`);
  throw new Error(a.note);
}
