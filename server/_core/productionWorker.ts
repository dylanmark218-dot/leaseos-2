import mysql from "mysql2/promise";
import { startDrainWorker } from "./drainWorker";
import { createWorkerPorts } from "./workflowRuntime";
import { startOnce, withHandlers, type Lifecycle } from "./workerLifecycle";
import { handleClaimedEnforcementEvent } from "./enforcementOutbox";
import { BOARD_AGGREGATE_TYPES, handleClaimedBoardEvent } from "./boardOutbox";
import { getDb } from "../db";

export type ProductionWorker = { lifecycle: Lifecycle; close: () => Promise<void> };

export async function startProductionWorker(): Promise<ProductionWorker | null> {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.WORKFLOW_WORKER_DISABLED === "true") return null;
  const pool = mysql.createPool({ uri: url, connectionLimit: Number(process.env.WORKFLOW_DB_POOL_SIZE ?? 4) });
  const base = createWorkerPorts(pool);
  const db = await getDb();
  if (!db) { await pool.end(); throw new Error("Workflow worker requires DATABASE_URL"); }
  const ports = withHandlers(base, [{
    name: "enforcement",
    matches: event => event.aggregateType === "enforcementEvent",
    handle: async event => {
      await handleClaimedEnforcementEvent(db, {
        aggregateId: event.aggregateId, payloadJson: event.payloadJson, tenantId: event.tenantId, now: new Date(),
      });
      return { tasksCreated: 0 };
    },
  }, {
    // 0182/0183 — board and open-work events become in-app notifications, one per recipient.
    name: "board",
    matches: event => BOARD_AGGREGATE_TYPES.includes(event.aggregateType),
    handle: async event => {
      await handleClaimedBoardEvent(db, {
        eventId: event.eventId, eventType: event.eventType, aggregateId: event.aggregateId,
        payloadJson: event.payloadJson, tenantId: event.tenantId, now: new Date(),
      });
      return { tasksCreated: 0 };
    },
  }]);
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
