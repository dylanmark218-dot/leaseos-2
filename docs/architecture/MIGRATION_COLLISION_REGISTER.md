# Migration collision register

A **human-reviewed** integration register, not a renumbering tool. It records which open branch claims
which migration number, where two branches claim the same one, and what is intended. Nothing here
renumbers anything automatically. A branch changes its own numbers when its author rebases it, and the
change is reviewed in that branch's PR.

**How to refresh it.** Run the scan below against `origin/main` and every remote branch, then update the
tables by hand:

```bash
git fetch origin --prune
for b in $(git branch -r | grep -v HEAD | sed 's#  origin/##'); do
  for f in $(git diff --name-only --diff-filter=A origin/main...origin/$b -- drizzle/ | grep -E 'drizzle/0[0-9]{3}_.*\.sql$'); do
    echo "$(basename $f) | $b | base $(git merge-base origin/main origin/$b | cut -c1-7)"
  done
done | sort
```

**Rule of thumb** (a convention, not automation): the first branch to merge keeps its number, and every
other claimant takes the next number free on `main` *and* on all open branches at its own rebase.
Reserved slots `0016`/`0017` are never used (CI gate 0). `0094`, `0095` and `0098` are historical gaps,
and `0157` is historically used twice. None of those is reused.

## State at C1a integration (2026-09-23, `main` = `6b01a0e`, after PR #4 and PR #5)

