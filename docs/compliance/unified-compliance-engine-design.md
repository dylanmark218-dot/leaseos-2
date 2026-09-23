# LeaseOS — Unified Compliance Engine: Design (Checkpoint 0)

Status: **design only**. No production code, no migrations, no seeds changed by this checkpoint.

| | |
|---|---|
| Surveyed at | `main` = `006069057b8a245ce00c0453d500f1e69c9e916c` (release `v23.25`), branch `claude/leaseos-compliance-survey-5faxe8` |
| Migration head on `main` | `0168_retire_storage_capability_urls.sql` (165 files; 0016/0017 reserved and absent; 0094/0095/0098 unused numbers; 0157 used twice) |
| Open work read | PRs #4, #5, #6, #7, #9 and branches `claude/leaseos-auth-workspace-system-t008ad`, `claude/spine-boundary-confirmation`, `docs/dispatch-assignment-model-design` |
| Companion | `docs/compliance/unified-compliance-engine-implementation-plan.md` |

The question the platform must answer is not "is this compliant?". It is:

> Is this person, vehicle, trailer, carrier, load, route and job authorized to perform this operation at this
> time under the applicable **verified** requirements, and if not, which requirement, from which authority,
> in which version, on what evidence, is unmet, and what must happen next?

LeaseOS already answers most of the parts of that question. It answers them in several places, in several
vocabularies, and with some connections missing. This design **reconciles** what exists. It does not add a
parallel engine.

---

## 0. A binding constraint the prompt did not mention: the SPINE moratorium

