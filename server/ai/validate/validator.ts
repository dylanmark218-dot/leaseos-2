/**
 * The judge. No model runs here, and nothing it decides is negotiable.
 *
 * The plan's equation for whether a field may reach a record automatically:
 *
 *     autoEligible(field) =
 *         quoteIsInTranscript      // hallucination tripwire
 *       ∧ sttConfidence(quote) ≥ θ
 *       ∧ formatValid              // ticket prefix, time, units
 *       ∧ crossCheckAgrees         // GPS dwell, tank capacity
 *       ∧ policyAllows(AUTO)
 *
 * Two properties of that expression matter more than the terms in it.
 *
 * **A false term is REVIEW, not a failure.** The field is still proposed; a
 * person just has to look at it. Only a hard rule — more volume than the tank
 * holds — is BLOCKED.
 *
 * **A missing term is never true.** Absent STT confidence, an absent tank
 * capacity, an absent list of open tickets: each is NOT_EVALUATED, and
 * NOT_EVALUATED does not conjoin to PASS. This is the single most important
 * line in the file, because every plausible way to break it looks like
 * tidiness: defaulting a threshold, treating "no capacity configured" as "no
 * capacity exceeded", letting an empty check list mean all checks passed.
 *
 * The quote check is a substring test against the transcript, not a similarity
 * score. A model can produce a fluent, wrong value; it cannot produce words the
 * driver did not say. That asymmetry is the whole reason `evidenceQuote` is
 * required for `stated` — and why a `stated` field whose quote fails the test
 * is the metric the golden set pins at zero.
 */

import type { ExtractedField, ExtractionEnvelope } from "../extraction/contract";
import type { FormDefinition, FormFieldDef } from "../../_core/aiProposal";
import {
  geofenceArrival,
  openTicketNumbers,
  tankCapacityLitres,
  contextRefs,
  type ContextPack,
} from "../context/contextPack";
import {
  normalizeTicketNumber,
  normalizeTime,
  normalizeVolume,
  type Verdict,
} from "./normalizers";

export type { Verdict } from "./normalizers";

/**
 * Per-word confidence from speech-to-text, when there is a speech leg at all.
 *
 * Two absences, and they are not the same absence — the distinction
 * `server/_core/automationPolicy.ts` makes between a capability that is not
 * licensed and one that is unconfigured, at this layer:
 *
 *   **No `SttConfidence` at the call** — nothing was transcribed. Phase 1 is a
 *   typed transcript, and typed words have no transcription risk, so the term
 *   is *not applicable* and is left out of the conjunction entirely. It is not
 *   a check that failed to run; it is a check with no subject.
 *
 *   **`minForSpan` returns null** — there WAS audio, and the transcriber did
 *   not report a confidence for this span. That is a check that could not be
 *   established, so it contributes NOT_EVALUATED and the field never reaches
 *   PASS on it.
 *
 * Collapsing those would mean either a typed transcript can never pass
 * anything, or a transcriber that silently stops reporting probabilities looks
 * like a keyboard. whisper.cpp's mobile bindings expose token probabilities, so
 * the second case is a malfunction and has to look like one.
 */
export type SttConfidence = {
  /** Lowest per-word confidence across the span, 0..1. Null if unreported. */
  minForSpan(quote: string): number | null;
};

/** Below this, a digit is confirmed rather than believed. */
export const STT_CONFIDENCE_THRESHOLD = 0.6;

export type FieldVerdict = {
  key: string;
  label: string;
  verdict: Verdict;
  /** Stable codes for every term that was not true. */
  reasonCodes: string[];
  /** What to tell a person, in words. */
  details: string[];
  /** The value after normalization, which may differ in form from the model's. */
  normalizedValue: string | number | boolean | null;
  /** Set when a value came from somewhere other than the driver's mouth. */
  basis: "stated" | "inferred" | "gps_detected" | null;
};

export type ValidationResult = {
  fields: FieldVerdict[];
  /** True when any field is BLOCKED. Nothing advances while it is. */
  blocked: boolean;
  /** Fields that need a question, worst first. */
  needsClarification: FieldVerdict[];
  /**
   * `stated` fields whose quote is not in the transcript. The golden set pins
   * this at zero; it is the count that says whether the model is guessing.
   */
  silentGuessKeys: string[];
  outOfScope: boolean;
};

/**
 * Normalise whitespace before the substring test.
 *
 * A transcriber that writes "sixteen  cubic metres" and a model that quotes
 * "sixteen cubic metres" are agreeing, and a check that called that a
 * fabrication would train everybody to ignore the check. Nothing else is
 * relaxed: no case folding beyond this, no punctuation stripping, no fuzzy
 * match. Those would start letting a nearly-right quote through, and a
 * nearly-right quote is the thing being guarded against.
 */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The hallucination tripwire. */
