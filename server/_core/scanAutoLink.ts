/**
 * Auto-linking a scan — proposing which record this document belongs to.
 *
 * A driver scans a disposal ticket. Somewhere on it is a tracking number that
 * LeaseOS itself minted, and the alternative to reading it is a person picking
 * the right load out of a list at the end of a fourteen-hour shift. So this
 * file finds the number and proposes the link.
 *
 * It proposes. It never links. A wrongly auto-linked disposal ticket attaches
 * one load's evidence to another load's invoice, and both are then wrong in a
 * way that reconciles perfectly and shows no mark. The verdict goes to a
 * person, and so does the reason.
 *
 * ## The pattern is derived from the configured format, never written out
 *
 * `trackingNumbers.ts` mints numbers from a stored `SequenceFormat` — prefix,
 * separator, year digits, month, sequence width — that an office can change.
 * A regex written here would be a second, silent copy of that configuration,
 * and it would be wrong the first afternoon somebody widened the sequence to
 * seven digits. The matcher is built FROM the format, so the office changing
 * the format changes the matcher.
 *
 * ## Barcodes and OCR are different evidence
 *
 * A Code-128 decode is the number. An OCR read of the same number is somebody's
 * best guess at eleven characters photographed in a cab, and `0`/`O`, `1`/`I`,
 * `5`/`S` and `8`/`B` are the four ways it goes wrong. OCR candidates are
 * matched with those substitutions allowed and carry a visibly lower
 * confidence when one was needed, because the whole point of separating them
 * is that a person reviewing sees which kind of evidence they are confirming.
 *
 * ## A QR code is a pointer
 *
 * LeaseOS QR codes carry a reference and no authority — the grant is resolved
 * server-side. Nothing here treats a QR payload as document content; it is
 * mined for a tracking number and otherwise ignored.
 */

import { formatTrackingNumber, type SequenceFormat } from "./trackingNumbers";

/* ------------------------------------------------------------------ */
/* What a scan can be linked to                                        */
/* ------------------------------------------------------------------ */

export type LinkTargetKind =
  | "job" | "trip" | "load" | "disposal" | "manifest" | "bol" | "field_ticket" | "invoice";

/** One sequence type the office has configured, and what it identifies. */
export type TrackingBinding = { target: LinkTargetKind; format: SequenceFormat };

export type AutoLinkSource = "barcode" | "ocr_text";

export type AutoLinkCandidate = {
  target: LinkTargetKind;
  /** The number as it will be looked up — canonical, with any OCR substitution applied. */
  trackingNumber: string;
  /** What was actually on the page, before substitution. Differs only for a corrected OCR read. */
  asRead: string;
  source: AutoLinkSource;
  /** The symbology, for a barcode. null for an OCR read. */
  barcodeFormat: string | null;
  /** 0–100. Evidence quality, not a probability that the link is right. */
  confidence: number;
  /** Which characters had to be corrected to make the read match the format. */
  substitutions: readonly { from: string; to: string; index: number }[];
  reason: string;
};

export type AutoLinkProposal = {
  candidates: AutoLinkCandidate[];
  /**
   * The one candidate worth putting in front of a person first, when there is
   * exactly one target. null when nothing matched or when the page names two
   * different records — which is the case a person must settle.
   */
  best: AutoLinkCandidate | null;
  /** The page names more than one record, or two reads of one number disagree. */
  ambiguous: boolean;
  reasons: string[];
};

/* ------------------------------------------------------------------ */
/* Building the matcher from the format                                */
/* ------------------------------------------------------------------ */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Characters OCR confuses, and the digit each is corrected TO.
 *
 * One-directional and applied ONLY inside the date and sequence runs. An
 * earlier version substituted across the whole string, which turned the prefix
 * "DISP" into "0150" and made every corrected read fail to match — the
 * correction table quietly destroying the thing it was meant to repair. The
 * prefix, the separator and the branch are matched literally, always.
 *
 * Keyed upper-case; lookups upper-case the character first, so lowercase `l`
 * and uppercase `I` are the same confusion they are on paper.
 */
const OCR_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ["O", "0"], ["Q", "0"], ["D", "0"],
  ["I", "1"], ["L", "1"], ["|", "1"],
  ["S", "5"],
  ["B", "8"],
  ["Z", "2"],
  ["G", "6"],
]);

