# LeaseOS — complete feature inventory

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · **Release** `v23.25` · read-only.

## Status definitions used here

| Status | Means |
|---|---|
| **IMPLEMENTED** | A usable production path exists end to end: a caller can reach it, it persists, and it is tested. |
| **BACKEND ONLY** | The server path is complete and tested but **no UI can reach it**. |
| **PARTIAL** | Some of the chain (backend / frontend / database / tests) is missing. |
| **STUB** | Code exists that deliberately does nothing usable. |
| **TEST-ONLY** | Exercised only by tests; no production caller. |
| **DOCUMENTED-ONLY** | Described in a register or spec; no implementation. |
| **BLOCKED** | Implementation exists but cannot run without an external key, licence, device or decision. |
| **NOT IMPLEMENTED** | No code. |

A schema, a type, a test fixture, a UI placeholder or a documentation mention is **not** evidence of
IMPLEMENTED. `BACKEND ONLY` is used heavily and deliberately: 81% of this system's API has no screen.

---

## Platform

### Authentication (JWT sessions)
**Status: IMPLEMENTED**
Evidence: `server/_core/sdk.ts` (`authenticateRequest`, `verifySession`), `jose` 6.1.0, `server/_core/context.ts`, `server/sessionAppId.test.ts` (9 cases).
Sessions are OAuth-issued JWTs in a cookie. `sdk.ts:238` rejects a session minted for a different `VITE_APP_ID`. `assertProductionSecrets` (`env.ts:55`, called at `index.ts:43`) refuses to boot production without a ≥32-byte `JWT_SECRET` and a `VITE_APP_ID`.

### Role-based authorization
**Status: IMPLEMENTED**
Evidence: `server/_core/trpc.ts:71` (`roleProcedure`), `server/_core/recordsAuthorization.ts` (337 permissions, 15 roles, 125 sensitive), `procedureAuthorization.test.ts`, `recordsApiAuthorization.test.ts`, CI gate 5 pins bare `protectedProcedure` at 0.
Every call — allowed or denied — writes an authorization decision row first. A sensitive permission whose audit cannot be written **refuses** rather than acting unrecorded. Branch-scoped grants confer nothing unless the procedure resolves a resource branch (verified by execution).

### Audit trail
**Status: IMPLEMENTED**
Evidence: `trpc.ts:91` (`recordAuthorizationDecision`), `dispatchAuditEvents`, `dispatchOverrides`, `signatureAudits`, `evidenceAccessEvents`, `scanAudits`, `auditPackages`/`auditPackageItems`/`auditPackageAccess`, `auditRouter.ts` (6 procedures), `auditPackage.test.ts`.
**Caveat**: `audit` router is **BACKEND ONLY** — no UI.

### Multi-tenant isolation
**Status: PARTIAL**
Evidence: `coreRecordOwnership` (4 record types only: unit, operator, load, financial_entity), `ownershipScopeWhere()` (`db.ts:791`), `resolveActingScope` (`_core/actingScope.ts`), 12 tenant-scope test files.
The mechanism works and is well tested. It is PARTIAL because `actingScope.ts` states plainly *"this system is single-tenant in fact"* — `SINGLE_TENANT_ID = "default"`, and only four record types carry ownership. Tables not reachable through one of those four have no tenant dimension.

### Migrations
**Status: IMPLEMENTED**
Evidence: 165 `.sql` files, `scripts/migrate.ts`, `server/_core/migrationLedger.ts` (`schemaMigrations`, checksummed, refuses on drift), `scripts/apply-migrations.sh`, CI gates 0–3.
**Known**: two migrations share prefix `0157`. `drizzle/meta/_journal.json` is vestigial (17 entries, last `0018`).

### Background worker
**Status: IMPLEMENTED**
Evidence: `server/_core/worker.ts` → `productionWorker.ts`, `workerLifecycle.ts`, `drainWorker.ts`, `workflowRuntime.ts`, tables `workflowRules` / `operationalTasks` / `workflowNotifications` / `domainEventOutbox`, `b20WorkflowWiring.test.ts`. Built as `dist/worker.js`.

---

## Dispatch and readiness

### Dispatch readiness engine
**Status: BACKEND ONLY**
Evidence: `server/readinessComposer.ts` (645 lines), `server/_core/dispatchReadiness.ts` (594 lines), `server/dispatchRouter.ts` (8 procedures), `dispatchEligibilityChecks`, `dispatchGate.test.ts`, `_core/dispatchReadiness.test.ts`, `_core/degradationSuite.test.ts`.
Composes credentials, training, medical projection, unit state, insurance, telematics faults, route and comms into typed blockers (`blocking` / `unknown` / `review`, each `overridable` or not). `priority` is deliberately not a parameter — emergency cannot bypass safety. **Zero of the 8 `dispatch.*` procedures are reachable from any screen.**

