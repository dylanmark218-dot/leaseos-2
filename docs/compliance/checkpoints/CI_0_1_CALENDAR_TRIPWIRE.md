# CI-0.1 — deterministic calendar tripwire for `capitalAssets.test.ts`

**Base:** `origin/main` `6f52b57` (v23.25; 169 migrations; 410 tables). **Branch:**
`claude/ci-0.1-capital-assets-calendar-tripwire`. **Production code:** unchanged. **Schema:** unchanged.

## Cause

The failing test was never `capitalAssets.test.ts`; it passes. The failure is
`server/calendarFixtures.test.ts`, a deliberate governance tripwire (P4.7, `109e044`, 2026-09-17). It
scans every test file for dates within 60 days of the **real** clock, keeps only files that also read
the real clock (`new Date()`, `Date.now()` other than key minting), and fails once the nearest
unreviewed date is 21 days out. On 2026-09-24 the nearest date in `capitalAssets.test.ts`,
2026-10-15, crossed that line. Nobody had reviewed the file because its dates had never been within
the window before.

The tripwire exists because two tests really did break when the clock passed a fixture date
(`promotionLedger.db.test`, `workforce.test`). It asks for exactly one of two things: make the fixture
clock-relative, or record it in `REVIEWED` with the reason the clock never meets it.

## What the fixture protects, and whether the clock meets it

The dates come from the original capital-assets checkpoint (v22.16): a company with a
**31 October** fiscal year end, a truck acquired **2026-03-01**, a CCA schedule taken
**2026-10-15**, and a disposal on **2026-10-20** (above cost, so a capital gain is named). The year is
semantically the point (class B): the schedule must land in the fiscal year ending 2026-10-31, and the
disposal must fall inside it. The dates matter to each other, not to the day CI runs.

Every path those dates take was traced:

| Path | Clock? |
|---|---|
| `asset.schedule` / `schedulePrepare` | explicit `asOf`; `fiscalYearFor(asOf, 10, 31)` |
| CCA rate lookup (`rateLookup`) | reads `new Date()`, but the seeds start 2026-01-01 with no end date, so the answer is "unverified" for every real date after 2026-01-01 |
| `asset.dispose` | compares `disposedAt` with `acquiredAt` only; `assertPeriodOpen` reads recorded closes, not the calendar |
| `asset.register` | `assertPeriodOpen(acquiredAt)`; the two `new Date()` acquisitions are refusal paths that never reach a date rule |
| `asset.twin` | passes the real clock as `asOf`, which is used only when the unit has recorded distance; this test records none |
| role grants | active unless revoked; no date comparison |

Classification: **clock-independent**. Not a fixture defect, so the fixture is not changed.

## Fix

1. **Proof first** (`server/capitalAssets.test.ts`, two "CI-0.1" tests). A pure test evaluates the
   fiscal year, schedule, rate status and twin through the same real-clock reads the router makes. A
   database-backed test runs the real procedures for the whole year (register, capitalize, class set
   and verify, schedule, prepare, refused review, twin, dispose, schedule again) under five system
   clocks: 2026-09-24, 2026-10-16 (after the schedule date), 2026-10-21 (after the disposal),
   2026-11-15 (after the fiscal year end) and 2030-09-24. Every business answer must be identical.
   Only `Date` is faked; timers stay real, so database I/O is unaffected.
2. **Teeth.** Planting `if (new Date() > 2026-10-31) throw` in `asset.dispose`, and making
   `fiscalYearFor` read the real year, turns both proofs red. Reverted; production code is unchanged.
3. **Review** (`server/calendarFixtures.test.ts`). A `REVIEWED` entry for `capitalAssets.test.ts`
   with the exact seven dates and the reason, pointing at the proof. The tripwire itself is untouched,
   and it fails again if any fixture date in the file changes (checked by moving 10-15 to 10-14).

## Wall-clock proof

| System clock | Pure proof | DB proof |
|---|---|---|
| 2026-09-24 | identical | identical |
| 2026-10-16 | identical | identical |
| 2026-10-21 | identical | identical |
| 2026-11-15 | identical | identical |
| 2030-09-24 | identical | identical |

Independently, `capitalAssets`, `commercialPortal`, `crewForecast`, `openShiftsApi` and `timeOffApi`
were run with the **entire test process's** clock faked to 2026-11-20 and 2027-01-15 (a throwaway
vitest config with a `Date`-faking setup file, verified effective, then deleted): all five pass at
both, as they do on the real clock.

## Similar findings (reported, not changed)

Of 333 test files, 108 read the real clock and 35 of those also hold a future date. 14 are already
reviewed; `capitalAssets` is now the 15th and the first to use a fake clock. The next four the
tripwire will fail on are unreviewed:

| File | Nearest date | Tripwire fails from | Faked-clock run (2026-11-20, 2027-01-15) | Class |
|---|---|---|---|---|
| `server/commercialPortal.test.ts` | 2026-10-30 (credit due date) | ~2026-10-09 | passes | likely clock-independent; needs review |
| `server/crewForecast.test.ts` | 2026-11-01 (TDG ticket expiry, forecast from 2026-12-01) | ~2026-10-11 | passes | likely clock-independent; needs review |
| `server/openShiftsApi.test.ts` | 2026-11-01 (licence expiry; shift 2026-11-10) | ~2026-10-11 | passes | likely clock-independent; needs review |
| `server/timeOffApi.test.ts` | 2026-11-02 (leave range) | ~2026-10-12 | passes | likely clock-independent; needs review |

Two more reach the window in October (`compliancePassport.test.ts`, `fieldDevice.test.ts`, both
2026-12-01), and 12 more in 2027 or later. Each is a one-line review with a reason, like this one;
none is done here.

## Proposal (not implemented): take the clock out of blocking PR CI

The tripwire is class C: it is **meant** to read the wall clock. That is right for its purpose and
wrong for a PR gate, because it turns every open PR red on a date nobody chose, for a file none of
them touched. Proposed, for owner approval:

1. **PR gate, deterministic.** Keep the check that a reviewed file's recorded dates still match its
   source (a changed date is back to unreviewed). That depends on content, not the calendar.
2. **Clock-based warning, scheduled.** Move the 60-day/21-day scan to a scheduled CI job (weekly,
   plus `workflow_dispatch`) that reports the files coming due and opens or updates one issue. It
   blocks nothing; it gives three weeks' notice.
3. **Optional backstop.** A PR fails on the clock only when a flagged date has actually **passed**
   and the file is still unreviewed, which is the moment a real break becomes possible.

## Repository impact

`server/capitalAssets.test.ts` (+2 tests), `server/calendarFixtures.test.ts` (+1 `REVIEWED` entry),
`LEASEOS_CURRENT_STATE.md` (test count), this record. Migrations 0, tables 0, columns 0, API 0,
production source 0.
