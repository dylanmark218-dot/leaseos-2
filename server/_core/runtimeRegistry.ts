/**
 * S2-FLEET-A — the runtime instance registry: who is running, on which build, with which capabilities.
 *
 * Every production process registers itself here at startup, before it can accept work, and keeps
 * a heartbeat while it runs. The server entrypoint (`startup.ts`) and the standalone worker
 * (`worker.ts`) both go through `registerThisRuntime`, so neither can be deployed unobserved. The
 * fleet observation (`server/fleetObservationService.ts`) reads this table and nothing else.
 *
 * LIVENESS. A heartbeat every RUNTIME_HEARTBEAT_INTERVAL_MS; an instance is live while its last
 * heartbeat is younger than RUNTIME_LIVE_TTL_MS. The TTL is four intervals: one missed heartbeat is
 * a slow database, four is a process that is gone. Both are below the workflow claim lease
 * (`workflowRuntime.ts`, 120 s) so a vanished worker reads as stale before its claims expire, and
 * they are judged on the DATABASE clock (`CURRENT_TIMESTAMP` on write, `TIMESTAMPDIFF` on read) so
 * two hosts with drifting clocks cannot make each other look dead or alive.
 *
 * IDENTITY IS IMMUTABLE. The INSERT is the only statement that writes build or capabilities; a
 * heartbeat updates `lastHeartbeatAt` alone, a stop sets `stoppedAt` alone, and a second INSERT with
 * the same `instanceRef` fails on the unique index rather than rewriting the first. There is no
 * upsert here and must not be: an upsert is how a later process would relabel an earlier one.
 *
 * AUTHORITY. Nothing exports a way for a request to reach these writes. No router imports this
 * module (`fleetWiring.test.ts` pins that); the writers are the two entrypoints and the tests.
 */
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { runtimeInstances } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { describeBuild, requireBuildIdentity, runtimeBuild, type RuntimeBuild } from "./buildIdentity";
import { declaredCapabilities, type RuntimeCapability } from "./runtimeCapabilities";

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNTIME_LIVE_TTL_MS = 60_000;
export const RUNTIME_LIVE_TTL_SECONDS = RUNTIME_LIVE_TTL_MS / 1000;

export type RuntimeKind = "server" | "worker";

export type RuntimeInstanceIdentity = Readonly<{
  /** `rt_` + a random UUID, minted at process start. Never derived from pid or hostname. */
  instanceRef: string;
  runtimeKind: RuntimeKind;
  build: RuntimeBuild;
  capabilities: readonly RuntimeCapability[];
}>;

export class RuntimeRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRegistrationError";
  }
}

export function newRuntimeInstanceIdentity(
  runtimeKind: RuntimeKind,
  build: RuntimeBuild = runtimeBuild(),
  capabilities: readonly RuntimeCapability[] = declaredCapabilities()
): RuntimeInstanceIdentity {
  return Object.freeze({
    instanceRef: `rt_${randomUUID()}`,
    runtimeKind,
    build,
    capabilities: Object.freeze([...capabilities]),
  });
}

/** INSERT only. A duplicate `instanceRef` is a unique-index failure, never an update. */
export async function registerRuntimeInstance(db: DbOrTx, identity: RuntimeInstanceIdentity): Promise<void> {
  const artifact = identity.build.source === "artifact" ? identity.build.identity : null;
  await db.insert(runtimeInstances).values({
    instanceRef: identity.instanceRef,
    runtimeKind: identity.runtimeKind,
    buildSha: artifact?.sha ?? null,
    buildRelease: artifact?.release ?? null,
    buildSource: identity.build.source,
    capabilitiesJson: JSON.stringify(identity.capabilities),
  });
}

/** Moves `lastHeartbeatAt` to the database's now. Touches nothing else; a stopped instance is left alone. */
export async function heartbeatRuntimeInstance(db: DbOrTx, instanceRef: string): Promise<void> {
  await db
    .update(runtimeInstances)
    .set({ lastHeartbeatAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(runtimeInstances.instanceRef, instanceRef), isNull(runtimeInstances.stoppedAt)));
}

/** Graceful shutdown. Sets `stoppedAt` once; a crash never reaches this and expires by TTL instead. */
export async function stopRuntimeInstance(db: DbOrTx, instanceRef: string): Promise<void> {
  await db
    .update(runtimeInstances)
    .set({ stoppedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(runtimeInstances.instanceRef, instanceRef), isNull(runtimeInstances.stoppedAt)));
}

