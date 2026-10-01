/**
 * P0-B — the refresh credential crosses the browser cookie boundary, proved over HTTP.
 *
 * The defect this pins: the refresh cookie was issued with `Path=/api/auth` while the refresh
 * request goes to `POST /api/trpc/auth.refresh`. Every router-level test passed, because a
 * `createCaller` test hands the procedure a `cookie` header directly and never asks whether a
 * browser would have sent one. A standards-compliant browser does not (RFC 6265 §5.1.4), so the
 * credential was issued and never delivered, and every session ended with its first access token.
 *
 * So this suite does not call the router. It starts the real Express app — `registerApi`, the
 * same registration `_core/index.ts` uses, so the tRPC mount is the production one — logs in
 * through the same issuing function the OAuth callback uses (`issueBrowserSession`, minus the
 * provider exchange), and drives it with a cookie jar that implements RFC 6265 (tough-cookie).
 * Time is advanced by faking `Date` only, so the access token expires for the server and for the
 * jar alike while sockets and timers keep working.
 *
 * The jar models the application's https origin; the socket is loopback http. Cookie delivery
 * depends on name, path and expiry, not on the host the bytes travel to.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const envSet = vi.hoisted(() => {
  // The real signing key and app identity, so a refreshed access token is one `verifySession`
  // accepts and the family binding is enforced. Defaulted, never overwritten; removed afterwards.
  const set: string[] = [];
  if (!process.env.JWT_SECRET) { process.env.JWT_SECRET = "p0b-test-signing-secret-long-enough-to-be-realistic"; set.push("JWT_SECRET"); }
  if (!process.env.VITE_APP_ID) { process.env.VITE_APP_ID = "leaseos-p0b-test-app"; set.push("VITE_APP_ID"); }
  return set;
});
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import mysql from "mysql2/promise";
import { CookieJar } from "tough-cookie";
import { COOKIE_NAME, REFRESH_COOKIE_NAME, TRPC_MOUNT_PATH } from "@shared/const";
import { registerApi } from "./_core/api";
import { issueBrowserSession } from "./_core/browserSession";
import { LEGACY_REFRESH_COOKIE_PATHS, REFRESH_COOKIE_PATH } from "./_core/cookies";
import { ENV } from "./_core/env";
import { ACCESS_TOKEN_TTL_MS } from "./_core/sessionFamily";
import { createSessionFamily, revokeFamily } from "./sessionFamilyService";
import { upsertUser } from "./db";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
const ORIGIN = "https://app.leaseos.test";
const REFRESH_URL = `${TRPC_MOUNT_PATH}/auth.refresh`;
const LOGOUT_URL = `${TRPC_MOUNT_PATH}/auth.logout`;
const ME_URL = `${TRPC_MOUNT_PATH}/auth.me`;
const PRE_P0B_PATH = "/api/auth";

let server: Server; let port = 0; let pool: mysql.Pool;
let seq = 0;
const newOpenId = () => `p0b-http-${Date.now()}-${seq++}`;

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 });
  const app = express();
  // The login, minus the provider exchange: the user record and the issuing function are the
  // production ones (`_core/oauth.ts` does exactly this after `exchangeCodeForToken`).
  app.post("/test/login", async (req, res) => {
    const openId = String(req.query.openId ?? newOpenId());
    await upsertUser({ openId, name: "Dana Transport", email: null, loginMethod: "test", lastSignedIn: new Date() } as never);
    await issueBrowserSession(req, res, { openId, name: "Dana Transport" });
    res.json({ openId });
  });
  registerApi(app);
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  await pool?.end();
  for (const k of envSet) delete process.env[k];
});

type Reply = { status: number; text: string; sent: string; setCookies: string[] };

/** A browser: cookies by RFC 6265, a same-origin Origin header unless told otherwise, nothing else. */
function browser() {
  const jar = new CookieJar();
  const sameOrigin = () => `http://127.0.0.1:${port}`;
  async function go(method: "GET" | "POST", path: string, opts: { origin?: string | null; referer?: string; body?: unknown } = {}): Promise<Reply> {
    const sent = await jar.getCookieString(ORIGIN + path);
    const headers: Record<string, string> = { cookie: sent, "content-type": "application/json" };
    if (opts.origin !== null) headers.origin = opts.origin ?? sameOrigin();
    if (opts.referer) headers.referer = opts.referer;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
    });
    const setCookies = response.headers.getSetCookie();
    for (const h of setCookies) await jar.setCookie(h, ORIGIN + path);
    return { status: response.status, text: await response.text(), sent, setCookies };
  }
  const cookies = async () => (await jar.getCookies(`${ORIGIN}/`, { allPaths: true })).map(c => ({ name: c.key, path: c.path, value: c.value }));
  const refreshCookies = async () => (await cookies()).filter(c => c.name === REFRESH_COOKIE_NAME);
  /** What a pre-P0-B login left behind: a real family's credential at the old path. */
  async function holdLegacy(openId: string) {
    const f = await createSessionFamily({ openId, appId: ENV.appId || null });
    await jar.setCookie(`${REFRESH_COOKIE_NAME}=${f.familyRef}.${f.verifier}; Path=${PRE_P0B_PATH}; HttpOnly; Secure; SameSite=None; Max-Age=2592000`, `${ORIGIN}/api/oauth/callback`);
    return f;
  }
  const login = async (openId = newOpenId()) => { const r = await go("POST", `/test/login?openId=${openId}`); expect(r.status).toBe(200); return openId; };
  const me = async () => { const r = await go("GET", ME_URL); return r.text.includes('"json":null') ? null : (r.text.match(/"openId":"([^"]+)"/)?.[1] ?? null); };
  const expireAccess = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + ACCESS_TOKEN_TTL_MS + 1_000); };
  return { jar, go, cookies, refreshCookies, holdLegacy, login, me, expireAccess };
}