/** The character class a digit position accepts when a read is allowed to be imperfect. */
const LOOSE_DIGIT = `[0-9${Array.from(OCR_SUBSTITUTIONS.keys()).join("").replace("|", "\\|")}]`;

type PatternShape = { regex: RegExp; dateLen: number; seqLen: number; sepLen: number };

function buildPattern(format: SequenceFormat, loose: boolean): PatternShape {
  const sep = escapeRe(format.separator);
  const prefix = escapeRe(format.prefix);
  const branch = `(?:[A-Z0-9]{1,8}${sep})?`;
  const yearLen = format.yearDigits === 4 ? 4 : format.yearDigits === 2 ? 2 : 0;
  const dateLen = yearLen + (format.includeMonth ? 2 : 0);
  const digit = loose ? LOOSE_DIGIT : "[0-9]";
  const datePart = dateLen > 0 ? `${digit}{${dateLen}}${sep}` : "";
  const seq = `${digit}{${format.sequenceDigits}}`;
  // Bounded by non-alphanumerics so a number embedded in a longer token is not
  // half-matched — a URL path segment is a legitimate place to find one, and
  // the middle of an account number is not.
  return {
    regex: new RegExp(`(?<![A-Z0-9])${prefix}${sep}${branch}${datePart}${seq}(?![A-Z0-9])`, "gi"),
    dateLen,
    seqLen: format.sequenceDigits,
    sepLen: format.separator.length,
  };
}

/**
 * The pattern one configured format produces.
 *
 * Mirrors `formatTrackingNumber` segment for segment: prefix, an optional
 * branch, a year/month part that is absent when the format asks for neither,
 * and a fixed-width sequence. The branch is optional because the same sequence
 * type mints both branch-scoped and unscoped numbers.
 */
export function trackingNumberPattern(format: SequenceFormat): RegExp {
  return buildPattern(format, false).regex;
}

/**
 * Which character ranges inside a match are digit positions.
 *
 * The sequence is always the final segment and the date, when the format has
 * one, always ends one separator before it — so both are located by counting
 * back from the end rather than by re-parsing. That keeps the prefix, the
 * separator and an optional branch out of reach of the correction table.
 */
