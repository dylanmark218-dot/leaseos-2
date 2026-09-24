/**
 * v22.20 (0101) — the first path where a person asks and LeaseOS answers.
 *
 * **There is no model here.** Every sentence returned is a passage from the
 * company's own documents, quoted. That is a deliberate stage, not a
 * limitation to apologise for: it proves retrieval, admission, citation and the
 * honest verdict against real rows, and when a model is added later it is
 * added behind machinery already known to work. The alternative — wire the
 * model first and the grounding after — produces something that demos
 * beautifully and cannot be audited.
 *
 * What this does prove:
 *
 *   ADMISSION   every passage comes through `contextAdmission`, so a passage
 *               belonging to another organization is refused with the same
 *               words as one that does not exist
 *   GROUNDING   `evidenceGrounding` grades the answer; a retrieved passage from
 *               a superseded revision supports nothing
 *   HONESTY     "nothing in the loaded documents answers this" is a real
 *               outcome, recorded as such
 *
 * The recorded query is the point of the audit trail. An assistant that said
 * "insufficient evidence" needs to be able to show it said so, and one that
 * answered from a retired revision needs to be findable afterwards.
 */
import { checkAssistantPassageUse } from "./_core/knowledge/sourceGate";
import { TRPCError } from "@trpc/server";
import { createHash } from "crypto";
import { z } from "zod";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, listActiveUserRoleNames } from "./db";
import { permissionsFor } from "./_core/recordsAuthorization";
import { assistantQueries, knowledgePassages, retrievalMeasurements, retrievalProbes } from "../drizzle/schema";
import { asc, desc } from "drizzle-orm";
import { resolveActingScope } from "./_core/actingScope";
import type { DbOrTx } from "./_core/dbTypes";
import { admitSource, type ActingContext, type ContextResolver } from "./_core/contextAdmission";
import { verifyAnswer, verifyClaim, type Claim, type Passage } from "./_core/evidenceGrounding";
import { caveatFor, gradeRetrieval, scoreProbe, stem, vocabularyGaps, type Probe, type ProbeResult } from "./_core/retrievalQuality";
import { domainTerms, termOverlap } from "./_core/domainTokens";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const MAX_PASSAGES = 8;

/**
 * Which retriever this is.
 *
 * Bump the version whenever candidate generation or scoring changes. A
 * measurement carries this so a recall figure cannot certify an implementation
 * that did not produce it.
 */
const RETRIEVER_KEY = "mysql-natural-language";
// Kept inside the column's 30 characters: a longer name failed the insert,
// which only surfaced against a database with no earlier measurement to reuse.
const RETRIEVER_VERSION = "lexical-v3";

/**
 * The resolver that makes a passage model-readable.
 *
 * Built per request so it closes over the acting scope — a resolver that could
 * be called without one would be a resolver that could be called without a
 * tenant.
 */
function passageResolver(d: DbOrTx): ContextResolver {
  return {
    resolverKey: "knowledgePassage",
    resolve: async (sourceRef, acting) => {
      // An unclassified passage answers as absent here too: the same words for "no such passage"
      // as admission gives another organization's, rather than a different, informative refusal.
      const row = (await d.select().from(knowledgePassages).where(and(eq(knowledgePassages.passageRef, sourceRef), quotable())).limit(1))[0];
      // Absent and foreign answer alike; admission turns both into "no such".
      if (!row || row.tenantId !== acting.tenantId) return null;
      return {
        sourceRef: row.passageRef,
        kind: "retrieved_document" as const,
        proof: { kind: "row" as const, tenantId: row.tenantId! },
        // A permission this system actually defines. "document.read" was not
        // one — it named nothing, so checking it would have refused everybody
        // or, as it did, nobody.
        permission: "assistant.ask",
        // Projected: the body and its identity, never the whole row.
        text: row.body,
      };
    },
  };
}