export function quoteIsInTranscript(quote: string | null, transcript: string): boolean {
  if (!quote || quote.trim() === "") return false;
  return collapse(transcript).includes(collapse(quote));
}

/**
 * How stakes are ordered when only one question may be asked per turn.
 *
 * Volume and ticket number bill a customer. A delay reason is a note. Asking
 * about the note first is how a driver ends up answering three questions to
 * fix the one that mattered.
 */
const STAKES: Readonly<Record<string, number>> = {
  quantity: 100,
  ticketNumber: 95,
  facilityTicketNumber: 95,
  measurementMethod: 80,
  arrivedAt: 70,
  operationStartedAt: 65,
  operationCompletedAt: 65,
  departedAt: 60,
  waitMinutes: 50,
  delayReason: 20,
};

export const stakesOf = (key: string): number => STAKES[key] ?? 40;

/**
 * Field keys that hold a ticket number.
 *
 * Two, because the forms already disagree: `unload_stop` has none and
 * `disposal_ticket` calls it `facilityTicketNumber`. A set rather than a
 * hard-coded key so adding a form does not silently skip the check.
 */
const TICKET_KEYS = new Set(["ticketNumber", "facilityTicketNumber"]);

const RANK: Readonly<Record<Verdict, number>> = {
  BLOCKED: 0,
  UNKNOWN: 1,
  NOT_EVALUATED: 2,
  REVIEW: 3,
  PASS: 4,
};

