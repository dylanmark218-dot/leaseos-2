# RI-P0 — zero-risk lineage ports

**Base:** `origin/main` `6f52b57` (v23.25; 169 migrations, tip `0174_dispatch_override_provenance`;
PR #6, #9, #10, #11 and #13 merged since RI-0.6 started). **Branch:** `claude/ri-p0-zero-risk-ports`.
**Migrations:** none (169 before, 169 after). **Tables:** 410 before and after. **Scope:** the first,
smallest slice of the lineage-port manifest (`docs/route-intelligence/LATER_FEATURE_PORT_MANIFEST.md`
on the reconciliation branch): items that apply verbatim, change no schema or API, and carry their own
tests. Nothing about permits, printing, the scanner, webhooks, trip-stop provenance or configuration.

| Item | Source | What landed | Verification |
|---|---|---|---|
| B3 | v23.29 line `e162752` | `server/workflowOrchestration.test.ts`: orchestration fixtures parked out of the shared drain worker's reach | applied clean; 10/10 with the database |
| B2 | v23.29 line `ec9b427` | `server/documentationTruth.test.ts`: `LEASEOS_RELEASE` must equal the generated document's Release row (the release bump in the source commit is **not** ported) | 25/25 |
| A1 | v23.29 line `dcc72fd` (+ comment reflow `82b2f18`) | `server/_core/osmImport.ts`, `osmImport.test.ts`: `isSeasonalCrossing` over `winter_road`, `ice_road` and `seasonal=winter`; an ice road no longer imports as gravel and raises a `seasonal_road_ban` advisory; Saskatchewan census in the header. Main's copies were byte-identical to the v23.24 base, so the two files are the whole delta | 20/20; OSM loader, topology and source-neutrality suites 71/71; source typecheck clean |
| C3 | `leaseos` `df51d65` | **not ported — already on main**: PR #13 recovered `docs/register/SPINE_WIRING_PLAN.md`, byte-identical to the sibling's | — |

## Gate

Full `scripts/ci-gate.sh` against MariaDB 10.11 on the final tree: 334 files, **4,775 passed, 1 failed,
3 skipped**. The one failure is `server/calendarFixtures.test.ts` "every file with a near-future fixture
and a real clock read is reviewed, or has more than three weeks left" — the repository's own calendar
tripwire, which fails **identically on the untouched `6f52b57`** today (2026-09-24):

`"server/capitalAssets.test.ts: 2026-10-15, 2026-10-20, 2026-10-31 (21 day(s) until the first) — unreviewed"`

It is date-driven, names a file this checkpoint does not touch, and asks for a human review of that
fixture (make it clock-relative, or record it in the test's REVIEWED list with the reason). It is not
fixed here because it is not this checkpoint's, and because the tripwire exists precisely so that a
person reviews the fixture rather than a passing commit silencing it. It will turn every PR's CI red
from today until reviewed.

## Next

Manifest items A2 (fold `osmLoadPlan` into `osmLoad` with the equivalence proof), B1 (tenant-first
webhook dispatch), C1 (trip-stop provenance, renumbered) and A3 (movement permits, renumbered) remain,
each as its own checkpoint.
