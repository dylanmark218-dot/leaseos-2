/**
 * Integration Hub — connector health and the circuit breaker.
 *
 * Health is derived from what the connector has done lately, never asserted.
 * The circuit opens after a run of failures and closes itself after a cooling
 * period; while it is open the Hub does not spend attempts on a destination
 * that is not answering. An optional connector being down degrades nothing but
 * itself; a critical one is reported to readiness as REVIEW or BLOCKED, and
 * never as PASS by default.
 */
import type { InterEngineStatus } from "../interEngineStatus";

export type HealthState = "healthy" | "degraded" | "rate_limited" | "authentication_required" | "disabled" | "suspended" | "failing" | "dead_letter_backlog" | "unknown";
export type ConnectorStatus = "draft" | "active" | "disabled" | "suspended" | "revoked";

export const CIRCUIT_OPEN_AFTER_FAILURES = 5;
export const CIRCUIT_COOL_DOWN_MS = 5 * 60_000;
export const STALE_AFTER_MS = 6 * 3600_000;

export type HealthEvidence = {
  status: ConnectorStatus;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureClass: string | null;
  circuitOpenUntil: Date | null;
  openDeadLetters: number;
  /** For sync connectors: the contract's freshness expectation and the last completed sync. */
  freshnessSeconds?: number | null;
  lastSyncAt?: Date | null;
  now: Date;
};

export function assessConnectorHealth(e: HealthEvidence): { state: HealthState; line: string } {
  if (e.status === "disabled" || e.status === "draft" || e.status === "revoked") return { state: "disabled", line: `connector is ${e.status}` };
  if (e.status === "suspended") return { state: "suspended", line: "connector is suspended by an operator" };
  if (e.lastFailureClass === "authentication_or_configuration") return { state: "authentication_required", line: "the last attempt was refused for credentials or configuration; nothing is retried until a person fixes it" };
  if (e.openDeadLetters > 0) return { state: "dead_letter_backlog", line: `${e.openDeadLetters} dead letter(s) need a person` };
  if (e.circuitOpenUntil && e.circuitOpenUntil.getTime() > e.now.getTime()) return { state: "failing", line: `circuit open until ${e.circuitOpenUntil.toISOString()} after ${e.consecutiveFailures} consecutive failures` };
  if (e.lastFailureClass === "rate_limited" && e.consecutiveFailures > 0) return { state: "rate_limited", line: "the provider is rate limiting; attempts wait for Retry-After" };
  if (e.consecutiveFailures >= 2) return { state: "degraded", line: `${e.consecutiveFailures} consecutive failures` };
  if (e.freshnessSeconds && (!e.lastSyncAt || e.now.getTime() - e.lastSyncAt.getTime() > e.freshnessSeconds * 1000)) return { state: "degraded", line: e.lastSyncAt ? `last completed sync ${Math.round((e.now.getTime() - e.lastSyncAt.getTime()) / 60_000)} min ago exceeds the contract's ${e.freshnessSeconds}s freshness` : "no sync has completed" };
  if (!e.lastSuccessAt) return { state: "unknown", line: "no successful communication yet" };
  if (e.now.getTime() - e.lastSuccessAt.getTime() > STALE_AFTER_MS) return { state: "degraded", line: `last success ${Math.round((e.now.getTime() - e.lastSuccessAt.getTime()) / 3600_000)} h ago` };
  return { state: "healthy", line: "healthy" };
}

/** The connector's counters after an attempt. */
export function afterAttempt(prev: { consecutiveFailures: number; circuitOpenUntil: Date | null }, outcome: "success" | "failure", now: Date): { consecutiveFailures: number; circuitOpenUntil: Date | null } {
  if (outcome === "success") return { consecutiveFailures: 0, circuitOpenUntil: null };
  const n = prev.consecutiveFailures + 1;
  return { consecutiveFailures: n, circuitOpenUntil: n >= CIRCUIT_OPEN_AFTER_FAILURES ? new Date(now.getTime() + CIRCUIT_COOL_DOWN_MS) : prev.circuitOpenUntil };
}

/** May an attempt be made now? An open circuit or a stopped connector says no, with the reason. */
export function shouldAttempt(e: { status: ConnectorStatus; circuitOpenUntil: Date | null; now: Date }): { attempt: true } | { attempt: false; reason: string; terminal: boolean } {
  if (e.status === "revoked" || e.status === "disabled") return { attempt: false, reason: `connector is ${e.status}`, terminal: true };
  if (e.status === "suspended" || e.status === "draft") return { attempt: false, reason: `connector is ${e.status}`, terminal: false };
  if (e.circuitOpenUntil && e.circuitOpenUntil.getTime() > e.now.getTime()) return { attempt: false, reason: `circuit open until ${e.circuitOpenUntil.toISOString()}`, terminal: false };
  return { attempt: true };
}

/** What a critical connector's health means to a readiness consumer. Never PASS while unknown. */
export function readinessVerdict(state: HealthState, critical: boolean): InterEngineStatus {
  if (!critical) return "NOT_EVALUATED";
  switch (state) {
    case "healthy": return "PASS";
    case "degraded": case "rate_limited": case "dead_letter_backlog": return "REVIEW";
    case "failing": case "authentication_required": return "BLOCKED";
    case "disabled": case "suspended": return "REVIEW";
    default: return "UNKNOWN";
  }
}
