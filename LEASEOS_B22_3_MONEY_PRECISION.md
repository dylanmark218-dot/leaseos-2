# LeaseOS — v22.3 Checkpoint: Money Precision

| | v22.2 | **v22.3** |
|---|---|---|
| Tables | 250 | **250** (8 integer shadow columns; 6 triggers) |
| Migrations | 59 | **60** (`0061`) |
| Role-authorized procedures | 356 | **356** |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 90 | **90** |
| Tests | 1,452 | **1,458** (+5 money guards, +1 truth guard) |
| Test files | 79 | **80** |
| Parity | 250/250 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

No new procedures. Every count is read from the source. Reserved slots untouched.

---

## Double money is grandfathered, never new

Money is integer minor units — an invariant the newer tables have honoured
since v21.9 and the older ones have not. **Forty columns** across
settlements, expenses, fuel, funding, insurance, payroll, purchasing and
vendor bills still hold money as `double`. They are now enumerated from the
live schema and pinned by test, the way the reserved-word audit pins its
list: a new `double` money column fails the gate, and a grandfathered one
that disappears must be removed from the list on purpose. The list only
shrinks.

## The two busiest ledgers grow integer shadows

Vendor bills, their lines and fuel transactions carry `…Cents` columns
beside their doubles — a forward migration only; the doubles stay for
older readers. The shadows are **backfilled by the migration**, and every
application writer sets both through one helper (`toCents`: half away from
zero, non-finite refused). And because raw imports, older tools and test
fixtures bypass the application, **the database guarantees the shadow**: a
`BEFORE INSERT` trigger fills a missing shadow from the double, and a
`BEFORE UPDATE` trigger re-derives it when the double changes alone while an
explicit shadow stands. The suite proves both, then reconciles **every row
the whole run wrote, to the cent**, as the last test in the gate.

## Corrected on the way — and guarded

The generated state's *Implemented on the server* narrative had lost every
addition after v21.12 — the later tranches' edits had landed, then a span
was cut — while the *Not implemented* section carried theirs intact. The
truth guard only checked *not-implemented* claims against the tree, so a
lost *implemented* narrative passed. The narrative is restored through
v22.3 from the checkpoints, and the guard is now **symmetric**: every
router that exists must be named as implemented, or the gate fails.

Also: the money guard's live filter was case-sensitive while MySQL's
`REGEXP` is not, so `grossAmount` was invisible to it; and the gate's own
first run showed 24 rows disagreeing — all raw-SQL fixtures — which is what
made the triggers the right answer rather than fixture edits.

## Files

**New:** `0061_money_cents_shadows.sql` (8 columns, backfill, 6 triggers) ·
`money.ts` · `zzMoneyPrecision.test.ts` (5)

**Changed:** `commercialRouter.ts`, `purchasingRouter.ts`, `fuelOpsRouter.ts`,
`integrationRouter.ts`, `assistantCommitService.ts` (dual writes) ·
`schema.ts` · `documentationTruth.test.ts` (symmetric guard) · inventory ·
generator (narrative restored)

## Not built, and named

Readers still consume the doubles; moving reads to the shadows and then
retiring the doubles is the remaining forward migration, ledger by ledger,
shrinking the grandfathered list as it goes. Payroll, settlements, expenses,
insurance and funding have no shadows yet.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
