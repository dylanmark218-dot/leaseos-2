/**
 * Score one golden case. Shared by the CI suite and the live eval script, so
 * the number a developer sees against a real model and the number CI enforces
 * against the mock are produced by the same code.
 *
 * Nothing here is a threshold. Thresholds belong to the caller: the vitest
 * suite demands exact agreement because it runs against fixtures whose answers
 * are known, and `eval:secretary` reports percentages because a real model will
 * not be perfect and the interesting number is which direction it moved.
 */

import { runExtraction } from "../extraction/runExtraction";
import { buildContextPack } from "../context/contextPack";
import { FORMS } from "../../aiProposal";
import { toProposal, advanceBlockedBecause } from "../proposal/bridge";
import { questionFor } from "../validate/questions";
import type { LlmProvider } from "../llm/provider";
import type { GoldenCase } from "./goldenSet";

export type CaseScore = {
  id: string;
  /** Fields whose verdict matched the expectation. */
  fieldsCorrect: number;
  fieldsChecked: number;
  /**
   * `stated` fields with a quote that is not in the transcript, MINUS the ones
   * this case deliberately contains. Must be zero.
   */
  unexpectedSilentGuesses: number;
  /** Everything that did not match, in words a person can act on. */
  mismatches: string[];
};

export async function scoreCase(
  testCase: GoldenCase,
  provider: LlmProvider
): Promise<CaseScore> {
  const mismatches: string[] = [];
  const formKey = testCase.formKey ?? testCase.context.formKey;
  const form = FORMS[formKey];
  if (!form) {
    return {
      id: testCase.id,
      fieldsCorrect: 0,
      fieldsChecked: 0,
      unexpectedSilentGuesses: 0,
      mismatches: [`no form named ${formKey}`],
    };
  }

  const pack = buildContextPack(testCase.context);
  const outcome = await runExtraction({
    provider,
    form,
    transcript: testCase.transcript,
    pack,
  });

  if (outcome.kind === "refused") {
    if (!testCase.expect.refused) {
      mismatches.push(`refused (${outcome.reason}) but the case expected an extraction`);
    } else if (
      testCase.expect.refusalReason &&
      testCase.expect.refusalReason !== outcome.reason
    ) {
      mismatches.push(
        `refused for ${outcome.reason}, expected ${testCase.expect.refusalReason}`
      );
    }
    return {
      id: testCase.id,
      fieldsCorrect: 0,
      fieldsChecked: 0,
      unexpectedSilentGuesses: 0,
      mismatches,
    };
  }

  if (testCase.expect.refused) {
    mismatches.push("extracted, but the case expected a refusal");
  }

  const { validation, injection, envelope, run } = outcome;
  const byKey = new Map(validation.fields.map(f => [f.key, f]));

  let fieldsCorrect = 0;
  let fieldsChecked = 0;

  for (const [key, expected] of Object.entries(testCase.expect.verdicts ?? {})) {
    fieldsChecked += 1;
    const actual = byKey.get(key);
    if (!actual) {
      mismatches.push(`${key}: no verdict produced`);
      continue;
    }
    if (actual.verdict === expected) {
      fieldsCorrect += 1;
    } else {
      mismatches.push(
        `${key}: ${actual.verdict}, expected ${expected}` +
          (actual.reasonCodes.length > 0 ? ` (${actual.reasonCodes.join(", ")})` : "")
      );
    }
  }

  for (const [key, codes] of Object.entries(testCase.expect.reasonCodes ?? {})) {
    const actual = byKey.get(key);
    for (const code of codes) {
      if (!actual?.reasonCodes.includes(code)) {
        mismatches.push(
          `${key}: expected reason ${code}, got ${actual?.reasonCodes.join(", ") || "none"}`
        );
      }
    }
  }

  for (const [key, value] of Object.entries(testCase.expect.normalizedValues ?? {})) {
    const actual = byKey.get(key);
    if (actual?.normalizedValue !== value) {
      mismatches.push(
        `${key}: normalized to ${JSON.stringify(actual?.normalizedValue)}, expected ${JSON.stringify(value)}`
      );
    }
  }

  if (testCase.expect.question !== undefined) {
    const first = validation.needsClarification[0];
    const asked = first ? questionFor(first) : null;
    if (asked !== testCase.expect.question) {
      mismatches.push(`asked ${JSON.stringify(asked)}, expected ${JSON.stringify(testCase.expect.question)}`);
    }
  }

  const silent = validation.silentGuessKeys.length;
  const unexpectedSilentGuesses = Math.max(0, silent - testCase.expect.silentGuesses);
  if (silent < testCase.expect.silentGuesses) {
    // The tripwire stopped firing on a case built to trip it, which is a worse
    // failure than a new guess: it means the check is broken, silently.
    mismatches.push(
      `expected ${testCase.expect.silentGuesses} silent guess(es), found ${silent} — the quote check may have stopped working`
    );
  }

  if (injection.suspected !== testCase.expect.injectionSuspected) {
    mismatches.push(
      `injectionSuspected ${injection.suspected}, expected ${testCase.expect.injectionSuspected}`
    );
  }
  for (const code of testCase.expect.injectionCodes ?? []) {
    if (!injection.findings.some(f => f.code === code)) {
      mismatches.push(`expected injection code ${code}`);
    }
  }

  if (testCase.expect.heldBecause) {
    const proposal = toProposal({
      form,
      targetRef: "EVAL",
      transcript: testCase.transcript,
      envelope,
      validation,
      run,
      injection,
    });
    const held = advanceBlockedBecause(proposal);
    if (!held || !held.startsWith(testCase.expect.heldBecause)) {
      mismatches.push(
        `expected the proposal held for ${testCase.expect.heldBecause}, got ${held ?? "nothing"}`
      );
    }
  }

  return { id: testCase.id, fieldsCorrect, fieldsChecked, unexpectedSilentGuesses, mismatches };
}
