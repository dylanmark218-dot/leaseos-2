# Analytics — Checkpoint B: the registry, the resolvers, the API

Built on `claude/leaseos-analytics-reporting-ko9ylj` after the Checkpoint A survey
(`docs/analytics/CHECKPOINT_A_SURVEY.md`). Server only: no screens, exports or financial metrics yet.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Contract | `server/_core/analytics/metricContract.ts` | the answer's shape; `aggregate()` is the only place a value comes from |
| Ranges | `server/_core/analytics/ranges.ts` | today, yesterday, 7/30 days, month/quarter/year to date, custom — resolved in a stated IANA zone or offset, UTC when none is given, echoed on every answer |
| Registry | `server/_core/analytics/metricRegistry.ts` | 29 metrics: id, formula in words, sources, unit, filters, source permission, freshness, incompleteness rule; `METRIC_REGISTRY_VERSION = "b.1"` pinned to a hash of the formulas |
| Resolvers | `server/_core/analytics/metricSources.ts` | one per resolvable metric; returns the qualifying rows and what it could not place |
| API | `server/analyticsRouter.ts`, mounted at `analytics.*` | `catalog`, `metric`, `drilldown` (`analytics.read`); `mine`, `mineDrilldown` (universal `analytics.read_own`) |

### The invariant, by construction

A resolver returns rows; `aggregate` turns rows into the value. `analytics.metric` and
`analytics.drilldown` run the same resolver with the same scope, range and filters, so a value and
its drill-down cannot disagree. Every answer names the call that repeats it exactly — the range is
echoed as its resolved instants, not as "today".

### Three gates, all on the server

1. The procedure permission: `analytics.read` (dispatcher, mechanic, shop lead, safety, office,
   management, HR, auditor, controller) or the universal `analytics.read_own`.
   `analytics.read` is also in the driver's `DENIALS`.
2. The metric's `requiredPermission` — the read permission of the records it counts — checked again
   inside the procedure. `analytics.read` never widens what a role can see: a mechanic reads defect
   metrics but is refused dispatch-check and duty-record metrics.
3. The organization, from `resolveActingScope` (never from input), applied by each source table's
   existing rule. A filter naming a unit, operator or job outside the scope is `NOT_FOUND`. A user in
   two organizations is refused (`PRECONDITION_FAILED`), as the resolver already refuses them.

### Data quality

`determination` is one of `computed`, `partial`, `unknown`, `not_applicable`, `not_derivable`,
`not_evaluated`, with every unplaced record named in `unknowns`. A counted zero is `computed`; a
completed trip or closed work order with no completion time is an `unknown` that makes the answer
`partial`; an average over nothing is `not_applicable`, never 0. `computedAt` and
`freshnessSeconds` let a screen mark an answer stale.

## The metrics

**Resolvable (22)**

| Family | Metrics |
|---|---|
| Operations | `ops.trips.in_progress`, `ops.trips.completed`, `ops.jobs.with_trip_in_progress`, `ops.drivers.on_trip`, `ops.units.on_trip` |
| Fleet | `fleet.units.registered`, `fleet.inspections.completed`, `fleet.inspections.failed` |
| Maintenance | `maintenance.defects.open`, `maintenance.defects.critical_open`, `maintenance.defects.reported`, `maintenance.work_orders.open`, `maintenance.work_orders.repair_hours_avg` |
| Compliance | `compliance.documents.expiring`, `compliance.documents.expired`, `compliance.documents.unverified`, `compliance.readiness.checks_blocked`, `compliance.readiness.checks_unknown` |
| Safety | `safety.incidents.reported`, `safety.near_misses.reported` (counts only; no statements, people or investigation detail) |
| Hours of service | `hos.driving_minutes_elapsed`, `hos.on_duty_minutes_elapsed` (elapsed time only) |

Eleven are available as the caller's own through `analytics.mine`: trips in progress and completed,
inspections completed and failed, the three document states, blocked and undecided dispatch checks,
and the two duty-time sums.

