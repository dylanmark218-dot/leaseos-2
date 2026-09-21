/**
 * v22.20 — what a truck with no signal may do, and what it may only record.
 *
 * Pure. No network, no database.
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
 * **The class is declared, never inferred.** A model deciding that something
 * "seems safe enough to do locally" is the model granting itself authority. The
 * class travels with the capability definition.
 *
 * **It binds to the gateway's risk levels rather than restating them.** Two
 * independently maintained vocabularies for "how dangerous is this" is the
 * shape that has already produced two receipt models and two never-automatic
 * floors in this codebase. Here the mapping is explicit and a test fails if one
 * side moves alone.
 */

import type { CapabilityDefinition, RiskLevel } from "./actionGateway";

export type OfflineClass =
  | "local_safe"          // reads what is already on the device
  | "local_capture"       // records what the person observed
  | "local_prepare"       // drafts something a server will later decide on
  | "server_authoritative"; // only the server may do this at all

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

export type FieldCapability = CapabilityDefinition & { offlineClass: OfflineClass };

export class ClassRiskMismatch extends Error {}

/**
 * Check a definition against its class.
 *
 * A capability marked `local_safe` that carries `approval_required` is not a
 * configuration nuance; it is a server decision labelled as a local read, and
 * the label is the thing an offline device would obey.
 */
export function validateCapability(capability: FieldCapability): void {
  const permitted = RISKS_PERMITTED[capability.offlineClass];
  if (!permitted.includes(capability.riskLevel)) {
    throw new ClassRiskMismatch(
      `${capability.key} is ${capability.offlineClass} but carries risk ${capability.riskLevel}. ` +
      `A ${capability.offlineClass} capability may be ${permitted.join(" or ")} — otherwise the label is the only thing standing between an offline device and a server decision.`,
    );
  }
}

/** Every disagreement between the two vocabularies, named rather than counted. */
export function classRiskDisagreements(capabilities: readonly FieldCapability[]): string[] {
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
export function offlineOutcome(capability: FieldCapability, args: { online: boolean; draftable: boolean }): OfflineOutcome {
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
