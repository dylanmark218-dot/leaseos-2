/**
 * v23.27 — what may go on paper, and what the paper is.
 *
 * Shared by the server and, once the native shell exists, the device: printing happens in a cab
 * with no signal, so the check that keeps a guess off paper has to run where the printer is. The
 * server runs the same function again when the print is recorded — and records the print whatever
 * it finds, because paper that exists and is not written down is worse than paper written down as
 * a breach. Paper cannot be recalled. It can be known about.
 *
 * Three questions:
 *   assessPrintability — may this document go on paper, and what must the paper say about itself?
 *   copyKindFor        — is this the first paper of this exact version, or a later one?
 *   staleCopies        — which paper in circulation no longer matches the record?
 */

/**
 * The state of one value on the document, read from its provenance.
 *
 *   confirmed    verified — a scale ticket, a signed line, a human confirmation
 *   provisional  a value exists and nobody has confirmed it — driver-stated, OCR pending, "about 8,000 L"
 *   unknown      the question matters and has not been answered — a permit requirement nobody determined
 *   absent       nothing there and nothing expected — an optional field left empty
 */
export type FieldState = "confirmed" | "provisional" | "unknown" | "absent";

/**
 * Who reads the paper decides how strict it must be.
 *
 *   regulatory     inspectors, scale operators, emergency responders — a TDG shipping document, a
 *                  waste manifest, a disposal ticket. They act on it and cannot tell a guess from a fact.
 *   commercial     the customer — a field ticket, a receipt, an invoice copy. A pending line may be
 *                  handed over, provided the paper says it is pending.
 *   informational  our own people — a trip summary, a load sheet. Never refused; always honest.
 */
export type DocumentClass = "regulatory" | "commercial" | "informational";

export type PrintField = { key: string; label: string; required: boolean; state: FieldState };
export type PrintBlocker = { key: string; label: string; reason: string };
export type PrintMark = "PROVISIONAL" | "NOT DETERMINED";
export type PrintMarking = { key: string; label: string; mark: PrintMark };
export type PrintVerdict = "printable" | "printable_with_markings" | "refused";
export type PrintAssessment = { verdict: PrintVerdict; blockers: PrintBlocker[]; markings: PrintMarking[] };

const REGULATORY_REASON: Record<Exclude<FieldState, "confirmed">, string> = {
  provisional: "Required on a regulatory document and not yet confirmed",
  unknown: "Required on a regulatory document and not determined",
  absent: "Required on a regulatory document and missing",
};

function markFor(state: FieldState): PrintMark | null {
  if (state === "provisional") return "PROVISIONAL";
  if (state === "unknown") return "NOT DETERMINED";
  return null;
}

export function assessPrintability(documentClass: DocumentClass, fields: readonly PrintField[]): PrintAssessment {
  const blockers: PrintBlocker[] = [];
  const markings: PrintMarking[] = [];

  /*
   * An empty manifest is not a clean one. A regulatory or commercial document that arrives with no
   * field list has not been checked, it has been skipped — and from outside the two look alike.
   */
  if (fields.length === 0 && documentClass !== "informational") {
    blockers.push({ key: "*", label: "field manifest", reason: "No field manifest was supplied, so nothing on this document has been checked" });
    return { verdict: "refused", blockers, markings };
  }

  const seen: Record<string, true> = {};
  for (const f of fields) {
    if (seen[f.key]) {
      // Two entries for one field are two answers, and printing either one hides the other.
      blockers.push({ key: f.key, label: f.label, reason: "The field manifest lists this field more than once" });
      continue;
    }
    seen[f.key] = true;
    if (f.state === "confirmed") continue;

    if (documentClass === "regulatory" && f.required) {
      /*
       * The strict case, and the reason this function exists. A required value on a regulatory
       * document is read by someone who will act on it — a responder deciding how to approach a
       * spill reads the UN number off the shipping document — and "PROVISIONAL" in small print does
       * not survive that reading. A required value that is not confirmed stops the print.
       */
      blockers.push({ key: f.key, label: f.label, reason: REGULATORY_REASON[f.state] });
      continue;
    }
    if (documentClass === "commercial" && f.required && (f.state === "unknown" || f.state === "absent")) {
      blockers.push({ key: f.key, label: f.label, reason: f.state === "absent" ? "Required and missing" : "Required and not determined" });
      continue;
    }

    /*
     * Everything else may go on paper, but never looking confirmed. A blank reads as "nothing to
     * declare", so an unknown value prints as NOT DETERMINED rather than as white space — and a
     * required value that is merely absent from an informational document is still called out.
     */
    const mark = markFor(f.state) ?? (f.required ? "NOT DETERMINED" : null);
    if (mark) markings.push({ key: f.key, label: f.label, mark });
  }

  const verdict: PrintVerdict = blockers.length > 0 ? "refused" : markings.length > 0 ? "printable_with_markings" : "printable";
  return { verdict, blockers, markings };
}

/** Only a print that produced paper counts. A failed or still-queued print made nothing. */
const PRODUCED_PAPER = ["sent", "delivered", "acknowledged"];
export function producedPaper(status: string): boolean {
  return PRODUCED_PAPER.indexOf(status) >= 0;
}

export type CopyKind = "original" | "reprint";

/**
 * The first paper of a version is the original; every later paper of that same version is a
 * reprint. A new version starts over, because it is a different document — and the old version's
 * paper is what `staleCopies` exists to find.
 */
export function copyKindFor(priorPrintsOfThisVersion: readonly { status: string }[]): CopyKind {
  return priorPrintsOfThisVersion.some(p => producedPaper(p.status)) ? "reprint" : "original";
}

export type ChainDocument = { id: number; documentRef: string; version: number; status: "current" | "superseded" | "withdrawn" };
export type PrintRecord = { deliveryRef: string; documentId: number; status: string; copyKind: CopyKind | null; sentAt: Date | null };
export type StaleCopy = PrintRecord & {
  printedDocumentRef: string;
  printedVersion: number;
  reason: "superseded" | "withdrawn";
  currentDocumentRef: string | null;
  currentVersion: number | null;
};

/**
 * Paper printed from a version that is no longer current. The record moved on after the printer
 * ran; the paper did not. Nothing here recalls it — the point is that whoever is holding a dispute
 * can be told which paper says something the record no longer says.
 */
export function staleCopies(chain: readonly ChainDocument[], prints: readonly PrintRecord[]): StaleCopy[] {
  const byId: Record<number, ChainDocument> = {};
  let current: ChainDocument | null = null;
  let currents = 0;
  for (const d of chain) {
    byId[d.id] = d;
    if (d.status === "current") { current = d; currents++; }
  }
  /*
   * Two current versions of one document is a data fault, and naming either as "the" current one
   * would pick a side. The stale list is still right — anything not current is stale — but the
   * pointer to a replacement is withheld rather than guessed.
   */
  if (currents > 1) current = null;

  const out: StaleCopy[] = [];
  for (const p of prints) {
    if (!producedPaper(p.status)) continue;
    const d = byId[p.documentId];
    if (!d || d.status === "current") continue;
    out.push({
      ...p,
      printedDocumentRef: d.documentRef,
      printedVersion: d.version,
      reason: d.status,
      currentDocumentRef: current ? current.documentRef : null,
      currentVersion: current ? current.version : null,
    });
  }
  return out;
}
