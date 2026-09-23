# ELD / HOS / Compliance / Diagnostics / Analytics — Survey and Design (Checkpoint 1 + 2)

**Branch:** `claude/eld-compliance-intelligence-ramlrd` (the "feat/eld-compliance-intelligence" work).
**Base at time of survey:** `6b01a0e` — identical to `origin/main`. Working tree clean. No production code is changed by this checkpoint.
**Status:** DESIGN ONLY. Nothing here is implemented. Every table, column, procedure and permission below is a proposal to be reviewed against the code before Phase 1 begins.
**Rule of this document:** every statement about the repository was read from the source at the commit above and cites a file. Every regulatory statement is either marked *requires verification* or is a description of what the seeds already carry, unverified.

---

## 0. Executive summary

LeaseOS already has more HOS machinery than the request assumed, and less ELD machinery than it needs.

**What exists and must be reused, not rebuilt**

| Component | Where | State |
|---|---|---|
| Versioned HOS rule registry (profiles + individually verified limits + immutable promotion ledger + second-person verification) | `drizzle/0077`, `0119`, `0120`, `0124`; `server/_core/hos.ts`; `server/hosRouter.ts`; `server/_core/knowledge/promotionLedger.ts`; `client/src/pages/HosVerificationConsole.tsx` | Built, tested, every figure seeded **unverified** (P9) |
| Pure HOS clock engine (`computeClocks`, `determine`, `selectProfile`, `tripFeasibility`) | `server/_core/hos.ts` | Built, pure, deterministic; consumes `DutyEntry[]` |
| Duty-status records | `dutyRecords` (`drizzle/schema.ts:649`) | Mutable, no tenant column, no sequence, no device identity, no hash |
| Paper-log attestation fallback | `hosAttestations` (0155), `hosRouter.attestHours` | Built and wired into dispatch |
| Dispatch gate with `hos_unknown` / `hos_attested` / `hos_insufficient` blockers | `server/_core/dispatchReadiness.ts:190-229` | Built; **the composer hard-codes `hoursAvailableMinutes: null`** (`server/readinessComposer.ts:703`), so live HOS never reaches dispatch |
| Machine ingestion with idempotency and tenant scope | `integrationProcedure`, `inboundEvents`, feed `eld_duty_status` (`server/integrationRouter.ts:278-282`) | Built; writes `dutyRecords`, matches operators **by name** |
| Field runtime with durable outbox, signed sync packages, device keys, capture kind `hos_event` | `client/src/runtime/*`, `server/deviceRouter.ts`, `fieldDevices`, `deviceSyncNonces` | Built on the server; `hos_event` captures are **never converted** into duty records server-side |
| Telemetry snapshots with odometer reconciliation | `telemetrySnapshots`, `server/_core/telematics.ts` | Built |
| Jurisdiction decision with confidence levels | `server/_core/jurisdiction.ts`, `routeCommunicationGeography.ts` | Built; no verified boundary layer loaded, so `confirmed` is unreachable today |
| Hash-chained append-only event pattern | `academyAuditEvents` (`trainingAcademyRouter.ts:83-90`), `manifestAmendments` + seal trigger (0129/0130) | Two working precedents to copy |

**What does not exist**

- An immutable ELD event ledger (engine power, motion, intermediate location, login/logout, yard move, personal conveyance, jurisdiction change, diagnostics, malfunctions).
- Any device sequence number, event UUID, hash chain or ordering reconstruction for duty data.
- Certification, correction request, unidentified-driving assignment, diagnostic or compliance-finding records.
- Any HOS *mechanics* beyond trailing-window arithmetic: no duty-day boundary, no cycle switch, no off-duty deferral, no split rest, no exemption model, no DST or timezone handling (`computeClocks` uses a trailing 24 h window and rolling 7/14-day windows, `hos.ts:292-296`).
- A job-duration source. Nothing in the repository produces an estimated job or drive duration (`dispatchPostings.estimatedDurationMinutes` exists and is written and read by nothing; `geo.routeCompute` returns metres only).
- A technical-standard conformance profile of any kind.

**The single most important design decision:** the new ledger is the canonical source, `dutyRecords` becomes a legacy input that is migrated into it, and the existing pure engine in `hos.ts` is *extended* (event projection + mechanics modules + exemptions) rather than replaced. The rule registry, promotion ledger and verification console are kept exactly as they are.

---

## 1. Repository survey

Each numbered item answers the checkpoint question with what was actually found.

### 1.1 Driver / operator models

- **`operators`** (`schema.ts:120-135`, created 0003): `id`, `userId` (nullable → `users.id`), `name`, `company` (free text), `licenseNumber`, `licenseClass`, `licenseExpiresAt`, `restrictions`, `trainingStatus`, `certifications` (text), `insurance` (text), `emergencyContact`. **No tenant column, no status, no home terminal, no timezone.** Never altered after 0003.
- Tenant ownership is a side table: **`coreRecordOwnership`** (`schema.ts:5437`, 0113) with `orgRef`, `recordType ∈ {unit, operator, load, financial_entity}`, `recordId`, unique on (recordType, recordId). Helpers: `recordBelongsToOrganization`, `assignRecordOwner` (`server/_core/coreRecordOwnership.ts`); `ownershipScopeWhere` (`server/db.ts:791`).
- **`organizationWorkers`** (`schema.ts:7792`, 0115) is the only table that links `orgRef`, `userId` and `operatorId` together, with `workerType` including `OWNER_DRIVER`, `EMPLOYEE_DRIVER`, `CO_DRIVER`.
- **Identity inconsistency:** `readinessRouter.ts:48`, `openShiftsRouter.ts:123/128`, `crewRouter.ts:123` look up `operators.id = userId`; everywhere else (`dispatchRouter.ts:179`, `workforceRouter.ts:31`, `readinessComposer`) the link is `operators.userId`. The ELD subsystem must resolve operator identity through `operators.userId` and `organizationWorkers`, never `operators.id = userId`.
- **Dead tables:** `operatorAvailability` (with `state = hos_limited`) and `operatorCapabilities` (`schema.ts:1730-1776`) are referenced by nothing outside the schema.
- Qualification stores keyed by **user**, not operator: `workerQualifications` (0092), `academyQualifications`, `trainingRecords`. Credential store keyed by owner: `complianceDocuments` (`ownerType ∈ {operator, unit, job, trailer, carrier, user, equipment}`), already carries `docType = "hos_daily_log"` written by `hosRouter.recordScannedLog`.

### 1.2 Vehicle / unit models

- **`units`** (`schema.ts:137-161`, 0003): `unitNumber` (unique), `vin`, `plate`, `vehicleType`, `company`, `weightKg`, `axles`, `inspectionStatus`, `maintenanceStatus`, `qrTag`. **No odometer, no engine hours, no telematics/ELD id, no tenant column.** Scoped through `coreRecordOwnership`.
- **There is no `trailers` table**; a trailer is a unit whose `vehicleType` says so (`readinessComposer.ts:520`), and `trailerId` is a bare int elsewhere.
- Odometer and engine hours live on event rows: `telemetrySnapshots` (`schema.ts:5506`: `unitId`, `recordedAt`, `odometerKm`, `engineHours`, `ptoHours`, `idleMinutes`, `sourceClientId`, `inboundEventId`), `workOrders`, `fuelTransactions`, `trips.odometerStart/EndKm`.
- `vehicleProfiles` (`schema.ts:5784`) carries dimensions and `emptyWeightKg` with a verification status; `registeredWeightKg` for the HOS selector must come from here or `units.weightKg` and be labelled which.
- Odometer reconciliation: `odometerReconciliation` (`server/_core/telematics.ts:14`), 3 % tolerance against trips since the last shop reading.

### 1.3 Existing HOS / logbook / duty-status code

- Engine: `server/_core/hos.ts` (479 lines, pure). Vocabulary: `DutyStatus = driving | on_duty | sleeper_berth | off_duty`; 19 `LIMIT_KEYS`; `selectProfile` walks authority → jurisdiction → latitude (60°N) → weight → operation class and answers `unknown` naming the missing rung or `conflict`; `computeClocks(entries, at, {shiftResetMinutes, cycle1Days, cycle2Days, mandatoryRestMinutes})` returns 16 elapsed clocks and **deliberately no `hoursRemaining`**; `determine` yields `within | exceeded | unknown` per limit and never rounds unknown to compliant; `tripFeasibility(determination, estimatedDriveMinutes)`.
- Registry: `hosRuleProfiles`, `hosRuleLimits` (unique profileKey+limitKey; `currentPromotionRef`, `recordedByUserId`), `hosRuleLimitHistory` (immutable promotion ledger with four dates and `correctsPromotionRef`). Seeds in `hosRuleSeeds.ts`: `CA_FEDERAL_SOUTH60`, `CA_FEDERAL_NORTH60`, `AB_PROVINCIAL`, `BC_GENERAL`, `BC_LOGGING`, `BC_OIL_WELL_SERVICE` (empty), `SK/MB/ON/QC/NB/NS/PE/NL`, `YT/NT/NU_NORTH60` (empty). **All unverified.** `CA_FEDERAL_NORTH60.daily_on_duty_minutes` is flagged "STILL CONTESTED" in the seed (register P0.8).
- API: `hosRouter.ts` — `recordScannedLog`, `attestHours`, `profileSeed`, `profileList`, `limitVerify` (closed, refuses), `limitPromote` (cited path, second-person rule, scope guard), `profileVerify`, `profileFor`, `status`, `tripFeasibility`. Permissions `hos.read`, `hos.write`, `hos.rule.manage`, `hos.rule.verify` (sensitive), `hos.attest`, `hos.recordScannedLog`.
- Records: `dutyRecords` (`schema.ts:649`): `operatorId`, `tripId`, `dutyStatus`, `startedAt`, `endedAt`, `durationMinutes`, lat/lng, `locationLabel`, `jurisdiction`, `source` varchar(80), `notes`. Writers: `fieldRoute.dutyRecords.create` (`routers.ts:952`, driver self-scoped, amendments by dispatcher/hr/management recorded as `source = "amendment by user N"`), and the integration feed. Readers: `hosRouter.status/tripFeasibility` (16-day lookback), `auditRouter.ts:116` (driver audit package), `listDutyRecords` (500-row cap).
- Presentation contract: `hosClockPresentation.ts` forbids tile labels that assert a compliance conclusion ("remaining", "safe to drive"); `docs/b28/B28_HOS_STATUS_CONTRACT.md` documents `hos.status`.
- Invariant already pinned by test: an observed DRIVING status is never rewritten when a rule finds an exceedance (`hos.test.ts:135-153`, `LEASEOS_UNRELEASED_0079_CDEF.md` §F).
- Related but separate: `fuelTransactions.hosRuleConclusion`, `payrollTimeReconciliations.hosOnDutyMinutes` (nothing writes it), `shiftReadiness.hos_unknown` objection (`shiftReadiness.ts:167`).

