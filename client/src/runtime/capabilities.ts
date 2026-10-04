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
 * Server imports: `server/_core/offlineCapability.ts` and the `actionGateway.ts` it reads
 * `mayRunWithoutServer` from are pure (no database, no network, no further imports), so the one
 * offline rule runs here rather than being restated for the device. The runtime otherwise stays free
 * of server modules (`scanSession.ts`).
 */

import { HARDWARE_CAPABILITIES, type CapabilityMatrix, type HardwareCapability } from "@shared/hardwareCapability";
import { runtimeAvailability, type DeviceOperation, type RuntimeAvailability } from "../../../server/_core/offlineCapability";
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
 * Every capture kind, declared once.
 *
 * Evidence (inspections, photos, tickets, a photographed out-of-service order…) is recorded on the
 * device whether or not there is signal — the outbox's existing behaviour — so it may run without the
 * server; what it permits is the server's on sync. A board message, an acknowledgement or an open-work
 * response is a request a server procedure decides, so it requires the server: it is drafted here and
 * decided there, never done on the device. Hardware is named only where the capture cannot exist
 * without it: every capture needs the local store, a capture with files needs the vault, a photo needs
 * the camera. GPS is attached when present and never required.
 */
const evidence = (kind: CaptureKind, extra: readonly HardwareCapability[] = []): DeviceOperation =>
  ({ key: `capture.${kind}`, riskLevel: "low_risk_action", requiresOnline: false, draftable: false, requiredHardware: ["localStore", "fileVault", ...extra] });
const request = (kind: CaptureKind): DeviceOperation =>
  ({ key: `capture.${kind}`, riskLevel: "low_risk_action", requiresOnline: true, draftable: true, requiredHardware: ["localStore"] });

export const CAPTURE_OPERATIONS: Readonly<Record<CaptureKind, DeviceOperation>> = {
  pretrip: evidence("pretrip"), posttrip: evidence("posttrip"), hos_event: evidence("hos_event"),
  job_accept: evidence("job_accept"), load_ticket: evidence("load_ticket"), disposal_ticket: evidence("disposal_ticket"),
  fuel_receipt: evidence("fuel_receipt"), expense_receipt: evidence("expense_receipt"),
  photo: evidence("photo", ["camera"]),
  signature: evidence("signature"), incident: evidence("incident"), defect_report: evidence("defect_report"),
  tailgate: evidence("tailgate"), tdg_document: evidence("tdg_document"), voice_note: evidence("voice_note"),
  roadside_enforcement: evidence("roadside_enforcement"), oos_order: evidence("oos_order"),
  scanned_document: evidence("scanned_document"),
  board_message: request("board_message"), board_acknowledgement: request("board_acknowledgement"), shift_response: request("shift_response"),
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
