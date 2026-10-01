import { describe, expect, it } from "vitest";
import {
  SESSION_STATES, TRANSITIONS, bindingVerdict, budgetVerdict, canTransition, decideOperation, evaluateDeadlines,
  initialDeadlines, isSessionRef, purgeAfterFor, refreshedIdleDeadline, sessionRefFromBytes, START_KEY_PATTERN,
  type SessionLimits,
} from "./session";

const limits: SessionLimits = { idleSeconds: 120, maxSessionMinutes: 20, retentionHours: 24, maxFramesPerSession: 60, maxInferenceCallsPerSession: 40 };
const t0 = new Date("2026-09-25T12:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);

describe("LA-1a session lifecycle — transitions", () => {
  it("permits exactly the transitions the design names", () => {
    expect(TRANSITIONS).toEqual({
      active: ["paused", "ended", "expired"],
      paused: ["active", "ended", "expired"],
      ended: [],
      expired: [],
    });
  });

  it("gives terminal states no way out, to any state", () => {
    for (const from of ["ended", "expired"] as const) {
      for (const to of SESSION_STATES) expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it("refuses resume, pause and heartbeat-driven change on a stopped session", () => {
    for (const s of ["ended", "expired"] as const) {
      expect(decideOperation(s, "resume")).toEqual({ kind: "refuse", code: "terminal" });
      expect(decideOperation(s, "pause")).toEqual({ kind: "refuse", code: "terminal" });
      expect(decideOperation(s, "heartbeat")).toEqual({ kind: "refuse", code: "terminal" });
    }
  });

  it("makes repeated requests land where the first one did (lifecycle idempotency)", () => {
    expect(decideOperation("paused", "pause")).toEqual({ kind: "noop" });
    expect(decideOperation("active", "resume")).toEqual({ kind: "noop" });
    expect(decideOperation("ended", "end")).toEqual({ kind: "noop" });
    expect(decideOperation("expired", "end")).toEqual({ kind: "noop" });
  });

  it("ends an open session with the user's reason", () => {
    expect(decideOperation("active", "end")).toEqual({ kind: "transition", to: "ended", reason: "user_end" });
    expect(decideOperation("paused", "end")).toEqual({ kind: "transition", to: "ended", reason: "user_end" });
    expect(decideOperation("active", "pause")).toEqual({ kind: "transition", to: "paused" });
    expect(decideOperation("paused", "resume")).toEqual({ kind: "transition", to: "active" });
  });
});

describe("LA-1a session lifecycle — server deadlines", () => {
  const d = initialDeadlines(t0, limits);

  it("computes deadlines from the server's clock and the snapshot, nothing else", () => {
    expect(d.idleDeadlineAt.toISOString()).toBe(at(120).toISOString());
    expect(d.hardDeadlineAt.toISOString()).toBe(at(1200).toISOString());
  });

  it("starts with the idle deadline no later than the hard one, even under a very short session limit", () => {
    const short = initialDeadlines(t0, { ...limits, idleSeconds: 120, maxSessionMinutes: 1 });
    expect(short.idleDeadlineAt.getTime()).toBe(short.hardDeadlineAt.getTime());
    expect(short.hardDeadlineAt.toISOString()).toBe(at(60).toISOString());
  });

  it("never moves the hard deadline, and never lets the idle deadline pass it", () => {
    expect(refreshedIdleDeadline(at(60), limits, d.hardDeadlineAt).toISOString()).toBe(at(180).toISOString());
    expect(refreshedIdleDeadline(at(1150), limits, d.hardDeadlineAt).toISOString()).toBe(d.hardDeadlineAt.toISOString());
  });

  it("expires an idle session and ends one that ran out of time, preferring the hard deadline", () => {
    const s = { state: "active" as const, ...d };
    expect(evaluateDeadlines(s, at(119))).toEqual({ kind: "within" });
    expect(evaluateDeadlines(s, at(120))).toEqual({ kind: "expired", reason: "idle_timeout" });
    expect(evaluateDeadlines({ ...s, idleDeadlineAt: at(5000) }, at(1200))).toEqual({ kind: "ended", reason: "budget_spent" });
    expect(evaluateDeadlines({ ...s, idleDeadlineAt: at(1), hardDeadlineAt: at(1) }, at(2))).toEqual({ kind: "ended", reason: "budget_spent" });
  });

  it("does not re-stop a stopped session", () => {
    expect(evaluateDeadlines({ state: "ended", idleDeadlineAt: at(0), hardDeadlineAt: at(0) }, at(9999))).toEqual({ kind: "within" });
  });

  it("derives purgeAfter from the stop time and retention", () => {
    expect(purgeAfterFor(at(0), limits).toISOString()).toBe(new Date(t0.getTime() + 24 * 3_600_000).toISOString());
  });
});

describe("LA-1a session references and binding", () => {
  it("builds references only from 18 random bytes, in one fixed shape", () => {
    const ref = sessionRefFromBytes(new Uint8Array(18).fill(7));
    expect(isSessionRef(ref)).toBe(true);
    expect(() => sessionRefFromBytes(new Uint8Array(17))).toThrow();
  });

  it("refuses malformed references before any query could run", () => {
    for (const bad of ["", "LAS-", "LAS-short", "las-AAAAAAAAAAAAAAAAAAAAAAAA", "LAS-AAAAAAAAAAAAAAAAAAAAAAA!", "LAS-AAAAAAAAAAAAAAAAAAAAAAAAA", "' OR 1=1 --", "AR-123"]) {
      expect(isSessionRef(bad), bad).toBe(false);
    }
    expect(START_KEY_PATTERN.test("short")).toBe(false);
    expect(START_KEY_PATTERN.test("a".repeat(65))).toBe(false);
    expect(START_KEY_PATTERN.test("retry-key_0123456789")).toBe(true);
  });

  it("binds a session to its owner AND its organization", () => {
    const s = { userId: 7, orgRef: "ORG-A" };
    expect(bindingVerdict(s, { userId: 7, orgRef: "ORG-A" })).toBe("owner");
    expect(bindingVerdict(s, { userId: 7, orgRef: "ORG-B" })).toBe("not_found");
    expect(bindingVerdict(s, { userId: 8, orgRef: "ORG-A" })).toBe("not_found");
  });
});

describe("LA-1a budgets are the server's", () => {
  it("refuses work past either per-session cap", () => {
    expect(budgetVerdict({ framesSubmitted: 59, inferenceCalls: 0 }, limits, { frames: 1, inferenceCalls: 0 })).toEqual({ allowed: true });
    expect(budgetVerdict({ framesSubmitted: 60, inferenceCalls: 0 }, limits, { frames: 1, inferenceCalls: 0 })).toEqual({ allowed: false, exhausted: "frames" });
    expect(budgetVerdict({ framesSubmitted: 0, inferenceCalls: 40 }, limits, { frames: 0, inferenceCalls: 1 })).toEqual({ allowed: false, exhausted: "inference_calls" });
  });
});
