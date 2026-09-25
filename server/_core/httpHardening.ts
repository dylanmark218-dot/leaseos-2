/**
 * The HTTP edge: what every request meets before tRPC or OAuth sees it.
 *
 * Before this, `index.ts` mounted a 50 MB JSON parser and the routers, and
 * nothing else — no security headers, no cross-site request defence, no rate
 * limit, no health signal a load balancer could use. Each piece below is small
 * on purpose and says what it does not do.
 *
 * Deliberately NOT here, and why:
 *
 * - **No framing ban by default.** The app is served inside an iframe in
 *   preview (that is why the session cookie is `SameSite=None`, and why
 *   `main.tsx` has a Bearer fallback for iframe-blocked cookies). A blanket
 *   `X-Frame-Options: DENY` would break sign-in there. Set
 *   `LEASEOS_FRAME_ANCESTORS` to the embedding origins (or `'none'`) to send a
 *   `frame-ancestors` policy.
 * - **No Content-Security-Policy yet.** The client loads Google Maps and a
 *   host runtime plugin; a CSP written without auditing those would either be
 *   so loose it proves nothing or break the map. It is a tracked follow-up.
 * - **The rate limiter is per process.** Behind N instances the effective
 *   limit is N×. It is a floor against a single noisy client, not a
 *   substitute for limits at the proxy/WAF.
 */
import type { Express, NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Security headers

export function securityHeaders(opts: { hsts: boolean; frameAncestors?: string | null }) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Field capture needs the camera, microphone (voice notes) and location on
    // our own origin; nothing else gets them.
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), serial=(), bluetooth=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (opts.frameAncestors) res.setHeader("Content-Security-Policy", `frame-ancestors ${opts.frameAncestors}`);
    // Only over a connection that is actually https: HSTS on plain http is
    // ignored by browsers, and on a misdetected scheme it is a lock-out.
    if (opts.hsts && req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  };
}

// ---------------------------------------------------------------------------
// Cross-site request defence for cookie-authenticated API calls

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The session cookie is `SameSite=None`, so a browser attaches it to requests
 * any other site triggers. The defence that does not depend on proxy headers:
 * a state-changing API call must be `application/json`. A cross-site page
 * cannot send that content type without a CORS preflight, and this server
 * answers no preflight, so the request never leaves the attacker's browser.
 * The three content types a form or `fetch` can send without a preflight —
 * `text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded` —
 * are refused here, before any procedure runs.
 *
 * When `LEASEOS_ALLOWED_ORIGINS` is set, a request that carries an `Origin`
 * must also match it. That second check is opt-in because behind a proxy that
 * rewrites `Host`, the server cannot work out its own public origin unaided,
 * and a wrong guess would refuse every mutation.
 */
export function crossSiteGuard(opts: { allowedOrigins: string[] | null }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json") {
      res.status(415).json({ error: "State-changing API requests must be sent as application/json" });
      return;
    }
    const origin = req.headers.origin;
    if (opts.allowedOrigins && origin !== undefined && !opts.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  };
}

export function allowedOriginsFromEnv(env: Record<string, string | undefined>): string[] | null {
  const raw = env.LEASEOS_ALLOWED_ORIGINS?.trim();
  if (!raw) return null;
  return raw.split(",").map(o => o.trim().replace(/\/$/, "")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rate limiting

/**
 * Fixed-window counter keyed by client address. `req.ip` is only the real
 * client when `trust proxy` is configured (see `LEASEOS_TRUST_PROXY`); without
 * it, every client behind a proxy shares the proxy's address, which is why the
 * default limit is generous.
 */
export function rateLimit(opts: { windowMs: number; max: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  let windowStart = now();
  let counts = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    if (t - windowStart >= opts.windowMs) {
      windowStart = t;
      counts = new Map(); // drop the old window whole; the map cannot grow without bound
    }
    const key = req.ip ?? "unknown";
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((windowStart + opts.windowMs - t) / 1000)));
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Trusted proxies

/**
 * Express trusts no forwarding headers by default, so `req.ip`, `req.secure`
 * and `req.protocol` describe the proxy rather than the client. Set
 * `LEASEOS_TRUST_PROXY` to what Express accepts: a hop count (`1`), or
 * addresses/subnets (`loopback, 10.0.0.0/8`). `true` is accepted but trusts
 * any client that sets the header, so use it only when the app cannot be
 * reached except through the proxy.
 */
export function trustProxySetting(env: Record<string, string | undefined>): boolean | number | string | null {
  const raw = env.LEASEOS_TRUST_PROXY?.trim();
  if (!raw) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// Health routes are main's `server/_core/health.ts` (/healthz, /readyz). This module's own
// /health/live and /health/ready, with a database ping, were dropped on merging main: main's
// readiness deliberately consults no dependency (see health.ts).
