# LeaseOS Route Intelligence — implementation plan (T0 → RI-12, revised at RI-0.5)

Planned against `main` = `0060690` (v23.25) at T0; **revised at RI-0.5 against `origin/main` = `6b01a0e`**
(`0169_defect_resolution` merged) and the lineage findings in `LINEAGE_RECONCILIATION.md`,
`MIGRATION_RECONCILIATION.md` and `LATER_FEATURE_PORT_MANIFEST.md`. The architectural intent of every
checkpoint is unchanged; what changed is the order, and which items are ports rather than builds. T0 (this checkpoint) writes documents only: no schema,
no API, no engine, no migration. Every later checkpoint is a **resolver, a router over an existing
engine, a wiring, or a deletion** — never an engine beside one that exists — so the SPINE moratorium's
own test ("Nothing above needs a new engine") is met by construction.

**Standing rules for every checkpoint**

- Inspect `main` and every active branch before choosing a migration number; take the next unclaimed
  slot at merge time. No number in this document is a reservation.
- Tests first: each checkpoint names the tests written before its code, and its focused command.
- Full regression gate is always `bash scripts/ci-gate.sh` with a disposable MariaDB (gates 0–8),
  which includes the test-file typecheck ratchet pinned at 0 and `engineReachability.test.ts`.
  Without a database, the local proxy is `pnpm exec tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.tests.json && pnpm exec vitest run --reporter=basic`
  (DB suites skip; see the baseline note in the final report).
- Every wired engine leaves `DECLARED_UNWIRED` in `server/engineReachability.test.ts` in the same
  commit (the census fails otherwise), and `LEASEOS_CURRENT_STATE.md` is regenerated.
- Additive only; every new column nullable or defaulted; no data migration that rounds an unknown
  to a value.
- Rollback for any checkpoint = revert the commit; a migration that only adds nullable columns or a
  new table is reversible by a down-file that drops them, written alongside.

Ordering follows the prompt's twelve areas, with two changes forced by the dependency graph:
**permits (RI-4a)** move ahead of the weight/structure integration because the fingerprint, the
readiness composer and the package all need permit rows to exist; and **TDG's cargo-flag fix (RI-6a)**
is pulled forward into the readiness hardening because it is a one-line permissive defect on `main`.


---

## RI-0.5 outcome — the revised order

| Checkpoint | Disposition after lineage analysis | Why |
|---|---|---|
| **RI-0.5** (this) | done: documents only | canonical base = `leaseos-2` `main` (LINEAGE §4) |
| **RI-P** — lineage ports (new, before RI-1) | **inserted**: manifest items B3, B2, C3, A1, A2, B1, C1, A3, C2 as one commit each on one port branch, one PR | every later RI checkpoint touches the five both-side files; porting first means porting once. A3 (permits) and A2 (osmLoad fold) are prerequisites T0 had assigned to RI-4a and RI-1 |
| **RI-0.6** — dangerous-goods readiness flag (new, isolated) | **inserted**, one file, no migration; may ride with RI-P or stand alone | the regex is on every line; it is a permissive defect independent of routing (§ below) |
| **RI-0.7** — permit readiness literal | **replaced by a port** (manifest A3); no new architecture | the later lineage already closes it exactly as the T0 design specified |
| RI-1 reconciliation / source authority | **split**: the `osmLoadPlan` fold and the duplicate-prefix gate leave it. The fold is manifest A2 (a port with an equivalence proof); the gate is designed in MIGRATION §6 and lands **after** the 0169–0173 renumbering, on owner approval. RI-1 keeps: `geofabrik_osm_*` registry rows, `routeConstraintContext` composer, `sourcePrecedence` + `jurisdiction` wiring, T8/T14 | the gate would go red against unmerged branches that are being renumbered; the fold already exists |
| RI-2 unified contracts | unchanged, **moved after RI-P** | its `vehicleProfiles` migration takes a number after the ports' numbers |
| RI-3 province graph | unchanged | depends on A1/A2 having landed (ice roads, extract header) |
| RI-4a permits | **replaced by the port** (manifest A3) plus the two things the later lineage did not do: `permitSet` computed from rows in `routeDependencies` / `routeApprovalCheck` (T6), tenant-scope test T5. Those two stay as "RI-4a-rest" after RI-P | |
| RI-4b weights / structures / bans / advisories | unchanged | |
| RI-5 HOS | unchanged; note that `dutyRecords`/`dailyLogs` are identical on every line — nothing to port | |
| RI-6 TDG | **RI-6a extracted** as RI-0.6 (above); RI-6b unchanged | |
| RI-7 comms imports / reminders | unchanged | identical on every line |
| RI-8 LSD / facility / oilfield | unchanged | |
| RI-9 route package | unchanged in intent; **its device half must wait for the scanner decision** (manifest B5) because both scanner variants rewrite `client/src/runtime/contracts.ts`, which the package vault reuses | |
| RI-10 GPS / deviation / reroute | unchanged in intent; **depends on manifest C1** (trip-stop provenance) so a deviation proposal can name its actor and source with the same `proposalFields` vocabulary; and on PR #10's boundary resolver landing on top of C1 | |
| RI-11 field / dispatch UI, native | unchanged in intent; **blocked on the scanner decision** (B5) and HS1 `capabilities()` over the chosen `contracts.ts` | |
| RI-12 field validation | unchanged | |

