# LeaseOS source lineage — reconciliation (RI-0.5)

Read on 2026-09-23 against every ref reachable from this environment. Two repositories were
inspected: `dylanmark218-dot/leaseos-2` (this one, public) and `dylanmark218-dot/leaseos` (private,
cloned read-only to `/home/user/leaseos` and attached as the local remote `sibling`). Nothing was
merged, reset, force-pushed, renamed or renumbered. Every number below was read from a tree, not a
branch name (`scripts/lineage-survey.sh` reproduces the table).

**Headline.** There are not two lineages but one, split three ways:

1. `leaseos` `main` (287 commits, root `937e257`, 2026-09-14 → 2026-09-21) is the **original
   chronological history**: v20 reconstruction → v22.x → v23.24 → B23.0 → HS0 → RB-01 → `#4` trip-stop
   provenance (`0169_trip_stop_provenance`) → SPINE plan → login/portal chooser.
2. `leaseos-2` `main` (26 commits, root `a65d4a3`, 2026-09-21 →) is a **squash re-import** of the
   `leaseos` tree at `fcc3b5d` (HS0, 2026-09-21): commit `6ae3856` "Import LeaseOS FieldRoute v23.25
   source tree" has **byte-identical `server/`, `drizzle/`, `client/`, `shared/` and `scripts/`** to
   `leaseos@fcc3b5d` (and `@e7178e8`). It then received its own audit, security and dispatch work and
   re-applied the login/portal commits (same content, different patch-ids).
3. The "orphan" `claude/mobile-hardware-scanner-mzp1e1-v2327` (219 commits, same root `937e257`) is
   the **v23.25 → v23.29 continuation** of the original history, branched at `6b4b232` (v23.24)
   **before** B23.0 was merged into `leaseos` main. It exists in both repositories; the `leaseos-2`
   copy is five commits ahead of the `leaseos` copy. It has no merge base with `leaseos-2` main only
   because `leaseos-2` main is a squash import; its merge base with `leaseos` main is `6b4b232`.

So "v23.25" names **two different trees**: the original line's `dcc72fd` (Saskatchewan validation +
ice-road fix, `LEASEOS_RELEASE` still reading v22.20 at the time) and the `leaseos`/`leaseos-2` main
line's B23.0 tree (labelled v23.25 by the importer). "v23.28" also names two: the v2327 line's page
scanner (`8ef5233`) and `claude/leaseos-auth-workspace-system-t008ad`'s B23.1 tree. Release labels are
therefore **not** lineage identifiers and must not be used to order trees.

---

## 1. Ref survey (read from each tree)

Merge base is against `leaseos-2` `origin/main` = `6b01a0e` (moved on 2026-09-23 when PR #4 and #5
merged; the T0 documents were written against `0060690`).

