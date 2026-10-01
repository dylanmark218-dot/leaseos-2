/**
 * The Canadian provider runtime's safety gates, proven without a database or a network.
 *
 * The DB-backed half — the same gates through `runTransportFeedTick`, the persisted advisory
 * lifecycle, and a closure making an approved route stale — is canadianProviderRuntime.db.test.ts.
 * No real key appears in either file; the fake ones below exist to prove they never come back out.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advisoriesOnRoute, DEFAULT_ADVISORY_RADIUS_METRES, type RoadAdvisory, type RouteLeg } from "./_core/advisoryImpact";
import { polylineRangeMetres } from "./_core/commRoute";
import { EgressRefused } from "./_core/egressGuard";
import type { ExternalDataSource } from "./_core/externalDataRegistry";
import { ALL_DATA_SOURCES } from "./_core/externalSourceSeeds";
import { emptyFeedState, shouldPoll } from "./_core/feedCollector";
import { categoryForStatus, egressFeedClient, retryAfterSeconds, type HttpClient } from "./_core/feedHttp";
import { contentHashOf, ingestFeed, type AdvisoryStore, type FeedRun, type StoredAdvisory } from "./_core/feedIngest";
import { haversineMetres, type LngLat } from "./_core/geoImport";
import { coveringCircle, geometryCoordinates } from "./_core/transport/placement";
import { CANADIAN_TRANSPORT_PROVIDERS, enabledFeedKeys, feedSourceFor, ingestProvider, providerFor, providerRuntimeReadiness } from "./_core/transport/providerRegistry";
import { attributionProjection, parseRunNote, productionFeedClient, providerHealthFrom, runNote } from "./transportFeedRuntime";
import { isMaterialToRoute } from "./routeDependencies";

const at = new Date("2026-10-01T18:00:00Z");
const ALL = CANADIAN_TRANSPORT_PROVIDERS.map(p => p.sourceKey).join(",");
const row = (k: string, over: Partial<ExternalDataSource> = {}): ExternalDataSource => ({ ...ALL_DATA_SOURCES.find(s => s.sourceKey === k)!, ...over });
const readiness = (k: string, env: Record<string, string | undefined>, opts: { databaseReady?: boolean; row?: ExternalDataSource | null } = {}) =>
  providerRuntimeReadiness({ provider: providerFor(k)!, row: opts.row === undefined ? row(k) : opts.row, env, databaseReady: opts.databaseReady ?? true, now: at });

const SECRET = "mb+KEY/9f2c=zz";          // reserved characters on purpose: the URL carries it encoded
const ENC = encodeURIComponent(SECRET);
const KEY_NAMES = ["AB_511_API_KEY", "ON_511_API_KEY", "MB_511_API_KEY", "NB_511_API_KEY", "YT_511_API_KEY", "NL_511_API_KEY"];

function fakeStore(seed: StoredAdvisory[] = []) {
  const runs: FeedRun[] = [];
  const withdrawn: string[] = [];
  const inserted: (RoadAdvisory & { advisoryRef: string })[] = [];
  const store: AdvisoryStore = {
    async activeByExternalRef() { return seed; },
    async insert(a) { inserted.push(a); },
    async supersede() {},
    async withdraw(r) { withdrawn.push(r); },
    async recordRun(r) { runs.push(r); },
  };
  return { store, runs, withdrawn, inserted };
}
const neverCalled = (): HttpClient & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, async request({ url }) { calls.push(url); throw new Error("the HTTP layer must not be reached"); } };
};

/* ------------------------------------------------------------------ */

