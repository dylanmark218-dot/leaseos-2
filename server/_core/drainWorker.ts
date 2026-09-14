/**
 * Outbox drain worker.
 *
 * Claims events with `FOR UPDATE SKIP LOCKED`, evaluates rules, creates
 * workflows/tasks/notifications idempotently, marks the event processed —
 * all inside one transaction, so a crash mid-work leaves the event unclaimed
 * for the next attempt rather than half-processed.
 *
 * Failures are visible. An event that keeps failing becomes dead-lettered and
 * surfaces to administrators; it is never quietly abandoned.
 */

export type WorkerConfig = {
  workerId: string;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  /** Base for exponential backoff between retries of a failing event. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Sleep applied when a poll finds nothing, so the loop never spins. */
  idleIntervalMs: number;
};

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  workerId: "outbox-worker-1",
  batchSize: 20,
  pollIntervalMs: 500,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
  idleIntervalMs: 2_000,
};

export type EventStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed"
  | "dead_letter";

/**
 * Exponential backoff with full jitter. Jitter matters with several workers:
 * without it, a batch that fails together retries together, forever in step.
 */
export function backoffMs(
  attempt: number,
  cfg: Pick<WorkerConfig, "backoffBaseMs" | "backoffMaxMs">,
  random: () => number = Math.random
): number {
  const exponential = Math.min(
    cfg.backoffBaseMs * 2 ** Math.max(0, attempt - 1),
    cfg.backoffMaxMs
  );
  return Math.floor(random() * exponential);
}

export type AttemptOutcome = {
  status: EventStatus;
  retryAfterMs: number | null;
  reason: string;
};

/**
 * What to do after an attempt fails. Past maxAttempts the event stops being
 * retried and becomes an administrative problem instead of a silent one.
 */
export function classifyFailure(
  attemptCount: number,
  cfg: WorkerConfig,
  error: string,
  random: () => number = Math.random
): AttemptOutcome {
  if (attemptCount >= cfg.maxAttempts) {
    return {
      status: "dead_letter",
      retryAfterMs: null,
      reason: `Failed ${attemptCount} times, giving up: ${error}. Requires an administrator.`,
    };
  }
  return {
    status: "failed",
    retryAfterMs: backoffMs(attemptCount, cfg, random),
    reason: `Attempt ${attemptCount} of ${cfg.maxAttempts} failed: ${error}`,
  };
}

/** A poll that found nothing waits longer than one that found work. */
export function nextPollDelay(
  processedCount: number,
  cfg: WorkerConfig
): number {
  return processedCount === 0 ? cfg.idleIntervalMs : cfg.pollIntervalMs;
}

/* ===================== the loop ===================== */

export type ClaimedEvent = {
  id: number;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  branchId: string | null;
  payloadJson: string;
  attemptCount: number;
  occurredAt: Date;
};

export type WorkerPorts = {
  /** Claim up to `limit` events, locking them for this worker only. */
  claimBatch: (workerId: string, limit: number) => Promise<ClaimedEvent[]>;
  /** Process one event: rules → tasks → notifications. Must be idempotent. */
  processEvent: (event: ClaimedEvent) => Promise<{ tasksCreated: number }>;
  markProcessed: (id: number) => Promise<void>;
  markFailed: (id: number, outcome: AttemptOutcome) => Promise<void>;
  heartbeat?: (workerId: string, at: Date) => Promise<void>;
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    meta?: unknown
  ) => void;
};

export type WorkerStats = {
  polls: number;
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
  tasksCreated: number;
};

export type WorkerHandle = {
  stop: () => void;
  stats: () => WorkerStats;
  /** Resolves once the loop has finished its current pass and exited. */
  done: Promise<WorkerStats>;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Run the drain loop until stopped. Shutdown is graceful: `stop()` lets the
 * current batch finish rather than abandoning claimed events mid-transaction.
 */
export function startDrainWorker(
  ports: WorkerPorts,
  config: Partial<WorkerConfig> = {}
): WorkerHandle {
  const cfg: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...config };
  const stats: WorkerStats = {
    polls: 0,
    claimed: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    tasksCreated: 0,
  };
  let running = true;

  const done = (async () => {
    while (running) {
      stats.polls++;
      let handled = 0;

      try {
        const batch = await ports.claimBatch(cfg.workerId, cfg.batchSize);
        stats.claimed += batch.length;

        for (const event of batch) {
          if (!running) break;
          try {
            const result = await ports.processEvent(event);
            await ports.markProcessed(event.id);
            stats.processed++;
            stats.tasksCreated += result.tasksCreated;
            handled++;
          } catch (err) {
            const outcome = classifyFailure(
              event.attemptCount + 1,
              cfg,
              (err as Error).message ?? String(err)
            );
            await ports.markFailed(event.id, outcome);
            if (outcome.status === "dead_letter") {
              stats.deadLettered++;
              ports.log?.("error", "Event dead-lettered", {
                eventId: event.eventId,
                type: event.eventType,
                reason: outcome.reason,
              });
            } else {
              stats.failed++;
              ports.log?.("warn", "Event failed, will retry", {
                eventId: event.eventId,
                retryAfterMs: outcome.retryAfterMs,
              });
            }
          }
        }
      } catch (err) {
        // A claim failure is infrastructure, not a bad event. Back off and
        // retry rather than treating every queued event as poisonous.
        ports.log?.("error", "Claim failed", { error: (err as Error).message });
        await sleep(cfg.idleIntervalMs);
        continue;
      }

      await ports.heartbeat?.(cfg.workerId, new Date());
      if (!running) break;
      await sleep(nextPollDelay(handled, cfg));
    }
    return stats;
  })();

  return {
    stop: () => {
      running = false;
    },
    stats: () => ({ ...stats }),
    done,
  };
}

/* ===================== observability ===================== */

export type QueueHealth = {
  pending: number;
  processing: number;
  failed: number;
  deadLetter: number;
  oldestPendingAgeSeconds: number | null;
  state: "healthy" | "lagging" | "degraded";
  message: string;
};

/**
 * Queue health from counts alone. Dead letters mean something needs a person,
 * so they degrade the state regardless of how fast the queue is moving.
 */
export function assessQueueHealth(
  counts: {
    pending: number;
    processing: number;
    failed: number;
    deadLetter: number;
  },
  oldestPendingAgeSeconds: number | null,
  lagThresholdSeconds = 120
): QueueHealth {
  const state: QueueHealth["state"] =
    counts.deadLetter > 0
      ? "degraded"
      : oldestPendingAgeSeconds !== null &&
          oldestPendingAgeSeconds > lagThresholdSeconds
        ? "lagging"
        : "healthy";

  const message =
    state === "degraded"
      ? `${counts.deadLetter} event(s) dead-lettered and need an administrator.`
      : state === "lagging"
        ? `Oldest unprocessed event is ${oldestPendingAgeSeconds}s old — the worker is behind.`
        : "Queue is current.";

  return { ...counts, oldestPendingAgeSeconds, state, message };
}
