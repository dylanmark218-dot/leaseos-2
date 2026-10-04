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
 *
 * ## Who calls this
 *
 * Since Intelligence Engine Checkpoint 2, `ingestion.ts` does, and an operator runs that from
 * `scripts/knowledge-ingest.ts`. No router reaches either, deliberately: a crawl started by a web
 * request is not something to expose. `engineReachability.test.ts` records that position, and
 * `knowledgeWritePaths.test.ts` still holds that nothing else writes the corpus.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import {
  knowledgeChunks, knowledgeDocuments, knowledgeSnapshots, knowledgeSources, knowledgeVersions,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  checkSourceGate, licenceFor, type IngestionPurpose, type SourceLicenceRecord,
} from "./sourceGate";
import { validateCatalogueEntry, type CatalogueEntry } from "./sourceCatalogue";
import { classifyRetrieval, sha256Hex, validateSourceUrl, type RetrievalOutcome, type UrlRefusal } from "./provenance";
import { validateTopics } from "./industryTaxonomy";
import type { CollectResult } from "./collectors";

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

/** Where the text came from (0197). Given whenever the chunks are the product of a recorded retrieval. */
export type ChunkProvenance = { snapshotRef: string; topics: readonly string[] };

/**
 * Write chunks.
 *
 * Refused unless the source permits reproduction *and* the document has left
 * quarantine. Both, because either alone lets something through: a licensed
 * source whose document was rejected for another reason, or a released document
 * whose source only ever allowed linking.
 *
 * With provenance (0197), also refused unless the snapshot belongs to this
 * document, produced a version, and was not a failed extraction — so a chunk can
 * always be traced to the exact bytes it was cut from, and text from a parse
 * that failed never reaches the corpus. Every chunk records its own hash.
 */
