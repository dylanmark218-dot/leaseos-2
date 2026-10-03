# Fleet & Equipment Portfolio — repository survey and design

**Status:** the survey and design, as written on 2026-09-23 against `main` `6f52b57`. Since then: the
foundation slice (holds, meters, events; `0200`/`0201`) was built from it on the mechanic-portal branch
and reconciled in `docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md`; the asset core (identity,
lifecycle, components, list and detail, unit-side readiness; `0242`/`0243`) is recorded in
`docs/fleet/FLEET_ASSET_CORE_CHECKPOINT.md`. Where those records and this document differ, the records
say what was built and why. The survey below is left as written: survey and design only. Written against
`main` = `6f52b57` (release `v23.25`) on branch `claude/fleet-equipment-portfolio-design-3d13d5`,
2026-09-23. Every table, column, procedure and file named here was read from the tree, not
recalled; line references are to `drizzle/schema.ts` unless another file is named.

The owner's framing is kept as the rule of the domain:

> People belong to the Driver/Employee Portfolio. Machines and physical assets belong to the
> Fleet & Equipment Portfolio. Jobs reference both.

---

## Part A — The required first response (17 items)

### 1. Branch and commit

| | |
|---|---|
| Branch | `claude/fleet-equipment-portfolio-design-3d13d5` |
| Head | `6f52b57` — "SPINE item 1: per-boundary confirmation — resolver and chain rule (#10)" |
| `origin/main` | `6f52b57` (same commit; the design branch carries no code yet) |
| Release | `v23.25` (`LEASEOS_RELEASE`) |
| Working tree | clean |

### 2. Migration state

| | |
|---|---|
| Files in `drizzle/*.sql` | 169 |
| Highest on `main` | `0174_dispatch_override_provenance.sql` (C1a; built as 0172, moved at integration) |
| Absent by rule | `0016`, `0017` (reserved, CI gate 0), `0094`, `0095`, `0098` (historical gaps), `0172`, `0173` (claimed by an open branch) |
| Used twice | `0157` (historical; never repeat) |
| `drizzle/meta/_journal.json` | frozen at `0018`; migrations are applied by `scripts/apply-migrations.sh` (CI) and `scripts/migrate.ts` (ledger) |

