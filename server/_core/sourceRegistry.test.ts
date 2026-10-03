/**
 * The approved external source registry's rules (0233), pure: how a URL is matched to an endpoint,
 * what an endpoint may declare, how a source moves through its lifecycle, who may approve, and what
 * the runtime refuses. The database half is server/sourceRegistry.db.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_MAX_DAYS, approverRefusal, canonicalHostname, effectiveLimits, endpointRefusal, lifecycleAfterNetworkEdit, networkChange,
  parseEndpointBase, REGISTRY_PURPOSES, reviewByRefusal, runtimeDecision, sameAuthority, selectEndpoint, SOURCE_LIFECYCLES, transition,
  validateEndpoint, type EndpointInput, type EndpointPolicy, type RegistryAction, type RuntimeApproval, type RuntimeEndpoint, type RuntimeSource,
} from "./sourceRegistry";
import { ENDPOINT_SEEDS, FACILITY_LAYER_ENDPOINTS, REVIEW_SEEDS, TRANSPORT_FEED_ENDPOINTS } from "./sourceRegistrySeeds";
import { ALL_DATA_SOURCES } from "./externalSourceSeeds";
import { CANADIAN_TRANSPORT_PROVIDERS } from "./transport/providerRegistry";
import { SK_FACILITIES } from "./arcgisImport";
import { EGRESS_CEILINGS } from "./egressGuard";

const EP: EndpointPolicy = { hostname: "example.com", port: 443, pathPrefix: "/arcgis/rest/services/Economy/Petroleum/FeatureServer/17", pathMatch: "prefix", httpMethod: "GET" };
const at = (path: string, host = "example.com") => new URL(`https://${host}${path}`);

describe("host names are compared as the URL parser writes them, never as substrings", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["gis.saskatchewan.ca", "gis.saskatchewan.ca"],
  ])("canonicalises %s to %s", (input, expected) => {
    expect(canonicalHostname(input)).toBe(expected);
  });

  it.each([
    "", "example.com:8443", "example.com/path", "user@example.com", "example.com?x", "exa mple.com",
    "10.0.0.1", "169.254.169.254", "[::1]", "2130706433", "0x7f.1",
    "localhost", "db.internal", "printer.local", "router.home.arpa", "intranet",
  ])("refuses %j as an endpoint host", input => {
    expect(canonicalHostname(input)).toBeNull();
  });

  it.each([
    ["evil-example.com", "a hyphenated look-alike"],
    ["example.com.attacker.tld", "the approved name as a label of another domain"],
    ["sub.example.com", "a subdomain"],
    ["example.co", "a shorter name"],
    ["xample.com", "a suffix of the approved name"],
  ])("refuses %s (%s)", host => {
    expect(endpointRefusal(at(EP.pathPrefix, host), EP)).toMatch(/is not the endpoint's host/);
  });

  it("accepts the same host in any case, with or without a trailing dot", () => {
    expect(endpointRefusal(at(EP.pathPrefix, "EXAMPLE.com"), EP)).toBeNull();
    expect(endpointRefusal(at(EP.pathPrefix, "example.com."), EP)).toBeNull();
  });

  it("matches an internationalised name only in its punycode form, which is what the parser produces", () => {
    const idn = { ...EP, hostname: "xn--bcher-kva.example" };
    expect(endpointRefusal(new URL(`https://bücher.example${EP.pathPrefix}`), idn)).toBeNull();
    expect(endpointRefusal(new URL(`https://bucher.example${EP.pathPrefix}`), idn)).toMatch(/host/);
  });
});

describe("ports, methods and schemes", () => {
  it("compares the port exactly; 443 written out is the default port", () => {
    expect(endpointRefusal(new URL(`https://example.com:443${EP.pathPrefix}`), EP)).toBeNull();
    expect(endpointRefusal(new URL(`https://example.com:8443${EP.pathPrefix}`), EP)).toMatch(/port 8443/);
    expect(endpointRefusal(new URL(`https://example.com:8443${EP.pathPrefix}`), { ...EP, port: 8443 })).toBeNull();
  });

  it("refuses another method, plain http and credentials in the URL", () => {
    expect(endpointRefusal(at(EP.pathPrefix), EP, "POST")).toMatch(/POST is not the endpoint's method/);
    expect(endpointRefusal(new URL(`http://example.com${EP.pathPrefix}`), EP)).toBe("https only");
    expect(endpointRefusal(new URL(`https://u:p@example.com${EP.pathPrefix}`), EP)).toMatch(/credentials/);
  });
});

describe("paths are compared on a segment boundary, after the parser resolves dot segments", () => {
  it.each([
    [`${EP.pathPrefix}`, null],
    [`${EP.pathPrefix}/`, null],
    [`${EP.pathPrefix}/query`, null],
    [`${EP.pathPrefix}?f=pjson`, null],
    [`${EP.pathPrefix}0`, "outside"],
    [`${EP.pathPrefix}0/query`, "outside"],
    ["/arcgis/rest/services/Economy/Petroleum/FeatureServer/1", "outside"],
    ["/arcgis/rest/services/Economy/Petroleum/FeatureServer", "outside"],
    [`${EP.pathPrefix}/../../../Admin/MapServer/0`, "outside"],
    [`${EP.pathPrefix}/%2e%2e/%2E%2E/18`, "outside"],
    [`${EP.pathPrefix}/.%2e/16`, "outside"],
    [`${EP.pathPrefix}%2Fquery`, "encoded separator"],
    [`${EP.pathPrefix}%2f..%2f16`, "encoded separator"],
    [`${EP.pathPrefix}%5c..%5c16`, "encoded separator"],
  ])("%s → %s", (path, refused) => {
    const why = endpointRefusal(at(path), EP);
    if (refused === null) expect(why).toBeNull();
    else expect(why).toContain(refused);
  });

  it("an exact endpoint admits its own path and nothing under it", () => {
    const exact = { ...EP, pathPrefix: "/api/v2/get/event", pathMatch: "exact" as const };
    expect(endpointRefusal(at("/api/v2/get/event?format=json"), exact)).toBeNull();
    expect(endpointRefusal(at("/api/v2/get/event/"), exact)).toBeNull();
    expect(endpointRefusal(at("/api/v2/get/event/1"), exact)).toMatch(/outside/);
    expect(endpointRefusal(at("/api/v2/get/events"), exact)).toMatch(/outside/);
  });
});

describe("an endpoint's base URL is stored only in the form the parser writes", () => {
  it("splits an https URL into host, port and a path prefix without its trailing slash", () => {
    expect(parseEndpointBase("https://GIS.example.ca/a/b/")).toEqual({ ok: true, hostname: "gis.example.ca", port: 443, pathPrefix: "/a/b" });
    expect(parseEndpointBase("https://gis.example.ca:8443/a")).toEqual({ ok: true, hostname: "gis.example.ca", port: 8443, pathPrefix: "/a" });
    expect(parseEndpointBase("https://gis.example.ca")).toEqual({ ok: true, hostname: "gis.example.ca", port: 443, pathPrefix: "/" });
  });

  it.each([
    ["http://gis.example.ca/a", "https"],
    ["https://gis.example.ca/a?f=json", "no query"],
    ["https://gis.example.ca/a#x", "no query"],
    ["https://u:p@gis.example.ca/a", "credentials"],
    ["https://10.0.0.1/a", "not a public DNS name"],
    ["https://localhost/a", "not a public DNS name"],
    ["https://gis.example.ca/a/../b", "canonical form"],
    ["https://gis.example.ca/a/./b", "canonical form"],
    ["https://gis.example.ca/a/%2e%2e/b", "encoded separator or dot"],
    ["https://gis.example.ca/a%2Fb", "encoded separator or dot"],
    ["https://gis.example.ca/a\\b", "encoded separator or dot"],
    ["https://gis.example.ca/a//b", "empty segment"],
    ["https://gis.example.ca/a b", "canonical form"],
  ])("refuses %s", (url, reason) => {
    const r = parseEndpointBase(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});

describe("choosing the endpoint that governs a URL", () => {
  const ep = (id: number, pathPrefix: string, enabled = true) => ({ ...EP, id, pathPrefix, enabled });

  it("the longest covering prefix governs", () => {
    const r = selectEndpoint(at(`${EP.pathPrefix}/query`), [ep(1, "/arcgis/rest/services"), ep(2, EP.pathPrefix)]);
    expect(r).toMatchObject({ ok: true, endpoint: { id: 2 } });
  });

  it("a disabled specific endpoint is not overridden by a broader enabled one", () => {
    const r = selectEndpoint(at(`${EP.pathPrefix}/query`), [ep(1, "/arcgis/rest/services"), ep(2, EP.pathPrefix, false)]);
    expect(r).toMatchObject({ ok: true, endpoint: { id: 2, enabled: false } });
  });

  it("two enabled endpoints that tie are refused, not chosen by row order", () => {
    expect(selectEndpoint(at(EP.pathPrefix), [ep(1, EP.pathPrefix), ep(2, EP.pathPrefix)])).toMatchObject({ ok: false, code: "ambiguous" });
  });

  it("an enabled endpoint governs over a disabled twin; with no enabled twin the lowest id is returned to be refused", () => {
    expect(selectEndpoint(at(EP.pathPrefix), [ep(1, EP.pathPrefix, false), ep(2, EP.pathPrefix)])).toMatchObject({ ok: true, endpoint: { id: 2 } });
    expect(selectEndpoint(at(EP.pathPrefix), [ep(5, EP.pathPrefix, false), ep(3, EP.pathPrefix, false)])).toMatchObject({ ok: true, endpoint: { id: 3 } });
  });

  it("nothing covering is unregistered", () => {
    expect(selectEndpoint(at("/elsewhere"), [ep(1, EP.pathPrefix)])).toMatchObject({ ok: false, code: "unregistered" });
    expect(selectEndpoint(at(EP.pathPrefix, "evil-example.com"), [ep(1, EP.pathPrefix)])).toMatchObject({ ok: false, code: "unregistered" });
    expect(selectEndpoint(at(EP.pathPrefix), [])).toMatchObject({ ok: false, code: "unregistered" });
  });
});

const INPUT: EndpointInput = {
  endpointKey: "petroleum_facilities_layer_17", displayName: "Petroleum facilities", serviceType: "arcgis_feature_server", httpMethod: "GET",
  baseUrl: "https://gis.example.ca/arcgis/rest/services/Economy/Petroleum/FeatureServer/17", pathMatch: "prefix",
  authScheme: "NONE", credentialRef: null, contentTypes: ["application/json", "text/plain"], timeoutMs: null, maxBytes: null,
};
const reasons = (patch: Partial<EndpointInput>) => { const r = validateEndpoint({ ...INPUT, ...patch }); return r.ok ? [] : r.reasons; };

describe("what an endpoint may declare", () => {
  it("stores a valid ArcGIS layer in canonical form", () => {
    const r = validateEndpoint({ ...INPUT, baseUrl: "https://GIS.example.ca:443/arcgis/rest/services/Economy/Petroleum/FeatureServer/17/" });
    expect(r).toMatchObject({ ok: true, endpoint: { hostname: "gis.example.ca", port: 443, pathPrefix: "/arcgis/rest/services/Economy/Petroleum/FeatureServer/17", canonicalUrl: "https://gis.example.ca/arcgis/rest/services/Economy/Petroleum/FeatureServer/17" } });
  });

  it("an ArcGIS endpoint is exactly one layer, matched by prefix", () => {
    expect(reasons({ baseUrl: "https://gis.example.ca/arcgis/rest/services" })).toEqual([expect.stringContaining("is one layer")]);
    expect(reasons({ baseUrl: "https://gis.example.ca/arcgis/rest/services/Economy/Petroleum/FeatureServer" })).toEqual([expect.stringContaining("is one layer")]);
    expect(reasons({ serviceType: "arcgis_map_server" })).toEqual([expect.stringContaining("MapServer/<layer id>")]);
    expect(reasons({ pathMatch: "exact" })).toEqual([expect.stringContaining("matches by prefix")]);
  });

  it("a webhook is POST and everything else GET", () => {
    expect(reasons({ serviceType: "json_feed", baseUrl: "https://gis.example.ca/feed", httpMethod: "POST" })).toEqual(["a json_feed endpoint is GET"]);
    expect(reasons({ serviceType: "webhook", baseUrl: "https://gis.example.ca/hook", httpMethod: "GET" })).toEqual(["a webhook endpoint is POST"]);
  });

  it("names a credential only by its credential-store reference, and never with no authentication", () => {
    expect(reasons({ credentialRef: "cred_abcd1234" })).toEqual(["an endpoint with no authentication binds no credential"]);
    expect(reasons({ authScheme: "API_KEY", credentialRef: "cred_abcd1234" })).toEqual([]);
    for (const value of ["plain-api-key-value", "Bearer abc.def.ghi", "cred_", "cred_ab", "cred_abc def", "api-key=1234567890"]) {
      expect(reasons({ authScheme: "API_KEY", credentialRef: value }), value).toEqual(["a credential is named by its providerCredentials credentialRef, never by a value"]);
    }
  });

  it("declares only content types the registry knows", () => {
    expect(reasons({ contentTypes: [] })).toEqual(["an endpoint declares at least one content type"]);
    expect(reasons({ contentTypes: ["text/html"] })).toEqual(["content type text/html is not one the registry accepts"]);
    expect(reasons({ contentTypes: ["APPLICATION/JSON "] })).toEqual([]);
  });

  it("cannot raise a limit past the egress guard's ceiling, or set one too low to complete", () => {
    expect(reasons({ timeoutMs: EGRESS_CEILINGS.timeoutMs + 1 })).toEqual([expect.stringContaining("the egress guard's ceiling")]);
    expect(reasons({ maxBytes: EGRESS_CEILINGS.maxBytes + 1 })).toEqual([expect.stringContaining("the egress guard's ceiling")]);
    expect(reasons({ timeoutMs: 999 })).toHaveLength(1);
    expect(reasons({ maxBytes: 1023 })).toHaveLength(1);
    expect(reasons({ timeoutMs: 1.5 })).toHaveLength(1);
    expect(reasons({ timeoutMs: EGRESS_CEILINGS.timeoutMs, maxBytes: EGRESS_CEILINGS.maxBytes })).toEqual([]);
  });

  it("collects every reason rather than stopping at the first", () => {
    expect(reasons({ endpointKey: "Bad Key", baseUrl: "http://x/y", contentTypes: ["text/html"], timeoutMs: 0 }).length).toBeGreaterThanOrEqual(4);
  });
});

describe("what counts as a change to what may be contacted", () => {
  const before = { hostname: "a.example", port: 443, pathPrefix: "/x", pathMatch: "prefix", httpMethod: "GET", serviceType: "json_feed", authScheme: "NONE", credentialRef: null, contentTypes: ["application/json"], timeoutMs: null, maxBytes: null, enabled: true, displayName: "A" };
  it.each([
    ["hostname", { hostname: "b.example" }], ["port", { port: 8443 }], ["pathPrefix", { pathPrefix: "/" }], ["pathMatch", { pathMatch: "exact" }],
    ["contentTypes", { contentTypes: ["application/json", "text/csv"] }], ["timeoutMs", { timeoutMs: 60_000 }], ["maxBytes", { maxBytes: 2048 }],
    ["credentialRef", { credentialRef: "cred_rotated01" }], ["authScheme", { authScheme: "API_KEY" }],
  ])("changing %s is a new revision", (_f, patch) => {
    expect(networkChange(before, { ...before, ...patch })).toBe(true);
  });
  it("enabling is a new revision; disabling or renaming is not", () => {
    expect(networkChange({ ...before, enabled: false }, before)).toBe(true);
    expect(networkChange(before, { ...before, enabled: false })).toBe(false);
    expect(networkChange(before, { ...before, displayName: "B" })).toBe(false);
  });
});

describe("the limits a registry-governed request runs under", () => {
  const defaults = { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024, maxRedirects: 3, accept: "application/json", contentTypes: ["application/json", "text/plain", "text/html"] };
  it("takes the endpoint's limits and content types, and its rule as the guard's destination policy", () => {
    const l = effectiveLimits({ ...EP, contentTypes: ["application/json"], timeoutMs: 10_000, maxBytes: null }, defaults);
    expect(l).toMatchObject({ timeoutMs: 10_000, maxBytes: defaults.maxBytes, maxRedirects: 3, contentTypes: ["application/json"] });
    expect(l.destinationPolicy!(at(`${EP.pathPrefix}/query`))).toBeNull();
    expect(l.destinationPolicy!(at(EP.pathPrefix, "example.com.attacker.tld"))).toMatch(/host/);
    expect(l.destinationPolicy!(at("/arcgis/rest/services/Admin"))).toMatch(/outside/);
  });
});

describe("the lifecycle", () => {
  const ACTIONS: RegistryAction[] = ["request_review", "approve", "reject", "suspend", "resume", "revoke", "retire"];
  const allowed: Record<string, string> = {};
  for (const from of SOURCE_LIFECYCLES) for (const a of ACTIONS) { const t = transition(from, a); if (t.ok) allowed[`${from} ${a}`] = t.to; }

  it("is exactly this table", () => {
    expect(allowed).toEqual({
      "draft request_review": "pending_approval", "draft retire": "retired",
      "pending_approval approve": "approved", "pending_approval reject": "draft", "pending_approval revoke": "revoked", "pending_approval retire": "retired",
      "approved request_review": "pending_approval", "approved suspend": "suspended", "approved revoke": "revoked", "approved retire": "retired",
      "suspended request_review": "pending_approval", "suspended resume": "approved", "suspended revoke": "revoked", "suspended retire": "retired",
      "revoked request_review": "pending_approval", "revoked retire": "retired",
    });
  });

  it("only a pending request is approved: draft, revoked and retired sources cannot be approved directly", () => {
    for (const from of ["draft", "approved", "suspended", "revoked", "retired"] as const) expect(transition(from, "approve").ok, from).toBe(false);
  });

  it("an edit to what may be contacted sends an approved or suspended source back for review, and a retired one is not edited", () => {
    expect(lifecycleAfterNetworkEdit("approved")).toEqual({ ok: true, to: "pending_approval", reReview: true });
    expect(lifecycleAfterNetworkEdit("suspended")).toEqual({ ok: true, to: "pending_approval", reReview: true });
    expect(lifecycleAfterNetworkEdit("pending_approval")).toEqual({ ok: true, to: "pending_approval", reReview: true });
    expect(lifecycleAfterNetworkEdit("draft")).toEqual({ ok: true, to: "draft", reReview: false });
    expect(lifecycleAfterNetworkEdit("revoked")).toEqual({ ok: true, to: "revoked", reReview: false });
    expect(lifecycleAfterNetworkEdit("retired").ok).toBe(false);
  });
});

describe("who may approve, and until when", () => {
  it("not whoever requested it, nor whoever made the revision", () => {
    expect(approverRefusal({ approverUserId: 7, requestedByUserId: 7, revisionByUserId: null })).toMatch(/requested/);
    expect(approverRefusal({ approverUserId: 7, requestedByUserId: 8, revisionByUserId: 7 })).toMatch(/revision/);
    expect(approverRefusal({ approverUserId: 7, requestedByUserId: null, revisionByUserId: null })).toBeNull();
    expect(approverRefusal({ approverUserId: 7, requestedByUserId: 8, revisionByUserId: 9 })).toBeNull();
  });
  it("a review-by date in the future, within a year", () => {
    const now = new Date("2026-10-03T00:00:00Z");
    expect(reviewByRefusal(now, now)).toMatch(/future/);
    expect(reviewByRefusal(new Date(now.getTime() - 1), now)).toMatch(/future/);
    expect(reviewByRefusal(new Date(now.getTime() + (APPROVAL_MAX_DAYS + 1) * 86_400_000), now)).toMatch(/within/);
    expect(reviewByRefusal(new Date(now.getTime() + 90 * 86_400_000), now)).toBeNull();
  });
});

describe("the runtime decision fails closed", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  const source: RuntimeSource = { id: 10, sourceKey: "sk_petroleum_gis", lifecycle: "approved", revision: 3 };
  const endpoint: RuntimeEndpoint = { ...EP, id: 20, endpointRef: "sk_petroleum_gis/layer_17", externalDataSourceId: 10, enabled: true, serviceType: "arcgis_feature_server" };
  const approval: RuntimeApproval = { id: 30, state: "approved", sourceRevision: 3, expiresAt: new Date("2027-01-01T00:00:00Z"), scope: ["facility_directory.arcgis_import"] };
  const decide = (patch: { source?: Partial<RuntimeSource>; endpoint?: Partial<RuntimeEndpoint>; approval?: Partial<RuntimeApproval> | null; url?: URL; method?: "GET" | "POST" }) =>
    runtimeDecision({
      source: { ...source, ...patch.source }, endpoint: { ...endpoint, ...patch.endpoint },
      approval: patch.approval === null ? null : { ...approval, ...patch.approval },
      url: patch.url ?? at(`${EP.pathPrefix}/query`), method: patch.method, purpose: "facility_directory.arcgis_import", now: NOW,
    });

  it("passes only an approved source with a current, unexpired, in-scope approval and an enabled endpoint covering the URL", () => {
    expect(decide({})).toEqual({ ok: true, decision: { sourceId: 10, sourceKey: "sk_petroleum_gis", endpointId: 20, endpointRef: "sk_petroleum_gis/layer_17", sourceRevision: 3, approvalId: 30, purpose: "facility_directory.arcgis_import" } });
  });

  it.each([
    ["a draft source", { source: { lifecycle: "draft" as const } }, "not_approved"],
    ["a source pending approval", { source: { lifecycle: "pending_approval" as const } }, "not_approved"],
    ["a suspended source", { source: { lifecycle: "suspended" as const } }, "suspended"],
    ["a revoked source", { source: { lifecycle: "revoked" as const } }, "revoked"],
    ["a retired source", { source: { lifecycle: "retired" as const } }, "retired"],
    ["no approval", { approval: null }, "no_approval"],
    ["a proposed approval", { approval: { state: "proposed" as const } }, "no_approval"],
    ["a revoked approval", { approval: { state: "revoked" as const } }, "no_approval"],
    ["a superseded approval", { approval: { state: "superseded" as const } }, "no_approval"],
    ["an approval of an older revision", { approval: { sourceRevision: 2 } }, "approval_stale"],
    ["an expired approval", { approval: { expiresAt: new Date("2026-10-03T11:59:59Z") } }, "approval_expired"],
    ["an approval with no review-by date", { approval: { expiresAt: null } }, "approval_expired"],
    ["an approval for another purpose", { approval: { scope: ["something_else"] } }, "out_of_scope"],
    ["an endpoint of a kind the purpose does not read", { endpoint: { serviceType: "json_feed" as const } }, "out_of_scope"],
    ["a disabled endpoint", { endpoint: { enabled: false } }, "endpoint_disabled"],
    ["a URL outside the endpoint", { url: at("/arcgis/rest/services/Admin") }, "endpoint_policy"],
    ["a look-alike host", { url: at(EP.pathPrefix, "evil-example.com") }, "endpoint_policy"],
    ["another port", { url: new URL(`https://example.com:8443${EP.pathPrefix}`) }, "endpoint_policy"],
    ["another method", { method: "POST" as const }, "endpoint_policy"],
    ["another source's endpoint", { endpoint: { externalDataSourceId: 99 } }, "unregistered"],
  ])("refuses %s", (_label, patch, code) => {
    expect(decide(patch)).toMatchObject({ ok: false, code });
  });

  it("refuses a suspended source even with a valid approval: the lifecycle is checked first", () => {
    expect(decide({ source: { lifecycle: "suspended" } })).toMatchObject({ ok: false, code: "suspended" });
  });

  it("an operation pinned to a decision continues only under the same source, endpoint, revision and approval", () => {
    const d = (decide({}) as { decision: Parameters<typeof sameAuthority>[0] }).decision;
    expect(sameAuthority(d, { ...d })).toBe(true);
    expect(sameAuthority(d, { ...d, sourceRevision: 4 })).toBe(false);
    expect(sameAuthority(d, { ...d, approvalId: 31 })).toBe(false);
    expect(sameAuthority(d, { ...d, endpointId: 21 })).toBe(false);
  });
});

describe("the seeds register only what the repository already reads", () => {
  it("every seed is a valid endpoint, binds no credential, and names a seeded source", () => {
    const keys = new Set(ALL_DATA_SOURCES.map(s => s.sourceKey));
    for (const s of ENDPOINT_SEEDS) {
      const v = validateEndpoint(s.endpoint);
      expect(v.ok, `${s.sourceKey}/${s.endpoint.endpointKey}: ${v.ok ? "" : v.reasons.join("; ")}`).toBe(true);
      expect(s.endpoint.credentialRef).toBeNull();
      expect(keys.has(s.sourceKey), s.sourceKey).toBe(true);
    }
    const refs = ENDPOINT_SEEDS.map(s => `${s.sourceKey}/${s.endpoint.endpointKey}`);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("the facility layers are the importer's own preset and the BC Energy Regulator layers its spec names, enabled for review", () => {
    expect(FACILITY_LAYER_ENDPOINTS.map(s => [s.sourceKey, s.endpoint.baseUrl, s.enabled])).toEqual([
      ["sk_petroleum_gis", SK_FACILITIES.layerUrl, true],
      ["bcer_gis", "https://geoweb-ags.bc-er.ca/arcgis/rest/services/PASR/PASR_FACILITY_PT/MapServer/0", true],
      ["bcer_gis", "https://geoweb-ags.bc-er.ca/arcgis/rest/services/OPERATIONAL/SUMP_LOCATIONS_PT/MapServer/0", true],
    ]);
  });

  it("the road-information endpoints are the collector's own addresses, registered disabled with no credential", () => {
    const withEndpoint = CANADIAN_TRANSPORT_PROVIDERS.filter(p => p.endpoint);
    expect(TRANSPORT_FEED_ENDPOINTS).toHaveLength(withEndpoint.length);
    for (const p of withEndpoint) {
      const seed = TRANSPORT_FEED_ENDPOINTS.find(s => s.sourceKey === p.sourceKey)!;
      const u = new URL(p.endpoint!.url);
      expect(seed.enabled).toBe(false);
      expect(seed.endpoint.baseUrl).toBe(`${u.origin}${u.pathname}`);
      const v = validateEndpoint(seed.endpoint);
      if (!v.ok) throw new Error(v.reasons.join("; "));
      // The collector's full URL, query and all, is inside the endpoint it is registered as.
      expect(endpointRefusal(u, v.endpoint)).toBeNull();
      expect(seed.endpoint.authScheme).toBe(p.endpoint!.credentialStyle.kind === "none" ? "NONE" : "API_KEY");
    }
  });

  it("only sources with an enabled seeded endpoint are put up for review, for a purpose a runtime path checks", () => {
    for (const r of REVIEW_SEEDS) {
      expect(ENDPOINT_SEEDS.some(s => s.sourceKey === r.sourceKey && s.enabled), r.sourceKey).toBe(true);
      for (const p of r.scope) expect(REGISTRY_PURPOSES).toContain(p);
      expect(r.reason).toContain("A seed is not an approval");
    }
    expect(REVIEW_SEEDS.map(r => r.sourceKey).sort()).toEqual(["bcer_gis", "sk_petroleum_gis"]);
  });
});
