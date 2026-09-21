# Merge / Review Order

1. `milestone/v20` — earliest exact source snapshot supplied.
2. `candidate/v20-to-v22.16` / `milestone/v22.16` — cumulative B20/B21/B22.0–B22.16 state.
3. `candidate/v22.16-to-cal05a` / `milestone/cal05a` — cumulative B22.17–B22.19 plus later CAL05a worktree state.
4. `main` — CAL05a plus reconciliation manifests and preserved unique artifacts.

Do not cherry-pick `upgrade/*` branches as though they were isolated feature commits: those refs intentionally point at cumulative milestone trees because the supplied material does not contain exact per-upgrade source trees.
