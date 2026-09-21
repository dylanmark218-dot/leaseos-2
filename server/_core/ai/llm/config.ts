/**
 * Where the model lives, read from the environment and nowhere else.
 *
 * The three names are the ones every OpenAI-compatible server already
 * documents, so pointing LeaseOS at llama.cpp, Ollama or vLLM is one line in a
 * deployment file rather than a code change:
 *
 *     LLM_BASE_URL=http://127.0.0.1:8080/v1
 *     LLM_MODEL=gemma-4-e4b-it
 *     LLM_API_KEY=            # optional; local servers usually want none
 *
 * `llmConfig()` reads `process.env` on every call rather than snapshotting it
 * at import. That is deliberate: `server/_core/env.ts` snapshots, and a test
 * that wants to prove the unconfigured case has to be able to set and unset
 * these without reloading a module graph.
 *
 * There is no default base URL. An unset `LLM_BASE_URL` is a configuration
 * that has not been made, and the provider says so — it does not quietly
 * reach a vendor host somebody did not choose and cannot see in a config file.
 */

export type LlmConfig = {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
};

const trimmed = (value: string | undefined): string | null => {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
};

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    baseUrl: trimmed(env.LLM_BASE_URL),
    model: trimmed(env.LLM_MODEL),
    apiKey: trimmed(env.LLM_API_KEY),
  };
}

/** True when a real provider could be built. CI leaves this false. */
export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const c = llmConfig(env);
  return c.baseUrl !== null && c.model !== null;
}