### 1.4 Dispatch readiness

- Engine `evaluateDispatchReadiness(input: ReadinessInput): DispatchEligibility` (`server/_core/dispatchReadiness.ts:161`). Blocker: `{code, label, severity: blocking|review|unknown, subject: operator|truck|trailer|job|route, overridable, overrideAuthority?: dispatcher|manager|administrator}`. Verdict ladder: blocking → `blocked`, unknown → `unknown`, review → `eligible_review`, else `eligible`.
- HOS branch (`:190-229`): `hoursAvailableMinutes === null` → `hos_attested` (review, dispatcher) if an attestation exists for today, else `hos_unknown` (unknown, manager). `projectedJobMinutes > hoursAvailableMinutes` → `hos_insufficient` (blocking, not overridable).
- Composer `composeReadiness` (`server/readinessComposer.ts:308`) passes **`hoursAvailableMinutes: null`, `projectedJobMinutes: null`, `availabilityDeclared: false`** unconditionally (`:703`) and `facts.hoursAvailableMinutes: null` (`:770`). It reads `hosAttestations` only. `dutyRecords`, `hos.status` and `hos.tripFeasibility` are never consulted. **`hos_insufficient` is unreachable from production code.**
- Capability picture (`readinessCapabilities.ts`): `CAPABILITY.hos` is in `DISPATCH_REQUIRED_ALWAYS`; any blocker code matching `/hos|hours|duty|logbook|log_book/i` is attributed to the HOS capability (`:155`). Billing's contract lists HOS as optional (`:126`).
- Award: `EligibilityFacts.hoursAvailableMinutes` is part of the fingerprint (`dispatchAward.ts:27-61`), so a live HOS figure entering the facts will correctly invalidate stale checks.
- Enforcement: `jobUnits.create` is gated by `dispatchEnforcementSettings` mode off/advisory/enforced (`dispatchEnforcementService.ts`).

### 1.5 GPS / location / event infrastructure

- `tripBreadcrumbs` (`schema.ts:888`): trip-scoped, no device, no sequence, no idempotency, plain insert; `zoneEvents` proposed by geofence and confirmed by a person.
- Integration feed `gps_position` is stored as an `inboundEvents` row only; it does not write breadcrumbs.
- `telemetrySnapshots`, `faultCodes` (upsert by unit/protocol/code), `drivingEvents` (no `operatorId` from ingest, by design: "a unit's event is not a driver's until a person says so").
- `inboundEvents` (`schema.ts:5449`): `orgRef`, `inboundRef`, `clientId`, `feed`, `idempotencyKey`, `payloadJson`, `payloadHash`, `status accepted|rejected|duplicate`, `resultKind/Ref`, `receivedAt`. UNIQUE(clientId, idempotencyKey) exists **only in the SQL migration**, not in the Drizzle definition. **No source-event timestamp column.**
- LoadSense is the one precedent for per-gateway sequence handling: `frameKey = gatewayDeviceId:sequence`, `mergeGatewayFrames`, `detectSequenceGaps` (`server/_core/loadSenseProtocol.ts:44-68`), scoped frame key `${orgRef}:${gatewayDeviceId}:${sequence}`.

### 1.6 Offline sync architecture

- Client (`client/src/runtime`): captures get `localId = Date.now().toString(36) + random` (**not a UUID, not a sequence**), `clientCaptureRef = "${deviceRef}:${localId}"` (globally unique on `evidenceRecords.clientCaptureRef`), `capturedAt` from the device clock kept even if wrong. Packages carry a durable per-device counter `packageSeq` (`syncEngine.ts:123-127`). Priority ordering puts `hos_event`, `incident`, `defect_report`, `oos_order` in tier 0 (`syncEngine.ts:25-54`), max 500 items per package.
- Server (`server/deviceRouter.ts:162-348` `sync.receivePackage`): device lookup + org match, signature freshness (±10 min, 24 h max skew), exact-wire or reconstructed verification, P-256 verification, nonce insert (UNIQUE(fieldDeviceId, nonce)), `admitPackage`, `syncPackages` row, per-item three-way hash check, `syncPackageItems` + `syncReceipts` rows, conflict detection. Returns `itemVerdicts[]`.
- `syncPackageItems.captureAuthorizationClaim` (0079) records the device's capture-time claim and is never upgraded by sync.
- **Gap:** nothing on the server interprets a `hos_event` capture. It is sealed evidence and stops there.
- `office_accepted` state exists in the state machine but nothing sets it.

### 1.7 Audit ledger / history

- No generic audit log. `authorizationDecisions` records every gate decision. Domain event tables are per module.
- Hash chains: `academyAuditEvents` (`previousHash`, `eventHash`, global chain, no lock/sequence) and `manifestAmendments` (each amendment stores the hash it replaced; 0130 DB trigger refuses post-seal edits unless `amendmentCount` increments in the same statement).
- Supersession pattern (never UPDATE the fact, add a row that points at it): `hosAttestations.supersededByAttestationId`, `hosRuleLimitHistory.correctsPromotionRef`, `workOrderReleases.supersededByReleaseId`, `automationPolicies.supersededByVersionId`, `manifestReconciliationOverrides`.
- Evidence vault: `evidenceRecords` (`sealState`, `currentVersion`, `legalHold`), `evidenceVersions`, `evidenceSeals` (`canonicalManifest`, `contentHash`, `manifestHash`, `serverVerifiedAt`, `verificationResult`), `evidenceAccessEvents`.
- Audit packages: `auditPackages` (`manifestHash`, `coverHash`, `status`, `supersedesPackageId`, two-person release), `auditPackageItems` (unique packageId+seq, `contentHash`), kinds already include `driver` and `vehicle`; the driver package already includes `dutyRecords` rows (`auditRouter.ts:116`). **`auditPackages` has no `orgRef`.**

### 1.8 Device identity / authentication

- `fieldDevices` (`schema.ts:3958`; 0035 + 0110): `deviceRef`, `userId` (NOT NULL — one user per device), `orgRef`, `keyFingerprint`, `publicKeySpkiBase64`, `keystoreAttestation`, `status enrolled|active|suspended|revoked`. `deviceKeyEvents` records rotation with validity windows and a 72 h grace.
- Devices have **no separate transport credential**: every device procedure runs as the logged-in user through `roleProcedure`; device identity is proven per package by signature and `admitPackage` requires `device.userId === ctx.user.id`.
- Machines authenticate through `integrationProcedure` with `x-integration-key` → `integrationClients` (`kind` includes `eld`, `scopesJson` lists feeds, `orgRef` required). `failedAttempts`/`lockedUntil` are never incremented on this path.
- `measurementDevices` / LoadSense gateways are a separate non-cryptographic registry.

### 1.9 Tenant / organization scoping

- Canonical column: **`orgRef`** (varchar 40/64) on 36 tables; `bookOrgRef` on commercial tables; `tenantId` on 19 (outbox, workflow, enforcement, workforce, message). **NULL means the historical single tenant**, visible only to `SINGLE_TENANT_ID = "default"`. New tables follow `orgRef` + the NULL convention (0132 comment style).
- The tRPC context does not carry an organization; each procedure calls `resolveActingScope(db, userId)` (`server/_core/actingScope.ts:65`; throws `AmbiguousOrganization` on multiple memberships) or a wrapper (`scopeFor`, `actingScopeFor`).
- Scope helpers return `null` → callers answer NOT_FOUND, never FORBIDDEN: `unitInScope`, `operatorInScope`, `tripInScope`, `jobInScope` (`server/db.ts:807-1019`); `orgScopeWhere` (`db.ts:160`).
- `scopeGuard` (`server/_core/knowledge/scopeGuard.ts`) is the *regulatory* scope guard for rule promotion, not tenant isolation.

### 1.10 Outbox / event infrastructure

- `domainEventOutbox` (`schema.ts:2239`; 0015 + 0089): `eventId` unique, `eventType`, `aggregateType/Id`, `tenantId` NOT NULL, `correlationId`, `causationId`, `payloadJson`, lease (`claimedAt`, `claimedBy`, 120 s), `attemptCount`, `retryAvailableAt`, `deadLetteredAt`.
- Enqueue: `emitDomainEvent(tx, …)` (`server/_core/eventEmitter.ts:115`) inside the caller's transaction. **Only live producer is enforcement** (`enforcementOutbox.ts:43`, deterministic `eventId` from sha256). 14 `emit*` functions in `domainEmitters.ts` have no production caller.
- Consume: `startProductionWorker` → `drainWorker` with `FOR UPDATE SKIP LOCKED`, backoff with jitter, dead letter after 5 attempts; consequences → `operationalTasks` (dedupe by `dedupeKey`, application-level) and `workflowNotifications` (`notificationKey` unique).
- Webhooks: `webhookSubscriptions`, `webhookDeliveries` (one row per attempt).

### 1.11 Routing and job-assignment contracts

- `jobs` has no scheduled start/end and no duration. `jobUnits` carries actual `hours`. `trips`/`tripStops` carry actual durations. `dispatchPostings.scheduledStart`, `estimatedDurationMinutes`, `estimatedDistanceKm` exist and are written/read by nothing. `resourceBookings` has caller-supplied `startsAt/endsAt`.
- Routing: `shortestPath` (`roadGraph.ts:124`) returns metres and surface km; `evaluateRoute` returns a four-axis verdict with `dispatchStatus clear|warning|review|blocked`; `geo.routeCompute` returns distance only. **No speed model, no duration anywhere.**
- Route approvals go stale by fingerprint (0165-0167). The readiness panel never passes `routeApprovalRef`, so it always shows `route_not_evaluated`.
- Job board: `shiftPosts`/`shiftInterests` (0091), `openShifts.ts` (`candidatesFor`, `IneligibilityCode`), `shifts.eligibility` reads leave, licence and `workerQualifications`; not HOS. `intendToAssign` returns `requiresReadinessCheck: true`. **No overtime concept exists.**
- There is **no `transfers` table**; `transfers.create` writes `transferAcknowledgements` (document delivery), so the B21.1 note about gating `transfers.create` refers to something that does not assign drivers.

### 1.12 Driver Portfolio / credential / document models

- No table or code is named "portfolio". The nearest surfaces: `compliance.passport` (`buildPassport` → `{verdict ready|review|blocked|unknown, items[]}`), `complianceDocuments` (owner-keyed), `workerQualifications`/`academyQualifications`/`trainingRecords` (user-keyed), Training Academy's `/training-academy` "certificate/qualification portfolio" page, and the driver audit package (`auditRouter`).
- `complianceRequirements` (0036) drive the passport; `requirementKey = "hos.daily_log"` is already the key used by `recordScannedLog`.

### 1.13 Migration conventions

