# Fleet/Unit Security CP1.5 — Tenant Isolation and Hold Authority (2026-09-25)

Branch `claude/mechanic-portal-domain-82efa9`. **Base:** `5856174` (the Fleet & Equipment Portfolio
foundation, approved; `main` = `3d05d32`, already contained). **Result:** `59642ba` (code); this record
and the regenerated current state are the commit after it. No pull request. No migration.

| Commit | What |
|---|---|
| `9eba428` | Part G — inventory drift, pre-existing on `main`, corrected on its own |
| `2284571` | Parts A–C — the unit-scope seam, every unsafe/partial mutation, incident ownership and incident holds |
| `7ea5ae9` | Parts D–F — `fleet.holdRelease` and the human-authorization permissions at the action gateway; separation-of-duties and readiness tests |
| `0076f4c` | merge of `main` `c626146` (the AI Secretary layer and agent-run guards landed while this checkpoint ran) |
| `6510d55` | a second pre-existing `main` failure, fixed on its own: four dispatch-role suites shared one test user-id band, and `main`'s new `testIdBands` guard fails on untouched `main` `c626146` (verified in a clean worktree) |
| `7faad54` | Part D, extended to the tool layer `main` added: the Secretary's tool registry calls procedures as the driver, and now refuses any procedure authorized by a human-authorization permission, not only names in `NEVER_AUTONOMOUS` |
| `59642ba` | a third pre-existing `main` failure, fixed on its own: `workerBoundary.test.ts` read `createHash("sha256").update(…)` (added by `60f8d90`) as a database write and fails on untouched `main` `c626146` (verified in a clean worktree); the guard now sets aside only that chain and still fails on a planted `db.update(` |

A prerequisite for Mechanic Portal CP2, which creates and releases defects, holds and return-to-service
authority. The unit-scope sweep (`UNIT_SCOPE_SWEEP_2026-09-25.md`) found router mutations that wrote a
request's unit id unchecked; this checkpoint revalidated every one on current code, fixed every unsafe
and partial one through one seam, fed incident holds into the canonical portfolio path, and put hold
release — and every future return-to-service act — outside what an agent may do.

## Result in one paragraph

Every router mutation that names a unit now refuses another organization's unit exactly as it refuses a
unit that does not exist — `NOT_FOUND "Unit <id> not found"` (or `Trailer`), same code, same message,
same access-log row — before anything is read about the unit or written anywhere. A structural test fails
the build if a new unit-taking mutation skips the check. An incident that holds its unit places one
`unitHolds` safety hold in the same transaction, lifted only by an independent safety review. An agent is
refused `fleet.holdRelease` and any capability requiring a return-to-service permission. **No unit
mutation is known to be unsafe.** Non-unit ids some of these mutations also take (jobs, trips, operators,
financial entities) are listed under *Unresolved* — outside this checkpoint's scope and not fixed here.

## The canonical seam

`server/unitScope.ts` — `requireCallerUnits(userId, { unitId, trailerId, unitIds })` and
`requireUnitInScope(unitId, scope, label)`. It adds no rule: the rule is `unitInScope` (`db.ts`) — the
unit exists AND its `coreRecordOwnership` owner is the caller's organization, or, for the historical
single tenant (no membership, `tenantId = "default"`), it has no owner. The seam is the one place that
turns "not in scope" into the refusal. The ~30 call sites that already made the same check in the same
words (`shopRouter`, `spatialRouter`, `routers.ts`, …) were left as they are — they are the same rule —
and are accepted by the guard.

`recordBelongsToOrganization` is **not** a unit check: it answers "the historical tenant's" for an id
that does not exist, so the historical tenant could name a unit that is not there, and its FORBIDDEN
refusal told that tenant which ids existed. The three mutations that used it for units now use the seam.

**Legacy/default scope, stated rather than inferred** (tested in `unitScopeSecurity.db.test.ts`): a user
with no membership may use an unowned unit; an organization's unit is refused to them exactly as a
missing one; an unowned unit is refused to an organization's member exactly as a missing one.

## Matrix — every procedure surveyed

