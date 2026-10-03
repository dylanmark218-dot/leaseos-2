/**
 * S2-FLEET-A — what the observation says about each shape of fleet, against a real database.
 *
 * Every test plants rows straight into `runtimeInstances` with chosen ages, so stale and live are
 * decided by the same database clock the service reads. The states are read back by name; no test
 * here asserts a boolean, because the point of the four states is that "compatible" and
 * "converged" are different claims with different evidence.
 *
 * The mandatory one is "the old-instance test": a compatible server and a compatible worker,
 * observed, yield observed compatibility and NOT convergence. A fleet gate that could not tell
 * those apart would approve a cutover on the day an unregistered old server is still signing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type { DbOrTx } from "./_core/dbTypes";
import { RUNTIME_LIVE_TTL_SECONDS } from "./_core/runtimeRegistry";
import { RUNTIME_CAPABILITIES } from "./_core/runtimeCapabilities";
import { classifyInstance, observeFleet, summarizeFleet, type RuntimeInstanceRecord } from "./fleetObservationService";

const DB_URL = process.env.DATABASE_URL;

describe("fleet observation — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped fleet suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let db: DbOrTx;
let mine: string[] = [];

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const ALL = JSON.stringify(RUNTIME_CAPABILITIES);
const NONE = "[]";

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
  db = (await getDb())!;
  // The observation is global. Every suite that registers an instance marks it stopped when it is
  // done; a live row here now is a leak in some other suite, and this suite would read it as fleet.
  const baseline = await observeFleet(db);
  expect(baseline.live.servers + baseline.live.workers, `another suite left live registrations: ${JSON.stringify(baseline.live)}`).toBe(0);
});
afterEach(async () => {
  if (mine.length) await pool.query("UPDATE runtimeInstances SET stoppedAt = COALESCE(stoppedAt, CURRENT_TIMESTAMP) WHERE instanceRef IN (?)", [mine]);
  mine = [];
});
afterAll(async () => {
  await pool?.end();
});

type Plant = {
  kind: "server" | "worker";
  sha?: string | null;
  source?: "artifact" | "unbuilt";
  capabilities?: string;
  ageSeconds?: number;
  stopped?: boolean;
};
async function plant(p: Plant): Promise<string> {
  const ref = `rt_${randomUUID()}`;
  mine.push(ref);
  await pool.execute(
    `INSERT INTO runtimeInstances (instanceRef, runtimeKind, buildSha, buildRelease, buildSource, capabilitiesJson, startedAt, lastHeartbeatAt, stoppedAt)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP - INTERVAL ? SECOND, CURRENT_TIMESTAMP - INTERVAL ? SECOND, ?)`,
    [ref, p.kind, p.sha === undefined ? SHA_A : p.sha, p.sha === null ? null : "v23.30", p.source ?? "artifact", p.capabilities ?? ALL, (p.ageSeconds ?? 0) + 1, p.ageSeconds ?? 0, p.stopped ? new Date() : null]
  );
  return ref;
}

const COMPATIBLE_EXTERNAL = "observed_compatible_external_confirmation_required";

d("the four states", () => {
  it("nothing live → not_observable, and a stale registration does not change that", async () => {
    const empty = await observeFleet(db);
    expect(empty.state).toBe("not_observable");
    expect(empty.reason).toMatch(/no live runtime instance has registered within the last 60s/);
    expect(empty.live).toEqual({ servers: 0, workers: 0, builds: [], compatible: 0, incompatible: [] });
    expect(empty.externalConfirmation.kind).toBe("none");

    const stale = await plant({ kind: "server", ageSeconds: RUNTIME_LIVE_TTL_SECONDS + 5 });
    const withStale = await observeFleet(db);
    expect(withStale.state).toBe("not_observable");
    expect(withStale.reason).toMatch(/1 stale registration\(s\) excluded/);
    expect(withStale.stale.map(i => i.instanceRef)).toEqual([stale]);
  });

  it("OLD-INSTANCE TEST (mandatory). a compatible server and a compatible worker: observed compatible, NOT converged", async () => {
    const server = await plant({ kind: "server" });
    const worker = await plant({ kind: "worker" });
    const o = await observeFleet(db);

    expect(o.state).toBe(COMPATIBLE_EXTERNAL);
    expect(o.state).not.toBe("converged");
    expect(o.live).toEqual({ servers: 1, workers: 1, builds: [SHA_A], compatible: 2, incompatible: [] });
    expect(o.stale).toEqual([]);
    expect(o.capabilityCoverage).toEqual({ "webhook-secret-ref-read": { live: 2, declaring: 2 } });
    expect(o.requiredCapabilities).toEqual(["webhook-secret-ref-read"]);
    expect(o.externalConfirmation).toMatchObject({ kind: "none", reason: expect.stringMatching(/HOSTING_TARGET unknown/) });
    expect(o.reason).toMatch(/every live instance observed \(1 server, 1 worker, 1 build\(s\)\) declares webhook-secret-ref-read; whether these are ALL the instances that exist cannot be established here/);
    expect(o.observedBy).toBe("runtimeInstances");
    expect(o.liveTtlSeconds).toBe(60);
    // Metadata only, and compatible instances are counted rather than listed: the report names the
    // ones that need attention (incompatible, stale), not every process in the fleet.
    const text = JSON.stringify(o);
    expect(text).not.toContain(server);
    expect(text).not.toContain(worker);
    expect(text).not.toMatch(/hostname|password|secret_|sec_/);
  });

  it("MIXED FLEET. a compatible server, an old server without the capability, a compatible worker → observed_incompatible, exactly one", async () => {
    await plant({ kind: "server" });
    const old = await plant({ kind: "server", sha: SHA_B, capabilities: NONE });
    await plant({ kind: "worker" });
    const o = await observeFleet(db);

    expect(o.state).toBe("observed_incompatible");
    expect(o.live.servers).toBe(2);
    expect(o.live.workers).toBe(1);
    expect(o.live.compatible).toBe(2);
    expect(o.live.incompatible).toHaveLength(1);
    expect(o.live.incompatible[0]).toMatchObject({ instanceRef: old, runtimeKind: "server", buildSha: SHA_B, compatible: false, incompatibilities: ["missing required capability webhook-secret-ref-read"] });
    expect(o.capabilityCoverage["webhook-secret-ref-read"]).toEqual({ live: 3, declaring: 2 });
    expect(o.reason).toMatch(new RegExp(`^1 of 3 live instance\\(s\\) cannot be counted compatible: ${old} \\(server: missing required capability webhook-secret-ref-read\\)$`));
    expect(o.live.builds).toEqual([SHA_A, SHA_B]);
  });

  it("STALE INSTANCES. an expired incompatible instance is listed stale, excluded from live counts, and does not make the live fleet incompatible — and still proves nothing externally", async () => {
    await plant({ kind: "server" });
    await plant({ kind: "worker" });
    const crashed = await plant({ kind: "server", sha: SHA_B, capabilities: NONE, ageSeconds: RUNTIME_LIVE_TTL_SECONDS + 1 });
    const o = await observeFleet(db);

    expect(o.state).toBe(COMPATIBLE_EXTERNAL);
    expect(o.live).toEqual({ servers: 1, workers: 1, builds: [SHA_A], compatible: 2, incompatible: [] });
    expect(o.stale).toHaveLength(1);
    expect(o.stale[0]).toMatchObject({ instanceRef: crashed, compatible: false });
    expect(o.stale[0]!.heartbeatAgeSeconds).toBeGreaterThanOrEqual(RUNTIME_LIVE_TTL_SECONDS);
    expect(o.externalConfirmation.kind).toBe("none");
  });

  it("MULTIPLE BUILDS. two different compatible builds are both compatible: the gate is the capability, not the sha", async () => {
    await plant({ kind: "server", sha: SHA_A });
    await plant({ kind: "server", sha: SHA_C });
    await plant({ kind: "worker", sha: SHA_C });
    const o = await observeFleet(db);
    expect(o.state).toBe(COMPATIBLE_EXTERNAL);
    expect(o.live.builds).toEqual([SHA_A, SHA_C]);
    expect(o.live.incompatible).toEqual([]);
    expect(o.live.compatible).toBe(3);
  });

  it("FLEET-M9. an unknown build is never compatible, whatever it declares", async () => {
    await plant({ kind: "worker" });
    const unbuilt = await plant({ kind: "server", sha: null, source: "unbuilt" });
    const o = await observeFleet(db);
    expect(o.state).toBe("observed_incompatible");
    expect(o.live.incompatible.map(i => i.instanceRef)).toEqual([unbuilt]);
    expect(o.live.incompatible[0]!.incompatibilities).toEqual(["build unknown: the instance runs from sources or recorded no build identity"]);
    expect(o.live.builds).toEqual([SHA_A]);
  });

  it("an unreadable or foreign capability declaration counts for nothing", async () => {
    await plant({ kind: "server" });
    const garbled = await plant({ kind: "worker", capabilities: "not json" });
    const foreign = await plant({ kind: "worker", capabilities: JSON.stringify(["webhook-secret-ref-read-v2", "anything"]) });
    const o = await observeFleet(db);
    expect(o.state).toBe("observed_incompatible");
    const byRef = Object.fromEntries(o.live.incompatible.map(i => [i.instanceRef, i]));
    expect(Object.keys(byRef).sort()).toEqual([garbled, foreign].sort());
    expect(byRef[garbled]!.incompatibilities).toEqual(["capability declaration unreadable", "missing required capability webhook-secret-ref-read"]);
    expect(byRef[foreign]!.incompatibilities).toEqual(["missing required capability webhook-secret-ref-read"]);
    expect(byRef[foreign]!.unknownCapabilities).toEqual(["anything", "webhook-secret-ref-read-v2"]);
    expect(byRef[foreign]!.capabilities).toEqual([]);
  });

  it("a stopped instance is history: neither live nor stale", async () => {
    await plant({ kind: "server", stopped: true });
    await plant({ kind: "worker", sha: SHA_B, capabilities: NONE, stopped: true });
    const o = await observeFleet(db);
    expect(o.state).toBe("not_observable");
    expect(o.stale).toEqual([]);
  });
});

describe("summarizeFleet — the pure reducer", () => {
  const record = (over: Partial<RuntimeInstanceRecord>): RuntimeInstanceRecord => ({
    instanceRef: `rt_${randomUUID()}`, runtimeKind: "server", buildSha: SHA_A, buildSource: "artifact", capabilitiesJson: ALL,
    startedAt: new Date("2026-10-01T00:00:00Z"), heartbeatAgeSeconds: 0, ...over,
  });

  it("the TTL boundary: an age below the TTL is live, at the TTL is stale", () => {
    const live = record({ heartbeatAgeSeconds: RUNTIME_LIVE_TTL_SECONDS - 1 });
    const stale = record({ heartbeatAgeSeconds: RUNTIME_LIVE_TTL_SECONDS });
    const o = summarizeFleet([live, stale]);
    expect(o.live.servers).toBe(1);
    expect(o.stale.map(i => i.instanceRef)).toEqual([stale.instanceRef]);
  });

  it("FLEET-M7/M8. converged is unreachable from rows: fully compatible rows yield observed compatibility, and nothing a caller passes changes the evidence", () => {
    const o = summarizeFleet([record({}), record({ runtimeKind: "worker" })]);
    expect(o.state).toBe(COMPATIBLE_EXTERNAL);
    expect(o.externalConfirmation.kind).toBe("none");
    // The reducer takes rows and a TTL. There is no third argument; an extra one is ignored by JavaScript.
    expect(summarizeFleet.length).toBe(1);
    const forced = (summarizeFleet as unknown as (...a: unknown[]) => ReturnType<typeof summarizeFleet>)([record({})], 60, { kind: "confirmed" }, true);
    expect(forced.state).toBe(COMPATIBLE_EXTERNAL);
  });

  it("classifyInstance names every reason an instance is not compatible", () => {
    const i = classifyInstance(record({ buildSha: "abc", capabilitiesJson: "[]" }), ["webhook-secret-ref-read"]);
    expect(i.compatible).toBe(false);
    expect(i.incompatibilities).toEqual([
      "build unknown: the instance runs from sources or recorded no build identity",
      "missing required capability webhook-secret-ref-read",
    ]);
    expect(classifyInstance(record({}), ["webhook-secret-ref-read"])).toMatchObject({ compatible: true, incompatibilities: [], capabilities: ["webhook-secret-ref-read"] });
  });
});
