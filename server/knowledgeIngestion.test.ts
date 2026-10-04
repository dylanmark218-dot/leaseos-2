/**
 * Intelligence Engine Checkpoint 2 — collectors, robots, extraction and text-based change detection.
 *
 * No network: every collector and the robots fetcher take an injected `fetch`, and the HTML here is
 * synthetic. No publisher's text is committed as a fixture — none of the seed sources is assessed,
 * and copying one into the repository would be the reproduction the licence gate exists to prevent.
 */
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_KINDS, COLLECTORS, CollectorNotImplemented, collectorFor, crawlerIdentity, fetchRobots,
  normalizeRobotsPath, parseRobots, robotsAllows, type CollectorEnvironment,
} from "./_core/knowledge/collectors";
import { chunkSections, decodeEntities, extractHtml } from "./_core/knowledge/extraction";
import { classifyRetrieval, sha256Hex } from "./_core/knowledge/provenance";

const enc = (s: string) => new TextEncoder().encode(s);
const identity = crawlerIdentity("https://leaseos.example/crawler")!;
const now = new Date("2026-10-01T00:00:00Z");

type Reply = { status: number; headers?: Record<string, string>; body?: string | Uint8Array } | Error;
function fakeFetch(replies: Record<string, Reply | Reply[]>) {
  const calls: { url: string; headers: Record<string, string>; redirect: string }[] = [];
  const fetch: CollectorEnvironment["fetch"] = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    const entry = replies[url];
    const r: Reply | undefined = Array.isArray(entry) ? entry.shift() : entry;
    if (!r) throw new Error(`unexpected request to ${url}`);
    if (r instanceof Error) throw r;
    const h: Record<string, string> = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes: Uint8Array = typeof r.body === "string" ? enc(r.body) : r.body ?? new Uint8Array();
    return {
      status: r.status,
      headers: { get: (n: string): string | null => h[n.toLowerCase()] ?? null },
      arrayBuffer: async (): Promise<ArrayBuffer> => bytes.slice().buffer as ArrayBuffer,
    };
  };
  return { fetch, calls };
}
const env = (fetch: CollectorEnvironment["fetch"]): CollectorEnvironment => ({ fetch, now: () => now, identity });

const page = (body: string, footerDate = "2026-09-28") => `<!doctype html><html><head><title>SOR/2005-313 &mdash; HOS</title>
<script>var analytics = "${Math.random()}";</script></head><body>
<header><nav><a href="/">Home</a> <a href="/eng">English</a></nav></header>
<main>${body}
<section class="pagedetails container"><h2 class="wb-inv">Page Details</h2><dl id="wb-dtmd"><dt>Date modified: </dt><dd><time property="dateModified">${footerDate}</time></dd></dl></section>
</main><footer><p>Terms and conditions</p></footer></body></html>`;

const REG = `<h2>Scheduling</h2><h3>Daily Driving Time</h3><p>12 (1) No motor carrier shall request, require or allow a driver to drive after the driver has accumulated 13 hours of driving time in a day.</p>
<h3>Daily Off-duty Time</h3><p>14 (1) A motor carrier shall ensure that a driver takes at least 10 hours of off-duty time in a day.</p>`;

/* ------------------------------------------------------------------ */

