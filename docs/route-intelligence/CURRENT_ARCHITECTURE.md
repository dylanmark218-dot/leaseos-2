# LeaseOS Route Intelligence — current architecture (T0 reconciliation)

**Read against:** `origin/main` = `006069057b8a245ce00c0453d500f1e69c9e916c` (2026-09-21, "Merge the
login/portal checkpoint"). Branch `claude/leaseos-route-intelligence-t0-mj9uj7` was created from that
commit and carries no code change; this checkpoint adds four documents and nothing else.

**Release:** `LEASEOS_RELEASE` = **v23.25**. `LEASEOS_CURRENT_STATE.md` (generated) reads 408
`mysqlTable(` declarations, 165 migration files, 646 role-authorized procedures, 36 portal procedures,
2 integration procedures, 355 permissions (125 fail-closed sensitive), 301 test files / 4,057 `it(`
cases, 4 native-only runtime bindings.

Every statement below was read from the tree at that commit. Where a remembered name from an older
document does not exist, this says so.

---

## 1. Migration ledger — the actual tip, and what is contending for the next slots

| Fact | Value |
|---|---|
| Files | 165 `drizzle/*.sql`, prefixes `0000`–`0168`, 164 distinct prefixes |
| Tip on `main` | `0168_retire_storage_capability_urls.sql` (data-only UPDATEs) |
| Reserved and absent | `0016`, `0017` — `scripts/ci-gate.sh` gate 0 fails if either is occupied |
| Unexplained gaps | `0094`, `0095`, `0098` — nothing in the tree explains them; never fill a historical gap |
| Duplicate prefix | `0157_seal_verification_unavailable.sql` **and** `0157_signature_device_attestation.sql`. Both apply (lexical order). No gate checks prefix uniqueness (roadmap "Security, CI and ops") |
| Runner | `scripts/apply-migrations.sh` (`ls drizzle/*.sql \| sort`, no ledger, used by CI) and `scripts/migrate.ts` → `server/_core/migrationLedger.ts` (`schemaMigrations` table, sha256, refuses drift). `drizzle/meta/_journal.json` is **not read** by either (17 entries, stale) |

**Open reservations and conflicts on unmerged branches** (fetched 2026-09-23):

| Slot | Claimed by | Note |
|---|---|---|
| `0169_defect_resolution.sql` | `readiness-defect-repair`, `feature/dispatcher-readiness-panel`, `feature/dispatcher-detail-assignment`, `feature/dispatch-role-assignment-backend` | four branches, same file |
| `0169` (planned, no file) | `docs/hybrid-seam/HS_CONTRACTS.md` §4 reserves 0169 for `sync_commands` | conflicts with the above |
| `0170_dispatch_role_types.sql`, `0171_dispatch_role_assignment_events.sql` | `feature/dispatch-role-assignment-backend` | |
| `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` | **conflicts** with `0170_dispatch_role_types` |
| `0168_movement_permits.sql`, `0169_print_audit.sql` | `claude/mobile-hardware-scanner-mzp1e1-v2327` (release **v23.29**, no merge base with `main`) | **conflicts with main's `0168`** — see §9 |

**Consequence for this programme:** the next genuinely free slot on `main` today is `0169`, but it is
not free in the portfolio. No Route Intelligence checkpoint may pick a number from this document. The
implementing checkpoint inspects `main` and every active branch at merge time and takes the next
unclaimed number then. T0 needs no migration.

---

## 2. Layer map — where the Route Intelligence code actually lives

All engines are flat files in `server/_core/`; DB-backed composers sit in `server/`. There is no
`server/services/`, no `commercialGraphRouting.ts`, no `routeIntelligence*` module.

```
  registries          externalSourceSeeds.ts → externalDataSources (21 sources: 8 verified, 13 unverified)
  (licence gate)      facilitySourceLicences · knowledgeSources (assistant passages, a different gate)
        │
  geography           dls.ts (LSD/UWI) · geoImport.ts (ATS grid + AB access roads, ArcGIS) · legalLand.ts
                      (reverseLookup, accessConfidence, ROAD_SOURCE_STANDING, roadAsSegment, corridorSegments)
        │
  road fabric         accessRoadSegments (imported) · osmImport/osmTopology/osmLoadPlan/osmLoad (pure, unwired)
        │
  candidate graph     roadGraph.ts (buildGraph coordinate-snap, snapToGraph, shortestPath Dijkstra)
                      → roadGraphBuilds / roadGraphNodes / roadGraphEdges (0073, +0164 source columns)
        │            "A path here is a proposal to evaluate, not a permission to drive."
        ▼
  constraint context  routingCompiler.ts (ConstraintProfile, 22 RequiredChecks) · structures.ts
                      (applicableRestrictions, structureAttributes, RouteDependencies, fingerprintHash,
                      stalenessAgainst) · roadRestrictions · structures · bridges · vehicleProfiles
        ▼
  evaluator           routeEvaluation.ts — evaluateRoute(requiredChecks, segments, vehicle) → RouteVerdict
                      CheckResult = pass | fail | review | unknown, three axes, worst-wins,
                      unverified-pass ⇒ review, absent ⇒ unknown, dispatchStatus clear|warning|review|blocked
        ▼
  evidence + approval routeEvidenceEntries (per check per segment, evaluationRef 0167)
                      routeApprovals (fingerprintHash, coverage 0165, evaluationRef 0167, status approved|stale|…)
        ▼
  readiness           readinessComposer.ts (DB) → dispatchReadiness.evaluateDispatchReadiness
                      → dispatchEligibilityChecks (fingerprint, routeApprovalRef, capabilitiesJson)
                      interEngineStatus.ts (PASS|REVIEW|BLOCKED|UNKNOWN|NOT_EVALUATED) · readinessCapabilities.ts
        ▼
  communications      commRoute.ts (transmitAuthorization, planCommunications, communicationBlockers)
                      commPackage.ts (sealCommunicationPackage, packageStaleness, carriedState)
                      routeCommunicationGeography.ts (DB geography resolver, jurisdictionConfidence)
        ▼
  offline / device    client/src/runtime (contracts, outbox, syncEngine, commsVault, safetyLatch, crypto)
                      adapters/memory.ts (browser/test) · adapters/capacitor.ts (every binding throws NotOnDeviceError)
```

Beside that spine, and consumed by it:

| Concern | Module(s) | Wired? |
|---|---|---|
| HOS rules-as-data | `hos.ts` (selectProfile, computeClocks, determine, tripFeasibility), `hosRuleSeeds.ts`, `hosRouter.ts`, tables `hosRuleProfiles`/`hosRuleLimits`/`hosRuleLimitHistory`/`hosAttestations`/`dutyRecords` | yes |
| HOS clock presentation | `hosClockPresentation.ts` | declared unwired |
| LoadSense / measurement ladder | `loadSense.ts` (legalAxleDetermination, toRoutingVehicleValues), `measurementQuality.ts` (`MEASUREMENT_AUTHORITY_RANK`), `loadSenseProtocol.ts`, `integrationRouter.ts` (`inbound.ingest`, `integration.loadSenseCalibrate/BindGateway`) | yes (ingest); `toRoutingVehicleValues` test-only |
| Facilities | `facilityDirectoryRouter.ts` (28 procs), `facilityCompatibility.ts`, `destinationAcceptance.ts`, `facilityNavigation.ts`, `arcgisImport.ts`, tables `facilities`+children (0139–0143) | yes |
| GPS → proposal | `tripGps.ts` (ingestBreadcrumb → `tripBreadcrumbs` + **pending** `zoneEvents`), `geofence.ts`, `fieldRoute.gps.*` in `routers.ts` | yes |
| Telematics | `telematics.ts`, `telematicsRouter.ts`, `telemetrySnapshots`, `faultCodes`, `drivingEvents`; `spatial.lastPosition` reads `inboundEvents` feed `gps_position` | yes |
| Feeds / advisories (511, DriveBC) | `feedCollector.ts`, `feedIngest.ts`, `feedHttp.ts`, `feedScheduler.ts`, `advisoryImpact.ts`; tables `externalFeedRuns`, `roadAdvisories` (0081) | **built, never started** — no worker job, no router writes the tables |
| Source precedence | `sourcePrecedence.ts` (AUTHORITY_RANK, resolvePrecedence, provisionalRestriction) | declared unwired ("M3's evidence compiler") |
| Approval policy | `routeApprovalPolicy.ts` (assessRouteApproval: FAIL blocking, risk triggers) | declared unwired; `spatial.routeApprove` has an inline FAIL guard instead |
| Jurisdiction | `jurisdiction.ts` (decideJurisdiction over verified boundary polygons) | declared unwired; no boundary layer loaded |
| Phone location gate | `phoneLocationGate.ts`, `monitoringNotice.ts` (0160) | declared unwired ("there is no phone yet") |
| External router adapter | `truckRoutingAdapter.ts` (guardRoutingPreferences, buildTruckRoutingRequest, assessRoutingResult) | declared unwired ("no live feed") |
| Routing source status | `routingSource.ts` — `LEASEOS_ROUTING_PROVIDER` named ⇒ `configured_not_implemented`; nothing ⇒ `not_loaded`; always `determination: "unknown"` | yes (`spatial.routeRequest`, `spatial.routingSourceStatus`) |
| Pre-departure cache / offline classes | `preDepartureCache.ts`, `offlineCapability.ts` | declared unwired |
| Trip passport / baseline / binder / billing projection | `tripPassportPackage.ts`, `siteBaseline.ts`, `safetyBinder.ts`, `tripBillingProjection.ts` (B23.0) | declared unwired |
| Customer projection | `customerProjections.ts` (operationalState, projectReadiness, noticeFor) via `portalRouter.ts` externalProcedures | yes |
| Google Maps template | `map.ts` | dead; `routingSource.ts` header says a guard pins no Google Maps endpoint in server code |

The census that makes "wired" a checked fact rather than a claim is `server/engineReachability.test.ts`
(`DECLARED_UNWIRED`, 55 entries, pinned). Adding an engine nobody reaches fails it unless declared.

---

## 3. Schema — the tables this subsystem owns, and which ones nothing reads

Line numbers are `drizzle/schema.ts`. "Scope" is the tenant column; **almost none of these tables has
one** (see §8 item 15).

### 3.1 Route, road, structures, vehicle

| Table | Line | Created | Read/written by | Status |
|---|---|---|---|---|
| `routeContexts` | 78 | 0002 | `fieldRoute.routeContext.*` (routers.ts) | legacy v1 context; showcase-era |
| `routeDecisions` | 849 | 0007 | `fieldRoute.routeDecisions.*` — "manual — not authority data" | legacy; int dimensions, `riskLevel` |
| `routeRequests` | 5814 | 0058 | `spatial.routeRequest` | records the honest UNKNOWN from `routingSource` |
| `routeEvidenceEntries` | 1659 | 0012 (+0166, +0167) | `spatial.routeEvaluateSegments` writes; `spatial.routeApprove` reads FAILs | **canonical evidence ledger** |
| `routeApprovals` | 6151 | 0072 (+0078 buildRef, +0165 coverage, +0167 evaluationRef) | `spatial.routeApprove`, `spatial.routeApprovalCheck`, `readinessComposer` | **canonical approval** |
| `roadSegments`, `segmentAttributes`, `bridges`, `importBatches`, `datasetConfirmations` | 1587–1659 | 0012 | `bridges` read by `spatial.routeEvaluateSegments`; the rest imported by no server file | legacy road model (B12) |
| `roadRestrictions` | 5790 | 0058 | `spatial.restrictionRecord/Verify`, `routeEvaluateSegments` (windowed via `applicableRestrictions`) | **canonical restriction rows** (16 checkKeys incl. `seasonal_closure`, `road_ban_level`, `dg_corridor`) |
| `structures` | 6117 | 0072 | `spatial.structureRecord/Verify`, `routeEvaluateSegments` | **canonical structures** (posted vs rated kept apart) |
| `vehicleProfiles` | 5774 | 0058 | `spatial.vehicleProfileSet/Verify`, `routeEvaluateSegments` | **canonical unit envelope** (`axleGroupsJson`, source, verification) |
| `atsLegalSubdivisions`, `accessRoadSegments`, `geoImportRuns` | 5992–6048 | 0070 | `geoRouter` | **canonical ATS grid + AB access roads** |
| `siteAccessPoints`, `siteAccessConfirmations` | 6070–6100 | 0071 | `geo.accessPropose/Decide/ConfirmPassage/ForLsd` | **canonical lease entrance** |
| `roadGraphBuilds`, `roadGraphNodes`, `roadGraphEdges` | 6195–6233 | 0073 (+0164) | `geo.graphBuild`, `geo.routeCompute`, `spatial.routeApprove` (build/segment check), `routeCommunicationGeography` | **canonical candidate graph** |
| `locationIdentities` | 400 | 0004 (+0058) | `spatial.location*`, `geo.locationVerifyFromGrid` | lease/well identity, `coordinateSource` ats_v41/field_gps/theoretical_grid |

### 3.2 Communications (0074–0076)

`radioChannels` (serviceStatus active/retired), `companyRadioAuthorizations` (provincesJson, licence
expiry), `unitRadioCapabilities` (configurationHash), `roadRadioAssignments` (8 authority tiers,
posted_sign first), `radioSignObservations` (photoHash, pending/confirmed/rejected),
`communicationCoverage`, `communicationPlans` (fingerprintHash), `communicationPolicies`
(proposed/approved), `communicationPackages` (manifestHash, dependencyHash, routeApprovalRef,
status current/superseded/stale), `communicationPackageDownloads`. All served by `commsRouter.ts` (26
procedures). This is the only production offline package in the tree.

### 3.3 HOS

`dutyRecords` (0008), `dailyLogs` (0010 — **imported by no server file**), `hosRuleProfiles` /
`hosRuleLimits` (0077, +0119/0120/0124), `hosRuleLimitHistory` (0120), `hosAttestations` (0155,
`orgRef`). No log-amendment table, no certification/signature table for a daily log, no sleeper-berth
capability on `units`.

### 3.4 LoadSense and measurement

`measurementDevices` (financialEntityId), `calibrationEvents`, `measurementDeviceAssignments` (0037),
`loadSenseCalibrationModels`, `loadSenseGatewayBindings` / `loadSenseGatewayFrames` (orgRef NOT NULL),
`loadSenseWeightSnapshots` (measurementSource ladder, `legalDetermination*` 0159), `loadSenseAxleWeights`,
`loadSenseScaleReconciliations` (**never imported**), `materialDensityProfiles` (**never imported**),
`calibrationSweeps` / `calibrationSweepFindings` (0163).

### 3.5 Facilities (0139–0143 over the P3 `facilities` table)

`facilities` (orgRef; coordinatePrecision, disposition, tdgRequired), `facilitySourceLicences`,
`facilityCapabilities` (acceptanceStatus verified/confirmation_required/not_accepted/unknown),
`facilityEvidence` (licenceKey, reviewState), `facilityAliases`, `loadFacilityAssessments` (immutable,
engineVersion, inputSnapshot), `wasteStreamVocabulary` (candidates until verified against Directive
047/058), `facilityOperatingHours`, `facilityCallAheads`, `facilityWaitReports`, `facilityImportRuns`.

### 3.6 Conditions, weather, feeds

`roadAdvisories` + `externalFeedRuns` (0081, **never written**), `weatherObservations` +
`roadHazardObservations` (0049; written by `closeout.weatherObserve` / `closeout.roadHazardReport`,
projected to the customer without coordinates).

### 3.7 Registries and readiness

`externalDataSources` (0024, +0080 review columns), `externalDatasetImports` / `externalFeedFetches`
(0024, **never imported**), `dispatchEligibilityChecks` (fingerprint, routeApprovalRef 0075,
capabilitiesJson 0152, automationPolicyJson 0153), `dispatchOverrides`, `dispatchEnforcementSettings`,
`capabilityEntitlements` / `automationPolicies` (0153), `complianceRequirements` / `compliancePacks` /
`companyPackActivations` (0036/0037).

### 3.8 Does not exist on `main`

- `movementPermits`, `movementPermitDeterminations` — **absent** (they exist only on the orphan
  v23.29 lineage, §9). Permits on `main` are the `permitRefs: string[]` input of `spatial.routeApprove`,
  hashed into `permitSet`, and `readinessComposer.ts:403` supplies **`permitRequired: false`** as a
  literal for every job.
- `trailers` — no table; `trailerId` is a bare int on three tables.
- a TDG/dangerous-goods table — `loadProfiles.unNumber/properShippingName/dgClass/packingGroup/classificationStatus` columns only.
- a road-ban or seasonal-weight table — `roadRestrictions.checkKey ∈ {seasonal_closure, road_ban_level}` rows only.
- a trip/offline route package table — only `communicationPackages`.
- a log-amendment, log-certification, or sleeper-berth table.
- province boundary polygons (`statcan_boundaries` is registered and unverified; `jurisdiction.ts` waits for a layer).

---

## 4. API surface — procedures and the permission each is gated by

`roleProcedure("<name>")` maps a procedure name to a Permission through
`OPERATIONAL_PROCEDURE_PERMISSIONS` in `server/_core/recordsAuthorization.ts`. `*` = in
`SENSITIVE_PERMISSIONS` (fail closed).

| Router (mount) | Procedures → permission |
|---|---|
| `spatial` (15) | locationRegister → spatial.location.manage; locationVerify → spatial.location.verify*; locationGet, routeApprovalCheck, routingSourceStatus, lastPosition → spatial.read; vehicleProfileSet → spatial.vehicle.manage; vehicleProfileVerify → spatial.vehicle.verify*; restrictionRecord → spatial.restriction.record; restrictionVerify → spatial.restriction.verify*; routeEvaluateSegments, routeRequest → spatial.route.evaluate; structureRecord → spatial.structure.record; structureVerify → spatial.structure.verify*; **routeApprove → spatial.route.approve\*** |
| `geo` (14) | sourceReview → geo.source.review*; atsImportTownship, accessRoadsImport → geo.import*; lsdLocate, positionToLsd, accessForLsd, corridorEvaluate, **routeCompute**, coverage → geo.read; accessPropose → geo.access.propose; accessDecide → geo.access.decide*; accessConfirmPassage → geo.access.passage; graphBuild → geo.graph.build*; locationVerifyFromGrid → geo.locationVerifyFromGrid* |
| `comms` (26) | channelSeed → comms.channel.manage; channelVerify, channelRetire → comms.channel.verify*; authorizationRecord → comms.authorization.manage; authorizationVerify → comms.authorization.verify*; unitCapabilitySet → comms.unit.capability; assignmentRecord, coverageRecord → comms.assignment.record; assignmentVerify → comms.assignment.verify*; signObserve → comms.observation.record; signDecide → comms.observation.decide*; planForPath → comms.plan.compute; policyPropose → comms.policy.manage; policyApprove → comms.policy.approve*; oosPolicyPropose/Approve → oos.policy.*; packageBuild → comms.package.build; packageFetch, packageAcknowledge → comms.package.fetch; channelList, assignmentsForSegments, signQueue, transmitCheck, planGet, policyCurrent, packageStatus → comms.read |
| `hos` (10) | recordScannedLog → hos.recordScannedLog; attestHours → hos.attest; profileSeed → hos.rule.manage; limitVerify, limitPromote, profileVerify → hos.rule.verify*; profileList, profileFor, status, tripFeasibility → hos.read |
| `fieldRoute` inline | gps.submitBreadcrumb → gps.submit; gps.breadcrumbs/pendingZoneEvents/zoneEvents → gps.read; **gps.confirmZoneEvent → gps.confirm\***; dutyRecords.list/create → hos.read/hos.write; routeContext.* → route.read/write; routeDecisions.create → route.decide*; trips.*, tripStops.* → trip.read/write; operatingZones.* → reference.read/write |
| `dispatch` (8) | readiness, enforcementGet → dispatch.read; evaluate → dispatch.evaluate; overrideRequest → dispatch.override.request; overrideGrant → dispatch.override.grant*; award → dispatch.award*; enforcementSet → dispatch.enforcement.manage*; whatAmIMissing → dispatch.readiness_own |
| `readiness` (2) | forShift, forTime → a second readiness system (`shiftReadiness.ts`), does not call `composeReadiness` |
| `facilityDirectory` (28) | read: licencesList, vocabularyList, arcgisPresets, arcgisRuns, lsdFind, features, get, assessments, nearby, driverView, exportCsv, exportGeoJson → facility.directory.read; review: vocabularyVerify, seedLeads, seedBrief, arcgisInspect, arcgisImport*, hydrovacImport, duplicates, evidenceReview, coordinateVerify, capabilitySet → facility.directory.review; write: hoursSet, evidenceRecord, assessLoad → facility.directory.write; report: callAheadRecord, waitReport → facility.directory.report |
| `telematics` (7) | unit, faults, reviewQueue → telematics.read; faultAcknowledge, faultClear → telematics.fault.acknowledge*; eventReview → safety.event.review; videoView → safety.video.read |
| `integration` / `inbound` | loadSenseCalibrate, loadSenseBindGateway → integration.client.manage*; `inbound.ingest` (integrationProcedure, sensitive) accepts `loadsense_weight`, `gps_position`, … |
| `requirement` / `calibration` | calibrationSweep → loadsense.calibration.sweep; packActivate → compliance.pack.manage; workAuthorization → compliance.work.evaluate; deviceRegister, eventRecord → calibration.record; impact → calibration.impact |
| `closeout` | weatherObserve, roadHazardReport → closeout.* (the only writers of weather/hazard observations) |
| `device` / `sync` | enroll, activate, rotateKey, revoke, verifySeal → device.*; receivePackage, resolveConflict → sync.* |

No Permission string exists for `permit`, `tdg`, `advisory`, `weather`, `radio`, `lsd`, `ats` or
`map` as such.

**Two different route-evaluation doors, unequal in what they read.** `geo.routeCompute` builds
segments only through `legalLand.roadAsSegment()` (surface + silent checks) and never consults
`roadRestrictions`, `bridges` or `structures`; it persists no evidence and mints no `evaluationRef`.
Only `spatial.routeEvaluateSegments` merges verified restrictions, bridges and structures, takes the
vehicle from `vehicleProfiles`, and writes `routeEvidenceEntries` under an `evaluationRef`. The
production path is therefore: `geo.routeCompute` (candidate) → `spatial.routeEvaluateSegments`
(compliance) → `spatial.routeApprove` (person) → `spatial.routeApprovalCheck` (staleness).

---

## 5. Production wiring — the facts that decide each capability's class

- **Worker.** `server/_core/productionWorker.ts` runs one outbox drain with one custom handler
  (`enforcement`). There is no scheduled job for feeds, advisories, route re-checks, comms package
  staleness or GPS. `feedScheduler.tick` has no caller. No `setInterval` in non-test server code.
- **Routing source.** `LEASEOS_ROUTING_PROVIDER` unset ⇒ `not_loaded`; set ⇒
  `configured_not_implemented`. `spatial.routeRequest` always records `determination: "unknown"`.
  The only computed path in production is `geo.routeCompute` over an imported `roadGraphBuilds` build
  (coordinate-snap over `accessRoadSegments`), which works only inside imported areas.
- **OSM province graphs.** `osmImport` / `osmTopology` / `osmLoadPlan` / `osmLoad` are pure, validated
  on real extracts (Alberta 508,807 routable ways; Edmonton slice end to end) and **unwired**: no
  loader writes `roadGraphEdges` from an OSM extract, and the three `geofabrik_osm_*` standing keys
  in `legalLand.ROAD_SOURCE_STANDING` have **no row in `externalSourceSeeds.ts`** (the registry has a
  single `osm` key). `osmLoad.ts` and `osmLoadPlan.ts` both define `planLoad`/`LoadPlan`.
- **Approval FAIL guard.** `spatial.routeApprove` refuses when `routeEvidenceEntries` holds any
  `result = "fail"` for the route's `segmentIds` — not scoped to `evaluationRef`, unit or vehicle, so
  any historical FAIL on a segment blocks every later approval over it. The caller-supplied
  `dispatchStatus` string is still accepted and only the literal `"blocked"` is refused.
- **Staleness and permits.** `routeApprovalCheck` recomputes dependencies with
  `permitRefs: []` and `carryOver: approved`, so `permitSet` and `requiredChecks` are **carried, not
  recomputed** (`spatialRouter.ts:48,52,323`). A permit change can never stale an approval today,
  because there is no permit record to read.
- **Readiness inputs.** `readinessComposer.ts:403` `permitRequired: false` (literal);
  `:532,:599` `hoursAvailableMinutes: null` (computed HOS clocks never reach dispatch; only
  `hosAttestations` do). `dispatchReadiness.ts:461` maps route `warning` (legal/feasible **UNKNOWN**)
  to `route_review` with severity `review` — a naming loss, not a rounding-up (the verdict stays
  non-eligible), but UNKNOWN ceases to be visible as UNKNOWN at the dispatch layer.
- **GPS.** `tripGps.ingestBreadcrumb` writes `tripBreadcrumbs` and a `zoneEvents` row born
  `pending`; `gps.confirmZoneEvent` (sensitive) is the only confirmation door. The rule holds by
  construction of the two write paths; no structural guard (a test that scans production writers)
  exists.
- **Customer projection.** `customerProjections.ts` carries no coordinate or driver-identity field
  (regex-pinned by `phoneLocationGate.test.ts`). `portalRouter.ts` job board, chain of custody, field
  ticket view and observations project no coordinates (read at `:279-287`, `:166-172`, `:477-480`,
  `:578`), and `fieldTicketSign` accepts the **customer signer's** own device GPS as signature
  evidence, never projected back. No test pins the portalRouter output keys.

---

## 6. Client and native runtime

- **Map libraries installed: none.** No `maplibre-gl`, `leaflet`, `mapbox-gl`, or `@capacitor/*`
  package. `@types/google.maps` is a devDependency. `client/src/components/Map.tsx` loads Google Maps
  through a proxy and is imported only by quarantined `client/src/showcase/*` pages (mutations refused
  by `showcaseGuardLink`).
- **Production pages touching this subsystem:** `/map` (`authoritative/Surfaces.tsx`, text-only
  routing-source status), `/route/preview` (`RoutePreview.tsx` → `geo.routeCompute`, read-only, no
  map, states "path_only … is not a permission to drive it"), `/disposal-finder`, `/comms/package`,
  `/comms/status`, `/comms/transmit`, `/hos-verification`.
- **Native runtime:** `client/src/runtime/adapters/capacitor.ts` — `capacitorStore`, `capacitorKeystore`,
  `capacitorVault` throw `NotOnDeviceError` unconditionally; GPS, camera, biometrics and notifications
  exist only as names in `NATIVE_ONLY_CAPABILITIES`. No `navigator.geolocation` call anywhere in
  `client/src`. `adapters/memory.ts` encrypts file bytes in memory only ("Nothing here is at-rest
  protection"); capture metadata and GPS fixes are plaintext in memory. `runtimeBootstrap.ts`
  `mountBrowserFallbackRuntime` is called by no client file.
- **Encrypted local map/package storage:** does not exist. `commsVault.ts` stores a carried comms
  package in the (memory) `FileVault`, re-hashes on read, refuses tamper — the right pattern, on an
  adapter that has no device implementation.

---

## 7. Existing safety tests that protect the invariants (pointer list)

| Invariant | Where it is pinned |
|---|---|
| UNKNOWN ≠ PASS, no data ≠ no restriction | `_core/routeEvaluation.test.ts` "unknown is never treated as clear", `_core/roadSourceNeutrality.test.ts`, `legalLand.test.ts`, `roadGraph.test.ts` (DB), `_core/dispatchReadiness.test.ts` |
| FAIL not approvable | `_core/routeApprovalPolicy.test.ts` (policy core; procedure pinned by **source regex**), `structures.test.ts` (caller says blocked), `_core/dispatchAward.test.ts` |
| REVIEW ≠ PASS | `_core/regulatoryDataDiscipline.test.ts`, `_core/routeEvaluation.test.ts`, `_core/interEngineStatus.test.ts`, `hosAttestation.test.ts` |
| Route fingerprint / staleness | `structures.test.ts`, `communications.test.ts` (DB), `commRoute.test.ts`, `commsDispatch.test.ts`, `commPackage.test.ts`, `_core/routeEvaluationIdentity.test.ts` |
| HOS selection / no single remaining / sleeper | `hos.test.ts`, `hosAttestation.test.ts`, `scopeGuard.db.test.ts` |
| Radio authorization / retired service | `commRoute.test.ts`, `commsDispatch.test.ts`, `commPackage.test.ts`, `communications.test.ts` |
| Source precedence | `commRoute.test.ts`, `_core/sourcePrecedence.test.ts`, `structures.test.ts`, `_core/roadSourceNeutrality.test.ts` |
| Facility acceptance | `_core/facilityCompatibility.test.ts`, `_core/facilityNavigation.test.ts`, `facilityDirectory.db.test.ts`, `destinationAcceptance.db.test.ts` |
| GPS boundary | `operationalApiAuthorization.test.ts`, `operationalTruth.test.ts`, `_core/geofence.test.ts` (confidence only lowers) |
| Tenant isolation | `tenantScopeSpatial.db.test.ts`, `tenantIsolation.test.ts` (pins the 19 scoped tables; route/road/comms/HOS tables are **not** among them, by design of the pin) |
| Offline package | `commPackage.test.ts`, `commsVault.test.ts`, `_core/preDepartureCache.test.ts`, `offlineCapability.test.ts`, `safetyLatch.test.ts` |
| LoadSense ladder / axle | `_core/loadSense.test.ts`, `_core/legalAxleDetermination.test.ts`, `loadSenseAuthenticatedProjectionBoundary.test.ts` |
| Readiness fingerprint | `_core/dispatchAward.test.ts`, `dispatchEnforcement.test.ts`, `dispatchGate.test.ts`, `commsDispatch.test.ts` |
| Regulatory literals | `_core/regulatoryDataDiscipline.test.ts` fails on any four-digit literal in the evaluator |
| Reachability census | `server/engineReachability.test.ts` |

Missing safety tests are enumerated in `GAP_ANALYSIS.md` §5.

---

## 8. Overlaps and duplicate concepts — which one is canonical

| # | Overlap | Canonical | Disposition |
|---|---|---|---|
| 1 | `routeContexts` (0002), `routeDecisions` (0007) vs `routeEvidenceEntries` + `routeApprovals` | **routeEvidenceEntries + routeApprovals** | legacy pair stays read-only for the showcase; no new writer; retire in a later cleanup, not here |
| 2 | `roadSegments`/`segmentAttributes`/`bridges` (0012) vs `accessRoadSegments` + `roadGraphEdges` + `roadRestrictions` + `structures` | **the 0058/0070/0072/0073 set** | `bridges` is still read by `routeEvaluateSegments`; fold its two live columns into `structures` reads when a checkpoint touches that procedure; never write `bridges` again |
| 3 | `segmentAttributes` vs `roadRestrictions` | **roadRestrictions** | — |
| 4 | vehicle dimensions: `vehicleProfiles` vs `units.weightKg/axles/dimensions` vs inline on `routeDecisions` | **vehicleProfiles** (measured, sourced, verified) | `units.*` stays descriptive; never a routing input |
| 5 | source registries: `externalDataSources`, `facilitySourceLicences`, `knowledgeSources`, `importBatches.licenceNotes` | **externalDataSources** for imports/feeds; `facilitySourceLicences` for facility evidence caching; `knowledgeSources` for assistant passages | three gates for three questions (v23.11 finding); do not merge; do register the `geofabrik_osm_*` keys |
| 6 | import/fetch logs: `importBatches`, `externalDatasetImports`, `externalFeedFetches`, `externalFeedRuns`, `geoImportRuns`, `facilityImportRuns` | `geoImportRuns` (geo), `externalFeedRuns` (feeds), `facilityImportRuns` (facilities) | `importBatches`, `externalDatasetImports`, `externalFeedFetches` are unused; do not add a seventh |
| 7 | facility hours/acceptance: `facilities.operatingHours`/`acceptedMaterials` vs `facilityOperatingHours`/`facilityCapabilities` | **the child tables** | — |
| 8 | HOS records: `dutyRecords` vs `dailyLogs` (unused) | **dutyRecords** for clocks; `dailyLogs` is the natural home for certification/amendment state once wired | do not add a third |
| 9 | readiness: `readinessComposer`+`dispatchReadiness` vs `shiftReadiness` (`readiness.forShift/forTime`) | **readinessComposer** (owner decision D-06 pending per the compliance design on `claude/leaseos-compliance-survey-5faxe8`) | route work binds only to the composer |
| 10 | packages: `syncPackages` (evidence) vs `communicationPackages` (comms) | both stay; a trip route package **extends the commPackage sealing pattern** and links by `routeApprovalRef` | no third package vocabulary |
| 11 | OSM plan: `osmLoad.planLoad` vs `osmLoadPlan.planLoad` | to be reconciled (v23.29 lineage deleted `osmLoadPlan.ts` and moved the header/format-version into `osmLoad.ts`) | one file after RI-1 |
| 12 | helpers: `windowState/inForce` ×3, `haversineMetres` ×2, `pointInRing` ×2 | leave; cheap and test-pinned separately | not a checkpoint |
| 13 | routing verdict vocabularies: `routeEvaluation.DispatchStatus` (clear/warning/review/blocked), `truckRoutingAdapter.RouteVerdict` (ready_to_approve/review/blocked/unknown), `dispatchReadiness.EligibilityVerdict`, `interEngineStatus` | **routeEvaluation** for the route; **interEngineStatus** at the boundary | adapters, never a fifth word |
| 14 | fingerprint hashers: `structures.fingerprintHash`, `commPackage.hashOf`, `dispatchAward.computeEligibilityFingerprint` | each owns its domain; all canonical-JSON sha256 | — |
| 15 | tenant scope keys: `orgRef` (varchar 64 / 40) vs `financialEntityId`; route/graph/comms/HOS-rule/source tables unscoped | shared reference data (roads, structures, rules, channels) is unscoped **on purpose** (`tenantScopeSpatial.db.test.ts` header); unit-bound rows scope through `coreRecordOwnership` | permits, packages and approvals must carry `orgRef` |

---

## 9. The orphan v23.29 lineage — a fact the plan must not ignore

`origin/claude/mobile-hardware-scanner-mzp1e1-v2327` is at **v23.29** and has **no merge base** with
`main` (229 files differ; it re-imports a v23.25 tree and continues). It contains work the prompt
names as "existing":

| On v23.29 only | Files |
|---|---|
| `movementPermits`, `movementPermitDeterminations` | `drizzle/0168_movement_permits.sql`, `server/_core/movementPermits.ts` (`resolvePermitStatus`, `permitCoversMoment`, `permitStatusForJob`), `server/movementPermitRouter.ts` (`statusFor`, `record`, `determine`, `verify`, `listForJob`), `readinessComposer.ts` reads `permitStatusForJob` instead of the literal, `dispatchReadiness.ts` adds `permit_requirement_unknown` (unknown severity, manager-overridable) |
| print audit | `0169_print_audit.sql`, `fieldPrinters`, `fieldPrinterAssignments` |
| page scanner | `scanSession.ts`, three more `NotOnDeviceError` bindings (document scanner, on-device OCR, barcode) |
| `osmLoadPlan.ts` deleted; format version and `ExtractHeader` moved into `osmLoad.ts` | resolves overlap #11 |

It **lacks** main's post-import work: the six security fixes (`a333909`), `0168_retire_storage_capability_urls`,
the login/portal chooser, `env.ts` validation, and the `sessionAppId` fixes.

**Resolution rule for this programme:** the permit model on v23.29 is the canonical design (it reuses
`dispatchReadiness`, keeps conditions as verbatim text, records the determination as a human act,
carries `orgRef`, and its migration comment names the exact defect on `main`). It must be **ported onto
`main`** under the next free slot at merge time (never as `0168`), with its tests, rather than
re-designed. Nothing else from that lineage is in scope for Route Intelligence.

---

## 10. Parallel designs in flight that touch the same seams

| Branch / doc | Overlap | How this plan treats it |
|---|---|---|
| `claude/leaseos-compliance-survey-5faxe8` — `docs/compliance/unified-compliance-engine-design.md` | C6 "routing integration": permits as rows in the fingerprint, LoadSense weights into `vehicleValues`, eager staleness, wiring `routeApprovalPolicy` + `advisoryImpact`; findings R-6 (`route_approval_stale` can never be awarded), R-8 (`dispatchEnforcementService` recomputes without `routeApprovalRef`), R-10 (second readiness system) | RI-4/RI-5 below **are** C6; one checkpoint, not two |
| SPINE moratorium (`docs/register/SECRETARY_SPINE_MORATORIUM.md`, quoting a plan in the sibling repo) | "no new engines until this path is wired"; `routeApprovalPolicy`, `sourcePrecedence`, `truckRoutingAdapter`, `preDepartureCache`, `offlineCapability`, `phoneLocationGate`, `siteBaseline`, `tripPassportPackage`, `jurisdiction` are on the unwired list | every RI checkpoint is a **resolver, a router over an existing engine, or a deletion**; none adds an engine beside an existing one |
| `docs/hybrid-seam/*` (HS1–HS5) | HS1 `capabilities()` matrix; HS3 `sync_commands` at "0169" | RI-9/RI-10 depend on HS1; the slot number in HS_CONTRACTS is stale |
| `docs/facility-map/*` v7 | facility map UI left behind; API complete | RI-8 reuses `facilityDirectory.*`; no second facility registry |
| `docs/product/DISPATCH_ASSIGNMENT_MODEL_DESIGN.md` (branch) | `0169`–`0171` | slot contention only |
