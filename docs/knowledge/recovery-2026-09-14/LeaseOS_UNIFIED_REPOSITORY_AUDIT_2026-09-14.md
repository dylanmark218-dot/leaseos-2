# LeaseOS unified repository audit — 2026-09-14

## Executive result

The two prepared LeaseOS repositories have been combined into one Git repository **without overwriting the newer v22.16 tree or fabricating historical source states**.

- Canonical release baseline: `main` at `888482953dd8aaaa0e9e745dbba3cb7f047e813b`.
- Unified audit/history branch: `integration/unified-repository-audit`.
- The unified audit merge has two parents: current v22.16 `main` and the older prepared v20 `main`; the merge uses Git's `ours` strategy so it links histories while leaving the v22.16 tree unchanged.
- Older repository refs are preserved under `legacy/v20/*` rather than colliding with current branch names.
- Exact/reconstructable source anchors remain `baseline/v20.2` and `source/v22.16-original`.
- Upgrade/checkpoint branches remain traceability branches. They are not re-labelled as exact historical source snapshots.
- Total local branches after unification: **107**; `upgrade/*`: **74**; imported `legacy/v20/*`: **25**; tags: **4**.

## Why this merge model is safe

The old prepared repository and the newer repository have unrelated Git histories. Comparing old `legacy/v20/main` with the newer `baseline/v20.2` shows that the old line adds mostly audit/branch/research documents plus executable-bit differences on two helper scripts; it does not contain a second newer implementation that should replace v22.16. Therefore the unified repository keeps v22.16 as the only canonical code line and preserves the older repo as namespaced history.

This also respects the project's historical boundary: where only checkpoint prose exists, no source snapshot is invented.

## Current implementation inventory verified statically

The generated `LEASEOS_CURRENT_STATE.md` was regenerated with explicit release `v22.16` and matched the committed file byte-for-byte. Independent static counting also matched its principal counts:

| Measure | Verified value |
|---|---:|
| `mysqlTable(` declarations | 264 |
| SQL migration files | 72 |
| `CREATE TABLE` statements | 264 |
| Role-authorized procedure call sites | 395 |
| Bare `protectedProcedure` | 0 |
| Permissions | 281 |
| Sensitive fail-closed list | 95 (see active defect below) |
| Server test files / `it(` cases | 89 / 1,527 |

The current tree includes substantial implementations for records/evidence, RBAC, payroll/finance/tax foundations, compliance registry and requirement engine, dispatch, IFTA, GST/HST, period close, AR/bank reconciliation, portals, site closeout, customer live view/transaction, fleet shop, capital assets, commercial projects, integration gateway, telematics, workforce, audit packages, spatial foundation, commercial terms/rates, money precision, setup, Alberta mapping imports, legal land, routing graph, invoicing, credits/voids/disputes, field-runtime protocol logic and more. See `LEASEOS_CURRENT_STATE.md` for the generated authoritative inventory.

## Repository integrity checks

Static audit of the unified tree found:

- Git object integrity passes `git fsck --full`.
- No unresolved Git conflict markers.
- No case-insensitive path collisions.
- No non-empty exact duplicate implementation-file groups in the current tree.
- No obvious RSA/OpenSSH private-key blocks, GitHub token forms, AWS `AKIA` keys, or simple `sk-`/`sk-proj` key literals in the static pattern scan.
- Schema/migration table-count parity is 264 / 264.
- The only large tracked historical artifact identified earlier is the intentional `archive/history/v20.2-to-v22.16.diff` (~4.65 MB).

These are static checks, not a substitute for dependency, database, browser, device or integration tests.

## Three fixes already isolated and ready for pull-request review

### 1. HIGH — fail-closed permission drift

`SENSITIVE_PERMISSIONS` currently has 95 entries even though seven actions introduced by later checkpoints are documented as sensitive and already exist in the permission model: `invoicing.void`, `invoicing.dispute.resolve`, `geo.import`, `geo.locationVerifyFromGrid`, `geo.access.decide`, `spatial.structure.verify`, `spatial.route.approve`.

Prepared branch: `fix/fail-closed-permission-drift`.

### 2. MEDIUM — CI pnpm mismatch

`package.json` pins pnpm 10.4.1 while `.github/workflows/ci.yml` installs pnpm 9. The older repository had already identified this and its fix still applies to v22.16.

Prepared/current branch: `fix/ci-pnpm-alignment`.

### 3. MEDIUM — current-state release autodetection

`scripts/current-state.sh v22.16` regenerates the committed current-state report exactly, but no-argument release autodetection produces an incorrect release label.

Prepared branch: `fix/current-state-release-autodetect`.

### Consolidated review candidate

`integration/recommended-fixes` stacks all three fixes on top of the unified audit line **without changing `main`**. It also regenerates `LEASEOS_CURRENT_STATE.md`, which reads **102 unique sensitive permissions** and **89 / 1,528** server test files/cases after the added authorization regression test. This candidate has passed static consistency checks only; the full dependency/database/test gate still must run before merge.

## High-priority gaps that remain after the repository merge

### Production workflow worker startup

The workflow engine, webhook delivery/retry logic and `startDrainWorker()` exist, but the production server entrypoint does not start a drain worker and no dedicated worker script is exposed by `package.json`. The current code therefore contains the worker logic without demonstrating an unattended supervised production worker lifecycle. Add startup, shutdown, health/readiness and deployment supervision before relying on it as background infrastructure.

### Native field runtime

The project explicitly does not yet implement the native Capacitor shell, encrypted SQLite, hardware keystore, native file vault, camera, GPS, biometric signing or local notifications. The TypeScript field-runtime protocol is useful and testable, but this is not yet the completed on-device offline product.

