/**
 * Collectors: the contract every future fetcher implements, and the one
 * decision each of them must ask before touching the network.
 *
 No network of its own: every collector is handed `fetch`, a clock and an
 * identity, so each one is tested against recorded responses. Checkpoint 1
 * fixed the shape — what a collector is handed, what it must return, what it
 * must refuse. Checkpoint 2 built the two the seed sources need, `HtmlCrawler`
 * and `PdfCollector`, as one careful HTTP GET; every other kind still refuses.
 *
 * The standing constraints, enforced by `decideFetch` rather than trusted to
 * each collector:
 *
 *   - robots.txt is honoured as RFC 9309 specifies, and an unreachable one
 *     means "disallow everything", not "no rules";
 *   - the crawler identifies itself, and will not run without a contact;
 *   - per-source delay and concurrency limits;
 *   - no authentication, paywall or CAPTCHA is ever bypassed: a source marked
 *     access-controlled is never fetched, and a 401/402/403/407 stops the
 *     collector rather than prompting a retry;
 *   - a source with no licence assessment is not fetched at all — the same rule
 *     `repository.quarantineDocument` applies on the way in, applied on the way
 *     out, so an unassessed fetch never happens rather than being discarded.
 *
 * Every ambiguity refuses. A crawler that guesses is a crawler that ends up in
 * somebody's logs.
 */

import { sha256Hex, validateSourceUrl, type UrlRefusal } from "./provenance";

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

