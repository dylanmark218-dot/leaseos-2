# CI-0.2 — the calendar tripwire, October–December, and a sweep that moves both clocks

Follows CI-0.1 (`CI_0_1_CALENDAR_TRIPWIRE.md`, merged as #24). No production code changed and no
migration was added.

## Why now

On current `main` (`ce27fec`), `server/calendarFixtures.test.ts` **fails the gate from 2026-10-02**
(tomorrow, as of writing). `cash.test.ts` is already reviewed, but its 2026-12-01 enters the 60-day
window on 2026-10-02, while its nearest date (2026-10-10) is eight days out. The next failure after
that would have been `commercialPortal.test.ts` (2026-10-30) on 2026-10-09.

PR #93 ("Fix CI calendar fixture guard failure", Copilot) duplicates CI-0.1's capitalAssets entry.
It targets `claude/relaxed-carson-qfcopf`, not `main`, and conflicts with it. This checkpoint
supersedes it, and #93 was not touched.

## Method: a run, not a reading

**`scripts/clock-sweep.sh <files…>`** runs test files under several system clocks and requires
them to pass under every one. Both clocks move together:

- **JavaScript.** `scripts/clock-sweep/fakeclock.setup.ts` fakes `Date` from module load onward.
  The faked clock *advances* in 1 ms steps rather than freezing. A frozen clock, or one that
  ticks in vitest's default 20 ms steps, makes two writes share a timestamp they never share in
  production, and the sweep then reports that instead of the date (see Finding 3).
- **Database.** Every connection's `NOW()` is pinned to the same offset through MariaDB
  `init_connect`. That only runs for non-SUPER accounts, so the sweep connects as a dedicated
  account with rights on the test database alone. A JavaScript-only sweep would miss a fixture
  that writes `NOW()` and a router that compares it with a fixed date.
- **`FRESH=1`** rebuilds the database before each clock. compliancePassport is not idempotent
  against a reused database, so without it a failure at the second clock may be the reuse.

**The harness catches what it should.** A planted JavaScript-clock dependency and a planted
database-clock dependency (each "now < 2026-11-10") pass at 2026-09-24, 10-31 and 11-03, and
fail at 2026-11-11, 2027-06-01 and 2030-09-24.

## Result

**Twelve files were swept**: the five unreviewed files in today's window, plus everything the
tripwire would fail on before December. The second group also covers new dates arriving in three
files that were already reviewed.

| File | Dates recorded | Verdict |
|---|---|---|
| commercialPortal | 2026-10-30, 2026-12-31, 2027-01-01 | independent: explicit `at` + 45-day terms |
| crewForecast | 2026-11-01, 2026-12-01, 2027-12-01 | independent: expiries vs. the explicit window FROM |
| openShiftsApi | 2026-11-01, 11-09, 11-10, 11-11, 2027-01-01 | independent: judged at the shift's explicit STARTS |
| qualificationReads.db | 2026-11-10, 2027-01-01, 2028-01-01 | independent: explicit AT; test 21 is clock-relative |
| timeOffApi | 2026-11-02, 2026-11-04 | independent: explicit FROM/TO both ways |
| cash (+12-01) | 2026-12-01 | independent: explicit `asOf` |
| calibrationEvidence (+12-01) | 2026-12-01 | independent: validUntil vs. fixed AT |
| fieldDevice | 2026-12-01 | independent: retention vs. explicit NOW |
| portalHardening | 2026-12-01 | independent: token expiry vs. explicit NOW |
| commercialSetup | 2026-12-15, 2027-01-01, 01-15, 02-01 | independent: rate effectivity at explicit `at` |
| **workforce** | +2026-12-01, 2029-08-31, 2029-09-14 | **was dependent — fixed in the test** (Finding 1) |
| **compliancePassport** | 2026-12-01, 2027-06-04 | **was dependent — fixed in the test** (Finding 2) |

Every future date in each file is recorded, not only those in today's window, so no entry goes
stale as the window advances.

**Final evidence** (`FRESH=1`, after the fixes):

- The eleven files other than compliancePassport: **151/151** at every one of eight clocks:
  2026-09-24, 10-31, 11-11, 11-21, 12-02, 2027-01-16, 2027-06-01 and 2030-09-24.
- compliancePassport and workforce together: **37/37** at 2026-09-24, 12-02, 2027-06-05,
  2028-03-25, 2028-04-22 and 2030-09-24.

**Projection.** I ran the tripwire itself under future clocks. With these entries it stays green
through **2026-12-09**. On 2026-12-10 the year-end group starts:
`commercialLifecycle`, `commercialProjects` (+12-31), `tenantScopeProjectFinance.db` and
`termsComplete`, followed by about nine files at 2027-01-01. That is a later checkpoint.

## Findings

1. **workforce.test.ts would have broken on 2026-10-10, and the tripwire could not see it.** The
   hire `START` is today + 7 days, so probation ends at today + 97 days. The extension was fixed
   at 2027-01-15. From 2026-10-10 that is no longer later than the probation end, and the router
   correctly refuses it ("An extension ends after the current probation end"). The tripwire
   reasons about a fixed date approaching *now*. It cannot see a clock-relative date overtaking a
   fixed one, and 2027-01-15 was not even in the window.
   **Fix (test only):** `EXTENDED_TO = START + 120 days`.
2. **compliancePassport.test.ts would have broken on 2028-03-22, nine days before the tripwire
   could warn.** A licence expiring 2028-04-21 is judged against now with a 30-day warning
   window, so the passport reads REVIEW instead of READY from 2028-03-22. The tripwire only fails
   21 days ahead. A medical report with the same expiry flips eligibility from "unknown" to "no"
   on the 21st. **Fix (test only):** both expiries are now + 2 years.
3. **Production, NOT fixed here (owner decision):** `fieldRoute.evidence.upload` stores bytes at
   `${userId}/evidence/${Date.now()}-${fileName}` (`server/routers.ts:558`). If the same user
   uploads two files with the same name in the same millisecond, the second overwrites the
   first's bytes under the same key. The first evidence record's stored content then no longer
   matches what it was. The sweep exposed this: fieldDevice's lifecycle test (uploads named
   `e.bin` in quick succession) fails under a 20 ms clock and passes under a 1 ms one. That is
   rare in production with a real millisecond clock, but an offline device draining a queue is
   exactly the case that makes it likely. A fix would add a random or sequence component to the
   key. It is an evidence-integrity defect and belongs in its own checkpoint.
