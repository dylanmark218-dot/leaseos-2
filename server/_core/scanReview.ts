/**
 * v23.28 — what a person sees after a scan: what was read, what is missing, and what to do.
 *
 * This is the join, and it is deliberately the only new thinking in the scanner's office half.
 * `shared/paperworkGuidance` knows what this kind of paperwork needs; `shared/printability`
 * decides whether that may go on paper; `_core/scanAutoLink` proposes which record it belongs to;
 * `_core/paperworkRetention` hands the retention question to the engine that owns it. None of them
 * knows about the others, and this file composes the four into the one screen a driver at a
 * facility gate actually uses.
 *
 * Everything it returns is advice or a proposal. It confirms nothing, links nothing, prints
 * nothing and blocks nothing.
 *
 * ## Why the order of the actions matters
 *
 * A driver reads the first line and maybe the second. So the actions come back ranked by what is
 * recoverable only right now: a missing gate signature is unrecoverable the moment the truck
 * moves, a bad photograph is recoverable while the paper is in hand, and a missing GST
 * registration number can be chased from the office next week. Sorting by severity instead would
 * put "check the total" above "get it signed", which is the wrong instruction to give somebody
 * standing at a gate.
 *
 * ## Why there is no second completeness verdict
 *
 * An earlier draft of this file computed its own `complete` boolean from "are all required fields
 * present". That is `assessPrintability`'s question, it already has a better answer — it knows a
 * provisional value on a regulatory document is worse than a missing one on an informational
 * document — and two answers to it would disagree the first time somebody edited one. So the
 * verdict here IS the printability verdict, and `readyToFile` is derived from it.
 */

import { assessPrintability, type PrintAssessment, type PrintField } from "@shared/printability";
import {
  guidanceFor, toPrintFields,
  type FieldObservation, type GuidanceContext, type PaperworkGuidance, type PaperworkKind,
} from "@shared/paperworkGuidance";
import { proposeLinks, type AutoLinkProposal, type ExistingLink, type TrackingBinding } from "./scanAutoLink";

/** What the device reported about one page, as it survives in the capture. */
export type ScannedPageSummary = {
  pageIndex: number;
  contentHash: string;
  qualityVerdict: "acceptable" | "unjudged" | "reshoot";
  qualityFailures: readonly string[];
  acceptedOverObjection: boolean;
  ocrAttempted: boolean;
  ocrFailed?: boolean;
  ocrMeanConfidence: number | null;
  ocrText: string | null;
  barcodes: readonly { format: string; value: string }[] | null;
};

export type ScanActionUrgency =
  /** Gone the moment the truck moves. */
  | "before_you_leave"
  /** Recoverable while the paper is in hand. */
  | "while_you_have_the_paper"
  /** The office can chase it. */
  | "before_filing";

export type ScanAction = {
  urgency: ScanActionUrgency;
  text: string;
  /** Which part of the review raised it, so a reader can go back to the source. */
  from: "paperwork" | "quality" | "recognition" | "linking";
};

export type ScanReview = {
  kind: PaperworkKind;
  guidance: PaperworkGuidance;
  /** The manifest handed to printability. Provisional means OCR read it and nobody confirmed it. */
  fields: PrintField[];
  /** Printability's verdict, not a second opinion on it. */
  printability: PrintAssessment;
  links: AutoLinkProposal;
  /** Ranked by what is recoverable only right now. */
  actions: ScanAction[];
  /**
   * True when nothing on this scan needs a person before it is filed: printability is content and
   * no page wants re-shooting. Never true for an unclassified document, because `unknown` carries
   * the regulatory class and an empty field manifest, which printability refuses outright.
   */
  readyToFile: boolean;
};

const URGENCY_ORDER: ScanActionUrgency[] = ["before_you_leave", "while_you_have_the_paper", "before_filing"];

/**
 * A field whose absence cannot be fixed later.
 *
 * Signatures and the counterparty's own reference are the two that vanish with the other party.
 * Everything else on a page can be read again from the page.
 */
const UNRECOVERABLE_ONCE_YOU_LEAVE = /signature|receiving|pin|ticket_number/i;

/** Below this mean confidence, a read is the kind faded thermal paper produces. */
export const FADED_READ_CONFIDENCE = 70;

