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

## Current state (2026-09-24, `main` = `1680e94`, scan at C1b-1)

`main` migration head: **`0179_trip_stop_provenance.sql`** (#17). `main` holds `0169`, `0170`/`0171`
(PR #9), `0174` (C1a) and `0179`; `0172`, `0173` and `0175`–`0178` are open on `main` and claimed only by
branches. Every number from `0175` to `0188` is claimed by at least one open branch.

| Number | Migration file | Branch | Status | Collision | Intended resolution |
|---|---|---|---|---|---|
| 0170 | `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` | open branch | **with main** (`0170_dispatch_role_types`, #9) | its author renumbers at rebase |
| 0170 | `0170_work_calendar_tasks_reminders.sql` | `claude/work-calendar-task-engine-0mtjyk` | open branch | **with main** | its author renumbers at rebase |
| 0172 | `0172_training_wallet_renewal_handoff.sql` | `claude/training-academy-workforce-q3mdse` | open branch | none | keeps 0172 |
| 0173 | `0173_wallet_history_guards.sql` | `claude/training-academy-workforce-q3mdse` | open branch | none | keeps 0173 |
| 0175 | `0175_client_services_portal.sql` | `claude/client-portal-job-tracking-zqmejc` | open branch | with driver-portfolio ×2, auth-workspace | first to merge keeps it |
| 0175 | `0175_driver_portfolio.sql` | `claude/driver-portfolio-api-ya8928`, `claude/driver-portfolio-credential-wallet-ya8928` | open branches | as above | first to merge keeps it |
| 0175 | `0175_organization_invitations.sql` | `claude/leaseos-auth-workspace-system-t008ad` | open branch | as above | first to merge keeps it |
| 0176 | `0176_driver_portfolio_events_append_only.sql` | both driver-portfolio branches | open branches | same file on both | follows its branch |
| 0177 | `0177_driver_portfolio_api.sql` | `claude/driver-portfolio-api-ya8928` | open branch | none | — |
| 0178 | `0178_document_control_definitions.sql` | `claude/document-control-architecture-jlffzk` | open branch | none | — |
| 0179 | `0179_document_control_register.sql` | `claude/document-control-architecture-jlffzk` | open branch | **with main** (`0179_trip_stop_provenance`) | its author renumbers at rebase |
| 0179 | `0179_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` | open branch | **with main** | its author renumbers at rebase |
| 0180 | `0180_document_control_numbering.sql` | `claude/document-control-architecture-jlffzk` | open branch | none | — |
| 0181 | `0181_document_control_templates.sql` | `claude/document-control-architecture-jlffzk` | open branch | none | — |
| 0182 | `0182_board_membership.sql`, `0182_customer_account_profile.sql`, `0182_document_control_intake.sql`, `0182_integration_hub_connectors.sql`, `0182_safety_program_builder.sql` | communications-marketplace, customer-contract-rates, document-control, integration-hub, safety-program-builder | open branches | five-way | first to merge keeps it |
| 0183 | `0183_customer_contracts_rate_sheets.sql`, `0183_document_control_disposal.sql`, `0183_integration_hub_delivery_and_sync.sql`, `0183_open_work_offers_availability.sql` | customer-contract-rates, document-control, integration-hub, communications-marketplace | open branches | four-way | first to merge keeps it |
| 0184 | `0184_integration_hub_dead_letters_conflicts.sql`, `0184_job_commercial_context.sql` | integration-hub, customer-contract-rates | open branches | two-way | first to merge keeps it |
| 0185 | `0185_assistant_proposal_tenancy.sql`, `0185_webhook_delivery_claim.sql` | `claude/relaxed-carson-qfcopf`, `claude/sec-004-webhook-delivery-integrity` | open branches | two-way | first to merge keeps it |
| 0186 | `0186_external_source_categories.sql` | `claude/canadian-govt-apis-leaseos-q33l42` | open branch | none | — |
| 0187 | `0187_training_compliance_operations.sql` | `claude/training-academy-workforce-q3mdse` | open branch | none (was 0174, collided with main) | — |
| 0188 | `0188_source_review_history_guards.sql` | `claude/training-academy-workforce-q3mdse` | open branch | none | — |
| 0189 | `0189_rule_ledger_generalization.sql` | `claude/leaseos-compliance-survey-5faxe8` (C1b-1) | this branch | none | keeps 0189 |

**Next free number for new work: `0190`** (re-check with the scan above before committing).

### Change log

* **2026-09-24 (C1b-1)**: rescanned after #6, #9, #11, #10, #13, #17, #18, #21, #23–#25 merged. C1b-1 takes
  `0189`, the first number no branch holds, rather than `0175` (named free on 2026-09-23 and claimed by
  four branches since). No other branch renumbered.

## Earlier state (2026-09-23, `main` = `42c454f`, after PR #4, PR #5 and C1a #12)

`main` migration head: **`0174_dispatch_override_provenance.sql`**. `main` holds `0169` (PR #4) and
`0174` (C1a); `0170`–`0173` are open on `main` and claimed only by branches.

| Number | Migration file | Branch | PR | Base (merge-base with main) | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0169 | `0169_defect_resolution.sql` | *(main)* | #4 | — | **on main** | vs `0169_driver_portfolio` | main owns 0169 |
| 0169 | `0169_driver_portfolio.sql` | `claude/driver-portfolio-credential-wallet-ya8928` | none | `3911f59` | open branch, no PR | **collides with main** | its author renumbers at rebase onto main |
| 0170 | `0170_driver_portfolio_events_append_only.sql` | `claude/driver-portfolio-credential-wallet-ya8928` | none | `3911f59` | open branch, no PR | with #9, #11, auth-workspace | renumber at rebase |
| 0170 | `0170_dispatch_role_types.sql` | `feature/dispatch-role-assignment-backend` | #9 | `42c454f` | PR open against `main`, main merged in | with auth-workspace, driver-portfolio | #9 is nearest to merge and **proposes to keep 0170/0171**; owner to confirm |
| 0170 | `0170_dispatch_role_types.sql` | `feature/dispatch-assignment-ui` | #11 | `e6b65f2` | PR open, stacked on #9 | inherited from #9 (same file) | follows #9 |
| 0170 | `0170_organization_scoped_role_grants.sql` | `claude/leaseos-auth-workspace-system-t008ad` | none | `f21cd1b` | open branch, no PR | with #9, driver-portfolio | renumber at rebase |
| 0171 | `0171_dispatch_role_assignment_events.sql` | `feature/dispatch-role-assignment-backend` | #9 | `42c454f` | PR open | inherited copy on #11 only | follows #9 |
| 0171 | `0171_dispatch_role_assignment_events.sql` | `feature/dispatch-assignment-ui` | #11 | `e6b65f2` | PR open, stacked on #9 | inherited from #9 | follows #9 |
| 0172 | `0172_training_wallet_renewal_handoff.sql` | `claude/training-academy-workforce-q3mdse` | none | `0060690` | open branch, no PR | none (C1a moved off it) | keeps 0172 |
| 0173 | `0173_wallet_history_guards.sql` | `claude/training-academy-workforce-q3mdse` | none | `0060690` | open branch, no PR | none | keeps 0173 |
| 0174 | `0174_dispatch_override_provenance.sql` | *(main)* | #12 | — | **on main** | none | — |

Next free number at that time: `0175` (superseded above).

## Change log

* **2026-09-23**: C1a merged (#12, `42c454f`), so `0174` is on main. PR #9 was brought onto main (merge-base `42c454f`).
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
