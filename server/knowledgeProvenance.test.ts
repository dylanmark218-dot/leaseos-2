/**
 * Intelligence Engine Checkpoint 1 — the provenance rules, adversarially.
 *
 * Each block is one way a knowledge corpus goes wrong in practice. The rules
 * are pure, so every case runs without a database; the repository suite
 * (`knowledgeProvenance.db.test.ts`) proves the same rules hold against tables.
 */
import { describe, expect, it } from "vitest";
import {
  classifyRetrieval, jurisdictionFit, resolveClaims, scopeHits, sha256Hex, validateSourceUrl, versionInForce,
  type Claim, type ScopedHit, type VersionWindow,
} from "./_core/knowledge/provenance";
import {
  AUTHORITY_TIERS, INDUSTRY_TOPICS, levelsInTier, tierOf, validateTopics,
} from "./_core/knowledge/industryTaxonomy";
import { AUTHORITY_LEVELS, outranks } from "./_core/knowledge/admission";
import {
  COLLECTOR_KINDS, COLLECTORS, DEFAULT_CRAWL_POLICY, accessSignal,
  crawlerIdentity, decideFetch, parseRobots, robotsAllows, type FetchSubject, type RobotsState,
} from "./_core/knowledge/collectors";
import { SEED_CATALOGUE, validateCatalogueEntry, type CatalogueEntry } from "./_core/knowledge/sourceCatalogue";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

/* ------------------------------------------------------------------ */

describe("duplicate content", () => {
  const body = "Section 12. No motor carrier shall request...";
  const h = sha256Hex(body);

  it("an identical re-retrieval confirms the version rather than creating one", () => {
    const r = classifyRetrieval(h, { httpStatus: 200, body });
    expect(r).toMatchObject({ outcome: "unchanged", sha256: h, newVersion: false });
  });

  it("a 304 against a known version is unchanged; a 304 with nothing known is not evidence of anything", () => {
    expect(classifyRetrieval(h, { httpStatus: 304 })).toMatchObject({ outcome: "unchanged", newVersion: false });
    expect(classifyRetrieval(null, { httpStatus: 304 })).toMatchObject({ outcome: "unavailable", newVersion: false });
  });

  it("the first retrieval is first_seen and makes a version", () => {
    expect(classifyRetrieval(null, { httpStatus: 200, body })).toMatchObject({ outcome: "first_seen", newVersion: true, sha256: h });
  });
});

describe("changed content under the same URL", () => {
  it("is a new version, identified by the hash of the new bytes", () => {
    const r = classifyRetrieval(sha256Hex("old text"), { httpStatus: 200, body: "new text" });
    expect(r).toMatchObject({ outcome: "changed", newVersion: true, sha256: sha256Hex("new text") });
  });

  it("a one-byte change is a change — no normalisation hides an edit to a regulation", () => {
    const r = classifyRetrieval(sha256Hex("13 hours"), { httpStatus: 200, body: "13 hours " });
    expect(r.outcome).toBe("changed");
  });
});

describe("hash mismatch", () => {
  const body = new TextEncoder().encode("the bytes actually held");

  it("refuses the collector's hash when it does not match the bytes, and produces no version", () => {
    const r = classifyRetrieval(null, { httpStatus: 200, body, declaredSha256: sha256Hex("something else") });
    expect(r).toMatchObject({ outcome: "hash_mismatch", sha256: null, newVersion: false });
  });

  it("refuses a malformed declared hash rather than ignoring it", () => {
    expect(classifyRetrieval(null, { httpStatus: 200, body, declaredSha256: "not-a-hash" }).outcome).toBe("hash_mismatch");
  });

  it("accepts a matching declaration in either case", () => {
    expect(classifyRetrieval(null, { httpStatus: 200, body, declaredSha256: sha256Hex(body).toUpperCase() }).outcome).toBe("first_seen");
  });

  it("a mismatch never masquerades as 'unchanged' even when the declared hash equals the previous one", () => {
    const prev = sha256Hex("the previous version");
    expect(classifyRetrieval(prev, { httpStatus: 200, body, declaredSha256: prev }).outcome).toBe("hash_mismatch");
  });
});

