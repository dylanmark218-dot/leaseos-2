/**
 * S1-D wiring — logout revokes, and the refresh endpoint spends a credential.
 *
 * The service is proved in `sessionFamily.db.test.ts`. What this adds is that the *procedures*
 * actually use it: before S1, `auth.logout` cleared a cookie and returned success, which left a
 * token already copied out of the browser working for the rest of its year. A test that only
 * checked the cookie was cleared would have passed against that.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * `_core/env` reads `JWT_SECRET` at module load, and minting the access token on a refresh needs a
 * real signing key. `vi.hoisted` runs before the imports below are evaluated, which is the only
 * point at which setting it still matters. Defaulted rather than overwritten, so a run that already
 * supplies a secret keeps it.
 */
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "s1-test-signing-secret-long-enough-to-be-realistic";
});
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { createSessionFamily, redeemRefresh } from "./sessionFamilyService";
import { REFRESH_COOKIE_NAME } from "@shared/const";

const DB_URL = process.env.DATABASE_URL;

describe("session wiring — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 0;
const openId = () => `s1w-${Date.now()}-${seq++}`;

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

/** A caller whose request carries the refresh cookie, and whose response we can inspect. */
function caller(cookieValue?: string) {
  const cleared: string[] = [];
  const set: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const req = { headers: { cookie: cookieValue ? `${REFRESH_COOKIE_NAME}=${cookieValue}` : "" } };
  const res = {
    clearCookie: (name: string) => { cleared.push(name); },
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      { set.push({ name, value, options }); },
  };
  return {
    cleared, set,
    api: appRouter.createCaller({ req, res, user: { id: 1, role: "user" } } as never),
  };
}

const rowFor = async (familyRef: string) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM sessionFamilies WHERE familyRef = ?", [familyRef]);
  return r[0]!;
};

d("logout revokes rather than merely forgetting", () => {
  it("D1w. revokes the family named by the refresh cookie", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: null });
    const c = caller(`${f.familyRef}.${f.verifier}`);
    await c.api.auth.logout();

    const row = await rowFor(f.familyRef);
    expect(row.revokedAt, "logout must end the family, not just clear a cookie").not.toBeNull();
    expect(row.revokeReason).toBe("logout");
  });

  it("D1x. the refresh is dead afterwards", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: null });
    await caller(`${f.familyRef}.${f.verifier}`).api.auth.logout();
    expect((await redeemRefresh(f.familyRef, f.verifier, new Date())).kind).toBe("revoked");
  });

  it("D1y. still clears the cookies, and still succeeds with no cookie present", async () => {
    const c = caller();
    await expect(c.api.auth.logout()).resolves.toMatchObject({ success: true });
    expect(c.cleared.length).toBeGreaterThan(0);
  });
});

d("refresh spends one credential and issues the next", () => {
  it("C1w. returns a new access token and rotates the cookie", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: null });
    const c = caller(`${f.familyRef}.${f.verifier}`);
    const out = await c.api.auth.refresh();

    expect(out.ok).toBe(true);
    const refreshCookie = c.set.find(s => s.name === REFRESH_COOKIE_NAME);
    expect(refreshCookie, "a rotated refresh credential must be set").toBeTruthy();
    expect(refreshCookie!.value).not.toBe(`${f.familyRef}.${f.verifier}`);
  });

  it("C3w. the previous cookie no longer works", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: null });
    const cookie = `${f.familyRef}.${f.verifier}`;
    await caller(cookie).api.auth.refresh();
    await expect(caller(cookie).api.auth.refresh()).rejects.toThrow();
  });

  it("C4w. reusing the previous cookie kills the family", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: null });
    const cookie = `${f.familyRef}.${f.verifier}`;
    await caller(cookie).api.auth.refresh();
    await caller(cookie).api.auth.refresh().catch(() => undefined);
    expect((await rowFor(f.familyRef)).revokeReason).toBe("reuse_detected");
  });

  it("refuses when no refresh cookie is presented", async () => {
    await expect(caller().api.auth.refresh()).rejects.toThrow();
  });
});
