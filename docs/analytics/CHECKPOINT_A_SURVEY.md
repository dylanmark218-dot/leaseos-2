# Analytics, Reporting & Operational Intelligence — Checkpoint A (survey)

Against `v23.25` (HEAD `6f52b57`, 410 tables, 169 migrations, 652 role-authorized procedures).
**A survey, no code.** Nothing in `server/`, `client/`, `shared/` or `drizzle/` was changed for
this checkpoint. **Checkpoint B has since been built** — see `docs/analytics/CHECKPOINT_B.md` for what was
implemented and what the survey's plan became. Every claim below was checked in the source, not inferred from the checkpoint
prose; schema references are `drizzle/schema.ts:<line>` unless another file is named.

The survey answers the nine questions Checkpoint A asked for, in order:

1. existing data sources
2. existing schemas and services that can be reused
3. missing dependencies
4. contradictions with the proposal
5. recommended architecture
6. proposed analytics permissions model
7. proposed metric definitions
8. migration requirements
9. test plan

Then a proposed order of implementation checkpoints, and what the Administration & Company
Configuration Center must supply before some of this can be honest.

---

## 0. The findings that shape everything else

Ten facts decide the design. Each is expanded in the sections that follow.

1. **LeaseOS is single-tenant in fact.** `resolveActingScope` falls back to `SINGLE_TENANT_ID =
   "default"` for a user with no membership (`server/_core/actingScope.ts:43,102`), and refuses a
   user with two memberships rather than offering a choice. Of 410 tables, about 76 carry any
   organization column (41 `orgRef`, 19 `tenantId`, 13 `bookOrgRef`) and about 334 carry none —
   including `units`, `operators`, `loads`, `invoices`, `vendorBills`, `workOrders`,
   `fieldTickets`, `disposalTickets`, `dutyRecords`, `complianceDocuments` and every audit log.
   Scope for those goes through `coreRecordOwnership` (unit / operator / load / financial_entity),
   through `financialEntities.orgRef` for money, or through a join to a scoped job or trip.
   `server/tenantIsolation.test.ts:4` states it plainly: "Organization-wide isolation is not a
   property this system has." The analytics layer cannot be "organization-scoped" by adding one
   predicate; it has to inherit the *per-table* scope helpers, and it has to say so.
2. **No platform-administrator cross-organization view exists** (`users.role` is `user|admin`;
   `adminProcedure` guards three bootstrap procedures). Roles are not per organization
   (`userRoleAssignments.scopeType` is `global|branch`, `docs/register/PORTAL_ORG_SCOPE_DEFERRED.md`
   §2). Platform-level analytics has no authorization substrate to stand on yet.
3. **There is no branch.** No branch table; branch is free text on seven workflow/enforcement
   tables, on memberships and on role grants, and absent from jobs, trips, units, invoices and
   bills (`server/_core/profitability.ts:17` already declares branch "not derivable").
4. **There is no downtime ledger, no unit status, and no scheduled-maintenance concept.** `units`
   has no status column; `units.maintenanceStatus`/`inspectionStatus` are write-once dead fields;
   the only "downtime" today is a work-order open→complete proxy in `asset.twin` that misses
   advance-closed work orders (`shop.workOrderAdvance` sets no timestamps).
5. **Much of the operations schema is never written.** `loads`, `disposalBatches`,
   `dispatchInvitations`, `dispatchBids`, `dispatchTemplates`, `workflowInstances`,
   `workflowTransitions`, `operatorAvailability`, `onCallRotations`, `operatorCapabilities`,
   `dailyLogs`, `incidentActions`, `incidentPeople`, `checklistItems`, `programAcknowledgements`
   have no production writer. `jobs.status` is set once at create and never updated.
   `domainEmitters.ts` is imported by nothing, so every seeded workflow rule except enforcement
   never fires.
6. **Every rule figure is unverified (P9).** HOS limits, tax rules and CCA rates read UNKNOWN by
   design; `hosClockPresentation.ts:76` bans the labels "hours remaining", "compliant" and "time
   left". "HOS remaining" and "HOS violation" cannot be computed today, only elapsed clocks.
7. **Everything is UTC.** No DB timezone, no `TZ`, no organization or site timezone; "today",
   shift and period boundaries are UTC days and UTC calendar months (`portalRouter.ts:437`,
   `periodClose.ts:22-27`, `gstReturn.ts:49-53`, `iftaEngine.ts:23-28`). The only local-time
   precedent is the assistant's required `utcOffsetMinutes`, never guessed
   (`assistantCommitAdapters.ts:296-345`).
8. **Revenue is already defined four different ways** (profitability, project forecast, GST line
   101, GL export readiness — §1.9), none nets approved credits, and the existing P&L reads
   contractor payables across tenants. A metric registry is not optional; it is the fix.
9. **The honesty vocabulary already exists and must be reused, not re-invented:**
   `computed | partial | unknown` with `unknowns[]` (asset twin, CCA, forecast);
   `PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED` (`interEngineStatus.ts`);
   `ready | review | blocked | unknown` (passport); `ok | stale | unknown | blocked | offline |
   not_permitted | failed` + `Provenance` (`widgetPayload.ts`). There is **no GREEN/AMBER/RED** and
   the compliance design forbids percentage scores (`safetyBinder.ts:99`, unified design §19).
10. **A moratorium on new engines is test-enforced.** `docs/register/SPINE_WIRING_PLAN.md`: "The
    moratorium stands: no new engines until this path is wired", pinned by
    `server/spineWiringPlan.test.ts`; `server/engineReachability.test.ts` fails any new
    `server/_core/*.ts` not reached by production code or declared unwired. The analytics layer is
    permitted work only if it is what the moratorium allows — "a resolver, or a router over
    something already written" — or the owner records an explicit exception.

---

## 1. Existing data sources

Legend for the **Analytics use** column: **READY** — a metric can be computed from it now with the
existing scope helpers; **PARTIAL** — computable with stated unknowns; **NONE** — no rows, no
timestamps, or no writer.

### 1.1 Organizations / tenants

| Source | Where | What it carries | Analytics use |
|---|---|---|---|
| `organizations` | schema:6864 | `orgRef` unique, `status` active/suspended/closed | dimension |
| `organizationMemberships` | :6873 | `orgRef`, `userId`, `membershipType` employee/contractor/client/system, `status`, `defaultWorkspace`, free-text `branchId` | READY (org of a user) |
| `organizationRelationships`, `organizationWorkers`, `contractorBusinessProfiles` | :7849, :7869, :7862 | prime/sub relationships; `workerType` (14 values), `status` active/inactive/ended | READY (headcount by worker type; no list procedure exists) |
| `coreRecordOwnership` | :5514 | owner `orgRef` per unit / operator / load / financial_entity; NULL owner = historical single tenant | the scope key for fleet and workforce |
| `financialEntities` | :3131 | `orgRef`, `fiscalYearEndMonth/Day` | the scope key for money |
| Scope helpers | `server/db.ts:160` `orgScopeWhere`; `:784-811` `ownershipScopeWhere`, `unitInScope`, `workOrderInScope`; `:817` `userInScope`; `:825-906` `jobScopeSubquery`, `tripScopeSubquery`, `jobInScope`, `tripInScope`, `fieldTicketInScope`; `_core/entityScope.ts` `entityScopeWhere`, `entityIdsInScope`, `assertEntityInScope` | out-of-scope reads as "not found", never "forbidden" | **the only correct way** to scope any metric |

Known scope leaks analytics must **not** copy: `surfaces.exceptions` sources
(`surfacesService.ts:48`), `surfaces.search` (:206), `surfaces.timeline` (:256), `auditRouter.ts`
(never resolves scope), `workOrders.list` without `unitId` (`db.ts:421`), all of
`telematicsRouter.ts`, `asset.twin`, `project.forecast`, `dutyRecords.list` without `operatorId`
(`db.ts:405`), `hos.status`, `compliance.passport`, `readiness.forTime`, and the finance routers
that take `financialEntityId` unchecked (cash, fuelOps, ifta, gst, asset, project, period,
invoicing, purchasing, `commercialOffice.profitability`). `docs/compliance/follow-ups/TENANCY_UNSCOPED_COMPLIANCE_TABLES.md`
records the compliance half of this.

### 1.2 Users and roles

| Source | Where | Notes |
|---|---|---|
| `users` | schema:9 | `role` user/admin only; no status column |
| `userRoleAssignments` | :3071 | 15 `DomainRole`s; `scopeType` global/branch + `scopeRef`; **no org column** |
| `authorizationDecisions` | :3104 | every gated call (reads included): actor, procedure, permission, roles held, outcome; no org, no input parameters |
| `recordsAuthorization.ts` | `Permission` union :45-332 (355), `GRANTS` :349, `DENIALS` :1702, `UNIVERSAL_PERMISSIONS` :1668 (13), `SENSITIVE_PERMISSIONS` :1737 (125), `OPERATIONAL_PROCEDURE_PERMISSIONS` :2182 (634 entries, count pinned) | **no analytics / report / metric / dashboard permission exists**; closest are `surface.exceptions.read`, `commercial.read`, `commercial.margin.view`, `audit.package.*` |
| `portalComposition.ts:34` | 16 `PortalKey`s; `executive` is "a lens on management … what is aggregated, not what is permitted" (:212) | portals are windows, not grants |

### 1.3 Drivers / operators and driver portfolios

| Source | Where | Notes |
|---|---|---|
| `operators` | :120-135 | `userId` nullable, no FK; **no status, no orgRef**; legacy `licenseExpiresAt`, `certifications` text. Scoped via `coreRecordOwnership` + `operatorInScope` (`db.ts:845`). `operators.list` caps at 100 |
| "Active driver" | — | **no canonical source.** Candidates: `organizationWorkers.status`, `organizationMemberships.status`, `employeePayrollProfiles.payrollStatus` (:3275), `crewMembers.leftAt IS NULL`, absence of `offboardings` |
| "Available driver" | `_core/crewCoverage.ts:35` | rotation minus leave (`crews.forecast` covered/tight/short). `operatorAvailability` (:1755) is dead; readiness hard-codes `availabilityDeclared:false` (`readinessComposer.ts:833`) |
| "Dispatched driver" | — | `trips.operatorId` with status loading/in_transit/unloading (`routers.ts:191`); `dispatchRoles.assignedOperatorId` (no timestamps); `dispatchRoleAssignmentEvents` (:1936, `orgRef`, `occurredAt`); `jobUnits.joinedAt` (`departedAt` never written); `jobCrewAssignments.startsAt` (no end) |
| Driver portfolio | — | **no table or aggregate.** `compliancePassport.ts` (pure, `buildPassport` :227) is the nearest; the driver audit package (`auditRouter.ts:107-117`) is the nearest "file" |
| Persisted readiness history | `dispatchEligibilityChecks` :2017 (`verdict`, `blockersJson`, `evaluatedAt`, `orgRef`), `dispatchOverrides` :2061 | **the best compliance time series in the system** |
| Known bug | `workforce.applicantDecide` creates an operator without an ownership row (`workforceRouter.ts:86`) | a driver hired by a real org is out of that org's scope |

### 1.4 Training / certification wallet

Five overlapping stores with inconsistent codes:

