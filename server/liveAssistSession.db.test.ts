/**
 * LA-1a — the Live Assist session spine against a real database, through the mounted router.
 *
 * What the owner's ruling requires this checkpoint to prove, each as a refusal or a recorded fact:
 * unauthenticated and unauthorized callers fail closed; another organization can neither read, resume,
 * mutate nor terminate a session; a client cannot choose its organization; stopped sessions stay
 * stopped; the kill switch stops new use; budgets are the server's; malformed and stale references are
 * refused; and nothing here reaches the network or writes content to a log.
 */
import http from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;

describe("Live Assist session spine — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped Live Assist suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 910_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const key = () => `k-${rnd()}-${rnd()}-${rnd()}`;
const caller = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const anonymous = () => appRouter.createCaller({ req: {} as never, res: {} as never, user: null });
const savedEnv = process.env.LIVE_ASSIST_ENABLED;

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 8 }); });
afterAll(async () => { await pool?.end(); process.env.LIVE_ASSIST_ENABLED = savedEnv; });
beforeEach(() => { process.env.LIVE_ASSIST_ENABLED = "true"; });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, role: string, userId = seq++) {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
const POLICY = { enabled: true, sourcesAllowed: ["photo" as const], idleSeconds: 120, maxSessionMinutes: 20, retentionHours: 12, maxSessionsPerUserPerDay: 30, dailySpendCeilingCents: 1_000 };
/** An organization with Live Assist switched on, a manager who configured it, and a driver. */
async function scene(policy: Partial<typeof POLICY> = {}) {
  const o = await org();
  const manager = await member(o, "management");
  const driver = await member(o, "driver");
  await caller(manager).liveAssist.policySet({ ...POLICY, ...policy });
  return { o, manager, driver };
}
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "RESOLVED"; } catch (e) { return e instanceof TRPCError ? e.code : `THREW ${(e as Error).message}`; }
}
async function row(sessionRef: string) {
  const [r] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM liveAssistSessions WHERE sessionRef = ?", [sessionRef]);
  return r[0]!;
}
async function events(sessionRef: string) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT e.eventType, e.endReason, e.actorUserId FROM liveAssistEvents e JOIN liveAssistSessions s ON s.id = e.sessionId WHERE s.sessionRef = ? ORDER BY e.id", [sessionRef]);
  return r.map(x => `${x.eventType}${x.endReason ? `:${x.endReason}` : ""}`);
}

d("who may call", () => {
  it("refuses an unauthenticated caller on every procedure", async () => {
    const a = anonymous().liveAssist;
    const ref = "LAS-AAAAAAAAAAAAAAAAAAAAAAAA";
    expect(await code(a.start({ source: "photo", startKey: key() }))).toBe("UNAUTHORIZED");
    expect(await code(a.heartbeat({ sessionRef: ref }))).toBe("UNAUTHORIZED");
    expect(await code(a.end({ sessionRef: ref }))).toBe("UNAUTHORIZED");
    expect(await code(a.policyGet())).toBe("UNAUTHORIZED");
    expect(await code(a.lifecycleList({ from: new Date(0), to: new Date() }))).toBe("UNAUTHORIZED");
  });

  it("refuses roles the owner did not approve, and refuses administration and review to ordinary users", async () => {
    const { o, driver } = await scene();
    for (const role of ["safety", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant"]) {
      const u = await member(o, role);
      expect(await code(caller(u).liveAssist.start({ source: "photo", startKey: key() })), role).toBe("FORBIDDEN");
    }
    const noRole = seq++;
    await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, o, noRole]);
    expect(await code(caller(noRole).liveAssist.start({ source: "photo", startKey: key() }))).toBe("FORBIDDEN");
    expect(await code(caller(driver).liveAssist.policySet(POLICY))).toBe("FORBIDDEN");
    expect(await code(caller(driver).liveAssist.lifecycleList({ from: new Date(0), to: new Date() }))).toBe("FORBIDDEN");
  });

  it("lets each approved role open a session", async () => {
    const { o } = await scene();
    for (const role of ["driver", "dispatcher", "mechanic", "shop_lead", "office", "management"]) {
      const u = await member(o, role);
      const r = await caller(u).liveAssist.start({ source: "photo", startKey: key() });
      expect(r.session.state, role).toBe("active");
    }
  });
});

