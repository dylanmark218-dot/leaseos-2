/**
 * The knowledge repository — the only way rows reach the knowledge tables.
 *
 * The gate in `sourceGate.ts` decides; this is where the decision is enforced
 * against a real database. Two rules do most of the work:
 *
 *   1. A document is **always** created `QUARANTINED`. There is no argument to
 *      create one in any other state, and the state column defaults to it, so a
 *      direct insert that forgets is still quarantined.
 *   2. A chunk cannot be written unless the source permits reproduction, and
 *      the row records which assessment permitted it. A later revocation can
 *      then find exactly the rows it has to remove — which is impossible if
 *      "why is this text here" was never written down.
 *
 * The application enforces both. The database defaults back them up rather than
 * replacing them, because a default cannot know what an assessment says.
 */

import { and, eq } from "drizzle-orm";
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  checkSourceGate, licenceFor, type IngestionPurpose, type SourceLicenceRecord,
} from "./sourceGate";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const dbOrThrow = async (): Promise<Db> => {
  const db = await getDb();
  // An unreachable database is not an empty knowledge base.
  if (!db) throw new Error("Database unavailable");
  return db;
};

/* ------------------------------------------------------------------ */
/* Registering a source                                                */
/* ------------------------------------------------------------------ */

/**
 * Store an assessment.
 *
 * Reasons and conditions are stored, not summarised: a future reader should not
 * have to re-derive why a source was blocked, or guess what would unblock it.
 */
export async function registerSource(record: SourceLicenceRecord, assessedByUserId: number): Promise<void> {
  const db = await dbOrThrow();

  // The pair the whole gate rests on. Refused here as well as in the gate,
  // because this is the last place before it becomes a row.
  if (record.commercial_reuse_authorized && !record.permission_document_id) {
    throw new Error(
      `"${record.source_name}" cannot be stored as commercially authorized without a permission document`);
  }

  await db.insert(knowledgeSources).values({
    sourceId: record.source_id,
    sourceName: record.source_name,
    owner: record.owner,
    jurisdiction: record.jurisdiction,
    assessmentId: record.assessment_id,
    // The assessment stores an ISO date string; the column is a date.
    assessedAt: new Date(record.assessed_at),
    assessedByUserId,
    licenceStatus: record.status,
    linkingAuthorized: record.linking_authorized,
    metadataOnlyAuthorized: record.metadata_only_authorized,
    ragIngestionAuthorized: record.rag_ingestion_authorized,
    modelTrainingAuthorized: record.model_training_authorized,
    apiProductionAuthorized: record.api_production_authorized,
    commercialReuseAuthorized: record.commercial_reuse_authorized,
    permissionDocumentId: record.permission_document_id,
    reasonsJson: record.reasons,
    conditionsToUnblockJson: record.conditions_to_unblock,
    officialSourcesJson: record.sources,
  });
}

/* ------------------------------------------------------------------ */
/* Fetching a document                                                 */
/* ------------------------------------------------------------------ */

export type FetchRequest = {
  documentRef: string;
  sourceId: string;
  title: string;
  url?: string;
  purpose: IngestionPurpose;
  contentHash: string;
  fetchedAt: Date;
  fetchedByUserId: number;
};

export type QuarantineResult =
  | { stored: true; documentRef: string; state: "QUARANTINED" }
  | { stored: false; reason: string };

/**
 * Record a fetched document.
 *
 * Always quarantined, even when the source is fully authorized. The gate runs
 * at the transition out, not here — so a job cannot pass the check under one
 * purpose and then advance under another.
 *
 * A source with no assessment is refused before anything is written. Storing a
 * document from an unassessed source "just to look at later" is the behaviour
 * this table exists to prevent.
 */
export async function quarantineDocument(req: FetchRequest): Promise<QuarantineResult> {
  const db = await dbOrThrow();

  const source = licenceFor(req.sourceId);
  if (!source) {
    return { stored: false, reason: `"${req.sourceId}" has no stored licence assessment; nothing may be fetched from it` };
  }
  if (source.status === "prohibited") {
    return { stored: false, reason: `"${source.source_name}" is prohibited` };
  }

  await db.insert(knowledgeDocuments).values({
    documentRef: req.documentRef,
    sourceId: req.sourceId,
    title: req.title,
    url: req.url ?? null,
    purpose: req.purpose,
    // Stated rather than defaulted, so the intent is visible in the code too.
    state: "QUARANTINED",
    contentHash: req.contentHash,
    fetchedAt: req.fetchedAt,
    fetchedByUserId: req.fetchedByUserId,
  });

  return { stored: true, documentRef: req.documentRef, state: "QUARANTINED" };
}

/* ------------------------------------------------------------------ */
/* Leaving quarantine                                                  */
/* ------------------------------------------------------------------ */

