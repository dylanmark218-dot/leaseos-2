# S2-E Phase 1 — deployment evidence record

**This document is the prerequisite for authorising Phase 2.** It is a form, filled in by whoever
runs the Phase 1 rollout, and it exists so that "Phase 1 is deployed everywhere" is an auditable
claim with a name and a date against it rather than something someone remembers being true.

Phase 2 (canonical-only webhook writes) must not be authorised while any row below is blank or
unresolved.

---

## Why this record exists at all

Every other precondition in S2-E is verifiable by a test or a query. **Deployment convergence is
not.** No query can tell you whether an application or worker instance somewhere is still running a
pre-Phase-1 build, and a pre-Phase-1 build cannot read a canonical-only webhook row.

That is the entire hazard Phase 2 introduces, and the only defence against it is a human confirming,
at a stated moment, that no such instance remains. `webhookSecretReadiness()` deliberately reports
**no** field named `releaseTwoReady` or `safeToCutover` (pinned by test `E29`), precisely so that a
healthy-looking report cannot be mistaken for this confirmation.

**`legacyOnly == 0` describes the rows. It says nothing about which code is running.**

---

## 1. Merge

| Field | Value |
|---|---|
| Phase 1 merge SHA | `a9a72463d33e6a0dc9d4706a204c7a07554470f9` |
| PR | #50 |
| `main` at merge | `a9a7246` |
| Merge-commit CI | _(success / link)_ |

## 2. Key provisioning

`LEASEOS_KEY_WEBHOOK_V1` — 64 hex characters. **Record only that it is present, never its value.**

| Environment | Provisioned | Confirmed by | Date |
|---|---|---|---|
| production | ☐ | | |
| staging | ☐ | | |
| _(other)_ | ☐ | | |

Backfill and canonical resolution refuse without it. A legacy-only deployment is unaffected — test
`E13` pins that a missing canonical key does not stop legacy-only signing.

## 3. Deployment

Every instance that can **read a webhook subscription** must be listed: application servers and
background workers alike. A worker running the retry sweep is as capable of reading a canonical-only
row as a web instance, and is easier to forget.

| Environment | Component | Version / image | Deployed at (UTC) |
|---|---|---|---|
| | application | | |
| | worker | | |

## 4. Convergence confirmation — the critical fence

| Field | Value |
|---|---|
| No pre-Phase-1 instance remains | ☐ confirmed |
| How it was confirmed | _(deployment tooling report, instance inventory, rollout dashboard — name the source)_ |
| Confirmed by | |
| Confirmed at (UTC) | |

State the *method*, not just the conclusion. "The deploy finished" is not confirmation: a finished
rollout can leave a stuck instance, a paused worker, or a manually-started process behind.

## 5. Backfill

Run `migrateWebhookSecrets` until it reports complete. It is idempotent and resumable, so running it
more than once is safe and expected.

| Field | Value |
|---|---|
| Run at (UTC) | |
| `scanned` | |
| `migrated` | |
| `failed` | |
| `complete` | ☐ |
| Failures — subscription refs and reasons | _(refs and reasons only; never a secret)_ |

Any failure means that subscription is **still signing on legacy ciphertext and still delivering**.
It is not an outage; it is an unmigrated row. Resolve each before Phase 2.

## 6. Readiness report

Output of `webhookSecretReadiness()`. Counts only.

| Field | Value | Required for Phase 2 |
|---|---|---|
| `total` | | — |
| `enabled` | | — |
| `legacyOnly` | | **0** |
| `transitional` | | — |
| `canonicalOnly` | | **0** — Phase 1 produces none; a non-zero value means something wrote a row it should not have |
| `invalidBothNull` | | **0** |
| `enabledUnsignable` | | **0** |
| `noEnabledLegacyDependence` | | **true** |

A non-zero `canonicalOnly` before Phase 2 is a **stop**, not a rounding error: normal creation cannot
produce it and the backfill cannot produce it, so it means either Phase 2 code reached an
environment early or something wrote outside the service.

## 7. Rollback plan in force

| Field | Value |
|---|---|
| `secretEnc` retained for every subscription | ☐ confirmed |
| Revert target SHA | _(the commit preceding the Phase 1 merge)_ |
| Rollback tested / accepted as understood | ☐ |

Reverting Phase 1 is safe for exactly as long as `secretEnc` is retained: the previous release reads
every row and signs identically, so **no webhook receiver reconfigures anything**. Clearing that
column is a separate, separately-approved checkpoint and must not be folded into Phase 2.

---

## Phase 2 authorisation

Phase 2 may be requested only when **all** of the following are recorded above:

1. ☐ merge SHA and merge-commit CI recorded;
2. ☐ `LEASEOS_KEY_WEBHOOK_V1` provisioned in every environment;
3. ☐ Phase 1 deployed to every webhook-capable application **and worker** instance;
4. ☐ **deployment convergence confirmed, with the method named, by a person, at a stated time**;
5. ☐ backfill run to `complete`, with every failure resolved;
6. ☐ readiness report meeting every "required" value in §6;
7. ☐ rollback plan in force, with `secretEnc` retained.

| | |
|---|---|
| Requested by | |
| Date | |
| Authorised by | |

**Item 4 is the one that cannot be automated.** Everything else on this list is a number a machine
can produce; that one is a judgement about the world, and it is the reason this record exists.
