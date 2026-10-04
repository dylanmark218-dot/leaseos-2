/**
 * Intelligence Engine Checkpoint 2 — one ingestion run, end to end, against real tables.
 *
 * Every request goes to an injected fake; nothing leaves the machine. The sources are synthetic
 * and licensed by the test seam, because no real source has an assessment — the seeds are
 * exercised only to prove that they are refused without a single request.
 *
 * The centre of the suite is the loop the engine exists for: a rule is promoted from a verified
 * source revision, the publisher amends the page, the next run detects it, and the rule appears
 * in `rulesOnStaleSources` for a person to re-read — while a run where only the page's footer
 * date moved does nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { __clearTestAssessments, __registerAssessmentForTest, type SourceLicenceRecord } from "./_core/knowledge/sourceGate";
import { registerCatalogueEntry, versionHistory } from "./_core/knowledge/repository";
import { SEED_CATALOGUE, type CatalogueEntry } from "./_core/knowledge/sourceCatalogue";
import { DEFAULT_CRAWL_POLICY, crawlerIdentity, type CollectorEnvironment } from "./_core/knowledge/collectors";
import { ingestSource, type IngestDeps } from "./_core/knowledge/ingestion";
import { promoteRule, rulesOnStaleSources, verifySourceRevision, type RuleEvidence } from "./_core/knowledge/promotionLedger";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9);
const enc = (s: string) => new TextEncoder().encode(s);
const HOST = "laws-lois.justice.gc.ca";
const ROBOTS = `https://${HOST}/robots.txt`;
const OPERATOR = 1, VERIFIER = 12, PROPOSER = 11;

const licence = (sourceId: string, full: boolean): SourceLicenceRecord => ({
  assessment_id: `LIC-TEST-${sourceId}`, source_id: sourceId, source_name: `Test ${sourceId}`,
  jurisdiction: "CA-FEDERAL", owner: "Test publisher", assessed_at: "2026-10-01", commercial_product: true,
  status: full ? "authorized_commercial" : "link_and_metadata_only",
  commercial_reuse_authorized: full, api_production_authorized: false, rag_ingestion_authorized: full,
  model_training_authorized: false, linking_authorized: true, metadata_only_authorized: true,
  permission_document_id: full ? "PERM-TEST" : null, reasons: ["synthetic, for tests"], conditions_to_unblock: [], sources: [],
});

async function source(full: boolean | null): Promise<{ id: string; url: string }> {
  const id = `t-ing-${rnd()}`;
  const url = `https://${HOST}/eng/regulations/${id}/`;
  if (full !== null) __registerAssessmentForTest(licence(id, full));
  const e: CatalogueEntry = {
    sourceId: id, sourceName: `Test ${id}`, owner: "Test publisher", jurisdiction: "CA-FEDERAL", homeUrl: url,
    domains: [HOST], sourceKind: "html", authorityLevel: "law", topics: ["hos_eld"], refreshIntervalHours: 24,
    crawlPolicy: { ...DEFAULT_CRAWL_POLICY, minDelayMs: 1000 }, termsUrl: null, accessControlled: false,
    licenceNotes: "synthetic", urlCheckedOn: "2026-10-01",
  };
  expect((await registerCatalogueEntry(e)).written).toBe(true);
  return { id, url };
}

type Reply = { status: number; headers?: Record<string, string>; body?: string | Uint8Array };
function harness(routes: Record<string, () => Reply>, opts: { identity?: boolean; storeRaw?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let clock = Date.now();
  const sleeps: number[] = [];
  const stored: string[] = [];
  const fetch: CollectorEnvironment["fetch"] = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    const r = route();
    const h: Record<string, string> = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bytes: Uint8Array = typeof r.body === "string" ? enc(r.body) : r.body ?? new Uint8Array();
    return { status: r.status, headers: { get: (n: string): string | null => h[n.toLowerCase()] ?? null },
      arrayBuffer: async (): Promise<ArrayBuffer> => bytes.slice().buffer as ArrayBuffer };
  };
  const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
    fetch, now: () => new Date(clock), sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    identity: opts.identity === false ? null : crawlerIdentity("https://leaseos.example/crawler"),
    operatorUserId: OPERATOR,
    ...(opts.storeRaw ? { storeRaw: async (key: string) => { stored.push(key); return key; } } : {}),
    ...over,
  });
  return { calls, sleeps, stored, deps, advance: (ms: number) => { clock += ms; } };
}

const page = (rule: string, footerDate = "2020-01-01") => `<html><head><title>Test regulation</title></head><body>
<nav>Home</nav><main><h2>Scheduling</h2><h3>Daily Driving Time</h3><p>${rule}</p>
<h3>Daily Off-duty Time</h3><p>14 (1) A driver shall take at least 10 hours of off-duty time in a day.</p>
<section class="pagedetails"><dl id="wb-dtmd"><dt>Date modified:</dt><dd><time property="dateModified">${footerDate}</time></dd></dl></section>
</main></body></html>`;
const RULE_13 = "12 (1) No driver shall drive after accumulating 13 hours of driving time in a day.";
const RULE_14 = "12 (1) No driver shall drive after accumulating 14 hours of driving time in a day.";
const html = (body: string | Uint8Array, headers: Record<string, string> = {}): Reply =>
  ({ status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body });

beforeAll(async () => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { __clearTestAssessments(); await pool?.end(); });

/* ------------------------------------------------------------------ */

