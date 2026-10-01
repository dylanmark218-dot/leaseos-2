/**
 * The paperwork surface: what this document needs, and what a scan of it is
 * still missing.
 *
 * Two queries and no mutations, deliberately. Everything behind this router is
 * arithmetic over guidance rows and over what a device already captured —
 * nothing here writes a record, attaches a scan to a job, or confirms a value.
 * Those are separate acts with their own procedures and their own permissions,
 * and folding them in here would turn "show me what this ticket needs" into a
 * path that changes things.
 *
 * Both sit on `compliance.read`. A worker who may not read the company's
 * compliance material may not read its paperwork guidance either; that is one
 * question, and it already had an answer.
 *
 * Every rule these return is UNVERIFIED and says so on its face. See
 * `_core/documentGuidance.ts` — LeaseOS has read a planning report, not the
 * regulations, and the `verification` field on every response is how a caller
 * knows which of those it is holding.
 */

import { z } from "zod";
import { desc } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { trackingSequences } from "../drizzle/schema";
import { guidanceFor, paperworkChecklist, type PaperworkKind } from "./_core/documentGuidance";
import type { LinkTargetKind, TrackingBinding } from "./_core/scanAutoLink";
import { reviewScan, type ScannedPageSummary } from "./_core/scanReview";

const KIND = z.enum([
  "tdg_shipping_document", "hazardous_waste_manifest", "disposal_ticket", "load_ticket",
  "scale_ticket", "fuel_receipt", "expense_receipt", "invoice", "bill_of_lading",
  "inspection_report", "safety_document", "unknown",
]);

const CONTEXT = z.object({
  /** Integer cents, as money is held everywhere else. */
  totalCents: z.number().int().nonnegative().nullable().optional(),
  jurisdiction: z.enum(["AB", "BC", "SK", "MB", "other"]).nullable().optional(),
}).optional();

const PAGE = z.object({
  pageIndex: z.number().int().nonnegative(),
  contentHash: z.string().min(1).max(128),
  qualityVerdict: z.enum(["acceptable", "unjudged", "reshoot"]),
  qualityFailures: z.array(z.string().max(400)).max(10).default([]),
  acceptedOverObjection: z.boolean().default(false),
  ocrAttempted: z.boolean(),
  ocrMeanConfidence: z.number().min(0).max(100).nullable(),
  ocrText: z.string().max(50_000).nullable(),
  barcodes: z.array(z.object({ format: z.string().max(40), value: z.string().max(4000) })).max(50).nullable(),
});

/**
 * Which minted sequences a scan can be linked to.
 *
 * A sequence type with no meaning on a scanned page — a credit note, a
 * write-off request — is simply not offered, because proposing "this disposal
 * ticket is credit note CR-2026-000019" is worse than proposing nothing.
 */
const SEQUENCE_TARGETS: Record<string, LinkTargetKind> = {
  DSP: "disposal",
  FT: "field_ticket",
  INV: "invoice",
};

/**
 * The formats as the office has them configured.
 *
 * Read from the sequence rows rather than written out here, so the matcher
 * follows a format change instead of quietly disagreeing with it. Several rows
 * share a sequence type — one per branch and period — and the most recently
 * updated one carries the current format.
 */
async function configuredBindings(): Promise<TrackingBinding[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(trackingSequences).orderBy(desc(trackingSequences.updatedAt));

  const seen = new Set<string>();
  const bindings: TrackingBinding[] = [];
  for (const r of rows) {
    const target = SEQUENCE_TARGETS[r.sequenceType];
    if (!target || seen.has(r.sequenceType)) continue;
    seen.add(r.sequenceType);
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

export const paperworkRouter = router({
  /**
   * What this kind of paperwork needs, and which of it is still missing.
   *
   * `confirmedFieldKeys` are fields a PERSON has entered or confirmed. Values
   * an OCR engine proposed are deliberately not accepted here: a checklist
   * that counted a proposal as present would report a ticket complete because
   * a model read a number off it.
   */
  guidance: roleProcedure("paperwork.guidance")
    .input(z.object({
      kind: KIND,
      confirmedFieldKeys: z.array(z.string().max(64)).max(100).default([]),
      context: CONTEXT,
    }))
    .query(({ input }) => {
      const kind = input.kind as PaperworkKind;
      const g = guidanceFor(kind, input.context ?? {});
      return {
        guidance: g,
        checklist: paperworkChecklist({
          kind,
          presentFieldKeys: input.confirmedFieldKeys,
          context: input.context ?? {},
        }),
      };
    }),

  /**
   * A scan, reviewed: the checklist, the link proposals, and what to do in the
   * order it stops being possible to do it.
   *
   * The pages are what the device reported about its own capture. The server
   * does not re-read the images — the recognizer ran on the handset and its
   * output is evidence of a read, not something to be re-derived here.
   */
  reviewScan: roleProcedure("paperwork.reviewScan")
    .input(z.object({
      kind: KIND,
      pages: z.array(PAGE).min(1).max(50),
      confirmedFieldKeys: z.array(z.string().max(64)).max(100).default([]),
      textRecognitionRan: z.boolean().default(true),
      context: CONTEXT,
    }))
    .query(async ({ input }) => reviewScan({
      kind: input.kind as PaperworkKind,
      pages: input.pages as ScannedPageSummary[],
      confirmedFieldKeys: input.confirmedFieldKeys,
      context: input.context ?? {},
      trackingBindings: await configuredBindings(),
      textRecognitionRan: input.textRecognitionRan,
    })),
});
