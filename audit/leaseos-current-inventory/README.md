# LeaseOS audit and build-plan artifacts — 2026-09-21

Read-only inventory of `main` @ `f21cd1bc2070ae179d431177fd0f286965e0f3c3` (v23.25), plus the
planning documents derived from it. No production code, migration or test was changed to produce any
of this.

## Contents

| File | What it is |
|---|---|
| `../../LEASEOS_CODEBASE_HANDOFF.md` | the master summary, written for external review |
| `SYSTEM_ARCHITECTURE.md` | stack, auth, tenancy, audit, data flows |
| `FEATURE_INVENTORY.md` | every identifiable feature with an evidence-backed status |
| `LEASEOS_FEATURE_MATRIX.md` | the product-area matrix |
| `DATABASE_INVENTORY.md` | 408 tables, writers, readers, orphans |
| `API_INVENTORY.md` | 690 procedures, permissions, UI reach |
| `UI_INVENTORY.md` | screens, routes, and backend-without-UI |
| `TEST_INVENTORY.md` | 304 files, 4 199 tests, skips and coverage gaps |
| `EXTERNAL_DEPENDENCIES.md` | every non-code blocker |
| `GAPS_AND_DISCONNECTED_CODE.md` | dead, partial and disconnected code |
| `REGISTER_STATUS.md` | register claims verified against code |
| `feature-matrix.json` | machine-readable, for external comparison |
| `REPO_FILE_MANIFEST.txt` | repository file tree, no credentials |
| `../../docs/product/LEASEOS_BUILD_ORDER.md` | phased build order derived from this audit |
| `../../docs/product/DISPATCHER_VERTICAL_SLICE_SPEC.md` | the first slice, specified test-first |

## Why there is no ZIP in this branch

A `LEASEOS_CODE_REVIEW_PACKAGE.zip` was produced for hand-off and is **deliberately not committed**.

The repository does store archives (`archive/source-bundles/*.zip`), so policy permits binaries. But
that precedent is for **source bundles that cannot otherwise be reconstructed**. This zip is a pure
derivative: it contains exactly the 13 files in this directory, verified byte-identical member by
member. Committing it would store the same content twice and leave a binary that goes stale the
moment any document here is edited, with nothing to detect the drift.

Regenerate it at any time:

```sh
cd audit/leaseos-current-inventory
cp ../../LEASEOS_CODEBASE_HANDOFF.md .
zip -r ../../LEASEOS_CODE_REVIEW_PACKAGE.zip .
rm LEASEOS_CODEBASE_HANDOFF.md      # it lives at the repository root, not here
```