d("refusals cost the publisher nothing", () => {
  it("every seed source is refused for want of a licence assessment, with zero requests", async () => {
    for (const e of SEED_CATALOGUE) await registerCatalogueEntry(e);
    const h = harness({});
    for (const e of SEED_CATALOGUE) {
      const r = await ingestSource(e.sourceId, h.deps());
      expect(r).toMatchObject({ result: "refused", requests: 0 });
      expect(r.steps.at(-1)!.detail).toMatch(/^NO_LICENCE_ASSESSMENT/);
    }
    expect(h.calls).toEqual([]);
  });

  it("a licensed source still does not run without a crawler contact", async () => {
    const s = await source(true);
    const h = harness({}, { identity: false });
    const r = await ingestSource(s.id, h.deps());
    expect(r).toMatchObject({ result: "refused", requests: 0 });
    expect(r.steps.at(-1)!.detail).toMatch(/^NO_CRAWLER_IDENTITY/);
    expect(h.calls).toEqual([]);
  });

  it("an uncatalogued source is refused before anything else", async () => {
    expect(await ingestSource(`t-nowhere-${rnd()}`, harness({}).deps())).toMatchObject({ result: "refused", requests: 0 });
  });

  it("robots.txt disallowing the page stops the run after one request and creates no document", async () => {
    const s = await source(true);
    const h = harness({ [ROBOTS]: () => ({ status: 200, body: "User-agent: LeaseOSIntelligenceBot\nDisallow: /eng/regulations/" }) });
    const r = await ingestSource(s.id, h.deps());
    expect(r).toMatchObject({ result: "refused", requests: 1 });
    expect(r.steps.at(-1)!.detail).toMatch(/^ROBOTS_DISALLOWED/);
    const [docs] = await pool.query("SELECT COUNT(*) AS n FROM knowledgeDocuments WHERE sourceId = ?", [s.id]);
    expect(Number((docs as { n: number }[])[0]!.n)).toBe(0);
    const [src] = await pool.query("SELECT robotsStatus, robotsCheckedAt FROM knowledgeSources WHERE sourceId = ?", [s.id]);
    expect((src as Record<string, unknown>[])[0]).toMatchObject({ robotsStatus: "fetched" });
    expect((src as Record<string, unknown>[])[0]!.robotsCheckedAt).not.toBeNull();
  });

  it("an unreachable robots.txt means disallow-all", async () => {
    const s = await source(true);
    const r = await ingestSource(s.id, harness({ [ROBOTS]: () => ({ status: 503 }) }).deps());
    expect(r.steps.at(-1)!.detail).toMatch(/^ROBOTS_UNREACHABLE/);
  });
});

