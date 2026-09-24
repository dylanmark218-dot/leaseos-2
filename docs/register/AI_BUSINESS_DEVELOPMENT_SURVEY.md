# AI Business Development / Sales Automation — repository survey

**Design checkpoint, no code.** Written against `main` = `6f52b57` (release `v23.25`, 410 tables,
169 migration files, 652 `roleProcedure(` sites) on branch
`claude/leaseos-ai-sales-architecture-xx19rj`. Every path, symbol and line number below was read
from that tree during this session. Where a document and the code disagree, the code is cited and
the disagreement is marked **NOTE**.

The companion document, `docs/register/AI_BUSINESS_DEVELOPMENT_DESIGN.md`, carries sections 4–15 of
the requested output (architecture, entities, contracts, state machine, autonomy, handoff, threat
analysis, failure modes, offline, migration, testing, checkpoints). This document carries sections
1–3: the survey, what to reuse, and the gaps.

**Governing constraint, stated first.** `docs/register/SPINE_WIRING_PLAN.md:3-4` — "The moratorium
stands: no new engines until this path is wired." Thirteen spine engines remain in `DECLARED_UNWIRED`
(`server/engineReachability.test.ts:28`), so the moratorium is fully in force. Every implementation
checkpoint in the design is a new engine or a new router and therefore needs either the spine wired
or an explicit owner carve-out. This checkpoint commits design artifacts only, which the moratorium
permits.

---

## 1. Repository survey

### 1.1 Organizations, companies, tenants

| Concern | Canonical implementation | Notes |
|---|---|---|
| Tenant identity | `organizations.orgRef` (varchar 40, unique), `drizzle/schema.ts:6864` | Columns: `name`, `status` (`active|suspended|closed`). **No type/kind, no contact, no region columns.** |
| Tenant column on records | `orgRef` on ~40 tables (`jobs:18`, `trips:575`, `facilities:245`, `customerAccounts:4808`, `capabilityEntitlements:8686`); `bookOrgRef` on 13 commercial-office tables (`vendors:818`, `commercialDocuments:8636`, the P7 tables); legacy `tenantId` varchar(40) on exactly 19 tables pinned by `server/tenantIsolation.test.ts:39-45` | There is **no `companyId` or `organizationId` column anywhere**. NULL `orgRef` means the historical single tenant (migration 0132 rule). |
| Tenant from session | `resolveActingScope(db, userId, at?)` → `ActingScope { tenantId, derivedFrom: "membership" \| "single_tenant_fallback" }`, `server/_core/actingScope.ts:42-102`; `SINGLE_TENANT_ID = "default"` | Two live memberships throw `AmbiguousOrganization`; the tenant is never read from input. `TrpcContext = { req, res, user }` (`server/_core/context.ts:5`) carries no tenant. |
| Scope predicates | `TenantScope`, `orgScopeWhere(table, scope)` `server/db.ts:159-164`; `jobScopeSubquery` `db.ts:876`; `vendorBookWhere` `db.ts:496`; `entityScopeWhere` `server/_core/entityScope.ts:14` (money is scoped by financial entity); `recordBelongsToOrganization` `server/_core/coreRecordOwnership.ts:12` | Out-of-scope rows answer `NOT_FOUND`, never `FORBIDDEN`. |
| Ownership side table | `coreRecordOwnership` `schema.ts:5514`, `recordType ∈ {unit, operator, load, financial_entity}`, unique `(recordType, recordId)` | How `units` and `operators` (which have no `orgRef`) are tenant-scoped. |
| Organization master (P7) | `commercialOffice.organizations.create` `server/commercialOfficeRouter.ts:45`; `commercialRoleTypes` `schema.ts:8296` seeded `client, vendor, disposal_facility, subcontractor, supplier` (`drizzle/0133_commercial_office_configuration.sql:24-29`); `organizationCommercialRoles` `schema.ts:8307` (`bookOrgRef` = the business keeping the record, `orgRef` = the organization holding the role, `commercialNumber` from a numbering policy); `organizationRecordLinks` `schema.ts:8373` (`recordType ∈ {vendor, facility, job_customer, customer_account}`) | A business may add its own role types (`roleTypes.create` `:74`, key regex `^[a-z][a-z0-9_]{1,39}$`). The linking rule at `:239-255` requires the organization to already hold the matching active role. |
| Contractor relationships | `organizationRelationships` `schema.ts:7849`, `relationshipType ∈ {PRIME_CONTRACTOR, CONTRACTOR, SUBCONTRACTOR, VENDOR, LEASED_OWNER_OPERATOR, INDEPENDENT_CARRIER, EQUIPMENT_PROVIDER}`, `status ∈ {pending, active, suspended, ended}`; `server/contractorOperationsRouter.ts:32-37` (parent = acting tenant, child must accept) | Company-to-company, not customer-prospect. |
| Customer account | `customerAccounts` `schema.ts:4805`: `orgRef` (nullable link to the client organization), `accountRef`, `financialEntityId` NOT NULL, `paymentTermsDays`, `creditLimitCents`, `requiresPurchaseOrder`, `requiresAfe`, `billingFrequency`, `holdReason`, `status ∈ {active, on_hold, inactive}` | **No contact columns. Requires a financial entity**, so it cannot hold a prospect. |
| Vendors (ours) | `vendors` `schema.ts:813`: `orgRef` (the vendor's own org), `bookOrgRef` (the tenant keeping the record), `category`, `status ∈ {active, inactive, blocked}`, `coverageArea`, `portalEnabled`, `preferred`, `emergency24h`, `contactName`, `phone`, `emergencyPhone`, `email` | This is *our* supplier registry, not our vendor status *at a customer*. |
| Subcontractors | `subcontractors` `schema.ts:2601`: `approvalStatus ∈ {pending, approved, suspended, expired}`, `insuranceExpiresAt`, `safetyProgramVerifiedAt`, contact columns | **No tenant column.** |
| Facilities | `facilities` `schema.ts:242`: `orgRef`, `province`, `municipality`, `legalLocation`, `latitude`, `longitude`, `coordinatePrecision`, `disposition`, `lifecycle`, `status`, seven contact/phone columns | The only table with region-like columns and a radius search. |
| Sales portal slot | `portalComposition.ts:189-196`: `portal: "sales_customer"`, purpose "Customers, quotes, rate cards and opportunities", `composedFrom: ["office","management"]`, comment "No sales role exists yet … a `sales` role is a forward addition" | Client labels it "Sales" (`client/src/portal/viewModels.ts:36`). |

Tests that pin tenancy: `server/tenantIsolation.test.ts`; the twelve `server/tenantScope*.db.test.ts`
suites (two organizations, cross-organization reads answer not-found; skipped without
`DATABASE_URL`); `server/actingScope*.test.ts`. `docs/register/PORTAL_ORG_SCOPE_DEFERRED.md`
records that roles cannot vary by organization (`userRoleAssignments.scopeType ∈ {global, branch}`).

### 1.2 Contacts and contact lists

**No CRM-style contact, person or contact-list entity exists.** No table name contains "contact" or
"person" except `incidentPeople` (`schema.ts:2968`). Contact data is flat columns on parents:
`facilities` (7 columns), `vendors` (4), `subcontractors` (3), `insuranceProviders` (4),
`fieldTicketSignatures.signerName/Company/Role/Phone`, `applicants.contactJson`. `customerAccounts`
and `organizations` have none.

External people exist only as:

- `externalIdentities` `schema.ts:4871` — a **portal login**, `kind ∈ {customer, vendor, facility}`,
  bound to exactly one of `customerAccountId | vendorId | facilityId`; `email` NOT NULL,
  `displayName`, token/invitation/MFA columns, `status ∈ {invited, active, suspended, revoked}`.
  Invitation (`portalAdmin.identityInvite`, `server/commercialRouter.ts:107`) returns the token to
  the internal user once; **it is not emailed**.
- `signatoryAuthorities` `schema.ts:4927` — a named customer signatory with authority flags
  (`mayAcceptQuotes`, `mayChangeRates`, `extraWorkLimitCents`, …). **No email or phone.**

Two specifications on disk govern how contacts must be built, and the design defers to them rather
than adding a parallel model:

- `docs/knowledge/source/LeaseOS_Contact_Communications_Emergency_Directory_Build_Plan_for_Claude.txt`
  (2026-09-19): entities `people`, `organization_memberships`, `contact_methods` (encrypted value,
  **classification** `public_work | internal_work | job_only | client_visible | dispatch_only |
  emergency_only | private_personal`, `verifiedAt`, `validFrom/To`), `organization_relationships`,
  `job_contact_assignments`, `contact_access_policies`, `contact_revisions`, `contact_access_events`;
  authorization function `authorizeContactMethod(actor, contactMethod, purpose, job?)`, fail-closed;
  hard rule "Do not use READ_CONTACTS to bulk-ingest device contacts."
- `docs/knowledge/source/LeaseOS_Commercial_Office_Administration_Hub` — Master Client Registry with
  `status: prospect/active/on-hold/suspended/archived`, contacts by function (dispatch, field, AP,
  safety, management), rate agreements with version history, invoice delivery channel.

`docs/register/ROADMAP_2026-09-21.md` lists "Contact directory, using `manifestPartySnapshots` as the
pattern" (`schema.ts:480`: `role`, `canonicalEntityId`, `capturedName`, `capturedIdentifier`,
`source ∈ {backfilled_text, bound_from_record, amendment}`) under **Product not built**.

