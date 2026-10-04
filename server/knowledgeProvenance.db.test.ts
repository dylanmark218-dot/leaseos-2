/**
 * Intelligence Engine Checkpoint 1 — the provenance model against real tables.
 *
 * The pure suite proves the rules; this proves the repository enforces them,
 * and that the database backs them up where the application could be bypassed:
 * snapshots cannot be deleted or edited, an extraction outcome is recorded
 * once, and the catalogue can never move a licence column.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  __clearTestAssessments, __registerAssessmentForTest, type SourceLicenceRecord,
} from "./_core/knowledge/sourceGate";
import {
  deactivateSource, quarantineDocument, recordExtraction, recordSnapshot, registerCatalogueEntry,
  releaseFromQuarantine, versionHistory, writeChunks, type SnapshotRequest, type SnapshotResult,
} from "./_core/knowledge/repository";
import { SEED_CATALOGUE, type CatalogueEntry } from "./_core/knowledge/sourceCatalogue";
import { DEFAULT_CRAWL_POLICY, type CollectResult } from "./_core/knowledge/collectors";
import { sha256Hex, versionInForce } from "./_core/knowledge/provenance";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9);
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const DOMAIN = "laws-lois.justice.gc.ca";
const URL0 = `https://${DOMAIN}/eng/regulations/SOR-2005-313/`;

const licence = (sourceId: string, full: boolean): SourceLicenceRecord => ({
  assessment_id: `LIC-TEST-${sourceId}`, source_id: sourceId, source_name: `Test ${sourceId}`,
  jurisdiction: "CA-FEDERAL", owner: "Test publisher", assessed_at: "2026-09-25", commercial_product: true,
  status: full ? "authorized_commercial" : "link_and_metadata_only",
  commercial_reuse_authorized: full, api_production_authorized: false, rag_ingestion_authorized: full,
  model_training_authorized: false, linking_authorized: true, metadata_only_authorized: true,
  permission_document_id: full ? "PERM-TEST" : null, reasons: ["synthetic, for tests"], conditions_to_unblock: [], sources: [],
});

const entry = (sourceId: string): CatalogueEntry => ({
  sourceId, sourceName: `Test ${sourceId}`, owner: "Test publisher", jurisdiction: "CA-FEDERAL",
  homeUrl: URL0, domains: [DOMAIN], sourceKind: "html", authorityLevel: "law", topics: ["hos_eld"],
  refreshIntervalHours: 24, crawlPolicy: DEFAULT_CRAWL_POLICY, termsUrl: null, accessControlled: false,
  licenceNotes: "synthetic", urlCheckedOn: "2026-09-25",
});

const result = (body: string | null, over: Partial<CollectResult> = {}): CollectResult => {
  const bytes = body === null ? undefined : new TextEncoder().encode(body);
  return {
    url: URL0, httpStatus: body === null ? 503 : 200, contentType: "text/html", etag: null, lastModified: null,
    body: bytes, declaredSha256: bytes ? sha256Hex(bytes) : null, collectorKind: "html", collectorVersion: "test-1", ...over,
  };
};

function recorded(r: SnapshotResult) {
  if (!r.recorded) throw new Error(`expected a recorded snapshot, got ${r.code}: ${r.reason}`);
  return r;
}

const FULL = `t-full-${rnd()}`;
const LINK = `t-link-${rnd()}`;
const OTHER = `t-other-${rnd()}`;

async function newDocument(sourceId: string): Promise<string> {
  const documentRef = `KD-${rnd()}-${rnd()}`;
  const q = await quarantineDocument({
    documentRef, sourceId, title: "SOR/2005-313", url: URL0, purpose: "rag_ingestion",
    contentHash: "0".repeat(64), fetchedAt: new Date(), fetchedByUserId: 1,
  });
  expect(q.stored).toBe(true);
  return documentRef;
}

const snap = (sourceId: string, documentRef: string, body: string | null, over: Partial<SnapshotRequest> = {}) =>
  recordSnapshot({ sourceId, documentRef, result: result(body), retrievedAt: new Date(), recordedByUserId: 1, ...over });

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 });
  __registerAssessmentForTest(licence(FULL, true));
  __registerAssessmentForTest(licence(LINK, false));
  __registerAssessmentForTest(licence(OTHER, true));
  for (const id of [FULL, LINK, OTHER]) expect((await registerCatalogueEntry(entry(id))).written).toBe(true);
});

afterAll(async () => {
  __clearTestAssessments();
  await pool?.end();
});

/* ------------------------------------------------------------------ */

