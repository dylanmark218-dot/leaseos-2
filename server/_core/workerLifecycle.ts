/**
 * v22.20 (0089) — one owner for the outbox, and a lifecycle that starts it once.
 *
 * Two things were missing between a drain worker that works and a drain worker
 * that runs.
 *
 * **One claim owner.** The generic workflow runtime can consume domain events,
 * and enforcement has its own consumer that writes out-of-service notifications
 * with stricter semantics. Starting both is two workers competing for the same
 * rows — precisely what the lease and `SKIP LOCKED` design exists to prevent,
 * and the one way to reintroduce the double-processing they were built to stop.
 * So there is one claimer, and it dispatches to a handler.
 *
 * Enforcement keeps its own handler rather than being flattened into a generic
 * workflow rule. Its acknowledgement and escalation behaviour is stricter than
 * a rule can express, and weakening it to fit would trade a real safety
 * property for tidiness.
 *
 * **Started exactly once.** A worker started twice because a module was
 * imported twice is not caught by the lease — both instances are live and both
 * are entitled to claim. The lifecycle holds a single handle and refuses a
 * second start.
 */

import type { ClaimedEvent, WorkerHandle, WorkerPorts } from "./drainWorker";

/**
 * One consequence path for one kind of event.
 *
 * `handle` runs after the event is claimed, and must be idempotent: the worker
 * can crash between the consequence committing and the event being marked
 * processed, and the replay has to be harmless.
 */
export type DomainEventHandler = {
  name: string;
  matches: (event: ClaimedEvent) => boolean;
  handle: (event: ClaimedEvent) => Promise<{ tasksCreated: number }>;
};

export type DispatchResult = { handler: string; tasksCreated: number };

/**
 * Wrap the generic ports so the single claimer routes each event to the first
 * handler that matches it, falling back to the workflow runtime's own
 * processing for everything else.
 *
 * The fallback matters: an event with no specialised handler is ordinary
 * workflow traffic and still has to be processed, not dropped.
 */
export function withHandlers(ports: WorkerPorts, handlers: readonly DomainEventHandler[]): WorkerPorts & { dispatched: DispatchResult[] } {
  const dispatched: DispatchResult[] = [];
  return {
    ...ports,
    dispatched,
    async processEvent(event: ClaimedEvent) {
      const handler = handlers.find(h => h.matches(event));
      if (!handler) {
        const generic = await ports.processEvent(event);
        dispatched.push({ handler: "workflow_rules", tasksCreated: generic.tasksCreated });
        return generic;
      }
      const result = await handler.handle(event);
      dispatched.push({ handler: handler.name, tasksCreated: result.tasksCreated });
      return result;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

export type QueueHealth = {
  pending: number;
  claimed: number;
  retryWaiting: number;
  deadLettered: number;
  oldestPendingAgeSeconds: number | null;
  /** One line. Dead letters are named first because nobody goes looking for them. */
  line: string;
};

export type Lifecycle = {
  started: boolean;
  workerId: string | null;
  stop: () => Promise<void>;
};

let current: { handle: WorkerHandle; workerId: string } | null = null;

export class WorkerAlreadyStarted extends Error {}

/**
 * Start the drain worker for this process.
 *
 * Refuses a second start rather than quietly running two. Multiple *processes*
 * are fine — that is what the lease and `SKIP LOCKED` are for — but two loops
 * inside one process is a module-import accident, not a scaling decision.
 */
export function startOnce(args: {
  start: () => WorkerHandle;
  workerId: string;
}): Lifecycle {
  if (current) {
    throw new WorkerAlreadyStarted(
      `A drain worker is already running in this process as ${current.workerId}. Two loops in one process is an import accident; run another process if you want more throughput.`,
    );
  }
  const handle = args.start();
  current = { handle, workerId: args.workerId };
  return {
    started: true,
    workerId: args.workerId,
    stop: async () => {
      current?.handle.stop();
      current = null;
    },
  };
}

/** For tests and for a process that legitimately restarts its worker. */
export function resetLifecycleForTests(): void {
  current?.handle.stop();
  current = null;
}

export const isWorkerRunning = (): boolean => current !== null;

/**
 * Register graceful shutdown. The worker is stopped before the pool closes, so
 * an event in flight finishes or releases its lease rather than being killed
 * holding a claim.
 */
export function onShutdown(lifecycle: Lifecycle, closeResources: () => Promise<void>, on = process.on.bind(process)): void {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await lifecycle.stop();
    await closeResources();
  };
  on("SIGTERM", handler);
  on("SIGINT", handler);
}

/** Read the queue's state for the operational health surface. */
export function describeQueueHealth(counts: Omit<QueueHealth, "line">): QueueHealth {
  const parts: string[] = [];
  if (counts.deadLettered) parts.push(`${counts.deadLettered} DEAD-LETTERED`);
  parts.push(`${counts.pending} pending`);
  if (counts.claimed) parts.push(`${counts.claimed} in flight`);
  if (counts.retryWaiting) parts.push(`${counts.retryWaiting} waiting to retry`);
  if (counts.oldestPendingAgeSeconds != null && counts.oldestPendingAgeSeconds > 300) {
    parts.push(`oldest pending ${Math.round(counts.oldestPendingAgeSeconds / 60)} min old`);
  }
  return { ...counts, line: `outbox: ${parts.join(" · ")}` };
}