### 1.3 Customers, consultants, producers, vendors

Three parallel models coexist (§1.1): legacy per-kind tables joined by integer id (`jobs.customer`
is free text; `jobs.customerOrgRef` is the optional link, set by `commercialOffice.linkSet`
`commercialOfficeRouter.ts:238-259`); the P7 role model on one organization master; and
contractor relationships (0115). **No "consultant" or "producer" entity exists** — "consultant"
appears only in prose as the customer's site signatory. Portal identity kinds map to permission sets
through `EXTERNAL_KIND_PERMISSIONS` (`server/_core/recordsAuthorization.ts:2980`).

### 1.4 Jobs and dispatch

| Concern | Implementation |
|---|---|
| Job | `jobs` `schema.ts:15`: `orgRef`, `customerOrgRef`, `jobCode` unique, `type` (free text), `mode ∈ {general, hydrovac, recovery, transport}`, `customer` (text), `location` (text), `status ∈ {dispatched, in_transit, loading, on_site, awaiting_docs, complete}`, `latitude`, `longitude`, `eta` varchar(32). **No draft/quoted/scheduled state, no requested start, no LSD FK, no service-type FK, no customer FK.** |
| Job create | `fieldRoute.jobs.create` `server/routers.ts:397` → `createJob(input, scope)` `server/db.ts:183`, one INSERT; `jobInput` zod at `routers.ts:265-289`. No other production `insert(jobs)`. |
| Posting | `dispatchPostings` `schema.ts:1806`: `planningState` (14 values from `draft` to `cancelled`), `planningBlocker` (`awaiting_customer`, `awaiting_permit`, …), `distribution`, `scheduledStart`, `estimatedDurationMinutes`, `requirementsJson`, `postedRateCents`. Created by `createPosting` `server/dispatchRoleService.ts:117`. |
| Slots | `dispatchRoles` `schema.ts:1876` (`roleCode`, `requiredEquipmentClass`, `status ∈ {open, invited, bid_received, assigned, cancelled}`); `dispatchRoleTypes` `:1911` (seeded `LEAD, WINCH_TRACTOR, BED_TRUCK, PICKER, PILOT_VEHICLE, PRIMARY_UNIT, SUPPORT_UNIT, STANDBY`, `drizzle/0170_dispatch_role_types.sql:71`); `dispatchRoleAssignmentEvents` `:1936` append-only. |
| Slot binding | `setRoleAssignment` `dispatchRoleService.ts:479` — locks posting then role `FOR UPDATE`, compares `expectedLastEventId` with `headEventId()` and throws `CONFLICT` if stale (`:376-410`); "writes no booking and is explicitly not an award" (`:319`). |
| Award | `dispatch.evaluate` `server/dispatchRouter.ts:216` (stores `dispatchEligibilityChecks` `schema.ts:2017` with `fingerprint` `EF2-sha256`, `verdict ∈ {eligible, eligible_review, blocked, unknown}`) → `overrideRequest/Grant` `:246/:279` (grantor ≠ requester) → `dispatch.award` `:312` → `awardAssignment` `server/_core/dispatchTransaction.ts:72`. |
| Bookings | `resourceBookings` `schema.ts:2101` (DDL `drizzle/0013_dispatch_operations.sql:130-140`): `resourceType ∈ {operator, unit, trailer, equipment}`, `resourceRef` (stringified id), `postingId?`, `jobId?`, `startsAt`, `endsAt`, `bookingState ∈ {tentative, confirmed, released, cancelled}` default `tentative`. **Only writer** is `awardAssignment` (`dispatchTransaction.ts:276`), always `confirmed`. **Nothing writes `tentative`, `released` or `cancelled`.** No unique constraint, no version, no expiry, no actor, **no `orgRef`**; index `(resourceRef, startsAt, endsAt)` only. |
| Overlap rule | `dispatchTransaction.ts:186-197`: half-open interval, `bookingState in ('tentative','confirmed')`, rows from the same posting excluded. |
| Schema-only dispatch tables | `operatorAvailability` `:1755` (`state` has 9 values incl. `hos_limited`, `qualification_blocked`; `region`, `maxRadiusKm`), `onCallRotations` `:1778`, `operatorCapabilities` `:1730`, `dispatchTemplates` `:2125`, `specialtyPools` `:1721` — **no production reader or writer**. `dispatchBids`/`dispatchInvitations` are only UPDATEd inside the award. |
| Matching | `dispatchMatching.ts` (pure, unwired, SPINE item 2 duplication): `matchOperatorToJob` `:124`, `detectBookingConflicts(proposed, existing)` `:461`. |
| Legacy assignment | `jobUnits.create` `routers.ts:1472` → `createJobUnitGated` `server/dispatchEnforcementService.ts:91`, governed by `dispatchEnforcementSettings.mode ∈ {off, advisory, enforced}` (`schema.ts:4462`, append-only). |

### 1.5 Driver/operator eligibility, unit eligibility, HOS and compliance gates

- **Composer.** `composeReadiness(subject, now?)` `server/readinessComposer.ts:379` →
  `ComposedReadiness { eligibility: DispatchEligibility, facts: EligibilityFacts, fingerprint,
  contributions, capabilities: CapabilityResult[], capabilityVerdict, automationPolicy, ruleSetHash }`
  (`:214`). `ReadinessSubject = { operatorId, unitId, trailerId, jobId, postingId?, routeApprovalRef?,
  loneWorker?, enforcement? }` (`:60`). Exposed read-only by `dispatch.readiness` (`dispatchRouter.ts:195`).
- **Verdict type.** `server/_core/dispatchReadiness.ts:24-52`: `EligibilityVerdict = "eligible" |
  "eligible_review" | "blocked" | "unknown"`; `DispatchBlocker { code, label, severity: blocking|review|unknown,
  subject: operator|truck|trailer|job|route, overridable, overrideAuthority? }`. `deriveVerdict` (`:491`)
  is worst-of; unknown outranks review.
- **Cross-engine vocabulary.** `server/_core/interEngineStatus.ts:37-86`: `InterEngineStatus = PASS |
  REVIEW | BLOCKED | UNKNOWN | NOT_EVALUATED`, `NotEvaluatedReason ∈ {module_disabled, not_licensed,
  not_applicable, no_data_source_loaded}`, `combineForConsumer` (`:100`). The contract per consumer is
  `dispatchContractFor()` (`server/_core/readinessCapabilities.ts:63`); `DISPATCH_REQUIRED_ALWAYS` (`:49`)
  = hos, operatorQualification, unitInspection, operatingDocuments, enforcementOrders.
