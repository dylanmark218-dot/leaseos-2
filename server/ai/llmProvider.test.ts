/**
 * The provider layer: configuration is configuration, and CI reaches no network.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { llmConfig, llmConfigured } from "./llm/config";
import { LlmNotConfigured, LlmTransportError } from "./llm/provider";
import { MockLlmProvider, MockResponseMissing } from "./llm/mockProvider";
import { OpenAiCompatibleProvider } from "./llm/openAiCompatibleProvider";
import { fence } from "./injection/guard";

const schema = { name: "t", schema: { type: "object" } };
const ask = (transcript: string) => ({
  messages: [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: fence(transcript) },
  ],
  jsonSchema: schema,
});

describe("configuration", () => {
  it("reads the three names and nothing else", () => {
    expect(
      llmConfig({
        LLM_BASE_URL: "http://box.local:8080/v1",
        LLM_MODEL: "gemma-4-e4b-it",
        LLM_API_KEY: "  ",
      })
    ).toEqual({ baseUrl: "http://box.local:8080/v1", model: "gemma-4-e4b-it", apiKey: null });
  });

  it("treats an empty variable as unset, not as an empty value", () => {
    expect(llmConfig({ LLM_BASE_URL: "   ", LLM_MODEL: "" })).toEqual({
      baseUrl: null,
      model: null,
      apiKey: null,
    });
    expect(llmConfigured({ LLM_BASE_URL: "   ", LLM_MODEL: "" })).toBe(false);
  });

  it("has no default endpoint, so an unconfigured build refuses rather than dialling one", () => {
    expect(() => OpenAiCompatibleProvider.fromEnv({})).toThrow(LlmNotConfigured);
    expect(() => OpenAiCompatibleProvider.fromEnv({ LLM_BASE_URL: "http://x/v1" })).toThrow(
      LlmNotConfigured
    );
  });

  it("names no vendor host anywhere in the provider layer", () => {
    // The point of this layer is that swapping models is configuration. A host
    // in the source is a host somebody has to find and edit.
    const sources = [
      "server/ai/llm/config.ts",
      "server/ai/llm/provider.ts",
      "server/ai/llm/openAiCompatibleProvider.ts",
    ];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      // Only the documented local examples may appear.
      const hosts = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      const foreign = hosts.filter(h => !/127\.0\.0\.1|localhost|box\.local/.test(h));
      expect(foreign, `${path} names ${foreign.join(", ")}`).toEqual([]);
    }
  });
});

describe("the mock provider", () => {
  it("answers by transcript, not by call order", async () => {
    const provider = new MockLlmProvider([
      { transcript: "one", response: '{"a":1}' },
      { transcript: "two", response: '{"a":2}' },
    ]);

    const second = await provider.complete(ask("two"));
    const first = await provider.complete(ask("one"));

    expect(second.text).toBe('{"a":2}');
    expect(first.text).toBe('{"a":1}');
  });

  it("throws on an unregistered transcript rather than inventing an answer", async () => {
    const provider = new MockLlmProvider([{ transcript: "one", response: "{}" }]);
    await expect(provider.complete(ask("three"))).rejects.toBeInstanceOf(MockResponseMissing);
  });

  it("refuses two fixtures for the same transcript", () => {
    expect(
      () =>
        new MockLlmProvider([
          { transcript: "one", response: "{}" },
          { transcript: "one", response: "{}" },
        ])
    ).toThrow(MockResponseMissing);
  });

  it("records what the prompt actually said, so a test can assert on it", async () => {
    const provider = new MockLlmProvider([{ transcript: "hello", response: "{}" }]);
    await provider.complete(ask("hello"));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages[0].role).toBe("system");
  });
});

describe("the OpenAI-compatible provider", () => {
  const build = (fetchImpl: typeof fetch) =>
    new OpenAiCompatibleProvider({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "gemma-4-e4b-it",
      fetchImpl,
    });

  it("sends the JSON schema as a constraint, at temperature zero", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ model: "gemma-4-e4b-it", choices: [{ message: { content: "{}" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await build(fetchImpl).complete(ask("hello"));

    expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "t", schema: { type: "object" }, strict: true },
    });
  });

  it("sends no authorization header when no key is configured", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await build(fetchImpl).complete(ask("hello"));
    expect(Object.keys(headers)).not.toContain("authorization");
  });

  it("reports the model that answered, not the one that was asked for", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ model: "gemma-4-e2b-it", choices: [{ message: { content: "{}" } }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await build(fetchImpl).complete(ask("hello"));
    expect(result.modelId).toBe("gemma-4-e2b-it");
  });

  it("fails rather than salvaging an empty completion", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(build(fetchImpl).complete(ask("hello"))).rejects.toBeInstanceOf(
      LlmTransportError
    );
  });

  it("does not retry — the outbox owns retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;
    await expect(build(fetchImpl).complete(ask("hello"))).rejects.toBeInstanceOf(
      LlmTransportError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
