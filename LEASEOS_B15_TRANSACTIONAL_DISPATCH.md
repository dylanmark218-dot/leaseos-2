# LeaseOS — B15: Transactional Dispatch Backend

**Status:** engines built and tested. **261 tests across 13 engines**, all green.
**Companion to:** `LEASEOS_B14_DISPATCH.md`

---

## 1. The two additions that close real holes

### 1.1 Dependency fingerprint — freshness alone was not enough

B14 made eligibility time-fresh. That was insufficient, exactly as identified: a check run five
minutes ago is worthless if the truck failed an inspection four minutes ago.

Every eligibility check now carries a **dependency fingerprint** over the facts it relied on:

```
valid = withinFreshnessWindow AND fingerprintUnchanged
```

`EligibilityFacts` is deliberately explicit rather than hashing whole rows — a cosmetic edit to an
operator's phone number must not force re-evaluation, while a licence expiry change must. It
covers: operator credentials, HOS, unit status, critical defect count, mechanic release, trailer
status, job classification, material classification, permit, destination acceptance and route
decision.

`assessEligibilityValidity()` reports **why** a check was invalidated — `age` or
`dependency_change` — because they mean different things to a dispatcher. One is routine; the
other means something material happened. When both apply, dependency change is reported, since
that's the more important fact.

The 30-minute window is now explicitly a **maximum reuse window, never permission to ignore a
change**.

### 1.2 Pre-departure gate — assigned ≠ released to depart

Agreed this was the last hole. An assignment made Tuesday says the work is *scheduled*; it does not
say the truck is safe to leave the yard Thursday.

```
Match → Bid → Award Gate → Scheduled Assignment → PRE-DEPARTURE GATE → Dispatched
```

`evaluatePreDeparture()` returns `released` / `at_risk` / `blocked`, and `releasedToDepart` is true
**only for the final mandatory check immediately before departure**. An earlier lead-time check that
passes says "still on track", not "cleared to go" — there's a test for that specifically.

A post-award blocker moves the assignment to **AT RISK and notifies dispatch** rather than silently
cancelling it. Someone has planned their day around that work, and the right response is often to
fix the condition, not scrap the job.

Checkpoints at 24 h / 4 h / 1 h / immediate, with the zero-hour check mandatory and not satisfiable
by any earlier pass.

---

## 2. The award transaction

`server/_core/dispatchTransaction.ts` — the client never creates an assignment. It **requests** one;
the server decides.

Three concurrency layers:

1. **`SELECT … FOR UPDATE` on the posting row** — serialises award attempts on the same posting.
2. **Overlap re-check inside the lock.** Checking before the lock would be a
   time-of-check/time-of-use race — the classic way two dispatchers both "succeed".
3. **Idempotency key** — a retried request resolves to the existing assignment rather than creating
   a second one.

All-or-nothing within one transaction: role assignment, resource bookings for operator/unit/trailer,
`usedForAward` marking, bid and invitation state updates, staffing recalculation, posting state
transition, and the audit event.

**Refused attempts are written before the rollback.** An attempt to dispatch a unit with an open
critical defect produces an `assignment_blocked` audit row with the named refusals, even though
everything else rolls back.

---

## 3. Two bugs the typecheck caught