**Registered with their reason (7)**

| Metric | Answer | Why |
|---|---|---|
| `maintenance.work_orders.overdue` | `not_derivable` | work orders carry no due date |
| `maintenance.downtime.scheduled_split` | `not_derivable` | no preventive-maintenance schedule or work-order type |
| `safety.corrective_actions.outstanding` | `not_derivable` | `incidentActions` has no writer |
| `workforce.overtime` | `not_derivable` | no overtime rule is modelled |
| `hos.limit_position` | `unknown` | every HOS limit figure is unverified (P9) |
| `maintenance.downtime.hours` | `not_evaluated` | waits on the owner's moratorium decision (survey C12) |
| `fleet.utilization` | `not_evaluated` | needs downtime hours; same decision |

## The moratorium

Every resolvable metric either counts existing records through an existing scope rule or calls an
existing engine. That is "a router over something already written". The one engine newly reached is
`complianceDocumentValidity`: expiry is decided by `documentValidity.validityOf`, not by a fifth
inline date comparison. The downtime interval union and utilization would be new arithmetic, so they
are registered `not_evaluated` until the owner decides.

**SPINE item 2 is still open.** Analytics now reads the canonical expiry answer. The
`documentExpiry` tile, `readinessComposer.credentialState` and the exception centre still decide
expiry inline, and deleting those copies is the actual work item 2 describes.

## Things repaired on the way, each for a stated reason

- `server/calendarFixtures.test.ts`: `capitalAssets.test.ts` recorded in `REVIEWED`. Its fixture date
  2026-10-15 came within 21 days and failed the gate on an untouched tree. The dates are explicit
  inputs compared only with each other.
- `server/engineReachability.test.ts`: the census now follows `../x` out of a `_core`
  subdirectory. Without it, an engine reached only from `analytics/` read as unreached. No existing
  verdict changed (only `analytics/` uses the form). The unwired count went 57 → 56 as
  `complianceDocumentValidity` left the declared list.
- `server/spineWiringPlan.test.ts`: the spine check now follows imports through `_core` the way the
  census does, instead of seeing a router's direct imports only.
- `server/db.ts`: `complianceDocumentScopeWhere` exports the rule `listComplianceDocuments` already
  applied, and `listComplianceDocuments` now uses it. `jobUnitOperatorScopeWhere` is
  `incidentInScope`'s rule as a predicate over many rows. Neither is a new rule.

## Proof

| Suite | Kind | Holds |
|---|---|---|
| `server/_core/analytics/ranges.test.ts` | pure | zone arithmetic incl. Edmonton daylight-saving days, half-hour zones, fixed offsets, boundaries, refusals |
| `server/_core/analytics/metricContract.test.ts` | pure | counted zero vs unplaced vs nothing to average, truncation, breakdowns, sums, unavailable metrics |
| `server/_core/analytics/metricRegistry.test.ts` | pure | unique ids; complete definitions; a resolver for every resolvable metric and none for the rest; sources limited to tables with a scope rule; every metric readable by some role; no forbidden HOS label; no score, rank or percentage; no telematics driving events; version pinned to the formulas |
| `server/analytics.db.test.ts` | database | two organizations and the single tenant: hand-counted values; value = drill-down for **every registered metric in every scope**; no cross-organization rows across all metrics; not-found filters; ambiguous membership refused; driver, mechanic and bookkeeper gates; the driver's own numbers and nothing that can name another person |

The isolation test was checked by breaking it: with the trip query's organization predicate removed,
the hand-counted and cross-organization tests both fail.

## Next

Checkpoint C (dashboards as widget sources over `analytics.metric`, the colour mapping over
source verdicts, driver self tiles, mobile "last updated") needs no owner decision. The owner
decisions from the survey still stand: the moratorium exception (C12), branch (C3), platform-level
view (C2), current shift (C10).
