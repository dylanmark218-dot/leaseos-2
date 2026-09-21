/**
 * The knowledge repository against real tables.
 *
 * The question these answer: can anything reach `knowledgeChunks` without a
 * licence assessment permitting it? Every path is tried.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  AB_511, authorizeCommercialUse, type SourceLicenceRecord,
} from "./_core/knowledge/sourceGate";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(async () => { if (!DB_URL) return; pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });

afterAll(async () => { await pool?.end(); });

d("the knowledge tables exist and default safely", () => {
  it("creates a document quarantined even when the insert does not say so", async () => {
    const ref = `DOC-${rnd()}`;
    // The column default backs up the application rule. A direct insert that
    // forgets the state still lands in quarantine.
    await pool.execute(
      "INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, contentHash, fetchedAt) VALUES (?,?,?,?,?,NOW())",
      [ref, AB_511.source_id, "Some page", "rag_ingestion", "h".repeat(16)]);

    const [rows] = await pool.query("SELECT state FROM knowledgeDocuments WHERE documentRef = ?", [ref]);
    expect((rows as { state: string }[])[0]?.state).toBe("QUARANTINED");
  });

  it("defaults a source to unassessed, which permits nothing", async () => {
    const id = `src-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeSources (sourceId, sourceName, owner, jurisdiction) VALUES (?,?,?,?)",
      [id, "Some site", "Somebody", "CA-AB"]);

    const [rows] = await pool.query(
      "SELECT licenceStatus, linkingAuthorized, ragIngestionAuthorized, commercialReuseAuthorized FROM knowledgeSources WHERE sourceId = ?", [id]);
    const r = (rows as Record<string, unknown>[])[0]!;
    expect(r.licenceStatus).toBe("unassessed");
    // Every permission off. "Not assessed" is not "probably fine".
    expect(Number(r.linkingAuthorized)).toBe(0);
    expect(Number(r.ragIngestionAuthorized)).toBe(0);
    expect(Number(r.commercialReuseAuthorized)).toBe(0);
  });

  it("records the 511 assessment with its reasons and conditions intact", async () => {
    const id = `gov-ab-511-${rnd()}`;
    await pool.execute(
      `INSERT INTO knowledgeSources
       (sourceId, sourceName, owner, jurisdiction, assessmentId, licenceStatus,
        linkingAuthorized, metadataOnlyAuthorized, reasonsJson, conditionsToUnblockJson)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, AB_511.source_name, AB_511.owner, AB_511.jurisdiction, AB_511.assessment_id,
       AB_511.status, true, true, JSON.stringify(AB_511.reasons), JSON.stringify(AB_511.conditions_to_unblock)]);

    const [rows] = await pool.query("SELECT reasonsJson, conditionsToUnblockJson FROM knowledgeSources WHERE sourceId = ?", [id]);
    const r = (rows as Record<string, string>[])[0]!;
    const reasons = typeof r.reasonsJson === "string" ? JSON.parse(r.reasonsJson) : r.reasonsJson;
    // Stored, not summarised — a future reader should not re-derive why.
    expect(reasons).toHaveLength(4);
    expect(JSON.stringify(reasons)).toContain("not intended to be reproduced or sold for commercial purposes");
  });

  it("ties every stored chunk to the assessment that permitted it", async () => {
    const docRef = `DOC-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, state, contentHash, fetchedAt) VALUES (?,?,?,?,?,?,NOW())",
      [docRef, "some-open-source", "Open dataset", "rag_ingestion", "VERIFIED", "h".repeat(16)]);

    const chunkRef = `CHK-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeChunks (chunkRef, documentRef, ordinal, text, authorizedByAssessmentId) VALUES (?,?,?,?,?)",
      [chunkRef, docRef, 0, "some permitted text", "LIC-OPEN-2026-01"]);

    const [rows] = await pool.query(
      "SELECT authorizedByAssessmentId FROM knowledgeChunks WHERE chunkRef = ?", [chunkRef]);
    // The question asked the day a permission is withdrawn. Without this column
    // "delete everything from that source" is a guess.
    expect((rows as { authorizedByAssessmentId: string }[])[0]?.authorizedByAssessmentId).toBe("LIC-OPEN-2026-01");
  });

  it("cannot store a chunk with no authorizing assessment", async () => {
    const docRef = `DOC-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, state, contentHash, fetchedAt) VALUES (?,?,?,?,?,?,NOW())",
      [docRef, "x", "y", "rag_ingestion", "VERIFIED", "h".repeat(16)]);

    // NOT NULL, so even a hand-written insert has to name one.
    await expect(pool.execute(
      "INSERT INTO knowledgeChunks (chunkRef, documentRef, ordinal, text) VALUES (?,?,?,?)",
      [`CHK-${rnd()}`, docRef, 0, "text"])).rejects.toThrow();
  });

  it("records a rejection with the gate's own code and reason", async () => {
    const ref = `DOC-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, contentHash, fetchedAt) VALUES (?,?,?,?,?,NOW())",
      [ref, AB_511.source_id, "Carrier course module 7", "rag_ingestion", "h".repeat(16)]);
    await pool.execute(
      "UPDATE knowledgeDocuments SET state='REJECTED', rejectedReason=?, gateDecisionCode=? WHERE documentRef=?",
      ["LeaseOS is a commercial product and 511 has no commercial reuse authorization",
       "COMMERCIAL_USE_UNAUTHORIZED", ref]);

    const [rows] = await pool.query(
      "SELECT state, gateDecisionCode, rejectedReason FROM knowledgeDocuments WHERE documentRef = ?", [ref]);
    const r = (rows as Record<string, string>[])[0]!;
    expect(r.state).toBe("REJECTED");
    // Refused for a nameable reason, so somebody can act on it.
    expect(r.gateDecisionCode).toBe("COMMERCIAL_USE_UNAUTHORIZED");
    expect(r.rejectedReason).toContain("commercial reuse");
  });

  it("keeps versions rather than overwriting a rule", async () => {
    const docRef = `DOC-${rnd()}`;
    await pool.execute(
      "INSERT INTO knowledgeDocuments (documentRef, sourceId, title, purpose, state, contentHash, fetchedAt) VALUES (?,?,?,?,?,?,NOW())",
      [docRef, "s", "Regulation", "rag_ingestion", "VERIFIED", "h1"]);

    const v1 = `VER-${rnd()}`, v2 = `VER-${rnd()}`;
    await pool.execute("INSERT INTO knowledgeVersions (versionRef, documentRef, contentHash) VALUES (?,?,?)", [v1, docRef, "h1"]);
    await pool.execute("INSERT INTO knowledgeVersions (versionRef, documentRef, contentHash, supersedesVersionRef) VALUES (?,?,?,?)", [v2, docRef, "h2", v1]);
    await pool.execute("UPDATE knowledgeVersions SET supersededByVersionRef=? WHERE versionRef=?", [v2, v1]);

    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM knowledgeVersions WHERE documentRef = ?", [docRef]);
    // Both survive, so a rule can be shown as it stood on a date.
    expect(Number((rows as { n: number }[])[0]?.n)).toBe(2);
  });
});

describe("authorization still needs the letter, at the row level", () => {
  it("refuses to build a commercially authorized record without a permission document", () => {
    const r = authorizeCommercialUse(AB_511, { documentId: "", scope: ["rag_ingestion"], recordedByUserId: 1 });
    expect(r.authorized).toBe(false);
  });

  it("produces a record a repository may store once the letter exists", () => {
    const r = authorizeCommercialUse(AB_511, {
      documentId: "PERM-AB-2026-11", scope: ["rag_ingestion", "commercial_redisplay"], recordedByUserId: 7,
    });
    expect(r.authorized).toBe(true);
    if (!r.authorized) return;
    const record: SourceLicenceRecord = r.record;
    expect(record.permission_document_id).toBe("PERM-AB-2026-11");
    expect(record.commercial_reuse_authorized).toBe(true);
    // Still not training — it was not in scope, and scope is not rounded up.
    expect(record.model_training_authorized).toBe(false);
  });
});
