/**
 * P1.6 — a refusal the device can act on, and the one it must never retry.
 *
 * The failure this prevents: a package refused for a wrong clock is refused again on every retry,
 * for ever, because retrying does not move a clock. Left alone the outbox grows, the screen says
 * "syncing", and the driver's evidence never lands — a failure that looks like progress, which is
 * worse than one that looks like a failure.
 */
import { describe, expect, it } from "vitest";
import { handleSyncRefusal, isRetryable, signatureFreshness, type SyncRefusalCode } from "./deviceSignature";

const NOW = new Date("2026-09-18T12:00:00Z");

describe("a wrong clock stops the queue instead of spinning it", () => {
  it("never retries a clock-skew refusal", () => {
    expect(isRetryable("CLOCK_SKEW_TOO_LARGE")).toBe(false);
    const h = handleSyncRefusal({ code: "CLOCK_SKEW_TOO_LARGE", skewMs: 26 * 60 * 60 * 1000, serverTimeIso: NOW.toISOString() });
    expect(h.action).toBe("stop_and_prompt");
    if (h.action !== "stop_and_prompt") throw new Error("unreachable");
    expect(h.title).toBe("This device's clock is wrong");
    // The driver cannot correct a clock they cannot compare against, so the server's own time is in
    // the instruction rather than left for them to guess at.
    expect(h.instruction).toMatch(/2026-09-18T12:00:00/);
    expect(h.instruction).toMatch(/about 26 hour\(s\) behind the server/);
    expect(h.instruction).toMatch(/Set the device to network time/);
    // And it says the work is safe, because the natural fear at this prompt is that it was lost.
    expect(h.instruction).toMatch(/Nothing is lost|queue is holding/);
    expect(h.instruction).toMatch(/retrying without fixing the clock will keep failing/);
  });

  it("says ahead when the device is ahead", () => {
    const h = handleSyncRefusal({ code: "CLOCK_SKEW_TOO_LARGE", skewMs: -30 * 60 * 60 * 1000 });
    if (h.action !== "stop_and_prompt") throw new Error("unreachable");
    expect(h.instruction).toMatch(/ahead of the server/);
  });

  it("copes when the server could not work out the skew at all", () => {
    const h = handleSyncRefusal({ code: "NO_DEVICE_CLOCK", serverTimeIso: NOW.toISOString() });
    if (h.action !== "stop_and_prompt") throw new Error("unreachable");
    expect(h.instruction).toMatch(/Set the device to network time/);
    expect(h.instruction).not.toMatch(/undefined|NaN/);
  });
});

describe("what the driver can fix, and what only the office can", () => {
  it("sends an enrolment problem to the office rather than to the driver", () => {
    for (const code of ["DEVICE_NOT_ENROLLED", "DEVICE_NOT_ACTIVE"] as SyncRefusalCode[]) {
      const h = handleSyncRefusal({ code });
      expect(h.action, code).toBe("stop_and_escalate");
      if (h.action !== "stop_and_escalate") throw new Error("unreachable");
      // Telling a driver to fix an enrolment is telling them to do something they cannot do.
      expect(h.instruction).toMatch(/not lost/);
      expect(h.instruction).toMatch(/office/);
    }
  });

  it("does not ask a driver to wait on something retrying cannot change", () => {
    for (const code of ["SIGNATURE_INVALID", "MALFORMED"] as SyncRefusalCode[]) {
      expect(isRetryable(code), code).toBe(false);
      const h = handleSyncRefusal({ code });
      if (h.action === "retry") throw new Error("unreachable");
      expect(h.instruction).toMatch(/retrying will not change the result|nothing you can do here/i);
    }
  });

  it("moves on from a replay, because the server already has it", () => {
    // The one retryable case, and it is retryable in the sense of "carry on with the next one" —
    // treating it as a hard stop would strand a queue over a package that already arrived.
    expect(isRetryable("REPLAY")).toBe(true);
    const h = handleSyncRefusal({ code: "REPLAY" });
    if (h.action !== "retry") throw new Error("unreachable");
    expect(h.reason).toMatch(/already accepted/);
  });

  it("gives every code a handling, so a new one cannot fall through to silence", () => {
    const codes: SyncRefusalCode[] = ["CLOCK_SKEW_TOO_LARGE", "SIGNATURE_STALE", "NO_DEVICE_CLOCK", "DEVICE_NOT_ENROLLED", "DEVICE_NOT_ACTIVE", "SIGNATURE_INVALID", "REPLAY", "MALFORMED"];
    for (const code of codes) expect(handleSyncRefusal({ code }).action, code).toBeTruthy();
  });
});

describe("the server tags its refusals with a code, not only a sentence", () => {
  it("tags a clock beyond a day", () => {
    const v = signatureFreshness({ signedAt: NOW, now: NOW, deviceClockAt: new Date("2026-09-16T12:00:00Z") });
    expect(v.fresh).toBe(false);
    if (v.fresh) throw new Error("unreachable");
    expect(v.code).toBe("CLOCK_SKEW_TOO_LARGE");
    expect(v.reason).toMatch(/beyond a da/);        // the sentence stays, for a person to read
  });

  it("tags a signature stale by the device's own clock", () => {
    const v = signatureFreshness({ signedAt: new Date("2026-09-18T11:00:00Z"), now: NOW, deviceClockAt: NOW });
    expect(v.fresh).toBe(false);
    if (v.fresh) throw new Error("unreachable");
    expect(v.code).toBe("SIGNATURE_STALE");
  });

  it("tags a package that reported no device clock at all", () => {
    const v = signatureFreshness({ signedAt: new Date("2026-09-18T11:00:00Z"), now: NOW, deviceClockAt: null });
    expect(v.fresh).toBe(false);
    if (v.fresh) throw new Error("unreachable");
    expect(v.code).toBe("NO_DEVICE_CLOCK");
  });

  it("leaves a fresh package alone", () => {
    expect(signatureFreshness({ signedAt: NOW, now: NOW, deviceClockAt: NOW }).fresh).toBe(true);
  });
});
