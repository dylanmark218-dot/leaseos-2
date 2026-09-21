# LeaseOS — B20.1 Checkpoint: Records & Safety Wired Into the Workflow Engine

**Date:** 2026-09-07
**Base:** v20.4 (103 tables · 553 tests)
**Output:** v20.5 — 103 tables · 18 migrations · **569 tests**

---

## 1. Completed

The B20 engines decided correctly and emitted nothing. They returned what *should* happen and no
consequence ever left the function. This connects them to the B17 orchestration the same way B19
connected the defect path — a real mutation, in a real transaction, producing real tasks from the
real released rule set.

**No parallel orchestration was built.** New emitters went into `domainEmitters.ts`, new rules into
`workflowSeeds.ts`, and `emitMechanicReleased` was reused rather than duplicated.

| Chain | Now provable end to end |
|---|---|
| Sealed incident → safety review + management notified | `safety.incident.sealed` |
| Incident holds a unit → mechanic + dispatcher + eligibility invalidated | `safety.incident.unit_held` |
| Near miss + injury → converts, safety reviews | `safety.near_miss.escalated` |
| Seal fails verification → office task, device copy retained | `records.evidence.integrity_failed` |
| Legal hold placed → confirmable obligation | `records.legal_hold.placed` |
| Management reviews defect → shop work order | `fleet.defect.sent_to_shop` |
| Released under limits → dispatcher told the restriction | `fleet.mechanic_release.restricted` |
| Release revoked → unit held again | `fleet.mechanic_release.revoked` |

Tests drive each emitter **from the engine's own output** rather than a hand-written payload, so a
change in engine behaviour surfaces here instead of quietly diverging from what the workflow believes.

---

## 2. Bug found — `notify` was dead configuration

`{ kind: "notify"; role; message; deepLink }` is declared in `ConsequenceAction`, is used in **eight
released rules**, and **nothing ever applied it**.

Notifications were produced in exactly one place: as a side effect of task creation, addressed to the
task's own assignee, carrying the task's title. So a rule reading:

```ts
{ kind: "notify", role: "management", message: "Critical defect opened — unit held from dispatch" }
```

delivered nothing at all unless a task happened to be assigned to `management`. Management was never
told a critical defect opened. The rule file said otherwise, and a rule author had no way to tell —
this is configuration that reads as working configuration.

Found because a B20 test asserted management receives a notification for a sealed serious incident
where the task goes to safety. That is precisely the case that could not work.

**Fix.** `applyEventConsequences` now applies `notify` actions from matched rules, against the same
derived-key discipline as task notifications, so a redelivered event still cannot notify twice.
Additive — it delivers notifications the rules already asked for; it removes none.

**Regression coverage.** Two tests: a role receiving a notification while owning **no task** from the
same event (impossible before), and double-delivery suppression across two worker passes.

This also retroactively repairs the eight existing rules — critical defect, disposal ticket,
credential expiry and the rest now notify the roles they always said they would.

---

## 3. Design decisions worth flagging

**A held unit got its own rule.** `safety.incident.unit_held` is separate from
`safety.incident.sealed` rather than folded in, because holding a unit must raise the dispatch
consequence even when severity alone would not have escalated. Same defect this build already fixed
inside `planEscalation()` — worth not reintroducing at the rule layer.

**Restricted release is not just "clear".** The existing rule fired `reevaluate dispatch` on
`releaseVerified: true` and said nothing about restrictions. `emitMechanicReleased` gained optional
`releaseType` / `restricted` / `restrictionDetail` (optional, so existing callers are unaffected), and
a restricted release now raises a dispatcher task carrying the limit. A revoked release holds the unit
again.

**A clean receipt is silent.** Verified evidence emits nothing — pinned by test. An exception centre
that fills with successes is one nobody reads.

**A hazard observation wakes nobody.** Also pinned. Worth recording, not worth a task.

---

## 4. Files changed

| File | Change |
|---|---|
| `server/_core/domainEmitters.ts` | +5 emitters; `emitMechanicReleased` gains optional restriction fields |
| `server/_core/workflowSeeds.ts` | +8 rule seeds (10 → 18) |
| `server/_core/workflowRuntime.ts` | **Bug fix** — `notify` actions now delivered |
| `server/b20WorkflowWiring.test.ts` | **New** — 16 integration tests |

No schema change, no new migration, parity unchanged at 103/103.

---

## 5. Verification — full gate, clean database

| Step | Result |
|---|---|
| 18 migrations, fresh DB | PASS — 103 tables |
| `verify-parity.sh` | PASS — 103 / 103 |
| `tsc --noEmit` | PASS — clean |
| `vitest run` | PASS — **569 / 569**, 27 / 27 files |
| `pnpm build` | PASS — `dist/index.js` 199.9 kb |

553 → 569 (**+16**). No existing test modified.

---

## 6. Remaining gaps

- **Still no UI and no tRPC procedures.** Engines and rules are wired to each other, not to a caller.
  Nothing in a request path calls these emitters yet — same gap B17.1 closed for the earlier domains.
- **Encrypted device storage unimplemented.** A real 14-day guarantee needs encrypted SQLite plus a
  native file store.
- **Audit Package Builder, duplicate detection, OCR auto-filing, safety-meeting attendees** — designed,
  not built.
- **Retention policy rows carry no verified statutory source.** Every row is still
  `statutorySourceStatus: 'unverified'`.
- **Spatial + LoadSense and Integrated Operations branches** — still not supplied.

---

## 7. Next recommended step

**Expose B20 through tRPC with authorization.** The engines are correct and the rules fire, but no
request path reaches them — sealing, sending, incident capture and mechanic release are all
callable only from a test. The procedures are also where the authorization boundaries this build
assumes get enforced for real: mechanic release requires an authenticated technician, roadside
inspection mode must be scope-limited server-side, and shop staff must not reach billing or other
employees' records. Those are currently properties of pure functions rather than of the API.

After that, the Driver Field Vault and Office Records Vault UIs have something real to call.