/**
 * Term overlap, and nothing cleverer.
 *
 * The fraction of the question's distinct words that appear in the passage.
 * It is not semantic: a passage answering the question in other words scores
 * zero, and one restating the question without answering it scores one. It is
 * the same number used to rank and to gate, so what is shown is what was
 * judged — which matters more here than the measure being sophisticated.
 */
/**
 * Term overlap, on domain terms.
 *
 * The measure is unchanged; which words count is what was wrong — stopwords
 * were scoring as evidence and measurements were being discarded.
 */
function lexicalScore(body: string, question: string): number {
  return termOverlap(body, question, stem);
}

/**
 * The retrieval the assistant actually performs.
 *
 * Shared with the probe harness on purpose: a harness that measured its own
 * private copy would report the recall of code nobody runs.
 */
/**
 * 0151 — the passages that may be quoted to a person.
 *
 * A row whose `reproductionBasis` is `unstated` predates the rule and nobody has classified it.
 * Unknown is not permission: it stays in the table so a person can classify it, and stays out of
 * every customer-visible answer until they do. One predicate, used by all four read paths —
 * retrieval, the direct passage read, the corpus fingerprint and the library listing — because a
 * condition repeated four times is a condition that will be forgotten once. The listing was in
 * fact forgotten in the first draft, and a probe with the filter disabled is what found it.
 */
const QUOTABLE_BASES = ["own_document", "licensed_source"] as const;
const quotable = () => inArray(knowledgePassages.reproductionBasis, QUOTABLE_BASES as unknown as string[]);

async function retrieve(d: DbOrTx, args: { tenantId: string; question: string; limit: number }) {
  /* Ordered by relevance, explicitly.
   *
   * The limit was applied to whatever order the database happened to return,
   * so a passage could be cut from the candidate set before the score that
   * decides support ever saw it — and no amount of care in that later score
   * can rescue a row that never arrived. Candidate generation is a separate
   * signal from the one that ranks the answer; it should at least be a
   * deterministic one. */
  const relevance = sql<number>`MATCH(${knowledgePassages.body}) AGAINST (${args.question} IN NATURAL LANGUAGE MODE)`;
  return d.select().from(knowledgePassages)
    .where(and(eq(knowledgePassages.tenantId, args.tenantId), quotable(), sql`${relevance} > 0`))
    .orderBy(desc(relevance), asc(knowledgePassages.id))
    .limit(args.limit);
}

/**
 * What corpus this is.
 *
 * Everything retrieval and grounding consult: the passage, its text, its
 * revision, its window, its jurisdiction. Superseding a passage changes what
 * an answer may cite while leaving a passage count and a newest-created date
 * exactly where they were, which is why those two were description and this is
 * identity.
 */
async function corpusFingerprint(d: DbOrTx, tenantId: string): Promise<{ hash: string; passageCount: number; newestAt: Date | null }> {
  const rows = await d.select({
    passageRef: knowledgePassages.passageRef, body: knowledgePassages.body,
    revision: knowledgePassages.revision, effectiveFrom: knowledgePassages.effectiveFrom,
    supersededAt: knowledgePassages.supersededAt, jurisdiction: knowledgePassages.jurisdiction,
    createdAt: knowledgePassages.createdAt,
  }).from(knowledgePassages).where(and(eq(knowledgePassages.tenantId, tenantId), quotable())).limit(20_000);

  const ordered = [...rows].sort((a, b) => a.passageRef.localeCompare(b.passageRef));
  const basis = ordered.map(r => ({
    passageRef: r.passageRef,
    bodyHash: createHash("sha256").update(r.body).digest("hex"),
    revision: r.revision,
    effectiveFrom: r.effectiveFrom?.toISOString() ?? null,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    jurisdiction: r.jurisdiction,
  }));
  return {
    hash: createHash("sha256").update(JSON.stringify(basis)).digest("hex"),
    passageCount: rows.length,
    newestAt: rows.reduce<Date | null>((max, r) => (!max || r.createdAt > max ? r.createdAt : max), null),
  };
}

