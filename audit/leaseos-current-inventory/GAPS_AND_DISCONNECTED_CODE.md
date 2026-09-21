# LeaseOS — gaps, dead paths and disconnected code

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only. **Nothing was fixed.**

This is a list of things that exist. It is not a list of things that are wrong to have.

---

## 1. The largest gap: 557 of 690 procedures have no UI

**81% of the API cannot be invoked from the LeaseOS application.** 48 of 63 routers are entirely
unreachable, including `dispatch`, `hos`, `records`, `shop`, `enforcement`, `sync`, `telematics`,
`automationPolicy` and `restrictedVault`.

The full breakdown is in `API_INVENTORY.md` and `UI_INVENTORY.md`. Two consequences worth naming:

- **The dispatch gate has no screen.** `dispatch.readiness`, `dispatch.evaluate`, `dispatch.overrideRequest`, `dispatch.overrideGrant` and `dispatch.award` are all unreachable from the client. The engine that decides whether a truck may move cannot be driven by the application.
- **The mechanic-release workflow has no screen.** `shop.workOrderRelease`, `records.maintenance.recordRelease` and `records.maintenance.revokeRelease` are all unreachable. Clearing a defect is an API operation.

## 2. The repository's own declared-unwired register — 52 engines

`server/engineReachability.test.ts` maintains `DECLARED_UNWIRED`, and a test fails if an engine is
unreached *and* undeclared, or declared *and* actually wired. This is the repository auditing itself,
and it is the most reliable gap list in the tree. Selected entries, verbatim:

| Engine | Declared reason |
|---|---|
| `feedScheduler` | *"backoff scheduler; nothing starts it from an entry point"* |
| `feedIngest` | *"feed ingestion lifecycle; scheduler not started"* |
| `feedCollector` | *"feed quota and clearance gates; scheduler not started"* |
| `feedHttp` | *"HTTP edge; scheduler not started in production"* |
| `advisoryImpact` | *"road-advisory placement; feed scheduler is not started"* |
| `truckRoutingAdapter` | *"routing adapter; no live feed"* |
| `osmImport` / `osmTopology` / `osmLoad` / `osmLoadPlan` | pure and validated against large extracts, but **nothing calls them** |
| `map` | *"map geometry helpers; callers use the routing adapter path instead"* |
| `modelGateway` | *"model routing and licence gate; **no AI provider is configured yet**"* |
| `offlineCapability` | *"offline capability classes for the field device; **no device runtime calls them yet**"* |
| `preDepartureCache` | *"P1.5 — what a job needs on the device before it leaves coverage"* |
| `voiceTranscription` | *"transcription edge; **no device path**"* |
| `loadSenseMaterialMovement` / `loadSenseEvents` | *"persistence is present but **no device ingestion**"* |
| `phoneLocationGate` | *"S10.1 — whether LeaseOS may collect location from a driver's personal phone. Not mounted"* |
| `monitoringNotice` | *"P4.6 — whether a worker has been told what is collected about them. Not reached from a router yet"* |
| `dispatchMatching` | *"matching engine; dispatch surface uses its own path"* |
| `openShifts` | *"eligibility engine; openShiftsRouter currently decides inline — **a live duplication, not a gap**"* |
| `billing` / `billingAdjustment` | *"billing engine predates this audit; reachability not yet established"* |
| `fieldTicket` | *"ticket engine; router path predates it"* |
| `disposalReconciliation` | *"reconciliation engine; no procedure calls it"* |
| `safetyBinder` / `siteBaseline` / `tripBillingProjection` / `tripPassportPackage` | each names the tables it still needs |
| `heartbeat` | *"liveness helper; no monitor calls it"* |
| `imageGeneration` | *"unused capability"* |
| `dataApi` | *"shape declarations only"* |
| `dataIngestion` | *"import path not wired"* |
| `widgetSourceContract` | modelled; *"**still DESIGN ONLY**"* per the register's P0.5 row |

## 3. Database columns and tables never consumed

### Confirmed write-only column

