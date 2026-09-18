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
  demoDataset: "the demonstration dataset's rules and step shape; reached from server/demoDataset.db.test.ts and scripts/demo-dataset.ts (the demo path), not from a router — a router that could seed demonstration rows into a customer's database is not something to build",
  // B28 widget engine (v22.23): the v1 service (widgetService/widgetDashboard/widgetLayoutWrite/
  // widgetRegistry/widgetPayload/roleActor) is reached through widgetsRouter. The layer below is
  // the promotion gate and the client's rendering semantics — read by tests and by
  // client/src/widgets, not by any server procedure. Wiring it server-side is B28 step 6+.
  boardSemantics: "board-level semantics (tone, ordering); consumed by the client and the promotion-gate tests",
  deviceManifest: "device-class manifest for the client; no server procedure reads it",
  hosClockPresentation: "HOS clock presentation for the hosRemaining tile; hosRemaining is not promoted yet (P0.5 step 6)",
  widgetProjection: "per-widget value projection for the client renderer; not read server-side",
  widgetRegistryV2: "the promotion-gate registry (source tiers); promotionGate.test is not yet ported",
  widgetSemantics: "per-widget semantics (variants, subjects); consumed by the client and tests",
  widgetSourceContract: "the twelve-source contract; enforced by widgetSourceContract.test, not by a procedure",
  migrationLedger: "the production migration ledger; reached from scripts/migrate.ts (the deploy path), not from a router — declared by the session that reconciled 5f3bef4",
  offlineCapability: "offline capability classes for the field device; no device runtime calls them yet",
  modelGateway: "model routing and licence gate; no AI provider is configured yet",
  dashboardWidget: "widget contract; no dashboard surface consumes it yet",
  financialCalendar: "AP/AR and company-event projections; no financial surface yet",
  openShifts: "eligibility engine; openShiftsRouter currently decides inline — a live duplication, not a gap",
  billing: "billing engine predates this audit; reachability not yet established",
  advisoryImpact: "road-advisory placement; feed scheduler is not started",
  eventEmitter: "event vocabulary; emitters write via raw SQL",
  externalDataRegistry: "external source registry; no feed is cleared",
  externalSourceSeeds: "no application path reaches this engine",
  feedCollector: "feed quota and clearance gates; scheduler not started",
  feedIngest: "feed ingestion lifecycle; scheduler not started",
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
  jurisdiction: "profile lookup; callers use their own",
  map: "map geometry helpers; callers use the routing adapter path instead",
  loadSenseMaterialMovement: "recovered LoadSense manifest/billing projection; persistence is present but no device ingestion path calls it yet",
  loadSenseEvents: "recovered LoadSense event vocabulary; device ingestion does not emit it yet",
  remoteWorkEvidence: "evidence helper",
  tracking: "tracking-number format; generators inline",
  truckRoutingAdapter: "routing adapter; no live feed",
  voiceTranscription: "transcription edge; no device path",
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
  const coreEntrypoints = new Set(["server/_core/index.ts", "server/_core/worker.ts"]);
  for (const [path, body] of Object.entries(srcs)) {
    if (path.includes("_core/") && !coreEntrypoints.has(path)) continue;
    if (coreEntrypoints.has(path)) reached.add(path.split("/").pop()!.replace(/\.ts$/, ""));
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
    expect(unwired).toHaveLength(40);   // v22.58: +1 demoDataset (reached from the demo path, declared above);   // v22.35: +1 migrationLedger (reached from scripts/migrate.ts, declared above);   // v22.23: +7 B28 semantics/promotion-gate modules, declared above; the sheet-serial modules are wired through academy.sheetPrintRun/sheetScanFile through trainingAcademyRouter (0123/0122)   // v22.21: loadSense wired through integrationRouter; one further engine reached by the recovered knowledge tranche
    expect(engines.length).toBeGreaterThan(130);
  });
});
