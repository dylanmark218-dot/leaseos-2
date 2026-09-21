/**
 * v22.20 (0081) — the ingestion lifecycle, proven in Node against fakes.
 *
 * No credential appears here. The fake fetcher never sees one and never needs
 * to: the collector's job is to decide whether a call is allowed, and the real
 * adapter reads the key from the environment at the edge.
 */
import { describe, expect, it } from "vitest";
import { emptyFeedState, type FeedSource, type FeedState } from "./_core/feedCollector";
import { contentHashOf, ingestFeed, runLine, type AdvisoryStore, type FeedFetcher, type FeedRun, type Normalizer, type StoredAdvisory } from "./_core/feedIngest";
import type { RoadAdvisory } from "./_core/advisoryImpact";

const at = new Date("2026-09-11T12:00:00Z");
const cleared = (over: Partial<FeedSource> = {}): FeedSource => ({
  sourceKey: "ab511", displayName: "511 Alberta Developer API", status: "verified",
  rateLimitCalls: 10, rateLimitWindowSeconds: 60, updateIntervalHours: 1,
  advisoryOnly: true, credentialEnvVar: "ALBERTA_511_API_KEY", ...over,
});
const present = { present: true, envVar: "ALBERTA_511_API_KEY" };
const due: FeedState = emptyFeedState();

function fakeStore(seed: StoredAdvisory[] = []) {
  const active = [...seed];
  const inserted: (RoadAdvisory & { advisoryRef: string })[] = [];
  const superseded: { advisoryRef: string; by: string }[] = [];
  const withdrawn: string[] = [];
  const runs: FeedRun[] = [];
  const store: AdvisoryStore = {
    async activeByExternalRef() { return active; },
    async insert(a) { inserted.push(a); },
    async supersede(advisoryRef, by) { superseded.push({ advisoryRef, by }); },
    async withdraw(advisoryRef) { withdrawn.push(advisoryRef); },
    async recordRun(r) { runs.push(r); },
  };
  return { store, inserted, superseded, withdrawn, runs };
}

const fetcher = (result: Parameters<FeedFetcher["fetch"]> extends never ? never : Awaited<ReturnType<FeedFetcher["fetch"]>>): FeedFetcher => ({ async fetch() { return result; } });

const event = (externalRef: string, headline: string) => ({ id: externalRef, headline, lat: 53.5, lng: -114.0, updated: "2026-09-11T11:40:00Z" });
const body = (...evts: unknown[]) => JSON.stringify(evts);
const parse = (b: string) => JSON.parse(b) as unknown[];

const normalize: Normalizer = (raw, i) => {
  const r = raw as { id?: string; headline?: string; lat?: number; lng?: number; updated?: string };
  if (!r.id) return { ok: false, reason: `record ${i} has no id` };
  if (typeof r.lat !== "number" || typeof r.lng !== "number") return { ok: false, reason: `record ${i} has no usable position` };
  const advisory: RoadAdvisory = {
    sourceKey: "ab511", externalRef: r.id, advisoryType: "road_condition", severity: "major",
    headline: r.headline ?? "", roadName: null, point: [r.lng, r.lat], radiusMetres: 2000,
    effectiveFrom: null, effectiveTo: null,
    sourceUpdatedAt: r.updated ? new Date(r.updated) : null, retrievedAt: at, advisoryOnly: true,
  };
  return { ok: true, advisory };
};

const run = (over: Partial<Parameters<typeof ingestFeed>[0]> = {}) =>
  ingestFeed({
    source: cleared(), state: due, credential: present,
    fetcher: fetcher({ status: "ok", httpStatus: 200, body: body(event("E1", "Poor conditions")), entityTag: 'W/"v1"', sourceVersion: "2026-09-11T11:40Z" }),
    store: fakeStore().store, normalize, parse, snapshotSemantics: "full", at, ...over,
  });

describe("a refusal is a run, not a silence", () => {
  it("records why an uncleared source was not polled, and never calls the fetcher", async () => {
    let called = false;
    const f: FeedFetcher = { async fetch() { called = true; throw new Error("must not be reached"); } };
    const s = fakeStore();
    const r = await run({ source: cleared({ status: "unverified" }), fetcher: f, store: s.store });
    expect(called).toBe(false);
    expect(r.run).toMatchObject({ outcome: "refused", refusedBecause: "not_cleared" });
    expect(s.runs).toHaveLength(1);
    expect(runLine(r.run)).toContain("REFUSED (not_cleared)");
  });

  it("records a quota refusal with its reason", async () => {
    const spent: FeedState = { ...emptyFeedState(), recentCallsAt: Array.from({ length: 10 }, () => new Date(at.getTime() - 5_000)) };
    const r = await run({ state: spent });
    expect(r.run).toMatchObject({ outcome: "refused", refusedBecause: "quota_exhausted" });
  });
});