### Override discipline
**Status: BACKEND ONLY**
Evidence: `dispatchReadiness.ts:508` (`requestOverride`), `dispatchRouter.ts:82,99`, `dispatchOverrides`, `dispatchGate.test.ts`.
Refused attempts are recorded, not dropped. The requester may not grant their own override. A `blocking` blocker is refused at award before overrides are consulted, so it is effectively non-overridable by anyone.

### Award with fact-change refusal
**Status: BACKEND ONLY**
Evidence: `_core/dispatchAward.ts:225` (`decideAward`), `computeEligibilityFingerprint`, `dispatchGate.test.ts`.
Facts are recomputed at award and never accepted from the caller; a changed fingerprint refuses.

### P8.1 inter-engine status contract
**Status: IMPLEMENTED (as a server contract)**
Evidence: `_core/interEngineStatus.ts`, `_core/readinessCapabilities.ts`, `_core/degradationSuite.test.ts` (25 cases, enumerating capabilities **from source** so a new capability without a degradation case fails).
`PASS / REVIEW / BLOCKED / UNKNOWN / NOT_EVALUATED`; `NOT_EVALUATED` never rounds up to PASS.

### P8.2 automation policy layer
**Status: IMPLEMENTED (mechanism) / TEST-ONLY (effect)**
Evidence: `_core/automationPolicy.ts` (404 lines), `_core/automationPolicyStore.ts`, `capabilityEntitlements`, `automationPolicies`, migration `0153`/`0154`, `automationPolicySurface.test.ts` (14 cases), `automationPolicyRouter.ts` (6 procedures, **no UI**).
Entitlement and mode are resolved, clamped and snapshotted onto every dispatch check. **The mode has no operational consumer**: `committedProvenance` (`automationPolicy.ts:392`) is called only from its own test, and nothing branches on `AUTO`/`HYBRID`/`MANUAL`.

### P8.3 paper / scanned HOS fallback
**Status: BACKEND ONLY**
Evidence: `hosAttestations` (migration + `drizzle/schema.ts:8630`), `dispatchReadiness.ts:198-229`, `readinessComposer.ts:440`, `hosRouter.ts`, `hosAttestation.test.ts` (10 cases).
A named person's attestation produces a `review` blocker naming who said it — it fills a void and can never contradict a computed figure. The only capability where human-supplied evidence is marked as such.

### P8.4 safety ceilings
**Status: BLOCKED (owner decision)**
Evidence: `SafetyCeiling` type (`automationPolicy.ts:71`), `SAFETY_CEILINGS = {}` (`automationPolicyStore.ts:32`), clamp logic (`automationPolicy.ts:187-190`), `automationPolicySurface.test.ts:67` pinning the empty literal.
Mechanism complete, list deliberately empty. The pin exists so the list cannot be decided by inference.

---

## Maintenance and shop

### Mechanic release
**Status: BACKEND ONLY, with a confirmed defect in the consumption path**
Evidence: `_core/mechanicRelease.ts` (`evaluateMechanicRelease`), `shopRouter.ts:325`, `recordsRouter.ts:686,761`, `workOrderReleases`, `_core/incidentMaintenance.test.ts`, `productionPath.test.ts`.
The **write** path is strict and scales with severity. The **read** path is not: `readinessComposer.ts:318-330` matches releases to critical defects by timestamp, so any later release — unrelated, failed-test, or **revoked** — clears a critical defect. Confirmed by execution against MariaDB. PR #4 repairs this; **it is not merged**.

### Defect resolution
**Status: NOT IMPLEMENTED**
Evidence: `maintenanceDefects.status` carries `resolved`; five `insert` sites (`db.ts:1107`, `purchasingRouter.ts:69`, `telematicsRouter.ts:41`, `_core/assistantCommitService.ts:656`, `_core/enforcementCommit.ts:211`) and **zero `update` sites**. `telematicsRouter.ts:51` refuses to clear a fault until the defect is resolved — a state nothing can produce.

### Work orders
**Status: BACKEND ONLY**
Evidence: `workOrders`, `shopRouter.ts` (25 procedures: advance, release, cost, parts, tires, tools, warranty, recalls), `fleetShop.test.ts`. **No UI reaches the `shop` router.**

