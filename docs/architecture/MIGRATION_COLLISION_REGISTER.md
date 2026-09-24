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

## Refresh at the Sign & Attest design checkpoint (2026-09-24, `main` = `6f52b57`, after PR #10)

`main` migration head: **`0174_dispatch_override_provenance.sql`** (`0170`, `0171`, `0174` on main; `0172`/`0173`
still held by `claude/training-academy-workforce-q3mdse`). Scan run with the command above over every
remote branch that shares history with `main`.

| Number | Migration file | Branch | PR | Base | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0170 | `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` | none | `f21cd1b` | open branch | **with main's `0170`** | renumber at rebase |
| 0170 | `0170_work_calendar_tasks_reminders.sql` | `claude/work-calendar-task-engine-0mtjyk` | none | `6b01a0e` | open branch | **with main's `0170`** | renumber at rebase |
| 0172–0175 | `0172_training_wallet_renewal_handoff`, `0173_wallet_history_guards`, `0174_training_compliance_operations`, `0175_source_review_history_guards` | `claude/training-academy-workforce-q3mdse` | none | `6b01a0e` | open branch | **`0174` with main's `0174`**; `0175` with driver-portfolio | renumber `0174`/`0175` at rebase |
| 0175–0176 | `0175_driver_portfolio.sql`, `0176_driver_portfolio_events_append_only.sql` | `claude/driver-portfolio-credential-wallet-ya8928` | **#16 (open)** | `42c454f` | PR open | `0175` with training-academy | #16 nearest to merge for these; training-academy renumbers |
| 0175–0177 | same two + `0177_driver_portfolio_api.sql` | `claude/driver-portfolio-api-ya8928` | none | `42c454f` | stacked on the wallet branch | inherited | follows #16 |
| 0178–0181 | `0178_document_control_definitions`, `0179_document_control_register`, `0180_document_control_numbering`, `0181_document_control_templates` | `claude/document-control-architecture-jlffzk` | none | `0cd4817` | open branch, four checkpoints | `0179` three ways (below) | first to open a PR keeps; others renumber |
| 0179 | `0179_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` | none | `6b01a0e` | open branch | **with DC `0179` and PR #17** | renumber at rebase |
| 0179 | `0179_trip_stop_provenance.sql` | `claude/migration-0169-reconciliation` | **#17 (open)** | `6f52b57` | PR open | **with DC `0179` and ELD `0179`** | #17 has a PR and the newest base; owner to confirm |
| **0182–0184** | `0182_sign_attest_foundation`, `0183_sign_attest_events`, `0184_sign_attest_guards` | `claude/leaseos-sign-attest-design-5993ar` | design only | `6f52b57` | **provisional claim, no SQL yet** (design: `docs/sign-attest/SIGN_ATTEST_DESIGN.md` §16) | none | re-scan at the SA1 PR |

**Unrelated-history branches the scan cannot see.** `claude/mobile-hardware-scanner-mzp1e1-v2327`
(`0168_movement_permits`, `0169_print_audit`) and `feature/tenant-scope-foundation`
(`0171_tracking_ownership`, `0172_tenant_relative_numbers`, `0173_offline_identity_scope`) have **no merge
base with `main`** (`git merge-base` fails), so the scan command reports nothing for them. Their numbers
collide with main's `0168`–`0171` and with the open claims above. They cannot merge as they stand; whoever
revives them renumbers onto a fresh scan. Recorded here so the gap in the scan is a known gap.

## Change log (continued)

* **2026-09-24**: refreshed at the Sign & Attest design checkpoint. New since C1a: PR #16 and #17 opened;
  the document-control branch claimed `0178`–`0181`; `0179` is now claimed three ways; `0174` collides between
  main and training-academy; Sign & Attest provisionally claims `0182`–`0184`. Two unrelated-history branches noted.