| Ref | HEAD | Release | Merge base w/ main | Ahead/Behind | Tables | Migs | Highest migration | Tests (files/it) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `origin/main` | `6b01a0e` | v23.25 | — | — | 408 | 166 | `0169_defect_resolution` | 303/4107 | PR #4 (readiness defect repair) and #5 (readiness panel) merged 2026-09-23 |
| `claude/leaseos-route-intelligence-t0-mj9uj7` (this) | `7e214ec` | v23.25 | `0060690` | 1/7 | 408 | 165 | `0168_retire_storage…` | 301/4057 | T0 documents only |
| `claude/mobile-hardware-scanner-mzp1e1-v2327` | `e162752` | **v23.29** | **none** (squash import) | n/a | 412 | 166 | `0169_print_audit` | 292/4053 | original history continued: permits, printing, scanner, tenant-first webhooks |
| `sibling/main` (`leaseos`) | `9bb2651` | v23.25 | none (squash import); content base `fcc3b5d` | n/a | 408 | 166 | `0169_trip_stop_provenance` | — | original history; 3 source commits `leaseos-2` never received |
| `sibling/claude/mobile-hardware-scanner-mzp1e1-v2327` | `8ef5233` | v22.20 (stale file) | `6b4b232` w/ sibling main | 14/87 | 412 | 166 | `0169_print_audit` | — | same line, 5 commits behind the `leaseos-2` copy |
| `feat/compliance-c1a-readiness-contract` | `7c07bef` | v23.25 | `38d2677` | 5/1 | 408 | 167 | `0172_dispatch_override_provenance` | 304/4123 | carries #4 |
| `feature/dispatch-assignment-ui` (PR #11) | `4bbe5ff` | v23.25 | `6b01a0e` | 26/0 | 410 | 168 | `0171_dispatch_role_assignment_events` | 313/4232 | carries #4, #5, #9 |
| `feature/dispatch-role-assignment-backend` (PR #9) | `84c69fc` | v23.25 | `6b01a0e` | 14/0 | 410 | 168 | `0171_…` | 312/4214 | |
| `feature/dispatcher-detail-assignment` (PR #6) | `02c0b74` | v23.25 | `6b01a0e` | 8/0 | 408 | 166 | `0169_defect_resolution` | 304/4120 | |
| `feature/dispatcher-readiness-panel` (PR #5) | `e6b65f2` | v23.25 | merged | 0/1 | 408 | 166 | `0169_defect_resolution` | | **merged** |
| `readiness-defect-repair` (PR #4) | `8ad53d6` | v23.25 | merged | 0/2 | 408 | 166 | `0169_defect_resolution` | | **merged** |
| `claude/driver-portfolio-credential-wallet-ya8928` | `0e1e9b2` | v23.25 | `3911f59` | 1/8 | 410 | 167 | `0170_driver_portfolio_events_append_only` | 303/4092 | its own `0169_driver_portfolio` |
| `claude/training-academy-workforce-q3mdse` | `6e76007` | v23.25 | `0060690` | 1/7 | 413 | 167 | `0173_wallet_history_guards` | 303/4097 | skips 0169–0171; adds `0172_training_wallet_renewal_handoff` |
| `claude/leaseos-auth-workspace-system-t008ad` | `e5b3eeb` | **v23.28** | `f21cd1b` | 3/11 | 408 | 166 | `0170_organization_scoped_role_grants` | 303/4130 | second "v23.28" |
| `claude/spine-boundary-confirmation` (PR #10) | `e304d81` | v23.25 | `0060690` | 5/7 | 408 | 165 | `0168_…` | 303/4096 | records the owner's **RELEASE BLOCKER — MIGRATION 0169** note |
| `claude/secretary-model-dialogue-yzszcv` (PR #7) | `929f721` | v23.25 | `f21cd1b` | 4/11 | 408 | 165 | `0168_…` | 308/4149 | |
| `claude/mobile-hardware-scanner-mzp1e1` | `05abfe3` | v23.25 | `f21cd1b` | 1/11 | 408 | 165 | `0168_…` | 297/4054 | **a second page-scanner implementation** (identical blobs to `sibling/claude/mobile-hardware-scanner-mzp1e1`) |
| `claude/finance-accounting-survey-2mp4h6` | `0c27271` | v23.25 | `0060690` | 3/7 | 408 | 165 | | 303/4075 | |
| `claude/leaseos-compliance-survey-5faxe8` | `12f2cc2` | v23.25 | `0060690` | 1/7 | 408 | 165 | | | docs only |
| `docs/dispatch-assignment-model-design`, `docs/leaseos-audit-and-build-plan-2026-09-21` | | v23.25 | `f21cd1b` | | 408 | 165 | | | docs only |
| `claude/login-portal-chooser` (PR #8), `followup/session-appid-verification` (PR #3), `copilot/full-audit-leaseos-2`, `claude/determined-ramanujan-y5ygsm` (PR #1/#2) | | | merged / behind | | | | | | |
| **Tags:** none in either repository. **Bundles:** `archive/source-bundles/` holds v20, v22.16 and CAL05a zips (pre-history provenance only). |

Sibling-only branches: `claude/new-session-32erhi`, `integration/b28-widgets-wip`, `copilot/lisa-s-inquiry`
(all = `df51d65`), `claude/login-portal-chooser`, `claude/spine-boundary-confirmation` (5 ahead of sibling
main; **content differs slightly** from the `leaseos-2` branch of the same name: 12+/3− in the resolver
and its tests), `claude/secretary-model-dialogue-yzszcv`, and stale `copilot/*` refs at v22.22/v22.40.

---

## 2. Ancestry, proven

```
leaseos (original history, root 937e257)
  … v23.20 … 5a4c71f v23.21 … 3cebaf9 v23.22 … 7024139 v23.23 … 5aaddcf/6b4b232 v23.24 ─┬─ ea19db9 f706963 dcc72fd(v23.25 SK+ice road)
                                                                                         │      82b2f18 … f50b704 (v23.26 permits, osmLoad fold)
                                                                                         │      af213ee (v23.27 printing) 8ef5233 (v23.28 scanner) ── [leaseos-2 only] fd59e6b 353b40d 3c4f997 ec9b427(v23.29) e162752
                                                                                         │      = claude/mobile-hardware-scanner-mzp1e1-v2327 in both repos
                                                                                         └─ b28a6a5 B23.0 … 3fae29e RB-01(0168) e7178e8 fcc3b5d(HS0) ── 850ad84 productionConfig ── 9e1a75f #4 (0169 trip stop) ── df51d65 SPINE plan ── login/portal ── 9bb2651 = leaseos main
                                                                                                                       │
                                                        leaseos-2 main:  a65d4a3 ── 6ae3856 "Import v23.25" (tree == fcc3b5d source) ── audits, security (a333909), PR #3 ── login/portal (re-applied) ── 0060690 ── PR #4 (0169 defect_resolution) ── PR #5 ── 6b01a0e
```

| Question | Answer | Evidence |
|---|---|---|
| Common ancestor of `leaseos-2` main and the v2327 line | **content ancestor `6b4b232` (v23.24)**; no git ancestor | source-only diff of every v2327 commit against `6ae3856` is smallest at `6b4b232` (24 files); `git merge-base` empty |
| Is `leaseos-2` main normal git ancestry? | From `6ae3856` on, yes. Before it, the history was **flattened into one import commit**; `a65d4a3` is an empty "Initial commit" | `git rev-list --max-parents=0` |
| Was source reconstructed independently? | No. `6ae3856`'s `server/ drizzle/ client/ shared/ scripts/` are byte-identical to `leaseos@fcc3b5d`; the import differs from it only in docs, audit logs, `.gitignore`, CI yaml, README, and `LEASEOS_RELEASE` | `git diff --shortstat fcc3b5d 6ae3856 -- server drizzle client shared scripts` = empty |
| Cherry-pick-equivalent commits despite different SHAs? | **None** between `leaseos-2` main and the v2327 line (0 of 216 / 0 of 15); **none** between `leaseos-2` main and `leaseos` main (`git cherry`); the login/portal, secretary and spine branches were **re-done** in `leaseos-2` with equal or near-equal content but no shared patch-ids | `git cherry` both directions |
| Identical trees with unrelated history? | Yes, at the import point (above). Also `leaseos-2 claude/mobile-hardware-scanner-mzp1e1` ≡ `leaseos claude/mobile-hardware-scanner-mzp1e1` (identical blobs) | blob compare |
| Is the "orphan" recovered source or genuine continuation? | **Genuine chronological continuation** of the original history (dated commits, per-checkpoint messages, gate logs). It is `leaseos-2` main that is the reconstruction | commit graph |
| Which files did both lines change after `6b4b232`? | Only 7: `LEASEOS_CURRENT_STATE.md`, `LEASEOS_RELEASE`, `recordsAuthorization.ts`, `routers.ts`, `readinessComposer.ts`, `calendarFixtures.test.ts`, `engineReachability.test.ts` | three-way blob compare |
| Migrations shared by all three lines | `0000`–`0167` (164 files) are **byte-identical** across `leaseos-2` main, `leaseos` main and the v2327 line, both `0157` files included | blob compare, 0 differing |

---

## 3. Release relationships

| Label | Tree(s) carrying it | Truth |
|---|---|---|
| v23.24 | `6b4b232` | last common content of all three lines |
| v23.25 | (a) `dcc72fd` on the v2327 line (SK validated, ice roads); (b) `leaseos` main from B23.0 on and `leaseos-2` main | two trees; (b) never received (a)'s `osmImport` fix |
| v23.26 | v2327 line: permits, osmLoad fold | not on either main |
| v23.27 | v2327 line: printing | not on either main |
| v23.28 | (a) v2327 line `8ef5233`: page scanner; (b) `claude/leaseos-auth-workspace-system-t008ad`: B23.1 | two trees; the v2327 line itself moved to v23.29 to avoid reusing (a) |
| v23.29 | `e162752` (leaseos-2 only): scanner fixes, tenant-first webhooks, release-truth test | |

`LEASEOS_RELEASE` on `leaseos` main and `leaseos-2` main reads v23.25 while the trees carry B23.0,
HS0, RB-01 and (on `leaseos-2`) PR #4/#5 — the v2327 line's `ec9b427` explains the drift and adds a
test that pins the marker to the generated document; that test is a port candidate.

---

## 4. Canonical baseline — options and recommendation

| Option | Risk | History preservation | Migration risk | Manual porting | Test impact | Reviewability | Rollback |
|---|---|---|---|---|---|---|---|
| **A — keep `leaseos-2` main, port later work** | low: main has CI, five merged PRs, six open PRs, the security fixes, `0169_defect_resolution` already applied in CI | original history stays reachable on the v2327 branch and in `leaseos`; main's pre-import history remains flattened (already true) | low: ported migrations take new numbers at merge; nothing applied anywhere is renamed | **moderate**: 6 features from the v2327 line (≈1,150 source lines + 4 tables), 3 commits from `leaseos` main; the 7 both-side files need hand merges | ported tests come with each feature; the 4 pinned-count tests (`engineReachability`, `procedureAuthorization`, `crossLayerIntegrity`, `documentationTruth`) are re-pinned per port | high: one PR per feature | revert one PR |
| B — promote the v2327 line (v23.29) | high: it lacks main's 17 audit/security commits, PR #3–#5, every open PR's base, `productionConfig`/`env` hardening, and carries `0168_movement_permits` / `0169_print_audit` colliding with main's `0168`/`0169` | best (real history) | **high**: two `0168`s and two `0169`s; any CI or environment that ran main's files would DRIFT | large: main's work must be re-ported the other way and six open PRs rebased | all main-side suites re-verified | low: one giant swap | poor |
| B′ — promote `leaseos` main | medium: has the original history and the 3 missing commits, but lacks `leaseos-2`'s 20+ post-import commits and all open PR work; its `0169_trip_stop_provenance` collides with main's `0169` | best | high (0169 collision, `main` on two repos) | large, both directions | | low | poor |
| **C — reconciliation branch from `leaseos-2` main, port checkpoint by checkpoint, merge by PR** | same as A | same as A | same as A | same as A | same as A | **highest**: each port is one reviewable commit on one branch | revert per commit |

**Recommendation: A, executed as C** — `leaseos-2` `main` is canonical; the ports land on a
dedicated branch (`integration/lineage-ports`, name to be confirmed) as one commit per feature from
`LATER_FEATURE_PORT_MANIFEST.md`, each with its tests, then a single reviewed PR. The v2327 branch and
the `leaseos` repository are **kept unchanged** as provenance (never deleted, never merged wholesale).
`leaseos` should stop accepting new work (its main is behind and carries a conflicting `0169`); that
is an owner decision recorded here, not executed.

Not executed. Nothing in this checkpoint changes a branch other than adding documents.

---

## 5. What main lost at the squash, and what nobody has

| Item | Where it exists | On `leaseos-2` main? |
|---|---|---|
| `osmImport` Saskatchewan census + `isSeasonalCrossing` (ice roads no longer import as gravel) | v2327 `dcc72fd` | **no** |
| `osmLoadPlan` folded into `osmLoad` (`OSM_EXTRACT_FORMAT_VERSION`, `ExtractHeader`) | v2327 `ea19db9`, `f0fa33f` | no (main still has both files; T0 listed the duplication) |
| Movement permits (tables, engine, router, permissions, readiness wiring, `permit_requirement_unknown`) | v2327 `82b2f18`, `6cbd1b4`, `f50b704` | no |
| Printing (`fieldPrinters`, `fieldPrinterAssignments`, `printingRouter`, `print.*`/`printer.*` permissions) | v2327 `af213ee` | no |
| Page scanner, v2327 shape (`scanningRouter`, `shared/captureQuality`, `paperworkRetention`, `scanSession`) | v2327 `8ef5233`, `fd59e6b`, `353b40d` | no — but a **different** scanner (`paperworkRouter`, `documentGuidance`) exists on `claude/mobile-hardware-scanner-mzp1e1` (unmerged) |
| Tenant-first webhook dispatch (filter by tenant before decrypting) | v2327 `3c4f997` (+ `webhookTenantIsolation.db.test.ts`) | no — main still decrypts every active subscription then filters (`webhookDispatchService.ts:40`) |
| `LEASEOS_RELEASE` ≡ generated Release row test | v2327 `ec9b427` | no |
| Orchestration fixture isolation | v2327 `e162752` | no (applies cleanly) |
| `productionConfig.ts` boot refusal (+ test) | `leaseos` `850ad84` | **different implementation** on main (`env.ts` `MIN_COOKIE_SECRET_LENGTH`, `index.ts` guard from the security PR) |
| `tripStops` provenance (`recordedByUserId`, `recordedSource`, `updatedBy…`) — `0169_trip_stop_provenance` | `leaseos` `9e1a75f` | no; roadmap item 4 names it; **collides with main's `0169`** |
| `docs/register/SPINE_WIRING_PLAN.md` | `leaseos` `df51d65` | no (quoted by two `leaseos-2` documents) |

Everything else the T0 gap analysis called "not built" is not built on any line.
