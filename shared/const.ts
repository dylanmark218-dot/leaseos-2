export const COOKIE_NAME = "app_session_id";
/**
 * The refresh credential's cookie. Separate from the access cookie because the two have different
 * lifetimes and different paths: the access token rides on every request, the refresh credential is
 * scoped to `/api/auth` so no other route ever sees it.
 *
 * Its value is `familyRef.verifier` — the reference names the row, the verifier proves possession,
 * and only the verifier's hash is stored server-side.
 */
export const REFRESH_COOKIE_NAME = "app_refresh_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
/**
 * When S1 session hardening took effect. Pre-cutover tokens are honoured for `LEGACY_GRACE_MS`
 * after this instant and refused afterwards, so the year-long sessions have an end date rather
 * than an expiry date. Move this only when re-running the transition deliberately.
 */
export const LEGACY_CUTOVER_AT = new Date("2026-09-24T00:00:00Z");

export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

// One-time nonce cookie that binds an OAuth login to the browser that started
// it. The `__Host-` prefix forces the cookie host-only (Secure, Path=/, no
// Domain), so a sibling *.manus.space site cannot plant a matching value in a
// victim's browser.
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";

// `state` carries the callback redirect URI (used at token exchange), the CSRF
// nonce, and — v23.26 — where inside LeaseOS the person was trying to go before
// they were sent to sign in. Defined here so the client encoder and server
// decoder never drift.
//
// `next` is attacker-influenceable, like every other field of `state`, and is
// treated that way: the callback runs it through `safeRedirectPath` before it
// reaches a `Location` header, so the worst a forged value achieves is landing
// the person on a path of this same origin. It is never used for anything but
// the redirect.
export type OAuthState = { redirectUri: string; nonce?: string; next?: string };

export const encodeOAuthState = (state: OAuthState): string =>
  btoa(JSON.stringify(state));

export const decodeOAuthState = (state: string): OAuthState => {
  let decoded: string;
  try {
    decoded = atob(state);
  } catch {
    // Malformed base64 (e.g. attacker-supplied garbage). Return no nonce so the
    // callback's CSRF guard rejects it with 403 — never throw, since the caller
    // runs outside the request handler's try/catch.
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
    // Legacy links: `state` was a bare base64(redirectUri) with no nonce.
  }
  return { redirectUri: decoded };
};