describe("the publisher saying nothing changed costs nothing", () => {
  it("records not_modified and touches no advisory", async () => {
    const s = fakeStore([{ advisoryRef: "ADV-1", externalRef: "E1", contentHash: "x" }]);
    const r = await run({ fetcher: fetcher({ status: "not_modified", httpStatus: 304, entityTag: 'W/"v1"' }), store: s.store, lastEntityTag: 'W/"v1"' });
    expect(r.run.outcome).toBe("not_modified");
    expect(s.inserted).toHaveLength(0);
    expect(s.withdrawn).toHaveLength(0);
    expect(runLine(r.run)).toContain("UNCHANGED");
  });

  it("records a failure with its status and counts it against the feed", async () => {
    const r = await run({ fetcher: fetcher({ status: "error", httpStatus: 503, error: "upstream unavailable" }) });
    expect(r.run).toMatchObject({ outcome: "failed", httpStatus: 503 });
    expect(r.state.consecutiveFailures).toBe(1);
    expect(runLine(r.run)).toContain("FAILED HTTP 503");
  });

  it("treats an unparseable response as a failure rather than an empty feed", async () => {
    const s = fakeStore([{ advisoryRef: "ADV-1", externalRef: "E1", contentHash: "x" }]);
    const r = await run({ fetcher: fetcher({ status: "ok", httpStatus: 200, body: "<html>maintenance</html>", entityTag: null, sourceVersion: null }), store: s.store });
    expect(r.run.outcome).toBe("failed");
    expect(r.run.errorText).toContain("did not parse");
    // Crucially: it did not conclude "no events" and withdraw everything held.
    expect(s.withdrawn).toHaveLength(0);
  });
});

describe("a change supersedes, and never overwrites", () => {
  it("inserts a new row and points the old one at it when the publisher revises an event", async () => {
    const first = normalize(event("E1", "Poor conditions"), 0);
    if (!first.ok) throw new Error("fixture");
    const heldHash = contentHashOf({ ...first.advisory, retrievedAt: undefined });
    const s = fakeStore([{ advisoryRef: "ADV-OLD", externalRef: "E1", contentHash: heldHash }]);

    const r = await run({ store: s.store, fetcher: fetcher({ status: "ok", httpStatus: 200, body: body(event("E1", "Road CLOSED")), entityTag: null, sourceVersion: null }) });
    expect(r).toMatchObject({ accepted: 1, superseded: 1, unchanged: 0 });
    expect(s.inserted).toHaveLength(1);
    expect(s.superseded[0]).toMatchObject({ advisoryRef: "ADV-OLD" });
    expect(s.superseded[0].by).toBe(s.inserted[0].advisoryRef);
  });

  it("writes nothing when the publisher repeats itself", async () => {
    const first = normalize(event("E1", "Poor conditions"), 0);
    if (!first.ok) throw new Error("fixture");
    const s = fakeStore([{ advisoryRef: "ADV-1", externalRef: "E1", contentHash: contentHashOf({ ...first.advisory, retrievedAt: undefined }) }]);
    const r = await run({ store: s.store });
    expect(r).toMatchObject({ accepted: 0, unchanged: 1, superseded: 0 });
    expect(s.inserted).toHaveLength(0);
  });

  it("does not treat a new retrieval time as a change", async () => {
    // retrievedAt moves on every poll; hashing it would churn the table hourly.
    const a = normalize(event("E1", "Poor conditions"), 0);
    const b = normalize(event("E1", "Poor conditions"), 0);
    if (!a.ok || !b.ok) throw new Error("fixture");
    b.advisory.retrievedAt = new Date(at.getTime() + 3_600_000);
    expect(contentHashOf({ ...a.advisory, retrievedAt: undefined })).toBe(contentHashOf({ ...b.advisory, retrievedAt: undefined }));
  });
});

describe("absence means something only when the feed is a snapshot", () => {
  const held = [{ advisoryRef: "ADV-GONE", externalRef: "E9", contentHash: "x" }];

  it("withdraws what a full listing stopped mentioning", async () => {
    const s = fakeStore(held);
    const r = await run({ store: s.store, snapshotSemantics: "full" });
    expect(r.withdrawn).toBe(1);
    expect(s.withdrawn).toEqual(["ADV-GONE"]);
  });

  it("withdraws nothing from an incremental feed, because absence there says nothing at all", async () => {
    const s = fakeStore(held);
    const r = await run({ store: s.store, snapshotSemantics: "incremental" });
    expect(r.withdrawn).toBe(0);
    expect(s.withdrawn).toHaveLength(0);
  });
});

describe("a record that will not normalize is counted, not skipped", () => {
  it("accepts the good rows, rejects the bad ones by index and reason, and says so on one line", async () => {
    const s = fakeStore();
    const r = await run({
      store: s.store,
      fetcher: fetcher({ status: "ok", httpStatus: 200, body: body(event("E1", "ok"), { headline: "no id" }, { id: "E3" }), entityTag: null, sourceVersion: null }),
    });
    expect(r).toMatchObject({ accepted: 1, rejected: 2 });
    expect(r.run.recordsSeen).toBe(3);
    expect(r.run.rejections.map(x => x.index)).toEqual([1, 2]);
    expect(r.run.rejections[1].reason).toContain("no usable position");
    expect(runLine(r.run)).toContain("3 seen, 1 new or revised, 2 rejected");
  });

  it("records the response hash and the publisher's version on a successful run", async () => {
    const r = await run();
    expect(r.run.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.run).toMatchObject({ sourceVersion: "2026-09-11T11:40Z", entityTag: 'W/"v1"', quotaLimit: 10, quotaUsedInWindow: 1 });
  });
});