`docs/register/SPINE_WIRING_PLAN.md` lives in the sibling `leaseos` repository. It is quoted in
`docs/register/SECRETARY_SPINE_MORATORIUM.md` (PR #7) and `docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`
(branch `claude/spine-boundary-confirmation`). It says:

> "The moratorium stands: **no new engines until this path is wired.**"

The plan's item 2 is "resolve the four duplications". One of the four is `complianceDocumentValidity`.
All thirteen spine engines are still `DECLARED_UNWIRED` in `server/engineReachability.test.ts`.

Consequences for this initiative:

* Checkpoint C1 is written so that it is **not a new engine**. It adds a typed contract over the existing
  composer. It fixes defects in that composer. It resolves the `complianceDocumentValidity`/passport duplication,
  which is SPINE item 2 work.
* C2 and later add real engine surface: permits, discrepancies, findings, wallet. Whether they may start before
  the spine is wired is **owner decision D-01**. This document does not assume the moratorium is lifted.

---

## 1. Current-state survey

References are to `main` at the SHA above. "Unwired" means it is listed in `DECLARED_UNWIRED`
(`server/engineReachability.test.ts`).

### 1.1 Compliance kernel

* **Requirement registry** (`0036`, `0037`, `drizzle/schema.ts:4028`).
  * `complianceRequirements` has `requirementKey`, `version` (unique with key), `family`, `subjectType`,
    `jurisdiction` (`*` = any), `appliesWhenJson`, `satisfiedByDocTypes`, `renewalIntervalDays`,
    `warnDaysBeforeExpiry`, and `missingSeverity` (`review|blocked`).
  * It also has `sourceAuthority`, `sourceUrl`, `sourceReference`, `effectiveFrom/Until`, and
    `verificationStatus` (`unverified|verified|superseded|withdrawn`), plus `packKey`.
  * **No org column, no content hash, no authority tier.**
* **Packs.**
  * `compliancePacks` has `activatesWhenJson`, `jurisdiction` and `core`.
  * `companyPackActivations` is keyed by `financialEntityId`.
  * Composition is a **union**. There is no precedence between packs.
* **Evaluators.**
  * `server/_core/compliancePassport.ts`:
    * `requirementApplies`, `evaluateRequirement`, `buildPassport`, `composeJobPassport`.
    * `ItemStatus` has 9 values: `satisfied|expiring|expired|missing|evidence_unverified|evidence_rejected|evidence_withheld|requirement_unverified|not_applicable`.
    * Item effect is `none|review|blocked|unknown`.
    * An unverified requirement evaluates to `unknown` and is never green. This is correct fail-closed behaviour.
  * `server/_core/requirementEngine.ts`:
    * `requirementsInForce`.
    * `evaluateWorkContext` returns `authorized|review|blocked|unknown`.
    * Also `equipmentAuthorization`, `calibrationStatus` and `calibrationEffectOnUse`.
* **Loader defects.**
  * `workAuthorization` reads **seed constants, never the table** (`requirementRouter.ts:137`).
  * `packActivate` validates against seeds, not the `compliancePacks` table (`:110`).
  * `loadRequirements` ignores `packKey` and version.
  * The `SUBJECT` zod enum lacks `equipment|attachment|work_context`.
* **Versioning.**
  * `compliance.requirementLoad` inserts version + 1 and **mutates** the prior row to `superseded`.
  * Verification is **single-person, self-attested**: `sourceVerified: true` plus a non-empty authority.
* **Seeds.** `complianceRequirementSeeds.ts` seeds every requirement `unverified`, v1, effective 2026-01-01.

### 1.2 Seven verification ladders

Each ladder has its own status vocabulary.

| Store | Status vocabulary | Two-person | Point-in-time | Hash |
|---|---|---|---|---|
| `complianceRequirements` | unverified/verified/superseded/withdrawn | no | partial (row mutated) | no |
| `hosRuleProfiles` + `hosRuleLimits` | unverified/verified/superseded | **yes** (`hos.limitPromote`, `hos.profileVerify`) | via ledger | no |
| `hosRuleLimitHistory` (0120, immutable ledger) | FUTURE/CURRENT/EXPIRED/REVOKED/SUPERSEDED | **yes** | **yes**: `believedOn(profile, limit, at)` | no (citation fields only) |
| `externalDataSources` (0024/0080) | unverified/verified/superseded/withdrawn | no (`geo.sourceReview`) | imports have effective windows | import checksums |
| `knowledgeDocuments` / `knowledgeVersions` (0118) | QUARANTINED → … → VERIFIED/PUBLISHED/REJECTED | no | `effectiveFrom/Until`, supersedes chain | **contentHash** |
| `roadRestrictions`, `structures` | unverified/verified(/superseded) | no | effective windows | route fingerprint |
| `regulatoryThresholds`, `taxRules` | unverified/operator_supplied/authority_confirmed | no | — | — |

The immutable HOS promotion ledger is the only mature pattern:

* It has citation, instrument version, verification method, FUTURE status and separation of duties.
* `server/_core/knowledge/promotionLedger.ts` (`validateEvidence`, `promote`, `believedOn`, `divergences`,
  `pendingFutureRules`) implements it.
* It is **the pattern to generalize**, not to copy.

### 1.3 Three partial authority ladders

1. **Knowledge** (`knowledge/admission.ts:34`): `law > official_guidance > recognized_standard = manufacturer > company_policy > operational > unverified`.
   Employer, client and site are lumped together.
2. **Road posture** (`sourcePrecedence.ts:23`, unwired): `posted_road_authority > official_restriction > operator_instruction > leaseos_field_hazard > open_map_data`.
   This one is correct and asymmetric: any source may tighten, only a higher one may loosen.
3. **HOS profile** `authorityLevel`: `federal|provincial|territorial`. This is jurisdiction, not authority.

None of them separates *regulator order*, *permit/exemption*, *carrier policy*, *client*, *site*, *company*
and *best practice*.

### 1.4 Dispatch readiness: the one composer, with gaps

* **The composer.** `server/readinessComposer.ts` `composeReadiness(subject, now)` is the canonical composer.
  * It is called by `dispatch.readiness|evaluate|award|whatAmIMissing`, `jobUnits.create` (via
    `dispatchEnforcementService`), `portal.preClearance` and the widgets reader.
  * It feeds `server/_core/dispatchReadiness.ts` `evaluateDispatchReadiness` with a typed `ReadinessInput`.
  * The contributing engines are academy, medical, device, insurance, roadside, calibration, telematics,
    enforcement, route, comms and the capability layer.
  * Each engine appends `DispatchBlocker`s.
  * `DispatchBlocker` carries `code, label, severity(blocking|review|unknown), subject, overridable, overrideAuthority`.
  * The verdict is `eligible|eligible_review|blocked|unknown`.
* **The client does not duplicate the logic.** No client code calls `dispatch.*`; the only readiness UI is the
  customer portal projection. PR #5 adds a dispatcher panel that renders server output.

Verified defects on `main`:

| # | Defect | Evidence | Status |
|---|---|---|---|
| R-1 | **Active government OOS orders never reach dispatch.** `ReadinessSubject.enforcement` is optional and no production caller passes it. | `readinessComposer.ts:74,412`; callers `dispatchRouter.ts:53,68,134,169`, `portalRouter.ts:300`, `dispatchEnforcementService.ts:52` | **Fixed on PR #4** (`loadEnforcementState` reads `enforcementEvents`/`outOfServiceOrders`), not merged |
| R-2 | **The override grantor is not recorded.** `overrideGrant` updates only `granted`/`refusalReason`. `award` then rebuilds `grantedByUserId` from `requestedByUserId`. | `dispatchRouter.ts:113,136` | **Open on every branch**, including #4 and #9 |
| R-3 | `mergeBlockers` dedupes by `code`, first wins, so a later, stricter blocker with the same code is dropped. | `readinessComposer.ts:621-623` | open |
| R-4 | `blockersForUnevaluatedRequired` sets `minimumRole:"supervisor"` behind a cast instead of `overrideAuthority`. | `readinessCapabilities.ts:208` | open |
| R-5 | Insurance, enforcement, telematics faults, roadside, calibration and medical are **not in `EligibilityFacts`**, so a change in them does not stale a check inside its 30-minute window. `permitVersion`, `materialClassificationVersion` and `destinationAcceptanceVersion` are always `"none"`. | `dispatchAward.ts:27-61` | open |
| R-6 | "Overridable" `blocking` blockers such as `route_approval_stale` can never be awarded (`decideAward` refuses every `blocking` blocker). The override class is implicit. | `dispatchAward.ts:211`, `readinessComposer.ts:481` | open |
| R-7 | Some inputs are hard-coded: `permitRequired:false`, `permitOnFile:null`, `hoursAvailableMinutes:null`, `availabilityDeclared:false`. Dangerous goods are detected by **regex on job type/mode**. | `readinessComposer.ts:227,403-404,532` | open; violates "never infer DG from free text" |
| R-8 | `dispatchEnforcementService` recomputes facts without `routeApprovalRef`, so route-bound checks fingerprint-mismatch in enforced mode. | `dispatchEnforcementService.ts:52` | open |
| R-9 | The licence **class and endorsements are not checked** in the composer. `driverTraining.evaluateDriverQualification` does check them, but is fed a client-supplied profile and never reads the DB. | `complianceRouter.ts:300`, `driverTraining.ts:246` | open |
| R-10 | Shift readiness (`readiness.forShift|forTime`, `shiftReadiness.ts`) is a **second readiness system**. It has its own `CheckState` and does not call `composeReadiness`. | `readinessRouter.ts` | open (owner decision D-06) |
| R-11 | `unitHeld` on incidents is not read by the composer. | `recordsRouter.ts:465` | open |

Fingerprints: three canonical-JSON hashers exist. They are `structures.ts` (sha256, route), `commPackage.ts`
(sha256) and `dispatchAward.ts` (**FNV-1a 32-bit**, the eligibility fingerprint).

### 1.5 HOS

* **Engine.** `server/_core/hos.ts` is pure and good.
  * It has 16 **separate** clocks (no `hoursRemaining`).
  * `selectProfile` returns `selected|unknown(missing[])|conflict`.
  * `determine` returns `unknown` if any limit is unverified.
  * `tripFeasibility` considers **the driving clock only**.
* **Profiles.** Seeded federal S60/N60, AB, BC general/logging, SK, MB, ON, QC and the Atlantic provinces.
  `BC_OIL_WELL_SERVICE` and `YT/NT/NU_NORTH60` are **empty**. **Everything is unverified.** Citations are
  generic, there are no URLs, and the federal N60 on-duty figure is marked contested.
* **Duty log.** `dutyRecords` (driver entry or integration) and `hosAttestations` (0155; stated, supersede-not-update).
  * Not found: driver log correction/annotation, certification, unassigned driving.
  * Not found: sleeper-berth vehicle eligibility, split-sleeper or deferral logic.
  * Not found: GPS/telematics reconciliation. The only precedent is `fuelTransactions.hosRuleConclusion = requires_status_review`.
* **Dispatch.** Dispatch sees only the attestation (`hos_attested` = review) or `hos_unknown`. Computed HOS never
  reaches dispatch.

### 1.6 Driver credentials: five overlapping stores

| Store | Content | Read by dispatch? |
|---|---|---|
| `operators` (legacy) | `licenseNumber/Class/ExpiresAt`, `restrictions`, `certifications` | licence fallback only |
| `operatorCapabilities` | kind + code, **no expiry, no verification** | matching |
| `complianceDocuments` | ownerType/docType/requirementKey/expiry/verification/privateDetail/evidenceRecordId | **yes**: licence, TDG (via regex), medical |
| `workerQualifications` (0092) + `qualificationValidity.ts` | holding, verificationState, supersede chain | no (open shifts, crews, calendar, shift readiness) |
| `academyQualifications` (0107/0108) | certificate / external / supervision / company sign-off; bound via `academyRequirementBindings` | **yes** (role, equipment, job_type, customer, site; **jurisdiction and cargo bindings never match**) |

* The explicit government-vs-employer labelling exists only in `driverTraining.ts` (`recognition`) and in
  Academy `credentialBoundary`.
* Contractor tables (0115/0116) carry **no credentials**.

### 1.7 Fleet, OOS, insurance, incidents, facilities

* **Fleet.**
  * Trailers are rows in `units`; there is no trailers table.
  * `inspections` (pre/post trip), `maintenanceDefects` (severity advisory/inspection_required/critical),
    `workOrders`, `workOrderReleases` (full/restricted/revoked, technician, resolvedDefectIds, superseded chain),
    `mechanicRelease.ts`.
  * PR #4 adds explicit defect resolution (`0169_defect_resolution.sql`) and removes the chronological clearing.
  * **Not found:** a GVWR column, sleeper configuration, CVIP/registration expiry on units (these are
    `complianceDocuments`), a permit table, a CAPA table.
* **Enforcement** (0082–0085, 0087, 0088).
  * `enforcementEvents`, `enforcementViolations`, `enforcementCitations`.
  * `outOfServiceOrders`: scope driver/vehicle/trailer/cargo/carrier, typed `requiredFindingType`,
    active/released/rescinded.
  * `oosReleaseFindings` and versioned `oosReleasePolicies`: company policy may strengthen but never weaken.
  * `enforcement.ts` `releaseReadiness` keeps "repair complete" separate from "releasable".
  * Release permission `enforcement.release` is held by safety and management only, and is sensitive.
  * `deviceSafetyLatches` are lifted only from order state.
  * `roadsidePanel` gives scoped, expiring grants. It has **unit axes only: no driver, licence or HOS axis**.
* **Insurance** (0038). `assessCoverage` gives expired or unknown = non-overridable block. This is correct.
* **Incidents.**
  * `incidentReports` (escalation up to `corrective_action`), `incidentActions` (the nearest thing to CAPA),
    `incidentMatters` (restricted vault, `REGULATORY_REPORT`).
  * **Reportability determination: not found.**
* **IFTA/GST.** `finalizeDecision` returns `{permitted, refusals}` with `computed|unknown`. It can be consumed; it is not wired.
* **Facilities/waste.**
  * `facilities`, `facilityCapabilities` (verified/confirmation_required/not_accepted/unknown, expiry, evidence),
    `facilityEvidence`, `wasteStreamVocabulary` (AER codes as **candidates**), `loadFacilityAssessments`
    (immutable, engine version).
  * `destinationAcceptance` is already a non-overridable dispatch blocker.
  * Manifests have a chain of custody, a hash chain and a seal trigger (0129/0130/0162).
  * `disposalReconciliation` is unwired.

### 1.8 Evidence, audit, notifications, AI, offline, scope

* **Evidence.**
  * `evidenceRecords`, `evidenceRelationships`, `evidenceVersions` (version 1 never overwritten),
    `evidenceSeals` (sha256, three-leg verification), `evidenceAccessEvents`.
  * Retention: `retentionPolicies` (`statutorySourceStatus` unverified/verified), `recordRetentionState`.
  * `legalHolds` link to evidence only.
  * **No DB immutability triggers** on evidence tables, and **no `orgRef`** on evidence, holds, retention or
    audit packages.
* **Audit packages** (0057/0060/0145).
  * `manifestJson` + `manifestHash`, `missingJson`, redaction policies, and `releaseDecision`
    (preparer ≠ releaser, gaps must be acknowledged).
  * **No org scoping** in `auditRouter` (`packageList` filters by `subjectRef` only).
* **Notifications.**
  * `domainEventOutbox` (tenantId NOT NULL, lease/retry/dead-letter), workflow engine (`workflowRules`,
    `operationalTasks` with `requiresEvidence`/`completionEvidenceRef`/`escalationStep`, `workflowNotifications`).
  * `domainEmitters.ts` has typed emitters, including `emitCredentialExpiring`, but is **unwired**.
  * `calendarProjection.ts` is a derived calendar with a `compliance` layer and mandatory provenance. It
    currently draws on `workerQualifications` only.
  * `exceptionCentre.ts` has a `compliance` category, but `loadExceptionSources` **takes no tenant scope**.
* **AI.**
  * Proposals: `aiProposal.ts` (`checkCommit`, `detectOverreach` blocks "is safe/legal", "cleared to dispatch"),
    `assistantCommitService` (re-authorization, receipt).
  * Gateways: `actionGateway.ts` `NEVER_AUTONOMOUS` (`compliance.override`, `maintenance.clearOutOfService`, …);
    `secretaryCoordination` `NEVER_AUTOMATIC` (`resolve_compliance`).
  * Knowledge: `knowledge/admission.ts` `FORBIDDEN_AI_OUTCOMES` and `checkClaim` (a decision needs binding,
    non-imported authority); `evidenceGrounding.verifyAnswer`.
  * PR #7 declares the model layer unwired under the moratorium.
* **Offline.**
  * `syncPackages`/`syncPackageItems`/`syncReceipts` with hash verification, `fieldDevices` with key binding and
    nonces (0110), `captureAuthorizationClaim` (0079), `SyncRefusalCode`.
  * `offlineCapability.ts` refuses device authority claims but is unwired.
  * `preDepartureCache.ts` is unwired, freshness is time-only, and it has no credential or HOS kinds.
  * There is **no cache revision fingerprint**.
* **Scope and RBAC.**
  * `roleProcedure(name)` maps a name to a permission in `recordsAuthorization.ts`, audits every decision, and
    fails closed for sensitive permissions. Bare `protectedProcedure` is banned by gate 5.
  * Org is derived by `resolveActingScope(db, userId)` from memberships, never from input.
  * Branch-confined grants fail closed when the branch is unknown.
  * The auth-workspace branch (unmerged, migration `0170_organization_scoped_role_grants`) widens grants to org scope.

### 1.9 UI

* `client/src/showcase/ComplianceEngine.tsx` is a **showcase** (`demonstration` / `fromQuery`), not an
  authoritative command centre.
* The dispatcher readiness panel and dispatch detail are on PRs #5 and #6.
* No driver compliance wallet exists.
* Widget boards exist (0127/0128). Their customization must not be able to hide critical tiles (see §17).

---

## 2. Reuse matrix

Legend:
* **R** = reuse unchanged.
* **E** = extend in place.
* **N** = genuinely new; justified because no canonical store exists.
* **U** = unify: two or more stores or engines to reconcile, not add to.

| Capability | Existing implementation | Missing | Reuse/extend | Proposed work (checkpoint) |
|---|---|---|---|---|
| Result model | `ItemStatus`, passport effect, `EligibilityVerdict`, `InterEngineStatus` (PASS/REVIEW/BLOCKED/UNKNOWN/NOT_EVALUATED), `CheckState` | one typed contribution contract; separate verdict vs dispatch effect vs override class | **E/U** | `ComplianceFinding` = extension of `DispatchBlocker` + mapping table (C1) |
| Authority ladder | 3 partial ladders (§1.3) | 8-tier ladder; no-weakening rule outside roads | **E** | `authorityTier` on requirements; map knowledge levels; keep `sourcePrecedence` for roads (C1b) |
| Regulatory source registry | `knowledgeSources/Documents/Versions` (hash, effective, state), `externalDataSources` (licence) | `proposed` status, section/subsection, publication and repeal dates as first-class fields | **E** | extend knowledge registry, not a new registry (C1b, C11) |
| Rule versioning / point-in-time | `hosRuleLimitHistory` + `promotionLedger.ts` | the same for compliance requirements; immutable requirement rows | **E/U** | generalize the ledger with a rule-family discriminator (C1b) |
| Two-person approval | `hos.limitPromote/profileVerify` | `requirementLoad`, `credentialVerify` (policy), `sourceReview` | **E** | route through the same `promote()` (C1b) |
| Applicability | `requirementApplies`, `packsActivatedBy`, `hos.selectProfile`, `jurisdiction.decideJurisdiction` (unwired) | one grammar; missing-input reporting; DG from structured data | **U** | one predicate grammar returning `missingInputs[]` (C1b); wire `jurisdiction` (C4) |
| Packs | `compliancePacks`, `companyPackActivations` | composition by reference; client/site/equipment packs; tenant-owned packs | **E** | `packKind`, `orgRef`, `extendsPackKey` (C8) |
| Dispatch readiness | `composeReadiness` → `evaluateDispatchReadiness` | typed contributions; R-1…R-11 | **E** (one composer) | C1a |
| Override policy | `requestOverride`, `dispatchOverrides`, `NEVER_AUTONOMOUS` | explicit override class; grantor identity; policy reference; scope/duration | **E** | C1a |
| Fingerprint | 3 hashers; `EligibilityFacts` | one sha256 canonical hasher; complete fact set; rule-set hash | **U** | C1a |
| HOS | `hos.ts`, profiles, ledger, attestations, `dutyRecords` | verified figures; computed availability to dispatch; log corrections; sleeper eligibility; feasibility beyond the drive clock | **E** | C2 |
| Evidence discrepancy | fuel `requires_status_review`, `odometerReconciliation`, `manifestFactReconciliation`, calibration sweep, `disposalReconciliation` | generic discrepancy record + review workflow | **N** (thin) + **R** detectors | `evidenceDiscrepancies` (C2) |
| Driver wallet | passport (server), `roadsidePanel` (unit only) | credential projection over 5 stores; offline wallet; roadside driver axis | **U** | C2 (projection), C10 (UI) |
| Credentials | 5 stores (§1.6) | one canonical read path, source-class labels | **U** | C2 (owner decision D-05) |
| Training / TDG training | Academy (certificates, signatures, retention, SoE, tier gate, bindings) | jurisdiction/cargo binding match; dispatch TDG reads the Academy | **E** | C2/C5 |
| Vehicle/trailer | `units`, `vehicleProfiles`, inspections, defects, work orders, releases, recalls | GVWR, registered weight, sleeper config, axle config as **verified** attributes | **E** | columns on `vehicleProfiles` (C3) |
| OOS / enforcement | full subsystem | the readiness read (PR #4), latch read in readiness | **R** + PR #4 | C1a depends on #4 |
| Permits / exemptions / equivalency | none (free-string `permitRefs`) | canonical permit model with conditions | **N** | `permits`, `permitConditions` (C6) |
| Route compliance | `routeEvaluation`, `routeApprovals` fingerprint, `structures`, `roadRestrictions` | permits in the fingerprint as rows; LoadSense weights into evaluation; lazy staleness only | **E** | C6 |
| Weights & dimensions | `legalAxleDetermination` (0159), `measurementQuality` | route evaluation uses LoadSense and certified scale | **E** | C6 |
| TDG shipment | `loadProfiles.unNumber/dgClass/classificationStatus`, `complianceSecretary.evaluateDangerousGoodsAssist` | structured shipment (PG, subsidiary class, quantity, containment, ERAP, placards); shipping-document revision/print state | **E** + **N** (shipment lines) | C5 |
| WHMIS/SDS | Academy WHMIS profile; `preDepartureCache` kind `sds` | SDS library + product linkage | **N** | C8 |
| OHS | tailgate/JSA artifacts, supervision records, incidents | versioned OHS packs | **E** | C8 |
| Client/site | Academy `customer`/`site` bindings, insurance `matchCustomerRequirements`, facility requirements (0141) | client/site packs that block only that client's job | **E** | C8 |
| Waste/disposal | facility directory, manifests, custody, destination acceptance | verified waste rules (AER D047/058 candidates only) | **E** | C8 |
| Incidents / reportability | `incidentReports`, `incidentMatters`, `incidentNotificationObligations` (security) | reportability determination with rule + evidence | **E** | C8 |
| Insurance | `insuranceRisk` | client-limit matching into readiness | **R/E** | C4 |
| IFTA/IRP | `iftaEngine`, `gstReturn` | a projected status only | **R** | C7 |
| Retention / holds | `retentionPolicies`, `legalHolds` | org scope; holds on non-evidence records; findings/CAPA as a hold reason | **E** | C9 |
| Evidence ledger | vault + seals + versions + relationships | org column; DB immutability triggers | **E** | C1b (triggers), C9 |
| CAPA | `incidentActions`, `operationalTasks` | a finding across sources | **N** (findings) + **R** (`operationalTasks` as actions) | C7 |
| Calendar | `calendarProjection` (derived, provenance-mandatory) | compliance sources | **E** | C7 |
| Notifications | outbox + workflow + `domainEmitters` (unwired) | wire compliance emitters | **E** | C1a (events), C7 |
| Carrier / safety program | `writtenProgramVersions`, `programAcknowledgements`, `carrierProfileReviews` | workspace; official score import with provenance | **E** | C7 |
| Audit mode / PIT | audit packages, `believedOn`, eligibility checks | rule-set refs per evaluation; org-scoped packages; PIT query | **E** | C9 |
| AI Secretary | admission, gateway, overreach, grounding | compliance answers cite the admitted rule | **R** | C10/C11 (unwired until moratorium) |
| Offline | sync, device keys, latches, `offlineCapability`/`preDepartureCache` (unwired) | revisioned cache package with source fingerprint | **E** | C10 |
| Regulatory change | knowledge quarantine pipeline, feed collectors, ledger | proposal → review → promotion adapters | **E** | C11 |
| Command centre | showcase only | authoritative surfaces | **E** (surfaces, widgets) | C10 |
| RBAC | `roleProcedure`, permission map, sensitive fail-closed, `resolveActingScope` | new permissions per checkpoint | **R** | every checkpoint |

---

## 3. Domain model

Every concept below maps to an existing table except where marked **new**.

```
RegulatorySource (knowledgeSources)                       ── licence/authority of the publisher
  └─ SourceDocument (knowledgeDocuments)                  ── one instrument (e.g. SOR/2005-313)
       └─ SourceRevision (knowledgeVersions)              ── content hash, effective window, supersedes

Rule family:
  ComplianceRequirement (complianceRequirements, immutable per version)
  HosRuleProfile/HosRuleLimit (hosRule*)
  RoadRestriction / Structure (roadRestrictions, structures)
  RetentionPolicy (retentionPolicies)
  └─ RulePromotion (hosRuleLimitHistory generalized → "rule promotion ledger")
        cites SourceRevision; carries verifier, second verifier, method, FUTURE/CURRENT/…

CompliancePack (compliancePacks) ── composes requirements by reference; activations per org/entity

Subject: operator | unit(trailer) | carrier(org) | job | load | route | equipment | work_context
Evidence: evidenceRecords (+versions, seals, relationships) | complianceDocuments | academyQualifications | …

Evaluation:
  ComplianceFinding (typed; extends DispatchBlocker)      ── one per requirement × subject
  ComposedReadiness (composeReadiness)                    ── the only dispatch composer
  EligibilityCheck (dispatchEligibilityChecks)            ── persisted verdict + fingerprint + rule-set refs
  Override (dispatchOverrides)                            ── with grantor, policy, scope, expiry

Follow-up:
  EvidenceDiscrepancy (new, C2)
  ComplianceFinding record / CAPA (new thin table, C7) → operationalTasks (existing)
  Permit + PermitCondition (new, C6)
```

### 3.1 The typed contribution (C1a)

A contributor returns `ComplianceFinding`. This is `DispatchBlocker` **extended**, not a new type, so every
existing consumer keeps compiling.

```ts
type ComplianceVerdict = "SATISFIED" | "UNSATISFIED" | "UNKNOWN" | "NOT_APPLICABLE";
type DispatchEffect     = "BLOCK" | "WARN" | "INFORMATIONAL" | "NONE";
type OverrideClass      = "NEVER_OVERRIDABLE" | "OVERRIDABLE_BY_APPROVED_POLICY" | "WARNING_ONLY" | "INFORMATIONAL";
type AuthorityTier      = "statute_regulation" | "regulator_order" | "government_permit_exemption"
                        | "carrier_safety_policy" | "client_contract" | "work_site" | "company_policy" | "best_practice";

interface ComplianceFinding extends DispatchBlocker {
  verdict: ComplianceVerdict;
  dispatchEffect: DispatchEffect;          // severity is derived from this for back-compat
  overrideClass: OverrideClass;            // replaces the bare `overridable` boolean as the source of truth
  authorityTier: AuthorityTier;
  engine: string;                          // contributor name
  requirementRef?: { key: string; version: number; promotionRef?: string };
  sourceRef?: { documentKey: string; revisionHash: string; citation: string };
  evidenceRefs: string[];                  // tracking numbers / record refs actually evaluated
  missingInputs: string[];                 // deciding inputs that are absent (UNKNOWN must name them)
  alerts: ("expiring" | "stale_evidence" | "evidence_unverified")[]; // properties, not verdicts
  resolution?: string;                     // the next legitimate step, when known
}
```

Mapping of the existing `ItemStatus`:

| ItemStatus | verdict | alert |
|---|---|---|
| `satisfied` | SATISFIED | |
| `expiring` | SATISFIED | `expiring` |
| `expired`, `missing`, `evidence_rejected` | UNSATISFIED | |
| `evidence_unverified`, `evidence_withheld`, `requirement_unverified` | UNKNOWN | as named |
| `not_applicable` | NOT_APPLICABLE | |

Invariants, tested in C1a:

1. `verdict ∈ {UNKNOWN}` never maps to `dispatchEffect = NONE` unless the requirement's approved policy says
   `INFORMATIONAL`, and never for `authorityTier ∈ {statute_regulation, regulator_order}`.
2. `authorityTier = regulator_order` ⇒ `overrideClass = NEVER_OVERRIDABLE`.
3. When two findings share a code, **the strictest** is kept (fixes R-3).
4. The composed verdict is the worst of all findings. No percentage is ever computed.

---

## 4. Authority model

The eight tiers are ordered as listed in §3.1. The rule:

* A finding from tier *t* may be **tightened** by any tier.
* It may be **loosened** only by a finding from a tier strictly above *t*, and only when that finding is itself
  verified and applicable.

This is `sourcePrecedence.resolvePrecedence`'s asymmetry, lifted from road sources to requirements.

Specific rules:

* `regulator_order` (OOS, compliance orders) is never loosened by tiers 4–8. **Only the issuing authority's
  release or rescind** removes it. This is already true of `releaseReadiness`/`oosReleasePolicy`, and it stays.
* `government_permit_exemption` modifies a tier-1 requirement **only when every verified permit condition
  matches** the subject, time, geography and load (C6). Otherwise it contributes nothing, not a warning.
* `carrier_safety_policy`, `client_contract`, `work_site` and `company_policy` may add requirements or raise
  effect. They never lower a tier-1/2/3 effect.
* `best_practice` is capped at `WARN`. The UI must label it "recommended".

Mapping of existing vocabularies (no data rewritten):

| Existing | Tier |
|---|---|
| knowledge `law` | statute_regulation |
| `official_guidance` | statute_regulation, flagged `guidance` (not binding; cannot BLOCK alone) |
| `recognized_standard` / `manufacturer` | carrier_safety_policy when adopted by a program version; otherwise best_practice |
| `company_policy` | split by pack kind into carrier_safety_policy / client_contract / work_site / company_policy |
| `outOfServiceOrders` | regulator_order |
| `sourcePrecedence` road ladder | kept as is, **inside** route evaluation |

Every explanation line carries `authorityTier`, the issuer (`sourceAuthority`) and the citation.

---

## 5. Source and version model

* **Sources.** Extend the knowledge registry. Add these fields to `knowledgeVersions`, or to the documents where
  per-document: `citation`, `section`, `subsection`, `publicationDate`, `repealedAt`/`supersededAt`,
  `retrievedAt`, `canonicalUrl`, `sourceTier`.
* **Status.** Add status `proposed`. Target set: `proposed → unverified → verified → superseded | withdrawn`.
  * The knowledge state machine already has QUARANTINED…VERIFIED.
  * The mapping is documented, not duplicated: QUARANTINED/LICENCE_CHECKED/PARSED/CLASSIFIED ⇒ `proposed`/`unverified`.
  * `externalDataSources` stays the **licence** registry for datasets.
* **Rule revisions.** Generalize `hosRuleLimitHistory` + `promotionLedger.ts` into a **rule promotion ledger**
  with a `ruleFamily` discriminator (`hos_limit | compliance_requirement | retention_policy | road_restriction | …`)
  and a `ruleRef` (see D-03).
  * `promote()` already enforces citation, binding authority, freshness ≤180 days, plausibility,
    FUTURE-dated rules and separation of duties.
  * It gains:
    * `sourceRevisionHash`, linking to `knowledgeVersions.contentHash`.
    * `secondVerifierUserId` for critical families.
* **Requirement rows become immutable per version.** `requirementLoad` stops mutating the prior row. The
  "superseded" status and `effectiveUntil` of v*n* are **derived** from the ledger (v*n+1*'s `effectiveFrom`).
  This makes point-in-time a query over append-only data.
* **No regulatory figure in code.** `regulatoryDataDiscipline.test.ts` already bans numeric literals in
  `routeEvaluation.ts`. C1b extends that guard to `compliancePassport.ts`, `requirementEngine.ts` and the new
  contributors. Seeds remain `unverified` data.

---

## 6. Applicability algorithm

This is deterministic, pure, and returns missing inputs rather than guesses.

```
applicable(requirement r, subject s, context c, at t):
  1. r's promotion status at t (ledger.believedOn(r, t)) must be CURRENT; FUTURE/EXPIRED/REVOKED ⇒ not in force.
     No CURRENT verified promotion ⇒ result UNKNOWN(reason: requirement_unverified), never NOT_APPLICABLE.
  2. subjectType match.
  3. jurisdiction: decided from structured route/job geography (jurisdiction.decideJurisdiction, verified layers only);
     unknown ⇒ UNKNOWN(missingInputs: ["jurisdiction"]).
  4. pack active for org/entity at t (packsActivatedBy + activations effective at t).
  5. predicate over structured inputs only (one grammar: eq, in, atLeast, atMost, any, present):
       each referenced input absent ⇒ collect into missingInputs; any missing ⇒ UNKNOWN.
  6. two verified requirements that conflict for the same (subject, obligation) ⇒ UNKNOWN(conflict) — never "pick one".
  7. otherwise APPLIES or NOT_APPLICABLE (with the predicate that excluded it recorded).
```

The inputs are listed in the prompt, §6. Each must come from a structured, provenance-bearing column:

* **Carrier:** org, SFC evidence.
* **Driver:** licence class, endorsements.
* **Vehicle:** `vehicleProfiles` verified GVWR, registered weight, axle config, sleeper config.
* **Operation:** operation class from job type **as a controlled vocabulary**, not regex.
* **Load:** `loadProfiles` classification, and structured DG from C5.
* **Route:** jurisdictions crossed, from the approved route.

The composer's regex DG detection (R-7) is removed in C1a. Until C5 exists, `dangerousGoods` is read from
`loadProfiles.classificationStatus/unNumber`. Absent ⇒ UNKNOWN.

HOS profile selection already follows this shape (`selectProfile` returns `unknown(missing[])|conflict`) and is
the reference implementation.

---

## 7. Evidence model

Reuse the vault: `evidenceRecords` + `evidenceVersions` + `evidenceSeals` + `evidenceRelationships` +
`evidenceAccessEvents`.

* **Provenance.** Each `ComplianceFinding.evidenceRefs` names the records evaluated. Evidence carries
  `sourceClass`: device observation, human attestation, OCR/AI proposal, official record, integration.
  `aiProposal.FieldSource` and `syncPackageItems.captureAuthorizationClaim` already carry most of it.
* **What establishes truth.** A proposal (OCR, voice, AI) establishes nothing until committed through
  `assistantCommitService` / verification.
* **Validity.** `documentValidity.validityOf` is the one validity function. `compliancePassport.evaluateRequirement`
  stops computing expiry inline, which resolves the `complianceDocumentValidity` duplication (SPINE item 2).
* **Immutability.** C1b adds DB triggers refusing UPDATE of `evidenceVersions.contentHash` and of sealed
  `evidenceSeals`. This follows the pattern of the `manifests_seal_guard` (0130) and academy retention triggers.
* **Tenancy.** Adding `orgRef` to evidence and audit packages is in C9, backfilled from `jobId`/owner. Until then
  scope is derived via `evidenceInScope`.

---

## 8. Dispatch integration

There is **one composer**: `composeReadiness`. Compliance modules contribute `ComplianceFinding[]` through a
registry of contributors. Each contributor has a declared `engine` name and the `CAPABILITY` it satisfies.
`readinessCapabilities.dispatchContractFor` still decides which capabilities are required, and a required
capability with no contribution is `capability_not_evaluated_*` (UNKNOWN).

C1a changes, all inside the existing composer:

1. **Typed contributions.** Each existing inline engine is wrapped to return `ComplianceFinding`. `mergeBlockers`
   keeps the strictest (R-3).
2. **Override.** `overrideClass` is explicit. `decideAward` and `requestOverride` both read it (R-6).
   * `dispatchOverrides` records `grantedByUserId`, `grantedByRole`, `grantedAt`, `policyRef`, `expiresAt` and
     `scopeJson` (R-2).
   * There is no generic override: a request names a blocker code and the policy that permits it.
3. **Fingerprint completeness.** `EligibilityFacts` gains insurance, enforcement, faults, roadside, calibration,
   medical, academy, incident hold and a `ruleSetHash` (the sorted `requirementRef`/`promotionRef` list). The
   hash moves to sha256 via one shared canonical hasher (R-5).
4. **R-4, R-7, R-8, R-11** fixed.
5. **Structured events.** `compliance.evaluated`, `blocker.created/resolved` are emitted through the existing
   `emitDomainEvent` inside the evaluate/award transactions (§18).
6. **Persisted refs.** `dispatchEligibilityChecks` stores `ruleSetHash` and the finding list. This is already
   `blockersJson`; the findings are richer.

Shift readiness (R-10) is **not** merged in C1a. D-06 decides whether `readiness.forShift` becomes a projection
over `composeReadiness`.

The §56 example ("Can Dylan take Unit 117…") is the acceptance target of C4.

---

## 9. HOS integration

* **Profiles and figures.** Keep `hos.ts`. Promote figures only via `hos.limitPromote` (already two-person).
  Figures without an official citation stay unverified, and `determine` stays UNKNOWN.
* **Computed availability.** `hos.status` + `determine` gives the availability that reaches the composer
  (replacing the hard-coded `hoursAvailableMinutes:null`). The contributor returns each clock separately; no single
  "hours remaining".
* **Trip feasibility.** Extend `tripFeasibility` from the drive clock to drive + on-duty + elapsed + cycle over
  a planned-work profile: route estimate, load, unload, disposal, standby, return, buffers. The output is
  `feasible_on_current_verified_inputs | infeasible | unknown` with reasons. It never promises future compliance.
* **Discrepancies.** New `evidenceDiscrepancies` table (C2):
  * Fields: `kind` (e.g. `HOS_EVIDENCE_DISCREPANCY_REQUIRES_REVIEW`), subject, window, the two conflicting
    evidence refs, the detector, the detector version, status, reviewer and disposition.
  * Detectors reuse existing engines: fuel off-duty, telematics movement, geofence arrivals, disposal tickets,
    field-ticket signatures and work orders.
  * **Never** edit a log; **never** label it falsification.
* **Log corrections.** Append-only `dutyRecordCorrections`: original, correction, author, reason, time,
  attestation. Its shape follows `hosAttestations`' supersede-not-update pattern.
* **Sleeper berth.** A `sleeper_berth` entry on a unit whose `vehicleProfiles.sleeperConfiguration` is
  absent/unverified ⇒ UNKNOWN + discrepancy. A verified "none" ⇒ UNSATISFIED + discrepancy. The legal
  definition of a qualifying sleeper is **not encoded** until sourced.

---

## 10. Training Academy integration

* Academy stays the **qualification issuer**. `academyRequirementBindings` stays the binding surface.
* C2 makes `jurisdiction` and `cargo` bindings match against **structured** job jurisdiction and load
  classification. Today they never match; the test that pins this changes deliberately.
* The dispatch TDG check reads `academyQualifications(TDG_ROAD)` **or** a verified external `complianceDocuments`
  TDG certificate. Both keep their source-class label.
* **Labels:** `government_regulated`, `employer_issued`, `external_certificate`, `client_requirement`,
  `site_requirement`. These come from Academy `credentialBoundary` + `driverTraining.recognition` + binding
  subject; no new vocabulary.

---

## 11. Fleet/shop integration

* **One compliance projection over the canonical shop records**, with no second maintenance database:
  `units`, `vehicleProfiles`, `inspections`, `maintenanceDefects` (with PR #4's explicit resolution),
  `workOrders`, `workOrderReleases`, recalls, `complianceDocuments` (CVIP, registration) and enforcement.
* **Vehicle attributes.** Add to `vehicleProfiles`, each with source and verification like the existing profile
  columns: GVWR, registered weight, axle configuration, sleeper configuration, unit class.
* **Invariants that already exist and are kept:**
  * A driver checkbox cannot clear a mechanic or regulatory defect.
  * Repair ≠ release.
  * Release requires the issuing condition.

---

## 12. Routing integration

* **Separate evaluations.** Routing (`roadGraph`, `truckRoutingAdapter`) and legal authorization
  (`routeEvaluation`, `routeApprovals`) stay separate.
* **Permits.** A permit becomes a row (C6), and `permitSet` in the route fingerprint becomes permit
  revision hashes, not free strings.
* **Weights.** LoadSense `legalAxleDetermination` and certified-scale weight feed `vehicleValues`, ranked by
  `MEASUREMENT_AUTHORITY_RANK`.
* **Staleness is eager.** Today it is lazy (`routeApprovalCheck` only). The composer recomputes the dependency
  hash on every evaluation and treats a mismatch as `route_approval_stale`.
* **Wiring.** `routeApprovalPolicy` and `advisoryImpact` are wired in C6. They require the M2/M3 routing work
  they are waiting on; this is a dependency, not something to force.

---

## 13. TDG model (C5)

* **Structured shipment lines.** Extend `loadProfiles` with a child table `dangerousGoodsLines`: UN number,
  shipping name, primary and subsidiary classes, packing group, quantity + unit, means of containment,
  special provisions, residue state, ERAP reference.
* **Parties:** consignor, carrier, consignee. Emergency information is reused from `facilities`/contacts.
* **Classification is a verified commit, never AI.** `complianceSecretary.evaluateDangerousGoodsAssist` stays
  an *assist* whose output is `ready_for_human_confirmation`.
* **Shipping document.** A frozen revision (evidence version + hash), print state, and original/reprint audit.
  Any amendment stales it.
* **Printer requirement.** Required only when an applicable verified requirement says paper is required.
* **Responsibilities.** Consignor, carrier and driver responsibilities are separate requirement subjects.
* **Emergency.** Verified ERAP/CANUTEC information and incident workflow links. No LLM-generated actions.

---

## 14. Offline semantics

* **Cache package.** Extend `preDepartureCache` + `offlineCapability`. They are unwired today; wiring them is
  SPINE item 3/HS1 work, so it is coordinated with the hybrid-seam plan.
* **Package fields.** The package carries `cacheRevision`, `downloadedAt`, `effectiveFrom/Until`, and a
  `sourceFingerprint` (sha256 over rule-set hash + credential projection + vehicle state + permits + route
  approval hash + emergency contacts).
* **Device limits.** The device records observations: inspections, defects, roadside captures as proposals. It
  never produces verified authority.
* **Stale or absent data.** A server-authoritative fact that is stale or absent renders UNKNOWN.
* **Latches.** Device safety latches (0087) stay fail-closed.
* **Driver visibility.** What a driver may see offline is decided by D-11.

---

## 15. Security and RBAC

* **Procedures.** Every new procedure is a `roleProcedure(name)` mapped in `recordsAuthorization.ts`. Sensitive
  permissions (verification, promotion, override grant, release, export) join `SENSITIVE_PERMISSIONS`.
* **Org scope.** Always `resolveActingScope`; it is never an input field. New compliance tables carry `orgRef`
  from birth.
* **Global rows.** Rule rows that are global law carry `orgRef NULL = platform`. Tenant packs carry their org.
  A branch-scoped policy cannot govern another branch (`mayScopePolicyTo`).
* **Projections for dispatchers.** Dispatchers get the finding projection ("TDG: VALID THROUGH 2027-05-12"),
  never the document. `privateDetail` → `evidence_withheld`, as the passport does today.
* **Roadside mode.** Extends `roadsidePanel` with a driver axis under the same expiring grant.
* **Exports.** Exports are reasoned and logged (`auditPackageAccess`, `restrictedAccessEvents`).
* **Known scope gaps to close:** `exceptionCentre.loadExceptionSources` (no tenant), `auditRouter` (no org),
  `legalHolds` (no org), `communicationPolicies` scope ignored.

---

## 16. Regulatory update model (C11)

```
adapter fetch (feedCollector/feedHttp, licence-gated by knowledgeSources)
 → knowledgeDocuments QUARANTINED, contentHash
 → diff vs previous version → change detected
 → proposed source revision (status proposed)
 → human review (knowledge verifier)
 → proposed rule revision(s) (ledger row, FUTURE or pending)
 → verification + second verifier for critical families
 → effective date (FUTURE rows activate by date, not by deploy)
 → impact query: requirements → packs → subjects/jobs affected
 → notifications (workflowNotifications)
 → old revision retained (append-only)
```

A scraper never activates law. `promotionLedger.validateEvidence` already refuses non-binding authority and
missing citations.

---

## 17. Audit reconstruction model

* **Point-in-time.** `evaluateAt(subject, t)`:
  1. Rule set = `believedOn(rule, t)` for every family.
  2. Evidence = records with `ingestedAt ≤ t` and the version current at t.
  3. Credential projections as of t.
  4. The historic `dispatchEligibilityChecks` row is shown **alongside** the recomputation.
  5. Any difference is reported, never silently reconciled.
* **Today-only is refused.** "What rules applied" is never answered from today's rule set alone.
* **Packages.** Audit packages (existing) gain:
  * `orgRef`, `authority`, `auditType`, `sample`.
  * `ruleRevisionRefs`.
  * An `unknownsJson` alongside `missingJson`.
  * Items state MISSING / UNKNOWN / NOT APPLICABLE explicitly.
  * The manifest is immutable (the existing hash plus a trigger).
* **Release.** `releaseDecision` (preparer ≠ releaser, gaps acknowledged) stays.

---

## 18. Observability

* **Events.** Emit through the existing typed emitters (`domainEmitters.ts`, which is wired as part of this
  work) into `domainEventOutbox`: `compliance.evaluated`, `requirement.unknown`, `requirement.failed`,
  `blocker.created/resolved`, `evidence.added/superseded`, `source.changed`, `rule.verified`,
  `qualification.expiring`, `oos.created/released`, `capa.overdue`, `audit_package.generated`.
* **Payloads carry refs and codes, never document content.**

---

## 19. UI information architecture (C10)

* **Command Centre.** Overview, Drivers, Fleet, Jobs, Regulatory, Audits, Corrective Actions (§34 of the brief).
  * It is built on `surfaces` and widget boards, fed only by server projections.
  * Counts and explicit blockers only. **No percentage score anywhere.**
  * Critical tiles (dispatch blockers, active OOS, regulatory UNKNOWNs) are **non-removable** in the widget
    registry.
* **Field Mobile Compliance.** Ready to Work (Driver/Truck/Trailer/HOS/Training/Route/Load/Documents/Site), My
  Wallet, Expiring Soon, Roadside, Inspection capture as proposals, and Fix This (the finding's `resolution`).
* **Rollup rule.** Overall = worst tile. Any UNKNOWN ⇒ "UNKNOWN / NOT READY".
* **Rendering.** Render from the server result. The client computes nothing.

---

## 20. Migration plan (summary; details in the implementation plan)

* **Slots are not assumed.** `main` ends at `0168`. Open work claims the next ones:

  | Slot | Claimed by |
  |---|---|
  | `0169` | `0169_defect_resolution` (PRs #4, #5, #6, #9); `0169_trip_stop_provenance` in the sibling repo; the hybrid-seam `sync_commands` plan |
  | `0170` | `0170_dispatch_role_types` (PR #9) and `0170_organization_scoped_role_grants` (auth branch): **a live collision** |
  | `0171` | `0171_dispatch_role_assignment_events` (PR #9) |

* The first compliance migration takes **the next free number at the time its PR is opened, after #4 and #9
  merge and the 0170 collision is resolved**. That is provisionally `0172`, or `0173` if the auth branch
  renumbers to `0172`. It is re-checked immediately before commit.
* **One migration per checkpoint slice**, additive only, with `verify-parity.sh` and column-parity tests updated
  in the same PR.

---

## 21. Test plan

The prompt's §49 matrix is adopted in full and assigned per checkpoint in the implementation plan. The C1a
tests must include:

* Government OOS cannot be overridden, by any role or policy.
* The override grantor is recorded, and the requester ≠ grantor.
* A strictest-wins merge.
* A fingerprint change on each newly covered fact.
* No regex DG inference: missing classification ⇒ UNKNOWN.
* `ruleSetHash` persisted on the check.
* Cross-tenant evaluate/award refusal.
* No bare `protectedProcedure`.
* A sensitive permission fails closed.

Database-backed suites follow the `*.db.test.ts` convention (gate 6 refuses skipped DB suites).

---

## 22. Major safety risks in the proposed architecture

1. **UNKNOWN flood → override pressure.**
   * Every seed is unverified, so honest evaluation makes almost everything UNKNOWN.
   * If UNKNOWN on a legal requirement blocks, operations will push for overrides.
   * If it only warns, UNKNOWN turns green in practice.
   * Mitigation: D-02 defines which UNKNOWNs block. Verified-source work (the §24 gaps) is on the critical path,
     not an afterthought.
2. **The seven ladders drifting further.** Adding a compliance-requirement ledger beside the HOS one would make
   eight. Mitigation: one generalized ledger (D-03).
3. **Fingerprint incompleteness (R-5).** A check can be awarded after an OOS order or insurance lapse lands,
   within the 30-minute window. C1a must close this before any new contributor is added.
4. **Override identity (R-2).** Audit cannot tell who granted an override. Any new override class built on this
   inherits the defect.
5. **Tenantless tables.** Requirements, packs, evidence, holds and audit packages have no `orgRef`. Tenant-owned
   client/site packs must not be written into a tenantless table.
6. **Point-in-time corrupted by mutation.** `requirementLoad` mutates prior rows. Historical reconstruction is
   unreliable until C1b.
7. **Two readiness systems (R-10).** Shift readiness and dispatch readiness can give different answers for the
   same person and time.
8. **Free-text inference.** DG regex (R-7) and client-supplied driver profiles (R-9) are where a confident wrong
   answer enters.
9. **Offline authority creep.** A cached "valid" credential shown past its revision can read as current. The
   package must carry revision and effective window, and render UNKNOWN when stale.
10. **Dashboard customization hiding critical tiles.** The widget boards allow layout changes. Critical tiles
    must be registry-pinned.
11. **Moratorium conflict.** Building C2+ engines while spine engines are unwired increases the unwired surface
    that `engineReachability.test.ts` exists to limit (D-01).
12. **Stacked-PR drift.** C1a edits `readinessComposer.ts` and `dispatchRouter.ts`, which PRs #4, #5, #6 and #9
    also rewrite. Starting before they land guarantees conflicts in the most safety-critical file.

---

## 23. Owner decisions (with recommended defaults)

| ID | Decision | Recommended default |
|---|---|---|
| D-01 | Does this initiative proceed under the SPINE moratorium, and which checkpoints count as "no new engine"? | C1a/C1b proceed (resolvers and contracts over existing engines, plus SPINE item 2). C2+ wait for owner sign-off. |
| D-02 | Which UNKNOWNs block dispatch? | UNKNOWN on tiers 1–3 and on any safety-critical capability (`DISPATCH_REQUIRED_ALWAYS`) blocks. UNKNOWN on tiers 4–8 warns unless the pack says block. |
| D-03 | One generalized rule promotion ledger, or per-family ledgers? | One ledger. Add `ruleFamily`/`ruleRef` to `hosRuleLimitHistory` (additive; existing rows = `hos_limit`). |
| D-04 | Two-person approval: which families? | All tier-1/2/3 rule promotions and source verifications. Credential verification stays single-person with sampling review. |
| D-05 | Canonical credential store | `complianceDocuments` for documents (licence, medical, registration, external certificates). `academyQualifications` for training-derived qualifications. `workerQualifications` becomes a projection or migrates. `operatorCapabilities` stays matching-only. `operators.license*` is read-only legacy. |
| D-06 | Shift readiness vs dispatch readiness | `readiness.forShift` becomes a projection over `composeReadiness` (C4). |
| D-07 | First-class jurisdictions at launch | Alberta provincial + Canada federal (south of 60). BC, SK, NT/YT/NU packs are hosted but unverified. |
| D-08 | Alberta-first before Canada-wide packs? | Yes. The engine is jurisdiction-neutral; verified data is Alberta-first. |
| D-09 | Internal company requirements: block vs warn | Warn by default; each company pack declares block explicitly with an approver. |
| D-10 | Customer requirements that block | Block only that customer's jobs, per `client_contract` pack declaration. |
| D-11 | What drivers may see offline | Their own credentials (projection level), assigned unit/trailer state, the job's permits, route package, emergency contacts. Never others' records or enforcement history beyond active orders on their assigned subjects. |
| D-12 | Who may verify regulatory sources | A named `compliance.source.verify` holder (safety/compliance lead), never the proposer. AI never. |
| D-13 | Notification windows | 90/60/30/14/7/1 days, configurable per org. Labelled "reminder", distinct from the legal deadline. |
| D-14 | Contractor records retained | Only what a requirement names, owned by the contractor org via `organizationRelationships`. Never merged into an employee record. |
| D-15 | Audit-package retention | The longest applicable verified retention for included records; until verified, company default + legal-hold override. |
| D-16 | Regulatory polling cadence | Weekly for tier-1 instruments, daily for advisories/road bans. All results are proposals. |
| D-17 | Order of stacked PRs | Merge #4 → #5 → #6 → #9 and resolve the 0170 collision **before** C1a starts. |
| D-18 | Eligibility fingerprint algorithm change (FNV-1a → sha256) | Accept. Existing checks become stale once, on deploy. |

---

## 24. Major regulatory-source gaps

Nothing below may become a dispatch-blocking rule until an official source is cited and verified through the
ledger.

* **HOS.**
  * All seeded figures are unverified; there are no URLs.
  * Federal N60 on-duty is contested.
  * `BC_OIL_WELL_SERVICE` and `YT/NT/NU_NORTH60` are empty.
  * Not encoded: sleeper-berth definition, split/deferral rules, oil-well-service exemptions, the 160 km
    short-haul radius; no US profiles.
* **Compliance requirement seeds.** CVIP (including the 11,794 kg threshold), registration, IRP, licence class,
  abstract, medical age bands and WHMIS are all unverified.
* **TDG.** Only the part 6 training topics are cited (SOR/2001-286, read 2026-09-11). Not encoded: shipping
  document content, placarding, ERAP thresholds, special provisions, reporting (part 8).
* **Waste.** AER Directive 047/058 mappings are candidates only (new edition effective 2026-06-04). BC/SK waste
  rules are absent.
* **Weights and dimensions.** No provincial weights/dimensions regulation or seasonal road-ban data source is
  verified. `roadRestrictions` is populated by hand.
* **Permits.** No permit issuer data (TRAVIS or municipal).
* **OHS.** No Alberta OHS Code thresholds (first aid, working alone, H2S, confined space, fall protection) encoded.
* **Incident reportability.** No collision, spill or dangerous-occurrence rules.
* **Retention.** `retentionPolicies.statutorySourceStatus` is unverified.
* **Carrier profile.** No Alberta carrier-profile/SFC or NSC data feed. Scores must be imported with provenance,
  never computed.

---

## 25. Unresolved questions carried forward

* Where the sibling repository's `SPINE_WIRING_PLAN.md` and `0169_trip_stop_provenance` land relative to this
  repo. This affects slot numbers and SPINE item 1.
* Whether `incidentActions` migrates into the C7 findings/CAPA model or stays incident-local with a projection.
* Whether the Academy's "UNRELEASED" checkpoint notes (0087/0088 docs) are closed. The gate run in this
  checkpoint includes the Academy suites.