d("lifecycle", () => {
  it("moves active → paused → active → ended, records each decision once, and ignores repeats", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    expect(session.state).toBe("active");
    expect((await c.pause({ sessionRef: session.sessionRef })).state).toBe("paused");
    expect((await c.pause({ sessionRef: session.sessionRef })).state).toBe("paused");
    expect((await c.resume({ sessionRef: session.sessionRef })).state).toBe("active");
    expect((await c.resume({ sessionRef: session.sessionRef })).state).toBe("active");
    expect((await c.heartbeat({ sessionRef: session.sessionRef })).state).toBe("active");
    const ended = await c.end({ sessionRef: session.sessionRef });
    expect(ended.state).toBe("ended");
    expect(ended.endReason).toBe("user_end");
    expect((await c.end({ sessionRef: session.sessionRef })).state).toBe("ended");
    expect(await events(session.sessionRef)).toEqual(["session_started", "session_paused", "session_resumed", "session_ended:user_end"]);
    const r = await row(session.sessionRef);
    expect(r.openMarker).toBeNull();
    expect(new Date(r.purgeAfter).getTime() - new Date(r.endedAt).getTime()).toBe(12 * 3_600_000);
  });

  it("never lets a terminated session reactivate", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    await c.end({ sessionRef: session.sessionRef });
    expect(await code(c.resume({ sessionRef: session.sessionRef }))).toBe("CONFLICT");
    expect(await code(c.pause({ sessionRef: session.sessionRef }))).toBe("CONFLICT");
    const hb = await c.heartbeat({ sessionRef: session.sessionRef });
    expect(hb.state).toBe("ended");
    expect((await row(session.sessionRef)).state).toBe("ended");
  });

  it("expires an idle session by its server deadline, and an expired session cannot be resumed", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    await c.pause({ sessionRef: session.sessionRef });
    await pool.execute("UPDATE liveAssistSessions SET idleDeadlineAt = '2020-01-01 00:00:00' WHERE sessionRef = ?", [session.sessionRef]);
    expect(await code(c.resume({ sessionRef: session.sessionRef }))).toBe("CONFLICT");
    const r = await row(session.sessionRef);
    expect(r.state).toBe("expired");
    expect(r.endReason).toBe("idle_timeout");
    expect(await events(session.sessionRef)).toEqual(["session_started", "session_paused", "session_expired:idle_timeout"]);
    expect(await code(c.resume({ sessionRef: session.sessionRef }))).toBe("CONFLICT");
  });

  it("ends a session at its hard deadline even while it is being kept alive", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    await pool.execute("UPDATE liveAssistSessions SET hardDeadlineAt = '2020-01-01 00:00:00', idleDeadlineAt = '2020-01-01 00:00:00' WHERE sessionRef = ?", [session.sessionRef]);
    const hb = await c.heartbeat({ sessionRef: session.sessionRef });
    expect(hb.state).toBe("ended");
    expect(hb.endReason).toBe("budget_spent");
  });

  it("moves the idle deadline from the server's clock on heartbeat, and never the hard deadline", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    await pool.execute("UPDATE liveAssistSessions SET idleDeadlineAt = DATE_ADD(NOW(), INTERVAL 5 SECOND) WHERE sessionRef = ?", [session.sessionRef]);
    const before = await row(session.sessionRef);
    const hb = await c.heartbeat({ sessionRef: session.sessionRef });
    expect(hb.idleDeadlineAt.getTime()).toBeGreaterThan(new Date(before.idleDeadlineAt).getTime());
    expect(hb.hardDeadlineAt.getTime()).toBe(new Date(before.hardDeadlineAt).getTime());
  });
});