export async function writeChunks(
  documentRef: string, chunks: readonly ChunkWrite[], provenance?: ChunkProvenance,
): Promise<ChunkResult> {
  const db = await dbOrThrow();

  let versionRef: string | null = null;
  let topicsJson: string[] | null = null;
  if (provenance) {
    const topics = validateTopics(provenance.topics);
    if (!topics.ok) return { written: false, code: "BAD_TOPICS", reason: topics.reason };
    topicsJson = [...topics.topics];
    const [snap] = await db.select().from(knowledgeSnapshots)
      .where(eq(knowledgeSnapshots.snapshotRef, provenance.snapshotRef)).limit(1);
    if (!snap) return { written: false, code: "SNAPSHOT_NOT_FOUND", reason: `no snapshot "${provenance.snapshotRef}"` };
    if (snap.documentRef !== documentRef) {
      return { written: false, code: "SNAPSHOT_DOCUMENT_MISMATCH", reason: `snapshot "${snap.snapshotRef}" is a retrieval of "${snap.documentRef}", not "${documentRef}"` };
    }
    if (!snap.versionRef || !snap.contentSha256) {
      return { written: false, code: "SNAPSHOT_NOT_USABLE", reason: `snapshot "${snap.snapshotRef}" was ${snap.outcome} and produced no trustworthy content` };
    }
    if (snap.extractionStatus === "failed") {
      return { written: false, code: "EXTRACTION_FAILED", reason: `extraction of "${snap.snapshotRef}" failed: ${snap.extractionError ?? "no reason recorded"}` };
    }
    versionRef = snap.versionRef;
  }

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
    versionRef,
    snapshotRef: provenance?.snapshotRef ?? null,
    contentHash: sha256Hex(c.text),
    topicsJson,
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

/* ------------------------------------------------------------------ */
/* The catalogue (0197)                                                */
/* ------------------------------------------------------------------ */

export type CatalogueWrite = { written: true; sourceId: string } | { written: false; code: string; reason: string };

/**
 * Describe a source: publisher, format, authority, topics, crawl cadence.
 *
 * Idempotent, and blind to the licence. The upsert names only catalogue
 * columns, so re-running the seed never changes what a source is permitted —
 * a source somebody has assessed stays assessed, and one nobody has stays
 * `unassessed`, which the column default makes the starting point.
 *
 * A source that has been deactivated is not reactivated by re-seeding:
 * `active` is not in the update set. Retiring a source is a decision, and a
 * seed script is not the place to reverse one.
 */
export async function registerCatalogueEntry(entry: CatalogueEntry): Promise<CatalogueWrite> {
  const verdict = validateCatalogueEntry(entry);
  if (!verdict.ok) return { written: false, code: verdict.code, reason: verdict.reason };
  const db = await dbOrThrow();

  const catalogue = {
    sourceName: entry.sourceName,
    owner: entry.owner,
    jurisdiction: entry.jurisdiction,
    homeUrl: entry.homeUrl,
    sourceKind: entry.sourceKind,
    authorityLevel: entry.authorityLevel,
    domainsJson: [...entry.domains],
    topicsJson: [...entry.topics],
    refreshIntervalHours: entry.refreshIntervalHours,
    crawlPolicyJson: { ...entry.crawlPolicy },
    termsUrl: entry.termsUrl,
    accessControlled: entry.accessControlled,
    licenceNotes: entry.licenceNotes,
  };
  await db.insert(knowledgeSources)
    .values({ sourceId: entry.sourceId, ...catalogue })
    .onDuplicateKeyUpdate({ set: catalogue });
  return { written: true, sourceId: entry.sourceId };
}

/** Retire a source. Its rows and history stay; nothing is fetched from it again. */
export async function deactivateSource(sourceId: string, reason: string): Promise<boolean> {
  if (!reason.trim()) throw new Error("deactivating a source needs a stated reason");
  const db = await dbOrThrow();
  const [res] = await db.update(knowledgeSources)
    .set({ active: false, deactivatedReason: reason.slice(0, 300) })
    .where(eq(knowledgeSources.sourceId, sourceId));
  return (res as { affectedRows?: number }).affectedRows === 1;
}

/* ------------------------------------------------------------------ */
/* Retrievals (0197)                                                   */
/* ------------------------------------------------------------------ */

export type SnapshotRequest = {
  sourceId: string;
  documentRef: string;
  result: CollectResult;
  retrievedAt: Date;
  /** Where the original bytes were retained. Refused unless the licence permits keeping text. */
  rawObjectKey?: string | null;
  /** As stated by this version of the document. Leave null when it states none — never guess. */
  publishedAt?: Date | null;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  recordedByUserId?: number | null;
  provenance?: Record<string, unknown>;
  /**
   * What the parser made of the bytes, when it ran before recording. Given, versions are
   * compared on the extracted text and the extraction outcome is recorded with the snapshot;
   * absent, the raw bytes are compared and extraction stays `pending`.
   */
  extraction?:
    | { status: "extracted"; parserVersion: string; fingerprint: string }
    | { status: "failed"; parserVersion: string; error: string };
};

export type SnapshotRefusal =
  | UrlRefusal
  | "SOURCE_NOT_CATALOGUED" | "SOURCE_INACTIVE" | "NO_LICENCE_ASSESSMENT" | "PROHIBITED_SOURCE"
  | "DOCUMENT_NOT_FOUND" | "DOCUMENT_SOURCE_MISMATCH" | "RAW_RETENTION_NOT_AUTHORIZED" | "BAD_EFFECTIVE_RANGE";

/** Emitted when an official document changed. Checkpoint 1 returns it; a later checkpoint routes it to impact review. */
export type ChangeSignal = {
  kind: "REGULATORY_CHANGE_DETECTED";
  sourceId: string; documentRef: string; snapshotRef: string;
  fromVersionRef: string; toVersionRef: string; authorityLevel: string;
};

export type SnapshotResult =
  | { recorded: true; snapshotRef: string; outcome: RetrievalOutcome; versionRef: string | null; change: ChangeSignal | null }
  | { recorded: false; code: SnapshotRefusal; reason: string };

const newRef = (prefix: string) => `${prefix}-${randomUUID()}`;

/**
 * Record one retrieval of a document, whatever happened.
 *
 * Refusals (nothing written) are for requests that should never have been
 * made: an uncatalogued, retired, unassessed or prohibited source, a document
 * that is not this source's, a URL outside the source's domains, or bytes
 * retained from a source whose licence does not allow keeping text.
 *
 * Everything else is recorded — including a page that was down and bytes whose
 * hash did not match — because "we checked and could not read it" is part of
 * the audit trail. What differs is whether a version results:
 *
 *   first_seen / changed   a new `candidate` version, pointing back at the one it
 *                          supersedes; the old one is marked `superseded`, which
 *                          is what puts its rules in front of a person
 *   unchanged              the existing version is confirmed; nothing new
 *   unavailable            no version; the previous one is untouched — a page
 *                          being down is not a rule being repealed
 *   hash_mismatch          no version, and no raw object reference either
 *   unparseable            bytes kept as evidence, no version: without text there
 *                          is no basis for saying the rule changed
 *
 * "Changed" means the extracted text changed when a parser ran first
 * (`req.extraction`), and the bytes changed otherwise.
 *
 * The document row is locked for the duration, so two collectors finishing at
 * once cannot both decide they saw the first version.
 */
export async function recordSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
  const db = await dbOrThrow();
  const refuse = (code: SnapshotRefusal, reason: string): SnapshotResult => ({ recorded: false, code, reason });

  const [source] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.sourceId, req.sourceId)).limit(1);
  if (!source) return refuse("SOURCE_NOT_CATALOGUED", `"${req.sourceId}" is not in the source catalogue`);
  if (!source.active) return refuse("SOURCE_INACTIVE", `"${req.sourceId}" is retired: ${source.deactivatedReason ?? "no reason recorded"}`);

  const licence = licenceFor(req.sourceId);
  if (!licence) return refuse("NO_LICENCE_ASSESSMENT", `"${req.sourceId}" has no stored licence assessment; nothing may be retrieved from it`);
  if (licence.status === "prohibited") return refuse("PROHIBITED_SOURCE", `"${source.sourceName}" is prohibited`);

  const domains = Array.isArray(source.domainsJson) ? (source.domainsJson as string[]) : [];
  const url = validateSourceUrl(req.result.url, domains);
  if (!url.ok) return refuse(url.code, url.reason);

  if (req.rawObjectKey && !checkSourceGate(req.sourceId, "rag_ingestion").allowed) {
    return refuse("RAW_RETENTION_NOT_AUTHORIZED",
      `keeping the original bytes of "${source.sourceName}" is reproduction, and its licence does not permit rag_ingestion; record the hash only`);
  }
  if (req.effectiveFrom && req.effectiveUntil && req.effectiveUntil <= req.effectiveFrom) {
    return refuse("BAD_EFFECTIVE_RANGE", "effectiveUntil must be after effectiveFrom");
  }

  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.documentRef, req.documentRef)).for("update").limit(1);
    if (!doc) return refuse("DOCUMENT_NOT_FOUND", `no document "${req.documentRef}"; quarantine it first`);
    if (doc.sourceId !== req.sourceId) {
      return refuse("DOCUMENT_SOURCE_MISMATCH", `"${req.documentRef}" belongs to "${doc.sourceId}", not "${req.sourceId}"`);
    }

    const [latest] = await tx.select().from(knowledgeSnapshots)
      .where(eq(knowledgeSnapshots.documentRef, req.documentRef))
      .orderBy(desc(knowledgeSnapshots.retrievedAt), desc(knowledgeSnapshots.id)).limit(1);
    const [lastGood] = await tx.select().from(knowledgeSnapshots)
      .where(and(eq(knowledgeSnapshots.documentRef, req.documentRef), isNotNull(knowledgeSnapshots.versionRef)))
      .orderBy(desc(knowledgeSnapshots.retrievedAt), desc(knowledgeSnapshots.id)).limit(1);
    // Compare against the current version's fingerprint, not the last snapshot's raw bytes.
    const [current] = lastGood?.versionRef
      ? await tx.select({ contentHash: knowledgeVersions.contentHash }).from(knowledgeVersions)
          .where(eq(knowledgeVersions.versionRef, lastGood.versionRef)).limit(1)
      : [];

    const cls = classifyRetrieval(current?.contentHash ?? null, {
      httpStatus: req.result.httpStatus, body: req.result.body, declaredSha256: req.result.declaredSha256,
    }, req.extraction ? (req.extraction.status === "extracted"
      ? { status: "extracted", fingerprint: req.extraction.fingerprint } : { status: "failed" }) : undefined);

    let versionRef: string | null = null;
    let change: ChangeSignal | null = null;
    const snapshotRef = newRef("KS");

    if (cls.newVersion && cls.fingerprint) {
      versionRef = newRef("KV");
      const supersedes = lastGood?.versionRef ?? null;
      await tx.insert(knowledgeVersions).values({
        versionRef, documentRef: req.documentRef, contentHash: cls.fingerprint,
        effectiveFrom: req.effectiveFrom ?? null, effectiveUntil: req.effectiveUntil ?? null,
        publishedAt: req.publishedAt ?? null, supersedesVersionRef: supersedes,
        retrievedAt: req.retrievedAt,
        // 0189: a revision fetched by a machine is a candidate. Only a named person makes it
        // `verified` (promotionLedger.verifySourceRevision), and only `verified` backs a rule.
        status: "candidate",
      });
      if (supersedes) {
        // Marking the old revision superseded is what routes the change to a person: every rule
        // promoted from it now appears in promotionLedger.rulesOnStaleSources, and no new rule can
        // be promoted from it. The rule itself is not touched. A withdrawn revision stays withdrawn.
        await tx.update(knowledgeVersions).set({ supersededByVersionRef: versionRef })
          .where(eq(knowledgeVersions.versionRef, supersedes));
        await tx.update(knowledgeVersions).set({ status: "superseded" })
          .where(and(eq(knowledgeVersions.versionRef, supersedes), ne(knowledgeVersions.status, "withdrawn")));
        change = {
          kind: "REGULATORY_CHANGE_DETECTED", sourceId: req.sourceId, documentRef: req.documentRef, snapshotRef,
          fromVersionRef: supersedes, toVersionRef: versionRef, authorityLevel: source.authorityLevel,
        };
      }
    } else if (cls.outcome === "unchanged") {
      versionRef = lastGood?.versionRef ?? null;
    }

    const trustworthy = cls.sha256 !== null;
    await tx.insert(knowledgeSnapshots).values({
      snapshotRef, sourceId: req.sourceId, documentRef: req.documentRef, url: url.url,
      retrievedAt: req.retrievedAt,
      collectorKind: req.result.collectorKind, collectorVersion: req.result.collectorVersion.slice(0, 40),
      outcome: cls.outcome, outcomeReason: cls.reason.slice(0, 500),
      httpStatus: req.result.httpStatus,
      contentType: req.result.contentType?.slice(0, 120) ?? null,
      etag: req.result.etag?.slice(0, 200) ?? null,
      lastModified: req.result.lastModified?.slice(0, 64) ?? null,
      byteLength: req.result.body ? req.result.body.byteLength : null,
      contentSha256: cls.sha256,
      declaredSha256: req.result.declaredSha256?.slice(0, 128) ?? null,
      // Bytes that failed their hash are not evidence; do not point at them.
      rawObjectKey: trustworthy ? (req.rawObjectKey ?? null) : null,
      previousSnapshotRef: latest?.snapshotRef ?? null,
      versionRef,
      publishedAt: cls.newVersion ? (req.publishedAt ?? null) : null,
      effectiveFrom: cls.newVersion ? (req.effectiveFrom ?? null) : null,
      effectiveUntil: cls.newVersion ? (req.effectiveUntil ?? null) : null,
      // A parse that ran is recorded with the snapshot; otherwise only a new version has anything to extract.
      extractionStatus: req.extraction && cls.sha256 ? req.extraction.status : cls.newVersion ? "pending" : "not_applicable",
      parserVersion: req.extraction && cls.sha256 ? req.extraction.parserVersion.slice(0, 40) : null,
      extractionError: req.extraction?.status === "failed" && cls.sha256 ? req.extraction.error.slice(0, 500) : null,
      provenanceJson: {
        ...(req.provenance ?? {}),
        licenceAssessmentId: licence.assessment_id,
        fingerprintBasis: cls.fingerprintBasis,
        ...(req.rawObjectKey && !trustworthy ? { rawObjectKeyDiscarded: true } : {}),
      },
      recordedByUserId: req.recordedByUserId ?? null,
    });

    return { recorded: true as const, snapshotRef, outcome: cls.outcome, versionRef, change };
  });
}

