/**
 * SPINE item 3 — every capture kind's offline declaration, once, for both sides.
 *
 * This is #143's `CAPTURE_OPERATIONS` policy, moved here unchanged so the server can read the same
 * fact the device obeys. The device's gate (`client/src/runtime/capabilities.ts`) adds the hardware a
 * capture needs — HS1, which the server never consults — and composes it with this. The server's
 * sync re-check (`fieldDevice.revalidatePackagedCapture`, called by `sync.receivePackage`) reads it
 * with nothing added. One declaration, two enforcement points; neither restates the other.
 *
 * `requiresOnline` is declared here and read only through `actionGateway.mayRunWithoutServer`.
 *
 * Evidence (inspections, photos, tickets, a photographed out-of-service order…) may run without the
 * server: what it permits is decided on sync. A board message, an acknowledgement or an open-work
 * response is a request a server procedure decides, so it requires the server: drafted on the device,
 * never done there, and never accepted as packaged evidence.
 *
 * Pure: a type import only, no database, no network — the device runtime imports it.
 */

import type { CapabilityDefinition } from "./actionGateway";

/** The policy fields of a capture operation. The device adds `requiredHardware` to make a `DeviceOperation`. */
export type CaptureOperationPolicy = Pick<CapabilityDefinition, "key" | "riskLevel" | "requiresOnline"> & {
  /** Server work that can usefully be prepared now and decided on reconnect. */
  draftable: boolean;
};

const evidence = <K extends string>(kind: K): CaptureOperationPolicy => ({ key: `capture.${kind}`, riskLevel: "low_risk_action", requiresOnline: false, draftable: false });
const request = <K extends string>(kind: K): CaptureOperationPolicy => ({ key: `capture.${kind}`, riskLevel: "low_risk_action", requiresOnline: true, draftable: true });

/** Keyed by capture kind (`CaptureKind`, `client/src/runtime/contracts.ts`); the seal's `recordType` carries the same key. */
export const CAPTURE_POLICY = {
  pretrip: evidence("pretrip"), posttrip: evidence("posttrip"), hos_event: evidence("hos_event"),
  job_accept: evidence("job_accept"), load_ticket: evidence("load_ticket"), disposal_ticket: evidence("disposal_ticket"),
  fuel_receipt: evidence("fuel_receipt"), expense_receipt: evidence("expense_receipt"),
  photo: evidence("photo"),
  signature: evidence("signature"), incident: evidence("incident"), defect_report: evidence("defect_report"),
  tailgate: evidence("tailgate"), tdg_document: evidence("tdg_document"), voice_note: evidence("voice_note"),
  roadside_enforcement: evidence("roadside_enforcement"), oos_order: evidence("oos_order"),
  scanned_document: evidence("scanned_document"),
  board_message: request("board_message"), board_acknowledgement: request("board_acknowledgement"), shift_response: request("shift_response"),
} as const satisfies Record<string, CaptureOperationPolicy>;

export type CaptureOperationKind = keyof typeof CAPTURE_POLICY;

/** The declaration for a kind, or null. Own keys only: an inherited name (`toString`) is not an operation. */
export function capturePolicyFor(kind: string | null | undefined): CaptureOperationPolicy | null {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(CAPTURE_POLICY, kind)) return null;
  return (CAPTURE_POLICY as Record<string, CaptureOperationPolicy>)[kind];
}
