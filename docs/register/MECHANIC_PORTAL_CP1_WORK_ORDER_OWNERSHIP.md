# Mechanic Portal — Checkpoint 1: who owns a work order, and cancelling one

Design: `docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md` (revised 2026-09-24).
Branch `claude/mechanic-portal-domain-82efa9`, on `main` at `1680e94`. **No new engine.**

| | `main` `1680e94` | **This checkpoint** |
|---|---|---|
| Tables | 410 | **411** (+1 `workOrderAssignments`) |
| Migrations | 170 | **171** (`0189_work_order_ownership.sql` at the time; **renumbered `0198`, then `0199`, on 2026-09-25**, when C1b-1 merged `0189` and C1b-2b merged `0198` to `main` first) |
| Role-authorized procedures | 652 | **655** (+3, `server/maintenanceRouter.ts`) |
| Operational procedure map | 634 | **637** |
| Permissions | 355 | **357** (+2) |
| Sensitive (fail-closed) | 125 | **126** (+1, `maintenance.workorder.cancel`) |
| Bare `protectedProcedure` | 0 | **0** |
| Unwired `_core` engines | 57 | **57** |
| CI gate | — | **PASS** from an empty MariaDB 10.11: 343 test files, 4,967 tests, 3 skipped (non-database, pre-existing), build, generated state |

Every count is read from the source by `scripts/current-state.sh`. Reserved slots 0016/0017 untouched.

---

## What was narrowed, and why

Checkpoint 1 was first built as the design's CP1 — a meter record copying every odometer and hour
figure into one table, explicit holds, and a unit service-state projection wired into dispatch
readiness. All of it passed its tests. It was withdrawn before any push, because an unmerged design
on `claude/fleet-equipment-portfolio-design-3d13d5` — the Fleet & Equipment Portfolio the owner named
as this module's foundation — already specifies `unitHolds`, a meter ledger read beside the other
sources in place, and an `operationalState` projection. Shipping a second version of each is the
competing-concepts outcome the owner asked to avoid, and copying distance values between tables is
what master-manifest rule 3 forbids. The design document now records the portfolio's model as
governing and proposes one sequence (O-11). The withdrawn drafts are not in the tree.

What stayed is mechanic-specific and overlaps nothing in the portfolio.

## A work order is owned by a person

`workOrders.technician` was a free-text name. An assignment is now a row in `workOrderAssignments`:
assigned, reassigned or unassigned, from whom, to whom, the shop facility and the expected completion,
the reason, and who did it. Nothing updates a row; the current owner is the newest one, and an
unchanged reassignment is refused rather than recorded. The assignee must hold a shop role (mechanic
or shop lead) in the unit's organization, and a facility must be one that organization may see.
Assigning is the shop lead's and management's.

## Cancelling repairs nothing

A work order that will not be done can be cancelled — with a reason, by a shop lead or management,
under a fail-closed permission. A cancelled work order is not closed:

- the defect it was opened for stays open, and the unit held for it stays held;
- it cannot be advanced, take parts, or be assigned;
- `evaluateMechanicRelease` refuses a release on it (`work_order_cancelled`), so it can never evidence
  one;
- a work order whose newest release still stands was done, and is refused cancellation — it is
  closed instead.

The cancellation is conditional on the status at the moment of writing, so two people cancelling at
once cannot both succeed.

## Four survey defects fixed

| # | Defect | Fix |
|---|---|---|
| S-2 | `fieldRoute.workOrders.update` set any status, backwards included, walking around the forward-only advance | `status` is refused at the schema; moving a work order is `shop.workOrderAdvance`, ending one is `maintenance.workOrderCancel` |
| S-7 | `shop.workOrderAdvance` discarded its note and never set `startedAt` / `completedAt` | both stamped once and never moved; the note is appended to the findings with who and when |
| S-8 | every telematics procedure served every organization's faults, events and video; `fieldRoute.workOrders.list` without a unit listed every organization's work orders | scoped through the unit's owner; out of scope is NOT_FOUND, never FORBIDDEN |
| — | the legacy create did not record who opened a work order | `openedByUserId` is written from the caller |

## Tests

`server/maintenance.db.test.ts` (6 cases, including a precondition that fails rather than skips
without a database): assignment and its refusals and history; cancellation leaving the defect open
and refusing advance, release, assignment and a second cancel; a standing release refusing
cancellation; the legacy create's opener, the legacy update's refusal, the advance's stamps and note;
the organization boundary on every maintenance procedure, `shop.workOrderAdvance`, and five
telematics procedures, and the work-order list.

Guards moved, each by exactly this checkpoint's surface: the operational procedure census (634 → 637,
in both tests), the mounted-path census in `crossLayerIntegrity.test.ts` (696 → 699), the refused-field
census in `operationalTruth.test.ts` (+1 `status`), the inventory row and total (356 → 359),
`documentationTruth`'s router-phrase table, and the `current-state.sh` narrative.

The first full gate run failed three of these guards — the two censuses above, and the calendar
tripwire, because the suite first used a fixed expected-completion date six days out beside real clock
reads. The date is now clock-relative; the second run is the one recorded above.

## Not built, and named

Holds, meter readings, unit operational state and their dispatch codes — the portfolio's Fleet Asset
Core. Defect history, triage, defect → work order, tasks, one release door, roadside close —
portfolio checkpoint 2 absorbing mechanic CP2 (O-11). Preventive maintenance, parts and labour on the
work order, costs, the portal UI, driver alerts — mechanic CP3–CP8 on that foundation.
`trips.create` accepts a `unitId` without checking the caller may see the unit; found here and not
fixed, because nothing in this checkpoint writes through it.

## Owner decisions

O-11 (one sequence with the portfolio, Fleet Asset Core next) and O-12 (what a service interval sees
when a meter regresses) are new; O-1 … O-10 stand as written in the design.