`main` migration head: **`0169_defect_resolution.sql`** (PR #4). PR #5 added none.

| Number | Migration file | Branch | PR | Base (merge-base with main) | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0169 | `0169_defect_resolution.sql` | *(main)* | #4 (merged) | — | **on main** | vs `0169_driver_portfolio` | main owns 0169 |
| 0169 | `0169_driver_portfolio.sql` | `claude/driver-portfolio-credential-wallet-ya8928` | none | `3911f59` | open branch, no PR | **collides with main** | renumber at that branch's rebase onto main (its author) |
| 0170 | `0170_driver_portfolio_events_append_only.sql` | `claude/driver-portfolio-credential-wallet-ya8928` | none | `3911f59` | open branch, no PR | with #9, #11, auth-workspace | renumber at rebase |
| 0170 | `0170_dispatch_role_types.sql` | `feature/dispatch-role-assignment-backend` | #9 | `e6b65f2` | PR open, stacked; CI green | with auth-workspace, driver-portfolio | #9 is nearest to merge, so it **proposes to keep 0170/0171**. Owner to confirm |
| 0170 | `0170_dispatch_role_types.sql` | `feature/dispatch-assignment-ui` | #11 | `e6b65f2` | PR open, stacked on #9 | same file as #9 (inherited), not a separate claim | follows #9 |
| 0170 | `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` | none | `f21cd1b` | open branch, no PR | with #9, driver-portfolio | renumber at rebase |
| 0171 | `0171_dispatch_role_assignment_events.sql` | `feature/dispatch-role-assignment-backend` | #9 | `e6b65f2` | PR open | none besides #11's inherited copy | follows #9 |
| 0171 | `0171_dispatch_role_assignment_events.sql` | `feature/dispatch-assignment-ui` | #11 | `e6b65f2` | PR open | inherited from #9 | follows #9 |
| 0172 | `0172_training_wallet_renewal_handoff.sql` | `claude/training-academy-workforce-q3mdse` | none | `0060690` | open branch, no PR | **was** with C1a's original `0172` | C1a moved off; this branch keeps 0172 |
| 0173 | `0173_wallet_history_guards.sql` | `claude/training-academy-workforce-q3mdse` | none | `0060690` | open branch, no PR | none | keeps 0173 |
| 0174 | `0174_dispatch_override_provenance.sql` | `feat/compliance-c1a-readiness-contract` | C1a PR | `6b01a0e` | rebased; gated | none | **moved from 0172 → 0174** at integration: the first number no branch held |

## State at Document Control Checkpoint A (2026-09-23, `main` = `0cd4817`)

Scan run with the command above against every remote branch. Claims found: `0170` (eld-compliance,
auth-workspace, work-calendar), `0172`–`0175` (training-academy-workforce), `0175`–`0177`
(driver-portfolio ×2). `0178` was the first number free on `main` and on every open branch.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0178 | `0178_document_control_definitions.sql` | `claude/document-control-architecture-jlffzk` | none yet | open branch | none at claim time | keeps 0178 unless a branch merges ahead with it; re-check at PR time |
| 0179+ | Document Control checkpoints B–F (register extension, numbering ledger, templates, mappings, intake) | same branch | none yet | planned | — | consecutive from 0178; re-check at PR time |

## Change log

* **2026-09-23 (later)**: Document Control claims `0178` after a fresh scan; driver-portfolio had moved to
  `0175`–`0177` and training-academy to `0172`–`0175` since the C1a scan.

* **2026-09-23**: created at C1a integration. C1a moved `0172 → 0174` because
  `claude/training-academy-workforce-q3mdse` had claimed `0172`/`0173` since the Checkpoint 0 survey.
  No other branch was renumbered.

## State at the 0169 reconciliation (2026-09-23, `main` = `6f52b574`, after PR #10 and PR #13)

`main` migration head: **`0174_dispatch_override_provenance.sql`**. Numbers 0175–0178 are claimed
by open branches (`0175` by `claude/driver-portfolio-*` and `claude/training-academy-workforce-q3mdse`,
`0176`/`0177` by `claude/driver-portfolio-*`, `0178` by `claude/document-control-architecture-jlffzk`).

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0169 | `0169_trip_stop_provenance.sql` | **sibling repository `leaseos`, `main`** (`9e1a75f`) | — | applied history there | with this repository's `0169_defect_resolution.sql` | **neither renamed**; this repository converges by forward migration 0179 — see `docs/register/MIGRATION_0169_RECONCILIATION.md` |
| 0174 | `0174_training_compliance_operations.sql` | `claude/training-academy-workforce-q3mdse` | none | open branch | **collides with main's `0174_dispatch_override_provenance.sql`** | renumber at that branch's rebase (its author) |
| 0179 | `0179_trip_stop_provenance.sql` | `claude/migration-0169-reconciliation` | this PR | first number free on `main` and on every open branch | none | keeps 0179 |

## Change log

* **2026-09-23 (0169 reconciliation)**: added the cross-repository 0169 row, the academy branch's
  `0174` collision (new since C1a), and 0179. No file renamed.

## State at Document Control adoption (2026-09-24, `main` = `1680e94`)

The owner adopted `claude/document-control-architecture-jlffzk` as the Document Control implementation
(`docs/document-control/DC_RECONCILIATION_BRIEF_2026-09-24.md`) and ruled that its checkpoints A–C land
first. They land from `claude/document-control-design-imsd3n`. Scan run with the command above against
every remote branch: claims now reach `0188` (`0187` eld-compliance and training-academy, `0188`
training-academy). `main` holds `0179_trip_stop_provenance.sql`, so the branch's `0179` could not keep
its number.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0178 | `0178_document_control_definitions.sql` | `claude/document-control-design-imsd3n` (from `…-jlffzk`) | this PR | only claimant | none | keeps 0178 |
| 0189 | `0189_document_control_register.sql` | same | this PR | first number free after every claim | none | **renamed from 0179** (collided with `main`'s trip-stop provenance); content unchanged, header says so |
| 0190 | `0190_document_control_numbering.sql` | same | this PR | next free | none | **renamed from 0180** to stay after 0189; content unchanged |
| 0181–0183 | Document Control D–H (templates, intake, disposal) | `claude/document-control-architecture-jlffzk` | none | held under the D-00 carve-out | 0182/0183 also claimed by four and three other branches | renumber past every claim when that work is ruled in |

* **2026-09-24 (Document Control adoption)**: `0179 → 0189` and `0180 → 0190` for Document Control;
  `0178` kept. No other branch's file renamed.