describe("extraction keeps the rule's text and drops the page furniture", () => {
  const e = extractHtml(enc(page(REG)));

  it("splits at headings and keeps the section numbers a citation needs", () => {
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.title).toBe("SOR/2005-313 — HOS");
    expect(e.sections.map((s) => s.heading)).toEqual(["Scheduling", "Daily Driving Time", "Daily Off-duty Time"]);
    expect(e.sections[1]!.text).toMatch(/^12 \(1\) No motor carrier .* 13 hours of driving time in a day\.$/);
  });

  it("drops scripts, navigation, header, footer and the Government of Canada 'Date modified' block", () => {
    if (!e.ok) throw new Error("setup");
    for (const furniture of ["analytics", "Home", "Terms and conditions", "Page Details", "Date modified", "2026-09-28"]) {
      expect(e.text).not.toContain(furniture);
    }
  });

  it("fingerprints the same when only the furniture changed — a new footer date is not an amendment", () => {
    const a = extractHtml(enc(page(REG, "2026-09-28"))), b = extractHtml(enc(page(REG, "2026-10-01")));
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(sha256Hex(enc(page(REG, "2026-09-28")))).not.toBe(sha256Hex(enc(page(REG, "2026-10-01"))));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("fingerprints differently when one figure in the rule changes", () => {
    const amended = extractHtml(enc(page(REG.replace("13 hours", "14 hours"))));
    if (!e.ok || !amended.ok) throw new Error("setup");
    expect(amended.fingerprint).not.toBe(e.fingerprint);
  });

  it("keeps 'Last amended' — the regulation's own statement — while dropping the template's date", () => {
    const x = extractHtml(enc(page(`<p>Last amended on June 18, 2024</p>${REG}`)));
    if (!x.ok) throw new Error("setup");
    expect(x.text).toContain("Last amended on June 18, 2024");
  });

  it("reads <body> when there is no <main>, and decodes entities", () => {
    const x = extractHtml(enc("<html><body><h1>T</h1><p>s.&nbsp;12 &amp; s.&#160;14 &sect;&#x41;</p></body></html>"));
    expect(x).toMatchObject({ ok: true, text: "T\ns. 12 & s. 14 §A" });
    expect(decodeEntities("&bogus; &#0;")).toBe("&bogus; &#0;");
  });

  it("fails rather than guesses on bytes that are not a page", () => {
    expect(extractHtml(new Uint8Array([0xff, 0xfe, 0xfd]))).toMatchObject({ ok: false, error: /UTF-8/ });
    expect(extractHtml(enc("a\u0000b"))).toMatchObject({ ok: false, error: /NUL/ });
    expect(extractHtml(enc("<html><body><script>x()</script><nav>menu</nav></body></html>"))).toMatchObject({ ok: false, error: /no text/ });
  });
});

describe("chunking", () => {
  it("never spans two sections, and labels each chunk with its heading", () => {
    const e = extractHtml(enc(page(REG)));
    if (!e.ok) throw new Error("setup");
    const chunks = chunkSections(e.sections);
    expect(chunks.map((c) => c.section)).toEqual(["Daily Driving Time", "Daily Off-duty Time"]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });

  it("respects the size limit on paragraph boundaries and splits an over-long line between words", () => {
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(40)}`.trim();
    const chunks = chunkSections([{ heading: "H", level: 2, text: [1, 2, 3, 4, 5, 6].map(para).join("\n") }], 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) { expect(c.text.length).toBeLessThanOrEqual(500); expect(c.text.startsWith("Paragraph")).toBe(true); }
    const long = chunkSections([{ heading: null, level: 0, text: "alpha ".repeat(400).trim() }], 300);
    for (const c of long) { expect(c.text.length).toBeLessThanOrEqual(300); expect(c.text).toMatch(/^alpha( alpha)*$/); }
  });
});

describe("change detection compares text, not bytes", () => {
  const fp = sha256Hex("the extracted text");

  it("same text in different bytes is unchanged, and the raw hash is still kept as provenance", () => {
    const r = classifyRetrieval(fp, { httpStatus: 200, body: "<p>new footer</p>" }, { status: "extracted", fingerprint: fp });
    expect(r).toMatchObject({ outcome: "unchanged", newVersion: false, fingerprint: fp, fingerprintBasis: "extracted_text", sha256: sha256Hex("<p>new footer</p>") });
  });

  it("different text is changed", () => {
    expect(classifyRetrieval(fp, { httpStatus: 200, body: "x" }, { status: "extracted", fingerprint: sha256Hex("amended") }))
      .toMatchObject({ outcome: "changed", newVersion: true });
  });

  it("a failed parse is unparseable: the bytes are evidence, but there is no basis for a new version", () => {
    expect(classifyRetrieval(fp, { httpStatus: 200, body: "garbled" }, { status: "failed" }))
      .toMatchObject({ outcome: "unparseable", newVersion: false, fingerprint: null, sha256: sha256Hex("garbled") });
    expect(classifyRetrieval(fp, { httpStatus: 200, body: "x" }, { status: "extracted", fingerprint: "not-a-hash" }).outcome).toBe("unparseable");
  });

  it("bytes that fail their hash are refused before the parser's opinion is considered", () => {
    expect(classifyRetrieval(null, { httpStatus: 200, body: "x", declaredSha256: sha256Hex("y") }, { status: "extracted", fingerprint: fp }).outcome)
      .toBe("hash_mismatch");
  });

  it("without a parser, the raw bytes are the fingerprint, as before", () => {
    expect(classifyRetrieval(null, { httpStatus: 200, body: "pdf bytes" })).toMatchObject({ fingerprint: sha256Hex("pdf bytes"), fingerprintBasis: "raw_bytes" });
  });
});

/* ------------------------------------------------------------------ */

describe("robots.txt paths are compared as octets (RFC 9309 §2.2.2)", () => {
  it("normalises escapes and non-ASCII", () => {
    expect(normalizeRobotsPath("/%7euser/%2fx")).toBe("/~user/%2Fx");
    expect(normalizeRobotsPath("/règlement")).toBe("/r%C3%A8glement");
    expect(normalizeRobotsPath("/bad%zz")).toBe("/bad%zz");
  });

  it("an encoded rule blocks the decoded path and the other way round", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /%7Eprivate/\nDisallow: /règlements/");
    expect(robotsAllows(robots, "x", "/~private/a")).toBe(false);
    expect(robotsAllows(robots, "x", "/%7eprivate/a")).toBe(false);
    expect(robotsAllows(robots, "x", "/r%C3%A8glements/1")).toBe(false);
    expect(robotsAllows(robots, "x", "/public")).toBe(true);
  });
});

describe("fetching robots.txt", () => {
  const domains = ["laws-lois.justice.gc.ca"];
  const R = "https://laws-lois.justice.gc.ca/robots.txt";

  it("parses a 200, and identifies itself", async () => {
    const f = fakeFetch({ [R]: { status: 200, body: "User-agent: *\nDisallow: /search" } });
    const s = await fetchRobots("laws-lois.justice.gc.ca", domains, env(f.fetch));
    expect(s.status).toBe("fetched");
    if (s.status === "fetched") expect(robotsAllows(s.file, "LeaseOSIntelligenceBot", "/search")).toBe(false);
    expect(f.calls[0]).toMatchObject({ redirect: "manual", headers: { "User-Agent": identity.userAgent } });
  });

  it("reads 4xx as no restrictions and 5xx or no answer as disallow-all", async () => {
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(fakeFetch({ [R]: { status: 404 } }).fetch))).status).toBe("absent");
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(fakeFetch({ [R]: { status: 503 } }).fetch))).status).toBe("unreachable");
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(fakeFetch({ [R]: new Error("ECONNRESET") }).fetch))).status).toBe("unreachable");
  });

  it("follows a redirect within the source's domains, and treats one elsewhere as unreachable", async () => {
    const inside = fakeFetch({
      [R]: { status: 301, headers: { location: "/robots-new.txt" } },
      "https://laws-lois.justice.gc.ca/robots-new.txt": { status: 200, body: "User-agent: *\nDisallow:" },
    });
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(inside.fetch))).status).toBe("fetched");
    const outside = fakeFetch({ [R]: { status: 302, headers: { location: "https://evil.example/robots.txt" } } });
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(outside.fetch))).status).toBe("unreachable");
    expect(outside.calls).toHaveLength(1);
  });

  it("gives up after five redirects", async () => {
    const f = fakeFetch({ [R]: Array.from({ length: 10 }, () => ({ status: 302, headers: { location: R } })) });
    expect((await fetchRobots("laws-lois.justice.gc.ca", domains, env(f.fetch))).status).toBe("unreachable");
    expect(f.calls).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */

describe("the HTTP collectors", () => {
  const URL0 = "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/";
  const req = { sourceId: "s", documentRef: "d", url: URL0, maxBytes: 1000 };
  const html = { "content-type": "text/html; charset=utf-8" };

  it("HtmlCrawler and PdfCollector are built; the other six still refuse", async () => {
    expect(COLLECTOR_KINDS.filter((k) => COLLECTORS[k].implemented)).toEqual(["html", "pdf"]);
    for (const k of COLLECTOR_KINDS.filter((k) => !COLLECTORS[k].implemented)) {
      await expect(collectorFor(k).collect(req, env(fakeFetch({}).fetch))).rejects.toBeInstanceOf(CollectorNotImplemented);
    }
  });

  it("retains the body with its recomputed hash, and sends identity and validators", async () => {
    const f = fakeFetch({ [URL0]: { status: 200, headers: { ...html, etag: "\"v2\"" }, body: "<p>ok</p>" } });
    const r = await collectorFor("html").collect({ ...req, ifNoneMatch: "\"v1\"", ifModifiedSince: "Tue, 01 Sep 2026 00:00:00 GMT" }, env(f.fetch));
    expect(r).toMatchObject({ httpStatus: 200, etag: "\"v2\"", declaredSha256: sha256Hex("<p>ok</p>"), collectorKind: "html" });
    expect(f.calls[0]).toMatchObject({ redirect: "manual", headers: {
      "User-Agent": identity.userAgent, "If-None-Match": "\"v1\"", "If-Modified-Since": "Tue, 01 Sep 2026 00:00:00 GMT" } });
  });

  it("reports a redirect instead of following it", async () => {
    const f = fakeFetch({ [URL0]: { status: 302, headers: { location: "https://login.example/" } } });
    const r = await collectorFor("html").collect(req, env(f.fetch));
    expect(r.body).toBeUndefined();
    expect(r.note).toMatch(/redirect to https:\/\/login\.example\/ not followed/);
    expect(f.calls).toHaveLength(1);
  });

  it("stops on access control and keeps nothing", async () => {
    for (const status of [401, 402, 403, 407]) {
      const r = await collectorFor("html").collect(req, env(fakeFetch({ [URL0]: { status, headers: html, body: "<p>please log in</p>" } }).fetch));
      expect(r).toMatchObject({ httpStatus: status, note: "stop_access_controlled" });
      expect(r.body).toBeUndefined();
    }
  });

  it("refuses a login page served where a PDF was expected", async () => {
    const r = await collectorFor("pdf").collect(req, env(fakeFetch({ [URL0]: { status: 200, headers: html, body: "<form>sign in</form>" } }).fetch));
    expect(r.body).toBeUndefined();
    expect(r.note).toMatch(/content type "text\/html" is not application\/pdf/);
  });

  it("enforces the byte ceiling from the header and again from the bytes", async () => {
    const big = fakeFetch({ [URL0]: { status: 200, headers: { ...html, "content-length": "5000" }, body: "<p>x</p>" } });
    expect((await collectorFor("html").collect(req, env(big.fetch))).note).toMatch(/Content-Length 5000 exceeds/);
    const lying = fakeFetch({ [URL0]: { status: 200, headers: { ...html, "content-length": "10" }, body: "y".repeat(2000) } });
    const r = await collectorFor("html").collect(req, env(lying.fetch));
    expect(r.body).toBeUndefined();
    expect(r.note).toMatch(/body of 2000 bytes exceeds/);
  });

  it("turns a network failure into a result, not a throw", async () => {
    const r = await collectorFor("html").collect(req, env(fakeFetch({ [URL0]: new Error("ETIMEDOUT") }).fetch));
    expect(r).toMatchObject({ httpStatus: null, note: "network failure: ETIMEDOUT" });
  });

  it("a 304 carries no body and is not an error", async () => {
    const r = await collectorFor("html").collect(req, env(fakeFetch({ [URL0]: { status: 304 } }).fetch));
    expect(r.httpStatus).toBe(304);
    expect(r.body).toBeUndefined();
    expect(r.note).toBeUndefined();
  });
});
