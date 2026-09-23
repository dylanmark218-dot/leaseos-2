/**
 * v23.28 — the scanning surface: what this paperwork needs, and what a scan of it still lacks.
 *
 * The mirror of `printingRouter`. Printing asks "may this go on paper"; scanning asks "what did
 * the paper say, what is missing, and which record does it belong to". Both run the same
 * `shared/printability` assessment, because a scanned document and a printed one are the same
 * document at two moments and must not be judged by two different rules.
 *
 * Three queries and NO mutations, deliberately. Everything behind this router is arithmetic over
 * guidance rows and over what a device already captured. Nothing here writes a record, attaches a
 * scan to a job, confirms a value or issues a tracking number. Those are separate acts with their
 * own procedures and their own permissions, and folding them in here would turn "show me what this
 * ticket needs" into a path that changes things.
 *
 * All three sit on `compliance.read`. A worker who may not read the company's compliance material
 * may not read its paperwork guidance either; that is one question and it already had an answer.
 *
 * ## Tenancy
 *
 * `reviewScan` reads rows, so it resolves the acting scope — which means a caller with active
 * memberships in two organizations is REFUSED rather than silently resolved, the refusal
 * `resolveActingScope` exists to make. `guidance` and `retention` do not, because they read no
 * rows at all: they are the same answer for every organization, and `printing.assess` — the one
 * pure procedure on the sibling router — resolves no scope for exactly this reason.
 *
 * Neither `trackingSequences` nor `trackingReferences` carries an organization column, so a row in
 * either cannot be attributed on its own. Ownership is therefore taken from the SUBJECT a number
 * names — trip, job, manifest, field ticket or load — each of which has a real owner, rather than
 * from the reference row. A number naming no such subject stays unattributable and the scanner
 * says so instead of guessing. See `existingLinkFor`.
 *
 * ## Everything returned is unverified guidance
 *
 * See `shared/paperworkGuidance`. LeaseOS has read a planning report, not the regulations, and the
 * `verification` field on every response is how a caller knows which of those it is holding.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, resolveTrackingSubject, type ResolvedSubject } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { trackingReferences, trackingSequences } from "../drizzle/schema";
import { guidanceFor, toPrintFields, type PaperworkKind } from "@shared/paperworkGuidance";
import { assessPrintability } from "@shared/printability";
import { computeEffectiveRetention } from "./_core/retentionPolicy";
import { retentionPolicyFor } from "./_core/paperworkRetention";
import { reviewScan, type ScannedPageSummary } from "./_core/scanReview";
import type { ExistingLinkState, LinkTargetKind, TrackingBinding } from "./_core/scanAutoLink";

const KIND = z.enum([
  "expense_receipt", "fuel_receipt", "disposal_ticket", "load_ticket", "scale_ticket",
  "invoice", "safety_document", "unknown",
  "tdg_shipping_document", "hazardous_waste_manifest", "bill_of_lading", "inspection_report",
]);

const CONTEXT = z.object({
  /** Integer cents, as money is held everywhere else. */
  totalCents: z.number().int().nonnegative().nullable().optional(),
  jurisdiction: z.enum(["AB", "BC", "SK", "MB", "other"]).nullable().optional(),
}).optional();

/**
 * How each field got its value.
 *
 * `_core/aiProposal.FieldStatus`'s own four words. A caller may say a field was `proposed`; saying
 * it was `confirmed` is a claim that a person confirmed it, and the procedures here neither write
 * nor rely on that claim for anything but advice — the authoritative confirmation lives on the
 * extraction path, behind its own permission.
 */
const OBSERVATION = z.object({
  key: z.string().min(1).max(80),
  status: z.enum(["proposed", "confirmed", "rejected", "corrected"]),
});

const PAGE = z.object({
  pageIndex: z.number().int().nonnegative(),
  contentHash: z.string().min(1).max(128),
  qualityVerdict: z.enum(["acceptable", "unjudged", "reshoot"]),
  qualityFailures: z.array(z.string().max(400)).max(10).default([]),
  acceptedOverObjection: z.boolean().default(false),
  ocrAttempted: z.boolean(),
  ocrFailed: z.boolean().optional(),
  ocrMeanConfidence: z.number().min(0).max(100).nullable(),
  ocrText: z.string().max(50_000).nullable(),
  barcodes: z.array(z.object({ format: z.string().max(40), value: z.string().max(4000) })).max(50).nullable(),
});

/**
 * Which minted sequences a scan can be linked to.
 *
 * A sequence type with no meaning on a scanned page — a credit note, a write-off request — is
 * simply not offered, because proposing "this disposal ticket is credit note CR-2026-000019" is
 * worse than proposing nothing.
 */
const SEQUENCE_TARGETS: Record<string, LinkTargetKind> = {
  DSP: "disposal",
  FT: "field_ticket",
  INV: "invoice",
};

