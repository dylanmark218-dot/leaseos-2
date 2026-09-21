/**
 * The judge: the quote tripwire, and the rule that a missing term never passes.
 */
import { describe, expect, it } from "vitest";
import { FORMS } from "../_core/aiProposal";
import { buildContextPack } from "./context/contextPack";
import { parseExtractionEnvelope } from "./extraction/contract";
import { declaredKeys } from "./extraction/formSchema";
import {
  quoteIsInTranscript,
  validateExtraction,
  worst,
  type SttConfidence,
} from "./validate/validator";

const form = FORMS.unload_stop;

const pack = (over: Partial<Parameters<typeof buildContextPack>[0]> = {}) =>
  buildContextPack({
    formKey: "unload_stop",
    formVersion: 1,
    tripRef: "TRIP-2026-004821",
    unitNumber: "T-118",
    unitTankCapacityLitres: 16000,
    ...over,
  });

/** A response with every declared slot missing, so a test sets only what it means. */
const envelope = (fields: Record<string, unknown>, top: Record<string, unknown> = {}) =>
  parseExtractionEnvelope({ fields, notes: null, ...top }, declaredKeys(form));

const stated = (value: unknown, quote: string) => ({
  value,
  status: "stated",
  evidenceQuote: quote,
  evidenceRef: null,
});

describe("the quote check", () => {
  const transcript = "Twelve thousand  litres on the meter.";

  it("accepts a verbatim quote across collapsed whitespace", () => {
    expect(quoteIsInTranscript("Twelve thousand litres", transcript)).toBe(true);
  });

  it("rejects a quote that is not in the transcript", () => {
    expect(quoteIsInTranscript("nine thousand litres", transcript)).toBe(false);
  });

  it("rejects an empty quote rather than treating it as trivially present", () => {
    expect(quoteIsInTranscript("", transcript)).toBe(false);
    expect(quoteIsInTranscript(null, transcript)).toBe(false);
  });
});

describe("a fabricated quote", () => {
  const transcript = "Arrived 11:00, unloaded 11:15 to 11:50. Meter reading.";

  it("is BLOCKED, not REVIEW — the driver did not say it, so there is nothing to confirm", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({ quantity: stated(9000, "nine thousand litres") }),
      transcript,
      pack: pack(),
    });

    const quantity = result.fields.find(f => f.key === "quantity");
    expect(quantity?.verdict).toBe("BLOCKED");
    expect(quantity?.reasonCodes).toContain("quote_not_in_transcript");
    expect(result.blocked).toBe(true);
  });

  it("is counted as a silent guess, which is the metric pinned at zero", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({ quantity: stated(9000, "nine thousand litres") }),
      transcript,
      pack: pack(),
    });
    expect(result.silentGuessKeys).toEqual(["quantity"]);
  });

  it("is not counted when every stated quote is real", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({ arrivedAt: stated("11:00", "Arrived 11:00") }),
      transcript,
      pack: pack(),
    });
    expect(result.silentGuessKeys).toEqual([]);
  });
});

