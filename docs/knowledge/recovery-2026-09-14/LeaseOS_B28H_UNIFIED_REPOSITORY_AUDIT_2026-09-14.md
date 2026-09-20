# LeaseOS unified repository audit — B28h arrival reconciliation — 2026-09-14

## Scope

This audit merges the newly supplied reconciled LeaseOS repository, Git bundle, clean-main source archive and reconciliation reports into the previous CAL05a unified master. The merge preserves both real Git histories and does not promote the staged B28h widget package into production code before its own documented blockers are reconciled.

The uploaded deliverable SHA-256 values were independently recomputed and match the supplied checksum manifest exactly. All three ZIPs pass `unzip -t`, and `git bundle verify` confirms the supplied bundle records a complete SHA-1 Git history with 99 branch heads, 4 tags and HEAD (104 refs including HEAD).

## Merge result

- Previous unified CAL05a `main`: `50a17103ea439fbb12a4f2bb9cbdef0f9b5f2118`
- Exact supplied reconciled `main`: `f4acba4d5774d8d18a631c38e7183943aace2624`
- Exact supplied B28h widget candidate: `bc91356912eb0e24d655c451fe7c96b35da8aa9b`
- New canonical merged `main`: `c27b8acfb4e2da230cee6349c9fae6bb7098ffc3`
- Combined repository-fix candidate: `integration/b28h-recommended-fixes` at `b230947fddb152abb5badacab5e6213f10053d11`
- Final branch count after creation of this audit branch: **324**
- Final tag count after the audit tag is added: **24**

Every supplied incoming head is retained under `incoming-b28/*`. The exact reconciled incoming main is also anchored at `source/reconciled-b28-main`. B23 through B28h have canonical `upgrade/*` aliases, and the exact staged widget line is retained at `candidate/b28h-widget-engine`.

The history merge uses the known-good CAL05a tree as the application source of truth. It joins the incoming Git history as a parent without allowing reconciliation metadata or staged wrapper files to overwrite production code.

## What is actually newer

The incoming reconciled `main` does **not** contain newer root application implementation than the previous unified CAL05a main. Across `client/`, `server/`, `drizzle/`, `shared/`, `scripts/`, package metadata and TypeScript/Vite configuration, there are **0 application-path differences**. The only `.github` implementation-adjacent difference is that the previous unified repo already contains a pull-request template.

The genuinely new material is the staged B23→B28h widget-engine package. Relative to the supplied CAL05a snapshot, `candidate/b28h-widget-engine` adds 186 paths, but it changes **0 root application paths** in `client/`, `server/`, `drizzle/`, `shared/`, `scripts/` or package/toolchain configuration. The widget engine lives under `incoming/b28h-widget-engine/` plus reconciliation evidence. Therefore it is preserved as a candidate rather than falsely described as production-integrated.

## Canonical CAL05a source measurements

Regenerating the repository's own current-state report with explicit release `v22.20` still yields:

- **309** `mysqlTable(...)` declarations
- **102** SQL migration files, current highest numeric slot **0106**
- **483** role-authorized procedures
- **36** external portal procedures
- **2** machine/integration procedures
- **0** bare `protectedProcedure`
- **328** permissions
- **112** sensitive/fail-closed permissions on `main`
- **8** universal self-scoped permissions
- **161** server test files / **2,653** source `it(...)` cases
- **4** native runtime bindings that still throw `NotOnDeviceError`

The explicit generated current-state file is byte-consistent with the CAL05a source when `v22.20` is supplied. Default release autodetection remains defective and emits `LEASEOS.B22.19.OFFLINE.PACKAGE.md` instead of the claimed release version.

## Independently rerun static integrity checks

On the merged canonical `main`:

- `git fsck --full --no-reflogs --no-dangling`: **PASS**
- tracked files: **769**
- non-empty exact duplicate groups: **0**
- non-empty duplicate implementation groups: **0**
- case-folding path collisions: **0**
- unresolved Git conflict-marker files in code/config: **0**
- common private-key / GitHub-token / AWS-key / OpenAI-key pattern hits: **0**
- schema `mysqlTable(...)` declarations versus SQL `CREATE TABLE`: **309 / 309**

The staged B28h candidate contains four exact duplicate evidence/report groups, all caused by wrapper/archive preservation. They are not duplicate root production implementations.

## B28h audit findings

### 1. HIGH — B28h is not production-integrated

The B28h release-candidate document explicitly says B28 remains open and production widgets are zero. Its branchless gate is evidence for the isolated widget package, not proof that the real LeaseOS application has integrated those widgets.

### 2. HIGH — migration numbers collide with CAL05a

The widget package contains `sql/0089_widget_dashboards.sql` and `sql/0090_widget_layout_revision.sql`. Canonical LeaseOS already uses 0089 and 0090 for outbox leases and leave requests and continues through 0106. The widget migrations must be renumbered together at/after the next free slots (currently 0107/0108) after refreshing the target branch.

