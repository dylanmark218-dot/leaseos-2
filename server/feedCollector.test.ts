/**
 * v22.20 — one collector, and the gates that keep it one.
 *
 * No API key appears in this file or anywhere in the source tree. The
 * credential is read from the environment by name and its presence is all the
 * collector ever learns about it.
 */
import { describe, expect, it } from "vitest";
import {
  AdvisorySourceViolation, credentialFromEnv, emptyFeedState, feedHealth, feedHealthLines,
  quota, recordCall, shouldPoll, toAdvisory, type FeedSource, type FeedState,
} from "./_core/feedCollector";

const now = new Date("2026-09-11T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

// Exactly what the registry records for Alberta 511: ten calls per sixty
// seconds, hourly updates, attribution required, licence not cleared.
const ab511 = (over: Partial<FeedSource> = {}): FeedSource => ({
  sourceKey: "ab511", displayName: "511 Alberta Developer API", status: "unverified",
  rateLimitCalls: 10, rateLimitWindowSeconds: 60, updateIntervalHours: 1,
  advisoryOnly: true, credentialEnvVar: "ALBERTA_511_API_KEY", ...over,
});
const present = { present: true, envVar: "ALBERTA_511_API_KEY" };

describe("the credential never enters the source tree", () => {
  it("learns only whether a key is present, by environment variable name", () => {
    expect(credentialFromEnv("ALBERTA_511_API_KEY", { ALBERTA_511_API_KEY: "whatever-this-is" })).toEqual({ present: true, envVar: "ALBERTA_511_API_KEY" });
    expect(credentialFromEnv("ALBERTA_511_API_KEY", {})).toEqual({ present: false, envVar: "ALBERTA_511_API_KEY" });
    expect(credentialFromEnv("ALBERTA_511_API_KEY", { ALBERTA_511_API_KEY: "   " }).present).toBe(false);
  });
});

describe("a key is permission to call, not a record of what the terms permit", () => {
  it("will not poll a source nobody has cleared, however good the credential is", () => {
    const d = shouldPoll(ab511(), emptyFeedState(), now, present);
    expect(d.poll).toBe(false);
    if (d.poll) return;
    expect(d.blockedBy).toBe("not_cleared");
    expect(d.reason).toContain("not a record of what its terms permit");
  });

  it("will not poll a cleared source with no credential, and names the variable rather than the key", () => {
    const d = shouldPoll(ab511({ status: "verified" }), emptyFeedState(), now, { present: false, envVar: "ALBERTA_511_API_KEY" });
    expect(d.poll).toBe(false);
    if (d.poll) return;
    expect(d.blockedBy).toBe("no_credential");
    expect(d.reason).toContain("ALBERTA_511_API_KEY");
    expect(d.reason).toContain("never in the source tree");
  });

  it("polls once both are true", () => {
    expect(shouldPoll(ab511({ status: "verified" }), emptyFeedState(), now, present)).toMatchObject({ poll: true });
  });

  it("never polls a withdrawn or superseded source", () => {
    for (const status of ["withdrawn", "superseded"] as const) {
      expect(shouldPoll(ab511({ status }), emptyFeedState(), now, present)).toMatchObject({ poll: false, blockedBy: "withdrawn" });
    }
  });
});

describe("the published limit is enforced here, so the publisher never has to", () => {
  const src = ab511({ status: "verified" });
  const withCalls = (n: number, secondsAgo = 10): FeedState => ({ ...emptyFeedState(), recentCallsAt: Array.from({ length: n }, () => new Date(now.getTime() - secondsAgo * 1000)) });

  it("counts only calls inside the window", () => {
    expect(quota(src, withCalls(4, 10), now)).toMatchObject({ used: 4, limit: 10, remaining: 6 });
    // Ten calls, but all of them more than sixty seconds ago.
    expect(quota(src, withCalls(10, 120), now)).toMatchObject({ used: 0, remaining: 10 });
  });

  it("refuses the eleventh call in sixty seconds and says when it may retry", () => {
    const d = shouldPoll(src, withCalls(10, 20), now, present);
    expect(d.poll).toBe(false);
    if (d.poll) return;
    expect(d.blockedBy).toBe("quota_exhausted");
    expect(d.reason).toContain("10 calls per 60s");
    expect(d.retryAfterSeconds).toBe(40);
  });

  it("does not poll faster than the publisher updates", () => {
    const fresh: FeedState = { ...emptyFeedState(), lastSuccessAt: ago(20) };
    const d = shouldPoll(src, fresh, now, present);
    expect(d.poll).toBe(false);
    if (d.poll) return;
    expect(d.blockedBy).toBe("not_due");
    expect(d.retryAfterSeconds).toBe(40 * 60);
  });

  it("keeps the window rolling as calls are recorded, and resets the failure run on success", () => {
    let s = emptyFeedState();
    for (let i = 0; i < 3; i++) s = recordCall(s, new Date(now.getTime() - (3 - i) * 1000), { ok: false, reason: "502" }, src);
    expect(s.consecutiveFailures).toBe(3);
    s = recordCall(s, now, { ok: true }, src);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastSuccessAt).toEqual(now);
    expect(quota(src, s, now).used).toBe(4);
  });
});

