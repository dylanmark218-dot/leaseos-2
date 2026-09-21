# LeaseOS — Widget Source Matrix

The authoritative catalogue. A widget that is not in this file is not
registered, and a widget in this file is exactly as implemented as its status
says.

**Status tiers**

| Tier | Means |
|---|---|
| **PRODUCTION** | Real engine named and exercised, permission mapped to a registered procedure, tests, runtime, browser proof. |
| **PROVISIONAL** | The source contract is defined and the runtime path is proven, but the engine is on the branch and has never been called from here. Must never be presented as production. |
| **BLOCKED** | Wanted, with a named dependency that is unfinished. |
| **UNAVAILABLE** | No credible source exists. A card is not a sensor. |

---

## The honest headline

**PRODUCTION: 0.**

Not one widget in this workspace meets the production bar, and the reason is
structural rather than a shortfall of effort: **this engine has never had the
LeaseOS branch.** Every procedure name below is inferred, the authorization map
is a shim, and no LeaseOS engine has ever been called. Registering thirty
widgets against `hos.remaining` when nobody has confirmed that procedure exists
would be exactly the fabrication B27 forbids — a card with a plausible name and
nothing behind it.

So B27 delivers the *machinery* for a production catalogue — the descriptor
contract, the registry integrity gate, the projection layer, the browser
proof — and classifies the twelve existing registrations plus wave-1 candidates
honestly. The tier flips to PRODUCTION per widget as `RECONCILIATION.md` is
worked through, one confirmed procedure at a time.

**PROVISIONAL: 12** (the proving set, runtime-proven, procedure names unconfirmed)
**BLOCKED: 9**
**UNAVAILABLE: 11**

---

## PROVISIONAL — the proving set

Runtime, permissions, provenance, offline behaviour, variants, spans and options
are all implemented and tested. What is missing in every row is the same thing:
a confirmed procedure on the branch.

| key | name | category | roles | source engine | procedure (inferred) | subject | authority | freshness | offline | variants | spans | options | action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `myDay` | My Day | My Work | DRIVER, OPERATOR, FIELD_SUPERVISOR | surfaces | `surfaces.myDay` | self | server | 60s | pre-departure 240m | list, detail | 1×1–2×1 | limit | open |
| `inbox` | Inbox | My Work | DISPATCHER, SAFETY, BILLING | surfaces | `surfaces.inbox` | self | server | 60s | none | queue, list | 1×1 | limit, unreadOnly | open |
| `exceptions` | Exception Centre | Dispatch | DISPATCHER, SAFETY, ADMIN | Exception Centre (derived on read) | `surfaces.exceptions` | org | server | 120s | none | queue, kpi, list, detail | 1×1–2×2 | limit, severity | open |
| `dispatchReadiness` | Dispatch Readiness | Dispatch | DISPATCHER, FIELD_SUPERVISOR | `readinessComposer.ts` | **`dispatch.readiness`** (confirmed, B28A; permission still inferred) | job | server | 30s | none | status, checklist, detail | 1×1–2×1 | — | resolve |
| `hosRemaining` | Hours Remaining | HOS | DRIVER, OPERATOR | local duty log + cached rule profile | **`hos.status`** (confirmed, B28) | self | **device-local** | 60s | device-local | kpi, gauge, countdown, detail | 1×1 | — | open |
| `documentExpiry` | Expiring Documents | Documents | DRIVER, SAFETY, ADMIN | records | `records.documentExpiry` | self | server | 300s | pre-departure 1440m | list, kpi, detail | 1×1–2×1 | warnDays | open |
| `unitReadiness` | Unit Readiness | Fleet | DRIVER, MECHANIC, DISPATCHER | shop readiness | `shop.unitReadiness` | unit | server | 120s | pre-departure 720m | status, checklist, detail | 1×1–2×1 | showPassing | resolve |
| `activeJob` | Active Job | My Work | DRIVER, DISPATCHER, CLIENT_VIEWER | jobs | `jobs.active` | job | server | 60s | pre-departure 480m | status, detail, timeline | 1×1–4×1 | — | open |
| `activeTrip` | Active Trip | Trips | DRIVER, DISPATCHER | trips | `trips.active` | trip | server | 30s | **pre-departure 120m** | status, timeline, map, detail | 1×1–2×2 | layer | open |
| `syncStatus` | Sync Status | System | DRIVER, OPERATOR, FIELD_SUPERVISOR | device outbox | `sync.status` | self | **device-local** | 15s | device-local | status, kpi, queue | 1×1 | — | — |
| `trackingLookup` | Tracking Number Lookup | System | DISPATCHER, BILLING, ADMIN | timeline surface | `surfaces.timeline` | org | server | on demand | none | form, timeline | 1×1–2×2 | — | open |
| `search` | Search | System | DISPATCHER, FIELD_SUPERVISOR, ADMIN | search surface | `surfaces.search` | org | on demand | none | pre-departure 1440m | form, list | 1×1–2×1 | — | open |

