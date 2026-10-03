/**
 * S2-FLEET-A — what the registry lets us say about the fleet, and what it does not.
 *
 * The runtime registry (`_core/runtimeRegistry.ts`) records every process that registered. That is
 * an observation of the processes that chose to register, not an inventory of the processes that
 * exist: a server deployed from a build older than the registry never registers at all, and nothing
 * in this repository can see it. So the strongest statement this module can make from the registry
 * alone is "every instance observed is compatible", and it says exactly that, in a state whose name
 * carries the caveat:
 *
 *   not_observable                                      no live instance has registered
 *   observed_incompatible                               a live instance lacks a required capability,
 *                                                       or has no known build
 *   observed_compatible_external_confirmation_required  every live instance is compatible; whether
 *                                                       they are ALL the instances cannot be known here
 *   converged                                           the above, AND an authoritative deployment
 *                                                       inventory confirms the observed set is the
 *                                                       whole fleet
 *
 * `converged` is reachable only through `deploymentEvidence()`, which today returns `none`: no
 * hosting platform has been selected (S2-KMS-A: HOSTING_TARGET unknown), so no inventory exists to
 * confirm against. It is a function with no parameters, by design — not a flag a caller can set,
 * not an environment variable, not a row somebody can insert. The S2-E cutover stays blocked until
 * that function has an authoritative source, and the blocker says so in words.
 *
 * Compatibility is judged on CAPABILITIES, never on a specific sha. Two builds that both declare
 * `webhook-secret-ref-read` are both compatible; the report lists the distinct builds for the
 * operator but does not gate on their number. A build that is unknown (the process ran from
 * sources, or recorded nothing) is never compatible, whatever it declares: a declaration without an
 * identity behind it cannot be traced to code.
 *
 * Metadata only: instance references, kinds, shas, capability names and ages. No hostname, no
 * address, no secret.
 */
import { isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { runtimeInstances } from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { BUILD_SHA_PATTERN } from "./_core/buildIdentity";
import { RUNTIME_LIVE_TTL_SECONDS, type RuntimeKind } from "./_core/runtimeRegistry";
import { WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES, parseCapabilities, type RuntimeCapability } from "./_core/runtimeCapabilities";

export type FleetConvergenceState =
  | "not_observable"
  | "observed_incompatible"
  | "observed_compatible_external_confirmation_required"
  | "converged";

/** One registry row, as the observation reads it. Ages come from the database clock. */
export type RuntimeInstanceRecord = {
  instanceRef: string;
  runtimeKind: RuntimeKind;
  buildSha: string | null;
  buildSource: "artifact" | "unbuilt";
  capabilitiesJson: string;
  startedAt: Date;
  heartbeatAgeSeconds: number;
};

export type ObservedRuntimeInstance = {
  instanceRef: string;
  runtimeKind: RuntimeKind;
  buildSha: string | null;
  buildSource: "artifact" | "unbuilt";
  capabilities: RuntimeCapability[];
  unknownCapabilities: string[];
  heartbeatAgeSeconds: number;
  startedAt: Date;
  /** A known build declaring every required capability. */
  compatible: boolean;
  /** Why not, when not. Empty when compatible. */
  incompatibilities: string[];
};

/**
 * Confirmation, from outside this repository, that the observed instances are every instance that
 * exists. Nothing produces `confirmed` today; see the header.
 */
export type DeploymentEvidence =
  | { kind: "none"; reason: string }
  | { kind: "confirmed"; inventory: string; confirmedAt: Date };

export type FleetObservation = {
  state: FleetConvergenceState;
  reason: string;
  observedBy: "runtimeInstances";
  liveTtlSeconds: number;
  requiredCapabilities: readonly RuntimeCapability[];
  live: {
    servers: number;
    workers: number;
    /** Distinct known builds among live instances. Informational; compatibility is by capability. */
    builds: string[];
    compatible: number;
    incompatible: ObservedRuntimeInstance[];
  };
  /** Registered, never stopped, heartbeat older than the TTL: a crash, or a host that lost its database. */
  stale: ObservedRuntimeInstance[];
  /** Per required capability: how many live instances there are and how many declare it. */
  capabilityCoverage: Record<string, { live: number; declaring: number }>;
  externalConfirmation: DeploymentEvidence;
};

/**
 * The one source of the `converged` state. No parameters: there is nothing a caller could pass that
 * would be evidence. When a hosting platform is selected and its inventory can be read, this is
 * where that read goes, and the preflight changes nowhere else.
 */
function deploymentEvidence(): DeploymentEvidence {
  return {
    kind: "none",
    reason:
      "no authoritative deployment inventory is connected: the production hosting platform is not yet selected " +
      "(HOSTING_TARGET unknown, S2-KMS-A), so the set of instances that exist cannot be compared with the set observed",
  };
}

export function classifyInstance(row: RuntimeInstanceRecord, required: readonly RuntimeCapability[]): ObservedRuntimeInstance {
  const parsed = parseCapabilities(row.capabilitiesJson);
  const capabilities = parsed?.capabilities ?? [];
  const incompatibilities: string[] = [];
  if (row.buildSource !== "artifact" || row.buildSha === null || !BUILD_SHA_PATTERN.test(row.buildSha)) {
    incompatibilities.push("build unknown: the instance runs from sources or recorded no build identity");
  }
  if (!parsed) incompatibilities.push("capability declaration unreadable");
  for (const cap of required) {
    if (!capabilities.includes(cap)) incompatibilities.push(`missing required capability ${cap}`);
  }
  return {
    instanceRef: row.instanceRef,
    runtimeKind: row.runtimeKind,
    buildSha: row.buildSha,
    buildSource: row.buildSource,
    capabilities,
    unknownCapabilities: parsed?.unknown ?? [],
    heartbeatAgeSeconds: row.heartbeatAgeSeconds,
    startedAt: row.startedAt,
    compatible: incompatibilities.length === 0,
    incompatibilities,
  };
}

/** Pure: rows in, observation out. The evidence is read inside; it is not an input. */
export function summarizeFleet(rows: readonly RuntimeInstanceRecord[], liveTtlSeconds = RUNTIME_LIVE_TTL_SECONDS): FleetObservation {
  const required = WEBHOOK_CUTOVER_REQUIRED_CAPABILITIES;
  const externalConfirmation = deploymentEvidence();

  const live: ObservedRuntimeInstance[] = [];
  const stale: ObservedRuntimeInstance[] = [];
  for (const row of rows) {
    const observed = classifyInstance(row, required);
    (row.heartbeatAgeSeconds < liveTtlSeconds ? live : stale).push(observed);
  }

  const servers = live.filter(i => i.runtimeKind === "server").length;
  const workers = live.filter(i => i.runtimeKind === "worker").length;
  const builds = Array.from(new Set(live.map(i => i.buildSha).filter((s): s is string => s !== null))).sort();
  const incompatible = live.filter(i => !i.compatible);
  const capabilityCoverage: Record<string, { live: number; declaring: number }> = {};
  for (const cap of required) {
    capabilityCoverage[cap] = { live: live.length, declaring: live.filter(i => i.capabilities.includes(cap)).length };
  }

  let state: FleetConvergenceState;
  let reason: string;
  if (live.length === 0) {
    state = "not_observable";
    reason =
      `no live runtime instance has registered within the last ${liveTtlSeconds}s` +
      (stale.length > 0 ? ` (${stale.length} stale registration(s) excluded)` : "") +
      "; nothing can be said about what is running";
  } else if (incompatible.length > 0) {
    state = "observed_incompatible";
    reason =
      `${incompatible.length} of ${live.length} live instance(s) cannot be counted compatible: ` +
      incompatible.map(i => `${i.instanceRef} (${i.runtimeKind}: ${i.incompatibilities.join("; ")})`).join(", ");
  } else if (externalConfirmation.kind === "confirmed") {
    state = "converged";
    reason =
      `every live instance (${servers} server, ${workers} worker, ${builds.length} build(s)) declares ${required.join(", ")}, ` +
      `and ${externalConfirmation.inventory} confirms these are all the instances that exist`;
  } else {
    state = "observed_compatible_external_confirmation_required";
    reason =
      `every live instance observed (${servers} server, ${workers} worker, ${builds.length} build(s)) declares ${required.join(", ")}; ` +
      `whether these are ALL the instances that exist cannot be established here: ${externalConfirmation.reason}`;
  }

  return {
    state,
    reason,
    observedBy: "runtimeInstances",
    liveTtlSeconds,
    requiredCapabilities: required,
    live: { servers, workers, builds, compatible: live.length - incompatible.length, incompatible },
    stale,
    capabilityCoverage,
    externalConfirmation,
  };
}

/** Read the registry and summarize it. Stopped instances are history and are not read. */
export async function observeFleet(db?: DbOrTx | null): Promise<FleetObservation> {
  const conn = db ?? (await getDb());
  if (!conn) throw new Error("fleet observation unavailable: no database connection");
  const rows = await conn
    .select({
      instanceRef: runtimeInstances.instanceRef,
      runtimeKind: runtimeInstances.runtimeKind,
      buildSha: runtimeInstances.buildSha,
      buildSource: runtimeInstances.buildSource,
      capabilitiesJson: runtimeInstances.capabilitiesJson,
      startedAt: runtimeInstances.startedAt,
      // The database's clock on both sides: the heartbeat wrote CURRENT_TIMESTAMP, this reads it back.
      heartbeatAgeSeconds: sql<number>`TIMESTAMPDIFF(SECOND, ${runtimeInstances.lastHeartbeatAt}, CURRENT_TIMESTAMP)`,
    })
    .from(runtimeInstances)
    .where(isNull(runtimeInstances.stoppedAt));
  return summarizeFleet(rows.map(r => ({ ...r, heartbeatAgeSeconds: Number(r.heartbeatAgeSeconds) })));
}