- Handwritten SQL in `drizzle/NNNN_snake_name.sql`, header `-- vX.YY — NNNN: why`, `--> statement-breakpoint` separators, MariaDB 10.11 syntax (`PERSISTENT` in 0021), `BEGIN`/`END;` on their own lines for compound triggers. `drizzle/meta/_journal.json` is stale (0000-0018) and unused by the gate.
- Highest file: `0169_defect_resolution.sql`, on both this branch and `origin/main` at survey time. **Next free prefix is 0170, but main has concurrent dispatch work; choose the number by reading `ls drizzle | tail` at implementation time, not from this document.** `dispatchRouter.ts` already uses "0170" as a change label with no SQL file. 0016/0017 are enforced absent (gate 0). Duplicate prefix 0157 exists and is documented; no gate checks prefix uniqueness.
- Parity: `scripts/verify-parity.sh` counts `mysqlTable(` in schema vs `^CREATE TABLE` lines in migrations — so `CREATE TABLE` must start a line and `mysqlTable(` must not appear in schema comments. `columnParity.test.ts` checks every column and nullability against a live database, and refuses database columns schema does not declare. `reservedWordColumns.test.ts` refuses MariaDB reserved words as columns. `migrationLedger.db.test.ts` applies every file through the production runner (`server/_core/migrationLedger.ts`, sha256 per file, refuses drift).
- Refs are minted as `PREFIX-<base36 time>-<rand4>`; `createdAt timestamp NOT NULL DEFAULT (now())`.
- Procedures: every `roleProcedure("x.y")` must be mapped in `OPERATIONAL_PROCEDURE_PERMISSIONS` (`recordsAuthorization.ts:2182`) or wiring throws; pinned counts to bump: `crossLayerIntegrity.test.ts:39` (691 paths), the operational map size (629) in `procedureAuthorization.test.ts`; new router files must be added to `OPERATIONAL_SOURCES`. `LEASEOS_CURRENT_STATE.md` must be regenerated (gate 8).

### 1.14 Test conventions and gate commands

- `pnpm exec vitest run` (all), `pnpm exec vitest run server/hos.test.ts` (one file), `pnpm check` (tsc). Full gate: `DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos bash scripts/ci-gate.sh` (drops and recreates the database; MariaDB 10.11; also sets `WIDGET_DB_URL`). CI runs exactly this (`.github/workflows/ci.yml`).
- `fileParallelism: false`; database suites guard with `const d = process.env.DATABASE_URL ? describe : describe.skip` and gate 6 fails if a `.db.test.ts` skips while a database is configured. Test files are type-checked with a ratchet pinned at **0** errors.
- Deterministic time is done by constants (`const at = new Date("2026-09-11T18:00:00Z")`) passed as `at`/`now`/`evaluatedAt`; no fake timers anywhere. Pure engines are tested with inline fixtures (`READY` in `dispatchReadiness.test.ts`, `DutyEntry[]` in `hos.test.ts`). Database tests build scenarios with raw `INSERT`s and `appRouter.createCaller`.

### 1.15 Overlaps and contradictions found

1. **Two duty-status writers with different identity rules.** `fieldRoute.dutyRecords.create` binds the operator to the signed-in driver; `inbound.ingest` (`eld_duty_status`) matches `operators.name` to a free-text `operatorRef`. Name matching is not an identity. The ledger needs an explicit external-identifier mapping.
2. **`dutyRecords` has no `orgRef`**; it is scoped only transitively via `operators` + `coreRecordOwnership`. `hos.status` filters by `operatorId` only, with no scope check (`hosRouter.ts:374-379`).
3. **HOS is computed but never consumed by dispatch** (§1.4). The composer, the shift swap check (`hosKnown`) and the job board all answer unknown by construction.
4. **`computeClocks` mechanics are placeholders**: "day" is a trailing 24 h, cycles are trailing 7/14 calendar days from `at`, shift start is "after the last rest ≥ shiftReset". Whether a Canadian "day" is a designated 24-hour period, how cycle days are counted and how a cycle reset works are *mechanics* that differ by regime and are not represented anywhere. The registry holds numbers, not mechanics.
5. **`operators` has no timezone or home terminal**, so a duty day boundary cannot be computed for any driver today.
6. **`hosClockPresentation.FORBIDDEN_LABELS` bans "remaining"** in tile labels, while `determine` legitimately returns `remainingMinutes` once a limit is verified. This is consistent (the ban is on *unsupported* labels) but the new engine must route every remaining figure through a determination that names the verified limit, never through a clock.
7. **`hos_event` captures from the field runtime are dead on arrival** at the server (§1.6).
8. **`operatorAvailability.hos_limited`** is a status nobody sets; the new design derives availability from projections and does not revive this enum.
9. **The 0079 invariant** (observed status never rewritten) and the 0130 seal-trigger pattern are the two existing rules the ledger design must honour and generalize.
10. **`inboundEvents` has no source timestamp column** and the unique constraint is SQL-only; the ELD path must not reuse `inboundEvents` as its ledger.

---

## 2. Existing components to reuse

| Need | Reuse | How |
|---|---|---|
| Rule packs, versions, effective dates, verification | `hosRuleProfiles`, `hosRuleLimits`, `hosRuleLimitHistory`, `limitPromote`, `profileVerify`, `HosVerificationConsole` | Unchanged. Add one nullable column `mechanicsKey` to `hosRuleProfiles` (§6) and an `hosExemptionGrants` table. |
| Profile selection | `selectProfile(OperatingContext)` | Unchanged; the ledger supplies `jurisdiction` + `latitude` from jurisdiction-change events. |
| Limit comparison and explanation | `determine`, `LimitDetermination`, `HosDetermination` | Unchanged shape; extended with `ruleId` and reason codes (§6). |
| Elapsed clocks | `computeClocks` | Kept as the *default* mechanics module; new modules implement regime-specific day/shift/cycle boundaries and produce the same `Clocks` shape. |
| Tenant scope | `orgRef` NULL convention, `resolveActingScope`, `recordBelongsToOrganization`, `operatorInScope`, `unitInScope` | Every ELD table gets `orgRef`; every procedure resolves scope server-side. |
| Machine ingestion | `integrationProcedure`, `integrationClients.kind = eld`, `inboundEvents` idempotency | New feed `eld_event` (batch) beside `eld_duty_status`; `inboundEvents` remains the receipt, `eldEvents` the ledger. |
| Device ingestion | `fieldDevices`, `deviceSyncNonces`, `sync.receivePackage`, capture kind `hos_event`, tier-0 priority | Add a post-verification step that projects verified `hos_event` captures into ledger rows (§10). |
| Append-only with hash | `academyAuditEvents` chain, `manifestAmendments` + 0130 trigger | Per-device hash chain on `eldEvents` and a BEFORE UPDATE/DELETE trigger that raises 45000. |
| Supersession instead of UPDATE | `hosAttestations.supersededBy…`, `hosRuleLimitHistory.correctsPromotionRef` | Corrections are new events pointing at the originals (§11). |
| Two-person rules | `limitPromote` recorder ≠ verifier; audit package release | Correction acceptance, unidentified-driving assignment and exemption grants require a second identity. |
| Dispatch | `ReadinessInput.operator.hoursAvailableMinutes/projectedJobMinutes`, `hos_insufficient`, `EligibilityFacts.hoursAvailableMinutes`, `CAPABILITY.hos`, `capabilityOf` regex | Fill them from the engine; add codes (§12). |
| Job board | `openShifts.candidatesFor`, `IneligibilityCode`, `shifts.eligibility` | Add an `hos_*` ineligibility from the same feasibility function (§13). |
| Portfolio | `compliance.passport`, `complianceDocuments(hos_daily_log)`, driver audit package | Certifications and findings become passport items and package items (§14). |
| Inspection package | `auditPackages` (kinds `driver`/`vehicle`, hashed manifest, two-person release) | New kind `eld_inspection` rather than a new table (§4.12). |
| Diagnostics precedents | `telemetrySnapshots` + `odometerReconciliation`, `detectSequenceGaps`, `signatureFreshness` clock-skew codes, `jurisdiction.ts` confidence | Reused as inputs to the diagnostics engine. |
| Outbox | `emitDomainEvent` in-transaction, `domainEventOutbox.tenantId` | Ledger commits emit `eld.event.recorded`, `eld.finding.opened`, `hos.projection.stale` for projection rebuild and notifications. |
| Presentation guard | `hosClockPresentation`, `FORBIDDEN_LABELS` | Kept; extended with a `HosRemainingPresentation` that is only constructible from a `LimitDetermination` with `limitMinutes != null`. |

---

## 3. Proposed boundaries

```
                          ┌──────────────────────────────────────────────────────────────┐
  Vehicle / device        │  INGESTION EDGES (impure, thin)                              │
  telemetry               │   integrationRouter  feed=eld_event  (third-party ELD)       │
  ───────────────────────►│   deviceRouter.receivePackage → hos_event captures (own app) │
                          │   eldRouter.event.record (driver manual status, office)       │
                          └───────────────┬──────────────────────────────────────────────┘
                                          │ canonical EldEventInput[]
                          ┌───────────────▼──────────────────────────────────────────────┐
                          │  LEDGER  server/_core/eld/ledger.ts (pure) + eldLedgerStore   │
                          │   canonicalize · validate · dedupe · sequence · hash-chain    │
                          │   append-only tables: eldEvents (+ annotations, corrections,   │
                          │   certifications, unidentified assignments)                   │
                          └──────┬────────────────────┬──────────────────┬───────────────┘
                                 │ ordered events      │ ordered events   │ ordered events
                 ┌───────────────▼─────┐  ┌────────────▼──────────┐  ┌────▼─────────────────┐
                 │ HOS ENGINE (pure)   │  │ DIAGNOSTICS (pure)    │  │ COMPLIANCE (pure)    │
                 │ eld/hosProjection   │  │ eld/diagnostics.ts    │  │ eld/compliance.ts    │
                 │ hos.ts (existing)   │  │ device/telemetry      │  │ consumes HOS +       │
                 │ hos/mechanics/*.ts  │  │ integrity findings    │  │ diagnostics outputs  │
                 └──────┬──────────────┘  └────────────┬──────────┘  └────┬─────────────────┘
                        │ HosResult                    │ DiagnosticFinding│ ComplianceFinding
                 ┌──────▼──────────────────────────────▼──────────────────▼─────────────────┐
                 │  PROJECTIONS (rebuildable read models)  eld/projections.ts                 │
                 │   hosDailyProjections · hosCycleProjections · eldFindings tables ·         │
                 │   fleet aggregates (computed on read or cached)                            │
                 └──────┬──────────────────────────────────────────────────────────────────┘
                        │
   ┌────────────────────▼──────────────┬──────────────────────────┬───────────────────────┐
   │ readinessComposer (dispatch)      │ openShifts (job board)   │ eldRouter (driver /    │
   │ evaluateHosFeasibility()          │ evaluateHosFeasibility() │ office / inspection)   │
   └───────────────────────────────────┴──────────────────────────┴───────────────────────┘
```