export type RuntimeRegistration = {
  readonly identity: RuntimeInstanceIdentity;
  /** Stops the heartbeat and marks the instance stopped. Idempotent. */
  close(): Promise<void>;
};

export type RegistrationOptions = {
  intervalMs?: number;
  onHeartbeatError?: (error: unknown) => void;
};

/** Register, then heartbeat until closed. The timer is unref'd so it never keeps a process alive. */
export async function startRuntimeRegistration(
  db: DbOrTx,
  identity: RuntimeInstanceIdentity,
  options: RegistrationOptions = {}
): Promise<RuntimeRegistration> {
  await registerRuntimeInstance(db, identity);
  const intervalMs = options.intervalMs ?? RUNTIME_HEARTBEAT_INTERVAL_MS;
  let inFlight = false;
  let closed = false;
  const timer = setInterval(() => {
    if (inFlight || closed) return;
    inFlight = true;
    heartbeatRuntimeInstance(db, identity.instanceRef)
      .catch(error => options.onHeartbeatError?.(error))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    identity,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await stopRuntimeInstance(db, identity.instanceRef);
    },
  };
}

export type RegisterThisRuntimeOptions = {
  /** Production rules: a built artifact and a successful registration, or no start at all. */
  production: boolean;
  /**
   * Tests inject a connection. The entrypoints leave this unset and the registry opens a small pool
   * of its own on DATABASE_URL, which `close()` ends — so a server that has nothing else open exits
   * cleanly after SIGTERM, as Gate 7a requires, rather than being held up by an idle connection.
   */
  db?: DbOrTx | null;
  intervalMs?: number;
  log?: (line: string) => void;
};

/**
 * The entrypoint call: identify this build, register this process, start its heartbeat.
 *
 * In production every failure here is a refusal to start — an unbuilt process, no database, a
 * rejected INSERT — because a process that cannot be observed must not become ready. Outside
 * production (development, tests) a missing database or a failed registration is logged and the
 * process runs unobserved, so `pnpm dev` without a database still works.
 */
export async function registerThisRuntime(
  runtimeKind: RuntimeKind,
  options: RegisterThisRuntimeOptions
): Promise<RuntimeRegistration | null> {
  const log = options.log ?? ((line: string) => console.log(line));

  let ownedPool: mysql.Pool | null = null;
  let db: DbOrTx | null;
  if (options.db !== undefined) {
    db = options.db;
  } else if (process.env.DATABASE_URL) {
    ownedPool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 2 });
    db = drizzle(ownedPool);
  } else {
    db = null;
  }
  if (!db) {
    if (options.production) {
      throw new RuntimeRegistrationError(
        "runtime registration requires a database in production: DATABASE_URL is unset or the connection failed, " +
          "so this instance cannot be observed and must not become ready"
      );
    }
    log(`[runtime] not registered: no database; a ${runtimeKind} outside production may run unobserved`);
    return null;
  }

  const build = requireBuildIdentity(runtimeBuild(), options.production);
  log(describeBuild(build));

  const identity = newRuntimeInstanceIdentity(runtimeKind, build);
  const intervalMs = options.intervalMs ?? RUNTIME_HEARTBEAT_INTERVAL_MS;
  let registration: RuntimeRegistration;
  try {
    registration = await startRuntimeRegistration(db, identity, {
      intervalMs,
      onHeartbeatError: error =>
        console.warn(`[runtime] heartbeat failed for ${identity.instanceRef}: ${error instanceof Error ? error.message : String(error)}`),
    });
  } catch (error) {
    await ownedPool?.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (options.production) throw new RuntimeRegistrationError(`runtime registration failed: ${message}`);
    log(`[runtime] not registered: ${message}; a ${runtimeKind} outside production may run unobserved`);
    return null;
  }
  log(
    `[runtime] registered ${identity.instanceRef} kind=${runtimeKind} capabilities=${identity.capabilities.join(",")} ` +
      `heartbeat=${intervalMs}ms ttl=${RUNTIME_LIVE_TTL_MS}ms`
  );
  if (!ownedPool) return registration;
  const pool = ownedPool;
  return {
    identity,
    close: async () => {
      await registration.close();
      await pool.end();
    },
  };
}
