/**
 * v22.20 (0081) — the one place a credential is read, and the one place it must
 * not escape from.
 *
 * This is the thin edge the pure collector and ingester were built around. It
 * does three things: put the key where the publisher expects it, honour
 * conditional requests, and give up rather than hang.
 *
 * The risk here is not the request. It is the *error*. A failed fetch whose
 * message echoes the request URL writes the API key into
 * `externalFeedRuns.errorText`, from where it reaches logs, checkpoint
 * documents and support tickets — all the places the key was carefully kept out
 * of. So every string that leaves this module is redacted, and a test asserts
 * the key cannot appear in a result even when the underlying client puts it in
 * an exception.
 */

import { EgressRefused, type EgressLimits, type EgressResponse } from "./egressGuard";
import type { FeedSource } from "./feedCollector";
import type { FeedFailureCategory, FeedFetcher, FetchResult } from "./feedIngest";

/** How a publisher wants its key presented. Alberta 511 uses a query parameter. */
export type CredentialStyle = { kind: "query"; parameter: string } | { kind: "header"; header: string } | { kind: "none" };

export type FeedEndpoint = {
  sourceKey: string;
  url: string;
  credentialStyle: CredentialStyle;
  /** Milliseconds. A feed that has not answered by now is a failed run, not a hung process. */
  timeoutMs: number;
  /** Sent so the publisher can answer 304 and cost us nothing. */
  acceptHeader?: string;
};

/** The minimal shape of an HTTP client, so this is testable without a network. */
export interface HttpClient {
  request(input: { url: string; headers: Record<string, string>; timeoutMs: number }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
}

/**
 * Remove anything that looks like the secret from a string bound for a record.
 * Takes the value rather than guessing at patterns, because the only thing we
 * reliably know about a key is what it is.
 */
export function redact(text: string, secret: string | null | undefined): string {
  if (!secret || !secret.trim()) return text;
  return text.split(secret).join("«redacted»");
}

export function buildRequest(endpoint: FeedEndpoint, secret: string | null, entityTag: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: endpoint.acceptHeader ?? "application/json" };
  if (entityTag) headers["If-None-Match"] = entityTag;
  let url = endpoint.url;
  if (endpoint.credentialStyle.kind === "header" && secret) headers[endpoint.credentialStyle.header] = secret;
  if (endpoint.credentialStyle.kind === "query" && secret) {
    url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(endpoint.credentialStyle.parameter)}=${encodeURIComponent(secret)}`;
  }
  return { url, headers };
}

/**
 * A fetcher for one endpoint. The secret is read once, from the environment, by
 * the variable name the registry records — never from a literal, an argument or
 * a config file in the tree.
 */
export function httpFeedFetcher(args: {
  endpoint: FeedEndpoint;
  client: HttpClient;
  env: Record<string, string | undefined>;
}): FeedFetcher {
  return {
    async fetch({ source, entityTag }: { source: FeedSource; entityTag: string | null }): Promise<FetchResult> {
      const secret = source.credentialEnvVar ? args.env[source.credentialEnvVar] ?? null : null;
      // The URL carries the key URL-encoded, so an error that echoes the URL carries that form —
      // which a raw-value redaction would miss for any key with a reserved character in it.
      const safe = (s: string) => redact(redact(s, secret), secret ? encodeURIComponent(secret) : null);
      const { url, headers } = buildRequest(args.endpoint, secret, entityTag);
      try {
        const res = await args.client.request({ url, headers, timeoutMs: args.endpoint.timeoutMs });
        if (res.status === 304) return { status: "not_modified", httpStatus: 304, entityTag: res.headers["etag"] ?? entityTag };
        if (res.status < 200 || res.status >= 300) {
          const category = categoryForStatus(res.status, source.credentialEnvVar !== null);
          return {
            status: "error", httpStatus: res.status, category,
            retryAfterSeconds: category === "rate_limited" ? retryAfterSeconds(res.headers["retry-after"], new Date()) : null,
            error: safe(`Publisher answered ${res.status}${category === "credential_rejected" ? " — the key was refused or the request was malformed" : ""}: ${(res.body ?? "").slice(0, 300)}`),
          };
        }
        return {
          status: "ok", httpStatus: res.status, body: res.body,
          entityTag: res.headers["etag"] ?? null,
          sourceVersion: res.headers["last-modified"] ?? null,
        };
      } catch (e) {
        return { status: "error", httpStatus: null, category: categoryForThrown(e), error: safe((e as Error).message || "the request failed with no message") };
      }
    },
  };
}

/**
 * What a non-2xx answer means for an operator. 429 is the publisher's own limit. 401 and 403 are a
 * refused key. 400 is a refused key too on the 511 platform — it answers `400 <Error><Message>Invalid
 * Key</Message></Error>` (seen 2026-10-01 against Manitoba and Ontario) — so a keyed source reads 400
 * as a credential problem first; a keyless one reads it as an ordinary HTTP error.
 */
export function categoryForStatus(status: number, keyed: boolean): FeedFailureCategory {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 400 && keyed) return "credential_rejected";
  return "http_error";
}

export function categoryForThrown(e: unknown): FeedFailureCategory {
  if (e instanceof EgressRefused) {
    if (e.code === "timeout") return "timeout";
    if (e.destination && e.code !== "unresolvable") return "destination_refused";
    if (e.code === "content_type" || e.code === "content_encoding" || e.code === "too_large" || e.code === "too_many_redirects") return "unexpected_response";
    return "unreachable";
  }
  return "unreachable";
}

/** `Retry-After` as delta-seconds or an HTTP date. Unreadable is null — fall back to our own backoff. */
export function retryAfterSeconds(header: string | null | undefined, now: Date): number | null {
  if (!header) return null;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now.getTime()) / 1000)) : null;
}

/* ------------------------------------------------------------------ */
/* The production client: through the egress guard, never a bare fetch  */
/* ------------------------------------------------------------------ */

/** Feed bodies are listings, not files. Québec's whole roadworks layer is well under this. */
export const FEED_MAX_BYTES = 32 * 1024 * 1024;

/**
 * An `HttpClient` over `egressGet`. The guard fixes the request headers, so this client can send
 * only what the guard sends — `Accept` — and refuses a header-style credential outright rather than
 * dropping it and calling unauthenticated. Every Canadian provider takes its key in the query, so
 * none needs one. `If-None-Match` is dropped: no publisher here sends an ETag (checked 2026-10-01),
 * so unchanged content is caught by the response hash instead.
 *
 * Content types allowed are exactly those the endpoint's Accept header names.
 */
export function egressFeedClient(get: (target: string, limits: EgressLimits) => Promise<EgressResponse>): HttpClient {
  return {
    async request({ url, headers, timeoutMs }) {
      const names = Object.keys(headers).map(h => h.toLowerCase());
      const extra = names.filter(n => n !== "accept" && n !== "if-none-match");
      if (extra.length) throw new Error(`the egress guard sends no caller headers; ${extra.join(", ")} cannot be carried — use a query-parameter credential`);
      const accept = Object.entries(headers).find(([k]) => k.toLowerCase() === "accept")?.[1] ?? "application/json";
      const contentTypes = accept.split(",").map(t => t.split(";")[0]!.trim().toLowerCase()).filter(Boolean);
      const res = await get(url, { timeoutMs, maxBytes: FEED_MAX_BYTES, maxRedirects: 2, accept, contentTypes });
      const out: Record<string, string> = {};
      if (res.retryAfter) out["retry-after"] = res.retryAfter;
      return { status: res.status, body: res.ok ? res.text() : "", headers: out };
    },
  };
}
