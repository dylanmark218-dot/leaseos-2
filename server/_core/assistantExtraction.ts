/**
 * Extraction bridge — form definition → JSON Schema → typed proposal.
 *
 * The model is never asked "what did they say?" and trusted with the answer.
 * It is handed the exact slot list for one form and constrained by
 * `outputSchema` to fill only those. Anything outside the schema cannot come
 * back, which is what makes `buildProposal` safe to feed.
 *
 * Two things this file will not do:
 *
 *   It does not decide precision. Hedges are detected from the driver's own
 *   words, not from the model's opinion about them — a model that decides
 *   "around ten" was probably exact is precisely the failure mode the whole
 *   provenance chain exists to prevent.
 *
 *   It does not let the model conclude anything. The system prompt forbids it
 *   and `detectOverreach` checks the prose it returns.
 */

import type { OutputSchema } from "./llm";
import {
  detectOverreach,
  type ExtractedValue,
  type FieldSource,
  type FormDefinition,
  type FormFieldDef,
} from "./aiProposal";

/* ===================== form → JSON Schema ===================== */

function jsonTypeFor(def: FormFieldDef): Record<string, unknown> {
  switch (def.type) {
    case "quantity":
    case "duration":
      return { type: ["number", "null"] };
    case "boolean":
      return { type: ["boolean", "null"] };
    case "enum":
      return { type: ["string", "null"], enum: [...(def.options ?? []), null] };
    case "time":
      return { type: ["string", "null"], description: "24-hour HH:MM" };
    default:
      return { type: ["string", "null"] };
  }
}

/**
 * Every slot carries its value alongside the words it came from and whether
 * the speaker hedged. Asking for `sourceUtterance` per field is what lets a
 * person check the interpretation rather than trusting it.
 */
export function buildOutputSchema(form: FormDefinition): OutputSchema {
  const properties: Record<string, unknown> = {};

  for (const def of form.fields) {
    properties[def.key] = {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        value: jsonTypeFor(def),
        sourceUtterance: {
          type: ["string", "null"],
          description:
            "The speaker's exact words this came from. Null if not stated.",
        },
        speakerHedged: {
          type: "boolean",
          description:
            "True if the speaker qualified this — about, around, roughly, maybe, or similar. " +
            "Report what they said; do not judge whether they meant it.",
        },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["value", "sourceUtterance", "speakerHedged", "confidence"],
    };
  }

  return {
    name: `leaseos_${form.key}_v${form.version}`,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fields: {
          type: "object",
          additionalProperties: false,
          properties,
          required: form.fields.map(f => f.key),
        },
        notes: {
          type: ["string", "null"],
          description:
            "Anything relevant that does not fit a field. Observations only — never a conclusion.",
        },
      },
      required: ["fields", "notes"],
    },
  } as OutputSchema;
}

/* ===================== system prompt ===================== */

export function buildSystemPrompt(
  form: FormDefinition,
  targetRef: string
): string {
  const slots = form.fields
    .map(f => {
      const bits: string[] = [f.type];
      if (f.unit) bits.push(f.unit);
      if (f.required) bits.push("required");
      if (f.options) bits.push(`one of: ${f.options.join(", ")}`);
      return `- ${f.key} (${f.label}) — ${bits.join(", ")}`;
    })
    .join("\n");

  return [
    `You are filling one LeaseOS form: ${form.title}, for ${targetRef}.`,
    ``,
    `Slots:`,
    slots,
    ``,
    `Rules:`,
    `1. Fill only these slots. If something was not said, return null — never guess.`,
    `2. Copy the speaker's own words into sourceUtterance for every slot you fill.`,
    `3. Set speakerHedged true whenever they qualified a value ("about", "around",`,
    `   "roughly", "maybe", "or so"). Report the hedge; do not decide what they meant.`,
    `4. Convert times to 24-hour HH:MM. "Quarter after ten" is 10:15. "Twenty to eleven"`,
    `   is 10:40. Keep the hedge flag separate from the conversion.`,
    `5. Record observations, never conclusions. If a driver describes a noise, record the`,
    `   noise. Do not name a cause, and do not state that anything is safe, unsafe, legal,`,
    `   compliant or cleared to depart. Those are not yours to determine.`,
  ].join("\n");
}

/* ===================== response → ExtractedValue[] ===================== */

type RawSlot = {
  value: unknown;
  sourceUtterance: string | null;
  speakerHedged: boolean;
  confidence: "low" | "medium" | "high";
};

/**
 * Hedge words checked against the driver's own utterance, independently of
 * what the model reported. If either the model or the text says it was
 * hedged, it is approximate — the two signals are combined pessimistically
 * because the cost of a false "exact" is much higher than a false "about".
 */
const HEDGES =
  /\b(about|around|roughly|approximately|maybe|or so|somewhere|ish|-ish|near enough|give or take)\b/i;

export function looksHedged(
  utterance: string | null | undefined,
  modelSaidHedged: boolean
): boolean {
  if (modelSaidHedged) return true;
  return Boolean(utterance && HEDGES.test(utterance));
}

export type ParsedExtraction = {
  values: ExtractedValue[];
  notes: string | null;
  /** Populated when the model asserted something it has no standing to assert. */
  overreach: string[];
};

export function parseExtraction(
  form: FormDefinition,
  raw: unknown,
  source: FieldSource = "driver_voice"
): ParsedExtraction {
  const values: ExtractedValue[] = [];
  const overreach: string[] = [];

  const root = (raw ?? {}) as {
    fields?: Record<string, RawSlot | null>;
    notes?: string | null;
  };
  const fields = root.fields ?? {};
  const declared = new Set(form.fields.map(f => f.key));

  for (const [key, slot] of Object.entries(fields)) {
    // Anything the model invented outside the schema is dropped, not stored.
    if (!declared.has(key) || !slot) continue;
    if (slot.value === null || slot.value === undefined || slot.value === "")
      continue;

    const hedged = looksHedged(
      slot.sourceUtterance,
      Boolean(slot.speakerHedged)
    );
    values.push({
      key,
      value: slot.value as ExtractedValue["value"],
      precision: hedged ? "approximate" : "exact",
      source,
      confidence: slot.confidence ?? "medium",
      sourceUtterance: slot.sourceUtterance ?? null,
    });
  }

  const notes = root.notes ?? null;
  if (notes) {
    const check = detectOverreach(notes);
    if (check.overreaches) overreach.push(...check.matched);
  }

  return { values, notes, overreach };
}

/**
 * Safe JSON parse for a model response. Returns null rather than throwing —
 * a malformed response is an expected condition, not an exception, and the
 * caller should fall back to asking the driver rather than crashing.
 */
export function parseModelJson(text: string): unknown | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