Classification at the base, from the red run (`unitScopeSecurity.db.test.ts` against the unfixed routers:
29 failed / 6 passed; in 16 cases the call from organization B on A's unit **succeeded and wrote**).
*Dispatch?* = can the mutation change dispatch readiness, the unit's operational state, or a hold.

### The sweep's rows

| # | Router | Procedure | Unit argument / path | Scoping at base | Result at base | Class | Fix | Dispatch? | Tests |
|---|---|---|---|---|---|---|---|---|---|
| 1 | asset | `asset.register` | `unitId`, `trailerId` (both UNIQUE) | none | wrote `capitalAssets` for A's unit and trailer | UNSAFE | seam, both, first | no | uSS (unit, trailer); `capitalAssets.test` |
| 2 | closeout | `closeout.delayRecord` | `unitId`; `ticketNumber` → the ticket's unit, job, trip | none (handler took no `ctx`) | wrote `delayEvents` | UNSAFE | seam + `fieldTicketInScope`, first | no | uSS (unit; ticket); `siteCloseout.test` |
| 3 | commercialSetup | `commercialSetup.definitionPropose` | `unitId` | none | wrote `chargeDefinitions` | UNSAFE | seam | no | uSS; `commercialSetup.test` |
| 4 | comms | `comms.unitCapabilitySet` | `unitId` | none | overwrote A's `unitRadioCapabilities`, reset to unverified | UNSAFE | seam | **yes** — readiness reads the unit's radio fit for route communication blockers | uSS; `communications.test` |
| 5 | comms | `comms.planForPath` | `unitId` (and reads its radio fit) | none | wrote `communicationPlans` | UNSAFE | seam | no | uSS |
| 6 | comms | `comms.packageBuild` | `unitId` | none | wrote `communicationPackages` | UNSAFE | seam | no | uSS; `commPackage.test` |
| 7 | dispatch | `dispatch.setRoleAssignment` | `unitId`, `trailerId` | `applyBinding` → `unitInScope` in the transaction | — | SAFE | none | yes | dispatch suites; guard (delegate verified) |
| 8 | enforcement | `enforcement.eventConfirm` | `unitId`, `trailerId` | event carries the caller's tenant; the **defect and work order** it files do not | wrote a critical defect + urgent work order on A's unit, and an event on A's trailer | PARTIAL | seam (unit and trailer) before the transaction opens | **yes** — the critical defect blocks A's truck (NEVER_OVERRIDABLE) | uSS (unit, trailer); hAR Part F; `enforcementApi.test` |
| 9 | enforcement | `enforcement.panelGrantIssue` | `unitId` | none | wrote `roadsidePanelGrants` | UNSAFE | seam | no | uSS |
| 10 | fuelOps | `fuel.dispenseRecord` | `unitId` | none (refused only by the tank lookup in the test) | would write `fuelTransactions` / `bulkFuelDispenses` | UNSAFE | seam, first | **indirect** — the dispense's odometer joins the unit's meter sequence, so a foreign figure could put A's meter into `METER_REGRESSION` | uSS; `bulkFuel.test` |
| 11 | geo | `geo.accessConfirmPassage` | `unitId` | none | would write `siteAccessConfirmations` | UNSAFE | seam, first | no | uSS; `legalLand.test` |
| 12 | ifta | `ifta.distanceRecord` | `unitId` | none | wrote `jurisdictionDistanceRecords` | UNSAFE | seam | no | uSS; `ifta.test` |
| 13 | insurance | `insurance.claimOpen` | `unitId` | none | would write `insuranceClaims` | UNSAFE | seam, first | no | uSS; `insuranceRisk.test` |
| 14 | payroll | `payroll.submitTime` | `unitId` | own profile only | would write `payrollTimeEntries` | PARTIAL | seam, first | no | uSS (refusal) |
| 15 | payroll | `finance.expenseCreate` | `unitId` | none | wrote `expenseRecords` / `expenseAllocations` | UNSAFE | seam | no | uSS (refusal) |
| 16 | purchasing | **`roadside.open`** | `unitId` | **existence only** | wrote a defect and an open roadside event on A's truck | UNSAFE | seam (replaces the existence check) | **yes** — the open event and the defect block A's truck | uSS; hAR Part F; `purchasingAp.test` |
| 17 | purchasing | `purchasing.request` | `unitId` | none | would write `purchaseAuthorizations` | UNSAFE | seam, first | no | uSS; `purchasingAp.test` |
| 18 | purchasing | `vendor.billRecord` | `unitId` | none | wrote `vendorBills` | UNSAFE | seam, first | no | uSS; `purchasingAp.test` |
| 19 | records | `records.incident.capture` | `unitId`, and `jobId` (the incident's organization is its job's, else its unit's) | none | wrote the incident on A's unit | UNSAFE | seam + job check, first; the hold is placed with the incident (below) | **yes, now** — an incident that holds its unit grounds it | uSS (unit; foreign job); hAR Part F |
| 20 | fieldRoute | `trips.create` | `unitId` | fixed in `18f3f68` | — | SAFE | — | no | `tripUnitScope.db.test` |
| 21 | fieldRoute | `assistant.draft` | `unitId` | none | would reach the model and write `assistantProposals` | UNSAFE | seam, **before the model is asked anything** | no (the proposal becomes visible to the unit's owner) | uSS (refusal) |
| 22 | fieldRoute | `jobUnits.create` | `unitId` | job scoped; unit only through an eligibility check in *enforced* mode | wrote `jobUnits` putting A's truck on B's job | PARTIAL | `requireUnitInScope`, every mode | **yes** — an assignment | uSS; `fieldroute.test`, `dispatchJobDetail.db.test` |

### Found by the revalidation (not in the sweep)

The sweep matched only inline `unitId`/`trailerId`/`unitIds`/`assignedUnitId` with no known guard. The
revalidation also followed named input schemas, `trailerUnitId`/`approvedUnitIds`/`equipmentId`, and
mutations that checked ownership the non-canonical way.

| Router | Procedure | Unit argument / path | Scoping at base | Result at base | Class | Fix | Dispatch? | Tests |
|---|---|---|---|---|---|---|---|---|
| comms | `comms.authorizationRecord` | `approvedUnitIds[]` | none | stored A's unit in B's licence approval | UNSAFE (record integrity — nothing reads the field today) | seam over every id | no | uSS |
| records | `records.nearMiss.report` | `unitId` (guarded), `jobId` → the escalated incident's organization | unit only | an escalated near miss became an incident attributed to A's job | PARTIAL | job check; the escalation places its hold through `unitHolds` | yes, via the escalated incident's hold | uSS (foreign job) |
| contractorOperations | `contractorOperations.crewAssign` | `unitId` | `recordBelongsToOrganization` → FORBIDDEN "not owned"; a nonexistent id passed for the historical tenant | FORBIDDEN | PARTIAL (non-canonical; wrote assignments for units that do not exist) | seam, first | no readiness read | uSS |
| integration | `integration.loadSenseBindGateway` | `unitId`; **`trailerId` unchecked** | unit: `recordBelongsToOrganization` inside a PRECONDITION_FAILED; trailer: none | PRECONDITION_FAILED | PARTIAL (trailer UNSAFE) | seam (unit and trailer), first | no readiness read | uSS |
| manifestCustody | `manifestCustody.bind`, `.amend` | `unitId`, `trailerUnitId` (named `PARTY` schema, via `resolveParties`) | `recordBelongsToOrganization` → FORBIDDEN "not owned"; historical tenant: missing → NOT_FOUND, foreign → FORBIDDEN | refused, but distinguishable | PARTIAL (disclosure) | `requireUnitInScope` in `resolveParties` | no | `manifestCustody.db.test` (foreign, missing, trailer) |
| dispatch | `dispatch.evaluate` | `unitId`, `trailerId` | `assertReadinessSubjectInScope` | — | SAFE | none | yes | dispatch suites |
| fieldRoute | `gps.submitBreadcrumb` | `unitId` is **REFUSED** in its input; the unit is the one on the caller's in-scope trip | trip scoped | — | SAFE (listed in the guard with its reason) | none | no | existing GPS tests |
| commercialSetup | `commercialSetup.pricingDecide` | `unitId` selects which of the entity's rates applies | — | nothing written against the unit | NOT UNIT-AFFECTING (listed in the guard) | none | no | `commercialSetup.test` |
| enforcement | `enforcement.panelView` | none in its input — the unit comes from an issued grant | grant | closed by #9 | NOT UNIT-AFFECTING | none | no | `enforcementApi.test` |
| closeout | `closeout.siteSign` | none (a widened scan's false positive) | ticket scoped | — | NOT UNIT-AFFECTING | none | no | `siteCloseout.test` |
| fieldRoute | `units.create` | creates the unit | — | — | NOT UNIT-AFFECTING | none | no | — |
| integration | inbound machine paths (`integrationProcedure`) | the client's `orgRef` | look the unit up, then `recordBelongsToOrganization`; a failure **quarantines** the inbound event rather than throwing | — | SAFE under its own explicit contract (not a role mutation) | none | — | `integration*` tests |

Already SAFE through the same rule and wording at the base (accepted by the guard): `closeout.ticketOpen`,
`.weatherObserve`, `.roadHazardReport`; `fleet.holdPlace`, `.meterRecord`; `workOrders.create`;
`unitSafety.create`; `manifests.create`; `inspections.create`; `maintenance.create`; `shop.tireInstall`,
`.warrantyPolicyRecord`, `.recallRecord`, `.recallUnitDecide`; `spatial.vehicleProfileSet`,
`.vehicleProfileVerify`, `.routeEvaluateSegments`, `.routeApprove`, `.routeRequest`.

*uSS* = `server/unitScopeSecurity.db.test.ts`; *hAR* = `server/holdAuthorityReadiness.db.test.ts`.

**Unsafe or partial at the base: 26 mutations. Fixed: all 26** — 20 of the sweep's rows (every row but
#7, already safe, and #20, fixed in `18f3f68`) and six found by the revalidation: `comms.authorizationRecord`,
`records.nearMiss.report`, `contractorOperations.crewAssign`, `integration.loadSenseBindGateway`,
`manifestCustody.bind`, `manifestCustody.amend`.

## No hidden side effects on refusal

Every check runs first, outside any transaction. The cross-tenant suite counts, before and after, every
table each procedure writes that names the unit (and, for enforcement, `domainEventOutbox`); Part F
counts holds, portfolio events, defects, work orders, roadside and enforcement events, incidents and
outbox rows. All unchanged. The one row a refused call leaves is `roleProcedure`'s access log
(`authorizationDecisions`): it records the role decision and **no subject**, and the suite asserts it is
identical for another organization's unit and for a missing one.

## Incident holds — enabled (closes the portfolio's R-2)

`records.incident.capture` and an escalating `records.nearMiss.report` prove the unit **and the job** are
the caller's organization's, then write the incident and — when its escalation plan holds the unit — one
`unitHolds` row, in one transaction (`recordsService.insertIncidentHoldingUnit`):

- `holdType: safety` → `dispatchEffect: out_of_service` → readiness `unit_hold_safety`, blocking,
  `NEVER_OVERRIDABLE` (the portfolio design's `incident_unit_held` class);
- `sourceKind: incident`, `sourceRef` = the incident number, `orgRef` = the caller's organization,
  `placedByUserId` = the capturer, `placedByRole: incident_escalation` (the plan's authority, not the
  capturer's role);
- there is **no second representation**: readiness and the projection read only `unitHolds`;
  `incidentReports.unitHeld` stays the incident's own record of what its plan decided.

**Deviation from the design's wording, recorded:** the portfolio design (B.4) had the composer read
`incidentReports.unitHeld` directly. Per the owner's instruction ("use the portfolio `unitHolds` model; do
not create a second incident hold representation"), the flag is not read; the hold row is. The design's
release rule is kept: the hold is lifted by the incident's safety review.

**Release:** `fleet.holdRelease` refuses it (a workflow's hold is released by its workflow).
`records.incident.review` releases it, in the same transaction as the review, and applies the hold's rules
first: the reviewer may not be the capturer (who placed it), and must hold a role that releases a safety
hold (safety, management — exactly the `incident.review` holders). The projection names the act:
`liftedBy: "records.incident.review"`. `NOT_EVALUATED` no longer lists `incident_unit_held`.

## Hold release is a person's act — the agent boundary

Inspected first: `server/_core/actionGateway.ts` (`decide`, `NEVER_AUTONOMOUS`), `agentRouter` (every
request through the agent runtime is `actor.type = "agent"`; approvals of `NEVER_AUTONOMOUS` capabilities
need a second person), the P8 automation policy (engine modes; its `SAFETY_CEILINGS` list is reserved for
P8.4 by an explicit owner decision and a surface test, and was not edited), and the tRPC context (a
procedure call is always an authenticated person; there is no agent actor on a procedure).

- `fleet.holdRelease` added to `NEVER_AUTONOMOUS`: denied to an agent at any risk level, under any policy,
  with or without an approval on file.
- New `HUMAN_AUTHORIZATION_PERMISSIONS` = `fleet.hold.release`, `maintenance.record_release` (mechanic
  release — the return to service — and resolving the defects it names), `maintenance.revoke_release`,
  `enforcement.release` (out-of-service clearance). `decide` denies an agent **any capability that
  requires one**, whatever it is called. A test ties the list to the permissions the real release
  procedures use, and asserts no registered agent capability can reach one.
- The Secretary tool layer `main` landed during this checkpoint (`server/_core/ai/tools/registry.ts`)
  calls procedures **as the driver** — a second agent path besides the gateway. Its only tools read,
  propose (`assistant.draft`, pending) or put a request in front of a person; its refusal was by
  `NEVER_AUTONOMOUS` name. `agentMayNotCall` now also refuses any procedure whose permission is a
  human-authorization permission, so a tool naming `records.maintenance.recordRelease` or
  `enforcement.orderRelease` is unreachable however it is added. Every existing tool stays reachable.

**The invariant for CP2 and after** (documented, nothing reserved by name): an AI or agent may evaluate a
hold and prepare evidence; it may not release a safety, maintenance, regulatory or out-of-service hold,
and may not perform a mechanic release, a return to service, a safety-defect closure or an
out-of-service clearance. Each such act is authorized by one of the permissions above — or its new
permission is added to that list in the same change — and is performed by a person through its procedure.

P8.4 (engine automation ceilings) should record `MANUAL` for any engine capability that performs one of
these acts when that list is decided; no engine capability does today.

## Separation of duties (Part E) — through the real router and triggers

The placer cannot release; a role that does not release the type cannot (mechanic on a safety hold); a
role without the permission is refused by the role check; another organization's member gets NOT_FOUND
identical to a missing hold; an independent safety person releases it; releasing one of two holds leaves
the other active and readiness still blocked by it; an agent run's `requestAction(fleet.holdRelease)` is
denied and the hold stands; a released hold's row and its `hold_released` event refuse UPDATE and DELETE
(triggers from `0201`). Cancelling a work order leaves the defect open with no release reference, the
hold active, no `workOrderReleases` row, and the truck blocked.

## Readiness and fingerprint (Part F) — through `composeReadiness`

- Organization B's roadside, enforcement (unit and trailer), incident and hold placement on A's unit are
  each refused NOT_FOUND; A's verdict, **fingerprint** and blocker codes are byte-identical before and
  after, and no row anywhere changed.
- Inside A: a roadside breakdown blocks the truck and moves the fingerprint; an out-of-service inspection
  blocks it with a NEVER_OVERRIDABLE finding; a collision incident places its safety hold
  (NEVER_OVERRIDABLE), the independent review releases it and the fingerprint returns to the clean one.
- Safety hold → blocking, NEVER_OVERRIDABLE; maintenance hold → blocking, APPROVED_POLICY_ONLY; a warning
  hold adds `unit_hold_maintenance_warning` (WARNING_ONLY) and no blocking finding; truck and trailer holds
  are both read.

## Authorization inventory drift (Part G) — pre-existing, corrected separately

`PROCEDURE_AUTHORIZATION_INVENTORY.md` is hand-maintained; its test pinned one total string and nothing
else. On untouched `main` `3d05d32` (checked in a clean worktree with the new checker), **nine** rows
under-counted their routers — `recordsRouter` 17/18, `deviceRouter` 6/7, `complianceRouter` 9/18,
`requirementRouter` 6/7, `surfacesRouter` 5/6, `dispatchRouter` 8/13, `shopRouter` 23/25,
`integrationRouter` 7/11, `spatialRouter` 11/15 — and the bold total said 356 where the listed routers
held 384. The total also read like a system-wide figure; the system has 657 on `main` (669 here), which
`LEASEOS_CURRENT_STATE.md` already generates.

Fixed at the source: `scripts/procedure-inventory.mjs` reads every row's count from its router
(`roleProcedure("…")` call sites) and writes the numbers and the total; `procedureAuthorization.test.ts`
now requires every row to equal its router and the total to equal the rows' sum (the hand pin is gone).
The total line now says it covers the listed surfaces and points to the generated system-wide count.
Committed on its own, apart from the security changes.

## Migrations (Part H)

None. Ownership is derived from `coreRecordOwnership` by the existing `unitInScope`; incident holds use
`unitHolds` (0200) as it is (`sourceKind` already had `incident`). Nothing was added to cache ownership.

## Tests

| File | New / changed | What it proves |
|---|---|---|
| `server/unitScopeSecurity.db.test.ts` | new, 35 | every fixed mutation: foreign = missing (code, message, access-log row), nothing written; a caller holding every role is refused the same; ticket and job paths; the historical tenant's rule; same-organization success for roadside, enforcement, comms, panel grants, delays, jobUnits, incidents, near misses |
| `server/holdAuthorityReadiness.db.test.ts` | new, 11 | Part E and Part F above |
| `server/unitScopeGuard.test.ts` | new, 5 | the structural guard; verified to fail when one fix is removed |
| `server/actionGateway.test.ts` | +5, pin updated | agent refused `fleet.holdRelease` and every return-to-service permission; a person is not; the permission list matches the real procedures |
| `server/_core/ai/agentTools.test.ts` | +2 | the tool layer refuses every release procedure by permission; every Secretary tool stays reachable |
| `server/_core/fleetPortfolio.test.ts`, `server/contractorCommercialChainBoundary.test.ts` | changed | `incident_unit_held` is evaluated now; the crew unit check is the canonical one (both failed the first CP1.5 gate run and were corrected — they asserted the old behaviour) |
| `server/dispatchRole{Readiness,Staffing,Unassign}.db.test.ts` | band moved | pre-existing `main` failure, see `6510d55` |
| `server/procedureAuthorization.test.ts` | changed | every inventory row equals its router; total equals the sum |
| `server/manifestCustody.db.test.ts` | changed | foreign unit / missing unit / foreign trailer → canonical NOT_FOUND (was FORBIDDEN "not owned") |
| `server/enforcementApi.test.ts`, `enforcementOutbox.test.ts`, `productionPath.test.ts`, `insuranceRisk.test.ts` | fixtures corrected | they named `unitId: 127` or random ids — whichever unit another test had made, or none — i.e. the cross-tenant write this checkpoint closes. Each now uses a unit of the caller's own tenant |

## Gate

`scripts/ci-gate.sh` on `59642ba` (current state regenerated), from a dropped and recreated database —
**PASS**, every section:

| Section | Result |
|---|---|
| Runtime version truth; reserved `0016`/`0017` | clean |
| Migrations from empty | 181 applied (no new migration) |
| Table parity; column parity | 419 = 419; OK |
| Production typecheck; test typecheck | clean; 0 test-file errors (ceiling 0) |
| Bare `protectedProcedure` | 0 |
| Full suite | **386 files, 5,660 passed, 3 skipped (5,663)**; no database-backed suite skipped |
| Production build | built |
| External (36) and machine (2) gates | pinned counts hold |
| Current-state document is generated | current |

Focused suites inside that run, all passing: `unitScopeSecurity.db` 35, `holdAuthorityReadiness.db` 11,
`unitScopeGuard` 5, `actionGateway` 32, `ai/agentTools` 27, `ai/workerBoundary` 10, `testIdBands` 3,
`agentRuntimeApi` 31 (3 skipped, as on `main`), `aiRequestBoundary` 11, `procedureAuthorization` 35,
`documentationTruth` 24, `fleetPortfolio.db` 9, `_core/fleetPortfolio` 10, `maintenance.db` 6 (mechanic
CP1), `tripUnitScope.db` 5, `manifestCustody.db` 10, `enforcementApi` 39, `enforcementOutbox` 7,
`productionPath` 1, `insuranceRisk` 25, `purchasingAp` 27 (roadside), `readinessDefectRepair.db` 25,
`dispatchReadinessPanel.db` 25, `complianceReadinessC1a.db` 17, `dispatchGate` 13, the five
`dispatchRole*.db` suites.

Earlier runs on the way, for the record: the first CP1.5 gate failed two tests that asserted the old
behaviour (`fleetPortfolio.test` listing `incident_unit_held` as not evaluated; a source-text test for
`recordBelongsToOrganization` in `crewAssign`) — both this checkpoint's, both corrected; after `main`
moved, two failures were proved to fail identically on untouched `main` `c626146` and fixed on their own
(`6510d55`, `59642ba`). No failure was labelled pre-existing without that proof.

## After the freeze — `main` moved to `9569195`, which is red on its own

Frozen on `59642ba` (containing `main` `c626146`), gate green. Immediately after, `main` advanced to
`9569195` (finance F1, PR #56). A merge was prepared and **not pushed**:

- **`main` `9569195` fails 10 tests in 3 files on its own** — verified in a clean worktree of untouched
  `9569195` against the same database: `requirementVerification.db` (7), `requirementRegistry.db` (2),
  `financeScopeCoverage` (1). F1.2 ("scope compliance subjects to the caller's organization") and C1b-2b
  (requirement verification, #54) meet: the five C1b-2b compliance procedures are unclassified in F1.2's
  coverage list, and the verification suites' subjects now fail `requireSubjectInScope`. Resolving it is
  a compliance-scoping decision for that work's owner, not a mechanical fix, so it is not made here.
- **The prepared merge** (kept locally as `local/cp15-merge-main-9569195`, gate otherwise green: 385 of 388
  files) resolves F1's overlap with this checkpoint: F1 added its own unit check,
  `financeScope.requireUnit` — the same `unitInScope` rule, different wording — to seven procedures
  CP1.5 had already scoped. The resolution keeps **one** refusal: `requireUnit` calls
  `server/unitScope.ts` (with an optional `Trailer` label); CP1.5's check stays first where both existed
  and F1's duplicate unit line goes (its job, trip and book checks stay); the guard accepts `requireUnit`
  and verifies it delegates. F1 also scoped `roadside.open`'s job and trip and the book of
  `definitionPropose`, `expenseCreate`, `distanceRecord`, `purchasing.request` — closing several of the
  non-unit residuals below.

When `main` is green again, that merge is re-made (or the prepared one replayed) and the gate re-run
before CP2 builds on it.

## Unresolved (outside this checkpoint's scope — not unit mutations, not fixed here)

- **Non-unit ids** some of these mutations accept are not scoped, seen during CP1.5 or reported by the
  sweep and not re-audited exhaustively: `roadside.open` `jobId`/`tripId`; `enforcement.eventConfirm`
  `operatorId`/`jobId` (readiness filters enforcement events by the unit owner's tenant, so these do not
  reach another organization's readiness); `closeout.delayRecord` `jobId`/`tripId`; `trips.create`
  `jobId`/`operatorId`/`manifestId`/`destinationFacilityId`; `financialEntityId` on
  `commercialSetup.definitionPropose`, `ifta.distanceRecord`, `finance.expenseCreate`,
  `purchasing.request` (money scope). A job/trip/operator/entity sweep of the same shape is the natural
  follow-up; the unit guard's pattern extends to it.
- `payroll.submitTime`, `finance.expenseCreate`, `assistant.draft`, `contractorOperations.crewAssign` and
  `integration.loadSenseBindGateway` have refusal tests but no same-organization success test (none
  existed before; building their fixtures was out of scope).
- P8.4's ceiling list stays empty by its own owner decision; see the agent section.
