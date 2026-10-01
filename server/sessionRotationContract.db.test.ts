/**
 * P0-B — the refresh-family contract (SR-T1..SR-T12) held end to end by the production procedures.
 *
 * The service rules live in `sessionFamily.db.test.ts` and the arithmetic in
 * `_core/sessionFamily.test.ts`; this suite proves `auth.refresh`, `auth.logout` and
 * `auth.revokeAll` keep them — and that none was loosened to make the cookie reach the endpoint.
 * `Date` alone is faked where a case needs the clock moved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ORG_SELECTION_COOKIE } from "./_core/organizationSelection";
const envSet = vi.hoisted(() => {
  const set: string[] = [];
  if (!process.env.JWT_SECRET) { process.env.JWT_SECRET = "p0b-test-signing-secret-long-enough-to-be-realistic"; set.push("JWT_SECRET"); }
  if (!process.env.VITE_APP_ID) { process.env.VITE_APP_ID = "leaseos-p0b-test-app"; set.push("VITE_APP_ID"); }
  return set;
});
import mysql from "mysql2/promise";
import { decodeJwt } from "jose";
import { COOKIE_NAME, REFRESH_COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { LEGACY_REFRESH_COOKIE_PATHS, REFRESH_COOKIE_PATH } from "./_core/cookies";
import { ENV } from "./_core/env";
import { sdk } from "./_core/sdk";
import { ACCESS_TOKEN_TTL_MS, REFRESH_ABSOLUTE_TTL_MS } from "./_core/sessionFamily";
import { createSessionFamily, redeemRefresh, revokeFamily, type RevokeReason } from "./sessionFamilyService";
import { upsertUser } from "./db";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 0;
const newOpenId = () => `p0b-rot-${Date.now()}-${seq++}`;
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await pool?.end(); for (const k of envSet) delete process.env[k]; });

const rowFor = async (familyRef: string) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT * FROM sessionFamilies WHERE familyRef = ?", [familyRef]))[0][0]!;

type SetCall = { name: string; value: string; options: Record<string, unknown> };
type ClearCall = { name: string; options: Record<string, unknown> };
function caller(cookieValue?: string, origin = "https://app.leaseos.test") {
  const set: SetCall[] = []; const cleared: ClearCall[] = [];
  const req = { headers: { cookie: cookieValue ? `${REFRESH_COOKIE_NAME}=${cookieValue}` : "", host: "app.leaseos.test", origin } };
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => { set.push({ name, value, options }); },
    clearCookie: (name: string, options: Record<string, unknown>) => { cleared.push({ name, options }); },
  };
  return { set, cleared, api: appRouter.createCaller({ req, res, user: null } as never) };
}
const cred = (f: { familyRef: string; verifier: string }) => `${f.familyRef}.${f.verifier}`;
const rotated = (c: ReturnType<typeof caller>) => c.set.find(s => s.name === REFRESH_COOKIE_NAME)!;
const verifierOf = (cookieValue: string) => cookieValue.slice(cookieValue.indexOf(".") + 1);
async function family(opts: Partial<Parameters<typeof createSessionFamily>[0]> = {}) {
  const openId = opts.openId ?? newOpenId();
  await upsertUser({ openId, name: "Dana Rotation", email: null, loginMethod: "test", lastSignedIn: new Date() } as never);
  return { openId, ...(await createSessionFamily({ openId, appId: ENV.appId || null, ...opts })) };
}
const REFUSED = { code: "UNAUTHORIZED", message: "Session expired. Sign in again." };
const clearedRefreshPaths = (c: ReturnType<typeof caller>) => c.cleared.filter(x => x.name === REFRESH_COOKIE_NAME).map(x => x.options.path);

d("SR-T1..T4 — single use, rotation, reuse revocation, no oracle", () => {
  it("SR-T1. a valid refresh rotates the verifier and mints an access token the server accepts", async () => {
    const f = await family();
    const c = caller(cred(f));
    await expect(c.api.auth.refresh()).resolves.toEqual({ ok: true });
    const next = rotated(c);
    expect(next.value).not.toBe(cred(f));
    expect(next.value.startsWith(`${f.familyRef}.`)).toBe(true);
    expect(next.options).toMatchObject({ path: REFRESH_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "none", maxAge: REFRESH_ABSOLUTE_TTL_MS });
    expect((await rowFor(f.familyRef)).rotationCounter).toBe(1);
    const access = c.set.find(s => s.name === COOKIE_NAME)!;
    expect(access.options).toMatchObject({ path: "/", maxAge: ACCESS_TOKEN_TTL_MS });
    await expect(sdk.verifySession(access.value), "the replacement access token must verify").resolves.toMatchObject({ openId: f.openId, appId: ENV.appId });
  });

  it("SR-T2. the spent verifier cannot be redeemed again", async () => {
    const f = await family();
    await caller(cred(f)).api.auth.refresh();
    await expect(caller(cred(f)).api.auth.refresh()).rejects.toMatchObject(REFUSED);
  });

  it("SR-T3. a replay revokes the family; the current verifier dies with it", async () => {
    const f = await family();
    const first = caller(cred(f));
    await first.api.auth.refresh();
    const current = rotated(first).value;
    const replay = caller(cred(f));
    await expect(replay.api.auth.refresh()).rejects.toMatchObject(REFUSED);
    expect(clearedRefreshPaths(replay)).toContain(REFRESH_COOKIE_PATH);
    expect((await rowFor(f.familyRef)).revokeReason).toBe("reuse_detected");
    await expect(caller(current).api.auth.refresh()).rejects.toMatchObject(REFUSED);
    expect((await redeemRefresh(f.familyRef, verifierOf(current), new Date())).kind).toBe("revoked");
  });

  it("SR-T4. an unknown family answers exactly like a dead one and creates nothing", async () => {
    await expect(caller("SF-does-not-exist.anything").api.auth.refresh()).rejects.toMatchObject(REFUSED);
    await expect(caller("SF-does-not-exist.anything").api.auth.revokeAll()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const n = (await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM sessionFamilies WHERE familyRef = 'SF-does-not-exist'"))[0][0]!.n;
    expect(Number(n)).toBe(0);
    const dead = await family();
    await revokeFamily(dead.familyRef, "admin");
    await expect(caller(cred(dead)).api.auth.refresh()).rejects.toMatchObject(REFUSED);
  });
});

d("SR-T5/T6 — the lifetimes", () => {
  it("SR-T5. rotation never moves the absolute ceiling; past it the family is over and the cookie is cleared", async () => {
    const f = await family();
    const ceiling = new Date((await rowFor(f.familyRef)).absoluteExpiresAt).getTime();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const c = caller(cred(f));
    await expect(c.api.auth.refresh()).resolves.toEqual({ ok: true });
    expect(new Date((await rowFor(f.familyRef)).absoluteExpiresAt).getTime()).toBe(ceiling);
    vi.setSystemTime(ceiling + 60_000);
    const late = caller(rotated(c).value);
    await expect(late.api.auth.refresh()).rejects.toMatchObject(REFUSED);
    expect(clearedRefreshPaths(late)).toEqual([REFRESH_COOKIE_PATH, ...LEGACY_REFRESH_COOKIE_PATHS]);
  });

  it("SR-T6. the access lifetime is fifteen minutes, on the token and on the cookie", async () => {
    const f = await family();
    const c = caller(cred(f));
    await c.api.auth.refresh();
    const access = c.set.find(s => s.name === COOKIE_NAME)!;
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(access.options.maxAge).toBe(ACCESS_TOKEN_TTL_MS);
    const life = (decodeJwt(access.value).exp as number) * 1000 - Date.now();
    expect(life).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 2_000);
    expect(life).toBeGreaterThan(ACCESS_TOKEN_TTL_MS - 10_000);
  });
});

d("SR-T7/T8/T9 — revocation", () => {
  it("SR-T7. logout revokes the family and clears both credentials at their issuing paths", async () => {
    const f = await family();
    const c = caller(cred(f));
    await expect(c.api.auth.logout()).resolves.toEqual({ success: true });
    expect((await rowFor(f.familyRef)).revokeReason).toBe("logout");
    // #64 (v23.26): the organization selection ends with the session, at the session cookie's path.
    expect(c.cleared.map(x => [x.name, x.options.path])).toEqual([[COOKIE_NAME, "/"], [REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH], ...LEGACY_REFRESH_COOKIE_PATHS.map(p => [REFRESH_COOKIE_NAME, p]), [ORG_SELECTION_COOKIE, "/"]]);
    await expect(caller(cred(f)).api.auth.refresh()).rejects.toMatchObject(REFUSED);
  });

  it("SR-T8. revoke-all ends every family of the account, nobody else's, and clears the cookies", async () => {
    const f = await family();
    const sibling = await createSessionFamily({ openId: f.openId, appId: ENV.appId || null });
    const stranger = await family();
    const c = caller(cred(f));
    await expect(c.api.auth.revokeAll()).resolves.toEqual({ ok: true });
    expect((await rowFor(sibling.familyRef)).revokeReason).toBe("revoked_all");
    expect((await rowFor(f.familyRef)).revokeReason).toBe("revoked_all");
    expect((await rowFor(stranger.familyRef)).revokedAt).toBeNull();
    expect(clearedRefreshPaths(c)).toEqual([REFRESH_COOKIE_PATH, ...LEGACY_REFRESH_COOKIE_PATHS]);
    await expect(caller(cred(stranger)).api.auth.refresh()).resolves.toEqual({ ok: true });
  });

  it.each(["device_revoked", "credential_change", "admin"] as RevokeReason[])("SR-T9. a family revoked for %s refuses the refresh and keeps its reason", async reason => {
    const f = await family();
    await revokeFamily(f.familyRef, reason);
    await expect(caller(cred(f)).api.auth.refresh()).rejects.toMatchObject(REFUSED);
    await revokeFamily(f.familyRef, "logout");
    expect((await rowFor(f.familyRef)).revokeReason).toBe(reason);
  });
});

d("SR-T10/T11/T12 — what survives rotation, and what cannot be revived", () => {
  it("SR-T10. MFA assurance and its timestamp survive a valid rotation", async () => {
    const at = new Date("2026-09-30T12:00:00Z");
    const f = await family({ authAssurance: "mfa", mfaCompletedAt: at });
    const c = caller(cred(f));
    await expect(c.api.auth.refresh()).resolves.toEqual({ ok: true });
    const row = await rowFor(f.familyRef);
    expect(row.authAssurance).toBe("mfa");
    expect(new Date(row.mfaCompletedAt).getTime()).toBe(at.getTime());
    const again = await redeemRefresh(f.familyRef, verifierOf(rotated(c).value), new Date());
    expect(again).toMatchObject({ kind: "ok", authAssurance: "mfa", mfaCompletedAt: at });
  });

  it("SR-T11. the app binding is enforced through the procedures and preserved by rotation", async () => {
    expect(ENV.appId).toBeTruthy();
    const mine = await family();
    const c = caller(cred(mine));
    await expect(c.api.auth.refresh()).resolves.toEqual({ ok: true });
    expect((await rowFor(mine.familyRef)).appId).toBe(ENV.appId);
    await expect(caller(rotated(c).value).api.auth.refresh()).resolves.toEqual({ ok: true });
    for (const appId of ["some-other-app", null]) {
      const foreign = await family({ appId });
      await expect(caller(cred(foreign)).api.auth.refresh()).rejects.toMatchObject(REFUSED);
      await expect(caller(cred(foreign)).api.auth.revokeAll()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect((await rowFor(foreign.familyRef)).rotationCounter).toBe(0);
    }
  });

  it("SR-T12. a revoked family is not revived by possession of its cookie, and the refusal clears it", async () => {
    const f = await family();
    const c = caller(cred(f));
    await c.api.auth.refresh();
    await revokeFamily(f.familyRef, "admin");
    const later = caller(rotated(c).value);
    await expect(later.api.auth.refresh()).rejects.toMatchObject(REFUSED);
    expect(later.set.map(s => s.name)).toEqual([]);
    expect(clearedRefreshPaths(later)).toEqual([REFRESH_COOKIE_PATH, ...LEGACY_REFRESH_COOKIE_PATHS]);
    expect((await rowFor(f.familyRef)).revokeReason).toBe("admin");
  });
});
