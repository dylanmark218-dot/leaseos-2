import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";
import { isSafeRedirectPath } from "@shared/_core/redirect";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Start the Manus OAuth login. Call this from an event handler or effect at the
// moment you want to navigate, e.g. `onClick={() => startLogin()}`.
//
// It has SIDE EFFECTS — it mints a one-time nonce, writes the __Host- state
// cookie, and navigates immediately — so the cookie nonce always matches the
// `state` it sends. Do NOT call it during render (no `href={startLogin()}` /
// `loginUrl={...}`): each call overwrites the cookie, so a stray render-phase
// call would desync it from an in-flight login and the callback would reject it
// with "invalid oauth state". It returns void by design, so there is no URL to
// stash across renders.
//
// v23.26 — `next` is where inside LeaseOS to return afterwards. It rides in
// `state`, so it survives the round trip through the provider with no extra
// cookie, and the callback runs it through `safeRedirectPath` before it reaches
// a `Location` header. It is filtered here too, so an obviously external value
// never leaves the browser — but the server's check is the one that counts,
// because this one runs on the attacker's side of the fence.
export const startLogin = (next?: string) => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  const nonce = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=None; Secure`;
  const state = encodeOAuthState({
    redirectUri,
    nonce,
    ...(isSafeRedirectPath(next) ? { next } : {}),
  });

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  window.location.href = url.toString();
};
