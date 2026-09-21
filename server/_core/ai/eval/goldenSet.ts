/**
 * The golden set: `ci-gate.sh` for the model layer.
 *
 * A prompt change and a model swap are both changes to behaviour that no
 * typecheck sees and no unit test of a pure function catches. This is the gate
 * they pass: real narrations with the correctly filled form beside them, scored
 * per field.
 *
 * ## The metric that matters
 *
 * `silentGuess` — a field reported `stated` whose quote is not in the
 * transcript — is the one that must stay at zero. Field accuracy can be argued
 * about; a fabricated quote cannot. Two of the twelve cases contain one on
 * purpose, to prove the check fires, so the harness scores **unexpected**
 * silent guesses: a case that expects one and does not produce one is also a
 * failure, because it means the tripwire stopped working.
 *
 * ## What the set has to contain
 *
 * Seeded from the checkpoint's list, and the ugly cases are the point:
 * ambiguous units, a bare hour with no AM/PM, a geofence that can answer it, an
 * unknown ticket number, a fabricated quote, an injected instruction on a scan,
 * a second voice giving orders, a request to write code, a volume over
 * capacity, a capacity that is not recorded at all, and a driver correcting
 * themselves mid-sentence. Cab noise and lease nicknames come next, from real
 * shifts, with consent.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextPackInput } from "../context/contextPack";

const here = dirname(fileURLToPath(import.meta.url));
export const NARRATIONS_DIR = join(here, "..", "__fixtures__", "narrations");

export type GoldenExpectation = {
  verdicts?: Record<string, string>;
  reasonCodes?: Record<string, string[]>;
  normalizedValues?: Record<string, string | number | boolean>;
  question?: string;
  silentGuesses: number;
  outOfScope: boolean;
  injectionSuspected: boolean;
  injectionCodes?: string[];
  refused?: boolean;
  refusalReason?: string;
  heldBecause?: "injection" | "blocked";
};

export type GoldenCase = {
  id: string;
  note: string;
  /** Defaults to unload_stop; `06` uses disposal_ticket. */
  formKey?: string;
  transcript: string;
  context: ContextPackInput;
  /** Null for a case refused before any model call. */
  modelResponse: unknown | null;
  expect: GoldenExpectation;
};

export function loadGoldenSet(): GoldenCase[] {
  return readdirSync(NARRATIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => JSON.parse(readFileSync(join(NARRATIONS_DIR, f), "utf8")) as GoldenCase);
}

/** Cases a provider is actually called for. The refusals never reach one. */
export const answerableCases = (cases: readonly GoldenCase[]): GoldenCase[] =>
  cases.filter(c => c.modelResponse !== null);

/** Fixtures for `MockLlmProvider`, one per answerable case. */
export const mockFixturesFrom = (cases: readonly GoldenCase[]) =>
  answerableCases(cases).map(c => ({
    transcript: c.transcript,
    response: JSON.stringify(c.modelResponse),
  }));