| Store | Where | Codes / status | Writer |
|---|---|---|---|
| `complianceDocuments` | :180-210 | `ownerType` operator/unit/job/trailer/carrier/user/equipment; `docType` free text; `verificationStatus` needs_review/verified/rejected; `expiresAt`; `privateDetail` | `compliance.credentialRecord/Verify`, workforce verify paths, `hos.recordScannedLog` |
| `trainingRecords` | :5721 | `COURSE_CREDENTIALS` (`_core/workforce.ts:41`): H2S_ALIVE→`h2s_alive` 3y, FIRST_AID_STANDARD→`first_aid` 3y, TDG_GROUND→`tdg_certificate` 3y, WHMIS_2015→`whmis` | `workforce.trainingRecord/Verify` |
| `competencySignoffs` | :5741 | level trainee/competent/senior | `workforce.competencySignoff` |
| `workerQualifications` / `qualificationTypes` | :7004 / :6991 | `tenantId`; `verificationState` | **no production writer** (read by readiness, shifts, crews, calendar) |
| Academy: `academyQualifications` :7488, `academyCertificates` :7507, `academyRequirements` :7651, `academyRequirementBindings` :7665, `academyAssignments` :7375 | `status` pending/current/expired/revoked/rejected — **`expired` is never written**, computed at read (`readinessComposer.ts:471`); `overdue` assignment never written | academy router |

Code mismatches: `whmis` / `whmis_certificate` / `WHMIS_EMPLOYER`; `tdg_certificate` / `TDG_ROAD`.
No H2S or First Aid requirement seed. All compliance requirement seeds are `unverified`, so every
passport item reads UNKNOWN until a person verifies it.

Expiry is computed in **four** places with different windows: `documentValidity.validityOf`
(:72, 30 days), `readinessComposer.credentialState` (:345), `surfacesService` exception loader
(:69-71, 90-day horizon, unscoped), `compliancePassport` (`warnDaysBeforeExpiry`, default 30).
Insurance uses 90/60/30/14/7 (`insuranceRisk.ts:133`).

### 1.5 Trucks, trailers, equipment / assets

| Source | Where | Notes |
|---|---|---|
| `units` | :137-161 | `vehicleType` **free text** (no catalog, no enum); `company` text; no status, no odometer, no engine hours, no branch/yard, no orgRef. "There is no trailers table: a trailer is a unit whose vehicleType says so" (`readinessComposer.ts:637`); `trailerId` / `equipmentId` columns everywhere point at `units.id` |
| `vehicleProfiles` | :5861 | dimensions/weights, `verificationStatus` (routing) |
| `capitalAssets` | :5302 | one per unit; `acquisitionCostCents`, expected life; `status` incl. `out_of_service` **never written** |
| `jobUnits` | :163-178 | manual `hours`, `mileage`, `joinedAt`, `departedAt` (never closed) |
| `measurementDevices` / `calibrationEvents` / assignments | :4259-4299 | calibration state feeds readiness and exceptions |
| `asset.twin` | `assetRouter.ts:141-164`, `_core/capitalAssets.ts:105-137` | lifetime only, no period, **no tenant check**; outputs `operatingCostCents` (null unless all known), `knownCostCents`, cost/km, cost/hour, `downtimeHours`, `determination`, `unknowns[]` |

### 1.6 Inspections, maintenance, work orders, defects, downtime

| Source | Where | Notes |
|---|---|---|
| `inspections` | :298-315 | `type` training/pre_trip/post_trip; `status` pass/fail/needs_maintenance/not_applicable; `checklist` free text; `observedAt`. **No due/overdue logic anywhere.** CVIP/annual is a `complianceDocuments` row (`cvip_certificate`, `annual_inspection`; seed `ab.unit.cvip.annual` at `complianceRequirementSeeds.ts:49`) |
| `maintenanceDefects` | :317-349 | `severity` advisory/inspection_required/critical; `status` open/in_progress/resolved (`in_progress` never written); `reportedAt`, `resolvedAt`; **no repeat linkage, no component code, no source enum** |
| `workOrders` | :671-704 | `status` draft/open/in_progress/waiting_parts/ready_for_service/closed; `priority`; `openedAt/startedAt/completedAt`; `laborMinutes`; `parts` **text**; `engineHours`, `odometerKm`. **No cost columns, no vendor link, no scheduled/PM flag, no status history.** `shop.workOrderAdvance` sets status only, so an advance-closed work order has no `completedAt` |
| `workOrderReleases` | :3021 | append-only full/restricted/revoked; `currentReleaseEvidenceFor` (`mechanicRelease.ts:225`) |
| Shop ledger | :5118-5284 | `partMovements` (`unitId`, `workOrderId`, `unitCostCents`), `tires`/`tireInstallations`, `warrantyClaims`, `recallUnitStatus`, tools. `fleetShop.ts` `workOrderCost` (:134) parts + labour; **labour rate is a caller-supplied parameter**, `chargeDefinitions.rateKind = internal_cost` (:5960) is unread |
| Downtime | — | **no table, no unit status history.** Partial signals: `outOfServiceOrders` :6788 (`issuedAt`→`releasedAt/rescindedAt`, joined via `enforcementEvents.unitId`), `roadsideServiceEvents` :3893 (`occurredAt`→`closedAt`, `vehicleMovable`, `estimatedDelayMinutes`), `delayEvents` :4965 (`kind = breakdown`), critical defects without a standing release, `payrollTimeEntries.activity = shop` with `unitId`. **Scheduled vs unscheduled cannot be derived** (no PM or service-interval concept) |
| Telematics | `telemetrySnapshots` :5583 (`odometerKm`, `engineHours`, `ptoHours`, `idleMinutes`, `fuelLevelPct`; no position, ignition or speed), `faultCodes` :5597, `drivingEvents` :5617, `tripBreadcrumbs` :888; GPS positions otherwise only in `inboundEvents.payloadJson` (`spatialRouter.ts:347-358`) | written only by the integration gateway; `telematicsRouter` is unscoped; no aggregation anywhere |

### 1.7 Dispatch, assignments, jobs, loads, tickets

| Source | Where | Notes |
|---|---|---|
| `jobs` | :15-46 | `orgRef`, `customerOrgRef`, `mode` general/hydrovac/recovery/transport, `status` dispatched/in_transit/loading/on_site/awaiting_docs/complete — **set once at create, never updated; no `jobs.update`**; no scheduled/started/completed timestamps, no estimated revenue, no branch, no dispatcher, no `customerAccountId` (`customer` is text) |
| `dispatchPostings` | :1806-1872 | **no orgRef** (scope via job); `planningState` never advances past staffed/partially_staffed in production; `scheduledStart`, `estimatedDurationMinutes`, `expectedLoads`, `postedRateCents` **never written** |
| `dispatchRoles` :1876, `dispatchRoleAssignmentEvents` :1936, `resourceBookings` :2101 | assignment now, assignment history with `occurredAt`, planned window (bookings never released) | READY for "who is assigned", PARTIAL for "for how long" |
| `dispatchEligibilityChecks` :2017, `dispatchOverrides` :2061 | verdict eligible/eligible_review/blocked/unknown, `blockersJson` with the reason codes in §1.11 | READY |
| `trips` | :572-604 | `orgRef`; `status` planned/loading/in_transit/unloading/complete/cancelled; `startedAt/completedAt`; `distanceKm` from odometer at create; caller-set, no state machine |
| `tripStops` | :606-631 | `arrivedAt/setupStartedAt/operationStartedAt/operationCompletedAt/departedAt`; wait/setup/duration minutes derived on create only; confirmed `zoneEvents` do **not** write `arrivedAt` (`routers.ts:921-941`) |
| `loads` | :1003-1046 | **no production writer**, no orgRef, no timestamps, `chainState` never updated, no weight, no rejected/partial flag |
| `fieldTickets` :1133-1173, `fieldTicketLines` :1178, `fieldTicketSignatures` :1226, `fieldTicketEvents` :1276, `fieldTicketRevisions` :4949, `delayEvents` :4965 | `signatureStatus` unsigned/accepted/partially_accepted (refused / no_representative never written); line `disposition` not_presented/accepted/disputed; events clocked by `EVENT_CLOCK` (`siteCloseout.ts:19-38`: site_work, standby, customer_hold, weather_hold, travel_to_disposal, disposal_queue, disposal, return_travel, post_trip, …) with `clock` and `customerBillable` yes/no/review | **the richest time-on-site and paperwork source**. `closeoutState` (`siteCloseout.ts:204-229`) is pure and reusable but exposed per ticket only (`closeout.state`), no list |
| `billingBooks` :970 / `billingBookEntries` :1483 | `billingState` — only `billing_review` and `invoiced` are ever written | PARTIAL |

### 1.8 Disposal facilities and disposal tickets

| Source | Where | Notes |
|---|---|---|
| `disposalTickets` | :1048-1080 | no orgRef; `scaleInAt` is the only event timestamp; `netKg`; `verificationStatus` unverified/needs_review/verified/rejected; **no cost column, no scale-out/turnaround**. Writers: facility portal (`commercialRouter.ts:159`), assistant commit |
| `facilities` :242-296 + `facilityCapabilities` :8499, `facilityOperatingHours` :8570, `facilityCallAheads` :8584, `facilityWaitReports` :8601, `loadFacilityAssessments` :8541 | `status` unknown/open/closed; `lifecycle`; call-ahead outcome incl. refused; self-reported `waitMinutes` | READY for facility usage counts, PARTIAL for wait |
| `facilityStatementLines` | :8412 | `amountCents` — **the only disposal cost evidence**; `matchOutcome` | PARTIAL (only where a statement was imported) |
| `manifests` :442 / `manifestCustodyEvents` :493 | `arrived_facility`, `accepted_by_facility`, `rejected_by_facility`, `unloaded` with `occurredAt` | READY for turnaround and rejections where custody is recorded |
| Distance to facility | `facilityDirectoryRouter.ts:302,475` | straight-line haversine only; no route km per trip leg persisted (`routeApprovals` has no km; recomputable from `roadGraphEdges.lengthMetres`) |
| `disposalReconciliation.ts` (`reconcileDisposal`, `summariseJobDisposals`, `completenessPercent`) | pure, **unwired** | reusable in Phase 1 as a resolver |

### 1.9 Billing / invoicing, expenses, fuel, other cost sources

