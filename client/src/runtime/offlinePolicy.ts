/**
 * SPINE item 3 — the device runtime asks `offlineCapability` what a capture is.
 *
 * `server/_core/offlineCapability.ts` holds the rule: the device is the source
 * of truth for what it observed, never the source of authority for what that
 * observation permits. Until this file, nothing on the device called it — the
 * outbox and the sync engine kept the rule by habit (every package item is
 * evidence, the authorization claim is historical) under their own vocabulary.
 *
 * Here every `CaptureKind` is declared as a `FieldCapability`. The class is
 * declared, never inferred: a kind added to `CaptureKind` without a line below
 * does not compile, and a kind the outbox is handed at run time that is not
 * declared here is refused before anything is saved.
 *
 * Every shipped kind is `local_capture`. That is the honest answer, not a
 * default: an out-of-service order recorded at roadside is the order as it was
 * handed over, and recording it releases nothing; a job acceptance is the
 * worker's statement, and the assignment stays the server's. No capture kind
 * today is a server decision. If one ever is, `server_authoritative` here makes
 * the outbox refuse to queue it and the sync engine refuse to package it.
 */

import {
  classRiskDisagreements, DeviceAuthorityRefused, envelopeFor, offlineOutcome,
  type FieldCapability, type SyncEnvelope,
} from "../../../server/_core/offlineCapability";
import type { Permission } from "../../../server/_core/recordsAuthorization";
import type { CaptureKind, LocalCapture } from "./contracts";

/** The permission the server checks when the evidence arrives (`evidence.upload`). */
const EVIDENCE_UPLOAD: Permission = "evidence.upload";

export type CapturePolicy = { readonly [K in CaptureKind]: FieldCapability };

const capture = (kind: CaptureKind, description: string): FieldCapability => ({
  key: `capture.${kind}`,
  description,
  riskLevel: "low_risk_action",
  requiredPermissions: [EVIDENCE_UPLOAD],
  requiresOnline: false,
  // The upload is idempotent by the device's capture reference.
  idempotent: true,
  offlineClass: "local_capture",
});

export const CAPTURE_CAPABILITIES: CapturePolicy = {
  pretrip: capture("pretrip", "a pre-trip inspection as the worker performed it"),
  posttrip: capture("posttrip", "a post-trip inspection as the worker performed it"),
  hos_event: capture("hos_event", "a duty-status change as the worker recorded it"),
  job_accept: capture("job_accept", "the worker's acceptance of a job; the assignment stays the server's"),
  load_ticket: capture("load_ticket", "a load ticket as written at the site"),
  disposal_ticket: capture("disposal_ticket", "a disposal ticket as issued by the facility"),
  fuel_receipt: capture("fuel_receipt", "a fuel receipt as printed"),
  expense_receipt: capture("expense_receipt", "an expense receipt as printed"),
  photo: capture("photo", "a photograph"),
  signature: capture("signature", "a signature as given on the device"),
  incident: capture("incident", "an incident as the worker observed it"),
  defect_report: capture("defect_report", "a defect as the worker observed it; whether the unit may run is the server's"),
  tailgate: capture("tailgate", "a tailgate meeting as held"),
  tdg_document: capture("tdg_document", "a dangerous-goods document as carried"),
  voice_note: capture("voice_note", "a voice note"),
  roadside_enforcement: capture("roadside_enforcement", "a roadside enforcement document as handed over"),
  oos_order: capture("oos_order", "an out-of-service order as handed over; recording it releases nothing"),
  scanned_document: capture("scanned_document", "a scanned document whose type nobody has established"),
};

export class UndeclaredCaptureKind extends Error {}

/** The declared capability for a kind, or a refusal: a kind nobody declared is not guessed at. */
export function captureCapability(kind: string, policy: CapturePolicy = CAPTURE_CAPABILITIES): FieldCapability {
  if (!Object.prototype.hasOwnProperty.call(policy, kind)) {
    throw new UndeclaredCaptureKind(`"${kind}" is not a declared capture kind; the device does not decide what an undeclared capture is`);
  }
  return policy[kind as CaptureKind];
}

/** Every disagreement between a policy's offline classes and its risk levels. */
export const capturePolicyDisagreements = (policy: CapturePolicy = CAPTURE_CAPABILITIES): string[] =>
  classRiskDisagreements(Object.keys(policy).map(k => policy[k as CaptureKind]));

/**
 * May the device queue this kind with no signal?
 *
 * Queuing is the offline path by definition, so it is judged as offline
 * whatever the connection is now. Nothing is draftable at the outbox: a draft
 * of a server decision is a proposal, and proposals go through the assistant,
 * not the evidence queue.
 */
export function assertQueueable(kind: string, policy: CapturePolicy = CAPTURE_CAPABILITIES): void {
  const outcome = offlineOutcome(captureCapability(kind, policy), { online: false, draftable: false });
  if (outcome.outcome === "unavailable") throw new DeviceAuthorityRefused(outcome.note);
}

/**
 * The capture as the engine's sync envelope: always evidence, never a verdict.
 * Throws `DeviceAuthorityRefused` for a server-authoritative kind.
 */
export function captureEnvelope(c: LocalCapture, deviceId: string, policy: CapturePolicy = CAPTURE_CAPABILITIES): SyncEnvelope {
  const capability = captureCapability(c.kind, policy);
  return envelopeFor({
    recordRef: c.localId, capability: capability.key, offlineClass: capability.offlineClass,
    observation: c.fields, capturedAt: new Date(c.capturedAt), deviceId,
  }, null);
}
