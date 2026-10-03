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
 * **SPINE item 3 — three questions, kept apart.** CAN the device do it is HS1
 * (`shared/hardwareCapability.ts`). MAY it run without the server is
 * `requiresOnline`, declared on the capability and read only through
 * `actionGateway.mayRunWithoutServer`. MAY this person do it is the server's, on
 * reconnect. This module composes the first two with connectivity into what the
 * device may attempt now — capture, draft, read, or refuse — and decides nothing
 * about the third. Hardware can narrow availability; it never grants it. Being
 * online satisfies connectivity and nothing else: server work is still queued for
 * the server, never executed here.
 *
 * **The offline class is derived, never declared.** Before item 3 a capability
 * carried its own `offlineClass` beside `requiresOnline`, two answers to one
 * question, and the class won. Now the class is read off `requiresOnline` and the
 * gateway's risk level, so there is one declaration. A capability that may run
 * without the server yet carries `approval_required` or `restricted` is a
 * contradiction and refuses — it is never quietly classed as local.
 */

import type { HardwareCapability, CapabilityMatrix } from "@shared/hardwareCapability";
import { missingHardware } from "@shared/hardwareCapability";
import { mayRunWithoutServer, type CapabilityDefinition, type RiskLevel } from "./actionGateway";

export type OfflineClass =
  | "local_safe"          // reads what is already on the device
  | "local_capture"       // records what the person observed
  | "local_prepare"       // drafts something a server will later decide on
  | "server_authoritative"; // only the server may do this at all

export class ClassRiskMismatch extends Error {}

type ClassInput = Pick<CapabilityDefinition, "key" | "riskLevel" | "requiresOnline">;

/**
 * The class a capability falls in, from its declaration. Exhaustive over `RiskLevel`, so a new risk
 * level fails the typecheck here until somebody decides what it means offline.
 */
export function offlineClassOf(capability: ClassInput): OfflineClass {
  if (!mayRunWithoutServer(capability)) return "server_authoritative";
  const risk: RiskLevel = capability.riskLevel;
  switch (risk) {
    case "read": return "local_safe";
    case "prepare": return "local_prepare";
    case "low_risk_action": return "local_capture";
    case "approval_required":
    case "restricted":
      throw new ClassRiskMismatch(
        `${capability.key} carries risk ${risk} but is declared to run without the server. ` +
        `Approval and restricted work is the server's; declare it requiresOnline — the label is the only thing an offline device would obey.`,
      );
    default: {
      const unreachable: never = risk;
      throw new ClassRiskMismatch(`${capability.key}: unknown risk level ${String(unreachable)}`);
    }
  }
}

/** Check a declaration: throws where requiresOnline and the risk level contradict each other. */
export function validateCapability(capability: ClassInput): void {
  offlineClassOf(capability);
}

/** Every contradiction among a set of declarations, named rather than counted. */
export function classRiskDisagreements(capabilities: readonly ClassInput[]): string[] {
  const out: string[] = [];
  for (const c of capabilities) {
    try { validateCapability(c); } catch (e) { out.push((e as Error).message); }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* What the device may attempt now                                     */
/* ------------------------------------------------------------------ */

/** An operation the device may be asked to do: its declaration, the hardware it needs, and whether it can be drafted. */
export type DeviceOperation = ClassInput & {
  requiredHardware: readonly HardwareCapability[];
  /** Server work that can usefully be prepared now and decided on reconnect. */
  draftable: boolean;
};

/**
 * What the device may attempt. The outcomes are the module's existing four; `reason` says which
 * question produced them, so a missing camera and a server-only act are never the same refusal.
 * None carries a permission, a scope or an authorization claim — this is availability, not authority.
 */
export type RuntimeAvailability =
  | { outcome: "execute_locally"; reason: "local_read"; note: string }
  | { outcome: "capture_locally"; reason: "local_capture"; note: string }
  | { outcome: "prepare_and_queue"; reason: "local_draft" | "server_decides"; note: string }
  | { outcome: "unavailable"; reason: "hardware_missing"; missing: HardwareCapability[]; note: string }
  | { outcome: "unavailable"; reason: "server_required_offline"; note: string };

/**
 * Compose HS1's hardware facts, the one offline policy and connectivity.
 *
 * Hardware first: a missing camera is missing online or off. Then the class from `requiresOnline`:
 * local reads, captures and drafts take the existing offline path whether or not there is signal;
 * server work is queued for the server — with signal it is sent now, without it only if it can be
 * drafted — and is never executed or captured as done on the device.
 */
export function runtimeAvailability(operation: DeviceOperation, ctx: { hardware: CapabilityMatrix; online: boolean }): RuntimeAvailability {
  const missing = missingHardware(ctx.hardware, operation.requiredHardware);
  if (missing.length) {
    return { outcome: "unavailable", reason: "hardware_missing", missing, note: `${operation.key} needs ${missing.join(", ")}, which this device does not have.` };
  }
  switch (offlineClassOf(operation)) {
    case "local_safe":
      return { outcome: "execute_locally", reason: "local_read", note: `${operation.key} reads what is already on the device.` };
    case "local_capture":
      return { outcome: "capture_locally", reason: "local_capture", note: `${operation.key} records what was observed. What it permits is decided when it reaches the server.` };
    case "local_prepare":
      return { outcome: "prepare_and_queue", reason: "local_draft", note: `${operation.key} is drafted here and decided by the server.` };
    case "server_authoritative":
      return ctx.online || operation.draftable
        ? { outcome: "prepare_and_queue", reason: "server_decides", note: `${operation.key} is the server's to decide. It is sent to the server${ctx.online ? " now" : " when this device reconnects"}; nothing is done here.` }
        : { outcome: "unavailable", reason: "server_required_offline", note: `${operation.key} needs the server and cannot be usefully prepared offline. Losing signal is not a way around it.` };
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