d("the catalogue describes sources and never licenses them", () => {
  it("seeds the six Checkpoint 1 sources unassessed, with every permission off", async () => {
    for (const e of SEED_CATALOGUE) expect(await registerCatalogueEntry(e)).toEqual({ written: true, sourceId: e.sourceId });
    const [rows] = await pool.query(
      `SELECT sourceId, licenceStatus, linkingAuthorized, ragIngestionAuthorized, commercialReuseAuthorized, authorityLevel, active, robotsStatus
       FROM knowledgeSources WHERE sourceId IN (?)`, [SEED_CATALOGUE.map((e) => e.sourceId)]);
    const list = rows as Record<string, unknown>[];
    expect(list).toHaveLength(6);
    for (const r of list) {
      expect(r.licenceStatus).toBe("unassessed");
      expect([r.linkingAuthorized, r.ragIngestionAuthorized, r.commercialReuseAuthorized].map(Number)).toEqual([0, 0, 0]);
      expect(Number(r.active)).toBe(1);
      expect(r.robotsStatus).toBe("unchecked");
    }
  });

  it("re-registering an assessed source changes its description and not one licence column", async () => {
    const id = `t-assessed-${rnd()}`;
    await pool.execute(
      `INSERT INTO knowledgeSources (sourceId, sourceName, owner, jurisdiction, assessmentId, licenceStatus,
         linkingAuthorized, ragIngestionAuthorized, commercialReuseAuthorized, permissionDocumentId)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, "Old name", "Old owner", "CA-FEDERAL", "LIC-REAL", "authorized_commercial", true, true, true, "PERM-REAL"]);
    await registerCatalogueEntry({ ...entry(id), sourceName: "New name", authorityLevel: "official_guidance" });
    const [rows] = await pool.query("SELECT * FROM knowledgeSources WHERE sourceId = ?", [id]);
    const r = (rows as Record<string, unknown>[])[0]!;
    expect(r.sourceName).toBe("New name");
    expect(r.authorityLevel).toBe("official_guidance");
    expect(r).toMatchObject({ assessmentId: "LIC-REAL", licenceStatus: "authorized_commercial", permissionDocumentId: "PERM-REAL" });
    expect([r.linkingAuthorized, r.ragIngestionAuthorized, r.commercialReuseAuthorized].map(Number)).toEqual([1, 1, 1]);
  });

  it("a retired source stays retired when the seed runs again", async () => {
    const id = `t-retired-${rnd()}`;
    await registerCatalogueEntry(entry(id));
    expect(await deactivateSource(id, "publisher withdrew the page")).toBe(true);
    await registerCatalogueEntry(entry(id));
    const [rows] = await pool.query("SELECT active, deactivatedReason FROM knowledgeSources WHERE sourceId = ?", [id]);
    expect((rows as Record<string, unknown>[])[0]).toMatchObject({ active: 0, deactivatedReason: "publisher withdrew the page" });
  });

  it("refuses organization material and malformed entries before any write", async () => {
    const leaked = { ...entry(`t-leak-${rnd()}`), tenantId: "org-acme" } as CatalogueEntry;
    expect(await registerCatalogueEntry(leaked)).toMatchObject({ written: false, code: "PRIVATE_MATERIAL" });
    expect(await registerCatalogueEntry({ ...entry(`t-bad-${rnd()}`), topics: ["not_a_topic" as never] }))
      .toMatchObject({ written: false, code: "BAD_TOPICS" });
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM knowledgeSources WHERE sourceId = ?", [leaked.sourceId]);
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
  });

  it("the public corpus tables have no tenant column to put a customer's document in", async () => {
    const [rows] = await pool.query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name IN ('knowledgeSources','knowledgeDocuments','knowledgeVersions','knowledgeChunks','knowledgeSnapshots')
         AND column_name REGEXP 'tenant|organization|company'`);
    expect(rows).toEqual([]);
  });
});

