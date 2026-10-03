# ELD Checkpoint 2c — the designated duty day

**Branch:** `claude/eld-compliance-intelligence-ramlrd`. **Base:** `c0543cf` (main merged to `db7dc7c`).
**Scope:** where an operator's duty day begins, recorded as history; the duty-day clocks computed exactly
over it; both shown by `eld.hosStatus`. **No verdict is unlocked.** Dispatch, readiness, the job board,
`hos.ts`, the rule registry and every UI are untouched. Dispatch still answers `hos_unknown`.

## Why this is the next step, and why it decides nothing

Checkpoint 2a refused every daily verdict with `HOS_DAY_BOUNDARY_UNKNOWN`: a verified "N hours in a day"
means nothing until the day is defined, and LeaseOS had no record of where any operator's day begins.
That gap has two halves:

1. **A fact about the operator** — their home-terminal timezone and the local time their day starts.
   This is not law. It is recorded once, by the office, and it changes rarely.
2. **A rule about the regime** — that a given schedule counts a given limit over that day. This IS law,
   and like every figure it must be verified before the engine uses it.

This checkpoint builds half 1 only. With a designation on record the engine shows the day's clocks and
names the remaining blocker precisely: a daily limit becomes `HOS_DAY_RULE_UNVERIFIED` ("the day is
designated, but no verified rule says this limit is counted over it") instead of
`HOS_DAY_BOUNDARY_UNKNOWN`. The verdict stays UNKNOWN, `remaining` stays null, and no violation is raised,
even when the designated day's count is over a verified figure (tested).

## The record — `0224_eld_duty_day_designations.sql`

`eldDutyDayDesignations`: `designationRef`, `orgRef`, `operatorId`, `timezone`, `dayStartMinutes`
(0–1439, a `CHECK`), `effectiveFrom`, `reason`, `tzVersion`, `recordedByUserId`, `recordedAt`.
BEFORE UPDATE / BEFORE DELETE triggers refuse every mutation: a change is a new row.

The designation in force at an instant is the latest `effectiveFrom` at or before it.
`recordDutyDayDesignation` (the only writer) adds one rule the triggers cannot express — **history is
only ever extended at its end**:

| Refusal | When |
|---|---|
| `backdated` | `effectiveFrom` is earlier than the server's clock at recording |
| `not_after_latest` | `effectiveFrom` is not later than the operator's latest designation's |
| `timezone_unknown` | the runtime's IANA database does not know the zone, or it is a fixed offset (`+05:00`) |
| `day_start_invalid`, `reason_required` | as named |
| `operator_not_found` | the operator does not exist or belongs to another organization |

Together, `backdated` and `not_after_latest` mean no later designation can change which designation
was in force at an instant the engine has already answered for. Both checks and the insert run in one
transaction holding the operator row (`SELECT … FOR UPDATE`), so two concurrent designations cannot both
pass. The cost: an instant before an operator's first designation has no designated day and reads
`HOS_TIMEZONE_UNKNOWN`. A reviewed backfill path is follow-up F-8.

The zone is stored under the database's canonical name (`america/edmonton` → `America/Edmonton`,
`US/Pacific` → `America/Los_Angeles`) so one zone is never two strings, and `tzVersion` records the IANA
database the recording server ran: the same name can mean different offsets in different versions.

## The arithmetic — `server/_core/eld/dutyDay.ts`

Pure. Offsets come from the runtime's ICU database, never from constants. Local times that do not exist
or happen twice are resolved as the Temporal proposal's `"compatible"` disambiguation does:

* a skipped time (spring forward) moves forward by the gap — 02:30 becomes 03:30;
* a repeated time (fall back) takes the earlier instant.

So a day is 24 hours, 23 on a spring-forward day and 25 on a fall-back day, and the code never assumes
24. `dutyDayClocks` counts driving, on duty (driving + on duty, as `hos.ts` rolls up), off duty and
sleeper berth over the day **up to the instant asked**, and reports the elapsed minutes with no status on
record as `unrecordedMinutes` rather than filling them.

Every expected instant in `server/_core/eldDutyDay.test.ts` is worked by hand from the zones' published
rules. The suite first asserts `process.versions.tz === "2026c"` (the gate's pinned Node 22.23.3): under
2026c America/Edmonton keeps −06:00 through November 2026, so its 1 November is 24 hours while
Winnipeg's is 25 — if the database changes, those expectations are re-derived, not edited to pass.

## The procedures

| Procedure | Permission | Who holds it |
|---|---|---|
| `eld.dutyDayDesignate` | `eld.dutyday.designate` — new, **sensitive** (fail-closed audit) | safety, management |
| `eld.dutyDayHistory` | `eld.read` | dispatcher, safety, office, management, auditor |

Both take `.strict()` input with no organization; the organization is the caller's acting scope, and an
operator outside it reads as not found. A driver sees their own designation through `eld.hosStatus`
(`dutyDay.designationRef`, the window, the zone) without needing `eld.read`.

`eld.hosStatus` loads the designation in force at `at`, widens its read window to cover the whole
designated day (a 25-hour day is longer than the 1-day minimum lookback), and passes it to the engine.

## The engine — `hos-engine/2c`

`HosEngineInput.homeTerminalTimezone` (always null) is replaced by `dutyDay` (the designation, or null).
The result gains `dutyDay`: the window, the four clocks, `unrecordedMinutes`, `designationRef`,
`designationEffectiveFrom`, and `designationChangedDuringDay` — true when the designation took effect
after the day began, i.e. the day's start was computed by a designation not yet in force at that start.
A designation whose zone the runtime no longer knows yields `dutyDay: null` and `HOS_TIMEZONE_UNKNOWN`:
never UTC, never the server's zone.

New reason code: `HOS_DAY_RULE_UNVERIFIED`. Shift, cycle, break and rest behaviour is unchanged.

## Counts that moved

| Pin | Before | After | Why |
|---|---|---|---|
| operational procedure map (two suites) | 780 | 782 | `eld.dutyDayDesignate`, `eld.dutyDayHistory` |
| router paths (`crossLayerIntegrity`) | 854 | 856 | the same two |
| migration head (`migrationSlots`) | 0222 | 0224 | this checkpoint's claim; 0223 is held by integration-hub |
| inventory total | 493 | 495 | eldRouter row 3 → 5, regenerated by `scripts/procedure-inventory.mjs` |

## Gate

One authoritative run of `scripts/ci-gate.sh` on this tree, against a freshly dropped and recreated
database, Node 22.23.3 (tz 2026c), no other gate running: **PASS**. 475 test files, 7189 passed,
3 skipped (the three long-standing skips); widget suite 4 files, 67 passed; current-state document
current. The merge of `main` `db7dc7c` underneath (`c0543cf`) was typechecked and its guard suites run
before commit, and is covered by this same run.

## Next

* **Verify a day rule** (owner + regulatory source): which schedules count which limits over the
  designated day. That is a registry entry with a citation and a second-person verification, not code.
  When one exists, the engine's daily downgrade lifts for exactly that profile and limit.
* F-8 (backfill from evidence) and F-4 (device outbox) remain the prerequisites for historical and live
  answers respectively.
