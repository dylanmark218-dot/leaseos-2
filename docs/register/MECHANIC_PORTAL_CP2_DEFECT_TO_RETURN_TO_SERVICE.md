# Mechanic Portal CP2 — Defect → Work Order → Repair Evidence → Authorized Return-to-Service (2026-10-01)

Branch `claude/mechanic-portal-domain-82efa9`. **Base:** `038dffc` (Fleet/Unit Security CP1.5 frozen, then
`main` `b35bac4` merged). **Implementation:** `fbbb6e1`. **Result:** `RESULT_SHA` (`main` `240b2dd`
merged on top). No pull request. Built on the Fleet & Equipment Portfolio (holds are `unitHolds`, state
is its projection) and on CP1.5 (units through `server/unitScope.ts`; return to service is a person's act).

```
unit → defect → work order → hold → repair tasks → release (repair evidence)
     → independent return to service → derived operational state → dispatch readiness
```

Every arrow is an API call, and every act writes a `maintenanceDefectEvents` row in the same transaction,
naming the actor and the role they acted in.

## The decision that shapes it: a hold is how "independent" is enforced

The owner's 0169 model, pinned by `readinessDefectRepair.db` and `dispatchReadinessPanel.db`, lets the
technician who signs a release also resolve the critical defect it names; readiness's `critical_defect` /
`mechanic_release_missing` then clear. That model is unchanged. CP2 adds a second, different fact:

| Record | Says | Cleared by |
|---|---|---|
| `maintenanceDefects.severity = critical` → `critical_defect`, `mechanic_release_missing` | the unit is **unrepaired** | a standing release that names the defect (0169) |
| the defect's `unitHolds` row (`sourceKind: defect`) → `unit_hold_safety` / `unit_hold_maintenance` | the unit has **not been returned to service by a second person** | `maintenance.returnToService` only |

Not one fact twice: the hold outlives the release on purpose, and nothing but the independent verification
lifts it. `fleet.holdRelease` refuses it (a workflow's hold is released by its workflow), and the
projection names `maintenance.returnToService` as the act that lifts it.

Who may lift it is the **portfolio's** hold rule, which the owner made authoritative: never the person who
placed it, and a safety hold only by safety or management. So a critical defect is returned to service by
safety or management; an inspection-required defect held for maintenance, by any other mechanic or shop
lead. In every case `returnToService` is also refused to the technician who signed the release — the one
guard a maintenance-held defect has against self-verification (the suite proves it fails without it).

## What was built

**Migration `0221_defect_lifecycle.sql`** (drafted `0220`; the scan found `0220` claimed by
`claude/eld-compliance-intelligence-ramlrd`) and **`0222_defect_lifecycle_guards.sql`**:

- `maintenanceDefects` + `defectRef` (UNIQUE), `source`, `driverStatement`, `severityProposed`,
  `severityProposedByUserId`, `severityDecidedByUserId`, `severityDecidedAt`. `severity` stays the decision
  readiness reads; the proposal is never read as one.
- `maintenanceDefectEvents` — append-only (trigger).
- `workOrderTasks` — forward only; a finished task is history and nothing is deleted (triggers).
- `inspections` — type `return_to_service`, with `inspectionRef`, `outcome`, `inspectorUserId`,
  `workOrderId`, `releaseId`; a return-to-service inspection is never edited or deleted (triggers).

**Procedures** — 7 new in `server/maintenanceRouter.ts`, over `server/defectLifecycleService.ts`:

| Procedure | Permission | Holders | Sensitive | Does |
|---|---|---|---|---|
| `maintenance.defectReport` | `maintenance.write_defect` (existing) | driver, mechanic, shop lead, office | no | the reporter's words and proposal; a proposed critical stands until triage (design O-3, recommended default) and places a safety hold at once |
| `maintenance.defectTriage` | `maintenance.defect.triage` | mechanic, shop lead, safety | **yes** | decides severity; raising to critical holds the unit; `holdUnit` holds an inspection-required one for maintenance; lowering releases the hold under the hold rule — a mechanic may raise to critical and may not take one back down alone |
| `maintenance.defectSendToShop` | `maintenance.defect.send_to_shop` | mechanic, shop lead, dispatcher, office | no | the work order and its first task together; one live work order per defect |
| `maintenance.taskAdd` / `taskSetStatus` | `maintenance.task.write` | mechanic, shop lead | no | forward only; done states the corrective action, not-required states why, deferred states the reason |
| `maintenance.returnToService` | `maintenance.return_to_service.record` | mechanic, shop lead, safety, management | **yes** | below |
| `maintenance.defectHistory` | `maintenance.read_defect` | shop and safety roles | no | the defect, every event, its work orders' tasks, its holds |

**Return to service** needs: the work order in scope and neither cancelled nor closed; a release on it
that names the work order's defect and still stands for every defect it names
(`currentReleaseEvidenceFor` — not revoked, not failed, not superseded); no task open or in progress; the
caller not the release's technician; and, for each hold it would lift, the hold rule. A **pass**, in one
transaction: the inspection; each named defect resolved on that release (if not already); their holds
released by the inspector; the roadside events those defects came from closed (design S-4 — an open
roadside event blocked a unit forever); the work order closed. A **fail** records the inspection and
changes nothing else. It never lifts a government out-of-service order (`enforcement.orderRelease`).

**One release door (design S-1).** `shop.workOrderRelease` now refuses while any task is open or in
progress, and writes the release with a `released` event per named defect. `records.maintenance.recordRelease`
is closed (the `hos.limitVerify` precedent): it never wrote `resolvedDefectIds`, so its releases never
counted as evidence. Its scope check stays, so another organization's work order is still "not found".
`records.maintenance.resolveDefect` keeps the 0169 model and now writes its `resolved` event in the same
transaction; `revokeRelease` is unchanged.

**Agents.** `maintenance.return_to_service.record` and `maintenance.defect.triage` (which can free a safety
hold) join `HUMAN_AUTHORIZATION_PERMISSIONS`, as CP1.5 required: no agent capability, and no Secretary
tool, may exercise either.

## Counts

| | Before (`038dffc`, `main` `b35bac4`) | CP2 (`fbbb6e1`) | After (`main` `240b2dd` merged) |
|---|---|---|---|
| Tables | 443 | 445 (**+2** `maintenanceDefectEvents`, `workOrderTasks`) | 457 |
| Migrations | 192 | 194 (**+2** `0221`, `0222`) | 199 |
| Role-authorized procedures | 755 | 762 (**+7**) | 797 |
| Operational procedure map (pin) | 735 | 742 (**+7**) | 777 |
| Mounted server paths (pin) | 805 | 812 (**+7**) | 851 |
| Permissions | 388 | 392 (**+4**) | 406 |
| Sensitive (fail-closed) | 146 | 148 (**+2**) | 159 |
| Unwired `_core` engines | 57 | 57 (no new `_core` module) | 57 |

Every count but the two pins is read from the source by `scripts/current-state.sh`; the "after" column
includes what `main` brought.

## Tests

`server/defectLifecycle.db.test.ts` — 11 cases through the real router, composer and triggers:

- **The arc**: a driver's critical report → `critical_defect` and `unit_hold_safety` (NEVER_OVERRIDABLE)
  → triage → sent to shop → assigned, started → release refused with an open task, a done task refused
  without its corrective action, a release refused without a road test → the release, and the unit is
  **still** held → return to service refused to the technician, to another mechanic (safety hold), to a
  driver → an independent safety officer's pass → defect resolved on the release, hold released, work order
  closed, unit `available`, readiness's blockers back to exactly the clean unit's — and eleven events in
  order with actor and role.
- An inspection-required defect held for maintenance: the technician refused, a failed verification
  changing nothing, another mechanic's pass lifting the hold.
- A roadside breakdown (`roadside.open`, the existing path) closed by the return to service of its repair.
- Refusals: another organization at every act (not found); lowering a critical by a mechanic and by the
  hold's placer; `fleet.holdRelease` on a defect's hold; a cancelled work order resolving, releasing and
  returning nothing (and the defect going back to the shop on a new one); an unnamed release and a revoked
  one; the closed door; tasks forward only; triggers on events, tasks and the signed inspection.

Changed: `tenantScopeRecords.db` (the owner's mechanic now releases through the one door and is told the
old one is closed), `actionGateway`, `ai/agentTools` (the two new human-authorization permissions), and
the pins.

## What merging `main` `240b2dd` found

`unitScopeGuard` (CP1.5) flagged two of `main`'s new open-work mutations. Each was run against
untouched `main` before anything was changed:

- **`shifts.post` stored another organization's unit.** Its `unitId` went into `shiftPosts`
  unchecked: a dispatcher in organization B posted work against organization A's truck and the call
  succeeded. A real cross-tenant write, not a guard false positive.
- **`shifts.award`** reached the canonical check only inside the binding, after reading the unit's
  readiness and recording its refusal; a foreign unit came back "No such shift post", not the
  unit refusal.

Both now call `requireCallerUnits` first (`c335dc0`, its own commit), and three cases joined the
CP1.5 table in `unitScopeSecurity.db` (`shifts.post`, `shifts.award` unit and trailer): another
organization's unit is refused exactly as a missing one, with nothing written. Red on `main` 3 of 3,
green here.

GATE_DETAIL

## Not in CP2, named

- **Defects created by the older paths do not place a hold.** `roadside.open`, `enforcement.eventConfirm`
  and `fieldRoute.maintenance.create` still create defects as before; their critical defects block through
  `critical_defect` and can be resolved under the 0169 model without an independent return to service.
  Routing them through `reportDefect` would change `productionPath` and the enforcement suites' expected
  ends; it is the natural next step and should be its own decision.
- The **pre-trip typed form** (`inspectionCommit`, `inspectionItems`: one failed line → one defect), the
  assistant's `severityProposed` (S-5), `telematics.faultAcknowledge` / `enforcementCommit` writing
  `source` and events, wiring `domainEmitters` (unwired 57 → 56) and notifications — design §9 CP2 items
  left for a CP2b so the safety lifecycle stood first.
- Preventive maintenance, parts, labour and costing, and the mechanic UI — not started, per the owner.