---

## Enforcement

### Out-of-service orders
**Status: PARTIAL — stored and managed, but ignored by readiness**
Evidence: `outOfServiceOrders`, `enforcementEvents`, `enforcementViolations`, `enforcementCitations`, `oosReleaseFindings`, `oosReleasePolicies`, `enforcementRouter.ts` (11 procedures), `_core/enforcementCommit.ts`, `enforcementApi.test.ts`, `enforcementLifecycle.test.ts`.
The domain is complete: a stop is confirmed, orders are created with scope and release conditions, and release requires a policy-bound finding with separate proposer and approver. **But `composeReadiness` reads enforcement only from `subject.enforcement`, which no production caller supplies**, so an active order does not block dispatch. Confirmed by execution.

### Roadside inspector panel
**Status: BACKEND ONLY** — `enforcementRouter` panel grants, `roadsidePanelGrants`, `_core/roadsidePanel.ts`, `scanAudits`.

---

## Hours of service

### HOS registry, promotion and verification
**Status: PARTIAL / BLOCKED**
Evidence: `hosRouter.ts` (10 procedures, **no UI**), `pages/HosVerificationConsole.tsx` (328 lines, **zero API calls**), `dutyRecords`, `drivingEvents`, `hos.test.ts`, `hosAttestation.test.ts`.
Rules are *registry values under a promotion ledger with separation of duties*, not hard-coded. **The values themselves are unverified**: P0.8 / P6.5 record `CA_FEDERAL_NORTH60.daily_on_duty_minutes` as **"STILL CONTESTED in the seed"**, and P6.1 / P6.4 require a person to read the clause.
Present: paper-log attestation, scanned log, dispatch blocking via `hos_insufficient` (non-overridable), audit history.
**NOT IMPLEMENTED**: electronic log / ELD ingestion, 7-day and 14-day cycle computation, sleeper-berth splitting, reset rules, 160 km home-terminal geofence logic, exemption handling. The roadmap's *"HOS still open"* section lists these explicitly.

---

## Mapping, routing and communications

### Road graph and route evaluation
**Status: TEST-ONLY (engines) / PARTIAL (persistence)**
Evidence: `_core/osmImport.ts`, `osmTopology.ts`, `osmLoad.ts`, `osmLoadPlan.ts` — **all four declared unwired**; `roadGraphBuilds/Nodes/Edges`, `roadSegments`, `roadRestrictions`, `bridges`, `routeRequests/Contexts/Decisions/Approvals/EvidenceEntries`; `_core/routeEvaluation.ts` (wired), `geographyAgreement.test.ts`, `routeEvaluationIdentity.test.ts`.
The import engines are validated against Alberta's 508 807 routable ways per their own headers and **nothing calls them**.

### Communications / radio planning
**Status: IMPLEMENTED (server) / BACKEND ONLY**
Evidence: `_core/commRoute.ts` (`planCommunications`, `communicationBlockers`), `communicationCoverage`, `communicationPlans`, `communicationPolicies`, `radioChannels`, `roadRadioAssignments`, `companyRadioAuthorizations`, `unitRadioCapabilities`, `commsDispatch.test.ts`; consumed live by `readinessComposer.ts:503-524`.
This is one of the few advanced engines actually wired into a live decision path. Its router (`comms`, 26 procedures) is 3/26 UI-reachable.

### External data feeds
**Status: BLOCKED**
Evidence: 21 sources in `_core/externalSourceSeeds.ts` (13 `unverified`); `feedScheduler`, `feedCollector`, `feedIngest`, `feedHttp`, `advisoryImpact`, `truckRoutingAdapter` all **declared unwired — "scheduler not started"**.
**NOT IMPLEMENTED**: offline maps, tile caching, satellite imagery, external navigation handoff, live 511 closures, weather, road conditions.

### Facility directory
**Status: IMPLEMENTED**
Evidence: `facilityDirectoryRouter.ts` (28 procedures, 5 UI-reachable), `facilities`, `facilityAliases`, `facilityCapabilities`, `facilityOperatingHours`, `facilityEvidence`, `facilitySourceLicences`, `facilityImportRuns`, `_core/arcgisImport.ts`, `pages/DisposalDirectory.tsx`, `pages/DisposalFinder.tsx`, migration `0168` + `docs/register/RB01_CLOSURE.md`.
One of the few features with a real screen.

---

## Documents, evidence and vault

