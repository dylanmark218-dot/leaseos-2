/**
 * The contract: one source of truth for the form, and four honest ways to say
 * "I don't know".
 */
import { describe, expect, it } from "vitest";
import { FORMS } from "../_core/aiProposal";
import {
  EXTRACTED_FIELD_STATUSES,
  ExtractionUnparseable,
  parseExtractionEnvelope,
} from "./extraction/contract";
import { buildFormJsonSchema, buildFormZodSchema, declaredKeys } from "./extraction/formSchema";
import { CURRENT_EXTRACT_PROMPT, inputHash, loadPrompt, promptHash } from "./prompts";

const form = FORMS.unload_stop;

describe("the JSON Schema is derived, not written", () => {
  it("has exactly the form's slots and no others", () => {
    const { schema } = buildFormJsonSchema(form);
    const fields = (schema as any).properties.fields.properties;
    expect(Object.keys(fields).sort()).toEqual(form.fields.map(f => f.key).sort());
  });

  it("follows the form definition when the form changes", () => {
    // The derivation is the point: a slot added to FORMS reaches the model's
    // grammar without anybody editing a second description of the same form.
    const extended = {
      ...form,
      fields: [...form.fields, { key: "newSlot", label: "New", type: "text" as const, required: false }],
    };
    const fields = (buildFormJsonSchema(extended).schema as any).properties.fields.properties;
    expect(Object.keys(fields)).toContain("newSlot");
  });

  it("gives every slot a value, a status, a quote and a ref", () => {
    const { schema } = buildFormJsonSchema(form);
    const quantity = (schema as any).properties.fields.properties.quantity;
    expect(Object.keys(quantity.properties).sort()).toEqual(
      ["alternatives", "evidenceQuote", "evidenceRef", "status", "value"].sort()
    );
  });

  it("offers the four statuses and nothing that means 'probably'", () => {
    const { schema } = buildFormJsonSchema(form);
    const status = (schema as any).properties.fields.properties.quantity.properties.status;
    expect(status.enum.sort()).toEqual([...EXTRACTED_FIELD_STATUSES].sort());
  });

  it("lets a value be null, because `missing` has to be expressible", () => {
    const { schema } = buildFormJsonSchema(form);
    const value = (schema as any).properties.fields.properties.quantity.properties.value;
    expect(JSON.stringify(value)).toContain("null");
  });

  it("carries the two top-level flags the checkpoint added", () => {
    const { schema } = buildFormJsonSchema(form);
    expect(Object.keys((schema as any).properties).sort()).toEqual(
      ["fields", "injectionSuspected", "notes", "outOfScope"].sort()
    );
  });

  it("names and versions itself, so a server can cache the grammar", () => {
    expect(buildFormJsonSchema(form).name).toBe("leaseos_secretary_unload_stop_v1");
  });

  it("constrains an enum slot to the form's own options", () => {
    const zod = buildFormZodSchema(form);
    const ok = zod.safeParse({
      fields: Object.fromEntries(
        form.fields.map(f => [
          f.key,
          { value: null, status: "missing", evidenceQuote: null, evidenceRef: null },
        ])
      ),
      notes: null,
      outOfScope: false,
      injectionSuspected: false,
    });
    expect(ok.success).toBe(true);

    const bad = zod.safeParse({
      fields: {
        ...Object.fromEntries(
          form.fields.map(f => [
            f.key,
            { value: null, status: "missing", evidenceQuote: null, evidenceRef: null },
          ])
        ),
        measurementMethod: {
          value: "Vibes",
          status: "stated",
          evidenceQuote: "vibes",
          evidenceRef: null,
        },
      },
      notes: null,
      outOfScope: false,
      injectionSuspected: false,
    });
    expect(bad.success).toBe(false);
  });
});

describe("parsing a model response", () => {
  const keys = declaredKeys(form);

  it("drops a field the form never declared", () => {
    const envelope = parseExtractionEnvelope(
      {
        fields: {
          quantity: { value: 1, status: "stated", evidenceQuote: "one", evidenceRef: null },
          invented: { value: "x", status: "stated", evidenceQuote: "x", evidenceRef: null },
        },
        notes: null,
      },
      keys
    );
    expect(Object.keys(envelope.fields)).not.toContain("invented");
  });

  it("fills an omitted field as `missing`, so absence looks the same either way", () => {
    // A silently absent field and a field reported absent must not be
    // distinguishable downstream; that difference is where a PASS on an unasked
    // question would come from.
    const envelope = parseExtractionEnvelope({ fields: {}, notes: null }, keys);
    expect(Object.keys(envelope.fields).sort()).toEqual([...keys].sort());
    expect(envelope.fields.quantity).toEqual({
      value: null,
      status: "missing",
      evidenceQuote: null,
      evidenceRef: null,
    });
  });

  it("treats an unrecognised status as missing rather than guessing at it", () => {
    const envelope = parseExtractionEnvelope(
      { fields: { quantity: { value: 5, status: "probably", evidenceQuote: "five", evidenceRef: null } } },
      keys
    );
    expect(envelope.fields.quantity.status).toBe("missing");
  });

  it("keeps alternatives when there are any and omits the key when there are none", () => {
    const withAlts = parseExtractionEnvelope(
      {
        fields: {
          quantity: {
            value: 16,
            status: "ambiguous",
            evidenceQuote: "sixteen",
            evidenceRef: null,
            alternatives: [16, 17],
          },
        },
      },
      keys
    );
    expect(withAlts.fields.quantity.alternatives).toEqual([16, 17]);

    const without = parseExtractionEnvelope(
      { fields: { quantity: { value: 16, status: "stated", evidenceQuote: "sixteen", evidenceRef: null } } },
      keys
    );
    expect(without.fields.quantity.alternatives).toBeUndefined();
  });

  it("defaults both flags to false, and neither default is load-bearing", () => {
    const envelope = parseExtractionEnvelope({ fields: {} }, keys);
    expect(envelope.outOfScope).toBe(false);
    expect(envelope.injectionSuspected).toBe(false);
  });

  it("refuses a response that is not an object at all", () => {
    expect(() => parseExtractionEnvelope("nope", keys)).toThrow(ExtractionUnparseable);
    expect(() => parseExtractionEnvelope(null, keys)).toThrow(ExtractionUnparseable);
  });
});

describe("prompt versioning", () => {
  it("loads the versioned file from the repository", () => {
    const text = loadPrompt(CURRENT_EXTRACT_PROMPT);
    expect(text).toContain("You are the LeaseOS field secretary");
    expect(text).toContain("injectionSuspected");
    expect(text).toContain("outOfScope");
  });

  it("hashes the words, not the version name", () => {
    // A version number proves which file was named; the hash proves which words
    // were in it.
    expect(promptHash(CURRENT_EXTRACT_PROMPT)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives the same input the same hash and different inputs different ones", () => {
    expect(inputHash("a", "b")).toBe(inputHash("a", "b"));
    expect(inputHash("a", "b")).not.toBe(inputHash("b", "a"));
  });
});
