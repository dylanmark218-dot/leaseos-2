import { describe, expect, it } from "vitest";
import { FORMS } from "./aiProposal";
import {
  buildOutputSchema,
  buildSystemPrompt,
  looksHedged,
  parseExtraction,
  parseModelJson,
} from "./assistantExtraction";

const UNLOAD = FORMS.unload_stop;

const slot = (
  value: unknown,
  utterance: string | null,
  hedged = false,
  confidence: "low" | "medium" | "high" = "high"
) => ({ value, sourceUtterance: utterance, speakerHedged: hedged, confidence });

describe("buildOutputSchema", () => {
  it("declares every form field and nothing else", () => {
    const s = buildOutputSchema(UNLOAD) as any;
    const props = Object.keys(s.schema.properties.fields.properties);
    expect(props.sort()).toEqual(UNLOAD.fields.map(f => f.key).sort());
  });

  it("forbids additional properties so the model cannot invent slots", () => {
    const s = buildOutputSchema(UNLOAD) as any;
    expect(s.schema.additionalProperties).toBe(false);
    expect(s.schema.properties.fields.additionalProperties).toBe(false);
  });

  it("requires the utterance and hedge flag on every slot", () => {
    const s = buildOutputSchema(UNLOAD) as any;
    const arrived = s.schema.properties.fields.properties.arrivedAt;
    expect(arrived.required).toEqual(
      expect.arrayContaining([
        "value",
        "sourceUtterance",
        "speakerHedged",
        "confidence",
      ])
    );
  });

  it("constrains an enum field to its declared options", () => {
    const s = buildOutputSchema(UNLOAD) as any;
    const method = s.schema.properties.fields.properties.measurementMethod;
    expect(method.properties.value.enum).toEqual(
      expect.arrayContaining(["Meter", "Scale", "Gauge", "Estimate"])
    );
  });

  it("versions the schema name so a form change is visible", () => {
    const s = buildOutputSchema(UNLOAD) as any;
    expect(s.name).toBe("leaseos_unload_stop_v1");
  });
});

describe("buildSystemPrompt", () => {
  it("names the target record and lists the slots", () => {
    const p = buildSystemPrompt(UNLOAD, "TRIP-2026-004821 unload stop");
    expect(p).toContain("TRIP-2026-004821 unload stop");
    expect(p).toContain("arrivedAt");
    expect(p).toContain("measurementMethod");
  });

  it("instructs the model to report hedges rather than interpret them", () => {
    const p = buildSystemPrompt(UNLOAD, "x");
    expect(p).toContain("Report the hedge; do not decide what they meant");
  });

  it("forbids conclusions about safety, legality and cause", () => {
    const p = buildSystemPrompt(UNLOAD, "x");
    expect(p).toContain("Record observations, never conclusions");
    expect(p).toContain("cleared to depart");
  });

  it("tells the model to return null rather than guess", () => {
    expect(buildSystemPrompt(UNLOAD, "x")).toContain("never guess");
  });
});

describe("looksHedged — two independent signals, combined pessimistically", () => {
  it("trusts the model when it reports a hedge", () => {
    expect(looksHedged("ten o'clock", true)).toBe(true);
  });

  it("catches a hedge in the words even when the model missed it", () => {
    expect(looksHedged("around ten", false)).toBe(true);
    expect(looksHedged("about eight minutes", false)).toBe(true);
    expect(looksHedged("roughly 8000 litres", false)).toBe(true);
    expect(looksHedged("twenty to eleven or so", false)).toBe(true);
    expect(looksHedged("give or take ten minutes", false)).toBe(true);
  });

  it("does not invent a hedge where there is none", () => {
    expect(looksHedged("ten fifteen exactly", false)).toBe(false);
    expect(looksHedged("the meter read 8000", false)).toBe(false);
    expect(looksHedged(null, false)).toBe(false);
  });
});

describe("parseExtraction", () => {
  const raw = {
    fields: {
      arrivedAt: slot("10:00", "around ten", false),
      waitMinutes: slot(8, "about eight minutes", false),
      operationStartedAt: slot("10:15", "quarter after", false),
      operationCompletedAt: slot("10:40", "twenty to eleven", true),
      delayReason: slot(
        "Scale delay",
        "the scale was backed up",
        false,
        "medium"
      ),
      quantity: slot(null, null),
      measurementMethod: slot(null, null),
      departedAt: slot(null, null),
    },
    notes: "Driver mentioned a grinding noise on start-up.",
  };

  it("marks a value approximate when the words hedge, even if the model said otherwise", () => {
    const r = parseExtraction(UNLOAD, raw);
    expect(r.values.find(v => v.key === "arrivedAt")?.precision).toBe(
      "approximate"
    );
    expect(r.values.find(v => v.key === "waitMinutes")?.precision).toBe(
      "approximate"
    );
  });

  it("marks a value exact only when neither signal hedges", () => {
    expect(
      parseExtraction(UNLOAD, raw).values.find(
        v => v.key === "operationStartedAt"
      )?.precision
    ).toBe("exact");
  });

  it("keeps the driver's words with every value", () => {
    const r = parseExtraction(UNLOAD, raw);
    expect(r.values.find(v => v.key === "arrivedAt")?.sourceUtterance).toBe(
      "around ten"
    );
  });

  it("skips slots the model returned as null", () => {
    const keys = parseExtraction(UNLOAD, raw).values.map(v => v.key);
    expect(keys).not.toContain("quantity");
    expect(keys).not.toContain("departedAt");
  });

  it("drops any slot outside the form, even if the model returns one", () => {
    const r = parseExtraction(UNLOAD, {
      ...raw,
      fields: { ...raw.fields, driverMood: slot("tired", "I'm beat") },
    });
    expect(r.values.find(v => v.key === "driverMood")).toBeUndefined();
  });

  it("passes observational notes through untouched", () => {
    const r = parseExtraction(UNLOAD, raw);
    expect(r.notes).toContain("grinding noise");
    expect(r.overreach).toEqual([]);
  });

  it("flags notes in which the model drew a conclusion", () => {
    const r = parseExtraction(UNLOAD, {
      ...raw,
      notes:
        "The problem is a worn pump bearing. The unit is safe to dispatch.",
    });
    expect(r.overreach.length).toBeGreaterThan(0);
  });

  it("survives a completely empty response", () => {
    const r = parseExtraction(UNLOAD, {});
    expect(r.values).toEqual([]);
    expect(r.notes).toBeNull();
  });

  it("defaults a missing confidence to medium rather than assuming high", () => {
    const r = parseExtraction(UNLOAD, {
      fields: {
        arrivedAt: {
          value: "10:00",
          sourceUtterance: "ten",
          speakerHedged: false,
        } as never,
      },
    });
    expect(r.values[0].confidence).toBe("medium");
  });
});

describe("parseModelJson", () => {
  it("parses a plain JSON response", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences a model may add", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("returns null on malformed output instead of throwing", () => {
    expect(parseModelJson("sorry, I couldn't do that")).toBeNull();
    expect(parseModelJson("")).toBeNull();
  });
});
