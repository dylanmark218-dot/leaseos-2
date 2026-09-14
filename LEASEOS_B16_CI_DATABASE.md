# LeaseOS — B16: Disposable database, and what it revealed

**Status:** **340 tests, 18 files, zero failures.** First time in this project's history that the
full suite has passed.

This closes the blocker I named at the end of B13, B15 and the assistant wiring pass, and which the
pasted priority list also puts at #1.

---

## 1. The migrations had never been executed

Fifteen migration files, 74 `CREATE TABLE` statements, written across five checkpoints — and until
this pass **not one of them had ever run.** Schema/migration parity was verified by counting, which
proves the numbers match, not that the SQL is valid.

Applied in order against MariaDB 10.11: **all 15 clean, 74 tables created.** No syntax errors, no
bad enums, no broken indexes. That was genuinely uncertain beforehand.

Worth stating plainly: applying a migration **is** a test. A migration that has never executed is an
assumption, not a schema.

---

## 2. The 13 "failing" tests were never broken

They were never *runnable*. With `DATABASE_URL` present: **15/15 pass**, unchanged.

I've reported them as failures in every checkpoint since the first audit. That was accurate but
misleading — I should have been clearer that "13 failures" meant "13 untested", which is a different
and in some ways worse problem.

---

## 3. Award concurrency, finally proven

`server/dispatchConcurrency.test.ts` — 8 tests, skipped without `DATABASE_URL`.

| Test | Result |
|---|---|
| Two dispatchers award the same unit simultaneously | **Exactly one winner** |
| Four simultaneous attempts | **Exactly one winner** |
| Second job overlapping the same truck | Refused — resource conflict |
| Back-to-back, one ending as the next begins | Both succeed |
| Different units, same window | Both succeed |

The parallel tests use `Promise.all`, not sequential awaits, and insert a deliberate 90–120 ms delay
**inside the lock, between the conflict check and the write**. That widens the
time-of-check/time-of-use window a naive implementation would fail on. `SELECT … FOR UPDATE` holds.

Three migration-integrity tests also run now: table count, unique constraint on tracking numbers,
and enum rejection. The last one confirms MySQL refuses an invalid `planningState` rather than
coercing it — worth knowing, since several engines depend on those enums being real constraints.

---

## 4. Two real environment problems, both worth recording

**MariaDB root uses socket authentication.** TCP connections as root are denied outright, so a
dedicated user is required.

**`'user'@'%'` does not cover `'user'@'localhost'`** while an anonymous `''@'localhost'` row exists —
the anonymous entry shadows the wildcard. Grants must name `localhost` and `127.0.0.1` explicitly,
or the anonymous users must be removed. This cost two debugging cycles and produces a confusing
`Access denied … (using password: YES)` that looks like a wrong password.

**Sandbox constraint:** the database process does not survive between tool calls here, so start,
migrate and test must happen in one invocation. In CI this is a non-issue — the service container
persists for the job.

---

## 5. CI

`.github/workflows/ci.yml` — MySQL 8 service container, health-gated, then:

```
install → apply migrations → verify parity → typecheck → test → build
```

`scripts/apply-migrations.sh` strips `--> statement-breakpoint`, which drizzle emits and the mysql
client cannot parse. `scripts/verify-parity.sh` fails the build if `schema.ts` and the migrations
disagree on table count — a table added to schema without a migration is a runtime failure typecheck
cannot catch.

---

## 6. On the pasted material

Three documents, dozens of ideas, and all three converge independently on the same architectural
recommendation:

- Doc 1 → **AI Skill Registry + Action Gateway**
- Doc 2 → **Event Bus + Task/Workflow Engine + Rules/Policy Engine**
- Doc 3 → **Workflow Engine** as "the biggest architecture addition"

They are describing one thing from three angles: *an event happens → policy evaluates → tasks are
generated → the right person is notified → AI explains → a human confirms → audit closes the loop.*

That is the right next build, and it is genuinely load-bearing rather than another feature. Doc 1's
own priority list also opens with "Disposable MySQL in CI" — which is what this pass did, so the
sequence is intact.

**I deliberately did not start it this pass.** Beginning a Workflow Engine on top of an unverified
database would have repeated the mistake I have just spent a checkpoint correcting. The
infrastructure had to be real first.

---

## 7. Status

| | |
|---|---|
| Tests | **340 across 18 files, 0 failures** |
| Tables | 74, all created from migrations |
| Migrations | 15, all verified to execute |
| Typecheck | 1 pre-existing error (`TripOperationsWorkspace.tsx(77,846)`, Phase 0 item 3) |
| CI | Configured, with a disposable database |

**Phase 0 item 4 — "green CI without a database" — is closed**, though not as originally worded: the
answer turned out to be *give it a database* rather than mock around one.

Still open: Prettier (lines to 11,259 characters) and the single type error. Both are now the only
Phase 0 items left.

---

## 8. Next

1. **Event Bus + Task/Workflow Engine + Rules/Policy Engine** — the convergent recommendation
2. AI Skill Registry + Action Gateway on top of it
3. Equipment Operator role and equipment domain
4. Wire voice transcription into `assistant.draft`
5. Replace the assistant prototype's local state with the real API
