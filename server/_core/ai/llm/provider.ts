/**
 * The model boundary. One interface, and nothing above it names a model.
 *
 * `server/_core/llm.ts` already talks to a model, but it talks to exactly one:
 * the base URL defaults to a hard-coded vendor host and the key comes from
 * `BUILT_IN_FORGE_API_KEY`. That is fine for the surfaces already built on it
 * and wrong for the Secretary, which has to run on a phone with no signal, on
 * an in-cab box, and on the company's own cloud, with the choice being a
 * config line rather than a rewrite. So this is a second, narrower door:
 * request in, text out, no vendor anywhere in the type.
 *
 * Three rules the interface exists to enforce.
 *
 * **A provider is configuration.** `LLM_BASE_URL`, `LLM_MODEL` and the optional
 * `LLM_API_KEY` are read at call time, never baked in. llama.cpp's server,
 * Ollama and vLLM all speak the same chat-completions shape, so swapping which
 * one answers is an environment change.
 *
 * **The model's own confidence is not evidence.** Nothing here returns a score
 * the caller is invited to threshold on. What comes back is text the caller
 * must parse and then prove against the transcript; `server/ai/validate` does
 * the proving. A provider that offered a trustworthy-looking number would
 * invite somebody to trust it.
 *
 * **CI never reaches a network.** `MockLlmProvider` is the only provider the
 * test suite constructs, and `OpenAiCompatibleProvider` throws rather than
 * defaulting to a public host when `LLM_BASE_URL` is unset. An accidental
 * network call in CI is a test that passes for a reason nobody chose.
 */

/** A chat turn. Deliberately smaller than the OpenAI shape — no tools, no images. */
export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

/**
 * What the caller wants back. `jsonSchema` is the constraint lever: a server
 * that supports structured output will not emit anything outside this shape,
 * which is the difference between parsing a model's JSON and hoping for it.
 */
export type LlmRequest = {
  messages: LlmMessage[];
  /** JSON Schema the response must satisfy. Named so a server can cache it. */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  /** Zero unless a caller has a reason. Extraction has no reason. */
  temperature?: number;
};

export type LlmResponse = {
  /** Raw text. Still untrusted, still unparsed, still unproven. */
  text: string;
  /** What actually answered, recorded on every proposal. */
  modelId: string;
  /** Present when the provider reports it. Absent is not zero. */
  usage?: { promptTokens: number; completionTokens: number };
};

export interface LlmProvider {
  /** Stable identifier for logs and proposals: "mock", "openai-compatible". */
  readonly providerKey: string;
  /** The model as deployed, so a proposal can say what answered. */
  readonly modelId: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Thrown when configuration is missing. Never a silent fallback to a default host. */
export class LlmNotConfigured extends Error {}

/** Thrown when a provider answered, but not with anything usable. */
export class LlmTransportError extends Error {}
