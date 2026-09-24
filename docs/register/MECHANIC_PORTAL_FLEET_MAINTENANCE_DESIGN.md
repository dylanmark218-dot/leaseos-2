# Mechanic Portal + Fleet Maintenance — domain design

Written against `6f52b57` (v23.25, migration head `0174`). **A proposal, no code.** Nothing in this
document is built, and nothing below is claimed as built unless the survey found it in the tree.

This is the design the owner asked for before any screen is made: a survey of what LeaseOS already
holds for units, inspections, defects, work orders, releases, parts, documents, notifications and
dispatch readiness, then a domain model that sits on those tables rather than beside them, then the
eight checkpoints in the order the dependencies force.

The rule this design is built under, from the master manifest, rule 14: *mechanic release is
separate from "work order complete"; a critical defect cannot disappear merely because a work order
status changed.* Every table and procedure below is checked against it.

---

## Revision 2026-09-24 — built on the Fleet & Equipment Portfolio, not beside it

The first version of this document was written from a survey of `main` and missed an unmerged design
on `claude/fleet-equipment-portfolio-design-3d13d5`:
`docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md`. The owner named that portfolio as the
foundation this module must sit on, and it already specifies four things this document proposed
differently. Where they overlap, **the portfolio's model governs**, and this module consumes it:

| Concept | This document proposed | The portfolio specifies | Now |
|---|---|---|---|
| Manual holds | `unitServiceHolds` (`kind`, lifted by a second person) | `unitHolds` (`holdType` safety / maintenance / inspection / compliance / damage / administrative, `dispatchEffect` block / warn, type-gated release, `orgRef`, evidence) | **`unitHolds`**. §3.3's `unitServiceHolds` is withdrawn |
| Meters | copy every odometer and hour figure into `unitMeterReadings` (int minor units, correction chain) | a manual ledger for readings with no home, and every other source **read in place** with its label — master-manifest rule 3 forbids duplicating distance values across tables | **the portfolio's ledger plus the read-in-place union.** The copy design and its back-fill are withdrawn |
| Unit state | `unitServiceState` projection | `fleetPortfolio.operationalState(facts)` with lifecycle stored and operational state derived | **`operationalState`**. §3.4 is withdrawn |
| Hold codes in readiness | `unit_hold_<kind>`, all non-overridable | `unit_hold_<type>` with block holds `APPROVED_POLICY_ONLY` and warn holds `WARNING_ONLY` | **the portfolio's table** (§B.5 there) |

Two further facts changed since the first version:

