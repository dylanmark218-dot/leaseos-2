# ELD Checkpoint 2a — the HOS engine over the ledger (pure, fail-closed)

**Branch:** `claude/eld-compliance-intelligence-ramlrd`. **Base:** `c9f5a07` (main merged to `1680e94`, ledger at `0187`).
**Scope:** a pure calculation layer between the ELD ledger and the existing clock engine. No schema, no
migration, no router, no permission, no dispatch, no readiness, no job board, no UI. `server/_core/hos.ts`
and the rule registry are untouched; no figure was verified or changed.

## Why this checkpoint, and why this narrow

The design's phase order is ledger, then engine, then everything that consumes the engine. Dispatch,
the job board and `hos.status` all want "hours available", and today each would have to invent it.
This checkpoint gives them one function to call later, and proves, before anything calls it, that it
states a number only when everything behind the number is verified.

## What was built

| File | Role |
|---|---|
| `server/_core/eld/reasonCodes.ts` | The stable machine vocabulary (`HOS_*`). A code is added when an engine first emits it, never ahead of the behaviour, and never renamed. |
| `server/_core/eld/hosProjection.ts` | Ledger rows → the clock engine's `DutyEntry[]`. Pure. |
| `server/_core/eld/hosEngine.ts` | `evaluateHos(input)`: projection → `selectProfile` → `computeClocks` → `determine` → the mechanics discipline below. Pure. |
| `server/_core/eldHos.test.ts` | 24 tests; every expected minute hand-computed from the fixture timeline and written as a literal. |

## The projection

- One entry per active duty-status event, running to the next; the last is open (`HOS_OPEN_STATUS`).
- Ordered by the device's clock, then its sequence; row arrival order changes nothing.
- **A correction retracts; it never edits.** The ledger contract forbids a correction from carrying a
  duty status, so an event named by an active correction is left out, and the replacement status is
  whatever duty-status event the device recorded. Retracting a correction restores what it retracted.
- **Correction cycles** (two corrections naming each other, which the ledger cannot prevent because a
  device may name a target it has not sent yet) are detected deterministically, treated as active,
  and reported (`HOS_CORRECTION_CYCLE`) for a person. Every row names at most one target, so the
  chains are functional graphs and the detection is exact.
- **Personal conveyance and yard moves are reported, not counted** (`HOS_SPECIAL_CATEGORY_UNMAPPED`):
  what they count as is a regime rule nobody has verified.
- No duty status is ever fabricated for a gap. No rows → no entries → `HOS_NO_DUTY_RECORD`.
- Other operators' rows and unidentified rows are ignored and counted, never silently dropped.

## The discipline: a verified figure is not enough

The only mechanics in the codebase is the trailing-window default inside `computeClocks`: a rolling
24 hours, rolling 7 and 14 days, a shift after the last long rest. It is honest about elapsed time
and makes no claim about a regime's day or cycle. So, even when the figure is verified:

| Limit family | Under the default mechanics | Code |
|---|---|---|
| `daily_*` | UNKNOWN, clock shown, no limit or remaining | `HOS_DAY_BOUNDARY_UNKNOWN` |
| `cycle_*_on_duty` | UNKNOWN, clock shown | `HOS_MECHANICS_DEFAULTED` |
| `shift_*` | determined only when `core_rest_minutes` (what ends a shift) is itself verified | `HOS_MECHANICS_DEFAULTED` otherwise |
| `break_required_after_drive` | determined from continuous driving, which depends on no boundary | — |
| rest rules (`core_rest`, `daily_off_duty`, resets, mandatory rest, break length, reduced-rest floor) | UNKNOWN: rest is counted but no rule about what rest satisfies what is implemented | `HOS_REQUIRED_REST_UNDETERMINED` |
| parameters (`cycle_1_days`, `cycle_2_days`) | consumed by the clocks when verified, never reported as a limit | — |

The consequence is tested: a verified 300-minute daily driving figure against a rolling count of 420
produces **no violation**, because "over, by a rolling day" is not a finding anyone can defend. And the
converse: with a verified break rule and nothing else, the engine does reach `within`, and with a tighter
one it reports `HOS_BREAK_REQUIRED` while leaving the observed DRIVING status and the ledger rows untouched
(the 0079 invariant, now over the ledger).

`remaining` is populated per clock family only from a determination that survived the discipline, and
names the rule ids it came from. Against the real seeds, every one of them is unverified, so every
remaining figure is null and every unknown is `HOS_LIMIT_UNVERIFIED` — tested against `ALL_HOS_PROFILE_SEEDS`.

## Deliberately not here

- **Regime mechanics modules** (Canadian federal, Alberta): each needs a verified day definition, cycle
  counting and reset rules. When one exists, it replaces the default for the limits it governs and the
  downgrades above stop applying to them. Not written, because writing one means encoding unverified law.
- **Home-terminal timezone**: there is no column; the engine takes it as input and reports
  `HOS_TIMEZONE_UNKNOWN` because it is always null today. Adding the column is a migration for the
  checkpoint that first needs it.
- **Exemptions**, **approaching-limit warnings** (a company-policy threshold), **required rest /
  earliest legal driving time**, **feasibility for a proposed job**: all consume verified mechanics.
- **Wiring**: `hos.status`, `eld.*`, the readiness composer and the job board do not call `evaluateHos`
  yet. That is the next integration step, and dispatch remains the last.

## Recommended next checkpoint

Wire `evaluateHos` into a read-only `eld.hosStatus` procedure (tenant-scoped through the device and
operator ownership rules the ledger already enforces), so the office and the driver can see the ledger-
derived clocks with their reason codes. It changes no existing answer: dispatch keeps `hos_unknown` until
a mechanics module and verified figures exist. In parallel, a person verifying the Alberta and federal
figures through `/hos-verification` is what turns any of this into a number.

## Gate

One authoritative run on a freshly rebuilt MariaDB 10.11: **346 files, 5062 passed, 3 skipped (the
pre-existing agent-runtime skips), 0 failed**; typecheck, test-file type ratchet (0), bare
`protectedProcedure` (0), production build, portal and inbound gates, and the current-state check all
PASS. Lint: not run, no lint script is configured.

One guard moved, deliberately: `server/engineReachability.test.ts` now declares `eld/hosEngine`,
`eld/hosProjection` and `eld/reasonCodes` as built-and-unwired with the reason, the unwired count goes
63 → 66, and the two modules reached only through the engine join the mutual-unwired list. All three
leave those lists when the next ELD checkpoint mounts `eld.hosStatus`.