describe("deleted or unavailable source", () => {
  it("a 404, a 500 or no response is unavailable and never a new version", () => {
    for (const httpStatus of [404, 410, 500, null]) {
      expect(classifyRetrieval(sha256Hex("x"), { httpStatus, body: "error page" })).toMatchObject({ outcome: "unavailable", newVersion: false, sha256: null });
    }
  });

  it("a 200 with no retained body is unavailable, not an empty document", () => {
    expect(classifyRetrieval(null, { httpStatus: 200 }).outcome).toBe("unavailable");
  });

  it("an unavailable retrieval leaves the version in force exactly as it was", () => {
    const versions: VersionWindow[] = [{ versionRef: "v1", effectiveFrom: d("2020-01-01"), effectiveUntil: null }];
    // The retrieval failed; nothing is added. The rule is still in force.
    expect(versionInForce(versions, d("2026-09-25"))).toMatchObject({ status: "in_force", version: { versionRef: "v1" } });
  });

  it("a retired source is never fetched", () => {
    expect(decide({ subject: { ...subject, active: false } })).toMatchObject({ allowed: false, code: "SOURCE_INACTIVE" });
  });
});

describe("superseded regulations", () => {
  const versions: VersionWindow[] = [
    { versionRef: "2019-edition", effectiveFrom: d("2019-06-01"), effectiveUntil: null },
    { versionRef: "2026-edition", effectiveFrom: d("2026-06-04"), effectiveUntil: null, supersedesVersionRef: "2019-edition" },
  ];

  it("answers 'what is the rule now' with the new edition", () => {
    expect(versionInForce(versions, d("2026-09-25"))).toMatchObject({ status: "in_force", version: { versionRef: "2026-edition" } });
  });

  it("answers 'what applied to this trip in March 2025' with the old one", () => {
    expect(versionInForce(versions, d("2025-03-15"))).toMatchObject({ status: "in_force", version: { versionRef: "2019-edition" } });
  });

  it("a released-but-not-yet-effective edition does not govern before its effective date", () => {
    expect(versionInForce(versions, d("2026-03-05"))).toMatchObject({ status: "in_force", version: { versionRef: "2019-edition" } });
  });

  it("before the first edition, nothing was in force", () => {
    expect(versionInForce(versions, d("2010-01-01")).status).toBe("none");
  });

  it("two overlapping editions with no supersession link are ambiguous, not 'the newer one'", () => {
    const overlapping: VersionWindow[] = [
      { versionRef: "a", effectiveFrom: d("2020-01-01"), effectiveUntil: null },
      { versionRef: "b", effectiveFrom: d("2024-01-01"), effectiveUntil: null },
    ];
    expect(versionInForce(overlapping, d("2025-01-01"))).toMatchObject({ status: "ambiguous", candidates: ["a", "b"] });
  });

  it("an explicit effectiveUntil ends a version even with no successor", () => {
    const repealed: VersionWindow[] = [{ versionRef: "r", effectiveFrom: d("2020-01-01"), effectiveUntil: d("2023-01-01") }];
    expect(versionInForce(repealed, d("2024-01-01")).status).toBe("none");
    expect(versionInForce(repealed, d("2022-12-31")).status).toBe("in_force");
  });
});