/** The worst of several verdicts. PASS only survives when every term passed. */
export function worst(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return "NOT_EVALUATED";
  return verdicts.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

function validateField(args: {
  def: FormFieldDef;
  field: ExtractedField;
  transcript: string;
  pack: ContextPack;
  stt: SttConfidence | null;
  refs: Set<string>;
}): FieldVerdict {
  const { def, field, transcript, pack, stt, refs } = args;
  const reasonCodes: string[] = [];
  const details: string[] = [];
  const terms: Verdict[] = [];
  let basis: FieldVerdict["basis"] = null;
  let normalizedValue: string | number | boolean | null = field.value;

  /* --- status-specific evidence requirements --------------------------- */

  switch (field.status) {
    case "missing":
      return {
        key: def.key,
        label: def.label,
        verdict: def.required ? "UNKNOWN" : "NOT_EVALUATED",
        reasonCodes: [def.required ? "required_field_missing" : "optional_field_missing"],
        details: [def.required ? `${def.label} was not mentioned and the form requires it.` : ""],
        normalizedValue: null,
        basis: null,
      };

    case "ambiguous":
      return {
        key: def.key,
        label: def.label,
        verdict: "REVIEW",
        reasonCodes: ["ambiguous_reading"],
        details: [
          field.alternatives && field.alternatives.length > 0
            ? `${def.label} could be ${field.alternatives.join(" or ")}.`
            : `${def.label} had more than one reading.`,
        ],
        normalizedValue: field.value,
        basis: null,
      };

    case "inferred": {
      basis = "inferred";
      if (!field.evidenceRef || !refs.has(field.evidenceRef)) {
        // An id that is not in the pack is a citation of something that was
        // never shown. That is a fabrication with a reference attached, and it
        // fails harder than a missing reference would.
        return {
          key: def.key,
          label: def.label,
          verdict: "REVIEW",
          reasonCodes: ["evidence_ref_not_in_context"],
          details: [
            field.evidenceRef
              ? `${def.label} cites "${field.evidenceRef}", which is not in the context pack.`
              : `${def.label} was inferred with nothing cited.`,
          ],
          normalizedValue: field.value,
          basis,
        };
      }
      terms.push("PASS");
      break;
    }

    case "stated": {
      basis = "stated";
      if (!quoteIsInTranscript(field.evidenceQuote, transcript)) {
        // The silent guess. Never REVIEW: a value the driver did not say is not
        // something to confirm, it is something that did not happen.
        return {
          key: def.key,
          label: def.label,
          verdict: "BLOCKED",
          reasonCodes: ["quote_not_in_transcript"],
          details: [
            `${def.label} was reported as stated, quoting ${JSON.stringify(field.evidenceQuote ?? "")}, which is not in the transcript.`,
          ],
          normalizedValue: null,
          basis,
        };
      }
      terms.push("PASS");

      // No transcriber at all: typed words, no transcription risk, no term.
      const confidence = stt === null ? undefined : stt.minForSpan(field.evidenceQuote ?? "");
      if (confidence === undefined) {
        // Not applicable. Deliberately contributes nothing rather than a pass:
        // a term that is absent is absent, not satisfied.
      } else if (confidence === null) {
        // There was audio and the transcriber reported nothing for this span.
        // Asked, not established — so never PASS.
        terms.push("NOT_EVALUATED");
        reasonCodes.push("stt_confidence_unavailable");
      } else if (confidence < STT_CONFIDENCE_THRESHOLD) {
        terms.push("REVIEW");
        reasonCodes.push("stt_confidence_low");
        details.push(
          `The transcriber was ${Math.round(confidence * 100)}% sure of "${field.evidenceQuote}".`
        );
      } else {
        terms.push("PASS");
      }
      break;
    }
  }

  /* --- format and cross-checks ----------------------------------------- */

  const quote = field.evidenceQuote;

  if (def.type === "quantity") {
    const r = normalizeVolume({
      amount: typeof field.value === "number" ? field.value : null,
      quote,
      formUnit: def.unit ?? null,
      capacityLitres: tankCapacityLitres(pack),
    });
    terms.push(r.verdict);
    if (r.verdict !== "PASS") {
      reasonCodes.push(r.reasonCode);
      if (r.detail) details.push(r.detail);
    }
    if (r.value) normalizedValue = r.value.amount;
  } else if (def.type === "time") {
    const r = normalizeTime({
      raw: field.value === null ? null : String(field.value),
      quote,
      geofenceArrivalLocal: geofenceArrival(pack),
    });
    terms.push(r.verdict);
    if (r.verdict !== "PASS") {
      reasonCodes.push(r.reasonCode);
      if (r.detail) details.push(r.detail);
    }
    if (r.value) {
      normalizedValue = r.value.local;
      if (r.value.basis === "gps_detected") basis = "gps_detected";
    }
  } else if (TICKET_KEYS.has(def.key)) {
    const r = normalizeTicketNumber({
      raw: typeof field.value === "string" || typeof field.value === "number" ? field.value : null,
      openTickets: openTicketNumbers(pack),
    });
    terms.push(r.verdict);
    if (r.verdict !== "PASS") {
      reasonCodes.push(r.reasonCode);
      if (r.detail) details.push(r.detail);
    }
    if (r.value !== null) normalizedValue = r.value;
  } else if (def.type === "enum" && def.options && typeof field.value === "string") {
    if (!def.options.includes(field.value)) {
      terms.push("REVIEW");
      reasonCodes.push("enum_value_not_an_option");
      details.push(`"${field.value}" is not one of: ${def.options.join(", ")}.`);
    } else {
      terms.push("PASS");
    }
  }

  return {
    key: def.key,
    label: def.label,
    verdict: worst(terms),
    reasonCodes,
    details: details.filter(d => d.length > 0),
    normalizedValue,
    basis,
  };
}

/**
 * Validate a whole extraction.
 *
 * Every declared field gets a verdict, including ones the model omitted — a
 * form is not partly judged. `silentGuessKeys` is computed from the same pass
 * rather than recounted later, so the number the eval harness prints and the
 * verdicts a driver sees can never disagree.
 */
export function validateExtraction(args: {
  form: FormDefinition;
  envelope: ExtractionEnvelope;
  transcript: string;
  pack: ContextPack;
  stt?: SttConfidence | null;
}): ValidationResult {
  const { form, envelope, transcript, pack } = args;
  const stt = args.stt ?? null;
  const refs = contextRefs(pack);

  const fields = form.fields.map(def =>
    validateField({
      def,
      field:
        envelope.fields[def.key] ??
        { value: null, status: "missing", evidenceQuote: null, evidenceRef: null },
      transcript,
      pack,
      stt,
      refs,
    })
  );

  const silentGuessKeys = fields
    .filter(f => f.reasonCodes.includes("quote_not_in_transcript"))
    .map(f => f.key);

  // Only what a person can actually answer.
  //
  // NOT_EVALUATED is excluded on purpose, and it is the subtle one: a check
  // with no subject is not a question for the driver. "No tank capacity is on
  // file for this unit" and "you did not mention wait time on an optional
  // field" are both real, both keep the field off PASS, and neither is fixed by
  // asking the person in the cab — the first is a fleet record and the second
  // is nothing at all. Putting them in the queue is how a driver ends up
  // answering three questions to fix the one that mattered, which is exactly
  // what the one-question-per-turn rule exists to prevent.
  // Stakes first, severity second.
  //
  // Severity-first reads as the safer default and is the wrong order here: a
  // missing optional-looking field outranking the volume that bills a customer
  // is how a driver answers a question about a date before the one about the
  // number on the invoice. What a field costs if it is wrong is the thing worth
  // the driver's one answer; how badly it failed only breaks the tie.
  const needsClarification = fields
    .filter(f => f.verdict === "BLOCKED" || f.verdict === "UNKNOWN" || f.verdict === "REVIEW")
    .sort((a, b) => stakesOf(b.key) - stakesOf(a.key) || RANK[a.verdict] - RANK[b.verdict]);

  return {
    fields,
    blocked: fields.some(f => f.verdict === "BLOCKED"),
    needsClarification,
    silentGuessKeys,
    outOfScope: envelope.outOfScope,
  };
}