### 3. HIGH — widget procedure/source contracts are unresolved

The supplied real-branch inventory records **7 CONFIRMED, 3 CONFLICT, 1 MISSING, 1 RENAMED**. The important unresolved items are:

- `records.documentExpiry` — missing
- `jobs.active` — conflict; domain exists but no authoritative `active` procedure
- `trips.active` — conflict
- `sync.status` — conflict and consistent with device-local status
- `shop.unitReadiness` — fuzzy tooling suggested `shop.unitCost`, but the supplied analysis correctly rejects that as a semantic false positive

These need deliberate source-contract decisions before a production registry is wired.

### 4. MEDIUM — recovered real-branch baseline was already red

The supplied branch delta recorded 14 failing `server/fieldroute.test.ts` cases before widget integration, all from `TRPCError: User holds no domain role`. This is a pre-existing role-fixture/grant problem and must be repaired before using later failures as widget regressions.

### 5. MEDIUM — dependency resolution is not clean on the recovered branch

The branch delta records `npm install` failing with `ERESOLVE`: `@builder.io/vite-plugin-jsx-loc@0.1.1` declares Vite 4/5 compatibility while the recovered branch uses Vite 7.3.6. `--legacy-peer-deps` was used only to continue inspection; it should not become the production dependency policy.

### 6. MEDIUM — B28h gate evidence is useful but incomplete

The supplied B28h report records 604 Vitest cases plus 48 Chromium cases passing. It also explicitly marks repository suite, production build, CI, real-app smoke and migration upgrade as **UNAVAILABLE**. Those gates must be run against the reconciled real branch.

### 7. LOW — B23→B28h branches are traceability refs, not exact intermediate histories

All supplied B23 through B28h upgrade refs point at the same frozen candidate commit. This repository preserves them because they are useful checkpoints, but does not claim they reconstruct separate historical source states.

## CAL05a findings that remain open

Because the root application source did not change, the previous CAL05a material findings remain valid. In particular:

1. **HIGH** — seven truth-changing permissions are still absent from `SENSITIVE_PERMISSIONS`: `invoicing.void`, `invoicing.dispute.resolve`, `geo.import`, `geo.locationVerifyFromGrid`, `geo.access.decide`, `spatial.structure.verify`, `spatial.route.approve`.
2. **MEDIUM** — `package.json` pins pnpm 10.4.1 while CI installs pnpm 9.
3. **MEDIUM** — default release autodetection is wrong and v22.20 has no supplied authoritative B22.20 checkpoint document.
4. **HIGH** — the workflow drain worker is not started by the production server lifecycle.
5. **HIGH** — native shell / encrypted SQLite / hardware keystore / native vault / camera / GPS / biometric signing / local notifications remain incomplete.
6. **HIGH** — HOS engine architecture exists but authoritative rule figures and several jurisdictional/short-haul/RODS paths remain unverified or incomplete.
7. **HIGH** — organization/membership isolation is meaningful but not yet a proven system-wide tenant property.
8. **HIGH** — province-wide routing and several communications/spectrum/coverage data sources remain source/licence limited.

The accompanying gap matrix carries forward all 47 CAL05a findings and adds 7 B28h-specific findings, for **54 total tracked audit rows**.

## Prepared fix stack

The prior three repository corrections were rebuilt on the new merged history:

- `fix/b28h-fail-closed-permission-drift`
- `fix/b28h-ci-pnpm-alignment`
- `fix/b28h-release-source-of-truth`
- combined: `integration/b28h-recommended-fixes`

On the combined fix branch, the sensitive set becomes **119** and all seven known missing fail-closed permissions are present. These remain separate from canonical `main` pending a real CI/database/build gate.

## Recommended merge order

1. Run full CI/database/build against `integration/b28h-recommended-fixes`; merge those three repository fixes if green.
2. Repair the recovered B28 real-branch role fixtures and dependency compatibility so the untouched baseline is green.
3. Reconcile widget migrations to the actual next free slots; never reuse 0089/0090.
4. Resolve the five ambiguous/missing widget source contracts with explicit semantics.
5. Port **one** widget end-to-end into the real root application, including authorization, persistence, migration, client runtime and tests.
6. Run repository tests, production build, migration upgrade path, real-app browser smoke and CI.
7. Only then merge the wider B23→B28h widget catalogue incrementally.

## Full-gate limitation for this audit

The canonical source still has no installed dependencies in the supplied archives and this environment cannot install from the package registry. Therefore the full pnpm/Vitest/MySQL/build/browser/native-device gate was not independently rerun here. The B28h harness results are preserved as supplied evidence, while this audit independently reran Git integrity, archive checksums, ZIP integrity, bundle verification, source/tree comparisons, duplicate/collision scans, schema parity counts, current-state generation and common secret/conflict scans.
