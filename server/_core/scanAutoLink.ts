/**
 * v23.28 — proposing which record a scanned document belongs to.
 *
 * A driver scans a disposal ticket. Somewhere on it is a tracking number LeaseOS itself minted,
 * and the alternative to reading it is a person picking the right load out of a list at the end of
 * a fourteen-hour shift. So this file finds the number and proposes the link.
 *
 * It proposes. It never links. A wrongly auto-linked disposal ticket attaches one load's evidence
 * to another load's invoice, and both are then wrong in a way that reconciles perfectly and shows
 * no mark. Every path out of this file is a `disposition` a person acts on, and `linked` is
 * deliberately not one of the values — this module has no vocabulary for having done it, so no
 * caller can mistake its output for the act.
 *
 * ## The pattern is derived from the configured format, never written out
 *
 * `trackingNumbers.ts` mints numbers from a stored `SequenceFormat` — prefix, separator, year
 * digits, month, sequence width — that an office can change. A regex written here would be a
 * second, silent copy of that configuration, and it would be wrong the first afternoon somebody
 * widened the sequence to seven digits. The matcher is built FROM the format, so the office
 * changing the format changes the matcher.
 *
 * ## A malformed format matches nothing, loudly
 *
 * The dangerous failure is not a format that fails to match. It is a format that matches
 * everything: `sequenceDigits: 0` compiles to a pattern with an empty numeric run, which will
 * happily "find" a tracking number in any line containing the prefix. So every binding is
 * validated before it is used, an invalid one is refused with its reason, and it proposes nothing
 * rather than proposing rubbish. Unknown counts against you.
 *
 * ## Barcodes and OCR are different evidence
 *
 * A Code-128 decode is the number. An OCR read of the same number is somebody's best guess at
 * eleven characters photographed in a cab, and 0/O, 1/I, 5/S and 8/B are the four ways it goes
 * wrong. OCR candidates are matched with those substitutions allowed inside the DIGIT RUNS ONLY,
 * carry a visibly lower confidence for each one, and stop being offered once the correction count
 * says we are inventing rather than reading.
 *
 * ## A QR code is a pointer
 *
 * LeaseOS QR codes carry a reference and no authority — the grant is resolved server-side. Nothing
 * here treats a QR payload as document content; it is mined for a tracking number and otherwise
 * ignored.
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

export type Substitution = { from: string; to: string; index: number };

export type AutoLinkCandidate = {
  target: LinkTargetKind;
  /** The number as it will be looked up — canonical, with any OCR substitution applied. */
  trackingNumber: string;
  /** What was actually on the page, before substitution. Differs only for a corrected OCR read. */
  asRead: string;
  source: AutoLinkSource;
  /** The symbology, for a barcode. null for an OCR read. */
  barcodeFormat: string | null;
  /** 0-100. Evidence quality, not a probability that the link is right. */
  confidence: number;
  substitutions: readonly Substitution[];
  reason: string;
};

/** A configured binding that cannot be used, and why. */
export type UnusableBinding = { target: LinkTargetKind; prefix: string; problem: string };

/** A link this document already carries. */
export type ExistingLink = { target: LinkTargetKind; trackingNumber: string };

/**
 * What a person must do about this scan.
 *
 * There is deliberately no `linked` value. This module cannot link and has no word for having
 * done so, which is the difference between a proposal and an act.
 */
export type AutoLinkDisposition =
  /** Exactly one record named, nothing already attached: show it for confirmation. */
  | "propose_single"
  /** More than one record named, or a link already exists. A person decides. */
  | "requires_review"
  /** The page named no record. */
  | "no_candidates"
  /** No usable sequence is configured, so nothing could have been found. */
  | "not_configured";

export type AutoLinkProposal = {
  candidates: AutoLinkCandidate[];
  /**
   * The one candidate worth putting in front of a person first. Non-null ONLY for
   * `propose_single`: an ambiguous page, or one that is already linked, must not hand a caller a
   * convenient single answer to act on.
   */
  best: AutoLinkCandidate | null;
  disposition: AutoLinkDisposition;
  /** The page names more than one record, or two reads disagree. */
  ambiguous: boolean;
  /** Present when the document already carries a link; re-linking is a person's decision. */
  alreadyLinked: ExistingLink | null;
  /** Configured bindings that were refused, each with its reason. Never silently dropped. */
  unusableBindings: UnusableBinding[];
  reasons: string[];
};

/* ------------------------------------------------------------------ */
/* Validating a configured format                                      */
/* ------------------------------------------------------------------ */

/**
 * Why this format cannot be turned into a matcher, or null if it can.
 *
 * Every rule here exists because breaking it produces a pattern that matches MORE than it should.
 * A format that matches too little is a nuisance; one that matches too much attaches evidence to
 * the wrong load.
 */