### Wave-1 HOS projections — designed, not registered

`hos.summary` returns one structured answer; five tiles read different fields of
it through `HOS_PROJECTORS`. The projection layer and its confidence rules are
implemented and tested (`widgetProjection.ts`, 16 tests). The registrations wait
on the procedure.

| intended key | reads | status |
|---|---|---|
| Driving Hours Remaining | `drivingRemainingMinutes` | BLOCKED — needs `hos.summary` |
| On-Duty Hours Remaining | `onDutyRemainingMinutes` | BLOCKED — needs `hos.summary` |
| Cycle Hours Remaining | `cycleRemainingMinutes` | BLOCKED — needs `hos.summary` |
| Break / Rest Countdown | `breakDueInMinutes` | BLOCKED — needs `hos.summary` |
| Current Duty Status | `dutyStatus` + rule profile | BLOCKED — needs `hos.summary` |
| HOS Violation Warning | `violations` → blocked payload | BLOCKED — needs `hos.summary` |
| Log Certification Status | `hasUncertifiedEdits` | BLOCKED — needs `hos.summary` |

One engine call feeds all seven. Registering them as seven independent reads of
`hos.remaining` would have been the defect the projection layer exists to
prevent.

---

## BLOCKED — wanted, dependency unfinished

| widget | blocked by |
|---|---|
| Driving / On-Duty / Cycle Remaining, Break Countdown, Duty Status, Violation Warning, Log Certification | `hos.summary` procedure, and a versioned rule profile that can be cached to the device |
| Legal Weight Remaining | regulatory profile work (P9: no verified rules loaded) |
| Permit Weight Remaining | permit engine + regulatory profiles |
| Driver ETA / Unit ETA | P0 spatial routing (HERE/Valhalla), migration slots 0016/0017 |
| Blocked Assignments, Dispatch Blockers | projections of `dispatch.gateCheck`, ready once that name is confirmed |
| Unassigned Jobs, Active Dispatches, Jobs Awaiting Acceptance, Late Dispatches | dispatch list procedures not yet named |
| Critical / Outstanding Defects, CVIP Status, Next Inspection Due, Open Work Orders, Maintenance Due/Overdue, Out-of-Service | shop engines exist on the branch; procedures unconfirmed |
| Loads Completed / Remaining, Current Site, Upcoming Stop, Waiting / Loading / Unloading Time | LoadSense (`B19`, migration slot 0018) |
| All client-portal tracking widgets | client scope authorization not yet proven; needs negative-authorization tests against real scope |

---

## UNAVAILABLE — no credible source

A card is not a sensor. None of these has an ingestion path.

GVW Estimate · Steer Axle Weight · Drive Axle Weight · Trailer Axle Weight ·
Payload Estimate · Fuel Level · DEF Level · Battery Health · Brake Temperature ·
Tire Pressure · Diagnostic Trouble Codes

These stay out of the registry entirely. They do not get a card that renders
`unknown`; they get no card, because a tile that permanently reads "cannot
determine" teaches drivers to ignore the word.

---

## Evidence, per dimension (B28B)

Procedure evidence and permission evidence are separate facts. One status column
would have to pick one, and `dispatch.readiness` is the case that proves it
would be wrong half the time.