- **Override classes.** `server/_core/complianceFinding.ts:28-30`: `OverrideClass = NEVER_OVERRIDABLE |
  APPROVED_POLICY_ONLY | WARNING_ONLY | INFORMATIONAL`; `CLASSIFICATION` regex table (`:98`);
  `APPROVED_OVERRIDE_POLICIES = []` (`:317`). `hos_insufficient` is HARD / NEVER_OVERRIDABLE (`:118`);
  `hos_unknown` is APPROVED_POLICY_ONLY (`:119`) and, with an empty policy list, **cannot be released by
  any grant**. `critical_defect` and `academy_<code>` blockers are blocking and not overridable
  (`readinessComposer.ts:460-489, 574-575`).
- **HOS.** `server/_core/hos.ts`: `HosDetermination { verdict: within|exceeded|unknown, … }` (`:360`),
  "`unknown` whenever any limit is unknown. It never rounds to compliant"; `tripFeasibility` (`:470`) →
  `yes|no|unknown`. Rules are data: `hosRuleProfiles` `schema.ts:6593`, `hosRuleLimits` `:6619`,
  `verificationStatus ∈ {unverified, verified, superseded}`. **NOTE:** the composer never calls
  `determine()`; it passes `hoursAvailableMinutes: null` (`readinessComposer.ts:833`) and reads only
  today's `hosAttestations` (`schema.ts:8717`), so every check today carries `hos_unknown` or
  `hos_attested`. HOS has no override concept of its own.
- **Qualifications.** `workerQualifications` `schema.ts:7004` (keyed by `userId`, `verificationState ∈
  {unverified, extracted, verified, rejected, superseded}`); `qualificationValidity.countsAsHeld`
  (`server/_core/qualificationValidity.ts:81`; a verified holding with no expiry counts as **not** held);
  `academyQualifications` `:7488`, `academyRequirements` `:7651` (`enforcement ∈ {block, review, inform}`),
  `academyRequirementBindings` `:7665` (`subjectType ∈ {role, equipment, job_type, customer, site,
  jurisdiction, cargo}`; `jurisdiction` and `cargo` never match, `readinessComposer.ts:272`);
  `trainingDispatchDecision` `server/_core/trainingAcademy.ts:207`.
- **Identity split.** Dispatch keys on `operatorId`; workforce, academy, qualifications and leave key on
  `userId`. Bridges: `operators.userId` (`schema.ts:120`), `organizationWorkers(userId, operatorId)`
  (`:7869`). An unlinked operator yields `academy_operator_unlinked` (severity unknown).
- **Units.** `units` `schema.ts:137`: `vehicleType` varchar(120) free text, `company` text (no orgRef),
  `inspectionStatus ∈ {current, due, blocked}`, `maintenanceStatus ∈ {clear, review, blocked}`; no
  capabilities column. `vehicleProfiles` `:5861` (dimensions, `source`, `verificationStatus`);
  `maintenanceDefects` `:317`; `capitalAssets.status` `:5302` incl. `out_of_service`.
- **Taxonomy.** No single canonical equipment or service enum. `taxonomyEntries` `schema.ts:1405`
  (`dimension ∈ {service, truck, trailer, cargo, …}`, **no production reader**); `server/_core/taxonomy.ts`
  `ServiceCategory` (`:28`), seed `TRUCKS` (`:563`: `TRK-TRIDEM-VAC` …), `deriveRequirements` (`:375`);
  `jobs.mode`; client-only `SERVICE_CATALOGUE` `client/src/portal/setupModel.ts:43` (`hydrovac,
  vac_hauling, water_hauling, …`); `commercialSetupProfiles.servicesJson` (owner decision pending,
  `docs/register/SPINE_WIRING_PLAN.md` "Service codes"). `dispatchRoles.requiredEquipmentClass` and
  `EquipmentProfile.equipmentClass` are free strings.

### 1.6 Training / certification records

`trainingRecords` `schema.ts:5721`, `competencySignoffs` `:5741`, `academyCertificates`,
`academyQualifications` `:7488`, `workerQualifications` `:7004`, `operatorEquipmentAuthorizations`
`:4239` (read only by `server/requirementRouter.ts`, not by the composer). Validity vocabulary:
`documentValidity.ValidityState = in_force | expiring | expired | unverified | rejected | none`
(`server/_core/documentValidity.ts:54`).

### 1.7 LSD / location / mapping / routing

