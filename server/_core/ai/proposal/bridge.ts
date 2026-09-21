/**
 * Where the new contract meets the proposal the database already holds.
 *
 * `ExtractedField` is a wire shape: what the model said and how it backed it
 * up. `ProposedField` in `server/_core/aiProposal.ts` is the stored shape, and
 * the `proposalFields` table's enums are what a person, an auditor and the
 * commit adapters all read. Adding a second stored shape would mean two
 * answers to "where did this value come from", so there is one mapping, here,
 * and it is total.
 *
 * ## The mapping, and why each line is what it is
 *
 * `status` → `source` (how it got here) and `status` (where it is in its life):
 *
 *   stated    → source `driver_voice`,     status `proposed`
 *   inferred  → source `system_inferred`,  status `proposed`
 *   ambiguous → source `driver_voice`,     status `proposed`  (a heard value,
 *               unresolved; the reading is the driver's, the doubt is ours)
 *   missing   → no field is stored at all
 *
 * A GPS-detected time overrides the source to `gps`, because a value the truck
 * reported is not a value the driver said even when it answers a question the
 * driver was asked.
 *
 * A corrected field takes `human_corrected` and status `corrected`, and keeps
 * the superseded value in `correctedFrom`. That pair is what makes every driver
 * fix a labelled example later, and it is why nothing overwrites in place.
 *
 * `precision` is not the model's to decide and is not mapped from status.
 * `looksHedged` in `server/_core/assistantExtraction.ts` already reads hedges
 * out of the driver's own words, and it is reused rather than reimplemented —
 * one answer to "was this approximate", derived from the transcript, not from
 * a confidence the model reported about itself.
 *
 * `confidence` is `low` for anything the validator did not pass. Not the
 * model's number: the model's number is the thing this whole layer declines to
 * trust, and storing it in a column called confidence would put it back in
 * front of a person as though it had been checked.
 */

import {
  buildProposal,
  type FieldSource,
  type FormDefinition,
  type Precision,
  type Proposal,
  type ProposedField,
} from "../../aiProposal";
import { looksHedged } from "../../assistantExtraction";
import type { ExtractionEnvelope, ExtractedField } from "../extraction/contract";
import type { FieldVerdict, ValidationResult } from "../validate/validator";
import type { RunProvenance } from "../prompts";
import type { InjectionScan } from "../injection/guard";

export type SecretaryProposal = {
  proposal: Proposal;
  /** Recorded on every proposal: what answered, under which prompt, on what input. */
  run: RunProvenance;
  /** Per-field verdicts, kept beside the proposal so a person sees both. */
  verdicts: FieldVerdict[];
  /** Set when the transcript or a document asked to be obeyed. */
  injection: InjectionScan;
  /**
   * The automation mode this proposal may reach at most.
   *
   * HYBRID: it lands pending and a person confirms. `server/_core/automationPolicy.ts`
   * already resolves a tenant's mode, and that resolver may narrow this to
   * MANUAL — it may never widen it, which is the dominance rule that file
   * enforces, applied here at the source.
   */
  ceiling: "HYBRID";
  /** Fields still open when the conversation ran out of rounds. */
  unresolvedKeys: string[];
};

const sourceFor = (field: ExtractedField, verdict: FieldVerdict): FieldSource => {
  if (verdict.basis === "gps_detected") return "gps";
  if (field.status === "inferred") return "system_inferred";
  return "driver_voice";
};

/**
 * Build the stored proposal.
 *
 * `missing` fields are dropped rather than stored as nulls: `buildProposal`
 * already computes gaps from the form definition, so a stored null would be a
 * second, weaker statement of the same absence — and the two could disagree.
 */
export function toProposal(args: {
  form: FormDefinition;
  targetRef: string;
  transcript: string;
  envelope: ExtractionEnvelope;
  validation: ValidationResult;
  run: RunProvenance;
  injection: InjectionScan;
  correctedKeys?: readonly string[];
  unresolvedKeys?: readonly string[];
  /** Values the driver superseded, by key, for `correctedFrom`. */
  supersededValues?: Readonly<Record<string, string | number | boolean | null>>;
  proposalId?: string;
}): SecretaryProposal {
  const {
    form,
    targetRef,
    transcript,
    envelope,
    validation,
    run,
    injection,
    proposalId,
  } = args;
  const correctedKeys = new Set(args.correctedKeys ?? []);
  const superseded = args.supersededValues ?? {};

  const verdictByKey = new Map(validation.fields.map(v => [v.key, v]));

  const extracted = form.fields.flatMap(def => {
    const field = envelope.fields[def.key];
    const verdict = verdictByKey.get(def.key);
    if (!field || !verdict) return [];
    if (field.status === "missing") return [];
    // A fabricated quote is not a value. It is dropped from the proposal and
    // survives only in the verdicts, where a person can see what happened.
    if (verdict.reasonCodes.includes("quote_not_in_transcript")) return [];

    const hedged = looksHedged(field.evidenceQuote, false);
    const precision: Precision = hedged ? "approximate" : "exact";

    return [
      {
        key: def.key,
        value: verdict.normalizedValue,
        precision,
        source: sourceFor(field, verdict),
        confidence: (verdict.verdict === "PASS" ? "high" : "low") as "high" | "low",
        sourceUtterance: field.evidenceQuote,
      },
    ];
  });

  const proposal = buildProposal(form, targetRef, extracted, proposalId);

  // Corrections are applied after the build so the superseded value is kept
  // rather than replaced. An overwritten value is a lost training example and
  // an unanswerable audit question.
  const fields: ProposedField[] = proposal.fields.map(f =>
    correctedKeys.has(f.key)
      ? {
          ...f,
          source: "human_corrected" as FieldSource,
          status: "corrected" as const,
          correctedFrom: superseded[f.key] ?? null,
        }
      : f
  );

  return {
    proposal: { ...proposal, fields, commitState: "drafting" },
    run,
    verdicts: validation.fields,
    injection,
    ceiling: "HYBRID",
    unresolvedKeys: [...(args.unresolvedKeys ?? [])],
  };
}

/**
 * Whether anything may advance.
 *
 * Three independent stops, and each one alone is enough:
 *
 *   a BLOCKED field — a hard rule was broken;
 *   a suspected injection — something in the data asked to be obeyed, and
 *     nothing auto-advances while that is unresolved, per the checkpoint;
 *   out of scope — there is nothing here to propose.
 *
 * This returns a reason rather than a boolean because "it did not advance" is
 * not a thing anybody can act on.
 */
export function advanceBlockedBecause(p: SecretaryProposal): string | null {
  if (p.injection.suspected) {
    return `injection suspected (${p.injection.findings.map(f => f.code).join(", ")})`;
  }
  if (p.verdicts.some(v => v.verdict === "BLOCKED")) {
    const blocked = p.verdicts.filter(v => v.verdict === "BLOCKED").map(v => v.key);
    return `blocked fields: ${blocked.join(", ")}`;
  }
  return null;
}