async function scopeFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, userId);
  return { db, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId, scope: { tenantId: scope.tenantId } };
}

/**
 * The formats as the office has them configured.
 *
 * Read from the sequence rows rather than written out here, so the matcher follows a format change
 * instead of quietly disagreeing with it. Several rows share a sequence type — one per branch and
 * period — and the most recently updated one carries the current format. A row whose configuration
 * is malformed is NOT filtered out here: it is passed through so `proposeLinks` can refuse it by
 * name, because a sequence that silently stops being searched is how auto-linking dies quietly.
 */
async function configuredBindings(db: Awaited<ReturnType<typeof getDb>>): Promise<TrackingBinding[]> {
  if (!db) return [];
  /*
   * `updatedAt` is a second-granularity timestamp, so "most recently updated" ties whenever two
   * rows of one sequence type are written in the same second — and the row that then wins is
   * whichever the engine happened to return. `id` breaks the tie by insertion order, which is
   * what "most recent" means when the clock cannot tell them apart. Without it the matcher picks
   * a format at random from the tied rows, and a scan silently stops recognizing its own tickets.
   */
  const rows = await db.select().from(trackingSequences)
    .orderBy(desc(trackingSequences.updatedAt), desc(trackingSequences.id));
  const seen: Record<string, true> = {};
  const bindings: TrackingBinding[] = [];
  for (const r of rows) {
    const target = SEQUENCE_TARGETS[r.sequenceType];
    if (!target || seen[r.sequenceType]) continue;
    seen[r.sequenceType] = true;
    bindings.push({
      target,
      format: {
        prefix: r.prefix,
        separator: r.separator,
        yearDigits: r.yearDigits === 4 ? 4 : r.yearDigits === 2 ? 2 : 0,
        includeMonth: r.includeMonth,
        sequenceDigits: r.sequenceDigits,
        resetPeriod: r.resetPeriod,
      },
    });
  }
  return bindings;
}

/**
 * Whether any number on this page is already attached to a record — and, crucially, whether we
 * can say WHOSE record it is.
 *
 * Established SERVER-side and never accepted from the request. The unsafe direction is a client
 * omitting a link that exists — that would let a second scan quietly re-attach evidence — so the
 * server looks it up itself and a caller has no field with which to say "not linked".
 *
 * The tenant boundary, and where it now comes from. `trackingReferences` is unique on
 * `trackingNumber` and carries NO organization column; neither does `trackingSequences`. So the
 * reference row itself still cannot say whose it is, and reporting one as "already linked to
 * disposal DSP-2026-000123" on the strength of a matching number would answer a cross-tenant
 * question with a guess.
 *
 * What changed is that ownership no longer has to come from the row. The number names a subject,
 * and the subject has a real owner: `resolveTrackingSubject` walks trip, job, manifest, field
 * ticket and load through the paths that already own them. So:
 *
 *   the number resolves to a subject in the caller's scope   → `owned`, and it may be named
 *   the number resolves to a subject somewhere else          → UNVERIFIABLE, nothing disclosed
 *   the number resolves to no subject this system can own    → UNVERIFIABLE, nothing disclosed
 *
 * The last case stays closed deliberately. A disposal or invoice reference is not one of the five
 * subjects, so a row bearing that number is still unattributable, and unknown counts against you.
 * That is the same answer as before for every case except the one that can now be proved.
 *
 * Nothing here is accepted from the request: the numbers come off the page and the scope comes
 * from the caller's membership.
 */
async function existingLinkFor(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: { tenantId: string },
  numbers: readonly string[],
): Promise<ExistingLinkState> {
  if (!db || numbers.length === 0) return { kind: "none" };
  for (const n of numbers) {
    const rows = await db.select().from(trackingReferences).where(eq(trackingReferences.trackingNumber, n)).limit(1);
    if (!rows[0]) continue;
    const resolved = await resolveTrackingSubject(n, scope);
    /*
     * The `in_scope` narrowing is the guard, and it is deliberately the ONLY
     * one: `SUBJECT_TARGETS` is total over the resolvable subjects, so there is
     * no second `if (!target)` to fall back on. Remove this check and the code
     * stops compiling rather than quietly returning `owned` — an earlier
     * version had both checks, which made this one redundant and let a mutation
     * that deleted it survive.
     */
    if (resolved.kind === "in_scope") {
      return { kind: "owned", link: { target: SUBJECT_TARGETS[resolved.subject], trackingNumber: n } };
    }
    return { kind: "ownership_unverifiable" };
  }
  return { kind: "none" };
}

/** What each resolvable subject is, in the vocabulary a link proposal speaks. Total, on purpose. */
const SUBJECT_TARGETS: Record<ResolvedSubject, LinkTargetKind> = {
  trip: "trip",
  job: "job",
  manifest: "manifest",
  field_ticket: "field_ticket",
  load: "load",
};

