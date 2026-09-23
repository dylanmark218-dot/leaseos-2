# LeaseOS Route Intelligence — unified design (T0)

Designed against `main` = `0060690` (v23.25) and the code that actually exists there. Every contract
below names the existing type or table it extends; a name from the prompt is kept only where nothing
equivalent exists. Nothing in this document is implemented by T0.

---

## 1. The one picture

Mapping is the centre; every other concern is a **source of evidence about a segment** or a
**consumer of a verdict about a route**. The spine already exists in the tree (see
`CURRENT_ARCHITECTURE.md` §2); the design adds contracts at four seams and wires engines that are
written and idle.

```
                     ┌─────────────────────────────────────────────────────────┐
                     │  EVIDENCE SOURCES (each with standing, version, licence) │
  externalDataSources│  ATS grid · AB access roads · OSM (AB/BC/SK) · authority │
  (gate: cleared?)   │  restrictions · structures · road bans · permits · 511 / │
                     │  DriveBC advisories · field observations · radio signs · │
                     │  coverage · weather · facility evidence · LoadSense      │
                     └───────────────┬─────────────────────────────────────────┘
                                     │  SegmentAttribute[] per segment, precedence-resolved
                                     ▼
   ┌──────────────┐    ┌──────────────────────────┐    ┌──────────────────────────────┐
   │ CANDIDATES   │    │ CONSTRAINT CONTEXT       │    │ TRANSPORT PROFILE            │
   │ roadGraph    │───▶│ roadRestrictions ·       │◀───│ vehicleProfiles × n ·        │
   │ (Dijkstra)   │    │ structures · bans ·      │    │ LoadSense determination ·    │
   │ osm* loader  │    │ permits · advisories ·   │    │ loadProfiles (DG lines) ·    │
   │ ext adapter  │    │ requiredChecks           │    │ configurationFingerprint     │
   └──────┬───────┘    └────────────┬─────────────┘    └──────────────┬───────────────┘
          │ RouteCandidateSet        │                                 │
          └──────────────┬───────────┴─────────────────────────────────┘
                         ▼
              routeEvaluation.evaluateRoute  ──▶  routeEvidenceEntries (evaluationRef)
                         │  RouteVerdict: legal / feasible / preferred × pass|fail|review|unknown
                         ▼
              spatial.routeApprove (a person; FAIL is nobody's to sign) ──▶ routeApprovals (fingerprint)
                         │
        ┌────────────────┼──────────────────────┬──────────────────────┐
        ▼                ▼                      ▼                      ▼
  readinessComposer   commRoute plan        RoutePackage (sealed)   customer projection
  (dispatch verdict)  (transmit gates)      → device vault          (no coordinates)
        ▲                                                             
        │ staleness: fingerprint mismatch ⇒ stale ⇒ AT_RISK ⇒ new candidates ⇒ a person again
        └──── tripBreadcrumbs → zoneEvents(pending) · deviation proposals · advisories
```

**The routing engine only determines which roads connect.** `roadGraph.shortestPath` and any
external adapter return a *candidate*; `routeEvaluation` decides; a person approves; nothing else
promotes.

---

## 2. Invariants, and the code that holds each

