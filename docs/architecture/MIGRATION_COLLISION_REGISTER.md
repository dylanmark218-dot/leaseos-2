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

## Current state (2026-10-01, `main` = `b93dea7`, scan at LA-1a)

`main` migration head: **`0209_operating_zone_scope.sql`**. `main` holds `0189`, `0191`–`0196`, `0198`,
and `0209`. LA-1a claims `0202` and `0203` on this branch; both are below the current main head and do
not collide with a main migration:

| Number | Migration file | Branch | Status | Collision | Intended resolution |
|---|---|---|---|---|---|
| 0195 | `0195_document_control_register.sql` | `claude/document-control-design-imsd3n` | open branch | none | — |
| 0196 | `0196_document_control_numbering.sql` | `claude/document-control-design-imsd3n` | open branch | none | — |
| 0197 | `0197_knowledge_provenance.sql` | `claude/leaseos-intelligence-engine-cr2fg1` | open branch | none (touches `knowledgeSources`/`knowledgeChunks`, new `knowledgeSnapshots`; C1b-2b does not touch those) | — |
| 0198 | `0198_requirement_verification.sql` | `claude/leaseos-compliance-survey-5faxe8` (C1b-2b) | this branch | none | keeps 0198 |
| 0199 | `0199_work_order_ownership.sql` | `claude/mechanic-portal-domain-82efa9` | open branch | none | keeps 0199 (moved from `0198` when C1b-2b merged first; see the claim below) |
| 0200 | `0200_fleet_portfolio_foundation.sql` | `claude/mechanic-portal-domain-82efa9` | open branch | none | keeps 0200 |
| 0201 | `0201_fleet_portfolio_guards.sql` | `claude/mechanic-portal-domain-82efa9` | open branch | none | keeps 0201 |
| 0202 | `0202_live_assist_sessions.sql` | `claude/live-assist-architecture-qg4jgp` (LA-1a) | this branch | none | keeps 0202 |
| 0203 | `0203_live_assist_events_append_only.sql` | `claude/live-assist-architecture-qg4jgp` (LA-1a) | this branch | none | keeps 0203 |
| 0220 | `0220_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` | open branch | none | — (seen in the CP2 scan, 2026-10-01) |
| 0221 | `0221_defect_lifecycle.sql` | `claude/mechanic-portal-domain-82efa9` (mechanic CP2) | open branch | none | keeps 0221 |
| 0222 | `0222_defect_lifecycle_guards.sql` | `claude/mechanic-portal-domain-82efa9` (mechanic CP2) | open branch | none | keeps 0222 (trigger DDL in its own file) |