describe("what a traffic feed gives us is advisory, and the type says so", () => {
  const src = ab511({ status: "verified" });
  const raw = { externalId: "EVT-1", kind: "closure" as const, headline: "Road closed", area: { latitude: 53.5, longitude: -113.5 }, startsAt: now, endsAt: null, retrievedAt: now, sourceVersion: "2026-09-11T12:00Z" };

  it("marks every record advisory-only and cannot be made to say otherwise", () => {
    const a = toAdvisory(src, raw);
    expect(a).toMatchObject({ sourceKey: "ab511", isVerifiedRestriction: false, determination: "advisory_only" });
  });

  it("refuses to normalize through this path a source that is not registered advisory-only", () => {
    expect(() => toAdvisory(ab511({ status: "verified", advisoryOnly: false }), raw)).toThrow(AdvisorySourceViolation);
  });
});

describe("the one line", () => {
  const src = ab511({ status: "verified" });
  it("distinguishes blocked, never-polled, ok, stale and failing without guessing", () => {
    expect(feedHealth(ab511(), emptyFeedState(), now, present).line).toContain("BLOCKED");
    expect(feedHealth(src, emptyFeedState(), now, present).line).toContain("NEVER POLLED");
    expect(feedHealth(src, { ...emptyFeedState(), lastSuccessAt: ago(30) }, now, present).line).toContain("OK — last success 30 min ago");
    expect(feedHealth(src, { ...emptyFeedState(), lastSuccessAt: ago(600) }, now, present).line).toContain("STALE");
    expect(feedHealth(src, { ...emptyFeedState(), lastSuccessAt: ago(10), consecutiveFailures: 4, lastFailureReason: "timeout" }, now, present).line).toContain("FAILING");
  });

  it("carries the quota in every line, so exhaustion is visible before it bites", () => {
    const s: FeedState = { ...emptyFeedState(), lastSuccessAt: ago(30), recentCallsAt: [ago(0.2), ago(0.3)] };
    expect(feedHealth(src, s, now, present).line).toContain("2/10 in 60s");
  });

  it("gives one line per feed", () => {
    const lines = feedHealthLines([
      { source: src, state: { ...emptyFeedState(), lastSuccessAt: ago(5) }, credential: present },
      { source: ab511({ sourceKey: "drivebc_open511", displayName: "Open511-DriveBC", status: "verified", credentialEnvVar: null, rateLimitCalls: null, rateLimitWindowSeconds: null }), state: emptyFeedState(), credential: null },
    ], now);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ab511: OK");
    expect(lines[1]).toContain("drivebc_open511: NEVER POLLED");
    expect(lines[1]).toContain("unmetered");
  });
});