export function formatProblem(format: SequenceFormat | null | undefined): string | null {
  if (!format) return "no format is configured for this sequence";
  if (typeof format.prefix !== "string" || format.prefix.length === 0) {
    return "the prefix is empty, so the pattern would match a bare number anywhere on the page";
  }
  if (!/^[A-Za-z0-9]+$/.test(format.prefix)) {
    return `the prefix ${JSON.stringify(format.prefix)} contains characters that are not letters or digits`;
  }
  if (typeof format.separator !== "string" || format.separator.length === 0) {
    return "the separator is empty, so the prefix and the number would run together and the boundary checks could not hold";
  }
  if (/[A-Za-z0-9]/.test(format.separator)) {
    return `the separator ${JSON.stringify(format.separator)} contains a letter or digit, which would make the word-boundary checks meaningless`;
  }
  if (!Number.isInteger(format.sequenceDigits) || format.sequenceDigits < 1 || format.sequenceDigits > 12) {
    return `sequenceDigits is ${String(format.sequenceDigits)}; it must be a whole number between 1 and 12, and a width of 0 would match an empty run`;
  }
  if (format.yearDigits !== 0 && format.yearDigits !== 2 && format.yearDigits !== 4) {
    return `yearDigits is ${String(format.yearDigits)}; it must be 0, 2 or 4`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Building the matcher from the format                                */
/* ------------------------------------------------------------------ */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Characters OCR confuses, and the digit each is corrected TO.
 *
 * One-directional, and applied ONLY inside the date and sequence runs. Substituting across the
 * whole string turns the prefix "DISP" into "0150" and makes every corrected read fail to match —
 * the correction table quietly destroying the thing it was meant to repair. The prefix, the
 * separator and the branch are matched literally, always.
 *
 * Keyed upper-case; lookups upper-case first, so lowercase l and uppercase I are the same
 * confusion they are on paper.
 */
const OCR_SUBSTITUTIONS: Record<string, string> = {
  O: "0", Q: "0", D: "0",
  I: "1", L: "1", "|": "1",
  S: "5",
  B: "8",
  Z: "2",
  G: "6",
};

const LOOSE_DIGIT = "[0-9" + Object.keys(OCR_SUBSTITUTIONS).join("").replace("|", "\\|") + "]";

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
  // Bounded by non-alphanumerics so a number embedded in a longer token is not half-matched — a
  // URL path segment is a legitimate place to find one, the middle of an account number is not.
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
 * Mirrors `formatTrackingNumber` segment for segment: prefix, an optional branch, a year/month
 * part that is absent when the format asks for neither, and a fixed-width sequence. Throws on a
 * format `formatProblem` rejects, so a caller cannot get a matcher for a configuration that was
 * already known to be unusable.
 */
export function trackingNumberPattern(format: SequenceFormat): RegExp {
  const problem = formatProblem(format);
  if (problem) throw new Error(`Tracking format is unusable: ${problem}`);
  return buildPattern(format, false).regex;
}

/**
 * Which character ranges inside a match are digit positions.
 *
 * The sequence is always the final segment and the date, when the format has one, always ends one
 * separator before it — so both are located by counting back from the end rather than by
 * re-parsing. That keeps the prefix, the separator and an optional branch out of reach of the
 * correction table.
 */
function digitRanges(match: string, shape: PatternShape): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const seqStart = match.length - shape.seqLen;
  ranges.push([seqStart, match.length]);
  if (shape.dateLen > 0) {
    const dateEnd = seqStart - shape.sepLen;
    ranges.push([dateEnd - shape.dateLen, dateEnd]);
  }
  return ranges;
}

const CONFIDENCE = {
  /** A machine decode of a symbology built with a checksum. */
  barcodeExact: 95,
  /** The characters were on the page and matched the format as written. */
  ocrExact: 72,
  /** Every substitution is a character somebody's eyes would also have to resolve. */
  ocrPerSubstitutionPenalty: 6,
  /**
   * Below this a corrected read is not offered at all. At six corrections the candidate falls
   * under the floor, which is the intended cliff: correcting half the characters of a tracking
   * number is not reading it, it is proposing one and hoping. A person picking the record from a
   * list is the better outcome than a plausible number nobody can check against the page.
   */
  floor: 40,
} as const;

export const MAX_OCR_SUBSTITUTIONS =
  Math.ceil((CONFIDENCE.ocrExact - CONFIDENCE.floor) / CONFIDENCE.ocrPerSubstitutionPenalty);

function matchesIn(text: string, binding: TrackingBinding, source: AutoLinkSource, barcodeFormat: string | null): AutoLinkCandidate[] {
  const out: AutoLinkCandidate[] = [];
  const strict = buildPattern(binding.format, false);

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

  // A barcode decode is not given the correction latitude: a checksummed symbology that decoded IS
  // the number, and "correcting" it would be inventing a different one.
  if (source !== "ocr_text") return out;

  const loose = buildPattern(binding.format, true);
  for (const m of Array.from(text.matchAll(loose.regex))) {
    const raw = m[0];
    const start = m.index ?? 0;
    const chars = raw.split("");
    const substitutions: Substitution[] = [];

    for (const [from, to] of digitRanges(raw, loose)) {
      for (let i = from; i < to; i++) {
        const ch = chars[i]!;
        if (ch >= "0" && ch <= "9") continue;
        const corrected = OCR_SUBSTITUTIONS[ch.toUpperCase()];
        if (!corrected) continue;
        substitutions.push({ from: ch, to: corrected, index: start + i });
        chars[i] = corrected;
      }
    }

    // No correction needed means the strict pass already has this one.
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
        `Read from the page text as "${raw}" and matches the ${binding.target} number format after correcting ` +
        substitutions.map(c => `"${c.from}"->"${c.to}"`).join(", ") +
        ". Check these characters against the page.",
    });
  }

  return out;
}

