/**
 * The provider that talks to a real server: llama.cpp's server, Ollama or vLLM.
 *
 * All three expose `/chat/completions` with the same request shape, which is
 * why the tier table in the plan — phone, in-cab box, company cloud — is a
 * configuration change rather than three integrations. The differences that do
 * exist are in what they support, not in how they are addressed:
 *
 *   `response_format: { type: "json_schema" }` is honoured by llama.cpp's
 *   server (it converts the schema to a GBNF grammar, so the model physically
 *   cannot emit anything else) and by vLLM's guided decoding. A server that
 *   ignores it returns prose, and `parseExtractionResponse` fails closed on
 *   that rather than salvaging what it can.
 *
 * No retries here. `server/_core/llm.ts` retries because it fronts a shared
 * hosted endpoint that rate-limits; this runs on the worker behind the
 * transactional outbox, which already has claim leases, attempt counts and
 * dead-lettering. A second retry loop inside a job that is itself retried is
 * how one narration becomes forty model calls.
 */

import { llmConfig } from "./config";
import {
  LlmNotConfigured,
  LlmTransportError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./provider";

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  /** Injected in tests. Production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly providerKey = "openai-compatible";
  readonly modelId: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions) {
    if (!options.baseUrl) {
      throw new LlmNotConfigured("LLM_BASE_URL is not set");
    }
    if (!options.model) {
      throw new LlmNotConfigured("LLM_MODEL is not set");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.modelId = options.model;
    this.apiKey = options.apiKey ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Build from the environment. Throws rather than falling back to a public
   * host, so an unconfigured deployment fails visibly at the first narration
   * instead of quietly sending a driver's words somewhere nobody chose.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof fetch
  ): OpenAiCompatibleProvider {
    const c = llmConfig(env);
    if (!c.baseUrl || !c.model) {
      throw new LlmNotConfigured(
        "LLM_BASE_URL and LLM_MODEL must both be set; there is no default model endpoint"
      );
    }
    return new OpenAiCompatibleProvider({
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: c.apiKey,
      fetchImpl,
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.modelId,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      // Extraction is not a creative task. A non-zero temperature here buys
      // variation in a job whose whole contract is that the same words produce
      // the same form.
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 2048,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: true,
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new LlmTransportError(
        `LLM request to ${this.baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmTransportError(
        `LLM request to ${this.baseUrl} returned ${response.status}: ${detail.slice(0, 300)}`
      );
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new LlmTransportError("LLM returned no message content");
    }

    return {
      text,
      // What actually answered, which a server may report differently from
      // what was asked for. The proposal records the answer, not the request.
      modelId: json.model ?? this.modelId,
      usage:
        json.usage &&
        typeof json.usage.prompt_tokens === "number" &&
        typeof json.usage.completion_tokens === "number"
          ? {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
            }
          : undefined,
    };
  }
}
