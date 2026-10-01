import type { CookieOptions, Request, Response } from "express";
import { COOKIE_NAME, REFRESH_COOKIE_NAME, TRPC_MOUNT_PATH } from "@shared/const";
import { ACCESS_TOKEN_TTL_MS, REFRESH_ABSOLUTE_TTL_MS } from "./sessionFamily";

/**
 * P0-B — the refresh cookie's Path is the tRPC mount, because that is where the refresh request goes.
 *
 * It used to be `/api/auth`. The refresh procedure is `auth.refresh` on the tRPC router, which is
 * mounted at `TRPC_MOUNT_PATH`, so the browser posts to `/api/trpc/auth.refresh` — and a browser
 * attaches a cookie only to a request whose path matches the cookie's Path (RFC 6265 §5.1.4). No
 * request ever went to `/api/auth`, so the refresh credential was issued and never sent, and every
 * browser session ended with its first access token. `sessionCookieTransport.http.db.test.ts`
 * reproduces that through the real mount with a real cookie jar.
 *
 * WHY NOT NARROWER. Path matching is prefix-by-segment: `/api/trpc/auth` would match
 * `/api/trpc/auth/x` but not `/api/trpc/auth.refresh`, because the character after the prefix is a
 * dot, not a slash. tRPC names procedures `auth.refresh`, so the narrowest Path that reaches the
 * credential procedures is the mount itself. `sessionCookiePathMatch.test.ts` pins both halves.
 *
 * WHY NOT `/`. The access token rides on every request by design; the refresh credential has no
 * business doing so. Scoped to the mount it never reaches `/api/oauth/callback`, the health probes,
 * the static bundle or any future non-tRPC route, so a leak in one of those routes' logging or
 * proxying cannot pick it up. Path is delivery scoping and nothing more: possession, origin and
 * family state are still proved server-side on every redemption (`auth.refresh`).
 */
export const REFRESH_COOKIE_PATH: string = TRPC_MOUNT_PATH;

/**
 * Paths the refresh cookie was issued under before P0-B. A browser that logged in before this
 * change holds `app_refresh_id; Path=/api/auth`. Every issue and every clearing of the current
 * cookie also expires the cookie at each of these paths, so a browser never holds two refresh
 * cookies under one name. Bounded: one absolute family lifetime (thirty days) after P0-B is
 * deployed, every such cookie has expired on its own and this list can be emptied.
 */
export const LEGACY_REFRESH_COOKIE_PATHS: readonly string[] = ["/api/auth"];

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

/*
 * The four operations below are the only place the session cookies are written. Login, refresh and
 * logout all go through them, so the attributes a cookie is issued with and the attributes it is
 * cleared with cannot drift apart — a deletion only removes a cookie whose name, domain and path
 * all match (RFC 6265 §5.3 step 11), so a clearing that names a different path leaves the browser
 * holding a live credential. `sessionCookieRouteGuard.test.ts` refuses any other writer.
 */

/** The access credential, for one access lifetime, site-wide. */
export function issueAccessCookie(req: Request, res: Response, accessToken: string): void {
  res.cookie(COOKIE_NAME, accessToken, { ...getSessionCookieOptions(req), maxAge: ACCESS_TOKEN_TTL_MS });
}

/** The refresh credential at its path, and the pre-P0-B copy expired alongside it. */
export function issueRefreshCookie(
  req: Request,
  res: Response,
  credential: { familyRef: string; verifier: string },
): void {
  res.cookie(REFRESH_COOKIE_NAME, `${credential.familyRef}.${credential.verifier}`, {
    ...getSessionCookieOptions(req, { refresh: true }),
    maxAge: REFRESH_ABSOLUTE_TTL_MS,
  });
  expireLegacyRefreshCookies(req, res);
}

export function clearAccessCookie(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, getSessionCookieOptions(req));
}

/** Expire the refresh cookie at its path and at every path it was ever issued under. */
export function clearRefreshCookie(req: Request, res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, getSessionCookieOptions(req, { refresh: true }));
  expireLegacyRefreshCookies(req, res);
}

function expireLegacyRefreshCookies(req: Request, res: Response): void {
  for (const path of LEGACY_REFRESH_COOKIE_PATHS) {
    res.clearCookie(REFRESH_COOKIE_NAME, { ...getSessionCookieOptions(req, { refresh: true }), path });
  }
}
