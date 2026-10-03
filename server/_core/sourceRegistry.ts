/**
 * The approved external source registry — the rules, pure.
 *
 * LeaseOS reads from regulators, provincial 511 services and other publishers. Four separate
 * questions stand between a request and the network, and this registry answers the middle two:
 *
 *   1. Identity — who publishes the source, under what licence and terms. That is the
 *      `externalDataSources` row (B20.8), and its licence review (`geo.sourceReview`) is unchanged.
 *   2. Approval — has a person authorised LeaseOS to contact it, for which purpose, until when.
 *      A lifecycle on the source plus an approval record bound to one revision of its endpoints.
 *   3. Endpoint — exactly which origin and path may be contacted: host, port, method and a path
 *      prefix, compared as the URL parser writes them, never as substrings.
 *   4. Network safety — whether this one request may leave the server. That stays the egress
 *      guard's (`egressGuard.ts`), and nothing here can widen it: the registry's endpoint rule is
 *      handed to the guard as a `destinationPolicy`, which can only refuse more, and its limits
 *      are bounded by `EGRESS_CEILINGS`. An approved host that resolves to a private address, or
 *      redirects to one, is refused by the guard exactly as an unapproved one is.
 *
 * Everything security-relevant fails closed: a source with no approval, an expired or revoked
 * approval, an approval for an older revision of the endpoints, a disabled endpoint, a purpose
 * the approval does not name, or a URL no endpoint covers is refused.
 */
import {
  ENDPOINT_AUTH_SCHEMES, ENDPOINT_METHODS, ENDPOINT_PATH_MATCHES, ENDPOINT_SERVICE_TYPES, RISK_CLASSES, SENSITIVITY_CLASSES,
  SOURCE_APPROVAL_STATES, SOURCE_CLASSES, SOURCE_LIFECYCLES,
} from "../../drizzle/schema";
import { EGRESS_CEILINGS, hostNameRefusal, ipBytes, type EgressLimits } from "./egressGuard";

/* ---- vocabulary (declared beside the tables in drizzle/schema.ts) ---- */

/*
 * The source's lifecycle uses the words LeaseOS already uses for things a person must approve
 * before they take effect (rate sheet versions, customer contracts): draft, pending approval,
 * approved, suspended, revoked, retired. Only `approved` authorises a request. An approval request
 * uses the versioned-approval words: proposed, approved, rejected, superseded, revoked.
 */
export { ENDPOINT_AUTH_SCHEMES, ENDPOINT_METHODS, ENDPOINT_PATH_MATCHES, ENDPOINT_SERVICE_TYPES, RISK_CLASSES, SENSITIVITY_CLASSES, SOURCE_APPROVAL_STATES, SOURCE_CLASSES, SOURCE_LIFECYCLES };
export type SourceLifecycle = (typeof SOURCE_LIFECYCLES)[number];
export type ApprovalState = (typeof SOURCE_APPROVAL_STATES)[number];
export type EndpointServiceType = (typeof ENDPOINT_SERVICE_TYPES)[number];
/** Exactly `providerCredentials.authScheme`, so an endpoint names a credential the way the credential store does. */
export type EndpointAuthScheme = (typeof ENDPOINT_AUTH_SCHEMES)[number];
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];
export type PathMatch = (typeof ENDPOINT_PATH_MATCHES)[number];

/** Media types an endpoint may declare. A declared type is what the guard will accept, nothing more. */
export const ENDPOINT_CONTENT_TYPES = ["application/json", "text/plain", "application/geo+json", "application/xml", "text/xml", "text/csv"] as const;

/**
 * What an approval may authorise. A purpose is listed here only once a runtime path checks it, so
 * an approval cannot name a use nothing enforces. The facility directory's ArcGIS importer
 * (inspect and import) is the one wired path today.
 */
export const REGISTRY_PURPOSES = ["facility_directory.arcgis_import"] as const;
export type RegistryPurpose = (typeof REGISTRY_PURPOSES)[number];

/** An approval is reviewed at least yearly. */
export const APPROVAL_MAX_DAYS = 366;

/** The lowest limits an endpoint may declare: below these a request cannot usefully complete. */
const LIMIT_FLOORS = { timeoutMs: 1_000, maxBytes: 1_024 } as const;

/* ---- hostnames and paths ---- */

