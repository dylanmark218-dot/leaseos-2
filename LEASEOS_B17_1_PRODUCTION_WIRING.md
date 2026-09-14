# LeaseOS — B17.1: Production Workflow Wiring

**Status:** **425 tests, 21 files, zero failures.** 80 tables · 16 migrations · typecheck clean.

---

## 1. Phase 0 is completely closed

Prettier ran as its own isolated pass, exactly as §26 asked — no logic changes mixed in, so the diff
is reviewable as pure formatting.

| | Before | After |
|---|---|---|
| Longest line | **11,259 chars** | **529** |
| BillingSafetyWorkspace | 11,259 | reflowed |
| RouteSafetyWorkspace | 9,673 | 276 |
| ComplianceEngine | 9,665 | reflowed |

Verified behaviour-preserving: typecheck clean before and after, **391 tests identical on both
sides**. That baseline-then-compare is the only thing that makes a mass reformat safe to accept.

Every Phase 0 item from the original audit is now done.

---

## 2. Rules are source-controlled, and released versions are immutable

`server/_core/workflowSeeds.ts` holds the four reference workflows as real versioned rules, not
fixtures. What a developer reads is what production runs.

`planSeedSync` compares seeds against what is released and **refuses to overwrite a released
version whose content changed**:

> `fleet.critical_defect.opened.v1` is already released with different content.
> Publish v2 instead of editing a released rule.

A task created last month must still be explainable by the rule that created it. Editing a released
rule silently rewrites history.

**The coordination boundary is asserted by a test**, not just documented: the complete set of action
kinds across all seeds is `create_task · invalidate_eligibility · mark_at_risk · notify ·
reevaluate · close_workflow`. **No action sets a domain verdict.** Adding one would fail that test.

---

## 3. Emission cannot outlive its transaction

`emitDomainEvent(tx, …)` takes the caller's transaction and never opens its own. An event published
outside the transaction that produced it can be lost — or worse, describe a state that rolled back.
A failed insert propagates, so the whole operation fails together.

A missing `correlationId` roots a new chain **at the event itself**, so every event belongs to
exactly one chain and "why did this happen?" is always answerable by walking causation backwards.

---

## 4. Loop protection, two independent mechanisms

**Before emitting:** `isMeaningfulChange` compares only the fields that matter. The loop it prevents
is the obvious one — assignment re-evaluated → "updated" → rule triggers re-evaluation → forever.
A re-evaluation that produced the same verdict emits nothing.

**After emitting:** `traceCausation` walks the chain and reports `runaway: true` on a cycle or past
depth 12, rather than following it. `guardCausationDepth` refuses to emit a further descendant at
the limit.

Comparing state before emitting is cheaper and more honest than detecting a cycle once it is
already spinning.

---

## 5. The worker fails visibly

`startDrainWorker` — batch claim, process, mark, sleep. Six behaviours tested:

| Behaviour | Why it matters |
|---|---|
| Processes a batch, marks each done | The happy path |
| Retries below the attempt limit | Transient faults are not fatal |
| Dead-letters at the limit **and logs it** | A poison event becomes an administrative problem, not a silent one |
| Survives a claim failure and keeps polling | Infrastructure trouble is not a bad event — one lost connection must not kill the worker |
| Stops gracefully | `stop()` finishes the current pass rather than abandoning claimed work |
| Idles longer than it polls | The loop never spins hot on an empty queue |

Backoff is exponential **with full jitter**. Without jitter, several workers that fail together
retry together, in lockstep, forever.

`assessQueueHealth` returns `degraded` whenever anything is dead-lettered — regardless of how fast
the queue is moving. A fast queue with abandoned events is not healthy.

---

## 6. Status

| | |
|---|---|
| Tests | **425 across 21 files, 0 failures** |
| Engines | 17 pure + 4 database-backed suites |
| Tables | 80, parity verified |
| Typecheck | **clean** |
| Longest source line | 529 (was 11,259) |

---

## 7. What §28 still does not have

Being precise, because the definition of done is specific and I have not met all of it.

**Done:** rules are source-controlled and versioned · emission is transactional · loop protection ·
worker with backoff, dead-lettering and graceful shutdown · responsibility routing · queue health.

**Not done:**

- **No domain service calls `emitDomainEvent` yet.** The emitter is proven; nothing in
  `dispatchTransaction.ts`, the defect flow or disposal reconciliation calls it. This is the single
  biggest remaining gap and it is the obvious next step.
- **`planSeedSync` is not executed at startup** — the plan is computed and tested, but no bootstrap
  runs it against `workflowRules`.
- **No worker process.** `startDrainWorker` has ports and tests; nothing wires it to the database
  and runs it as a service.
- **Notification delivery** is still records only — no channel.
- **No end-to-end integration test** from a real domain mutation through to a created task. The
  chain is proven in halves: seeds → engine → tasks in unit tests, and outbox → worker → task
  against the database. Not yet joined.
- Sections on retention, replay tooling, admin UI and Action Gateway are untouched.

So: the **machinery** is built and its hard guarantees are proven. The **wiring into real
operations** is not. Calling this "production workflow wiring" complete would overstate it.

---

## 8. Next

1. `emitDomainEvent` from the three flows that matter: critical defect, disposal reconciliation,
   dispatch invalidation
2. Seed bootstrap running `planSeedSync` on startup
3. Worker as a real process against the outbox
4. One end-to-end test: real mutation → outbox → worker → task → notification
5. Then the Action Gateway

Item 4 is the one that closes §28. Everything before it is preparation for being able to write it.