- **The 0169 release blocker is closed.** `claude/migration-0169-reconciliation` merged (PR #17)
  and renumbered the trip-stop provenance migration forward as `0179`.
- **Migration numbers.** `0175`–`0188` are all claimed by open branches. The first number free on
  `main` and every branch is `0189`, which checkpoint 1 took.

**Consequence for the sequence (§9).** The portfolio's own plan runs Fleet Asset Core → Inspections
and Defects → Documents → a mechanic work-order portal. That overlaps this document's CP2–CP6. The
recommendation, for the owner (O-11 in §10), is one sequence, not two:

1. **Mechanic CP1 — done:** work-order ownership and cancellation, and four survey fixes (below).
   Nothing in it overlaps the portfolio.
2. **Portfolio Fleet Asset Core** — `unitHolds`, the meter ledger and union, `operationalState`,
   lifecycle, components, `fleetPortfolioEvents`, hold codes in readiness.
3. **Portfolio checkpoint 2 (Inspections and Defects), absorbing this document's CP2** — the defect
   history, severity proposal and triage, defect → work order in one transaction, work-order tasks,
   one release door, roadside close.
4. **This document's CP3–CP8 on that foundation** — preventive maintenance reading the portfolio's
   meter union, parts and labour and costs, the portal UI, driver alerts and the lockout (placing
   `unitHolds` of type `maintenance` / `safety` rather than a table of its own), history and reports,
   the release gate.

Sections below that describe withdrawn tables are left as written and marked, so the reasoning that
was replaced can be read.

---

## 0. The one thing to decide first: the SPINE moratorium

`docs/register/SPINE_WIRING_PLAN.md` states, hash-pinned by `server/spineWiringPlan.test.ts`: *"The
moratorium stands: no new engines until this path is wired."* Owner decision **D-01**
(`docs/compliance/unified-compliance-engine-design.md` §23) confirms it: reconciliation, wiring,
safety fixes and consolidation are permitted; no new standalone engine until the compliance path is
wired through the spine. `server/engineReachability.test.ts` enforces it mechanically: the unwired
engine count is pinned at 57, so a new `server/_core` module must be reached from production or the
gate fails.

This module is not on the spine. Most of what it needs **is** permitted work — routers over
`fleetShop.ts` and `mechanicRelease.ts`, wiring emitters and workflow seeds that are written and
never called, and closing readiness gaps that are safety fixes. Checkpoints 1, 2, 6 and most of 7
are that kind of work. Two parts are not:

| Needs D-01 amended | Why it cannot be a router over existing state |
|---|---|
| Preventive maintenance (checkpoint 3) | there is no interval, no due figure, no service definition and no meter history anywhere in the tree — `grep serviceInterval\|pmSchedule\|nextServiceKm` returns nothing |
| Meter readings as a record (checkpoint 1) | odometer and hours exist only as columns on six unrelated rows (§1.3); "service due in 750 km" has nothing to read |

**Recommendation:** amend D-01 to name this module as the first post-spine domain, on the condition
that every new engine ships wired in the same checkpoint (never a `DECLARED_UNWIRED` entry), and
that no migration lands until the `0169` reconciliation blocker named in
`docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md` is closed (it closed on 2026-09-24 as `0179`).
The amendment is recorded as an owner decision in §10 and in the checkpoint document, not implied.

*Revision 2026-09-24:* the meter record in the table above is now the portfolio's, and the
portfolio's own survey reaches the same moratorium reading (its C-1): a projection plus a router,
with any new `_core` module reached from its router in the same PR. Checkpoint 1 as delivered adds
no `_core` module at all.

---

## 1. What exists — the reuse map

Status words as in `docs/register/SCOPE_RECONCILIATION_2026-09-21.md`: **BUILT** · **PARTIAL** ·
**UNWIRED** (code exists, production never reaches it) · **MISSING**.

### 1.1 Against the owner's list

| Owner's requirement | Status | Where it lives today | What is missing |
|---|---|---|---|
| Work orders — status, priority, notes | **PARTIAL** | `workOrders` (0008): status `draft/open/in_progress/waiting_parts/ready_for_service/closed`, priority `routine/urgent/critical`; `shop.workOrderAdvance` moves forward only | no `cancelled`; no tasks; `technician` is free text; `laborMinutes` is one number; the advance `note` is discarded and `startedAt`/`completedAt` are never set; `fieldRoute.workOrders.update` can set any status backwards |
| Work orders — downtime | **MISSING** | `asset.twin` derives `completedAt − openedAt` | no hold placed/lifted record to derive real downtime from |
| Work orders — photos, signatures | **PARTIAL** | `evidenceRelationships.entityType` has `workOrder`, `inspection`, `unit`; `workOrderReleases` names the technician from `ctx.user.id` | nothing serves evidence bytes to a reader (`storageGetSignedUrl` has two callers, neither the shop); no release evidence column; no `defect` relationship type |
| Mechanic inspections, CVIP, return-to-service | **PARTIAL** | `inspections` (0003): `training/pre_trip/post_trip`, `pass/fail/needs_maintenance/not_applicable`, checklist as text; CVIP is a `complianceDocuments` row of docType `cvip_certificate` read by readiness | no mechanic, CVIP or return-to-service inspection type; no per-item results; a failed pre-trip creates no defect and holds nothing; `workOrders.inspectionId` is written by nothing |
| Driver defect handover | **PARTIAL** | assistant form `defect_report` → `maintenanceDefects`; direct `compliance.maintenance.create`; field capture kinds `pretrip/posttrip/defect_report` exist with tier-0 sync | the assistant path hardcodes `severity: "advisory"`; no typed pre-trip form or commit adapter; no defect ↔ inspection link; the driver's severity proposal has no column |
| Preventive maintenance by km / hours / days, whichever first | **MISSING** | — | no service definitions, no schedules, no completions, no "next due" |
| Parts and inventory | **BUILT** | `parts`, `partMovements` ledger (0051), `issueDecision`, `reorderFindings`, cores, counts | returns do not carry `workOrderId` so cost overstates after a return; reorder is a finding, not an exception or purchase proposal |
| Complete service history per unit | **PARTIAL** | `surfacesService.loadTimeline("unit")` reads defects, releases, roadside, fuel, disposal | no work orders, inspections, meters, PM completions, holds in it |
| Odometer / engine / PTO hours | **PARTIAL** | readings on `workOrders`, `trips`, `fuelTransactions`, `bulkFuelDispenses`, `tireInstallations`, `tireMeasurements`, `telemetrySnapshots` (odometer, engine, PTO, idle) | no per-unit meter record, no provenance, no correction history, no pump/vacuum meter; `telematics.unit` reconciles three sources ad hoc |
| Scheduling notifications | **UNWIRED** | `workflowNotifications` + inbox; `workflowSeeds` `fleet.*` rules; `domainEmitters` `emitCriticalDefectOpened`, `emitDefectSentToShop`, `emitMechanicReleased`; `escalation.ts` ladder | none of the fleet emitters is called from production; no internal acknowledge procedure; only enforcement and customer alerts write notifications |
| Driver notifications ("service due in 750 km", "do not operate") | **MISSING** | inbox channel exists | no "my unit today" resolver — `whatAmIMissing` takes the unit from the caller; nothing unit-driven writes a driver notification |
| Mechanic assignment, shop, expected completion, labour time | **MISSING** | `technician` varchar; `laborMinutes` double; labour rate is a query parameter | no assignment record, no labour entries, no stored rate, no shop location |
| Attachments / evidence | **PARTIAL** | records vault (0019): seal, versions, retention, access events; `vendorBills.evidenceRecordId` | see photos row; `vendorBills.workOrderId` exists and no procedure accepts it |
| Costs per unit / km / hour | **PARTIAL** | `workOrderCost`, `unitCost` name what they cannot know | labour unknown without a rate; outside-shop bills unreachable from the work order; km and hours come from work-order columns, not a meter |
| Warranty / recall / bill-to | **PARTIAL** | `warrantyPolicies`, `warrantyClaims` (two-person), `recallNotices`, `recallUnitStatus` | no bill-to on a work order; recall status never reaches readiness; `recallNotices.status` never changes |
| Audit history | **PARTIAL** | `authorizationDecisions` (who called what); `workOrderReleases` append-only; `dispatchRoleAssignmentEvents` is the append-only precedent | no defect history (severity changes, triage, who sent to shop); `MaintenanceStage` in `mechanicRelease.ts` is pure and never persisted |
| Maintenance hold dispatch cannot bypass | **PARTIAL** | readiness blocks on `critical_defect`, `mechanic_release_missing`, `oos.*`, `roadside_event_open`, critical faults — none overridable (`readinessDefectRepair.db.test.ts` M1–M18, E1–E6) | `units.maintenanceStatus` is written once at creation and only ever yields a manager-overridable `review`; no explicit hold with a reason a driver can read; failed pre-trip, recall and `deviceSafetyLatches` never reach readiness; slot binding (`setRoleAssignment`) never consults readiness; a roadside event can never be closed once open, so its blocker is permanent |

### 1.2 Engines to reuse unchanged

| Engine | Reused for |
|---|---|
| `server/_core/mechanicRelease.ts` — `evaluateMechanicRelease`, `currentReleaseEvidenceFor`, `unitServiceStateAfterRelease` | the release act and its read-back; the return-to-service decision |
| `server/_core/fleetShop.ts` — `stockPositions`, `issueDecision`, `reorderFindings`, `tireRun`, `claimEligibility`, `workOrderCost` | parts, tires, warranty, cost |
| `server/_core/oosReleasePolicy.ts` | who may record a release finding on a government order; unchanged, and a mechanic release never lifts one |
| `server/readinessComposer.ts` + `server/_core/dispatchReadiness.ts` + `complianceFinding.ts` `CLASSIFICATION` | the dispatch lockout; this module adds contributions, never a second readiness authority (D-06) |
| `server/_core/exceptionCentre.ts` | overdue PM, unassigned critical work orders, reorder shortfalls — derived, never stored |
| `server/_core/workflowEngine.ts` + `workflowSeeds.ts` + `escalation.ts` | task creation and the escalation ladder for critical defects |
| `server/_core/evidenceSeal.ts`, `recordsService.ts` | photos, forms, invoices, signatures on work orders and inspections |
| `server/_core/attachmentAuthorizers.ts` | message-board attachments of defects, units, work orders |
| `server/_core/telematics.ts` `odometerReconciliation`, `faultDispatchEffect` | one input to the meter record; fault → defect stays as built |
| `server/_core/purchasing.ts` | outside-shop bills; `billApprovalReleasesUnit` stays `false` |

### 1.3 Where an odometer lives today (so the meter record can be seeded honestly)

| Column | Type | Written by |
|---|---|---|
| `workOrders.odometerKm` / `engineHours` | double | `fieldRoute.workOrders.create/update` |
| `trips.odometerStartKm` / `odometerEndKm` | double | `trips.create/update` |
| `fuelTransactions.odometerKm` / `engineHours` | double | `fuel.dispenseRecord`, `inbound.ingest`, assistant fuel receipt |
| `bulkFuelDispenses.odometerKm` | double | `fuel.dispenseRecord` |
| `tireInstallations.installOdometerKm` / `removeOdometerKm`, `tireMeasurements.odometerKm` | int | `shop.tireInstall/Remove/Measure` |
| `telemetrySnapshots.odometerKm` / `engineHours` / `ptoHours` / `idleMinutes` | double / int | `inbound.ingest` feed `vehicle_telemetry` |

None carries provenance beyond the row it sits on, none can be corrected, and no two agree by
construction. The meter record in §3.3 makes each of these a *source* of a reading rather than the
reading itself.

### 1.4 Defects found in the survey (fixed inside the checkpoints, listed so nothing is silent)

| # | Finding | Fixed in |
|---|---|---|
| S-1 | Two release doors: `shop.workOrderRelease` writes `resolvedDefectIds`; `records.maintenance.recordRelease` does not, so a release made there never counts as evidence for a critical defect | CP2 — one door |
| S-2 | `fieldRoute.workOrders.update` accepts any `status`, bypassing `workOrderAdvance`'s forward-only rule | CP1 |
| S-3 | `shop.partReturn` writes no `workOrderId`; `workOrderCost` overstates after a return | CP4 |
| S-4 | `roadsideServiceEvents.status` is only ever set to `vendor_assigned`; an open event blocks the unit forever | CP2 |
| S-5 | The assistant defect form hardcodes `severity: "advisory"` | CP2 |
| S-6 | `inspections.status = fail` creates no defect and reaches no readiness input | CP2, CP6 |
| S-7 | `shop.workOrderAdvance` discards `note`, never sets `startedAt`/`completedAt` | CP1 |
| S-8 | `telematicsRouter` and `assetRouter` apply no tenant scope; `fieldRoute.workOrders.list` without a unit is unscoped | CP1 |
| S-9 | No procedure returns evidence bytes to a mechanic; `evidenceInScope` never looks at a unit or work-order relationship | CP7 |
| S-10 | `recallUnitStatus` and `inspectionStatus` never reach readiness | CP6 |
| S-11 | `vendorBills.workOrderId` and `purchaseAuthorizations.workOrderId` exist and no input accepts them | CP4 |
| S-12 | `server/readinessRouter.ts:48` compares `operators.id` to a user id (shift readiness, kept under D-06 until behavioural equivalence) | named, not this module's |
| S-13 | `dispatchRoleService.setRoleAssignment` binds a unit to a slot without consulting readiness | CP6 (hold refusal only; readiness at binding stays a SPINE item) |

---

## 2. Constraints every checkpoint inherits

- **Tenancy.** `units` carry no organization column; ownership is `coreRecordOwnership` and every
  unit-keyed row is scoped through `unitInScope` / `workOrderInScope` (`server/db.ts:800,806`).
  New tables that hang off a unit follow the same rule and add no `orgRef`. New tables that do not
  (labour rates, service definitions) carry a nullable `orgRef varchar(64)` where NULL is the
  historical single tenant, never `tenantId` (`tenantIsolation.test.ts` pins the exceptions). Out of
  scope answers NOT_FOUND, never FORBIDDEN. The tenant is never read from input.
- **Fail closed.** Every procedure is `roleProcedure`; every act that creates operational fact has its
  own permission; acts that hold or free a unit are in `SENSITIVE_PERMISSIONS`.
- **Unknown is never clear.** A meter with no reading is unknown, not zero. A schedule whose meter
  is unknown is *not evaluable*, and says so, rather than "not due".
- **No silent overwrite.** Corrections append. Severity changes, assignments, holds, labour and
  meter corrections are rows with an actor, a reason and the prior value.
- **Money in integer minor units.** `*Cents int`. No new double anywhere; hours are stored in
  tenths as `int`.
- **Propose → evidence → confirm → commit.** AI may classify or route a driver's words; it never
  sets a severity. Telematics proposes a reading; a mechanic confirms a fault's severity.
- **Migrations.** Next free slot on main and all open branches is **`0175`**; `0172`/`0173` belong
  to `claude/training-academy-workforce-q3mdse`; `0016`/`0017`, `0094`/`0095`/`0098` and the second
  `0157` are never reused. Claims go into `docs/architecture/MIGRATION_COLLISION_REGISTER.md` at the
  checkpoint that lands them. `drizzle/schema.ts` is hand-written; `CREATE TABLE` starts a line;
  never edit an applied file.
- **Drift guards** that move with every checkpoint: `OPERATIONAL_PROCEDURE_PERMISSIONS` count pin
  (634 today, in two tests), `engineReachability` unwired pin (57), the inventory row and total in
  `PROCEDURE_AUTHORIZATION_INVENTORY.md`, the `documentationTruth` router-phrase table, the
  `current-state.sh` heredoc, and `a11yCoverage` for every new `.dom.test.tsx`.

---

## 3. The domain model

### 3.1 The two chains, on the tables that carry them

**Chain A — corrective**

```
Unit ─→ Defect ─→ Work Order ─→ Work Order Task ─→ Parts Used ─→ Evidence ─→ Return-to-Service ─→ Service History
units   maintenanceDefects  workOrders  workOrderTasks(new)  partMovements  evidenceRecords+  workOrderReleases     derived read model
        + maintenanceDefectEvents(new)  + workOrderAssignments(new)          evidenceRelationships  + inspections(type return_to_service)
        + inspections/inspectionItems   + workOrderLabourEntries(new)                              + maintenanceDefects.resolved*
```

**Chain B — preventive**

```
Unit ─→ Maintenance Schedule ─→ Upcoming Due Event ─→ Notification ─→ Completed Service ─→ Next Due
units   maintenanceServiceDefinitions(new)   derived, never stored   workflowNotifications   maintenanceServiceCompletions(new)   derived
        unitMaintenanceSchedules(new)        from unitMeterReadings  + exceptionCentre       ← a workOrderTask of kind pm_service
```

**The spine both chains hang from:** `unitMeterReadings` (new, append-only) — every km and hour
figure the system has, with its source. And the state both chains change: the **unit service
state** — `available / restricted / held / unknown` — which is **derived on every read** from
defects, releases, holds, orders, roadside events, faults and failed inspections, and is never a
column. `units.maintenanceStatus` and `units.inspectionStatus` are retired as inputs (kept as
columns, read by nothing, so no migration removes them under this design).

### 3.2 Existing tables: what changes (all additive `ALTER`s, one migration each checkpoint)

**`maintenanceDefects`** (CP1)

| Column | Why |
|---|---|
| `defectRef varchar(64) UNIQUE` | a tracking number; rule 8, 9 |
| `source enum('driver_pre_trip','driver_post_trip','driver_report','mechanic_inspection','pm_service','telematics','roadside','enforcement','recall','office')` | provenance; every insert site names its own |
| `system varchar(40)` | the assistant form's system list, kept as data (`Brakes`, `Steering`, `Lights`, `Tires`, `Coupling`, `Pump / PTO`, `Tank`, `Hoses`, `Engine`, `Other`) |
| `driverStatement text` | the driver's exact words, byte-for-byte; `detail` keeps the mechanic's notes — "one is an observation, the other is a finding" |
| `severityProposed enum(...)`, `severityProposedByUserId` | what the reporter proposed; never what readiness reads |
| `severityDecidedByUserId`, `severityDecidedAt` | the triage act (§4: sensitive) |
| `inspectionId int`, `inspectionItemId int` | the pre-trip line that raised it |
| `sourceRef varchar(120)` | `faultCodes.id`, `roadsideServiceEvents.eventRef`, `enforcementViolations.violationRef`, `recallUnitStatus.id` |

`severity` stays the three-value enum readiness and the release evaluator are built on. Whether a
driver's proposal of `critical` holds the unit *before* triage is an owner decision (§10, O-3); the
recommended default is **yes** — a reported critical is treated as critical until a mechanic says
otherwise, because the failure mode of the other choice is a truck that should not move.

**`workOrders`** (CP1)

| Column | Why |
|---|---|
| `kind enum('corrective','preventive','inspection','recall','warranty','roadside')` | which chain opened it |
| `status` gains `'cancelled'` | the owner's list; forward-only, with a reason, never from `closed` |
| `openedByUserId`, `cancelledAt`, `cancelledByUserId`, `cancelReason varchar(400)` | provenance |
| `shopFacilityId int` | the shop; `facilities` already exists |
| `expectedCompletionAt timestamp` | the promise dispatch plans around |
| `billTo enum('internal','warranty','customer','third_party','insurance')`, `billToRef varchar(120)`, `billToDecidedByUserId` | the owner's "billed internally, to warranty, or to another party" |
| `openingMeterReadingId int`, `closingMeterReadingId int` | replaces `odometerKm`/`engineHours` as the source; those columns stay, dual-written, read by nothing new |

`technician`, `laborMinutes`, `parts` stay as legacy columns, written by nothing new.

**`workOrderReleases`** (CP2): `returnToServiceInspectionId int` (the inspection that proved it),
`releaseEvidenceRecordId int` (the signed form, sealed), `deviceSignatureRef` where the device
attests the signature as `fieldTicketSignatures` does.

**`inspections`** (CP2)

| Column | Why |
|---|---|
| `inspectionRef varchar(64) UNIQUE` | tracking number |
| `type` gains `'mechanic'`, `'cvip'`, `'return_to_service'`, `'pm_service'`, `'roadside_follow_up'` | the owner's list; `training/pre_trip/post_trip` stay |
| `outcome enum('pass','pass_with_defects','fail','out_of_service','not_established')` | `status` stays for the legacy three; readiness reads `outcome`, and `not_established` denies rather than passes |
| `inspectorUserId int` | mechanic inspections; `authenticatedOperatorId` stays for drivers |
| `workOrderId int`, `defectFollowUpOfId int` | defect follow-ups and return-to-service |
| `certificateDocumentId int` | the `complianceDocuments` row (`cvip_certificate`) a CVIP produced; the requirement engine keeps reading that row |
| `meterReadingId int` | the reading taken at inspection |
| `evidenceRecordId int` | the signed form |

New child **`inspectionItems`**: `inspectionId`, `seq`, `itemKey varchar(80)` (from the checklist
definition), `result enum('pass','fail','not_applicable','not_checked')`, `note varchar(400)`,
`defectId int` (the defect a failed line raised — one line, one defect). A `fail` line with no
defect is refused at commit: the reason the pre-trip failed must exist as a defect the shop can see.

**`partMovements`** (CP4): `workOrderTaskId int`; returns carry `workOrderId` (S-3).

**`evidenceRelationships.entityType`** (CP7): add `'maintenanceDefect'`, `'maintenanceSchedule'`.

**`vendorBills` / `purchaseAuthorizations`** (CP4): no schema change; `workOrderId` accepted at
`vendor.billRecord` and `purchasing.request`, scoped through `workOrderInScope`.

### 3.3 New tables

Every table below is append-only unless a `status` column is named, and every one is scoped
through `unitId` unless it carries `orgRef`. Column types follow the repo: `int` ids, `varchar`
refs, `timestamp`, `enum`, integer minor units.

> **Withdrawn 2026-09-24** — superseded by the portfolio's `unitMeterReadings` manual ledger and
> read-in-place union (see the revision at the top). Kept for the reasoning.

**`unitMeterReadings`** (CP1) — the meter record

| Column | Notes |
|---|---|
| `id`, `readingRef varchar(64) UNIQUE` | |
| `unitId int NOT NULL` | scope |
| `meterType enum('odometer_km','engine_hours','pto_hours','pump_hours','vacuum_hours','idle_hours')` | the manifest's six |
| `valueMinor int NOT NULL` | km as whole km; hours as tenths — the minor unit is a property of `meterType`, never of the row |
| `source enum('telematics','work_order','trip','fuel','tire','inspection','driver_capture','manual','correction')` | |
| `sourceTable varchar(60)`, `sourceId int` | the originating row (`telemetrySnapshots.id`, `trips.id`, …) |
| `recordedAt timestamp NOT NULL` | when the meter read this, per the source |
| `recordedByUserId int`, `deviceRef varchar(80)` | one of the two is required |
| `confidence enum('measured','stated','derived')` | telematics = measured; a driver's typed figure = stated; trip distance summed onto a prior reading = derived |
| `supersedesReadingId int`, `correctionReason varchar(400)` | a correction is a new row naming the one it replaces; the old row stays |
| `createdAt` | |

Index `(unitId, meterType, recordedAt)`. **The current meter** is a pure function:
`currentMeter(readings, meterType)` = the newest non-superseded reading, and it answers `unknown`
with a reason when there is none, when the newest is `derived` from a stale base, or when two
sources disagree beyond `odometerReconciliation`'s tolerance — a discrepancy is surfaced, never
averaged. Every existing writer in §1.3 also inserts a reading here from CP1 on (dual-write, the
same shape as the money shadows), so the record fills from the day it exists; the historical
columns are back-filled by one script with `source` set truthfully and `confidence: 'stated'`.

> **Withdrawn 2026-09-24** — superseded by the portfolio's `unitHolds`. Kept for the reasoning.

**`unitServiceHolds`** (CP1) — explicit holds

The derived holds (unresolved critical defect, active OOS order, open roadside event, critical
fault) stay derived; the source of truth for each is the record that produced it. This table holds
only the holds that are *acts*:

| Column | Notes |
|---|---|
| `id`, `holdRef varchar(64) UNIQUE` | |
| `unitId int NOT NULL` | |
| `kind enum('safety','inspection_failed','pm_overdue','recall','manual')` | |
| `reason varchar(600) NOT NULL` | what the driver reads |
| `sourceTable varchar(60)`, `sourceId int` | the inspection, schedule, recall or defect that justified it |
| `placedByUserId int NOT NULL`, `placedByRole varchar(40)`, `placedAt timestamp NOT NULL` | |
| `liftedAt timestamp`, `liftedByUserId int`, `liftedByRole varchar(40)`, `liftReason varchar(600)` | |
| `liftedByReleaseId int`, `liftedByInspectionId int` | a `safety` hold lifts only with both: a standing release and a `return_to_service` inspection whose `outcome` is `pass` |
| `createdAt` | |

A hold is never updated except to be lifted; a second hold for the same reason is a new row. Index
`(unitId, liftedAt)`.

**`maintenanceDefectEvents`** (CP2) — the audit history the owner asked for, and the persisted
`MaintenanceStage`

| Column | Notes |
|---|---|
| `id`, `eventRef varchar(64) UNIQUE`, `defectId int NOT NULL`, `unitId int NOT NULL` | |
| `eventType enum('reported','severity_proposed','severity_decided','triaged','sent_to_shop','work_started','waiting_parts','repaired','released','resolved','reopened','hold_placed','hold_lifted')` | |
| `fromValue varchar(120)`, `toValue varchar(120)` | old and new severity, stage, status |
| `reason varchar(600)` | |
| `actorUserId int NOT NULL`, `actorRole varchar(40) NOT NULL`, `actorSource enum('human','system','ai','integration')` | |
| `workOrderId int`, `releaseId int`, `evidenceRecordId int` | |
| `occurredAt timestamp NOT NULL`, `createdAt` | |

Written inside the same transaction as the change it records (the enforcement commit is the
precedent: "a real domain-event row is written inside the same transaction as the order").

**`workOrderTasks`** (CP2)

| Column | Notes |
|---|---|
| `id`, `taskRef varchar(64) UNIQUE`, `workOrderId int NOT NULL`, `seq int NOT NULL` | |
| `kind enum('inspect','diagnose','repair','replace','adjust','pm_service','road_test','recall','other')` | |
| `title varchar(220) NOT NULL`, `instructions text` | |
| `defectId int` | many tasks may name one defect; a work order may carry several defects through its tasks — `workOrders.defectId` stays as "the defect that opened it" |
| `scheduleId int` | a `pm_service` task names the schedule it satisfies |
| `status enum('open','in_progress','done','not_required','deferred')` | forward only; `deferred` needs a reason and creates a follow-up work order or a note on the schedule, never silence |
| `assignedUserId int` | |
| `findings text`, `correctiveAction text` | per task, so a release can cite the task that did the work |
| `completedByUserId int`, `completedAt timestamp` | |
| `deferredReason varchar(400)`, `createdAt`, `updatedAt` | |

**`workOrderAssignments`** (CP1) — append-only, the `dispatchRoleAssignmentEvents` shape

`eventRef`, `workOrderId`, `eventType enum('assigned','reassigned','unassigned')`, `fromUserId`,
`toUserId`, `shopFacilityId`, `expectedCompletionAt`, `reason`, `actorUserId`, `actorRole`,
`occurredAt`, `createdAt`. The current assignee is the newest row; nothing updates one.

**`workOrderLabourEntries`** (CP4) — append-only

`entryRef`, `workOrderId`, `workOrderTaskId`, `technicianUserId NOT NULL` (the caller, never the
body), `startedAt`, `endedAt`, `minutes int NOT NULL`, `rateCentsPerHour int` (the rate in force
when recorded, snapshotted so a later rate change cannot reprice history), `labourRateId int`,
`source enum('manual','clock')`, `supersedesEntryId`, `correctionReason`, `createdAt`. Labour cost
is `Σ minutes × rate / 60`; an entry recorded while no rate was in force carries `NULL` and the
work order's labour cost is *partial, rate missing*, exactly as `workOrderCost` says today.

**`shopLabourRates`** (CP4) — versioned, never overwritten

`rateRef`, `orgRef varchar(64)` (NULL = single tenant), `shopFacilityId int`, `rateCentsPerHour int
NOT NULL`, `effectiveFrom`, `effectiveTo`, `proposedByUserId`, `approvedByUserId`, `approvedAt`,
`status enum('proposed','approved','superseded')`. Proposer ≠ approver. Two approved rates
overlapping at one scope are refused at approval, the `oosReleasePolicies` rule.

**`maintenanceServiceDefinitions`** (CP3) — the catalogue

`serviceCode varchar(40)`, `orgRef` (NULL = shared seed), `name varchar(160)`,
`category enum('oil','filter','grease','transmission','differential','brake','tire','wheel_retorque','hydraulic','pump_blower_pto','trailer','cvip','custom')`,
`checklistJson text` (the `inspectionItems` keys a `pm_service` inspection carries),
`defaultIntervalKm int`, `defaultIntervalHoursTenths int`, `defaultIntervalMeter enum(...)`,
`defaultIntervalDays int`, `source varchar(200)` (OEM manual, company policy — recorded, not
verified: an interval is company data, not a regulation, so it is not in the rule ledger),
`status enum('active','retired')`, `createdByUserId`, `createdAt`. Unique `(orgRef, serviceCode)`
through a persistent generated key as in `0021`.

**`unitMaintenanceSchedules`** (CP3)

| Column | Notes |
|---|---|
| `id`, `scheduleRef varchar(64) UNIQUE`, `unitId int NOT NULL`, `serviceDefinitionId int NOT NULL` | |
| `intervalKm int`, `intervalMeterType enum('engine_hours','pto_hours','pump_hours','vacuum_hours')`, `intervalHoursTenths int`, `intervalDays int` | any subset; at least one; **whichever comes first** is the only rule |
| `warnKm int`, `warnHoursTenths int`, `warnDays int` | the "due soon" window, per schedule |
| `overduePolicy enum('warn','hold')` | what an overdue service does to the unit — default `warn`; `hold` is declared explicitly (D-09's shape) |
| `baselineCompletionId int` | the completion the first "next due" counts from; NULL = never serviced = **unknown, not due** |
| `status enum('active','suspended','retired')`, `suspendedReason` | |
| `createdByUserId`, `approvedByUserId` | a schedule that can place a hold needs a second person |
| `createdAt`, `updatedAt` | |

**`maintenanceServiceCompletions`** (CP3) — append-only

`completionRef`, `scheduleId`, `unitId`, `workOrderId NOT NULL`, `workOrderTaskId`,
`completedAt NOT NULL`, `completedByUserId NOT NULL`, `odometerReadingId`, `hoursReadingId`
(the readings at completion, as rows in `unitMeterReadings`), `inspectionId` (the `pm_service`
inspection with its items), `evidenceRecordId`, `createdAt`. A completion needs the work order that
did the work — the recall rule, applied to PM.

**Next due and due state are derived**, never stored:

```
nextDue(schedule, lastCompletion, currentMeters, now) →
  { dueAtKm | unknown, dueAtHours | unknown, dueAtDate | unknown,
    state: 'not_evaluable' | 'ok' | 'due_soon' | 'overdue',
    firstAxis: 'km' | 'hours' | 'days',
    remaining: { km?, hoursTenths?, days? },
    reasons: string[] }
```

`not_evaluable` when there is no baseline completion, or when an axis the schedule names has no
current meter; the reason names the missing thing. A schedule with three axes and one unknown meter
is evaluated on the two it can read and says the third is unknown — it does not round to `ok`.

### 3.4 The unit service state — one projection, every reader

> **Withdrawn 2026-09-24** — superseded by the portfolio's `operationalState(facts)`. The reason
> ordering below (held > unknown > restricted > available, unknown when a source cannot be read) is
> offered to that projection as a review note, not built here.

```
unitServiceState(unitId, now) → {
  status: 'available' | 'restricted' | 'held' | 'unknown',
  reasons: [{ code, label, source: { table, id }, liftedBy: 'mechanic_release' | 'return_to_service' | 'oos_release' | 'roadside_close' | 'fault_clear' | 'hold_lift' | 'inspection_pass' | 'pm_completion' }],
  restrictions: string[],          // from a restricted release
  since: Date | null,              // for downtime
  version: string                  // joins the eligibility fingerprint
}
```

Inputs, in the order they are read: `unitServiceHolds` (open) · `maintenanceDefects` (unresolved
critical, or resolved on a release that no longer stands) · `workOrderReleases` (via
`currentReleaseEvidenceFor`) · `outOfServiceOrders` through `enforcementEvents` (as the composer
reads them today) · `roadsideServiceEvents` (open) · `faultCodes` (critical acknowledged) ·
`inspections` (newest pre-trip/post-trip/mechanic with `outcome` `fail` or `out_of_service` and no
later `pass` or `return_to_service` pass) · `recallUnitStatus` (`affected`, not `completed` →
`restricted`, never `held`, unless a hold of kind `recall` was placed) · `unitMaintenanceSchedules`
with `overduePolicy: 'hold'` and state `overdue`.

`unknown` is the answer when a read fails or when a required input is `not_established` — the
composer's `NOT_EVALUATED` rule. The same function feeds: the readiness composer's truck axis (CP6),
the driver's My Day card and "do not operate" notice (CP6), the dispatcher's slot view (CP6), the
unit passport (CP5) and downtime in the cost roll-up (CP7). It lives in `server/_core/unitServiceState.ts`
and is reached from `maintenanceRouter.ts` and `readinessComposer.ts` in the same checkpoint it is
created, so `engineReachability` never sees it unwired.

---

## 4. Authorization

Roles exist: `mechanic`, `shop_lead`, `safety`, `management`, `driver`, `dispatcher`, `office`,
`controller`. No new role. New permissions, with holders and sensitivity:

| Permission | Holders | Sensitive | Guards |
|---|---|---|---|
| `maintenance.meter.record` | driver (own captures), mechanic, shop_lead, office | no | reading, not decision |
| `maintenance.meter.correct` | shop_lead, management | **yes** | a correction moves every schedule on the unit |
| `maintenance.defect.triage` | mechanic, shop_lead | **yes** | raising to `critical` holds the unit; lowering from `critical` frees it |
| `maintenance.defect.send_to_shop` | mechanic, shop_lead, dispatcher, office | no | opens the work order from a defect (CP2) |
| `maintenance.workorder.assign` | shop_lead, management | no | |
| `maintenance.workorder.cancel` | shop_lead, management | **yes** | a cancelled work order for a critical defect leaves the defect open and the unit held |
| `maintenance.task.write` | mechanic (assigned), shop_lead | no | |
| `maintenance.labour.record` | mechanic (self only, universal-style), shop_lead | no | technician = caller |
| `shop.labour_rate.propose` / `shop.labour_rate.approve` | management, controller / the other of the two | approve **yes** | proposer ≠ approver |
| `maintenance.inspection.write` | mechanic, shop_lead | no | mechanic, CVIP, PM, follow-up inspections; drivers keep `inspection.write` |
| `maintenance.return_to_service.record` | mechanic, shop_lead | **yes** | the `return_to_service` inspection; inspector ≠ repairing technician when the company's `oosReleasePolicies`-style setting says so (O-6) |
| `maintenance.hold.place` | shop_lead, safety, management | **yes** | |
| `maintenance.hold.lift` | shop_lead, safety, management | **yes** | never the placer for `manual`; for `safety` requires release + return-to-service inspection whatever the role |
| `maintenance.schedule.read` | every internal role holding `shop.read` or `fleet.read` | no | |
| `maintenance.schedule.manage` | shop_lead, management | no; `overduePolicy: 'hold'` requires `maintenance.schedule.approve` | |
| `maintenance.schedule.approve` | management, safety | **yes** | second person for a hold-capable schedule |
| `maintenance.service.complete` | mechanic, shop_lead | no | needs the work order and readings |
| `maintenance.billto.decide` | shop_lead, controller, management | no | |
| `shop.evidence.read` | mechanic, shop_lead, safety, management, auditor | no | returns a signed URL and writes `evidenceAccessEvents` |
| `maintenance.notice.acknowledge_own` | universal | no | the driver acknowledging their own unit notice |
| `maintenance.my_unit_read` | universal | no | self-scoped resolver of "my unit today" |

Existing permissions keep their meaning. `shop.release` remains the only release door (S-1:
`records.maintenance.recordRelease` is retired in CP2 — refuses with a message naming
`shop.workOrderRelease`, the `hos.limitVerify` precedent). `maintenance.write_work_order` stops
being able to set status (`fieldRoute.workOrders.update` keeps notes and findings only).
`DENIALS` for mechanic/shop_lead (billing, payroll, personnel, investigations) are unchanged; a
mechanic reads a labour *rate* only as it prices their own work order, never payroll.

Mounting: one new file `server/maintenanceRouter.ts` (key `maintenance`), added to
`OPERATIONAL_SOURCES`, the inventory table and the `documentationTruth` phrase list. `shopRouter.ts`
keeps parts, tires, warranty, recalls, `workOrderAdvance`, `workOrderRelease`, cost.

---

## 5. Dispatch lockout — how a held unit cannot be dispatched

What holds today, kept exactly: `critical_defect`, `mechanic_release_missing`, `oos.<scope>`,
`roadside_event_open`, `fault_<code>_critical` — blocking, overridable by no one.

What CP6 adds to the composer, as contributions on the existing truck and trailer axes:

| Blocker code | From | Severity | Overridable |
|---|---|---|---|
| `unit_hold_<kind>` | `unitServiceHolds` open | blocking | **no** for `safety`, `inspection_failed`; `manual` overridable by management with a reason (recorded on `dispatchOverrides`) |
| `inspection_failed_unresolved` | newest driver/mechanic inspection `outcome` fail / out_of_service with no later pass | blocking | no |
| `inspection_result_not_established` | newest inspection `outcome` `not_established` | unknown | manager |
| `pm_overdue_hold` | schedule with `overduePolicy: 'hold'`, state `overdue` | blocking | management, with reason — it is company policy, not a regulation |
| `pm_overdue` | `overduePolicy: 'warn'`, overdue | review | manager |
| `pm_not_evaluable` | a schedule's meter unknown | unknown | manager |
| `recall_affected_open` | `recallUnitStatus.status = affected` | review | manager |
| `maintenance_hold_status_unknown` | `unitServiceState` returned `unknown` | unknown | nobody until it is evaluated |

The fingerprint gains `unitServiceState.version`, so a hold placed between the check and the award
refuses the award ("facts changed, re-evaluate") — the mechanism `awardAssignment` already has.

**Return to service** is the sequence, each step its own act by a named person:

1. every task on the work order is `done` or `not_required`;
2. `shop.workOrderRelease` by the authenticated technician — `evaluateMechanicRelease` scales the
   evidence to the defect's severity; a critical needs test procedure, result and road test;
3. a `return_to_service` inspection with `outcome: pass`, by an inspector the company's separation
   setting permits, naming the release;
4. `records.maintenance.resolveDefect` per critical defect, on the release that names it;
5. `maintenance.holdLift` on any `safety` hold — refused unless 2 and 3 stand;
6. `unitServiceState` recomputes to `available` (or `restricted`, carrying the restriction text),
   `emitMechanicReleased` fires in the same transaction, and the driver's notice changes from
   "Do not operate" to "Returned to service".

Nothing in the sequence lifts a government out-of-service order; that stays `enforcement.orderRelease`
under `oosReleasePolicy`.

**Slot binding (S-13).** `dispatchRoleService.setRoleAssignment` binds a unit to a slot without a
readiness check, by design (it is "not an award"). The recommendation is a narrower rule than
readiness: **binding a unit whose `unitServiceState` is `held` is refused in every enforcement mode**,
because a hold is a known stop, not an unknown that enforcement mode exists to tolerate. Recorded as
owner decision O-2.

---

## 6. Notifications and driver alerts

| Event | Mechanism | Recipient | Key | Acknowledged by |
|---|---|---|---|---|
| Critical defect reported | `emitCriticalDefectOpened` (wired) → rule `fleet.critical_defect.opened` → task + notification; `escalation.ts` `DEFAULT_CRITICAL_POLICY` ladder | shop_lead, safety, dispatcher, then management | `defect:${defectId}:critical` | `inbox.acknowledge` (new, CP6) |
| Defect sent to shop | `emitDefectSentToShop` (wired) → `fleet.defect.sent_to_shop` | mechanic role, or the assignee once assigned | `payload.workOrderRef` (seed's dedupe) | task completion |
| Work order assigned / expected completion set | direct `workflowNotifications` row | `recipientUserId` = assignee | `wo:${id}:assigned:${eventRef}` | view |
| Waiting on parts, part short | Exception Centre `fleet` (derived) + reorder finding as a `purchasing.request` proposal | shop_lead, controller | `stock:${partId}:${bin}` | clears when stock moves |
| PM due soon | direct row to the driver of the current assignment **and** the unit's Exception Centre entry | driver via `myUnitToday`; shop_lead | `pm:due:${scheduleId}:${thresholdKm|thresholdDate}` — one per threshold crossing, so the driver hears once at 750 km, not every trip | driver `maintenance.noticeAcknowledgeOwn` |
| PM overdue | Exception Centre (`fleet`, severity by how far over) + task `perform_pm_service` | shop_lead | `pm:overdue:${scheduleId}` | completion |
| Unit held / "Do not operate" | direct row to the driver, priority `emergency` on the unit's message-board broadcast (`broadcastReaches` supports `unitRef`) | current and next-assigned driver, dispatcher | `hold:${holdRef}` | ack required (board rule for `emergency`) |
| Returned to service | `emitMechanicReleased` (wired) → `fleet.mechanic_release.verified` + direct driver row | driver, dispatcher | `release:${releaseId}` | view |
| Restricted release | `fleet.mechanic_release.restricted` | driver, dispatcher | `release:${releaseId}:restricted` | ack |
| Release revoked | `fleet.mechanic_release.revoked` | driver, dispatcher, shop_lead | `release:${releaseId}:revoked` | ack |

Delivery is in-app only today (`channel: 'in_app'`); push, email and SMS have no sender in the tree
and this module does not add one — the row's `channel` is the hook when one exists.

**"My unit today"** — a resolver, not a table: the newest of (a) `dispatchRoles` with
`assignedOperatorId` = my operator and a posting in `staffed/dispatched/in_progress`, (b) a
`trips` row in `planned/loading/in_transit/unloading` for my operator, (c) `jobUnits` with my
operator and no `departedAt`. It returns `{ unitId, source, since }` or `null` with the reason —
a driver with two live assignments gets both, never a guess. Self-scoped: the operator is
`operators.userId = ctx.user.id`, and the unit id is never taken from input.

**Wiring the emitters.** `domainEmitters` leaves `DECLARED_UNWIRED` in CP2 (57 → 56): the three
fleet emitters are called from `maintenanceRouter.ts` and `shopRouter.ts` inside the writing
transaction; `bootstrapRuleSeeds` runs at server start for the `fleet.*` rules; the production
worker already routes non-enforcement events to `processEvent`.

---

## 7. Offline

Nothing in this module changes the rule in `offlineCapability.ts`: the device is the source of truth
for what it observed, never for what that observation permits.

| Capture (device) | Class | Server commit |
|---|---|---|
| `pretrip` / `posttrip` — typed form: checklist items, meter reading, photos, driver's words, severity proposal | `local_capture` | `maintenance.inspectionCommit` → `inspections` + `inspectionItems` + one `maintenanceDefects` per failed item + a `unitMeterReadings` row (`source: 'driver_capture'`, `confidence: 'stated'`) |
| `defect_report` | `local_capture` (exists, tier 0) | as today, plus `severityProposed` and `driverStatement` |
| `mechanic_inspection`, `work_order_note`, `photo` | `local_capture` | `inspectionCommit` / task note / evidence |
| `meter_reading` | `local_capture` | `unitMeterReadings` |
| release, resolve, triage, hold lift, count, service completion | `server_authoritative` | never executed on the device; prepared and queued; the device shows "queued — not yet in effect" |

A driver's tablet already latches a confirmed out-of-service order locally
(`client/src/runtime/safetyLatch.ts`). CP6 extends the same latch to a **served** `unitServiceState`
of `held`: the device shows "Do not operate" from the last served state and never clears it on its
own; only a served `available`/`restricted` clears it, and a cached state with no capture time is
`unknown`, shown as such.

Sync priority: `pretrip`/`posttrip` stay at 10; `meter_reading` at 20; a pre-trip whose items
contain a `fail` is promoted to tier 0 on the device, because a failed pre-trip is a defect report.

---

## 8. The mechanic portal (CP5) — screens, not decisions

Portal `fleet_maintenance` exists (`portalComposition.ts:177`, composed from `mechanic` and
`shop_lead`). Routes under `/portal/fleet_maintenance/*`. Every screen follows
`DispatchReadiness` — container (the only tRPC caller), props-only view, pure presentation module,
`.dom.test.tsx` for each, declared in `panelContract.ts`, added to `a11yCoverage`. Field density,
dark, one primary action, the six status words `✓ Ready · ! Review · × Blocked · ? Unknown ·
○ Pending · ↻ Syncing`.

| Screen | Reads | Writes (each a named act) |
|---|---|---|
| **Defect queue** | defects by severity and stage, source, driver's words, unit state | triage (severity decision with reason), send to shop |
| **Work orders** board | by status and assignee; expected completion; waiting-on-parts | assign, advance, cancel |
| **Work order** detail | tasks, parts issued (from the ledger), labour, evidence, cost as far as known, release history, bill-to | task write, part issue/return, labour entry, evidence attach, release, bill-to |
| **Return to service** | the release, the inspection checklist for the defect's system, the hold(s) | `return_to_service` inspection, resolve defect, lift hold |
| **Unit passport** (maintenance tab) | service state and reasons, meters with source and confidence, schedules and next due, service history (work orders, inspections, completions, holds, releases, roadside, enforcement), documents | meter reading, manual hold |
| **PM board** | every schedule in `due_soon`/`overdue`/`not_evaluable`, grouped by unit | open a preventive work order from a schedule (one click, one work order, one `pm_service` task) |
| **Inspections** | mechanic / CVIP / follow-up inspections, certificate expiry from `complianceDocuments` | record inspection, attach certificate |
| **Parts and stock** | `shop.stock`, reorder findings, cores outstanding | receive, count (lead), propose purchase |
| **Blocked-unit history** | holds and derived holds over time, downtime per unit | read only |

The driver side (CP6) is two cards in `field_workforce` My Day: **My unit** (state, restriction
text, next service with the remaining km/hours/days and which axis comes first, the "Do not operate"
notice when held) and the **pre-trip form** (checklist from the unit's service definition items,
meter, photos, defects with the driver's words). No driver screen has a release, triage or lift
button.

---

## 9. Checkpoints — definition of done

Each checkpoint is one PR, gate-green from an empty database (`scripts/ci-gate.sh`), with its
before/after table in the `LEASEOS_B21_15_FLEET_SHOP.md` format, its migration claimed in the
collision register, the `OPERATIONAL_PROCEDURE_PERMISSIONS` pin bumped in both tests with a
history note, the inventory row and total updated, the `current-state.sh` heredoc carrying the
router's phrase, and `documentationTruth` extended with that phrase.

### CP1 — work-order ownership, cancellation, and four fixes (delivered 2026-09-24)

Narrowed from the original CP1 once the portfolio design was found; the withdrawn parts are listed in
the revision at the top. The record is `docs/register/MECHANIC_PORTAL_CP1_WORK_ORDER_OWNERSHIP.md`.

- Migration `0189_work_order_ownership.sql`: `workOrderAssignments` (append-only), `workOrders`
  gains `cancelled`, `openedByUserId`, `cancelledAt`, `cancelledByUserId`, `cancelReason`.
- `server/maintenanceRouter.ts` (mounted as `maintenance`): `workOrderAssignment` (read),
  `workOrderAssign`, `workOrderCancel`. Two permissions, `maintenance.workorder.assign` and
  `maintenance.workorder.cancel` (sensitive), held by shop lead and management.
- `evaluateMechanicRelease` refuses a cancelled work order (`work_order_cancelled`); the shop refuses
  to advance it or issue parts to it.
- S-2: `fieldRoute.workOrders.update` refuses a `status` at the schema. S-7: `shop.workOrderAdvance`
  stamps `startedAt` / `completedAt` once and keeps its note. S-8: every telematics procedure and the
  unit-less `fieldRoute.workOrders.list` are scoped to the caller's organization.
- No new `_core` engine; the unwired-engine census is unchanged.

### CP2 — defect to work order

- Migration `0176`: `maintenanceDefectEvents`, `workOrderTasks`, `inspections` ALTER +
  `inspectionItems`, `workOrderReleases` ALTER.
- `maintenanceRouter.ts`: `defectReport` (driver words, proposal, source), `defectTriage`,
  `defectSendToShop` (creates the work order and its first task in one transaction, emits
  `emitDefectSentToShop`), `taskWrite`, `taskComplete`, `inspectionCommit` (pre/post-trip typed
  form; a failed item raises a defect; `outcome` written; a critical raises the hold),
  `inspectionRecord` (mechanic, CVIP with certificate link, follow-up), `returnToServiceRecord`,
  `holdLift` now honours `safety`.
- Retire `records.maintenance.recordRelease` (S-1): one door, `shop.workOrderRelease`, which now
  writes `returnToServiceInspectionId` when given, refuses a release while any task is `open` or
  `in_progress`, and emits `emitMechanicReleased`. `resolveDefect` and `revokeRelease` stay in the
  records router and write `maintenanceDefectEvents`.
- `roadside.close` and `roadside.repairedAwaitingRelease` (S-4), scoped, reason required.
- Assistant `planDefectReport` writes `severityProposed` from the form and leaves `severity` to
  triage (S-5), with the recommended default from O-3.
- `enforcementCommit` and `telematics.faultAcknowledge` write `source` and an event row.
- Wire `domainEmitters` + `bootstrapRuleSeeds` for `fleet.*` (unwired 57 → 56).
- Tests: the arc — driver pre-trip fails brakes → defect with the driver's words and proposal
  `critical` → unit `held` → dispatch readiness `BLOCKED`, non-overridable → triage confirms →
  sent to shop → assigned → task done → release refused without road test → release → return-to-
  service inspection by a second person → resolve → hold lifted → `available` → award proceeds;
  and its refusals at every step (wrong role, same person, wrong unit, cancelled work order leaves
  the defect open). `readinessDefectRepair.db.test.ts` unchanged and green.
- **Done when:** the arc runs through the API only, every step leaves a `maintenanceDefectEvents`
  row with actor and role, and there is exactly one procedure in the tree that appends a release.

### CP3 — preventive maintenance

- Owner decision on D-01 recorded first (§0).
- Migration `0177`: `maintenanceServiceDefinitions`, `unitMaintenanceSchedules`,
  `maintenanceServiceCompletions`; seed the catalogue rows for the owner's list (oil, filters,
  grease, transmission, differential, brakes, tires, wheel re-torque, hydraulics, pump/blower/PTO,
  trailer, CVIP) with `orgRef NULL`, intervals empty — **an interval is the company's to set**.
- `server/_core/maintenanceSchedule.ts` (`nextDue`, whichever-first, `not_evaluable`) reached by
  `maintenanceRouter.ts`: `serviceDefinitionCreate/Retire`, `scheduleCreate/Update/Approve/Suspend`,
  `scheduleDue` (per unit and fleet-wide), `workOrderOpenFromSchedule`, `serviceComplete`.
- A `pm_service` task completion with readings and the `pm_service` inspection writes the completion.
- Tests: km-first vs hours-first vs date-first, a vac truck with 9,000 km and 1,900 PTO hours due on
  hours, unknown meter → `not_evaluable` naming the meter, a correction of the odometer moving the
  due figure, warn windows, `overduePolicy: 'hold'` refused without approval.
- **Done when:** "Unit 214 service due in 750 km" is a computed answer with the reading, its source
  and the schedule it came from behind it, and a unit never serviced reads unknown.

### CP4 — parts, labour, costs, bill-to

- Migration `0178`: `workOrderLabourEntries`, `shopLabourRates`, `partMovements` ALTER.
- `shopRouter.ts`: `partIssue` takes `taskRef`; `partReturn` carries `workOrderId` (S-3);
  `workOrderCost`/`unitCost` read labour entries and rates, outside bills by `workOrderId`, and km
  and hours from `unitMeterReadings` — cost per km and per hour with `determination` and reasons,
  as today.
- `maintenanceRouter.ts`: `labourRecord`, `labourCorrect`, `labourRatePropose/Approve`,
  `billToDecide`; `vendor.billRecord` and `purchasing.request` accept a work order (S-11); reorder
  findings raise a `purchasing.request` proposal and an Exception Centre entry.
- Warranty: `warrantyClaimRaise` from a work order with `billTo: 'warranty'`; recall work orders of
  kind `recall` complete `recallUnitStatus`.
- **Done when:** a work order's cost reads parts (net of returns), labour at the rate in force when
  recorded, and the outside invoice, and names every reason it is partial; a rate change never
  reprices history.

### CP5 — mechanic portal UI

- The nine screens in §8, `panelContract.ts`, `.dom.test.tsx` per screen, `a11yCoverage`,
  `PortalShell` routing, `quickCaptureActions('fleet_maintenance')` gains meter reading and
  mechanic inspection.
- No new server procedure except read models: `maintenance.workOrderDetail`, `maintenance.unitPassport`,
  `maintenance.defectQueue`, `maintenance.pmBoard`, `maintenance.blockedHistory` — every one a
  projection with `determination` on anything computed.
- **Done when:** every screen renders from records with "from records — <procedure>, n rows" or
  states its demonstration reason, and no screen can round a server answer up.

### CP6 — driver alerts and dispatch lockout

- `readinessComposer.ts`: the truck and trailer axes read `unitServiceState`; the blockers in §5;
  `CLASSIFICATION` rows for each new code (a new code with no classification fails
  `complianceFinding`'s coverage); fingerprint carries the state version.
- `dispatchRoleService.setRoleAssignment` refuses a `held` unit (O-2).
- `myUnitToday` resolver; driver My Day cards; `inbox.acknowledge`; the notification rows in §6;
  the device latch on served `held`.
- `dispatchReadinessPanel.db.test.ts` and `readinessDefectRepair.db.test.ts` extended: a hold
  placed after `evaluate` refuses `award`; a failed pre-trip blocks and a later mechanic pass
  releases; PM `hold` blocks and PM `warn` reviews; `unknown` state never reads as clear.
- **Done when:** no path in the tree assigns, binds or awards a held unit, and a driver whose unit
  is held sees why, from whom, and what lifts it, on and off line.

### CP7 — service history, documents, audit, reporting

- Migration `0179`: `evidenceRelationships` enum ALTER.
- `shop.evidenceRead` (signed URL + access event, S-9); `evidenceInScope` learns the `unit` and
  `workOrder` relationship (through `unitInScope`); attachment authorizer for `workOrder`.
- `loadTimeline('unit')` gains work orders, inspections, completions, holds, meters; the vehicle
  audit package gains the same and `COMPLETENESS.vehicle` gains `inspection` and `pm_completion`.
- Reports as procedures with `determination`: cost per unit / km / hour over a period, downtime per
  unit from holds, PM compliance (completed on time / late / not evaluable), defect ageing by
  stage, warranty recovered vs claimed.
- **Done when:** a unit's history is one chronological read with every row's source, and every
  report names what it could not know.

### CP8 — integration, refusal, offline tests and release gate

- One test walks a unit from purchase through: schedule → telematics readings → due-soon notice →
  driver pre-trip failure → hold → shop → release → return-to-service → PM completion → next due,
  through the API, asserting the chronology, not the final state.
- Refusal matrix: every sensitive act by every role that must not perform it, and every
  same-person rule.
- Offline: the pre-trip captured without signal syncs idempotently (`clientCaptureRef`), a release
  prepared offline is refused at sync as `server_authoritative`, a served `held` state survives the
  device restarting.
- Gate: `ci-gate.sh` green, `current-state.sh` regenerated, checkpoint document, collision register
  refreshed, `LEASEOS_RELEASE` bumped, the "Not implemented — and not claimed" section updated to
  stop claiming PM is missing.

---

## 10. Owner decisions

| ID | Decision | Recommended default |
|---|---|---|
| O-1 | Amend D-01 for this module (§0) | amend, conditioned on every engine shipping wired. The `0169` blocker it was paired with closed as `0179`; CP1 needed no amendment because it adds no engine |
| O-2 | A `held` unit is refused at slot binding in every enforcement mode | yes — a hold is a known stop, not an unknown |
| O-3 | A driver-proposed `critical` holds the unit before triage | yes; triage may lower it with a reason, recorded |
| O-4 | Severity vocabulary stays three-valued (`advisory / inspection_required / critical`) rather than the functional spec's L1–L4 | keep three; the readiness classification, the release evaluator and eighteen database tests are built on them; the driver's proposal is a separate column |
| O-5 | `overduePolicy` default for a new schedule | `warn`; `hold` needs a second person |
| O-6 | Return-to-service inspector must differ from the repairing technician | company setting, default **yes**, versioned like `oosReleasePolicies` (reuse that table's shape, not that table) |
| O-7 | Hours stored as tenths | yes; no new double |
| O-8 | Trailers and equipment get schedules exactly as trucks (they are `units`) | yes; catalogue rows carry an `appliesToVehicleTypes` hint only |
| O-9 | Who may place a `manual` hold | shop_lead, safety, management; dispatcher may not |
| O-10 | The retired `records.maintenance.recordRelease` refuses with a pointer rather than being deleted | refuse with pointer (the `hos.limitVerify` precedent) |
| O-11 | Run the mechanic portal and the Fleet & Equipment Portfolio as one sequence (revision at the top), with the portfolio's Fleet Asset Core next | yes — every later mechanic checkpoint reads the portfolio's holds, meters and state |
| O-12 | Meter regression: the portfolio records a reading below the last verified one as `meter_regression`, flagged and never rejected; the withdrawn draft here read the meter as unknown until corrected. Which does a service interval see? | the portfolio's flag, plus: a service interval reading a regressed meter reports `not_evaluable` rather than a due figure |

---

## 11. Not built by this module, and named

Fluids as measured inventory (the parts ledger holds them by unit). Push, email or SMS delivery.
Telematics vendor adapters (readings arrive through the integration gateway as today). Native
camera, GPS or biometrics. Tire rotation planning. Payroll from labour entries (`EarningSource`
`work_order` exists; wiring it is payroll's checkpoint). Readiness at slot binding beyond the hold
refusal (a SPINE item). Any regulatory inspection interval as a verified rule — CVIP stays a
`complianceDocuments` requirement seeded unverified (P9).

## 12. After this module

The Safety & Compliance Administration Portal the owner named next — company safety documents,
training and tickets, incidents and near misses, corrective actions, policies, orientations, audits,
ERP/ERAP material, expiry dashboards — reads what this module writes: inspections, holds, defect
history and PM compliance are its fleet inputs, and `incidentReport.ts`'s `holdUnit` becomes a
`unitServiceHolds` row of kind `safety` rather than a boolean on the incident.
