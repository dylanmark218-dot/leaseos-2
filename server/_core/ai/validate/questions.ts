/**
 * The questions, written by people and chosen by code.
 *
 * Asking the model to phrase its own question puts the least reliable
 * component in charge of the sentence a driver hears at 60 km/h. Templates
 * keyed on a reason code cost nothing at runtime, read the same every time,
 * and can be rewritten by whoever actually talks to drivers.
 *
 * Three rules they are written to:
 *
 * **One question, one field.** "Sixteen cubic metres or barrels?" has an
 * answer. "Can you confirm the volume and the ticket?" has two, and a driver
 * answers one of them.
 *
 * **Digits are said one at a time.** "Four-four-seven-one", not "forty-four
 * seventy-one" — the second is what a transcriber heard wrong in the first
 * place, and repeating it back the same way gets the same agreement to the
 * same mistake.
 *
 * **Never suggest the answer.** "Was that sixteen?" gets "yes" from a driver
 * who is not listening. The templates offer readings or ask openly.
 */

import type { FieldVerdict } from "./validator";

/** Ticket numbers and anything else a person should hear digit by digit. */
export const spellDigits = (value: string | number): string =>
  String(value).replace(/\d+/g, run => run.split("").join("-"));

type Template = (f: FieldVerdict) => string;

/**
 * One template per reason code. A code with no template falls through to the
 * generic ask rather than to silence: a field that needs a question and does
 * not produce one is a field that quietly becomes whatever the model said.
 */
const TEMPLATES: Readonly<Record<string, Template>> = {
  volume_unit_missing: f =>
    `You said ${f.normalizedValue}. Was that cubic metres or barrels?`,

  volume_unit_mismatch: f =>
    `You said ${f.normalizedValue} in a different unit than this form records. Which should I put down?`,

  volume_over_capacity: f =>
    `${f.normalizedValue} is more than that unit's tank holds. What was the volume?`,

  volume_not_positive: () => `I did not catch a volume. How much was it?`,

  time_meridiem_unknown: f => `Was ${f.label.toLowerCase()} in the morning or the evening?`,

  time_from_geofence: f =>
    `The truck's location puts ${f.label.toLowerCase()} at ${f.normalizedValue}. Is that right?`,

  time_unreadable: f => `I did not catch ${f.label.toLowerCase()}. What time was it?`,

  ticket_prefix_missing: f =>
    `Is the ticket number ${spellDigits(String(f.normalizedValue ?? ""))}, or does it have a prefix?`,

  ticket_not_open: f =>
    `I have ticket ${spellDigits(String(f.normalizedValue ?? ""))}, which is not on your open list. Can you read it back to me?`,

  stt_confidence_low: f => `I am not sure I heard ${f.label.toLowerCase()}. Can you say it again?`,

  ambiguous_reading: f =>
    `${f.label} could be more than one thing. Which did you mean?`,

  required_field_missing: f => `I still need ${f.label.toLowerCase()}.`,

  enum_value_not_an_option: f => `What should I put for ${f.label.toLowerCase()}?`,

  evidence_ref_not_in_context: f =>
    `I filled in ${f.label.toLowerCase()} from something I cannot point to. What should it be?`,

  quote_not_in_transcript: f =>
    `I have ${f.label.toLowerCase()} written down but no record of you saying it. What should it be?`,
};

/**
 * The one question for a field.
 *
 * The first reason code with a template wins, and the codes are pushed in
 * check order, so the earliest failure is the one asked about — a field that
 * is both low-confidence and missing a unit is a field the driver should
 * simply repeat.
 */
export function questionFor(field: FieldVerdict): string {
  for (const code of field.reasonCodes) {
    const template = TEMPLATES[code];
    if (template) return template(field);
  }
  return `Can you tell me ${field.label.toLowerCase()} again?`;
}

/**
 * The read-back, once every field is settled.
 *
 * Short, and ticket numbers digit by digit. A read-back nobody listens to is
 * worse than none, because it manufactures a confirmation.
 */
export function readBack(fields: readonly FieldVerdict[]): string {
  const said = fields
    .filter(f => f.normalizedValue !== null && f.normalizedValue !== "")
    .map(f => {
      const isTicket = /ticket/i.test(f.key);
      const value = isTicket ? spellDigits(String(f.normalizedValue)) : String(f.normalizedValue);
      return `${f.label}: ${value}`;
    });

  return said.length === 0 ? "I have nothing written down yet." : `${said.join(". ")}. Is that right?`;
}
