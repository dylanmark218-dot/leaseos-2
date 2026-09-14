/**
 * v22.20 — an engine nothing imports is a rule waiting to be written twice.
 *
 * This session found the same defect five times by hand: readyForTomorrow
 * beside shiftReadiness, two receipt vocabularies, two never-automatic floors,
 * four inline copies of the document-validity rule, and an overwritten
 * migration. Every one was two correct things that did not know about each
 * other, and every one was found by a person noticing.
 *
 * The mechanical signal is simple. A `_core` engine written as the canonical
 * answer, imported by its own test and by nothing else, is either not wired yet
 * or has been quietly reimplemented somewhere. Both are worth knowing; only one
 * is a bug. So the position is declared rather than discovered: an engine is
 * either reached by production code, or named below with the reason.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Engines deliberately not reached from production yet.
 *
 * Being on this list is a claim: "this is built and not wired, on purpose."
 * Removing an engine from the list without wiring it fails the gate, and so
 * does wiring one without removing it — which keeps the list honest in both
 * directions.
 */
const DECLARED_UNWIRED: Record<string, string> = {
  offlineCapability: "offline capability classes for the field device; no device runtime calls them yet",
  modelGateway: "model routing and licence gate; no AI provider is configured yet",
  dashboardWidget: "widget contract; no dashboard surface consumes it yet",
  financialCalendar: "AP/AR and company-event projections; no financial surface yet",
  openShifts: "eligibility engine; openShiftsRouter currently decides inline — a live duplication, not a gap",
  billing: "billing engine predates this audit; reachability not yet established",
  advisoryImpact: "road-advisory placement; feed scheduler is not started",
  drainWorker: "outbox drain; startOnce is not called from an entry point",
  eventEmitter: "event vocabulary; emitters write via raw SQL",
  externalDataRegistry: "external source registry; no feed is cleared",
  externalSourceSeeds: "no application path reaches this engine",
  feedCollector: "feed quota and clearance gates; scheduler not started",
  feedIngest: "feed ingestion lifecycle; scheduler not started",
  oauth: "no application path reaches this engine",
  storageProxy: "no application path reaches this engine",
  vite: "no application path reaches this engine",
  workflowEngine: "no application path reaches this engine",
  workflowSeeds: "no application path reaches this engine",
  billingAdjustment: "adjustment rules; same unestablished reachability as billing",
  dataApi: "shape declarations only",
  dataIngestion: "import path not wired",
  dispatchMatching: "matching engine; dispatch surface uses its own path",
  disposalReconciliation: "reconciliation engine; no procedure calls it",
  domainEmitters: "event vocabulary; emitted from raw SQL paths",
  feedHttp: "HTTP edge; scheduler not started in production",
  feedScheduler: "backoff scheduler; nothing starts it from an entry point",
  fieldTicket: "ticket engine; router path predates it",
  heartbeat: "liveness helper; no monitor calls it",
  imageGeneration: "unused capability",
  index: "barrel file, re-exports only",
  jurisdiction: "profile lookup; callers use their own",
  map: "map geometry helpers; callers use the routing adapter path instead",
  remoteWorkEvidence: "evidence helper",
  tracking: "tracking-number format; generators inline",
  truckRoutingAdapter: "routing adapter; no live feed",
  voiceTranscription: "transcription edge; no device path",
  workerLifecycle: "worker lifecycle; startOnce not called from an entry point",
  workflowRuntime: "runtime writes via raw SQL rather than importing itself",
};

function coreEngines(): string[] {
  return readdirSync("server/_core")
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map(f => f.slice(0, -3));
}

function productionSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      out[p] = readFileSync(p, "utf8");
    }
  };
  walk("server");
  return out;
}

/**
 * Reached means reached from the application, following imports through.
 *
 * Two earlier versions of this were each wrong in one direction. Counting any
 * production importer let two engines cite each other and both look wired while
 * nothing used either. Requiring a direct importer outside the engine layer
 * called 53 engines unreached, including ones a router genuinely depends on
 * through one hop — `documentValidity` is used by `qualificationValidity`,
 * which routers call, and that is a real chain rather than a gap.
 *
 * So: walk the import graph from every production file outside `_core`, and an
 * engine is reached if that walk arrives at it.
 */
function reachableSet(srcs: Record<string, string>): Set<string> {
  const importsOf = (body: string): string[] =>
    Array.from(body.matchAll(/from\s+"(?:[./]*)(?:_core\/)?([A-Za-z0-9_]+)"/g)).map(m => m[1]);

  const reached = new Set<string>();
  const queue: string[] = [];
  for (const [path, body] of Object.entries(srcs)) {
    if (path.includes("_core/")) continue;
    for (const mod of importsOf(body)) queue.push(mod);
  }
  while (queue.length) {
    const mod = queue.pop()!;
    if (reached.has(mod)) continue;
    reached.add(mod);
    const body = srcs[`server/_core/${mod}.ts`];
    if (body) for (const next of importsOf(body)) queue.push(next);
  }
  return reached;
}

describe("every engine is reached, or says why not", () => {
  const engines = coreEngines();
  const srcs = productionSources();
  const reached = reachableSet(srcs);
  const isReached = (mod: string) => reached.has(mod);

  it("has no engine that is unreached and undeclared", () => {
    const surprises = engines.filter(m => !isReached(m) && !(m in DECLARED_UNWIRED));
    // A new engine nobody wired is the moment to notice, not three
    // checkpoints later when somebody has rewritten its rule inline.
    expect(surprises).toEqual([]);
  });

  it("has no engine declared unwired that is actually wired", () => {
    const stale = Object.keys(DECLARED_UNWIRED).filter(m => isReached(m));
    // Leaving it listed after wiring it makes the list decorative.
    expect(stale).toEqual([]);
  });

  it("gives every declared engine a reason rather than a bare name", () => {
    for (const [mod, reason] of Object.entries(DECLARED_UNWIRED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(engines).toContain(mod);
    }
  });

  it("keeps the count visible, so the gap cannot grow quietly", () => {
    const unwired = engines.filter(m => !isReached(m));
    // Moving this number is a deliberate act either way.
    expect(unwired).toHaveLength(38);
    expect(engines.length).toBeGreaterThan(130);
  });
});