d("a retrieval is refused when it should never have happened", () => {
  it("an uncatalogued source", async () => {
    expect(await snap(`t-nowhere-${rnd()}`, "KD-x", "text")).toMatchObject({ recorded: false, code: "SOURCE_NOT_CATALOGUED" });
  });

  it("a catalogued source with no licence assessment — every seed today", async () => {
    expect(await snap(SEED_CATALOGUE[0]!.sourceId, "KD-x", "text")).toMatchObject({ recorded: false, code: "NO_LICENCE_ASSESSMENT" });
  });

  it("a retired source", async () => {
    const id = `t-gone-${rnd()}`;
    __registerAssessmentForTest(licence(id, true));
    await registerCatalogueEntry(entry(id));
    const doc = await newDocument(id);
    await deactivateSource(id, "retired for the test");
    expect(await snap(id, doc, "text")).toMatchObject({ recorded: false, code: "SOURCE_INACTIVE" });
  });

  it("a URL outside the source's domains, however it arrived", async () => {
    const doc = await newDocument(FULL);
    const off = { result: result("text", { url: "https://www.canlii.org/en/ca/laws/regu/sor-2005-313/" }) };
    expect(await snap(FULL, doc, "text", off)).toMatchObject({ recorded: false, code: "OUTSIDE_SOURCE_DOMAIN" });
    const ssrf = { result: result("text", { url: "https://169.254.169.254/latest/meta-data/" }) };
    expect(await snap(FULL, doc, "text", ssrf)).toMatchObject({ recorded: false, code: "IP_LITERAL_HOST" });
  });

  it("a document that belongs to another source", async () => {
    const doc = await newDocument(OTHER);
    expect(await snap(FULL, doc, "text")).toMatchObject({ recorded: false, code: "DOCUMENT_SOURCE_MISMATCH" });
  });

  it("keeping the original bytes of a source licensed only for linking", async () => {
    const doc = await newDocument(LINK);
    expect(await snap(LINK, doc, "text", { rawObjectKey: "raw/x.html" }))
      .toMatchObject({ recorded: false, code: "RAW_RETENTION_NOT_AUTHORIZED" });
    // The hash alone is still recordable, so change detection works before a licence arrives.
    expect(recorded(await snap(LINK, doc, "text")).outcome).toBe("first_seen");
  });
});

