# Fleet & Equipment Portfolio — foundation slice: reconciliation with the repository (2026-09-25)

Design: `docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md` (branch
`claude/fleet-equipment-portfolio-design-3d13d5`, `21b3cfc`, no code). Built on
`claude/mechanic-portal-domain-82efa9` after `main` `88608f3`.

Owner decisions of 2026-09-25 that govern this slice:

1. The portfolio model is authoritative for unit holds, meter readings and unit operational status.
2. The Mechanic Portal does not recreate or dual-write those concepts.
3. A meter reading that regresses below a previously accepted reading makes distance-based maintenance
   evaluation return an explicit cannot-evaluate state, never "not due".
4. The reason is machine-readable (`METER_REGRESSION`); the original reading is kept as evidence and
   never repaired or overwritten.
5. The Mechanic Portal consumes the portfolio's projections and APIs.

## What was checked

- **Nothing of the portfolio has landed.** No `unitHolds`, `unitMeterReadings`, `unitComponents` or
  `fleetPortfolioEvents` table and no `fleetPortfolio` module exist on `main` or on any of the 70
  fetched branches; the design branch still holds only its document.
- **The readiness composer is unchanged** on `main` since the mechanic portal's checkpoint 1
  (`git diff 5936108 origin/main -- server/readinessComposer.ts` is empty).
- **Migrations.** The complete corpus (main plus every fetched branch) holds numbers up to `0198`
  (C1b-2b's `0198_requirement_verification.sql`, merged to `main` in #54 while this slice was being
  gated); `0199` is this branch's work-order ownership, moved up from `0198`. This slice takes **`0200`** (tables) and **`0201`**
  (trigger DDL, in its own file as the portfolio design asks). The design's `0182` / `0183` were
  taken long ago.

## Contradictions, and how this slice resolves them

| # | The portfolio design says | The repository or the owner says | Resolution |
|---|---|---|---|
| R-1 | a hold's `dispatchEffect` is `block` or `warn` | the owner requires three levels: warning, dispatch-blocking, safety / out-of-service | `dispatchEffect` is `warn` / `block` / `out_of_service`. `out_of_service` if and only if `holdType = safety`. In readiness: `warn` → review, overridable by a manager; `block` → blocking, releasable only under an approved override policy (none exist, so none today); `out_of_service` → blocking, overridable by no one |
| R-2 | the composer reads `incidentReports.unitHeld` as `incident_unit_held` (closing R-11) | `records.incident.capture` writes the request's `unitId` unchecked (unit-scope sweep #19): a user in one organization can file an incident naming another organization's unit | **Deferred.** Reading it now would let a foreign user ground another organization's truck. It is listed in the projection's `notEvaluated`, and lands once #19 is fixed |
| R-3 | "the latest reading is the latest *verified* reading"; readings from telemetry, work orders, fuel and trips stay where they are | those in-place sources carry no verification status; the owner's rule speaks of a *previously accepted* reading | **Accepted** means: a telemetry snapshot, a work-order, trip, fuel-receipt or tire-service figure (each written in its own domain by an authorized person or an owned integration client), or a ledger reading a second person verified. A ledger reading nobody has verified is **provisional**: shown, never the current value, but it *can* expose a regression. A rejected reading is kept and shown, and takes no part. |
| R-4 | "a reading below the last verified reading is `meter_regression` — recorded, flagged, never rejected" | the owner: evaluation must return cannot-evaluate | Both: the reading is stored untouched, the pair is flagged `METER_REGRESSION`, the unit's sequence reads `UNTRUSTED_METER_SEQUENCE`, and `meterProgress` from any baseline at or before the drop answers `indeterminate` with reason `METER_REGRESSION`. A later baseline taken after the drop — in practice a verified reading at the next service — evaluates normally again; nothing is repaired to get there |
| R-5 | — | the owner: identical readings need a defined deterministic behaviour | Equal values are no progress and no regression. Two observations are compared after rounding to one decimal of the meter's unit, so two sources that store the same figure at different precision do not manufacture a regression. Ties in time break by source precedence (telematics, work order, tire service, trip, fuel receipt, ledger) and then by reference |
| R-6 | `sourceKind` is `manual / incident / damage_report / inspection / document_expiry` | the mechanic portal's checkpoint 2 places holds from a defect and releases them on a work order | `sourceKind` also takes `defect`, `work_order` and `enforcement`, so checkpoint 2 uses this table rather than a second one |
| R-7 | the first slice extends `units` with identity and lifecycle columns, adds `unitComponents`, a fleet list and asset detail UI, unit-only readiness, `fleet.myAssignedUnits` | the owner: the smallest canonical foundation the mechanic portal needs | **Deferred**, unchanged in the design: identity and lifecycle columns, components, the list and detail UI, unit-only readiness, the driver's own-unit read. `lifecycle` is in `notEvaluated` |
| R-8 | operational states `available / dispatched / maintenance_hold / inspection_hold / compliance_hold / out_of_service / maintenance_due` | the owner's list: available, warning / service due, maintenance hold, safety / out-of-service, indeterminate | The projection returns the owner's five as `status` and keeps the design's finer split as each reason's `category` (`maintenance`, `inspection`, `compliance`, `safety`, `enforcement`, `telematics`, `meter`, `source`). `dispatched` needs bookings and is not a condition of the unit; `compliance_hold` from documents and insurance stays with the readiness composer, which already decides it. Both are in `notEvaluated`, so `available` never claims them |
| R-9 | `fleet.meter.record` includes the driver, for their own assigned units | there is no own-unit resolver yet (R-7) | The driver is not granted it in this slice |

No contradiction required choosing between two things the owner had approved; each is resolved by the
owner's own requirement or by the more conservative reading, and each is testable.

## What is canonical after this slice

- **`unitHolds`** — the only table of manual holds. The mechanic portal places and releases its holds
  here, with `sourceKind = defect | work_order`.
- **`unitMeterReadings`** — the ledger for readings with no other home. Nothing is copied into it.
- **The meter union** — `fleetPortfolioService.meterObservations`: the ledger plus telemetry snapshots,
  work orders, fuel transactions, trips, tire installations and tire measurements, each observation
  carrying its table, row and field. Bulk fuel dispenses are not read: every dispense writes the same
  odometer to the fuel transaction it creates.
- **`_core/fleetMeters.ts`** — `meterSequence` and `meterProgress`, the seam preventive maintenance
  calls.
- **`_core/fleetPortfolio.ts` `operationalState`** — the unit's derived status.
- **`fleetPortfolioEvents`** — append-only, trigger-protected history of holds and meter readings.

The readiness composer stays the single authority on dispatch (D-06): it reads active `unitHolds`
into its existing blocker list, classification and fingerprint.