export type ExtractionOutcome =
  | { status: "extracted"; parserVersion: string }
  | { status: "failed"; parserVersion: string; error: string };

/**
 * Record how parsing a snapshot went. Once.
 *
 * A failure is recorded, not retried in place: the snapshot keeps saying what
 * happened, the previous version's chunks stay exactly as they were, and
 * `writeChunks` refuses text from the failed snapshot. The database trigger
 * refuses a second outcome even if this function were bypassed.
 */
export async function recordExtraction(snapshotRef: string, outcome: ExtractionOutcome): Promise<boolean> {
  const db = await dbOrThrow();
  const [res] = await db.update(knowledgeSnapshots)
    .set({
      extractionStatus: outcome.status,
      parserVersion: outcome.parserVersion.slice(0, 40),
      extractionError: outcome.status === "failed" ? outcome.error.slice(0, 500) : null,
    })
    .where(and(eq(knowledgeSnapshots.snapshotRef, snapshotRef), eq(knowledgeSnapshots.extractionStatus, "pending")));
  return (res as { affectedRows?: number }).affectedRows === 1;
}

/** Every version of a document, oldest first — the input `provenance.versionInForce` reads. */
export async function versionHistory(documentRef: string) {
  const db = await dbOrThrow();
  return db.select({
    versionRef: knowledgeVersions.versionRef,
    contentHash: knowledgeVersions.contentHash,
    effectiveFrom: knowledgeVersions.effectiveFrom,
    effectiveUntil: knowledgeVersions.effectiveUntil,
    supersedesVersionRef: knowledgeVersions.supersedesVersionRef,
    supersededByVersionRef: knowledgeVersions.supersededByVersionRef,
  }).from(knowledgeVersions).where(eq(knowledgeVersions.documentRef, documentRef)).orderBy(knowledgeVersions.id);
}

