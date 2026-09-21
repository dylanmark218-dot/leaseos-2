/**
 * B24 — widget options.
 *
 * Pure.
 *
 * Options were opaque JSON in B23, which was defensible while nothing wrote to
 * them. As soon as a UI does, they are a persisted, client-supplied blob that
 * reaches resolution, and three things have to be impossible:
 *
 *   - choosing a different server procedure ("source": "billing.read")
 *   - widening permission ("asRole": "DISPATCHER")
 *   - smuggling an expression for something downstream to evaluate
 *
 * All three die to the same rule: options are a closed set of named scalars
 * with declared bounds, validated against the widget's own schema, and any key
 * the schema does not declare is refused by name. There is no object value, no
 * array, no string outside a declared enum — so there is nothing to interpret.
 *
 * Values are normalized on the way in, not coerced on the way out. A stored
 * option is already valid, so resolution never has to ask.
 */

import { definitionFor, type OptionSpec, type WidgetKey } from "./widgetRegistry";

/**
 * Serialized ceiling.
 *
 * A closed schema of scalars cannot get large on its own, so this only catches
 * a caller sending something absurd before the per-key checks run. Forty tiles
 * times this is still a small row set.
 */
export const MAX_OPTIONS_BYTES = 2_048;

export type OptionsOutcome =
  | { ok: true; options: Readonly<Record<string, unknown>> | null }
  | { ok: false; rejections: readonly { code: string; detail: string }[] };

function checkOne(name: string, spec: OptionSpec, raw: unknown): { value: unknown } | { detail: string } {
  switch (spec.kind) {
    case "int": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { detail: `"${name}" must be a whole number` };
      }
      if (raw < spec.min || raw > spec.max) {
        return { detail: `"${name}" must be between ${spec.min} and ${spec.max}, not ${raw}` };
      }
      return { value: raw };
    }
    case "bool": {
      // No truthiness. "false" and 0 are not false here; they are the wrong
      // type, and silently accepting them is how a threshold ends up off.
      if (typeof raw !== "boolean") return { detail: `"${name}" must be true or false` };
      return { value: raw };
    }
    case "enum": {
      if (typeof raw !== "string" || !spec.values.includes(raw)) {
        return { detail: `"${name}" must be one of ${spec.values.join(", ")}` };
      }
      return { value: raw };
    }
  }
}

/**
 * Validate and normalize one tile's options.
 *
 * Returns `null` for a widget that takes none, so the column holds null rather
 * than an empty object — one spelling for "nothing", which is the lesson from
 * the `options: null` versus `undefined` mismatch in B23.
 */
export function validateOptions(widgetKey: WidgetKey, raw: unknown): OptionsOutcome {
  const schema = definitionFor(widgetKey).optionsSchema;
  const declared = Object.keys(schema);

  if (raw === null || raw === undefined) {
    return { ok: true, options: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, rejections: [{ code: "OPTIONS_NOT_AN_OBJECT", detail: "options must be an object" }] };
  }

  const size = JSON.stringify(raw).length;
  if (size > MAX_OPTIONS_BYTES) {
    return {
      ok: false,
      rejections: [{ code: "OPTIONS_TOO_LARGE", detail: `options are ${size} bytes; the limit is ${MAX_OPTIONS_BYTES}` }],
    };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (declared.length === 0 && entries.length > 0) {
    return {
      ok: false,
      rejections: [{
        code: "OPTIONS_NOT_SUPPORTED",
        detail: `${definitionFor(widgetKey).title} takes no options; got ${entries.map(([k]) => k).join(", ")}`,
      }],
    };
  }

  const rejections: { code: string; detail: string }[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, value] of entries) {
    const spec = schema[name];
    if (!spec) {
      // Named, not silently dropped. A dropped key is a setting the user
      // believes they applied.
      rejections.push({
        code: "OPTION_UNKNOWN",
        detail: `"${name}" is not an option for ${definitionFor(widgetKey).title}`,
      });
      continue;
    }
    const checked = checkOne(name, spec, value);
    if ("detail" in checked) {
      rejections.push({ code: "OPTION_INVALID", detail: checked.detail });
      continue;
    }
    out[name] = checked.value;
  }

  if (rejections.length > 0) return { ok: false, rejections };

  // Declared defaults are filled in, so a stored option set is complete and
  // resolution never has to decide what a missing key meant.
  for (const [name, spec] of Object.entries(schema)) {
    if (!(name in out)) out[name] = spec.default;
  }

  return { ok: true, options: Object.keys(out).length > 0 ? out : null };
}
