# LeaseOS unified repository audit — Chat1–Chat5 merge — 2026-09-14

## Scope

This checkpoint merges the supplied Chat1–Chat5 reconciled Git repository/bundle into the prior B28H unified LeaseOS master and reruns the repository, branch, duplicate, schema/migration, static-security and feature-gap audit. The merge is source-conservative: complete application snapshots remain authoritative, while partial Academy and widget packages remain candidates until their missing database/runtime pieces are reconciled.

The supplied Chat1–Chat5 SHA-256 manifest was independently rechecked: the all-branches bundle, GitHub-ready ZIP, clean-main ZIP and reconciliation-report ZIP all match their supplied hashes. All three ZIP files pass `unzip -t`, and the Git bundle verifies as a complete SHA-1 history.

## Merge result

- Previous B28H unified `main`: `c27b8acfb4e2da230cee6349c9fae6bb7098ffc3`
- Supplied Chat1–Chat5 reconciled `main`: `74d99de54387894f42daa54c802e4a536eab9313`
- New canonical merged `main`: `74d99de54387894f42daa54c802e4a536eab9313`
- Previous main preserved at `archive/pre-chat1-5-main`
- Supplied reconciled main preserved at `source/chat1-5-reconciled-main`
- Driver Academy candidate: `candidate/chat5-academy` at `e24502141af5044b17619b1bd08fa8d8fc5470d6`
- Corrected Academy packaging branch: `fix/chat5-module-paths-and-vitest` at `54965eecf805ca10d7ae2e78231216bff48c1d0d`
- Academy integration plan: `integration/chat5-academy-port-plan` at `cd9b2bdad279efc6a90798acf3d955bc1be774a3`
- Restricted assessor material: `restricted/chat5-assessor-key` at `cc33ee3ad29a36fee8b0276b8f09919ebc9539a5`
- Updated canonical root-fix stack: `integration/chat1-5-recommended-fixes` at `762eaa57a0c5c694944e0426c804386b901afe9b`
- Final unified repository after the audit branch: **337 local branch heads / 26 tags**

### Branch/ref deduplication

The incoming bundle contains 125 branch heads and 24 tags. Against the previous B28H unified repository:

- **115** branch heads already existed at exactly the same commit.
- **9** branch names are genuinely new.
- **1** existing branch name (`main`) advances by one reconciliation/audit commit.
- **24/24** incoming tags already existed with identical targets.

Therefore this checkpoint imports only the nine genuinely new canonical branches plus the incoming-main source anchor rather than creating another redundant namespace containing 115 duplicate branch heads.

The nine new incoming branches are:

- `archive/chat5-raw-safe`
- `candidate/chat5-academy`
- `fix/b28h-package-script-duplicate-key`
- `fix/chat5-module-paths-and-vitest`
- `integration/chat5-academy-port-plan`
- `restricted/chat5-assessor-key`
- `upgrade/0087-driver-academy`
- `upgrade/0088-academy-hardening`
- `upgrade/0089-academy-readiness`

## What changed on canonical main

Relative to the previous B28H `main`, the new `main` adds only seven reconciliation/audit artifacts:

- `GITHUB_IMPORT_CHAT1_5.md`
- `audit/chat1-chat5/CHAT5_CODE_REVIEW.md`
- `audit/chat1-chat5/EXACT_DUPLICATE_REPORT.md`
- `audit/chat1-chat5/FILENAME_REVISION_FAMILIES.md`
- `audit/chat1-chat5/RECONCILIATION_SUMMARY.md`
- `audit/chat1-chat5/RECURSIVE_MANIFEST.csv`
- `audit/chat1-chat5/SOURCE_SNAPSHOT_DIFF.json`

There are **zero root application-path changes** in `client/`, `server/`, `drizzle/`, `shared/`, `scripts/`, package metadata or CI between the previous B28H application tree and the new main. Chat5 is therefore preserved as a candidate line rather than misrepresented as production-integrated Academy code.

## Canonical application measurements

Explicit regeneration with `scripts/current-state.sh v22.20` reports:

- **309** `mysqlTable(...)` declarations
- **102** SQL migration files; highest numeric slot **0106**
- **483** role-authorized procedures
- **36** externally gated portal procedures
- **2** integration/machine procedures
- **0** bare `protectedProcedure`
- **328** permissions
- **112** sensitive/fail-closed permissions on `main`
- **8** universal self-scoped permissions
- **161** server test files / **2,653** literal `it(` occurrences
- **4** native-only runtime bindings that still throw `NotOnDeviceError`

A whitespace-tolerant audit finds one additional syntactically equivalent `it (` occurrence in `server/dispatchGate.test.ts`; the prior 2,653 figure is therefore a formatting-specific source count, not evidence of a changed test suite.

Schema parity remains **309 `mysqlTable` declarations / 309 `CREATE TABLE` statements**.

## Independently rerun static integrity checks

On canonical merged `main`:

- Git object integrity (`git fsck --full --no-dangling`): **PASS**
- tracked files: **776**
- non-empty exact duplicate groups: **0**
- duplicate implementation groups: **0**
- case-folding path collisions: **0**
- unresolved Git conflict-marker files in code/config: **0**
- common private-key / GitHub-token / AWS-key / OpenAI-key pattern hits: **0**
- root `package.json` top-level duplicate keys: **0**

The confidential Academy assessor answer key is not present on `main`; it is isolated on `restricted/chat5-assessor-key`.

## Driver Academy / Chat5 audit

### Positive findings

Chat5 adds substantive design and candidate implementation for:

