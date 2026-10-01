/**
 * The conversation loop, as a state machine with no clock and no I/O.
 */
import { describe, expect, it } from "vitest";
import { MAX_CLARIFY_ROUNDS, advance, initialState, isTerminal } from "./dialogue/machine";
import type { FieldVerdict, ValidationResult } from "./validate/validator";

const field = (
  key: string,
  verdict: FieldVerdict["verdict"],
  reasonCodes: string[] = [],
  label = key
): FieldVerdict => ({
  key,
  label,
  verdict,
  reasonCodes,
  details: [],
  normalizedValue: verdict === "PASS" ? "value" : null,
  basis: null,
});

const result = (fields: FieldVerdict[], outOfScope = false): ValidationResult => ({
  fields,
  blocked: fields.some(f => f.verdict === "BLOCKED"),
  needsClarification: fields.filter(f => f.verdict !== "PASS"),
  silentGuessKeys: [],
  outOfScope,
});

const clean = result([field("quantity", "PASS"), field("arrivedAt", "PASS")]);
const oneOpen = result([
  field("quantity", "REVIEW", ["volume_unit_missing"], "Quantity"),
  field("arrivedAt", "PASS"),
]);
const twoOpen = result([
  field("quantity", "REVIEW", ["volume_unit_missing"], "Quantity"),
  field("delayReason", "REVIEW", ["ambiguous_reading"], "Delay reason"),
]);

describe("the happy path", () => {
  it("runs listen → transcribe → extract → validate → readback → propose", () => {
    let s = initialState();
    expect(s.phase).toBe("LISTEN");

    s = advance(s, { type: "TRANSCRIPT_READY" });
    expect(s.phase).toBe("EXTRACT");

    s = advance(s, { type: "EXTRACTED" });
    expect(s.phase).toBe("VALIDATE");

    s = advance(s, { type: "VALIDATED", result: clean, vehicleMoving: false });
    expect(s.phase).toBe("READBACK");
    expect(s.utterance).toContain("Is that right?");

    s = advance(s, { type: "READBACK_CONFIRMED" });
    expect(s.phase).toBe("PROPOSE");
    expect(isTerminal(s)).toBe(true);
  });
});

describe("clarification", () => {
  it("asks one question about one field", () => {
    const s = advance(initialState(), { type: "VALIDATED", result: twoOpen, vehicleMoving: false });
    expect(s.phase).toBe("CLARIFY");
    expect(s.askingKey).toBe("quantity");
    // One sentence, one field. Two questions in a turn gets one answer.
    expect(s.utterance).toBe("You said null. Was that cubic metres or barrels?");
  });

  it("stops after three rounds and hands the draft to the office", () => {
    let s = initialState();
    s = advance(s, { type: "VALIDATED", result: oneOpen, vehicleMoving: false });
    for (let i = 1; i < MAX_CLARIFY_ROUNDS; i++) {
      s = advance(s, { type: "ANSWER", key: "quantity", result: oneOpen, vehicleMoving: false });
      expect(s.phase).toBe("CLARIFY");
    }
    expect(s.round).toBe(MAX_CLARIFY_ROUNDS);

    s = advance(s, { type: "ANSWER", key: "quantity", result: oneOpen, vehicleMoving: false });
    expect(s.phase).toBe("DRAFT_FOR_OFFICE");
    expect(s.unresolvedKeys).toContain("quantity");
    expect(isTerminal(s)).toBe(true);
  });

  it("reaches the read-back as soon as the answer settles the field", () => {
    let s = advance(initialState(), { type: "VALIDATED", result: oneOpen, vehicleMoving: false });
    s = advance(s, { type: "ANSWER", key: "quantity", result: clean, vehicleMoving: false });
    expect(s.phase).toBe("READBACK");
    expect(s.correctedKeys).toEqual(["quantity"]);
  });
});

describe("while the truck is moving", () => {
  it("holds the question instead of asking it", () => {
    const s = advance(initialState(), { type: "VALIDATED", result: oneOpen, vehicleMoving: true });
    expect(s.phase).toBe("HOLDING");
    expect(s.utterance).toBeNull();
    // Held, not dropped: the chosen field is carried so nothing is re-decided.
    expect(s.askingKey).toBe("quantity");
    expect(s.round).toBe(0);
  });

  it("asks the moment the truck stops", () => {
    let s = advance(initialState(), { type: "VALIDATED", result: oneOpen, vehicleMoving: true });
    s = advance(s, { type: "VEHICLE_STOPPED", result: oneOpen });
    expect(s.phase).toBe("CLARIFY");
    expect(s.utterance).not.toBeNull();
    expect(s.round).toBe(1);
  });

  it("is not advanced by the truck stopping when it was not holding", () => {
    const readback = advance(initialState(), { type: "VALIDATED", result: clean, vehicleMoving: false });
    expect(advance(readback, { type: "VEHICLE_STOPPED", result: clean })).toEqual(readback);
  });
});

describe("corrections", () => {
  it("re-asks only the field the driver named, and does not spend a round", () => {
    let s = advance(initialState(), { type: "VALIDATED", result: clean, vehicleMoving: false });
    expect(s.phase).toBe("READBACK");

    s = advance(s, { type: "READBACK_REJECTED", key: "quantity" });
    expect(s.phase).toBe("CLARIFY");
    expect(s.askingKey).toBe("quantity");
    // The rounds exist to stop the machine nagging. This round was the
    // driver's idea, so it does not count against them.
    expect(s.round).toBe(0);
    expect(s.correctedKeys).toEqual(["quantity"]);
  });

  it("records a corrected key once, however many times it is corrected", () => {
    let s = advance(initialState(), { type: "VALIDATED", result: oneOpen, vehicleMoving: false });
    s = advance(s, { type: "ANSWER", key: "quantity", result: oneOpen, vehicleMoving: false });
    s = advance(s, { type: "ANSWER", key: "quantity", result: clean, vehicleMoving: false });
    expect(s.correctedKeys).toEqual(["quantity"]);
  });
});

describe("out of scope", () => {
  it("refuses, asks nothing, and produces no proposal", () => {
    const s = advance(initialState(), {
      type: "VALIDATED",
      result: result([field("quantity", "PASS")], true),
      vehicleMoving: false,
    });
    expect(s.phase).toBe("REFUSED");
    expect(s.askingKey).toBeNull();
    expect(isTerminal(s)).toBe(true);
  });
});
