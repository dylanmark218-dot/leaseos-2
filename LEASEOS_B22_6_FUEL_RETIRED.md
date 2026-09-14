# LeaseOS — v22.6 Checkpoint: The Fuel Ledger Retires Its Doubles

| | v22.5.1 | **v22.6** |
|---|---|---|
| Tables | 250 | **250** (5 double columns dropped; 36 triggers) |
| Migrations | 62 | **63** (`0064`) |
| Role-authorized procedures | 356 | **356** |
| Bare `protectedProcedure` | 0 | **0** |
| Grandfathered double money columns | 35 | **30** |
| Tests | 1,478 | **1,478** |
| Test files | 82 | **82** |
| Parity | 250/250 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

No new procedures. Every count is read from the source. Reserved slots untouched.

---

## The second ledger, same order

Removing the five fuel doubles from the schema made the compiler name four
readers: the GST/HST return (already shadow-first, its fallback gone), the
asset twin's fuel cost (now a sum of integers, no rounding), the statement
matching read (converted at the boundary because statement lines are still
doubles), and the bulk dispense. Three writers — the assistant commit, the
machine feed and the dispense — write only the integers. The four triggers
that named the doubles were dropped, then the doubles, then `totalCents`
became NOT NULL as `total` was. The per-unit price retired into
`unitPriceMillis`: a rate keeps its thousandths.

Seven raw fixtures across four suites moved to cents. The trigger proof and
the thousandths proof, which lived on fuel, moved to expense records and pay
rates — ledgers that still carry doubles — so they keep proving what they
did. The retirement test now covers both retired ledgers: no double money,
totals non-null, no trigger naming a dropped column.

## Files

**New:** `0064_retire_fuel_doubles.sql`

**Changed:** `schema.ts` · `gstRouter.ts`, `assetRouter.ts`, `fuelOpsRouter.ts`,
`integrationRouter.ts`, `assistantCommitService.ts` · four fixture suites ·
`zzMoneyPrecision.test.ts` (30) · inventory · generator

## Not built, and named

Thirty doubles remain: expenses (four), fuel statement lines, payroll (six,
three of them rates), settlements (five), insurance (nine), funding (three),
purchasing, customer recovery. Expenses next — the GST return already reads
their shadows.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
