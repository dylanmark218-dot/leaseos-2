# LeaseOS — B17: Workflow Orchestration Core

**Status:** **386 tests, 20 files, zero failures.** 80 tables · 16 migrations · **typecheck clean**.

```
EVENT → POLICY → CONSEQUENCES → TASKS → OWNER → NOTIFY
      → ACTION → RE-EVALUATION → CLOSE → AUDIT
```

---

## 1. Phase 0 is closed

`TripOperationsWorkspace.tsx(77,846)` — tracked since the very first audit — is fixed.

The cause was `odometerKm: trip.odometerEndKm`, where `odometerEndKm` is a nullable column
(`number | null`) and the mutation input expects `number | undefined`. The correct fix is
`?? undefined`, not a cast: a null closing odometer means **not recorded**, which should be omitted
rather than sent as an explicit null.

**Typecheck is now clean — zero errors.** Only Prettier remains from Phase 0.

---

## 2. The boundary this engine must not cross

> **Workflow rules coordinate. Domain engines decide.**

Nothing here judges whether a truck is mechanically safe, a route is legal, a TDG classification is
right or an invoice is valid. It reacts to what the domain engines already decided, works out who
needs to act, and tracks it until resolved.

Enforced structurally: `ConsequenceAction` can create tasks, invalidate eligibility, mark at-risk,
notify and request re-evaluation. There is **no action that sets a domain verdict.**

---

## 3. Deduplication — one condition, one task

`buildDedupeKey` keys on **rule + task type + subject**, not on the event. A defect re-reported
three times produces one shop task, not three. Once completed, the same condition can open a fresh
one.

Root-cause grouping means an expired inspection shows as *one* problem with its consequences
attached, rather than four unrelated alerts:

```
VAC-12 annual inspection expired          ← root, owner: mechanic
  └─ 2 assignments at risk                ← consequence
```

---

## 4. "Completed" must not mean "stopped being visible"

`REQUIRE_EVIDENCE` covers renewals, mechanic release, disposal tickets, document verification and
critical defects. `canCompleteTask` refuses to close those without an evidence reference.

A renewal task closes because a **verified document exists**, not because somebody got tired of
seeing it.

---

## 5. Transitions are guarded, and AI cannot pass an evidence gate

`attemptTransition` refuses `reported → closed` on a critical defect and says where you *may* go
instead. Terminal states are dead ends.

Two rules worth stating:

- Evidence-gated transitions (test → mechanic_release, document_received → human_verify) refuse
  without a reference.
- **AI cannot satisfy an evidence gate at all** — even holding a valid reference. It may advance
  ungated steps; it may not certify. Tested both ways.

---

## 6. Explanation is deterministic

`explainTask` assembles the answer to *"why am I seeing this?"* from stored workflow evidence with
**no model involved**:

> Because unit VAC-12 raised unit.inspection_expired at 2026-09-03 08:00. This caused: Unit
> dispatch status → blocked; JOB-8851 assignment → at risk. Rule: fleet.inspection.expired.v1
> Source: INS-2025-2291

AI may translate this into plainer language. It must never be the source of it — an explanation
that can hallucinate is not an explanation. Tested for identical output on repeated calls.

---

## 7. Proven against a real database

10 orchestration tests, plus the 8 dispatch concurrency tests from B16.

| Claim | Result |
|---|---|
| State change and event commit together | ✅ |
| Rollback loses both, never one | ✅ |
| Duplicate eventId refused | ✅ |
| **Two workers, one event → processed once, one task** | ✅ |
| **Four workers, one event → still once** | ✅ |
| Two workers, two events → both proceed in parallel | ✅ |
| Replay creates no second task | ✅ |
| Completed task allows a fresh one | ✅ |
| Workflow history append-only | ✅ |
| Duplicate notification key refused | ✅ |

Contention uses `SELECT … FOR UPDATE SKIP LOCKED` with a 120–150 ms delay held **inside** the
transaction, between claim and work.

---

## 8. Three bugs, all mine, all found by running things

**`maintenanceDefects` has no `description` column** — it has `title`, NOT NULL. My test invented a
column. Schema assumptions are worth exactly nothing until executed.

**The race test wasn't isolating the outbox.** Both workers "won" because worker B legitimately
claimed a *different* leftover event from an earlier test. The engine was correct; the test proved
nothing. Contention tests now scope to a specific `eventId`, so they genuinely contend for one row.

That one is worth dwelling on: a concurrency test that passes for the wrong reason is worse than no
test, because it retires the question.

**A hardcoded `74` in the migration-integrity test.** Rather than bump it to 80, it now derives the
expected count from `schema.ts`. A test that needs hand-editing on every schema change gets
hand-edited carelessly.

---

## 9. What is not built

Honest scope. The spec has 24 sections; this checkpoint delivers the core, not all of it.

- **Rules are not yet seeded** — the engine evaluates them, but no production rules exist in
  `workflowRules`. The four reference workflows are defined as state machines, not yet wired
  end-to-end to live domain events.
- **No domain emitters.** Nothing yet writes to `domainEventOutbox` from real operations.
- **No drain worker.** The claim/process logic is proven in tests; it isn't running as a service.
- **Action Gateway not started.** Deferred deliberately — it belongs on top of a working bus.
- **Notification delivery** is records only; no channel is wired.

B17 is the foundation with its hardest guarantees proven. It is not yet the finished orchestration
layer, and the definition of done in §24 is not met.

---

## 10. Next

1. Seed the four reference workflows as real rules and emit their events from domain services
2. Drain worker running against the outbox
3. Action Gateway, then the AI Skill Registry on top
4. Prettier (last Phase 0 item)

The rule from B16 held again this pass, three times over:

> A migration that has not run is untested. A concurrency mechanism that has not faced concurrency
> is untested. **And a concurrency test that passes for the wrong reason is worse than none.**
