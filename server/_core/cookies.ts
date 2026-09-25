import type { CookieOptions, Request } from "express";

/**
 * The refresh credential is scoped to the auth path, not the whole site.
 *
 * The access token rides on every request by design; the refresh credential has no business doing
 * so. Narrowing the path means a leak in some other route's logging, proxying or error reporting
 * cannot pick it up, because the browser never sends it there.
 */
export const REFRESH_COOKIE_PATH = "/api/auth";

/**
 * S1-E — cookie policy.
 *
 * `secure` used to be computed per request from `req.protocol` and `x-forwarded-proto`. A proxy
 * that failed to set that header silently downgraded the session cookie to one that would travel in
 * clear text. That is not a per-request decision worth making: LeaseOS is served over https, and a
 * cookie that would only be safe when a header happens to be right is not safe.
 *
 * `sameSite: "none"` is kept **deliberately**. `client/src/main.tsx` sends `credentials: "include"`
 * and mirrors the session for embedded surfaces — Safari ITP, private browsing, iOS/Android
 * WebViews — where iframe cookies are blocked; `lax` would log every one of those out. The
 * consequence is stated rather than glossed: **the cookie layer contributes nothing against CSRF
 * here**, so CSRF is defended separately. Tightening SameSite later would not make that defence
 * unnecessary, and `sessionCookiePolicy.test.ts` pins the claim so the trade stays visible.
 */
export function getSessionCookieOptions(
  _req: Request,
  options: { refresh?: boolean } = {},
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  return {
    httpOnly: true,
    path: options.refresh ? REFRESH_COOKIE_PATH : "/",
    sameSite: "none",
    secure: true,
  };
}