| Source | Where | Notes |
|---|---|---|
| Money rule | `_core/money.ts`; `zzMoneyPrecision.test.ts:16-48` | integer cents canonical; 30 grandfathered doubles each with a `…Cents`/`…Millis` shadow kept by trigger; **analytics reads the shadow** (`gstRouter.ts:45` pattern). Legacy `billingRateCards` / `jobChargeLines` (:789, :803) are whole dollars — ignore |
| `invoices` :1299 / `invoiceLines` :6057 | `status` draft/sent/viewed/approved/disputed/partially_paid/paid/void (finalize = `approved` + `issuedAt`, `invoicingRouter.ts:208`; customer acceptance only in `acceptedAt`); lines carry `serviceCode`, `amountCents`, `fieldTicketLineId` → `fieldTicketLines` → `fieldTickets.{unitId, operatorId, loadId, tripId}` — **unit/driver/load revenue is derivable by evidence link** even though `profitability.ts` declares it not |
| **Four revenue definitions** | `commercialOfficeRouter.ts:699` (subtotal, not draft/void, by `issuedAt`); `projectRouter.ts:158` (total incl. tax, all-time); `gstRouter.ts:39` (subtotal, anything but void incl. drafts); `:529` GL readiness | none nets approved `customerCredits` |
| AR | `_core/accountsReceivable.ts:18` (pure): balance = total − allocations − approved credits; buckets current/31-60/61-90/90+/disputed from `dueAt ?? issuedAt` | READY (`ar.read`) |
| Estimated revenue | `quotes.subtotalCents` :5371, `changeOrders.estimatedCents`, `projectBudgets.totalCents` :5453, `pricingDecisions` `job_estimate` :6010 | inputs only; nothing multiplies a rate card by expected loads |
| `expenseRecords` :3200 / `expenseAllocations` :3245 | `total/totalCents`, `jobId/unitId/operatorId` (operator never set); allocations only ever `business`/`personal` (`expenseTreatment.ts:205`) with job/unit stamped on **both** halves (`payrollRouter.ts:678-685`); `expenseCategories` unused; **`personalTaxDocuments` must be excluded** | PARTIAL (filter `allocationType = business`) |
| `fuelTransactions` :3825 | `unitId/trailerId/equipmentId/jobId/tripId/operatorId`, litres, `totalCents`, `odometerKm`, `engineHours`, `status`, `financialTreatment`; anomalies computed at read (`bulkFuel.ts:127`). **Bulk dispenses write `totalCents: 0`** (`fuelOpsRouter.ts:60`) — the litres reach the unit, the dollars stay on the tank purchase |
| IFTA `jurisdictionDistanceRecords` :4477 | `unitId`, `distanceKm`, jurisdiction, period, `source`, `verificationStatus`; scoped by `financialEntityId` | READY as a verified-km denominator |
| `vendorBills` :3952 | header `unitId`, `jobId`, `workOrderId`, `roadsideEventId`, `codingCategory`, cents; lines carry no attribution | READY for unit/job cost where coded |
| `contractorPayables` :7894 | `chainRef`, payer/payee `orgRef`, state prepared…paid (never posted/paid by code) | PARTIAL |
| Labour | `payrollTimeEntries` :3315 (minutes, activity, `jobId/tripId/unitId`, status); `payRates` `rateMillis`; `payrollEarningEvents` :3349 (no job/unit/work date); **pay-run lines are never produced** | estimate only (minutes × rate in force) |
| Depreciation | `ccaSchedules` (tax CCA, rate unverified → UNKNOWN) | **none** (no book depreciation) |
| P&L | `_core/profitability.ts` + `commercialOffice.profitability.byDimension` (`commercialOfficeRouter.ts:689-727`, `commercial.read`) | defects: payables query cross-tenant (:704); paid payables drop out; no fuel/expense/labour; unit/driver/load verdicts too cautious; margin under `commercial.read` while `marginSimulate` needs `commercial.margin.view` |
| Periods | `periodCloses` :4616 (`YYYY-MM`, UTC month); `assertPeriodOpen` guards only some writers | period-close awareness must be a metric flag, not a lock |
| GL dimension | `commercialGlAccounts` :8463 (revenue/cost_of_sales/expense/…), `commercialGlMappings` :8474 (`service_code`, `coding_category`); `commercialCategoryTypes` :8360 (`profitability_dimension` seeded client/job/load/unit/driver/branch/contractor) | **reuse as the category dimension; nothing seeded yet** |

### 1.10 HOS

| Source | Where | Notes |
|---|---|---|
| `dutyRecords` | :649 | `operatorId`, `tripId`, `dutyStatus` driving/on_duty/sleeper_berth/off_duty, `startedAt/endedAt`, `durationMinutes`, `source`; no org, no certification/signature |
| `_core/hos.ts` | `computeClocks` :287 (16 elapsed clocks, rolling 24 h, gaps counted as neither duty nor rest), `determine` :391 (within/exceeded/unknown; remaining only when profile **and** limit verified), `tripFeasibility` :470 | READY for elapsed hours; **UNKNOWN for remaining/violation until P9** |
| `hosClockPresentation.ts` | CONFIRMED_ELAPSED / UNVERIFIED_ELAPSED / UNKNOWN; `FORBIDDEN_LABELS` (:76) | analytics inherits the ban |
| `hosRuleProfiles` :6593 / `hosRuleLimits` :6619 / history :8070 | all seeds unverified | — |
| `hosAttestations` :8717 | `orgRef`, `operatorId`, `dutyDate`, method | READY (paper-log attestation count) |
| `hos.status` | `hosRouter.ts:374`, `hos.read`, 16-day lookback | **not self-scoped**; cycle windows fixed 7/14 |
| Missing logs / signatures / stored violations | — | **none of these concepts exist**; `dailyLogs` is dead |
| Dispatch readiness | `readinessComposer.ts:833,920` | hard-codes `hoursAvailableMinutes: null` → `hos_unknown` or `hos_attested` |

### 1.11 Compliance, safety paperwork, incidents, enforcement

| Source | Where | Notes |
|---|---|---|
| Readiness reason codes | `_core/dispatchReadiness.ts:163-480`, `readinessComposer.ts` | `operator_<credential>_{missing|unknown|expired}`, `truck_/trailer_{inspection|registration|insurance}_*`, `critical_defect`, `mechanic_release_missing`, `maintenance_overdue`, `hos_*`, `tdg_document_*`, `documents_missing`, `permit_*`, `destination_*`, `route_*`, `academy_*`, `medical_fitness_*`, `insurance_*`, `roadside_event_open`, `fault_<code>_*`, `enforcement_*`, `communication_*`, `capability_not_evaluated_<cap>`. Hard-coded: `requiredDocumentsPresent` true whenever the job exists, `permitRequired` false, `tdgDocumentPrepared`/`emergencyPlanOnFile` null (`readinessComposer.ts:660-669`) — **"missing job documentation" is not really evaluated** |
| `complianceFinding.ts` | result SATISFIED/UNSATISFIED/UNKNOWN/NOT_APPLICABLE; effect BLOCK/WARN/INFORMATIONAL/NONE; `CLASSIFICATION_VERSION = "c1a.2"` | the finding vocabulary to reuse |
| `exceptionCentre.ts` | categories critical/dispatch/billing/purchasing/workforce/fleet/finance/ai/sync/devices/calibration/insurance/compliance; severity critical/high/medium/low; derived, never stored; **no safety category**; sources unscoped | pattern to reuse, scope to fix |
| `safetyEvents` :94 | `severity`, `status` **always open** (nothing resolves) | PARTIAL |
| `incidentReports` :2918 / `nearMissReports` :2995 | `escalationState` captured→…→closed (nothing sets `corrective_action`/`closed`); `incidentActions` :2982 and `incidentPeople` **dead**; no list procedure | PARTIAL (counts and trends by `occurredAt`, severity, type) |
| `tailgateMeetings` :735, `complianceArtifacts` :717 | job-scoped | READY (counts) |
| Restricted vault | `incidentMatters` :8736, `restrictedAccessEvents` :8785 | **never count or reveal restricted matters outside the vault** |
| `securityIncidents` :8130 | `orgRef` NOT NULL; obligations | READY under `incident.read_summary` |
| Enforcement | `enforcementEvents` :6721 (`inspectionResult`, `tenantId/branchId` snapshots), `enforcementViolations` :6752, `enforcementCitations` :6772 (never advance past `scanned`), `outOfServiceOrders` :6788 | READY for roadside outcome counts (no list procedure exists) |
| `dispatchEligibilityChecks` | :2017 | the persisted compliance verdict history |

### 1.12 Permits, licences, insurance, registration, document expiry

Permits, licences, registration and CVIP are all `complianceDocuments` rows by `docType`; **no
permit table exists** (readiness hard-codes `permitRequired: false`). Insurance:
`insurancePolicies` :4325 (scoped by `financialEntityId`), `insuranceCoveredEntities`,
`insuranceCertificates`, `insuranceRequirements`; `insuranceRisk.ts` `assessCoverage` (:50) and
`renewalCalendar` (:126, buckets expired/7/14/30/60/90). Trailer/equipment documents cannot be
created through `documents.create` (accepts operator/unit/job only, `routers.ts:1524`).

### 1.13 Map / routing activity

`routeRequests` :5901 and `routeApprovals` :6238 carry no km; `communicationPlans.totalKm`
:6489 does; `trips.distanceKm` is odometer-derived; `jurisdictionDistanceRecords` is the verified
per-unit km source; GPS breadcrumbs exist only for the caller's own active trip. No GPS-derived
distance, driving or idle time exists.

### 1.14 Audit events

| Log | Where | Org column |
|---|---|---|
| `authorizationDecisions` | :3104 | no |
| `evidenceAccessEvents` (viewed/downloaded/exported/shared/printed/seal_verified) | :3041 | no |
| `externalAccessLog` | :5082 | no |
| `auditPackages` / `auditPackageAccess` (purpose required) | :5800-5850 | no |
| `restrictedAccessEvents` (written **before** content is served) | :8785 | **yes** |
| `videoAccessLog`, `communicationPackageDownloads`, `dispatchAuditEvents`, `recordAmendments`, `academyAuditEvents` (hash-chained) | various | no |
| `domainEventOutbox` | :2316 | `tenantId` + `branchId`; only enforcement writes it |

There is no generic "who viewed or exported which report" log. Existing export precedents:
ticket/completion/invoice PDFs stored as `fieldTicketDocuments` with `generatedByUserId`,
`generatedAt`, `contentHash`, `sourceSnapshotHash` (`closeoutRouter.ts:354,511`,
`invoicingRouter.ts:68`); one CSV export (`facilityDirectory.exportCsv`, `_core/facilityExport.ts`);
`payroll.export` is a stub; `records.evidence.export` writes audit rows and no file.

### 1.15 Offline synchronization status

`syncPackages` :2864 (`state`, `queuedAt`, `serverReceivedAt`, `hashVerifiedAt`;
`officeAcceptedAt` never set; `operatorId` always null), `syncConflicts` :4086, `fieldDevices`
:4035 (`orgRef`, `status`, `lastSeenAt` updated only on an admitted package). **No "last synced
at" column, no server view of captures still on a device, no per-device status procedure.**
Client: `client/src/runtime/outbox.ts` `status()` and `portal/viewModels.ts:163` `syncIndicator`;
the `syncStatus` widget is device-local by design (`widgetSources.ts:171`).

### 1.16 Existing dashboard, widget, surface and report infrastructure