describe("missing effective date", () => {
  it("an undated current version makes the answer unknown rather than 'always'", () => {
    const v: VersionWindow[] = [{ versionRef: "undated", effectiveFrom: null, effectiveUntil: null }];
    expect(versionInForce(v, d("2026-01-01"))).toMatchObject({ status: "effective_date_unknown", undated: ["undated"] });
  });

  it("an undated draft beside a dated edition still refuses — the draft might be what is in force", () => {
    const v: VersionWindow[] = [
      { versionRef: "dated", effectiveFrom: d("2020-01-01"), effectiveUntil: null },
      { versionRef: "draft", effectiveFrom: null, effectiveUntil: null },
    ];
    expect(versionInForce(v, d("2026-01-01")).status).toBe("effective_date_unknown");
  });

  it("an undated version that a dated one superseded no longer blocks the answer", () => {
    const v: VersionWindow[] = [
      { versionRef: "old-undated", effectiveFrom: null, effectiveUntil: null },
      { versionRef: "new", effectiveFrom: d("2024-01-01"), effectiveUntil: null, supersedesVersionRef: "old-undated" },
    ];
    expect(versionInForce(v, d("2026-01-01"))).toMatchObject({ status: "in_force", version: { versionRef: "new" } });
  });

  it("a claim with no effective date cannot prevail", () => {
    const r = resolveClaims([claim({ claimRef: "c", effectiveFrom: null })], { jurisdiction: "CA-AB", at: d("2026-01-01") });
    expect(r.prevailing).toBeNull();
    expect(r.excluded[0]!.reason).toMatch(/no effective date/);
  });
});

describe("jurisdiction mismatch", () => {
  it("a BC rule does not govern Alberta", () => {
    expect(jurisdictionFit("CA-BC", "CA-AB").fit).toBe("mismatch");
  });

  it("a provincial rule does not govern the federal regime", () => {
    expect(jurisdictionFit("CA-AB", "CA-FEDERAL").fit).toBe("mismatch");
  });

  it("federal material is conditional for a province — operating status decides, not the document", () => {
    const f = jurisdictionFit("CA-FEDERAL", "CA-AB");
    expect(f.fit).toBe("conditional");
  });

  it("a US federal rule is not conditional for a Canadian province", () => {
    expect(jurisdictionFit("US-FEDERAL", "CA-AB").fit).toBe("mismatch");
  });

  it("an empty jurisdiction is not 'everywhere'", () => {
    expect(jurisdictionFit("", "CA-AB").fit).toBe("mismatch");
  });

  it("an out-of-jurisdiction claim is excluded, not treated as a contradiction", () => {
    const r = resolveClaims([
      claim({ claimRef: "ab", value: "13", jurisdiction: "CA-AB" }),
      claim({ claimRef: "bc", value: "12", jurisdiction: "CA-BC" }),
    ], { jurisdiction: "CA-AB", at: d("2026-01-01") });
    expect(r.prevailing?.claimRef).toBe("ab");
    expect(r.needsReview).toBe(false);
    expect(r.excluded.map((e) => e.claim.claimRef)).toEqual(["bc"]);
  });

  it("a directly applicable provincial claim is preferred to conditional federal material", () => {
    const r = resolveClaims([
      claim({ claimRef: "fed", value: "13", jurisdiction: "CA-FEDERAL", authorityLevel: "law" }),
      claim({ claimRef: "ab", value: "15", jurisdiction: "CA-AB", authorityLevel: "law" }),
    ], { jurisdiction: "CA-AB", at: d("2026-01-01") });
    expect(r.prevailing?.claimRef).toBe("ab");
    expect(r.conditional).toBe(false);
  });

  it("federal-only material prevails but is marked conditional", () => {
    const r = resolveClaims([claim({ claimRef: "fed", jurisdiction: "CA-FEDERAL" })], { jurisdiction: "CA-AB", at: d("2026-01-01") });
    expect(r).toMatchObject({ prevailing: { claimRef: "fed" }, conditional: true });
  });
});

