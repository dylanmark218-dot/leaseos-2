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