d("start: idempotency, one open session, and budgets", () => {
  it("returns the same session for a repeated startKey and records one start", async () => {
    const { driver } = await scene();
    const k = key();
    const a = await caller(driver).liveAssist.start({ source: "photo", startKey: k });
    const b = await caller(driver).liveAssist.start({ source: "photo", startKey: k });
    expect(b.session.sessionRef).toBe(a.session.sessionRef);
    expect(b.replayed).toBe(true);
    expect(await events(a.session.sessionRef)).toEqual(["session_started"]);
  });

  it("returns one session to concurrent retries of the same start", async () => {
    const { driver } = await scene();
    const k = key();
    const results = await Promise.all([1, 2, 3, 4].map(() => caller(driver).liveAssist.start({ source: "photo", startKey: k })));
    expect(new Set(results.map(r => r.session.sessionRef)).size).toBe(1);
    expect(results.filter(r => !r.replayed).length).toBe(1);
    expect(await events(results[0]!.session.sessionRef)).toEqual(["session_started"]);
  });

  it("scopes the startKey to the caller: the same key from another person opens their own session", async () => {
    const { o, driver } = await scene();
    const other = await member(o, "driver");
    const k = key();
    const a = await caller(driver).liveAssist.start({ source: "photo", startKey: k });
    const b = await caller(other).liveAssist.start({ source: "photo", startKey: k });
    expect(b.session.sessionRef).not.toBe(a.session.sessionRef);
    expect(b.replayed).toBe(false);
  });

  it("allows one open session per person, even when two starts race", async () => {
    const { driver } = await scene();
    const results = await Promise.allSettled([1, 2, 3].map(() => caller(driver).liveAssist.start({ source: "photo", startKey: key() })));
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as TRPCError).code).toBe("CONFLICT");
    const [n] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM liveAssistSessions WHERE userId = ? AND openMarker = 1", [driver]);
    expect(Number(n[0]!.n)).toBe(1);
  });

  it("chains a new session to a stopped one, and refuses to chain to one still open", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    const first = await c.start({ source: "photo", startKey: key() });
    expect(await code(c.start({ source: "photo", startKey: key(), previousSessionRef: first.session.sessionRef }))).toBe("CONFLICT");
    await c.end({ sessionRef: first.session.sessionRef });
    const next = await c.start({ source: "photo", startKey: key(), previousSessionRef: first.session.sessionRef });
    expect(next.session.previousSessionRef).toBe(first.session.sessionRef);
    expect((await row(first.session.sessionRef)).state).toBe("ended");
  });

  it("enforces the daily session limit on the server", async () => {
    const { driver } = await scene({ maxSessionsPerUserPerDay: 2 });
    const c = caller(driver).liveAssist;
    for (let i = 0; i < 2; i++) {
      const { session } = await c.start({ source: "photo", startKey: key() });
      await c.end({ sessionRef: session.sessionRef });
    }
    expect(await code(c.start({ source: "photo", startKey: key() }))).toBe("TOO_MANY_REQUESTS");
  });

  it("refuses sources this release has not built", async () => {
    const { driver } = await scene();
    for (const source of ["camera", "screen", "video"] as const) {
      expect(await code(caller(driver).liveAssist.start({ source, startKey: key() })), source).toBe("PRECONDITION_FAILED");
    }
  });
});