export function reviewScan(args: {
  kind: PaperworkKind | string;
  pages: readonly ScannedPageSummary[];
  /** How each field got its value. OCR proposals arrive here as `proposed`, never as `confirmed`. */
  observations?: readonly FieldObservation[];
  context?: GuidanceContext;
  trackingBindings?: readonly TrackingBinding[];
  existingLink?: ExistingLink | null;
  /** False when the device had no recognizer at all. */
  textRecognitionRan?: boolean;
}): ScanReview {
  const ctx = args.context ?? {};
  const guidance = guidanceFor(args.kind, ctx);
  const fields = toPrintFields(args.kind, args.observations ?? [], ctx);
  const printability = assessPrintability(guidance.documentClass, fields);

  const combinedText = args.pages.map(p => p.ocrText ?? "").filter(t => t.length > 0).join("\n\n");
  const barcodes = args.pages.reduce<{ format: string; value: string }[]>(
    (acc, p) => acc.concat((p.barcodes ?? []) as { format: string; value: string }[]), [],
  );

  const links = proposeLinks({
    bindings: args.trackingBindings ?? [],
    barcodes,
    ocrText: combinedText.length > 0 ? combinedText : null,
    existingLink: args.existingLink ?? null,
  });

  const actions: ScanAction[] = [];

  // 1. What the paperwork itself is missing — read off printability's own blockers and markings,
  //    so the advice cannot disagree with the verdict.
  for (const b of printability.blockers) {
    actions.push({
      urgency: UNRECOVERABLE_ONCE_YOU_LEAVE.test(b.key) ? "before_you_leave" : "before_filing",
      text: `${b.label}: ${b.reason}.`,
      from: "paperwork",
    });
  }
  for (const m of printability.markings) {
    actions.push({
      urgency: UNRECOVERABLE_ONCE_YOU_LEAVE.test(m.key) ? "before_you_leave" : "before_filing",
      text: `${m.label} will print as ${m.mark}. Confirm it against the page if you can.`,
      from: "paperwork",
    });
  }

  // 2. Photographs worth taking again, which is only possible now.
  for (const page of args.pages) {
    if (page.qualityVerdict !== "reshoot") continue;
    const detail = page.qualityFailures[0] ?? "the capture did not meet the quality floor";
    actions.push({
      urgency: "while_you_have_the_paper",
      text: page.acceptedOverObjection
        ? `Page ${page.pageIndex + 1} was kept despite a quality objection (${detail}). Re-shoot it if the paper is still to hand.`
        : `Page ${page.pageIndex + 1}: ${detail}`,
      from: "quality",
    });
  }

  const unjudged = args.pages.filter(p => p.qualityVerdict === "unjudged").length;
  if (unjudged > 0) {
    actions.push({
      urgency: "while_you_have_the_paper",
      text: `This device does not score capture quality, so ${unjudged} page${unjudged > 1 ? "s were" : " was"} stored without being checked. Read ${unjudged > 1 ? "them" : "it"} on screen before you accept.`,
      from: "quality",
    });
  }

  // 3. What nothing read.
  if (args.textRecognitionRan === false) {
    actions.push({
      urgency: "before_filing",
      text: "No text recognizer was available on this device, so nothing was read off these pages. The images are safe and queued; every field will have to be entered by hand.",
      from: "recognition",
    });
  } else {
    const failed = args.pages.filter(p => p.ocrFailed === true);
    if (failed.length > 0) {
      actions.push({
        urgency: "while_you_have_the_paper",
        text: `Text recognition failed on ${failed.length} of ${args.pages.length} page${args.pages.length > 1 ? "s" : ""} (page${failed.length > 1 ? "s" : ""} ${failed.map(p => p.pageIndex + 1).join(", ")}). Those images are stored and will need reading by hand.`,
        from: "recognition",
      });
    }
    const scored = args.pages.filter(p => typeof p.ocrMeanConfidence === "number");
    const faded = scored.filter(p => (p.ocrMeanConfidence as number) < FADED_READ_CONFIDENCE);
    if (faded.length > 0) {
      actions.push({
        urgency: "while_you_have_the_paper",
        text:
          `Text recognition is unsure about ${faded.length} page${faded.length > 1 ? "s" : ""} ` +
          `(mean confidence ${faded.map(p => Math.round(p.ocrMeanConfidence as number)).join(", ")}). ` +
          "Faded thermal paper reads like this. Check every value against the page rather than accepting what was read.",
        from: "recognition",
      });
    }
  }

  // 4. Which record it belongs to. The disposition decides the words; nothing here links.
  if (links.disposition === "requires_review") {
    actions.push({ urgency: "before_filing", text: links.reasons[0]!, from: "linking" });
  } else if (links.disposition === "propose_single" && links.best) {
    actions.push({
      urgency: "before_filing",
      text: `${links.best.trackingNumber} is proposed as the ${links.best.target} (${links.best.source === "barcode" ? "from a barcode" : "read off the page"}). Confirm it — nothing is attached until you do.`,
      from: "linking",
    });
  } else if (links.disposition === "no_candidates") {
    actions.push({ urgency: "before_filing", text: "No tracking number was found on this scan. Pick the record it belongs to by hand.", from: "linking" });
  } else if (links.disposition === "not_configured" && (args.trackingBindings?.length ?? 0) > 0) {
    actions.push({ urgency: "before_filing", text: links.reasons[0]!, from: "linking" });
  }

  actions.sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));

  return {
    kind: guidance.kind,
    guidance,
    fields,
    printability,
    links,
    actions,
    readyToFile:
      printability.verdict === "printable" &&
      !args.pages.some(p => p.qualityVerdict === "reshoot"),
  };
}
