# Fleet & Equipment Portfolio — foundation checkpoint (2026-09-25)

Branch `claude/mechanic-portal-domain-82efa9`. **Base:** `1cc01f2` (the branch after merging `main`
`88608f3` and the portfolio design `21b3cfc`). **Implementation:** `c8985fa`. **Result:** `e2629d1`
(`main` `3d05d32` merged in and the migrations renumbered; this record is the commit after it). No pull
request.

Design: `docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md`. Reconciliation, with every
contradiction and its resolution: `docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md`.

## Before this: the trip tenant-boundary fix

`18f3f68` — `fieldRoute.trips.create` refused a unit the caller's organization cannot see, as NOT_FOUND
worded as for a unit that does not exist. Written red first (`server/tripUnitScope.db.test.ts`, 3 of 5
cases failed against the unfixed procedure for every role holding `trip.write`). The sweep that followed
(`docs/register/UNIT_SCOPE_SWEEP_2026-09-25.md`, `23888cf`) found 16 more mutations writing a request's
unit id unchecked and 4 checking something else; recorded, not fixed.

## Counts

| | `main` `3d05d32` | Mechanic Portal CP1 | **This slice** | **Result** |
|---|---|---|---|---|
| Tables | 415 | +1 | **+3** (`unitHolds`, `unitMeterReadings`, `fleetPortfolioEvents`) | **419** |
| Migrations | 178 | +1 (`0199`) | **+2** (`0200_fleet_portfolio_foundation.sql`, `0201_fleet_portfolio_guards.sql`) | **181** |
| Role-authorized procedures | 657 | +3 | **+9** (`server/fleetPortfolioRouter.ts`, mounted as `fleet`) | **669** |
| Operational procedure map | 639 | +3 | **+9** | **651** |
| Mounted server paths | 703 | +3 | **+9** | **715** |
| Permissions | 360 | +2 | **+4** | **366** |
| Sensitive (fail-closed) | 129 | +1 | **+3** | **133** |
| Unwired `_core` engines | 57 | — | **0** — `fleetMeters` and `fleetPortfolio` are reached from their router | **57** |
| Classification | `c1a.2` | — | **+3 hold rules** | **`c1a.3`** |
| CI gate | — | — | — | **PASS** from an empty database |

Every count is read from the source by `scripts/current-state.sh`; the pins moved by exactly the CP1 and
slice deltas over `main`.

## Migrations — 0200 and 0201

First written as `0199`/`0200` after a scan of `origin/main` and 93 remote refs (highest other claim
`0197`). The scan repeated immediately before finalizing (94 refs) found C1b-2b's
`0198_requirement_verification.sql` merged to `main` (#54) in between, so this branch's three migrations
moved up one: checkpoint 1's work-order ownership is `0199`, this slice is `0200` (tables) and `0201`
(triggers). No environment had applied any of them. No other ref holds a number above `0198`; the next
free number is `0202`. Recorded in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

- **`unitHolds`** — the one table of placed holds: organization, unit, type, effect, reason, the source
  that placed it (`manual`, `incident`, `damage_report`, `inspection`, `document_expiry`, `defect`,
  `work_order`, `enforcement`), reference, evidence, who placed it and in what role and when, status,
  who released it, when, why, and on what evidence.
- **`unitMeterReadings`** — the ledger for readings with no other home. Nothing is copied into it.
- **`fleetPortfolioEvents`** — the portfolio's append-only history.
- **0201 triggers:** the events table refuses UPDATE and DELETE; a meter reading's observation (unit,
  meter, value, time, source, author, organization) never changes and its verification is decided once;
  a hold's placement never changes, it is released once, a released hold is never changed again, and
  nothing is deleted from any of the three.

## Procedures and permissions

| Procedure | Permission | Sensitive |
|---|---|---|
| `fleet.unitState` | `fleet.read` | no |
| `fleet.holdList` | `fleet.read` | no |
| `fleet.holdPlace` | **`fleet.hold.place`** (mechanic, shop lead, safety, management) | **yes** |
| `fleet.holdRelease` | **`fleet.hold.release`** (mechanic, shop lead, safety, management) | **yes** |
| `fleet.meterReadings` | `fleet.read` | no |
| `fleet.meterProgress` | `fleet.read` | no |
| `fleet.meterRecord` | **`fleet.meter.record`** (mechanic, shop lead, office) | no |
| `fleet.meterDecide` | **`fleet.meter.verify`** (mechanic, shop lead, management) | **yes** |
| `fleet.history` | `fleet.read` | no |

Below the permission, the hold's type decides: a mechanic places and releases maintenance holds only; a
shop lead places maintenance, inspection, damage and administrative holds; safety places and releases
safety, inspection and compliance holds; management places any and releases all but maintenance. The
placer never releases their own hold, and nobody verifies their own reading.

## What is canonical now

| Concept | Canonical | Mechanic Portal reuse |
|---|---|---|
| Placed holds | `unitHolds` via `fleetPortfolioService.placeHold` / `releaseHold` | checkpoint 2 places a hold with `sourceKind: "defect"` and releases it on the return-to-service act; a hold placed by a workflow is refused to `fleet.holdRelease` by hand |
| Meter readings | the read-in-place union `meterObservations` + the ledger | preventive maintenance calls `meterProgress` from a service baseline |
| Unit status | `operationalStateFor` → `_core/fleetPortfolio.ts operationalState` | `maintenance.workOrderCancel` already reports `unitStatus` from it |
| History | `fleetPortfolioEvents` | defect and work-order events stay in their own domain; hold and meter events are here |
| Dispatch | `composeReadiness` (unchanged authority, D-06) | reads active `unitHolds` for the truck and the trailer |