/** The format a source publishes in. Stored on the source row. */
export const SOURCE_KINDS = ["api", "html", "pdf", "xml", "json", "csv", "geojson", "warc", "rss", "sitemap"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const COLLECTOR_KINDS = ["api", "html", "pdf", "browser", "geodata", "sitemap", "rss", "common_crawl"] as const;
export type CollectorKind = (typeof COLLECTOR_KINDS)[number];

export type CollectorDescriptor = {
  name: string;
  accepts: readonly SourceKind[];
  /** True for html and pdf since Checkpoint 2; every other kind refuses. */
  implemented: boolean;
  note: string;
};

export const COLLECTORS: Readonly<Record<CollectorKind, CollectorDescriptor>> = {
  api: { name: "ApiIngestor", accepts: ["api", "json", "xml"], implemented: false,
    note: "structured feeds (511, open-data APIs); obeys the source's published quota — see feedCollector.planFeedFetch, which already enforces it for feeds" },
  html: { name: "HtmlCrawler", accepts: ["html"], implemented: true, note: "server-rendered pages; text extracted by extraction.extractHtml" },
  pdf: { name: "PdfCollector", accepts: ["pdf"], implemented: true,
    note: "regulations, directives, manuals; collected and hashed, so changes are detected. Text extraction needs a PDF parser, which is a dependency decision not yet taken — extraction stays pending" },
  browser: { name: "BrowserCrawler", accepts: ["html"], implemented: false,
    note: "pages that only render with JavaScript; never used to get past a login, challenge or consent wall" },
  geodata: { name: "GeoDataIngestor", accepts: ["geojson", "csv", "json"], implemented: false,
    note: "facility and road datasets; the spatial importers in scripts/ remain the path for bulk road graphs" },
  sitemap: { name: "SitemapCrawler", accepts: ["sitemap", "xml"], implemented: false,
    note: "discovery only: a sitemap proposes URLs, each is then decided on its own" },
  rss: { name: "RssWatcher", accepts: ["rss", "xml"], implemented: false, note: "change notices from regulators" },
  common_crawl: { name: "CommonCrawlImporter", accepts: ["warc"], implemented: false,
    note: "discovery and history only. A WARC record is a third party's copy of the publisher's page: the publisher's licence still governs, and provenance must name both" },
};

/* ------------------------------------------------------------------ */
/* The collector contract                                              */
/* ------------------------------------------------------------------ */

export type CollectRequest = {
  sourceId: string; documentRef: string; url: string;
  /** From the source's crawl policy. A larger body is not retained. */
  maxBytes: number;
  ifNoneMatch?: string | null; ifModifiedSince?: string | null;
};

export type CollectResult = {
  url: string;
  /** Null when no response was received at all. */
  httpStatus: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  body?: Uint8Array;
  /** What the collector computed; `provenance.classifyRetrieval` recomputes and compares. */
  declaredSha256: string | null;
  collectorKind: CollectorKind;
  collectorVersion: string;
  /** Why a response was not retained, when it was not: a redirect, a wrong content type, an oversize body. */
  note?: string;
};

/** Everything that touches the outside world is handed in, so a test can stand in for all of it. */
export type CollectorEnvironment = {
  /**
   * Called with `redirect: "manual"`, always. A redirect is how a crawl leaves its source's
   * domain without anyone deciding it should, so collectors report it instead of following it.
   */
  fetch: (url: string, init: { headers: Record<string, string>; redirect: "manual" }) => Promise<{
    status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  now: () => Date;
  identity: CrawlerIdentity;
};

export interface Collector {
  readonly kind: CollectorKind;
  readonly version: string;
  /** Called only after `decideFetch` allowed this URL. */
  collect(req: CollectRequest, env: CollectorEnvironment): Promise<CollectResult>;
}

export class CollectorNotImplemented extends Error {
  constructor(kind: CollectorKind) {
    super(`${COLLECTORS[kind].name} is declared but not implemented; nothing is fetched in Checkpoint 1`);
    this.name = "CollectorNotImplemented";
  }
}

/** The content types each HTTP collector accepts. Anything else is not what the source said it publishes. */
const ACCEPTS_CONTENT: Partial<Record<CollectorKind, { accept: string; types: readonly string[] }>> = {
  html: { accept: "text/html,application/xhtml+xml;q=0.9", types: ["text/html", "application/xhtml+xml"] },
  pdf: { accept: "application/pdf", types: ["application/pdf"] },
};

export const HTTP_COLLECTOR_VERSION = "http-1";

/**
 * One plain HTTP GET, done carefully. `HtmlCrawler` and `PdfCollector` are this with a
 * different content type; nothing about fetching a PDF differs from fetching a page.
 *
 * Called only after `decideFetch` allowed the URL. It still refuses, by not retaining a body:
 *
 *   - a redirect (reported with its target, never followed);
 *   - an access-control or back-off answer (`accessSignal`);
 *   - a content type the collector does not handle — a login page served as `text/html`
 *     where a PDF was expected is exactly the soft paywall this catches;
 *   - a body over the source's byte ceiling, judged from Content-Length first and the
 *     bytes second, so a lying header cannot get past it.
 *
 * A network failure is a result (`httpStatus: null`), not a throw: it becomes an
 * `unavailable` snapshot, which is the audit record that the source was tried.
 */
function httpCollector(kind: CollectorKind): Collector {
  const spec = ACCEPTS_CONTENT[kind]!;
  return {
    kind, version: HTTP_COLLECTOR_VERSION,
    async collect(req, env) {
      const base = { url: req.url, collectorKind: kind, collectorVersion: HTTP_COLLECTOR_VERSION, declaredSha256: null };
      const headers: Record<string, string> = { "User-Agent": env.identity.userAgent, Accept: spec.accept };
      if (req.ifNoneMatch) headers["If-None-Match"] = req.ifNoneMatch;
      if (req.ifModifiedSince) headers["If-Modified-Since"] = req.ifModifiedSince;

      let res: Awaited<ReturnType<CollectorEnvironment["fetch"]>>;
      try {
        res = await env.fetch(req.url, { headers, redirect: "manual" });
      } catch (e) {
        return { ...base, httpStatus: null, contentType: null, etag: null, lastModified: null,
          note: `network failure: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
      }
      const meta = {
        ...base, httpStatus: res.status,
        contentType: res.headers.get("content-type"), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"),
      };
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        return { ...meta, note: `redirect to ${res.headers.get("location") ?? "(no location)"} not followed; if it is the publisher, update the source` };
      }
      const signal = accessSignal(res.status);
      if (signal !== "ok" || res.status === 304) return { ...meta, ...(signal !== "ok" ? { note: signal } : {}) };

      const type = (meta.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!spec.types.includes(type)) {
        return { ...meta, note: `content type "${type || "(none)"}" is not ${spec.types.join(" or ")}; not retained` };
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > req.maxBytes) {
        return { ...meta, note: `Content-Length ${declared} exceeds the ${req.maxBytes}-byte ceiling; not downloaded` };
      }
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > req.maxBytes) {
        return { ...meta, note: `body of ${body.byteLength} bytes exceeds the ${req.maxBytes}-byte ceiling; not retained` };
      }
      return { ...meta, body, declaredSha256: sha256Hex(body) };
    },
  };
}

/** The collector for a kind. HTML and PDF are built; every other kind refuses until it is built and reviewed. */
export function collectorFor(kind: CollectorKind): Collector {
  if (ACCEPTS_CONTENT[kind]) return httpCollector(kind);
  return {
    kind, version: "0",
    collect: async () => { throw new CollectorNotImplemented(kind); },
  };
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** The product token robots.txt groups are matched against. */
export const CRAWLER_TOKEN = "LeaseOSIntelligenceBot";
export const CRAWLER_VERSION = "0.1";

export type CrawlerIdentity = { token: string; userAgent: string; contact: string };

/**
 * The User-Agent every request carries.
 *
 * Requires a contact URL. A publisher who sees the crawler in their logs should
 * be able to reach a person; a crawler that cannot say who runs it does not run.
 */
export function crawlerIdentity(contactUrl: string | null | undefined): CrawlerIdentity | null {
  if (!contactUrl) return null;
  try {
    const u = new URL(contactUrl);
    if (u.protocol !== "https:" && u.protocol !== "mailto:") return null;
  } catch { return null; }
  return { token: CRAWLER_TOKEN, contact: contactUrl, userAgent: `${CRAWLER_TOKEN}/${CRAWLER_VERSION} (+${contactUrl})` };
}

/* ------------------------------------------------------------------ */
/* robots.txt (RFC 9309)                                               */
/* ------------------------------------------------------------------ */

type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
export type RobotsFile = { groups: readonly RobotsGroup[] };

/**
 * Parse robots.txt into groups.
 *
 * Consecutive `user-agent` lines open one group; rules attach to the group
 * above them. Unknown directives (`crawl-delay`, `sitemap`) are ignored, as the
 * RFC allows. Lines are limited to what the RFC's 500 KiB parse minimum covers.
 */
export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, 500 * 1024).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), value = m[2]!.trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value === "") continue;   // an empty rule matches nothing
      current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return { groups };
}

/**
 * One spelling for a path, so a rule and a URL that mean the same octets compare equal
 * (RFC 9309 §2.2.2). Non-ASCII is UTF-8 percent-encoded, an encoded unreserved character is
 * decoded (`%7E` is `~`), and every other escape is upper-cased (`%2f` is `%2F`). An escape
 * that is not two hex digits is left alone rather than guessed at.
 */
export function normalizeRobotsPath(p: string): string {
  let out = "";
  for (const ch of p) out += ch.charCodeAt(0) > 0x7e || ch === " " ? encodeURIComponent(ch) : ch;
  return out.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${hex.toUpperCase()}`;
  });
}

const patternMatches = (rawPattern: string, rawPath: string): boolean => {
  const pattern = normalizeRobotsPath(rawPattern), path = normalizeRobotsPath(rawPath);
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
};

/**
 * May `token` fetch `pathAndQuery`?
 *
 * Group choice: every group naming the token (case-insensitive) is merged; if
 * none does, the `*` group applies; if there is no `*` group either, nothing is
 * restricted. Rule choice: the longest matching pattern wins, and `allow` wins
 * a tie. `/robots.txt` itself is always fetchable.
 */
export function robotsAllows(robots: RobotsFile, token: string, pathAndQuery: string): boolean {
  if (pathAndQuery === "/robots.txt") return true;
  const t = token.toLowerCase();
  let groups = robots.groups.filter((g) => g.agents.includes(t));
  if (groups.length === 0) groups = robots.groups.filter((g) => g.agents.includes("*"));
  let best: RobotsRule | null = null;
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * What robots.txt said when it was last fetched.
 *
 * RFC 9309 §2.3.1: a 4xx means there are no restrictions; a 5xx or no answer
 * means the crawler must assume complete disallow. `unchecked` is ours, and it
 * refuses — not having looked is not the same as having been told yes.
 */
export type RobotsState =
  | { status: "unchecked" }
  | { status: "fetched"; fetchedAt: Date; file: RobotsFile }
  | { status: "absent"; fetchedAt: Date }         // 4xx
  | { status: "unreachable"; fetchedAt: Date };   // 5xx or network failure

/** RFC 9309 §2.4: a cached robots.txt should not be used for more than 24 hours. */
export const ROBOTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch and read a host's robots.txt, as RFC 9309 says to.
 *
 * 2xx is parsed; 4xx means no restrictions (`absent`); 5xx, no answer, or anything
 * unexpected means `unreachable`, which `decideFetch` treats as disallow-all. Redirects
 * are followed up to five times (§2.3.1.2) but only to https hosts the source itself
 * declares — a robots.txt that redirects somewhere else is not this publisher's, and is
 * treated as unreachable rather than obeyed or ignored.
 */
export async function fetchRobots(
  host: string, domains: readonly string[], env: Pick<CollectorEnvironment, "fetch" | "now" | "identity">,
): Promise<RobotsState> {
  let url = `https://${host}/robots.txt`;
  for (let hop = 0; hop <= 5; hop++) {
    const target = validateSourceUrl(url, domains);
    if (!target.ok) return { status: "unreachable", fetchedAt: env.now() };
    let res: Awaited<ReturnType<CollectorEnvironment["fetch"]>>;
    try {
      res = await env.fetch(target.url, { headers: { "User-Agent": env.identity.userAgent, Accept: "text/plain" }, redirect: "manual" });
    } catch {
      return { status: "unreachable", fetchedAt: env.now() };
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) return { status: "unreachable", fetchedAt: env.now() };
      url = new URL(next, target.url).toString();
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      const text = new TextDecoder("utf-8").decode(await res.arrayBuffer());
      return { status: "fetched", fetchedAt: env.now(), file: parseRobots(text) };
    }
    if (res.status >= 400 && res.status < 500) return { status: "absent", fetchedAt: env.now() };
    return { status: "unreachable", fetchedAt: env.now() };
  }
  return { status: "unreachable", fetchedAt: env.now() };
}

/* ------------------------------------------------------------------ */
/* The fetch decision                                                  */
/* ------------------------------------------------------------------ */

export type CrawlPolicy = {
  /** Minimum gap between two requests to one source. */
  minDelayMs: number;
  maxConcurrency: number;
  /** Bodies larger than this are not retained. */
  maxBytes: number;
};

/** Conservative on purpose: a government server is not a CDN. */
export const DEFAULT_CRAWL_POLICY: CrawlPolicy = { minDelayMs: 10_000, maxConcurrency: 1, maxBytes: 50 * 1024 * 1024 };

export type FetchSubject = {
  sourceId: string;
  active: boolean;
  domains: readonly string[];
  /** True when the source sits behind a login, paywall, subscription or challenge. Never fetched. */
  accessControlled: boolean;
  licence: "none" | "prohibited" | "assessed";
  policy: CrawlPolicy;
};

export type FetchRefusal =
  | UrlRefusal
  | "SOURCE_INACTIVE" | "NO_LICENCE_ASSESSMENT" | "PROHIBITED_SOURCE" | "ACCESS_CONTROLLED"
  | "NO_CRAWLER_IDENTITY" | "ROBOTS_UNCHECKED" | "ROBOTS_STALE" | "ROBOTS_UNREACHABLE" | "ROBOTS_DISALLOWED"
  | "RATE_LIMITED" | "CONCURRENCY_LIMIT";

export type FetchDecision =
  | { allowed: true; url: string; userAgent: string }
  | { allowed: false; code: FetchRefusal; reason: string; retryAfterMs?: number };

/**
 * May this URL be fetched, now?
 *
 * Checked cheapest-and-most-permanent first, so the reason a refusal gives is
 * the one that would still stand after the others were fixed.
 */
export function decideFetch(input: {
  subject: FetchSubject;
  url: string;
  identity: CrawlerIdentity | null;
  robots: RobotsState;
  now: Date;
  lastRequestAt: Date | null;
  inFlight: number;
}): FetchDecision {
  const { subject: s, now } = input;
  const no = (code: FetchRefusal, reason: string, retryAfterMs?: number): FetchDecision =>
    ({ allowed: false, code, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  if (!s.active) return no("SOURCE_INACTIVE", `"${s.sourceId}" is inactive; nothing is fetched from it`);
  if (s.licence === "prohibited") return no("PROHIBITED_SOURCE", `"${s.sourceId}" is prohibited`);
  if (s.licence === "none") return no("NO_LICENCE_ASSESSMENT", `"${s.sourceId}" has no licence assessment; it is not fetched until someone has read its terms`);
  if (s.accessControlled) return no("ACCESS_CONTROLLED", `"${s.sourceId}" is behind access control; LeaseOS does not log in, pay, or solve challenges to crawl`);

  const url = validateSourceUrl(input.url, s.domains);
  if (!url.ok) return no(url.code, url.reason);
  if (!input.identity) return no("NO_CRAWLER_IDENTITY", "no crawler contact is configured; an anonymous crawler does not run");

  const r = input.robots;
  if (r.status === "unchecked") return no("ROBOTS_UNCHECKED", "robots.txt has not been fetched for this host");
  if (now.getTime() - r.fetchedAt.getTime() > ROBOTS_MAX_AGE_MS) return no("ROBOTS_STALE", "robots.txt is more than 24 hours old; fetch it again first");
  if (r.status === "unreachable") return no("ROBOTS_UNREACHABLE", "robots.txt could not be read; RFC 9309 requires assuming everything is disallowed");
  if (r.status === "fetched") {
    const u = new URL(url.url);
    if (!robotsAllows(r.file, input.identity.token, `${u.pathname}${u.search}`)) {
      return no("ROBOTS_DISALLOWED", `robots.txt disallows ${u.pathname} for ${input.identity.token}`);
    }
  }

  if (input.inFlight >= s.policy.maxConcurrency) return no("CONCURRENCY_LIMIT", `already ${input.inFlight} request(s) in flight to "${s.sourceId}"`);
  if (input.lastRequestAt) {
    const wait = input.lastRequestAt.getTime() + s.policy.minDelayMs - now.getTime();
    if (wait > 0) return no("RATE_LIMITED", `the next request to "${s.sourceId}" is due in ${wait} ms`, wait);
  }

  return { allowed: true, url: url.url, userAgent: input.identity.userAgent };
}

/**
 * What a response status means for the crawl.
 *
 * Access-control answers stop the collector for that source. They are not
 * errors to retry around, and they are never an invitation to supply
 * credentials the source did not give LeaseOS.
 */
export function accessSignal(httpStatus: number): "ok" | "stop_access_controlled" | "back_off" | "unavailable" {
  if (httpStatus >= 200 && httpStatus < 400) return "ok";
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403 || httpStatus === 407) return "stop_access_controlled";
  if (httpStatus === 429 || httpStatus === 503) return "back_off";
  return "unavailable";
}