d("versions are appended, never overwritten", () => {
  it("walks first_seen → duplicate → changed → unavailable → hash mismatch, keeping every step", async () => {
    const doc = await newDocument(FULL);

    const a = recorded(await snap(FULL, doc, "s.12: 13 hours", { effectiveFrom: day("2019-01-01"), rawObjectKey: "raw/a.html" }));
    expect(a).toMatchObject({ outcome: "first_seen", change: null });

    const dup = recorded(await snap(FULL, doc, "s.12: 13 hours"));
    expect(dup).toMatchObject({ outcome: "unchanged", versionRef: a.versionRef });

    const b = recorded(await snap(FULL, doc, "s.12: 14 hours", { effectiveFrom: day("2026-06-04") }));
    expect(b.outcome).toBe("changed");
    expect(b.versionRef).not.toBe(a.versionRef);
    expect(b.change).toMatchObject({ kind: "REGULATORY_CHANGE_DETECTED", fromVersionRef: a.versionRef, toVersionRef: b.versionRef, authorityLevel: "law" });

    const down = recorded(await snap(FULL, doc, null));
    expect(down).toMatchObject({ outcome: "unavailable", versionRef: null });

    const bad = recorded(await snap(FULL, doc, "tampered", {
      result: result("tampered", { declaredSha256: sha256Hex("what the collector claimed") }), rawObjectKey: "raw/bad.html",
    }));
    expect(bad).toMatchObject({ outcome: "hash_mismatch", versionRef: null });

    const [rows] = await pool.query(
      "SELECT snapshotRef, outcome, versionRef, previousSnapshotRef, contentSha256, rawObjectKey, extractionStatus, provenanceJson FROM knowledgeSnapshots WHERE documentRef = ? ORDER BY id", [doc]);
    const s = rows as Record<string, unknown>[];
    expect(s.map((r) => r.outcome)).toEqual(["first_seen", "unchanged", "changed", "unavailable", "hash_mismatch"]);
    // Each snapshot points at the one before it, failures included.
    expect(s.map((r) => r.previousSnapshotRef)).toEqual([null, s[0]!.snapshotRef, s[1]!.snapshotRef, s[2]!.snapshotRef, s[3]!.snapshotRef]);
    expect(s[0]!.contentSha256).toBe(sha256Hex("s.12: 13 hours"));
    expect(s[0]!.rawObjectKey).toBe("raw/a.html");
    // Untrustworthy bytes leave no hash and no pointer to themselves.
    expect(s[4]).toMatchObject({ contentSha256: null, rawObjectKey: null });
    expect(JSON.stringify(s[4]!.provenanceJson)).toMatch(/rawObjectKeyDiscarded/);
    // Only a new version has anything to extract.
    expect(s.map((r) => r.extractionStatus)).toEqual(["pending", "not_applicable", "pending", "not_applicable", "not_applicable"]);

    const history = await versionHistory(doc);
    expect(history.map((v) => v.versionRef)).toEqual([a.versionRef, b.versionRef]);
    expect(history[0]!.supersededByVersionRef).toBe(b.versionRef);
    expect(history[1]!.supersedesVersionRef).toBe(a.versionRef);

    // The page going down and the tampered bytes did not unseat the rule in force.
    expect(versionInForce(history, day("2026-09-25"))).toMatchObject({ status: "in_force", version: { versionRef: b.versionRef } });
    expect(versionInForce(history, day("2025-03-15"))).toMatchObject({ status: "in_force", version: { versionRef: a.versionRef } });
  });

  it("returning to earlier text is a change, not a rewind", async () => {
    const doc = await newDocument(FULL);
    const a = recorded(await snap(FULL, doc, "v-one"));
    recorded(await snap(FULL, doc, "v-two"));
    const back = recorded(await snap(FULL, doc, "v-one"));
    expect(back.outcome).toBe("changed");
    expect(back.versionRef).not.toBe(a.versionRef);
    expect((await versionHistory(doc)).length).toBe(3);
  });

  it("two collectors finishing at once cannot both see the first version", async () => {
    const doc = await newDocument(FULL);
    const both = await Promise.all([snap(FULL, doc, "same bytes"), snap(FULL, doc, "same bytes")]);
    expect(both.map((r) => recorded(r).outcome).sort()).toEqual(["first_seen", "unchanged"]);
    expect((await versionHistory(doc)).length).toBe(1);
  });

  it("refuses an effective range that ends before it starts", async () => {
    const doc = await newDocument(FULL);
    expect(await snap(FULL, doc, "x", { effectiveFrom: day("2026-01-01"), effectiveUntil: day("2025-01-01") }))
      .toMatchObject({ recorded: false, code: "BAD_EFFECTIVE_RANGE" });
  });
});