**Module layout (proposed):**

```
server/_core/eld/
  events.ts          EldEventType, EldEventInput, canonical form, zod schemas (shared with client)
  ledger.ts          pure: canonicalize, validate, dedupe, order, gap detection, hash chain
  hosProjection.ts   pure: EldEvent[] → DutyEntry[] (+ segments, jurisdiction spans)
  diagnostics.ts     pure: EldEvent[] + telemetry + device facts → DiagnosticFinding[]
  compliance.ts      pure: HosResult + DiagnosticFinding[] + ledger facts → ComplianceFinding[]
  feasibility.ts     pure: evaluateHosFeasibility()
  projections.ts     pure: HosResult → daily/cycle projection rows; fleet aggregates
  reasonCodes.ts     the stable code registry (one file, one union type)
  fixtures.ts        test scenario builders (deterministic)
server/_core/hos.ts                 existing engine, extended (rule ids, reason codes, mechanics hook)
server/_core/hos/mechanics/
  index.ts           MechanicsModule interface + registry keyed by mechanicsKey
  trailingWindow.ts  today's computeClocks behaviour, named honestly as a default
  caFederal.ts       Canadian federal mechanics (skeleton; every rule marked requires-verification)
  abProvincial.ts    Alberta provincial mechanics (skeleton)
  usFmcsa395.ts      FMCSA (skeleton, future)
server/_core/eld/techStandard/
  profiles.ts        technical-standard profiles (event vocabulary, required fields, intervals) — versioned, unverified
server/eldRouter.ts                  roleProcedure surface
server/_core/eldLedgerStore.ts       the only writer of eldEvents (transactional append + hash)
shared/eld/                          zod schemas shared with the client runtime
client/src/runtime/eldOutbox.ts      device-side event persistence (UUID + local sequence)
```

**Boundary rules**

1. Only `eldLedgerStore.append()` writes `eldEvents`. Routers, the integration feed and the sync projector all call it.
2. Engines are pure functions of `(events, context, at)`. No engine reads the database.
3. `hos.ts` remains the single place where a clock is compared to a limit. `evaluateHosFeasibility` calls `determine`; it never re-implements a comparison.
4. UI receives projections and determinations, never raw arithmetic inputs to recompute.

---

## 4. Data model

Conventions applied to every new table: `id int AUTO_INCREMENT`, `orgRef varchar(64) NULL` (NULL = historical single tenant, per 0132), refs `PREFIX-<base36 time>-<rand4>`, `createdAt timestamp NOT NULL DEFAULT (now())`, no MariaDB reserved words as column names, `CREATE TABLE` at line start. Names adapt to the repository's camelCase table style.

### 4.1 `eldTechnicalStandardProfiles` — technical-standard conformance profiles

Mirrors `hosRuleProfiles` in spirit: versioned, effective-dated, verified by a person, and separate from HOS rules.

| Column | Type | Note |
|---|---|---|
| `profileKey` | varchar(60) unique | e.g. `CA_ELD_TS_1_2`, `CA_ELD_TS_1_3_1`, `US_FMCSA_395_SUBPART_B` — keys only; contents unverified |
| `label`, `issuingBody`, `sourceCitation`, `sourceUrl` | | |
| `effectiveFrom`, `effectiveTo` | timestamp NULL | |
| `specJson` | text | event vocabulary, required data elements, intermediate-location interval, motion threshold, malfunction/diagnostic codes — **every figure seeded unverified** |
| `verificationStatus` | enum unverified/verified/superseded | second-person verification like `profileVerify` |
| `supersedesProfileKey`, `recordedByUserId`, `verifiedByUserId`, `verifiedAt` | | |

### 4.2 `eldDevices` — ELD identities

An ELD is one of three things already in the system, so this table is a registry of *roles*, not a fourth credential store.

| Column | Note |
|---|---|
| `eldRef` varchar(64) unique | `ELD-…` |
| `orgRef` | |
| `identityKind` enum `field_device` / `integration_client` / `hardware_unit` | |
| `fieldDeviceId` int NULL → `fieldDevices` | the LeaseOS app as ELD |
| `integrationClientId` int NULL → `integrationClients` | a third-party ELD provider |
| `hardwareSerial` varchar(120) NULL, `manufacturer`, `model`, `firmwareVersion` | |
| `techStandardProfileKey` varchar(60) NULL | the profile the device claims to conform to; **`certified` is never inferred from this** |
| `certificationStatus` enum `not_certified` / `certification_claimed` / `certification_verified` | default `not_certified`; `verified` requires a `complianceDocuments` row and a second person |
| `certificationDocumentId` int NULL | |
| `status` enum active/suspended/retired, `registeredByUserId` | |

Index `(orgRef, status)`; unique `(identityKind, fieldDeviceId)`, `(identityKind, integrationClientId, hardwareSerial)`.

### 4.3 `eldVehicleBindings` — device ↔ unit

`eldDeviceId`, `unitId`, `orgRef`, `boundAt`, `unboundAt` NULL, `boundByUserId`, `source` enum `office` / `device_reported` / `integration_reported`. A binding is never edited; unbinding sets `unboundAt` once (the one permitted UPDATE, guarded by trigger to a NULL→value transition). Index `(unitId, boundAt)`.

### 4.4 `eldExternalIdentifiers` — provider ids → LeaseOS ids

Replaces name matching. `orgRef`, `integrationClientId`, `subjectType` enum `operator` / `unit`, `externalId` varchar(160), `subjectId` int, `effectiveFrom`, `effectiveTo`, `recordedByUserId`. Unique `(integrationClientId, subjectType, externalId, effectiveFrom)`.

### 4.5 `eldDriverSessions` — login/logout on a device

`sessionRef` unique, `orgRef`, `eldDeviceId`, `operatorId`, `unitId` NULL, `loginEventRef` → `eldEvents.eventRef`, `logoutEventRef` NULL, `role` enum `driver` / `co_driver`, `startedAt`, `endedAt` NULL. Derived from login/logout events; rebuildable; exists for query speed and for team-driver support.

### 4.6 `eldEvents` — the immutable ledger

This is the legal record. **No UPDATE, no DELETE**, enforced by a BEFORE UPDATE and BEFORE DELETE trigger raising SQLSTATE 45000 (pattern from 0130 and the academy retention guards). Corrections are new rows.

| Column | Type | Note |
|---|---|---|
| `eventRef` | varchar(64) unique | device-minted UUID v4 (`crypto.randomUUID`) for device paths; `${integrationClientId}:${providerEventId}` for providers; server-minted `EVT-…` for office-originated events |
| `orgRef` | varchar(64) NULL | |
| `eldDeviceId` | int NULL | NULL only for office-originated correction events |
| `deviceSequence` | bigint NULL | device-local monotonic counter; unique `(eldDeviceId, deviceSequence)` where not NULL |
| `unitId` | int NULL | NULL when the device is unbound |
| `operatorId` | int NULL | **NULL = unidentified driving / no authenticated driver** |
| `coDriverOperatorId` | int NULL | team support |
| `eventType` | enum | see §5 |
| `eventCode` | varchar(40) | sub-type within the type, from the tech-standard profile vocabulary |
| `dutyStatus` | enum driving/on_duty/sleeper_berth/off_duty NULL | only on duty-status events; the existing `DutyStatus` vocabulary, unchanged |
| `specialCategory` | enum `none` / `personal_conveyance` / `yard_move` | |
| `recordOrigin` | enum `automatic` / `driver` / `office_edit` / `assumed_unidentified` / `legacy_duty_record` / `integration` | who or what produced it |
| `eventAt` | timestamp(3) | the device's clock, kept even if wrong |
| `eventUtcOffsetMinutes` | smallint NULL | as reported by the device; NULL = not reported |
| `receivedAt` | timestamp(3) | server receipt |
| `clockSkewMs` | int NULL | from `signatureFreshness` where a signed package exists |
| `latitude`, `longitude` | double NULL | |
| `locationAccuracyM` | double NULL | |
| `locationSource` | enum `gps` / `network` / `manual` / `ecm` / `none` | |
| `locationDescription` | varchar(220) NULL | |
| `jurisdiction` | varchar(8) NULL | device or provider claim |
| `jurisdictionConfidence` | enum confirmed/probable/ambiguous/unknown | from `jurisdiction.ts` at ingest; default `unknown` |
| `odometerKm`, `engineHours` | double NULL | as reported |
| `vehicleSpeedKph` | double NULL | motion events |
| `malfunctionCode`, `diagnosticCode` | varchar(20) NULL | device-reported codes on diagnostic/malfunction events |
| `annotation` | varchar(500) NULL | driver's note at the time of the event (immutable; later notes go to 4.7) |
| `supersedesEventRef` | varchar(64) NULL | set on accepted correction events; the original row is untouched |
| `correctionRequestId` | int NULL | which request produced this row |
| `sourceKind` | enum `device_sync` / `integration` / `office` / `migration` | |
| `sourceRef` | varchar(64) NULL | `evidenceRecordId` / `inboundRef` / `dutyRecords.id` |
| `payloadJson` | text | the canonical event as received, verbatim |
| `payloadHash` | char(64) | sha256 of canonical JSON |
| `previousEventHash` | char(64) NULL | per `(eldDeviceId)` stream; NULL for the first event of a stream and for office rows |
| `eventHash` | char(64) | sha256(previousEventHash ‖ payloadHash ‖ eventRef ‖ deviceSequence) |
| `createdAt` | | |

Indexes: `(operatorId, eventAt)`, `(unitId, eventAt)`, `(eldDeviceId, deviceSequence)`, `(orgRef, eventAt)`, `(supersedesEventRef)`.

**Record status is derived, not stored.** An event is *active* iff no accepted correction event names it in `supersedesEventRef`. A rebuildable `eldEventStatus` cache (4.13) exists for query speed only.

### 4.7 `eldEventAnnotations` — append-only notes

`eventRef`, `orgRef`, `authorUserId`, `authorRole` enum driver/office/system, `text` varchar(500), `annotatedAt`. Never edited. Distinct from `eldEvents.annotation`, which is the driver's note at the moment of the event.

### 4.8 `eldCorrectionRequests` — requested / accepted / rejected corrections