| Piece | Where | State |
|---|---|---|
| Widget board | `server/widgetsRouter.ts` (`widgets.offerable/boardResolve/layoutSave` under `myday.read_own`), `server/widgetSources.ts:65` (`widgetReaderFor` calls each tile's **own procedure** via `appRouter.createCaller` as the acting user), `_core/widgetPayload.ts` (`ok/stale/unknown/blocked/offline/not_permitted/failed` + `Provenance` + `deepLink`), `_core/widgetRegistry.ts` (12 keys, 9 variants incl. `kpi`), `widgetLayouts`/`widgetLayoutItems` :8203-8230 (`orgRef`, `userId`, `roleKey`, `deviceClass`, `revision`, options JSON), client `client/src/widgets/*` at `/widgets` | working machinery; `docs/b28/WIDGET_SOURCE_MATRIX.md` says PRODUCTION: 0; three tiles pass `userId` as `operatorId` |
| Surfaces | `surfaces.exceptions/inbox/myDay/search/chain/timeline` | exceptions summary (total, bySeverity, byCategory) is the only existing KPI-like aggregate; timeline omits stops, ticket events, signatures, custody, dispatch events, delays, duty records |
| Aggregations on read | AR/AP aging, `profitability.byDimension`, `glExportReadiness`, `periodClose` readiness counts, `portal.dailyReport` (estimated value explicitly `not_computed`), `project.forecast`, `asset.twin`, `shop.unitCost`, `iftaEngine` per-unit km/litres, `crews.forecast` | all single-entity or single-dimension, computed on request, none period-filtered except IFTA/GST |
| Materialized read models, caches, schedulers | — | **none.** Only background process is the outbox drain worker (`_core/productionWorker.ts`); `feedScheduler.ts`/`heartbeat.ts` unwired; no `/api/scheduled` route |
| Saved views / report definitions | — | none (`widgetLayouts` is the only per-user saved layout) |
| PDF | `_core/ticketPdf.ts` deterministic text-line PDF + `storagePut` + hash | reusable |
| Client product analytics | `client/src/lib/analytics.ts` | an optional Umami beacon, off by default — not business analytics |

### 1.17 AI secretary

`assistant.ask` returns quoted `knowledgePassages` only (no model, no operational record
resolver); `agentRouter.ts` has six read-level `CapabilityDefinition`s and executes nothing;
`SECRETARY_TOOLS` (tool key → `ProcedureName`, user-scoped `createCaller`) is PR #7 and not in
this tree (`docs/register/AI_RUNTIME_TERMINOLOGY.md` §2.4). Guardrails to plug into:
`evidenceGrounding.ts`, `aiProposal.detectOverreach` (:686), `knowledge/admission.ts`
`FORBIDDEN_AI_OUTCOMES`, `secretaryCoordination` `Observation {finding, source, urgency}`,
`contextAdmission` `TenantProof`. The widget reader (`widgetSources.ts:65`) is the working precedent
for "the AI calls the same canonical procedure as the UI".

---

## 2. Existing schemas and services that can be reused

**Nothing in this list needs to be rewritten; the analytics layer should call it.**

### 2.1 Authorization and scope (reuse as-is)
- `roleProcedure(name)` (`server/_core/trpc.ts:71`): per-call audit row, fail-closed audit for
  `SENSITIVE_PERMISSIONS`, `ctx.roles`. Every analytics procedure is a `roleProcedure`.
- `resolveActingScope(db, userId)` → `{tenantId, derivedFrom, branchRefs, global}`. Every
  analytics resolver takes the scope as an argument, never from input.
- Per-table scope: `orgScopeWhere` (jobs, trips, manifests, facilities, customerAccounts,
  applicants, securityIncidents, dispatchEligibilityChecks), `ownershipScopeWhere` /
  `unitInScope` / `operatorInScope` (units, operators, loads and everything keyed to them),
  `entityIdsInScope` (invoices, fuel, expenses, vendor bills, payroll, IFTA, insurance, capital
  assets, period closes), `tenantId` equality (operationalTasks, workflowNotifications,
  enforcementEvents, outOfServiceOrders, leaveRequests, shiftPosts, crews, workerQualifications),
  `jobScopeSubquery` / `tripScopeSubquery` (dispatchPostings, dispatchRoles, fieldTickets,
  disposalTickets, delayEvents, safetyEvents, tailgateMeetings).
- `authorize()` + the `visibleTo` / `requiredPermission` pattern of `exceptionCentre.ts`: each
  item (here: each metric) names the permission it needs, and the feed is filtered to what the
  caller may see.
- `authorizeRecordScope` (:2088) for own-operator / own-user self-scoping.

### 2.2 Presentation and honesty contracts (reuse as-is)
- `_core/widgetPayload.ts`: `WidgetState`, `Provenance`, `ValueSource`, `freshness()`,
  `isConfirmed()`, `deepLink`. A metric result is a `WidgetPayload`-shaped value.
- `computed | partial | unknown` + `unknowns: string[]` (`capitalAssets.ts:34,66,117`,
  `commercialProjects.ts:45`, `iftaReturns.taxDetermination`, `gst` determination).
- `interEngineStatus.ts` `PASS | REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED` with
  `NotEvaluatedReason`; `compliancePassport` `ready | review | blocked | unknown`;
  `complianceFinding.ts` result/effect; `dispatchReadiness` verdict; `documentValidity`
  `in_force | expiring | expired | unverified | rejected | none`.
- `hosClockPresentation.presentClock` and `FORBIDDEN_LABELS`.
- `safetyBinder.ts:99` "N of M verified, denominator always shown".
- `calendarProjection.ts:69` "every event must carry `generatedBy`" — the precedent for
  generated-by metadata on reports.

### 2.3 Pure aggregation engines already written (call, do not copy)
| Engine | Use in analytics |
|---|---|
| `exceptionCentre.deriveExceptions` / `summarize` | compliance-risk and "attention needed" counts, once the sources are scoped |
| `accountsReceivable.aging` / `invoiceBalanceCents` | outstanding invoices |
| `profitability.finish` / `derivability` | revenue vs cost by job / client / contractor (after the two bugs are fixed in place) |
| `capitalAssets.assetTwin`, `fleetShop.workOrderCost` / `tireRun` / `stockPositions` | unit cost, maintenance cost |
| `commercialProjects.projectForecast` | budget vs billed vs collected per job |
| `rateResolution.simulateMargin` / `poExposure` | margin band, PO exposure |
| `iftaEngine.buildIftaQuarter` (`UnitLine`) | verified km and litres per unit per quarter |
| `bulkFuel.fuelAnomalies` / `reconcileTank` | fuel anomalies, tank variance |
| `hos.computeClocks` / `determine`, `hosClockPresentation` | driving / on-duty elapsed hours |
| `compliancePassport.buildPassport` / `composeJobPassport` | driver and job compliance state |
| `documentValidity.validityOf`, `complianceDocumentValidity.documentExpiry`, `qualificationValidity.countsAsHeld`, `insuranceRisk.renewalCalendar` | expiring certificates, permits, insurance |
| `readinessComposer.composeReadiness`, `readinessCapabilities` | "why can't this unit leave" drill-down; unit readiness |
| `siteCloseout.closeoutState` / `composeSiteSnapshot` / `whyTheseHours` | paperwork completeness, billing readiness, on-site hours |
| `customerProjections.operationalState`, `portal.dailyReport` logic | customer-facing operational counts |
| `disposalReconciliation.reconcileDisposal` / `summariseJobDisposals` / `completenessPercent` (unwired) | disposal-document completion |
| `crewCoverage.qualifiedForecast` / `coverageWarnings` | available drivers by day |
| `enforcement.consequencesOf` / `enforcementReadiness` | roadside outcomes, active OOS |
| `periodClose.closeReadiness` | period-close flag on financial metrics |
| `surfacesService.loadTimeline` (+ the omitted sources) | operational timeline |

### 2.4 Storage and export precedents
- Widget board (`widgetsRouter.ts`, `widgetSources.ts`, `widgetRegistry.ts`, client
  `WidgetBoard`) with `kpi` / `list` / `detail` / `timeline` variants: executive and portal tiles
  should be **widget sources**, not a second dashboard framework.
- `widgetLayouts` / `widgetLayoutItems` (org + user + role scoped): the saved-layout storage.
- `fieldTicketDocuments` pattern (`generatedByUserId`, `generatedAt`, `contentHash`,
  `sourceSnapshotHash`) and `restrictedAccessEvents` (written before serving, `orgRef`):
  the audit shape for report runs and exports.
- `ticketPdf.renderPdf` + `storagePut`; `facilityExport.toCsv`.
- `domainEventOutbox` + `productionWorker` drain loop: the only home for any future incremental
  projection; not needed for Phase 1.
- `commercialGlAccounts` / `commercialGlMappings` / `commercialCategoryTypes`: the category
  and dimension catalogue.
- `assistantCommitAdapters` `utcOffsetMinutes` (required, never guessed): the timezone contract.

---

## 3. Missing dependencies

Grouped by whether analytics can proceed without them (**A**: proceed, report unknown),
whether the authoritative system must be fixed first (**B**: prerequisite fix in the owning
subsystem, not in analytics), or whether a person or another category must decide (**C**).

### 3.1 Tenancy and authorization
- **B** Exception-centre, search, timeline and audit-package sources are unscoped; analytics must
  scope its own reads and should not call `loadExceptionSources()` until it takes a scope.
- **B** Ownership row missing for drivers hired through `workforce.applicantDecide`.
- **C** No organization-scoped role grants, no organization selector, no platform-admin
  cross-organization read path (`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md`). Platform-level
  analytics is **out of scope until that lands**; the survey proposes reserving the permission name
  only.
- **C** No branch table or branch column on jobs/units/trips/invoices → branch comparison is
  `not_derivable` (Administration & Company Configuration Center).

### 3.2 Fleet
- **B** `shop.workOrderAdvance` must stamp `startedAt` / `completedAt` (otherwise repair duration
  and downtime are wrong for every advance-closed work order).
- **A** No downtime ledger / unit status history: "units currently down" is derivable now from
  the union in §1.6; "downtime duration" is `partial` (work orders, OOS orders, roadside events,
  breakdown delays) and "scheduled vs unscheduled" is `not_derivable`.
- **C** No asset-type catalog (`vehicleType` free text) → utilization by unit type groups on the
  free text and says so; a catalog belongs to the Administration Center.
- **A** No engine-hour / PTO meter series: `telemetrySnapshots` deltas where a feed exists,
  `workOrders.engineHours` as a last-known reading, else unknown.
- **A** Labour rate for work-order cost: `chargeDefinitions.rateKind = internal_cost` exists and is
  unread; analytics should read it and report `unknown` when absent, rather than take a
  caller-supplied rate.
- **A** Bulk fuel dispenses carry `$0`: fuel spend per unit is `partial` wherever a unit fuels from
  a tank; the litres are still attributable.

### 3.3 Operations
- **A** `jobs` has no lifecycle timestamps and `status` never changes: "active job" and "jobs
  completed today" are computed from trips, field tickets, signatures and manifests, and the
  registry says which. A job-lifecycle fix belongs to the dispatch/job subsystem, not here.
- **A** `loads` has no writer: load counts come from `fieldTicketLines.lineKind = load`,
  `disposalTickets`, `manifests` and `tripStops.stopType = load`, each declared as the source.
- **A** Dispatch assignments carry no end time; "dispatched hours" is `partial` (trip
  start/complete where present).
- **A** Route km is not persisted; distance uses `trips.distanceKm` (odometer) or verified IFTA km.

### 3.4 Workforce and HOS
- **C** P9: HOS limits unverified → `hos_remaining`, `hos_exceptions`, "approaching HOS limit"
  read UNKNOWN with the rung that stopped them. Elapsed driving / on-duty hours are computable.
- **A** No canonical "active driver": the registry defines it explicitly (§7) from
  `organizationWorkers`/memberships/payroll status and says which source answered.
- **A** Overtime is not modelled anywhere → `not_derivable` until a pay rule (verified) defines it.
- **A** Missing logs / missing signatures on HOS: not modelled; `dailyLogs` is dead.
- **B** `hos.status`, `dutyRecords.list`, `compliance.passport` and `readiness.forTime` accept any
  operator; the driver self-view in analytics must not reuse them unscoped.

### 3.5 Finance
- **B** `profitability.byDimension` cross-tenant payables query and dropped `paid` payables.
- **B** Revenue definition unified in one place (the registry) and the four callers pointed at it
  (a later, separate change to the owning routers).
- **A** No depreciation; CCA is UNKNOWN → "cost per truck" is `partial` and lists depreciation
  under `unknowns`.
- **A** Labour cost is estimate-only (time entries × rate in force) and must be labelled
  `estimated`.
- **A** Expense allocation to job/unit is only via `expenseRecords.jobId/unitId` (business half).

### 3.6 Compliance and safety
- **A** No GREEN/AMBER/RED scheme exists: defined in §5.6 as a presentation mapping over existing
  verdicts, never a stored score.
- **A** `incidentActions` (corrective actions) is dead → "corrective actions outstanding" is
  `not_derivable`; incident counts and trends are computable.
- **A** Job-level "missing required documents" is hard-coded true in readiness → analytics reports
  it as `NOT_EVALUATED(no_data_source_loaded)` rather than "0 missing".
- **B** Expiry thresholds live in four places; the registry adopts `warnDaysBeforeExpiry` /
  `documentValidity` (30 days) and the insurance buckets, and names them.

### 3.7 Time
- **C** No organization timezone. Analytics takes an explicit `zone` (IANA) or `utcOffsetMinutes`
  per request, defaults to UTC, and **returns the zone it used in every response**. An
  organization default timezone belongs to the Administration Center.
- **A** "Current shift": `shiftReadiness.ts` uses explicit timestamps; there is no shift
  calendar. `current_shift` range is `not_derivable` until shifts exist as records; Phase 1 offers
  `today`, `yesterday`, `7d`, `30d`, `mtd`, `qtd`, `ytd`, `custom`.

### 3.8 Reporting infrastructure
- **A** No report definitions, saved views, scheduler, CSV/PDF framework, or report-run audit.
  One new table (`analyticsReportRuns`) is proposed (§8); everything else is code.

### 3.9 Offline / mobile
- **A** No server-side per-device sync status; the mobile summary reuses the device-local outbox
  status and the server's `fieldDevices.lastSeenAt`, labelled as such.

### 3.10 AI
- **C** `SECRETARY_TOOLS` / record-data resolver are not in this tree (PR #7). Analytics exposes
  procedures now; the AI binding is a later checkpoint.

---

## 4. Contradictions with the proposal

| # | Proposal says | The tree says | Resolution proposed |
|---|---|---|---|
| C1 | "Every analytics query must be organization-scoped" | Isolation is not a system property; scope is per table via four different mechanisms; ~334 tables carry no org column | Analytics inherits every existing scope helper per source table and **states `scope.derivedFrom`** in each response (`membership` vs `single_tenant_fallback`). Any table with no helper is not read. |
| C2 | Platform administrator may view platform-level information | No cross-organization read path, no org-scoped roles, multi-org users are refused | Reserve the name `analytics.platform.read`; **do not map it** until PORTAL_ORG_SCOPE lands (an unmapped permission with no holder would fail `recordsAuthorization.test.ts:295`). |
| C3 | Branch → branch comparison | No branch entity or column on operational records | `branch` filter returns `not_derivable` with the reason; unblock in the Administration Center. |
| C4 | "Fleet utilization = 71%" and percentage KPIs | Compliance design forbids percentage scores; `safetyBinder` shows "7 of 9"; `hosClockPresentation` bans "remaining"/"compliant" | Ratios are allowed **only** when numerator and denominator are both `computed` and both shown, and never for compliance or safety. Unknown rows never enter the denominator. |
| C5 | GREEN / AMBER / RED / UNKNOWN categories | No colour vocabulary exists; there are five four-state vocabularies | Colours are a presentation label over the source verdict (§5.6); the payload carries the source verdict and reason; no stored colour. |
| C6 | HOS remaining, approaching limit, violations, missing logs | P9: every HOS figure unverified; `hos.status` withholds the compliance answer; no violation or log record exists | Registry ships `hos_elapsed_*` (computed) and `hos_remaining_*` / `hos_exceptions` as UNKNOWN naming the unverified rung; attestation counts are computable. |
| C7 | "Do not silently convert missing records to zero" | `project.forecast` "budget and variance are zero by absence" (`projectRouter.ts:161`); `dailyReport` estimated value `not_computed` | Registry rule: every metric returns `determination` and a `denominator`; absence produces `unknown`, and a zero is only ever a counted zero. |
| C8 | Cost per load, per job, per hour, per km | Load has no writer; labour is estimate-only; bulk fuel is $0; depreciation absent; unit revenue "not derivable" in `profitability.ts` though the ticket link exists | Cost metrics carry `actual` / `estimated` / `unallocated` / `missing` buckets (§5.5); unit/driver/load revenue is derived via `invoiceLines → fieldTicketLines → fieldTickets` and the derivability table is corrected in place. |
| C9 | Executive dashboard "revenue" | Four definitions in four routers | One `revenue_recognized` metric (issued, not draft/void, subtotal ex-tax, net of approved credits, by `issuedAt`) and one `revenue_billed_gross`; the four callers migrate to it later. |
| C10 | "Current shift" range | No shift calendar; shift start is an explicit timestamp | Deferred; ranges limited to calendar ranges in the stated zone. |
| C11 | Driver analytics incl. "safety events where appropriate" | Repo decisions: "nothing per driver is summed", "no driver score" (`telematics.ts:53`, `integrationGateway.ts:88`, `dispatchMatching.ts:9-15`) | Driver metrics are counts of the driver's own records with formula and drill-down; **no ranking, no composite, no per-driver driving-event totals**; sensitive safety records only under their existing sensitive permissions. |
| C12 | "Create a metric registry / new services" | SPINE moratorium: no new engines until the spine is wired; every new `_core` file must be reached or declared | The registry and resolvers are "a router over something already written" for every metric that calls an existing engine. Metrics that need new arithmetic (utilization, downtime union) are new logic: **the owner must record an explicit exception in `docs/register/SPINE_WIRING_PLAN.md` or `docs/register/ROADMAP_2026-09-21.md` before Checkpoint B**, or those metrics wait. |
| C13 | Mobile "driver HOS state" | The `hosRemaining` tile is device-local by the engine's plan; server `hos.status` is unscoped | Mobile summary shows elapsed clocks with CONFIRMED/UNVERIFIED/UNKNOWN and `LAST UPDATED`, sourced from the device-local engine, never a server "remaining". |
| C14 | Adding `tenantId` to new tables | `tenantIsolation.test.ts` pins exactly 19 `tenantId` tables | New analytics tables use `orgRef` (nullable, NULL = historical single tenant), matching `restrictedAccessEvents`. |
| C15 | Adding permissions / procedures | Counts are pinned: 634 operational mappings, `OPERATIONAL_SOURCES`, inventory, current-state doc | Every checkpoint that adds a procedure updates the pins, `PROCEDURE_AUTHORIZATION_INVENTORY.md`, and regenerates `LEASEOS_CURRENT_STATE.md` in the same commit. |

---

## 5. Recommended architecture

```
authoritative tables ──► existing scope helpers ──► existing pure engines
        │                         │                        │
        └──────────────► METRIC REGISTRY (code, versioned) ◄┘
                          id · formula · sources · unit · permission · filters ·
                          refresh · incompleteness rule · drilldown procedure
                                     │
               ┌─────────────────────┼──────────────────────┐
               ▼                     ▼                      ▼
     analytics.metric.*     analytics.report.*       widget sources
     (value + drilldown)    (run · export · audit)   (executive / portal tiles)
               │                     │                      │
               ▼                     ▼                      ▼
     dashboards (client)     CSV / PDF (server)      Field Mobile summaries
                                     │
                              analyticsReportRuns (audit row)
```

### 5.1 Placement
- `server/analyticsRouter.ts` — the only new router; mounted as `analytics.*`; every procedure a
  `roleProcedure`; added to `OPERATIONAL_SOURCES`.
- `server/_core/analytics/` — `metricRegistry.ts` (the catalogue and `METRIC_REGISTRY_VERSION`),
  `metricResolvers.ts` (one resolver per metric, each taking `{db, scope, range, filters}`),
  `ranges.ts` (range → `[from, to)` in the stated zone), `reportRegistry.ts`,
  `reportRunner.ts` (rows + CSV + PDF via `ticketPdf`), `dataQuality.ts` (determination and
  denominator rules). Every file is imported by the router, so `engineReachability` is satisfied.
- No new engine duplicates an existing one: a resolver that needs AR calls
  `accountsReceivable.aging`; one that needs a passport calls `buildPassport`; and so on (§2.3).

### 5.2 The metric contract (server-side, never client-computed)
```ts
type MetricResult = {
  metricId: string; version: string;          // registry id + METRIC_REGISTRY_VERSION
  scope: { tenantId: string; derivedFrom: "membership" | "single_tenant_fallback" };
  range: { from: Date; to: Date; zone: string; label: RangeLabel };
  filters: Record<string, string | number>;   // echoed back exactly
  value: number | null;                       // null unless determination !== "unknown"
  unit: "count" | "cents" | "minutes" | "hours" | "km" | "litres" | "kg" | "m3" | "ratio";
  numerator?: { value: number; of: string }; denominator?: { value: number; of: string };
  determination: "computed" | "partial" | "unknown" | "not_derivable" | "not_evaluated";
  unknowns: string[];                         // every reason, named
  state: WidgetState;                         // ok | stale | unknown | blocked | not_permitted | failed
  provenance: Provenance;                     // source, verification, observedAt (= computedAt)
  buckets?: Record<"actual" | "estimated" | "unallocated" | "missing", number>;  // cost metrics
  drilldown: { procedure: ProcedureName; input: unknown };  // returns exactly the qualifying rows
};
```
Invariant: `analytics.metric.drilldown(metricId, range, filters)` returns the rows whose count
(or sum) **is** `value`, computed by the same resolver in the same transaction; a test asserts it
for every registered metric (§9).

### 5.3 Ranges and time
`today | yesterday | 7d | 30d | mtd | qtd | ytd | custom`, resolved server-side in the request's
`zone` (IANA name, validated with `Intl.DateTimeFormat`) or `utcOffsetMinutes`; default `UTC`;
the response echoes the zone. `current_shift` is not offered (C10). Fiscal quarter/year use
`financialEntities.fiscalYearEndMonth/Day` when a financial entity is in scope, otherwise
calendar, and the response says which.

### 5.4 Refresh and caching
Phase 1 computes on request, like every existing aggregate. `provenance.observedAt` is the
computation time; the widget freshness budget marks `stale`. No materialized rollups until a metric
is measured to be slow on real volumes; if one is, the projection lives on the outbox drain
worker, not a new scheduler.

### 5.5 Cost model
Every cost metric sums into four named buckets and reports each: `actual` (cents from a posted
or approved record: vendor bills, fuel card transactions, parts issued at cost, tires, claims,
citations), `estimated` (labour minutes × rate in force; internal labour rate from
`chargeDefinitions.internal_cost`), `unallocated` (cost rows in scope with no link to the
dimension asked for — e.g. fuel with a null unit), `missing` (named gaps: bulk fuel priced at $0,
depreciation absent, work orders with no cost). A new cost source is one more resolver
contributing to a bucket, not a rewrite.

### 5.6 Compliance colour mapping (presentation only)
| Label | Source verdicts it may display |
|---|---|
| GREEN | passport `ready`, readiness `eligible`, finding `SATISFIED`, validity `in_force`, `PASS` |
| AMBER | `review`, `eligible_review`, `WARN`, `expiring` (within the requirement's `warnDaysBeforeExpiry`), `needs_review` |
| RED | `blocked`, `BLOCK`, `expired`, `rejected`, active OOS, unresolved critical defect |
| UNKNOWN | `unknown`, `NOT_EVALUATED` (with its reason), `unverified` requirement, P9 |
Every RED/AMBER row carries the reason code (§1.11) and the drill-down deep link to the record.
No colour is stored; no colour is a score.

### 5.7 Drill-down chain (from the proposal's example)
`fleet_units_in_service` → `analytics.metric.drilldown` (units in scope with their per-unit
determination) → `readiness.forShift` / `asset.twin` / `surfaces.timeline(unit)` /
`shop.unitCost` / `records.maintenance.*` — all existing procedures, all already audited.

### 5.8 Reports
A report is a registry entry: `{key, title, version, columns, metricIds | rowResolver,
filters, requiredPermission, exportable}`. `analytics.report.run` returns rows plus the header
block (generated at, generated by, organization, filters, zone, definition version);
`analytics.report.export` (`csv` | `pdf`) writes an `analyticsReportRuns` row **before** serving
and returns a content hash — the `restrictedAccessEvents` order, the `fieldTicketDocuments`
shape. Saved views: Phase 3, one table (§8).

### 5.9 Widgets and mobile
Executive tiles register as widget sources whose reader calls `analytics.metric.get` through
`createCaller` (the tile's own permission gate). Field Mobile shows only self-scoped metrics
(`analytics.read_own`) and the device-local sync/HOS tiles; every mobile tile shows
`LAST UPDATED <observedAt>`; a payload older than its freshness budget renders `stale`, never
live.

### 5.10 AI
The future secretary calls `analytics.metric.get` / `analytics.report.run` through the same
`createCaller` path as widgets, cites the `MetricResult` as an `Observation` with its provenance,
and is bound by `detectOverreach` and `FORBIDDEN_AI_OUTCOMES`. It is never handed raw tables.

---

## 6. Proposed analytics permissions model

Three new permissions in the existing vocabulary, mapped explicitly in `GRANTS`; per-metric
gating reuses the **source's** existing read permission so no metric reveals more than its
underlying records do (the exception-centre pattern).

| Permission | Kind | Held by (proposed) | Purpose |
|---|---|---|---|
| `analytics.read` | ordinary | dispatcher, mechanic, shop_lead, safety, office, management, hr, bookkeeper, controller, external_accountant, auditor | may call `analytics.metric.*`, `analytics.dashboard.*`, `analytics.report.run`; sees only metrics whose `requiredPermission` they also hold |
| `analytics.read_own` | **universal** (`UNIVERSAL_PERMISSIONS`, count 13→14) | every recognised role | self-scoped metrics only (`subject = self`), resolved from `ctx.user.id` → operator via one shared `operatorForUser` (not the copies in five routers) |
| `analytics.export` | **sensitive** (`SENSITIVE_PERMISSIONS`, 125→126) | management, controller, bookkeeper, safety, auditor | CSV / PDF export; fail-closed audit; writes `analyticsReportRuns` |
| `analytics.platform.read` | **reserved, not mapped** | nobody | platform-level view; mapped only when organization-scoped roles exist (C2) |

Per-metric `requiredPermission` (existing names):

| Metric family | Gate |
|---|---|
| jobs / trips / loads / dispatch | `job.read`, `trip.read`, `dispatch.read` |
| fleet readiness, work orders, defects, downtime | `fleet.read`, `maintenance.read_defect`, `shop.read`, `telematics.read`, `enforcement.read` |
| driver counts, availability | `personnel.read`; own view via `analytics.read_own` |
| HOS elapsed / attestations | `hos.read` (own view self-scoped) |
| certificates, permits, insurance expiry | `compliance.read`, `compliance.passport.read`, `insurance.read_summary`; private detail never (`compliance.private.read` is not granted to analytics) |
| revenue, AR, unbilled, billing readiness | `invoicing.read`, `ar.read`, `closeout.read` |
| costs, margin, profitability | `commercial.read` for cost; **`commercial.margin.view` for any margin or profitability figure** (fixes the inconsistency in §1.9) |
| expenses / fuel | `tax.read_business`, `fuel.review` |
| safety counts | `incident.read_summary`; investigation detail never; restricted vault never |
| disposal | `manifest.read`, `facility.directory.read` |
| audit / report runs | `audit.package.read` (list of report runs) |

Portal boundaries the server enforces (never the UI):
- **Driver / worker_self_service**: `analytics.read_own` only; every self metric filters by the
  caller's operator id; a request naming another `operatorId` is refused as not found.
- **Dispatch**: `analytics.read` + `dispatch.read` / `job.read` / `trip.read`; no money metrics
  (no `invoicing.read`).
- **Safety**: + `incident.read_summary`, `compliance.read`, `hos.read`.
- **Mechanic / shop**: + `fleet.read`, `maintenance.read_defect`, `shop.read`; cost per unit
  in cents under `shop.read` (as `shop.unitCost` already is); no revenue.
- **Accounting / office**: + `invoicing.read`, `ar.read`, `tax.read_business`; margin only with
  `commercial.margin.view`.
- **Owner / management / executive**: `analytics.read` plus the union above; export.
- **Customer / consultant**: **no role procedure**; a later checkpoint may add one
  `externalProcedure` (`portal.customer.analytics`) scoped by `ctx.external.accountId`, bumping the
  pinned external count (36→37); Phase 1 relies on the existing `portal.jobBoard` /
  `portal.dailyReport`.
- **Auditor**: read and export, no write anywhere (already the role's shape).

`DENIALS` additions: `driver` denied `analytics.read` and `analytics.export` explicitly
(defence in depth beyond "not granted").

---

## 7. Proposed metric definitions (registry v1 candidates)

Every entry states: **source** (tables and the engine called), **formula**, **unit**,
**incompleteness rule**, and a **status** read from the tree — **COMPUTABLE** (all inputs exist
and are scoped), **PARTIAL** (computable with named unknowns), **UNKNOWN** (inputs exist but the
rule is unverified — P9), **NOT DERIVABLE** (no data; the metric is registered so it answers
honestly, not omitted). Supported filters for all: `range`, `zone`; per family as noted.
Permission per §6. Refresh: on request; freshness budget in seconds is the tile's.

Rule for every metric: a row whose determining field is NULL is counted in `unknowns`, never
in the denominator; `value` is `null` whenever `determination = unknown`.

### 7.1 Executive / operations
| id | source · formula | unit | status · incompleteness |
|---|---|---|---|
| `jobs_active` | `jobs` in `orgScopeWhere` with a trip in status loading/in_transit/unloading **or** `commercialJobChains.status = active`; `jobs.status` is not used (never updated) | count | COMPUTABLE; jobs with no trip and no chain listed under `unknowns` as "lifecycle not recorded" |
| `jobs_completed` | distinct `jobs` whose latest trip `completedAt` **or** field ticket `completedAt` falls in range (source named per row) | count | PARTIAL: jobs with neither timestamp are `unknowns` |
| `loads_completed` | `fieldTicketLines.lineKind = load` on tickets completed in range **plus** `manifests.closedAt` in range, de-duplicated by load/ticket line; `loads` table not used (no writer) | count | PARTIAL; states which source counted |
| `drivers_active` | operators in scope with (`organizationWorkers.status = active` driver-type **or** `employeePayrollProfiles.payrollStatus = active`) and no `offboardings` row with `lastDay <= to` | count | COMPUTABLE; operators with no worker/payroll row → `unknowns` |
| `drivers_dispatched_now` | distinct `trips.operatorId` in status loading/in_transit/unloading, plus `dispatchRoles.assignedOperatorId` with status assigned on postings whose job is in scope | count | COMPUTABLE |
| `drivers_available` | `crewCoverage.qualifiedForecast` for the day: crew members on rotation minus approved leave, minus `drivers_dispatched_now` | count | PARTIAL: drivers on no crew → `unknowns`; `operatorAvailability` is dead and not read |
| `units_in_service` | units in scope with no active OOS order (via `enforcementEvents.unitId`), no open critical defect without a standing release (`currentReleaseEvidenceFor`), no open roadside event, no acknowledged critical fault | count | COMPUTABLE (this is the `readinessComposer` unit half, reused) |
| `units_unavailable` | complement of the above, each with its blocker code | count | COMPUTABLE |
| `units_dispatched_now` | distinct `trips.unitId` active + `dispatchRoles.assignedUnitId` assigned | count | COMPUTABLE |
| `fleet_utilization_ratio` | numerator = Σ dispatched hours (`trips.startedAt→completedAt` clipped to range) per unit; denominator = Σ available hours = range hours − downtime hours (§7.3); ratio shown only with both terms | ratio | PARTIAL: units with no trips in range have numerator 0 (counted); units with `unknown` downtime excluded from the denominator and named |
| `revenue_recognized` | invoices via `entityIdsInScope`, status ∉ {draft, void}, `issuedAt` in range: Σ `subtotalCents` − Σ approved `customerCredits.amountCents` applied to those invoices | cents | COMPUTABLE; invoices with null `financialEntityId` under the default scope are counted and flagged `legacy_unowned` |
| `revenue_billed_gross` | same set, Σ `totalCents` (incl. tax) | cents | COMPUTABLE |
| `revenue_estimated_open_jobs` | Σ accepted `quotes.subtotalCents` + authorized `changeOrders.estimatedCents` for jobs in `jobs_active`; else `projectBudgets.totalCents` approved | cents | PARTIAL: jobs with no quote/budget → `unknowns` (never 0) |
| `ar_outstanding` | `accountsReceivable.aging` at `to` | cents by bucket | COMPUTABLE |
| `operating_cost` | Σ over cost resolvers (§7.4) in range, reported as `actual/estimated/unallocated/missing` | cents | PARTIAL by construction |
| `fuel_spend` | `fuelTransactions` (`entityIdsInScope`, status ∉ {rejected}, payer company) Σ `totalCents` by `occurredAt`; litres alongside | cents, litres | PARTIAL: bulk dispenses ($0) counted in `missing` with their litres |
| `maintenance_cost` | Σ `fleetShop.workOrderCost` (parts actual, labour estimated) for work orders with `openedAt` in range + vendor bills with `workOrderId` | cents | PARTIAL (labour rate from `chargeDefinitions.internal_cost` or unknown) |
| `downtime_hours` | §7.3 | hours | PARTIAL |
| `compliance_attention_count` | RED + AMBER rows of §7.6 | count | COMPUTABLE (UNKNOWN rows reported separately, never in the count) |

### 7.2 Driver / operator (all also available `subject = self`)
| id | source · formula | unit | status |
|---|---|---|---|
| `driver_hours_driving_elapsed` | `hos.computeClocks` over `dutyRecords` clipped to range: Σ driving minutes | minutes | COMPUTABLE, presented via `presentClock` (CONFIRMED/UNVERIFIED) |
| `driver_hours_on_duty_elapsed` | Σ on_duty + driving | minutes | COMPUTABLE |
| `driver_hours_worked` | `payrollTimeEntries` status ∈ {submitted, verified, approved} Σ `minutes` by `startedAt` (self-reported; labelled) | minutes | PARTIAL: `open`/`disputed` entries → `unknowns` |
| `driver_hos_remaining_*`, `driver_hos_exceptions` | `hos.determine` | minutes / count | **UNKNOWN until P9** — response names the unverified rung |
| `driver_hos_attested_days` | `hosAttestations` by `dutyDate` | count | COMPUTABLE |
| `driver_jobs_completed`, `driver_loads_completed` | `jobs_completed` / `loads_completed` filtered by `trips.operatorId` / `fieldTickets.operatorId` | count | PARTIAL (same rules) |
| `driver_avg_job_duration` | mean of `fieldTickets.completedAt − startedAt` where both set | minutes | PARTIAL |
| `driver_utilization_ratio` | dispatched hours ÷ on-duty elapsed hours, both shown | ratio | PARTIAL |
| `driver_overtime` | — | — | NOT DERIVABLE (no pay rule) |
| `driver_qualification_status` | `buildPassport` verdict + item statuses | enum | COMPUTABLE structurally; UNKNOWN where requirement seeds are unverified |
| `driver_certificates_expiring` | `documentValidity.validityOf` over the driver's `complianceDocuments` + `academyQualifications.expiresAt` + `trainingRecords.expiresAt`, window = `warnDaysBeforeExpiry` (default 30); `privateDetail` rows counted but never described | count | COMPUTABLE |
| `driver_inspections_completed` | `inspections` by `authenticatedOperatorId`, `observedAt` in range, by type/status | count | COMPUTABLE |
| `driver_paperwork_open` | field tickets where operator = driver and `closeoutState` ∉ {BILLING_READY, POST_SITE_COMPLETE}, with blockers | count | COMPUTABLE (per-ticket engine, batched) |
| `driver_paperwork_rejected` | ticket lines `disposition = disputed` + `signatureStatus = partially_accepted` + rejected portal submissions on the driver's tickets | count | COMPUTABLE |
| `driver_safety_events` | `safetyEvents`, `nearMissReports`, `incidentReports` **counts only**, under `incident.read_summary`; no driving-event totals; no ranking | count | COMPUTABLE, gated |

### 7.3 Fleet utilization, maintenance and downtime
| id | source · formula | unit | status |
|---|---|---|---|
| `unit_hours_dispatched` | Σ trip windows per unit clipped to range | hours | COMPUTABLE where trips have both timestamps |
| `unit_hours_driving` | `dutyRecords.dutyStatus = driving` joined via `tripId → trips.unitId` | hours | PARTIAL (duty records without trip → `unknowns`) |
| `unit_hours_on_location` | Σ `fieldTicketEvents` with clock ∈ {job, customer_billing} and eventType ∈ {site_work, standby, customer_hold, weather_hold}, else `tripStops` arrived→departed | hours | PARTIAL |
| `unit_hours_idle` | Σ `telemetrySnapshots.idleMinutes` deltas per unit | hours | PARTIAL: units with no feed → `unknowns` (never 0) |
| `unit_engine_hours` | last `telemetrySnapshots.engineHours` − first in range; fallback `workOrders.engineHours` last reading | hours | PARTIAL |
| `unit_km` | verified `jurisdictionDistanceRecords.distanceKm` in period; fallback Σ `trips.distanceKm` (odometer) | km | PARTIAL; source named |
| `downtime_hours` | union of intervals per unit clipped to range: `workOrders.openedAt→completedAt` (open WO → `to`), `outOfServiceOrders.issuedAt→releasedAt/rescindedAt`, `roadsideServiceEvents.occurredAt→closedAt`, `delayEvents(kind=breakdown).observedAt→endedAt`, open critical defect without release `reportedAt→resolvedAt`; overlapping intervals merged once | hours | PARTIAL: advance-closed work orders (no `completedAt`) → `unknowns` until fixed (§3.2) |
| `downtime_scheduled_vs_unscheduled` | — | — | NOT DERIVABLE (no PM concept) |
| `units_down_now` | units with any open interval above at `now` | count | COMPUTABLE |
| `work_orders_open`, `work_orders_overdue` | `workOrders.status ∉ {closed}`; overdue = — | count | open COMPUTABLE; **overdue NOT DERIVABLE** (no due date on work orders) |
| `defects_open`, `defects_critical_unreleased` | `maintenanceDefects.status ≠ resolved`; critical without `currentReleaseEvidenceFor` | count | COMPUTABLE |
| `defects_repeat` | same `unitId` + normalised `title` within 90 days | count | PARTIAL (heuristic; labelled; no linkage exists) |
| `maintenance_cost_per_unit` | `maintenance_cost` grouped by unit | cents | PARTIAL |
| `repair_duration_avg` | mean `completedAt − openedAt` over closed WOs with both | hours | PARTIAL |
| `mtbf_service_events` | mean gap between consecutive `workOrders.openedAt` per unit, ≥ 3 events | days | PARTIAL (units with < 3 events → not stated) |
| `units_approaching_maintenance` | — | — | NOT DERIVABLE (no thresholds/PM) |
| `inspections_outstanding` | units with no `pre_trip` inspection on a day they had an active trip; CVIP: `credentialState` of `cvip_certificate`/`annual_inspection` expiring/expired | count | PARTIAL |
| `unit_cost_total` | §7.4 grouped by unit; per km / per engine hour / per dispatched hour only when both terms computed | cents | PARTIAL |

### 7.4 Cost per unit / job / load / customer / project (resolvers → buckets)
| resolver | dimension links | bucket |
|---|---|---|
| `vendorBills.subtotalCents` (status approved…paid) | `unitId`, `jobId`, `workOrderId`, `roadsideEventId`; customer via job | actual |
| `fuelTransactions.totalCents` (company payer, ∉ rejected) | unit/trailer/equipment, job, trip, operator | actual; bulk ($0) → missing (litres reported) |
| `partMovements` issued × `unitCostCents` | unit, work order | actual; no-cost parts → missing (as `workOrderCost` already names) |
| `workOrders.laborMinutes` × internal rate | unit | estimated; no rate → missing |
| `tires` / `tireInstallations` (`tireRun`) | unit | actual |
| `expenseRecords.totalCents` (business allocation) | unit, job | actual (only `allocationType = business`) |
| `contractorPayables.grossAmountCents` (approved/posted/**paid**) | chain → job, crew → unit/driver | actual |
| `insuranceClaimCosts.amountCents` | via claim unit/job | actual |
| `enforcementCitations.fineAmountCents` | via event unit/operator | actual |
| depreciation / CCA | unit | **missing** (rate unverified) |
| labour from pay runs | — | not derivable (never produced) |
| **`cost_per_load`, `cost_per_job`, `cost_per_customer`, `cost_per_project`** | denominators from §7.1; project = `jobId` only (no project entity) | PARTIAL; unallocated bucket shown |

### 7.5 Financial / operations reporting
| id | source · formula | status |
|---|---|---|
| `revenue_by_customer / job / service_type / period` | `revenue_recognized` grouped by `invoices.customerAccountId` / `jobId` / `invoiceLines.serviceCode` (mapped through `commercialGlMappings` where seeded) / issued month | COMPUTABLE |
| `revenue_by_unit / driver` | `invoiceLines → fieldTicketLines → fieldTickets.unitId / operatorId` (evidence link); lines without a ticket line → `unallocated` | PARTIAL — corrects `profitability.ts` derivability |
| `job_profitability`, `unit_profitability` | revenue − cost buckets; `margin` only when cost `determination ≠ unknown`, else "margin cannot be stated" (`rateResolution.ts:179` wording) | PARTIAL; `commercial.margin.view` |
| `avg_revenue_per_load`, `avg_revenue_per_hour` | revenue ÷ `loads_completed` / ÷ `unit_hours_dispatched`, both shown | PARTIAL |
| `unbilled_work` | signed tickets (`signatureStatus ∈ {accepted, partially_accepted}`) with no `invoiceLines` reference and `closeoutState.invoiceReady = true`; Σ accepted line `pricingDecisions.amountCents` where priced | count, cents | PARTIAL (unpriced lines → `unknowns`) |
| `billing_paperwork_outstanding` | tickets `completedAt` set, no signature; post-site required without supplement | count | COMPUTABLE |
| `paperwork_rejected` | disputed lines, partially accepted signatures, rejected `portalSubmissions`, rejected disposal tickets | count | COMPUTABLE |
| `period_close_state` | `periodClose` latest action for the month | flag on every financial metric | COMPUTABLE |

### 7.6 Compliance risk (each row = one subject with reason + deep link)
| id | source · formula | status |
|---|---|---|
| `compliance_driver_rows` | per operator: `buildPassport` items → colour (§5.6); licence via requirement `ab.driver.licence.class1`; H2S / First Aid / TDG / WHMIS via `trainingRecords` + `complianceDocuments` docTypes (`h2s_alive`, `first_aid`, `tdg_certificate`, `whmis` **and** `whmis_certificate` — the mismatch is named in the row); academy via `academyQualifications` computed expiry | COMPUTABLE structurally; UNKNOWN where the requirement is unverified |
| `compliance_hos_rows` | attested today / not attested / unknown (P9) | UNKNOWN for limits; attestation COMPUTABLE |
| `compliance_hos_missing_logs` | — | NOT DERIVABLE |
| `compliance_unit_rows` | `readinessComposer` unit and trailer halves: inspection/registration/insurance/CVIP credential state, unresolved critical defect, active OOS, incomplete pre/post-trip (no inspection row on a trip day) | COMPUTABLE |
| `compliance_permit_rows` | — | NOT DERIVABLE (no permit model; readiness hard-codes none) |
| `compliance_job_rows` | manifests not `complete` for trips completed; loads without disposal evidence (`closeoutState` blocker); DG: `loadProfiles.classificationStatus ≠ verified`; missing signatures | PARTIAL: "required documents" NOT_EVALUATED (hard-coded true in readiness) |
| `compliance_readiness_history` | `dispatchEligibilityChecks` verdicts by day (blocked / review / unknown / eligible) | COMPUTABLE — the only true time series |
| `compliance_roadside` | `enforcementEvents.inspectionResult` counts, active `outOfServiceOrders`, citations by status | COMPUTABLE |

### 7.7 Disposal
| id | source · formula | status |
|---|---|---|
| `disposal_loads_by_facility` | `disposalTickets` (via job/trip scope) grouped by `facilityId`, `scaleInAt` in range | COMPUTABLE |
| `disposal_volume` | Σ `netKg` / `quantity` (verified); unverified rows counted separately | PARTIAL |
| `disposal_cost` | `facilityStatementLines.amountCents` matched to tickets; unmatched → unallocated; vendor bills coded disposal | PARTIAL |
| `disposal_turnaround` | custody `arrived_facility → unloaded`; fallback unload `tripStops` arrived→departed; fallback `fieldTicketEvents` disposal_queue + disposal | PARTIAL |
| `disposal_wait_reported` | `facilityWaitReports.waitMinutes` mean | COMPUTABLE (self-reported, labelled) |
| `disposal_rejected` | custody `rejected_by_facility` + `disposalTickets.verificationStatus = rejected` + call-ahead `refused` + blocking `loadFacilityAssessments` | COMPUTABLE |
| `disposal_partial_acceptance` | — | NOT DERIVABLE |
| `disposal_distance_avg` | haversine origin→facility | PARTIAL, labelled straight-line |
| `disposal_document_completion` | `disposalReconciliation.completenessPercent` per job (shown as N of M) | COMPUTABLE (engine unwired today; wiring it here is permitted work) |
| `facility_status` | `facilities.status` / `lifecycle` / hours | COMPUTABLE |

### 7.8 Safety
| id | source | status |
|---|---|---|
| `inspections_completed`, `inspection_failures` | `inspections` by status | COMPUTABLE |
| `defects_reported` | `maintenanceDefects.reportedAt` | COMPUTABLE |
| `incidents_by_type_severity`, `near_misses` | `incidentReports`, `nearMissReports` (summary permission) | COMPUTABLE |
| `corrective_actions_outstanding` | `incidentActions` | NOT DERIVABLE (dead table) |
| `safety_actions_outstanding` | `operationalTasks` of safety task types + incidents not closed | PARTIAL (emitters unwired) |
| `safety_paperwork_overdue` | tailgate meetings `needs_review`; artifacts past `retentionUntil` | COMPUTABLE |
| `training_compliance` | `driver_qualification_status` aggregated as N of M | COMPUTABLE structurally |
| `recurring_problem_categories` | incident type × 90-day window | COMPUTABLE |

### 7.9 Operational timeline (report, not a metric)
`analytics.timeline.day(date, zone)` composes, in scope: trips started/completed, dispatch
assignment events, field ticket events and signatures, custody events, disposal tickets, delay
events, defects and releases, roadside events, OOS orders, readiness checks (blocked), sync
conflicts. It extends `surfacesService.loadTimeline` with the sources it omits (§1.16) and takes a
scope. "What changed since the previous shift" is answered as "since `<timestamp>`" (C10).

### 7.10 Reports (registry v1)
Fleet Utilization · Driver Utilization · Equipment Downtime · Maintenance Cost · Compliance
Exceptions · Certification Expiry · HOS Elapsed & Attestation (not "HOS Risk" until P9) · Job
Performance · Load Report · Disposal Report · Fuel/Expense Report · Customer Activity · Billing
Readiness · Safety Compliance · Daily Operations · Weekly Operations · Monthly Management —
each a set of metric ids plus a row resolver; each row a drill-down.

---

## 8. Migration requirements

**One table in Checkpoint B; one optional table in Checkpoint D; no analytics rollup tables.**

| Migration | Table | Columns | Why it is not a duplicate |
|---|---|---|---|
| `0175_analytics_report_runs.sql` | `analyticsReportRuns` | `id`, `runRef` (unique), `orgRef` (nullable, NULL = historical single tenant — **not** `tenantId`, per C14), `generatedByUserId` NOT NULL, `generatedAt` NOT NULL, `reportKey`, `definitionVersion`, `registryVersion`, `rangeFrom`, `rangeTo`, `zone`, `filtersJson`, `exportType` enum `screen/csv/pdf`, `rowCount`, `contentHash` (nullable), `storageKey` (nullable), `scopeDerivedFrom` enum `membership/single_tenant_fallback` | §18 auditability: who/org/when/filters/version/export type. No existing log carries filters or a definition version; `fieldTicketDocuments` is per ticket. **Report contents are not stored**, only the hash and (for exports) the storage key. |
| `0176_analytics_saved_views.sql` (Checkpoint D, optional) | `analyticsSavedViews` | `orgRef`, `userId`, `reportKey`, `name`, `filtersJson`, `sharedWithRole` (nullable), `createdAt`, `updatedAt` | `widgetLayouts` stores tile layouts, not report filters. Could instead be folded into the Administration Center's per-user settings; owner's call. |

Every migration must: match `drizzle/schema.ts` (table parity + `columnParity.test.ts`), avoid
slots 0016/0017, use the next free prefix (0175; note the two existing `0157` files), and hold
money only as integers (none planned).

**Prerequisite fixes in the authoritative systems** (separate small commits, each with its own
test, before the metric that depends on it is promoted from PARTIAL):
1. `shop.workOrderAdvance` stamps `startedAt` / `completedAt` (downtime, repair duration).
2. `commercialOffice.profitability.byDimension`: entity-scope the payables query; include `paid`.
3. `workforce.applicantDecide` writes `coreRecordOwnership` for the new operator.
4. `surfacesService.loadExceptionSources` takes a scope (or analytics does not call it).
5. `profitability.derivability`: unit/driver/load become derivable via the ticket link.

None of these is analytics code; each is a defect in the record's own subsystem.

**No new columns on operational tables** are proposed by analytics. Columns the survey found
wanting (job timestamps, unit status, downtime ledger, PM schedule, asset-type catalog, branch,
org timezone, load writer, permit model) belong to their subsystems or to the Administration &
Company Configuration Center, and analytics reports `not_derivable` until they exist.

---

## 9. Test plan

All suites follow the repo's conventions: pure tests in `server/*.test.ts` and
`server/_core/analytics/*.test.ts`; database suites as `*.db.test.ts` guarded by
`const d = DATABASE_URL ? describe : describe.skip` (the gate fails a skipped DB suite);
fixtures insert their own organizations, memberships, ownership rows and role grants with random
refs (`tenantScopeMoney.db.test.ts:17-27` pattern); callers via `appRouter.createCaller`.

| Area (from the proposal §20) | Test | Kind |
|---|---|---|
| Tenant isolation | Two organizations with identical fixtures; every registered metric returns each org's own value; the drill-down for org A never contains a row owned by org B; a metric over a table with no scope helper **fails registration** (registry test enumerates sources against an allow-list of helpers) | db |
| Cross-organization refusal | A caller in org A requesting a unit/operator/invoice id from org B gets `NOT_FOUND`, never `FORBIDDEN`, for every drill-down | db |
| Authorization | For every `analytics.*` procedure: unauthenticated → UNAUTHORIZED; each of the 15 roles → FORBIDDEN or passes the gate exactly as `GRANTS` says (`operationalApiAuthorization.test.ts` `attempt()` pattern); authorization runs before input validation | pure + db |
| Per-metric permission | A caller holding `analytics.read` but not the metric's `requiredPermission` sees the metric as `not_permitted`, not as a number; margin never appears without `commercial.margin.view` | db |
| Driver self-view | A driver calling with `subject = self` gets only their own rows; naming another `operatorId` → NOT_FOUND; a driver never passes `analytics.read` or `analytics.export`; the `userId`/`operatorId` mapping goes through one shared resolver | db |
| Portal boundaries | Dispatcher: no money metrics; mechanic: costs but no revenue; safety: no invoices; office: no restricted or investigation detail; auditor: read/export only | db |
| Metric formulas | One pure test per metric with a hand-computed fixture: known inputs → expected value, determination, unknowns, buckets | pure |
| Zero vs missing | A fixture with zero qualifying rows returns `value: 0, determination: computed`; a fixture with rows whose determining field is NULL returns `value: null, determination: unknown` with the reason; a mixed fixture returns `partial` with the NULL rows named | pure |
| Date ranges | Boundary rows at `from` (included) and `to` (excluded); `mtd/qtd/ytd` against fixed clocks; fiscal vs calendar quarter when a financial entity is in scope | pure |
| Timezone | The same rows in `UTC`, `America/Edmonton` and `+05:30`: a row at 23:30 local lands in "today" locally and "tomorrow" in UTC; response echoes the zone; an invalid zone is refused | pure |
| Incomplete data | Bulk fuel → `missing` bucket with litres; no labour rate → `estimated` absent and named; advance-closed work order → downtime `unknowns` | pure |
| Stale data | A metric payload older than its freshness budget renders `stale`; a mobile tile with no `observedAt` renders `unknown`, never live | pure (widget contract) |
| Aggregation | Overlapping downtime intervals merged once; a unit on two trips at once counted once; grouped totals equal the ungrouped total | pure |
| **Drill-down equivalence** | For every registered metric and a randomized fixture: `metric.get(...).value` equals `count`/`sum` of `metric.drilldown(...)` under identical scope, range, zone and filters ("14 overdue units" ⇒ 14 rows). Registry test fails if a metric lacks a drill-down | db, table-driven over the registry |
| Registry integrity | Every metric has id, formula text, unit, permission from the `Permission` union, at least one source table, a resolver and a drill-down; ids unique; `METRIC_REGISTRY_VERSION` changes when a formula changes (snapshot of formula texts) | pure |
| Report exports | CSV: quoting via `facilityExport.toCsv`, header block present, row count matches `report.run`; PDF: deterministic bytes for the same snapshot (as `ticketPdf` tests); an `analyticsReportRuns` row exists **before** bytes are returned; export without `analytics.export` → FORBIDDEN; audit-write failure → refused (sensitive) | db |
| Auditability | Report run rows carry user, org, time, filters, versions, export type; no report contents stored | db |
| No driver scoring | A test that greps the analytics registry for any per-driver metric of kind ratio/rank over `drivingEvents`, and fails if one appears; no metric sorts operators by a composite | pure |
| Honesty labels | No metric label contains "remaining", "compliant", "time left" for HOS (`FORBIDDEN_LABELS`); no colour is emitted without a source verdict and reason | pure |
| CI pins | `OPERATIONAL_PROCEDURE_PERMISSIONS` count, `OPERATIONAL_SOURCES`, inventory, `LEASEOS_CURRENT_STATE.md`, `engineReachability`, `tenantIsolation` (no `tenantId` literal), `columnParity` — all updated in the same commit as the procedures | existing gates |

---

## 10. Proposed implementation checkpoints (after this survey is approved)

| Checkpoint | Scope | Adds |
|---|---|---|
| **B — registry and spine** | `server/_core/analytics/{metricRegistry,metricResolvers,ranges,dataQuality}.ts`, `server/analyticsRouter.ts` with `analytics.metric.get / list / drilldown`, permissions `analytics.read` / `analytics.read_own`, ~20 COMPUTABLE metrics from §7.1/7.3/7.6/7.8, the drill-down equivalence suite, tenancy suite | 0 tables; pins updated; owner's moratorium note recorded |
| **C — dashboards as widgets** | executive, fleet, maintenance/downtime, compliance, disposal tiles registered as widget sources reading `analytics.metric.get`; colour mapping; driver self tiles; mobile `LAST UPDATED` | 0 tables |
| **D — cost, finance, reports** | cost resolvers and buckets, `revenue_recognized`, profitability corrections in place, report registry, `analytics.report.run / export`, `analytics.export` (sensitive), `analyticsReportRuns` | migration 0175 (+0176 optional) |
| **E — timeline and AI binding** | `analytics.timeline.day`, daily/weekly/monthly reports, read-level `CapabilityDefinition`s for the secretary once PR #7 lands | 0 tables |
| **Deferred** | branch, platform-level, current shift, HOS remaining/violations, permits, scheduled maintenance, overtime, partial acceptance, customer-portal analytics | wait on Administration Center, P9, PORTAL_ORG_SCOPE |

## 11. What the Administration & Company Configuration Center must supply

The survey confirms the owner's instinct that the next category after analytics is configuration.
These metrics stay `not_derivable` or `partial` until that center exists:
- **Branches** as records, and a branch on jobs, units and operators (C3).
- **Organization default timezone** and shift calendar (C10, §3.7).
- **Asset-type catalog** replacing free-text `vehicleType` (utilization by unit type).
- **Expiry warning windows** per document type (today 30 days in four places; insurance 90/60/30/14/7).
- **Internal labour rate** (`chargeDefinitions.internal_cost`) and PM / service-interval thresholds.
- **Organization-scoped roles** and a platform-admin role (C2).
- **Alert rules** for KPI thresholds on `workflowRules` + `automationPolicy` (§1.17 of the safety survey).
- **Numbering** for report runs (`runRef`) can reuse `commercialNumberingPolicies` when it exists.

---

*Survey generated for Checkpoint A. Nothing above is implemented. The next step is the owner's
decision on C2, C3, C10 and C12, then Checkpoint B.*