d("tenancy", () => {
  it("does not let Organization B read, resume, mutate, terminate or chain to Organization A's session", async () => {
    const A = await scene();
    const B = await scene();
    const { session } = await caller(A.driver).liveAssist.start({ source: "photo", startKey: key() });
    const before = await row(session.sessionRef);
    for (const u of [B.driver, B.manager]) {
      const c = caller(u).liveAssist;
      expect(await code(c.heartbeat({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
      expect(await code(c.pause({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
      expect(await code(c.resume({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
      expect(await code(c.end({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
      expect(await code(c.start({ source: "photo", startKey: key(), previousSessionRef: session.sessionRef }))).toBe("NOT_FOUND");
    }
    const list = await caller(B.manager).liveAssist.lifecycleList({ from: new Date(0), to: new Date(Date.now() + 60_000) });
    expect(list.map(s => s.sessionRef)).not.toContain(session.sessionRef);
    const after = await row(session.sessionRef);
    expect({ state: after.state, idle: String(after.idleDeadlineAt), hb: String(after.lastHeartbeatAt) })
      .toEqual({ state: before.state, idle: String(before.idleDeadlineAt), hb: String(before.lastHeartbeatAt) });
    expect(await events(session.sessionRef)).toEqual(["session_started"]);
  });

  it("does not let another person in the same organization touch the session either", async () => {
    const { o, driver } = await scene();
    const other = await member(o, "driver");
    const { session } = await caller(driver).liveAssist.start({ source: "photo", startKey: key() });
    expect(await code(caller(other).liveAssist.end({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
    expect((await row(session.sessionRef)).state).toBe("active");
  });

  it("does not let the same person, now acting for another organization, change the old session", async () => {
    const A = await scene();
    const B = await scene();
    const { session } = await caller(A.driver).liveAssist.start({ source: "photo", startKey: key() });
    await pool.execute("UPDATE organizationMemberships SET effectiveTo = '2021-01-01' WHERE userId = ? AND orgRef = ?", [A.driver, A.o]);
    await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, B.o, A.driver]);
    expect(await code(caller(A.driver).liveAssist.end({ sessionRef: session.sessionRef }))).toBe("NOT_FOUND");
    expect((await row(session.sessionRef)).state).toBe("active");
    const fresh = await caller(A.driver).liveAssist.start({ source: "photo", startKey: key() });
    expect((await row(fresh.session.sessionRef)).orgRef).toBe(B.o);
  });

  it("writes the organization from the server, and refuses one sent by the client", async () => {
    const A = await scene();
    const B = await scene();
    const c = caller(A.driver).liveAssist as unknown as { start: (i: unknown) => Promise<unknown> };
    expect(await code(c.start({ source: "photo", startKey: key(), orgRef: B.o }))).toBe("BAD_REQUEST");
    expect(await code(c.start({ source: "photo", startKey: key(), tenantId: B.o }))).toBe("BAD_REQUEST");
    const { session } = await caller(A.driver).liveAssist.start({ source: "photo", startKey: key() });
    expect((await row(session.sessionRef)).orgRef).toBe(A.o);
  });

  it("refuses a user with two live memberships and no established organization", async () => {
    const A = await scene();
    const B = await scene();
    await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, B.o, A.driver]);
    expect(await code(caller(A.driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
  });

  it("shows a reviewer only their own organization's lifecycle, and never content", async () => {
    const { o, driver } = await scene();
    const safety = await member(o, "safety");
    const { session } = await caller(driver).liveAssist.start({ source: "photo", startKey: key() });
    const list = await caller(safety).liveAssist.lifecycleList({ from: new Date(0), to: new Date(Date.now() + 60_000) });
    const mine = list.find(s => s.sessionRef === session.sessionRef)!;
    expect(Object.keys(mine).sort()).toEqual(["endReason", "endedAt", "events", "sessionRef", "source", "startedAt", "state", "transientPurgedAt", "userId"]);
    expect(mine.events.map(e => e.eventType)).toEqual(["session_started"]);
  });
});

d("malformed and stale references", () => {
  it("refuses malformed references at the boundary and unknown ones as not found", async () => {
    const { driver } = await scene();
    const c = caller(driver).liveAssist;
    expect(await code(c.heartbeat({ sessionRef: "not-a-ref" }))).toBe("BAD_REQUEST");
    expect(await code(c.end({ sessionRef: "' OR 1=1 --" }))).toBe("BAD_REQUEST");
    expect(await code(c.heartbeat({ sessionRef: "LAS-ZZZZZZZZZZZZZZZZZZZZZZZZ" }))).toBe("NOT_FOUND");
    expect(await code(c.start({ source: "photo", startKey: "short" }))).toBe("BAD_REQUEST");
  });
});

d("the kill switch", () => {
  it("refuses a new session when the deployment switch is off, whatever the organization's policy", async () => {
    const { driver } = await scene();
    process.env.LIVE_ASSIST_ENABLED = "false";
    expect(await code(caller(driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
    delete process.env.LIVE_ASSIST_ENABLED;
    expect(await code(caller(driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
  });

  it("refuses when the organization never configured Live Assist, disabled it, or set no spend ceiling", async () => {
    const o = await org();
    const driver = await member(o, "driver");
    expect(await code(caller(driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
    const off = await scene({ enabled: false });
    expect(await code(caller(off.driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
    const noCeiling = await scene({ dailySpendCeilingCents: null as unknown as number });
    expect(await code(caller(noCeiling.driver).liveAssist.start({ source: "photo", startKey: key() }))).toBe("PRECONDITION_FAILED");
    const p = await caller(noCeiling.driver).liveAssist.policyGet();
    expect(p.effective.enabled).toBe(false);
    expect(p.effective.disabledBecause).toEqual(["no_spend_ceiling"]);
  });

  it("stops an open session on its next call once switched off, and records why", async () => {
    const { manager, driver } = await scene();
    const c = caller(driver).liveAssist;
    const { session } = await c.start({ source: "photo", startKey: key() });
    process.env.LIVE_ASSIST_ENABLED = "false";
    const hb = await c.heartbeat({ sessionRef: session.sessionRef });
    expect(hb.state).toBe("ended");
    expect(hb.endReason).toBe("policy_disabled");
    expect(await code(c.resume({ sessionRef: session.sessionRef }))).toBe("CONFLICT");
    expect(await events(session.sessionRef)).toEqual(["session_started", "session_ended:policy_disabled"]);
    // Administration still works while switched off: the switch stops use, not configuration.
    expect((await caller(manager).liveAssist.policyGet()).effective.disabledBecause).toEqual(["deployment_switch_off"]);
  });
});

d("policy", () => {
  it("refuses a policy above LeaseOS's hard limits and changes nothing", async () => {
    const { manager } = await scene();
    const before = await caller(manager).liveAssist.policyGet();
    expect(await code(caller(manager).liveAssist.policySet({ ...POLICY, idleSeconds: 99_999 }))).toBe("BAD_REQUEST");
    expect(await code(caller(manager).liveAssist.policySet({ ...POLICY, sourcesAllowed: ["photo", "screen"] }))).toBe("BAD_REQUEST");
    expect((await caller(manager).liveAssist.policyGet()).policyRef).toBe(before.policyRef);
  });

  it("keeps exactly one current policy per organization, even under concurrent changes", async () => {
    const { o, manager } = await scene();
    const results = await Promise.allSettled([60, 90, 110].map(idleSeconds => caller(manager).liveAssist.policySet({ ...POLICY, idleSeconds })));
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    const [n] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM liveAssistPolicies WHERE orgRef = ? AND currentMarker = 1", [o]);
    expect(Number(n[0]!.n)).toBe(1);
    const [all] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM liveAssistPolicies WHERE orgRef = ?", [o]);
    expect(Number(all[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});

d("the lifecycle record", () => {
  it("is append-only in the database itself", async () => {
    const { driver } = await scene();
    const { session } = await caller(driver).liveAssist.start({ source: "photo", startKey: key() });
    const { id } = await row(session.sessionRef);
    await expect(pool.execute("UPDATE liveAssistEvents SET detail = 'x' WHERE sessionId = ?", [id])).rejects.toThrow(/append-only/);
    await expect(pool.execute("DELETE FROM liveAssistEvents WHERE sessionId = ?", [id])).rejects.toThrow(/never deleted/);
  });
});

d("no network, no model, no content in logs", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

  it("runs a whole session without touching the network or writing anything a person sent to a log", async () => {
    const { manager, driver } = await scene();
    const fetchSpy = vi.fn(() => { throw new Error("network forbidden in LA-1a"); });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const httpSpy = vi.spyOn(http, "request");
    const httpsSpy = vi.spyOn(https, "request");
    spies.push(httpSpy, httpsSpy);
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    }
    try {
      const c = caller(driver).liveAssist;
      const k = key();
      const { session } = await c.start({ source: "photo", startKey: k });
      await c.heartbeat({ sessionRef: session.sessionRef });
      await c.pause({ sessionRef: session.sessionRef });
      await c.resume({ sessionRef: session.sessionRef });
      await c.end({ sessionRef: session.sessionRef });
      await caller(manager).liveAssist.lifecycleList({ from: new Date(0), to: new Date(Date.now() + 60_000) });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      for (const line of logs) {
        expect(line).not.toContain(session.sessionRef);
        expect(line).not.toContain(k);
        expect(line).not.toMatch(/data:image|base64/i);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