function digitRanges(match: string, shape: PatternShape): [number, number][] {
  const ranges: [number, number][] = [];
  const seqStart = match.length - shape.seqLen;
  ranges.push([seqStart, match.length]);
  if (shape.dateLen > 0) {
    const dateEnd = seqStart - shape.sepLen;
    ranges.push([dateEnd - shape.dateLen, dateEnd]);
  }
  return ranges;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

const CONFIDENCE = {
  /** A machine decode of a symbology built with a checksum. */
  barcodeExact: 95,
  /** The characters were on the page and matched the format as written. */
  ocrExact: 72,
  /** Every substitution is a character somebody's eyes would also have to resolve. */
  ocrPerSubstitutionPenalty: 6,
  /**
   * Below this a corrected read is not offered at all. At six corrections the
   * candidate falls under the floor, which is the intended cliff: correcting
   * half the characters of a tracking number is not reading it, it is
   * proposing one and hoping. A person picking the record from a list is the
   * better outcome than a plausible number nobody can check against the page.
   */
  floor: 40,
} as const;

function matchesIn(text: string, binding: TrackingBinding, source: AutoLinkSource, barcodeFormat: string | null): AutoLinkCandidate[] {
  const out: AutoLinkCandidate[] = [];
  const strict = buildPattern(binding.format, false);

  // Pass 1: the characters as they stand.
  for (const m of Array.from(text.matchAll(strict.regex))) {
    out.push({
      target: binding.target,
      trackingNumber: m[0].toUpperCase(),
      asRead: m[0],
      source,
      barcodeFormat,
      confidence: source === "barcode" ? CONFIDENCE.barcodeExact : CONFIDENCE.ocrExact,
      substitutions: [],
      reason: source === "barcode"
        ? `Decoded from a ${barcodeFormat ?? "barcode"} and matches the ${binding.target} number format.`
        : `Read from the page text and matches the ${binding.target} number format exactly.`,
    });
  }

  // Pass 2, OCR only: allow the confusions inside the digit runs, and charge
  // for each one. A barcode decode is not given this latitude — a checksummed
  // symbology that decoded is the number, and "correcting" it would be
  // inventing a different one.
  if (source !== "ocr_text") return out;

  const loose = buildPattern(binding.format, true);
  for (const m of Array.from(text.matchAll(loose.regex))) {
    const raw = m[0];
    const start = m.index ?? 0;
    const chars = raw.split("");
    const substitutions: { from: string; to: string; index: number }[] = [];

    for (const [from, to] of digitRanges(raw, loose)) {
      for (let i = from; i < to; i++) {
        const ch = chars[i]!;
        if (ch >= "0" && ch <= "9") continue;
        const corrected = OCR_SUBSTITUTIONS.get(ch.toUpperCase());
        if (!corrected) continue;
        substitutions.push({ from: ch, to: corrected, index: start + i });
        chars[i] = corrected;
      }
    }

    // No correction needed means pass 1 already has this one.
    if (substitutions.length === 0) continue;

    const confidence = CONFIDENCE.ocrExact - substitutions.length * CONFIDENCE.ocrPerSubstitutionPenalty;
    if (confidence < CONFIDENCE.floor) continue;

    out.push({
      target: binding.target,
      trackingNumber: chars.join("").toUpperCase(),
      asRead: raw,
      source,
      barcodeFormat: null,
      confidence,
      substitutions,
      reason:
        `Read from the page text as "${raw}" and matches the ${binding.target} number format ` +
        `after correcting ${substitutions.map(c => `"${c.from}"\u2192"${c.to}"`).join(", ")}. Check these characters against the page.`,
    });
  }

  return out;
}

/**
 * Propose which records this scan belongs to.
 *
 * Both sources are searched against every configured sequence, because a
 * disposal ticket routinely carries the load number in a barcode and the job
 * number in print, and proposing both is more useful than picking one.
 */
export function proposeLinks(args: {
  bindings: readonly TrackingBinding[];
  barcodes?: readonly { format: string; value: string }[];
  ocrText?: string | null;
}): AutoLinkProposal {
  const candidates: AutoLinkCandidate[] = [];
  const reasons: string[] = [];

  for (const binding of args.bindings) {
    for (const b of args.barcodes ?? []) {
      candidates.push(...matchesIn(b.value, binding, "barcode", b.format));
    }
    if (args.ocrText) {
      candidates.push(...matchesIn(args.ocrText, binding, "ocr_text", null));
    }
  }

  // One number read twice — once off a barcode, once off the print — is one
  // candidate carrying the better evidence, not two competing ones.
  const byNumber = new Map<string, AutoLinkCandidate>();
  for (const c of candidates) {
    const key = `${c.target}:${c.trackingNumber}`;
    const existing = byNumber.get(key);
    if (!existing || c.confidence > existing.confidence) byNumber.set(key, c);
  }

  const deduped = Array.from(byNumber.values()).sort((a, b) =>
    b.confidence - a.confidence || a.trackingNumber.localeCompare(b.trackingNumber),
  );

  if (deduped.length === 0) {
    return { candidates: [], best: null, ambiguous: false, reasons: ["No tracking number matching any configured sequence was found on this scan."] };
  }

  const distinct = new Set(deduped.map(c => `${c.target}:${c.trackingNumber}`));
  const ambiguous = distinct.size > 1;

  if (ambiguous) {
    reasons.push(
      `This scan names ${distinct.size} different records: ` +
      `${deduped.map(c => `${c.trackingNumber} (${c.target})`).join(", ")}. ` +
      `Which one the document belongs to is not something the scan can settle.`,
    );
  } else {
    reasons.push(`${deduped[0]!.trackingNumber} proposed as the ${deduped[0]!.target} — confirm it before anything is attached.`);
  }

  return { candidates: deduped, best: ambiguous ? null : deduped[0]!, ambiguous, reasons };
}

/**
 * A sanity check the office can run on a format before it is saved: the
 * pattern this module derives must match a number that format actually mints.
 *
 * Cheap, and it fails loudly at configuration time rather than silently at the
 * gate six weeks later when no ticket ever auto-links again.
 */
export function patternMatchesOwnOutput(format: SequenceFormat, at: Date, sequence: number, branch?: string | null): boolean {
  const minted = formatTrackingNumber(format, at, sequence, branch);
  const m = minted.match(trackingNumberPattern(format));
  return m != null && m.length === 1 && m[0] === minted;
}
