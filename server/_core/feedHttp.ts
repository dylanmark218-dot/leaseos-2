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

import type { FeedSource } from "./feedCollector";
import type { FeedFetcher, FetchResult } from "./feedIngest";

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
      const safe = (s: string) => redact(s, secret);
      const { url, headers } = buildRequest(args.endpoint, secret, entityTag);
      try {
        const res = await args.client.request({ url, headers, timeoutMs: args.endpoint.timeoutMs });
        if (res.status === 304) return { status: "not_modified", httpStatus: 304, entityTag: res.headers["etag"] ?? entityTag };
        if (res.status < 200 || res.status >= 300) {
          return { status: "error", httpStatus: res.status, error: safe(`Publisher answered ${res.status}: ${(res.body ?? "").slice(0, 300)}`) };
        }
        return {
          status: "ok", httpStatus: res.status, body: res.body,
          entityTag: res.headers["etag"] ?? null,
          sourceVersion: res.headers["last-modified"] ?? null,
        };
      } catch (e) {
        return { status: "error", httpStatus: null, error: safe((e as Error).message || "the request failed with no message") };
      }
    },
  };
}
