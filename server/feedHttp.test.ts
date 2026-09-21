/**
 * v22.20 (0081) — the edge, and the secret that must not leave it.
 *
 * The "key" here is an invented fixture string. No real credential appears in
 * this file, and the point of the file is that one could not escape if it did.
 */
import { describe, expect, it } from "vitest";
import { buildRequest, httpFeedFetcher, redact, type FeedEndpoint, type HttpClient } from "./_core/feedHttp";
import { backoffSeconds, inBackoff, tick, type ScheduledFeed } from "./_core/feedScheduler";
import { emptyFeedState, type FeedSource, type FeedState } from "./_core/feedCollector";
import type { FeedRun } from "./_core/feedIngest";

const SECRET = "fixture-secret-not-a-real-key";
const env = { ALBERTA_511_API_KEY: SECRET };
const now = new Date("2026-09-11T12:00:00Z");

const source = (over: Partial<FeedSource> = {}): FeedSource => ({
  sourceKey: "ab511", displayName: "511 Alberta Developer API", status: "verified",
  rateLimitCalls: 10, rateLimitWindowSeconds: 60, updateIntervalHours: 1,
  advisoryOnly: true, credentialEnvVar: "ALBERTA_511_API_KEY", ...over,
});
const endpoint: FeedEndpoint = { sourceKey: "ab511", url: "https://example.invalid/events", credentialStyle: { kind: "query", parameter: "apikey" }, timeoutMs: 8000 };
const client = (r: { status: number; body?: string; headers?: Record<string, string> } | Error): HttpClient => ({
  async request() { if (r instanceof Error) throw r; return { status: r.status, body: r.body ?? "", headers: r.headers ?? {} }; },
});

describe("the request is built the way the publisher expects", () => {
  it("puts the key in the query where that is the style, and never in the headers", () => {
    const { url, headers } = buildRequest(endpoint, SECRET, null);
    expect(url).toContain("apikey=");
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it("puts it in the header where that is the style, and never in the URL", () => {
    const { url, headers } = buildRequest({ ...endpoint, credentialStyle: { kind: "header", header: "X-Api-Key" } }, SECRET, null);
    expect(headers["X-Api-Key"]).toBe(SECRET);
    expect(url).not.toContain(SECRET);
  });

  it("sends a conditional request when it has an ETag, so an unchanged feed costs nothing", () => {
    expect(buildRequest(endpoint, SECRET, 'W/"v4"').headers["If-None-Match"]).toBe('W/"v4"');
    expect(buildRequest(endpoint, SECRET, null).headers["If-None-Match"]).toBeUndefined();
  });

  it("sends no credential for a source that needs none", () => {
    const { url, headers } = buildRequest({ ...endpoint, credentialStyle: { kind: "none" } }, null, null);
    expect(url).toBe(endpoint.url);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });
});

describe("the secret cannot leave this module, even through an error", () => {
  it("redacts the key out of a thrown message that echoed the request URL", async () => {
    // This is the real hazard: a client that includes the full URL in its error,
    // which would otherwise be written into externalFeedRuns.errorText.
    const leaky = new Error(`connect ETIMEDOUT https://example.invalid/events?apikey=${SECRET}`);
    const r = await httpFeedFetcher({ endpoint, client: client(leaky), env }).fetch({ source: source(), entityTag: null });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.error).not.toContain(SECRET);
    expect(r.error).toContain("«redacted»");
  });

  it("redacts it out of a non-2xx body the publisher echoed back", async () => {
    const r = await httpFeedFetcher({ endpoint, client: client({ status: 403, body: `Forbidden for key ${SECRET}` }), env }).fetch({ source: source(), entityTag: null });
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.error).not.toContain(SECRET);
    expect(r.httpStatus).toBe(403);
  });

  it("leaves ordinary text alone and handles an absent secret", () => {
    expect(redact("connect ETIMEDOUT", SECRET)).toBe("connect ETIMEDOUT");
    expect(redact("anything at all", null)).toBe("anything at all");
    expect(redact("anything at all", "  ")).toBe("anything at all");
  });
});