**Posting state enum didn't carry the lifecycle.** B14 shipped `tentative / awaiting_customer /
awaiting_permit / … / posted / awarded`, which cannot express the B15 machine. Fixed by separating
two things that were conflated:

- `planningState` — where the posting is in its life (`draft → planning → open_for_bid |
  invite_only | on_call | direct → bid_closed → awarding → partially_staffed → staffed →
  dispatched → in_progress → completed`, plus `cancelled`)
- `planningBlocker` — *why* it's stuck (`awaiting_customer`, `awaiting_permit`,
  `awaiting_classification`, `weather`, …)

"Where is this posting" and "why is it stuck" are different questions. Conflating them made the
state machine unrepresentable.

**No fingerprint column existed** for the mechanism in §1.1. Added as `NOT NULL` — and a row
without one is treated as `"MISSING"`, which fails comparison, so a legacy check is invalid rather
than accidentally valid.

Both fixed in migration 0013 **in place**, since it was written this session and has never been
applied anywhere. If you've run it locally, drop the dispatch tables before re-running.

---

## 4. Lifecycle behaviours

**Offline bids.** A bid prepared offline stays a draft until the server acknowledges it. When it
finally arrives the posting may have closed — `acknowledgeOfflineBid()` fails it with the reason,
so an expired posting never receives a retroactively "successful" bid.

**Multi-role staffing.** A posting is `staffed` only when every **required** role is filled;
optional support roles don't hold it back. A rig move is one posting with independently gated roles
for lead, winch tractors, bed truck, picker, lowboy and pilots — **no special-casing by job type**.
`assessStaffing()` names the outstanding roles rather than reporting a count.

**On-call rotation.** `advanceRotation()` skips declined / no-response / unavailable entries in
position order and reports **exhaustion explicitly** — "Escalate to dispatch" — rather than
silently returning nobody. Prior responses are retained, so who was asked survives.

**Rate visibility as a matrix, not a boolean.** Employee sees own compensation but not customer
rate; contractor may submit a price; customer rate hidden from every operator; internal margin
restricted to office roles and **not** dispatchers. Kept structurally separate from eligibility —
what someone may see about money has no bearing on whether they may be assigned work.

---

## 5. B14 invariant preserved

A match score cannot reach `decideAward()`. It is not a parameter. The chain is:

```
MATCH (score, visibility)  ≠  BID (willingness)  ≠  ELIGIBILITY (verdict)  ≠  AWARD (permission)
```

Tested: a granted override of a **non-overridable** blocker is still refused at award time, even if
one was somehow recorded upstream. Belt and braces against a bad write.

---

## 6. Honest limits

**The award transaction cannot be tested in this environment.** It needs a live MySQL instance for
`SELECT … FOR UPDATE` to mean anything — the 13 pre-existing failures in `server/fieldroute.test.ts`
are the same constraint (Phase 0 item 4).

The concurrency tests you asked for — two simultaneous awards produce one winner, two jobs
reserving the same truck for overlapping periods — **are not written**, because a test that can't
run proves nothing and a passing stub would be worse than nothing. They need:

1. `DATABASE_URL` pointing at a disposable MySQL
2. Migrations applied
3. Two genuinely parallel connections, not sequential awaits

The *decision* logic underneath is fully tested (26 tests in `dispatchAward.test.ts`) — what remains
untested is whether MySQL's locking behaves as expected under real contention. That's a real gap and
it should be closed before dispatch goes live, not after.

**Not yet built:** `db.ts` helpers and the tRPC dispatch router. The transaction module is the hard
part and it's done; wiring is mechanical but not free.

---

## 7. Status

| Engine | Tests |
|---|---|
| geofence · tracking · billing · fieldTicket · disposalReconciliation · taxonomy | 94 |
| routingCompiler · routeEvaluation · dataIngestion | 62 |
| dispatchMatching · dispatchReadiness | 42 |
| **dispatchAward · dispatchLifecycle** | **63** |
| **Total** | **261** |

71 tables · 14 migrations, parity verified. Typecheck: 1 pre-existing error
(`TripOperationsWorkspace.tsx(77,846)`, Phase 0 item 3, untouched).
Full suite: 13 failures, all in `server/fieldroute.test.ts`, all requiring `DATABASE_URL`.

**Dispatch is not complete.** Database helpers, router, authorization wiring, production UI and the
concurrency tests all remain.

---

## 8. Next

Per your sequence — B16 notifications + recurring work, B17 dispatch map on the B13 road graph,
B18 subcontractor marketplace. Before any of those:

1. `db.ts` + tRPC dispatch router
2. A disposable MySQL in CI so the award transaction and the 13 existing DB tests can actually run
3. Concurrency tests against it
