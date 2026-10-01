import { describe, expect, it } from "vitest";
import { createSweepTicker, errorCode, withSweepOnHeartbeat, type SweepCounts } from "./sweepTicker";

const zero: SweepCounts = { expired: 0, purgedSessions: 0, rowsDeleted: 0, failures: 0 };
const t = (s: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, s));

describe("LA-1a sweep ticker — riding the worker heartbeat safely", () => {
  it("runs at most once per interval although the heartbeat fires every poll", async () => {
    let runs = 0;
    const tick = createSweepTicker({ run: async () => { runs++; return zero; }, log: () => {}, intervalMs: 60_000 });
    expect(await tick(t(0))).toBe("ran");
    for (let s = 1; s < 60; s++) expect(await tick(t(s))).toBe("skipped_interval");
    expect(await tick(t(60))).toBe("ran");
    expect(runs).toBe(2);
  });

  it("never overlaps itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const tick = createSweepTicker({ run: async () => { await gate; return zero; }, log: () => {}, intervalMs: 0 });
    const first = tick(t(0));
    expect(await tick(t(1))).toBe("skipped_running");
    release();
    expect(await first).toBe("ran");
  });

  it("never throws into the drain loop, even when the sweep and the logger both fail", async () => {
    const tick = createSweepTicker({
      run: async () => { throw Object.assign(new Error("Duplicate entry 'ORG-SECRET-7' for key 'x'"), { code: "ER_DUP_ENTRY" }); },
      log: () => { throw new Error("logger down"); },
      intervalMs: 0,
    });
    await expect(tick(t(0))).resolves.toBe("failed");
  });

  it("logs counts and an error code only — never a message, a row or a reference", async () => {
    const lines: string[] = [];
    const log = (_l: "info" | "warn", line: string) => lines.push(line);
    const failing = createSweepTicker({
      run: async () => { throw Object.assign(new Error("UPDATE liveAssistSessions SET ... WHERE sessionRef = 'LAS-AAAAAAAAAAAAAAAAAAAAAAAA'"), { code: "ER_LOCK_DEADLOCK" }); },
      log, intervalMs: 0,
    });
    await failing(t(0));
    const ok = createSweepTicker({ run: async () => ({ expired: 2, purgedSessions: 1, rowsDeleted: 7, failures: 0 }), log, intervalMs: 0, clock: () => 0 });
    await ok(t(0));
    const quiet = createSweepTicker({ run: async () => zero, log, intervalMs: 0 });
    await quiet(t(0));
    expect(lines).toEqual([
      "[worker] live assist sweep failed code=ER_LOCK_DEADLOCK",
      "[worker] live assist sweep expired=2 purgedSessions=1 rowsDeleted=7 failures=0 ms=0",
    ]);
    for (const l of lines) expect(l).not.toMatch(/LAS-|ORG-|UPDATE|base64|data:/);
  });

  it("reduces an error to a driver code or 'unknown'", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "ER_LOCK_WAIT_TIMEOUT" }))).toBe("ER_LOCK_WAIT_TIMEOUT");
    expect(errorCode({ cause: { code: "ECONNRESET" } })).toBe("ECONNRESET");
    expect(errorCode(new Error("no code"))).toBe("unknown");
    expect(errorCode({ code: "not a code; DROP TABLE" })).toBe("unknown");
  });
});

describe("LA-1a sweep ticker — composed onto the existing heartbeat", () => {
  it("runs the existing heartbeat first and in full, then the sweep", async () => {
    const order: string[] = [];
    const ports = withSweepOnHeartbeat(
      { heartbeat: async (_id: string, _at: Date) => { order.push("webhook retry sweep"); }, other: 1 },
      async () => { order.push("live assist sweep"); return "ran" as const; },
    );
    await ports.heartbeat!("w1", t(0));
    expect(order).toEqual(["webhook retry sweep", "live assist sweep"]);
    expect(ports.other).toBe(1);
  });

  it("keeps the heartbeat resolving when the Live Assist sweep fails", async () => {
    const tick = createSweepTicker({ run: async () => { throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); }, log: () => {}, intervalMs: 0 });
    const ports = withSweepOnHeartbeat({ heartbeat: async (_id: string, _at: Date) => {} }, tick);
    await expect(ports.heartbeat!("w1", t(0))).resolves.toBeUndefined();
  });

  it("adds the sweep to a worker that had no heartbeat of its own", async () => {
    let ran = 0;
    const ports = withSweepOnHeartbeat({} as { heartbeat?: (id: string, at: Date) => Promise<void> }, async () => { ran++; return "ran" as const; });
    await ports.heartbeat!("w1", t(0));
    expect(ran).toBe(1);
  });
});