describe("lower-authority contradiction", () => {
  const ctx = { jurisdiction: "CA-AB", at: d("2026-01-01") };

  it("a forum post never overrides the regulation, and the disagreement is flagged", () => {
    const r = resolveClaims([
      claim({ claimRef: "reg", value: "13", authorityLevel: "law" }),
      claim({ claimRef: "forum", value: "14", authorityLevel: "unverified" }),
    ], ctx);
    expect(r.prevailing?.claimRef).toBe("reg");
    expect(r.lowerAuthorityContradictions.map((c) => c.claimRef)).toEqual(["forum"]);
    expect(r.needsReview).toBe(true);
  });

  it("order of arrival does not matter — the lower claim listed first still loses", () => {
    const r = resolveClaims([
      claim({ claimRef: "guide", value: "14", authorityLevel: "official_guidance" }),
      claim({ claimRef: "reg", value: "13", authorityLevel: "law" }),
    ], ctx);
    expect(r.prevailing?.claimRef).toBe("reg");
  });

  it("a newer lower-authority source does not override an older higher one", () => {
    const r = resolveClaims([
      claim({ claimRef: "reg-2019", value: "13", authorityLevel: "law", effectiveFrom: d("2019-01-01") }),
      claim({ claimRef: "company-2025", value: "16", authorityLevel: "company_policy", effectiveFrom: d("2025-01-01") }),
    ], ctx);
    expect(r.prevailing?.claimRef).toBe("reg-2019");
  });

  it("agreement from below is not a contradiction", () => {
    const r = resolveClaims([
      claim({ claimRef: "reg", value: "13", authorityLevel: "law" }),
      claim({ claimRef: "guide", value: "13", authorityLevel: "official_guidance" }),
    ], ctx);
    expect(r).toMatchObject({ needsReview: false, lowerAuthorityContradictions: [] });
  });

  it("two equal authorities that disagree resolve to nobody, and go to a person", () => {
    const r = resolveClaims([
      claim({ claimRef: "a", value: "13", authorityLevel: "law" }),
      claim({ claimRef: "b", value: "14", authorityLevel: "law", effectiveFrom: d("2024-01-01") }),
    ], ctx);
    expect(r).toMatchObject({ prevailing: null, needsReview: true });
  });

  it("claims about different facts are refused as a set", () => {
    const r = resolveClaims([claim({ claimRef: "a" }), claim({ claimRef: "b", subject: "tdg.class" })], ctx);
    expect(r).toMatchObject({ prevailing: null, needsReview: true });
  });

  it("the A–E tiers agree with the level ranking in every pair", () => {
    const tierRank = (t: string) => AUTHORITY_TIERS.indexOf(t as never);
    for (const a of AUTHORITY_LEVELS) for (const b of AUTHORITY_LEVELS) {
      if (outranks(a, b)) expect(tierRank(tierOf(a))).toBeLessThanOrEqual(tierRank(tierOf(b)));
    }
    expect(levelsInTier("A")).toEqual(["law"]);
    expect(levelsInTier("E")).toEqual(["unverified"]);
  });
});