d("an amendment reaches the rules that relied on the old text — and a new footer date does not", () => {
  it("runs the whole loop", async () => {
    const s = await source(true);
    let body: () => Reply = () => html(page(RULE_13), { etag: "\"v1\"" });
    const h = harness({ [ROBOTS]: () => ({ status: 404 }), [s.url]: () => body() });

    // 1. First retrieval: a candidate version, chunks stored, robots recorded, the delay honoured.
    const first = await ingestSource(s.id, h.deps());
    expect(first).toMatchObject({ result: "recorded", outcome: "first_seen", requests: 2, chunksWritten: 2, change: null });
    expect(h.sleeps).toEqual([1000]);   // the robots.txt request counted against the source's delay
    expect(h.calls[1]!.headers["User-Agent"]).toMatch(/^LeaseOSIntelligenceBot\//);
    const [docRow] = await pool.query("SELECT documentRef, state FROM knowledgeDocuments WHERE sourceId = ?", [s.id]);
    const doc = (docRow as { documentRef: string; state: string }[])[0]!;
    expect(doc.state).toBe("LICENCE_CHECKED");
    const [v1] = await versionHistory(doc.documentRef);
    const [v1row] = await pool.query("SELECT status, retrievedAt FROM knowledgeVersions WHERE versionRef = ?", [v1!.versionRef]);
    expect((v1row as Record<string, unknown>[])[0]).toMatchObject({ status: "candidate" });
    expect((v1row as Record<string, unknown>[])[0]!.retrievedAt).not.toBeNull();

    // 2. Not due yet: nothing is requested at all.
    expect(await ingestSource(s.id, h.deps())).toMatchObject({ result: "not_due", requests: 0 });

    // 3. A person verifies the revision and a rule is promoted from it.
    expect(await verifySourceRevision(v1!.versionRef, VERIFIER, new Date())).toEqual({ verified: true });
    const rule = await promoteRule(ruleEvidence(v1!.versionRef), new Date());
    if (!rule.promoted) throw new Error(`setup: ${rule.code} ${rule.reason}`);
    const stale = async () => (await rulesOnStaleSources(new Date())).some((x) => x.promotionRef === rule.promotionRef);
    expect(await stale()).toBe(false);

    // 4. The page is re-served with a new footer date only: same text, so nothing changes.
    body = () => html(page(RULE_13, "2020-01-02"), { etag: "\"v1b\"" });
    h.advance(25 * 3_600_000);
    const footer = await ingestSource(s.id, h.deps());
    expect(footer).toMatchObject({ result: "recorded", outcome: "unchanged", change: null, chunksWritten: 0 });
    expect(h.calls.at(-1)!.headers["If-None-Match"]).toBe("\"v1\"");
    expect((await versionHistory(doc.documentRef)).length).toBe(1);
    expect(await stale()).toBe(false);

    // 5. The publisher amends the rule. A new candidate version; the verified one is superseded;
    //    the rule is now in front of a person. The rule itself is untouched.
    body = () => html(page(RULE_14), { etag: "\"v2\"" });
    h.advance(25 * 3_600_000);
    const amended = await ingestSource(s.id, h.deps());
    expect(amended).toMatchObject({ result: "recorded", outcome: "changed", chunksWritten: 2 });
    expect(amended.change).toMatchObject({ kind: "REGULATORY_CHANGE_DETECTED", fromVersionRef: v1!.versionRef, authorityLevel: "law" });
    const history = await versionHistory(doc.documentRef);
    expect(history.map((v) => v.versionRef)).toEqual([v1!.versionRef, amended.change!.toVersionRef]);
    const [statuses] = await pool.query("SELECT versionRef, status FROM knowledgeVersions WHERE documentRef = ? ORDER BY id", [doc.documentRef]);
    expect((statuses as { status: string }[]).map((r) => r.status)).toEqual(["superseded", "candidate"]);
    expect(await stale()).toBe(true);
    const [ruleRow] = await pool.query("SELECT status FROM hosRuleLimitHistory WHERE promotionRef = ?", [rule.promotionRef]);
    expect((ruleRow as { status: string }[])[0]!.status).toBe("CURRENT");

    // 6. A garbled response: kept as evidence, no version, the amended text still current.
    body = () => html(new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    h.advance(25 * 3_600_000);
    const garbled = await ingestSource(s.id, h.deps());
    expect(garbled).toMatchObject({ result: "recorded", outcome: "unparseable", change: null, chunksWritten: 0 });
    expect((await versionHistory(doc.documentRef)).length).toBe(2);
    const [snap] = await pool.query("SELECT extractionStatus, extractionError, contentSha256, versionRef FROM knowledgeSnapshots WHERE snapshotRef = ?", [garbled.snapshotRef]);
    expect((snap as Record<string, unknown>[])[0]).toMatchObject({ extractionStatus: "failed", versionRef: null });
    expect((snap as Record<string, unknown>[])[0]!.contentSha256).not.toBeNull();

    // 7. 304: confirmed unchanged without a body.
    body = () => ({ status: 304 });
    h.advance(25 * 3_600_000);
    expect(await ingestSource(s.id, h.deps())).toMatchObject({ result: "recorded", outcome: "unchanged" });

    // Text from the two real versions only, each chunk pointing at its version.
    const [chunks] = await pool.query(
      "SELECT c.versionRef, c.section, c.text FROM knowledgeChunks c WHERE c.documentRef = ? ORDER BY c.id", [doc.documentRef]);
    const cs = chunks as { versionRef: string; section: string; text: string }[];
    expect(cs.map((c) => c.versionRef)).toEqual([v1!.versionRef, v1!.versionRef, amended.change!.toVersionRef, amended.change!.toVersionRef]);
    expect(cs.map((c) => c.section)).toEqual(["Daily Driving Time", "Daily Off-duty Time", "Daily Driving Time", "Daily Off-duty Time"]);
    expect(cs.some((c) => /Date modified|Home/.test(c.text))).toBe(false);
  });

  it("a withdrawn revision stays withdrawn when the page changes", async () => {
    const s = await source(true);
    let rule = RULE_13;
    const h = harness({ [ROBOTS]: () => ({ status: 404 }), [s.url]: () => html(page(rule)) });
    const first = await ingestSource(s.id, h.deps());
    const [docRow] = await pool.query("SELECT documentRef FROM knowledgeDocuments WHERE sourceId = ?", [s.id]);
    const [v1] = await versionHistory((docRow as { documentRef: string }[])[0]!.documentRef);
    expect(first.outcome).toBe("first_seen");
    await pool.query("UPDATE knowledgeVersions SET status = 'withdrawn' WHERE versionRef = ?", [v1!.versionRef]);
    rule = RULE_14;
    expect((await ingestSource(s.id, h.deps({ force: true }))).outcome).toBe("changed");
    const [row] = await pool.query("SELECT status, supersededByVersionRef FROM knowledgeVersions WHERE versionRef = ?", [v1!.versionRef]);
    expect((row as Record<string, unknown>[])[0]!.status).toBe("withdrawn");
    expect((row as Record<string, unknown>[])[0]!.supersededByVersionRef).not.toBeNull();
  });
});

d("the licence decides what is kept", () => {
  it("a link-only source is fingerprinted for change detection, but no text and no original bytes are kept", async () => {
    const s = await source(false);
    const h = harness({ [ROBOTS]: () => ({ status: 404 }), [s.url]: () => html(page(RULE_13)) }, { storeRaw: true });
    const r = await ingestSource(s.id, h.deps());
    expect(r).toMatchObject({ result: "recorded", outcome: "first_seen", chunksWritten: 0 });
    expect(r.steps.find((x) => x.step === "release")).toMatchObject({ ok: false });
    expect(h.stored).toEqual([]);
    const [c] = await pool.query("SELECT COUNT(*) AS n FROM knowledgeChunks k JOIN knowledgeDocuments d ON d.documentRef = k.documentRef WHERE d.sourceId = ?", [s.id]);
    expect(Number((c as { n: number }[])[0]!.n)).toBe(0);
  });

  it("a source licensed for ingestion keeps the original bytes, and the snapshot points at them", async () => {
    const s = await source(true);
    const h = harness({ [ROBOTS]: () => ({ status: 404 }), [s.url]: () => html(page(RULE_13)) }, { storeRaw: true });
    const r = await ingestSource(s.id, h.deps());
    expect(h.stored).toHaveLength(1);
    const [snap] = await pool.query("SELECT rawObjectKey FROM knowledgeSnapshots WHERE snapshotRef = ?", [r.snapshotRef]);
    expect((snap as { rawObjectKey: string }[])[0]!.rawObjectKey).toBe(h.stored[0]);
  });
});

/* ------------------------------------------------------------------ */

function ruleEvidence(sourceRevisionRef: string): RuleEvidence {
  return {
    ruleFamily: "document_requirement", ruleRef: `TEST-${rnd()}`, domain: "documents", dispatchEffect: "WARN",
    payload: { satisfiedBy: ["FIXTURE_DOC"] },
    jurisdiction: "CA-FEDERAL", authorityType: "law",
    instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", issuingAuthority: "FIXTURE — no issuing authority",
    sourceSection: "s. 12", citationUrl: `https://${HOST}/eng/regulations/SOR-2005-313/`, verificationMethod: "OFFICIAL_WEB",
    sourceRevisionRef, proposedByUserId: PROPOSER, verifiedByUserId: VERIFIER, verifiedAt: new Date(Date.now() - 86_400_000),
  };
}