| Invariant | Held by today | Extended by this design |
|---|---|---|
| UNKNOWN ≠ PASS | `routeEvaluation` silent checks, `hos.determine`, `commRoute` gates, `interEngineStatus` never rounds up | `RouteIntelligenceReadiness` keeps `UNKNOWN` as a first-class verdict through dispatch (today route `warning` becomes `route_review`) |
| REVIEW ≠ PASS | unverified-pass ⇒ review (`regulatoryDataDiscipline.test.ts`) | unchanged; permit/advisory evidence enters at `unverified`/`operator_supplied` confidence and can only raise review |
| NO DATA ≠ NO RESTRICTION | absent attribute ⇒ `unknown`; `permitCoversMoment(null window) ⇒ null` (v23.29) | route package states per axis what it does **not** carry; readiness DG flag read from structured load, never regex |
| ROUTE EXISTS ≠ ROUTE LEGAL | `geo.routeCompute` returns `path_only`; `roadGraph.ts` header | `RouteCandidateSet` has no verdict field at all; approval refuses a candidate with no `evaluationRef` when policy requires one |
| MAP PIN ≠ FACILITY ACCEPTANCE | `facilityCompatibility`, coordinate precision, `loadFacilityAssessments` | disposal routing composes *acceptance* and *route* as two verdicts; the package carries both |
| RADIO FREQUENCY KNOWN ≠ AUTHORIZED TO TRANSMIT | `commRoute.transmitAuthorization`, retired service excluded from package | reminder evidence `promptDelivered` / `driverConfirmed` / `transmissionVerified` as three tri-states, never one boolean |
| PERMIT UPLOADED ≠ PERMIT VERIFIED | v23.29 `movementPermits.verificationStatus` + separate `determination` | structured conditions only via document → proposal → human verification → active row |
| GPS EVENT ≠ CONFIRMED JOB EVENT | `zoneEvents.state = pending`, `gps.confirmZoneEvent` sensitive | deviation and passage proposals reuse the same pending row; a structural test scans writers |
| HOS CLOCK ≠ VERIFIED HOS COMPLIANCE | `HosDetermination.verdict` UNKNOWN while a limit is unverified; no single hours-remaining | dispatch consumes the **determination**, never a remaining figure; ELD boundary stated as a type |
| A known FAIL cannot be signed away | `spatial.routeApprove` evidence guard; `routeApprovalPolicy` "blocking, reported first" | guard scoped to the named `evaluationRef`; `routeApprovalPolicy` becomes the one place the rule lives |

---

## 3. What is reused, what is extended, what is new