| widget | proc conf. | procedure | perm conf. | permission | source conf. | engine | contract | status | blocker |
|---|---|---|---|---|---|---|---|---|---|
| `hosRemaining` | **CONFIRMED** | `hos.status` | **CONFIRMED** | `hos.read` | CONFIRMED | HOS status engine | **PARTIAL** | BLOCKED_BY_BRANCH | `determination` shape invisible; runtime cannot execute |
| `dispatchReadiness` | **CONFIRMED** | `dispatch.readiness` | **UNCONFIRMED** | `dispatch.read` (guess) | CONFIRMED | `composeReadiness` | **PARTIAL** | BLOCKED_BY_BRANCH | permission map not in this worktree; `contributions` invisible |
| `unitReadiness` | COMPOSED | — | NO_EVIDENCE | — | CONFIRMED | `readinessComposer.ts` | NO_EVIDENCE | COMPOSED | is it an axis of `contributions`? |
| `inbox` | NO_EVIDENCE | `surfaces.inbox` | NO_EVIDENCE | — | **PARTIAL** | `surfacesService.loadInbox` | NO_EVIDENCE | NO_EVIDENCE | source confirmed, procedure not |
| `syncStatus` | NO_EVIDENCE | `sync.status` | NO_EVIDENCE | — | PARTIAL | device outbox | NO_EVIDENCE | NO_EVIDENCE | may need no procedure at all |
| `myDay`, `exceptions`, `search`, `trackingLookup` | NO_EVIDENCE | `surfaces.*` | NO_EVIDENCE | — | NO_EVIDENCE | — | NO_EVIDENCE | NO_EVIDENCE | no `surfaces.*` in this worktree |
| `documentExpiry` | NO_EVIDENCE | `records.documentExpiry` | NO_EVIDENCE | — | NO_EVIDENCE | — | NO_EVIDENCE | NO_EVIDENCE | no `records.*` in this worktree |
| `activeJob` | NO_EVIDENCE | `jobs.active` | NO_EVIDENCE | — | NO_EVIDENCE | — | NO_EVIDENCE | NO_EVIDENCE | no `jobs.*` in this worktree |
| `activeTrip` | NO_EVIDENCE | `trips.active` | NO_EVIDENCE | — | NO_EVIDENCE | — | NO_EVIDENCE | NO_EVIDENCE | no `trips.*` in this worktree |

## B28 reconciliation progress

Two procedures confirmed against real branch source, ten still inferred.
B28A added `roleProcedure(...)` mount scanning, which is how the second one
surfaced — its permission map was never touched by that worktree.

| finding | detail |
|---|---|
| `hos.remaining` → **`hos.status`** | permission `hos.read`. Adopted across registry, shim and twelve callers. |
| HOS rule profiles are real on the branch | `hos.profileFor`, `hos.profileList`, `hos.profileSeed`, `hos.profileVerify`, `hos.limitVerify`, permission family `hos.rule.*`. The B27 `HosRuleProfile` contract should be reconciled against `hos.profileFor` rather than kept as designed. |
| Unit readiness is composed, not one procedure | the branch has `shop.workOrderRelease` (`shop.release`), `shop.workOrderAdvance`, `shop.workOrderCost`. `shop.unitReadiness` does not exist. |
| Ten widgets: NO_EVIDENCE | their domains are not covered by the available diff. Not the same as absent. |

A confirmed name is not production. `hos.status` still resolves through a shim
and its engine has never been called.

## Locked architecture decisions

**Board auditing.** One audit event per board open, carrying actor, scope,
effective role, layoutRef, tile count, withheld count, unknown count and failed
count. Never one per tile refresh — thirty reads a minute would bury the log
that answers "who saw our compliance records". Protected procedures keep their
own audits. No tile payloads are logged.

**`activeTrip` is not device-authoritative.** A trip is a server record a
dispatcher can reassign; the device knows only what it last saw. Offline it
shows a cached server answer, `stale` within 120 minutes with its as-of time and
`offline` past it. Cached trip state may never authorize dispatch,
arrival/departure, load completion, billing or a safety decision — those run
`submitBoardAction`, which reruns the gate.

**HOS rule profiles are versioned regulatory inputs.** A local HOS result is
valid only when its profile carries jurisdiction, authority, rule family, cycle
type, effective-from/to, profile version, schema version, content hash and
verified-at. The result names the profile that produced it. Missing, expired,
ambiguous, unsupported-schema or failed-integrity all resolve to `unknown` and
non-authorizing. No silent fallback to a neighbouring province, to federal
rules, or to a previous version.
