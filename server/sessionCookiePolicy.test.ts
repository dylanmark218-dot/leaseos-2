/**
 * S1-E — the cookie, and the thing the cookie cannot do.
 *
 * `secure` was computed per request from the protocol and the `x-forwarded-proto` header. A
 * misconfigured proxy that fails to set that header therefore downgraded the session cookie to one
 * that would travel in clear text, silently. The flag is not worth deciding per request.
 *
 * `sameSite: "none"` stays, and that is deliberate rather than an oversight: `client/src/main.tsx`
 * sends `credentials: "include"` and mirrors the session for embedded contexts — Safari ITP,
 * private browsing, iOS/Android WebViews — where iframe cookies are blocked. Setting `lax` would
 * log those contexts out. What follows from that is stated here rather than hoped: **the cookie
 * layer contributes nothing against CSRF**, so CSRF is solved separately and this file pins the
 * claim so nobody later "hardens" SameSite and believes the problem is handled.
 */
import { describe, expect, it } from "vitest";
import { TRPC_MOUNT_PATH } from "@shared/const";
import { getSessionCookieOptions, REFRESH_COOKIE_PATH } from "./_core/cookies";

const req = (o: Record<string, unknown> = {}) =>
  ({ protocol: "http", headers: {}, ...o }) as never;

describe("E1 — Secure is not a per-request decision", () => {
  it("is set even when the request arrived over plain http", () => {
    expect(getSessionCookieOptions(req()).secure).toBe(true);
  });

  it("is set when a proxy forgot x-forwarded-proto", () => {
    expect(getSessionCookieOptions(req({ headers: {} })).secure).toBe(true);
  });

  it("is set over https, obviously", () => {
    expect(getSessionCookieOptions(req({ protocol: "https" })).secure).toBe(true);
  });
});

describe("E1b — the rest of the session cookie", () => {
  it("stays httpOnly, so page script cannot read it", () => {
    expect(getSessionCookieOptions(req()).httpOnly).toBe(true);
  });

  /*
   * Kept on purpose. Embedded contexts are a supported surface; `lax` would break them. The cost is
   * recorded in this file's header and paid for by a separate CSRF defence.
   */
  it("keeps sameSite none, because embedded surfaces are supported", () => {
    expect(getSessionCookieOptions(req()).sameSite).toBe("none");
  });
});

describe("E2 — the refresh cookie is not sent on every request", () => {
  /*
   * The access token rides on every call; the refresh credential should not. A narrow path means a
   * leak in any other route's logging or proxying cannot pick it up.
   *
   * P0-B — narrow, but not narrower than the request that redeems it. The path used to be
   * `/api/auth`, which no request ever went to; the browser never sent the cookie and every
   * session ended with its first access token. The path is the tRPC mount, the floor for a dotted
   * procedure name (`sessionCookiePathMatch.test.ts`), and it is derived from the mount constant
   * rather than spelled again here.
   */
  it("is scoped to the tRPC mount, not the whole site and not a path nothing is mounted at", () => {
    expect(REFRESH_COOKIE_PATH).toBe(TRPC_MOUNT_PATH);
    expect(REFRESH_COOKIE_PATH).not.toBe("/");
    expect(REFRESH_COOKIE_PATH).not.toBe("/api/auth");
    expect(getSessionCookieOptions(req(), { refresh: true }).path).toBe(TRPC_MOUNT_PATH);
  });

  it("the access cookie stays site-wide", () => {
    expect(getSessionCookieOptions(req()).path).toBe("/");
  });

  it("the refresh cookie is also Secure and httpOnly", () => {
    const o = getSessionCookieOptions(req(), { refresh: true });
    expect(o.secure).toBe(true);
    expect(o.httpOnly).toBe(true);
  });
});