export const assistantAskRouter = router({
  /**
   * Ask a question of the loaded documents.
   *
   * Extractive. The answer is the passages themselves, graded — LeaseOS does
   * not compose prose it cannot cite.
   *
   * A mutation, because asking is recorded. It was written as a query, which is
   * how a screen refetching on window focus would have filed a second "question
   * asked" that nobody asked — and the record is the point: an assistant that
   * answered "insufficient evidence" has to be able to show that it said so,
   * and a log padded with phantom asks is not evidence of anything.
   */
  ask: roleProcedure("assistant.ask")
    .input(z.object({
      question: z.string().min(3).max(1000),
      jurisdiction: z.string().max(20).optional(),
      /**
       * Which day's documents to answer from — "what did the manual say on 1
       * March". Evidence validity only.
       *
       * When the question was asked is a different fact and belongs to the
       * server. One field was doing both, so a caller could file an audit row
       * dated whenever it liked, in the table whose entire purpose is showing
       * what was asked and when.
       */
      asOf: z.coerce.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      // A question of only short words scores zero against everything and would
      // return "nothing supports this" — true, and misleading about why.
      if (!domainTerms(input.question).length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That question has no searchable terms; nothing could be looked up." });
      }
      const acting = await resolveActingScope(d, ctx.user.id);
      const asOf = input.asOf ?? new Date();
      // The caller's real permissions. Hardcoding ["document.read"] made every
      // asker appear to hold it, which is a lie told to the authorization layer
      // — and it would have gone unnoticed until the first passage type that
      // needed a permission somebody lacked.
      const heldPermissions = permissionsFor(await listActiveUserRoleNames(ctx.user.id)) as string[];
      const actingContext: ActingContext = {
        userId: ctx.user.id, tenantId: acting.tenantId,
        heldPermissions,
        /* Derived from how this caller's scope was established. A user acting
           through a real organization membership is in a deployment where
           legacy single-tenant proof is no longer good enough; one on the
           fallback is not. Frozen at false, the admission module's refusal
           could never fire, and the protection was decorative. */
        multiTenant: acting.derivedFrom === "membership",
      };

      /* Retrieve candidates, scoped to this organization in the query itself
         rather than filtered afterwards. */
      const candidates = await retrieve(d, { tenantId: acting.tenantId, question: input.question, limit: MAX_PASSAGES * 3 });

      /* Everything the model would see goes through admission — all of it,
         before any truncation. Cutting to the top eight by the database's
         ranking and then gating on a different score meant a passage could be
         discarded before the score that actually decides ever saw it. */
      const resolver = passageResolver(d);
      const resolvers = new Map([["knowledgePassage", resolver]]);
      const admittedPassages: Passage[] = [];
      for (const row of candidates) {
        let admittedText: string;
        try {
          const block = await admitSource({
            resolvers, sourceKind: "knowledgePassage", sourceRef: row.passageRef,
            acting: actingContext, at: asOf, blockRef: `B-${row.passageRef}`,
          });
          // The admitted projection, not the raw row. Discarding it and reading
          // the row again would make admission a check rather than a gate, and
          // the projection the place a future field quietly escapes.
          admittedText = block.text;
        } catch {
          // Surfaced by the retriever is not entitled to be read.
          continue;
        }
        admittedPassages.push({
          passageRef: row.passageRef, documentRef: row.documentRef, documentTitle: row.documentTitle,
          section: row.section, page: row.page, text: admittedText, revision: row.revision,
          effectiveFrom: row.effectiveFrom, supersededAt: row.supersededAt,
          jurisdiction: row.jurisdiction, score: lexicalScore(admittedText, input.question),
        });
      }

      /* One signal decides both order and admission to the answer. Ranking by
         the database's relevance and gating on a different number meant the
         eight most relevant by one measure were judged by another. */
      const passages = admittedPassages
        .sort((a2, b2) => b2.score - a2.score)
        .slice(0, MAX_PASSAGES);

      /* One claim: that these passages answer the question asked. Composing
         several claims needs a model to decompose the answer, which is the
         next stage and not this one. */
      const claim: Claim = {
        claimRef: "Q1", text: input.question,
        citedPassageRefs: passages.map(p => p.passageRef),
        jurisdiction: input.jurisdiction ?? null,
      };
      const claimVerdict = verifyClaim({ claim, passages, at: asOf });
      const answer = verifyAnswer([claimVerdict]);

      const queryRef = ref("ASK");
      await d.insert(assistantQueries).values({
        queryRef, tenantId: acting.tenantId, askedByUserId: ctx.user.id,
        question: input.question, jurisdiction: input.jurisdiction ?? null,
        verdict: answer.state,
        passagesRetrieved: candidates.length,
        passagesSupporting: claimVerdict.support.length,
        citedPassageRefsJson: JSON.stringify(claimVerdict.support.map(p => p.passageRef)),
        // The server's clock. The caller chooses what to answer from, never when it asked.
        askedAt: new Date(),
      });

      // What is known about this corpus's retrieval travels with the answer.
      // An answer from an unmeasured corpus is not wrong; it is uncalibrated,
      // and the difference is the reader's to know.
      const probeCount = (await d.select({ probeRef: retrievalProbes.probeRef }).from(retrievalProbes)
        .where(and(eq(retrievalProbes.tenantId, acting.tenantId), isNull(retrievalProbes.retiredAt))).limit(500)).length;

      /* The last measurement, and whether it still describes this corpus.
         This previously graded an empty array, so the screen reported
         "unmeasured" for ever — counting probes beside a figure that ignored
         them, which is worse than not showing the count at all. */
      const fingerprint = await corpusFingerprint(d, acting.tenantId);
      const measurement = (await d.select().from(retrievalMeasurements)
        .where(eq(retrievalMeasurements.tenantId, acting.tenantId))
        .orderBy(desc(retrievalMeasurements.id)).limit(1))[0];

      /* Corpus, implementation and depth. A recall@20 figure is a true number
         about a product that shows twenty; an answer showing eight cannot
         borrow it, and neither can a retriever that did not produce it. */
      const mismatch = measurement == null ? "none"
        : measurement.corpusHash !== fingerprint.hash ? "corpus"
        : measurement.k !== MAX_PASSAGES ? "depth"
        : measurement.retrieverKey !== RETRIEVER_KEY || measurement.retrieverVersion !== RETRIEVER_VERSION ? "retriever"
        : null;
      const measurementApplies = measurement != null && mismatch === null;
      const quality = measurementApplies
        ? {
            grade: measurement.grade, probeCount: measurement.probeCount,
            meanRecall: measurement.meanRecallBasisPoints == null ? null : measurement.meanRecallBasisPoints / 10_000,
            completeMisses: [], k: measurement.k,
            line: `recall@${measurement.k} measured against this exact corpus`,
          }
        : gradeRetrieval([], MAX_PASSAGES);

      // A measurement over a corpus that has since changed is not out of date;
      // it is about something else, and saying so beats quietly reusing it.
      const MISMATCH_NOTE: Record<string, string> = {
        corpus: "the documents have changed since — that figure describes a different corpus",
        depth: `it was measured at ${measurement?.k} results while answers show ${MAX_PASSAGES} — a true number about a different product`,
        retriever: "the retriever has changed since — that figure describes a different implementation",
      };
      const caveat = mismatch && mismatch !== "none"
        ? { clean: false, caveat: `Retrieval was measured, but ${MISMATCH_NOTE[mismatch]}. Re-run the measurement before relying on it.` }
        : caveatFor(quality);

      return {
        queryRef,
        verdict: answer.state,
        headline: answer.headline,
        retrievalQuality: quality.grade,
        retrievalCaveat: caveat.caveat,
        probesOnFile: probeCount,
        /* The answer is the passages. Quoted, not paraphrased. */
        passages: claimVerdict.support.map(p => ({
          passageRef: p.passageRef, documentTitle: p.documentTitle, section: p.section,
          page: p.page, revision: p.revision, text: p.text,
        })),
        rejected: claimVerdict.rejected,
        sources: answer.sources,
        note: "Every sentence here is quoted from a loaded document. LeaseOS does not compose prose it cannot cite, and no model wrote this answer.",
      };
    }),

  /**
   * What *I* asked, and what I was told. Read-only.
   *
   * AIL-1A.1 (owner ruling): raw assistant history is USER-scoped. Sharing an organization does not
   * let one person read another's questions, and `assistant.ask` — held by drivers — is not a
   * privilege to review colleagues. No existing permission means "review other people's AI
   * conversations" (`assistant.curate` governs what is loaded, not who may be read), so there is no
   * cross-user path; a privileged review would be its own permission, decided later. Company learning
   * will consume derived signals, never this raw text. Owner and person come from the session; the
   * input is strict, so a forged user or organization field is refused rather than ignored.
   */
  history: roleProcedure("assistant.askHistory")
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      // Newest first. Unordered with a limit, a curator past thirty questions
      // would have been shown whichever the database happened to return.
      const rows = await d.select().from(assistantQueries)
        .where(and(eq(assistantQueries.tenantId, acting.tenantId), eq(assistantQueries.askedByUserId, ctx.user.id)))
        .orderBy(desc(assistantQueries.id)).limit(input.limit);
      const labelled = new Set((await d.select({ originQueryRef: retrievalProbes.originQueryRef })
        .from(retrievalProbes).where(eq(retrievalProbes.tenantId, acting.tenantId)).limit(2000))
        .map(r => r.originQueryRef).filter((r): r is string => r != null));
      return {
        queries: rows.map(r => ({
          queryRef: r.queryRef, question: r.question, verdict: r.verdict,
          passagesRetrieved: r.passagesRetrieved, passagesSupporting: r.passagesSupporting,
          citedPassageRefs: JSON.parse(r.citedPassageRefsJson) as string[],
          askedAt: r.askedAt,
          labelled: labelled.has(r.queryRef),
        })),
        note: "An assistant that answered insufficient evidence should be able to show that it said so.",
      };
    }),

  /** Record a labelled probe: a question and the passages that should answer it. */
  addProbe: roleProcedure("assistant.addProbe")
    .input(z.object({
      question: z.string().min(3).max(1000),
      expectedPassageRefs: z.array(z.string().min(1).max(64)).min(1).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      // A probe naming a passage from elsewhere would measure nothing.
      const found = await d.select({ passageRef: knowledgePassages.passageRef }).from(knowledgePassages)
        .where(and(eq(knowledgePassages.tenantId, acting.tenantId), inArray(knowledgePassages.passageRef, input.expectedPassageRefs)));
      if (found.length !== input.expectedPassageRefs.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "One or more of those passages does not exist here" });
      }
      const probeRef = ref("PRB");
      await d.insert(retrievalProbes).values({
        probeRef, tenantId: acting.tenantId, question: input.question,
        expectedPassageRefsJson: JSON.stringify(input.expectedPassageRefs),
        // Always authored. A real question is not something a request can
        // declare itself to be — see addProbeFromAsk.
        authoredByUserId: ctx.user.id, origin: "authored_from_document",
      });
      return {
        probeRef, origin: "authored_from_document" as const,
        note: "Recorded as written from the document. A set of only these measures whether retrieval finds a passage from its own words, which it nearly always does — real questions come from recorded asks, not from this procedure.",
      };
    }),

  /**
   * Browse the corpus, for labelling.
   *
   * Deliberately **not** the retriever under test. A curator has to be able to
   * find a passage that retrieval missed — that is the whole finding — and a
   * browse built on the same MATCH query could only ever surface what already
   * surfaced. This is a plain scan with a substring filter: slower, dumber, and
   * the only kind that can show you the thing your retriever cannot see.
   */
  passageList: roleProcedure("assistant.passageList")
    .input(z.object({
      contains: z.string().max(200).optional(),
      documentRef: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).default({ limit: 50 }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const rows = await d.select().from(knowledgePassages)
        .where(and(
          eq(knowledgePassages.tenantId, acting.tenantId),
          // The fourth read path: browsing the library is a customer-visible answer like any other.
          quotable(),
          input.documentRef ? eq(knowledgePassages.documentRef, input.documentRef) : undefined,
          // LIKE, not MATCH. Substring rather than relevance, so a term the
          // retriever's index does not carry is still findable.
          input.contains ? like(knowledgePassages.body, `%${input.contains}%`) : undefined,
        ))
        .limit(input.limit);
      return {
        passages: rows.map(r => ({
          passageRef: r.passageRef, documentRef: r.documentRef, documentTitle: r.documentTitle,
          section: r.section, page: r.page, body: r.body, revision: r.revision,
          supersededAt: r.supersededAt, jurisdiction: r.jurisdiction,
        })),
        note: "A plain scan, not the retriever. Finding a passage here that an answer did not cite is the measurement working.",
      };
    }),

  /**
   * Label a question somebody actually asked.
   *
   * The question is copied from the recorded ask rather than retyped, so
   * `real_question` is a fact about where the words came from instead of a
   * claim the caller makes about itself.
   *
   * What this deliberately does not do is adopt the passages the assistant
   * returned. A curator names the passages that *should* answer, which may
   * include ones retrieval never surfaced — that gap is the entire measurement.
   * Accepting the retrieved set would let the retriever mark its own homework
   * and then be graded on it.
   */
  addProbeFromAsk: roleProcedure("assistant.addProbeFromAsk")
    .input(z.object({
      queryRef: z.string().min(1).max(64),
      expectedPassageRefs: z.array(z.string().min(1).max(64)).min(1).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);

      // AIL-1A.1: only the asker's own question can be labelled. Another person's raw question is
      // not theirs to copy into the organization's probe set, and "not found" does not say it exists.
      const ask = (await d.select().from(assistantQueries)
        .where(and(eq(assistantQueries.queryRef, input.queryRef), eq(assistantQueries.tenantId, acting.tenantId), eq(assistantQueries.askedByUserId, ctx.user.id)))
        .limit(1))[0];
      if (!ask) throw new TRPCError({ code: "NOT_FOUND", message: "No such recorded question" });

      const found = await d.select({ passageRef: knowledgePassages.passageRef }).from(knowledgePassages)
        .where(and(eq(knowledgePassages.tenantId, acting.tenantId), inArray(knowledgePassages.passageRef, input.expectedPassageRefs)));
      if (found.length !== input.expectedPassageRefs.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "One or more of those passages does not exist here" });
      }

      // Labelling one question five times produced five "real questions" from
      // one person asking once, weighting the set toward whatever a curator
      // revisited.
      const existing = (await d.select({ probeRef: retrievalProbes.probeRef }).from(retrievalProbes)
        .where(eq(retrievalProbes.originQueryRef, ask.queryRef)).limit(1))[0];
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `That question is already labelled as ${existing.probeRef}. One ask is one question, however many times it is reviewed.`,
        });
      }

      const probeRef = ref("PRB");
      await d.insert(retrievalProbes).values({
        probeRef, tenantId: acting.tenantId,
        // Copied, never retyped.
        question: ask.question,
        expectedPassageRefsJson: JSON.stringify(input.expectedPassageRefs),
        authoredByUserId: ctx.user.id,
        origin: "real_question", originQueryRef: ask.queryRef,
      });

      const cited = JSON.parse(ask.citedPassageRefsJson) as string[];
      const missed = input.expectedPassageRefs.filter(r => !cited.includes(r));
      return {
        probeRef, origin: "real_question" as const, question: ask.question, originQueryRef: ask.queryRef,
        /* Stated at labelling time, because it is the finding: passages a
           person says should have answered and retrieval did not return. */
        notRetrievedWhenAsked: missed,
        note: missed.length
          ? `${missed.length} of the passages you named were not returned when this was asked. That gap is what the measurement is for.`
          : "Every passage you named was returned when this was asked.",
      };
    }),

  /**
   * Run every probe and report recall.
   *
   * Measures the retrieval the assistant performs, not a copy of it.
   *
   * A mutation, because it records a measurement. It was a query — the same
   * mistake as `ask`, which I had fixed one change earlier and did not then
   * look for anywhere else. A refetch would have filed another measurement of
   * a run nobody asked for.
   */
  measureRetrieval: roleProcedure("assistant.measureRetrieval")
    .input(z.object({ k: z.number().int().min(1).max(50).default(MAX_PASSAGES) }).default({ k: MAX_PASSAGES }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const rows = await d.select().from(retrievalProbes)
        .where(and(eq(retrievalProbes.tenantId, acting.tenantId), isNull(retrievalProbes.retiredAt))).limit(500);

      const results: ProbeResult[] = [];
      for (const row of rows) {
        const probe: Probe = {
          probeRef: row.probeRef, question: row.question,
          expectedPassageRefs: JSON.parse(row.expectedPassageRefsJson) as string[],
          authoredByUserId: row.authoredByUserId, origin: row.origin,
        };
        const retrieved = await retrieve(d, { tenantId: acting.tenantId, question: probe.question, limit: input.k });
        results.push(scoreProbe(probe, retrieved.map(r => r.passageRef), input.k));
      }

      // The depth measured against the depth answers actually show.
      const quality = gradeRetrieval(results, input.k, MAX_PASSAGES);
      const bodies = new Map<string, string>();
      for (const r of results) {
        for (const ref of r.expected) {
          if (bodies.has(ref)) continue;
          const row = (await d.select().from(knowledgePassages).where(eq(knowledgePassages.passageRef, ref)).limit(1))[0];
          if (row) bodies.set(ref, row.body);
        }
      }
      const gaps = vocabularyGaps(results, r => bodies.get(r) ?? null);

      // A measurement describes the corpus it ran against, so the corpus is
      // recorded with it. Fifty new documents later this number is not out of
      // date — it is about something else.
      const fingerprint = await corpusFingerprint(d, acting.tenantId);
      const measurementRef = ref("MEAS");
      await d.insert(retrievalMeasurements).values({
        measurementRef, tenantId: acting.tenantId, k: input.k, grade: quality.grade,
        probeCount: quality.probeCount,
        realQuestionCount: results.filter(r => r.origin === "real_question").length,
        meanRecallBasisPoints: quality.meanRecall == null ? null : Math.round(quality.meanRecall * 10_000),
        corpusPassageCount: fingerprint.passageCount, corpusNewestPassageAt: fingerprint.newestAt, corpusHash: fingerprint.hash,
        retrieverKey: RETRIEVER_KEY, retrieverVersion: RETRIEVER_VERSION,
        measuredByUserId: ctx.user.id, measuredAt: new Date(),
      });

      return {
        measurementRef,
        corpus: { passageCount: fingerprint.passageCount, newestPassageAt: fingerprint.newestAt, hash: fingerprint.hash },
        quality, results, vocabularyGaps: gaps,
        note: gaps.length
          ? "Some questions share no words with the passages that answer them. That is not a ranking problem and tuning the score will not fix it."
          : quality.line,
      };
    }),

  /** Load a passage. Separate from asking, and permissioned separately. */
  addPassage: roleProcedure("assistant.addPassage")
    .input(z.object({
      documentRef: z.string().min(1).max(64),
      documentTitle: z.string().min(1).max(300),
      section: z.string().max(120).optional(),
      page: z.number().int().min(1).optional(),
      body: z.string().min(1).max(8000),
      revision: z.string().min(1).max(40),
      effectiveFrom: z.coerce.date().optional(),
      supersededAt: z.coerce.date().optional(),
      jurisdiction: z.string().max(20).optional(),
      // 0150/0151: why this text may be reproduced. There is no default: a person states it.
      reproductionBasis: z.enum(["own_document", "licensed_source"]),
      /** Required for a licensed source: the source id the licence registry keys. */
      sourceId: z.string().min(1).max(64).optional(),
      /**
       * Required for an own document: what the person is actually claiming. It is an assertion,
       * not a proof of title, and it is recorded as one so a later review can find who claimed
       * what. An anonymous own-document claim is how third-party text gets in unlabelled.
       */
      rightsAssertion: z.string().min(20).max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      /*
       * 0151, after human review. Two bases, two different obligations, and they are not
       * interchangeable: company-owned material does not go through a third-party licence
       * assessment, and third-party material does not get in as an anonymous own-document claim.
       *
       * A licensed source must clear BOTH rights the library exercises — storing and indexing the
       * text (rag_ingestion) and returning it to a person in a paid product (commercial_redisplay).
       * checkAssistantPassageUse asks both; the first version asked only redisplay, which would
       * have admitted a source that may be shown but not stored.
       */
      let stampedAssessment: string | null = null;
      let stampedSource: string | null = null;
      if (input.reproductionBasis === "licensed_source") {
        if (!input.sourceId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A licensed source must name the source id the licence registry keys" });
        }
        if (input.rightsAssertion) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A licensed source is authorized by its assessment, not by an assertion; remove rightsAssertion" });
        }
        const use = checkAssistantPassageUse(input.sourceId);
        if (!use.allowed) throw new TRPCError({ code: "FORBIDDEN", message: use.reason });
        // Stamped from the gate's own record, never from the request: the assessment is what a
        // revocation sweeps by, and a typed value could name an assessment that says otherwise.
        stampedAssessment = use.assessmentId;
        stampedSource = use.sourceId;
      } else {
        if (!input.rightsAssertion) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "An own document needs the rights assertion the person is making — that this organization holds the right to load and quote this text" });
        }
        if (input.sourceId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "An own document names no licensed source; remove sourceId or state the basis as licensed_source" });
        }
      }
      const passageRef = ref("PSG");
      await d.insert(knowledgePassages).values({
        passageRef, tenantId: acting.tenantId,
        documentRef: input.documentRef, documentTitle: input.documentTitle,
        section: input.section ?? null, page: input.page ?? null,
        body: input.body, revision: input.revision,
        effectiveFrom: input.effectiveFrom ?? null, supersededAt: input.supersededAt ?? null,
        jurisdiction: input.jurisdiction ?? null,
        reproductionBasis: input.reproductionBasis,
        sourceId: stampedSource,
        licenceAssessmentRef: stampedAssessment,
        rightsAssertion: input.rightsAssertion ?? null,
        loadedByUserId: ctx.user.id,
      });
      return {
        passageRef, basis: input.reproductionBasis,
        authorizedBy: stampedAssessment,
        note: stampedAssessment
          ? `Loaded. Both rights the library exercises — storing the text and returning it to a person — are authorized by ${stampedAssessment}, which is what a revocation will sweep by.`
          : "Loaded. Recorded as this organization's own material on the assertion of the person who loaded it; that is an assertion, not a proof of title.",
      };
    }),

  /** Retire a revision without deleting it. */
  supersedePassage: roleProcedure("assistant.supersedePassage")
    .input(z.object({ passageRef: z.string().min(1).max(64), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const row = (await d.select().from(knowledgePassages).where(eq(knowledgePassages.passageRef, input.passageRef)).limit(1))[0];
      if (!row || row.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such passage" });
      await d.update(knowledgePassages).set({ supersededAt: input.at })
        .where(and(eq(knowledgePassages.passageRef, input.passageRef), eq(knowledgePassages.tenantId, acting.tenantId)));
      return { passageRef: input.passageRef, note: "Retired. It stays readable as history and supports nothing said about today." };
    }),
});
