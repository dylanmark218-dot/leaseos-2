# ELD Checkpoint 2b — `eld.hosStatus`: hours of service from the ledger, read-only

**Branch:** `claude/eld-compliance-intelligence-ramlrd`. **Base:** `853c82e` (main merged to `b35bac4`, ledger at `0220`).
**Scope:** one read-only procedure that runs checkpoint 2a's `evaluateHos` over the ledger. No schema, no
migration, no write path, no dispatch, readiness, job-board or UI change. `hos.ts` and the rule registry
are untouched. Dispatch still answers `hos_unknown`.

## What a caller gets

`eld.hosStatus({ operatorId?, carrierAuthority?, jurisdiction?, crossedBoundary?, registeredWeightKg?,
operationClass?, latitude?, at?, lookbackDays = 16 })` returns `evaluateHos`'s whole result — clocks,
the determination after the mechanics discipline, violations, unknowns with their reason codes, remaining
(only where everything behind it is verified), the projection with its corrections — plus `window`:
`{ from, to, rowsRead, chainGaps }`.

## Who may read whom

| Caller | Reads |
|---|---|
| Holder of `hos.read` (the gate), no `operatorId` | their own operator, resolved from the session (`operators.userId`), never from input |
| Holder of `hos.read` naming someone else | refused unless they also hold `eld.read` (dispatcher, safety, office, management, auditor) |
| Anyone, operator outside their organization | `NOT_FOUND`, as everywhere in LeaseOS |
| A user with two operator records and no `operatorId` | refused: which one is meant is established, not guessed |

The input is `.strict()`: it takes no organization and no device.

## What it reads

`loadHosLedgerWindow` in the ledger store, scoped by `orgRef` on every query:

1. every row for the operator in `[at − lookbackDays, at]`;
2. the last duty-status row before the window, so a status already running when the window opens is
   counted from the window's start (the engine counts only the overlap) rather than dropped;
3. every row that names any loaded row in `supersedesEventRef`, followed forward (bounded at 16 hops) so
   a correction that was itself retracted later is seen as retracted.

It also turns each device's sequence gaps into time spans — from the event before the gap to the event
after it, the narrowest span the record vouches for — and passes them to the engine, which raises
`HOS_DATA_GAP` when one overlaps the duty window.

## Tests (database, through the real signed push)

Seven cases in `server/eldLedger.db.test.ts`: own clocks counted from pushed events and the answer
UNKNOWN with its reasons (and a read writes no row); a correction pushed by the device applied as a
retraction with the device's replacement status, the original unchanged on the ledger; a status running
before the window counted from the window's start (23 hours of a 20-day off-duty period in a trailing
24 hours, hand-computed); a sequence gap reported as a time span and `HOS_DATA_GAP`; the office reading
another operator in its organization, a colleague without `eld.read` refused, another organization's
office seeing not found; a caller with no operator record refused; an organization in the input refused.

## Guards moved, deliberately

- `legacyGrantHardening`: the `eld.read` check passes the organization the gate decided in (`ctx.organization`), so a role granted by another employer never counts toward reading this organization's hours. The guard caught the first draft without it.

- Procedures: +1 `eld.hosStatus` → operational map 725 → 726 (two files), router paths 795 → 796.
- `engineReachability`: `eld/hosEngine`, `eld/hosProjection` and `eld/reasonCodes` are now reached
  from a router, so their 2a declarations are removed and the unwired count returns 76 → 73.
- `hosRouter.loadProfiles` is now exported and reused, so the rule profiles are read one way.
- Inventory row for `eldRouter.ts`: 2 → 3 procedures.

## Still not here

Regime mechanics modules (a verified duty day and cycle), the home-terminal timezone column, required
rest and earliest legal driving time, exemptions, feasibility for a proposed job, and any consumer of
this answer in dispatch, readiness or the job board.

## Gate

One authoritative run under the `.nvmrc`-pinned Node 22.23.3 on a freshly rebuilt MariaDB 10.11:
**445 files, 6880 passed, 3 skipped (pre-existing), 0 failed**; fixture isolation (67 passed), production
boot, and every other step PASS. Lint: not run, no lint script is configured.