| Column | Note |
|---|---|
| `requestRef` unique, `orgRef`, `operatorId` | |
| `requestedByUserId`, `requestedByRole` enum driver/dispatcher/office/safety/management, `requestedAt` | |
| `affectsEventRefsJson` | the originals |
| `proposedEventsJson` | the replacement events, canonical form, not yet in the ledger |
| `reason` varchar(500) | required |
| `status` enum `requested` / `accepted` / `rejected` / `withdrawn` | |
| `decidedByUserId`, `decidedAt`, `decisionNote` | second identity when the requester is not the driver, and the driver's own acceptance when the office proposed |
| `driverAcceptanceUserId`, `driverAcceptedAt` | an office-proposed correction to a driver's log requires the driver's acceptance (*requires verification* against the applicable standard, §18) |
| `resultingEventRefsJson` | filled on acceptance |
| `certificationId` int NULL | the certification in force when requested, if any |

A row moves `requested → accepted|rejected|withdrawn` exactly once (trigger-guarded transition), then is immutable.

### 4.9 `eldLogCertifications` — daily log certification and recertification

`certificationRef` unique, `orgRef`, `operatorId`, `dutyDate` date, `dutyDayStartsAt` timestamp (the duty day's actual start in the driver's home-terminal zone), `timezone` varchar(64), `certifiedByUserId` (must be the driver), `certifiedAt`, `logHash` char(64) (sha256 over the active events of the day in canonical order), `eventCount`, `supersededByCertificationId` NULL, `supersessionReason` enum `correction_accepted` / `late_event` / `driver_recertified`. A certification is never edited; a material change after certification writes a compliance finding `certification_stale` until a new row appears.

### 4.10 `eldUnidentifiedAssignments` — claims and assignments of unidentified driving

`assignmentRef`, `orgRef`, `eventRefsJson` (the unidentified events), `unitId`, `proposedOperatorId`, `proposedByUserId`, `proposedByRole` enum driver_claim/office, `proposedAt`, `status` enum proposed/accepted/rejected/annotated_not_driver, `decidedByUserId`, `decidedAt`, `note`. Acceptance writes correction events with `recordOrigin = office_edit`, `supersedesEventRef` = the unidentified events, `operatorId` = the assignee. The original events keep `operatorId = NULL` forever.

### 4.11 `eldDiagnosticFindings` — diagnostic and malfunction records

| Column | Note |
|---|---|
| `findingRef` unique, `orgRef` | |
| `kind` enum `diagnostic` / `malfunction` | the standard's two-tier distinction, profile-defined |
| `code` varchar(40) | from `reasonCodes.ts` (§7) |
| `eldDeviceId`, `unitId` NULL, `operatorId` NULL | |
| `openedAt`, `openedByEventRef` NULL | device-reported or engine-detected |
| `detectedBy` enum `device` / `engine` | |
| `clearedAt` NULL, `clearedByEventRef` NULL, `clearedByUserId` NULL | |
| `evidenceJson` | event refs, telemetry snapshot ids, sequence ranges |
| `explanation` varchar(600) | |
| `status` enum open/cleared/acknowledged | |

### 4.12 `eldComplianceFindings` — compliance findings (§8)

One row per finding; resolution is a status transition plus an append-only `eldComplianceFindingEvents` (`findingId`, `eventType` opened/acknowledged/resolved/reopened/escalated, `byUserId`, `at`, `note`).

### 4.13 Projections (derived, rebuildable, never legal records)

- `hosDailyProjections`: `orgRef`, `operatorId`, `dutyDate`, `timezone`, `profileKey`, `profileVerified`, `clocksJson`, `determinationJson`, `verdict`, `violationCount`, `warningCount`, `unidentifiedMinutes`, `certificationStatus`, `ledgerHeadHash` (the last event hash included), `computedAt`, `engineVersion`. Unique `(operatorId, dutyDate, engineVersion)`.
- `hosCycleProjections`: `operatorId`, `cycleKey`, `windowFrom`, `windowTo`, `onDutyMinutes`, `resetAvailableAt` NULL, `verdict`, `ledgerHeadHash`, `computedAt`.
- `eldEventStatus`: `eventRef`, `active` bool, `supersededByEventRef` — a cache of the derivation in 4.6.
- Fleet aggregates are computed on read from the above in Phase 6 and cached only if measured slow.

Every projection row records `ledgerHeadHash` + `engineVersion` so a reader can tell whether it is stale (`hos.projection.stale` outbox event) and which engine produced it.

### 4.14 `hosExemptionGrants` — rule-supported exceptions

`grantRef`, `orgRef`, `subjectType` enum operator/organization, `subjectId`, `profileKey`, `exemptionKey` varchar(60) (e.g. `adverse_driving`, `emergency`, `oil_well_service`, `short_haul_radius` — **keys only; applicability requires verification**), `ruleReference` varchar(200), `effectiveFrom`, `effectiveTo`, `evidenceDocumentId` NULL, `requestedByUserId`, `approvedByUserId` (≠ requester), `status` requested/approved/refused/revoked, `revokedAt`, `revokedByUserId`. The engine applies an exemption only when `approved`, in force, and its `exemptionKey` is one the selected profile's mechanics module implements.

### 4.15 Changes to existing tables

- `hosRuleProfiles`: add `mechanicsKey varchar(40) NULL` (which mechanics module governs; NULL = `trailing_window` default, and the determination says so).
- `operators`: add `homeTerminalTimezone varchar(64) NULL`, `homeTerminalRef varchar(64) NULL`, `dutyDayStartMinutes smallint NULL` (the carrier-designated start of the 24-hour day, *requires verification* as a concept per regime). NULL → the engine answers `unknown` for day-bound limits and names the missing rung, exactly as `selectProfile` does.
- `auditPackages.kind`: add `eld_inspection`.
- `INBOUND_FEEDS`: add `eld_event`. `eld_duty_status` is kept for one release and routed into the ledger as `recordOrigin = integration`, then deprecated.
- `dutyRecords`: no schema change. Migration backfill (§17) copies rows into `eldEvents` with `recordOrigin = legacy_duty_record`, `sourceKind = migration`, `sourceRef = dutyRecords.id`, and the two writers are redirected to the ledger. `auditRouter` reads the ledger.

---

## 5. ELD event schema

```ts
// shared/eld/events.ts — shared by server engines and client runtime
export type EldEventType =
  | "duty_status_change"          // dutyStatus required
  | "intermediate_location"       // periodic while moving
  | "special_category_change"     // personal_conveyance | yard_move | none
  | "engine_power_up" | "engine_power_down"
  | "motion_start" | "motion_stop" // vehicle crossed the profile's motion threshold
  | "driver_login" | "driver_logout"
  | "co_driver_login" | "co_driver_logout"
  | "jurisdiction_change"
  | "certification" | "recertification"
  | "diagnostic_opened" | "diagnostic_cleared"
  | "malfunction_opened" | "malfunction_cleared"
  | "correction"                  // an accepted correction row; supersedesEventRef set
  | "annotation";                 // legacy note-only rows from migration

export type EldEventInput = {
  eventRef: string;                     // UUID v4 from the device; provider id for integrations
  deviceSequence: number | null;        // device-local monotonic; null only for office rows
  eventType: EldEventType;
  eventCode: string;                    // profile vocabulary code, e.g. "DS_D", "IL_60"
  eventAt: string;                      // ISO-8601 with offset, device clock
  eventUtcOffsetMinutes: number | null;
  dutyStatus?: DutyStatus | null;
  specialCategory?: "none" | "personal_conveyance" | "yard_move";
  recordOrigin: "automatic" | "driver" | "office_edit" | "assumed_unidentified" | "integration";
  operatorExternalId?: string | null;   // integration path only; mapped via eldExternalIdentifiers
  unitExternalId?: string | null;
  location?: { latitude: number; longitude: number; accuracyM: number | null; source: "gps"|"network"|"manual"|"ecm"|"none"; description?: string | null } | null;
  jurisdiction?: string | null;
  odometerKm?: number | null;
  engineHours?: number | null;
  vehicleSpeedKph?: number | null;
  malfunctionCode?: string | null;
  diagnosticCode?: string | null;
  annotation?: string | null;
  supersedesEventRef?: string | null;   // correction rows only
};
```

**Canonical form:** `canonicalJson` (`client/src/runtime/crypto.ts:22`, already used for seals) over the input with keys sorted, numbers normalized, timestamps in UTC millisecond precision plus the reported offset. `payloadHash = sha256(canonical)`. The device computes it; the server recomputes it and refuses a mismatch (same three-way discipline as `verifyPackageItems`).

**Validation** (pure, `ledger.ts`): required fields per `eventType`; `dutyStatus` present iff `duty_status_change`; `supersedesEventRef` present iff `correction`; `eventAt` parseable; `deviceSequence` non-negative integer; a `correction` may not itself be superseded by a row with `recordOrigin = automatic`.

**Duty status projection** (`hosProjection.ts`): a `DutyEntry` opens at each active `duty_status_change` and closes at the next active one for the same operator; `personal_conveyance` projects to `off_duty` and `yard_move` to `on_duty` **only if the selected profile's mechanics module says so** (*requires verification* per regime, §18); motion events with `operatorId = NULL` project to *unidentified driving segments*, not to any driver's entries. This is the bridge that lets the existing `computeClocks` consume the ledger unchanged.

---

## 6. HOS rule-engine interface

The existing engine is kept and wrapped. New public surface:

```ts
// server/_core/eld/hosEngine.ts (pure)
export type HosEngineInput = {
  events: readonly EldEvent[];               // ordered, active rows only, one operator (+ team rows)
  operator: { operatorId: number; homeTerminalTimezone: string | null; dutyDayStartMinutes: number | null };
  context: OperatingContext;                 // existing type; jurisdiction/latitude from the latest jurisdiction span
  profiles: readonly HosRuleProfile[];       // loaded from the registry, as today
  exemptions: readonly ExemptionGrant[];     // approved and in force at `at`
  at: Date;
  engineVersion: string;                     // e.g. "hos-engine/2.0.0"
};

export type HosEngineResult = {
  engineVersion: string;
  selection: SelectionOutcome;               // existing
  mechanicsKey: string;                      // which module computed the boundaries, "trailing_window" when defaulted
  currentStatus: DutyStatus | null;
  timeInCurrentStatusMinutes: number;
  clocks: Clocks;                            // existing shape
  determination: HosDetermination;           // existing shape, each LimitDetermination gains:
                                             //   ruleId: string (profileKey + limitKey + promotionRef when verified)
                                             //   reasonCodes: HosReasonCode[]
  remaining: {                               // ONLY populated from verified determinations
    drivingMinutes: number | null; onDutyMinutes: number | null; shiftWindowMinutes: number | null;
    cycleMinutes: number | null; basisRuleIds: string[];
  };
  requiredRest: { minutes: number | null; earliestDrivingAt: Date | null; basisRuleIds: string[]; reasonCodes: HosReasonCode[] };
  warnings: HosFinding[];                    // approaching a verified limit (threshold is engine config, not law)
  violations: HosFinding[];                  // exceeded a verified limit
  unknowns: HosFinding[];                    // limits that could not be determined, each naming why
  appliedExemptions: { grantRef: string; exemptionKey: string; effect: string }[];
  explanation: string;                       // human-readable
  reasonCodes: HosReasonCode[];              // machine-readable summary
};

export type HosFinding = { code: HosReasonCode; ruleId: string | null; limitKey: LimitKey | null;
  usedMinutes: number | null; limitMinutes: number | null; fromAt: Date | null; explanation: string };
```

