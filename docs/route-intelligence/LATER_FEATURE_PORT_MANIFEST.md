# Later LeaseOS features — port manifest (RI-0.5)

Base for every port: `leaseos-2` `origin/main` (`6b01a0e` on 2026-09-23; re-read at port time).
Sources: the v23.25–v23.29 line `origin/claude/mobile-hardware-scanner-mzp1e1-v2327` (`e162752`), and
`leaseos` `main` (`9bb2651`, attached locally as remote `sibling`). Every commit named below can be
read with `git show <sha>` in this clone; nothing below is to be recreated from memory.

**Why porting rather than cherry-picking.** A dry run in a throwaway worktree applied each v2327
commit against `origin/main` with `git apply --3way`: **15 of 16 conflict**, almost entirely in the
five files both lines changed (`recordsAuthorization.ts`, `routers.ts`, `readinessComposer.ts`,
`engineReachability.test.ts`, `calendarFixtures.test.ts`) plus the generated
`LEASEOS_CURRENT_STATE.md` and the pinned-count suites (`procedureAuthorization`,
`crossLayerIntegrity`, `operationalApiAuthorization`). The feature files themselves
(`movementPermits.ts`, `movementPermitRouter.ts`, `scanSession.ts`, …) apply cleanly. So each port is:
copy the feature files verbatim from the source commit, hand-merge the five shared files, re-pin
the counts, renumber the migration, run the gate.

Classification key (Step 3): **1** already equivalent on main · **2** clean extension · **3** conflicts
with main · **4** superseded by a main implementation · **5** must be manually ported · **6** discard.

---

## A. Route Intelligence features on later lines

