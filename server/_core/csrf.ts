/**
 * The defence the session cookie cannot provide.
 *
 * `getSessionCookieOptions` keeps `sameSite: "none"` on purpose — embedded surfaces (Safari ITP,
 * private browsing, iOS/Android WebViews) would otherwise be signed out, and they are a supported
 * way to run LeaseOS. The consequence is that the browser will attach the session cookie to a
 * request originating from any site, so SameSite contributes nothing here and something else has
 * to.
 *
 * WHAT THE RISK ACTUALLY IS on the credential endpoints. A cross-site page cannot *read* anything:
 * the cookies are `httpOnly` and the response is opaque to it. What it can do is cause a refresh to
 * happen. That rotates the family, so the verifier the real browser holds stops working — a logout
 * primitive anyone can fire — and if it replays a stale one it trips reuse detection and kills the
 * family outright. Availability, not disclosure, and worth closing either way.
 *
 * ORIGIN, NOT A TOKEN ROUND-TRIP. These endpoints are few and a token would need every client to
 * change. The rule is narrow and it fails closed: the request must name an origin, that origin must
 * be this host, and anything unparseable or absent is refused.
 *
 * SCOPE, STATED. This guards the endpoints that mint or destroy credentials. Extending the same
 * check (or a double-submit token) to every cookie-authenticated mutation is the remaining CSRF
 * work, and it is not done here.
 */

type HeaderBag = { headers?: Record<string, string | string[] | undefined> };

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Does this request originate from the application itself?
 *
 * Compared on **host**, not on the full origin, because the proxy terminates TLS and the scheme a
 * browser reports need not match what this process sees. The host is what identifies us; matching
 * on the whole string would refuse legitimate traffic and invite a looser rule later.
 */
export function isTrustedOrigin(req: HeaderBag): boolean {
  const host = first(req.headers?.host);
  if (!host) return false;

  const stated = first(req.headers?.origin) ?? first(req.headers?.referer);
  if (!stated) return false;

  let statedHost: string;
  try {
    statedHost = new URL(stated).host;
  } catch {
    return false;
  }

  // Exact host equality. A suffix or prefix comparison would accept
  // `app.leaseos.test.evil.example` and `notapp.leaseos.test` respectively.
  return statedHost === host;
}
