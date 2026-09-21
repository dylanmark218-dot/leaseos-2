# LeaseOS — B19: The Chain, Joined

**Status:** **472 tests, 23 files, zero failures.** 87 tables · 17 migrations · typecheck clean.

**§28's definition of done is now met.** A real domain mutation produces a real task through the
real released rule set.

---

## 1. What was missing, and now is not

Two checkpoints deferred the same thing, and I flagged it as compounding:

> B17.1: *"No domain service calls `emitDomainEvent` yet. The emitter is proven; nothing calls it."*
> B18: *"Not wired to the workflow engine. Neither emits an event yet — the same gap as B17.1."*

The chain had been proven **in halves**: seeds → engine → tasks in unit tests, and outbox → claim →
mark against the database. Never joined. An event bus with no publishers is scaffolding.

Three pieces close it:

| File | Role |
|---|---|
| `domainEmitters.ts` | Typed emitters the operational flows call inside their own transactions |
| `workflowRuntime.ts` | Seed bootstrap, rule loading, event → task application, database-backed worker ports |
| `workflowEndToEnd.test.ts` | 12 integration tests proving the whole path |

---

## 2. The end-to-end proof

All 12 passed on the first run.

| Test | What it proves |
|---|---|
| Real defect → mechanic task + dispatcher consequence | The full path, including root-cause grouping |
| Notification queued for the owning role | Ownership resolves from configuration, not from the rule |
| Same defect reported 3× → still 2 tasks | Dedupe holds against the **database**, not an in-memory guess |
| Advisory defect → nothing | Conditions are evaluated from released rules |
| Disposal ticket missing → driver task | Names the specific evidence |
| Facility issues no tickets → **no event at all** | Requirement-awareness starts at the emitter |
| Verdict moved → dispatcher task | Invalidation reaches a person |
| **Verdict unchanged → no event** | The loop guard, proven in the real path |
| Rollback → no event, no task | Transactional integrity |
| Unmatched event → processed, not retried forever | An event with no rule is not poison |

The two `null` returns matter most. `emitDisposalTicketMissing` refuses to emit for a facility that
issues no tickets, and `emitAssignmentAtRisk` refuses when the verdict did not move. Both are the
difference between a system that works and one that generates noise or feeds itself.

---

## 3. Decisions worth recording

**Dedupe is decided against the database.** `applyEventConsequences` reads existing open tasks for
the subject before planning. An in-memory check would let two workers on two events for the same
unit both create a task.

**Notification keys are derived** from `dedupeKey|role`, so a redelivered event cannot notify twice.
The duplicate insert is caught and ignored — the owner has already been told.

**Only the newest released version of each rule applies.** `loadRules` orders by version descending
and keeps the first per key. Old versions stay for explaining old tasks; they do not fire.

**A dead letter keeps its claim.** `markFailed` releases the claim for a retry but deliberately
leaves it set on a dead letter, so a poison event stops circulating and surfaces to an administrator
instead of being re-claimed every poll.

**Emission is guarded by causation depth** in every emitter, so a rule set that accidentally feeds
itself stops rather than cascading.

---

## 4. Status

| | |
|---|---|
| Tests | **472 across 23 files, 0 failures** |
| Pure engines | 19 |
| Database-backed suites | 4 (`fieldroute`, `dispatchConcurrency`, `workflowOrchestration`, `workflowEndToEnd`) |
| Tables | 87, parity verified |
| Migrations | 17, all applied clean |
| Typecheck | clean |
| Longest source line | 529 |

---

## 5. Still not built

- **No tRPC routers** for workflow, tasks, adjustments or disputes. The engines and runtime exist;
  the API surface does not.
- **No worker process.** `createWorkerPorts` + `startDrainWorker` are proven together against the
  database, but nothing runs them as a service — no entrypoint, no supervision, no shutdown hook.
- **Notification delivery** is still records only. No channel is wired.
- **B18 is not emitting yet.** `emitInvoiceDisputed` and `emitCalloutAuthorityUnverified` exist and
  are typed, but no rule matches them — the end-to-end test confirms they are processed harmlessly
  rather than creating tasks. Adding those two rules is a small, well-defined next step.
- Action Gateway and AI Skill Registry untouched.

---

## 6. Next

1. Two rules for the B18 events, so a disputed invoice and an unverified callout raise tasks
2. Worker entrypoint with supervision and graceful shutdown
3. tRPC routers for tasks and adjustments
4. Notification delivery for at least one channel

---

## 7. Note on the pasted documents

Three consecutive pasted documents have arrived **empty** — no content reached me in any of them.
Every *file upload* has come through fine, so saving the spec as `.md` and attaching it as a file is
the reliable route.

I proceeded with this work because it was already identified as the priority and did not depend on
the missing spec.