**2026-09-25 (later), on merging main into `claude/leaseos-auth-workspace-system-t008ad` (#64):** its
`0170_organization_scoped_role_grants.sql` and `0175_organization_invitations.sql` collided with main's
`0170_dispatch_role_types` (#9) and `0175_session_families` (#30). Per the rule of thumb they were renumbered
to **`0207`** and **`0208`**, the first slots free on main and on every open branch (the scan then showed
`0199`–`0206` claimed: `0199`–`0201` mechanic-portal, `0202`–`0204` driver-portfolio, `0205`–`0206`
communications-marketplace). `scripts/verify-migration-0170.sh` became `verify-migration-0207.sh`. Still
open, not touched here: `0202`/`0203` are claimed twice — driver-portfolio (#16) and
`claude/live-assist-architecture-qg4jgp` (no PR). Next free number at that time: `0209` (since taken by main for P0-A2.1; see the 2026-10-01 section below — next free is `0210`).

**Next free number for new work: `0210`** (re-check with the scan before committing). The 2026-09-24 table below
is kept for history; several of its claims have since merged or been renumbered by their authors.

## Earlier state (2026-09-24, `main` = `1680e94`, scan at C1b-1)

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
| 0189 | `0189_rule_ledger_generalization.sql` | `claude/leaseos-compliance-survey-5faxe8` (C1b-1, PR #15) | open PR | with the two rows below (claimed after 2026-09-24 12:00) | first to merge keeps it |
| 0189 | `0189_document_control_register.sql` | `claude/document-control-design-imsd3n` | open branch | with C1b-1, mechanic-portal | first to merge keeps it |
| 0189 | `0189_work_order_ownership.sql` | `claude/mechanic-portal-domain-82efa9` | open branch | with C1b-1, document-control-design | first to merge keeps it |
| 0190 | `0190_document_control_numbering.sql` | `claude/document-control-design-imsd3n` | open branch | none | — |

Next free number at that time: `0191` (superseded above).

### Change log

* **2026-09-25**: `main` (`242b619`) now carries `0175_session_families.sql` (#30), so the `0175` rows above
  now collide with `main` and their authors renumber at rebase. Since the C1b-1 scan, `0189` has also been
  claimed by `claude/document-control-design-imsd3n` and `claude/mechanic-portal-domain-82efa9`. No file was
  renamed.
* **2026-09-24 (C1b-1)**: rescanned after #6, #9, #11, #10, #13, #17, #18, #21, #23–#25 merged. C1b-1 takes
  `0189`, the first number no branch holds, rather than `0175` (named free on 2026-09-23 and claimed by
  four branches since). No other branch renumbered.

## Claim: 0227 (payroll P2 — pay schedules and the pay-period machine, 2026-10-03)

`main` = `a61ff29`, migration head **`0226_payroll_compensation_agreements.sql`** (P1, merged as #130). Scan over
`origin/main` and all 130 remote refs immediately before the P2 commit:

| Number | Migration file | Branch | Status | Collision | Intended resolution |
|---|---|---|---|---|---|
| 0220 | `0220_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` | open | with integration hub | first to merge keeps it |
| 0220–0223 | `0220_integration_hub_connectors.sql` … `0223_integration_hub_conflicts_and_links.sql` | `claude/integration-hub-subsystem-6nzrkw` | open | 0220 with ELD | first to merge keeps it |
| 0224 | `0224_eld_duty_day_designations.sql` | `claude/eld-compliance-intelligence-ramlrd` | open | with ci-stabilization | first to merge keeps it |
| 0224, 0225 | `0224_offline_capture_identity_scope.sql`, `0225_queued_package_identity_scope.sql` | `fix/main-ci-stabilization` | open | 0224 with ELD | first to merge keeps it |
| **0227** | **`0227_payroll_pay_schedules.sql`** | **`claude/payroll-p2-pay-schedules`** | **claiming** | **none** | **keeps 0227** |

No ref holds anything at or above `0227`. **Next free number for new work: `0228`** (re-check with the scan before
committing).

## Claim: 0226 (payroll P1 — compensation agreements and earning codes, 2026-10-02)

`main` = `3e44aa9`, migration head **`0222_defect_lifecycle_guards.sql`**. Scan over `origin/main` and every remote
branch immediately before the P1 commit:

| Number | Migration file | Branch | Status | Collision | Intended resolution |
|---|---|---|---|---|---|
| 0220 | `0220_eld_event_ledger.sql` | `claude/eld-compliance-intelligence-ramlrd` | open | with integration hub | first to merge keeps it |
| 0220–0223 | `0220_integration_hub_connectors.sql` … `0223_integration_hub_conflicts_and_links.sql` | `claude/integration-hub-subsystem-6nzrkw` | open | 0220 with ELD | first to merge keeps it |
| 0224 | `0224_eld_duty_day_designations.sql` | `claude/eld-compliance-intelligence-ramlrd` | open | with ci-stabilization | first to merge keeps it |
| 0224, 0225 | `0224_offline_capture_identity_scope.sql`, `0225_queued_package_identity_scope.sql` | `fix/main-ci-stabilization` | open | 0224 with ELD | first to merge keeps it |
| **0226** | **`0226_payroll_compensation_agreements.sql`** | **`claude/payroll-p1-compensation-agreements`** | **claiming** | **none** | **keeps 0226** |

P1 was drafted as `0224` (free at the first scan of the day) and moved to `0226` before any environment applied it,
when the pre-commit rescan found `0224` and `0225` claimed. **Next free number for new work: `0227`** (re-check with
the scan before committing).

## Claim: 0221, 0222 (mechanic portal CP2 — defect to return to service, 2026-10-01)

| Number | Migration file | Branch | PR | Base | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0221 | `0221_defect_lifecycle.sql` | `claude/mechanic-portal-domain-82efa9` | none | `038dffc` (contains `main` `b35bac4`) | gated on the branch | none | keeps 0221 |
| 0222 | `0222_defect_lifecycle_guards.sql` | `claude/mechanic-portal-domain-82efa9` | none | `038dffc` | gated on the branch | none | keeps 0222 (trigger DDL in its own file) |

Drafted as `0220`/`0221`. The scan of `origin/main` and all 120 remote refs immediately before writing found
`main` ending at `0219` and `claude/eld-compliance-intelligence-ramlrd` holding `0220_eld_event_ledger.sql`,
so this checkpoint takes the first two numbers above every claim. No environment had applied either.
Next free number: `0223`.

## Claim: 0199, 0200, 0201 (mechanic portal CP1 and the Fleet & Equipment Portfolio foundation, 2026-09-25)

| Number | Migration file | Branch | PR | Base (merge-base with main) | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0199 | `0199_work_order_ownership.sql` | `claude/mechanic-portal-domain-82efa9` | none | `3d05d32` | gated on the branch | none | keeps 0199. Drafted as `0175`, then `0189`, then `0198`; each was taken first (`0189` by C1b-1, `0198` by C1b-2b, both merged to `main`), and it moved before any environment applied it |
| 0200 | `0200_fleet_portfolio_foundation.sql` | `claude/mechanic-portal-domain-82efa9` | none | `3d05d32` | gated on the branch | none | keeps 0200. The portfolio design's own `0182` was taken long ago |
| 0201 | `0201_fleet_portfolio_guards.sql` | `claude/mechanic-portal-domain-82efa9` | none | `3d05d32` | gated on the branch | none | keeps 0201 (trigger DDL in its own file) |

First chosen as `0198`–`0200` by scanning `origin/main` and all 93 remote refs, when the highest number any
other ref held was `0197` (`claude/leaseos-intelligence-engine-cr2fg1`). The scan repeated immediately
before finalizing (94 refs, `main` = `3d05d32`) found C1b-2b's `0198_requirement_verification.sql` merged to
`main` (#54), so all three moved up one; no other ref holds anything above `0198`. `0190` is unclaimed everywhere but
was not taken: it would sort before `main`'s `0191`–`0194`, so a fresh database and a deployed one would
apply it in different orders.

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

## Claim: 0185 (SEC-004, 2026-09-24)

| Number | Migration file | Branch | PR | Base (merge-base with main) | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0185 | `0185_webhook_delivery_claim.sql` | `claude/sec-004-webhook-delivery-integrity` | SEC-004 PR | `6f52b57` | gated | none | keeps 0185 |

Chosen by scanning `origin/main` and all 57 remote refs immediately before writing: the highest number
any of them held was `0184` (`integration-hub-subsystem`, `customer-contract-rates`), so `0185` was the
first number free everywhere. `claude/integration-hub-subsystem-6nzrkw`'s `0183` also adds
`webhookDeliveries.claimedAt`/`claimedBy`. When that branch rebases onto this one, its `0183` drops those
two columns rather than this migration being renumbered (see
`audit/hardening-2026-09-24/SEC-004-WEBHOOK-DELIVERY-INTEGRITY.md`).
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

* **2026-09-23**: C1a merged (#12, `42c454f`), so `0174` is on main. PR #9 was brought onto main (merge-base `42c454f`).
* **2026-09-23**: created at C1a integration. C1a moved `0172 → 0174` because
  `claude/training-academy-workforce-q3mdse` had claimed `0172`/`0173` since the Checkpoint 0 survey.
  No other branch was renumbered.
* **2026-09-24**: `0185` claimed by SEC-004 (`claude/sec-004-webhook-delivery-integrity`); first number free on
  `main` and every remote branch. No branch renumbered.

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

## State at the S2 integration (2026-09-25, `main` = `e291f28`, after PR #45, #47 and #48)

`main` migration head: **`0193_mfa_secret_ref.sql`**. `main` carries **no `018x` migration at all** —
the 0181–0190 range is held entirely by open branches.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0185 | `0185_webhook_delivery_claim.sql` | `claude/sec-004-webhook-delivery-integrity` | #20 | reconciled onto `main`; integrating | **`claude/relaxed-carson-qfcopf` also claims `0185`** (`0185_assistant_proposal_tenancy.sql`) | **SEC-004 keeps `0185`**: it claimed the number at 2026-09-24 07:52 when it was free on `main` and every branch; the other claim followed 77 minutes later and did not meet the "free everywhere" standard. That branch renumbers at its own integration, as the academy branch's `0174` does |
| 0191 | `0191_encrypted_secrets.sql` | `feature/secret-management-foundation` | #45 | **merged** | none | recorded late — see change log |
| 0192 | `0192_provider_credentials.sql` | `feature/secret-management-foundation` | #45 | **merged** | none | recorded late — see change log |
| 0193 | `0193_mfa_secret_ref.sql` | `feature/mfa-secret-migration` | #47 | **merged** | none | recorded late — see change log |

Next number free on `main` and on every open branch: **`0194`** — to be re-scanned at the moment of
claiming, not taken from this line.

## Change log

* **2026-09-25 (S2 integration)**: recorded `0191`, `0192` and `0193`, which were **merged without
  being entered here** — a bookkeeping defect in S2-A/B/C and S2-D, not a numbering one: all three
  numbers were verified free across every branch before use, and none collided. The register is the
  repository's record of that verification, and three merges' worth of it was missing. Also recorded
  the `0185` double-claim, resolved in SEC-004's favour on claim order. No migration file renamed.
## State at Document Control adoption (2026-09-24, `main` = `1680e94`)

The owner adopted `claude/document-control-architecture-jlffzk` as the Document Control implementation
(`docs/document-control/DC_RECONCILIATION_BRIEF_2026-09-24.md`) and ruled that its checkpoints A–C land
first. They land from `claude/document-control-design-imsd3n`. Scan run with the command above against
every remote branch: claims now reach `0188` (`0187` eld-compliance and training-academy, `0188`
training-academy). `main` holds `0179_trip_stop_provenance.sql`, so the branch's `0179` could not keep
its number.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0178 | `0178_document_control_definitions.sql` | `claude/document-control-design-imsd3n` (from `…-jlffzk`) | #29 | only claimant | none | keeps 0178 |
| 0195 | `0195_document_control_register.sql` | same | #29 | first number free after every claim at the 2026-09-25 rebase | none | **built as 0179**, adopted as 0189, **renamed 0195** (see change log); content unchanged, header says so |
| 0196 | `0196_document_control_numbering.sql` | same | #29 | next free | none | **built as 0180**, adopted as 0190, **renamed 0196** to stay after 0195; content unchanged |
| 0181–0183 | Document Control D–H (templates, intake, disposal) | `claude/document-control-architecture-jlffzk` | none | held under the D-00 carve-out | 0182/0183 also claimed by four and three other branches | renumber past every claim when that work is ruled in |

* **2026-09-24 (Document Control adoption)**: `0179 → 0189` and `0180 → 0190` for Document Control;
  `0178` kept. No other branch's file renamed.
* **2026-09-25 (Document Control rebase onto `main` `14b5df2`)**: `0189` turned out to be claimed three
  times — C1b-1 (`claude/leaseos-compliance-survey-5faxe8`, PR #15) first, then this PR and
  `claude/mechanic-portal-domain-82efa9`. Following the rule of thumb and the SEC-004 claim-order
  precedent, this PR moved off it at its own rebase: `0189 → 0195` and `0190 → 0196` (`0191`–`0193` are
  on `main`; `0194` is held by PR #50). `0178` unchanged. No other branch's file renamed.

## State at the S2-E Phase 1 claim (2026-09-25, `main` = `14b5df2`, after PR #20 and #49)

`main` migration head: **`0193_mfa_secret_ref.sql`**, 175 migrations. Re-scanned across `main`,
every remote branch and every open-PR head at the moment of claiming: the highest number held
anywhere is `0193`, so `0194` is the first free everywhere.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0194 | `0194_webhook_secret_ref.sql` | `feature/webhook-secret-migration-phase1` | S2-E Phase 1 | claiming | none | keeps 0194 |

## Change log

* **2026-09-25 (S2-E Phase 1)**: claimed `0194` and recorded it **in the commit that creates the
  migration**, rather than afterwards. That ordering is the correction for the `0191`–`0193`
  omission recorded above: those numbers were each verified free before use, but the verification
  went unrecorded, and this register is the only place that verification survives.

## State at the P0-A2.1 claim (2026-10-01, `main` = `64f784d`, after PR #73)

`main` migration head: **`0198_requirement_verification.sql`**, 181 migrations (0197 unused). Re-scanned
across `main` and every remote branch (a superset of every open-PR head) at the moment of claiming:
numbers held somewhere beyond `main` are `0199`–`0208` (`claude/driver-portfolio-credential-wallet-ya8928`
0202–0204, `claude/leaseos-auth-workspace-system-t008ad` 0207–0208, and others), so `0209` is the first
number free everywhere.

| Number | Migration file | Branch | PR | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|
| 0209 | `0209_operating_zone_scope.sql` | `security/operating-zone-tenant-model` | P0-A2.1 | claiming | none | keeps 0209 |

**Next free number for new work: `0210`** (re-check with the scan before committing).

## Change log (continued)

* **2026-10-01 (P0-A2.1)**: claimed `0209` (`operatingZones.orgRef`, nullable; NULL = the historical single
  tenant, as 0132 and 0148), recorded in the commit that creates the migration.

## Claim: 0217–0219 (Customer, Contract and Rate Management, 2026-10-01)

| Number | Migration file | Branch | PR | Base (merge-base with main) | Status | Collision | Intended resolution |
|---|---|---|---|---|---|---|---|
| 0217 | `0217_customer_account_profile.sql` | `claude/leaseos-customer-contract-rates-jkrw1i` | none yet | `c3f088b` | gated | none | keeps 0217 |
| 0218 | `0218_customer_contracts_rate_sheets.sql` | `claude/leaseos-customer-contract-rates-jkrw1i` | none yet | `c3f088b` | gated | none | keeps 0218 |
| 0219 | `0219_job_commercial_context.sql` | `claude/leaseos-customer-contract-rates-jkrw1i` | none yet | `c3f088b` | gated | none | keeps 0219 |

Written as `0182`–`0184` on 2026-09-24, when they were the first numbers free everywhere. By the merge of
`main` (`c3f088b`) three other open branches held `0182`–`0184` (`document-control-architecture`,
`integration-hub-subsystem`, `safety-compliance-program-builder`) and the highest claim on any remote ref
was `0216`: `claude/relaxed-carson-qfcopf` took `0214` and `claude/leaseos-sign-attest-design-5993ar`
took `0215`–`0216` while this merge was being gated, the second of them minutes before this branch
pushed `0215`–`0217`. As the later, unmerged claimant this branch moved again, to the first
three numbers free on `main` and on every open branch. No other branch was renumbered.


## State at the Sign & Attest SA1 merge (2026-10-01, `main` = `ce27fec`, after PR #98, #59 and #102)

`main` migration head: **`0219_job_commercial_context.sql`** (v23.31 took `0217`–`0219`, renumbered around
Sign & Attest's claim; `0205`/`0206` landed with #59). This branch (PR #104) holds **`0214`–`0216`**
(`0214_sign_attest_foundation`, `0215_sign_attest_events`, `0216_sign_attest_guards`): below main's head,
colliding with nothing on main, applied by name. The earlier provisional claim of `0182`–`0184` in the
design document is withdrawn (those numbers were taken by other branches).

**Next free number for new work after this merge: `0220`** (re-check with the scan before committing).

## Change log (continued)

* **2026-10-01 (SA1 merge)**: Sign & Attest `0214`–`0216` recorded against `main` `ce27fec`; next free `0220`.
