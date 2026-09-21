/**
 * The conversation, as pure functions over a state value.
 *
 *     LISTEN → TRANSCRIBE → EXTRACT → VALIDATE → CLARIFY (≤3) → READBACK
 *            → CONFIRM | CORRECT → PROPOSE
 *
 * Nothing here calls a model, a database or a clock. `advance` takes a state
 * and an event and returns the next state, which is what makes "after three
 * unresolved rounds it saves a draft instead of nagging" a property a test can
 * assert rather than a behaviour somebody remembers implementing.
 *
 * The rules that are in here rather than in a prompt:
 *
 * **One question per turn, highest stakes first.** The ordering is the
 * validator's, so the conversation cannot disagree with the judge about what
 * matters.
 *
 * **A correction re-extracts one field.** "No, eighteen" changes the volume
 * and nothing else. Re-running the whole narration would let an unrelated
 * field move for no reason a person could account for, and the new value is
 * tagged `corrected` — which is also the free training set the plan wants
 * later, since every correction is a labelled example.
 *
 * **Questions wait while the truck moves.** The state machine holds them; it
 * does not decide the distracted-driving rule, it just refuses to be the
 * reason somebody looks down. A held question is not a lost question.
 *
 * **Three rounds, then stop.** An assistant that asks a fourth time has
 * stopped helping. The draft goes to the office with its unresolved fields
 * intact, which is a better artifact than a form filled in by attrition.
 */

import type { ValidationResult, FieldVerdict } from "../validate/validator";
import { questionFor, readBack } from "../validate/questions";

export const MAX_CLARIFY_ROUNDS = 3;

export type DialoguePhase =
  | "LISTEN"
  | "TRANSCRIBE"
  | "EXTRACT"
  | "VALIDATE"
  | "CLARIFY"
  | "HOLDING"
  | "READBACK"
  | "PROPOSE"
  | "DRAFT_FOR_OFFICE"
  | "REFUSED";

export type DialogueState = {
  phase: DialoguePhase;
  /** How many questions have been asked and answered or abandoned. */
  round: number;
  /** The field currently being asked about, if any. */
  askingKey: string | null;
  /** The sentence to speak now. Null when there is nothing to say. */
  utterance: string | null;
  /** Keys the driver has corrected, which become provenance `corrected`. */
  correctedKeys: string[];
  /** Keys asked about and still not resolved when the rounds ran out. */
  unresolvedKeys: string[];
};

export type DialogueEvent =
  | { type: "TRANSCRIPT_READY" }
  | { type: "EXTRACTED" }
  | { type: "VALIDATED"; result: ValidationResult; vehicleMoving: boolean }
  | { type: "VEHICLE_STOPPED"; result: ValidationResult }
  | { type: "ANSWER"; key: string; result: ValidationResult; vehicleMoving: boolean }
  | { type: "READBACK_CONFIRMED" }
  | { type: "READBACK_REJECTED"; key: string };

export const initialState = (): DialogueState => ({
  phase: "LISTEN",
  round: 0,
  askingKey: null,
  utterance: null,
  correctedKeys: [],
  unresolvedKeys: [],
});

/** The next field to ask about: the validator's order, first one still open. */
const nextOpen = (result: ValidationResult): FieldVerdict | null =>
  result.needsClarification[0] ?? null;

/**
 * Decide what to do once a validation result is in hand.
 *
 * Shared by the first validation and by every answer, because they are the
 * same decision: is anything still open, have we asked too often, and is the
 * truck moving. Writing it twice is how the two paths drift apart.
 */
function afterValidation(
  state: DialogueState,
  result: ValidationResult,
  vehicleMoving: boolean
): DialogueState {
  // Out of scope short-circuits everything. No proposal is created at all, so
  // there is nothing to clarify and nothing to read back.
  if (result.outOfScope) {
    return {
      ...state,
      phase: "REFUSED",
      askingKey: null,
      utterance: "I only handle trucking operations. I have not written anything down.",
    };
  }

  const open = nextOpen(result);

  if (!open) {
    return {
      ...state,
      phase: "READBACK",
      askingKey: null,
      utterance: readBack(result.fields),
    };
  }

  if (state.round >= MAX_CLARIFY_ROUNDS) {
    return {
      ...state,
      phase: "DRAFT_FOR_OFFICE",
      askingKey: null,
      utterance: "I have saved this as a draft and flagged it for the office.",
      unresolvedKeys: result.needsClarification.map(f => f.key),
    };
  }

  if (vehicleMoving) {
    // Held, not dropped. The question is already chosen; it is spoken the
    // moment the truck stops, which is why the key is carried in the state.
    return { ...state, phase: "HOLDING", askingKey: open.key, utterance: null };
  }

  return {
    ...state,
    phase: "CLARIFY",
    round: state.round + 1,
    askingKey: open.key,
    utterance: questionFor(open),
  };
}

export function advance(state: DialogueState, event: DialogueEvent): DialogueState {
  switch (event.type) {
    case "TRANSCRIPT_READY":
      return { ...state, phase: "EXTRACT", utterance: null };

    case "EXTRACTED":
      return { ...state, phase: "VALIDATE", utterance: null };

    case "VALIDATED":
      return afterValidation(state, event.result, event.vehicleMoving);

    case "VEHICLE_STOPPED":
      // Only a held question is released. A state that was not holding is not
      // advanced by the truck stopping.
      return state.phase === "HOLDING"
        ? afterValidation(state, event.result, false)
        : state;

    case "ANSWER": {
      // The answer re-extracted exactly one field, and that field's new value
      // came from the driver's own correction.
      const corrected = state.correctedKeys.includes(event.key)
        ? state.correctedKeys
        : [...state.correctedKeys, event.key];
      return afterValidation(
        { ...state, correctedKeys: corrected },
        event.result,
        event.vehicleMoving
      );
    }

    case "READBACK_CONFIRMED":
      return { ...state, phase: "PROPOSE", askingKey: null, utterance: null };

    case "READBACK_REJECTED":
      // A rejected read-back is a correction, not a restart: the driver names
      // the field that is wrong and only that field is asked again. It does not
      // spend a clarify round, because the rounds exist to stop the machine
      // nagging and this round was the driver's idea.
      return {
        ...state,
        phase: "CLARIFY",
        askingKey: event.key,
        utterance: `What should it be?`,
        correctedKeys: state.correctedKeys.includes(event.key)
          ? state.correctedKeys
          : [...state.correctedKeys, event.key],
      };
  }
}

/** True once the conversation has produced whatever it is going to produce. */
export const isTerminal = (state: DialogueState): boolean =>
  state.phase === "PROPOSE" ||
  state.phase === "DRAFT_FOR_OFFICE" ||
  state.phase === "REFUSED";
