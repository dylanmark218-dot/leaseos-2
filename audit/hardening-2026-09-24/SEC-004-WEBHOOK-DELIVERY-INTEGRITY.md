# SEC-004 — webhook delivery integrity

Branch `claude/sec-004-webhook-delivery-integrity`, based on `main` at `6f52b57`. Separate from
the Wave 1 hardening PR (#19) and from the Integration Hub branch.

## The race

Webhook dispatch has three callers that can run at the same moment: the drain worker (for the
event it just processed), the heartbeat retry sweep, and the office's `integration.webhookDispatch`.
There can also be more than one worker process. Each caller:

1. read the latest attempt row for (subscription, event);
2. computed attempt n+1;
3. **POSTed it**;
4. then inserted the attempt row.

Two callers could both reach step 3 for the same attempt. `UNIQUE(subscriptionId, eventId, attempt)`
(migration 0054) stopped the second *row*, but only at step 4, after the consumer had already
received the request twice. The loser threw, and the database showed a single attempt.

**Why the unique key was not enough:** it constrains what is recorded, not what is sent. The
request went out before the constraint was consulted.

## Deterministic reproduction

On `main`, two `dispatchWebhooks` calls for one event, run concurrently, with a transport that
takes 200 ms (a scratch test, not committed):

| | Result |
|---|---|
| POSTs received by the consumer | **2** |
| Rows in `webhookDeliveries` | **1** (`attempt 1, delivered`) |
| Losing dispatcher | **rejected**: `Failed query: insert into webhookDeliveries …` (ER_DUP_ENTRY) |

`server/webhookDeliveryClaim.db.test.ts` was written before the fix and run against `main`'s
code: **12 of 12 failed**. The race test failed with the losing dispatcher rejected. Tests that
need the claim columns failed on "Unknown column 'claimedAt'". Five failed before reaching the race
at all, on the fragility described under "Also fixed".

Because the double send leaves one row, **no query over existing data can find past
occurrences**. The only trace is the worker log line
`[worker] webhook dispatch failed … Duplicate entry`.
`scripts/preflight/sec004-webhook-delivery-duplicates.sql` (read-only) checks everything data
*can* show. It has been run only against local test databases. **Production has not been
inspected**, and nothing here claims production data is clean.

## Identity

- **Logical delivery:** `(subscriptionId, eventId)`.
- **Attempt:** `attempt`, one row each, 1..n. A retry is a new row with the next number; that is
  legitimate and unchanged.
- **Uniqueness:** `UNIQUE(subscriptionId, eventId, attempt)`, unchanged. SEC-004 adds no second
  uniqueness model; it uses this one as the claim.

## Schema change: migration 0185

`drizzle/0185_webhook_delivery_claim.sql` adds two NULL-able columns to `webhookDeliveries`:
`claimedAt timestamp NULL` and `claimedBy varchar(64) NULL`. No data is rewritten, and no
constraint or index is added or changed.

**Number:** `0185`. Chosen by scanning `origin/main` and all 57 remote refs immediately before the
file was written. The highest number any of them held was `0184`. Recorded in
`docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

No index was added. Stale claims are found by `status = 'queued'`, and only in-flight attempts
are in that state.

## States

As stored in the existing enum (0054: `queued, delivered, failed, dead`). No state was added or
renamed.

| Status | Meaning |
|---|---|
| `queued` | **Claimed and in flight.** Always written with `claimedAt`/`claimedBy`. The enum has had it since 0054, but nothing wrote it for webhooks until now, and no document gave it a meaning (both checked). |
| `delivered` | 2xx received. Terminal. |
| `failed` | Retryable; `nextAttemptAt` is when the next attempt becomes due. |
| `dead` | Attempts exhausted (`MAX_ATTEMPTS`). Terminal; "a person re-queues it". |

```
(none) ──CLAIM: INSERT 'queued' + claim──▶ queued ──FINISH (guarded)──▶ delivered | failed | dead
queued, lease expired ──RECLAIM (guarded UPDATE)──▶ queued (new owner, SAME attempt)
failed, nextAttemptAt due ──CLAIM attempt+1──▶ queued
```

A `queued` row with `claimedAt` NULL (none should exist; preflight section 6 reports any) is
treated as an expired claim.

## The claim algorithm

Claim first, commit the claim, send second, record third. `server/webhookDispatchService.ts`
exports each step, so every sender uses one definition:

- **`claimNewAttempt`**: `INSERT` the attempt row as `queued` with `claimedAt`/`claimedBy`. The
  unique key lets exactly one concurrent INSERT succeed. The others get `ER_DUP_ENTRY`, return
  `null`, and **send nothing**. The insert autocommits, so the claim is durable before the request
  leaves, and **no transaction is held across the POST**.
- **`reclaimExpiredAttempt`**: `UPDATE … SET claimedAt = leaseNow, claimedBy = token WHERE id = ?
  AND status = 'queued' AND (claimedAt IS NULL OR claimedAt <= leaseNow − lease)`, succeeding only
  if exactly one row changed. InnoDB re-evaluates the predicate against the locked row, so of two
  recoverers exactly one wins.
- **`finishClaimedAttempt`**: `UPDATE … WHERE id = ? AND status = 'queued' AND claimedBy = token`.
  A worker whose claim expired and was taken over changes no row. Its result is reported as
  `claim_lost` and the recovering worker's outcome stands. `claimedAt`/`claimedBy` are kept on
  finished rows, recording who sent each attempt.

No process-local lock is involved; the database decides.

## The lease

**`WEBHOOK_CLAIM_LEASE_MS` = 5 minutes.** What it had to exceed:

- **Attempt timeout.** On `main` the default transport had **none** (`fetch` with no signal), so no
  lease could be safe. It now has `WEBHOOK_ATTEMPT_TIMEOUT_MS` = 10 s (`AbortSignal.timeout`), the
  same value PR #19's outbound client uses for webhooks. The lease is 30× that.
- **Margin** for the two DB writes around the POST, event-loop stalls in a busy worker, and clock
  skew between worker hosts. The lease is compared across processes, each on its own clock.
- **Recovery delay.** A crashed attempt waits at most 5 minutes, inside the existing retry
  schedule (1, 5, 30, 120, 720 min), so no new delay class is added.

The Integration Hub branch's 120 s was not copied. A unit test pins lease ≥ 10× attempt timeout,
so neither can be changed alone.

**Clocks.** `now` stays the scheduling clock (backoff, due-ness), which callers and tests already
supply. The lease uses `leaseNow`, which is **real time unless a test supplies it** and is never
taken from a request. `integration.webhookDispatch` accepts `now` from its caller; if the lease used
that value, a privileged caller could expire a live claim and cause a double send. Test 10 pins
that it cannot. The database's `NOW()` is not used anywhere in this path.

**`claimedBy`** is `"<workerId>#<12 hex random>"`, at most 64 chars. The worker id is
`host:pid` by default; the heartbeat passes its lifecycle worker id. It is opaque and used for
audit only: never a credential, never a secret (a unit test checks).

## Crash behavior

| Worker dies… | What happens |
|---|---|
| after CLAIM, before the POST | The row stays `queued`. Nobody takes it while the lease is live. After expiry, one recoverer reclaims it and sends the **same attempt**. Nothing was sent twice. (Test 9 & 14) |
| after the consumer received the POST, before FINISH | After expiry the same attempt is **sent again**, with the same `x-leaseos-delivery: <subscriptionRef>:<eventId>:<attempt>` and the same `eventId` in the body. (Test 15) |
| during the POST, then comes back after the lease | Its FINISH changes no row (`claim_lost`); the recovering worker's outcome stands. (Last test) |

**What is and is not guaranteed.** At most one worker holds an attempt at any time, and a live
claim is never taken. That removes every *concurrent* duplicate. **Exactly-once receipt across a
network boundary is not achievable by any lease:** if the consumer accepts the POST and the worker
dies before recording it, LeaseOS cannot know it was received. The semantics are therefore
**at-least-once, with no concurrent duplicates, and a stable delivery id for consumer-side
deduplication**. Consumers should deduplicate on `x-leaseos-delivery` (per attempt) or `eventId`
(per event). Both existed before this change and are preserved. No header was added.

## Tenant isolation

Unchanged, and tested (test 11):

- A subscription only ever receives its own tenant's events (`ev.tenantId === s.orgRef`).
- A dispatch scoped to organization A, naming B's event, claims and sends nothing.
- Every claimed row carries the subscription's `orgRef`.
- `sweepWebhookRetries` gained an optional `orgRef` to scope a sweep to one tenant. The worker's
  sweep stays global.

## Also fixed (found while testing)

**One undecryptable subscription stopped all webhook dispatch.** `dispatchWebhooks` decrypted
every active subscription's secret before looking at events. A single subscription encrypted
under another key (a rotated key, a restored row) threw, and the whole call failed for every
tenant. `main`'s own suites hit this whenever their subscriptions overlapped in one database. A
secret is now decrypted only when that subscription has an attempt to claim, and a failure skips
that subscription with a warning. Scope was kept narrow: no dead-lettering, which is the Hub
branch's feature.

## Tests

`server/webhookDeliveryClaim.db.test.ts`: 3 pure cases plus 12 against real MariaDB, through the
real dispatcher.

| # | Case | Result |
|---|---|---|
| 1–4 | Two workers race for one new attempt: one claim, **one POST**, one row, loser does not throw | pass |
| — | Five concurrent workers: one POST | pass |
| 5 | Delivered attempt never reclaimed, alone or under a race | pass |
| 6–7 | Retryable failure waits for backoff; two racing sweeps send attempt 2 once | pass |
| 8 | Dead delivery not resent by dispatch or sweep | pass |
| 9 & 14 | Crash after claim, before send: recovered after expiry, same attempt, one POST between two racing recoverers | pass |
| 10 | Live claim not stolen by dispatch, sweep, or a future scheduling clock | pass |
| 11 | Organization A cannot claim or send B's delivery | pass |
| 12 | Duplicate (subscription, event, attempt) row still refused (`ER_DUP_ENTRY`) | pass |
| 13 | Different deliveries proceed concurrently: two workers, two events, one POST each | pass |
| 15 | Crash after receipt, before record: resent once with the **same** delivery id (at-least-once, documented) | pass |
| — | A worker that overran its lease cannot overwrite the recovering worker's outcome (`claim_lost`) | pass |
| unit | Lease ≥ 10× timeout; lease boundary; token format, uniqueness, length, no secret | pass |

The existing webhook suites (`integrationGateway`, `contractTerms`: signing, backoff schedule,
dead after six, worker send, heartbeat sweep) pass unchanged.

**Isolation from the rest of the gate.** The gate runs every file at once against one database.
This suite's scheduling and lease clocks are set in 2035 (every other suite runs in 2026), its
sweeps are tenant-scoped, and it revokes its subscriptions after each test. So no other suite's
sweep finds this suite's rows due or claims expired, and this suite never touches theirs.

**Pre-existing, not changed here:** `integrationGateway.test.ts` fails when re-run against a
database it has already used, on `main` too (2 failures on `main`'s code, 1 on this branch's, over
the same three runs). It passes on a fresh database, which is what the gate uses.

## Gate evidence

`scripts/ci-gate.sh`, full, MariaDB 10.11, fresh database: see the PR for the result on the final
commit. It includes clean-database migration through 0185, table and column parity, application
and test-file typecheck, the complete Vitest suite, the production build, and current-state
regeneration.

This branch is based on `main`, which fails its own gate on two pre-existing test problems that
PR #19 fixes. The **identical** test-only fixes are ported here in a separate commit, so either PR
can merge first.

**Dependency audit** on this branch reads `main`'s numbers (2 critical, 39 high). SEC-004 does not
touch dependencies; PR #19 is where they are fixed.

## Relationship to PR #19 — superseded; see "After landing" below

Written before either PR merged, this section expected PR #19's `outboundRequest` to become the
webhook transport. That is not what happened: `main` landed its own egress guard first, and the
webhook transport is `main`'s `egressPost`. The record of what happened follows.

## After landing (reconciliation record, 2026-10-01)

**Order.** PR #20 landed first, on 2026-09-25 (head `843d36a`, base `e291f28`), after another
session merged `main` into it (82 commits of drift; two bookkeeping conflicts; one duplicate
`calendarFixtures` key fixed; its comment on PR #20 has the detail). PR #19 stayed open and was
merged up to `main` three times: `791406d`, `5b2d8a0`, and `4c6a12d` (`main` = `b35bac4`).

**The combined transport, as it stands on `main` and on PR #19's head:**

| Invariant | State | Where |
|---|---|---|
| Only one worker claims an attempt | holds | `claimNewAttempt`; the unique `(subscriptionId, eventId, attempt)` |
| No send without the claim | holds | `dispatchWebhooks` continues past a `null` claim before calling the poster |
| Only the claim holder records | holds | `finishClaimedAttempt`, guarded by `claimedBy` |
| A live claim is not stolen; a stale one is recovered | holds | `reclaimExpiredAttempt`, `claimIsLive`, lease clock `leaseNow` |
| Attempt timeout | **10 s** | `WEBHOOK_ATTEMPT_TIMEOUT_MS`, passed as `timeoutMs` to `egressPost` |
| Lease | **5 min** | `WEBHOOK_CLAIM_LEASE_MS`; no evidence in the combined code argues for another value |
| SSRF guard on the send | `main`'s `egressPost` | resolves, checks every address, pins the socket to them; no redirects |
| SSRF check when the URL is saved | PR #19 (pending) | `checkEgressUrl` in `integration.webhookSubscribe` |
| Retries keep legitimate attempt numbers | holds | failed → `claimNewAttempt(attempt + 1)` |
| Tenant isolation | holds | `ev.tenantId === s.orgRef`; `orgRef` on every row and scoped sweep |
| Delivery semantics | **at-least-once** | one active sender per attempt; a crash after the consumer accepted a POST but before it was recorded re-sends the same `x-leaseos-delivery` id. Never "exactly-once". |

There is no direct `fetch` in the webhook path, and no second guard inside the webhook service.
PR #19's `outboundHttp.ts` was removed in its merge with `main`.

**Evidence on the combined tree** (`4c6a12d`): `scripts/ci-gate.sh`, full, fresh MariaDB 10.11,
Node 22.23.3: **PASS, gates 0a–8**. That's 442 files, **6,783 passed, 3 skipped**, with the
SEC-004 suite 15/15 inside the concurrent run. `pnpm audit`: 0 critical, 0 high, 3 moderate.

**Migration 0185**, rescanned 2026-10-01 across `main` and 116 remote refs: on `main` as
`0185_webhook_delivery_claim.sql`. One open PR still carries a conflicting
`0185_assistant_proposal_tenancy.sql`: **#93** (`copilot/fix-github-actions-job`, based on the old
`6f52b57`). Under the register's rule (first to merge keeps it), #93 must renumber before it lands;
`main`'s migration head is `0219`. `claude/relaxed-carson-qfcopf` no longer adds a 0185 file.

**Production preflight: not executed — no production database/log access.** It remains a human
deployment prerequisite: run `scripts/preflight/sec004-webhook-delivery-duplicates.sql` read-only,
and search worker logs for `webhook dispatch failed … Duplicate entry` from before 0185 deployed.

## Relationship to the Integration Hub branch

`claude/integration-hub-subsystem-6nzrkw` (commit `e430c0b`, no PR) contains an **older,
overlapping** implementation of the same fix, inside a much larger feature. It was used as a design
reference only; nothing was merged or cherry-picked. This change is intended as the canonical
implementation the Hub consumes. The Hub branch is untouched.

**Overlaps, and what the Hub keeps or drops when it rebases onto this:**

| In the Hub branch | Overlap | At its rebase |
|---|---|---|
| `0183`: `ADD COLUMN claimedAt`, `claimedBy` on `webhookDeliveries` | **duplicate** of 0185 | **drop** these two; its `0183` would otherwise fail with a duplicate column |
| `0183`: enum + `cancelled`, `superseded`; `retriedAt`, `outcomeClass`, `responseMetaJson`, `deadLetterId`, `correlationId`; `webhookDeliveries_due_idx` | additional | keep |
| `0183`: `webhookSubscriptions`, `inboundEvents`, `integrationClients`, sync tables | unrelated to SEC-004 | keep |
| `webhookDispatchService.ts`: `claimDue` (`UPDATE … SET claimedAt/claimedBy … LIMIT`) | **second claim implementation** | replace with `claimNewAttempt` / `reclaimExpiredAttempt` |
| its `finish` (`UPDATE … WHERE id = ?`, clears `claimedAt/claimedBy`) | **second finish; unguarded** | replace with `finishClaimedAttempt`. As written, a worker that overran its lease can overwrite the recovering worker's outcome, and the record of who sent is lost |
| `DELIVERY_LEASE_SECONDS = 120`, measured on the scheduling `now` | **second lease, on the wrong clock** | use `WEBHOOK_CLAIM_LEASE_MS` and `leaseNow`. As written, the office's caller-supplied `now` can expire a live claim |
| enqueue-then-attempt (`queued` rows written at enqueue, claimed later) | compatible model | may keep: a queued row with `claimedAt` NULL is exactly what `reclaimExpiredAttempt` accepts. But the failed→retry path should insert attempt+1 through `claimNewAttempt` |
| poster path with no attempt timeout | lease has no bound | bound it by `WEBHOOK_ATTEMPT_TIMEOUT_MS` |
| its claim test ("two concurrent workers send each attempt once; crashed claim ages out") | overlaps tests 1–4, 9, 14 | keep as Hub-level coverage once it calls the canonical primitives |
| destination policy (`assessDestination`), its own transport (`hubTransport`) | **second SSRF guard** | drop; use `main`'s `egressGuard` (`checkEgressUrl`) and `egressHttp` (`egressPost`) |
| circuit breaker, dead letters, connector health, sync contracts, retry policy per connector, `x-leaseos-event-id` header | additional | keep |

The result should be one claim implementation, here, and a Hub that calls it.

**Rebase plan as of 2026-10-01.** The Hub branch is still at `e430c0b` (2026-09-24), with no PR,
and does not contain `main`'s SEC-004. When it is next taken forward:

1. Merge `main` into it; do not rebuild it.
2. From its `0183`, delete the `claimedAt`/`claimedBy` columns (now from `0185`). Keep the rest.
3. Renumber `0182`–`0184` if needed: they are still free on `main`, but open **PR #99** also
   claims `0182`. Whichever lands second takes the next free number on `main` and every open branch.
4. In `webhookDispatchService.ts`, keep `main`'s file as the base. Re-add the Hub's enqueue step,
   dead-lettering, connector gating and health updates on top of `claimNewAttempt`,
   `reclaimExpiredAttempt` and `finishClaimedAttempt`. Remove `claimDue`, its unguarded `finish`,
   `DELIVERY_LEASE_SECONDS`, the claim timing taken from the scheduling `now`, and its
   timeout-less poster path.
5. Replace `assessDestination`/`hubTransport` with `main`'s egress guard.
6. Keep its claim test as Hub-level coverage, now exercising the canonical functions, and run
   `webhookDeliveryClaim.db.test.ts` unchanged as the contract.
