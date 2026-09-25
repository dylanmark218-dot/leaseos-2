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