/**
 * A DNS name as the WHATWG URL parser writes it — lower case, IDNA to punycode, no trailing dot —
 * or null. Anything that is not a bare name is refused rather than repaired: a port, a path,
 * credentials, an IP literal, or a name reserved for the inside (`localhost`, `.internal`, …).
 */
export function canonicalHostname(input: string): string | null {
  if (!input || /[\s/\\@?#:]/.test(input)) return null;
  let u: URL;
  try { u = new URL(`https://${input}/`); } catch { return null; }
  const host = u.hostname.replace(/\.$/, "");
  if (!host || ipBytes(host.replace(/^\[|\]$/g, "")) || hostNameRefusal(host)) return null;
  return host;
}

/**
 * Split an https base URL into the parts an endpoint stores. The path must already be the form
 * the parser produces — no `..`, no `.`, no percent-encoded separator, no backslash, nothing
 * re-encoded — because a path that reads two ways is the shape of a traversal.
 */
export function parseEndpointBase(baseUrl: string): { ok: true; hostname: string; port: number; pathPrefix: string } | { ok: false; reason: string } {
  const m = /^https:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(baseUrl);
  if (!m) return { ok: false, reason: "an endpoint is an https URL with no query or fragment" };
  let u: URL;
  try { u = new URL(baseUrl); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "https only" };
  if (u.username || u.password) return { ok: false, reason: "a URL carrying credentials is not an endpoint" };
  const hostname = canonicalHostname(u.hostname);
  if (!hostname) return { ok: false, reason: `${u.hostname} is not a public DNS name` };
  const rawPath = m[2] ?? "/";
  if (/%2f|%5c|%2e/i.test(rawPath) || rawPath.indexOf("\\") >= 0) return { ok: false, reason: "the path carries an encoded separator or dot" };
  if (u.pathname !== rawPath) return { ok: false, reason: `the path is not in canonical form (${rawPath} parses as ${u.pathname})` };
  const pathPrefix = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  if (/\/\//.test(pathPrefix)) return { ok: false, reason: "the path has an empty segment" };
  return { ok: true, hostname, port: u.port === "" ? 443 : Number(u.port), pathPrefix };
}

/* ---- endpoints ---- */

export type EndpointPolicy = {
  hostname: string;
  port: number;
  pathPrefix: string;
  pathMatch: PathMatch;
  httpMethod: EndpointMethod;
};

/**
 * Why `url` is outside the endpoint, or null when it is inside. Host and port compare as exact
 * strings of the parser's output, so `evil-example.com` and `example.com.attacker.tld` never
 * match `example.com`. The path compares on a segment boundary after the parser has resolved
 * `..` and `%2e%2e`, so `/layer/17/../../other` is judged as the path it actually names.
 */
export function endpointRefusal(url: URL, ep: EndpointPolicy, method: EndpointMethod = "GET"): string | null {
  if (url.protocol !== "https:") return "https only";
  if (url.username || url.password) return "the URL carries credentials";
  const host = url.hostname.replace(/\.$/, "");
  if (host !== ep.hostname) return `host ${host} is not the endpoint's host ${ep.hostname}`;
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== ep.port) return `port ${port} is not the endpoint's port ${ep.port}`;
  if (method !== ep.httpMethod) return `${method} is not the endpoint's method ${ep.httpMethod}`;
  const path = url.pathname;
  if (/%2f|%5c/i.test(path)) return "the path carries an encoded separator";
  const inside = ep.pathMatch === "exact"
    ? path === ep.pathPrefix || path === `${ep.pathPrefix}/`
    : ep.pathPrefix === "/" || path === ep.pathPrefix || path.startsWith(`${ep.pathPrefix}/`);
  return inside ? null : `path ${path} is outside ${ep.pathPrefix}`;
}

/**
 * The endpoint that governs `url`, from every endpoint registered for its host and port. The
 * longest covering path prefix governs whether or not it is enabled, so disabling a specific
 * endpoint is never undone by a broader one. Among equally specific endpoints the enabled one
 * governs (a retired source's disabled endpoint does not block its successor); two enabled ones
 * are refused rather than resolved by row order; and when none is enabled the lowest id is
 * returned, for the caller to refuse as disabled.
 */
export function selectEndpoint<T extends EndpointPolicy & { id: number; enabled: boolean }>(url: URL, candidates: readonly T[], method: EndpointMethod = "GET"):
  { ok: true; endpoint: T } | { ok: false; code: "unregistered" | "ambiguous"; reason: string } {
  const covering = candidates.filter(c => endpointRefusal(url, c, method) === null);
  if (!covering.length) return { ok: false, code: "unregistered", reason: `no registered endpoint covers ${url.host}${url.pathname}` };
  const best = Math.max(...covering.map(c => c.pathPrefix.length));
  const winners = covering.filter(c => c.pathPrefix.length === best);
  const enabled = winners.filter(c => c.enabled);
  if (enabled.length > 1) return { ok: false, code: "ambiguous", reason: `${enabled.length} enabled endpoints cover ${url.host}${url.pathname} equally; which one governs is not decided by row order` };
  return { ok: true, endpoint: enabled[0] ?? [...winners].sort((a, b) => a.id - b.id)[0]! };
}

export type EndpointInput = {
  endpointKey: string;
  displayName: string;
  serviceType: EndpointServiceType;
  httpMethod: EndpointMethod;
  baseUrl: string;
  pathMatch: PathMatch;
  authScheme: EndpointAuthScheme;
  credentialRef: string | null;
  contentTypes: readonly string[];
  timeoutMs: number | null;
  maxBytes: number | null;
};

export type EndpointConfig = Omit<EndpointInput, "baseUrl" | "contentTypes"> & {
  hostname: string; port: number; pathPrefix: string; canonicalUrl: string; contentTypes: string[];
};

/** Every reason an endpoint definition is refused. An endpoint is stored only when there are none. */
export function validateEndpoint(input: EndpointInput): { ok: true; endpoint: EndpointConfig } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(input.endpointKey)) reasons.push("endpointKey is lower_snake, 2–80 characters");
  const base = parseEndpointBase(input.baseUrl);
  if (!base.ok) reasons.push(base.reason);
  if (base.ok && (input.serviceType === "arcgis_feature_server" || input.serviceType === "arcgis_map_server")) {
    // An ArcGIS endpoint is one layer: the service path ends at its layer id, and the prefix rule
    // lets the importer reach that layer's own resources (?f=pjson, /query) and nothing beside it.
    const service = input.serviceType === "arcgis_feature_server" ? "FeatureServer" : "MapServer";
    if (!new RegExp(`/rest/services/.+/${service}/\\d+$`).test(base.pathPrefix)) reasons.push(`an ${input.serviceType} endpoint is one layer: …/rest/services/…/${service}/<layer id>`);
    if (input.pathMatch !== "prefix") reasons.push("an ArcGIS layer endpoint matches by prefix, so its /query resource is inside it");
  }
  if (input.serviceType === "webhook" ? input.httpMethod !== "POST" : input.httpMethod !== "GET") reasons.push(`a ${input.serviceType} endpoint is ${input.serviceType === "webhook" ? "POST" : "GET"}`);
  if (input.authScheme === "NONE" && input.credentialRef !== null) reasons.push("an endpoint with no authentication binds no credential");
  if (input.credentialRef !== null && !/^cred_[A-Za-z0-9_-]{4,59}$/.test(input.credentialRef)) reasons.push("a credential is named by its providerCredentials credentialRef, never by a value");
  const types = input.contentTypes.map(t => t.trim().toLowerCase());
  if (!types.length) reasons.push("an endpoint declares at least one content type");
  for (const t of types) if ((ENDPOINT_CONTENT_TYPES as readonly string[]).indexOf(t) < 0) reasons.push(`content type ${t} is not one the registry accepts`);
  if (input.timeoutMs !== null && !(Number.isInteger(input.timeoutMs) && input.timeoutMs >= LIMIT_FLOORS.timeoutMs && input.timeoutMs <= EGRESS_CEILINGS.timeoutMs)) reasons.push(`timeoutMs is ${LIMIT_FLOORS.timeoutMs}–${EGRESS_CEILINGS.timeoutMs}, the egress guard's ceiling`);
  if (input.maxBytes !== null && !(Number.isInteger(input.maxBytes) && input.maxBytes >= LIMIT_FLOORS.maxBytes && input.maxBytes <= EGRESS_CEILINGS.maxBytes)) reasons.push(`maxBytes is ${LIMIT_FLOORS.maxBytes}–${EGRESS_CEILINGS.maxBytes}, the egress guard's ceiling`);
  if (reasons.length || !base.ok) return { ok: false, reasons };
  const portPart = base.port === 443 ? "" : `:${base.port}`;
  return {
    ok: true,
    endpoint: {
      endpointKey: input.endpointKey, displayName: input.displayName, serviceType: input.serviceType, httpMethod: input.httpMethod,
      pathMatch: input.pathMatch, authScheme: input.authScheme, credentialRef: input.credentialRef,
      timeoutMs: input.timeoutMs, maxBytes: input.maxBytes, contentTypes: types,
      hostname: base.hostname, port: base.port, pathPrefix: base.pathPrefix,
      canonicalUrl: `https://${base.hostname}${portPart}${base.pathPrefix}`,
    },
  };
}