/** Every bare token on the page that could be a tracking number, for the already-linked lookup. */
function candidateNumbers(pages: readonly ScannedPageSummary[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    for (const b of p.barcodes ?? []) {
      for (const m of Array.from(b.value.matchAll(/[A-Z0-9]+(?:[-/][A-Z0-9]+){1,3}/gi))) out.push(m[0].toUpperCase());
    }
    for (const m of Array.from((p.ocrText ?? "").matchAll(/[A-Z0-9]+(?:[-/][A-Z0-9]+){1,3}/gi))) out.push(m[0].toUpperCase());
  }
  return Array.from(new Set(out)).slice(0, 50);
}

export const scanningRouter = router({
  /**
   * What this kind of paperwork needs, and what printability makes of what is known so far.
   *
   * `observations` say how each field got its value. There is deliberately no way to pass a VALUE:
   * this procedure decides nothing about what a document says, only about what is still unanswered.
   */
  guidance: roleProcedure("paperwork.guidance")
    .input(z.object({
      kind: KIND,
      observations: z.array(OBSERVATION).max(100).default([]),
      context: CONTEXT,
    }))
    // Pure, exactly like `printing.assess`: no ctx, no database, no rows. There is nothing here
    // to scope, because nothing here is anybody's data — it is the same guidance for every
    // organization, and a scope lookup would be a database round trip that changes no answer.
    .query(({ input }) => {
      const kind = input.kind as PaperworkKind;
      const context = input.context ?? {};
      const guidance = guidanceFor(kind, context);
      const fields = toPrintFields(kind, input.observations, context);
      return {
        guidance,
        fields,
        printability: assessPrintability(guidance.documentClass, fields),
      };
    }),

  /**
   * A scan, reviewed: the field manifest, printability's verdict, the link proposals, and what to
   * do in the order it stops being possible to do it.
   *
   * The pages are what the device reported about its own capture. The server does not re-read the
   * images — the recognizer ran on the handset and its output is evidence of a read, not something
   * to be re-derived here.
   */
  reviewScan: roleProcedure("paperwork.reviewScan")
    .input(z.object({
      kind: KIND,
      pages: z.array(PAGE).min(1).max(50),
      observations: z.array(OBSERVATION).max(100).default([]),
      textRecognitionRan: z.boolean().default(true),
      context: CONTEXT,
    }))
    .query(async ({ ctx, input }) => {
      const { db, scope } = await scopeFor(ctx.user.id);
      const pages = input.pages as ScannedPageSummary[];
      const bindings = await configuredBindings(db);
      const existing = await existingLinkFor(db, scope, candidateNumbers(pages));
      return reviewScan({
        kind: input.kind as PaperworkKind,
        pages,
        observations: input.observations,
        context: input.context ?? {},
        trackingBindings: bindings,
        existing,
        textRecognitionRan: input.textRecognitionRan,
      });
    }),

  /**
   * How long this kind of paperwork must be kept.
   *
   * Answers about a KIND, not about a particular sealed record, so no legal hold can apply — a
   * hold is placed on a record and there is no record yet. `underLegalHold` is therefore false
   * because it is true of the question, not because the hold was skipped, and the response says so.
   *
   * The statutory figure this carries is unverified, so `computeEffectiveRetention` applies company
   * policy and attaches its caveat rather than asserting statutory compliance. That caveat is the
   * point of this endpoint: it is what tells a reader the number is the company's, not the law's.
   */
  retention: roleProcedure("paperwork.retention")
    .input(z.object({
      kind: KIND,
      context: CONTEXT,
      companyRetentionMonths: z.number().int().positive().max(1200).optional(),
      contractRetentionMonths: z.number().int().positive().max(1200).nullable().optional(),
    }))
    // Pure for the same reason: a retention period for a KIND is not a row.
    .query(({ input }) => {
      const policy = retentionPolicyFor({
        kind: input.kind as PaperworkKind,
        context: input.context ?? {},
        companyRetentionMonths: input.companyRetentionMonths,
        contractRetentionMonths: input.contractRetentionMonths ?? null,
      });
      const guidance = guidanceFor(input.kind as PaperworkKind, input.context ?? {});
      return {
        policy,
        statutoryCitation: guidance.statutoryRetention.citation,
        whoMustRetain: guidance.statutoryRetention.whoMustRetain,
        guidanceVerification: guidance.verification,
        legalHoldConsulted: false,
        legalHoldNote:
          "This answers about a kind of document, not about a sealed record, so no legal hold applies. " +
          "A hold is placed on a record and outranks every period once it exists.",
        effective: computeEffectiveRetention({
          policy,
          // A kind-level question has no seal date; the caller reads the MONTHS and the basis, and
          // the dates below are relative to now purely so the shape is complete.
          sealedAt: new Date(),
          underLegalHold: false,
        }),
      };
    }),
});
