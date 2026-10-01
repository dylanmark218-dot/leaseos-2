import mysql from "mysql2/promise";
import { startDrainWorker } from "./drainWorker";
import { createWorkerPorts } from "./workflowRuntime";
import { startOnce, withHandlers, type Lifecycle } from "./workerLifecycle";
import { handleClaimedEnforcementEvent } from "./enforcementOutbox";
import { getDb } from "../db";
import { sweepLiveAssist } from "../liveAssistService";
import { createSweepTicker, withSweepOnHeartbeat } from "./liveAssist/sweepTicker";
import { handleClaimedIntegrationInbound, sweepIntegrationHub } from "../integrationHubService";
import type { DomainEventHandler } from "./workerLifecycle";

export type ProductionWorker = { lifecycle: Lifecycle; close: () => Promise<void> };

export async function startProductionWorker(): Promise<ProductionWorker | null> {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.WORKFLOW_WORKER_DISABLED === "true") return null;
  const pool = mysql.createPool({ uri: url, connectionLimit: Number(process.env.WORKFLOW_DB_POOL_SIZE ?? 4) });
  const base = createWorkerPorts(pool);
  const db = await getDb();
  if (!db) { await pool.end(); throw new Error("Workflow worker requires DATABASE_URL"); }
  // LA-1a (owner ruling, docs/live-assist/LA1A_OWNER_RULING.md): bounded purge of expired Live Assist
  // transient state rides the existing heartbeat, after the webhook retry sweep, at most once a minute.
  // The ticker never throws — the drain loop awaits `heartbeat` outside its own try/catch, so a throw
  // here would stop outbox processing — and it logs counts and an error code only.
  const liveAssistSweep = createSweepTicker({
    run: at => sweepLiveAssist(db, at),
    log: (level, line) => (level === "warn" ? console.warn(line) : console.info(line)),
  });
  // Integration Hub — the same sweep-ticker pattern as Live Assist: dead-letter scan, sync
  // scheduling and execution, rate-limited and non-overlapping, added to the heartbeat without
  // disturbing what it already does.
  const integrationHubSweep = createSweepTicker({
    run: at => sweepIntegrationHub(db, at),
    intervalMs: 5_000,
    log: (level, line) => (level === "warn" ? console.warn(line) : console.info(line)),
  });
  const handlers: DomainEventHandler[] = [{
    name: "enforcement",
    matches: event => event.aggregateType === "enforcementEvent",
    handle: async event => {
      await handleClaimedEnforcementEvent(db, {
        aggregateId: event.aggregateId, payloadJson: event.payloadJson, tenantId: event.tenantId, now: new Date(),
      });
      return { tasksCreated: 0 };
    },
  }, {
    // Integration Hub — an accepted inbound event is processed under its connector's contract
    // here, on the one claimer.
    name: "integrationInbound",
    matches: event => event.aggregateType === "integrationInbound",
    handle: event => handleClaimedIntegrationInbound(db, { aggregateId: event.aggregateId, tenantId: event.tenantId, now: new Date() }),
  }];
  const ports = withHandlers(withSweepOnHeartbeat(withSweepOnHeartbeat(base, liveAssistSweep), integrationHubSweep), handlers);
  const workerId = process.env.WORKFLOW_WORKER_ID ?? `leaseos-${process.pid}`;
  const lifecycle = startOnce({
    workerId,
    start: () => startDrainWorker(ports, {
      workerId,
      batchSize: Number(process.env.WORKFLOW_BATCH_SIZE ?? 25),
      idleIntervalMs: Number(process.env.WORKFLOW_POLL_MS ?? 1000),
    }),
  });
  return { lifecycle, close: async () => { await lifecycle.stop(); await pool.end(); } };
}