describe("a missing term never rounds up to PASS", () => {
  const transcript = "Twenty two thousand litres on the meter.";
  const quantity = stated(22000, "Twenty two thousand litres on the meter");

  it("reports NOT_EVALUATED when no tank capacity is on file", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({ quantity }),
      transcript,
      pack: pack({ unitTankCapacityLitres: null }),
    });
    const field = result.fields.find(f => f.key === "quantity");
    expect(field?.verdict).toBe("NOT_EVALUATED");
    expect(field?.reasonCodes).toContain("capacity_unknown");
  });

  it("reports NOT_EVALUATED when there WAS audio and the transcriber reported nothing", () => {
    const silent: SttConfidence = { minForSpan: () => null };
    const result = validateExtraction({
      form,
      envelope: envelope({ measurementMethod: stated("Meter", "on the meter") }),
      transcript: "Reading on the meter.",
      pack: pack(),
      stt: silent,
    });
    const field = result.fields.find(f => f.key === "measurementMethod");
    expect(field?.verdict).toBe("NOT_EVALUATED");
    expect(field?.reasonCodes).toContain("stt_confidence_unavailable");
  });

  it("leaves the term out entirely for a typed transcript, which has no speech leg", () => {
    // Phase 1 is typed. Typed words carry no transcription risk, so this is a
    // check with no subject — not a check that failed to run.
    const result = validateExtraction({
      form,
      envelope: envelope({ measurementMethod: stated("Meter", "on the meter") }),
      transcript: "Reading on the meter.",
      pack: pack(),
    });
    const field = result.fields.find(f => f.key === "measurementMethod");
    expect(field?.verdict).toBe("PASS");
    expect(field?.reasonCodes).not.toContain("stt_confidence_unavailable");
  });

  it("passes only when the transcriber was actually confident", () => {
    const confident: SttConfidence = { minForSpan: () => 0.95 };
    const result = validateExtraction({
      form,
      envelope: envelope({ measurementMethod: stated("Meter", "on the meter") }),
      transcript: "Reading on the meter.",
      pack: pack(),
      stt: confident,
    });
    expect(result.fields.find(f => f.key === "measurementMethod")?.verdict).toBe("PASS");
  });

  it("sends a low-confidence span to REVIEW", () => {
    const shaky: SttConfidence = { minForSpan: () => 0.31 };
    const result = validateExtraction({
      form,
      envelope: envelope({ measurementMethod: stated("Meter", "on the meter") }),
      transcript: "Reading on the meter.",
      pack: pack(),
      stt: shaky,
    });
    const field = result.fields.find(f => f.key === "measurementMethod");
    expect(field?.verdict).toBe("REVIEW");
    expect(field?.reasonCodes).toContain("stt_confidence_low");
  });

  it("is the behaviour of `worst` itself: no terms is NOT_EVALUATED", () => {
    expect(worst([])).toBe("NOT_EVALUATED");
    expect(worst(["PASS", "NOT_EVALUATED"])).toBe("NOT_EVALUATED");
    expect(worst(["PASS", "REVIEW"])).toBe("REVIEW");
    expect(worst(["REVIEW", "BLOCKED"])).toBe("BLOCKED");
    expect(worst(["PASS", "PASS"])).toBe("PASS");
  });
});

describe("evidence for an inferred field", () => {
  it("accepts an id that is in the context pack", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({
        delayReason: { value: "Queue", status: "inferred", evidenceQuote: null, evidenceRef: "trip" },
      }),
      transcript: "Nothing about a delay.",
      pack: pack(),
    });
    expect(result.fields.find(f => f.key === "delayReason")?.verdict).toBe("PASS");
  });

  it("rejects an id that was never shown to the model", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({
        delayReason: { value: "Queue", status: "inferred", evidenceQuote: null, evidenceRef: "ticket_99" },
      }),
      transcript: "Nothing about a delay.",
      pack: pack(),
    });
    const field = result.fields.find(f => f.key === "delayReason");
    expect(field?.verdict).toBe("REVIEW");
    expect(field?.reasonCodes).toContain("evidence_ref_not_in_context");
  });

  it("rejects an inference with nothing cited", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({
        delayReason: { value: "Queue", status: "inferred", evidenceQuote: null, evidenceRef: null },
      }),
      transcript: "Nothing about a delay.",
      pack: pack(),
    });
    expect(result.fields.find(f => f.key === "delayReason")?.verdict).toBe("REVIEW");
  });
});

describe("required and optional absences are different answers", () => {
  it("makes a missing required field UNKNOWN", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({}),
      transcript: "Nothing useful.",
      pack: pack(),
    });
    // quantity is required, waitMinutes is not.
    expect(result.fields.find(f => f.key === "quantity")?.verdict).toBe("UNKNOWN");
    expect(result.fields.find(f => f.key === "waitMinutes")?.verdict).toBe("NOT_EVALUATED");
  });

  it("gives every declared field a verdict, including ones the model omitted", () => {
    const result = validateExtraction({
      form,
      envelope: envelope({}),
      transcript: "Nothing useful.",
      pack: pack(),
    });
    expect(result.fields.map(f => f.key).sort()).toEqual(form.fields.map(f => f.key).sort());
  });
});

describe("what gets asked first", () => {
  it("orders by verdict severity, then by what the field costs if it is wrong", () => {
    const transcript = "Dumped sixteen. Some kind of delay at the gate.";
    const result = validateExtraction({
      form,
      envelope: envelope({
        quantity: stated(16, "Dumped sixteen"),
        delayReason: {
          value: "Gate",
          status: "ambiguous",
          evidenceQuote: "Some kind of delay at the gate",
          evidenceRef: null,
          alternatives: ["Queue", "Site unavailable"],
        },
      }),
      transcript,
      pack: pack(),
    });

    // Both are REVIEW; the volume bills a customer and the delay reason is a
    // note, so the volume is asked about first.
    const reviews = result.needsClarification.filter(f => f.verdict === "REVIEW");
    expect(reviews[0].key).toBe("quantity");
  });
});
