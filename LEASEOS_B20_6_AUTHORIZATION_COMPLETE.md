# LeaseOS — B20.6 Checkpoint: Authorization Migration Complete (P1)

**Date:** 2026-09-08
**Base:** v20.9 (128 tables · 747 tests · 57 authenticated-only)
**Output:** v20.10 — **128 tables · 22 migrations · 761 tests · 33 files**

---

## 1. P0 could not be executed

Your priority list puts **P0 — merge/recover Spatial + LoadSense + Integrated Operations** first. I
checked before doing anything else.

`/mnt/user-data/uploads` contains one file: `leaseos-fieldroute-v20_2.zip` — the original trunk. A
source-wide grep for `loadSense`, `roadGraph`, `operationsEngine` and `aiSecretary` returns nothing.

**Those three branches have still never been supplied as code.** I did not reconstruct them from the
gap inventory and present them as merged — that would put a plausible-looking reimplementation in the
place where the real branch has to land, and the next reconciliation would have no way to tell.

Migration slots `0016` and `0017` remain reserved. P0 stays blocked on artifacts only you can send.

So I did **P1**, which was fully executable.

---

## 2. P1 complete — exact numbers

| | |
|---|---|
| Tables | 128 (no schema change) |
| Migration files | 22 |
| Tests | **761** (+14) |
| Test files | 33 |
| Typecheck | clean |
| Build | clean — `dist/index.js` 297.7 kb |
| **`protectedProcedure` remaining** | **0** |
| **Role-authorized procedures** | **102** (85 operational + 17 records) |
| Permissions | **113** |
| Sensitive permissions | **28** |

**85 → 57 → 0.** Every operational procedure in `routers.ts` now resolves the caller's domain roles,
decides against the permission engine, and writes an authorization decision row.

---

## 3. The 57 were not uniform, and were not treated as such

Gap item #27 lists them as one block. They are not. Three groups needed their own permissions because
they *create operational fact* rather than report it:

| Procedure | Permission | Why separate |
|---|---|---|
| `transfers.acknowledge` | `transfer.acknowledge` | A custody handoff. Not the same act as listing transfers. |
| `gps.confirmZoneEvent` | `gps.confirm` | Turns a GPS proposal into a billable arrival. Reading position and converting it to money are different permissions. |
| `routeDecisions.create` | `route.decide` | A routing decision, distinct from recording route context. |
| `evidence.verify` | `evidence.verify` | Verification is not upload. |
| `assistant.commit` | `assistant.commit` | Drafting and answering are capture; committing writes truth downstream systems rely on. |

All five are registered **sensitive**, so they fail closed without an authorization trail.

The assistant's ten procedures split four ways — `assistant.read` (forms, get, pending),
`assistant.use` (draft, answer, readBack), `assistant.review` (setStatus, acknowledge, reject),
`assistant.commit`. A driver can draft and answer and cannot commit or reject. Pinned by test.

Reads and writes were split throughout: `jobs.list` is `job.read`, `jobs.create` is `job.write`.

---

## 4. A design gap the migration surfaced

Only `driver` held `hos.write`, which meant **nobody but the driver could ever correct a duty
record** — while the HOS requirements explicitly call for amendments and office review.

Granted `hos.write` to `office` and `management`. Found because a pre-existing test failed once duty
records were gated; the correct response was to fix the grant model, not the test.

`hr` gets `hos.read` and nothing else operational — duty records feed payroll, and that is the only
reason HR touches them. Pinned by a test asserting HR is refused `trips.list` and `jobs.list`.

---

## 5. My test harness was wrong again, in a new way

B20.4 hardened `attempt()` to rethrow non-tRPC errors after a mistyped path read as a green
authorization test. That fix was incomplete: a wrong path comes back as tRPC **`NOT_FOUND`**, which
*has* a `code`, so it passed the hardened check and was still reported as "passed the gate."

Four new tests were green for that reason before I looked. `attempt()` now throws explicitly on
`NOT_FOUND` with a message saying it is a harness error, not an authorization result.

Worth stating plainly: this is the second time a helper of mine converted a structural mistake into a
passing security test. The paths were wrong for `transfers`, `units`, `jobUnits` and `loads` — all
nested deeper than I assumed.

---

## 6. Drift guard

Baseline is now **0** and must never rise. The failure message tells the author to gate the procedure
or classify it deliberately. Two new assertions: the entire operational surface is declared (85), and
the number of wired `roleProcedure` calls equals the number of declared permissions — no orphan
declarations, no undeclared wiring.

`PROCEDURE_AUTHORIZATION_INVENTORY.md` updated to 102 / 0.

---

## 7. Files changed

| File | Change |
|---|---|
| `server/_core/recordsAuthorization.ts` | +30 permissions, grants for 11 roles, +5 sensitive |
| `server/routers.ts` | 57 procedures migrated; 0 remain |
| `server/operationalApiAuthorization.test.ts` | +13 tests; harness hardened against `NOT_FOUND` |
| `server/procedureAuthorization.test.ts` | Baseline 0, +1 assertion |
| `server/fieldroute.test.ts` | Caller roles corrected |
| `PROCEDURE_AUTHORIZATION_INVENTORY.md` | 102 / 0 |

No schema change. Parity unchanged at 128/128.

---

## 8. Where the gap inventory now stands

**P1 is done.** Item #27 closes. Item #64 (assistant authorization) closes with it.

Item **#5** — the enforcement-evasion routing guard — I did **not** implement. It guards a routing
preference structure that lives in the branch that has not arrived, and building a guard against a
structure I invented would create a second thing to reconcile. It stays blocked with P0.

Unchanged and outstanding: **P2** (payroll/finance/tax API — schema and engines exist, nothing
callable), **P3** (scanner/OCR), **P4** (encrypted device storage), **P5** (spatial, blocked on P0),
**P6** (UIs), **P7** (GST/HST, banking, capital assets, year-end), **P8** (comms, TrackNode,
equipment ops, client portal), **P9** (authoritative datasets — no tax rule, HOS rule, retention
period or road restriction is loaded, so all determinations correctly return UNKNOWN).

---

## 9. Next recommended step

**P2 — expose the payroll, finance and tax APIs**, following the B20.3 pattern: `roleProcedure` on
every procedure, server-side subject resolution, the employee-private boundary enforced at the DTO
layer, and API-level negative tests per boundary. The gate is now proven across 102 procedures, so
this is applying a known pattern rather than inventing one.

P2 is also the last thing standing between the financial foundation and being usable, and it does not
depend on any missing branch.

Status in one line: *every procedure in LeaseOS is now authorized, audited and named; the financial
foundation still has no API; and three branches remain unsent.*
