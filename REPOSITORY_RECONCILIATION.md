# LeaseOS Reconciled Repository

This Git history was reconstructed on 2026-09-14 from four supplied archive sets. The commits named `snapshot:` are import checkpoints, **not** claims about the original commit timestamps or authorship of the underlying development work.

## Default branch

`main` starts from the newest complete source tree supplied in the Chat3 CAL05a archive. Its generated `LEASEOS_CURRENT_STATE.md` reports release v22.20. Reconciliation-only reports live under `docs/reconciliation/`; functional source was not rewritten merely to make history look cleaner.

## Important B28H rule

Do not merge `candidate/b28h-widget-engine` blindly. B28H was frozen assuming migrations 0089 and 0090 were available. The newest complete source already uses those numbers and continues through 0106, and the B28 branch inventory still reports unresolved procedure mappings. Treat it as a review candidate.

## Historical accuracy

Branches under `upgrade/` are reference/containment branches. Where no exact source snapshot existed for an individual checkpoint, the branch points to the first supplied complete snapshot known to contain that checkpoint. See `docs/reconciliation/BRANCH_PLAN.md`.