d("the database refuses to rewrite history even if the application is bypassed", () => {
  it("a snapshot cannot be deleted", async () => {
    const doc = await newDocument(FULL);
    const s = recorded(await snap(FULL, doc, "evidence"));
    await expect(pool.execute("DELETE FROM knowledgeSnapshots WHERE snapshotRef = ?", [s.snapshotRef])).rejects.toThrow(/append-only/);
  });

  it("a snapshot's hash, URL or outcome cannot be edited", async () => {
    const doc = await newDocument(FULL);
    const s = recorded(await snap(FULL, doc, "evidence"));
    for (const [col, val] of [["contentSha256", "f".repeat(64)], ["url", "https://example.org/"], ["outcome", "unchanged"], ["versionRef", null]] as const) {
      await expect(pool.execute(`UPDATE knowledgeSnapshots SET ${col} = ? WHERE snapshotRef = ?`, [val, s.snapshotRef]))
        .rejects.toThrow(/append-only/);
    }
  });
});

d("parser failure", () => {
  it("is recorded once, keeps the last good text, and never reaches the corpus", async () => {
    const doc = await newDocument(FULL);
    expect(await releaseFromQuarantine(doc)).toMatchObject({ released: true });

    const good = recorded(await snap(FULL, doc, "s.12 text"));
    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "s.12 text", section: "12" }],
      { snapshotRef: good.snapshotRef, topics: ["hos_eld"] })).toMatchObject({ written: true, count: 1 });
    expect(await recordExtraction(good.snapshotRef, { status: "extracted", parserVersion: "html-1" })).toBe(true);

    const broken = recorded(await snap(FULL, doc, "<html><garbled"));
    expect(await recordExtraction(broken.snapshotRef, { status: "failed", parserVersion: "html-1", error: "unterminated tag" })).toBe(true);
    // Once. Neither the function nor a raw UPDATE can overwrite it.
    expect(await recordExtraction(broken.snapshotRef, { status: "extracted", parserVersion: "html-2" })).toBe(false);
    await expect(pool.execute("UPDATE knowledgeSnapshots SET extractionStatus = 'extracted' WHERE snapshotRef = ?", [broken.snapshotRef]))
      .rejects.toThrow(/recorded once/);

    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "garbled" }],
      { snapshotRef: broken.snapshotRef, topics: ["hos_eld"] })).toMatchObject({ written: false, code: "EXTRACTION_FAILED" });

    const [rows] = await pool.query("SELECT text, versionRef, snapshotRef, contentHash, topicsJson FROM knowledgeChunks WHERE documentRef = ?", [doc]);
    const chunks = rows as Record<string, unknown>[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: "s.12 text", versionRef: good.versionRef, snapshotRef: good.snapshotRef, contentHash: sha256Hex("s.12 text") });
    expect(chunks[0]!.topicsJson).toEqual(["hos_eld"]);
  });

  it("text cannot be attributed to a retrieval of another document, or to one with no trustworthy bytes", async () => {
    const doc = await newDocument(FULL);
    const other = await newDocument(FULL);
    await releaseFromQuarantine(doc);
    const foreign = recorded(await snap(FULL, other, "other text"));
    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "x" }], { snapshotRef: foreign.snapshotRef, topics: ["hos_eld"] }))
      .toMatchObject({ written: false, code: "SNAPSHOT_DOCUMENT_MISMATCH" });
    const down = recorded(await snap(FULL, doc, null));
    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "x" }], { snapshotRef: down.snapshotRef, topics: ["hos_eld"] }))
      .toMatchObject({ written: false, code: "SNAPSHOT_NOT_USABLE" });
    const ok = recorded(await snap(FULL, doc, "fine"));
    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "x" }], { snapshotRef: ok.snapshotRef, topics: ["nope"] }))
      .toMatchObject({ written: false, code: "BAD_TOPICS" });
  });

  it("the licence gate still runs first: a link-only source's text is never chunked, snapshot or not", async () => {
    const doc = await newDocument(LINK);
    expect(await releaseFromQuarantine(doc)).toMatchObject({ released: false });
    const s = recorded(await snap(LINK, doc, "text"));
    expect(await writeChunks(doc, [{ chunkRef: `KC-${rnd()}`, ordinal: 0, text: "text" }], { snapshotRef: s.snapshotRef, topics: ["hos_eld"] }))
      .toMatchObject({ written: false, code: "NOT_RELEASED" });
  });
});
