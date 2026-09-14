/**
 * v22.20 (0089) — one claim owner, started once, stopped cleanly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeQueueHealth, isWorkerRunning, onShutdown, resetLifecycleForTests,
  startOnce, withHandlers, WorkerAlreadyStarted, type DomainEventHandler,
} from "./_core/workerLifecycle";
import type { ClaimedEvent, WorkerHandle, WorkerPorts } from "./_core/drainWorker";

afterEach(() => resetLifecycleForTests());

const event = (eventType: string, id = 1): ClaimedEvent => ({
  id, eventId: `EVT-${id}`, eventType, aggregateType: "x", aggregateId: "A-1",
  tenantId: "default", branchId: null, payloadJson: "{}", attemptCount: 1,
  occurredAt: new Date(), jobId: null, tripId: null, unitId: null,
  correlationId: null, causationId: null, actorSource: "system",
} as unknown as ClaimedEvent);

function fakePorts(): WorkerPorts & { generic: number } {
  const o = {
    generic: 0,
    claimBatch: async () => [],
    processEvent: async () => { o.generic++; return { tasksCreated: 1 }; },
    markProcessed: async () => undefined,
    markFailed: async () => undefined,
  };
  return o as unknown as WorkerPorts & { generic: number };
}

describe("one claimer dispatches; it does not run two workers", () => {
  const enforcement: DomainEventHandler = {
    name: "enforcement",
    matches: e => e.eventType.startsWith("enforcement."),
    handle: async () => ({ tasksCreated: 4 }),
  };

  it("routes an enforcement event to its own handler, keeping its stricter behaviour", async () => {
    const ports = fakePorts();
    const wrapped = withHandlers(ports, [enforcement]);
    const r = await wrapped.processEvent(event("enforcement.out_of_service.issued"));
    expect(r.tasksCreated).toBe(4);
    expect(wrapped.dispatched[0].handler).toBe("enforcement");
    // The generic path was not also run — that would be the double processing.
    expect(ports.generic).toBe(0);
  });

  it("falls back to the workflow rules for ordinary traffic rather than dropping it", async () => {
    const ports = fakePorts();
    const wrapped = withHandlers(ports, [enforcement]);
    await wrapped.processEvent(event("unit.critical_defect_opened", 2));
    expect(wrapped.dispatched[0].handler).toBe("workflow_rules");
    expect(ports.generic).toBe(1);
  });

  it("uses the first matching handler and only that one", async () => {
    const seen: string[] = [];
    const a: DomainEventHandler = { name: "a", matches: () => true, handle: async () => { seen.push("a"); return { tasksCreated: 1 }; } };
    const b: DomainEventHandler = { name: "b", matches: () => true, handle: async () => { seen.push("b"); return { tasksCreated: 1 }; } };
    await withHandlers(fakePorts(), [a, b]).processEvent(event("anything"));
    expect(seen).toEqual(["a"]);
  });
});

describe("started exactly once per process", () => {
  const handle = (): WorkerHandle => ({ stop: () => undefined } as unknown as WorkerHandle);

  it("starts, and refuses a second start rather than quietly running two loops", () => {
    const first = startOnce({ start: handle, workerId: "worker-1" });
    expect(first.started).toBe(true);
    expect(isWorkerRunning()).toBe(true);

    // The lease does not catch this: both loops are live and both may claim.
    expect(() => startOnce({ start: handle, workerId: "worker-2" })).toThrow(WorkerAlreadyStarted);
    expect(() => startOnce({ start: handle, workerId: "worker-2" })).toThrow(/import accident/i);
  });

  it("can be started again after a clean stop", async () => {
    const first = startOnce({ start: handle, workerId: "worker-1" });
    await first.stop();
    expect(isWorkerRunning()).toBe(false);
    expect(() => startOnce({ start: handle, workerId: "worker-2" })).not.toThrow();
  });

  it("stops the worker before closing resources, so nothing dies holding a claim", async () => {
    const order: string[] = [];
    const lifecycle = startOnce({ start: () => ({ stop: () => order.push("worker stopped") } as unknown as WorkerHandle), workerId: "w" });
    const handlers: Record<string, () => Promise<void>> = {};
    onShutdown(lifecycle, async () => { order.push("pool closed"); }, ((sig: string, fn: () => Promise<void>) => { handlers[sig] = fn; }) as never);

    await handlers.SIGTERM();
    expect(order).toEqual(["worker stopped", "pool closed"]);
  });

  it("shuts down once even if both signals arrive", async () => {
    const closes = vi.fn(async () => undefined);
    const lifecycle = startOnce({ start: handle, workerId: "w" });
    const handlers: Record<string, () => Promise<void>> = {};
    onShutdown(lifecycle, closes, ((sig: string, fn: () => Promise<void>) => { handlers[sig] = fn; }) as never);
    await handlers.SIGTERM();
    await handlers.SIGINT();
    expect(closes).toHaveBeenCalledTimes(1);
  });
});

describe("queue health says what is wrong first", () => {
  it("names dead letters ahead of everything else", () => {
    const h = describeQueueHealth({ pending: 3, claimed: 1, retryWaiting: 2, deadLettered: 4, oldestPendingAgeSeconds: 30 });
    expect(h.line.startsWith("outbox: 4 DEAD-LETTERED")).toBe(true);
    expect(h.line).toContain("3 pending");
    expect(h.line).toContain("2 waiting to retry");
  });

  it("flags a backlog that has stopped moving", () => {
    const h = describeQueueHealth({ pending: 1, claimed: 0, retryWaiting: 0, deadLettered: 0, oldestPendingAgeSeconds: 3_600 });
    expect(h.line).toContain("oldest pending 60 min old");
  });

  it("stays quiet when there is nothing to say", () => {
    expect(describeQueueHealth({ pending: 0, claimed: 0, retryWaiting: 0, deadLettered: 0, oldestPendingAgeSeconds: null }).line)
      .toBe("outbox: 0 pending");
  });
});