### Compliance documents
**Status: IMPLEMENTED (server) / PARTIAL (UI)**
Evidence: `complianceDocuments` (ownerType × 7, `verificationStatus` ∈ needs_review/verified/rejected, `expiresAt`, `privateDetail`), `_core/compliancePassport.ts`, `_core/documentValidity.ts`, `readinessComposer.ts:168` consumes expiry live.
**Known defect**: `credentialState` treats `needs_review` documents as satisfying a credential check — `credentialBlocker` never reads `verificationStatus`.

### Evidence chain and seals
**Status: IMPLEMENTED** — `_core/evidenceChainWalk.ts`, `_core/evidenceSeal.ts`, `_core/deviceSignature.ts`, `evidenceAccessEvents`, `_core/evidenceChainWalk.test.ts`, `_core/deviceSignature.attestation.test.ts`.

### Restricted records vault (P8.5)
**Status: BACKEND ONLY** — `restrictedVaultRouter.ts` (9 procedures, no UI), `incidentMatters` with 4 sensitivity tiers, `_core/restrictedVault.test.ts`, `_core/vaultFailClosed.test.ts`.

### QR / DOT verification, offline document sharing, hard-copy tracking
**Status: NOT IMPLEMENTED** — no table, module or procedure found.

---

## Training

### Training Academy
**Status: IMPLEMENTED**
Evidence: `trainingAcademyRouter.ts` (28 procedures, 8 UI-reachable), `academyQualifications`, `academyRequirements`, `academyRequirementBindings`, `academyDirectSupervisionRecords`, `academyCertificates`, `academyCertificateSignatures`, `sheetSerialAllocations`, `_core/trainingAcademy.ts`, `trainingAcademyCatalog.ts`, `trainingAcademyRegulatory.ts`, `pages/TrainingAcademy.tsx`, `trainingAcademy.test.ts`, `trainingAcademyHardening.test.ts`, migration `0126` retention trigger (verified by `apply-migrations.sh`).
Consumed live by readiness: `readinessComposer.ts:231-290` matches requirement bindings against job facts and routes per-requirement enforcement (`block` / `review` / `inform`) into separate channels. Findings name the state (`never held` / `expired <date>` / `pending` / `revoked` / `rejected`) and carry the requirement's own code.

---

## Commercial office

