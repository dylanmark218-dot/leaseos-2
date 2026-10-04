# RI-P0 — zero-risk lineage ports, reconciled onto current main

## Where it came from

RI-P0 was written on `origin/main` `6f52b57` (v23.25, 169 migrations, 410 tables) as branch
`claude/ri-p0-zero-risk-ports`, head `7563ca4`, and was never merged. It took the smallest slice of
the lineage-port manifest (`docs/route-intelligence/LATER_FEATURE_PORT_MANIFEST.md` on the T0
branch): items that applied verbatim and changed no schema or API.

| Commit | Item | Source on the v23.29 line |
|---|---|---|
| `77fb203` | B3: orchestration fixtures parked out of the shared drain worker's reach | `e162752` |
| `32fdd54` | B2: `LEASEOS_RELEASE` must equal the generated document's Release row | `ec9b427` |
| `08e3591` | A1: ice roads and winter roads import as seasonal crossings, not gravel | `dcc72fd` (+ `82b2f18`) |
| `7563ca4` | the checkpoint record; also noted C3 (SPINE wiring plan) as already on main | — |

**Why its CI failed.** The one GitHub run on `7563ca4` (run `35948409333`, job `107471441246`) had
exactly one failing file out of 334: `server/calendarFixtures.test.ts`, the calendar tripwire,
flagging `capitalAssets.test.ts` (dates 2026-10-15, 2026-10-20 and 2026-10-31). It failed
identically on the untouched base, and CI-0.1 (#24) fixed it on main. It was a pre-existing failure
that has since been corrected, not an RI-P0 regression.

## Reconciliation onto `6ecf2d4` (2026-10-03), rebased onto `1f24b16`

| Historical item | Current-main state | Action |
|---|---|---|
| B3: fixture isolation (`workflowOrchestration.test.ts`) | **missing**: fixture events still sit where the real worker's `claimBatch` takes them | **ported**: RED reproduced, then replayed and GREEN |
| B2: release-marker truth (`documentationTruth.test.ts`) | **already covered, by a stronger check**: CI-STATE-1's `currentStateMetrics` case A regenerates the whole document from `LEASEOS_RELEASE` and requires it to equal the committed copy, and gate 8 diffs the whole document. With the marker set to v23.32 against a document saying v23.31, both fail. | **not ported** (would duplicate). The only thing lost is B2's sentence naming both values in the failure message. |
| A1: seasonal crossings (`server/_core/osmImport.ts` + test) | **still needed**: main's importer is unchanged since the v23.25 import, so `ice_road=yes` still imports by surface as an ordinary track and no `seasonal_road_ban` advisory is raised | **not ported here**: it is production code in the OSM loader, which this checkpoint's scope excludes. It needs its own decision (alone, or with RI-P2). |
| C3: SPINE wiring plan (`docs/register/SPINE_WIRING_PLAN.md`) | **present**: restored byte-for-byte by `fc35f6f` and pinned by `server/spineWiringPlan.test.ts` | **untouched** |
| `LEASEOS_CURRENT_STATE.md` edits in `32fdd54` and `08e3591` | stale numeric test-count rows; CI-STATE-1 removed that row | **dropped** |

### B3, step by step

**The leak.** `createWorkerPorts(...).claimBatch` is the real outbox worker, and some suites start
it for real. It takes the oldest unprocessed, unclaimed, retry-due rows from `domainEventOutbox`
with no `eventId` filter. The orchestration suite inserts a fixture event and then races its own
two (or four) workers for it. If a sibling suite's worker claims the fixture first, every racer
finds nothing, and the failure reads `expected [] to have a length of 1`. That looks like a broken
`SKIP LOCKED` claim when it is not one. Persisted outbox rows are the only state that leaks; the
suite's units already use `NO_SUCH_UNIT`.

**RED (`e2eef00`).** A new case runs the worker's own claim query, unchanged, with one added clause
that restricts it to this test's event. Nothing else in the shared database is touched, and the
case refuses to run unscoped if the claim query changes shape. On main, the worker claimed the
fixture:
`expected [ 'EVT-REACH-…' ] to deeply equal []`.

**Fix (`0c14ffa`, replayed from `77fb203`).** Fixture events carry `retryAvailableAt = 2037-01-01`
(TIMESTAMP ends in 2038), which `claimBatch` skips. The suite's own `drainOnce` does not filter on
the retry window, so the race it tests is unchanged. The race assertions also check which worker
the database records as holding the row. The commit applied cleanly over main's newer
`NO_SUCH_UNIT` change.

**GREEN.** The suite passes 11/11, repeated three times. No production code changed.

## Repository impact

0 migrations, 0 tables, 0 columns, 0 permissions, 0 procedures, no production code. Changed: one
test file (`server/workflowOrchestration.test.ts`) and this record.
