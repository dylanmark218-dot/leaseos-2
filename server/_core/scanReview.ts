/**
 * What a person sees after a scan: what was read, what is missing, and what to
 * do about it.
 *
 * This is the join. `scanSession.ts` on the device produces evidence and
 * reads; `documentGuidance.ts` knows what this kind of paperwork needs;
 * `scanAutoLink.ts` proposes which record it belongs to. None of them knows
 * about the others, and this file composes the three into the one screen a
 * driver at a facility gate actually uses.
 *
 * Everything it returns is advice or a proposal. It confirms nothing, links
 * nothing and blocks nothing — the confirmation is a person's act and the
 * blocking lives in the requirement engine, on verified rules, which these
 * are not.
 *
 * ## Why the order of the actions matters
 *
 * A driver reads the first line and maybe the second. So the actions come back
 * ranked by what is recoverable only right now: a missing gate signature is
 * unrecoverable the moment the truck moves, a bad photograph is recoverable
 * while the paper is in hand, and a missing GST registration number can be
 * chased from the office next week. Sorting these by severity rather than by
 * recoverability would put "check the total" above "get it signed", which is
 * the wrong instruction to give somebody standing at a gate.
 */

import {
  guidanceFor, paperworkChecklist, longestRetentionYears,
  type GuidanceContext, type PaperworkChecklist, type PaperworkKind,
} from "./documentGuidance";
import { proposeLinks, type AutoLinkProposal, type TrackingBinding } from "./scanAutoLink";

/** What the device reported about one page, as it survives in the capture. */
export type ScannedPageSummary = {
  pageIndex: number;
  contentHash: string;
  qualityVerdict: "acceptable" | "unjudged" | "reshoot";
  qualityFailures: readonly string[];
  acceptedOverObjection: boolean;
  ocrAttempted: boolean;
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
  from: "guidance" | "quality" | "recognition" | "linking";
};

export type ScanReview = {
  kind: PaperworkKind;
  checklist: PaperworkChecklist;
  links: AutoLinkProposal;
  /** Ranked by what is recoverable only right now. */
  actions: ScanAction[];
  /** The longest retention any rule names. null is UNKNOWN, never "none". */
  retentionYears: number | null;
  /**
   * True when nothing on this scan needs a person before it is filed. False
   * for an unclassified document, always: nobody has looked up what it needs.
   */
  readyToFile: boolean;
};

const URGENCY_ORDER: ScanActionUrgency[] = ["before_you_leave", "while_you_have_the_paper", "before_filing"];

/**
 * A field whose absence cannot be fixed later.
 *
 * Signatures and the counterparty's own reference are the two that vanish with
 * the other party. Everything else on a page can be read again from the page.
 */
const UNRECOVERABLE_ONCE_YOU_LEAVE = /signature|receiving|pin|ticket_number/i;

export function reviewScan(args: {
  kind: PaperworkKind;
  pages: readonly ScannedPageSummary[];
  /** Field keys a PERSON has entered or confirmed. OCR proposals do not count. */
  confirmedFieldKeys: readonly string[];
  context?: GuidanceContext;
  trackingBindings?: readonly TrackingBinding[];
  /** False when the device had no recognizer at all. */
  textRecognitionRan?: boolean;
}): ScanReview {
  const checklist = paperworkChecklist({
    kind: args.kind,
    presentFieldKeys: args.confirmedFieldKeys,
    context: args.context,
  });

  const combinedText = args.pages.map(p => p.ocrText ?? "").filter(t => t.length > 0).join("\n\n");
  const barcodes = args.pages.flatMap(p => p.barcodes ?? []);

  const links = proposeLinks({
    bindings: args.trackingBindings ?? [],
    barcodes,
    ocrText: combinedText.length > 0 ? combinedText : null,
  });

  const actions: ScanAction[] = [];

  // 1. What the paperwork itself is missing.
  for (const item of checklist.items) {
    if (item.present || item.advice == null) continue;
    actions.push({
      urgency: UNRECOVERABLE_ONCE_YOU_LEAVE.test(item.field.key) ? "before_you_leave" : "before_filing",
      text: item.advice,
      from: "guidance",
    });
  }

  // 2. Photographs worth taking again, which is only possible now.
  for (const page of args.pages) {
    if (page.qualityVerdict === "reshoot") {
      const detail = page.qualityFailures[0] ?? "the capture did not meet the quality floor";
      actions.push({
        urgency: "while_you_have_the_paper",
        text: page.acceptedOverObjection
          ? `Page ${page.pageIndex + 1} was kept despite a quality objection (${detail}). Re-shoot it if the paper is still to hand.`
          : `Page ${page.pageIndex + 1}: ${detail}`,
        from: "quality",
      });
    }
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
    const scored = args.pages.filter(p => p.ocrMeanConfidence != null);
    const faded = scored.filter(p => (p.ocrMeanConfidence as number) < 70);
    if (faded.length > 0) {
      actions.push({
        urgency: "while_you_have_the_paper",
        text:
          `Text recognition is unsure about ${faded.length} page${faded.length > 1 ? "s" : ""} ` +
          `(mean confidence ${faded.map(p => Math.round(p.ocrMeanConfidence as number)).join(", ")}). ` +
          `Faded thermal paper reads like this. Check every value against the page rather than accepting what was read.`,
        from: "recognition",
      });
    }
  }

  // 4. Which record it belongs to.
  if (links.ambiguous) {
    actions.push({ urgency: "before_filing", text: links.reasons[0]!, from: "linking" });
  } else if (links.best) {
    actions.push({
      urgency: "before_filing",
      text: `${links.best.trackingNumber} is proposed as the ${links.best.target} (${links.best.source === "barcode" ? "from a barcode" : "read off the page"}). Confirm it — nothing is attached until you do.`,
      from: "linking",
    });
  } else if ((args.trackingBindings?.length ?? 0) > 0) {
    actions.push({
      urgency: "before_filing",
      text: "No tracking number was found on this scan. Pick the record it belongs to by hand.",
      from: "linking",
    });
  }

  actions.sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));

  return {
    kind: checklist.kind,
    checklist,
    links,
    actions,
    retentionYears: longestRetentionYears(guidanceFor(args.kind, args.context ?? {}).retention),
    // An unclassified document is never ready: `checklist.complete` is already
    // false for it, and the quality gate is a second, independent reason.
    readyToFile: checklist.complete && !args.pages.some(p => p.qualityVerdict === "reshoot"),
  };
}
