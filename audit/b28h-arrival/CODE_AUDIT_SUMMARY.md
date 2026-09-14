# LeaseOS Code / Archive Audit Summary

## Archive reconciliation

The four archive wrappers contain 218 top-level entries. Exact SHA-256 comparison identified **82 redundant copies**: 21 in Chat1, 30 in Chat2, 31 in Chat3, and 0 in Chat4. Deduplication was limited to byte-identical files. No normalized filename group contained two different byte contents, so the numbered duplicates were safe to classify as redundant.

The source snapshots themselves do **not** show the same accidental duplication pattern. The only exact same-content paths inside the complete source trees are expected `.gitkeep` placeholders. B28H additionally carries one duplicate copy of its branch-arrival document.

## Source snapshots reviewed

- v20: **229 files**, 2,551,842 bytes.
- v22.16: **558 files**, 6,358,592 bytes.
- newest complete CAL05a source: **730 files**, 8,195,330 bytes; generated state reports **v22.20**, 309 tables, 102 migration files, 483 role-authorized procedures, and 161 test files / 2,653 source `it(...)` occurrences.
- B28H widget-engine package: **139 files**, 1,756,019 bytes.

File-level delta v20 → v22.16: **338 added, 20 modified, 9 deleted**.
File-level delta v22.16 → newest complete source: **172 added, 33 modified, 0 deleted**.

## Validation performed in this reconciliation

- Git object/database integrity: **PASS** (`git fsck --full --no-dangling`).
- Re-generated `LEASEOS_CURRENT_STATE.md` from source using explicit release `v22.20`: **byte-for-byte PASS**.
- TypeScript/TSX parser scan on reconciled main: **497 files, 0 syntax-error files**.
- TypeScript/TSX parser scan on B28H: **66 files, 0 syntax-error files**.
- Main JSON: **14 parsed, 0 errors**; shell scripts: **4 `bash -n` checks, 0 errors**; JavaScript: **1 `node --check`, 0 errors**.
- B28H JSON: **8 parsed, 0 errors**; JavaScript/MJS: **12 `node --check`, 0 errors**.
- Common secret/credential-pattern scan: **no hits** and no `.env*` files found.
- Source TODO/FIXME/HACK/XXX scan on executable/code file types: **0 hits**.

## Full test-suite limitation

The full repository Vitest/build/DB gate was **not independently rerun here** because this environment cannot reach the package registry and the supplied source does not include `node_modules`. The existing repository contains a CI workflow that installs with pnpm and runs migrations, parity, TypeScript, Vitest, and the production build. B28H's supplied gate report records 604 Vitest tests plus 48 Chromium cases, but that report is preserved as supplied evidence rather than represented as a new independent run.

## B28H merge blockers discovered against the newest complete source

1. **Migration collision.** B28H ships `0089_widget_dashboards.sql` and `0090_widget_layout_revision.sql`. Reconciled main already uses those slots and reaches migration **0106**. Do not reuse old gaps; after confirming the target branch has not moved, the safe pair should be renumbered together beginning after the current migration head (currently 0107/0108).
2. **Procedure reconciliation is incomplete.** Running B28H's branch inventory against the complete source produced: **7 CONFIRMED, 1 RENAMED, 3 CONFLICT, 1 MISSING**. The unresolved areas are `records.documentExpiry` (missing), `jobs.active`, `trips.active`, and `sync.status` (conflicts), while `shop.unitReadiness` was heuristically matched to `shop.unitCost` and needs semantic review before accepting the rename.
3. **B28H is intentionally not production-integrated.** Its own checkpoint labels production widgets as zero and says branch-only repository/build/migration gates were unavailable. The Git reconstruction therefore stages it on `candidate/b28h-widget-engine` instead of forcing it into `main`.

## Git history policy

The repository contains exact complete-source snapshot commits for v20, v22.16, and the newest CAL05a/v22.20 tree. Individual `upgrade/*` branches are containment/reference branches pointing to the first supplied complete snapshot that contains each checkpoint. This avoids fabricating exact historical commits that were not present in the uploaded archives.
