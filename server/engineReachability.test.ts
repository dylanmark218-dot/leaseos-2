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
  /* ----------------------------------------------------------------------
   * The AI Secretary model layer — 21 modules, every one unwired on purpose.
   *
   * These landed as `server/ai/`, OUTSIDE this census, and were moved under
   * `_core/` for exactly the reason the `coreEngines` header gives about
   * `server/_core/knowledge/`: a guard against unwired engines that cannot see
   * a directory reports health about a subsystem it has never looked at. Twenty
   * one modules were in that position. Being outside `_core` was not a
   * permission to skip the declaration; it was the declaration going unasked.
   *
   * They stay unwired because `docs/register/SPINE_WIRING_PLAN.md:3` says so:
   * "no new engines until this path is wired". All 13 spine engines are still
   * on this list, so the moratorium is fully in force, and the plan places the
   * AI-adjacent engines (`modelGateway`, `voiceTranscription`) off the spine in
   * "later phases" (line 40). Wiring these ahead of the spine is the thing the
   * moratorium exists to prevent.
   * -------------------------------------------------------------------- */
  "ai/llm/provider": "the model boundary — the LlmProvider interface. Unwired under the SPINE moratorium",
  "ai/llm/config": "LLM_BASE_URL/LLM_MODEL/LLM_API_KEY, read at call time. No default endpoint, so an unconfigured deployment fails closed rather than reaching a vendor nobody chose",
  "ai/llm/mockProvider": "deterministic fixtures; the only provider the test suite constructs, which is what keeps CI off the network",
  "ai/llm/openAiCompatibleProvider": "llama.cpp / Ollama / vLLM over chat-completions. Unwired: nothing may call a model until the spine is wired",
  "ai/prompts/index": "versioned prompt loader and the run fingerprint (model, prompt version, prompt hash, input hash)",
  "ai/extraction/contract": "ExtractedField — value, status, evidenceQuote, evidenceRef. A wire contract, not a second stored shape",
  "ai/extraction/formSchema": "FORMS -> zod -> JSON Schema. Derived twice from one source so no hand-written parallel schema exists",
  "ai/extraction/runExtraction": "perimeter -> fence -> prompt -> provider -> parse -> scan -> validate. Calls a model, so it stays unwired under the moratorium",
  "ai/context/contextPack": "the projection a model is handed. Imports nothing at all, which is what lets contextPerimeter.test prove it cannot reach the restricted vault or a medical record",
  "ai/validate/normalizers": "volume, times, legal land, ticket numbers. Deterministic; the reasoning the prompt forbids the model from doing",
  "ai/validate/validator": "the judge — the verbatim-quote tripwire and the rule that a missing term never rounds up to PASS",
  "ai/validate/questions": "templated clarification questions, written by people and chosen by code",
  "ai/dialogue/machine": "the conversation as pure functions over a state value; one question per turn, three rounds, then a draft for the office",
  "ai/injection/guard": "fences untrusted text as data and scans it independently of what the model reported",
  "ai/proposal/bridge": "maps ExtractedField onto the ProposedField the database already holds, so there is one persisted shape and one provenance chain",
  "ai/tools/registry": "the agent's tool list. Every procedure is typed ProcedureName, so a made-up name does not compile",
  "ai/tools/caller": "the thin wrappers over a driver-scoped tRPC caller. createCaller is a required dependency, never an appRouter import, so the engine layer does not close a cycle back into the router layer",
  "ai/worker/secretaryExtractionJob": "the job body for one narration. Returns what should be written; the worker that owns claims and transactions would do the writing, and does not call this yet",
  "ai/eval/goldenSet": "the 12 golden narrations and their expectations",
  "ai/eval/scoreCase": "scores one case; shared by the CI suite and eval:secretary so both report the same number",
  "ai/eval/runEval": "pnpm eval:secretary against a real model. Refuses to start unconfigured; never run by CI",

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
  preDepartureCache: "P1.5 - what a job needs on the device before it leaves coverage, and whether what is there is still current. Not reached from a router yet: the procedure has to report what THIS device holds, and the device side of that (the cache index) is P1.1 work on hardware. Mounting a server-side guess about a device's contents would answer confidently about a machine it cannot see.",
  monitoringNotice: "P4.6 - whether a worker has been told what is collected about them. Not reached from a router yet, and deliberately not enforcing: whether unacknowledged monitoring should stop a dispatch is a decision with real operational teeth - a hard block would strand trucks over paperwork - and it belongs to the owner through the automation policy, not to a module that happens to know the answer. The procedures and the Exception Centre surfacing are the next step.",
  routeApprovalPolicy: "S10.4 - coverage as evidence, risk as the trigger. Not mounted: it needs the evaluator's per-check outcomes tagged with applicability (does this route actually cross that bridge), which is the importer's job in M2. Feeding it untagged checks would make every unknown high-consequence and demand a second signature for every route - the exact failure the percentage threshold was rejected for.",
  sourcePrecedence: "S10.3 - asymmetric precedence between road sources. Not mounted: the evaluator consumes segment attributes, and wiring this means deciding where a field observation enters that stream, which is M3's evidence compiler rather than a wiring choice.",
  phoneLocationGate: "S10.1 - whether LeaseOS may collect location from a driver's personal phone. Not mounted: there is no phone yet. The collector it governs is P1.1 device work, and a gate wired ahead of the thing it gates is a gate nothing passes through - it would report a decision about a collection that cannot happen, which is worse than reporting nothing.",
  osmImport: "M2 - an OSM way becomes a road edge or says why it did not. Pure and validated against all 734,600 Alberta highway ways; not mounted because the bulk loader that would call it is the rest of M2, and a conversion wired to nothing is easier to review than a half-written import job.",
  osmTopology: "M2 - where roads meet. Pure; validated on Alberta's 508,807 routable ways, 536,506 junctions and 883,380 edges. Not mounted for the same reason as osmImport: the bulk loader that would call it is the rest of M2.",
  osmLoadPlan: "M2 - reads an extraction and says what it refused. Pure; run end to end with osmImport and osmTopology over a real Edmonton slice (13,441 ways, 0 rejections, 29,369 edges). Not mounted: the procedure that would call it writes half a million rows, and that wants a database that is not dropped and rebuilt every gate run.",
  osmLoad: "M2 - an extract becomes a graph build. Pure by design: it returns a plan rather than writing one, because a road graph is worth counting and diffing against the build in use before it replaces it. Proven on 103,001 real Edmonton ways. The write step is the remaining piece and wants a database that is not dropped between gate runs.",
  migrationLedger: "the production migration ledger; reached from scripts/migrate.ts (the deploy path), not from a router — declared by the session that reconciled 5f3bef4",
  offlineCapability: "offline capability classes for the field device; no device runtime calls them yet",
  modelGateway: "model routing and licence gate; no AI provider is configured yet",
  dashboardWidget: "widget contract; no dashboard surface consumes it yet",
  financialCalendar: "AP/AR and company-event projections; no financial surface yet",
  openShifts: "eligibility engine; openShiftsRouter currently decides inline — a live duplication, not a gap",
  billing: "billing engine predates this audit; reachability not yet established",
  advisoryImpact: "road-advisory placement; feed scheduler is not started",
  eventEmitter: "event vocabulary; emitters write via raw SQL",
  feedCollector: "feed quota and clearance gates; scheduler not started",
  feedIngest: "feed ingestion lifecycle; scheduler not started",
  billingAdjustment: "adjustment rules; same unestablished reachability as billing",
  dataApi: "shape declarations only",
  dataIngestion: "import path not wired",
  dispatchMatching: "matching engine; dispatch surface uses its own path",
  disposalReconciliation: "reconciliation engine; no procedure calls it",
  domainEmitters: "event vocabulary; emitted from raw SQL paths",
  feedHttp: "HTTP edge; scheduler not started in production",
  // The Canadian 511 tranche (2026-09-24): per-province endpoints and parsers over the feed layer
  // above, declared for the same reason it is — nothing starts the scheduler that would call them.
  "transport/providerRegistry": "per-province endpoint, key location and parser over feedCollector/feedHttp/feedIngest; scheduler not started",
  "transport/ibi511": "the 511 platform parser shared by AB, ON, MB, NB, YT and NL; reached only through providerRegistry",
  "transport/drivebcOpen511": "DriveBC Open511 parser; reached only through providerRegistry",
  "transport/quebecRoadworks": "Québec MTMD roadworks parser; reached only through providerRegistry",
  "transport/placement": "publisher geometry to the point-and-radius advisoryImpact places; used only by the parsers above",
  "transport/fields": "date, severity and column-width coercions shared by the parsers above",
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
  /*
   * B23.0 trip-operations closeout: four pure engines, arriving with their tests and
   * nothing wired. The wiring is its own commit — schema, routers, authorization
   * inventory entries and tenant-scope coverage — and until it lands these are the
   * honest shape of "built, not reachable."
   */
  /*
   * server/_core/knowledge/ entered the census when `coreEngines` learned to
   * recurse. Six of its nine modules are reached — `promotionLedger`, `scopeGuard`
   * and `sourceGate` directly from routers, and three more through them. These
   * three are not, and each was checked rather than assumed: no production
   * importer, one test importer apiece.
   */
  "knowledge/evaluationState": "distinguishes the two silences for the knowledge evaluator; nothing downstream reads the distinction yet, which is what its own header says it was written to fix",
  "knowledge/perimeter": "the AI request perimeter and learning intake; assistantAskRouter gates through sourceGate, not through this, so the two-gate design is only half wired",
  "knowledge/repository": "declares itself the only way rows reach the knowledge corpus, and nothing calls it — knowledgeWritePaths.test.ts enforces that rule vacuously, since no write path exists at all yet",
  safetyBinder: "per-unit binder completeness and the office task queue; needs unitBinderSnapshots and safetyBinderRouter before anything reaches it",
  boundaryConfirmation: "SPINE item 1 — the one resolver of which tripStops timestamps a person stands behind, read from committed receipt manifests; pure. Its receipt reader cannot exist here until tripStops carries updatedAt (this repository has no trip-stop provenance migration), and siteBaseline has no router yet",
  boundaryEvidence: "SPINE item 1 — the chain rule over a stop's assistantCommitReceipts and the receipt reader over tripStops provenance (0179), the sibling repository's code unchanged; refuses a broken chain (edited after commit, another writer, broken seal, unreadable manifest) and reads the stop through orgScopeWhere(trips). Its caller is the stop-timing router, which is SPINE item 4 and does not exist yet",
  siteBaseline: "per-site median/MAD stop-duration baselines and the stop assessment; needs siteStopBaselines/siteStopAlerts and siteBaselineRouter before anything reaches it",
  tripBillingProjection: "turns a completed trip into ChargeLineSource[] for calculateChargeLines; belongs inside the existing billing path where evaluateBillingReadiness already runs, which is the wiring decision still open",
  tripPassportPackage: "assembles and staleness-checks the trip passport package; needs tripPassportPackages/tripPassportPackageItems and a decision on whether assembly runs on completion, on demand or in the worker",
};