The mechanic portal's checkpoint 1 (work-order ownership and cancellation) is unchanged; its six
database cases pass, one now asserting the unit's status from the portfolio's projection.

## The meter-regression rule

A reading that goes below a previously **accepted** reading — a telemetry, work-order, trip, fuel or tire
figure, or a ledger reading a second person verified — makes `meterProgress` from any baseline at or
before it answer `{ status: "indeterminate", reason: "METER_REGRESSION" }`. A ledger reading nobody has
verified is provisional: it can expose a regression but is never the current value. The reading that
went down is stored and shown unchanged; the database refuses to edit or delete it; rejecting a
ledger typo lets evaluation resume; a drop in an accepted source cannot be rejected away and stays on
record, and evaluation resumes only from a later baseline. The unit's state carries
`UNTRUSTED_METER_SEQUENCE` as a warning — a meter that went backwards does not ground a truck. Equal
readings are no progress and no regression; figures are compared at one decimal; ties in time break by
source precedence and reference.

## Dispatch readiness

| Hold | Code | Severity | Override class |
|---|---|---|---|
| safety (out of service) | `unit_hold_safety` / `trailer_hold_safety` | blocking | **NEVER_OVERRIDABLE** |
| any other type, blocking | `unit_hold_<type>` / `trailer_hold_<type>` | blocking | APPROVED_POLICY_ONLY — no policy exists, so none today |
| any type, warning | `unit_hold_<type>_warning` | review | WARNING_ONLY (manager) |

Hold references and effects join the unit's and the trailer's fingerprint versions, so a hold placed or
released after a check makes that check stale. Asserted through `composeReadiness` itself.

## Tenant refusal

Every `fleet.*` procedure resolves the acting organization and answers NOT_FOUND for another
organization's unit, hold or reading. The test compares the refusal for another organization's unit with
the refusal for a unit id that does not exist, word for word, on seven procedures.

## Tests

| File | Cases | What it proves |
|---|---|---|
| `server/_core/fleetMeters.test.ts` | 8 | increasing, identical and precision-noise sequences; METER_REGRESSION from a provisional and from an accepted drop; rejected readings; resuming from a later baseline; the named cannot-count reasons |
| `server/_core/fleetPortfolio.test.ts` | 10 | the three effects; who places and releases which type; status precedence; a warning never standing in for a safety hold; defects and releases read as the composer reads them; meter warnings; unreadable sources |
| `server/fleetPortfolio.db.test.ts` | 9 | the real router, composer and triggers: safety hold fails readiness closed and moves the fingerprint; blocking vs warning holds and their classes; release by the right person updates the state and keeps history; refusals for driver, dispatcher, mechanic-on-safety and the placer; triggers refusing rewrites; trailer holds; the organization boundary; provenance from five sources with no copying; increasing, identical and regressing readings, and rejection resuming evaluation |
| `server/tripUnitScope.db.test.ts` | 5 | the trip tenant boundary |

## Gate

`scripts/ci-gate.sh` on `e2629d1`, from a dropped and recreated database, passed every section:

| Section | Result |
|---|---|
| Runtime version truth; reserved slots `0016`/`0017` | clean |
| Migrations from empty | 181 applied, ending `0198` (C1b-2b), `0199`, `0200`, `0201` |
| Table parity (schema vs migrations); column parity | 419 = 419; OK |
| Production typecheck; test typecheck | clean; 0 test-file errors (ceiling 0) |
| Bare `protectedProcedure` | 0 |
| Full suite | **370 files, 5,404 passed, 3 skipped (5,407)**; no database-backed suite skipped |
| Production build | built |
| External (36) and machine (2) gates | pinned counts hold |
| Current-state document is generated | current |

Focused suites inside that run: `fleetPortfolio.db` 9, `_core/fleetPortfolio` 10, `_core/fleetMeters` 8,
`maintenance.db` 6, `tripUnitScope.db` 5, `readinessDefectRepair.db` 25, `dispatchReadinessPanel.db` 25,
`complianceReadinessC1a.db` 17, `dispatchGate` 13, `procedureAuthorization` 35,
`operationalApiAuthorization` 37, `crossLayerIntegrity` 4, `documentationTruth` 24, `engineReachability` 5,
`calendarFixtures` 2 — all passing.

The same gate had also passed on the pre-merge tree (369 files, 5,380 passed, 3 skipped); the rerun is
the one that counts, because `main` moved and the migrations were renumbered after it.

## Remaining known gaps

- Incident unit holds are not read into readiness or the projection until incident capture checks the
  unit's organization (sweep #19); `notEvaluated` says so.
- Sixteen unguarded and four partial unit-taking mutations (the sweep), notably `roadside.open` and
  `enforcement.eventConfirm`, which can ground another organization's truck.
- Not built from the portfolio's first slice: unit identity and lifecycle columns, components, the fleet
  list and detail UI, unit-only readiness, the driver's own-unit read and meter recording.
- `operationalState` does not decide documents or insurance; dispatch readiness does. The two readings of
  a unit's defects, releases, orders, roadside events and faults are the same rules in two places until
  the composer's unit side is generalised (the roadmap's "why can't this unit leave").
- The roadside event still has no close path, so an open one holds a unit indefinitely.
- `NEVER_AUTONOMOUS` does not yet list `fleet.holdRelease`; no agent capability reaches it today.
- Observed on `main`, not changed here: `PROCEDURE_AUTHORIZATION_INVENTORY.md` still lists
  `server/complianceRouter.ts` at 9 while that router has 18 `roleProcedure(` call sites, and totals 356;
  its pin checks only that the total appears. This branch's rows (`maintenanceRouter` 3, `fleetPortfolioRouter`
  9) are exact and machine-checked.
