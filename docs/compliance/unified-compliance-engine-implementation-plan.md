# LeaseOS — Unified Compliance Engine: Implementation Plan

Companion to `docs/compliance/unified-compliance-engine-design.md`. Section references (§) are to that document;
R-* are the verified readiness defects in §1.4; D-* are the owner decisions in §23.

## Checkpoint 0 result (this document)

| | |
|---|---|
| Starting SHA | `006069057b8a245ce00c0453d500f1e69c9e916c` (`main` = this branch's base; release v23.25) |
| Gate | `DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos bash scripts/ci-gate.sh` against MariaDB 10.11.14, the CI engine |
| Result | **PASS**: gates 0–8. 311 test files; 4309 passed, 3 skipped (`agentRuntimeApi.test.ts`, not a DB suite); no DB suite skipped; typecheck clean; test-file type errors 0/0; 0 bare `protectedProcedure`; 408 tables; 165 migrations; 646 role-authorized, 36 external, 2 integration procedures; build OK; current-state document current |
| Changes | two documents under `docs/compliance/`. No code, no migrations, no seeds |

## Migration collisions and dependencies

| Slot | Claimed by | State |
|---|---|---|
| 0016, 0017 | Spatial / LoadSense branches (gate 0 enforces) | reserved, absent |
| 0094, 0095, 0098 | never used (calendar/readiness/crew channels shipped without tables) | leave unused |
| 0157 | used twice on `main` (`seal_verification_unavailable`, `signature_device_attestation`) | historical; do not repeat |
| **0169** | `0169_defect_resolution` (PR #4, and carried by #5, #6, #9); `0169_trip_stop_provenance` (sibling `leaseos`, SPINE item 1); hybrid-seam `sync_commands` plan (`docs/hybrid-seam/HS_CONTRACTS.md`) | **contested** (3 claims) |
| **0170** | `0170_dispatch_role_types` (PR #9); `0170_organization_scoped_role_grants` (branch `claude/leaseos-auth-workspace-system-t008ad`, no PR) | **live collision** |
| 0171 | `0171_dispatch_role_assignment_events` (PR #9) | claimed |

Rules for this initiative:

1. **Reserve no number now.** Each compliance checkpoint takes the next free slot when its PR is opened.
   * Check it against `main` and against every open branch: run `git diff --name-status origin/main...origin/<branch> -- drizzle/` over all remote branches.
   * Record the check in the PR body.
2. The provisional first compliance slot is `0172`, or `0173` if the auth branch renumbers to `0172`.
3. Code dependencies:
   * C1a edits `readinessComposer.ts`, `dispatchRouter.ts`, `dispatchAward.ts` and `readinessCapabilities.ts`.
   * PRs #4, #5, #6 and #9 rewrite the same files.
   * **C1a starts only after #4 merges.** It also rebases after #9 if #9 is ahead (D-17).
   * C1b depends on nothing in flight except the slot.

## Checkpoint sequence

Each checkpoint is one reviewable PR, with at most one or two additive migrations, and the full gate run
before push. "Engine?" records the SPINE-moratorium classification (D-01).

### C1a — Dispatch contract and safety defects — **done** (see `checkpoints/C1A_READINESS_HARDENING.md`)

*As built:* migration `0174` (built as `0172`, moved at integration; see the collision register). Deviations from the plan below: outbox events and R-11 (`unitHeld`) were
deferred. Tenant scoping of the dispatch path and the D-02 classification were added.

*Engine?* No. It is a contract over the existing composer, plus defect fixes.

**Scope**

* `ComplianceFinding` (§3.1) as an extension of `DispatchBlocker`, and the `ItemStatus` → verdict mapping.
  Every existing contributor is wrapped. Behaviour is unchanged except for the fixes below.
* **R-2:** `dispatchOverrides` gains `grantedByUserId`, `grantedByRole`, `grantedAt`, `policyRef`, `expiresAt`
  and `scopeJson`. `award` reads the grantor, not the requester.
* **R-3:** a strictest-wins merge.
* **R-4:** `overrideAuthority`, with no cast.
* **R-6:** an explicit `overrideClass`. `decideAward` and `requestOverride` both read it. Government OOS is
  `NEVER_OVERRIDABLE`.
* **R-5:** facts completed (insurance, enforcement, faults, roadside, calibration, medical, academy, incident
  hold) plus `ruleSetHash`. One shared sha256 canonical hasher; the route and comm-package hashers are moved onto
  it without changing their output.
* **R-7:** DG regex removed. DG is read from `loadProfiles` classification; absent ⇒ UNKNOWN.
* **R-8:** `dispatchEnforcementService` recompute includes `routeApprovalRef`.
* **R-11:** incident `unitHeld` read.
* Emit `compliance.evaluated`, `blocker.created`, `blocker.resolved` via `emitDomainEvent` inside the existing
  transactions.

**Migration:** one, additive:

* `dispatchOverrides` grantor, policy, expiry and scope columns.
* `dispatchEligibilityChecks.ruleSetHash`, `findingsJson`.

**Tests (DB-backed where persistence is involved)**

* An OOS order blocks for every role and every policy.
* The override grantor is recorded and the requester cannot grant.
* An override is refused without a policy.
* The strictest duplicate wins.
* Each newly fingerprinted fact stales a check.
* No regex DG.
* `ruleSetHash` persisted.
* Tenant A cannot evaluate/award against tenant B's records.
* The sensitive `dispatch.overrideGrant` fails closed when its audit write fails.
* The procedure census is updated.

**Out of scope:** new contributors, UI, requirement registry changes.

### C1b — Requirement registry reconciliation *(authorized after C1a merged; C1b-1 implemented, see `checkpoints/C1B_1_RULE_LEDGER.md`)*

*Updated 2026-09-23 against the real merged state (`main` = `42c454f`, migration head `0174`).*
*Engine?* No. It is consolidation: seven verification ladders become one ledger, and SPINE item 2's
`complianceDocumentValidity` duplication is resolved. **Out of scope:** the driver, fleet, TDG, route and
OHS systems. C1b builds the regulatory authority that they will consume later.

**What exists to build on (verified on `main`)**

| Piece | Where | Relevance to C1b |
|---|---|---|
| Immutable, two-person, point-in-time promotion ledger | `hosRuleLimitHistory` (0120/0124). Columns: `promotionRef, profileKey, limitKey, value, unit, jurisdiction, authorityType, instrumentTitle, issuingAuthority, sourceSection, citationUrl, instrumentVersion, consolidationDate, verificationMethod, establishedByVersionRef, verifiedByUserId, verifiedAt, effectiveFrom, effectiveUntil, recordedAt, status (FUTURE/CURRENT/EXPIRED/REVOKED/SUPERSEDED), changeReason, correctsPromotionRef, previousPromotionRef`. Code: `knowledge/promotionLedger.ts` (`validateEvidence`, `promote`, `believedOn`, `divergences`) and `hos.limitPromote` (separation of duties) | **The pattern and the table to generalize.** Its history must survive unchanged |
| Source documents with hashes and effective windows | `knowledgeDocuments` (`state`, `authorityLevel`, `contentHash`, `url`) and `knowledgeVersions` (`contentHash`, `effectiveFrom/Until`, supersedes chain, `verifiedBy`) | The **source** half of the ledger |
| Requirement registry | `complianceRequirements` (`requirementKey`, `version`, `family`, `packKey`, `subjectType`, `jurisdiction`, `appliesWhenJson`, `satisfiedByDocTypes`, `missingSeverity`, `source*`, `effectiveFrom/Until`, `verificationStatus`, `verifiedBy`). `requirementLoad` mutates the prior row and is single-person | The **rule** half, to be put under the ledger |
| Other ladders | `externalDataSources` (dataset licences), `roadRestrictions`/`structures`, `regulatoryThresholds`, `taxRules` | Mapped onto the ledger's vocabulary; **migrated later**, not in C1b |
| Readiness provenance | `dispatchEligibilityChecks.ruleSetHash` (C1a); `ComplianceFinding.ruleRef` = classification rule | C1b adds the **requirement revision** each finding used |
| Duplicated expiry logic (SPINE item 2) | `documentValidity.validityOf` (canonical, unused by dispatch); `complianceDocumentValidity` (adapter, **no production caller**); inline copies in `widgetSources.expiryState` (documentExpiry tile), `compliancePassport.evaluateRequirement`, `readinessComposer.credentialState` + `dispatchReadiness.credentialBlocker` | Reconciled onto the canonical path, with equivalence tests first |

**Design**

1. **One ledger, generalized in place** (D-03). `hosRuleLimitHistory` gains `ruleFamily` (`hos_limit` for
   every existing row), `ruleRef`, `domain`, `authorityTier` (the §4 ladder), `sourceRevisionRef`
   (→ `knowledgeVersions.versionRef`), `sourceHash`, `secondVerifierUserId`, `lifecycle`, and `payloadJson`
   for non-numeric rules. `profileKey`/`limitKey`/`value` become nullable for non-HOS families.
   * **Additive only.** No existing row is rewritten except to backfill `ruleFamily = 'hos_limit'`, and
     `believedOn` keeps returning byte-identical answers for HOS (an equivalence test is written first).
   * The table keeps its name; a follow-up may add a view with a neutral name. Renaming a table
     that holds legal history is not worth the risk (owner question C1b-Q1).
2. **Lifecycle:** `candidate → reviewed → verified → active → superseded | withdrawn`, mapped onto the
   existing statuses without rewriting history. `candidate`/`reviewed` are pre-ledger states held on the
   proposal. `verified` and `active` correspond to FUTURE and CURRENT, split by the effective date.
   `EXPIRED`, `REVOKED` and `SUPERSEDED` are kept. Nothing becomes `active` except by date after
   verification. A scraper or an AI can produce at most a `candidate`.
3. **Sources:**
   * `knowledgeVersions` gains `citation`, `section`, `publicationDate`, `retrievedAt`, `repealedAt` and a
     source `status`.
   * The knowledge `authorityLevel` maps to the authority tier by table, not by rewrite.
   * A rule revision cannot be verified without a `verified` source revision whose hash it records.
4. **Rules:**
   * `complianceRequirements` rows become immutable revisions: `requirementLoad` inserts and never
     updates, and supersession is read from the ledger.
   * Requirements gain `authorityTier`, `dispatchEffect` (explicit, replacing the implicit
     `missingSeverity` mapping), `evidenceRequirementsJson`, `exemptionRefsJson`, `retentionRef`, and
     `orgRef` (NULL = platform law).
   * `requirementLoad` and `geo.sourceReview` go through `promote()`.
   * Dispatch-blocking rules at the statute or regulator-order tier require two distinct verifiers,
     the HOS model.
5. **Historical evaluation:** every finding produced from a requirement carries
   `requirementRef = { key, revision, promotionRef }`. `dispatchEligibilityChecks` stores the list, so
   "which exact verified rule revision did this decision use?" is a row read. Point-in-time uses
   `believedOn(rule, at)` for every family. Today's rules are never applied to yesterday's check.
6. **Loader defects fixed** (found in the Checkpoint 0 survey):
   * `workAuthorization` reads the table, not the seed constants.
   * `packActivate` validates against `compliancePacks`.
   * `loadRequirements` honours `packKey` and version.
   * The `SUBJECT` zod enum is completed.
7. **SPINE item 2, `complianceDocumentValidity`:** the four inline expiry decisions above route through
   `documentValidity.validityOf` via the adapter. Equivalence tests are written **before** any inline
   code is removed. `complianceDocumentValidity` then leaves `DECLARED_UNWIRED`.

**Proposed slices** (one additive migration each, numbers from the register at PR time, next free `0175`):

| Slice | Content | Migration |
|---|---|---|
| C1b-1 | ledger generalization + source fields + lifecycle; HOS equivalence tests; `promote()` generalized. **Implemented** (`0189`; the next free number was re-scanned, see the register) | one |
| C1b-2 | requirements under the ledger; immutable revisions; two-person for dispatch-blocking statute; loader fixes; `requirementRef` on findings and checks; point-in-time query | one |
| C1b-3 | SPINE item 2 `complianceDocumentValidity` reconciliation (equivalence first); D-05 credential read adapter, non-destructive, with equivalence tests for the four `workerQualifications` readers | none expected |

**SPINE items this advances**

* **Item 2** (the four duplications): C1b-3 resolves `complianceDocumentValidity`. The D-05 adapter moves
  `openShiftsRouter`'s qualification reads onto the canonical projection, which is a step towards the
  `openShifts` duplication but **does not resolve it**: the eligibility decision itself stays inline.
  `dispatchMatching` and `fieldTicket` are untouched.
* **Not advanced:**
  * Item 1 (per-boundary confirmation on `tripStops`; resolver on open PR #10, reader blocked on a schema gap).
  * Item 3 (`offlineCapability` → HS1).
  * Item 4 (the rest of the spine in path order).
* None of the thirteen engines is expected to leave `DECLARED_UNWIRED` except `complianceDocumentValidity`.
  The moratorium stays in force.

**Owner questions before C1b code.** *The owner said "Continue" without answering these. C1b-1 proceeds
on the recommended answer to each, and records them in `checkpoints/C1B_1_RULE_LEDGER.md` so they can be
reversed. None of them changes dispatch behaviour in C1b-1.*

* **C1b-Q1:** generalize `hosRuleLimitHistory` in place (recommended: additive, history untouched),
  or create a new ledger and copy HOS history into it (two sources of truth during the transition)?
* **C1b-Q2:** who may verify a regulatory source or rule revision (D-12)? Recommended: a named
  `compliance.source.verify` holder, never the proposer, never AI.
* **C1b-Q3:** which families need two verifiers? Recommended: any rule at the statute or
  regulator-order tier whose dispatch effect is BLOCK.
* **C1b-Q4:** may existing unverified seeds be loaded as `candidate` rows, or must they stay outside the
  ledger until a human proposes them? Recommended: as candidates, clearly labelled.

### C2 — Driver compliance projection and HOS

*Engine?* Partly new (discrepancies, corrections). Needs D-01.

**Scope**

* A credential projection over the canonical stores (D-05) with source-class labels.
* The licence class/endorsement check reads the DB and replaces the client-supplied profile (R-9).
* Academy jurisdiction/cargo bindings matched from structured inputs.
* The dispatch TDG check reads the Academy.
* HOS contributor with computed clocks (replaces `hoursAvailableMinutes:null`), and multi-clock trip feasibility.
* `dutyRecordCorrections` (append-only).
* `evidenceDiscrepancies` plus detectors for fuel, telematics movement, geofence and field tickets.
* Sleeper-berth integrity via `vehicleProfiles.sleeperConfiguration`, which is added in C3. If C3 has not landed,
  the contributor returns UNKNOWN.

**Tests:** §49 *Driver* and *HOS* rows.

### C3 — Fleet compliance projection

*Engine?* No. It is a projection.

**Scope**

* `vehicleProfiles` verified attributes: GVWR, registered weight, axle config, sleeper config, unit class.
* One vehicle/trailer projection over inspections, defects (with PR #4 resolution), releases, recalls,
  CVIP/registration documents and enforcement.
* A roadside panel driver axis.
* A reconstructable maintenance history query per unit.

**Tests:** §49 *Vehicle* and *Enforcement* rows, including "repair does not equal release" and "wrong-role
release refused".

### C4 — Trip/dispatch aggregation

*Engine?* No.

**Scope**

* `readiness.forShift` becomes a projection over `composeReadiness` (D-06).
* Insurance client-limit matching.
* Wiring `jurisdiction.decideJurisdiction` for route-derived jurisdictions.
* The §56 "Can Dylan take Unit 117…" acceptance test, end to end, every line traceable to a rule and evidence.

### C5 — TDG

*Engine?* New tables.

**Scope**

* `dangerousGoodsLines`.
* Shipping-document revision, print state and reprint audit.
* Printer requirement only from a verified rule.
* Consignor/carrier/driver responsibilities.
* ERAP/CANUTEC emergency view from verified data.

**Tests:** §49 *TDG* rows.

### C6 — Route, weights and permits

*Engine?* New tables (`permits`, `permitConditions`).

**Scope**

* Permit model with all-conditions-match semantics.
* Permit revision hashes in the route fingerprint.
* LoadSense and certified-scale weights into route evaluation.
* Eager staleness in the composer.
* Wire `routeApprovalPolicy`/`advisoryImpact` once M2/M3 land.

**Tests:** §49 *Route* rows.

### C7 — Carrier, admin and CAPA

**Scope**

* Carrier workspace over `writtenProgramVersions`, `programAcknowledgements` and `carrierProfileReviews`.
* Official score import with provenance.
* `complianceFindings` (thin), whose corrective actions are `operationalTasks`.
* Compliance sources feed `calendarProjection`.
* Reminder policy kept distinct from the deadline.
* IFTA/GST status projected.

### C8 — OHS, client, site and environmental packs

**Scope**

* Pack kinds and `extendsPackKey`, with tenant-owned packs.
* SDS library.
* Reportability determinations (rule + evidence; UNKNOWN ≠ not reportable).
* Waste-rule hosting, with verified rules only.

### C9 — Audit readiness and point-in-time

**Scope**

* `evaluateAt(subject, t)`.
* Audit packages gain org, authority/type/sample, rule revision refs and unknowns.
* `orgRef` backfill on evidence, holds, retention and packages.
* Legal holds on non-evidence records.

### C10 — Compliance UI and mobile

**Scope**

* Command Centre over surfaces/widgets, with pinned critical tiles and no percentages.
* Field Mobile Compliance: Ready to Work, Wallet, Expiring, Roadside, Inspection proposals, Fix This.
* Offline cache package with revision and source fingerprint (coordinated with HS1).

### C11 — Regulatory-change proposals

**Scope**

* Source adapters: Transport Canada, Alberta TEC, Alberta OHS, AER, CCMTA.
* Knowledge quarantine → proposal → review → ledger promotion → impact notification.
* No silent activation.

## Test matrix allocation (§49 of the brief)

| Area | Checkpoint |
|---|---|
| Applicability | C1b (grammar), C4 (jurisdiction crossing) |
| Versioning | C1b |
| Driver | C2 |
| HOS | C2 |
| Vehicle | C3 |
| TDG | C5 |
| Route | C6 |
| Client/site | C8 |
| Evidence | C1b (hash), C2 (discrepancy), C10 (offline, delayed sync) |
| Enforcement | C1a (non-override), C3 (release) |
| Multi-tenancy | every checkpoint, via `tenantScope*.db.test.ts` style suites |
| Audits | C9 |
| Security | every checkpoint (gate 5, procedure census, sensitive fail-closed) |

## Exact recommended first implementation checkpoint

**C1a — Dispatch contract and safety defects**, started after PR #4 merges.

It is first because:

* It fixes the defects that make today's answers unsafe: override identity (R-2), incomplete fingerprint (R-5),
  implicit override class (R-6) and free-text DG (R-7).
* PR #4 separately fixes the dead OOS read (R-1).
* Every later contributor depends on the typed `ComplianceFinding` contract.
* It adds no engine, so it is permitted under the SPINE moratorium.

The migration number is taken at PR time per the rules above.

## Migration slots after C1a (checked 2026-09-23)

`main` ends at `0169` (PR #4; PR #5 added none). C1a uses `0174`. Claims on open branches: `0170`/`0171` by PR #9 and
`feature/dispatch-assignment-ui`; `0170` also by `claude/leaseos-auth-workspace-system-t008ad`;
`0169`/`0170` by `claude/driver-portfolio-credential-wallet-ya8928` (its `0169` already collides with
main); `0172`/`0173` by `claude/training-academy-workforce-q3mdse`. The next compliance slot is `0175`, re-checked at PR time against `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.