/* ------------------------------------------------------------------ */
/* What an ingestion run reads (Checkpoint 2)                          */
/* ------------------------------------------------------------------ */

/** The catalogue row an ingestion run works from, or null when the source is not catalogued. */
export async function sourceForIngestion(sourceId: string) {
  const db = await dbOrThrow();
  const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.sourceId, sourceId)).limit(1);
  return row ?? null;
}

/**
 * Record what robots.txt said for a source's host. Written on every check, so the row
 * always says when the crawler last asked — the answer RFC 9309 lets it trust for 24 hours.
 */
export async function recordRobotsCheck(
  sourceId: string, status: "fetched" | "absent" | "unreachable", checkedAt: Date,
): Promise<void> {
  const db = await dbOrThrow();
  await db.update(knowledgeSources).set({ robotsStatus: status, robotsCheckedAt: checkedAt })
    .where(eq(knowledgeSources.sourceId, sourceId));
}

/**
 * The document already tracking this URL for this source, if any, with what its latest
 * retrieval said — the validators a conditional request sends, and when it was taken.
 * One document per URL is what makes "changed content under the same URL" a version
 * rather than a second document.
 */
export async function documentForUrl(sourceId: string, url: string) {
  const db = await dbOrThrow();
  const [doc] = await db.select({ documentRef: knowledgeDocuments.documentRef, state: knowledgeDocuments.state })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.url, url)))
    .orderBy(knowledgeDocuments.id).limit(1);
  if (!doc) return null;
  const [last] = await db.select({
    retrievedAt: knowledgeSnapshots.retrievedAt, etag: knowledgeSnapshots.etag, lastModified: knowledgeSnapshots.lastModified,
  }).from(knowledgeSnapshots).where(eq(knowledgeSnapshots.documentRef, doc.documentRef))
    .orderBy(desc(knowledgeSnapshots.retrievedAt), desc(knowledgeSnapshots.id)).limit(1);
  return { ...doc, last: last ?? null };
}
