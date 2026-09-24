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

## Change log

* **2026-09-23**: created at C1a integration. C1a moved `0172 → 0174` because
  `claude/training-academy-workforce-q3mdse` had claimed `0172`/`0173` since the Checkpoint 0 survey.
  No other branch was renumbered.

## Reservations recorded by design branches (not yet files on any branch)

A design document that names its migration numbers is a claim the next claimant should see here, or
two branches pick the same free number from the same scan. Rows leave this table when the files land
on the branch and move into the table above.

| Number | Intended file | Branch | Design | Basis | Note |
|---|---|---|---|---|---|
| 0182 | `0182_board_membership.sql` | `claude/leaseos-communications-marketplace-p8ptqw` | `docs/product/COMPANY_BOARD_OPEN_WORK_DESIGN.md` §10 | scan of every remote branch against `main` `6f52b57` on 2026-09-24: highest claim anywhere is `0181` (`claude/document-control-architecture-jlffzk`) | **file now on the branch** (Checkpoint 2) |
| 0183 | `0183_open_work_offers_availability.sql` | same | same | same | **file now on the branch** (Checkpoint 2) |
| 0184 | *(released)* | same | same | same | Checkpoint 3 needed no column; `0184` is free again |

## Change log (continued)

* **2026-09-24**: the Company Board + Open Work design reserved `0182`–`0184` by scan (highest open
  claim `0181`). Nothing renumbered; no file added.
* **2026-09-24** (later): Checkpoint 2 of that design added `0182_board_membership.sql` and
  `0183_open_work_offers_availability.sql` to `claude/leaseos-communications-marketplace-p8ptqw`. `0184`
  stays reserved. Nothing renumbered.
* **2026-09-24** (Checkpoint 3): `0184` released — the award needed no column. The first number free
  on `main` and every open branch is again `0184`.