describe("what the edge returns", () => {
  it("passes a 200 through with the publisher's ETag and Last-Modified", async () => {
    const r = await httpFeedFetcher({ endpoint, client: client({ status: 200, body: "[]", headers: { etag: 'W/"v5"', "last-modified": "Fri, 11 Sep 2026 11:40:00 GMT" } }), env }).fetch({ source: source(), entityTag: null });
    expect(r).toMatchObject({ status: "ok", httpStatus: 200, entityTag: 'W/"v5"', sourceVersion: "Fri, 11 Sep 2026 11:40:00 GMT" });
  });

  it("reports 304 as not_modified and keeps the tag it sent", async () => {
    const r = await httpFeedFetcher({ endpoint, client: client({ status: 304 }), env }).fetch({ source: source(), entityTag: 'W/"v4"' });
    expect(r).toMatchObject({ status: "not_modified", httpStatus: 304, entityTag: 'W/"v4"' });
  });

  it("turns a timeout into a failed run rather than a hung process", async () => {
    const r = await httpFeedFetcher({ endpoint, client: client(new Error("timeout of 8000ms exceeded")), env }).fetch({ source: source(), entityTag: null });
    expect(r).toMatchObject({ status: "error", httpStatus: null });
  });
});

describe("the scheduler is polite after a failure", () => {
  it("backs off exponentially and caps", () => {
    expect(backoffSeconds(0)).toBe(0);
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(4)).toBe(480);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it("holds a failing feed and releases it once the window passes", () => {
    const failing: FeedState = { ...emptyFeedState(), consecutiveFailures: 3, lastFailureAt: new Date(now.getTime() - 60_000) };
    expect(inBackoff(failing, now)).toMatchObject({ held: true });
    const older: FeedState = { ...failing, lastFailureAt: new Date(now.getTime() - 600_000) };
    expect(inBackoff(older, now)).toMatchObject({ held: false });
    expect(inBackoff(emptyFeedState(), now)).toMatchObject({ held: false });
  });

  it("skips a held feed without calling ingest, and still reports a line for it", async () => {
    const held: ScheduledFeed = { source: source(), state: { ...emptyFeedState(), consecutiveFailures: 2, lastFailureAt: new Date(now.getTime() - 10_000) }, credential: { present: true, envVar: "ALBERTA_511_API_KEY" } };
    const ok: ScheduledFeed = { source: source({ sourceKey: "drivebc_open511", credentialEnvVar: null }), state: emptyFeedState(), credential: null };
    let ingested = 0;
    const { result } = await tick({
      feeds: [held, ok], now,
      ingest: async f => { ingested++; return { run: { sourceKey: f.source.sourceKey, outcome: "succeeded", recordsSeen: 1, recordsAccepted: 1, recordsRejected: 0, rejections: [] } as unknown as FeedRun, state: { ...f.state, lastSuccessAt: now, consecutiveFailures: 0 } }; },
    });
    expect(ingested).toBe(1);
    expect(result.polled).toEqual(["drivebc_open511"]);
    expect(result.heldInBackoff[0]).toMatchObject({ sourceKey: "ab511" });
    expect(result.lines.some(l => l.includes("ab511: BACKOFF"))).toBe(true);
    // Every feed gets a health line every tick, held or not.
    expect(result.lines.filter(l => l.includes("ab511")).length).toBeGreaterThanOrEqual(2);
  });

  it("carries the updated state forward so the next tick sees it", async () => {
    const feed: ScheduledFeed = { source: source(), state: emptyFeedState(), credential: { present: true, envVar: "ALBERTA_511_API_KEY" } };
    const { feeds } = await tick({
      feeds: [feed], now,
      ingest: async f => ({ run: { sourceKey: f.source.sourceKey, outcome: "succeeded", recordsSeen: 0, recordsAccepted: 0, recordsRejected: 0, rejections: [] } as unknown as FeedRun, state: { ...f.state, lastSuccessAt: now } }),
    });
    expect(feeds[0].state.lastSuccessAt).toEqual(now);
  });
});