| Later capability | Source | Source files | Main equivalent | Class | Action |
|---|---|---|---|---|---|
| **A1. OSM ice-road / seasonal crossing + Saskatchewan census** | v2327 `dcc72fd` (+`82b2f18` hunk in `osmImport.ts`) | `server/_core/osmImport.ts` (`isSeasonalCrossing`, `ice_road`, SK header), `server/_core/osmImport.test.ts` | main has v23.24's `osmImport.ts`; **ice roads import as `gravel`** | **5** | port both files verbatim; no schema, no API, no migration; tests: the 2 new `osmImport.test.ts` cases; collision: none (main did not touch the file) |
| **A2. `osmLoadPlan` folded into `osmLoad`** | v2327 `ea19db9` (delete), `f0fa33f` (fold) | `server/_core/osmLoad.ts` (+`OSM_EXTRACT_FORMAT_VERSION`, `ExtractHeader`, header/hash agreement), `osmLoad.test.ts`, **delete** `osmLoadPlan.ts` + `.test.ts`, `tools/osm-extract.py` (+12), `engineReachability.test.ts` (−`osmLoadPlan`), spec doc 1 line | main has both files with two `planLoad`s (T0 overlap #11) | **5** | port `osmLoad.ts`/test and `osm-extract.py`; delete `osmLoadPlan.*` **only after** `osmLoad.test.ts` carries every `osmLoadPlan.test.ts` case (semantic-equivalence proof, per the hard rule); re-pin `engineReachability` (55 → 54 declared) |
| **A3. Movement permits** | v2327 `82b2f18`, `6cbd1b4`, `f50b704` | `drizzle/0168_movement_permits.sql` → **renumber**; `drizzle/schema.ts` (+`movementPermits`, `movementPermitDeterminations`, both `orgRef`); `server/_core/movementPermits.ts` (`PermitRow`, `DeterminationRow`, `PermitStatus`, `permitCoversMoment`, `resolvePermitStatus`, `permitStatusForJob`); `server/movementPermitRouter.ts`; `server/_core/recordsAuthorization.ts` (+`permit.read`, `permit.record`, `permit.determine`, `permit.verify` — verify sensitive); `server/routers.ts` (mount `movementPermit`); `server/readinessComposer.ts` (replace the `permitRequired: false` literal, now at `:544-545`); `server/_core/dispatchReadiness.ts` (`permitRequired: boolean \| null`, `permit_requirement_unknown` blocker, manager-overridable, verdict `unknown`) | **none** — main's composer asserts no permit for every job (GAP §1.5) | **5** | port; procedures `movementPermit.statusFor/record/determine/verify/listForJob`; tests `server/_core/movementPermits.test.ts` (110 lines), `movementPermitAuthority.test.ts` (59), `+4` cases in `dispatchReadiness.test.ts`, pin updates in `procedureAuthorization.test.ts`; dependencies: none beyond `jobs`/`trips`/`units`; collisions: `recordsAuthorization.ts` and `routers.ts` (both-side files), permission count pins, `PROCEDURE_AUTHORIZATION_INVENTORY.md`; migration: **one, new number**, header names origin `0168_movement_permits.sql @ 6cbd1b4` |
| A4. Route/graph/restrictions/structures/approvals/fingerprints/jurisdiction/source precedence/511/comms/HOS/LoadSense/facility/GPS | — | — | identical on all lines since `6b4b232` (v23.24) | **1** | nothing to port; T0's analysis of these stands |

## B. Other later work on the v2327 line

| Later capability | Source | Source files | Main equivalent | Class | Action |
|---|---|---|---|---|---|
| **B1. Tenant-first webhook dispatch** | v2327 `3c4f997` | `server/webhookDispatchService.ts` (scope moves into the query; a NULL-`orgRef` subscription is inert; failed delivery auditable), `server/webhookTenantIsolation.db.test.ts` (200 lines) | main still loads every active subscription and decrypts before the `ev.tenantId !== s.orgRef` check (`webhookDispatchService.ts:29-40`); the security PR `a333909` did not touch this file | **5** (security) | port both files verbatim; no schema/API/migration; collision: none |
| **B2. `LEASEOS_RELEASE` ≡ generated Release row** | v2327 `ec9b427` | `server/documentationTruth.test.ts` (+1 case) | main's `documentationTruth.test.ts` diverged (main-only edits) — merge the one `it()` in; `scripts/current-state.sh` on main already reads the file (T0 verified) | **2** | port the test case; **do not** port the release bump (label policy is the owner's) |
| **B3. Orchestration fixture isolation** | v2327 `e162752` | `server/workflowOrchestration.test.ts` | main has the older fixtures; `git apply --check` is **clean** | **2** | apply as-is |
| **B4. Printing / print audit** | v2327 `af213ee` | `drizzle/0169_print_audit.sql` → **renumber**; schema (+`fieldPrinters`, `fieldPrinterAssignments`, `commercialDocumentDeliveries.printerId`); `server/printingRouter.ts` (`printing.registerPrinter/assignPrinter/listPrinters/assess/record/staleCopies`); `shared/printability.ts`; permissions `print.read`, `print.record`, `printer.manage`, `printing.assess`, `printing.record`; tests `printability.test.ts`, `printingAuthority.test.ts` | none | **5**, **outside Route Intelligence** | port as its own PR if the owner wants printing; not a prerequisite of any RI checkpoint; collisions: `recordsAuthorization`, `routers`, pinned counts |
| **B5. Page scanner (v2327 shape)** | v2327 `8ef5233`, `fd59e6b`, `353b40d` | `server/scanningRouter.ts` (`paperwork.guidance/reviewScan/retention`), `server/_core/scanReview.ts`, `scanAutoLink.ts`, `paperworkRetention.ts`, `scanningAuthority.test.ts`, `documentScanner.test.ts` (1,218 lines), `scanningApi.db.test.ts`; `shared/captureQuality.ts`, `shared/paperworkGuidance.ts`; `client/src/runtime/{scanSession.ts, contracts.ts, outbox.ts, syncEngine.ts, adapters/capacitor.ts, adapters/memory.ts}` (+3 `NotOnDeviceError` bindings) | **a second, different scanner** on `claude/mobile-hardware-scanner-mzp1e1` (`05abfe3`, unmerged; blob-identical to `leaseos`'s branch): `server/paperworkRouter.ts`, `_core/documentGuidance.ts`, `_core/scanReview.ts`/`scanAutoLink.ts` (different blobs), `client/src/runtime/captureQuality.ts` | **3** | **owner decision**: pick one. Do not port either until chosen; RI-11 depends on `client/src/runtime/contracts.ts`, which both variants extend differently (HS1 `capabilities()` must be designed over the chosen one) |

## C. Later work on `leaseos` main that `leaseos-2` never received

| Later capability | Source | Source files | Main equivalent | Class | Action |
|---|---|---|---|---|---|
| **C1. Trip-stop row provenance** | `leaseos` `9e1a75f` "#4: a trip stop names who recorded it" | `drizzle/0169_trip_stop_provenance.sql` → **renumber**; `drizzle/schema.ts` (`tripStops` +`recordedByUserId`, `recordedSource` enum = `proposalFields.source`, `updatedByUserId`, `updatedSource`, `updatedAt`); `server/routers.ts` (`tripStops.create/update` write the actor); `server/_core/assistantCommitService.ts` (commit path leaves row source NULL by design); `server/tripStopProvenance.test.ts` (83 lines); HS0/HS_CONTRACTS doc edits | none on main (`tripStops` has no provenance column); roadmap item 4 names exactly this | **5** | port; migration **one, new number** (never `0169`: main's `0169` is `_defect_resolution`); collision: `routers.ts` (both-side file), the SPINE boundary resolver (PR #10) reads `tripStops` and should land on top of this, not beside it |
| **C2. Production config boot refusal** | `leaseos` `850ad84` | `server/_core/productionConfig.ts` (128 lines: refuses, never repairs, never echoes a secret, conditional requirements), `productionConfig.test.ts` (98), `server/_core/index.ts` (+19), register/current-state edits | main's own `env.ts` (`MIN_COOKIE_SECRET_LENGTH`, byte-measured secret) + `index.ts` guard from the security PR; `env.test.ts`, `vaultFailClosed.test.ts` | **3** | compare the two rule sets and keep **one** module: main's is already merged and tested; port only the rules `productionConfig` checks that `env.ts` does not (conditional Forge/portal requirements, placeholder detection). Do not carry two validators |
| **C3. SPINE wiring plan** | `leaseos` `df51d65` | `docs/register/SPINE_WIRING_PLAN.md` (143 lines) | quoted by `SECRETARY_SPINE_MORATORIUM.md` and `SPINE_ITEM1_BOUNDARY_CONFIRMATION.md` but **absent** | **2** | copy the document verbatim into `docs/register/` (docs-only) |
| C4. Login/portal chooser, secretary layer, spine boundary resolver | `leaseos` branches | — | re-implemented on `leaseos-2` branches with the same content (spine resolver differs by 12+/3−) | **1 / 4** | nothing; treat `leaseos-2`'s branches as canonical |
| C5. `leaseos` audit logs, `docs/knowledge/recovery-2026-09-14/*` | `leaseos` main, v2327 line | provenance material | dropped at the squash import | **6** | leave in `leaseos`; not source |

## D. Migration renumbering rule for every ported migration

1. Copy the SQL body verbatim; change only the filename prefix and add one header line
   `-- ported from <origin filename> @ <sha> (<repo>); renumbered at merge, see docs/route-intelligence/MIGRATION_RECONCILIATION.md §5`.
2. Take the number at merge time (`max(prefix on main)+1`), after confirming with
   `pnpm tsx scripts/migrate.ts status` on each real environment that no ledger row carries the
   origin filename (MIGRATION_RECONCILIATION §3). If one does, rename the ledger row in the same
   operator change; never re-run.
3. `drizzle/schema.ts` and `scripts/verify-parity.sh` must agree after the port (table count +2 for
   permits, +2 for printing, +0 for trip-stop provenance).
4. Regenerate `LEASEOS_CURRENT_STATE.md` in the same commit.

## E. Suggested port order (one commit each, one PR)

1. B3 (clean), B2 (one test), C3 (doc) — zero-risk warm-up, proves the branch and gate.
2. A1 OSM ice-road fix; A2 osmLoad fold with the equivalence proof.
3. B1 tenant-first webhooks (security).
4. C1 trip-stop provenance (renumbered) — roadmap item 4, prerequisite for PR #10's resolver.
5. A3 movement permits (renumbered) — prerequisite for RI-4a's remaining work and the T1/T6 tests.
6. C2 production-config rule comparison (owner-reviewed).
7. B4 printing and B5 scanner only on owner decision.

Nothing above is executed in RI-0.5.
