/**
 * `pnpm eval:secretary` — the golden set against a real model.
 *
 * Run by a developer against whatever is on the other end of `LLM_BASE_URL`:
 * llama.cpp on a laptop, the in-cab box, the company cloud. Never run by CI,
 * which has no model and must make no network call — so this refuses to start
 * without configuration rather than falling back to anything.
 *
 * What it prints is what the checkpoint asks to be tracked: per-field accuracy
 * and the silent-guess count. The second is the one with a hard floor.
 *
 *     LLM_BASE_URL=http://127.0.0.1:8080/v1 LLM_MODEL=gemma-4-e4b-it pnpm eval:secretary
 */

import { OpenAiCompatibleProvider } from "../llm/openAiCompatibleProvider";
import { llmConfigured } from "../llm/config";
import { loadGoldenSet } from "./goldenSet";
import { scoreCase } from "./scoreCase";

async function main(): Promise<void> {
  if (!llmConfigured()) {
    console.error(
      "eval:secretary needs LLM_BASE_URL and LLM_MODEL. There is no default endpoint."
    );
    process.exit(2);
  }

  const provider = OpenAiCompatibleProvider.fromEnv();
  const cases = loadGoldenSet();

  let fieldsCorrect = 0;
  let fieldsChecked = 0;
  let silentGuesses = 0;
  let failed = 0;

  console.log(`golden set: ${cases.length} narrations against ${provider.modelId}\n`);

  for (const testCase of cases) {
    // Serial, not parallel. A phone-class model answering twelve narrations at
    // once is measuring contention, not accuracy, and the wall clock here is
    // not what anybody is optimising.
    const score = await scoreCase(testCase, provider);
    fieldsCorrect += score.fieldsCorrect;
    fieldsChecked += score.fieldsChecked;
    silentGuesses += score.unexpectedSilentGuesses;

    const ok = score.mismatches.length === 0 && score.unexpectedSilentGuesses === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${score.id}  ${score.fieldsCorrect}/${score.fieldsChecked}`);
    for (const m of score.mismatches) console.log(`       ${m}`);
  }

  const accuracy = fieldsChecked === 0 ? 0 : (fieldsCorrect / fieldsChecked) * 100;
  console.log(`\nfield accuracy: ${fieldsCorrect}/${fieldsChecked} (${accuracy.toFixed(1)}%)`);
  console.log(`silent guesses: ${silentGuesses} (must be 0)`);
  console.log(`cases failed:   ${failed}/${cases.length}`);

  // The silent-guess floor fails the run on its own, whatever the accuracy is.
  // A model that scores well and fabricates a quote is a model that has learned
  // to be convincing, which is the opposite of what is being measured.
  process.exit(silentGuesses > 0 || failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
