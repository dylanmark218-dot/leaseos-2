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
| 0185 | `0185_assistant_proposal_tenancy.sql` | `claude/relaxed-carson-qfcopf` | none yet | `6f52b57` | AIL-1A checkpoint | none | 0170–0184 are each claimed by main or an open branch (fetch of 2026-09-24, comparing file names on all 56 remotes, including the two branches with no merge base); 0185 is the first free number |
| 0214 | `0214_organization_knowledge_entries.sql` | `claude/relaxed-carson-qfcopf` | none yet | `6f52b57` | AIL-1B checkpoint | none | a fetch of 2026-10-01 compared file names on every remote: 0180–0213 are held except 0190 and 0204, which are gaps inside another branch's own run (0189→0191, 0203→0205) and treated as held; 0214 is the first number past every claim |

## Change log

* **2026-09-23**: created at C1a integration. C1a moved `0172 → 0174` because
  `claude/training-academy-workforce-q3mdse` had claimed `0172`/`0173` since the Checkpoint 0 survey.
  No other branch was renumbered.
* **2026-09-24**: AIL-1A claims `0185`. The three-dot scan above misses
  `feature/tenant-scope-foundation` and `claude/mobile-hardware-scanner-mzp1e1-v2327`, which share no
  history with main (they claim 0168–0173 and 0168–0169 by file name). The rows above for 0175–0184 are
  not yet recorded here; they were confirmed as claimed by file name, not reconciled branch by branch.
* **2026-10-01**: AIL-1B claims `0214`. 0186–0213 are now claimed by file name on open branches
  (agent-terminal-run-guard, the audit chain diagnostic and others); this branch's own 0185 is unchanged.
