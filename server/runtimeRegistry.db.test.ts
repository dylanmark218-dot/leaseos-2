/**
 * S2-FLEET-A — the runtime registry against a real database.
 *
 * Register, heartbeat, stop: three statements, and the things each must NOT do are the point.
 * A heartbeat that could change a build would let a later process relabel an earlier one; a
 * registration that could overwrite an existing instanceRef would do the same; a stop that
 * deleted the row would erase the evidence that the instance ever ran.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { getDb } from "./db";
import type { DbOrTx } from "./_core/dbTypes";
import { BuildIdentityError, type RuntimeBuild } from "./_core/buildIdentity";
import { RUNTIME_CAPABILITIES } from "./_core/runtimeCapabilities";
import {
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  RUNTIME_LIVE_TTL_MS,
  RuntimeRegistrationError,
  heartbeatRuntimeInstance,
  newRuntimeInstanceIdentity,
  registerRuntimeInstance,
  registerThisRuntime,
  startRuntimeRegistration,
  stopRuntimeInstance,
} from "./_core/runtimeRegistry";

const DB_URL = process.env.DATABASE_URL;

describe("runtime registry — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped registry suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let db: DbOrTx;
const mine: string[] = [];

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
  db = (await getDb())!;
});
afterAll(async () => {
  // Nothing is deleted: a registry row is the record that a process ran. Rows this suite created are
  // marked stopped so no later suite sees them as live.
  if (mine.length) await pool.query("UPDATE runtimeInstances SET stoppedAt = COALESCE(stoppedAt, CURRENT_TIMESTAMP) WHERE instanceRef IN (?)", [mine]);
  await pool?.end();
});

const ARTIFACT: RuntimeBuild = { source: "artifact", identity: { sha: "1".repeat(40), release: "v23.30", shaSource: "git" } };

type Row = {
  instanceRef: string; runtimeKind: string; buildSha: string | null; buildRelease: string | null; buildSource: string;
  capabilitiesJson: string; startedAt: Date; heartbeatAge: number; stoppedAt: Date | null;
};
async function row(ref: string): Promise<Row | null> {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT instanceRef, runtimeKind, buildSha, buildRelease, buildSource, capabilitiesJson, startedAt,
            TIMESTAMPDIFF(SECOND, lastHeartbeatAt, CURRENT_TIMESTAMP) AS heartbeatAge, stoppedAt
       FROM runtimeInstances WHERE instanceRef = ?`,
    [ref]
  );
  return (r[0] as Row | undefined) ?? null;
}
const identityOf = (r: Row) => ({ instanceRef: r.instanceRef, runtimeKind: r.runtimeKind, buildSha: r.buildSha, buildRelease: r.buildRelease, buildSource: r.buildSource, capabilitiesJson: r.capabilitiesJson });
const ageHeartbeat = (ref: string, seconds: number) =>
  pool.query("UPDATE runtimeInstances SET lastHeartbeatAt = CURRENT_TIMESTAMP - INTERVAL ? SECOND WHERE instanceRef = ?", [seconds, ref]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

d("registration", () => {
  it("inserts one row carrying the build, the kind and the declared capabilities, live and not stopped", async () => {
    const identity = newRuntimeInstanceIdentity("server", ARTIFACT);
    mine.push(identity.instanceRef);
    expect(identity.instanceRef).toMatch(/^rt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(identity.capabilities).toEqual(RUNTIME_CAPABILITIES);
    expect(Object.isFrozen(identity)).toBe(true);

    await registerRuntimeInstance(db, identity);
    const r = (await row(identity.instanceRef))!;
    expect(identityOf(r)).toEqual({
      instanceRef: identity.instanceRef, runtimeKind: "server", buildSha: "1".repeat(40), buildRelease: "v23.30",
      buildSource: "artifact", capabilitiesJson: JSON.stringify(RUNTIME_CAPABILITIES),
    });
    expect(r.heartbeatAge).toBeLessThanOrEqual(5);
    expect(r.stoppedAt).toBeNull();
  });

  it("an unbuilt process registers with no sha, recorded as unbuilt — never a placeholder", async () => {
    const identity = newRuntimeInstanceIdentity("worker"); // the test runner's own build: unbuilt
    mine.push(identity.instanceRef);
    await registerRuntimeInstance(db, identity);
    const r = (await row(identity.instanceRef))!;
    expect(r.buildSha).toBeNull();
    expect(r.buildRelease).toBeNull();
    expect(r.buildSource).toBe("unbuilt");
    expect(r.runtimeKind).toBe("worker");
  });

  it("FLEET-M4/16. a second registration under the same instanceRef is refused and rewrites nothing", async () => {
    const identity = newRuntimeInstanceIdentity("server", ARTIFACT);
    mine.push(identity.instanceRef);
    await registerRuntimeInstance(db, identity);
    const before = identityOf((await row(identity.instanceRef))!);

    const impostor = { ...identity, runtimeKind: "worker" as const, build: { source: "artifact" as const, identity: { ...ARTIFACT.identity, sha: "2".repeat(40) } }, capabilities: [] };
    const failure = await registerRuntimeInstance(db, impostor).then(() => null, (e: unknown) => e as Error & { cause?: { code?: string } });
    expect(failure).toBeInstanceOf(Error);
    // drizzle wraps the driver error; the unique-index refusal is the cause.
    expect(`${failure!.cause?.code ?? ""} ${failure!.message}`).toMatch(/ER_DUP_ENTRY|Duplicate entry/);
    expect(identityOf((await row(identity.instanceRef))!)).toEqual(before);
  });

  it("pid and hostname are not the identity: two identities minted in one process differ", () => {
    const a = newRuntimeInstanceIdentity("server", ARTIFACT);
    const b = newRuntimeInstanceIdentity("server", ARTIFACT);
    expect(a.instanceRef).not.toBe(b.instanceRef);
    expect(a.instanceRef).not.toContain(String(process.pid));
  });
});

d("heartbeat and stop", () => {
  it("FLEET-M4. a heartbeat moves lastHeartbeatAt and nothing else", async () => {
    const identity = newRuntimeInstanceIdentity("worker", ARTIFACT);
    mine.push(identity.instanceRef);
    await registerRuntimeInstance(db, identity);
    await ageHeartbeat(identity.instanceRef, 300);
    const before = (await row(identity.instanceRef))!;
    expect(before.heartbeatAge).toBeGreaterThanOrEqual(299);

    await heartbeatRuntimeInstance(db, identity.instanceRef);
    const after = (await row(identity.instanceRef))!;
    expect(after.heartbeatAge).toBeLessThanOrEqual(5);
    expect(identityOf(after)).toEqual(identityOf(before));
    expect(after.startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(after.stoppedAt).toBeNull();
  });

  it("stop sets stoppedAt once; a heartbeat after stop changes nothing; the row stays", async () => {
    const identity = newRuntimeInstanceIdentity("server", ARTIFACT);
    mine.push(identity.instanceRef);
    await registerRuntimeInstance(db, identity);
    await stopRuntimeInstance(db, identity.instanceRef);
    const stopped = (await row(identity.instanceRef))!;
    expect(stopped.stoppedAt).not.toBeNull();

    await ageHeartbeat(identity.instanceRef, 300);
    await heartbeatRuntimeInstance(db, identity.instanceRef);
    const after = (await row(identity.instanceRef))!;
    expect(after.heartbeatAge).toBeGreaterThanOrEqual(299);
    expect(after.stoppedAt?.getTime()).toBe(stopped.stoppedAt!.getTime());

    await sleep(1100);
    await stopRuntimeInstance(db, identity.instanceRef);
    expect((await row(identity.instanceRef))!.stoppedAt?.getTime()).toBe(stopped.stoppedAt!.getTime());
  });

  it("the interval and the TTL are what the design says: 15 s, four missed beats, under the 120 s claim lease", () => {
    expect(RUNTIME_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(RUNTIME_LIVE_TTL_MS).toBe(4 * RUNTIME_HEARTBEAT_INTERVAL_MS);
    expect(RUNTIME_LIVE_TTL_MS).toBeLessThan(120_000);
  });

  it("startRuntimeRegistration registers, beats on its interval, and close marks stopped and stops beating", async () => {
    const identity = newRuntimeInstanceIdentity("worker", ARTIFACT);
    mine.push(identity.instanceRef);
    const errors: unknown[] = [];
    const registration = await startRuntimeRegistration(db, identity, { intervalMs: 150, onHeartbeatError: e => errors.push(e) });
    expect(registration.identity).toBe(identity);
    expect((await row(identity.instanceRef))!.stoppedAt).toBeNull();

    await ageHeartbeat(identity.instanceRef, 300);
    await sleep(600);
    expect((await row(identity.instanceRef))!.heartbeatAge, "the timer brought the heartbeat forward").toBeLessThanOrEqual(5);
    expect(errors).toEqual([]);

    await registration.close();
    await registration.close(); // idempotent
    const closed = (await row(identity.instanceRef))!;
    expect(closed.stoppedAt).not.toBeNull();
    await ageHeartbeat(identity.instanceRef, 300);
    await sleep(500);
    expect((await row(identity.instanceRef))!.heartbeatAge, "no beat after close").toBeGreaterThanOrEqual(299);
  });
});

d("registerThisRuntime — the entrypoint call", () => {
  it("FLEET-M3. production with no database refuses, so startup cannot reach readiness", async () => {
    await expect(registerThisRuntime("server", { production: true, db: null, log: () => {} })).rejects.toThrow(RuntimeRegistrationError);
    await expect(registerThisRuntime("server", { production: true, db: null, log: () => {} })).rejects.toThrow(/must not become ready/);
  });

  it("FLEET-M12. production from sources (no embedded identity) refuses even with a database", async () => {
    await expect(registerThisRuntime("server", { production: true, db, log: () => {} })).rejects.toThrow(BuildIdentityError);
  });

  it("outside production, no database means unobserved rather than failed", async () => {
    const lines: string[] = [];
    expect(await registerThisRuntime("worker", { production: false, db: null, log: l => lines.push(l) })).toBeNull();
    expect(lines.join("\n")).toMatch(/not registered: no database/);
  });

  it("outside production with a database, an unbuilt process registers and reports itself", async () => {
    const lines: string[] = [];
    const registration = await registerThisRuntime("server", { production: false, db, intervalMs: 60_000, log: l => lines.push(l) });
    expect(registration).not.toBeNull();
    mine.push(registration!.identity.instanceRef);
    try {
      expect(lines[0]).toMatch(/^\[build\] unbuilt: /);
      expect(lines[1]).toMatch(new RegExp(`^\\[runtime\\] registered ${registration!.identity.instanceRef} kind=server capabilities=${RUNTIME_CAPABILITIES.join(",")} heartbeat=60000ms ttl=60000ms$`));
      const r = (await row(registration!.identity.instanceRef))!;
      expect(r.buildSource).toBe("unbuilt");
      expect(r.capabilitiesJson).toBe(JSON.stringify(RUNTIME_CAPABILITIES));
    } finally {
      await registration!.close();
    }
    expect((await row(registration!.identity.instanceRef))!.stoppedAt).not.toBeNull();
  });
});
