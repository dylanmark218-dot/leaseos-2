/**
 * v22.20, moved here at SPINE item 3 — what a truck with no signal may do, and what it may only
 * record. One policy, run by both sides.
 *
 * Pure. No network, no database, no runtime-specific import: the field client and the server both
 * import this file, the same way they share `driverWallet.ts`.
 *
 * The sentence this module exists to enforce:
 *
 *   **The device is the source of truth for what it observed. It is not the
 *   source of authority for what that observation permits.**
 *
 * A driver with no signal can record a defect, capture a signature, complete a
 * tailgate meeting and dictate a ticket. Those are facts, they happened, and
 * they survive to sync. What an offline device cannot do is manufacture a
 * server decision: it cannot release an out-of-service order, cannot resolve an
 * unknown compliance question as passed, and cannot turn an extraction into a
 * confirmed fact. Losing signal must not become a way around the server.
 *
 * **Two consumers, two jobs.** The field client (`client/src/runtime/outbox.ts`) calls
 * `decideFieldOperation` before it queues anything, because offline there is nobody to ask: that is
 * UX and offline correctness. The server (`server/deviceRouter.ts`, through the
 * `server/_core/offlineCapability.ts` adapter) calls `revalidatePackagedOperation` on every item it
 * receives, deriving the operation from its own records, because the client is not an authorization
 * boundary: that is authority. Neither answer is a permission. Who may act is still decided by the
 * authenticated actor, the acting scope and the procedure's own permission.
 *
 * **The class is declared, never inferred.** A model deciding that something
 * "seems safe enough to do locally" is the model granting itself authority. The
 * class travels with the capability definition — and with the field operation
 * below, never with the capture.
 *
 * **It binds to the gateway's risk levels rather than restating them.** Two
 * independently maintained vocabularies for "how dangerous is this" is the
 * shape that has already produced two receipt models and two never-automatic
 * floors in this codebase. Here the mapping is explicit and a test fails if one
 * side moves alone.
 *
 * **Not hardware.** Whether this device *can* take a photograph is HS1's `capabilities()`
 * (`client/src/runtime/capabilities.ts`). Whether a class of operation may run or queue while
 * disconnected is this file. The two never answer each other's question.
 */

import type { RiskLevel } from "./riskLevel";

export type OfflineClass =
  | "local_safe"          // reads what is already on the device
  | "local_capture"       // records what the person observed
  | "local_prepare"       // drafts something a server will later decide on
  | "server_authoritative"; // only the server may do this at all

/** The fields this policy reads. The gateway's `CapabilityDefinition` plus a class fits it structurally. */
export type OfflineCapability = { key: string; riskLevel: RiskLevel; offlineClass: OfflineClass };

/**
 * Which risks a class may carry.
 *
 * `local_capture` is allowed `low_risk_action` because recording an
 * observation is an action — it creates a record — and refusing that offline
 * would make the device useless exactly where it matters most.
 */
const RISKS_PERMITTED: Record<OfflineClass, readonly RiskLevel[]> = {
  local_safe: ["read"],
  local_capture: ["read", "prepare", "low_risk_action"],
  local_prepare: ["prepare"],
  server_authoritative: ["low_risk_action", "approval_required", "restricted"],
};

export class ClassRiskMismatch extends Error {}

/**
 * Check a definition against its class.
 *
 * A capability marked `local_safe` that carries `approval_required` is not a
 * configuration nuance; it is a server decision labelled as a local read, and
 * the label is the thing an offline device would obey.
 */
export function validateCapability(capability: OfflineCapability): void {
  const permitted = RISKS_PERMITTED[capability.offlineClass];
  if (!permitted.includes(capability.riskLevel)) {
    throw new ClassRiskMismatch(
      `${capability.key} is ${capability.offlineClass} but carries risk ${capability.riskLevel}. ` +
      `A ${capability.offlineClass} capability may be ${permitted.join(" or ")} — otherwise the label is the only thing standing between an offline device and a server decision.`,
    );
  }
}