export type ReleaseResult =
  | { released: true; state: "LICENCE_CHECKED" }
  | { released: false; state: "REJECTED"; reason: string; code: string };

/**
 * The only transition out of quarantine, against the database.
 *
 * The purpose is read from the stored row rather than taken as an argument. A
 * caller cannot ask to release a document "as link_only" when it was fetched
 * for RAG ingestion — the row remembers what the job said it was for.
 */
export async function releaseFromQuarantine(documentRef: string): Promise<ReleaseResult> {
  const db = await dbOrThrow();

  const rows = await db.select().from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.documentRef, documentRef)).limit(1);
  const doc = rows[0];
  if (!doc) return { released: false, state: "REJECTED", reason: "no such document", code: "NOT_FOUND" };

  const gate = checkSourceGate(doc.sourceId, doc.purpose);

  if (!gate.allowed) {
    await db.update(knowledgeDocuments)
      .set({ state: "REJECTED", rejectedReason: gate.reason, gateDecisionCode: gate.code })
      .where(eq(knowledgeDocuments.documentRef, documentRef));
    return { released: false, state: "REJECTED", reason: gate.reason, code: gate.code };
  }

  await db.update(knowledgeDocuments)
    .set({ state: "LICENCE_CHECKED", gateDecisionCode: "AUTHORIZED" })
    .where(eq(knowledgeDocuments.documentRef, documentRef));
  return { released: true, state: "LICENCE_CHECKED" };
}

/* ------------------------------------------------------------------ */
/* Storing text                                                        */
/* ------------------------------------------------------------------ */

export type ChunkWrite = { chunkRef: string; ordinal: number; text: string; section?: string; page?: number };

export type ChunkResult =
  | { written: true; count: number; authorizedBy: string }
  | { written: false; reason: string; code: string };

/**
 * Write chunks.
 *
 * Refused unless the source permits reproduction *and* the document has left
 * quarantine. Both, because either alone lets something through: a licensed
 * source whose document was rejected for another reason, or a released document
 * whose source only ever allowed linking.
 */
export async function writeChunks(documentRef: string, chunks: readonly ChunkWrite[]): Promise<ChunkResult> {
  const db = await dbOrThrow();

  const rows = await db.select().from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.documentRef, documentRef)).limit(1);
  const doc = rows[0];
  if (!doc) return { written: false, reason: "no such document", code: "NOT_FOUND" };

  if (doc.state === "QUARANTINED" || doc.state === "REJECTED") {
    return { written: false, code: "NOT_RELEASED",
      reason: `"${doc.title}" is ${doc.state}; text may not be stored until it has passed the licence gate` };
  }

  const source = licenceFor(doc.sourceId);
  if (!source) {
    return { written: false, code: "NO_LICENCE_ASSESSMENT", reason: `"${doc.sourceId}" has no stored licence assessment` };
  }

  // Chunking is reproduction. This is the check the pipeline diagram has no box
  // for, and the one that keeps a course out of the vector store.
  const gate = checkSourceGate(doc.sourceId, "rag_ingestion");
  if (!gate.allowed) {
    return { written: false, code: gate.code,
      reason: `storing text from "${source.source_name}" is reproduction, and ${gate.reason}` };
  }

  await db.insert(knowledgeChunks).values(chunks.map((c) => ({
    chunkRef: c.chunkRef,
    documentRef,
    ordinal: c.ordinal,
    text: c.text,
    section: c.section ?? null,
    page: c.page ?? null,
    // So a revocation can find its own rows.
    authorizedByAssessmentId: source.assessment_id,
  })));

  return { written: true, count: chunks.length, authorizedBy: source.assessment_id };
}

/**
 * Every stored chunk that a given assessment authorized.
 *
 * The question asked the day a permission is withdrawn, or an assessment is
 * found to have been wrong. Without `authorizedByAssessmentId` it is
 * unanswerable, and "delete everything from that source" is a guess.
 */
export async function chunksAuthorizedBy(assessmentId: string): Promise<{ chunkRef: string; documentRef: string }[]> {
  const db = await dbOrThrow();
  return db.select({ chunkRef: knowledgeChunks.chunkRef, documentRef: knowledgeChunks.documentRef })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.authorizedByAssessmentId, assessmentId));
}

/** Documents still waiting on a licence decision. */
export async function quarantined(sourceId?: string): Promise<{ documentRef: string; title: string; purpose: string }[]> {
  const db = await dbOrThrow();
  const where = sourceId
    ? and(eq(knowledgeDocuments.state, "QUARANTINED"), eq(knowledgeDocuments.sourceId, sourceId))
    : eq(knowledgeDocuments.state, "QUARANTINED");
  return db.select({
    documentRef: knowledgeDocuments.documentRef,
    title: knowledgeDocuments.title,
    purpose: knowledgeDocuments.purpose,
  }).from(knowledgeDocuments).where(where);
}