Revised sequence: **RI-0.5 → RI-P (+RI-0.6) → RI-1 → RI-2 → RI-3 → RI-4a-rest → RI-4b → RI-5 → RI-6b → RI-7 → RI-8 → RI-9 → RI-10 → RI-11 → RI-12**,
with RI-4a-rest, RI-5, RI-6b, RI-7 still parallelisable after RI-2.

**Exact first production implementation checkpoint after reconciliation: RI-P item 1–3 (B3, B2, C3)**
as the first commit of the port branch — zero-risk, proves the branch and the gate — followed in the
same PR by A1, A2, B1, C1, A3, C2 in the manifest's order. Owner approval of LINEAGE §4 gates it.

### RI-P — lineage ports

| | |
|---|---|
| Purpose | land the later lineage's verified work on canonical `main` once, by feature, without recreating anything from memory |
| Files | per manifest item (A1, A2, A3, B1, B2, B3, C1, C2, C3); the five both-side files are hand-merged once per item that touches them |
| Tables | +`movementPermits`, +`movementPermitDeterminations` (A3); `tripStops` +5 columns (C1) |
| API | `movementPermit.statusFor/record/determine/verify/listForJob`; `tripStops.create/update` write provenance |
| Migrations | **two, renumbered at merge** per MIGRATION §5 and manifest §D (origin `0168_movement_permits`, origin `0169_trip_stop_provenance`); ledger status confirmed on every real environment first |
| Tests first | every ported test file as it exists at the source commit; `osmLoad.test.ts` must contain every `osmLoadPlan.test.ts` case before `osmLoadPlan.ts` is deleted; T1 (permit branches reach the verdict), T6 (permit change stales an approval — may stay RED until RI-4a-rest), T5 (permit out of scope is NOT_FOUND) |
| Focused command | `pnpm exec vitest run server/_core/osmImport.test.ts server/_core/osmLoad.test.ts server/_core/movementPermits.test.ts server/_core/movementPermitAuthority.test.ts server/_core/dispatchReadiness.test.ts server/dispatchGate.test.ts server/tripStopProvenance.test.ts server/webhookTenantIsolation.db.test.ts server/documentationTruth.test.ts server/engineReachability.test.ts server/procedureAuthorization.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert per commit; down-files for the two migrations |
| Safety invariants | as T0 RI-4a; plus: a port carries the source commit in its message and changes no semantics; the v2327 branch and the `leaseos` repository are left untouched as provenance |

### RI-0.6 — dangerous-goods readiness flag (isolated; Step 10 record)

**Exact existing behaviour** (`server/readinessComposer.ts:333` on `origin/main`, identical on every
line):

```ts
const dangerousGoods = /tdg|dangerous|hazard/i.test(`${job?.type ?? ""} ${job?.mode ?? ""}`);
```

The flag then drives: the TDG credential requirement (`:293` in the T0 tree), `job.dangerousGoods`,
`tdgDocumentPrepared: dangerousGoods ? null : true`, `emergencyPlanOnFile: dangerousGoods ? null : true`,
the communications lone-worker/DG blockers, and the Academy readiness binding. A job whose `type`/`mode`
text does not contain those words is treated as non-DG **and** as having its TDG document and ERAP on
file, whatever its loads carry. No test drives a DG job through the composer: every fixture sets
`dangerousGoods: false` directly on `ReadinessInput` (`hosAttestation.test.ts:41`,
`destinationAcceptance.db.test.ts:27`, `commsDispatch.test.ts:235-300`), and no test fixture has a job
`type`/`mode` containing `tdg`/`hazard`/`dangerous`, so the regex's true branch is unexecuted by the
suite.

**Authoritative structured data already available:** `loadProfiles.unNumber`, `properShippingName`,
`dgClass`, `packingGroup`, `classificationStatus` (`needs_verification` / `verified` / `blocked`) on
`drizzle/schema.ts:212` (migration 0003), joined to the job through `loads`; the Academy binding and
`compliancePassport.dangerousGoodsAssist` already consume structured fields.

**Minimal corrective checkpoint (one file, no migration):** in `readinessComposer.ts`, replace the regex
with a read of the job's loads' `loadProfiles`: `dangerousGoods = true` if any load has
`classificationStatus = verified` and a `unNumber`; `null` if any load is `needs_verification`/`blocked`
or has no profile; `false` only when every load has a verified non-DG classification. Thread `null`
through `ReadinessInput.job.dangerousGoods: boolean | null` so `dispatchReadiness` adds
`dg_classification_unverified` (severity `unknown`), and keep `tdgDocumentPrepared`/`emergencyPlanOnFile`
as `null` whenever the flag is not `false`. Tests first: T9 (a job typed "water haul" carrying a
verified UN 1267 load is DG; a job typed "TDG run" with no load profile is `unknown`, never `true` from
the words), plus one `degradationSuite` case. Focused: `pnpm exec vitest run server/dispatchGate.test.ts server/_core/dispatchReadiness.test.ts server/academyReadinessBindings.test.ts server/_core/degradationSuite.test.ts`.

### RI-0.7 — permit readiness literal (Step 11 record)

`server/readinessComposer.ts:544-545` on `origin/main`: `permitRequired: false, permitOnFile: null`.
Because `dispatchReadiness.ts` only enters its permit branch when `permitRequired` is truthy, the
`permit_missing`/`permit_unknown` blockers are dead on `main` and an oversize movement passes the permit
check in silence. The later lineage closes this exactly as T0's design asked, and the port is the fix:

1. `movementPermits` + `movementPermitDeterminations` tables (A3) give the composer something to read;
2. `permitStatusForJob(db, jobId)` returns `{ permitRequired: boolean | null, permitOnFile: boolean | null }`
   — `null` when no determination row exists, `permitOnFile` from verified, in-window rows
   (`permitCoversMoment` reads a null window as unknown);
3. the composer's two lines become `permitRequired: permits.permitRequired, permitOnFile: permits.permitOnFile`;
4. `dispatchReadiness` gains `permit_requirement_unknown` (severity `unknown`, manager-overridable,
   verdict stays non-eligible) beside the untouched non-overridable `permit_missing`/`permit_unknown`;
5. four new `dispatchReadiness.test.ts` cases pin the three states apart.

No new permit architecture; `permitRefs` on `spatial.routeApprove` become references to these rows in
RI-4a-rest.

---

## RI-1 — Reconciliation and source authority

**Purpose.** Make the source registry, the road-source standing and the CI gate agree; wire
`sourcePrecedence` and `jurisdiction` at the one place segment attributes are compiled; retire the
duplicate OSM plan file. No behaviour changes for a caller except that a conflicting source now
tightens a segment instead of being ignored.

| | |
|---|---|
| Files expected to change | `server/_core/externalSourceSeeds.ts` (three `geofabrik_osm_*` rows, verified under ODbL with the share-alike caveat, attribution text set); `server/_core/legalLand.ts` (standing keys unchanged; test binds them to the registry); `server/_core/osmLoad.ts` absorbs `osmLoadPlan.ts` (port the v23.29 shape: `OSM_EXTRACT_FORMAT_VERSION`, `ExtractHeader`) and `osmLoadPlan.ts` + its test are deleted; new `server/routeConstraintContext.ts` (DB composer: restrictions windowed + structures + observations → `sourcePrecedence.resolvePrecedence` → `RoadSegmentInput[]`), called by `spatial.routeEvaluateSegments` in place of its inline merge; `server/_core/jurisdiction.ts` called from `routeCommunicationGeography.ts` (returns `probable` until a verified layer exists — no answer changes); `scripts/ci-gate.sh` gate 0b: duplicate-prefix check with the known `0157` pair allow-listed; `server/engineReachability.test.ts` (remove `sourcePrecedence`, `jurisdiction`, `osmLoadPlan` from the declared list) |
| Tables affected | none |
| API changes | none (same procedures, same shapes); `spatial.routeEvaluateSegments` explanation gains precedence lines |
| Migration | **none** |
| Tests first | T8 every `ROAD_SOURCE_STANDING` key has a registry row; T14 a `closed` field observation on a segment lowers the route to REVIEW/BLOCKED and a "looks open" one never lifts a verified restriction (DB, over `spatial.routeEvaluateSegments`); T11 gate script refuses a second duplicate prefix; `osmLoad.test.ts` keeps every `osmLoadPlan.test.ts` case |
| Focused command | `pnpm exec vitest run server/_core/externalSourceSeeds.test.ts server/_core/sourcePrecedence.test.ts server/_core/osmLoad.test.ts server/structures.test.ts server/engineReachability.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; no data written |
| Safety invariants | a source may tighten, never loosen; UNKNOWN + "looks clear" = UNKNOWN; jurisdiction stays `probable` with no verified boundary layer; the registry, not a key, is what clears a source |

