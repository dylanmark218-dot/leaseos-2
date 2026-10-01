/**
 * LA-1a — how the Live Assist purge rides the production worker without disturbing it.
 *
 * The drain loop (`drainWorker.ts`) awaits `ports.heartbeat` after every poll, OUTSIDE its own
 * try/catch: a heartbeat that throws ends the loop, and with it outbox processing, enforcement
 * notifications and webhook retries. So this ticker:
 *
 * - **never throws** — every failure is caught and turned into one log line;
 * - **runs at most once per interval** per process (default 60 s), although the heartbeat fires after
 *   every poll (about once a second when idle);
 * - **never overlaps itself** — a tick that arrives while the previous sweep is still running is skipped;
 * - **logs counts and an error code only** — never a message, a row, a reference or anything a person
 *   typed or photographed. A driver error message can quote the SQL it failed on, bound values
 *   included, so the message itself is never logged.
 *
 * Several worker processes may each run a ticker; `sweepLiveAssist` is written to be safe under that.
 */

export type SweepCounts = { expired: number; purgedSessions: number; rowsDeleted: number; failures: number };

export type TickOutcome = "ran" | "skipped_interval" | "skipped_running" | "failed";

export type SweepTicker = (at: Date) => Promise<TickOutcome>;

export function createSweepTicker(args: {
  run: (at: Date) => Promise<SweepCounts>;
  log: (level: "info" | "warn", line: string) => void;
  intervalMs?: number;
  clock?: () => number;
}): SweepTicker {
  const intervalMs = args.intervalMs ?? 60_000;
  const clock = args.clock ?? (() => Date.now());
  let lastStartedAt: number | null = null;
  let running = false;

  return async (at: Date) => {
    if (running) return "skipped_running";
    const t = at.getTime();
    if (lastStartedAt !== null && t - lastStartedAt < intervalMs) return "skipped_interval";
    running = true;
    lastStartedAt = t;
    const began = clock();
    try {
      const c = await args.run(at);
      const ms = clock() - began;
      if (c.expired || c.purgedSessions || c.rowsDeleted || c.failures) {
        args.log(c.failures ? "warn" : "info",
          `[worker] live assist sweep expired=${c.expired} purgedSessions=${c.purgedSessions} rowsDeleted=${c.rowsDeleted} failures=${c.failures} ms=${ms}`);
      }
      return "ran";
    } catch (e) {
      try { args.log("warn", `[worker] live assist sweep failed code=${errorCode(e)}`); } catch { /* a logger failure must not escape either */ }
      return "failed";
    } finally {
      running = false;
    }
  };
}

/** A driver error code such as `ER_LOCK_DEADLOCK`, or `unknown`. Never the message. */
export function errorCode(e: unknown): string {
  for (let x = e as { code?: unknown; cause?: unknown } | null | undefined, depth = 0; x && depth < 5; x = x.cause as typeof x, depth++) {
    if (typeof x.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(x.code)) return x.code;
  }
  return "unknown";
}

/**
 * Add the Live Assist sweep to a worker's heartbeat without disturbing what it already does: the existing
 * heartbeat runs first and in full, then the ticker. The result never rejects because of the sweep.
 */
export function withSweepOnHeartbeat<P extends { heartbeat?: (workerId: string, at: Date) => Promise<void> }>(ports: P, ticker: SweepTicker): P {
  return {
    ...ports,
    heartbeat: async (workerId: string, at: Date) => {
      await ports.heartbeat?.(workerId, at);
      await ticker(at);
    },
  };
}