const familyRow = async (familyRef: string) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT * FROM sessionFamilies WHERE familyRef = ?", [familyRef]))[0][0]!;
const familyRefOf = (cookieValue: string) => cookieValue.slice(0, cookieValue.indexOf("."));

d("COOKIE-T1/T3/T8 — the issued cookie reaches the refresh request, and the refresh works", () => {
  it("logs in, outlives its access token, refreshes through the real mount and is signed in again", async () => {
    const b = browser();
    const openId = await b.login();
    const issued = await b.refreshCookies();
    expect(issued).toHaveLength(1);
    expect(issued[0]!.path).toBe(REFRESH_COOKIE_PATH);                       // COOKIE-T1
    expect(await b.me()).toBe(openId);

    b.expireAccess();
    expect(await b.me(), "the access token has expired: signed out until a refresh").toBeNull();

    const r = await b.go("POST", REFRESH_URL);
    expect(r.sent, "the browser attaches the refresh cookie to the real refresh request").toContain(`${REFRESH_COOKIE_NAME}=`);   // COOKIE-T3
    expect(r.sent, "the expired access cookie is gone from the jar").not.toContain(`${COOKIE_NAME}=`);
    expect(r.status).toBe(200);
    expect(await b.me(), "the replacement access token verifies and names the account").toBe(openId);   // COOKIE-T8

    const after = await b.refreshCookies();
    expect(after).toHaveLength(1);                                             // COOKIE-T7: no accumulation
    expect(after[0]!.path).toBe(REFRESH_COOKIE_PATH);
    expect(after[0]!.value).not.toBe(issued[0]!.value);                        // rotated
    expect(familyRefOf(after[0]!.value)).toBe(familyRefOf(issued[0]!.value));  // same family
    expect((await familyRow(familyRefOf(issued[0]!.value))).rotationCounter).toBe(1);
  }, 30_000);

  it("the refresh cookie is sent to no non-tRPC route (COOKIE-T4), and does not authenticate a tRPC call on its own", async () => {
    const b = browser();
    await b.login();
    for (const path of ["/api/oauth/callback", "/healthz", "/readyz", "/", PRE_P0B_PATH]) {
      expect(await b.jar.getCookieString(ORIGIN + path), path).not.toContain(`${REFRESH_COOKIE_NAME}=`);
    }
    // Path is delivery scoping, not authority: with the access cookie gone, the refresh cookie
    // reaches every tRPC procedure and authenticates none of them.
    b.expireAccess();
    const r = await b.go("GET", ME_URL);
    expect(r.sent).toContain(`${REFRESH_COOKIE_NAME}=`);
    expect(r.text).toContain('"json":null');
  }, 30_000);
});

d("COOKIE-T5 — logout and revoke-all clear what they issued", () => {
  it("logout removes both cookies from the browser and the refresh is dead afterwards", async () => {
    const b = browser();
    await b.login();
    const familyRef = familyRefOf((await b.refreshCookies())[0]!.value);
    const out = await b.go("POST", LOGOUT_URL);
    expect(out.status).toBe(200);
    expect(await b.cookies(), "no session or refresh cookie survives a logout at any path").toEqual([]);
    expect((await familyRow(familyRef)).revokeReason).toBe("logout");
    b.expireAccess();
    expect((await b.go("POST", REFRESH_URL)).status).toBe(401);
  }, 30_000);

  it("revoke-all removes both cookies and kills every family of the account", async () => {
    const b = browser();
    const openId = await b.login();
    const other = await createSessionFamily({ openId, appId: ENV.appId || null });
    const r = await b.go("POST", `${TRPC_MOUNT_PATH}/auth.revokeAll`);
    expect(r.status).toBe(200);
    expect(await b.cookies()).toEqual([]);
    expect((await familyRow(other.familyRef)).revokeReason).toBe("revoked_all");
  }, 30_000);
});