/**
 * Propose which record this scan belongs to.
 *
 * Both sources are searched against every usable binding, because a disposal ticket routinely
 * carries the load number in a barcode and the job number in print, and proposing both is more
 * useful than picking one.
 *
 * `existingLink` is the caller's statement that this document is already attached to something.
 * When it is set, the disposition is `requires_review` whatever was found: re-attaching evidence
 * that is already attached somewhere else is precisely the act that must not happen quietly.
 */
export function proposeLinks(args: {
  bindings: readonly TrackingBinding[];
  barcodes?: readonly { format: string; value: string }[];
  ocrText?: string | null;
  existingLink?: ExistingLink | null;
}): AutoLinkProposal {
  const unusableBindings: UnusableBinding[] = [];
  const usable: TrackingBinding[] = [];

  for (const b of args.bindings) {
    const problem = formatProblem(b.format);
    if (problem) unusableBindings.push({ target: b.target, prefix: b.format?.prefix ?? "", problem });
    else usable.push(b);
  }

  const candidates: AutoLinkCandidate[] = [];
  for (const binding of usable) {
    for (const b of args.barcodes ?? []) {
      if (typeof b?.value !== "string" || b.value.length === 0) continue;
      candidates.push(...matchesIn(b.value, binding, "barcode", b.format));
    }
    if (typeof args.ocrText === "string" && args.ocrText.length > 0) {
      candidates.push(...matchesIn(args.ocrText, binding, "ocr_text", null));
    }
  }

  // One number read twice — once off a barcode, once off the print — is one candidate carrying the
  // better evidence, not two competing ones.
  const byKey: Record<string, AutoLinkCandidate> = {};
  for (const c of candidates) {
    const key = `${c.target}:${c.trackingNumber}`;
    const existing = byKey[key];
    if (!existing || c.confidence > existing.confidence) byKey[key] = c;
  }

  const deduped = Object.keys(byKey).map(k => byKey[k]!).sort((a, b) =>
    b.confidence - a.confidence || a.trackingNumber.localeCompare(b.trackingNumber),
  );

  const distinct = Object.keys(byKey).length;
  const ambiguous = distinct > 1;
  const alreadyLinked = args.existingLink ?? null;
  const reasons: string[] = [];

  for (const u of unusableBindings) {
    reasons.push(`The ${u.target} sequence was not searched: ${u.problem}.`);
  }

  let disposition: AutoLinkDisposition;
  if (alreadyLinked) {
    disposition = "requires_review";
    reasons.push(
      `This document is already linked to ${alreadyLinked.trackingNumber} (${alreadyLinked.target}). ` +
      `Re-linking is a person's decision, not a re-scan's.`,
    );
  } else if (usable.length === 0) {
    disposition = "not_configured";
    reasons.push("No usable tracking sequence is configured, so no link could be proposed for this scan.");
  } else if (deduped.length === 0) {
    disposition = "no_candidates";
    reasons.push("No tracking number matching any configured sequence was found on this scan.");
  } else if (ambiguous) {
    disposition = "requires_review";
    reasons.push(
      `This scan names ${distinct} different records: ` +
      deduped.map(c => `${c.trackingNumber} (${c.target})`).join(", ") +
      ". Which one the document belongs to is not something the scan can settle.",
    );
  } else {
    disposition = "propose_single";
    reasons.push(`${deduped[0]!.trackingNumber} proposed as the ${deduped[0]!.target} — confirm it before anything is attached.`);
  }

  return {
    candidates: deduped,
    best: disposition === "propose_single" ? deduped[0]! : null,
    disposition,
    ambiguous,
    alreadyLinked,
    unusableBindings,
    reasons,
  };
}

/**
 * A sanity check the office can run on a format before it is saved: the pattern this module
 * derives must match a number that format actually mints.
 *
 * Cheap, and it fails loudly at configuration time rather than silently at the gate six weeks
 * later when no ticket ever auto-links again.
 */
export function patternMatchesOwnOutput(format: SequenceFormat, at: Date, sequence: number, branch?: string | null): boolean {
  if (formatProblem(format)) return false;
  const minted = formatTrackingNumber(format, at, sequence, branch);
  const m = minted.match(trackingNumberPattern(format));
  return m != null && m.length === 1 && m[0] === minted;
}