4. **Housekeeping.** An earlier capitalAssets review comment (from `c2d0005`) had drifted above
   the `auditPackage` entry in a merge. It was moved, unchanged, next to the capitalAssets entry.

## Proposal (not implemented)

Finding 1 shows the tripwire's model has a blind spot, and Finding 2 shows its 21-day lead can be
shorter than a product warning window. A **scheduled** job could run `scripts/clock-sweep.sh` over
every DB-backed suite at, for example, now + 30, + 90 and + 365 days. It would find these breaks
by behaviour weeks ahead, independent of which dates a file happens to spell out. CI-0.1 proposed
the scheduling half of this; the harness now exists. Running it on every PR would cost a full
suite run per clock, so a nightly schedule is the likely shape.

## Changed

- `server/calendarFixtures.test.ts`: 9 new `REVIEWED` entries, 3 extended (cash,
  calibrationEvidence, workforce), and one moved comment.
- `server/workforce.test.ts`: `EXTENDED_TO` is clock-relative.
- `server/compliancePassport.test.ts`: `CREDENTIAL_EXPIRES` is clock-relative.
- `scripts/clock-sweep.sh`, `scripts/clock-sweep/{fakeclock.setup.ts,vitest.config.ts}`: the
  harness. It is not wired into the gate.

## Gate

`scripts/ci-gate.sh`, pinned Node 22.23.3, fresh database:

- **Gates 0–4 pass.** Test-file typecheck: 0 errors.
- **Gate 5:** 6915 passed, 3 skipped, **1 failed**. The failure is **pre-existing on `main`
  `ce27fec`, not introduced here.** It is
  `documentValidityCanonical.test.ts › census › open work consumes the adapter's verdict and decides
  no qualification itself`: `_core/openShifts.ts imports the validity engine ./documentValidity`.
  It fails identically on an unmodified checkout of `origin/main`.
- **Cause.** Two merged lines disagree. `c2dc622` (SPINE item 2, "one open-shift eligibility
  rule, enforced by the router (owner ruling)", via #102/#59) added the import, and C1b-3's census
  forbids it. Which side gives way is an owner decision, so it is untouched here.
- Because gate 5 fails, gates 6–8 did not run. `scripts/current-state.sh` reports the document
  current. Nothing here touches the build (tests and scripts only).