**Claims on open branches** (scan of every `origin/*` branch against `origin/main`, run 2026-09-23
with the script in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`):

| Number | File | Branch |
|---|---|---|
| 0170 | `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` |
| 0170 | `0170_work_calendar_tasks_reminders.sql` | `claude/work-calendar-task-engine-0mtjyk` |
| 0172, 0173, 0174, 0175 | training wallet / history guards / compliance operations / source review guards | `claude/training-academy-workforce-q3mdse` |
| 0175, 0176, 0177 | driver portfolio, events append-only, portfolio API | `claude/driver-portfolio-api-ya8928`, `claude/driver-portfolio-credential-wallet-ya8928` |
| 0178–0181 | document control definitions / register / numbering / templates | `claude/document-control-architecture-jlffzk` |
| 0179 | `0179_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` |
| 0179 | `0179_trip_stop_provenance.sql` | `claude/migration-0169-reconciliation` |

The first number free on `main` **and** on every open branch today is **`0182`**. Per the register's
rule and the compliance plan's rule ("reserve no number now; each checkpoint takes the next free slot
when its PR is opened"), this document claims nothing. The number is re-checked at PR time.

**Release blocker that precedes this work.** `docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`
records: *"Migration 0169 is claimed twice … Resolve it before the next migration-bearing feature in
either repository."* The Fleet Asset Core is a migration-bearing feature. It waits on that
reconciliation (branch `claude/migration-0169-reconciliation` exists and proposes `0179`). See owner
decision **O-1**.

### 3. Existing unit / vehicle / equipment tables

**`units` is the only machine table and it already anchors the whole system.** 53 tables carry a
`unitId` (or `trailerId` / `equipmentId` / `trailerUnitId` that points at `units.id` by convention).
There is no `vehicles`, `trucks`, `trailers`, `equipment` or `assets` table. *"There is no trailers
table: a trailer is a unit whose vehicleType says so"* (`server/readinessComposer.ts:637`).

`units` (schema.ts:137; created in `0003`, never altered since):

| Column | Type | Note |
|---|---|---|
| `id` | int autoincrement PK | |
| `unitNumber` | varchar(40) NOT NULL **UNIQUE** | unique across the whole database, not per tenant |
| `vin` | varchar(80) | not unique |
| `plate` | varchar(40) | |
| `vehicleType` | varchar(120) NOT NULL | free text; the only marker of truck vs trailer vs equipment |
| `company` | varchar(180) | free text, not an owner reference |
| `weightKg`, `axles`, `dimensions`, `equipment` | int, int, varchar(160), text | free-form spec |
| `inspectionStatus` | enum `current / due / blocked` | set to `due` at create; **never written afterwards** |
| `maintenanceStatus` | enum `clear / review / blocked` | set to `review` at create; **never written afterwards**; readiness reads `blocked` |
| `qrTag` | varchar(120) | |
| `createdAt`, `updatedAt` | timestamp | |

No `orgRef`, no lifecycle status, no `retiredAt`, no make/model/year, no serial, no odometer.
Ownership is the side table `coreRecordOwnership` (schema.ts:5514; `recordType` enum
`unit | operator | load | financial_entity`, UNIQUE on (recordType, recordId)). Trailer and equipment
documents resolve their tenant through `recordType='unit'` (`server/db.ts:708-716`).

The API is `fieldRoute.identity.units.list` / `.create` (`server/routers.ts:1449-1468`; permissions
`fleet.read` / `fleet.write`). **There is no update, retire or transfer procedure for a unit.**

Satellite tables that already extend `units`:

| Table | Line | Migration | What it holds |
|---|---|---|---|
| `vehicleProfiles` | 5861 | 0058 | `unitId` UNIQUE; height/width/length m; `emptyWeightKg`; `axleGroupsJson`; `source` enum `shop_measured / spec_sheet / operator_stated`; `verificationStatus`; verifier and recorder |
| `capitalAssets` | 5302 | 0052 | `unitId` UNIQUE, `trailerId` UNIQUE; `kind` `unit / trailer / equipment / building / leasehold / other`; acquisition, financing `owned / financed / leased`, CCA class, `status` `pending_capital_review / in_service / out_of_service / disposed / expensed`, disposal |
| `unitRadioCapabilities` | 6397 | 0074 | `unitId` UNIQUE; VHF/UHF/CB/satellite/cellular; verification |
| `unitSafetyPlans` | 838 | 0006 | hazard, shutdown, PPE, SDS, emergency contacts as text |
| `jobUnits` | 163 | 0003 / 0039 | the legacy job↔unit worklog (`eligibilityCheckId`, `enforcementModeAtCreate`); a guard test forbids production callers |
| `dispatchRoles` | 1876 | 0013 / 0170 | the canonical slot: `assignedOperatorId`, `assignedUnitId`, `assignedTrailerId`, `requiredEquipmentClass`, `requiredTrailerClass` |
| `dispatchRoleAssignmentEvents` | 1936 | 0171 | append-only from/to operator, unit, trailer per slot |
| `resourceBookings` | 2101 | 0013 | `resourceType` `operator / unit / trailer / equipment` + `resourceRef` (award-time overlap check) |
| `insuranceCoveredEntities` | 4360 | 0038 | `entityType` `unit / trailer / equipment / …` |
| `complianceDocuments` | 180 | 0003 / 0036 | `ownerType` `operator / unit / job / trailer / carrier / user / equipment` |
| `evidenceRelationships` | 2737 | 0019 | `entityType` includes `unit`, `trailer`, `equipment`, `workOrder`, `inspection` |
| `loadSenseGatewayBindings` | 7716 | 0114 | `unitId`, `trailerId`, `tareKg`, `orgRef` |
| `telemetrySnapshots`, `faultCodes`, `drivingEvents` | 5583, 5597, 5617 | 0055 | per-unit telematics |
| `tireInstallations`, `tireMeasurements` | 5172, 5186 | 0051 | tire by unit and axle position |
| `recallUnitStatus` | 5275 | 0051 | recall × unit decision |
| `fuelTransactions`, `bulkFuelDispenses`, `expenseRecords`, `expenseAllocations` | 3825, 4538, 3200, 3245 | 0033 / 0041 / 0022 | cost by unit; fuel carries `odometerKm`, `engineHours` |
| `trips` | 578 | 0008 / 0132 | `unitId`, `odometerStartKm`, `odometerEndKm`, `distanceKm`, `orgRef` |
| `incidentReports`, `nearMissReports`, `roadsideServiceEvents`, `insuranceClaims`, `enforcementEvents` | 2918, 3001, 3893, 4398, 6721 | | unit and trailer references |

Configuration that lives in code, not rows: `TruckConfiguration` / `TrailerConfiguration` and the
`TRUCKS` / `TRAILERS` seed registries in `server/_core/taxonomy.ts:67-100, 564+` (axle groups,
tare, dimensions, `canTow`, `deckHeightM`). `taxonomyEntries` (schema.ts:1405) is their intended
data home.

**Owner ruling already on record:** *"`units` gets no capacity column"* — capacity belongs to the
load-carrying equipment, is deferred, and reads `capacity_unknown` / `NOT_EVALUATED` until modelled
(`docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md:73-79`). This design respects it.

### 4. Existing maintenance / work-order tables

| Table | Line | Migration | Lifecycle and notes |
|---|---|---|---|
| `workOrders` | 671 | 0008 | `workOrderNumber` UNIQUE; `unitId`; `inspectionId`; `defectId`; `status` `draft / open / in_progress / waiting_parts / ready_for_service / closed` (forward-only via `shop.workOrderAdvance`, `server/shopRouter.ts:283`); `priority` `routine / urgent / critical`; `odometerKm`, `engineHours`; `technician` **free text**; `laborMinutes`; `parts` **free text**; findings; corrective action |
| `workOrderReleases` | 3021 | 0019 | append-only; `releaseType` `full / restricted / revoked`; `testResult` `pass / fail / not_required`; `roadTestPerformed`; `technicianUserId` + `technicianIdentifier` + `technicianCertificationRef`; `resolvedDefectIds` (JSON array in varchar); `supersededByReleaseId`. Written by `shop.workOrderRelease` (technician = login) and `records.maintenance.recordRelease` (technician from input) — **two release paths** |
| `parts`, `partMovements` | 5118, 5135 | 0051 | append-only stock ledger; movements carry `workOrderId` and `unitId` |
| `tires`, `tireInstallations`, `tireMeasurements` | 5153–5186 | 0051 | serialised tires, one axle position per unit at a time, km known only when both odometers recorded |
| `warrantyPolicies`, `warrantyClaims` | 5199, 5217 | 0051 | `subjectType` `part / tire / unit_component` |
| `serializedTools`, `toolCheckouts` | 5239, 5249 | 0051 | |
| `recallNotices`, `recallUnitStatus` | 5259, 5275 | 0051 | recall held unverified until a second person verifies; per-unit decision |
| `roadsideServiceEvents` | 3893 | 0034 | breakdown / vendor repair; any open status blocks dispatch |
| `measurementDevices`, `calibrationEvents`, `measurementDeviceAssignments` | 4259, 4274, 4291 | 0037 | calibration state feeds readiness as review |

Pure engine: `server/_core/mechanicRelease.ts` — `evaluateMechanicRelease` (blocker codes
`technician_not_authenticated`, `test_failed`, `road_test_missing`, …),
`currentReleaseEvidenceFor` (a release is evidence only for the defects it **names**, and only while
not revoked, not failed, not superseded), and an unpersisted `MaintenanceStage` chain
`driver_reported → management_review → sent_to_shop → work_in_progress → repair_complete → released → office_archived`.

**Not present:** a preventive-maintenance / service-interval schedule; a mechanic or shop table
(mechanics are `organizationWorkers.workerType` `MECHANIC / SHOP_HAND / MAINTENANCE_SUPERVISOR` or free
text); labour rates as configuration; component-level service history.

**Verdict:** the maintenance and work-order abstractions are mature enough to reuse as-is for the
first checkpoint. Depth (typed parts and labour on the work order, service intervals, one release
path) is checkpoint 4 work, not a reason to build a second maintenance database — which
`docs/compliance/unified-compliance-engine-design.md` §11 already forbids.

### 5. Existing inspection / defect implementation

**Inspections** (`inspections`, schema.ts:298; `0003`): `unitId`; `type` enum
`training / pre_trip / post_trip`; `status` enum `pass / fail / needs_maintenance / not_applicable`;
`checklist`, `resultSummary` text; `observedAt`; `authenticatedOperatorId`. Insert-only, written by
`fieldRoute.identity.inspections.create` (`inspection.write`: driver, mechanic, shop_lead, safety).

- **Readiness never reads `inspections`.** A `fail` creates no defect and blocks nothing. The
  "inspection" the gate checks is a *credential*: `complianceDocuments` docType `cvip_certificate`
  or `annual_inspection` (`readinessComposer.ts:571`). The 24-hour trip inspection is likewise a
  requirement seed (`ab.unit.trip_inspection.24h`, satisfied by docType `trip_inspection`) whose
  evaluator `tripInspectionValidity()` has no production caller.
- Client capture kinds `pretrip` / `posttrip` exist (`client/src/runtime/contracts.ts:28`) with
  sync priority 10, and **no server handler consumes them**.

**Defects** (`maintenanceDefects`, schema.ts:317; `0003` + `0169`): `unitId`; `title`; `severity`
`advisory / inspection_required / critical`; `status` `open / in_progress / resolved`; `detail`;
`storageKey`; `reportedAt`; `reportedBy`; `workOrderNumber`; `resolvedAt`, `resolvedByUserId`,
`resolvedByReleaseId`, `resolutionNote`; index `(unitId, severity, status)`.

- Five insert sites, all `open`: `fieldRoute.compliance.maintenance.create`
  (`maintenance.write_defect`: driver, mechanic, shop_lead, office), the enforcement shop bridge
  (`enforcementCommit.ts:211`), `roadside.open`, `telematics.faultAcknowledge`, and the assistant
  `defect_report` commit (severity forced to advisory).
- One resolve path: `records.maintenance.resolveDefect` (`recordsRouter.ts:780`), permission
  `maintenance.record_release` (mechanic, shop_lead; sensitive). A critical defect needs a release
  that names it. The write is `UPDATE … WHERE status <> 'resolved'`, so a race resolves once.
- `in_progress` is never written. There is no reopen, no assessment, no "deferred / monitor /
  duplicate / invalid" disposition.
- Readiness (`readinessComposer.ts:519-578`): unresolved critical → `critical_defect`; critical
  without standing release evidence → `mechanic_release_missing`; both `NEVER_OVERRIDABLE`
  (`complianceFinding.ts:137`). This is the repair recorded in
  `docs/register/READINESS_DEFECT_REPAIR.md` and must not be re-implemented.

**Holds.** There is **no hold table**. A block is derived on every composition from
`maintenanceDefects` + `workOrderReleases`, `outOfServiceOrders` (via `enforcementEvents`, tenant
scoped), `complianceDocuments`, insurance, `roadsideServiceEvents`, `faultCodes`,
`units.maintenanceStatus`. Government OOS is a full subsystem (`0082`–`0085`, `0087`):
`outOfServiceOrders` (`scope` `driver / vehicle / trailer / cargo / carrier`; `requiredFindingType`;
`active / released / rescinded`), `oosReleaseFindings`, versioned `oosReleasePolicies` that may
strengthen but never weaken, release under `enforcement.release` (safety, management; sensitive)
with separation of duties, a conditional `UPDATE … WHERE status='active'` that makes a release race
resolve once. `deviceSafetyLatches` (`0087`) is the device-side latch; nothing server-side lifts it.
`incidentReports.unitHeld` (schema.ts:2954) exists and **is not read by the composer** — this is
open defect **R-11** in the compliance design.

### 6. Existing Vault / document relationship model

Two spines, both already unit-aware:

1. **Evidence vault** — the bytes and their integrity. `evidenceRecords` (schema.ts:48: `jobId`,
   `category`, `storageKey`, `mimeType`, `capturedAt`, `capturedBy`, lat/long, `status`,
   `trackingNumber`, `clientCaptureRef` (device idempotency), `recordType`, `sealState`,
   `currentVersion`, `legalHold`), `evidenceVersions` (content hash per version), `evidenceSeals`
   (canonical manifest, sha256, device id and platform, captured coordinates, server verification),
   `evidenceRelationships` (**`entityType` enum already includes `unit`, `trailer`, `equipment`,
   `workOrder`, `inspection`, `incident`**; `entityId` or `entityRef`; `role`),
   `evidenceAccessEvents`, retention and legal-hold tables. The seal API
   (`records.evidence.seal`) accepts `unit`, `trailer`, `equipment`, `workOrder`, `inspection` as
   relationship targets today. Storage is S3 through `server/storage.ts` (`storagePut`,
   `storageGetSignedUrl`, `storageRead`); `/manus-storage/*` was retired in `0168`.
   `EvidenceRecordType` already includes `pre_trip`, `post_trip_dvir`, `defect_report`,
   `work_order`, `inspection`, `permit`, `photo` (`server/_core/evidenceSeal.ts:18-36`).
2. **`complianceDocuments`** — typed credentials with expiry and verification (`ownerType` includes
   `unit`, `trailer`, `equipment`; `docType` free text; `requirementKey`; `identifier`;
   `issuedAt`; `expiresAt`; `jurisdiction`; `verificationStatus` `needs_review / verified / rejected`;
   `verifiedByUserId`; `privateDetail`; `evidenceRecordId` → the vault; `source`; `confidence`).
   Owner decision **D-05** made this the canonical document-backed credential store, and the driver
   portfolio branch reads it through `complianceDocumentValidity` → `documentValidity.validityOf()`
   (`in_force / expiring / expired / unverified / rejected / none`; the newest **verified** version
   wins; an unverified upload never displaces a verified one). Unit requirement seeds exist:
   `ab.unit.registration`, `ab.unit.insurance_proof`, `ab.unit.cvip.annual`,
   `ab.unit.trip_inspection.24h`, `ca.unit.ifta`, `ca.unit.irp`
   (`server/_core/complianceRequirementSeeds.ts:44-56`), all unverified (P9).

Gaps that matter here: `complianceDocuments` has no recorder/uploader column and no `orgRef`
(scoped through the owner; tracked in `docs/compliance/follow-ups/TENANCY_UNSCOPED_COMPLIANCE_TABLES.md`);
`evidenceRecords` has no `orgRef` (C9); there is **no download procedure** for an evidence record or
compliance document (`storageGetSignedUrl` is called only by the audit package and video view);
`compliance.credentialVerify` has no separation of duties; `evidenceRecords` has no GPS accuracy or
purpose column beyond `category`. **Permits are not modelled** — free-string `permitRefs` only,
and `readinessComposer.ts` hard-codes `permitRequired: false`. The compliance plan reserves the
canonical permit model (`permits`, `permitConditions`) for **C6**.

Attachment authorizers (`server/_core/attachmentAuthorizers.ts`): `unit` is registered
(`fleet.read`, class `partial` because there is no org column); `trailer` is in `ObjectKind` with no
resolver. The pinned test expects exactly `["defect","job","unit"]`.

**Vault UI:** none in production. `/evidence` is a text stub; `/showcase/offline-vault` and
`/showcase/fleet` are quarantined demonstrations that cannot write.

### 7. Existing dispatch-readiness implementation

**One composer, one contract, fail-closed by classification.** `composeReadiness(subject, now)`
(`server/readinessComposer.ts:379`) loads every fact server-side from identities only
(`{ operatorId (required), unitId, trailerId, jobId, postingId?, routeApprovalRef?, loneWorker?, workEndsAt? }`),
feeds the pure `evaluateDispatchReadiness` (`server/_core/dispatchReadiness.ts:163`), and wraps each
blocker as a `ComplianceFinding` (`server/_core/complianceFinding.ts:28-67`) through an ordered
regex `CLASSIFICATION` keyed on the blocker `code`. A code no rule names **fails closed**
(`fromProducer`: a non-overridable blocker becomes `NEVER_OVERRIDABLE`, a BLOCK becomes
`APPROVED_POLICY_ONLY`). `mergeFindings` keeps the strictest of duplicate codes. Verdict order:
blocking > unknown > review > eligible. `CLASSIFICATION_VERSION = "c1a.2"`; bumping it stales every
stored check by design.

```ts
type DispatchBlocker = { code; label; severity: "blocking"|"review"|"unknown";
  subject: "operator"|"truck"|"trailer"|"job"|"route"; overridable; overrideAuthority? };
type ComplianceFinding = DispatchBlocker & { domain; result; dispatchEffect;
  overrideClass: "NEVER_OVERRIDABLE"|"APPROVED_POLICY_ONLY"|"WARNING_ONLY"|"INFORMATIONAL";
  authorityClass; ruleRef; evidenceRefs; evaluatedAt };
```

Unit-side facts the composer reads today (`:513-654`): unit credentials (CVIP/annual inspection,
registration); insurance via `assessCoverage`; open or critical defects + every release
(`critical_defect`, `mechanic_release_missing`); `units.maintenanceStatus === "blocked"` →
`maintenance_overdue` (WARNING_ONLY); open roadside events (HARD); calibration of assigned
measurement devices (review); `faultCodes` (`fault_<code>_critical` HARD, `_inspection` warn,
`_active` UNKNOWN-blocks); OOS orders through `enforcementEvents.unitId/trailerId` (HARD); trailer
credentials; trailer compatibility hard-coded `null` (`trailer_compatibility_unknown`, blocks as
APPROVED_POLICY_ONLY — deliberate until C3). Every governing expiry enters `governingExpiries` and the
`EligibilityFacts` fingerprint (`EF2-` + sha256), so time passing stales a check without a row
changing.

Unit state the gate does **not** read: `units.inspectionStatus`, `inspections` rows,
`incidentReports.unitHeld` (R-11), `resourceBookings` except at award, the slot's
`requiredEquipmentClass` / `requiredTrailerClass` (read only by the unwired `dispatchMatching`),
whether a bound "trailer" is actually a trailer (`dispatchRoleService.ts:364-372` checks existence and
tenancy only), `capitalAssets.status`, permits.

Award and override: `dispatch.award` (`_core/dispatchTransaction.ts`) sets the slot, writes
`resourceBookings`, marks the check `usedForAward`. Overrides are requested and granted by different
people (`0174`); `APPROVED_OVERRIDE_POLICIES = []`, so nothing in `APPROVED_POLICY_ONLY` can be
released today; `NEVER_AUTONOMOUS` in `actionGateway.ts` forbids agents from
`maintenance.clearOutOfService` and `inspection.bypassFailure`. `dispatch.readiness` requires an
operator: **a readiness question cannot be asked about a unit alone.** The roadmap names this:
*"Why can't this unit leave?" — generalise `readinessComposer` rather than sitting beside it.*

Client: `/dispatch/:jobId` (`client/src/dispatch/DispatchJobDetail.tsx` + `View`), the read-only
`DispatchReadinessView`, and `readinessPresentation.ts` as the single status-to-label mapping.

### 8. Existing organization / tenant ownership rules

- Acting scope is resolved from membership, never from input: `resolveActingScope(db, userId)`
  (`server/_core/actingScope.ts:65`) → `{ tenantId, derivedFrom, membershipRef, branchRefs, global }`.
  No membership → `SINGLE_TENANT_ID = "default"`; two live memberships → `AmbiguousOrganization`
  (refused, not resolved).
- Owned records carry `orgRef varchar(64) NULL`; NULL means the historical single tenant (`0132`
  rule). Legacy core records (`unit`, `operator`, `load`, `financial_entity`) are owned through
  `coreRecordOwnership`; `createUnit` inserts the ownership row only when the scope is not `default`.
- Query helpers (`server/db.ts`): `orgScopeWhere(table, scope)`, `ownershipScopeWhere("unit" | "operator", idColumn, scope)`
  (correlated subquery), `actingScopeFor(userId)`, and the `*InScope` family (`unitInScope`,
  `workOrderInScope`, `jobInScope`, `operatorInScope`, `evidenceInScope`, …). **Out of scope is
  "not found", never "forbidden".**
- Roles cannot yet vary by organization (`userRoleAssignments.scopeType` is `global | branch`);
  an open branch (`0170_organization_scoped_role_grants`) is changing that.
- `units.unitNumber` is unique across the database — two tenants cannot both own "Unit 12".
- Tests: `server/tenantScope*.db.test.ts` (org A creates, org B lists → absent, gets → NOT_FOUND;
  legacy NULL rows visible only to member-less users), `tenantScopeShop.db.test.ts` and
  `tenantScopeUnitRecords.db.test.ts` for the unit side; static scans `tenantIsolation.test.ts`
  and `coreRecordOwnershipBoundary.test.ts`.
- Known unscoped fleet-adjacent routers: `assetRouter`, `telematicsRouter`, `insuranceRouter`,
  `complianceRouter.credentialRecord/Verify`, most shop parts/tires/warranty procedures.

### 9. Existing offline / outbox architecture

Two outboxes, deliberately separate:

- **Server domain-event outbox** — `domainEventOutbox` (`0015`, `0089`): `eventType`,
  `aggregateType/Id`, `tenantId`, `unitId`, `actorSource`, `payloadJson`, lease and dead-letter
  columns; `emitDomainEvent(tx, input)` (`server/_core/eventEmitter.ts:115`) must run inside the
  caller's transaction; drained by `server/_core/drainWorker.ts` with `FOR UPDATE SKIP LOCKED`.
  `eventEmitter` and `domainEmitters` are **declared unwired**; the one live producer is the
  enforcement confirm (`enforcementOutbox.ts`). Typed emitters for `unit.critical_defect_opened`,
  `unit.mechanic_released`, `fleet.defect_sent_to_shop` exist with no production caller. C1a
  deferred its own outbox events on purpose.
- **Device outbox and sync** — `client/src/runtime/` (`contracts.ts`: six sync states
  `saved_locally | queued | syncing | synchronized | failed | conflict`; `CaptureKind` includes
  `pretrip`, `posttrip`, `defect_report`, `photo`, `incident`, `roadside_enforcement`, `oos_order`;
  `LocalCapture` carries `unitId`, GPS fix, `captureAuthorizationClaim`; `outbox.ts`;
  `syncEngine.ts` with priority tiers). Server side `sync.receivePackage`
  (`server/deviceRouter.ts:162`): device org vs acting scope, P-256 signature over wire bytes,
  replay nonce, admission, three-way hash re-verification from storage, `syncPackages` /
  `syncPackageItems` (capture-time authorization claim, `0079`) / `syncReceipts`, conflict rows.
  Idempotency: `evidenceRecords.clientCaptureRef`, `syncPackages.packageRef`, `deviceSyncNonces`,
  `deviceSafetyLatches (reportedByUserId, captureLocalId)`.
- Everything syncs **as evidence** (upload, seal, signed package), not as typed mutations;
  `offlineCapability.ts` (`local_safe | local_capture | local_prepare | server_authoritative`) has no
  production registry and is SPINE item 3 / HS1.
- What a driver carries today: only the sealed **communication package** (`commPackage.ts`,
  `comms.packageBuild/Fetch/Acknowledge/Status`, hashed, stale by arithmetic). `preDepartureCache`
  (`CacheItemKind`: `job | trip | route | map_tiles | facility | permit | sds | emergency_plan | lease_location | communications`;
  "missing is named, never counted"; "cached is not current") is written and unwired. The driver
  portfolio branch's wallet carries `validUntil` and `walletStatusAt()` (`shared/driverWallet.ts`)
  turns a cached READY into STALE — NOT READY never improves offline. Owner decision **D-11** fixes
  what a driver may see offline: *"their own credentials, assigned unit/trailer state, the job's
  permits, route package, emergency contacts."*

### 10. Existing audit-event infrastructure

There is no single audit ledger and no `recordAudit()` helper. The conventions are:

1. `authorizationDecisions` (schema.ts:3104) — written automatically by every `roleProcedure`,
   denials included (`recordAuthorizationDecision`, `server/db.ts:1377`). For a permission in
   `SENSITIVE_PERMISSIONS`, a failed audit write **refuses the call** (`server/_core/trpc.ts:108-114`).
2. Per-domain **append-only event tables** written inside the mutating transaction:
   `dispatchRoleAssignmentEvents` (`eventRef`, `orgRef`, enum `eventType`, from/to, `actorUserId`,
   `actorRole`, `occurredAt`), `dispatchAuditEvents`, `securityIncidentEvents` (sequenced),
   `manifestCustodyEvents`, `evidenceAccessEvents`, `deviceKeyEvents`, `contractorPayableEvents`,
   and on the driver-portfolio branch `driverPortfolioEvents` with **database triggers refusing
   UPDATE and DELETE** (`0176`). Hash chaining exists in `academyAuditEvents`
   (`previousHash` / `eventHash`) and `manifestAmendments`.
3. Provenance columns on the row itself (`resolvedByUserId`, `releasedByUserId`,
   `verifiedByUserId`, `recordedByRole`) — the 0169 pattern.
4. The domain outbox (§9), where a downstream consumer exists.

Event names are `domain.snake_case_past_tense` (`unit.critical_defect_opened`).

### 11. Existing relevant APIs and UI

Server (all `roleProcedure`, all mapped in `server/_core/recordsAuthorization.ts`):

| Surface | Procedures | Scope guard |
|---|---|---|
| `fieldRoute.identity.units` | `list` (cap 100), `create` | `ownershipScopeWhere` |
| `fieldRoute.identity.inspections` | `list`, `create` | `unitInScope` |
| `fieldRoute.compliance.maintenance` | `list`, `create` (defect) | `unitInScope` |
| `fieldRoute.workOrders` | `list`, `create`, `update` | `unitInScope` |
| `fieldRoute.identity.documents` | `list`, `create` (owner `operator / unit / job`), `review` | scope |
| `records.maintenance` | `recordRelease`, `resolveDefect`, `revokeRelease` | `unitInScope` |
| `shop.*` (23) | parts, tires, warranty, tools, recalls, `workOrderAdvance`, `workOrderRelease`, `unitCost` | partial |
| `asset.*` (10) | capital register / review / CCA / `twin` | **none** |
| `telematics.*` (7) | `unit` (odometer reconciliation + faults), `faultAcknowledge`, `faultClear`, … | **none** |
| `compliance.*` | `passport` (subject `unit / trailer`), `credentialRecord` (owner `unit / trailer / equipment`), `credentialVerify`, `requirementLoad` | **none** |
| `insurance.*` | `coverageAssign` (entity `unit / trailer / equipment`), `coverageForEntity`, `renewalCalendar`, claims | **none** |
| `spatial.*` | `vehicleProfileSet`, `vehicleProfileVerify` | `unitInScope` |
| `enforcement.*` | `eventConfirm`, `findingRecord`, `orderRelease`, `latchReport`, `latchStates`, `activeOrders` | tenant |
| `dispatch.*` (13) | slot model, `readiness`, `evaluate`, overrides, `award`, `whatAmIMissing` | tenant (C1a) |
| `audit.packagePrepare` | kind `vehicle` gathers unit documents, checks, work orders, defects, releases, tires, faults, recalls — the closest thing to a per-unit portfolio query | |
| `surfaces.search` | returns units with deep link `fleet_maintenance` → `/units/:id` | |
| `agent` | capability `fleet.readUnit` (`fleet.read`, read) already registered | |

Client: `client/src/portal/PortalShell.tsx` is the authoritative shell (`/portal/:portal/*?`; portal
key `fleet_maintenance` = "Fleet & Maintenance", composed from `mechanic` + `shop_lead` in
`server/_core/portalComposition.ts:178`; panels My Day / Exceptions / Inbox / Timeline / Setup;
`panelContract.ts` pins exactly which procedures each panel file may call). `/dispatch/:jobId` is
the one detail screen and the container/View/`.dom.test.tsx` pattern to copy. **`/fleet` redirects
to `/showcase/fleet`**, a 1,566-line demonstration behind a write-refusing guard. The deep links
`/units/:id`, `/credentials/:id`, `/calibration/:ref` that the server already emits have **no
route**. Status vocabulary: `readinessPresentation.ts` (`ready / review / blocked / insufficient / not_evaluated / unavailable`;
unknown → "Unavailable", never "ready"); `LEASEOS_DESIGN_SYSTEM.md` (one vocabulary carried by icon
and word, three levels of disclosure, exception-first office screens, dark single-column field
screens).

### 12. Architectural conflicts with this request

| # | The request says | The repository says | Resolution in this design |
|---|---|---|---|
| C-1 | build the Fleet & Equipment Portfolio as a new domain | **SPINE moratorium**: *"no new engines until this path is wired"* (`docs/register/SPINE_WIRING_PLAN.md`, guarded by `server/spineWiringPlan.test.ts` and `engineReachability.test.ts`); D-01: only reconciliation, wiring, safety fixes, consolidation are permitted | The portfolio is built as a **projection over canonical records plus a router**, the exact shape D-01 permits and the driver portfolio branch used. No new `_core` decision engine; the one new `_core` module is reached from its router in the same PR. The compliance plan already schedules this as **C3 — "Fleet compliance projection. Engine? No."** |
| C-2 | canonical statuses `active / available / dispatched / maintenance_due / maintenance_hold / inspection_hold / compliance_hold / out_of_service / seasonal_storage / retired / sold` as a stored status | a block is **derived on every composition**, never stored (`readinessComposer`); "exceptions are derived from current state, never stored" (`B21_0`); a stored availability column would be a second answer to "can this unit leave" | Split: **lifecycle** is stored (`active / seasonal_storage / retired / sold / transferred`); **operational state** is a projection with named reasons. No `vehicleAvailable` flag. See §B.3 |
| C-3 | permits attach to assets with metadata, conditions, verification | permits are C6 in the compliance plan (`permits`, `permitConditions`, "all-conditions-match semantics", permit revision hashes in the route fingerprint); D-01 forbids a C2+ standalone engine before the spine is wired | Permit *documents* are `complianceDocuments` rows today (`docType` `permit:<kind>`, ownerType `unit`); the permit *model* stays C6. The portfolio shows them as documents and does not evaluate conditions |
| C-4 | canonical `currentMileage` must not be overwritten; store readings historically | readings already live on `telemetrySnapshots`, `workOrders`, `fuelTransactions`, `bulkFuelDispenses`, `trips`, `tireInstallations`; `odometerReconciliation` in `telematics.ts` already reconciles trips vs shop vs telemetry | Add one **manual meter ledger** for readings that have no home (driver, mechanic, inspection, job closeout); read the others in place with their source label. No copy, no current-value column. See §B.6 |
| C-5 | tenant-to-tenant asset transfer | `coreRecordOwnership` is UNIQUE per record; `assignRecordOwner` throws `RECORD_OWNED_BY_ANOTHER_ORGANIZATION`; `units.unitNumber` is globally unique; roles cannot vary by org yet | **Deferred.** Transfer needs an ownership-history row and a decision on unit-number scoping. See O-4 |
| C-6 | equipment-specific typed specifications now | `vehicleProfiles.axleGroupsJson` (zod-validated JSON with source + verification) is the precedent; C3 plans GVWR, registered weight, axle config, sleeper config, unit class as **verified columns on `vehicleProfiles`**; the owner has ruled *no capacity column on `units`* | Legal/routing dimensions and weights go on `vehicleProfiles` (C3, verified). Category-specific specs get a **typed, versioned `unitSpecifications` row per class** (§B.9). Capacity stays deferred and reads UNKNOWN |
| C-7 | fleet-manager permissions | there is no `fleet_manager` role; `fleet.write` is held by dispatcher, shop_lead, office, management; org-scoped role grants are being built on another branch | Map "fleet manager" to `shop_lead` + `management` (+ `office` for identity data) now; a role is O-3 |
| C-8 | audit records for every important action, using the audit ledger | no single ledger; per-domain append-only tables + `authorizationDecisions` + provenance columns; outbox events deferred by C1a | Append-only `fleetPortfolioEvents` with 0176-style triggers, mirroring `driverPortfolioEvents`; outbox emission is O-6 |
| C-9 | expiration engine with configurable thresholds | thresholds exist per requirement (`complianceRequirements.warnDaysBeforeExpiry`, `missingSeverity` `review / blocked`), per widget, in `safetyBinder.warnWithinDays`, and as a hard-coded 90/60/30/14/7 in the driver portfolio; D-13 decides "90/60/30/14/7/1 configurable per org, labelled reminder"; there is **no threshold-policy table** | Reuse the requirement registry for block-vs-warn and the D-13 tiers for reminders; build no second threshold table (§B.8) |
| C-10 | the mechanic should "clear maintenance holds"; safety "impose/release compliance holds" | who may release depends on **why** the unit is held: a critical defect needs a release naming it (`maintenance.record_release`); a government order needs `enforcement.release` under an OOS policy; drivers cannot clear either | Manual holds get typed release permissions per hold type; derived holds are released only by resolving their source. Nothing here weakens `READINESS_DEFECT_REPAIR` |
| C-11 | a first migration now | release blocker: **0169 is claimed twice**; "resolve before the next migration-bearing feature" | O-1 |

### 13. Recommended canonical asset model

**`units` is the canonical Fleet Asset.** It is extended, not replaced. Every machine class the owner
listed — truck, tractor, body job, trailer, tanker, vacuum unit, hydrovac, pressure washer, hot-seat
trailer, pump, compressor, refrigeration unit, generator, miscellaneous field equipment — is a
`units` row, distinguished by a controlled `assetClass` and `assetType` rather than the free-text
`vehicleType`. Components (a mounted vacuum system, a PTO, a pump, a refrigeration unit) are also
`units` rows so they can carry their own defects, work orders, documents and service history, and
they are connected to their parent through a dated relation. `capitalAssets` stays the financial
identity (one per unit, already enforced). `vehicleProfiles` stays the verified physical profile.
`coreRecordOwnership` stays the tenant owner.

What is **not** created: a `vehicles`, `trailers`, `equipment`, `assets` or `fleetAssets` table; a
stored availability flag; a second defect, inspection, work-order, document, evidence, outbox or
readiness system; a permit model; a capacity column.

### 14. Exact migrations believed necessary

Two files for the first checkpoint, numbered at PR time (today's first free slot is `0182`;
trigger DDL is kept in its own file, following `0176`):

**`0182_fleet_asset_core.sql`** (additive; every new column nullable or defaulted; no data rewritten)

```sql
-- units: identity and lifecycle. vehicleType stays for every existing reader; assetClass/assetType
-- are the controlled vocabulary the portfolio and the gate read. NULL assetClass = not yet classified,
-- which the projection reports as `asset_class_unknown`, never as a truck.
ALTER TABLE `units`
  ADD COLUMN `assetClass` enum('power_unit','trailer','mounted_system','portable_equipment','component') NULL,
  ADD COLUMN `assetType` varchar(60) NULL,            -- controlled list in shared/fleetAssetTypes.ts
  ADD COLUMN `assetSubtype` varchar(60) NULL,
  ADD COLUMN `companyAssetNumber` varchar(60) NULL,
  ADD COLUMN `serialNumber` varchar(120) NULL,        -- VIN stays `vin`; serial is for non-VIN equipment
  ADD COLUMN `plateJurisdiction` varchar(8) NULL,
  ADD COLUMN `make` varchar(80) NULL,
  ADD COLUMN `model` varchar(80) NULL,
  ADD COLUMN `modelYear` smallint NULL,
  ADD COLUMN `manufacturer` varchar(120) NULL,
  ADD COLUMN `ownershipType` enum('owned','leased','rented','customer_supplied','contractor_supplied') NULL,
  ADD COLUMN `acquiredAt` timestamp NULL,
  ADD COLUMN `homeTerminal` varchar(120) NULL,
  ADD COLUMN `assignedBranchRef` varchar(64) NULL,    -- a branch scopeRef, the same vocabulary userRoleAssignments uses
  ADD COLUMN `assignedDivision` varchar(120) NULL,
  ADD COLUMN `defaultOperatorId` int NULL,
  ADD COLUMN `regulatoryClass` varchar(60) NULL,
  ADD COLUMN `lifecycleStatus` enum('active','seasonal_storage','retired','sold','transferred') NOT NULL DEFAULT 'active',
  ADD COLUMN `lifecycleChangedAt` timestamp NULL,
  ADD COLUMN `lifecycleChangedByUserId` int NULL,
  ADD COLUMN `lifecycleReason` varchar(400) NULL,
  ADD COLUMN `retiredAt` timestamp NULL,
  ADD COLUMN `notes` text NULL;
--> statement-breakpoint
CREATE INDEX `units_lifecycle_idx` ON `units` (`lifecycleStatus`, `assetClass`);
--> statement-breakpoint
-- A manual hold placed by a person, with a typed reason. Derived holds (critical defect, OOS order,
-- expired required document, open roadside event) are NOT rows here: they are computed from their
-- source records, and releasing them means resolving the source. Released rows stay; nothing is deleted.
CREATE TABLE `unitHolds` (
  `id` int AUTO_INCREMENT NOT NULL,
  `holdRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,                          -- NULL = historical single tenant (0132)
  `unitId` int NOT NULL,
  `holdType` enum('safety','maintenance','inspection','compliance','damage','administrative') NOT NULL,
  `dispatchEffect` enum('block','warn') NOT NULL,     -- decided at placement from holdType + placer's permission
  `reason` varchar(600) NOT NULL,
  `sourceKind` enum('manual','incident','damage_report','inspection','document_expiry') NOT NULL DEFAULT 'manual',
  `sourceRef` varchar(120) NULL,                      -- incidentNumber, inspection id, defect id …
  `evidenceRecordId` int NULL,
  `placedByUserId` int NOT NULL,
  `placedByRole` varchar(40) NOT NULL,
  `placedAt` timestamp NOT NULL,
  `status` enum('active','released') NOT NULL DEFAULT 'active',
  `releasedAt` timestamp NULL,
  `releasedByUserId` int NULL,
  `releasedByRole` varchar(40) NULL,
  `releaseReason` varchar(600) NULL,
  `releaseEvidenceRecordId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitHolds_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitHolds_holdRef_unique` UNIQUE(`holdRef`)
);
--> statement-breakpoint
CREATE INDEX `unitHolds_unit_active_idx` ON `unitHolds` (`unitId`, `status`, `holdType`);
--> statement-breakpoint
-- Parent/child equipment relation with history. Both ends are units rows. A detachment sets
-- removedAt; the row is never deleted, so "what was attached during a job" is a temporal query.
CREATE TABLE `unitComponents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `componentRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `parentUnitId` int NOT NULL,
  `childUnitId` int NOT NULL,
  `relationship` enum('mounted','installed','attached','towed') NOT NULL,
  `removable` boolean NOT NULL DEFAULT true,
  `installedAt` timestamp NOT NULL,
  `installedByUserId` int NOT NULL,
  `installWorkOrderId` int NULL,
  `removedAt` timestamp NULL,
  `removedByUserId` int NULL,
  `removeWorkOrderId` int NULL,
  `removalReason` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitComponents_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitComponents_componentRef_unique` UNIQUE(`componentRef`)
);
--> statement-breakpoint
CREATE INDEX `unitComponents_parent_idx` ON `unitComponents` (`parentUnitId`, `removedAt`);
--> statement-breakpoint
CREATE INDEX `unitComponents_child_idx` ON `unitComponents` (`childUnitId`, `removedAt`);
--> statement-breakpoint
-- Meter readings that have no home today (driver, mechanic, inspection, job closeout). Telemetry,
-- fuel, trip and work-order readings stay where they are and are read beside these with their source.
CREATE TABLE `unitMeterReadings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `readingRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `unitId` int NOT NULL,
  `meterType` enum('odometer_km','engine_hours','pto_hours','pump_hours','blower_hours','compressor_hours','generator_hours','other') NOT NULL,
  `reading` double NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `source` enum('driver_manual','mechanic','inspection','job_closeout','imported') NOT NULL,
  `sourceRef` varchar(120) NULL,
  `enteredByUserId` int NOT NULL,
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `verificationStatus` enum('unverified','verified','rejected') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int NULL,
  `verifiedAt` timestamp NULL,
  `note` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitMeterReadings_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitMeterReadings_readingRef_unique` UNIQUE(`readingRef`)
);
--> statement-breakpoint
CREATE INDEX `unitMeterReadings_unit_idx` ON `unitMeterReadings` (`unitId`, `meterType`, `recordedAt`);
--> statement-breakpoint
-- The portfolio's own append-only record (the driverPortfolioEvents pattern).
CREATE TABLE `fleetPortfolioEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `unitId` int NOT NULL,
  `subjectType` varchar(40) NOT NULL,                 -- unit | hold | component | meter_reading | document | inspection | defect | lifecycle
  `subjectRef` varchar(120) NOT NULL,
  `eventType` enum('asset_created','asset_edited','lifecycle_changed','hold_placed','hold_released','component_attached','component_detached','meter_recorded','meter_verified','document_recorded','document_verified','inspection_recorded','defect_reported','portfolio_viewed','used_for_dispatch') NOT NULL,
  `previousState` varchar(80) NULL,
  `newState` varchar(80) NULL,
  `detail` varchar(600) NULL,
  `actorUserId` int NULL,
  `actorRole` varchar(40) NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fleetPortfolioEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `fleetPortfolioEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `fleetPortfolioEvents_unit_idx` ON `fleetPortfolioEvents` (`unitId`, `id`);
--> statement-breakpoint
CREATE INDEX `fleetPortfolioEvents_org_idx` ON `fleetPortfolioEvents` (`orgRef`, `occurredAt`);
```

**`0183_fleet_portfolio_events_append_only.sql`** — two `BEFORE UPDATE` / `BEFORE DELETE` triggers
that `SIGNAL SQLSTATE '45000'`, byte-for-byte the `0176` shape, on `fleetPortfolioEvents`. No other
statement in the file.

**Deliberately not in the first migration:** the `inspections.type` widening and inspection
provenance columns, the defect workflow columns, `unitSpecifications`, a documents `recordedByUserId`
(all checkpoint 2/3; §B.10). `units.inspectionStatus` / `maintenanceStatus` are left in place, marked
legacy in the schema comment, and stop being the portfolio's answer; dropping them is a later,
separate migration once no reader remains (readiness still reads `maintenanceStatus`).

**`drizzle/schema.ts`** gains the matching declarations, `scripts/verify-parity.sh` counts them, and
`server/columnParity.test.ts` checks nullability against the live database.

### 15. Proposed first vertical slice — "Fleet Asset Core"

One reviewable PR, one migration pair, the full gate before push:

1. **Canonical asset** — `units` extended as above; `shared/fleetAssetTypes.ts` holds the
   controlled `assetType` list per `assetClass` (with a zod schema shared by server and client, the
   `shared/facilities.ts` precedent).
2. **Asset profile API** — `fleetPortfolioRouter` (new file, mounted in `server/routers.ts`):
   `fleet.list` (filters: lifecycle, assetClass, assetType, branch, operational state, expiring
   documents, inspection due), `fleet.get` (the portfolio: identity, lifecycle, operational state with
   named reasons, active holds, open defects, latest inspections, documents with validity, insurance,
   components in and out, meters, recent work orders and releases, recalls, fault codes, capital
   asset, vehicle profile, event history), `fleet.create` (replaces the legacy create's free-text
   shape; the legacy procedure stays and is marked), `fleet.update` (identity fields only),
   `fleet.lifecycleSet`, `fleet.holdPlace`, `fleet.holdRelease`, `fleet.componentAttach`,
   `fleet.componentDetach`, `fleet.meterRecord`, `fleet.meterVerify`, `fleet.unitReadiness`,
   `fleet.myAssignedUnits`, `fleet.auditHistory`. Every procedure resolves the acting scope and
   answers NOT_FOUND for another organization's unit.
3. **Operational state projection** — pure `server/_core/fleetPortfolio.ts`
   (`operationalState(facts)`, `holdProblem()`, `lifecycleTransition()`, `componentProblem()`,
   `meterProblem()`), reached from the router in the same PR so the reachability census counts it as
   wired.
4. **Documents** — read through `complianceDocuments` (owner `unit / trailer / equipment`) with
   `complianceDocumentValidity`; evidence through `evidenceRelationships` (`unit`, `trailer`,
   `equipment`). No new table. Recording a document uses the existing `compliance.credentialRecord`.
5. **Inspection linkage (read)** — the portfolio shows the latest `inspections` rows per type and
   flags a `fail` / `needs_maintenance` newer than the last `pass` with no linked defect as
   `inspection_unresolved` (a projection reason, not a new gate). Widening the enum and creating the
   defect from a failed inspection is checkpoint 2.
6. **Defect reporting** — reuses `fieldRoute.compliance.maintenance.create` and
   `records.maintenance.resolveDefect` unchanged; the portfolio shows the lifecycle. Workflow depth
   is checkpoint 2.
7. **Operational hold** — `unitHolds` with typed placement and release (§B.4).
8. **Dispatch-readiness integration** — inside `composeReadiness`'s unit block (§B.5): active
   `unitHolds`, `incidentReports.unitHeld` (closes R-11), `lifecycleStatus`, `assetClass` of a bound
   trailer, components' critical defects rolled up to the parent. New codes classified in
   `CLASSIFICATION`; `CLASSIFICATION_VERSION` bumped. A unit-only question is answered by the same
   composer (§B.5).
9. **Fleet list + asset detail UI** — `/fleet` becomes authoritative: a `Fleet` panel in the portal
   shell (registered in `panelContract.ts`, mounted for `fleet_maintenance`, `dispatch`, `safety`,
   office and management portals) and `/fleet/:unitId` following the `/dispatch/:jobId`
   container/View/`.dom.test.tsx` pattern. The showcase stays under `/showcase/fleet`. The dead
   `fleet_maintenance` deep link `/units/:id` is routed to the detail page.
10. **Authorization** — the permissions in §B.7, every one mapped in
    `OPERATIONAL_PROCEDURE_PERMISSIONS`, sensitive ones fail closed; the count pins in
    `procedureAuthorization.test.ts` and `operationalApiAuthorization.test.ts` bumped; the inventory
    table updated.
11. **Tenant isolation** — `ownershipScopeWhere("unit", …)` on every read; `orgRef` written from the
    acting scope on every new row; `tenantScopeFleetPortfolio.db.test.ts`.
12. **Audit** — `fleetPortfolioEvents` appended inside every mutating transaction; triggers refuse
    edits; `authorizationDecisions` as today.
13. **Tests** — §16.

Then: **checkpoint 2 — Inspections and Defects** (enum widening, inspector and expiry provenance,
failed inspection → defect in one transaction, defect workflow stages and dispositions, mechanic
assessment of severity, `pretrip` / `posttrip` capture handlers on the sync path, offline unit card);
**checkpoint 3 — Documents, expiry and evidence** (per-asset vault view, uploader provenance,
download procedure, expiry projection tiers, photo purposes, damage reports);
**checkpoint 4 — Mechanic work-order portal** (typed parts and labour on the work order, one release
path, service intervals from the meter ledger, return-to-service screen). Permits (C6), TDG (C5),
tire UI, telematics ingestion and the AI Secretary's fleet capabilities come after, on this
foundation.

### 16. Test strategy

Every checkpoint runs `DATABASE_URL=… bash scripts/ci-gate.sh` (gates 0–8) before push. For the
first slice:

| Kind | File | What it proves |
|---|---|---|
| Pure | `server/_core/fleetPortfolio.test.ts` | operational-state derivation for every input combination; a hold, a critical defect, an OOS order, an expired blocking document, a retired unit each produce their named reason; unknown asset class is `asset_class_unknown`, never a truck; lifecycle transitions (retired/sold are terminal except by an explicit reactivation act; `transferred` refused until O-4); component cycles refused; a meter reading below the last verified reading of the same type is `meter_regression` (recorded, flagged, never rejected — a rolled-back odometer is evidence) |
| DB, API | `server/fleetPortfolio.db.test.ts` | a "preconditions" case that **fails** (not skips) without `DATABASE_URL`; create → get round-trip; hold place/release through the real router; lifecycle set; component attach/detach with history intact after detach; meter record/verify with separation of duties |
| Refusal | same file + `operationalApiAuthorization.test.ts` | driver: `fleet.get` on an unassigned unit → NOT_FOUND, `holdPlace` → forbidden, `holdRelease` → forbidden, `lifecycleSet` → forbidden; mechanic: `holdRelease` on a `safety` hold → forbidden, on a `maintenance` hold → allowed; dispatcher: `holdRelease` → forbidden; the placer of a hold may not release it (separation of duties); `holdRelease` on an already-released hold → PRECONDITION_FAILED; `meterVerify` by the person who entered it → forbidden; any procedure with an `orgRef` in its input → refused at the schema (static scan) |
| Tenant | `server/tenantScopeFleetPortfolio.db.test.ts` | org A's unit is absent from org B's list and NOT_FOUND on get/hold/component/meter; a legacy NULL unit is visible only to a member-less caller; a hold placed by org A cannot ground org B's dispatch of a same-numbered unit (guards O-2) |
| Readiness | `server/fleetReadiness.db.test.ts` | through `composeReadiness`: an active `safety` hold → `unit_hold_safety`, blocking, non-overridable, and the fingerprint moves; releasing it restores the previous verdict; a `warn` hold never blocks; `incidentReports.unitHeld` → `incident_unit_held`; a `retired` unit → `unit_retired`; a bound trailer whose `assetClass` is not `trailer` → `trailer_class_mismatch`; a component's critical defect blocks the parent; every new code is present in `CLASSIFICATION` and an invented code fails closed (`complianceFinding.test.ts`); unit-only readiness reports operator capabilities as `NOT_EVALUATED(not_applicable)` and is labelled as not a dispatch verdict |
| Concurrency | `server/fleetConcurrency.db.test.ts` | two `holdRelease` calls on one hold via `Promise.all` → exactly one `released`, one `already released`, one `releasedByUserId` (conditional `UPDATE … WHERE status='active'`, the `releaseOutOfServiceOrder` pattern); `holdPlace` racing `dispatch.award` on the same unit → the award refuses on fingerprint mismatch or the hold lands after the award and the next evaluation blocks — never an awarded unit with an unseen block; two `lifecycleSet` calls → last-writer refused on a version check; two `componentAttach` of the same child to two parents → one refused |
| Migration | `server/migrationLedger.db.test.ts` ("applies the real corpus"), `columnParity.test.ts`, `scripts/verify-parity.sh` | both files apply from empty; triggers refuse UPDATE/DELETE on `fleetPortfolioEvents` by raw SQL; no existing row changes meaning (`vehicleType` untouched, `lifecycleStatus` defaults to `active`) |
| Guards | `spineWiringPlan.test.ts`, `engineReachability.test.ts`, `procedureAuthorization.test.ts`, `panelContract.test.ts`, `legacyAssignmentGuard.test.ts`, `clientTruth.test.ts`, `messageAttachmentApi.test.ts` | the plan hash is untouched; `_core/fleetPortfolio.ts` is reached (the unwired pin does not rise); every new procedure is mapped; the Fleet panel's real calls match its contract; nothing new calls `jobUnits.create`; the showcase page count is unchanged; the attachment authorizer list, if `trailer` is added, is re-pinned |
| UI | `client/src/fleet/FleetAssetDetailView.dom.test.tsx`, `FleetListView.dom.test.tsx` | an unknown operational state renders "Unavailable", never "Available"; a block reason is shown with its code and subject; controls disappear on FORBIDDEN and say why |
| Docs | `scripts/current-state.sh` regenerated; a checkpoint document under `docs/fleet/checkpoints/`; the collision register row added when the number is taken | gate 8 |

### 17. Owner decisions required

| # | Decision | Recommendation |
|---|---|---|
| **O-1** | The 0169 double claim is a recorded release blocker for the next migration-bearing feature. Does the Fleet Asset Core wait for `claude/migration-0169-reconciliation`, or is it authorised to proceed at the next free number? | Wait for the reconciliation (it is one small PR); build the code on this branch meanwhile and take the number at PR time |
| **O-2** | `units.unitNumber` is unique across the database. Keep the global constraint (two companies can never both have "Unit 12") or scope it per organization (a generated `unitNumberKey = CONCAT(COALESCE(orgRef,'*'),':',unitNumber)` UNIQUE, the `0170` `roleTypeKey` pattern — which requires an `orgRef` column on `units`, a second place ownership would live)? | Keep global for this checkpoint and record the constraint; revisit with O-4, because both need the same ownership-history change |
| **O-3** | There is no `fleet_manager` role. Add one (a `userRoleAssignments` enum widening plus `GRANTS`), or map fleet management onto `shop_lead` + `management` (+ `office` for identity data) as this design does? | Map now; add the role when the org-scoped role grants branch has merged, so it is added once |
| **O-4** | Tenant-to-tenant transfer: defer (this design), or build now with an ownership-history row on `coreRecordOwnership` and the `lifecycleStatus = transferred` state? | Defer; `transferred` exists in the enum so a later migration adds no value, and the transition is refused until the history exists |
| **O-5** | Manual holds and D-09 ("internal company requirements warn by default; each company pack declares block explicitly"): should a `safety` or `inspection` hold placed by the safety role be `block` by default (this design), or `warn` until a company pack says otherwise? | Block: a person placing a safety hold is the explicit declaration D-09 asks for; `administrative` and `damage` holds warn unless placed as blocking by `management` |
| **O-6** | Outbox events for hold placed/released and lifecycle changes: emit through `emitDomainEvent` now (the emitter is written but declared unwired), or record only in `fleetPortfolioEvents` as C1a did? | Record only, consistent with C1a; wire the outbox for the whole compliance family in C7 |
| **O-7** | Drivers today hold `fleet.read` (the whole list, capped at 100). Keep that, or narrow the driver's fleet read to assigned units (`fleet.read_own`, universal and self-scoped through `dispatchRoles.assignedOperatorId` / `assignedUnitId`) as this design proposes? | Narrow; D-11 says a driver sees "assigned unit/trailer state" |
| **O-8** | Should `inspectionStatus` and `maintenanceStatus` on `units` be dropped in the first slice (readiness still reads `maintenanceStatus === "blocked"`, which nothing writes), or left as legacy until checkpoint 2 replaces that read? | Leave; drop in checkpoint 2 with the read |
| **O-9** | Component roll-up: does a child component's critical defect block the parent unit's dispatch by default (this design), or only when the relation is `removable = false`? | By default; a mounted vac system with a critical defect is the truck's problem until someone detaches it, and the detachment is the recorded act |

---

## Part B — The design

### B.1 Principles this design is held to

- **One record per fact.** A machine is a `units` row; its owner is `coreRecordOwnership`; its
  documents are `complianceDocuments`; its files are the evidence vault; its physical profile is
  `vehicleProfiles`; its money is `capitalAssets`; its readiness is `composeReadiness`. The portfolio
  is a projection over these and a set of narrow, audited writes.
- **Derived state is never stored.** Availability, holds that come from other records, expiry
  states and "why can't this unit leave" are computed with named reasons on every read.
- **Unknown is not clear.** An unclassified asset, a reading with no source, a document with no
  expiry recorded, a trailer whose class nobody set — each reads as UNKNOWN with the missing input
  named, and a safety-relevant UNKNOWN blocks (D-02).
- **History is appended, never rewritten.** Holds are released, not deleted; components are
  detached, not deleted; meters are corrected by a new reading, not an edit; assets are retired,
  sold or transferred, never deleted. The events table is trigger-protected.
- **Server-side enforcement only.** The UI offers controls and hides them on FORBIDDEN; it never
  decides.

### B.2 Asset identity

`units` + the new identity columns (§A.14). `assetClass` is the structural discriminator the gate
reads; `assetType` is the operational vocabulary from `shared/fleetAssetTypes.ts`:

| `assetClass` | `assetType` values (first list; extensible by migration, not by free text) |
|---|---|
| `power_unit` | `truck`, `tractor`, `body_job`, `vac_truck`, `hydrovac`, `tank_truck`, `picker`, `bed_truck`, `winch_tractor`, `pilot_vehicle`, `service_truck`, `pickup` |
| `trailer` | `van`, `flatdeck`, `lowboy`, `tanker`, `pup`, `hot_seat_trailer`, `reefer_trailer`, `equipment_trailer` |
| `mounted_system` | `vacuum_system`, `pto`, `hydraulic_pump`, `refrigeration_unit`, `heating_system`, `blower`, `debris_tank`, `water_pump`, `tank_body` |
| `portable_equipment` | `pressure_washer`, `pump`, `compressor`, `generator`, `light_tower`, `heater`, `misc_field_equipment` |
| `component` | `axle_group`, `engine`, `transmission`, `other_component` |

`vehicleType` is kept and still written (the composer, the driver-portfolio binding facts and the
Academy bindings read it); the create procedure derives it from `assetType` so the two never
disagree for new rows. Existing rows get `assetClass = NULL` and are reported as
`asset_class_unknown` until a person classifies them — a backfill by string-matching `vehicleType`
is a **proposal** a fleet manager confirms per unit, not a migration.

### B.3 Status: lifecycle stored, operational state derived

The owner's list maps onto two axes so that no stored flag can contradict the gate:

| Owner's value | Where it lives | How it is decided |
|---|---|---|
| `active` | `units.lifecycleStatus` | written by `fleet.lifecycleSet` |
| `seasonal_storage`, `retired`, `sold`, `transferred` | `units.lifecycleStatus` | same; `retired`/`sold` set `retiredAt`; `transferred` refused until O-4 |
| `available` | projection | lifecycle `active`, no blocking reason, no active booking or assigned slot now |
| `dispatched` | projection | an active `resourceBookings` row or a `dispatchRoles` slot with `assignedUnitId`/`assignedTrailerId` whose posting is `dispatched`/`in_progress` |
| `maintenance_hold` | projection | unresolved critical defect, missing release, open `roadside` event, work order in `waiting_parts`/`in_progress` with `priority = critical`, or an active `unitHolds` row of type `maintenance` |
| `inspection_hold` | projection | active `unitHolds` of type `inspection`, or a failed inspection newer than the last pass with no linked defect (checkpoint 2 makes this a defect) |
| `compliance_hold` | projection | a required document expired or missing with `missingSeverity = blocked`, insurance `coverage_expired`/`coverage_unknown`, or an active `unitHolds` of type `compliance`/`safety` |
| `out_of_service` | projection | an active `outOfServiceOrders` row reachable through `enforcementEvents` for this unit, in this tenant |
| `maintenance_due` | projection (warn) | a requirement `expiring` within its `warnDaysBeforeExpiry`, or a service interval due (checkpoint 4) |

The projection returns `{ state, reasons: ComplianceFinding-shaped[] }`, and when the inputs it
needs are unreadable it returns `unknown` with the missing input named — never `available`.

### B.4 Holds

Two kinds, kept apart on purpose:

- **Derived holds** come from their source records and are released only by acting on the source: a
  critical defect by `records.maintenance.resolveDefect` on a release that names it; a government
  order by `enforcement.orderRelease` under an OOS policy; a document by recording and verifying a
  new one; a roadside event by closing it. The portfolio names the source and the permitted action;
  it never offers a shortcut.
- **Manual holds** are `unitHolds` rows. Placement is typed and permission-gated; release is
  gated by hold type, sensitive, refused to the placer, and conditional on `status = 'active'` so a
  race releases once. Placement and release both append a `fleetPortfolioEvents` row and, for a
  `block` hold, change the eligibility fingerprint (`unitHoldVersion` joins `EligibilityFacts`).

`incidentReports.unitHeld` stays where it is; the composer reads it (R-11) as `incident_unit_held`,
released when the incident's `safetyReviewedAt` is set or `unitHeld` is cleared under
`incident.review`. A damage report (checkpoint 3) may place a `damage` hold; it never creates a
mechanical defect by itself.

### B.5 Dispatch-readiness integration

All inside `composeReadiness`, in the existing unit block, emitting through the existing `extra`
list and classified in `CLASSIFICATION`:

| Producer code | Severity | Class | Authority | Source |
|---|---|---|---|---|
| `unit_hold_safety`, `unit_hold_inspection`, `unit_hold_compliance`, `unit_hold_maintenance` (effect `block`) | blocking | `APPROVED_POLICY_ONLY` | `carrier_safety_policy` | `unitHolds` |
| `unit_hold_damage`, `unit_hold_administrative` (effect `warn`) | review | `WARNING_ONLY` (manager) | `company_policy` | `unitHolds` |
| `incident_unit_held` | blocking | `NEVER_OVERRIDABLE` | `carrier_safety_policy` | `incidentReports.unitHeld` |
| `unit_retired`, `unit_sold`, `unit_transferred`, `unit_in_storage` | blocking | `NEVER_OVERRIDABLE` (`in_storage`: `APPROVED_POLICY_ONLY`) | `company_policy` | `units.lifecycleStatus` |
| `asset_class_unknown` | unknown | `APPROVED_POLICY_ONLY` | `carrier_safety_policy` | `units.assetClass` |
| `trailer_class_mismatch` | blocking | `NEVER_OVERRIDABLE` | `carrier_safety_policy` | bound trailer's `assetClass` |
| `component_critical_defect:<childUnitId>` | blocking | `NEVER_OVERRIDABLE` | `carrier_safety_policy` | `unitComponents` × `maintenanceDefects` |

Existing trailer-compatibility (`trailer_compatibility_unknown`) is **not** touched here; it is C3's
`vehicleProfiles` work. Slot `requiredEquipmentClass`/`requiredTrailerClass` are compared against
`assetType` in checkpoint 2 once the vocabulary is populated (`equipment_class_mismatch`).

**Unit-only readiness.** `composeReadiness` gains `subject.operatorId: number | null`. With no
operator, every operator-side capability (HOS, licence, qualification, medical, availability) is
reported `NOT_EVALUATED` with reason `not_applicable`, the verdict is labelled
`unit_side_only` in `contributions`, and `fleet.unitReadiness` returns it as an explanation, never
as an award-able check (`dispatch.evaluate` keeps requiring an operator; `usedForAward` is
unreachable from the unit-only path). This is the "generalise rather than sit beside" the roadmap
asks for and the C4 "Can Dylan take Unit 117" acceptance target reads the same composer.

### B.6 Meters

`unitMeterReadings` holds readings that have no home. The portfolio's meter view is a **union with
provenance**: `unitMeterReadings` (source as recorded), `telemetrySnapshots` (`telematics`,
`sourceClientId`), `workOrders.odometerKm/engineHours` (`work_order`), `fuelTransactions`
(`fuel_receipt`), `trips.odometerStart/EndKm` (`trip`), `tireInstallations` (`tire_service`). The
"latest" reading is the latest *verified* reading per meter type, and it says which source it is; a
newer unverified reading is shown beside it. `odometerReconciliation` in `server/_core/telematics.ts`
stays the reconciliation engine and gains the manual ledger as one more input. Nothing writes a
current value onto `units`. Service rules ("every 10,000 km / 500 h / 90 days, whichever first")
are checkpoint 4 and read this union.

### B.7 Permissions

Existing permissions are reused where the act already exists (`maintenance.write_defect`,
`maintenance.record_release`, `inspection.write`, `compliance.credential.verify`,
`enforcement.release`, `dispatch.read`). New, all mapped in `OPERATIONAL_PROCEDURE_PERMISSIONS`:

| Permission | Roles | Sensitive | Notes |
|---|---|---|---|
| `fleet.read_own` | universal (driver) | no | self-scoped: units bound to the caller's operator through `dispatchRoles`; takes no unit id from the driver |
| `fleet.read` | existing holders | no | unchanged (O-7 narrows the driver) |
| `fleet.asset.manage` | shop_lead, office, management | **yes** | create, identity edit |
| `fleet.lifecycle.set` | shop_lead, management | **yes** | retire, sell, storage, reactivate |
| `fleet.hold.place` | mechanic, shop_lead, safety, management (type-gated: mechanic may place `maintenance` only) | **yes** | |
| `fleet.hold.release` | per type: `maintenance` → mechanic, shop_lead; `inspection`, `safety`, `compliance` → safety, management; `damage`, `administrative` → shop_lead, management | **yes** | refused to the placer; never the driver; never the dispatcher |
| `fleet.component.manage` | mechanic, shop_lead, management | **yes** | attach/detach |
| `fleet.meter.record` | driver (own assigned units), mechanic, shop_lead, office | no | |
| `fleet.meter.verify` | mechanic, shop_lead, management | **yes** | not the recorder |
| `fleet.readiness.read` | dispatcher, mechanic, shop_lead, safety, office, management | no | unit-only readiness |

Deny-by-default: a driver never holds `fleet.hold.release`, `fleet.lifecycle.set`,
`fleet.component.manage` (`DENIALS`), and `NEVER_AUTONOMOUS` gains `fleet.holdRelease` and
`fleet.lifecycleSet` so no agent path can clear a unit.

### B.8 Documents, expiry and evidence

- Regulatory documents and permits-as-documents: `complianceDocuments` (`ownerType` `unit`,
  `trailer`, `equipment`; `docType` from the requirement seeds plus `permit:<kind>` and
  `certification:<kind>`; `jurisdiction`; `identifier`; `issuedAt`; `expiresAt`; verification by a
  second person). Checkpoint 3 adds `recordedByUserId` and a download procedure that writes an
  `evidenceAccessEvents` row.
- Photos, manuals, invoices, damage evidence: `evidenceRecords` + `evidenceRelationships`
  (`unit` / `trailer` / `equipment` / `workOrder` / `inspection` / `incident`) with `category` as
  the folder (`registration`, `insurance`, `permits`, `inspections`, `maintenance`, `work_orders`,
  `invoices`, `manuals`, `photos`, `damage`, `certifications`, `purchase`, `lease`, `warranty`,
  `disposal`) and `role` as the photo purpose (`front`, `rear`, `driver_side`, `passenger_side`,
  `vin_plate`, `licence_plate`, `unit_number`, `serial_plate`, `damage`, `defect`, `repair`,
  `inspection_evidence`). Hash, seal, device, coordinates and capture ref already exist.
- Expiry: `documentValidity.validityOf()` is the one validity function (SPINE item 2 resolves the
  inline duplicate). Block vs warn per document comes from `complianceRequirements.missingSeverity`
  and `warnDaysBeforeExpiry`; reminder tiers follow D-13 and are labelled "reminder", distinct from
  the legal deadline. The portfolio's expiry dashboard is the driver portfolio's `expiryAlerts`
  shape over unit owners. No second threshold table.

### B.9 Equipment-specific specifications

Legal and routing attributes (GVWR, registered weight, axle configuration, sleeper configuration,
unit class, tare, dimensions, wheelbase) belong on **`vehicleProfiles`** with `source` and
`verificationStatus`, as C3 specifies; job forms never write them, and a value nobody verified reads
`unverified` in the route fingerprint.

Category specs (tank capacity, compartments, product compatibility; debris and water capacity,
blower and vacuum rating, pump type; reefer unit and temperature range; pressure, flow, heat source;
electrical output, fuel type) go in one typed table in checkpoint 2:

```
unitSpecifications: unitId, specClass (= assetType), schemaVersion, specJson, source, measuredAt,
                    verificationStatus, verifiedByUserId, recordedByUserId, supersededBySpecId
```

- **Validation:** one zod schema per `specClass` in `shared/fleetSpecifications.ts`, keyed by
  `schemaVersion`; the router refuses a row whose JSON does not parse under its declared version
  (the `axleGroupsJson` precedent, made explicit).
- **Versioning:** a spec is never edited; a new row supersedes the old (`supersededBySpecId`), and a
  schema change is a new `schemaVersion` with a reader that upgrades old rows on read, never a data
  rewrite.
- **Capacity** fields are present in the tank/vac schemas as *recorded* values and are **not** read
  by dispatch or routing until the deferred capacity model lands; the composer keeps answering
  `capacity_unknown`.

### B.10 Later checkpoints — schema deltas already foreseen

| Checkpoint | Additive change |
|---|---|
| 2 Inspections & Defects | `inspections.type` widened (`cvip`, `annual`, `trailer`, `tank`, `pressure_vessel`, `brake`, `tire`, `shop`, `regulatory`, `company`, `equipment_specific`); `inspectorUserId`, `nextDueAt`, `evidenceRecordId`, `workOrderId`, `resultingDefectId`; `maintenanceDefects` gains `workflowStage` (`reported / acknowledged / assessed / repair_required / work_in_progress / repaired / verification_required / verified / closed`), `disposition` (`repair_required / deferred / monitor / duplicate / invalid`), `affectedSystem`, `componentUnitId`, `assessedSeverity`, `assessedByUserId`, `duplicateOfDefectId`; `status` keeps `open / in_progress / resolved` as the readiness-facing lifecycle so the 0169 repair is untouched; `unitSpecifications` |
| 3 Documents & Evidence | `complianceDocuments.recordedByUserId`; `damageReports` (unit, trailer, kind, incident link, claim link, hold link, evidence); evidence download procedure |
| 4 Mechanic portal | `workOrderLabour`, `workOrderParts` (typed, replacing the free-text columns for new rows), `serviceIntervals` + `serviceDue` projection; retire `records.maintenance.recordRelease` in favour of `shop.workOrderRelease` |

### B.11 Offline

- **Read:** `fleet.myAssignedUnits` returns, per assigned unit, a cacheable **unit card** —
  identity, lifecycle, operational state with reasons, active holds, known open defects, required
  documents with validity, latest inspection, emergency/manual pointers — with `generatedAt`,
  `validUntil` (the earlier of the offline allowance and the first governing expiry) and the shared
  rule `shared/fleetUnitCard.ts: unitCardStatusAt()` (READY/ACTION REQUIRED → STALE past
  `validUntil`; NOT READY stays NOT READY). `preDepartureCache.CacheItemKind` gains `unit_state` and
  `unit_documents` (necessity `required_to_depart`), so a missing card is named, not counted.
  Checkpoint 2 work, once the card's inputs exist.
- **Write:** offline mutations use the existing capture kinds (`pretrip`, `posttrip`,
  `defect_report`, `photo`, `incident`) through the device outbox and `sync.receivePackage`; the
  server handlers for `pretrip` / `posttrip` (absent today) land in checkpoint 2 and create the
  inspection and, on failure, the defect, carrying the capture-time authorization claim
  unchanged. No second sync path. A hold is never placed or released from a device.

### B.12 AI Secretary

Reads: `agentRouter` capabilities `fleet.readUnit` (exists), plus `fleet.unitPortfolio`,
`fleet.unitReadiness`, `fleet.expiryDashboard`, `fleet.holdList` — all `read`, all through the
router's own procedures with the caller's permissions. Writes: only the typed proposal path
(`FORMS` + `plan<Form>` adapter + executor), starting with `defect_report` (exists) and, later,
`meter_reading` and `work_order_from_defect` as `prepare`/`approval_required`. `fleet.holdRelease`,
`fleet.lifecycleSet`, `maintenance.clearOutOfService` stay in `NEVER_AUTONOMOUS`. The Secretary
layer itself remains under the moratorium until the spine is wired.

### B.13 UI

Portal-first, matching the existing shell rather than the showcase:

- **Fleet list** — a `FleetPanel` in `PortalShell` (registered in `PANEL_CONTRACTS` with exactly
  `fleet.list`), exception-first: filters `state` (available / dispatched / maintenance / out of
  service), `expiring documents`, `inspection due`, `assetClass`/`assetType`, branch, unit number;
  each row a status word + icon from one vocabulary (`fleetPresentation.ts`, the
  `readinessPresentation.ts` pattern; unknown → "Unavailable").
- **Asset detail** — `/fleet/:unitId` (`client/src/fleet/FleetAssetDetail.tsx` container +
  `FleetAssetDetailView.tsx` + `.dom.test.tsx`): header (unit number, type, lifecycle, operational
  state, assigned driver from the live slot, location if a last position exists); cards **Dispatch
  readiness** (unit-only composer output, labelled), **Holds**, **Defects**, **Inspections**,
  **Documents**, **Work orders**, **Usage** (meters with source), **Components**, **Photos**; tabs
  Overview / Maintenance / Inspections / Defects / Documents / Equipment / History, with three
  levels of disclosure (summary → detail → evidence: expires, verified by, source, confidence).
  Controls (place/release hold, lifecycle, attach/detach) are offered and withdrawn on FORBIDDEN
  with the server's reason, as `DispatchJobDetail` does.
- `/fleet` stops redirecting to the showcase; `DashboardLayout` "Fleet & compliance" points at it.
  `/showcase/fleet` is left as it is.

---

## Part C — What this design refuses to do, and why

- **No second asset table.** 53 tables already point at `units.id`; a `fleetAssets` table would be
  the third answer to "which machine" beside `units` and `capitalAssets`.
- **No stored availability.** The readiness repair of 2026-09-23 exists because a stored state
  drifted from its evidence. The portfolio computes state and names its sources.
- **No new gate.** Fleet eligibility enters `composeReadiness` through the same `extra` list, the
  same `CLASSIFICATION`, the same fingerprint, the same override ladder as every other engine.
- **No permit engine, no capacity column, no threshold table, no second sync path, no second
  outbox, no new `_core` decision engine** — each is either already planned under a named compliance
  checkpoint, ruled on by the owner, or forbidden by the moratorium.
- **No destructive cascade.** Retire, sell, transfer, release, detach — every one leaves the rows
  that old jobs, bills, inspections and orders reference.

## Sources read

`LEASEOS_CURRENT_STATE.md`, `LEASEOS_B21_15_FLEET_SHOP.md`, `LEASEOS_B21_16_CAPITAL_ASSETS.md`,
`LEASEOS_B21_19_TELEMATICS.md`, `LEASEOS_B21_1_DISPATCH_GATE.md`, `LEASEOS_B21_2_DISPATCH_ENFORCEMENT.md`,
`LEASEOS_B20_RECORDS_VAULT.md`, `LEASEOS_B22_19_OFFLINE_PACKAGE.md`, `LEASEOS_MASTER_PROGRAMMING_MANIFEST_V8.md`
(§8 mechanic workflow, "Unit → Inspection → Defect → Work Order → Mechanic Release → Dispatch Eligibility"),
`PROCEDURE_AUTHORIZATION_INVENTORY.md`, `docs/register/SPINE_WIRING_PLAN.md` and its provenance,
`docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`, `docs/register/READINESS_DEFECT_REPAIR.md`,
`docs/register/ROADMAP_2026-09-21.md`, `docs/register/SCOPE_RECONCILIATION_2026-09-21.md`,
`docs/compliance/unified-compliance-engine-design.md` (§1.7, §2, §3, §8, §11, §12, §14, D-01…D-18),
`docs/compliance/unified-compliance-engine-implementation-plan.md` (C1a…C11, migration slots),
`docs/compliance/checkpoints/C1A_READINESS_HARDENING.md`, `docs/compliance/follow-ups/TENANCY_UNSCOPED_COMPLIANCE_TABLES.md`,
`docs/architecture/MIGRATION_COLLISION_REGISTER.md`, `docs/REMAINING_BUILD_REGISTER.md`,
the driver portfolio branches (`origin/claude/driver-portfolio-api-ya8928`: migrations 0175–0177,
`server/_core/driverPortfolio.ts`, `driverPortfolioRouter.ts`, `driverPortfolioService.ts`,
`shared/driverWallet.ts`, `LEASEOS_DRIVER_PORTFOLIO_CHECKPOINT_2026-09-23.md`), `drizzle/schema.ts`,
migrations `0003`, `0019`, `0036`–`0039`, `0051`, `0052`, `0055`, `0058`, `0082`–`0087`, `0113`,
`0132`, `0152`, `0169`–`0171`, `0174`, and the server, client and test files named inline.