**Mechanics modules** (`server/_core/hos/mechanics/index.ts`):

```ts
export interface MechanicsModule {
  key: string;                                            // matches hosRuleProfiles.mechanicsKey
  dutyDayWindow(at: Date, op: OperatorDayContext): { from: Date; to: Date } | { unknown: string };
  shiftStart(entries: DutyEntry[], at: Date, limits: VerifiedLimits): Date | { unknown: string };
  cycleWindows(at: Date, limits: VerifiedLimits): CycleWindow[] | { unknown: string };
  resetDetection(entries: DutyEntry[], limits: VerifiedLimits): ResetInfo | { unknown: string };
  specialCategoryProjection(cat: SpecialCategory): DutyStatus | { unknown: string };
  supportedExemptions: readonly string[];
  applyExemption(key: string, clocks: Clocks, limits: VerifiedLimits): Clocks | { unsupported: string };
}
```

Every branch that would need a regulatory fact not present as a verified limit returns `{unknown}` naming the rung, and `determine` carries that into `unknowns[]`. A module never contains a number; numbers come only from `hosRuleLimits`. **The `trailing_window` module is today's `computeClocks` behaviour, and any determination computed with it says "shift and day boundaries are a default, not a regime rule".**

**Warnings** use thresholds that are LeaseOS configuration (e.g. "warn at 30 min before a verified limit"), stored as company policy through the existing `automationPolicies`-style store, and labelled as policy in the explanation, never as law.

**Reason codes** (all in `reasonCodes.ts`, one union): `HOS_PROFILE_UNKNOWN`, `HOS_PROFILE_CONFLICT`, `HOS_LIMIT_UNVERIFIED`, `HOS_MECHANICS_DEFAULTED`, `HOS_DAY_BOUNDARY_UNKNOWN`, `HOS_TIMEZONE_UNKNOWN`, `HOS_DRIVING_LIMIT_EXCEEDED`, `HOS_ON_DUTY_LIMIT_EXCEEDED`, `HOS_SHIFT_WINDOW_EXCEEDED`, `HOS_CYCLE_LIMIT_EXCEEDED`, `HOS_BREAK_REQUIRED`, `HOS_REST_INSUFFICIENT`, `HOS_APPROACHING_LIMIT`, `HOS_EXEMPTION_APPLIED`, `HOS_EXEMPTION_UNSUPPORTED`, `HOS_DATA_GAP` (a diagnostic affected the window), `HOS_UNIDENTIFIED_DRIVING_IN_WINDOW`.

---

## 7. Diagnostics interface

```ts
// server/_core/eld/diagnostics.ts (pure)
export type DiagnosticsInput = {
  events: readonly EldEvent[];                 // one device stream, ordered by deviceSequence
  telemetry: readonly TelemetrySnapshotLike[]; // unit's telemetrySnapshots in the window
  device: { eldDeviceId: number; lastSyncReceivedAt: Date | null; pendingPackageCount: number | null; clockSkewMs: number | null };
  bindings: readonly VehicleBindingLike[];
  sessions: readonly DriverSessionLike[];
  techProfile: TechStandardProfile | null;     // supplies intervals/thresholds; null → interval checks are "unknown"
  window: { from: Date; to: Date };
  at: Date;
};

export type DiagnosticFinding = {
  code: DiagnosticCode; kind: "diagnostic" | "malfunction";
  eldDeviceId: number; unitId: number | null; operatorId: number | null;
  openedAt: Date; detectedBy: "device" | "engine";
  evidence: { eventRefs: string[]; telemetryIds: number[]; sequenceRange?: [number, number]; detail: string };
  explanation: string; affectsRecordQuality: boolean;
};
```

`DiagnosticCode` (registry in `reasonCodes.ts`): `ECM_COMMUNICATION_UNAVAILABLE`, `LOCATION_UNAVAILABLE`, `CLOCK_DISCREPANCY`, `SEQUENCE_GAP`, `SEQUENCE_DUPLICATE`, `SEQUENCE_OUT_OF_ORDER`, `EVENT_MISSING_EXPECTED` (e.g. motion without a preceding power-up), `ODOMETER_DISCONTINUITY`, `ENGINE_HOURS_DISCONTINUITY`, `MOTION_WITHOUT_AUTHENTICATED_DRIVER`, `UNIDENTIFIED_DRIVING`, `DEVICE_POWER_INTERRUPTION`, `SYNC_BACKLOG`, `INTERMEDIATE_LOCATION_GAP`, `SENSOR_DISAGREEMENT` (GPS speed vs ECM speed, GPS distance vs odometer delta), `JURISDICTION_UNDETERMINED`, `TELEMETRY_INTEGRITY` (hash chain break, payload hash mismatch), `TIMING_INCONSISTENT` (eventAt regresses against deviceSequence).

Whether a code is `diagnostic` or `malfunction`, and the thresholds (interval, motion speed, allowed skew), come from the technical-standard profile; when the profile is null or unverified the finding is emitted as `diagnostic` with `explanation` saying the threshold is a LeaseOS default. `affectsRecordQuality` is what the compliance engine reads. A diagnostic never names a driver as at fault; `operatorId` is present only to route the finding.

Inputs already available: `detectSequenceGaps` pattern, `odometerReconciliation`, `signatureFreshness` skew, `jurisdiction.ts` confidence, `syncPackages.attemptCount/state` for backlog.

---

## 8. Compliance finding model

```ts
export type ComplianceFinding = {
  findingRef: string; code: ComplianceCode; severity: "info" | "review" | "high" | "blocking";
  orgRef: string | null; operatorId: number | null; unitId: number | null;
  eventRefs: string[]; ruleReference: string | null;          // profileKey.limitKey.promotionRef or spec section
  detectedAt: Date; status: "open" | "acknowledged" | "resolved" | "reopened";
  explanation: string; evidence: { eventRefs: string[]; findingRefs: string[]; documentIds: number[]; projectionRefs: string[] };
};
```

`ComplianceCode` (registry): `CERTIFICATION_MISSING`, `CERTIFICATION_STALE` (material change after certification), `UNIDENTIFIED_DRIVING_UNRESOLVED`, `LOG_INFORMATION_MISSING` (required data element absent per tech profile), `POSSIBLE_DUTY_DISCREPANCY` (motion while OFF/SB; odometer advance with no driving), `HOS_VIOLATION` (from the HOS engine, carries the `HosFinding`), `RECORD_QUALITY_AFFECTED` (open diagnostic with `affectsRecordQuality`), `RULE_SET_UNCERTAIN` (selection unknown/conflict, mechanics defaulted), `AUDIT_EVIDENCE_INSUFFICIENT` (hash chain gap, unsigned source), `REPEATED_CORRECTIONS` (count over a policy threshold), `EDIT_AFTER_CERTIFICATION_PENDING`, `EXEMPTION_EXPIRED_IN_USE`.

Severity ladder maps onto dispatch: `blocking` → dispatch blocker severity `blocking`; `high`/`review` → `review`; `info` → contribution only. **No finding code contains the words fraud or falsification.** `POSSIBLE_DUTY_DISCREPANCY` explanations use the fixed phrasing "requires compliance review: <observation>; <what evidence was preserved>".

Resolution is a status transition recorded in `eldComplianceFindingEvents` with the resolver's identity and note; resolving never deletes the finding or the evidence.

---

## 9. Analytics / read-model architecture

- All metrics are functions of projections (4.13) and findings (4.11, 4.12), never of raw arithmetic in a router or React component.
- **Driver read model** (per day and per cycle): driving/on-duty/off-duty/sleeper minutes, utilization (on-duty ÷ elapsed), available minutes per clock *only when verified*, cycle remaining, warnings, violations, unidentified minutes attributed to the unit not the driver, open findings.
- **Fleet read model**: counts of drivers by verdict, drivers nearing a verified limit within N minutes (policy N), drivers not dispatchable and why (by reason code), unidentified driving totals per unit, diagnostic and malfunction frequency per device and per model, missing certifications, open correction requests, repeated findings, inspection readiness (a driver is "inspection ready" when the last 14 duty days — *the count requires verification* — have certifications, no open malfunction, and an inspection package can be assembled).
- **Predictive**: `predictedExhaustionAt` per clock = `at + remaining` assuming continuous current status; `estimatedRequiredRest` from `requiredRest`; job simulation (§12) appends a hypothetical duty segment to the events and re-runs the engine — same code path, labelled `simulation`.
- Read models are computed on demand in Phase 6, persisted to `hosDailyProjections`/`hosCycleProjections` by the outbox consumer on `eld.event.recorded`, and served through `eldRouter` and the existing widget registry with `hosClockPresentation`-style confidence labelling. Every projection carries `ledgerHeadHash` so a stale row is visibly stale.

---

## 10. Offline synchronization strategy

**Device side** (`client/src/runtime/eldOutbox.ts`, alongside the existing outbox):

1. Every ELD event is written to the encrypted local store *before* any UI acknowledgement, with `eventRef = crypto.randomUUID()` and `deviceSequence` from a durable per-device counter in local meta (same technique as `packageSeq`). The existing `uid()` is not used for ELD events.
2. `payloadHash` is computed on the device; the device also maintains its own `previousEventHash` chain so the server can verify continuity.
3. Events are transported inside the existing signed sync package as capture kind `hos_event` with `fields = EldEventInput` (tier 0 priority already). A package may carry many events; the 500-item cap applies.
4. The device runs the same pure engines (`hos.ts`, `hosProjection.ts`, `ledger.ts` are dependency-free) against its local events and the last downloaded rule pack (profiles + verified limits, hashed), so the driver's clocks work with no signal. Offline determinations are labelled `computedOffline: true, rulePackHash` and are never uploaded as facts; only events are uploaded.
5. Receipt handling: each event is `synchronized` only when its `eventRef` appears in the server's `itemVerdicts` with `verified: true`; otherwise it stays `queued`/`failed` and is never discarded (existing six-state machine).

**Server side**:

