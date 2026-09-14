# LeaseOS — v22.15 Checkpoint: Structures, Effective Dates, and Route Staleness

| | v22.14 | **v22.15** |
|---|---|---|
| Tables | 259 | **261** (`structures`, `routeApprovals`) |
| Migrations | 70 | **71** (`0072`) |
| Role-authorized procedures | 389 | **393** (+4) |
| Sensitive (fail-closed) permissions | 99 | **101** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,516 | **1,522** (+6, `structures.test.ts`) |
| Test files | 87 | **88** |
| Parity | 259/259 | **261/261 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## Where this sits against the project's own plan

The knowledge base's B13 sequence: **B13.1, B13.2, B13.3 and B13.8 shipped**
in v22.13–v22.14; **B13.4** (AER wells) is permission-blocked; **B13.9**
(GraphHopper/Valhalla) is P0. This is **B13.7 — structures and restrictions**
— plus the strongest idea in those notes that existed nowhere in the code:
the **route dependency fingerprint**.

## A defect worth naming

`roadRestrictions` has carried `effectiveFrom` and `effectiveTo` since B12.
**Nothing read them.** A spring road ban recorded with a March–June window
kept blocking in September, and one recorded in advance applied in January.
The evaluator now takes an evaluation date, applies only what is in force on
it, and **reports what the window excluded** rather than dropping it
silently — because a driver who remembers last spring's ban deserves to be
told it has lapsed, not left to wonder.

Tested against real dates: the same segment blocks in April on a 9,000 kg
spring ban, and in September on a posted 29,000 kg bridge while the lapsed
ban is named as expired.

## The most restrictive governs

While fixing the window I found the ordering would have taken the
**latest-recorded** verified row for a check. With a spring ban of 9,000 kg
and a standing limit of 29,000 kg both in force, that can pick the *more
permissive* of two limits. For weight, clearance and width that is the wrong
way to be wrong. Among rows of equal standing, the lowest limit now governs.

## A posted limit is the limit; a rated capacity is not

A **structure** — bridge, culvert, overhead, cattle guard, ford, narrow
passage — is now a record: what is posted, what it is rated for, its width
and clearance, its seasonal variation, its authority and source document, an
effective window, and a second person's verification (never the recorder's).
A **posted** limit becomes a limit the evaluator enforces. A **rated**
capacity with nothing posted does not: it is engineering data, it produces a
note, and the check stays UNKNOWN — because what governs a driver is the
sign. A structure with nothing posted, rated or seasonal is refused outright:
it states no limit.

## An approved route knows when it has gone stale

An approval carries a **dependency fingerprint** over seven things: the
unit's profile, the load, the permits, the restrictions in force, the
structures on the route, the imported road data, and the checks required.
Ask whether it still holds and the answer is arithmetic:

```
the restrictions in force changed since this route was approved
the imported road data changed since this route was approved
```

A heavier load is a different question — 28,000 kg and 34,000 kg produce
different fingerprints, so the approval does not quietly carry over. A
blocked route is never approved at all. The check records what it found, so
the staleness is on the record and not only in the answer.

## Corrected on the way

The gate's typecheck is stricter than my ad-hoc grep — `Map` iteration and
inferred parameters — caught before shipping, fixed properly rather than by
loosening the config. Six fixture mismatches against procedures I had not
read closely enough: the axle-group shape, the profile source enum, which
roles hold `spatial.vehicle.manage` and `spatial.vehicle.verify`, and that
the source document belongs on **verification**, not on recording — which is
correct, and is exactly where evidence should be demanded.

## Files

**New:** `0072_structures_and_route_staleness.sql` · `_core/structures.ts` ·
`structures.test.ts` (6)

**Changed:** `spatialRouter.ts` (window filter, structures applied, 4
procedures, dependency composer) · `schema.ts` ·
`recordsAuthorization.ts` · two count pins · inventory · generator

## Not built, and named

The routing graph — **P0 stands**; nothing computes a route. Automatic
re-evaluation when an approval goes stale (the check reports and records it;
nothing re-runs the route). Structures harvested from any authority feed —
every one is recorded by a person today. Breadcrumb-derived route learning
(B13.6's second half). The older `bridges` table still feeds the evaluator
alongside `structures`; it is not yet retired.

## Blockers

**P0/P5** — no routing source. **AER ST37 / ST102** — written permission for
commercial use. **Alberta 511** — API key. **P9** — no verified rule.
