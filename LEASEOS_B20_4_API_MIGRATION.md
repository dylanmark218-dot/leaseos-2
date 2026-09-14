# LeaseOS — B20.4 Checkpoint: Operational API Migration (Tranche 1)

**Date:** 2026-09-07
**Base:** v20.7 (106 tables · 650 tests · 85 unreviewed procedures)
**Output:** v20.8 — **106 tables · 20 migrations · 676 tests · 32 files**

---

## 1. Exact numbers

| | |
|---|---|
| Tables | **106** (no schema change) |
| Migration files | **20** |
| Tests | **676** (+26) |
| Test files | **32** |
| Typecheck | clean |
| Build | clean — `dist/index.js` 269.8 kb |
| Role-authorized procedures | **45** — 17 records + **28 operational** |
| `protectedProcedure` remaining | **57** (was 85) |

---

## 2. Migrated — 28 procedures, 85 → 57

Bands 1–5 of the committed priority order, all of them the sensitive ones:

| Band | Procedures | Permissions |
|---|---|---|
| A. Personnel | `operators.list` / `.create` | `personnel.read` / `personnel.write` |
| B. Billing | `rateCards.*` · `lines.*` · `vendors.*` | `billing.read` / `billing.write` |
| C. Compliance | `documents.*` · `artifacts.*` · `compliance.sign` | `compliance.read` / `.write` / `.review` / `.sign` |
| D. Safety | `safety.*` · `tailgates.*` · `unitSafety.*` | `incident.read_summary` / `safety.write` |
| E. Maintenance | `maintenance.*` · `workOrders.*` | `maintenance.read_defect` / `.write_defect` / `.write_work_order` |

**Reads and writes were split, not stamped.** `rateCards.list` is `billing.read`; `rateCards.update`
is `billing.write`. `documents.list` is `compliance.read`; `documents.review` — which sets
verified/rejected — is `compliance.review`, held only by office, safety and management. A mechanic
can see whether an inspection is current and cannot decide that it is.

`billing.write`, `personnel.write` and `compliance.review` are registered **sensitive**, so they fail
closed if the authorization trail cannot be written.

---

## 3. Both gaps from B20.3 closed

**`queueSend` now declares real hashes.** It loads the stored `evidenceSeals` row for the record's
current version. The placeholders would have made the office compare a constant against itself and
pass regardless — verification that always succeeds is not verification. Records whose seal row
cannot be found are excluded from the package rather than sent with a fabricated declaration.

**Bootstrap is reachable.** `records.roles.bootstrapManagement`, gated on `adminProcedure` — it could
never satisfy a `roleProcedure`, since the whole point is that no role exists yet. It refuses once
any active management grant exists, grants `management` and nothing else, and records the event.
`bootstrapStatus` reports whether the path is still open. Platform admin stayed separate from the
domain model.

---

## 4. What the migration surfaced

**Four pre-existing tests failed, and that was the gate working.** `fieldroute.test.ts` drives the
procedures I had just gated with a caller holding no domain role. The fix was to grant the caller the
roles a real user doing that work holds — not to loosen the gate.

**Then one still failed, and the audit trail diagnosed it in one query:**

```
operators.create | personnel.write | denied_permission | office,safety,mechanic,management
```

The caller held `mechanic` alongside `office` and `management`, and mechanic is **explicitly denied**
`personnel.write` — deny beats grant, exactly as designed. The correct fix was to drop `mechanic`
from that caller, because a person who is simultaneously a mechanic and management should not thereby
get personnel write. Weakening the denial to make a test pass would have removed the property the
denial exists for.

Worth noting on its own: the authorization audit table paid for itself the first time something went
wrong, which is the argument for recording denials rather than only successes.

**A flaw in my own test harness.** `attempt()` treated any non-FORBIDDEN error as "passed the gate",
so a mistyped router path surfaced as a green authorization test. Ten tests were passing for the
wrong reason. It now rethrows anything that is not a tRPC error. A helper that converts a structural
mistake into a green security test is worse than no helper.

---

## 5. Drift guard updated

Baseline lowered **85 → 57**, and three new assertions added:

- every declared operational procedure is actually wired (no orphan declarations)
- every wired `roleProcedure` in `routers.ts` has a declared permission (no undeclared wiring)
- the tranche is exactly 28, so a procedure cannot quietly move back

`PROCEDURE_AUTHORIZATION_INVENTORY.md` records what was migrated and re-orders the remaining bands.

---

## 6. Files changed

| File | Change |
|---|---|
| `server/_core/recordsAuthorization.ts` | +10 permissions, grants, denials, `OPERATIONAL_PROCEDURE_PERMISSIONS` |
| `server/routers.ts` | 28 procedures moved to `roleProcedure` |
| `server/recordsRouter.ts` | Real seal hashes in `queueSend`; bootstrap procedures |
| `server/recordsService.ts` | `loadCurrentSealHashes` |
| `server/operationalApiAuthorization.test.ts` | **New** — 23 API-level tests |
| `server/procedureAuthorization.test.ts` | Baseline 57, +3 assertions |
| `server/fieldroute.test.ts` | Caller granted realistic roles |
| `PROCEDURE_AUTHORIZATION_INVENTORY.md` | Updated |

No schema change, no new migration, parity unchanged at 106/106.

---

## 7. Remaining — 57 procedures, in order

1. **Dispatch and trip mutations** — `trips.*`, `tripStops.*`, `jobUnits.*`, `transfers.acknowledge`
2. **Job, load, manifest and evidence writes** — `jobs.create`, `loads.create`, `manifests.create`,
   `evidence.upload` / `.verify`
3. **Assistant proposal lifecycle** — 10 procedures; `commit` is the sensitive one
4. **GPS and zone confirmation** — `gps.confirmZoneEvent` is a write
5. **Read-only operational** — largest count, lowest risk

Also outstanding: encrypted device storage · Audit Package Builder · OCR filing · duplicate detection ·
verified statutory retention sources · the spatial + LoadSense and Integrated Operations branches.

---

## 8. Next recommended step

**Band 1 — dispatch and trip mutations.** They are the next real write surface: awarding work,
changing trip state and acknowledging transfers all have operational consequences, and
`transfers.acknowledge` is a custody handoff.

Status in one line: *records, personnel, billing, compliance, safety and maintenance are authorized;
57 operational procedures remain authenticated-only, counted and shrinking.*