describe("malformed and untrusted URLs", () => {
  const domains = ["laws-lois.justice.gc.ca"];
  const bad: [string, string][] = [
    ["", "MALFORMED_URL"],
    [" https://laws-lois.justice.gc.ca/", "MALFORMED_URL"],
    ["not a url", "MALFORMED_URL"],
    ["http://laws-lois.justice.gc.ca/eng/", "INSECURE_SCHEME"],
    ["ftp://laws-lois.justice.gc.ca/x", "INSECURE_SCHEME"],
    ["javascript:alert(1)", "INSECURE_SCHEME"],
    ["file:///etc/passwd", "INSECURE_SCHEME"],
    ["https://user:pw@laws-lois.justice.gc.ca/", "EMBEDDED_CREDENTIALS"],
    ["https://laws-lois.justice.gc.ca:8443/", "NON_DEFAULT_PORT"],
    ["https://127.0.0.1/", "IP_LITERAL_HOST"],
    ["https://169.254.169.254/latest/meta-data/", "IP_LITERAL_HOST"],
    ["https://[::1]/", "IP_LITERAL_HOST"],
    ["https://2130706433/", "IP_LITERAL_HOST"],
    ["https://localhost/", "LOCAL_OR_INTERNAL_HOST"],
    ["https://intranet/", "LOCAL_OR_INTERNAL_HOST"],
    ["https://metadata.google.internal/", "LOCAL_OR_INTERNAL_HOST"],
    // A Unicode lookalike of the publisher: the URL parser turns it into an xn-- label.
    ["https://laws-lois.jüstice.gc.ca/", "PUNYCODE_HOST"],
    ["https://laws-lois.justice.gc.ca.evil.example/", "OUTSIDE_SOURCE_DOMAIN"],
    ["https://evil-laws-lois.justice.gc.ca.example/", "OUTSIDE_SOURCE_DOMAIN"],
    ["https://justice.gc.ca/", "OUTSIDE_SOURCE_DOMAIN"],
    [`https://laws-lois.justice.gc.ca/${"a".repeat(1000)}`, "URL_TOO_LONG"],
  ];
  it.each(bad)("refuses %s", (url, code) => {
    const v = validateSourceUrl(url, domains);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it("accepts the publisher's own URL and drops the fragment", () => {
    const v = validateSourceUrl("https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/page-2.html#h-12", domains);
    expect(v).toMatchObject({ ok: true, url: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/page-2.html" });
  });

  it("refuses everything when the source declared no domains", () => {
    expect(validateSourceUrl("https://laws-lois.justice.gc.ca/", []).ok).toBe(false);
  });
});

describe("cross-tenant retrieval", () => {
  type H = ScopedHit & { text: string };
  const hits: H[] = [
    { ref: "pub-1", corpus: "public_industry", text: "SOR/2005-313 s.12" },
    { ref: "acme-policy", corpus: "organization", tenantId: "org-acme", text: "Acme's own HOS policy" },
    { ref: "rival-policy", corpus: "organization", tenantId: "org-rival", text: "Rival's rates" },
    { ref: "orphan", corpus: "organization", tenantId: null, text: "an owner-less private row" },
  ];

  it("an actor sees the public corpus and their own organization only", () => {
    const r = scopeHits(hits, { tenantId: "org-acme" });
    expect(r.visible.map((h) => h.ref)).toEqual(["pub-1", "acme-policy"]);
    expect(r.refused.map((h) => h.ref)).toEqual(["rival-policy", "orphan"]);
  });

  it("an actor with no tenant sees no organization material at all", () => {
    expect(scopeHits(hits, { tenantId: null }).visible.map((h) => h.ref)).toEqual(["pub-1"]);
  });

  it("an owner-less private row is never shown, even to an actor with no tenant", () => {
    expect(scopeHits(hits, { tenantId: null }).refused.map((h) => h.ref)).toContain("orphan");
  });

  it("organization material cannot be registered into the public corpus", () => {
    const leaked = { ...SEED_CATALOGUE[0]!, sourceId: "acme-sop", tenantId: "org-acme" } as CatalogueEntry;
    expect(validateCatalogueEntry(leaked)).toMatchObject({ ok: false, code: "PRIVATE_MATERIAL" });
  });
});

/* ------------------------------------------------------------------ */

describe("the taxonomy", () => {
  it("covers every topic group the brief named", () => {
    for (const t of ["hos_eld", "nsc", "cvip", "tdg", "whmis", "ohs", "driver_licensing", "inspections", "permits",
      "vehicle_maintenance", "weights_dimensions", "road_restrictions", "road_511", "dangerous_goods", "emergency_response",
      "oilfield_operations", "vacuum_hydrovac", "water_hauling", "wells_rigs_leases_lsd", "waste_classification",
      "disposal_facilities", "disposal_tickets", "aer_petrinex", "environmental_compliance", "accounting", "gst_hst",
      "payroll", "expenses", "fuel", "invoicing", "fleet_cost", "job_costing"]) {
      expect(t in INDUSTRY_TOPICS, t).toBe(true);
    }
  });

  it("refuses an unknown topic and an empty list, and collapses duplicates", () => {
    expect(validateTopics(["hos_eld", "hours_of_servce"])).toMatchObject({ ok: false, unknown: ["hours_of_servce"] });
    expect(validateTopics([]).ok).toBe(false);
    expect(validateTopics(["tdg", "tdg"])).toEqual({ ok: true, topics: ["tdg"] });
  });
});

describe("the seed catalogue", () => {
  it("holds the six Checkpoint 1 sources, each well-formed", () => {
    expect(SEED_CATALOGUE.map((e) => e.sourceId)).toEqual([
      "ca-justice-sor-2005-313", "ab-tec-commercial-carriers", "ab-tec-carrier-requirements",
      "aer-directive-047", "aer-directive-058", "aer-st107",
    ]);
    for (const e of SEED_CATALOGUE) expect(validateCatalogueEntry(e), e.sourceId).toEqual({ ok: true });
  });

  it("never scopes a seed to a parent domain that also hosts the blocked 511 source", () => {
    for (const e of SEED_CATALOGUE) {
      expect(e.domains).not.toContain("alberta.ca");
      expect(validateSourceUrl("https://511.alberta.ca/api/v2/get/event", e.domains).ok).toBe(false);
    }
  });

  it("carries no effective dates and no licence — those come from retrieval and assessment", () => {
    for (const e of SEED_CATALOGUE) {
      const keys = Object.keys(e);
      expect(keys.some((k) => /effective|licenceStatus|authorized/i.test(k))).toBe(false);
    }
  });

  it("does not collide with an existing licence-registry id", () => {
    expect(SEED_CATALOGUE.map((e) => e.sourceId)).not.toContain("gov-ab-511");
  });
});

describe("robots.txt (RFC 9309)", () => {
  const robots = parseRobots([
    "User-agent: *",
    "Disallow: /private/",
    "Allow: /private/public-notice",
    "",
    "User-agent: LeaseOSIntelligenceBot",
    "User-agent: otherbot",
    "Disallow: /eng/search",
    "Disallow: /*.pdf$",
    "Crawl-delay: 30   # ignored: not in the RFC",
  ].join("\n"));

  it("uses the group naming the crawler, case-insensitively, instead of the * group", () => {
    expect(robotsAllows(robots, "leaseosintelligencebot", "/private/x")).toBe(true);
    expect(robotsAllows(robots, "LeaseOSIntelligenceBot", "/eng/search?q=hos")).toBe(false);
  });

  it("falls back to * for an unnamed crawler, and longest match wins with allow on ties", () => {
    expect(robotsAllows(robots, "someone", "/private/x")).toBe(false);
    expect(robotsAllows(robots, "someone", "/private/public-notice")).toBe(true);
  });

  it("supports * and $ in patterns", () => {
    expect(robotsAllows(robots, "LeaseOSIntelligenceBot", "/docs/d047.pdf")).toBe(false);
    expect(robotsAllows(robots, "LeaseOSIntelligenceBot", "/docs/d047.pdf?download=1")).toBe(true);
  });

  it("always permits /robots.txt, and an empty file restricts nothing", () => {
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /"), "x", "/robots.txt")).toBe(true);
    expect(robotsAllows(parseRobots(""), "x", "/anything")).toBe(true);
  });

  it("an empty Disallow means nothing is disallowed", () => {
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:"), "x", "/a")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

const subject: FetchSubject = {
  sourceId: "ca-justice-sor-2005-313", active: true, domains: ["laws-lois.justice.gc.ca"],
  accessControlled: false, licence: "assessed", policy: DEFAULT_CRAWL_POLICY,
};
const now = d("2026-09-25");
const identity = crawlerIdentity("https://leaseos.example/crawler");
const robotsOk: RobotsState = { status: "absent", fetchedAt: now };

function decide(over: Partial<Parameters<typeof decideFetch>[0]> = {}) {
  return decideFetch({
    subject, url: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/", identity,
    robots: robotsOk, now, lastRequestAt: null, inFlight: 0, ...over,
  });
}

describe("the fetch decision fails closed", () => {
  it("allows a well-behaved request and identifies the crawler", () => {
    const r = decide();
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.userAgent).toMatch(/^LeaseOSIntelligenceBot\/[\d.]+ \(\+https:\/\/leaseos\.example\/crawler\)$/);
  });

  it("refuses a source with no licence assessment, or a prohibited one", () => {
    expect(decide({ subject: { ...subject, licence: "none" } })).toMatchObject({ code: "NO_LICENCE_ASSESSMENT" });
    expect(decide({ subject: { ...subject, licence: "prohibited" } })).toMatchObject({ code: "PROHIBITED_SOURCE" });
  });

  it("never fetches behind a login, paywall or challenge", () => {
    expect(decide({ subject: { ...subject, accessControlled: true } })).toMatchObject({ code: "ACCESS_CONTROLLED" });
  });

  it("will not run anonymously", () => {
    expect(decide({ identity: null })).toMatchObject({ code: "NO_CRAWLER_IDENTITY" });
    expect(crawlerIdentity("http://insecure.example")).toBeNull();
    expect(crawlerIdentity("")).toBeNull();
  });

  it("treats unchecked, stale and unreachable robots.txt as no", () => {
    expect(decide({ robots: { status: "unchecked" } })).toMatchObject({ code: "ROBOTS_UNCHECKED" });
    expect(decide({ robots: { status: "absent", fetchedAt: d("2026-09-23") } })).toMatchObject({ code: "ROBOTS_STALE" });
    expect(decide({ robots: { status: "unreachable", fetchedAt: now } })).toMatchObject({ code: "ROBOTS_UNREACHABLE" });
  });

  it("honours a disallow for the crawler's own token", () => {
    const file = parseRobots("User-agent: LeaseOSIntelligenceBot\nDisallow: /eng/regulations/");
    expect(decide({ robots: { status: "fetched", fetchedAt: now, file } })).toMatchObject({ code: "ROBOTS_DISALLOWED" });
  });

  it("refuses an off-domain URL even from an assessed source", () => {
    expect(decide({ url: "https://www.canlii.org/en/ca/laws/regu/sor-2005-313/" })).toMatchObject({ code: "OUTSIDE_SOURCE_DOMAIN" });
  });

  it("enforces the per-source delay and concurrency", () => {
    const r = decide({ lastRequestAt: new Date(now.getTime() - 4_000) });
    expect(r).toMatchObject({ allowed: false, code: "RATE_LIMITED", retryAfterMs: 6_000 });
    expect(decide({ inFlight: 1 })).toMatchObject({ code: "CONCURRENCY_LIMIT" });
  });

  it("treats access-control answers as a stop, not a retry", () => {
    for (const s of [401, 402, 403, 407]) expect(accessSignal(s)).toBe("stop_access_controlled");
    expect(accessSignal(429)).toBe("back_off");
    expect(accessSignal(200)).toBe("ok");
  });
});

describe("collectors are declared by name", () => {
  // Which of them are built, and that the rest refuse, is knowledgeIngestion.test.ts's job since Checkpoint 2.
  it("names all eight", () => {
    expect(COLLECTOR_KINDS.map((k) => COLLECTORS[k].name)).toEqual([
      "ApiIngestor", "HtmlCrawler", "PdfCollector", "BrowserCrawler",
      "GeoDataIngestor", "SitemapCrawler", "RssWatcher", "CommonCrawlImporter",
    ]);
  });
});

/* ------------------------------------------------------------------ */

function claim(over: Partial<Claim> & { claimRef: string }): Claim {
  return {
    subject: "hos.daily_driving_limit_hours", value: "13", authorityLevel: "law", jurisdiction: "CA-AB",
    effectiveFrom: d("2019-01-01"), effectiveUntil: null, ...over,
  };
}