1. `sync.receivePackage` stays as is. A new post-verification step (`eldSyncProjector`) reads verified items of kind `hos_event`, resolves `eldDeviceId` from `fieldDevices.id`, `operatorId` from the device's user through `organizationWorkers`/`operators.userId` (never from the payload), and calls `eldLedgerStore.append(batch)`.
2. `append` is one transaction per package: for each event, insert-or-recognize. Idempotency is two-layered: `eventRef` unique (global) and `(eldDeviceId, deviceSequence)` unique. A duplicate with the same `payloadHash` is acknowledged as already recorded; a duplicate with a *different* hash is refused and recorded as `TELEMETRY_INTEGRITY` with both hashes preserved.
3. Ordering: rows are stored as received; canonical order for all engines is `(eldDeviceId, deviceSequence)` for one stream and `eventAt` across streams, with `TIMING_INCONSISTENT` raised when the two disagree. Gaps in `deviceSequence` open `SEQUENCE_GAP` and are closed automatically when the missing sequence arrives.
4. Hash chain: the server recomputes `eventHash` from its stored previous row; a mismatch opens `TELEMETRY_INTEGRITY` and the event is still stored (loss of evidence is worse than a flagged row).
5. Integration path (`eld_event` feed): the batch shares `inboundEvents` idempotency, then goes through the same `append`; `operatorExternalId`/`unitExternalId` resolve through `eldExternalIdentifiers`; an unmapped id yields `operatorId = NULL` events (unidentified) plus a finding, never a guess by name.
6. Reconciliation: an `eld.event.recorded` outbox event per appended batch triggers projection rebuild for the affected operators and days.

---

## 11. Audit / correction workflow

```
driver or office proposes  →  eldCorrectionRequests(requested)  [original events untouched]
      │  reason required; affected refs + proposed events canonicalized and hashed
      ▼
second identity decides  →  accepted | rejected           [row transitions once; trigger-guarded]
      │  accepted: eldLedgerStore.append(correction events with supersedesEventRef, recordOrigin=office_edit or driver)
      │            eldEventStatus cache updated (derived); certification for the day → CERTIFICATION_STALE finding
      ▼
driver recertifies  →  new eldLogCertifications row with new logHash, previous row supersededBy…
```

Preserved for every correction: the original event rows (immutable), the requesting identity/role/time, the proposed events (verbatim in the request), the reason, the deciding identity/time/note, the driver's acceptance where the office proposed, the resulting event refs, and the certification state before and after. `recordAmendments`-style field diffs are unnecessary because both sides are whole events.

Office-originated corrections to a driver's record require the driver's acceptance before they become active (*requires verification*, §18); until then they are `requested` and the projection shows the original with a pending-correction marker.

Certification: only the driver certifies their own day (`eld.certify_own`, universal, self-scoped). The `logHash` is over the active events of the day in canonical order, so an inspector can recompute it.

---

## 12. Dispatch integration

Changes to `readinessComposer.composeReadiness` (the only place that changes):

