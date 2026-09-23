# LeaseOS Route Intelligence — gap analysis (T0)

Read against `main` = `0060690` (v23.25). See `CURRENT_ARCHITECTURE.md` for the tree this classifies.

**Classes**

| # | Class | Meaning here |
|---|---|---|
| 1 | BUILT AND PRODUCTION-WIRED | reachable from a `roleProcedure`/`externalProcedure`/`integrationProcedure` or the worker, with schema and tests |
| 2 | BUILT BUT NOT PRODUCTION-WIRED | engine exists and is tested; listed in `engineReachability.test.ts` `DECLARED_UNWIRED` or reached by no production path |
| 3 | PARTIALLY BUILT | mechanism exists; a named input, output, table or path is missing |
| 4 | DATA/RIGHTS BLOCKED | code can exist or does; the dataset is unlicensed, unverified or not loadable without an owner action |
| 5 | NATIVE-RUNTIME BLOCKED | needs the Capacitor shell (P1.1) or hardware |
| 6 | NOT BUILT | nothing in the tree does this |
| 7 | SHOULD NOT BE BUILT / DUPLICATE | an equivalent exists; building it would create a second vocabulary |

"New schema?" answers whether the capability can be delivered without a migration. "No — extend X"
means a column or enum value on an existing table, which is still a migration but not a new table.

---

## 1. Capability classification

### 1.1 Legal land, entrances, geography

| Capability | Class | Canonical implementation (files · tables · procedures) | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| Alberta ATS/LSD lookup | **1** | `_core/dls.ts` (parseLsd, parseUwi, theoreticalCentroid), `_core/geoImport.ts` (ATS ArcGIS parse), `geo.lsdLocate`, `geo.atsImportTownship` → `atsLegalSubdivisions`, `geoImportRuns` | import is per-township on demand; no province-wide preload; refresh cadence unknown (`ats.updateIntervalHours` null) | none — OGL-Alberta verified | — | no |
| reverse GPS → LSD | **1** | `legalLand.reverseLookup`, `geo.positionToLsd` | answers `outside_imported_grid` beyond imported townships; road-allowance hits are named, not guessed | none | ATS coverage | no |
| lease centroid | **1** | `locationIdentities.coordinateSource` (`ats_v41` / `field_gps` / `theoretical_grid`), `geo.locationVerifyFromGrid`, `spatial.locationVerify` | — | none | — | no |
| lease truck entrance | **1** | `siteAccessPoints` (0071), `geo.accessPropose` / `accessDecide` (second person) / `accessForLsd`, `geoImport.locateAccess` | entrance is a point + approach road; no gate-hours / gate-contact structure (facilities have it, leases do not) | none | — | no (extend later if gate contact is wanted) |
| entrance confidence / passages | **1** | `siteAccessConfirmations` + `legalLand.accessConfidence` (confirmed/probable/reported/proposed/disputed from passages that reached it) | passages are recorded by a person (`geo.accessConfirmPassage`); no GPS-proposed passage exists | none | RI-10 for a GPS-proposed passage (still a proposal) | no |

### 1.2 Road graph and candidates

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| OSM/Geofabrik graph | **2** | `_core/osmImport.ts`, `osmTopology.ts`, `osmLoadPlan.ts`, `osmLoad.ts` (pure, validated on real AB/BC/SK extracts); `legalLand.ROAD_SOURCE_STANDING.geofabrik_osm_*`; target tables `roadGraphBuilds` / `roadGraphNodes` / `roadGraphEdges` (+0164 source columns) | no loader writes a build from an extract; `osmLoad`/`osmLoadPlan` both define `planLoad` (v23.29 lineage already merged them); `geofabrik_osm_*` keys **absent from `externalSourceSeeds.ts`**, so the source gate cannot clear them; `roadGraphEdges` has no direction column and `accessRoadObjectId` is not nullable for a non-ATS edge (confirm at build time); PBF→JSONL extractor lives outside the repo | ODbL share-alike: the OSM-derived routing database must stay logically separable from proprietary layers (registry caveat) | RI-1 (registry rows), RI-3 | **probably one ALTER** on `roadGraphEdges` (direction, nullable `accessRoadObjectId`); reuse `externalDatasetImports` (unused, has `checksumSha256`, `datasetVersion`) for the extract record rather than a new table |
| Alberta graph coverage | **3** | `accessRoadSegments` (ATS road allowance, `geo.accessRoadsImport` per bbox) + `geo.graphBuild` (coordinate snap) | province-wide only via OSM (above); ATS road allowance ≠ every road | as above | RI-3 | as above |
| BC graph coverage | **2 / 4** | `geofabrik_osm_bc` standing (`CA-BC`, `OSM-BC-`) | nothing loaded; no BC authority road layer registered (`bc_resource_road_maps` unverified, "posted sign takes precedence") | rights on BC resource-road layers | RI-1, RI-3 | as above |
| Saskatchewan graph coverage | **2 / 4** | `geofabrik_osm_sk` standing (`CA-SK`, `OSM-SK-`) | nothing loaded; 0 axle / width / length tags in the extract | none for OSM; SK authority layers unregistered | RI-1, RI-3 | as above |
| route candidates | **1** | `roadGraph.shortestPath` (Dijkstra, surface cost model) via `geo.routeCompute` → `outcome: path_only` "not a permission to drive it" | one path only; only inside an imported build; `routingSource` external provider always `unknown` | none | — | no |
| route alternatives | **6** | — | no k-shortest / alternative set; no `RouteCandidateSet` | none | RI-2 contract, RI-3 graph | no (candidates are not persisted; only the approved one is) |
| route evidence | **1** | `routeEvaluation.evaluateRoute` → `routeEvidenceEntries` (per check per segment, source, version, verifiedAt, confidence, `evaluationRef` 0167) via `spatial.routeEvaluateSegments` | `geo.routeCompute` evaluates without persisting evidence and without restrictions/structures (two unequal doors) | none | RI-2 | no |
| source precedence | **2** (roads) / **1** (radio tiers) | `_core/sourcePrecedence.ts` (AUTHORITY_RANK, resolvePrecedence, provisionalRestriction) — declared unwired; `commRoute.AUTHORITY_TIERS` wired for channels | no evidence compiler feeds observations + advisories + restrictions into one `SegmentAttribute[]`; `sourcePrecedence` therefore decides nothing in production | none | RI-1 | no |

