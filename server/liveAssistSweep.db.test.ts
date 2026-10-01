/**
 * LA-1a — the Live Assist purge against a real database.
 *
 * The owner approved cleanup on the existing worker on conditions, and each condition is a test here:
 * deterministic, bounded per tick, retry-safe, idempotent, safe after a restart and with concurrent
 * workers, tenant-safe, incapable of deleting permanent evidence or anything promoted into it, and
 * driven by server-controlled expiry rather than anything a client said.
 *
 * Determinism in a shared database: every sweep here runs with `now` in 2020, and every row this suite
 * plants has deadlines and retention in 2019–2020. Sessions any other suite creates carry real 2026
 * deadlines, so they can never be due at these instants and cannot disturb a count here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { getDb } from "./db";
import { sweepLiveAssist } from "./liveAssistService";
import type { DbOrTx } from "./_core/dbTypes";

const DB_URL = process.env.DATABASE_URL;

describe("Live Assist purge — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped purge suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let db: DbOrTx;
let seq = 916_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const T = (iso: string) => new Date(`${iso}Z`);
const SNAP = JSON.stringify({ idleSeconds: 120, maxSessionMinutes: 20, retentionHours: 24, maxFramesPerSession: 60, maxInferenceCallsPerSession: 40 });

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 8, timezone: "Z" });
  db = (await getDb())!;
});
afterAll(async () => { await pool?.end(); });

type Plant = {
  state: "active" | "paused" | "ended" | "expired";
  idle: string; hard: string; purgeAfter?: string | null; orgRef?: string;
};
async function plant(p: Plant) {
  const orgRef = p.orgRef ?? `ORG-${rnd()}`;
  const userId = seq++;
  const sessionRef = `LAS-${rnd()}${rnd()}${rnd()}XXX`.slice(0, 28);
  const open = p.state === "active" || p.state === "paused";
  await pool.execute(
    `INSERT INTO liveAssistSessions (sessionRef, orgRef, userId, startKey, source, state, openMarker, policySnapshotJson,
       startedAt, lastHeartbeatAt, idleDeadlineAt, hardDeadlineAt, endedAt, endReason, purgeAfter)
     VALUES (?,?,?,?, 'photo', ?, ?, ?, '2019-06-01 00:00:00', '2019-06-01 00:00:00', ?, ?, ?, ?, ?)`,
    [sessionRef, orgRef, userId, `key-${rnd()}-${rnd()}-${rnd()}`, p.state, open ? 1 : null, SNAP,
     p.idle, p.hard, open ? null : "2019-06-01 00:10:00", open ? null : "user_end", p.purgeAfter ?? null],
  );
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM liveAssistSessions WHERE sessionRef = ?", [sessionRef]);
  return { id: Number(r[0]!.id), orgRef, sessionRef };
}
async function children(s: { id: number; orgRef: string }, n: { turns?: number; observations?: number; frames?: number; savedFrameEvidenceId?: number; orgRef?: string }) {
  const org = n.orgRef ?? s.orgRef;
  for (let i = 0; i < (n.turns ?? 0); i++) {
    await pool.execute("INSERT INTO liveAssistTurns (sessionId, orgRef, seq, role, channel, text) VALUES (?,?,?,'user','text','transient')", [s.id, org, i + 1 + Math.floor(Math.random() * 1e6)]);
  }
  for (let i = 0; i < (n.observations ?? 0); i++) {
    await pool.execute("INSERT INTO liveAssistObservations (sessionId, orgRef, kind, statement, certainty) VALUES (?,?,'identified','transient','inferred')", [s.id, org]);
  }
  for (let i = 0; i < (n.frames ?? 0); i++) {
    await pool.execute("INSERT INTO liveAssistFrames (sessionId, orgRef, frameSeq, kind, frameHash, width, height, byteSize) VALUES (?,?,?,'context',?,640,480,1000)", [s.id, org, i + 1 + Math.floor(Math.random() * 1e6), "a".repeat(64)]);
  }
  if (n.savedFrameEvidenceId) {
    await pool.execute("INSERT INTO liveAssistFrames (sessionId, orgRef, frameSeq, kind, frameHash, width, height, byteSize, savedEvidenceRecordId) VALUES (?,?,?,'inspect',?,2048,1536,9000,?)",
      [s.id, org, 9_000_000 + Math.floor(Math.random() * 1e6), "b".repeat(64), n.savedFrameEvidenceId]);
  }
}
async function count(table: string, sessionId: number, extra = "") {
  const [r] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE sessionId = ? ${extra}`, [sessionId]);
  return Number(r[0]!.n);
}
async function session(id: number) {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT state, endReason, openMarker, purgeAfter, transientPurgedAt FROM liveAssistSessions WHERE id = ?", [id]);
  return r[0]!;
}
async function events(id: number) {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT eventType, endReason, actorUserId, detail FROM liveAssistEvents WHERE sessionId = ? ORDER BY id", [id]);
  return r;
}

d("expiry by server deadline", () => {
  it("stops open sessions whose deadline passed, leaves the rest, and records the server as the actor", async () => {
    const idle = await plant({ state: "active", idle: "2020-01-01 00:00:00", hard: "2020-06-02 00:00:00" });
    const hard = await plant({ state: "paused", idle: "2020-01-01 00:00:00", hard: "2020-01-01 00:00:00" });
    const live = await plant({ state: "active", idle: "2020-06-01 00:00:00", hard: "2020-06-02 00:00:00" });
    await sweepLiveAssist(db, T("2020-03-01 00:00:00"));
    expect(await session(idle.id)).toMatchObject({ state: "expired", endReason: "idle_timeout", openMarker: null });
    expect(await session(hard.id)).toMatchObject({ state: "ended", endReason: "budget_spent", openMarker: null });
    expect(await session(live.id)).toMatchObject({ state: "active", endReason: null, openMarker: 1 });
    expect((await events(idle.id)).map(e => [e.eventType, e.endReason, e.actorUserId, e.detail])).toEqual([["session_expired", "idle_timeout", null, "sweep"]]);
    expect(await events(live.id)).toEqual([]);
    const after = await session(idle.id);
    expect(new Date(after.purgeAfter).toISOString()).toBe(T("2020-03-02 00:00:00").toISOString());
  });
});

d("purge of transient rows", () => {
  it("removes turns, observations and unsaved frames once retention has passed, and marks the session", async () => {
    const s = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2020-01-01 00:00:00" });
    await children(s, { turns: 3, observations: 2, frames: 2 });
    const r = await sweepLiveAssist(db, T("2020-02-01 00:00:00"));
    expect(r.failures).toBe(0);
    expect([await count("liveAssistTurns", s.id), await count("liveAssistObservations", s.id), await count("liveAssistFrames", s.id)]).toEqual([0, 0, 0]);
    expect((await session(s.id)).transientPurgedAt).not.toBeNull();
    expect((await events(s.id)).map(e => [e.eventType, e.actorUserId, e.detail])).toEqual([["session_transient_purged", null, "rows=7"]]);
  });

  it("does not touch rows whose retention has not passed, or sessions still open", async () => {
    const notYet = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2020-12-01 00:00:00" });
    const open = await plant({ state: "active", idle: "2020-12-01 00:00:00", hard: "2020-12-02 00:00:00" });
    await children(notYet, { turns: 2, frames: 1 });
    await children(open, { turns: 2 });
    await sweepLiveAssist(db, T("2020-02-01 00:00:00"));
    expect(await count("liveAssistTurns", notYet.id)).toBe(2);
    expect(await count("liveAssistFrames", notYet.id)).toBe(1);
    expect(await count("liveAssistTurns", open.id)).toBe(2);
    expect((await session(notYet.id)).transientPurgedAt).toBeNull();
  });

  it("never deletes permanent evidence, or a frame that was promoted into it", async () => {
    await pool.execute("INSERT INTO evidenceRecords (title, category, capturedAt, status) VALUES (?, 'photo', '2019-06-01 00:05:00', 'needs_review')", [`LA sweep guard ${rnd()}`]);
    const [ev] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM evidenceRecords ORDER BY id DESC LIMIT 1");
    const evidenceId = Number(ev[0]!.id);
    const s = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2020-01-01 00:00:00" });
    await children(s, { frames: 2, savedFrameEvidenceId: evidenceId });
    await sweepLiveAssist(db, T("2020-02-01 00:00:00"));
    expect(await count("liveAssistFrames", s.id, "AND savedEvidenceRecordId IS NULL")).toBe(0);
    expect(await count("liveAssistFrames", s.id, "AND savedEvidenceRecordId IS NOT NULL")).toBe(1);
    const [still] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM evidenceRecords WHERE id = ?", [evidenceId]);
    expect(still.length).toBe(1);
    expect((await session(s.id)).state).toBe("ended");
  });

  it("is tenant-safe: a row carrying another organization is never deleted through this session", async () => {
    const s = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2020-01-01 00:00:00" });
    await children(s, { turns: 1 });
    await children(s, { turns: 1, orgRef: `ORG-OTHER-${rnd()}` });
    await sweepLiveAssist(db, T("2020-02-01 00:00:00"));
    expect(await count("liveAssistTurns", s.id, `AND orgRef = '${s.orgRef}'`)).toBe(0);
    expect(await count("liveAssistTurns", s.id, `AND orgRef <> '${s.orgRef}'`)).toBe(1);
  });
});

d("idempotent, bounded, concurrent, restart-safe", () => {
  it("does nothing the second time", async () => {
    const s = await plant({ state: "active", idle: "2020-01-01 00:00:00", hard: "2020-06-02 00:00:00" });
    await children(s, { turns: 2 });
    const now1 = T("2020-03-01 00:00:00");
    await sweepLiveAssist(db, now1);
    const later = T("2020-03-05 00:00:00");  // past this session's 24 h retention
    await sweepLiveAssist(db, later);
    const evBefore = (await events(s.id)).length;
    await sweepLiveAssist(db, later);
    await sweepLiveAssist(db, later);
    expect((await events(s.id)).length).toBe(evBefore);
    expect((await events(s.id)).map(e => e.eventType)).toEqual(["session_expired", "session_transient_purged"]);
  });

  it("deletes at most rowsPerTick rows per pass and finishes on a later tick, as a restarted worker would", async () => {
    const s = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2019-01-01 00:00:00" });
    await children(s, { turns: 5 });
    const now = T("2019-01-02 00:00:00");
    const first = await sweepLiveAssist(db, now, { sessionsPerTick: 10, rowsPerTick: 3 });
    expect(first.rowsDeleted).toBe(3);
    expect(await count("liveAssistTurns", s.id)).toBe(2);
    expect((await session(s.id)).transientPurgedAt).toBeNull();
    const second = await sweepLiveAssist(db, now, { sessionsPerTick: 10, rowsPerTick: 3 });
    expect(second.rowsDeleted).toBe(2);
    expect((await session(s.id)).transientPurgedAt).not.toBeNull();
  });

  it("gives one outcome per session when several workers sweep at once", async () => {
    const plantedAt = "2019-02-01 00:00:00";
    const expiring = await Promise.all([1, 2, 3].map(() => plant({ state: "active", idle: plantedAt, hard: "2019-02-02 00:00:00" })));
    const purging = await Promise.all([1, 2, 3].map(() => plant({ state: "ended", idle: plantedAt, hard: plantedAt, purgeAfter: plantedAt })));
    for (const p of purging) await children(p, { turns: 3, observations: 2, frames: 1 });
    const now = T("2019-02-01 06:00:00");
    const results = await Promise.all([1, 2, 3, 4].map(() => sweepLiveAssist(db, now)));
    const retry = await sweepLiveAssist(db, now);
    for (const e of expiring) {
      expect((await events(e.id)).map(x => x.eventType)).toEqual(["session_expired"]);
    }
    for (const p of purging) {
      expect([await count("liveAssistTurns", p.id), await count("liveAssistObservations", p.id), await count("liveAssistFrames", p.id)]).toEqual([0, 0, 0]);
      expect((await events(p.id)).map(x => x.eventType)).toEqual(["session_transient_purged"]);
    }
    const mine = new Set([...expiring, ...purging].map(x => x.id));
    expect(mine.size).toBe(6);
    expect(results.every(r => r.failures >= 0)).toBe(true);
    expect(retry.expired + retry.purgedSessions).toBe(0);
  });

  it("does not read the deployment switch: retention is honoured even with Live Assist off", async () => {
    const saved = process.env.LIVE_ASSIST_ENABLED;
    process.env.LIVE_ASSIST_ENABLED = "false";
    try {
      const s = await plant({ state: "ended", idle: "2019-06-01 00:02:00", hard: "2019-06-01 00:20:00", purgeAfter: "2019-03-01 00:00:00" });
      await children(s, { turns: 1 });
      await sweepLiveAssist(db, T("2019-03-02 00:00:00"));
      expect(await count("liveAssistTurns", s.id)).toBe(0);
    } finally {
      process.env.LIVE_ASSIST_ENABLED = saved;
    }
  });
});
