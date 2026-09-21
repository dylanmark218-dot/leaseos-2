/**
 * Where a model call is allowed to happen, proved by reading the source.
 *
 * The rule — LLM calls run in the worker behind the transactional outbox,
 * never inside a request handler — is the kind that holds for a year and then
 * quietly stops when somebody adds an `await extract(...)` to a router because
 * it was the shortest path to a demo. A structural guard catches that at the
 * import, which is the only place it is cheap to catch.
 *
 * Same technique as `server/knowledgeWritePaths.test.ts`, and the same caveat:
 * this proves no router reaches the layer, not that the worker is wired to it.
 * Wiring the job into `productionWorker.ts` is the next checkpoint's work, and
 * the last test here records that honestly rather than implying otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRETARY_EXTRACTION_EVENT } from "./worker/secretaryExtractionJob";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() && e.name !== "node_modules"
      ? walk(`${dir}/${e.name}`)
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
        ? [`${dir}/${e.name}`]
        : []
  );

/** Every router in the tree, enumerated from disk rather than from a list. */
const routers = walk("server").filter(p => /Router\.ts$|\/routers\.ts$/.test(p));

describe("no request handler reaches the model layer", () => {
  it("found routers to check, so a pass is not vacuous", () => {
    expect(routers.length).toBeGreaterThan(20);
  });

  it("imports nothing from server/ai into any router", () => {
    const offenders = routers.filter(path =>
      /from\s+["'][^"']*\/ai\/(llm|extraction|worker)\//.test(readFileSync(path, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("calls no provider from any router", () => {
    const offenders = routers.filter(path =>
      /\b(runExtraction|OpenAiCompatibleProvider|runSecretaryExtractionJob)\b/.test(
        readFileSync(path, "utf8")
      )
    );
    expect(offenders).toEqual([]);
  });
});

describe("the job body", () => {
  it("opens no socket of its own — the provider is injected", () => {
    const source = readFileSync("server/ai/worker/secretaryExtractionJob.ts", "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|new OpenAiCompatibleProvider|fromEnv\(/);
  });

  it("writes nothing — the worker that owns the transaction does that", () => {
    const source = readFileSync("server/ai/worker/secretaryExtractionJob.ts", "utf8");
    expect(source).not.toMatch(/getDb|drizzle\/schema|\.insert\(|\.update\(/);
  });

  it("claims exactly one event type, so a filter can be exact", () => {
    expect(SECRETARY_EXTRACTION_EVENT).toBe("secretary.narration.captured");
  });
});

describe("the rule is already broken next door, and this says so", () => {
  /**
   * `server/routers.ts` calls `invokeLLM` inside the `assistant.draft`
   * mutation. That is a model call inside a request handler — the thing the
   * house rule forbids — and it is **pre-existing**, in the live path, written
   * before this layer existed.
   *
   * It is pinned rather than fixed. Fixing it means `assistant.draft` stops
   * answering synchronously and starts returning a queued job, which changes
   * what the app does in front of a driver. That is a product decision and an
   * owner's call, not something to slip into a checkpoint that was asked to add
   * a model layer.
   *
   * What is not acceptable is the alternative: a boundary test that passes
   * because it only looks at the new code, while the violation it exists to
   * prevent sits in the file next to it. The count is pinned at one. A second
   * call site fails this, and removing the first one fails it too — at which
   * point this test is what tells whoever fixed it to delete the pin.
   */
  const PRE_EXISTING_LLM_CALLS_IN_HANDLERS = 1;

  it("has exactly one pre-existing model call inside a request handler", () => {
    const routers = readFileSync("server/routers.ts", "utf8");
    const calls = routers.match(/\bawait invokeLLM\s*\(/g) ?? [];
    expect(
      calls.length,
      calls.length > PRE_EXISTING_LLM_CALLS_IN_HANDLERS
        ? "a new model call was added inside a request handler — it belongs in the worker"
        : "the pre-existing call in assistant.draft is gone; delete this pin",
    ).toBe(PRE_EXISTING_LLM_CALLS_IN_HANDLERS);
  });

  it("has none anywhere else in the server tree", () => {
    const offenders = walk("server")
      .filter(p => p !== "server/_core/llm.ts" && p !== "server/routers.ts")
      .filter(p => /\binvokeLLM\s*\(/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is not the door this layer uses — nothing under server/ai imports it", () => {
    // Imports, not prose. Several files here name `server/_core/llm.ts` in a
    // doc comment explaining why they are a separate door, and a guard that
    // cannot tell a citation from an import fails on its own documentation.
    const offenders = walk("server/ai").filter(p => {
      const code = readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return /from\s+["'][^"']*_core\/llm["']|\binvokeLLM\s*\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

describe("what is not wired yet", () => {
  it("is not yet dispatched by the production worker, and this records that", () => {
    // Stated rather than implied. The job body, its contract and its guards are
    // complete and reachable by test; the dispatch line in productionWorker.ts
    // belongs with the capture surface that emits the event, and neither exists
    // yet. A guard that asserted the wiring existed would be asserting a
    // fiction; a guard that said nothing would let the gap go unrecorded.
    const worker = readFileSync("server/_core/productionWorker.ts", "utf8");
    expect(worker).not.toContain(SECRETARY_EXTRACTION_EVENT);
  });
});