### 1.3 Weights, dimensions, bans, access

Mechanism for every row below is `routeEvaluation.ts` (`RequiredCheck`, silent = UNKNOWN) +
`roadRestrictions` (effective-windowed, verified-or-not) + `structures` (posted vs rated) +
`vehicleProfiles` + `regulatoryDataDiscipline.test.ts` (no literals). All are **3** because the data
is absent, not the code.

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| road weight limits | **3** | check `road_weight_restriction`; `roadRestrictions.checkKey`; `spatial.restrictionRecord/Verify` | no provincial dataset loaded; OSM `maxweight` = 141 ways across three provinces, and never more than an advisory | **4** for data: no registered source publishes segment weight limits | RI-4 (ingest path), RI-1 | no |
| axle restrictions | **3** | `axle_group_limit`; `vehicleProfiles.axleGroupsJson`; `loadSense.legalAxleDetermination` (0159) | LoadSense actual axle weights never reach the evaluator (`toRoutingVehicleValues` is test-only); evaluator takes `maxAxleGroupKg` only | data as above | RI-4 | no |
| bridge weights | **3** | `structures.postedWeightKg` (`ratedWeightKg` is not a limit), `bridge_capacity`; `bridges` (0012) still read | only manual entry; no authority bridge dataset; `bridges` legacy table still consulted | data | RI-4 | no (fold `bridges` reads into `structures`) |
| bridge axle limits | **3** | `structures.postedAxleGroupKg`, `bridge_axle_limit` | as above | data | RI-4 | no |
| vertical clearance | **3** | `structures.clearanceM`, `overhead_clearance` / `bridge_clearance` (feasible axis); OSM `maxheight` (2,129 ways) as advisory | as above | data | RI-4 | no |
| width restrictions | **3** | `width_restriction`; `structures.widthM`; `roadRestrictions` | as above; BC extract has 0 widths | data | RI-4 | no |
| length restrictions | **3** | `length_restriction` in both enums | as above | data | RI-4 | no |
| road bans | **3** | `roadRestrictions.checkKey = road_ban_level` with `effectiveFrom/To` and `applicableRestrictions` windowing ("names what it set aside") | no ban-order ingestion; Alberta/SK/BC ban orders are published documents nobody imports | data (source registration + a verifier) | RI-4 | no |
| seasonal weights | **3** | `seasonal_closure`; `structures.seasonalVariation` (text) | seasonal *weight* (as opposed to closure) has no numeric structure; it would be a `road_ban_level` row with a window | data | RI-4 | no |
| private road access | **3** | `road_owner_permission`, `lease_gate_access`; OSM `access=private` advisory (13,511 AB ways); `siteAccessPoints.gatePresent` | no owner-permission record type; nothing turns an OSM private flag into a REVIEW row on the segment | none | RI-1 evidence compiler | no (a permission record is a permit of type `other` on v23.29's model) |
| municipal truck routes | **3** | `truck_route_designation`; OSM `hgv` designations (2,625 in Edmonton slice) as advisory | no bylaw dataset; per-municipality source registration needed | data / rights | RI-4 | no |
| dangerous-goods restrictions | **3** | `dg_corridor`, `dg_time_restriction`; `VehicleValues.dangerousGoods`; OSM `hazmat` advisory | no DG route dataset; DG flag reaches the evaluator as one boolean | data; RI-6 for structured cargo | RI-4, RI-6 | no |

### 1.4 Live conditions, weather, POIs

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| 511 live events | **4** | `_core/feedCollector.ts` (CLEARED → DUE → QUOTA gates, `ab511` 10/60 s), `feedIngest.ts` (supersede never overwrite), `feedHttp.ts` (redacts key), `feedScheduler.ts` (backoff), `advisoryImpact.ts` (geometry placement, staleness); tables `externalFeedRuns`, `roadAdvisories` (0081) | scheduler never started (no worker job); `ab511` is `commercialUsePermitted: unknown` so the collector refuses by design; no normalizer for the 511 payload in the tree | **written permission from Alberta 511** (P6.3; `docs/P6_DATA_PERMISSION_REQUESTS.md` §1) | RI-4 (worker job), RI-1 | no |
| DriveBC | **2** | `drivebc_open511` is **verified** (OGL-BC) in `externalSourceSeeds.ts`; same feed engines | no DriveBC endpoint/normalizer; scheduler not started | none on rights | RI-4 | no |
| Saskatchewan Highway Hotline | **6 / 4** | — (no `sk_*` road-condition source registered; `sk_iris` is wells/facilities) | register the source, verify licence, then it is the DriveBC path | licence unknown until recorded | RI-1 | no (a registry row, seeded) |
| construction | **3** | `AdvisoryType = construction` in `roadAdvisories` and `advisoryImpact` | no ingestion (above); no manual advisory entry procedure | as 511/DriveBC | RI-4 | no |
| closures | **3** | `AdvisoryType = closure`; `sourcePrecedence` posture `closed` (official CLOSED beats "looks open") | as above; precedence unwired | as above | RI-1, RI-4 | no |
| weather | **3** | `weatherObservations` (worker / supervisor / external_source) via `closeout.weatherObserve`, projected to customers without coordinates; `msc_geomet` verified; `weather_interaction` check (preferred axis) | no external ingestion; observations are per job, not per segment | none on rights (ECCC end-use licence: 1 req/s, no bulk WMS scraping) | RI-4 | no |
| wildfire | **4** | `cwfis` registered `ADVISORY_ONLY` (`isAdvisoryOnly`) — may add context, may never satisfy a safety constraint | no ingestion | publisher states "not designed for operational fire management"; keep advisory-only | RI-4 | no |
| inspection stations | **2 / 6** | `truckRoutingAdapter.mayDisplayResource` (weigh/inspection stations may be **displayed**, never avoided; `guardRoutingPreferences` refuses avoidance terms) — unwired | no POI table, no source (P2.4) | data | RI-3 (POI layer) | **yes, later**: one POI table for service/regulatory points with source + verification (P2.4), not before a source is registered |
| rest areas | **6** | `osmImport` refuses `highway=rest_area` / `services` **by name** and reports them | not represented anywhere | none | RI-3 | as above |
| truck-safe parking | **6** | — | — | data | RI-3 | as above |

### 1.5 Movement permits

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| movement permits | **2 (portfolio) / 6 (main)** | **On the orphan v23.29 lineage only:** `0168_movement_permits.sql` (`movementPermits`: authority, jurisdiction, permitNumber, permitType, effectiveFrom/To, `conditionsText` verbatim, routeRef/routeVersion, documentId, source, verificationStatus, `orgRef`; `movementPermitDeterminations`: permitRequired + basis + ruleSource, human-recorded), `_core/movementPermits.ts` (`resolvePermitStatus`, `permitCoversMoment` null-window ⇒ unknown, `permitStatusForJob`), `movementPermitRouter.ts` (statusFor, record, determine, verify, listForJob), `readinessComposer` reads it, `dispatchReadiness` adds `permit_requirement_unknown`. **On main:** `readinessComposer.ts:403` `permitRequired: false` literal — every job asserts no permit is required and the `permit_missing` / `permit_unknown` branches are dead | the canonical model is not on `main`; main's literal is wrong in the permissive direction | **owner decision:** port the v23.29 permit checkpoint onto `main` (recommended) under the next free slot, never as `0168` | RI-4a | **yes — port `0168_movement_permits` under a new number** |
| permit route binding | **3** | `spatial.routeApprove.permitRefs` → `permitSet` hash in `routeApprovals.fingerprintJson`; v23.29 `movementPermits.routeRef/routeVersion` | `routeApprovalCheck` passes `permitRefs: []` with `carryOver`, so **a permit change can never stale an approval**; refs are free strings, not rows | none once permits exist | RI-4a | no (after the port) |
| permit effective dates | **2** | v23.29 `permitCoversMoment` (null window ⇒ unknown, never "runs forever") | not on main | port | RI-4a | as above |
| permit structured conditions | **6** | `conditionsText` verbatim on v23.29, never parsed | the required ladder document → proposal → human verification → active structured condition does not exist; the AI Secretary proposal vocabulary (`proposalFields`, `assistantCommitReceipts`) is the reuse point for the proposal step | none | RI-4a, then a later checkpoint | **yes, later**: `movementPermitConditions` (structured, verified, supersedes) — only after the port and only with a verifier role |

### 1.6 Hours of service and logbooks

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| HOS rule selection | **1** | `hos.selectProfile` (authority → jurisdiction → 60°N → weight → class; UNKNOWN names the rung; conflict names candidates), `hosRuleProfiles`/`hosRuleLimits`/`hosRuleLimitHistory` (versioned, promoted by a second person), `hos.profileFor`, `hos.status` | every seeded figure is `unverified` ⇒ every determination UNKNOWN until a person verifies (P6.1/P9 — correct, not a gap) | **a management verifier** for each figure | — | no |
| HOS clocks | **1** | `hos.computeClocks` — driving, on-duty, off-duty, sleeper, shift elapsed, cycle 1/2, last rest; **no single hours-remaining**; `hos.status` | dispatch reads `hoursAvailableMinutes: null` and only `hosAttestations`; computed clocks never reach readiness | none | RI-5 | no |
| HOS trip feasibility | **1** | `hos.tripFeasibility` (UNKNOWN when the driving limit is unverified) | consumed by nothing (no route estimate feeds it; no readiness blocker reads it) | verified figures | RI-5 | no |
| logbook editing / amendments | **6** | `dailyLogs.status` has `amended` (table imported by no server file); `dutyRecords` has no history; `hos.recordScannedLog` files a paper page as a compliance document | no immutable amendment ledger; no driver certification signature on a day | none | RI-5 | **yes**: an append-only amendment/certification table over `dailyLogs` (extend, do not replace `dutyRecords`) |
| sleeper-berth eligibility | **3** | `DutyStatus = sleeper_berth`, `Clocks.dailySleeperMinutes` | **no unit sleeper capability anywhere** (`units`, `vehicleProfiles` carry none), so "refuse sleeper berth when the assigned unit has no qualifying sleeper" cannot be evaluated | owner: where the sleeper fact comes from (spec sheet vs shop-measured) | RI-5 | **no new table — extend `vehicleProfiles`** with a verified sleeper attribute (source + verification like its other columns) |
| HOS falsification / discrepancy detection | **6** | pattern exists elsewhere: `siteCloseout.ts:175` flags GPS-vs-ticket time as "TIME DISCREPANCY … REVIEW" without choosing | nothing compares `dutyRecords` against `tripBreadcrumbs` / `telemetrySnapshots`; nothing raises a review row | none | RI-5, RI-10 | **yes**: a discrepancy/review row (or reuse `exceptionCentre` sources with a required field, no schema) — decide at RI-5; prefer the Exception Centre (21 state-derived sources, no schema) |
| certified ELD integration boundary | **3** | integration gateway (`integrationClients`, `inboundEvents` feeds, `inbound.ingest`) is the only machine door; `hosRouter.ts:120` comment separates computed fields from "an ELD reading" | no `eld_*` feed kind; no explicit statement in code that LeaseOS HOS is **assistance, not a certified ELD**; no record of which device/vendor a duty record came from beyond `dutyRecords.source` varchar | none | RI-5 | no new table — `INBOUND_FEEDS` gains an ELD feed kind (enum) and `dutyRecords.source` becomes a constrained enum including `certified_eld` (extend) |

### 1.7 Dangerous goods

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| TDG classification | **3** | `loadProfiles.unNumber / properShippingName / dgClass / packingGroup / classificationStatus` (needs_verification / verified / blocked); `compliancePassport.dangerousGoodsAssist`; placard/label UI (showcase) | **`readinessComposer.ts:227` derives `dangerousGoods` by regex over `job.type`/`job.mode` and never reads `loadProfiles`** — a direct violation of "do not infer regulated cargo from free text", wrong in the permissive direction (a verified UN load on a job whose type does not say "tdg" is treated as non-DG, so `tdgDocumentPrepared` and `emergencyPlanOnFile` read `true`); no subsidiary class, quantity, placard requirement | none | RI-6 | **no new table for the boolean** (read `loadProfiles`); **yes, later** for structured lines: `dangerousGoodsLines` child of `loadProfiles` (the compliance design's C5 names the same table — one checkpoint, not two) |
| TDG training readiness | **1** | Academy: server-owned TDG expiry, `academyReadinessBindings` into `readinessComposer` ("without inferring cargo or jurisdiction from free text" — true for the binding, false for the cargo flag it is fed) | fed by the regex flag above | none | RI-6 | no |
| TDG documents | **3** | `job.tdgDocumentPrepared: dangerousGoods ? null : true` (honest idiom, but nothing ever sets it true for a DG job); `complianceDocuments` | no structured "shipping document state" per load | none | RI-6 | no — a `requirementKey` + document on the existing registry, plus a load-level state read from it |
| ERAP state | **6** | `job.emergencyPlanOnFile: dangerousGoods ? null : true` — never supplied for a DG job | no ERAP record | none | RI-6 | extend `loadProfiles` (ERAP number, expiry, verification) or a `complianceDocuments` requirement — decide at RI-6 |

### 1.8 LoadSense, facilities, disposal

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| LoadSense weight authority | **1** | `measurementQuality.MEASUREMENT_AUTHORITY_RANK` (authority_certified 10 … unknown 99), `loadSense.legalAxleDetermination` (0159, refuses uncalibrated / unstable / expired / driver-entered), `loadSenseWeightSnapshots.legalDetermination*`, gateway binding + authenticated frames | `loadSense.toRoutingVehicleValues` is test-only: **route evaluation never consumes a LoadSense or certified-scale weight**; `spatial.routeEvaluateSegments` takes gross weight from the caller's `load` | none | RI-4 | no |
| facility acceptance | **1** | `facilityCapabilities.acceptanceStatus`, `facilityEvidence` (licenceKey, reviewState), `loadFacilityAssessments` (immutable, engineVersion), `facilityCompatibility.assessFacilityCompatibility`, `destinationAcceptance.destinationAcceptanceForJob` → readiness `destinationAcceptanceVerified` (null/true/false) | — | vocabulary verification against Directive 047/058 (P6.11, human) | — | no |
| disposal routing | **3** | `facilityNavigation` (directions only for verified coordinates), `facilityDirectory.nearby` (straight-line with caveat), `geo.routeCompute` (lat/lng in) | no lease→facility candidate through the graph; the finder shows distance, not a route; no "route to a facility that accepts this waste stream" composition | none | RI-8 | no |

### 1.9 Communications

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| radio channels | **1** | `radioChannels` (serviceStatus, sourceKey/citation, verification), `comms.channelSeed/Verify/Retire`, `radioChannelSeeds.ts` (ISED B1 western, BC RR, CB/GRS — seeded unverified with citations) | ISED/BC banks stay unverified; redistribution to tablets unconfirmed | **rights**: `ised_*`, `bc_resource_road_maps` redistribution (registry) | — | no |
| transmit authorization | **1** | `commRoute.transmitAuthorization` (channel verified ∧ company authorization ∧ licence in force ∧ unit programmed ∧ province confirmed, else UNKNOWN / NOT_AUTHORIZED / requires_posted_channel), `comms.transmitCheck`, `/comms/transmit` | province-limited licences read `probable` from dataset jurisdiction ⇒ UNKNOWN (correct) until a verified boundary layer exists | `statcan_boundaries` licence review (rights) | `jurisdiction.ts` wiring (RI-1) | no |
| road call points | **1** | `roadRadioAssignments.mustCallKmJson`, `PackagedZone.mustCallKm`, `callDirectionLoaded`, `callIntervalKm` | driver reminder delivery does not exist (no device); no `promptDelivered` / `driverConfirmed` / `transmissionVerified` evidence | **5** for delivery | RI-7 | **yes, later**: a reminder-evidence row with those three tri-states (append-only), designed at RI-7, written at RI-11 with the device |
| cellular coverage | **3** | `communicationCoverage` (medium cellular, state available/intermittent/unavailable, authority tier, verification) via `comms.coverageRecord`; plan ladder counts unknown as UNKNOWN | rows are hand-recorded; `crtc_coverage` registered, unverified ("modelled, not a guarantee") | rights | RI-7 | no |
| satellite fallback | **3** | `unitRadioCapabilities.satellite`, `communicationPolicies` lone-worker rule, coverage medium `satellite`, `communicationBlockers` | no satellite device inventory beyond a boolean; no message path | none | RI-7 | no |
| offline communications package | **1** | `commPackage.sealCommunicationPackage` (hash, retired channels excluded, unverified counted), `communicationPackages` (manifestHash, dependencyHash, staleness), `communicationPackageDownloads`, `client/src/runtime/commsVault.ts` (re-hash on read, tamper refused) | on a memory vault only | **5** for at-rest storage | RI-9 (becomes one section of the route package) | no |

### 1.10 Offline package, GPS, deviation, reroute

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| complete offline route package | **6** (pattern **1**) | pattern: `commPackage` (seal → hash → dependencies → staleness → carried state); `preDepartureCache.manifestFor` (kinds include route, map_tiles, facility, permit; "cached is not current"; missing named never counted) unwired; `tripPassportPackage` unwired | no package that carries geometry, LSD, entrance, facility, restrictions, structures, bans, permits, TDG refs, HOS snapshot, comms plan, contacts, safe stops, source versions | none for the server half | RI-9 | **yes**: `routePackages` (+ downloads) modelled on `communicationPackages`, linked by `routeApprovalRef` and carrying `communicationPackageRef`; never a second sealing vocabulary |
| GPS breadcrumbs | **1** (server) / **5** (device) | `tripGps.ingestBreadcrumb` → `tripBreadcrumbs` + `zoneEvents` born `pending`; `gps.submitBreadcrumb`, `gps.confirmZoneEvent` (sensitive); `geofence.evaluateZoneMembership` (source ceiling: gps high, dead_reckoning medium, manual low) | no device breadcrumb queue (a fix reaches the server only attached to a capture); no `navigator.geolocation` anywhere | **5** | RI-10 (server), RI-11 (device) | no |
| GPS map matching | **6** | `roadGraph.snapToGraph` (nearest node, 3 km) is a point snap, not sequence matching; `map.ts` `RoadsResult` is dead Google code | no HMM/sequence matcher over `roadGraphEdges` | none | RI-10 | no |
| route deviation | **6** | — | nothing compares breadcrumbs with the approved route's `segmentIdsJson` | none | RI-10 | no (a deviation is a proposal → `zoneEvents`-shaped pending row; reuse `zoneEvents.eventType` extension or the Exception Centre — decide at RI-10) |
| dynamic route staleness | **3** | lazy: `spatial.routeApprovalCheck` (fingerprint over vehicle, load, permits, restrictions, structures, fabric, checks, comms plan), `routeApprovals.status = stale`; dispatch eligibility invalidates on dependency change (`assessEligibilityValidity`) | not eager: nothing re-checks on a restriction/structure/permit/advisory write; `dispatch.assignment_at_risk` event exists but no route-change emitter; permits carried not recomputed; advisories not in the fingerprint | none | RI-4, RI-10 | no |
| automatic candidate rerouting | **6** | — | no "stale ⇒ new candidate set ⇒ evaluate ⇒ human" loop | none | RI-10 | no |
| human route reapproval | **1** | `spatial.routeApprove` again (a new `approvalRef`); statuses include `superseded` | `routeApprove` does not mark the prior approval `superseded`; no link from new to old | none | RI-4 (one column read, no migration: set status on the prior row) | no |
| customer-safe route projection | **3** | boundary is right: `customerProjections.ts` has no coordinate/driver field (regex-pinned); `portalRouter` job board / chain of custody / field ticket / observations project no coordinates | no route, ETA or progress in the customer projection at all; no `CustomerTripProjection` type; portalRouter output keys unpinned | owner §10.2 already approved | RI-2 (type), RI-11 | no |

### 1.11 UI, maps, native

| Capability | Class | Canonical implementation | Gap | Blocker | Depends on | New schema? |
|---|---|---|---|---|---|---|
| driver UI | **3** | `/route/preview` (path + evaluation + comms zones, read-only), `/comms/package`, `/comms/status`, `/comms/transmit`, `/disposal-finder` | no route instruction view, no map, no package viewer, no HOS clocks on the driver surface | **5** for offline | RI-11 | no |
| dispatch map | **6** | `/map` is a text-only routing-source status surface | no fleet map | none | RI-11 | no |
| MapLibre / offline tiles | **6** | `DATA_SOURCES.md` records MapLibre GL JS (BSD-3) and Native (BSD-2) as usable; nothing installed | no tile pipeline, no region/corridor packages | tile source + hosting decision (owner) | RI-9, RI-11 | no |
| encrypted local map/package storage | **5** | `client/src/runtime/contracts.ts` `FileVault`/`Keystore`; `commsVault` pattern; memory adapter only ("Nothing here is at-rest protection") | `capacitorVault().open` throws unconditionally | P1.1 Android shell | HS1, RI-11 | no |
| native GPS runtime | **5** | `NATIVE_ONLY_CAPABILITIES` names `gps`; `phoneLocationGate.ts` (four gates; declined monitoring never becomes a blocker reason) unwired; `monitoringNotices` (0160) | no binding, no queue, no gate wiring | P1.1 | RI-11 | no |

---

## 2. Contradictions between the request and the repository

1. **`movementPermits` / `movementPermitDeterminations` are named as existing to reuse.** They do not
   exist on `main`. They exist on `claude/mobile-hardware-scanner-mzp1e1-v2327` (v23.29, no merge base),
   as `0168_movement_permits.sql`, which collides with main's `0168`. Main's readiness composer asserts
   `permitRequired: false` for every job.
2. **"Reuse the existing measurement authority ladder and LoadSense components" for the transport
   profile.** The ladder exists; the bridge from LoadSense to routing (`toRoutingVehicleValues`) is
   test-only, and `spatial.routeEvaluateSegments` takes the gross weight from the caller.
3. **Routing provider direction.** `docs/REMAINING_BUILD_REGISTER.md` P2.1 says "HERE Routing v8
   (approved direction)"; `docs/LEASEOS_MAPPING_ROUTING_GPS_SPEC.md` §11 says "It does not adopt
   GraphHopper, HERE or Valhalla as the router"; `truckRoutingAdapter.ts` emits a Valhalla-shaped
   `costing: "truck"` request; `routingSource.ts` refuses any named provider. Owner must pick one
   sentence.
4. **"Do not infer regulated cargo or jurisdiction from free text."** `readinessComposer.ts:227`
   infers dangerous goods with `/tdg|dangerous|hazard/i` over `job.type`/`job.mode` and ignores
   `loadProfiles`. The Academy binding downstream is honest about *its* inputs; the input is not.
5. **"Reuse/version the existing HOS rule registry" and "sleeper berth refusal when assigned equipment
   has no qualifying sleeper".** The registry exists; no unit or profile carries a sleeper fact, so the
   refusal is unimplementable without extending `vehicleProfiles`.
6. **Migration slot guidance in `docs/hybrid-seam/HS_CONTRACTS.md` ("0169")** is stale: four unmerged
   branches carry `0169_defect_resolution.sql`, two carry conflicting `0170`s, the orphan lineage
   carries `0168`/`0169`. No document may pre-assign a number.
7. **The spec says `spatial.approveRoute` reads evidence "for this route's own segments".** It reads
   every FAIL ever stored on those segment ids, from any evaluation of any vehicle
   (`spatialRouter.ts:284-286`). That over-blocks (a FAIL for a 60 t unit blocks a 20 t unit forever
   on that segment) and, because it is not tied to `evaluationRef`, it also cannot say *which*
   evaluation failed.
8. **Register P4.1 "tenant isolation DONE" vs `tenantIsolation.test.ts` "not a property this system
   has"** (already recorded in `docs/register/ROADMAP_2026-09-21.md` item 3). Route, graph, comms,
   HOS-rule and source tables are unscoped on purpose (shared reference data); permits, packages and
   approvals must not be.
9. **`docs/b23/LEASEOS_B23_0_TRIP_OPERATIONS_CLOSEOUT.md` says "wiring is the next commit".** Four
   checkpoints later the four modules are still `DECLARED_UNWIRED`.
10. **"ROUTE EXISTS != ROUTE LEGAL" is a live rule** but the two evaluation doors are unequal:
    `geo.routeCompute` evaluates only surface/silent checks and is what the driver page calls, while
    only `spatial.routeEvaluateSegments` reads restrictions and structures. A route "looks evaluated"
    on `/route/preview` without ever having been evaluated against a verified limit.
11. **Prompt lists `dailyLogs`, `roadAdvisories`, `loadSenseScaleReconciliations`,
    `externalDatasetImports` as existing implementation.** They exist as tables imported by no server
    file.

---

## 3. Duplicate concepts this checkpoint refused to create

| Refused | Because the tree already has | Where it is decided |
|---|---|---|
| a `RouteEvaluator` / "better" evaluator | `routeEvaluation.evaluateRoute` with its `RequiredCheck`, axis map and UNKNOWN discipline, pinned by `regulatoryDataDiscipline.test.ts` | UNIFIED_DESIGN §3 |
| a second road graph model | `roadGraphBuilds/Nodes/Edges` + `roadGraph.ts`; OSM loader targets the same tables | GAP 1.2 |
| a `TransportProfile` table | `vehicleProfiles` (per unit, sourced, verified, `axleGroupsJson`) + `legalLand.configurationFingerprint` + `structures.loadFingerprint`; a tractor–trailer combination is a **derived** contract over several `vehicleProfiles` rows, persisted only as the `vehicleProfile`/`loadProfile` hash parts already in `routeApprovals.fingerprintJson` | UNIFIED_DESIGN §4.2 |
| a permit registry designed from scratch | the v23.29 `movementPermits` model (verbatim conditions, human determination, `orgRef`) | GAP 1.5 |
| a second HOS clock / rule store | `hos.computeClocks` + `hosRuleProfiles/Limits/History` | GAP 1.6 |
| a second source/licence registry | `externalDataSources` (imports/feeds), `facilitySourceLicences` (facility evidence), `knowledgeSources` (assistant) — three gates for three questions, v23.11 | CURRENT §8 #5 |
| a second offline package vocabulary | `commPackage` sealing/staleness/carried-state; the route package **extends** it | UNIFIED_DESIGN §4.7 |
| a second radio-plan engine or transmit gate | `commRoute.planCommunications`, `transmitAuthorization` | GAP 1.9 |
| a second facility registry / acceptance model | `facilities` + `facilityCapabilities` + `loadFacilityAssessments` (the v7 fork was already folded in at 0139) | GAP 1.8 |
| a second readiness verdict vocabulary | `dispatchReadiness.EligibilityVerdict` + `interEngineStatus` | CURRENT §8 #13 |
| a second GPS/zone event model | `tripBreadcrumbs` + `zoneEvents(pending)` | GAP 1.10 |
| a `CapabilityUnavailable` error | `NotOnDeviceError` | HS0 |
| a fourth import/fetch log | `geoImportRuns`, `externalFeedRuns`, `facilityImportRuns`; and the unused `externalDatasetImports` is the right home for an OSM extract record | CURRENT §8 #6 |
| a `RouteCandidateProvider` framework beside `roadGraph` and `truckRoutingAdapter` | both exist; the contract in UNIFIED_DESIGN §4.3 is an interface **over** them | UNIFIED_DESIGN |

---

## 4. Blockers that only the owner (or an authority, or hardware) can close

| Blocker | Unblocks | Where |
|---|---|---|
| Written 511 Alberta permission (retrieve, cache, derive, display, offline, customer display — six answers) | 1.4 511 live events; the reactive staleness loop for Alberta | `docs/P6_DATA_PERMISSION_REQUESTS.md` §1 → `geo.sourceReview` |
| AER ST37/ST102/ST107 terms; SK IRIS / MB Petroleum Branch caching terms | facility/lease identity mirroring; offline facility refs in the package | §2, §3 of the same |
| ISED channel-bank redistribution; BC resource-road map terms; StatCan boundary licence; CRTC coverage terms | verified channels; `jurisdiction.ts` `confirmed`; coverage import | `DATA_SOURCES.md` |
| Routing-provider sentence (HERE vs none vs Valhalla-shaped adapter) | RI-3 scope; whether `truckRoutingAdapter` is wired or retired | this document §2 item 3 |
| Reconcile the orphan v23.29 lineage with `main` (port permits/printing/scanner forward, or rebase main's 17 commits onto it) | RI-4a; slot arbitration | CURRENT §9 |
| Arbitrate migration slots 0169–0171 among the five unmerged claimants | every RI checkpoint with a migration | CURRENT §1 |
| SPINE moratorium D-01 (may resolvers/routers over existing engines proceed) and D-06 (one readiness system) | RI-1 onward | compliance design on `claude/leaseos-compliance-survey-5faxe8` |
| A management verifier for each HOS figure (P6.1, P9) | HOS trip feasibility that says a number | `/hos-verification` |
| Where the unit sleeper fact comes from (spec sheet vs shop-measured, who verifies) | sleeper-berth refusal | RI-5 |
| Android shell (P1.1): encrypted SQLite, keystore, vault, GPS | every class-5 row | HS1 |
| Tile source/hosting decision for MapLibre | RI-11 map | — |

---

## 5. Missing safety tests (call-outs)

Existing coverage is listed in `CURRENT_ARCHITECTURE.md` §7. These are absent and each is named as the
first test of the checkpoint that closes it:

| # | Missing test | Why it matters | First written in |
|---|---|---|---|
| T1 | `permit_missing` / `permit_unknown` / `permit_requirement_unknown` reach the dispatch verdict from a real job with no determination (DB) | main's literal `false` makes the branches dead; a regression to a literal must fail | RI-4a |
| T2 | A breadcrumb produces a `pending` zone event and **no** write to `tripStops`, `trips.status`, duty records or job state; plus a source scan asserting no production writer moves job/trip state from `tripBreadcrumbs`/`zoneEvents` except `gps.confirmZoneEvent` | the GPS invariant holds by construction today, not by guard (spec §5) | RI-10 |
| T3 | `spatial.routeApprove` refuses on a stored FAIL from **this** `evaluationRef` and does **not** refuse on a FAIL stored under another evaluation of a different vehicle (DB) | today's guard is regex-pinned and over-blocks | RI-2 |
| T4 | `portal.jobBoard`, `chainOfCustody`, `fieldTicketView`, `observations.roadHazards` output keys contain no `latitude`/`longitude`/`driverName`/breadcrumb fields, nulled or otherwise | only `customerProjections.ts` source and the weather keys are pinned | RI-2 |
| T5 | Tenant scope: a comms package, a route package, a permit and an HOS status for a unit outside the acting scope read NOT_FOUND | `tenantScopeSpatial.db.test.ts` covers vehicle profile, route request and last position only | RI-4a, RI-9 |
| T6 | A verified permit superseded/revoked/expired after approval turns the approval `stale` naming `permitSet` | impossible today (carry-over); must fail before RI-4a and pass after | RI-4a |
| T7 | Route `warning` (legal/feasible UNKNOWN) surfaces at dispatch as severity `unknown`, not `review` | UNKNOWN visibility through the boundary | RI-2 |
| T8 | Every key in `legalLand.ROAD_SOURCE_STANDING` has a row in `externalSourceSeeds.ts` | `geofabrik_osm_*` are unregistered today; the source gate cannot clear what it cannot see | RI-1 |
| T9 | The readiness DG flag comes from `loadProfiles.classificationStatus`/`unNumber`, never from job free text; a job typed "water haul" carrying a verified UN 1267 load is DG | direct violation today | RI-6 |
| T10 | Live-conditions state is `unavailable_due_to_rights` / `feed_not_started` — never `clear` — when no advisory run exists for the route's sources (spec §8) | absence must read as absence | RI-4 |
| T11 | CI gate: duplicate migration prefix fails (`0157` ×2 exists; the gate would pin the count of known duplicates at 1 and refuse a second) | slot contention on five branches | RI-1 (gate script only, no migration) |
| T12 | Route package: hash covers geometry, LSD, entrance, facility, restrictions, structures, bans, permits, TDG refs, HOS rule identity, comms plan, contacts, safe stops, source versions; any change moves it; a stale package says which section moved | mirrors `commPackage.test.ts` | RI-9 |
| T13 | HOS: a `sleeper_berth` status on a unit with no verified sleeper capability is refused as a **review row**, never silently reclassified; an unknown sleeper fact refuses too | invariant "GPS/telematics contradictions raised for review rather than silently modifying logs" extended to equipment | RI-5 |
| T14 | An advisory (closure) on a route segment lowers the approval to REVIEW/BLOCKED and never raises an UNKNOWN or RESTRICTED segment to clear (asymmetry, `sourcePrecedence`) once wired | precedence engine is unwired; its integration is untested | RI-1 |
| T15 | `geo.routeCompute` output carries no field a caller could mistake for an evaluation against restrictions (or carries `evaluatedAgainst: ["surface"]` explicitly) and `spatial.routeApprove` refuses an approval whose `evaluationRef` is absent when the tenant's policy requires one | closes the two-door inequality | RI-2 |