1. Load the operator's active ledger events (lookback ≥ the longest cycle in any live profile + 1 day), run `hosEngine`, and:
   - if `determination.verdict === "within"` and the governing driving/on-duty limits are verified → `hoursAvailableMinutes = min(remaining.drivingMinutes, remaining.onDutyMinutes, remaining.shiftWindowMinutes, remaining.cycleMinutes)` (all non-null), and `facts.hoursAvailableMinutes` the same (so the fingerprint changes when hours change);
   - if any violation → new blocker `hos_violation_active` (blocking, **overridable: false**);
   - if `unknown` → `hoursAvailableMinutes = null` (today's `hos_unknown` path, unchanged) with the engine's `reasonCodes` in the contribution;
   - attestation continues to apply only when the ledger has **no events** for the duty day (paper-log companies); an attestation never overrides a ledger.
2. `projectedJobMinutes` comes from `evaluateHosFeasibility` (below) when the caller supplies a `proposedJob`; the existing `hos_insufficient` blocker becomes reachable.
3. New review blockers (overridable by manager, recorded): `hos_data_quality_review` (open diagnostic with `affectsRecordQuality`), `hos_unidentified_driving_unresolved` (unit has unresolved unidentified driving in the window), `hos_certification_missing` (policy-configurable whether this blocks), `hos_rule_set_uncertain` (selection unknown/conflict or mechanics defaulted — this is the honest replacement for today's blanket `hos_unknown`).
4. Exceptions are only `hosExemptionGrants` rows the engine applied; a dispatcher cannot set a boolean. `dispatchOverrides` on `hos_violation_active` are refused by the engine's existing "not overridable" rule.
5. `CAPABILITY.hos` is `PASS`/`REVIEW`/`BLOCKED`/`UNKNOWN` from the engine, `NOT_EVALUATED(no_data_source_loaded)` when the operator has no ledger and no attestation.

```ts
export function evaluateHosFeasibility(input: {
  engineResult: HosEngineResult;
  proposedJob: { startsAt: Date; estimatedDriveMinutes: number | null; estimatedOnDutyMinutes: number | null;
                 durationSource: "posting_estimate" | "shift_post" | "route_model" | "caller" | "unknown" };
}): {
  verdict: "legal" | "illegal" | "unknown";
  availableMinutes: { driving: number | null; onDuty: number | null; shiftWindow: number | null; cycle: number | null };
  estimatedRequiredMinutes: { driving: number | null; onDuty: number | null };
  limitingRuleId: string | null;
  requiredRestBeforeStart: { minutes: number | null; earliestStartAt: Date | null };
  predictedStateAtCompletion: { drivingMinutesLeft: number | null; cycleMinutesLeft: number | null } | null;
  reasonCodes: HosReasonCode[];
  explanation: string;
}
```

`unknown` whenever any needed limit is unverified, the mechanics are defaulted for a day-bound limit, or the duration source is `unknown`. **Job duration has no source today** (§1.11); Phase 5 wires `dispatchPostings.estimatedDurationMinutes` and `shiftPosts.startsAt/endsAt` as `posting_estimate`/`shift_post` sources and leaves `route_model` for a future speed model. The explanation always names the source of the estimate.

---

## 13. Job-board integration

`openShifts.candidatesFor` gains an `hos` input computed by the same `evaluateHosFeasibility` against the shift's `startsAt/endsAt` (duration source `shift_post`), producing `IneligibilityCode` additions `hos_illegal` and `hos_unknown` (the latter surfaced as "needs readiness check", which `intendToAssign` already requires). The seven job-board questions map as: qualified → existing `workerQualifications`; credentials → `compliance.passport`; unit available → `resourceBookings`; enough HOS/cycle → feasibility; predicted return/rest → `requiredRestBeforeStart` + `predictedStateAtCompletion`; compliance status → open findings with severity ≥ `high`. No arithmetic in `openShiftsRouter` or the UI.

---

## 14. Driver Portfolio integration

- Passport items: a new requirement `hos.daily_certification` (seeded unverified like every requirement) satisfied by `eldLogCertifications` rows; `hos.daily_log` continues to accept scanned paper for paper-log companies.
- The driver audit package (`auditRouter`) replaces its `dutyRecords` items with ledger items (`eldEvents` active + superseded, certifications, correction requests, findings), each with `contentHash = eventHash`.
- Driver-facing portfolio surface lists: certifications by day, open findings, correction history, and the current clocks through `hosClockPresentation` — with the `remaining` tiles allowed only from a `LimitDetermination` with a verified limit.

---

## 15. Security / authorization model

- Every ELD table carries `orgRef`; every procedure resolves scope with `resolveActingScope` and checks subjects with `operatorInScope`/`unitInScope`/`recordBelongsToOrganization`; out-of-scope answers NOT_FOUND.
- Device path: `operatorId` is derived from the enrolled device's `userId` → `organizationWorkers`/`operators.userId`; the payload's operator field is ignored and a mismatch is a finding.
- Integration path: `integrationClients.orgRef` is the tenant; ids map only via `eldExternalIdentifiers`; the client must be scoped for `eld_event`.
- Proposed permissions (all mapped in `OPERATIONAL_PROCEDURE_PERMISSIONS`; counts bumped):
  - universal self-scoped: `eld.read_own`, `eld.event.record_own`, `eld.correction.request_own`, `eld.certify_own`, `eld.unidentified.claim_own`
  - role: `eld.read` (dispatcher, safety, office, management, auditor), `eld.device.manage` (management, safety), `eld.correction.decide` **sensitive**, `eld.unidentified.assign` **sensitive**, `eld.finding.resolve` **sensitive**, `eld.inspection.package` (safety, management), `hos.exemption.request`, `hos.exemption.approve` **sensitive** (second person), `eld.techstandard.manage`/`verify` **sensitive**
  - deny: drivers never hold `eld.correction.decide` for their own requests; the requester ≠ decider rule is enforced in code as in `limitPromote`.
- Immutability is enforced at three layers: the store (only `append`), the database (BEFORE UPDATE/DELETE triggers on `eldEvents`, `eldEventAnnotations`, `eldLogCertifications`, `eldComplianceFindingEvents`), and tests that attempt an UPDATE through raw SQL and expect SQLSTATE 45000.
- Audit: sensitive permissions fail closed through `authorizationDecisions` exactly as today.

---

## 16. Testing strategy

Pure engine tests first (`server/_core/eld/*.test.ts`, `server/_core/hos/mechanics/*.test.ts`), database tests second, UI last. Deterministic time by constants; no wall clock; every fixture built by `server/_core/eld/fixtures.ts` builders (`day()`, `drive()`, `rest()`, `event()`, `stream()`) with explicit timezones.

Scenario matrix (each a named fixture, each asserting reason codes, not prose):

| Area | Scenarios |
|---|---|
| Ledger | duplicate delivery (same hash → acknowledged once; different hash → integrity finding), out-of-order delivery reconstructs by sequence, sequence gap opens and closes, hash-chain break, office row without sequence, payload hash mismatch refused |
| Projection | normal duty day, movement transitions, PC/YM projection when module defines it and `unknown` when not, unidentified segments never enter a driver's entries, superseded events excluded, correction chain of depth 2 |
| Boundaries | midnight in home-terminal zone, driver in a different zone than the terminal, DST spring-forward and fall-back days (23 h / 25 h days), duty-day start not at midnight, `dutyDayStartMinutes` NULL → `HOS_DAY_BOUNDARY_UNKNOWN` |
| HOS | synthetic verified profile exceedance keeps observed status (extends the 0079 invariant), unverified limit → unknown with clocks shown, mechanics defaulted → `HOS_MECHANICS_DEFAULTED` on day-bound limits only, exemption applied only when approved and supported, rule-set version change mid-window evaluates each span under its own version, jurisdiction change selects a new profile from the change event, team driving (co-driver's sleeper time not counted as driver's driving) |
| Diagnostics | GPS loss, ECM loss, odometer jump, engine-hour discontinuity, motion without authenticated driver, clock regression against sequence, sync backlog, intermediate-location gap (with and without a tech profile) |
| Compliance | missing certification, edit after certification, unresolved unidentified driving, motion while OFF → `POSSIBLE_DUTY_DISCREPANCY` with fixed phrasing and preserved evidence, repeated corrections over policy threshold |
| Feasibility | legal with margin, illegal naming the limiting rule, unknown when duration source unknown, required rest before start, predicted state at completion |
| Dispatch (db) | live ledger fills `hoursAvailableMinutes` and changes the fingerprint; violation → `hos_violation_active` non-overridable; attestation ignored when ledger has events; `hos_insufficient` reachable |
| Job board | `hos_illegal` and `hos_unknown` ineligibility from the same function |
| Security (db) | cross-org read → NOT_FOUND; device payload naming another operator → recorded under the device's operator with a finding; UPDATE on `eldEvents` → 45000; requester cannot decide own correction |
| Offline (node) | device outbox round trip through the memory adapter: events survive a simulated crash, package receipt marks only acknowledged refs |

Gate impact: new router file added to `OPERATIONAL_SOURCES`; counts in `crossLayerIntegrity.test.ts` and `procedureAuthorization.test.ts` bumped; `LEASEOS_CURRENT_STATE.md` regenerated; column parity and reserved-word suites pass; test-file type errors remain 0.

---

## 17. Migration plan

Order within one phase; numbers assigned at implementation time from `ls drizzle | tail` (0170 is free at survey time; do not trust this document over the directory).

1. `NNNN_eld_ledger.sql` — `eldTechnicalStandardProfiles`, `eldDevices`, `eldVehicleBindings`, `eldExternalIdentifiers`, `eldEvents` (+ triggers), `eldEventAnnotations`, `eldEventStatus`. `INBOUND_FEEDS` gains `eld_event`. `hosRuleProfiles.mechanicsKey`. `operators.homeTerminalTimezone/homeTerminalRef/dutyDayStartMinutes`.
2. `NNNN_eld_corrections_certifications.sql` — `eldDriverSessions`, `eldCorrectionRequests`, `eldLogCertifications`, `eldUnidentifiedAssignments`, `hosExemptionGrants`.
3. `NNNN_eld_findings_projections.sql` — `eldDiagnosticFindings`, `eldComplianceFindings`, `eldComplianceFindingEvents`, `hosDailyProjections`, `hosCycleProjections`; `auditPackages.kind` + `eld_inspection`.
4. `NNNN_duty_records_to_ledger.sql` — data migration: one `eldEvents` row per `dutyRecords` row (`recordOrigin = legacy_duty_record`, `sourceKind = migration`, `sourceRef = id`, `orgRef` resolved through `coreRecordOwnership`, `eventRef = LEGACY-<id>`), plus an end-marker event where `endedAt` is set. `dutyRecords` is left in place and read-only by convention until a later retirement migration; both writers are redirected in code in the same phase.

Each migration: header comment in the repository's voice, `CREATE TABLE` at line start, breakpoints, MariaDB syntax, trigger bodies with `BEGIN`/`END;` on their own lines, no MariaDB reserved words (`reservedWordColumns.test.ts` pins the known set; prefixed names such as `deviceSequence` and `eventCode` are used above to stay clear of it).

---

## 18. Regulatory / specification facts that still require authoritative verification

Nothing below is asserted as true by this document. Each is a question a controller answers through the promotion/verification path before the engine determines anything from it.

**Canadian federal HOS (Commercial Vehicle Drivers Hours of Service Regulations)**
1. Every figure in `hosRuleSeeds.ts` (13/14/16, 10 off, 8 core, 70/7, 120/14, 36 h and 72 h resets, 24 h in 14 days, north-of-60 figures) — all seeded unverified; `CA_FEDERAL_NORTH60.daily_on_duty_minutes` is contested.
2. Definition of "day" (designated 24-hour period, whether the carrier sets its start), and how a change of day-start is handled.
3. Cycle definitions: whether cycle days are calendar days in the home-terminal zone, how a cycle switch is permitted, what constitutes a cycle reset.
4. Off-duty deferral provisions, split sleeper-berth provisions (single and team), and whether personal conveyance counts as off duty and yard move as on duty, with any distance/time caps.
5. Adverse driving, emergency and oil-well-service (and any other) exemptions: which exist, what they change, what evidence is required.
6. Team driving rules: what time in a moving vehicle counts as, for the co-driver.
7. Which jurisdictions adopt the federal text by reference and for which carriers.

**Alberta provincial HOS** — every `AB_PROVINCIAL` figure, the 11 794 kg threshold, the break rule, reduced-rest floor; whether intraprovincial carriers of specific vehicle classes are exempt from ELD; the 160 km/daily-return RODS exemption noted in `research_hos_sources.md`.

**U.S. FMCSA 49 CFR 395** — all figures (kept as a future rule pack; nothing seeded).

**Canadian ELD Technical Standard**
8. The current version identifier and its in-force status; the user's message cites CCMTA "Technical Standard 1.3.1 released 22 July 2026" and a Transport Canada transition — **this has not been verified by this survey and must not be encoded as fact**. The profile table exists so that any version can be loaded as a row.
9. Automatic driving-status threshold (the user cites "up to 8 km/h"), intermediate-location interval while moving (the user cites 60 minutes), engine-power and motion event definitions, required data elements per event, location precision and privacy rounding for personal conveyance, event record-origin and record-status vocabularies, diagnostic vs malfunction code list and their clearing conditions, unidentified-driving handling (retention period, assignment, annotation), edit/correction rules (who may propose, driver acceptance, what is retained), certification requirements (per day, recertification after change), roadside transfer/output file format, retention periods for the carrier and on the device, clock-accuracy tolerance.
10. Third-party certification requirement: the user states Canadian ELDs require third-party certification before being represented as compliant; the design encodes only `certificationStatus` with `not_certified` as default and never labels LeaseOS a certified ELD.

**LeaseOS policy facts (not law, but must be declared as policy)** — warning thresholds, repeated-correction threshold, whether a missing certification blocks dispatch, inspection-readiness window.

---

## 19. Conflicts with current LeaseOS architecture

1. **`dutyRecords` is mutable and untenanted**; the ledger supersedes it. Until the backfill runs, the two can disagree. Mitigation: redirect both writers in the same phase as the ledger table; `hos.status` reads the ledger only after backfill.
2. **`operators.name` matching in the integration feed** must be replaced by `eldExternalIdentifiers`; existing `eld_duty_status` clients will break unless the mapping is seeded from current names during migration (a one-time, logged seed with `recordedByUserId = system`).
3. **`operators.id = userId` lookups** in `readinessRouter`, `openShiftsRouter`, `crewRouter` will attribute HOS to the wrong operator whenever ids diverge. The ELD subsystem must not inherit this; a fix to those three call sites is recommended but is outside this branch's scope unless the job-board phase touches them.
4. **`computeClocks` semantics** (trailing windows) become the `trailing_window` mechanics module; existing `hos.test.ts` expectations remain valid for that module. Regime modules will produce different clocks for the same entries by design; tests must target a named module.
5. **`hosClockPresentation.FORBIDDEN_LABELS`** includes "remaining"; the new `remaining` fields need a presentation type that is constructible only from a verified determination. Widget code that reads `Clocks` must not read `remaining`.
6. **Concurrent dispatch work on main** touches `readinessComposer.ts`, `dispatchReadiness.ts`, `dispatchRouter.ts` and the readiness panel (the most recent five commits). The dispatch integration (§12) should be the last phase and be rebased onto main immediately before implementation; the composer change is confined to the HOS block (`:604-625`, `:703`, `:770`).
7. **Pinned counts** (`crossLayerIntegrity` 691 paths, operational map 629, records 18) will collide with concurrent branches; bump from the merged base, not from these numbers.
8. **`inboundEvents` unique constraint is SQL-only**; the ELD feed does not rely on it and adds its own uniqueness on `eldEvents`.
9. **No timezone on operators**; day-bound limits stay `unknown` for every driver until the column is populated, which is the correct behaviour and must be explained in the UI rather than hidden.
10. **Outbox has one live producer**; adding ELD producers means the production worker must register an `eld` handler in `workerLifecycle.withHandlers`, or events fall to the generic rules path and do nothing.
11. **`auditPackages` has no `orgRef`**; the inspection package kind inherits this gap and should be scoped through its subject until that table is tenanted.

---

## 20. Implementation phases

Each phase ends with a checkpoint document, the full gate green, and no UI unless named.

| Phase | Deliverable | Depends on | Gate additions |
|---|---|---|---|
| **0** | This document reviewed; data model corrected against code | — | — |
| **1 — Ledger** | Migrations 1 + 4 (tables, triggers, backfill), `shared/eld/events.ts`, `ledger.ts` (pure), `eldLedgerStore.append`, `hosProjection.ts`, `eld_event` feed + `eldExternalIdentifiers`, sync projector for `hos_event`, redirect both `dutyRecords` writers, `eldRouter` read + record_own + device.manage | 0 | ledger and projection pure tests; db tests for immutability, idempotency, scope |
| **2 — HOS engine v2** | `hosEngine.ts` wrapper, `MechanicsModule` + `trailing_window` + skeleton `caFederal`/`abProvincial` (every rule `unknown` until a verified limit and a verified mechanics decision exist), `hosExemptionGrants`, reason codes, `hos.status` reads the ledger, `HosRemainingPresentation` | 1 | boundary/DST/timezone/team/version-change fixtures; 0079 invariant extended |
| **3 — Diagnostics** | `diagnostics.ts`, `eldDiagnosticFindings`, `eldTechnicalStandardProfiles` (seeded unverified keys only), outbox producer + worker handler | 1 | every diagnostic code has a fixture |
| **4 — Compliance, corrections, certification** | Migration 2 (+3 findings tables), `compliance.ts`, correction and certification procedures with two-person rules, unidentified assignment, findings lifecycle | 2, 3 | compliance fixtures; db tests for correction chain and recertification |
| **5 — Dispatch and job board** | `feasibility.ts`, composer HOS block, new blocker codes, capability status, `openShifts` HOS ineligibility, duration sources from postings/shift posts | 2, 4; rebase onto main first | dispatch db tests; fingerprint changes with hours |
| **6 — Projections, analytics, UI** | `projections.ts`, projection tables + rebuild consumer, driver clocks/logbook grid/violations/corrections/certification screens with "why" from reason codes, office review queue, fleet widgets through the widget registry | 4, 5 | widget source contracts; jsdom tests; presentation guard tests |
| **7 — Technical-standard conformance and inspection package** | profile verification console (reusing the HOS console pattern), inspection package kind with hashed manifest and two-person release, roadside output format as a versioned renderer per profile | 3, 6 | package hash reproducibility tests |

**Stop points:** after Phase 1 (ledger reviewed with real device and provider payloads) and after Phase 2 (engine reviewed against one verified figure through the console) before any UI work, as the user's sequence requires.

---

*Survey performed at commit `6b01a0e` on 2026-09-23. Four parallel read-only surveys plus direct reading of the HOS, dispatch, integration, device and migration code. No production file was modified.*