/** Every disagreement between the two vocabularies, named rather than counted. */
export function classRiskDisagreements(capabilities: readonly OfflineCapability[]): string[] {
  const out: string[] = [];
  for (const c of capabilities) {
    try { validateCapability(c); } catch (e) { out.push((e as Error).message); }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* What happens when there is no signal                                 */
/* ------------------------------------------------------------------ */

export type OfflineOutcome =
  | { outcome: "execute_locally"; note: string }
  | { outcome: "capture_locally"; note: string }
  | { outcome: "prepare_and_queue"; note: string }
  | { outcome: "unavailable"; note: string };

/**
 * Decide what an offline device may do with a capability.
 *
 * A server-authoritative capability is *never* executed offline. Where it can
 * usefully be drafted it is queued for a server decision, and where it cannot
 * it is simply unavailable — said plainly, rather than appearing to work and
 * failing hours later when the truck reaches signal.
 */
export function offlineOutcome(capability: Pick<OfflineCapability, "key" | "offlineClass">, args: { online: boolean; draftable: boolean }): OfflineOutcome {
  if (args.online) {
    return { outcome: "execute_locally", note: "Online; the server decides as usual." };
  }
  switch (capability.offlineClass) {
    case "local_safe":
      return { outcome: "execute_locally", note: `${capability.key} reads what is already on the device.` };
    case "local_capture":
      return {
        outcome: "capture_locally",
        note: `${capability.key} records what was observed. The observation is a fact; what it permits is decided when this reaches the server.`,
      };
    case "local_prepare":
      return { outcome: "prepare_and_queue", note: `${capability.key} is drafted here and decided by the server.` };
    case "server_authoritative":
      return args.draftable
        ? { outcome: "prepare_and_queue", note: `${capability.key} needs the server. It can be prepared now and will be decided when this device reconnects.` }
        : {
            outcome: "unavailable",
            note: `${capability.key} needs the server and cannot be usefully prepared offline. Losing signal is not a way around it.`,
          };
  }
}

/* ------------------------------------------------------------------ */
/* The field operations a device performs                               */
/* ------------------------------------------------------------------ */

/**
 * One kind of thing the field device does, keyed by its capture kind (`CaptureKind` in
 * `client/src/runtime/contracts.ts`; `outbox.ts` holds the compile-time check that every kind has a
 * row). The server receives the same key as the seal's `recordType`.
 *
 * `channel` is where it travels: `package` is evidence through `sync.receivePackage`; `direct` is a
 * message, an acknowledgement or a response sent to its own procedure (`DIRECT_CAPTURE_KINDS`).
 */
export type FieldOperation = OfflineCapability & { draftable: boolean; channel: "package" | "direct" };

const capture = (key: string): FieldOperation => ({ key, riskLevel: "low_risk_action", offlineClass: "local_capture", draftable: true, channel: "package" });
const prepare = (key: string, channel: FieldOperation["channel"]): FieldOperation => ({ key, riskLevel: "prepare", offlineClass: "local_prepare", draftable: true, channel });

/**
 * Every field operation the policy knows. Anything absent is refused — offline and online, on the
 * device and at the server. There is no default class.
 *
 * Every row is a capture or a draft: a device records what happened and prepares what someone else
 * decides. Job acceptance is a draft, not a capture — the award is `dispatch.award`'s, on the server.
 * A roadside order or an out-of-service order is a *capture of the document the officer issued*; its
 * release is not a field operation at all, and is refused here by being absent.
 */
export const FIELD_OPERATIONS = {
  pretrip: capture("pretrip"),
  posttrip: capture("posttrip"),
  hos_event: capture("hos_event"),
  job_accept: prepare("job_accept", "package"),
  load_ticket: capture("load_ticket"),
  disposal_ticket: capture("disposal_ticket"),
  fuel_receipt: capture("fuel_receipt"),
  expense_receipt: capture("expense_receipt"),
  photo: capture("photo"),
  signature: capture("signature"),
  incident: capture("incident"),
  defect_report: capture("defect_report"),
  tailgate: capture("tailgate"),
  tdg_document: capture("tdg_document"),
  voice_note: capture("voice_note"),
  roadside_enforcement: capture("roadside_enforcement"),
  oos_order: capture("oos_order"),
  scanned_document: capture("scanned_document"),
  board_message: prepare("board_message", "direct"),
  board_acknowledgement: prepare("board_acknowledgement", "direct"),
  shift_response: prepare("shift_response", "direct"),
} as const satisfies Record<string, FieldOperation>;

export type FieldOperationKey = keyof typeof FIELD_OPERATIONS;

/** The policy row for a key, or null. Own properties only: `"toString"` is not an operation. */
export function fieldOperation(key: string | null | undefined): FieldOperation | null {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(FIELD_OPERATIONS, key)) return null;
  return (FIELD_OPERATIONS as Record<string, FieldOperation>)[key];
}

export type FieldOperationDecision = OfflineOutcome | { outcome: "refused"; note: string };

/**
 * The field client's question: may this operation run or queue right now?
 *
 * The key is the capture's kind and nothing else — never a class, flag or verdict carried in the
 * capture's own fields. An unknown key is refused whatever the connection.
 */
export function decideFieldOperation(key: string, args: { online: boolean }): FieldOperationDecision {
  const op = fieldOperation(key);
  if (!op) return { outcome: "refused", note: `${key} is not a field operation the offline policy knows. Nothing unknown is queued.` };
  return offlineOutcome(op, { online: args.online, draftable: op.draftable });
}

/**
 * The server's question about an item it received: was this an operation a device may record?
 *
 * The caller passes the kind from the server's OWN records (the seal manifest it computed), never
 * anything the package asserts. No kind — an unsealed item, an unreadable manifest — is refused, not
 * waved through. Passing this is not authorization; it only means the device stayed inside the
 * policy. The actor, the scope and the hashes are checked separately and are not overridden by it.
 */
export function revalidatePackagedOperation(recordType: string | null | undefined): { accepted: true; operation: FieldOperation } | { accepted: false; reason: string } {
  const op = fieldOperation(recordType);
  if (!op) {
    return { accepted: false, reason: recordType ? `${recordType} is not a field operation the offline policy knows` : "the item carries no sealed operation the server can classify" };
  }
  if (op.channel !== "package") return { accepted: false, reason: `${op.key} is sent to its own procedure, never as packaged evidence` };
  if (op.offlineClass === "server_authoritative") return { accepted: false, reason: `${op.key} is server-authoritative and cannot be recorded as done by a device` };
  return { accepted: true, operation: op };
}

/* ------------------------------------------------------------------ */
/* What syncs, and as what                                              */
/* ------------------------------------------------------------------ */

export type LocalRecord = {
  recordRef: string;
  capability: string;
  offlineClass: OfflineClass;
  /** What the device observed, in the words or values it captured. */
  observation: Record<string, unknown>;
  capturedAt: Date;
  deviceId: string;
};

export type SyncEnvelope = {
  recordRef: string;
  /** Always evidence. Never a decision the device reached about that evidence. */
  kind: "evidence";
  observation: Record<string, unknown>;
  capturedAt: Date;
  deviceId: string;
  /** What the device believed, kept as a proposal for the server to evaluate. */
  deviceAssessment: { claim: string; basis: string } | null;
  note: string;
};

export class DeviceAuthorityRefused extends Error {}

/**
 * Package a local record for the server.
 *
 * A device assessment travels as a claim with its basis, never as a verdict.
 * The difference matters: "the local model thought the route was legal" and
 * "the route is legal" are the same sentence to a database column and entirely
 * different to a regulator.
 */
export function envelopeFor(record: LocalRecord, assessment: { claim: string; basis: string } | null): SyncEnvelope {
  if (record.offlineClass === "server_authoritative") {
    throw new DeviceAuthorityRefused(
      `${record.capability} is server-authoritative and cannot be recorded as done by a device. Prepare it and let the server decide.`,
    );
  }
  return {
    recordRef: record.recordRef, kind: "evidence",
    observation: record.observation, capturedAt: record.capturedAt, deviceId: record.deviceId,
    deviceAssessment: assessment,
    note: assessment
      ? "The device's assessment travels as a claim with its basis. The server's engines decide; this is not their answer."
      : "Observation only.",
  };
}

/* ------------------------------------------------------------------ */
/* Where an answer came from                                            */
/* ------------------------------------------------------------------ */

export type Freshness = "current" | "stale" | "unknown";

export type LocalAnswer<T> = {
  value: T;
  source: "local" | "cloud";
  capturedAt: Date | null;
  freshness: Freshness;
};

/**
 * Grade a cached answer.
 *
 * Cached data with no capture time is `unknown`, not `current`. A device that
 * cannot say when it learned something should not present it as today's truth —
 * the same rule the dashboard applies to a stale telemetry reading.
 */
export function freshnessOf(capturedAt: Date | null, now: Date, staleAfterMinutes: number): Freshness {
  if (!capturedAt) return "unknown";
  const minutes = (now.getTime() - capturedAt.getTime()) / 60_000;
  return minutes <= staleAfterMinutes ? "current" : "stale";
}

/** Whether an answer is fit to act on, as opposed to fit to read. */
export const actionable = (answer: LocalAnswer<unknown>): boolean => answer.freshness === "current";
