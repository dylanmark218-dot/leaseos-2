/**
 * P0-B — does the browser deliver the refresh cookie to the request that redeems it?
 *
 * Answered with a cookie jar that implements RFC 6265 (tough-cookie, the jar jsdom uses), not by
 * comparing two constants: a cookie is attached to a request only when the cookie's Path
 * path-matches the request path (§5.1.4), and the match is prefix-by-segment — `/api/auth` does
 * not match `/api/trpc/auth.refresh`, and neither does `/api/trpc/auth`, because the character
 * after that prefix is a dot. The pre-P0-B path is kept here as the thing that must stay broken
 * (COOKIE-T2), and the chosen path is proved to be the narrowest that works (COOKIE-T3, T4).
 */
import { describe, expect, it } from "vitest";
import { CookieJar } from "tough-cookie";
import { REFRESH_COOKIE_NAME, TRPC_MOUNT_PATH } from "@shared/const";
import { LEGACY_REFRESH_COOKIE_PATHS, REFRESH_COOKIE_PATH } from "./_core/cookies";

const ORIGIN = "https://app.leaseos.test";
const CREDENTIAL_PROCEDURES = ["auth.refresh", "auth.logout", "auth.revokeAll"] as const;
const PRE_P0B_PATH = "/api/auth";

/** Would a browser holding the refresh cookie issued for `cookiePath` send it to `requestPath`? */
async function delivered(cookiePath: string, requestPath: string): Promise<boolean> {
  const jar = new CookieJar();
  await jar.setCookie(`${REFRESH_COOKIE_NAME}=SF-x.verifier; Path=${cookiePath}; HttpOnly; Secure; SameSite=None; Max-Age=2592000`, `${ORIGIN}/api/oauth/callback`);
  return (await jar.getCookieString(`${ORIGIN}${requestPath}`)).includes(`${REFRESH_COOKIE_NAME}=`);
}

describe("COOKIE-T2 — the pre-P0-B cookie never reached the refresh request", () => {
  it.each(CREDENTIAL_PROCEDURES)("Path=/api/auth is not delivered to %s", async proc => {
    expect(await delivered(PRE_P0B_PATH, `${TRPC_MOUNT_PATH}/${proc}`)).toBe(false);
  });
  it("is delivered only to a path nothing is mounted at", async () => {
    expect(await delivered(PRE_P0B_PATH, "/api/auth")).toBe(true);
    expect(await delivered(PRE_P0B_PATH, "/api/auth/refresh")).toBe(true);
  });
});

describe("COOKIE-T3 — the issued cookie reaches every credential procedure", () => {
  it("is scoped to the tRPC mount, the only place a request can redeem it", () => {
    expect(REFRESH_COOKIE_PATH).toBe(TRPC_MOUNT_PATH);
    expect(REFRESH_COOKIE_PATH).not.toBe(PRE_P0B_PATH);
  });
  it.each(CREDENTIAL_PROCEDURES)("is delivered to %s", async proc => {
    expect(await delivered(REFRESH_COOKIE_PATH, `${TRPC_MOUNT_PATH}/${proc}`)).toBe(true);
  });
  it("is delivered to the batched form the tRPC client uses", async () => {
    expect(await delivered(REFRESH_COOKIE_PATH, `${TRPC_MOUNT_PATH}/auth.logout?batch=1`)).toBe(true);
  });
  it("no narrower path can reach a dotted procedure name — the mount is the floor", async () => {
    expect(await delivered(`${TRPC_MOUNT_PATH}/auth`, `${TRPC_MOUNT_PATH}/auth.refresh`)).toBe(false);
    expect(await delivered(`${TRPC_MOUNT_PATH}/auth.`, `${TRPC_MOUNT_PATH}/auth.refresh`)).toBe(false);
    expect(await delivered(`${TRPC_MOUNT_PATH}/auth.refresh`, `${TRPC_MOUNT_PATH}/auth.refresh`)).toBe(true);
    expect(await delivered(`${TRPC_MOUNT_PATH}/auth.refresh`, `${TRPC_MOUNT_PATH}/auth.logout`)).toBe(false);
  });
});

describe("COOKIE-T4 — and nowhere else", () => {
  it.each(["/", "/api/oauth/callback", "/healthz", "/readyz", "/assets/index.js", "/api/auth", `${TRPC_MOUNT_PATH}x/auth.refresh`, "/api"])(
    "is not delivered to %s", async requestPath => {
      expect(await delivered(REFRESH_COOKIE_PATH, requestPath)).toBe(false);
    });
  it("is not site-wide", () => {
    expect(REFRESH_COOKIE_PATH).not.toBe("/");
  });
});

describe("legacy paths — expired, and never ambiguous with the live cookie", () => {
  it("names exactly the pre-P0-B path", () => {
    expect([...LEGACY_REFRESH_COOKIE_PATHS]).toEqual([PRE_P0B_PATH]);
  });
  it.each(CREDENTIAL_PROCEDURES)("no legacy-path cookie can accompany the live one to %s", async proc => {
    for (const legacy of LEGACY_REFRESH_COOKIE_PATHS) {
      expect(await delivered(legacy, `${TRPC_MOUNT_PATH}/${proc}`)).toBe(false);
    }
  });
  it("a browser holding both sends one, and it is the live one", async () => {
    const jar = new CookieJar();
    await jar.setCookie(`${REFRESH_COOKIE_NAME}=SF-old.v; Path=${PRE_P0B_PATH}; HttpOnly; Secure; SameSite=None; Max-Age=2592000`, `${ORIGIN}/api/oauth/callback`);
    await jar.setCookie(`${REFRESH_COOKIE_NAME}=SF-new.v; Path=${REFRESH_COOKIE_PATH}; HttpOnly; Secure; SameSite=None; Max-Age=2592000`, `${ORIGIN}/api/oauth/callback`);
    expect(await jar.getCookieString(`${ORIGIN}${TRPC_MOUNT_PATH}/auth.refresh`)).toBe(`${REFRESH_COOKIE_NAME}=SF-new.v`);
    // and the deletion the server sends for the legacy path removes exactly that one
    await jar.setCookie(`${REFRESH_COOKIE_NAME}=; Path=${PRE_P0B_PATH}; HttpOnly; Secure; SameSite=None; Expires=Thu, 01 Jan 1970 00:00:00 GMT`, `${ORIGIN}${TRPC_MOUNT_PATH}/auth.refresh`);
    const left = await jar.getCookies(`${ORIGIN}/`, { allPaths: true });
    expect(left.map(c => [c.key, c.path])).toEqual([[REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH]]);
  });
});