**`workOrderReleases.resolvedDefectIds`** — written on every mechanic release (`shopRouter.ts:379`,
validated at `:336` as up to 50 positive integers) and **read by no production code**. The only
references outside the write site are in tests. The column exists to link a release to the specific
defects it repaired; readiness instead matches releases to defects by timestamp
(`readinessComposer.ts:320`). *(PR #4 makes it load-bearing; not merged.)*

### Tables with no production reference at all — 38

Full list in `DATABASE_INVENTORY.md`. Notable:

- `workflowInstances`, `workflowTransitions` (migration `0015`) — **superseded**. The live workflow runtime (`server/_core/workflowRuntime.ts`) uses `workflowRules`, `operationalTasks`, `workflowNotifications` and `domainEventOutbox` instead.
- `subcontractors`, `subcontractedLines` (`0018`) — commercial records with no code path.
- `roadAdvisories` (`0081`) — the advisory engine is declared unwired.
- `operatorAvailability`, `operatorCapabilities`, `dispatchTemplates`, `onCallRotations` (`0013`) — dispatch tables the current dispatch path does not use.
- `monitoringNotices` (`0160`) — matches the declared-unwired `monitoringNotice` engine.
- `loadSenseScaleReconciliations`, `materialDensityProfiles` (`0109`) — LoadSense persistence with no device ingestion.

### Usage classes

- **29 tables are write-only** — production writes them, nothing reads them.
- **23 tables are read-only** — production reads them, nothing populates them, so they are permanently empty in a fresh deployment unless seeded out of band.

## 4. Configuration written but not read

- **`maintenanceDefects.status`** — the enum carries `resolved`, `telematicsRouter.ts:51` *refuses to clear a fault code until the defect is resolved*, and **no production path can ever write that value**: five `insert` sites, zero `update` sites. A state the schema promises, one live path requires, and nothing can produce.
- **Purchase-order limits (P6.7)** — the register's own row records that *"purchase orders have two limit sources: the per-entity purchasing limit and the approval ladder"*, unresolved. Flagged as suspected dead configuration; **not investigated further and not fixed**, per instruction.
- **`SAFETY_CEILINGS`** (`server/_core/automationPolicyStore.ts:32`) is `{}` by design, awaiting the P8.4 owner decision. The clamp mechanism exists and is unexercised.
- **`AutomationMode`** (`MANUAL`/`HYBRID`/`AUTO`) has **no operational consumer**: `committedProvenance` (`automationPolicy.ts:392`) is called only from its own test. The mode is resolved and snapshotted onto every dispatch check and nothing branches on it.

## 5. UI that does nothing

- **`components/AIChatBox.tsx`** — 378 lines, **zero network calls** (no `fetch`, no `useQuery`, no `useMutation`). Mounted only in `pages/ComponentShowcase.tsx`, a component gallery. There is no working AI chat in the product.
- **24 showcase panels declare themselves demonstrations** via `panelSource.demonstration(reason)`. These are placeholders that say so on screen, e.g. *"the readiness engine is not run on this page; these states are the demonstration layout"*. Honest, but they are not the product working.

## 6. Mocks and stubs in production paths

- **`client/src/runtime/adapters/capacitor.ts`** — 53 lines; every binding throws `NotOnDeviceError` (5 occurrences). Its header lists the required plugins as *"not installed in this repository"*. This is the entire native surface: encrypted SQLite, file vault, keystore, camera, GPS, biometrics.
- **`client/src/runtime/adapters/memory.ts`** — the in-memory adapter, which is what actually runs.

## 7. Duplicate / parallel implementations

- `openShiftsRouter` decides eligibility inline while `_core/openShifts.ts` exists as the engine — the repository calls this *"a live duplication, not a gap"*.
- `dispatchMatching` versus the dispatch surface's own path.
- `complianceDocumentValidity` is an adapter over `documentValidity`; *"the tile still decides expiry inline"*.
- `workflowInstances`/`workflowTransitions` versus the live workflow tables.

## 8. Missing tenant scoping, authorization or audit

- **Authorization**: none found missing. CI gate 5 pins bare `protectedProcedure` at **0**; `procedureAuthorization.test.ts` asserts every `roleProcedure` name maps to a declared permission.
- **Audit**: every `roleProcedure` call records a decision, denials included, and sensitive permissions fail closed on an unrecordable audit.
- **Tenant scoping**: 12 dedicated test files. The structural limitation is not a missing check but the design — `resolveActingScope` states plainly that *"this system is single-tenant in fact"*, and `coreRecordOwnership` covers only four record types (`unit`, `operator`, `load`, `financial_entity`). Tables not reachable through one of those four have no ownership dimension at all.

## 9. Missing persistence

- `safetyBinder` needs `unitBinderSnapshots` / `safetyBinder*` tables — declared, not built.
- `siteBaseline` needs `siteStopBaselines` / `site*` tables — declared, not built.
- `tripPassportPackage` needs `tripPassportPackages` / `tripPassport*` — declared, not built.

## 10. Known defects carried in main

| Defect | Evidence | State |
|---|---|---|
| A critical defect is cleared by **any** later work-order release — unrelated, failed, or **revoked** | `readinessComposer.ts:318-330`; confirmed by execution against MariaDB | **present in main**; PR #4 open, not merged |
| A defect can never reach `resolved` | five inserts, zero updates | **present in main** |
| Active out-of-service orders are ignored by readiness — `composeReadiness` reads enforcement only from `subject.enforcement`, which **no production caller supplies** | `readinessComposer.ts:412`; six call sites | **present in main** |
| Two `blocking` blockers advertise a manager override the award gate cannot honour (`route_approval_*`, `lone_worker_no_satellite`) | `dispatchAward.ts:232-238` refuses all blocking blockers before the override branch | present; static finding, not execution-verified |
| `automationPolicyRouter.ts:83` reports `clamped` only for `requestedMode === "AUTO"` while the resolver clamps by level | unreachable while `SAFETY_CEILINGS` is empty | present; static finding |
| `credentialState` treats `needs_review` documents as satisfying a credential check | `readinessComposer.ts:168-174`; `credentialBlocker` never reads `verificationStatus` | present; static finding |
| Two migrations share prefix `0157` | `ls drizzle/0157*` | present; recorded in the repo's own roadmap |

## 11. TODO / FIXME

**Zero.** `grep -rn "TODO\|FIXME\|XXX\|HACK"` across `server/`, `client/src/` and `shared/`, excluding tests,
returns no matches. Unfinished work in this codebase is recorded in declared registers, not in comments.