| Concern | Implementation |
|---|---|
| LSD parse | `parseLsd(input)` `server/_core/dls.ts:34` → `Lsd { lsd, section, township, range, meridian, canonical ("05-12-052-18-W5"), identity ("AB:M5:R18:T52:S12:L5") }`; `parseUwi` `:56`; `theoreticalCentroid` `:83-93` → `{ source: "theoretical_grid", confidence: "low", caveat: "… Not for navigation …" }`. |
| LSD → coordinate | `geo.lsdLocate` `server/geoRouter.ts:208` (ATS polygons `atsLegalSubdivisions` `schema.ts:6079` + access point from `accessRoadSegments`; outcomes `invalid | not_imported | located`; **never falls back to the grid**). `facilityDirectory.lsdFind` `server/facilityDirectoryRouter.ts:389` is the only path that falls back (`basis: "theoretical"`, ±2 km). |
| Location record | `locationIdentities` `schema.ts:410`: `surfaceLsd`, `uwi`, `coordinateSource ∈ {ats_v41, field_gps, customer_stated, theoretical_grid, unknown}`, `coordinateConfidence`, `coordinateVerificationStatus ∈ {unverified, verified}`; `spatial.locationRegister` `server/spatialRouter.ts:59`; `spatial.locationGet` `:86` returns `navigable` only when verified. `siteAccessPoints` `:6157` (two-person confirm, `geo.accessDecide` `geoRouter.ts:270`). |
| Route path | `geo.routeCompute` `geoRouter.ts:370` — Dijkstra over `roadGraphBuilds` (`shortestPath` `server/_core/roadGraph.ts:124`); outcomes `no_graph | origin_unreachable | destination_unreachable | disconnected | no_path | path_only | evaluated`; returns `path.metres/kilometres`. Only inside imported areas. |
| Route verdict | `spatial.routeEvaluateSegments` `spatialRouter.ts:144` → `evaluateRoute` `server/_core/routeEvaluation.ts:261` → `RouteVerdict { legal, physicallyFeasible, operationallyPreferred: CheckResult(pass|fail|review|unknown), dispatchStatus: clear|warning|review|blocked, dataConfidence, evidence[] }` (`:96`). Requires a `vehicleProfiles` row. |
| Route approval | `spatial.routeApprove` `:241`, `routeApprovalCheck` `:308`; `routeApprovals` `schema.ts:6238` with `fingerprintHash`, `status ∈ {approved, stale, revoked, superseded}`; staleness by `stalenessAgainst(approved, current: RouteDependencies)` `server/_core/structures.ts:100-140` (vehicle profile, load, permits, restrictions, structures, road fabric, required checks, comms plan). |
| Travel time | **Not computed anywhere.** `server/_core/map.ts:253` (Google distance matrix via the forge proxy) is unwired and contrary to the no-Google policy in `routingSource.ts`; treat as off-limits. `jobs.eta` is free text. |
| Region | **No first-class region, territory, yard or home-terminal entity.** `operatingZones` `schema.ts:633` are geofence circles at sites; `region` varchar on `operatorAvailability`/`onCallRotations`; `jurisdiction.provinceAt` `server/_core/jurisdiction.ts:89`. |
| Proximity | `facilityDirectory.nearby` `facilityDirectoryRouter.ts:302` → `nearbyFacilities` `:469` (loads all facilities, haversine in memory, "Distances are straight-line"). **No spatial index; no proximity query over jobs, locations or customers.** |
| Unit position | `spatial.lastPosition` `spatialRouter.ts:347` (latest accepted `inboundEvents` `gps_position`, "A position is not a work state"); `tripBreadcrumbs` `schema.ts:888` via `gps.submitBreadcrumb` `routers.ts:870` (operator's active trip only). `telemetrySnapshots` has no lat/lng. |

### 1.8 Regional job / activity intelligence

- **Source registry.** `externalDataSources` `schema.ts:3519`: `sourceKey`, `category` (13 values),
  licence columns (`commercialUsePermitted ∈ {yes, no, unknown}`, `redistributionPermitted`,
  `attributionRequired/Text`, `shareAlikeObligation`), rate-limit columns, `updateIntervalHours`,
  `retrievedAt`, `verifiedAt`, reviewer columns, `status ∈ {unverified, verified, superseded, withdrawn}`.
  Gates: `evaluateSourceUsage({source, intent ∈ inspect|operational_decision|redistribute|offline_package})`
  `server/_core/externalDataRegistry.ts:92` (only `inspect` on an unverified source);
  `assessFreshness` `:185` → `fresh|aging|stale|unknown` ("Stale produces UNKNOWN, never PASS");
  `sourceGate` `geoRouter.ts:37` (verified + commercial use yes); `geo.sourceReview` `:95`.
- **Seeds.** `server/_core/externalSourceSeeds.ts`: 8 verified (osm, nrn, canvec, ats,
  ats_road_allowance, drivebc_open511, msc_geomet, cwfis), 13 unverified. **The oilfield activity
  sources a regional-opportunity engine would want — `aer_st37` (well list), `aer_st102` (facility
  list), `aer_st107` (licence status), `sk_iris`, `mb_petroleum` — are all `commercialUsePermitted:
  "unknown"`, `status: unverified`, and therefore blocked** for any operational intent. **NOTE:**
  `DATA_SOURCES.md` and `LEASEOS_CURRENT_STATE.md` disagree on the counts; the test
  `externalSourceSeeds.test.ts:44-46` pins 21/8/13.
- **Feed pattern (unwired).** `ingestFeed({source, state, credential, fetcher, store, normalize, parse,
  snapshotSemantics: "full"|"incremental", lastEntityTag, at})` `server/_core/feedIngest.ts:99` ("A
  refusal is a run"; a change supersedes and never overwrites); `shouldPoll` `feedCollector.ts:83`
  (`withdrawn | not_cleared | no_credential | not_due | quota_exhausted`); `externalFeedRuns`
  `schema.ts:6643`; `roadAdvisories` `:6667` (`sourceKey`, `externalRef`, `runRef`, geometry,
  `effectiveFrom/To`, `retrievedAt`, `contentHash`, `advisoryOnly`, `status ∈ {active, superseded,
  withdrawn}`) — the shape a regional signal row should copy.
- **Existing opportunity model.** `fundingOpportunities` `schema.ts:3639` (`matchStrength ∈ {strong,
  possible, more_information_required, excluded}`, `matchReasonsJson`, `missingInformationJson`,
  `estimateBasis`, 10-value status ladder, `assignedToUserId`); `matchProgram` `server/_core/fundingIntelligence.ts:159`
  ("Unverified programs can never be 'strong'", `:265-270`); ranking by strength order, **no numeric
  score** (`:303`); `purchaseAdvisory` `:429` is the recommended-action equivalent. **NOTE:** no
  non-test code inserts `fundingOpportunities`; matches are computed on read.
- **Historical intelligence.** Only profitability: `commercialOffice.profitability.byDimension`
  `commercialOfficeRouter.ts:689-735` (`Figures { revenueCents, costCents, marginCents, marginPct,
  invoiceCount, … }`, client key = `jobs.customerOrgRef` or `unlinked:<text>`). **No per-customer job
  count, last-job date, visited-site or notice-period analytics.**
- **Inbound machine events.** `integrationClients.kind` includes `customer_system` (`schema.ts:5494`);
  `INBOUND_FEEDS` (`:5492`) has no lead/request kind; the `generic` feed stores the event with its hash
  and creates nothing (`integrationGateway.ts:105-106`); `inboundRouter.ingest` `server/integrationRouter.ts:180-317`
  is "idempotent by the client's key, hashed, accepted only in scope … becoming a PROPOSAL where it
  becomes anything."

### 1.9 Rates, billing, quotes

- **Two pricing engines.** Quotes (`projectRouter.quoteCreate` `server/projectRouter.ts:43`) price from
  `customerRateCards`/`customerRateCardLines` (`schema.ts:4846/4860`) through `commercial.priceLines`
  (`server/_core/commercial.ts:47`); `rateCardCreate` (`commercialRouter.ts:58`) inserts the card as
  `approved` by its own creator. The deterministic resolver — `resolveRate(defs, ctx: ResolutionContext)
  : Resolution` (`server/_core/rateResolution.ts:67`, outcomes `resolved | unknown | conflict`,
  precedence `job_override > change_order > po_afe > project_site > customer_contract >
  customer_rate_card > branch > company`) and `priceQuantity` (`:112`) over `chargeDefinitions`
  (`schema.ts:5960`: `approvalStatus`, `sourceKind ∈ {human, ai_extracted, imported, negotiated}`,
  `sourceDocumentEvidenceId`) — is **not called by quotes**. `pricingDecisions.subjectKind` already
  includes `"quote_line"` and `"job_estimate"` (`:6010`) and nothing writes them. Roadmap step 5
  ("Unify billing") is the same seam.
- **Quote lifecycle.** `quotes` `schema.ts:5371`: `status ∈ {draft, issued, accepted, declined, expired,
  superseded, withdrawn}`, `snapshotJson/Hash`, `validUntil`, acceptance columns,
  `acceptanceWithinAuthority ∈ {yes, no, unknown}`. `quoteIssue` (`:58-70`, sensitive permission
  `project.quote.issue`, management/controller only) freezes `sha256(canonicalJson(snapshot))`;
  `quoteRevise` (`:73`) supersedes. Acceptance is portal-only: `portal.quoteAccept`
  (`server/portalRouter.ts:100-112`) → `quoteAcceptanceDecision` (`server/_core/commercialProjects.ts:15-23`).
  **No internal mark-accepted path, no expiry job; `expired/declined/withdrawn` are never written.**
  `quoteLines.priceSource ∈ {rate_card, explicit}`; an explicit line has no approval, margin or
  authority check (`projectRouter.ts:34`).
- **Margin envelope.** `simulateMargin({sellCents, costCents, guardrails, roles}): MarginSimulation`
  `rateResolution.ts:177` → `band ∈ {target, warning, below_minimum, unknown}`, `approvalRequired`;
  `commercialSetupProfiles.discountAuthorityJson` (role → floor bps), `targetMarginBps`,
  `warningMarginBps`, `minimumAuthorityMarginBps` (`schema.ts:6040`). Cost unknown →
  `approvalRequired: "controller"`.
- **Approval ledger.** `decide(db, {actorUserId, category, subjectType, subjectRef, amountCents,
  preparedByUserId, decision, note?}): DecideResult(satisfied|awaiting|refused|blocked)`
  `server/_core/commercialApprovalService.ts:27`; policies `commercialApprovalPolicies` `schema.ts:8346`
  seeded (`0133:120-126`) for `purchase_order, vendor_bill, credit, rate_override, write_off, payment`
  in three tiers (≤$5k office; ≤$25k management; unbounded management + second person).
  **`rate_override` is seeded and has no caller.** `mayApprove` (`commercialApprovals.ts:26`) enforces
  separation of duties. Quotes, change orders and margin overrides do not use this ledger today.
- **Credit and terms.** `commercialBillingCheck` `server/_core/commercial.ts:28` → `verdict ∈ {ready,
  review, blocked}` (blocks on `on_hold`, `inactive`, missing/exhausted PO, missing AFE;
  `over_credit_limit` is review); `aging` `server/_core/accountsReceivable.ts:51`; `customerAccounts`
  columns in §1.1. `billingAuthorityBands` (`schema.ts:2561`) and `billingAdjustments` (`:2527`) are
  **unread by any router**.

### 1.10 Email / outbox / messaging infrastructure

- **There is no outbound email transport.** A search of `server/`, `client/`, `shared/` and
  `package.json` for nodemailer, sendgrid, smtp, mailer, sendEmail, resend, postmark, mailgun, ses
  found nothing. The only notifier is `notifyOwner(payload)` `server/_core/notification.ts:64` (Manus
  owner notification). `commercialDocumentDeliveries` (`schema.ts:8667`, `channel ∈ {email, portal,
  print, api, courier, other}`, `status ∈ {queued, sent, delivered, failed, bounced, acknowledged}`)
  is a **delivery log a person records** (`documents.deliveryRecord` `commercialOfficeRouter.ts:632`).
  `workflowNotifications.channel ∈ {in_app, push, email, sms, integration}` (`schema.ts:2468`) but
  **every insert uses `in_app`** (`server/customerAlertService.ts:33`, `enforcementOutbox.ts:101,158`).
  Roadmap: "Customer alerts by email or SMS (in-app only today)".
- **Internal board.** `messageChannels` `schema.ts:7060` (`type` includes `client`, `clientRef`),
  `boardMessages` `:7076` (`authorUserId` NOT NULL — an internal user), receipts
  `queued_offline → … → resolved` (`server/_core/messageLifecycle.ts:23-31`, forward-only with typed
  evidence). `EXTERNAL_CHANNEL_TYPES = ["client"]` (`messageBoard.ts:50`) but **every procedure is
  `roleProcedure`**; there is no portal route to the board, and external parties cannot post or read.
- **Outbox.** `domainEventOutbox` `schema.ts:2316` (`eventId` unique, `eventType`, `aggregateType`,
  `tenantId` NOT NULL, `correlationId`, `causationId`, `actorSource ∈ {human, system, ai, integration}`,
  lease columns `claimedAt/claimedBy/retryAvailableAt/attemptCount/deadLetteredAt`). Emit inside the
  caller's transaction with `emitDomainEvent(tx, input: EmitInput)` `server/_core/eventEmitter.ts:115`
  (unwired) or the live `enqueueEnforcementEvent` `server/_core/enforcementOutbox.ts:43`. Claim:
  `FOR UPDATE SKIP LOCKED`, `CLAIM_LEASE_SECONDS = 120` (`server/_core/workflowRuntime.ts:360-405`).
  Drain: `startDrainWorker` `server/_core/drainWorker.ts:151`, `maxAttempts 5`, dead letter.
  Handlers: `DomainEventHandler { name, matches, handle }` + `withHandlers(ports, handlers)`
  `server/_core/workerLifecycle.ts:34-50`; `productionWorker.ts:18-26` registers exactly one
  (`aggregateType === "enforcementEvent"`); `startOnce` guarantees a single claimer.
- **Webhooks.** `webhookSubscriptions` `schema.ts:5543`, `webhookDeliveries` `:5556`,
  `dispatchWebhooks`/`sweepWebhookRetries` `server/webhookDispatchService.ts:23/60`.

### 1.11 Audit ledger

There is **no single general-purpose audit ledger**; the pattern is one cross-cutting authorization
log plus per-domain event tables:

- `authorizationDecisions` `schema.ts:3104` — one row per `roleProcedure` call
  (`server/_core/trpc.ts:71-120` → `recordAuthorizationDecision` `server/db.ts:1377`);
  `outcome ∈ {allowed, denied_no_role, denied_permission, denied_scope, denied_unauthenticated}`;
  sensitive permissions fail closed when the row cannot be written.
- Per domain: `dispatchAuditEvents` `:2086`, `externalAccessLog` `:5082`, `evidenceAccessEvents`
  `:3041`, `restrictedAccessEvents` `:8785` (written before content is served), `signatureAudits`
  `:363`, and ~28 more `*Events` tables.
- **Hash-chained example** to copy: `academyAuditEvents` (`previousHash`, `eventHash`) written by the
  `audit()` helper at `server/trainingAcademyRouter.ts:83-89` (`stableHash({…, previous})`).
- Sealing/hashing utilities: `sealEvidence` `server/_core/evidenceSeal.ts:139`; `canonicalJson`,
  `sha256`, `assemble` `server/_core/auditPackage.ts:63`; `agentActions.payloadHash`;
  `assistantCommitReceipts.fieldManifestHash`.

### 1.12 Approval / action gateway patterns

- **Action gateway (pure).** `server/_core/actionGateway.ts`: `RiskLevel = read | prepare |
  low_risk_action | approval_required | restricted` (`:35`); `CapabilityDefinition { key, riskLevel,
  requiredPermissions, requiresOnline, idempotent }` (`:42`); `NEVER_AUTONOMOUS = [compliance.override,
  hos.ignoreViolation, inspection.bypassFailure, maintenance.clearOutOfService, audit.delete,
  safety.clearViolation]` (`:60`); `InstructionAuthority ∈ {system, leaseos_policy, company_policy,
  authorized_user, workflow_data, external_content}`, `MAY_INSTRUCT` (`:86-94`; `external_content` and
  `workflow_data` may never instruct); `decide(request, ctx): Decision(allow | deny | require_approval |
  compliance_block | stale)` (`:150`, strictest first; unregistered → deny; unknown compliance → block);
  `approvalCovers` (`:243`, bound to `payloadHash`); `idempotencyKey` (`:285`); `detectNoProgress` (`:301`, unwired).
- **Agent runtime (live, executes nothing).** `agentRuns` `schema.ts:7143` (13-value status,
  `maxSteps` default 40 never read), `agentSteps` `:7162`, `agentActions` `:7175` (`origin`, `decision`,
  `outcome ∈ {requested, accepted, executed, verified, failed}` never advanced), `agentApprovals`
  `:7198` (`payloadHash`, `decision ∈ {pending, approved, rejected}`). `server/agentRouter.ts`: `CAPABILITIES`
  (`:64-71`, six entries), `TRANSITIONS` (`:76-88`), `requestAction` (`:125-260`; forces `origin =
  "authorized_user"`, `compliance = null`, `actor.type = "agent"`, `autoExecute: []` at `:229`),
  `decideApproval` (`:263-283`; requester may not approve a `NEVER_AUTONOMOUS` capability). Permissions
  `agent.use / agent.act / agent.approve (sensitive) / agent.read` (`recordsAuthorization.ts:2741-2745`).
  Header `:16-19`: "Deliberately absent: any capability that executes."
- **Proposal → commit (the live executing AI path).** `assistantProposals` `schema.ts:2182`
  (`commitState ∈ {drafting, awaiting_answers, awaiting_readback, committed, rejected}`,
  `overreachFlags`), `proposalFields` `:2235` (`source`, `status`, `precision`), `assistantCommitReceipts`
  `:2281` (`proposalId` **unique** — the idempotency boundary; `targetType ∈ {trip_stop, maintenance_defect,
  expense_record, disposal_ticket, fuel_transaction}`). `executeAssistantCommit` `server/_core/assistantCommitService.ts:114`
  (locks the proposal, replays on receipt, re-authorizes the target permission, writes
  `authorizationDecisions`, performs the domain write, inserts the receipt). New domains add a form in
  `FORMS` (`aiProposal.ts:112`), an intent variant and an adapter in `planAssistantCommit`
  (`assistantCommitAdapters.ts:785`; default case "generic writes are forbidden"), and a `targetType` value.
- **Automation policy (the existing autonomy-level concept).** `AutomationMode = AUTO | HYBRID | MANUAL`
  (`server/_core/automationPolicy.ts:31`); `SCOPE_ORDER = [tenant, role, task, customer]` (`:43`);
  `resolveAutomation` (`:131`; entitlement → ceiling → tenant → role → task → customer; entitled-but-unconfigured
  is MANUAL); `evaluateOperationalOverride` (`:220`, only toward MANUAL); `SAFETY_CEILINGS = {}`
  (`automationPolicyStore.ts:32`, "P8.4 decides the list"); tables `capabilityEntitlements` `schema.ts:8684`
  (three-valued) and `automationPolicies` `:8698` (append-only, `safetyCeilingApplied`); router
  `server/automationPolicyRouter.ts` (`resolve`, `set`, `setEntitlement`, `operationalOverride`, `history`,
  `snapshotFor`). Only live consumer: `readinessComposer.ts:859`. **Not connected to
  `GatewayContext.autoExecute`.** `docs/register/SPINE_WIRING_PLAN.md` "Automation safety floor": six of
  eight owner-named capabilities map to existing keys; TDG and permit validity have no key.
- **Never-automatic floor (second list).** `NEVER_AUTOMATIC = [assign_person, approve_leave,
  schedule_payment, change_payroll, resolve_compliance]` (`server/_core/secretaryCoordination.ts:47`),
  kept consistent with `NEVER_AUTONOMOUS` by `floorDisagreements()` (`:238`). `validatePolicy` throws
  `PolicyExceedsFloor` ("a policy may narrow what is automatic and never widen it").
- **Two-person commercial approvals.** §1.9.
- **Workflow engine.** `attemptTransition` `server/_core/workflowEngine.ts:456` guards a
  `WorkflowDefinition { initial, transitions, terminal, evidenceRequired }`; **`actorSource === "ai"`
  can never pass an evidence gate** (`:494-500`); `WORKFLOWS` is a hard-coded constant of four
  workflows (`:363`); `workflowInstances`/`workflowTransitions` have no non-test writer. The rules →
  tasks half (`evaluateRules` `:141`, `planTasks` `:229`, `operationalTasks` `schema.ts:2374` with
  `dedupeKey`) is generic and live via `workflowRuntime.applyEventConsequences` (`:206`).

### 1.13 AI / LLM infrastructure and agent tool calling

- **One live model door.** `invokeLLM(params: InvokeParams): Promise<InvokeResult>`
  `server/_core/llm.ts:345`, raw `fetch` to `${ENV.forgeApiUrl}/v1/chat/completions` (falls back to
  `https://forge.manus.im/…`, `:220-223`); `tools`/`tool_choice` pass through at the wire level
  (`:372-382`) but **no caller passes tools and nothing handles `tool_calls`**; 4-retry backoff
  (`:307`); no timeout; `usage` returned, never stored or capped. Only call site:
  `fieldRoute.assistant.draft` `server/routers.ts:690` (inside a request handler; pinned as the one
  allowed violation by the worker-boundary test in PR #7).
- **Provider selection (unwired).** `modelGateway.route({task: ModelTask, providers, deployment}): Routing`
  `server/_core/modelGateway.ts:126`, `ModelTask ∈ {reason, code, fast_chat, verify, transcribe, speak,
  embed, extract}`, licence-gated, `verifierFor` refuses same-model verification (`:183`).
  `engineReachability.test.ts:62`: "no AI provider is configured yet".
- **Prompt registry.** None on `main`; the live system prompt is built inline by `buildSystemPrompt`
  (`server/_core/assistantExtraction.ts:103`), unversioned and unhashed. `outputSchema` with
  `additionalProperties: false` (`buildOutputSchema` `:52`); `parseExtraction` (`:169`) drops
  undeclared keys.
- **Tool registry.** `docs/register/AI_RUNTIME_TERMINOLOGY.md` §2.4/§5 describes `ToolDefinition { key,
  category ∈ read|propose|human_step, procedure: ProcedureName, formKey?, requiresIdempotencyKey }`,
  `SECRETARY_TOOLS`, `resolveTool(allowlist, key)`, `TaskAllowlist { taskKey, toolKeys, stepBudget }`,
  `invokeTool({ ctx, state, invocation, createCaller })` in `server/_core/ai/tools/`. **NOTE: that
  directory does not exist on `main`**; it lives in open PR #7 (`claude/secretary-model-dialogue-yzszcv`,
  head `929f721`), declared unwired under the moratorium. `docs/register/SECRETARY_SPINE_MORATORIUM.md`
  is likewise cited but present only on that branch.
- **Context.** `admitSource({resolvers, sourceKind, sourceRef, acting, at, blockRef})`
  `server/_core/contextAdmission.ts:118` (branded `AdmittedContextBlock`; same not-found answer for
  absent, foreign and forbidden; no generic `admit()`); `assembleContext({tenantId, blocks})`
  `server/_core/contextAssembly.ts:123` (`BlockKind → InstructionAuthority` via `AUTHORITY_OF` `:41`:
  `retrieved_document` and `external_message` are `external_content`, which may never instruct;
  throws `CrossTenantContext`; `detectForbiddenEcho` `:203`) — **no production caller**. Knowledge
  tiers A–F (`server/_core/knowledge/admission.ts:34`; F = "AI inference, driver observation,
  third-party", never binding).
- **Clarification.** `assistantQuestions` `schema.ts:3709` (`reason ∈ {missing_required, low_confidence,
  precision_unresolved, sensitive_human_only, ambiguous_classification}`), `persistQuestions` /
  `answerQuestion` `server/questionQueueService.ts:18/72` (answerer must be the person asked;
  **no production caller**; keyed by `proposalId`+`fieldKey`).
- **Escalation.** `escalationOutcome` `server/_core/escalation.ts:86` (unwired), `DEFAULT_CRITICAL_POLICY`
  (`:51`, reached via `enforcementOutbox`), `mayOptOut` (`:132`).
- **Named gaps** (`AI_RUNTIME_TERMINOLOGY.md` §19): run-provenance columns (`providerKey, modelId,
  promptVersion, promptHash, inputHash`), persisted tool result, tool version, inference telemetry,
  budget enforcement, composition root for `createCaller`. §20: "Any 'AI memory', conversation store or
  reasoning store — intentionally unsupported."

### 1.14 Authorization and tenant scoping (adding a procedure)

`roleProcedure(name: ProcedureName)` `server/_core/trpc.ts:71` (permission looked up at wiring time,
unmapped procedure throws; `authorize()`; `recordAuthorizationDecision`); `externalProcedure` `:156`
(portal token, `ctx.external`); `integrationProcedure` `:227` (`x-integration-key`, `ctx.integration`).
Vocabulary in `server/_core/recordsAuthorization.ts`: `DomainRole` (`:26`, 15 roles, **no `sales`**),
`Permission` (`:45`), `GRANTS` (`:349`), `UNIVERSAL_PERMISSIONS` (`:1668`), `SENSITIVE_PERMISSIONS`
(`:1737`), `OPERATIONAL_PROCEDURE_PERMISSIONS` (`:2182`, 634 entries pinned at
`server/procedureAuthorization.test.ts:161`), `EXTERNAL_PROCEDURE_PERMISSIONS` (`:2986`, 36 pinned
`:252`). A new router file must be added to the test's source list and `OPERATIONAL_SOURCES` (`:82`);
`PROCEDURE_AUTHORIZATION_INVENTORY.md` must be updated (read by `server/documentationTruth.test.ts`).

### 1.15 Offline synchronization

Device captures sync as `CaptureKind` (`client/src/runtime/contracts.ts:28`: pretrip, hos_event,
load_ticket, signature, …) through `syncPackages` `schema.ts:2864` (state ladder `queued → … →
office_accepted`), `syncPackageItems`, `syncReceipts`, `deviceSyncNonces`; conflicts via `detectConflict`
`server/_core/fieldDevice.ts:198` → `syncConflicts` `schema.ts:4086`, resolved by a person.
`offlineCapability.ts:31`: `OfflineClass = local_safe | local_capture | local_prepare |
server_authoritative`; `envelopeFor` throws `DeviceAuthorityRefused` for `server_authoritative`
(unwired, SPINE item 3). `NEVER_IN_ROADSIDE_PACKAGE = ["payroll","personnel","billing","invoice",
"rate_card","tax","claims_reserve","premium"]` (`fieldDevice.ts:331`). Six client sync states pinned
(`contracts.ts:22`).

### 1.16 Document storage and vendor documents

`storagePut(relKey, data, contentType) → { key }` `server/storage.ts:51` (Forge presigned S3; key
persisted, URLs never); `storageGetSignedUrl` `:94`; `isValidStorageKey` `server/_core/storageKey.ts:20`.
Tables: `evidenceRecords` `schema.ts:48` (+ `evidenceVersions` `:2756` `contentHash`, `evidenceSeals`
`:2772`), `complianceDocuments` `:180` (`ownerType ∈ {operator, unit, job, trailer, carrier, user,
equipment}` — **no vendor/subcontractor/organization owner type, no tenant column**),
`commercialDocuments` `:8633` (`bookOrgRef`, `documentType` seeded `invoice, credit_note, statement,
manifest, field_ticket, disposal_ticket, vendor_bill, purchase_order, remittance, audit_package`
(`0144:80-89`), `contentHash` NOT NULL, `counterpartyOrgRef`, `retentionPolicyId`, version chain),
`commercialDocumentLinks` `:8659`, `commercialDocumentDeliveries` `:8667`, `insuranceCertificates`
`:4383` (certificates **we issue** to customers, `recipientCustomerRef` free text). **No table holds a
customer's vendor-application package, a customer's insurance/safety requirement, or our submitted
prequalification documents.** `attachmentAuthorization.ts` (`NEVER_ATTACHABLE` `:44`: payrollDocument,
employeeRecord, clientContract).

### 1.17 Migrations, branches and PRs

- Files: `drizzle/0001…0169`, then `0170_dispatch_role_types`, `0171_dispatch_role_assignment_events`,
  `0174_dispatch_override_provenance` on `main`. `0172/0173` are absent on `main` because C1a moved its
  migration `0172 → 0174` when `claude/training-academy-workforce-q3mdse` claimed 0172/0173
  (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`). Reserved and never used: `0016`, `0017`
  (CI gate 0). Historical gaps `0094/0095/0098`; `0157` used twice. `drizzle/meta/_journal.json` is
  frozen legacy (17 entries) and must not be updated; `scripts/apply-migrations.sh` applies
  `ls drizzle/*.sql | sort`; `server/_core/migrationLedger.ts` refuses on `DRIFT` (never edit an
  applied file).
- CI gates (`scripts/ci-gate.sh`): parity (`mysqlTable(` count = `CREATE TABLE` count across
  `drizzle/*.sql`), tsc, zero bare `protectedProcedure`, vitest with no skipped `.db.test.ts`, and
  regeneration of `LEASEOS_CURRENT_STATE.md` with a fail-on-diff. A new `_core` module must be reached
  from production or declared in `DECLARED_UNWIRED` with the pinned count (`engineReachability.test.ts:302`,
  currently 57). `server/_core/degradationSuite.test.ts` enumerates capability keys from source and
  **fails on any capability added without a degradation case**.
- **Migration claims across every remote branch** (scan run in this session after
  `git fetch origin --prune`, using the register's own script):

  | Number | Branch(es) |
  |---|---|
  | 0170 | `claude/leaseos-auth-workspace-system-t008ad`, `claude/work-calendar-task-engine-0mtjyk` (both collide with `main`) |
  | 0172, 0173, 0174, 0175 | `claude/training-academy-workforce-q3mdse` (**its 0174 collides with `main`'s 0174**) |
  | 0175, 0176 | `claude/driver-portfolio-credential-wallet-ya8928` (PR #16) |
  | 0175, 0176, 0177 | `claude/driver-portfolio-api-ya8928` |
  | 0178, 0179, 0180 | `claude/document-control-architecture-jlffzk` |
  | 0179 | `claude/eld-compliance-intelligence-ramlrd` |
  | 0179 | `claude/migration-0169-reconciliation` (PR #17, `0179_trip_stop_provenance.sql`) |

  **The highest number claimed anywhere is 0180.** The register on `main` is stale (it predates the
  0174 collision and the three 0179 claims). Per the register's rule, this design assigns **no**
  migration numbers; each implementation branch takes the next number free on `main` and on all open
  branches at its own rebase and records it in the register.
- Open PRs (2026-09-23): #7 AI Secretary model layer (declared unwired), #15 C1a docs, #16 Driver
  Portfolio, #17 migration 0169 reconciliation + SPINE item 1 receipt reader. Nothing open touches
  sales, contacts, quotes, outreach or `resourceBookings`.

### 1.18 Existing specs touching this capability

- `docs/knowledge/INDEX.md` row 42 — "Sales, estimating, tendering, business development — SPEC":
  the document is **not on disk**; it must be fetched before build, not inferred.
- `docs/register/ROADMAP_2026-09-21.md` **Planned**: "Customer intake: AI booking line, self-serve
  portal, customer API — PLANNED — Only `portalSubmissions`; `resourceBookings` is resource
  scheduling, unrelated." **Product not built**: contact directory; customer alerts by email or SMS.
- `docs/REMAINING_BUILD_REGISTER.md` ground rules: "inspect before building; additive changes; one
  source of truth; provenance on every important value; PROPOSE → SHOW EVIDENCE → HUMAN CONFIRM →
  COMMIT; UNKNOWN stays UNKNOWN". P9 (AI runtime backlog): "none is SPINE work, and none may be built
  ahead of the spine."

---

## 2. Existing components to reuse

| Need | Reuse | Why it fits |
|---|---|---|
| Tenant scoping | `resolveActingScope`, `orgRef`/`bookOrgRef` convention, `orgScopeWhere`, `recordBelongsToOrganization`, the `tenantScope*.db.test.ts` pattern | Every new table carries `bookOrgRef` (the business keeping the record about another organization), exactly like `vendors` and `commercialDocuments`. |
| Organization identity | `organizations` + `commercialOffice.organizations.create` + `organizationCommercialRoles` + `organizationRecordLinks` | A prospect is an `organizations` row that does not yet hold the `client` role; promotion to customer is `roles.assign(client)` + `customerAccounts` creation, no new identity. |
| Contacts | The Contact Directory build plan (`people`, `contact_methods` with classification) | Sales outreach targets a `contact_methods` row of classification `public_work`; the design adds **no** contact table. |
| Authorization | `roleProcedure`, `Permission`, `GRANTS`, `SENSITIVE_PERMISSIONS`, `OPERATIONAL_PROCEDURE_PERMISSIONS`, `authorizationDecisions` | New `sales.*` procedures and permissions follow the eight-step recipe in §1.14; a `sales` `DomainRole` is the "forward addition" `portalComposition.ts:189` anticipates. |
| Agent authority | `actionGateway.decide`, `CapabilityDefinition`, `NEVER_AUTONOMOUS`, `agentRuns/agentSteps/agentActions/agentApprovals`, `agentRouter.TRANSITIONS`, payload-hash-bound approvals, `idempotencyKey` | The sales agents are agent runs with sales capabilities registered in the same registry; no second gateway. |
| Autonomy levels | `AutomationMode`, `automationPolicies`, `capabilityEntitlements`, `SAFETY_CEILINGS`, `evaluateOperationalOverride`, `automationPolicyRouter` | Beta levels 0–7 become named **presets** that write entitlements and policies for `sales.*` capabilities (the roadmap's "automation onboarding presets — PARTIAL"). Never-automatic actions become safety ceilings and `NEVER_AUTONOMOUS` entries. |
| Model-facing tools | PR #7's `ToolDefinition { procedure: ProcedureName, category ∈ read|propose|human_step }`, `resolveTool`, `TaskAllowlist`, `invokeTool({createCaller})` | `SALES_TOOLS` is a second allowlist in the same registry shape; the model still never names a procedure. |
| Proposals and clarification | `assistantProposals`, `proposalFields`, `assistantCommitReceipts` (unique `proposalId`), `FORMS`, `planAssistantCommit`, `assistantQuestions`, `persistQuestions` | Every AI-drafted message, quote line set or booking request is a proposal with a form; commit goes through `executeAssistantCommit` with a new adapter and `targetType`. |
| Context | `admitSource` resolvers, `assembleContext` with `AUTHORITY_OF` (external messages are `external_content`), `detectForbiddenEcho`, knowledge tier F rule | Inbound customer email is admitted as `external_message` and can never instruct. |
| Pricing | `resolveRate` + `priceQuantity` over `chargeDefinitions`; `pricingDecisions.subjectKind = "quote_line"` (present, unused); `simulateMargin` + `commercialSetupProfiles.discountAuthorityJson`; `commercialApprovalService.decide` with the seeded, unused `rate_override` category; `quotes`/`quoteLines`/`quoteIssue` snapshot hash; `portal.quoteAccept` | The Quote Agent is a projection onto the resolver the roadmap already wants quotes on (step 5); discount authority and two-person approval exist and are unused. |
| Credit / terms facts | `commercialBillingCheck`, `aging`, `customerAccounts` columns | Authoritative answers to "can we take this work on account". |
| Availability and eligibility | `composeReadiness` (via `dispatch.readiness` preview), `DispatchEligibility`, `computeEligibilityFingerprint`, `assessEligibilityValidity(maxAgeMinutes)`, `detectBookingConflicts`, `resourceBookings.bookingState = 'tentative'`, `awardAssignment` | The booking hold is a `tentative` booking carrying the readiness fingerprint; conversion is the existing award path. |
| Location and route | `parseLsd`, `geo.lsdLocate`, `locationIdentities`, `geo.routeCompute` (distance), `spatial.routeEvaluateSegments`, `routeApprovals` staleness | The conversation agent's "map the LSD, check the road" is three existing procedures; travel time stays UNKNOWN until a routing source exists. |
| Signals and provenance | `externalDataSources` + `evaluateSourceUsage` + `assessFreshness` + `geo.sourceReview`; `ingestFeed` / `externalFeedRuns` / `roadAdvisories` row shape; `knowledgeSources` + `checkSourceGate`; `inboundRouter.ingest` (idempotent, hashed, becomes a proposal) | Regional activity signals are advisories with a source key, run ref, content hash and supersession; external activity feeds stay blocked until licence review. |
| Opportunity ranking | `fundingIntelligence.matchProgram` shape: `strength ∈ {strong, possible, more_information_required, excluded}`, `reasons[]`, `missingInformation[]`, verification caveat, status ladder, "unverified can never be strong" | Ranking by explainable strength, not an opaque score. |
| Outbox and worker | `domainEventOutbox`, `emitDomainEvent` inside the transaction, `withHandlers` + a `DomainEventHandler` in `productionWorker.ts`, `startOnce`, dead letter | Sending, model calls and hold expiry run in the worker behind the outbox, never in a request handler (the boundary the terminology doc names). |
| Audit | `authorizationDecisions` (free with `roleProcedure`), `agentActions`, hash-chained `academyAuditEvents` pattern, `canonicalJson`/`sha256` | One hash-chained `salesAuditEvents` table per the academy pattern; no parallel ledger. |
| Approval ledger | `commercialApprovals` + `decide()` with separation of duties | Discount beyond envelope, credit terms, contractual commitments. |
| Delivery record | `commercialDocuments` (a new seeded `documentType` for `quote` and `vendor_application`) + `commercialDocumentDeliveries` | Quotes and prequalification packages are registered documents with deliveries recorded. |
| Two-person rules | `mayApprove`, `budgetApprove` ("author may not approve"), `overrideGrant` (grantor ≠ requester), `accessDecide` | Every sales gate that involves money or commitment uses the same separation. |
| Surface | `portalComposition.sales_customer` slot, `PortalShell`, `CommercialOffice` page | A sales surface lives at `/portal/sales_customer`; the map gains opportunity markers next to the routing-status `MapSurface`. |

---

## 3. Gaps requiring new development

Ordered by how much the rest depends on them.

| # | Gap | Evidence | Depends on |
|---|---|---|---|
| G1 | **No contact entity.** No `people`/`contact_methods`; no consent or suppression state anywhere; no field to record where a contact came from. | §1.2; grep for `casl`, `opt-out`, `suppress`, `consent` finds only `complianceConsents` (worker privacy) and escalation opt-out | Contact Directory build plan (product not built) |
| G2 | **No prospect / relationship / opportunity record.** `customerAccounts` requires a financial entity and has no `prospect` status; no lead, opportunity, vendor-application or activity-signal table. | §1.1, §1.8; `fundingOpportunities` is the only opportunity-shaped table and is program-specific | G1 for contacts; organization master for identity |
| G3 | **No outbound transport of any kind** (email, SMS) and no inbound message intake. `commercialDocumentDeliveries` and `workflowNotifications.channel` are records, not senders. No `INBOUND_FEEDS` kind for a message. | §1.10 | Outbox handler pattern; a transport port with no provider chosen |
| G4 | **No deterministic outreach policy.** Nothing decides whether a communication may be sent; jurisdiction, sender identification, contact source and suppression are unmodelled. | §1.2, §1.10 | G1 |
| G5 | **No sales role, sales permissions or `sales.*` procedures.** `DomainRole` has no `sales`; `portalComposition` composes the slot from office/management. | §1.14 | Authorization recipe |
| G6 | **No sales capabilities in the gateway and no sales tools.** `CAPABILITIES` has six entries, none sales; PR #7's tool registry is unmerged; no worker handler runs a model. | §1.12, §1.13 | PR #7 or equivalent; moratorium |
| G7 | **Quotes do not use the deterministic resolver;** explicit lines bypass every check; `rate_override` approval is unused; no quote expiry; no internal acceptance path; no `quote` document kind. | §1.9 | Roadmap step 5 |
| G8 | **Booking holds.** `tentative` is never written; `resourceBookings` lacks `orgRef`, expiry, actor, source, and any lock finer than the posting (two postings booking the same unit are not serialised). No expiry sweep. | §1.4 | Dispatch award transaction |
| G9 | **Availability is not computed.** `operatorAvailability` is schema-only; readiness answers `availability_not_declared` and `hos_unknown` for everyone; HOS clocks are never consulted by the composer. | §1.5 | SPINE dispatch gate; P9 verified HOS |
| G10 | **No job intake state.** `jobs.status` starts at `dispatched`; no requested start, LSD FK, service code FK or customer FK; `jobs.customer` is text. | §1.4 | Additive columns or a separate intake record |
| G11 | **No region/yard/base entity, no proximity query over anything but facilities, no travel time.** | §1.7 | Spatial foundation; routing source decision (P2.1) |
| G12 | **No regional signal ingestion; activity sources are licence-blocked;** no per-customer history metrics. | §1.8 | `geo.sourceReview`, feed family (off-spine, unwired) |
| G13 | **Model-call provenance and telemetry** (provider, model, prompt version/hash, input/output hash, usage) have no columns; tool results are not persisted; run budgets are not enforced. | §1.13, terminology §19 | Door 2 wiring (SPINE-blocked) |
| G14 | **Vendor-application documents.** No owner type for organizations on `complianceDocuments`; no record of a customer's requirements or our submitted package. | §1.16 | `commercialDocuments` document types |
| G15 | **Web chat for prospects.** `externalProcedure` requires an account-bound identity; prospects have none. | §1.2 | Deferred; email first |

Each gap maps to a checkpoint in `docs/register/AI_BUSINESS_DEVELOPMENT_DESIGN.md` §15.