### AP / AR / GL / tax / assets / payroll
**Status: BACKEND ONLY (mostly)**
Evidence: `commercialOfficeRouter` (43 procedures, 15 UI-reachable), `invoicing` (7, **0 UI**), `ar` (8, **0**), `gst` (5, **0**), `ifta` (7, **0**), `payroll` (22, **0**), `asset` (10, **0**), `fuel` (7, **0**), `bank` (3, **0**), `period` (3, **0**).
Substantial and tested (`periodClose.test.ts` — `assertPeriodOpen` at 12 call sites; `capitalAssets.test.ts`; `contractTerms.test.ts`). `pages/CommercialOffice.tsx` reaches part of it.
**Known open question** (from the repo's own `P_ROW_SUBSTANCE_AUDIT.md`): `invoicing.void` mutates an invoice in place with no `assertPeriodOpen`, and `invoices` carries no accounting date — so voiding an invoice finalized in a closed period changes that period.

### Purchase orders
**Status: PARTIAL, with suspected dead configuration**
Evidence: `purchaseAuthorizations`, `_core/purchasing.ts`, `purchasingRouter.ts` (2 procedures, no UI). Register row **P6.7**: two limit sources — the per-entity purchasing limit and the approval ladder — unresolved. **Flagged, not investigated, not fixed.**

---

## Portals

### Customer / vendor / facility portals
**Status: IMPLEMENTED**
Evidence: `portalRouter.ts` — **38 `externalProcedure` calls, 0 `roleProcedure`** (CI gate 7b), bearer tokens SHA-256 hashed, MFA, lockout; `client/src/portal/external/` (`CustomerPortal.tsx`, `VendorFacilityPortal.tsx`, `SignOffScreen.tsx`, `ChainOfCustody.tsx`, `AlertsPanel.tsx`), 23 of 36 portal procedures called from the client, `commercialPortal.test.ts`, `portalAuthorization.test.ts`.
The most complete backend-to-UI chain in the system.

---

## Machine integration

### Integration gateway
**Status: BACKEND ONLY** — `integrationRouter.ts` (**4 `integrationProcedure`**, CI gate 7c), `integrationClients`, webhook subscription with a secret shown once, signed delivery, retry schedule, dead-lettering; `integrationGateway.test.ts`. No UI.

---

## AI and assistant

### Voice-transcript form extraction
**Status: BLOCKED (external API key)**
Evidence: `_core/llm.ts` (458 lines, hand-written OpenAI-shaped client — **no LLM SDK in `package.json`**), one call site at `server/routers.ts:691`, `assistantProposals` with `commitState: "awaiting_readback"`, `_core/assistantExtraction.ts`, `assistantPersistence.ts`, `assistantCommitService.ts`, `assistantCommitAdapters.ts`, `_core/aiProposal.ts`.
Produces a **proposal** for human readback; never writes a domain record directly. `assertApiKey()` throws without `BUILT_IN_FORGE_API_KEY`.

### Knowledge corpus and ask (P4.4)
**Status: IMPLEMENTED (ingestion) / PARTIAL (surface)**
Evidence: `_core/knowledge/` (`repository`, `perimeter`, `sourceGate`, `evaluationState`), `knowledgeSources`, `knowledgeVersions`, `assistantAskRouter.ts` (8 procedures, 5 UI-reachable), `pages/AssistantAsk.tsx`, `pages/AssistantCalibration.tsx`, `knowledgeAdmission.test.ts`, `knowledgePerimeter.test.ts`, `knowledgeRepository.db.test.ts`.
The roadmap notes `repository`, `perimeter` and `evaluationState` are half-wired.

### AI chat interface
**Status: STUB** — `components/AIChatBox.tsx`, 378 lines, **zero network calls**, mounted only in the component gallery.

### Multi-agent architecture (planner / executor / tester / reviewer)
**Status: NOT IMPLEMENTED** — `agentRouter.ts` has 5 procedures, no UI; 3 of its tests are skipped as *"not reachable from the API since the facts became server-owned"*. `modelGateway` declared unwired: *"no AI provider is configured yet"*.

---

## Field / mobile / offline

### Offline outbox and sync engine
**Status: PARTIAL — code complete, no device**
Evidence: `client/src/runtime/outbox.ts` (99 lines, six states, nothing deleted, only synchronized items evictable), `syncEngine.ts` (215 lines, `captureSyncPriority` puts `oos_order`, `hos_event`, `roadside_enforcement` at tier 0), `commsVault.ts`, `crypto.ts`, `safetyLatch.ts`, `contracts.ts`, `fieldRuntime.test.ts`, `sync` router (3 procedures, **0 UI**).

### Native device capabilities
**Status: STUB / NOT IMPLEMENTED**
Evidence: `client/src/runtime/adapters/capacitor.ts` — 53 lines, **every binding throws `NotOnDeviceError`** (5 occurrences). No `android/`, no `ios/`, no Capacitor dependency, plugins *"not installed in this repository"*.
Therefore **NOT IMPLEMENTED**: encrypted local database, encrypted file vault, hardware keystore, camera capture, GPS, biometric signing, push notifications.

### GPS / zone events
**Status: PARTIAL** — `operatingZones`, `zoneEvents`, `locationIdentities`, `_core/geofence.ts`, `fieldRoute.gps` (5 procedures, **0 UI-reachable**), `fieldRoute.operatingZones` (2/2 reachable). Register P1.3 is the only row marked PARTIAL.

### Emergency / SOS
**Status: NOT IMPLEMENTED** — no SOS table, module or procedure. `emergencyPlanOnFile` exists as a readiness input only (`dispatchReadiness.ts`); ERAP appears in `complianceSecretary.ts` as text.

---

## Not implemented at all

Each verified by absence of any table, module or procedure:

| Feature | Note |
|---|---|
| **Contact directory** (company / driver / consultant / client / disposal / medic / emergency / ERAP / 911 / job-specific) | **No contact table of any kind exists.** The roadmap lists it under *"Product not built"* with the intended pattern (`manifestPartySnapshots`). |
| SDS library keyed by UN number | per-load SDS storage exists; the library does not |
| Placard generation / voice-to-placard | `placard` appears only in enforcement text, the training catalog and the demo dataset |
| SMS / email / push notification | no provider dependency |
| Biometric signature capture | requires the native shell |
| Camera / photo evidence capture | requires the native shell |
| Voice commands | `voiceTranscription` declared unwired, *"no device path"* |
| QR / DOT compliance verification | no implementation |
| Offline maps, tile caching, satellite imagery | no implementation |
| Weigh stations, live closures, weather, road conditions | scheduler never started |
| Rate-sheet document reader | *"formula pricing is recorded but not evaluated"* |
| Final pay on offboarding, measured fluids inventory, remote camp module | roadmap *"Product not built"* |
| Video clips in the vault | hashes only |
| iOS application | no code |