/**
 * Every engine, named by its path under `_core` — `siteBaseline`, `knowledge/repository`.
 *
 * This used to be a flat `readdirSync`, which meant `server/_core/knowledge/` was
 * outside the census entirely: nine modules that could be neither reached nor
 * declared, three of them imported directly by routers and one whose own header
 * says it is "the only way rows reach the knowledge tables" while nothing calls
 * it. A guard against unwired engines that cannot see a directory reports health
 * about a subsystem it has never looked at.
 *
 * `.d.ts` is excluded: a declaration file is not an engine.
 */
function coreEngines(): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`)
        : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")
          ? [`${prefix}${e.name.slice(0, -3)}`] : []);
  return walk("server/_core", "");
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
/** Comments removed first: a documented import is not an import. */
const stripComments = (body: string) =>
  body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * Every engine this file depends on, named the way `coreEngines` names them.
 *
 * Three things this has to catch that the first version did not:
 *
 *   - `await import("./_core/x")`. `db.ts` loads `externalSourceSeeds` that way,
 *     and the module was declared unwired with the reason "no application path
 *     reaches this engine" — a declaration the code contradicted, invisible
 *     because the regex only matched `from`.
 *   - nested paths. `./_core/knowledge/promotionLedger` matched nothing at all,
 *     so a router's direct import of it counted for nothing.
 *   - a comment. See `stripComments`.
 *
 * `fromDir` resolves a sibling import inside `_core` — `./sourceGate` from
 * `knowledge/repository.ts` is `knowledge/sourceGate`, not `sourceGate`.
 */
function importsOfBody(body: string, fromDir = ""): string[] {
  const text = stripComments(body);
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(?:[./]*)_core\/([A-Za-z0-9_/]+)"/g)) out.push(m[1]);
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"\.\/([A-Za-z0-9_/]+)"/g)) {
    out.push(fromDir ? `${fromDir}${m[1]}` : m[1]);
  }
  return out;
}

function reachableSet(srcs: Record<string, string>): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  const coreEntrypoints = new Set(["server/_core/index.ts", "server/_core/worker.ts"]);
  for (const [path, body] of Object.entries(srcs)) {
    if (path.includes("_core/") && !coreEntrypoints.has(path)) continue;
    if (coreEntrypoints.has(path)) reached.add(path.split("/").pop()!.replace(/\.ts$/, ""));
    for (const mod of importsOfBody(body)) queue.push(mod);
  }
  while (queue.length) {
    const mod = queue.pop()!;
    if (reached.has(mod)) continue;
    reached.add(mod);
    const body = srcs[`server/_core/${mod}.ts`];
    const dir = mod.includes("/") ? `${mod.slice(0, mod.lastIndexOf("/"))}/` : "";
    if (body) for (const next of importsOfBody(body, dir)) queue.push(next);
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

  /*
   * A declaration promises future wiring. It is not evidence that the thing it
   * will wire into exists.
   *
   * `billing` is how that gap looked in practice: declared unwired with the
   * reason "reachability not yet established", and after the B23.0 merge its only
   * importer anywhere was `tripBillingProjection`, itself declared. Two modules
   * citing each other, both passing every check above, and the live invoicing
   * path a different stack entirely. The reachability walk cannot see this — both
   * are declared, so neither is ever a surprise — so it is checked separately.
   *
   * A cluster is a declared engine whose importers all exist and are all declared
   * too. Some are legitimate: a subsystem that lands as a unit imports itself
   * before anything imports it. The point is not that a cluster is a bug, it is
   * that a cluster is where this particular bug hides, so the set is pinned and
   * moving it is a deliberate act.
   */
  it("keeps mutual-unwired clusters visible", () => {
    // `importsOfBody` strips comments for both callers now: `voiceTranscription`'s
    // header shows its own import in an example, and a documented import is not one.
    const importers: Record<string, string[]> = {};
    for (const [path, body] of Object.entries(srcs)) {
      const rel = path.startsWith("server/_core/") ? path.slice("server/_core/".length, -3) : null;
      const mod = rel ?? path.split("/").pop()!.replace(/\.ts$/, "");
      const dir = rel && rel.includes("/") ? `${rel.slice(0, rel.lastIndexOf("/"))}/` : "";
      for (const dep of new Set(importsOfBody(body, dir))) {
        (importers[dep] ??= []).push(mod);
      }
    }

    const clusters = Object.keys(DECLARED_UNWIRED)
      .filter(mod => (importers[mod]?.length ?? 0) > 0)
      .filter(mod => importers[mod].every(imp => imp in DECLARED_UNWIRED))
      .sort();

    expect(clusters).toEqual([
      // The OSM loader cores, which arrived together at v23.21-v23.24 and are
      // built from scripts rather than a router. Legitimate.
      "osmImport",
      "osmTopology",
      // Declared before their consumers were, each waiting on the same wiring.
      "advisoryImpact",
      "deviceManifest",
      "eventEmitter",
      "feedCollector",
      "feedIngest",
      "monitoringNotice",
      // The provincial parsers and their helpers, imported only by providerRegistry and each
      // other. They leave with the feed layer, when the scheduler is started.
      "transport/drivebcOpen511",
      "transport/fields",
      "transport/ibi511",
      "transport/placement",
      "transport/quebecRoadworks",
      // SPINE item 1, landing as one chain before its router: boundaryEvidence holds the
      // chain rule and imports boundaryConfirmation, which imports siteBaseline's types.
      // Not the `billing` shape — nothing else in the tree answers "which boundaries does
      // a person stand behind", so there is no live second copy for this to be drifting
      // away from. Both leave the list when SPINE item 4 wires the stop-timing router.
      "boundaryConfirmation",
      "siteBaseline",
      // The one that prompted this check. `billing` leaves the list when the trip
      // projection is adapted onto rateResolution/linePricing, or when either is
      // wired for real — see docs/b23/HOOKS_AND_PERSISTENCE.md.
      "billing",
      // The AI Secretary model layer's internal cluster: these nine are imported
      // only by other modules in the same unwired subsystem, which is what a
      // whole subsystem held back by the SPINE moratorium looks like from here.
      // They leave this list together, when the layer is wired, or not at all.
      "ai/eval/goldenSet",
      "ai/eval/scoreCase",
      "ai/extraction/contract",
      "ai/extraction/formSchema",
      "ai/llm/config",
      "ai/llm/provider",
      "ai/tools/registry",
      "ai/validate/normalizers",
      "ai/validate/validator",
    ].sort());
  });

  it("keeps the count visible, so the gap cannot grow quietly", () => {
    const unwired = engines.filter(m => !isReached(m));
    // Moving this number is a deliberate act either way.
    expect(unwired).toHaveLength(83);   // driver portfolio: complianceDocumentValidity (already -1 above on main) is also reached from the readiness composer through driverPortfolio (the documentExpiry tile still decides expiry inline);   // SPINE item 2: -1 complianceDocumentValidity, now reached — dispatch (credentials, medical fitness, insurance proof), the documentExpiry tile, the insurance office, the exception centre, the passport and foreign TDG recognition all read the verdict through it; no other engine moved   // +21 AI Secretary model-layer modules. They existed as `server/ai/`, outside this census entirely, and were moved under `_core/` so the guard can see them; every one is declared unwired above under the SPINE moratorium (docs/register/SPINE_WIRING_PLAN.md:3). The number rising is the census becoming honest, not the gap growing: the modules were always unwired, and this is the first run in which that is stated.   // Canadian 511 tranche: +6 transport/* (providerRegistry and the parsers it routes to), declared above; unwired for the same reason feedCollector/feedIngest/feedHttp are   // SPINE item 1: +2 boundaryConfirmation (the resolver) and boundaryEvidence (the chain rule), declared above; the receipt reader is not in this repository — tripStops has no updatedAt here   // census repair: -2 +3. externalSourceSeeds and externalDataRegistry left the declared list because they are reached — db.ts loads the first with `await import`, which the old regex could not see, and its declaration read "no application path reaches this engine". knowledge/evaluationState, knowledge/perimeter and knowledge/repository entered it because coreEngines now recurses; server/_core/knowledge/ was outside the census entirely, nine modules that could be neither reached nor declared   // B23.0 closeout: +4 trip-operations engines (safetyBinder, siteBaseline, tripBillingProjection, tripPassportPackage), declared above and wired by nobody yet   // v23.24 merge: their 49 + 1 — the four OSM loader cores landed unwired this line (osmImport, osmTopology, osmLoadPlan, osmLoad: the build runs from scripts, not from a router, and a router that rebuilds the road graph on request is not something to expose), and the union is 50, counted from DECLARED_UNWIRED rather than taken from either pin: the one entry their side still does not carry is complianceDocumentValidity (merged in from the parallel B28 port at v22.24, unwired because the documentExpiry tile decides expiry inline; see its entry above)   // v22.58: +1 demoDataset (reached from the demo path, declared above);   // v22.35: +1 migrationLedger (reached from scripts/migrate.ts, declared above);   // v22.23: +7 B28 semantics/promotion-gate modules, declared above; the sheet-serial modules are wired through academy.sheetPrintRun/sheetScanFile through trainingAcademyRouter (0123/0122)   // v22.21: loadSense wired through integrationRouter; one further engine reached by the recovered knowledge tranche
    expect(engines.length).toBeGreaterThan(130);
  });
});