| Concern | Reuse (unchanged) | Extend (in place) | New |
|---|---|---|---|
| Candidate graph | `roadGraph.ts`, `roadGraphBuilds/Nodes/Edges` | `roadGraphEdges` gains a direction; OSM loader writes builds; `geofabrik_osm_*` registered | `RouteCandidateProvider` interface (over `shortestPath` and `truckRoutingAdapter`) |
| Evaluation | `routeEvaluation.ts`, `routeEvidenceEntries`, `evaluationRef` | `spatial.routeEvaluateSegments` reads LoadSense determination and permits; `geo.routeCompute` stops evaluating | — |
| Constraint context | `structures.ts` (`RouteDependencies`, `applicableRestrictions`), `roadRestrictions`, `structures` | `RouteDependencies` gains `advisorySet`; `permitSet` from permit rows; `sourcePrecedence` wired at the compile step | `RouteConstraintContext` (a named bundle of what exists) |
| Transport profile | `vehicleProfiles`, `configurationFingerprint`, `loadFingerprint`, `MEASUREMENT_AUTHORITY_RANK`, `legalAxleDetermination` | `vehicleProfiles` gains registered weight, sleeper, tire capacity, wheelbase/overhang (nullable, sourced, verified like its siblings) | `TransportProfile` derived type (never a table) |
| Approval | `routeApprovals`, `spatial.routeApprove/ApprovalCheck`, `routeApprovalPolicy.ts` | approve marks the prior row `superseded`; policy engine wired; FAIL guard by `evaluationRef` | — |
| Permits | v23.29 `movementPermits` + determinations + router | ported to `main`; fingerprint reads rows | later: `movementPermitConditions` |
| HOS | `hos.ts`, rule registry, `hos.status`, `hos.tripFeasibility`, `hosAttestations` | readiness consumes determination; `dutyRecords.source` enum; `vehicleProfiles.sleeper*` | `dailyLogAmendments` (append-only), discrepancy reviews via Exception Centre |
| TDG | `loadProfiles.*` DG columns, Academy TDG expiry, `compliancePassport.dangerousGoodsAssist` | composer reads `loadProfiles`; `emergencyPlanOnFile`/`tdgDocumentPrepared` from records | `dangerousGoodsLines` (shared with the compliance design's C5) |
| Comms | `commRoute`, `commPackage`, all 0074–0076 tables | coverage import; reminder evidence | `communicationReminderEvents` (tri-state evidence) at the device checkpoint |
| Offline | `commPackage` seal/staleness/carried; `commsVault`; `preDepartureCache.manifestFor`; `syncPackages` | — | `routePackages` (+downloads) modelled on `communicationPackages` |
| GPS | `tripGps`, `geofence`, `zoneEvents` | `zoneEvents.eventType` gains `route_deviation` / `entrance_passage` proposals | map-matching function over `roadGraphEdges` (pure, in `roadGraph.ts` or beside it, not a new engine family) |
| Readiness | `readinessComposer`, `dispatchReadiness`, `interEngineStatus`, `readinessCapabilities`, `degradationSuite` | route/HOS/permit/TDG inputs become facts, not literals; UNKNOWN preserved | `RouteIntelligenceReadiness` = the route slice of `ReadinessInput` named as a type |
| Customer | `customerProjections.ts`, `portalRouter` | job board gains stage/ETA/progress from business events only | `CustomerTripProjection` type (spec §7.1) |
| Live conditions | feed engines, `roadAdvisories`, `advisoryImpact` | worker job started; DriveBC normalizer; 511 behind the rights gate | — |

---

## 4. Canonical contracts

Type sketches are TypeScript over the existing exports. File placement follows the tree's habit: pure
contracts in `server/_core/`, DB composition in `server/`.

### 4.1 `RoutePlanningRequest` — extends `routeRequests` + `CompilerInput`

`routeRequests` (0058) already records who asked for what and answers UNKNOWN when no source is
loaded. It stays the persisted request. The planning request is the in-memory input to candidate
generation, built from records rather than typed by a caller:

```ts
// server/_core/routePlanning.ts (new file, no new engine: it composes existing types)
import type { CompilerInput, RequiredCheck } from "./routingCompiler";
import type { LngLat } from "./geoImport";

export type RouteEndpoint =
  | { kind: "location"; locationIdentityId: number; accessRef?: string | null }   // lease/well + confirmed entrance
  | { kind: "facility"; facilityId: number }                                       // verified coordinates only
  | { kind: "position"; position: LngLat; source: "device_gps" | "dispatcher_typed" };

export type RoutePlanningRequest = {
  requestRef: string;                 // = routeRequests.requestRef
  orgRef: string | null;
  jobId: number | null; tripId: number | null;
  unitIds: number[];                  // tractor first, trailers after — the combination
  loadId: number | null;
  origin: RouteEndpoint; destination: RouteEndpoint; via: RouteEndpoint[];
  departAt: Date;                     // the instant restrictions, bans, permits and HOS are windowed at
  requiredChecks: RequiredCheck[];    // from compileConstraintProfile, never typed by a caller
  jurisdictionHint: string | null;    // a hint; jurisdiction.ts decides, or UNKNOWN
  compiler: CompilerInput;            // existing
};
```

Persisted only through `routeRequests` (extended with `orgRef`, `departAt`, `originEndpointJson`,
`destinationEndpointJson` when RI-2 lands; one ALTER).

### 4.2 `TransportProfile` — derived over `vehicleProfiles`, never a table

A tractor–trailer combination is a set of units. Each unit already has a `vehicleProfiles` row with
source and verification; the combination is **computed** and identified by
`legalLand.configurationFingerprint`. Actual weights come from the measurement ladder.

```ts
// server/_core/transportProfile.ts
import type { VehicleValues } from "./routeEvaluation";
import type { MeasurementAuthority } from "./measurementQuality";
import type { AxleDeterminationVerdict } from "./loadSense";

export type UnitEnvelope = {                    // one vehicleProfiles row
  unitId: number; role: "tractor" | "trailer" | "straight_truck";
  heightM: number; widthM: number; lengthM: number; emptyWeightKg: number;
  axleGroups: { position: string; axles: number; ratingKg: number }[];
  registeredWeightKg: number | null;            // extend vehicleProfiles
  manufacturerGvwrKg: number | null;            // extend vehicleProfiles
  tireCapacityKgPerAxleGroup: Record<string, number> | null; // extend, nullable
  wheelbaseM: number | null; rearOverhangM: number | null;   // extend, nullable
  sleeper: { qualifying: boolean | null; source: string | null; verified: boolean }; // extend
  source: "shop_measured" | "spec_sheet" | "operator_stated";
  verificationStatus: "unverified" | "verified";
};

export type TransportProfile = {
  configurationFingerprint: string;             // legalLand.configurationFingerprint
  units: UnitEnvelope[];
  combined: { lengthM: number; widthM: number; heightM: number; axleGroups: UnitEnvelope["axleGroups"] };
  weights: {
    grossKg: { value: number | null; authority: MeasurementAuthority; snapshotRef: string | null };
    axleGroupsKg: { key: string; value: number | null; authority: MeasurementAuthority }[];
    legalAxleDetermination: AxleDeterminationVerdict | null;   // 0159, from LoadSense when present
  };
  cargo: {                                       // from loadProfiles, structured only
    dangerousGoods: boolean | null;              // null = classification not verified
    lines: DangerousGoodsLine[];                 // §6
  };
  specialPermitState: "none_required" | "required_and_verified" | "required_unverified" | "required_missing" | "unknown";
  roadBanAdjustedLimits: null;                   // computed per segment by the evaluator, not stored here
  toVehicleValues(): VehicleValues;              // the evaluator's existing input, from the highest-ranked weight
  unknowns: string[];                            // every null above, named
};
```

`toVehicleValues()` replaces the caller-supplied `load` in `spatial.routeEvaluateSegments` and is
where `loadSense.toRoutingVehicleValues` (test-only today) becomes production.

### 4.3 `RouteCandidateProvider` — an interface over `roadGraph` and `truckRoutingAdapter`

```ts
// server/_core/routeCandidates.ts
import type { RouteOutcome, Graph, CostModel } from "./roadGraph";
import type { TransportProfile } from "./transportProfile";

export type CandidateRefusal = { reason: "source_not_loaded" | "outside_coverage" | "disconnected" | "provider_refused" | "preference_refused"; detail: string };

export interface RouteCandidateProvider {
  readonly providerKey: "leaseos_road_graph" | "external_truck_router";
  readonly sourceStatus: () => import("./routingSource").RoutingSourceStatus;
  candidates(req: RoutePlanningRequest, profile: TransportProfile, opts: { maxAlternatives: number; cost: CostModel })
    : Promise<RouteCandidateSet | CandidateRefusal>;
}
```

Two implementations: `roadGraphProvider` (wraps `snapToGraph` + `shortestPath`; alternatives by
penalising the previous path's edges — Yen's algorithm is the conventional choice) and, **only if the
owner reconciles §2 item 3 of the gap analysis**, `externalProvider` (wraps
`truckRoutingAdapter.buildTruckRoutingRequest` + `guardRoutingPreferences`). A candidate from either
carries **no verdict**.

### 4.4 `RouteCandidateSet` — not persisted; only the approved candidate is

```ts
export type RouteCandidate = {
  candidateRef: string;                         // stable within the set
  buildRef: string | null;                      // roadGraphBuilds.buildRef; null for an external provider
  segmentIds: string[];                         // roadGraphEdges.segmentId, ordered
  geometry: LngLat[];
  metres: number; surfaces: Record<string, number>;
  providerKey: RouteCandidateProvider["providerKey"];
  sourceKeys: string[];                         // every source whose edges this path uses (ODbL separation)
  reasons: string[];                            // from RouteOutcome
  evaluatedAgainst: [];                         // literally empty: the type cannot carry an evaluation
};
export type RouteCandidateSet = { requestRef: string; generatedAt: Date; candidates: RouteCandidate[]; refused: CandidateRefusal[] };
```

### 4.5 `RouteConstraintContext` — a named bundle of `structures.RouteDependencies` inputs

Everything the evaluator consumes for one candidate at one instant, compiled once so that the same
context produces the same fingerprint:

```ts
// server/_core/routeConstraintContext.ts
import type { RoadSegmentInput } from "./routeEvaluation";
import type { RouteDependencies } from "./structures";
import type { PrecedenceVerdict } from "./sourcePrecedence";

export type RouteConstraintContext = {
  at: Date;
  segments: RoadSegmentInput[];                 // attributes already precedence-resolved
  precedence: Record<string, PrecedenceVerdict>;// per segment, kept for the explanation
  setAside: { segmentId: string; check: string; reason: string }[];   // out-of-window rows, named
  permits: { permitRef: string; status: "verified" | "unverified" | "expired" | "revoked"; covers: boolean | null }[];
  advisories: { advisoryRef: string; placedOn: string[]; severity: string; staleness: string }[];
  dependencies: RouteDependencies & { advisorySet: string };          // extend RouteDependencies by one part
  coverage: { axis: string; applicable: number; verified: number; unverified: number; absent: number }[]; // 0165 shape
};
```

Compiled by one function that reads `roadRestrictions` (windowed), `structures` (windowed, posted
only), `movementPermits`, `roadAdvisories` (placed by `advisoryImpact.advisoriesOnRoute`) and field
observations, and resolves conflicts with `sourcePrecedence.resolvePrecedence`. This is "M3's evidence
compiler" that `sourcePrecedence.ts`'s unwired note waits for. It lives in `server/` because it reads
the database; the pure pieces are the ones that already exist.

### 4.6 `RouteIntelligenceReadiness` — the route slice of `ReadinessInput`, named

`dispatchReadiness.ReadinessInput.route` is `{ dispatchStatus, dataTrustworthy }`. The design names
the slice and widens it without a second verdict vocabulary:

```ts
export type RouteIntelligenceReadiness = {
  approval: { approvalRef: string | null; status: "approved" | "stale" | "revoked" | "superseded" | "none"; evaluationRef: string | null };
  verdict: import("./routeEvaluation").RouteVerdict["dispatchStatus"] | null;   // clear | warning | review | blocked
  unknownAxes: ("legal" | "feasible" | "preferred")[];   // so UNKNOWN stays UNKNOWN at dispatch
  permits: import("./movementPermits").PermitStatus;      // v23.29 type, ported
  hos: { selection: import("./hos").SelectionOutcome["outcome"]; determination: import("./hos").HosDetermination["verdict"]; feasibility: import("./hos").TripFeasibility["feasible"] };
  communications: import("./commRoute").CommunicationsVerdict | "not_evaluated";
  liveConditions: "current" | "stale" | "feed_not_started" | "unavailable_due_to_rights" | "not_applicable";
  package: { packageRef: string | null; carried: import("./commPackage").CarriedState | "unknown" };
  boundary: import("./interEngineStatus").InterEngineStatus;   // PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED with reason
};
```

`readinessComposer` fills it from records; `dispatchReadiness` maps it to blockers, adding
`route_unknown` (severity `unknown`) beside the existing `route_review`, and `permit_*` and
`hos_*` blockers read facts instead of literals.

### 4.7 Offline `RoutePackage` — extends the `commPackage` pattern, one table beside `communicationPackages`

Sealing, hashing, dependency hashing, staleness and carried-state are `commPackage.ts` functions
already; the route package **calls them** with a wider content type and stores the comms package by
reference:

```ts
// server/_core/routePackage.ts — reuses canonical(), hashOf(), packageStaleness(), carriedState()
export type RoutePackageContent = {
  formatVersion: 1;
  identity: { routeApprovalRef: string; evaluationRef: string | null; requestRef: string; buildRef: string | null; sealedAt: string };
  route: { segmentIds: string[]; geometry: LngLat[]; metres: number; instructions: RouteInstruction[] };
  maps: { tileRegionRefs: string[] } | { absent: "no_tile_pipeline" };            // absence is named
  legalLand: { originLsd: string | null; destinationLsd: string | null; parcels: ParcelRef[] };
  entrances: { accessRef: string; confidence: string; approachRoadObjectId: number | null }[];
  facilities: { facilityId: number; acceptance: string; hours: unknown; contacts: unknown; precision: string }[];
  restrictions: { segmentId: string; check: string; limit: number | null; source: string; verified: boolean; window: [string | null, string | null] }[];
  structures: { structureRef: string; kind: string; posted: Record<string, number | null>; verified: boolean }[];
  roadBans: { segmentId: string; level: string | null; window: [string | null, string | null]; source: string }[];
  permits: { permitRef: string; permitNumber: string; authority: string; window: [string | null, string | null]; verified: boolean; conditionsText: string | null }[];
  tdg: { lines: DangerousGoodsLine[]; documentState: string; erapState: string } | { absent: "not_dangerous_goods" | "classification_unverified" };
  hos: { profileKey: string | null; profileVerified: boolean; rulesetVersionRef: string | null; clocksAt: string; clocks: import("./hos").Clocks | null; determination: string };
  communications: { communicationPackageRef: string; manifestHash: string };     // by reference, not copied
  emergencyContacts: { role: string; name: string; phone: string; source: string }[];
  safeStops: { kind: "rest_area" | "truck_parking" | "scale" | "fuel" | "water" | "service"; ref: string; verified: boolean }[] | { absent: "no_poi_layer" };
  sourceVersions: { sourceKey: string; version: string | null; retrievedAt: string | null; licence: string }[];
  evidenceTimestamps: { section: keyof RoutePackageContent; asOf: string }[];
  standingNotice: string;                       // "a package is only as current as its last rebuild"
};
export type SealedRoutePackage = { content: RoutePackageContent; manifestHash: string; dependencyHash: string; counts: Record<string, number>; absences: string[] };
```

Table `routePackages` mirrors `communicationPackages` column for column (packageRef, version,
routeApprovalRef, communicationPackageRef, contentJson LONGTEXT, manifestHash, dependencyHash, status
current/superseded/stale, staleReasonsJson, `orgRef`) plus `routePackageDownloads`. **Immutable:** a
rebuild is a new version; nothing edits `contentJson`. The device stores it through `commsVault`'s
carry/read-back/tamper pattern generalised by one parameter (the vault key prefix).

---

## 5. HOS and logbook design (preserved rules)

- **Rules stay data.** `hosRuleProfiles`/`hosRuleLimits`/`hosRuleLimitHistory` remain the only
  schedule store; no UI or route code carries a number (`regulatoryDataDiscipline` extends to the
  new consumers).
- **Selection** — `hos.selectProfile` over a real `OperatingContext` assembled from records:
  `carrierAuthority` from the organization's registered authority, `jurisdiction` from
  `jurisdiction.decideJurisdiction` over the approved route (UNKNOWN until a verified boundary layer
  exists, exactly as today), `registeredWeightKg` from `vehicleProfiles` (extended), `latitude` from
  the route's northernmost vertex.
- **Clocks** — `hos.computeClocks`; separate driving / on-duty / elapsed / cycle 1 / cycle 2; no
  remaining figure; presentation through `hosClockPresentation` (`CONFIRMED_ELAPSED` /
  `UNVERIFIED_ELAPSED` / `UNKNOWN`) once wired.
- **Feasibility** — `hos.tripFeasibility(determination, estimatedDriveMinutes)` where the estimate
  comes from the candidate's metres and the surface cost model, labelled an estimate.
- **Amendments** — `dailyLogAmendments` (append-only: logId, dutyRecordId, field, before, after,
  reason, requestedBy, reviewedBy, decided state) over `dailyLogs` (exists, unused). A log is never
  updated in place; the current view is derived.
- **Certification** — driver certifies a day with the existing signature attestation
  (`deviceSignature`/P-256 when on device; `driver_declaration` otherwise), recorded as a row with
  the log's content hash; supporting evidence links `evidenceRecords`.
- **Discrepancies** — a comparison of `dutyRecords` against `tripBreadcrumbs` / `telemetrySnapshots`
  emits **review rows** (Exception Centre source, required field), never a log edit.
- **Sleeper** — `sleeper_berth` on a unit whose `vehicleProfiles.sleeper.qualifying` is not
  `true`+verified is a review row; unknown refuses like false.
- **ELD boundary** — an `HosAssistanceBoundary` type stated once: `{ kind: "leaseos_assistance"; certifiedEld: false }`
  on every HOS output, and an `eld_duty_status` inbound feed kind whose records carry
  `dutyRecords.source = certified_eld` with the vendor, so a certified reading and a LeaseOS
  computation are never the same row.

## 6. TDG (structured only)

`DangerousGoodsLine = { unNumber, properShippingName, primaryClass, subsidiaryClasses[], packingGroup, quantity: { value, unit }, containment, placardRequired: boolean | null, classificationStatus }`
as a child of `loadProfiles` (the compliance design's C5 names `dangerousGoodsLines`; one table). The
route domain consumes `TransportProfile.cargo`; `readinessComposer` reads `loadProfiles`, never
`job.type`. `shippingDocumentState` and `erapState` are read from the compliance document registry
(`complianceDocuments` under a `requirementKey`), tri-state (present-verified / present-unverified /
absent), and `unknown` when the classification itself is unverified.

## 7. Weights, dimensions, permits

- Evaluator input is `TransportProfile.toVehicleValues()`; the highest-ranked weight on the ladder
  wins and its authority is written into `EvidenceEntry.inputs` so the evidence says *which* weight.
- Road-ban-adjusted limits are computed at evaluation from `road_ban_level` rows in force at
  `departAt`; the ban level and its source are part of `restrictionSet`.
- Permit state enters as `RouteConstraintContext.permits`; the evaluator's `road_owner_permission`,
  `oversize_corridor_designation` and `escort_requirement` checks read a **verified, in-window** permit
  as `pass` on unverified confidence ⇒ `review`, and an unverified/absent one as `unknown` — never a
  parse of `conditionsText`.
- Structured conditions, when built: `movementPermitConditions` rows created only from a
  `proposalFields`-vocabulary proposal (`source: document_extraction`), verified by a second person,
  superseded not edited.

## 8. Communications — the seven separations, and reminder evidence

Channel knowledge (`radioChannels`) · geographic applicability (`roadRadioAssignments` + geography
conditions) · company authorization (`companyRadioAuthorizations`) · unit capability
(`unitRadioCapabilities`) · posted channel (`radioSignObservations` → assignment at `posted_sign`
tier) · driver call reminder (new evidence) · actual transmission (never inferred). Reminder evidence:

```ts
type ReminderEvidence = { planRef: string; atKm: number; channelKey: string | null;
  promptDelivered: "yes" | "no" | "unknown"; driverConfirmed: "yes" | "no" | "unknown";
  transmissionVerified: "yes" | "no" | "unknown"; deviceRef: string; capturedAt: string };
```

`transmissionVerified` can only become `yes` from a radio with a logging interface; the design has
none, so it stays `unknown` and says so.

## 9. GPS, deviation, reroute

- Breadcrumbs remain evidence. Map matching is a pure function over `roadGraphEdges` of the approved
  `buildRef` producing `{ segmentId, confidence }` per fix; **deviation** is a `zoneEvents` row of a
  new `eventType` (`route_deviation`) born `pending`, with the matched segment and the distance from
  the approved path.
- A confirmed deviation, a fingerprint mismatch, or a placed advisory sets the approval `stale` and
  emits `dispatch.assignment_at_risk` (existing event). The worker then asks the provider for a new
  `RouteCandidateSet`, evaluates every candidate, and writes evidence under a new `evaluationRef`.
  **Nothing approves.** The candidate set is presented; a person calls `spatial.routeApprove`.
- GPS may establish position, distance-to-site, geofence crossing, deviation, connectivity gap. It may
  not establish loading, unloading, standby, disposal acceptance, sign-off, off-duty, sleeper berth or
  completion — enforced by the structural test T2.

## 10. Customer projection boundary

`CustomerTripProjection = { jobRef, state, eta: { at, basis } | null, progress: { stage, approximate: true }, loadsCompleted, loadsPlanned, delayCategory, lastUpdatedAt }`.
No latitude, longitude, driver identity, unit position, breadcrumb, or nulled placeholder for any of
them. ETA derives from the approved route's remaining metres and business events, never from a phone.
`portalRouter` outputs are key-pinned (T4). Exact asset tracking, if ever contracted, is a separate
feature on `telemetrySnapshots` with its own entitlement.

## 11. Explanations and actions (AI Secretary)

The Secretary explains a verdict from `routeEvidenceEntries` + `RouteConstraintContext.precedence`
(every entry already carries reason, source, version, confidence) and proposes actions as
`proposalFields`-vocabulary proposals: request a permit determination, propose an entrance, propose a
restriction row from a document. It never writes a verdict, an approval, a confirmation or a log.
