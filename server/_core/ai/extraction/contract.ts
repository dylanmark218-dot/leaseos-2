/**
 * What the model is allowed to say about a field, and how it must back it up.
 *
 * The existing extraction bridge (`server/_core/assistantExtraction.ts`) asks
 * the model for `{ value, sourceUtterance, speakerHedged, confidence }`. That
 * shape solved the precision problem — "about 8,000 litres" must not become a
 * measurement — and it leaves two gaps this contract closes.
 *
 * **"Not stated" and "stated ambiguously" were the same answer.** A null value
 * meant both "the driver never mentioned it" and "the driver said something I
 * could not resolve", and those need different questions. Four statuses
 * separate them, which also removes the pressure to guess: a model with four
 * structured ways to say "I don't know" reaches for one instead of inventing a
 * value.
 *
 * **`sourceUtterance` was advisory.** Nothing checked it against the
 * transcript. `evidenceQuote` is the same field promoted to a hard rule: the
 * validator rejects any field whose quote is not a verbatim substring of what
 * was actually said, which is the hallucination tripwire. A model cannot
 * fabricate a value and a quote that survives that check, because the quote
 * has to exist in words somebody spoke.
 *
 * This is a wire contract, not a second storage shape. `server/ai/proposal`
 * maps every field of it onto the `ProposedField` the database already holds,
 * so a proposal still has exactly one persisted form and one provenance chain.
 */

/**
 * Where a value came from, in the model's own account of it.
 *
 *   `stated`    — the driver said it. `evidenceQuote` is required and checked.
 *   `inferred`  — it came from the context pack. `evidenceRef` names the item.
 *   `ambiguous` — more than one reading. Every reading goes in `alternatives`.
 *   `missing`   — not mentioned. `value` is null.
 *
 * There is no fifth status meaning "probably". A model that wants to say
 * "probably 16" is saying `ambiguous`, and the driver gets asked.
 */
export type ExtractedFieldStatus = "stated" | "inferred" | "missing" | "ambiguous";

export const EXTRACTED_FIELD_STATUSES: readonly ExtractedFieldStatus[] = [
  "stated",
  "inferred",
  "missing",
  "ambiguous",
] as const;

export type ExtractedValue = string | number | boolean;

export type ExtractedField<T extends ExtractedValue = ExtractedValue> = {
  value: T | null;
  status: ExtractedFieldStatus;
  /**
   * The driver's exact words. Required for `stated`, and verbatim: the
   * validator does a substring check, not a similarity score.
   */
  evidenceQuote: string | null;
  /**
   * The context-pack item this was inferred from, by id. Required for
   * `inferred`, and checked against the pack the model was actually handed —
   * an id that is not in the pack is a fabrication with extra steps.
   */
  evidenceRef: string | null;
  /** Every reading, when the status is `ambiguous`. */
  alternatives?: T[];
};

/**
 * The whole model response for one form.
 *
 * The two top-level booleans are answers to questions that are not about any
 * single field, which is why they are not fields:
 *
 *   `outOfScope` — the request was not about trucking operations. A driver who
 *     asks the Secretary to write Python gets a refusal, and no proposal is
 *     created at all. `server/_core/knowledge/perimeter.ts` holds the same rule
 *     for the assistant's ask path; this is it at the extraction door.
 *
 *   `injectionSuspected` — something in the data asked to be obeyed. The model
 *     reporting it is one witness; `server/ai/injection/guard.ts` is the other,
 *     and they are combined pessimistically.
 */
export type ExtractionEnvelope = {
  fields: Record<string, ExtractedField>;
  notes: string | null;
  outOfScope: boolean;
  injectionSuspected: boolean;
};

/** Thrown when a model response cannot be read as an envelope at all. */
export class ExtractionUnparseable extends Error {}

const isStatus = (v: unknown): v is ExtractedFieldStatus =>
  typeof v === "string" &&
  (EXTRACTED_FIELD_STATUSES as readonly string[]).includes(v);

const asValue = (v: unknown): ExtractedValue | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  return null;
};

/**
 * Read a model response into an envelope, dropping anything outside the form.
 *
 * Keys the form did not declare are discarded rather than stored, exactly as
 * `parseExtraction` already does: a model that invents a field is a model whose
 * invention must not reach a table. A field the form declared but the model
 * omitted comes back as `missing`, because a silently absent field and a field
 * reported absent must not be distinguishable downstream — that difference is
 * where a `PASS` on an unasked question would come from.
 */
export function parseExtractionEnvelope(
  raw: unknown,
  declaredKeys: readonly string[]
): ExtractionEnvelope {
  if (raw === null || typeof raw !== "object") {
    throw new ExtractionUnparseable("model response was not an object");
  }

  const root = raw as Record<string, unknown>;
  const rawFields =
    root.fields && typeof root.fields === "object"
      ? (root.fields as Record<string, unknown>)
      : {};

  const fields: Record<string, ExtractedField> = {};
  for (const key of declaredKeys) {
    const slot = rawFields[key];
    if (slot === null || slot === undefined || typeof slot !== "object") {
      fields[key] = { value: null, status: "missing", evidenceQuote: null, evidenceRef: null };
      continue;
    }

    const s = slot as Record<string, unknown>;
    const status = isStatus(s.status) ? s.status : "missing";
    const alternatives = Array.isArray(s.alternatives)
      ? s.alternatives.map(asValue).filter((v): v is ExtractedValue => v !== null)
      : undefined;

    fields[key] = {
      value: asValue(s.value),
      status,
      evidenceQuote: typeof s.evidenceQuote === "string" ? s.evidenceQuote : null,
      evidenceRef: typeof s.evidenceRef === "string" ? s.evidenceRef : null,
      ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
    };
  }

  return {
    fields,
    notes: typeof root.notes === "string" ? root.notes : null,
    // Absent is false for scope and false for injection, but neither default
    // is load-bearing: scope is re-checked deterministically and injection is
    // scanned independently. A model that omits them changes nothing.
    outOfScope: root.outOfScope === true,
    injectionSuspected: root.injectionSuspected === true,
  };
}
