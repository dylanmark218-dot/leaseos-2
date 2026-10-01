/**
 * AIL-1B — company intelligence: the governed write and read paths.
 *
 * An organization's terminology, shorthand, SOP knowledge, facility and customer conventions,
 * approved preferences, known gaps and verified corrections are `organizationKnowledgeEntries`
 * rows (0214). Rules (pure) are in `_core/companyKnowledge.ts`; this router owns everything that
 * needs the database:
 *
 *   OWNERSHIP   The organization is the session's acting scope, never input. Every read and write
 *               compares `tenantId` strictly, so another organization's entry is "not found".
 *   PROVENANCE  A source is checked, not asserted: a company document must be this organization's own
 *               current passage; a verified correction must be a field a person actually corrected on a
 *               record this organization committed. A raw assistant conversation is never a source.
 *   APPROVAL    An entry has no effect until a DIFFERENT person with `company_knowledge.review`
 *               approves it. Nothing approves automatically.
 *   LIFECYCLE   Approving a new meaning supersedes the old one; withdrawing one retires it. Neither
 *               deletes anything.
 *
 * Nothing here is read by a model. `lookup` is for people (and a later, separately approved
 * checkpoint), and it keeps the organization's meaning and the public directory's apart.
 */
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, orgScopeWhere } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { assistantCommitReceipts, assistantProposals, facilities, facilityAliases, knowledgePassages, organizationKnowledgeEntries } from "../drizzle/schema";
import {
  KNOWLEDGE_KINDS, SOURCE_KINDS, SUBJECT_TYPES, correctionInManifest, mayMove, mayReview, shapeRefusal, termKey, type EntryState,
} from "./_core/companyKnowledge";

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}
type Db = Awaited<ReturnType<typeof db>>;
const entryRef = () => `OKN-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

/** The acting organization, from the session only. */
async function actingOrg(d: Db, userId: number) {
  const a = await resolveActingScope(d, userId);
  return { tenantId: a.tenantId, derivedFrom: a.derivedFrom };
}

/** A facility the organization may name: a public directory facility, or one it owns. "Not found" otherwise. */
async function facilityNameable(d: Db, facilityId: number, scope: { tenantId: string }) {
  return (await d.select({ id: facilities.id }).from(facilities)
    .where(and(eq(facilities.id, facilityId), or(isNotNull(facilities.facilityKey), orgScopeWhere(facilities, scope)))).limit(1)).length > 0;
}

/** The checked provenance for a proposal, or the reason it was refused. */
async function provenanceRefusal(d: Db, scope: { tenantId: string }, e: { sourceKind: string; sourceRef: string | null; subjectRef: string | null }): Promise<string | null> {
  if (e.sourceKind === "company_document") {
    const p = (await d.select({ id: knowledgePassages.id }).from(knowledgePassages).where(and(
      eq(knowledgePassages.passageRef, e.sourceRef!), eq(knowledgePassages.tenantId, scope.tenantId),
      eq(knowledgePassages.reproductionBasis, "own_document"), isNull(knowledgePassages.supersededAt),
    )).limit(1))[0];
    return p ? null : "Company document not found";
  }
  if (e.sourceKind === "verified_correction") {
    // The receipt's proposal must be this organization's by its proved owner (0210), and the sealed
    // manifest must hold the named field as corrected by a person.
    const r = (await d.select({ formKey: assistantCommitReceipts.formKey, manifest: assistantCommitReceipts.fieldManifest })
      .from(assistantCommitReceipts).innerJoin(assistantProposals, eq(assistantProposals.proposalId, assistantCommitReceipts.proposalId))
      .where(and(eq(assistantCommitReceipts.proposalId, e.sourceRef!), eq(assistantProposals.tenantId, scope.tenantId))).limit(1))[0];
    if (!r) return "Committed record not found";
    return correctionInManifest(r.manifest, r.formKey, e.subjectRef ?? "") ? null : "That record has no person's correction to the named field";
  }
  return null;
}

const ENTRY_COLUMNS = {
  entryRef: organizationKnowledgeEntries.entryRef, kind: organizationKnowledgeEntries.kind, term: organizationKnowledgeEntries.term,
  meaning: organizationKnowledgeEntries.meaning, subjectType: organizationKnowledgeEntries.subjectType, subjectRef: organizationKnowledgeEntries.subjectRef,
  sourceKind: organizationKnowledgeEntries.sourceKind, sourceRef: organizationKnowledgeEntries.sourceRef, state: organizationKnowledgeEntries.state,
  proposedByUserId: organizationKnowledgeEntries.proposedByUserId, proposedAt: organizationKnowledgeEntries.proposedAt,
  reviewedByUserId: organizationKnowledgeEntries.reviewedByUserId, reviewedAt: organizationKnowledgeEntries.reviewedAt, reviewNote: organizationKnowledgeEntries.reviewNote,
  supersededByEntryRef: organizationKnowledgeEntries.supersededByEntryRef, retiredAt: organizationKnowledgeEntries.retiredAt, retireReason: organizationKnowledgeEntries.retireReason,
};

export const companyKnowledgeRouter = router({
  /**
   * Propose an entry. Any field worker may: the people who use the shorthand are the people who know
   * it. A proposal changes nothing until reviewed. Unknown fields — an organization, a state, a
   * reviewer — are refused, not dropped.
   */
  propose: roleProcedure("companyKnowledge.propose")
    .input(z.object({
      kind: z.enum(KNOWLEDGE_KINDS),
      term: z.string().min(1).max(220),
      meaning: z.string().min(1).max(4000),
      subjectType: z.enum(SUBJECT_TYPES).default("none"),
      subjectRef: z.string().min(1).max(160).nullable().default(null),
      sourceKind: z.enum(SOURCE_KINDS),
      sourceRef: z.string().min(1).max(120).nullable().default(null),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const refusal = shapeRefusal(input);
      if (refusal) throw new TRPCError({ code: "BAD_REQUEST", message: `Entry refused: ${refusal}` });
      const org = await actingOrg(d, ctx.user.id);
      if (input.subjectType === "facility") {
        const id = Number(input.subjectRef);
        if (!Number.isInteger(id) || id <= 0 || !(await facilityNameable(d, id, org))) throw notFound("Facility");
      }
      const prov = await provenanceRefusal(d, org, input);
      if (prov) throw new TRPCError({ code: "NOT_FOUND", message: prov });
      const ref = entryRef();
      await d.insert(organizationKnowledgeEntries).values({
        entryRef: ref, tenantId: org.tenantId, tenantDerivedFrom: org.derivedFrom,
        kind: input.kind, term: input.term.trim(), termKey: termKey(input.term), meaning: input.meaning.trim(),
        subjectType: input.subjectType, subjectRef: input.subjectRef, sourceKind: input.sourceKind, sourceRef: input.sourceRef,
        state: "proposed", proposedByUserId: ctx.user.id, proposedAt: new Date(),
      });
      return { entryRef: ref, state: "proposed" as const };
    }),

  /**
   * Approve or reject a proposal. A different person from the proposer, holding
   * `company_knowledge.review` (a sensitive permission: the decision is audited before it is made).
   * Approving supersedes the organization's previously approved meaning for the same term, kind and
   * subject, in the same transaction.
   */
  review: roleProcedure("companyKnowledge.review")
    .input(z.object({ entryRef: z.string().min(1).max(64), decision: z.enum(["approve", "reject"]), note: z.string().min(3).max(500) }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const org = await actingOrg(d, ctx.user.id);
      return d.transaction(async tx => {
        const e = (await tx.select().from(organizationKnowledgeEntries)
          .where(and(eq(organizationKnowledgeEntries.entryRef, input.entryRef), eq(organizationKnowledgeEntries.tenantId, org.tenantId))).for("update").limit(1))[0];
        if (!e) throw notFound("Entry");
        const to: EntryState = input.decision === "approve" ? "approved" : "rejected";
        if (!mayMove(e.state, to)) throw new TRPCError({ code: "CONFLICT", message: `Entry is ${e.state}` });
        if (!mayReview(e.proposedByUserId, ctx.user.id)) throw new TRPCError({ code: "FORBIDDEN", message: "The person who proposed an entry cannot review it" });
        const now = new Date();
        if (to === "approved") {
          await tx.update(organizationKnowledgeEntries).set({ state: "superseded", supersededByEntryRef: e.entryRef }).where(and(
            eq(organizationKnowledgeEntries.tenantId, org.tenantId), eq(organizationKnowledgeEntries.state, "approved"),
            eq(organizationKnowledgeEntries.kind, e.kind), eq(organizationKnowledgeEntries.termKey, e.termKey),
            eq(organizationKnowledgeEntries.subjectType, e.subjectType),
            e.subjectRef == null ? isNull(organizationKnowledgeEntries.subjectRef) : eq(organizationKnowledgeEntries.subjectRef, e.subjectRef),
          ));
        }
        await tx.update(organizationKnowledgeEntries).set({ state: to, reviewedByUserId: ctx.user.id, reviewedAt: now, reviewNote: input.note })
          .where(eq(organizationKnowledgeEntries.id, e.id));
        return { entryRef: e.entryRef, state: to };
      });
    }),

  /** Withdraw an approved entry. Kept, marked retired, with who and why. */
  retire: roleProcedure("companyKnowledge.retire")
    .input(z.object({ entryRef: z.string().min(1).max(64), reason: z.string().min(3).max(500) }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const org = await actingOrg(d, ctx.user.id);
      const e = (await d.select({ id: organizationKnowledgeEntries.id, state: organizationKnowledgeEntries.state }).from(organizationKnowledgeEntries)
        .where(and(eq(organizationKnowledgeEntries.entryRef, input.entryRef), eq(organizationKnowledgeEntries.tenantId, org.tenantId))).limit(1))[0];
      if (!e) throw notFound("Entry");
      if (!mayMove(e.state, "retired")) throw new TRPCError({ code: "CONFLICT", message: `Entry is ${e.state}` });
      await d.update(organizationKnowledgeEntries).set({ state: "retired", retiredByUserId: ctx.user.id, retiredAt: new Date(), retireReason: input.reason })
        .where(and(eq(organizationKnowledgeEntries.id, e.id), eq(organizationKnowledgeEntries.state, "approved")));
      return { entryRef: input.entryRef, state: "retired" as const };
    }),

  /** The organization's entries, newest first. */
  list: roleProcedure("companyKnowledge.list")
    .input(z.object({ states: z.array(z.enum(["proposed", "approved", "rejected", "superseded", "retired"])).min(1).max(5).optional(), kind: z.enum(KNOWLEDGE_KINDS).optional(), limit: z.number().int().positive().max(500).default(100) }).strict().optional())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const org = await actingOrg(d, ctx.user.id);
      return d.select(ENTRY_COLUMNS).from(organizationKnowledgeEntries).where(and(
        eq(organizationKnowledgeEntries.tenantId, org.tenantId),
        input?.states ? inArray(organizationKnowledgeEntries.state, input.states) : undefined,
        input?.kind ? eq(organizationKnowledgeEntries.kind, input.kind) : undefined,
      )).orderBy(desc(organizationKnowledgeEntries.proposedAt)).limit(input?.limit ?? 100);
    }),

  /**
   * What a term means here. The organization's APPROVED entries first; the public facility
   * directory's official aliases second, labelled GLOBAL and never merged into the organization's
   * answer. Another organization's meaning of the same word is never consulted.
   */
  lookup: roleProcedure("companyKnowledge.lookup")
    .input(z.object({ term: z.string().min(1).max(220) }).strict())
    .query(async ({ ctx, input }) => {
      const d = await db();
      const org = await actingOrg(d, ctx.user.id);
      const key = termKey(input.term);
      const organization = await d.select(ENTRY_COLUMNS).from(organizationKnowledgeEntries).where(and(
        eq(organizationKnowledgeEntries.tenantId, org.tenantId), eq(organizationKnowledgeEntries.termKey, key), eq(organizationKnowledgeEntries.state, "approved"),
      )).orderBy(desc(organizationKnowledgeEntries.reviewedAt)).limit(50);
      const global = (await d.select({ alias: facilityAliases.alias, relationship: facilityAliases.relationship, facilityKey: facilities.facilityKey, facilityName: facilities.name })
        .from(facilityAliases).innerJoin(facilities, eq(facilities.id, facilityAliases.facilityId))
        .where(and(eq(facilityAliases.alias, input.term.trim()), isNotNull(facilities.facilityKey))).limit(20))
        .map(g => ({ scope: "GLOBAL" as const, ...g }));
      return { term: input.term, organization: organization.map(o => ({ scope: "ORGANIZATION" as const, ...o })), global };
    }),
});