### HOS / ELD decision engine

`dutyRecords` are persisted; authenticated procedures exist; integration feeds can create ELD duty records. However, the verified Canada/U.S. HOS rule layer, home-terminal/radius logic, short-haul eligibility, daily return/release checks, full RODS escalation and jurisdiction/load-aware clocks are not complete. The current code deliberately refuses to invent an HOS legal conclusion when no authoritative rule is loaded.

### Tenant/company isolation proof

Authorization has advanced far beyond the older v20 audit: there are 395 role-authorized procedures and zero bare protected procedures. However, for a multi-company SaaS deployment, an explicit tenant/company ownership invariant and cross-tenant negative test suite should still be demonstrated independently of role/branch authorization.

### Routing coverage and source licensing

The project can build/use a graph from imported Alberta road fabric where loaded, but does not yet have complete province-wide routing coverage or deployed PostGIS/Valhalla/Martin/MapLibre services. P0/P5 source recovery remains unresolved, and AER ST37/ST102/Alberta 511 remain gated by permission/licensing decisions.

## TODO audit — what is actually still open

`todo.md` contains 23 unchecked boxes, but they are not all equivalent to missing code.

**Stale / substantially implemented:**

- Pre-trip critical-defect dispatch blocking + mechanic release is implemented and tested; mark that TODO complete.
- Operator credential expiry has core implementation: expiry fields, requirement warning windows, exception surfaces and an `operator.credential_expiring` workflow. Narrow the TODO to verifying coverage of every required document/jurisdiction rather than building an engine from zero.
- Workflow rules already carry key+version semantics; the remaining pilot item is process/governance traceability, not absence of versioned rules.

**Partially present but still incomplete:**

- HOS typed duty-record persistence/procedures exist, but exemption determinations and escalation events/rules remain incomplete.
- Trip passports and hashed audit-package manifests exist, but automatic after-round-trip bundle generation/export is not complete.
- Pricing, rate cards, trip distance and invoice construction exist, but automatic authoritative billing-line creation from verified trip measurements is not established as a full production path.

**Still materially missing:**

- Disposal-facility normalized metadata/provenance/structured restrictions/route handoff.
- Verified short-haul/HOS calculation and RODS escalation.
- Site-specific duration baselines/anomaly alerts.
- Digital unit safety-binder completeness score/task queue.
- Browser/mobile E2E tests.
- Native device layer and GPS routing integration.

The detailed row-by-row disposition is in `audit/UNIFIED_GAP_MATRIX_2026-09-14.csv`.

## Other material release/deployment gaps

- Production migration execution needs a migration ledger/tool; `scripts/apply-migrations.sh` replays every SQL file and is appropriate for disposable CI rather than repeat production rollout.
- `package.json` declares MIT but no `LICENSE` file exists. Resolve proprietary/open-source intent before public release.
- Local HTTP browser auth should verify `SameSite=None`/`Secure` cookie behavior.
- Voice transcription URL fetching is not production-wired; if exposed later, constrain URL/storage ingestion to avoid SSRF.
- Email/SMS customer alert delivery, full clip storage in the evidence vault, verified posted-speed source, final-pay computation, fluids inventory and downloadable archive bundles remain incomplete as described in the gap matrix.

## Human/source blockers

The following cannot honestly be solved just by writing code:

1. **P9 regulatory/tax/rate verification** — rules must remain UNKNOWN until a responsible human verifies authoritative sources.
2. **AER ST37/ST102/Alberta 511 permissions** — obtain/record written rights before ingestion beyond permitted inspection/use.
3. **P0/P5 missing original spatial source** — recover the actual source/ZIP or replace it deliberately; do not reconstruct it from prose.
4. **Six-month operational pilot** — driver interviews, office feedback and compliance/process reviews are field validation work.

## Recommended merge order from here

1. Protect `main` and keep it at the clean v22.16 baseline until checks run.
2. Review `integration/recommended-fixes` as the combined three-fix candidate, or merge the three `fix/*` branches individually. If the permission fix is merged individually, regenerate `LEASEOS_CURRENT_STATE.md` so the generated sensitive-permission count moves from 95 to 102.
3. Require dependency install, typecheck, Vitest, disposable-database migration/parity, and current-state generation before updating `main`.
4. Add a real production worker startup branch and exercise webhook retry/dead-letter behavior.
5. Build/verify tenant isolation before multi-company production use.
6. Treat native runtime, HOS, province-wide routing and regulator-data licensing as release-track workstreams, not small cleanup tasks.
7. Reconcile `todo.md` so implemented items are checked and partial items describe only their remaining scope.

## Test-gate limitation of this audit

The full dependency/typecheck/Vitest/database/browser/device gate was **not** re-executed here. The supplied ZIP does not include `node_modules`; pnpm is not installed locally; Corepack attempted to obtain pnpm 10.4.1 but network/DNS access to the package registry is unavailable in this environment. Therefore the **89 test files / 1,527 cases** count is independently enumerated from source, while any claim that those tests pass remains project history until CI runs in an environment with dependencies and a disposable database.

## Deliverables in this branch

- `audit/UNIFIED_REPOSITORY_AUDIT_2026-09-14.md` — this report.
- `audit/UNIFIED_GAP_MATRIX_2026-09-14.csv` — actionable missing/partial/fix-ready matrix.
- `audit/UNIFIED_BRANCH_MAP_2026-09-14.csv` — all refs, origin, historical meaning and recommended use.

The Git bundle and ZIP produced from this repository should be treated as the record copy. A Git bundle preserves branch/tag refs; a normal source ZIP does not preserve Git history.