describe("runtime readiness — rights first, then key, then the owner's switch, then the database", () => {
  it("(1) holds Manitoba at rights review with a valid-looking key present, and never schedules it", () => {
    const r = readiness("mb511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, MB_511_API_KEY: SECRET });
    expect(r.status).toBe("rights_review");
    expect(r.credential).toBe("present");
    expect(r.rightsVerified).toBe(false);
    expect(r.schedulable).toBe(false);
  });

  it("reports rights review, not a missing key, for a blocked source without one — the key is never the first question", () => {
    for (const k of ["ab511", "mb511", "nb511", "yt511", "nl511"]) expect(readiness(k, { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL }).status, k).toBe("rights_review");
  });

  it("refuses a row marked verified whose commercial use was never answered", () => {
    // geo.sourceReview can clear a row and leave commercialUsePermitted unknown. The import gate
    // refused that; the collector did not. Now both do.
    const forged = row("mb511", { status: "verified", verifiedAt: at, attributionText: "x", commercialUsePermitted: "unknown" });
    expect(readiness("mb511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, MB_511_API_KEY: SECRET }, { row: forged }).status).toBe("rights_review");
    expect(shouldPoll(feedSourceFor(providerFor("mb511")!, forged), emptyFeedState(), at, { present: true, envVar: "MB_511_API_KEY" }).poll).toBe(false);
  });

  it("(2) keeps Ontario at credential_missing until ON_511_API_KEY exists, whatever else is true", () => {
    expect(readiness("on511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL }).status).toBe("credential_missing");
    expect(readiness("on511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, ON_511_API_KEY: "  " }).status).toBe("credential_missing");
    expect(readiness("on511", { ON_511_API_KEY: "k" }).status).toBe("disabled");
    expect(readiness("on511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, ON_511_API_KEY: "k" }, { databaseReady: false }).status).toBe("runtime_unavailable");
    expect(readiness("on511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, ON_511_API_KEY: "k" }).status).toBe("ready");
  });

  it("(3) makes B.C. and Québec ready with no key — once the owner enables them", () => {
    for (const k of ["drivebc_open511", "qc_mtmd_roadworks"]) {
      expect(readiness(k, {}).status, k).toBe("disabled");
      const r = readiness(k, { LEASEOS_TRANSPORT_FEEDS_ENABLED: k });
      expect(r.status, k).toBe("ready");
      expect(r.credential, k).toBe("not_required");
      expect(r.schedulable, k).toBe(true);
    }
  });

  it("treats an unset or empty switch as nothing enabled", () => {
    expect(enabledFeedKeys({}).size).toBe(0);
    expect(enabledFeedKeys({ LEASEOS_TRANSPORT_FEEDS_ENABLED: " , " }).size).toBe(0);
    expect([...enabledFeedKeys({ LEASEOS_TRANSPORT_FEEDS_ENABLED: "drivebc_open511, qc_mtmd_roadworks" })]).toEqual(["drivebc_open511", "qc_mtmd_roadworks"]);
  });

  it("puts no key value and no key variable name in any readiness line", () => {
    const env = { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, ...Object.fromEntries(KEY_NAMES.map(n => [n, SECRET])) };
    const text = JSON.stringify(CANADIAN_TRANSPORT_PROVIDERS.map(p => readiness(p.sourceKey, env)));
    expect(text).not.toContain(SECRET);
    for (const n of KEY_NAMES) expect(text).not.toContain(n);
  });
});

describe("(17) Saskatchewan has nothing to collect, and nothing scrapes it", () => {
  it("is unschedulable in every configuration", () => {
    expect(readiness("sk_highway_hotline", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL }).status).toBe("no_published_api");
    expect(readiness("sk_highway_hotline", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL }, { row: row("sk_highway_hotline", { status: "verified", commercialUsePermitted: "yes" }) }).status).toBe("no_published_api");
  });

  it("refuses a direct collection before any request is built", async () => {
    const client = neverCalled();
    await expect(ingestProvider({ provider: providerFor("sk_highway_hotline")!, row: row("sk_highway_hotline"), state: emptyFeedState(), env: {}, client, store: fakeStore().store, at })).rejects.toThrow(/no published API/);
    expect(client.calls).toEqual([]);
  });

  it("names the Hotline only as an attribution link, never as something fetched", () => {
    // Structural: the host appears in production code only as the provider's public page.
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(e => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? (e === "node_modules" ? [] : walk(p)) : /\.ts$/.test(p) && !/\.test\.ts$/.test(p) ? [p] : [];
    });
    const hits = walk("server").filter(p => /hotline\.gov\.sk\.ca/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual(["server/_core/transport/providerRegistry.ts"]);
    const body = readFileSync("server/_core/transport/providerRegistry.ts", "utf8");
    expect(body).toMatch(/publicUrl: "https:\/\/hotline\.gov\.sk\.ca\/"/);
    expect(providerFor("sk_highway_hotline")!.endpoint).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("(4) a provider key cannot leak", () => {
  const ON = providerFor("on511")!;
  const onRow = row("on511");
  const env = { ON_511_API_KEY: SECRET };

  it("from a thrown HTTP error that echoes the request URL, in either encoding", async () => {
    const { store, runs } = fakeStore();
    const client: HttpClient = { async request({ url }) { throw new Error(`socket hang up GET ${url} (raw ${SECRET})`); } };
    const out = await ingestProvider({ provider: ON, row: onRow, state: emptyFeedState(), env, client, store, at });
    expect(out.run.outcome).toBe("failed");
    for (const text of [out.run.errorText, runNote(out.run), JSON.stringify(runs), out.state.lastFailureReason]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ENC);
    }
    expect(out.run.errorText).toContain("«redacted»");
  });

  it("from an egress refusal, whose message names the URL it was given", async () => {
    const client = egressFeedClient(async target => { throw new EgressRefused("too_many_redirects", `more than 2 redirects from ${target}`); });
    const out = await ingestProvider({ provider: ON, row: onRow, state: emptyFeedState(), env, client, store: fakeStore().store, at });
    expect(out.run.failureCategory).toBe("unexpected_response");
    expect(out.run.errorText).not.toContain(ENC);
    expect(out.run.errorText).not.toContain(SECRET);
  });

  it("from a publisher error body that quotes the key back", async () => {
    const client: HttpClient = { async request() { return { status: 400, body: `<Error><Message>Invalid Key ${SECRET}</Message></Error>`, headers: {} }; } };
    const out = await ingestProvider({ provider: ON, row: onRow, state: emptyFeedState(), env, client, store: fakeStore().store, at });
    expect(out.run.failureCategory).toBe("credential_rejected");
    expect(out.run.errorText).not.toContain(SECRET);
  });

  it("from the health projection and the attribution projection, even over a row whose text was never redacted", () => {
    const leaky = { id: 1, runRef: "R1", sourceKey: "on511", startedAt: at, finishedAt: at, outcome: "failed" as const, refusedBecause: null, httpStatus: 400, recordsSeen: 0, recordsAccepted: 0, recordsRejected: 0, rejectionsJson: null, quotaUsedInWindow: 1, quotaLimit: 10, responseHash: null, sourceVersion: null, entityTag: null, errorText: `[credential_rejected] GET https://511on.ca/api/v2/get/event?key=${ENC}`, createdAt: at };
    const r = readiness("on511", { LEASEOS_TRANSPORT_FEEDS_ENABLED: ALL, ON_511_API_KEY: SECRET });
    const health = providerHealthFrom({ provider: ON, row: onRow, readiness: r, runsNewestFirst: [leaky], activeAdvisories: 0, now: at });
    const text = JSON.stringify({ health, attribution: attributionProjection({ ...onRow, sourceUrl: null }, ON) });
    expect(health.state).toBe("credential_rejected");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ENC);
    expect(text).not.toContain("511on.ca/api");
    for (const n of KEY_NAMES) expect(text).not.toContain(n);
  });

  it("sends production requests through the egress guard, which refuses a private address before any connection", async () => {
    await expect(productionFeedClient().request({ url: `https://127.0.0.1/api/v2/get/event?key=${ENC}`, headers: { Accept: "application/json" }, timeoutMs: 2000 }))
      .rejects.toBeInstanceOf(EgressRefused);
  });

  it("refuses to carry a header-style credential through the egress guard rather than calling without it", async () => {
    const client = egressFeedClient(async () => { throw new Error("must not be called"); });
    await expect(client.request({ url: "https://example.org/x", headers: { Accept: "application/json", "X-Api-Key": SECRET }, timeoutMs: 1000 })).rejects.toThrow(/x-api-key cannot be carried/);
  });
});

describe("failures are named, not flattened", () => {
  it("reads the 511 platform's 400 Invalid Key as a refused key only when a key was sent", () => {
    expect(categoryForStatus(400, true)).toBe("credential_rejected");
    expect(categoryForStatus(400, false)).toBe("http_error");
    expect(categoryForStatus(401, false)).toBe("credential_rejected");
    expect(categoryForStatus(403, true)).toBe("credential_rejected");
    expect(categoryForStatus(429, true)).toBe("rate_limited");
    expect(categoryForStatus(503, true)).toBe("http_error");
  });

  it("obeys a Retry-After: the collector will not call again until it has passed", async () => {
    expect(retryAfterSeconds("120", at)).toBe(120);
    expect(retryAfterSeconds(new Date(at.getTime() + 90_000).toUTCString(), at)).toBe(90);
    expect(retryAfterSeconds("soon", at)).toBeNull();

    const client: HttpClient = { async request() { return { status: 429, body: "", headers: { "retry-after": "600" } }; } };
    const qc = providerFor("qc_mtmd_roadworks")!;
    const out = await ingestProvider({ provider: qc, row: row("qc_mtmd_roadworks"), state: emptyFeedState(), env: {}, client, store: fakeStore().store, at });
    expect(out.run.failureCategory).toBe("rate_limited");
    expect(out.run.retryAfterSeconds).toBe(600);
    expect(parseRunNote(runNote(out.run))).toMatchObject({ category: "rate_limited", retryAfterSeconds: 600 });
    const later = shouldPoll(feedSourceFor(qc, row("qc_mtmd_roadworks")), out.state, new Date(at.getTime() + 300_000), null);
    expect(later).toMatchObject({ poll: false, blockedBy: "quota_exhausted" });
    expect(shouldPoll(feedSourceFor(qc, row("qc_mtmd_roadworks")), { ...out.state, lastSuccessAt: null }, new Date(at.getTime() + 601_000), null).poll).toBe(true);
  });

  it("counts a listing that would not parse as a failure for health, not a success", async () => {
    const client: HttpClient = { async request() { return { status: 200, body: "<html>maintenance</html>", headers: {} }; } };
    const out = await ingestProvider({ provider: providerFor("drivebc_open511")!, row: row("drivebc_open511"), state: emptyFeedState(), env: {}, client, store: fakeStore().store, at });
    expect(out.run.failureCategory).toBe("parser_rejected");
    expect(out.state.lastSuccessAt).toBeNull();
    expect(out.state.consecutiveFailures).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("(7)(8) a full listing withdraws only when it can be trusted whole", () => {
  const source = feedSourceFor(providerFor("qc_mtmd_roadworks")!, row("qc_mtmd_roadworks"));
  const held = (ref: string): StoredAdvisory => ({ advisoryRef: `ADV-${ref}`, externalRef: ref, contentHash: "old" });
  const adv = (ref: string): RoadAdvisory => ({ sourceKey: source.sourceKey, externalRef: ref, advisoryType: "closure", severity: "closure", headline: ref, roadName: null, point: [-73.5, 45.5], radiusMetres: null, effectiveFrom: null, effectiveTo: null, sourceUpdatedAt: null, retrievedAt: at, advisoryOnly: true });
  const run = (body: unknown[], seed: StoredAdvisory[]) => {
    const f = fakeStore(seed);
    return ingestFeed({
      source, state: emptyFeedState(), credential: null, store: f.store, at, snapshotSemantics: "full",
      fetcher: { async fetch() { return { status: "ok", httpStatus: 200, body: JSON.stringify(body), entityTag: null, sourceVersion: null }; } },
      parse: b => JSON.parse(b) as unknown[],
      normalize: (r, i) => (r as { id?: string }).id ? { ok: true, advisory: adv((r as { id: string }).id) } : { ok: false, reason: `record ${i} has no id` },
    }).then(out => ({ out, ...f }));
  };

  it("withdraws what a complete listing no longer mentions", async () => {
    const { out, withdrawn } = await run([{ id: "B" }], [held("A")]);
    expect(withdrawn).toEqual(["ADV-A"]);
    expect(out.run.snapshotComplete).toBe(true);
  });

  it("withdraws nothing when one record was rejected — its id is unknown, so absence means nothing", async () => {
    const { out, withdrawn, inserted } = await run([{ id: "B" }, { nope: true }], [held("A")]);
    expect(withdrawn).toEqual([]);
    expect(inserted.map(i => i.externalRef)).toEqual(["B"]);   // what did arrive is still used
    expect(out.run.outcome).toBe("succeeded");
    expect(out.run.snapshotComplete).toBe(false);
    expect(out.run.failureCategory).toBe("snapshot_incomplete");
  });

  it("withdraws nothing on an empty listing while closures are held — empty is not all-clear", async () => {
    const { out, withdrawn } = await run([], [held("A"), held("B")]);
    expect(withdrawn).toEqual([]);
    expect(out.run.outcome).toBe("failed");
    expect(out.run.failureCategory).toBe("snapshot_incomplete");
    expect(out.state.lastSuccessAt).toBeNull();
  });

  it("answers a repeated id once", async () => {
    const { out, inserted } = await run([{ id: "B" }, { id: "B" }], []);
    expect(inserted).toHaveLength(1);
    expect(out.accepted).toBe(1);
  });

  it("hashes content without the retrieval time, so collecting twice is not a change", () => {
    expect(contentHashOf({ ...adv("A"), retrievedAt: undefined })).toBe(contentHashOf({ ...adv("A"), retrievedAt: undefined }));
  });
});

/* ------------------------------------------------------------------ */

describe("(11)(12)(13) placement stays conservative without making every nearby road an issue", () => {
  // A 10 km east–west road at 50°N.
  const road: LngLat[] = [[-114.0, 50.0], [-113.86, 50.0]];
  const leg = (path: LngLat[] = road): RouteLeg[] => [{ segmentId: "S1", lengthKm: 10, geography: { segmentId: "S1", province: "AB", path } }];
  const at50 = (northMetres: number): LngLat => [-113.93, 50.0 + northMetres / 111_195];
  const advisory = (over: Partial<RoadAdvisory>): RoadAdvisory => ({ sourceKey: "drivebc_open511", externalRef: "E", advisoryType: "incident", severity: "major", headline: "h", roadName: null, point: null, radiusMetres: null, effectiveFrom: null, effectiveTo: null, sourceUpdatedAt: at, retrievedAt: at, advisoryOnly: true, ...over });
  const placed = (a: RoadAdvisory) => advisoriesOnRoute({ route: leg(), advisories: [a], at }).placed.length;

  it("gives a single-point incident the full default radius, not a smaller one", () => {
    const c = coveringCircle([at50(0)])!;
    expect(c.radiusMetres).toBeNull();
    expect(placed(advisory({ point: at50(DEFAULT_ADVISORY_RADIUS_METRES - 100) }))).toBe(1);
    expect(placed(advisory({ point: at50(DEFAULT_ADVISORY_RADIUS_METRES + 100) }))).toBe(0);
  });

  it("is inclusive at exactly the tolerance and exclusive just past it", () => {
    const p = at50(5_000);
    // Measured exactly as placement measures, so the boundary is the placement's boundary.
    const d = polylineRangeMetres(p, road).nearest;
    expect(Math.abs(d - haversineMetres(p, [-113.93, 50.0]))).toBeLessThan(50);
    expect(placed(advisory({ point: p, radiusMetres: Math.ceil(d) }))).toBe(1);
    expect(placed(advisory({ point: p, radiusMetres: Math.floor(d) - 1 }))).toBe(0);
  });

  it("places a linear closure that crosses the route", () => {
    const crossing = coveringCircle(geometryCoordinates({ type: "LineString", coordinates: [[-113.93, 49.9], [-113.93, 50.1]] }))!;
    expect(placed(advisory({ advisoryType: "closure", severity: "closure", point: crossing.point, radiusMetres: crossing.radiusMetres }))).toBe(1);
  });

  it("places construction along the route, and not on a parallel road 20 km away", () => {
    const along = coveringCircle(geometryCoordinates({ type: "LineString", coordinates: [[-113.99, 50.0], [-113.9, 50.0]] }))!;
    expect(placed(advisory({ advisoryType: "construction", severity: "minor", point: along.point, radiusMetres: along.radiusMetres }))).toBe(1);
    const parallel = coveringCircle(geometryCoordinates({ type: "LineString", coordinates: [[-113.99, 50.18], [-113.9, 50.18]] }))!;
    expect(placed(advisory({ advisoryType: "construction", point: parallel.point, radiusMetres: parallel.radiusMetres }))).toBe(0);
  });

  it("covers a polygon area event from its extent", () => {
    const area = geometryCoordinates({ type: "Polygon", coordinates: [[[-113.95, 49.97], [-113.91, 49.97], [-113.91, 50.03], [-113.95, 50.03], [-113.95, 49.97]]] });
    expect(area).toHaveLength(5);
    const c = coveringCircle(area)!;
    expect(c.radiusMetres!).toBeGreaterThanOrEqual(DEFAULT_ADVISORY_RADIUS_METRES);
    expect(placed(advisory({ advisoryType: "weather", point: c.point, radiusMetres: c.radiusMetres }))).toBe(1);
  });

  it("treats closures, restrictions, major and unknown as material to an approval, and minor roadwork as not", () => {
    expect(isMaterialToRoute({ advisoryType: "closure", severity: "minor" })).toBe(true);
    expect(isMaterialToRoute({ advisoryType: "restriction", severity: "info" })).toBe(true);
    expect(isMaterialToRoute({ advisoryType: "incident", severity: "major" })).toBe(true);
    expect(isMaterialToRoute({ advisoryType: "construction", severity: "unknown" })).toBe(true);
    expect(isMaterialToRoute({ advisoryType: "construction", severity: "minor" })).toBe(false);
    expect(isMaterialToRoute({ advisoryType: "road_condition", severity: "info" })).toBe(false);
  });
});

describe("(15) attribution projection", () => {
  it("carries what the publisher requires shown, and nothing internal", () => {
    const r = { ...row("on511"), reviewNote: "privately: counsel says…", notes: "internal", reviewedByUserId: 7, sourceUrl: null } as ExternalDataSource & Record<string, unknown>;
    const p = attributionProjection(r, providerFor("on511"));
    expect(p).toEqual({
      sourceKey: "on511", providerName: "Government of Ontario — Ministry of Transportation", jurisdiction: "CA-ON",
      datasetName: "Ontario 511 Developer API", licenceName: "Open Government Licence – Ontario",
      licenceUrl: "https://www.ontario.ca/page/open-government-licence-ontario", attributionRequired: true,
      attributionText: "Contains information licensed under the Open Government Licence – Ontario",
      sourceUrl: "https://511on.ca/", rightsStatus: "verified", rightsVerifiedAt: r.verifiedAt, logoPermitted: false,
    });
    const text = JSON.stringify(p);
    for (const leak of ["counsel", "internal", "reviewedBy", "ON_511_API_KEY"]) expect(text).not.toContain(leak);
  });

  it("marks a source whose rights are not verified as such, with no logo for anyone", () => {
    expect(attributionProjection(row("mb511"), providerFor("mb511"))).toMatchObject({ rightsStatus: "not_verified", attributionText: null, logoPermitted: false });
  });
});
