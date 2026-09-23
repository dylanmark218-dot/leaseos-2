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

*As built:* migration `0172`. Deviations from the plan below: outbox events and R-11 (`unitHeld`) were
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

### C1b — Requirement registry reconciliation *(next; not started)*

*Added by owner decision:* the credential read adapter from `credential-store-reconciliation.md` (D-05),
non-destructive, after the owner answers its questions.

*Engine?* No. It is a resolver, plus SPINE item 2.

**Scope**

* `complianceRequirements`: `authorityTier`, `orgRef` (NULL = platform law), `contentHash`. Rows become
  immutable per version.
* The rule promotion ledger is generalized (D-03): `ruleFamily`/`ruleRef` on `hosRuleLimitHistory`, plus
  `sourceRevisionHash` and `secondVerifierUserId`.
* `requirementLoad` and `sourceReview` go through `promote()` with separation of duties (D-04).
* The loader reads the table, not the seeds: `workAuthorization`, `packActivate` and `packKey`/version.
  The `SUBJECT` zod enum is completed.
* The applicability grammar is unified and returns `missingInputs[]`.
* `compliancePassport.evaluateRequirement` uses `documentValidity.validityOf`, which resolves the
  `complianceDocumentValidity` duplication.
* Knowledge registry: status `proposed`, `section`, `publicationDate`, `repealedAt`.
* DB triggers make sealed evidence versions immutable.
* `regulatoryDataDiscipline` guard extended to the compliance evaluators.

**Migration:** one or two, additive.

**Tests:** the §49 *Versioning* matrix:

* Rule before, after and on its effective date.
* Superseded, future and overlapping-verified rules; no verified rule.
* Two-person refusal.
* Point-in-time `believedOn` for requirements.
* Historical source revision retained.
* Hash mismatch.

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

`main` ends at `0169` (PR #4). C1a uses `0172`. Claims on open branches: `0170`/`0171` by PR #9 and
`feature/dispatch-assignment-ui`; `0170` also by `claude/leaseos-auth-workspace-system-t008ad`;
`0169`/`0170` by `claude/driver-portfolio-credential-wallet-ya8928` (its `0169` already collides with
main). The next compliance slot is `0173`, re-checked at PR time.