d("COOKIE-T6/T7 — a browser from before P0-B is migrated, not left with two cookies", () => {
  it("the legacy-path cookie is never delivered to the refresh request, so it cannot refresh", async () => {
    const b = browser();
    await b.holdLegacy(newOpenId());
    const r = await b.go("POST", REFRESH_URL);
    expect(r.sent).toBe("");                                                   // COOKIE-T2 over HTTP
    expect(r.status).toBe(401);
  }, 30_000);

  it("a login expires the legacy-path cookie while issuing the current one: exactly one refresh cookie remains", async () => {
    const b = browser();
    const legacy = await b.holdLegacy(newOpenId());
    expect(await b.refreshCookies()).toHaveLength(1);
    await b.login();
    const left = await b.refreshCookies();
    expect(left).toHaveLength(1);                                              // COOKIE-T7
    expect(left[0]!.path).toBe(REFRESH_COOKIE_PATH);
    expect(left[0]!.value).not.toContain(legacy.familyRef);
    expect(await b.jar.getCookieString(`${ORIGIN}${PRE_P0B_PATH}/x`), "no refresh cookie is left at the old path").not.toContain(`${REFRESH_COOKIE_NAME}=`);   // COOKIE-T6
    for (const p of LEGACY_REFRESH_COOKIE_PATHS) expect(await b.jar.getCookieString(`${ORIGIN}${p}/x`)).not.toContain(`${REFRESH_COOKIE_NAME}=`);
  }, 30_000);

  it("a refresh and a logout expire the legacy-path cookie too", async () => {
    const b = browser();
    await b.login();
    await b.holdLegacy(newOpenId());                 // planted after login: the stale copy returns
    expect(await b.refreshCookies()).toHaveLength(2);
    b.expireAccess();
    expect((await b.go("POST", REFRESH_URL)).status).toBe(200);
    expect((await b.refreshCookies()).map(c => c.path)).toEqual([REFRESH_COOKIE_PATH]);
    await b.holdLegacy(newOpenId());
    expect((await b.go("POST", LOGOUT_URL)).status).toBe(200);
    expect(await b.cookies()).toEqual([]);
  }, 30_000);
});

d("CSRF stays fail-closed on the real endpoint", () => {
  it("same-origin succeeds; a missing, foreign or malformed origin is refused and does not rotate the family", async () => {
    const b = browser();
    await b.login();
    const before = (await b.refreshCookies())[0]!.value;
    b.expireAccess();
    expect((await b.go("POST", REFRESH_URL, { origin: null })).status, "cookie alone, no Origin or Referer").toBe(403);
    expect((await b.go("POST", REFRESH_URL, { origin: "https://evil.example" })).status).toBe(403);
    expect((await b.go("POST", REFRESH_URL, { origin: "not a url" })).status).toBe(403);
    expect((await b.go("POST", REFRESH_URL, { origin: null, referer: "https://evil.example/x" })).status).toBe(403);
    expect((await b.refreshCookies())[0]!.value, "a refused call must not rotate the real browser's credential").toBe(before);
    expect((await b.go("POST", REFRESH_URL)).status, "the real browser still refreshes").toBe(200);
    expect((await b.refreshCookies())[0]!.value).not.toBe(before);
  }, 30_000);

  it("a cross-site revoke-all is refused as well", async () => {
    const b = browser();
    await b.login();
    expect((await b.go("POST", `${TRPC_MOUNT_PATH}/auth.revokeAll`, { origin: "https://evil.example" })).status).toBe(403);
    expect(await b.refreshCookies()).toHaveLength(1);
  }, 30_000);
});

d("appId binding, through the real endpoint", () => {
  it("a family minted for another surface, or for none, is refused; this surface's refreshes and keeps its binding", async () => {
    expect(ENV.appId, "this suite runs with an identity configured").toBeTruthy();
    const b = browser();
    const openId = await b.login();
    const mine = familyRefOf((await b.refreshCookies())[0]!.value);
    expect((await familyRow(mine)).appId).toBe(ENV.appId);

    for (const appId of ["some-other-app", null]) {
      const foreign = await createSessionFamily({ openId, appId });
      const j = browser();
      await j.jar.setCookie(`${REFRESH_COOKIE_NAME}=${foreign.familyRef}.${foreign.verifier}; Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=None`, `${ORIGIN}/`);
      const r = await j.go("POST", REFRESH_URL);
      expect(r.sent).toContain(foreign.familyRef);
      expect(r.status, `appId=${appId}`).toBe(401);
      expect((await familyRow(foreign.familyRef)).rotationCounter).toBe(0);
    }
    b.expireAccess();
    expect((await b.go("POST", REFRESH_URL)).status).toBe(200);
    expect((await familyRow(mine)).appId, "rotation preserves the binding").toBe(ENV.appId);
  }, 30_000);
});

d("SR-T12 over HTTP — a revoked family cannot be revived by possession of the cookie", () => {
  it("refuses the refresh and clears the cookie, so nothing usable stays in the browser", async () => {
    const b = browser();
    await b.login();
    const familyRef = familyRefOf((await b.refreshCookies())[0]!.value);
    await revokeFamily(familyRef, "admin");
    b.expireAccess();
    const r = await b.go("POST", REFRESH_URL);
    expect(r.status).toBe(401);
    expect(await b.refreshCookies(), "the refusal removes the dead credential from the browser").toEqual([]);
    expect(await b.me()).toBeNull();
  }, 30_000);
});