## RI-2 — Unified contracts

**Purpose.** Name the seams as types over what exists (`RoutePlanningRequest`, `TransportProfile`,
`RouteCandidateProvider`, `RouteCandidateSet`, `RouteConstraintContext`, `RouteIntelligenceReadiness`,
`CustomerTripProjection`), close the two-door inequality, scope the FAIL guard, and keep UNKNOWN
visible through dispatch.

| | |
|---|---|
| Files | new `server/_core/routePlanning.ts`, `transportProfile.ts` (derived over `vehicleProfiles` rows + `loadSense.toRoutingVehicleValues` + `legalLand.configurationFingerprint`), `routeCandidates.ts` (interface + `roadGraphProvider` wrapping `snapToGraph`/`shortestPath`; alternatives via edge-penalty re-runs), `routeIntelligenceReadiness.ts` (type + adapter to `ReadinessInput.route`); `server/geoRouter.ts` `routeCompute` returns a `RouteCandidateSet` (no evaluation; `evaluatedAgainst: []`) and a new `geo.routeCandidates` alias; `server/spatialRouter.ts` `routeEvaluateSegments` takes `{ candidateRef | segmentIds, unitIds, loadId }` and builds the profile itself; `routeApprove` FAIL guard filtered by `evaluationRef` (required when `communicationPolicies`/company policy says so — reuse the policy table's proposed/approved pattern, no new table), marks the prior approval `superseded`; `server/_core/dispatchReadiness.ts` adds `route_unknown` (severity `unknown`) for `warning`; `server/_core/customerProjections.ts` adds `CustomerTripProjection`; `client/src/pages/RoutePreview.tsx` shows "candidate — not evaluated" until an evaluation is attached |
| Tables | `routeRequests` (+`orgRef`, `departAt`, endpoint JSON), `vehicleProfiles` (+`registeredWeightKg`, `manufacturerGvwrKg`, `tireCapacityJson`, `wheelbaseM`, `rearOverhangM`, `sleeperQualifying` tinyint NULL, `sleeperSource`, `sleeperVerifiedAt`, `sleeperVerifiedByUserId`) — all nullable |
| API | `geo.routeCompute` output shape gains `candidates[]` (old single-path fields kept one release for the preview page); `spatial.routeEvaluateSegments` input widened (old shape accepted, deprecated); `spatial.routeApprove` refuses without `evaluationRef` when policy requires |
| Migration | **one**, next free slot at merge time: ALTER `routeRequests`, ALTER `vehicleProfiles` (nullable columns only) |
| Tests first | T3 FAIL guard scoped to `evaluationRef` (DB); T7 route UNKNOWN surfaces as `unknown` severity; T15 candidate carries no evaluation field and approval refuses an unevaluated candidate under policy; T4 portalRouter output keys carry no coordinate field; `transportProfile.test.ts`: highest-ranked weight wins and is named in the evidence, an unverified sleeper reads `null`, a combination fingerprint moves when a trailer changes |
| Focused command | `pnpm exec vitest run server/_core/routeEvaluation.test.ts server/_core/routeApprovalPolicy.test.ts server/structures.test.ts server/roadGraph.test.ts server/_core/dispatchReadiness.test.ts server/customerLiveView.test.ts server/_core/transportProfile.test.ts server/spatialFoundation.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; down-file drops the added columns; old procedure shapes still accepted during the release |
| Safety invariants | ROUTE EXISTS ≠ ROUTE LEGAL is a type; a FAIL from this evaluation blocks and nobody signs it; UNKNOWN is `unknown` at dispatch; the customer type has no location slot; the transport profile is derived, never a second registry |

## RI-3 — Province-scale graph and map data

**Purpose.** Load OSM extracts (AB, then BC, SK) into `roadGraphBuilds/Nodes/Edges` through the
existing pure loader, with topology by shared node ids, source and version on every edge, and the
extract recorded with its SHA-256. No display tiles yet.

| | |
|---|---|
| Files | new `scripts/osm-load.ts` (reads the JSONL intermediate, runs `osmLoad.planLoad` → `osmTopology.buildTopology` → writes a build; refuses an unregistered or uncleared source through `evaluateSourceUsage`); `server/_core/roadGraph.ts` reads `direction`; `server/geoRouter.ts` `graphBuild` accepts `sourceKeys[]` and the topology strategy from `standingFor`; `server/db.ts` `externalDatasetImports` writer (unused table becomes the extract record: `datasetVersion` = publish date, `checksumSha256` = extract hash) |
| Tables | `roadGraphEdges` (+`direction` enum forward/backward/both NULL, `accessRoadObjectId` → nullable), `roadGraphBuilds` (+`topologyStrategy`, +`extractImportRef`) |
| API | `geo.graphBuild` input gains `sourceKeys`; `geo.coverage` reports per-source edge counts and "ways meeting nothing" |
| Migration | **one**, next free slot: two ALTERs |
| Tests first | `osmLoad.test.ts` end-to-end over the Edmonton fixture writes a build whose edge count equals the topology's; a build mixing `ats_road_allowance` (snap) and `geofabrik_osm_ab` (ids) refuses to snap OSM ways; `roadSourceNeutrality.test.ts` extended: an OSM `maxweight` tag never produces a `pass` on `road_weight_restriction`; `routeCompute` over an OSM build returns `path_only` with every legal check UNKNOWN; ODbL separation: a candidate's `sourceKeys` names `geofabrik_osm_*` whenever an OSM edge is used |
| Focused command | `pnpm exec vitest run server/_core/osmImport.test.ts server/_core/osmTopology.test.ts server/_core/osmLoad.test.ts server/_core/roadTopologyStrategy.test.ts server/_core/roadSourceNeutrality.test.ts server/roadGraph.test.ts` |
| Full gate | `bash scripts/ci-gate.sh`, plus the loader run on the real Alberta extract recorded in the checkpoint document (counts, refusals by name) |
| Rollback | revert; a build is a row with `status`, so a bad build is `superseded`, never deleted |
| Safety invariants | shared node ids only for OSM; a coordinate source never through id matching; "UNKNOWN is the data"; no OSM tag answers a legal check; the extract hash is recorded or the build is refused |

## RI-4a — Movement permits on `main` (port, not redesign)

**Purpose.** Bring the v23.29 permit checkpoint onto `main` under a new migration number, with its
tests, and make the fingerprint read permit rows.

| | |
|---|---|
| Files | port `server/_core/movementPermits.ts`, `server/movementPermitRouter.ts` (+ `routers.ts` mount, `recordsAuthorization.ts` permissions `permit.read/record/determine/verify*`), `server/readinessComposer.ts` (`permitStatusForJob`), `server/_core/dispatchReadiness.ts` (`permit_requirement_unknown`), tests `movementPermits.test.ts`, `movementPermitAuthority.test.ts`; `server/spatialRouter.ts` `routeDependencies` computes `permitSet` from **rows** (permitRef + verificationStatus + window) and `routeApprovalCheck` stops carrying it over |
| Tables | `movementPermits`, `movementPermitDeterminations` (both with `orgRef`) |
| API | `permit.statusFor`, `permit.record`, `permit.determine`, `permit.verify` (sensitive), `permit.listForJob`; `spatial.routeApprove.permitRefs` must name existing rows |
| Migration | **one**, next free slot: the v23.29 `0168_movement_permits.sql` body renumbered, plus `permit.*` procedure inventory update |
| Tests first | T1 permit branches reach the verdict from a real job (DB); T6 a permit superseded after approval turns it `stale` naming `permitSet`; T5 permit for a unit out of scope reads NOT_FOUND; port the two v23.29 test files unchanged |
| Focused command | `pnpm exec vitest run server/_core/movementPermits.test.ts server/_core/movementPermitAuthority.test.ts server/dispatchGate.test.ts server/structures.test.ts server/procedureAuthorization.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; down-file drops the two tables; the composer literal must **not** return — the revert of this checkpoint reinstates `permitRequired: null` handling from RI-2's `route_unknown` pattern, not `false` |
| Safety invariants | no determination ⇒ UNKNOWN, not exempt; a null window is unknown, not forever; `conditionsText` is never parsed into a pass; permit uploaded ≠ verified; `permit_missing`/`permit_unknown` are not overridable |

## RI-4b — Weight, structure, road-ban and advisory integration

**Purpose.** The evaluator consumes the ladder-ranked weight, road bans in force, structures without
the legacy `bridges` table, and placed advisories; the feed worker runs; staleness becomes eager.

| | |
|---|---|
| Files | `server/spatialRouter.ts` `routeEvaluateSegments` uses `TransportProfile.toVehicleValues()` (LoadSense determination when a current snapshot exists) and reads `structures` only; `server/routeConstraintContext.ts` adds advisories via `advisoryImpact.advisoriesOnRoute` and `RouteDependencies.advisorySet`; `server/_core/structures.ts` `RouteDependencies` gains `advisorySet`; `server/_core/productionWorker.ts` registers a `feeds` job calling `feedScheduler.tick` for cleared sources (DriveBC first; 511 stays refused until the registry row is cleared); `server/_core/feedIngest.ts` DriveBC Open511 normalizer; `server/_core/domainEmitters.ts` emits `dispatch.assignment_at_risk` from restriction/structure/permit/advisory writes that touch an approved route's segments (a query, not a new event type); `engineReachability.test.ts` removes `advisoryImpact`, `feedCollector`, `feedIngest`, `feedHttp`, `feedScheduler`, `routeApprovalPolicy` (wired into `routeApprove` as the one FAIL/trigger authority) |
| Tables | none new; `externalFeedRuns`, `roadAdvisories` get their first writer |
| API | `spatial.routeApprovalCheck` reasons include `advisorySet`; new read `spatial.liveConditions` → `current | stale | feed_not_started | unavailable_due_to_rights` |
| Migration | **none** (if `RouteDependencies` gains a part, it is JSON in `fingerprintJson`) |
| Tests first | T10 live-conditions state never reads `clear` without a run; evidence names the weight's authority; a road ban in force lowers a limit and an expired one is set aside by name; a placed closure makes an approval stale and a re-check names `advisorySet`; `regulatoryDataDiscipline` extended to the constraint compiler (no literals); the feed job refuses `ab511` while `commercialUsePermitted = unknown` |
| Focused command | `pnpm exec vitest run server/_core/loadSense.test.ts server/_core/legalAxleDetermination.test.ts server/_core/advisoryImpact.test.ts server/feedIngest.test.ts server/feedCollector.test.ts server/structures.test.ts server/_core/regulatoryDataDiscipline.test.ts server/_core/routeApprovalPolicy.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; the worker job is a registration; no schema |
| Safety invariants | advisory stays advisory (raises review, never clears, never blocks by itself unless the policy says a closure blocks); rated capacity is not a limit; a driver-entered weight never becomes the evaluator's gross weight; a FAIL is reported before triggers |

## RI-5 — HOS and logbook hardening

**Purpose.** Dispatch consumes the HOS determination; amendments and certifications become rows;
discrepancies become review rows; sleeper refusal; ELD boundary stated.

| | |
|---|---|
| Files | `server/readinessComposer.ts` fills `RouteIntelligenceReadiness.hos` from `hos.selectProfile`/`computeClocks`/`determine`/`tripFeasibility` with a records-built `OperatingContext`; `server/_core/dispatchReadiness.ts` `hos_unknown` / `hos_exceeded` / `hos_infeasible` from the determination (attestation path kept); `server/hosRouter.ts` + `server/_core/hos.ts`: `logAmend` (proposal), `logAmendDecide` (second person), `logCertify`, `discrepancies` (pure comparison → Exception Centre source); `server/_core/hosClockPresentation.ts` wired to `hos.status`; `server/_core/exceptionCentre.ts` new required source `hosDiscrepancies`; `INBOUND_FEEDS` gains `eld_duty_status`; `HosAssistanceBoundary` on every HOS output |
| Tables | `dailyLogAmendments` (new, append-only), `dailyLogCertifications` (new) over `dailyLogs`; `dutyRecords.source` becomes an enum incl. `certified_eld` (+`sourceDeviceRef`) |
| API | `hos.logAmend`, `hos.logAmendDecide` (sensitive), `hos.logCertify`, `hos.discrepancies`; `dispatch.readiness` output carries the HOS slice |
| Migration | **one**, next free slot |
| Tests first | T13 sleeper refusal as a review row; a GPS-vs-duty contradiction raises a discrepancy and edits nothing; an amendment never updates `dutyRecords` in place; certification hashes the log content; `hos_*` blockers from an UNKNOWN determination read `unknown`; a certified-ELD row and a computed row are distinguishable; `degradationSuite` gains the HOS capability cases |
| Focused command | `pnpm exec vitest run server/hos.test.ts server/hosAttestation.test.ts server/_core/dispatchReadiness.test.ts server/dispatchGate.test.ts server/_core/degradationSuite.test.ts server/registryV2.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; down-file drops the two tables and restores the varchar |
| Safety invariants | no schedule in code; UNKNOWN names the rung; no single hours-remaining; logs are never silently modified; LeaseOS HOS ≠ certified ELD is a type on the wire |

## RI-6 — TDG integration

**Purpose.** Structured dangerous-goods lines feed the route domain; the readiness DG flag reads
records, never free text; document and ERAP state are tri-state.

| | |
|---|---|
| Files | **RI-6a (pull forward into RI-2 if that ships first):** `server/readinessComposer.ts:227` reads `loadProfiles` for the job's loads (`classificationStatus`, `unNumber`) — `dangerousGoods` becomes `true | false | null`; `server/_core/dispatchReadiness.ts` `dg_classification_unverified` blocker (unknown severity). **RI-6b:** `dangerousGoodsLines` child table and `compliance.dangerousGoodsLinesSet/Verify`; `transportProfile.cargo` reads it; `routeEvaluation` `dg_corridor` / `dg_time_restriction` read `dangerousGoods === true` only; `tdgDocumentPrepared` and `emergencyPlanOnFile` from `complianceDocuments` under `requirementKey`s |
| Tables | `loadProfiles` (+`erapNumber`, `erapExpiresAt`, `erapVerificationStatus`); `dangerousGoodsLines` (new; shared with the compliance design's C5 — one table) |
| API | `compliance.dangerousGoodsLinesSet`, `…Verify` (sensitive); readiness output carries `cargo` |
| Migration | RI-6a **none**; RI-6b **one**, next free slot |
| Tests first | T9 regex never decides DG; an unverified classification reads `null` ⇒ `unknown`; a UN line with no placard decision reads `placardRequired: null`; the evaluator's DG checks never run on `null` as if `false` |
| Focused command | `pnpm exec vitest run server/dispatchGate.test.ts server/_core/dispatchReadiness.test.ts server/compliancePassport.test.ts server/academyReadinessBindings.test.ts server/_core/routingCompiler.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; RI-6a is one file |
| Safety invariants | regulated cargo is structured or unknown; jurisdiction is decided, not inferred; ERAP present-unverified ≠ present |

## RI-7 — Communications imports and reminders

**Purpose.** Coverage rows from a cleared source; reminder evidence designed as three tri-states;
call points carried into the route package.

| | |
|---|---|
| Files | `server/commsRouter.ts` `coverageImport` (only for a registry row with `commercialUsePermitted = yes`; `crtc_coverage` stays unverified until the owner records terms); `server/_core/commRoute.ts` reminder schedule from `mustCallKm` (pure); `server/_core/commReminders.ts` type only until RI-11 |
| Tables | none in RI-7 (reminder evidence table lands with the device in RI-11) |
| API | `comms.coverageImport` (sensitive) |
| Migration | **none** |
| Tests first | an import from an uncleared source is refused by name; a modelled coverage row records `authorityTier` below a field observation; the reminder schedule never asserts `transmissionVerified` |
| Focused command | `pnpm exec vitest run server/commRoute.test.ts server/communications.test.ts server/commsDispatch.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert |
| Safety invariants | seven separations preserved; retired service authorizes nothing; `promptDelivered` ≠ `driverConfirmed` ≠ `transmissionVerified` |

## RI-8 — LSD, facility and oilfield integration

**Purpose.** Compose lease entrance, facility acceptance and route candidates into one planning
call; disposal routing through the graph.

| | |
|---|---|
| Files | `server/routePlanning.ts` (DB): resolve `RouteEndpoint.location` to the confirmed `siteAccessPoints` row (proposed/disputed ⇒ endpoint unknown, request refused by name), `RouteEndpoint.facility` to verified coordinates only, and run `facilityCompatibility` beside (never inside) the route; `geoRouter.ts` `routeCandidates` accepts endpoints; `facilityDirectoryRouter.ts` `driverView` gains "route candidates available: yes/no/why" |
| Tables | none |
| API | `geo.routeCandidates` endpoint kinds; `facilityDirectory.driverView` field |
| Migration | **none** |
| Tests first | an approximate-site facility is never an endpoint; a proposed entrance refuses the request and names `accessDecide`; acceptance and route are two verdicts in the response and neither implies the other |
| Focused command | `pnpm exec vitest run server/legalLand.test.ts server/_core/facilityCompatibility.test.ts server/_core/facilityNavigation.test.ts server/facilityDirectory.db.test.ts server/roadGraph.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert |
| Safety invariants | map pin ≠ acceptance; entrance confidence is counted from passages; theoretical grid is labelled |

## RI-9 — Complete offline route package (server half)

**Purpose.** One immutable, versioned, hashed `routePackages` row per approved route, sealed by the
`commPackage` functions, referencing the comms package, naming every absence.

| | |
|---|---|
| Files | `server/_core/routePackage.ts` (content type, `sealRoutePackage` via `canonical`/`hashOf`, `routePackageDependencies`, `packageStaleness` reused); `server/routePackageRouter.ts` (`build`, `fetch`, `acknowledge`, `status`) mirroring `commsRouter` package procedures; `client/src/runtime/commsVault.ts` generalised to `carryPackage(kind)`; `preDepartureCache.manifestFor` wired as the "what must be on the device" check (leaves `DECLARED_UNWIRED`) |
| Tables | `routePackages`, `routePackageDownloads` (new; columns mirror `communicationPackages` / `communicationPackageDownloads`, plus `orgRef`, `communicationPackageRef`) |
| API | `routePackage.build` (permission `route.package.build`), `fetch`/`acknowledge` (`route.package.fetch`), `status` (`route.read`) |
| Migration | **one**, next free slot |
| Tests first | T12 (hash coverage, absence naming, staleness per section); T5 package out of scope NOT_FOUND; a package built from a `stale` approval is refused; `carriedState` distinguishes behind / stale / none; the package excludes a retired channel because the comms package does |
| Focused command | `pnpm exec vitest run server/_core/routePackage.test.ts server/commPackage.test.ts server/commsVault.test.ts server/_core/preDepartureCache.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; down-file drops two tables |
| Safety invariants | built once, hashed, never edited; missing is named, never counted; cached ≠ current; the package carries verdicts and evidence, never grants |

## RI-10 — Live GPS, deviation, reroute (server half)

**Purpose.** Map matching and deviation as proposals; stale ⇒ candidates ⇒ a person.

| | |
|---|---|
| Files | `server/_core/roadGraph.ts` `matchFixes(edges, fixes)` (pure, sequence-aware); `server/_core/tripGps.ts` proposes `zoneEvents` of `eventType = route_deviation` when matched segments leave the approved `segmentIdsJson`; `server/_core/workflowRuntime.ts` handler for `dispatch.assignment_at_risk` → `RouteCandidateProvider.candidates` → `spatial.routeEvaluateSegments` under a new `evaluationRef` → an Exception Centre item "route needs re-approval" (no approval written); structural test scanning production writers |
| Tables | `zoneEvents.eventType` enum (+`route_deviation`, +`entrance_passage`) |
| API | `gps.pendingZoneEvents` includes deviations; `spatial.rerouteCandidates` read |
| Migration | **one**, next free slot (enum extension) |
| Tests first | T2 structural guard + behavioural pending-only; a deviation confirmed by a person marks the approval stale; the reroute handler writes evidence and never an approval; a matched fix with low confidence proposes nothing |
| Focused command | `pnpm exec vitest run server/operationalTruth.test.ts server/_core/geofence.test.ts server/roadGraph.test.ts server/_core/dispatchLifecycle.test.ts server/operationalApiAuthorization.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` |
| Rollback | revert; enum values are additive |
| Safety invariants | GPS creates evidence and proposals only; automatic candidate generation is not automatic approval; confidence only ever lowers |

## RI-11 — Field and dispatch UI, native runtime bindings

**Purpose.** Driver route/package/HOS surfaces, dispatch map, MapLibre with offline tiles, native
GPS/vault through the existing adapter, reminder evidence, phone-location gate wired.

| | |
|---|---|
| Files | `client/src/pages/RoutePreview.tsx` → candidate/evaluation/approval states; new `DriverRoute.tsx`, `DispatchMap.tsx`; `client/src/components/Map.tsx` replaced by a MapLibre component (Google template deleted with `server/_core/map.ts`); `client/src/runtime/adapters/capacitor.ts` real bindings behind HS1 `capabilities()`; breadcrumb capture kind in `contracts.ts`/`outbox.ts` (priority tier from `captureSyncPriority`); `phoneLocationGate` wired to the collector; `monitoringNotice` enforced per owner §10.1; reminder evidence writer |
| Tables | `communicationReminderEvents` (tri-state evidence, append-only); `tripBreadcrumbs.source` unchanged |
| API | `gps.submitBreadcrumbBatch`; `comms.reminderEvidence`; `device.capabilities` |
| Migration | **one**, next free slot |
| Tests first | a11y runs for the new surfaces; `clientTruth.test.ts` extended (no hardware call outside the adapter); a declined monitoring notice never appears as a blocker reason; the vault refuses a tampered route package; emulator tests for GPS capture (P1.7) |
| Focused command | `pnpm exec vitest run client/src/**/*.dom.test.tsx server/clientTruth.test.ts server/fieldRuntime.test.ts server/_core/phoneLocationGate.test.ts server/commsVault.test.ts` |
| Full gate | `bash scripts/ci-gate.sh` + device suite |
| Rollback | revert; the browser fallback runtime remains |
| Safety invariants | tiles are not the graph; exact position never from a personal phone to a customer; four gates for phone location; `NotOnDeviceError` is the only unavailable-capability error |

**Blocked on:** P1.1 Android shell; tile source decision; ISED/BC/CRTC terms for what the package may carry.

## RI-12 — Field validation and release

**Purpose.** Known Alberta heavy-haul and back-road routes driven against the system; every
workflow change versioned; the pilot plan from `docs/b23`.

| | |
|---|---|
| Files | `docs/route-intelligence/FIELD_VALIDATION.md` (routes, expected UNKNOWNs, observed); no code unless a defect is found |
| Tables / API / Migration | none planned |
| Tests first | every defect found in the field lands as a failing test before its fix |
| Full gate | `bash scripts/ci-gate.sh` |
| Safety invariants | a pilot finding never lowers a gate; verification stays a person's act |

---

## Dependency graph

```
RI-1 ──▶ RI-2 ──▶ RI-3 ──▶ RI-4b ──▶ RI-8 ──▶ RI-9 ──▶ RI-11 ──▶ RI-12
          │         ▲        ▲        ▲        ▲
          ├──▶ RI-4a ┘        │        │        │
          ├──▶ RI-5 ──────────┘        │        │
          ├──▶ RI-6 ──────────┘        │        │
          └──▶ RI-7 ───────────────────┘        │
                RI-10 (after RI-3, RI-4b) ──────┘
```

RI-4a, RI-5, RI-6a and RI-7 are independent of each other and of RI-3; they can run in parallel on
separate branches provided each takes its migration number at merge time.

## Recommended first implementation checkpoint (T0 text; superseded by the RI-0.5 outcome above)

**RI-1.** It needs no migration, no owner data decision and no device; it fixes three real defects
(unregistered OSM standing keys, the duplicate OSM plan file, the missing duplicate-prefix gate) and
wires two idle engines at the seam every later checkpoint compiles through. It also forces the
`routeConstraintContext` composer into existence, which is the object RI-2, RI-4a and RI-4b all
extend.

**Immediately after, and small enough to ride with RI-1 if the owner prefers:** RI-6a — replace the
regex at `readinessComposer.ts:227` with a read of `loadProfiles`. It is one file, no migration, and
closes a permissive defect on `main` today.