/**
 * The fields whose change alters what LeaseOS may contact. Changing any of them, or enabling an
 * endpoint, makes a new revision of the source that its current approval does not cover.
 * Disabling an endpoint narrows what is reachable and needs no review.
 */
export const NETWORK_FIELDS = ["hostname", "port", "pathPrefix", "pathMatch", "httpMethod", "serviceType", "authScheme", "credentialRef", "contentTypes", "timeoutMs", "maxBytes"] as const;

export function networkChange(before: Record<string, unknown> & { enabled: boolean }, after: Record<string, unknown> & { enabled: boolean }): boolean {
  if (!before.enabled && after.enabled) return true;
  return NETWORK_FIELDS.some(f => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
}

/** The limits a registry-governed request runs under: the caller's defaults, narrowed by the endpoint, policed by the guard. */
export function effectiveLimits(ep: EndpointPolicy & { contentTypes: readonly string[]; timeoutMs: number | null; maxBytes: number | null }, defaults: EgressLimits): EgressLimits {
  return {
    ...defaults,
    timeoutMs: ep.timeoutMs ?? defaults.timeoutMs,
    maxBytes: ep.maxBytes ?? defaults.maxBytes,
    contentTypes: [...ep.contentTypes],
    destinationPolicy: u => endpointRefusal(u, ep, ep.httpMethod),
  };
}

/* ---- lifecycle ---- */

export type RegistryAction = "request_review" | "approve" | "reject" | "suspend" | "resume" | "revoke" | "retire";

/*
 * Requesting a review stops an approved or suspended source until the new request is approved:
 * renewal before a review-by date is a fresh approval of the revision as it stands, and nothing
 * runs on a request that is still open.
 */
const TRANSITIONS: Record<RegistryAction, { from: readonly SourceLifecycle[]; to: SourceLifecycle }> = {
  request_review: { from: ["draft", "approved", "suspended", "revoked"], to: "pending_approval" },
  approve: { from: ["pending_approval"], to: "approved" },
  reject: { from: ["pending_approval"], to: "draft" },
  suspend: { from: ["approved"], to: "suspended" },
  resume: { from: ["suspended"], to: "approved" },
  revoke: { from: ["pending_approval", "approved", "suspended"], to: "revoked" },
  retire: { from: ["draft", "pending_approval", "approved", "suspended", "revoked"], to: "retired" },
};

export function transition(from: SourceLifecycle, action: RegistryAction): { ok: true; to: SourceLifecycle } | { ok: false; reason: string } {
  const t = TRANSITIONS[action];
  return t.from.indexOf(from) >= 0 ? { ok: true, to: t.to } : { ok: false, reason: `a ${from} source cannot be ${action.replace("_", " ")}d` };
}

/**
 * Where a network edit leaves a source. An edit to an approved or suspended source makes a
 * revision its approval does not cover, so it goes back to pending approval; a retired source
 * is not edited at all.
 */
export function lifecycleAfterNetworkEdit(from: SourceLifecycle): { ok: true; to: SourceLifecycle; reReview: boolean } | { ok: false; reason: string } {
  if (from === "retired") return { ok: false, reason: "a retired source is not edited" };
  if (from === "approved" || from === "suspended") return { ok: true, to: "pending_approval", reReview: true };
  return { ok: true, to: from, reReview: from === "pending_approval" };
}

/**
 * Separation of duties. Whoever asked for the approval, and whoever made the revision being
 * approved, may not approve it. A seeded request has no requester; the revision rule still holds.
 */
export function approverRefusal(a: { approverUserId: number; requestedByUserId: number | null; revisionByUserId: number | null }): string | null {
  if (a.requestedByUserId !== null && a.approverUserId === a.requestedByUserId) return "the person who requested an approval does not approve it";
  if (a.revisionByUserId !== null && a.approverUserId === a.revisionByUserId) return "the person who made this revision of the source does not approve it";
  return null;
}

export function reviewByRefusal(expiresAt: Date, now: Date): string | null {
  const days = (expiresAt.getTime() - now.getTime()) / 86_400_000;
  if (!(days > 0)) return "an approval's review-by date is in the future";
  if (days > APPROVAL_MAX_DAYS) return `an approval is reviewed within ${APPROVAL_MAX_DAYS} days`;
  return null;
}

/* ---- runtime ---- */

export type RegistryRefusalCode =
  | "unregistered" | "ambiguous" | "not_approved" | "suspended" | "revoked" | "retired"
  | "no_approval" | "approval_stale" | "approval_expired" | "out_of_scope" | "endpoint_disabled" | "endpoint_policy" | "changed_during_operation";

export type RuntimeSource = { id: number; sourceKey: string; lifecycle: SourceLifecycle; revision: number };
export type RuntimeEndpoint = EndpointPolicy & { id: number; endpointRef: string; externalDataSourceId: number; enabled: boolean };
export type RuntimeApproval = { id: number; state: ApprovalState; sourceRevision: number; expiresAt: Date | null; scope: readonly string[] };

/** What a request was authorised under — carried into the audit trail and the provenance record. */
export type RegistryDecision = {
  sourceId: number; sourceKey: string; endpointId: number; endpointRef: string; sourceRevision: number; approvalId: number; purpose: RegistryPurpose;
};

/**
 * Whether one request may proceed. The order is the order an operator would fix things in, and
 * every branch refuses: only an approved source, with an approval for its current revision that
 * has not expired and names this purpose, and an enabled endpoint that covers the URL, passes.
 */
export function runtimeDecision(a: {
  source: RuntimeSource; endpoint: RuntimeEndpoint; approval: RuntimeApproval | null; url: URL; method?: EndpointMethod; purpose: RegistryPurpose; now: Date;
}): { ok: true; decision: RegistryDecision } | { ok: false; code: RegistryRefusalCode; reason: string } {
  const { source, endpoint, approval } = a;
  if (endpoint.externalDataSourceId !== source.id) return { ok: false, code: "unregistered", reason: `endpoint ${endpoint.endpointRef} does not belong to ${source.sourceKey}` };
  if (source.lifecycle === "suspended") return { ok: false, code: "suspended", reason: `${source.sourceKey} is suspended` };
  if (source.lifecycle === "revoked") return { ok: false, code: "revoked", reason: `${source.sourceKey}'s approval is revoked` };
  if (source.lifecycle === "retired") return { ok: false, code: "retired", reason: `${source.sourceKey} is retired` };
  if (source.lifecycle !== "approved") return { ok: false, code: "not_approved", reason: `${source.sourceKey} is ${source.lifecycle.replace("_", " ")}; nothing is fetched from it until a person approves it` };
  if (!approval || approval.state !== "approved") return { ok: false, code: "no_approval", reason: `${source.sourceKey} has no standing approval` };
  if (approval.sourceRevision !== source.revision) return { ok: false, code: "approval_stale", reason: `${source.sourceKey}'s approval covers revision ${approval.sourceRevision}, and its endpoints are at revision ${source.revision}` };
  if (!approval.expiresAt || approval.expiresAt.getTime() <= a.now.getTime()) return { ok: false, code: "approval_expired", reason: `${source.sourceKey}'s approval is past its review-by date` };
  if (approval.scope.indexOf(a.purpose) < 0) return { ok: false, code: "out_of_scope", reason: `${source.sourceKey} is not approved for ${a.purpose}` };
  if (!endpoint.enabled) return { ok: false, code: "endpoint_disabled", reason: `endpoint ${endpoint.endpointRef} is disabled` };
  const outside = endpointRefusal(a.url, endpoint, a.method ?? "GET");
  if (outside) return { ok: false, code: "endpoint_policy", reason: outside };
  return {
    ok: true,
    decision: {
      sourceId: source.id, sourceKey: source.sourceKey, endpointId: endpoint.id, endpointRef: endpoint.endpointRef,
      sourceRevision: source.revision, approvalId: approval.id, purpose: a.purpose,
    },
  };
}

/**
 * Whether a decision taken earlier in an operation still stands — the import loop asks before
 * every page, so a revocation, suspension or edit stops it at the next request.
 */
export function sameAuthority(before: RegistryDecision, now: RegistryDecision): boolean {
  return before.sourceId === now.sourceId && before.endpointId === now.endpointId && before.sourceRevision === now.sourceRevision && before.approvalId === now.approvalId;
}