- Driver Academy requirements and qualification state
- crew-readiness specifications
- field assessment tickets
- sheet serial generation/validation
- collision-safe sheet serial allocation design
- Academy-to-dispatch readiness blockers
- migration-gate/runbook material

`sheetSerial.ts` independently passes strict TypeScript checking. `academyReadinessBridge.ts` also passes strict TypeScript checking when checked beside canonical `dispatchReadiness.ts`, confirming its `DispatchBlocker` contract is structurally compatible.

The corrected `fix/chat5-module-paths-and-vitest` branch normalizes the numbered-copy allocator filenames and replaces the missing `./stub-vitest` import with the repository's real `vitest` import.

### HIGH — Academy is not production-integrated

All Academy implementation remains under `incoming/chat5-academy/`. No canonical root `server/`, `client/`, `drizzle/` or `shared/` implementation is changed by the Academy candidate. The candidate is evidence/source for a future port, not production behavior.

### HIGH — required Academy SQL is missing

The supplied review/runbook references `0087_training_academy_hardening.sql` and `0088_academy_retention_trigger.sql`, but those SQL files are absent. The historical database change therefore cannot be reconstructed exactly from this upload and must not be fabricated from prose.

### HIGH — Academy migration numbering collides

Canonical LeaseOS already uses 0087–0090 and continues through 0106. Chat5's historical 0087/0088/0089 numbering cannot be reused. Any real Academy port must allocate from the actual next-free slots after B28H/other pending migrations are resolved.

### HIGH — migration runner depends on an absent trigger

The Chat5 `apply-migrations.sh` candidate explicitly verifies `academyCertificates_retention_guard`. Because the trigger migration is absent, merging that runner change without the trigger would make an otherwise healthy database fail its gate.

### HIGH — readiness bridge still needs production DB wiring

`academyReadinessBridge.ts` is intentionally pure/DB-free. The supplied integration plan correctly requires real reads/wiring in `server/readinessComposer.ts`; until then, Academy qualifications do not enforce production dispatch readiness.

### HIGH — confidential assessor answer key

`LEASEOS_ASSESSOR_KEY_CONFIDENTIAL.html` is explicitly marked not for distribution. It is kept only on `restricted/chat5-assessor-key`. Any public GitHub export must omit that ref. A private repository remains the recommended default.

### MEDIUM — B28H candidate contains a duplicate package-script key

The staged B28H widget toolchain `package.json` contains two `scripts.b28:gate` keys. Standard JSON parsing silently discards the earlier value. `fix/b28h-package-script-duplicate-key` corrects this by retaining one as `b28:gate` and the other as `b28:gate:legacy`. This defect exists in the staged B28H candidate, not canonical root `package.json`.

## Existing B28H/CAL05a findings still applicable

Because Chat5 changes no production application path, the previous B28H gap matrix remains applicable. Major open items still include:

1. B28H widgets are staged, not root-integrated.
2. B28H migration numbers collide with canonical migrations and need fresh slots.
3. B28H widget source/procedure contracts still contain missing/conflicting semantics.
4. Recovered B28 baseline role fixtures have pre-existing failures.
5. B28 dependency compatibility and complete production gates remain unresolved.
6. Native Capacitor/encrypted offline-device runtime remains incomplete.
7. HOS rule figures and jurisdictional coverage require authoritative verification.
8. Organization isolation is meaningful but not yet a proven system-wide property.
9. Province-wide routing and several communications/spectrum/coverage imports remain source/licence limited.
10. Production workflow-drain lifecycle wiring remains incomplete.

The updated gap matrix carries forward the previous **54** rows and adds **9** Chat1–5/B28H findings for **63 tracked rows**.

## Prepared root-fix candidate

`integration/chat1-5-recommended-fixes` rebases the existing root hardening fixes onto the new merged main without integrating Academy or B28H feature candidates. It changes only:

- CI pnpm setup to **10.4.1**
- explicit `LEASEOS_RELEASE` / release-source handling
- fail-closed permission coverage and its regression test

Regenerating current state on that branch reports **119 sensitive permissions** and release **v22.20**.

The B28H duplicate-script fix remains separate because it applies to the staged widget package, not root production `package.json`.

## Full-gate limitation

The supplied source archives do not include installed dependencies, `pnpm` is not installed in this environment, and external package installation is unavailable. Therefore the full pnpm/Vitest/MySQL/build/browser/native-device gate was not independently rerun.

This audit independently reran archive hashes/ZIP integrity, Git bundle/history checks, branch-tip reconciliation, Git fsck, source-tree diffs, schema/migration parity, current-state generation, duplicate/case/conflict/secret scans, JSON duplicate-key checks, and focused strict TypeScript checks for the pure Academy modules. Supplied runtime/test claims remain historical evidence rather than being relabeled as independently executed.

## Recommended merge order

1. Review/merge `integration/chat1-5-recommended-fixes` into canonical root once CI can run.
2. Keep `restricted/chat5-assessor-key` private and never merge it to `main`.
3. Review `fix/b28h-package-script-duplicate-key` on the staged widget candidate.
4. Recover the missing Academy SQL/trigger source before any Academy DB merge.
5. Allocate fresh Academy and B28H migration slots against the same current target head.
6. Port the corrected Academy modules from `fix/chat5-module-paths-and-vitest` into real root paths.
7. Wire Academy DB reads/readiness composition and add authorization + cross-tenant negative tests.
8. Integrate one B28H widget end-to-end rather than merging the wrapper wholesale.
9. Run clean/upgrade migrations, full repository tests, production build, CI, browser/mobile smoke and native-device gates before promoting either candidate.
