# LeaseOS — v22.4 Checkpoint: Integer Shadows Everywhere

| | v22.3 | **v22.4** |
|---|---|---|
| Tables | 250 | **250** (+32 shadow columns; 44 triggers in all) |
| Migrations | 60 | **61** (`0062`) |
| Role-authorized procedures | 356 | **356** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,458 | **1,459** |
| Test files | 80 | **80** |
| Parity | 250/250 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

No new procedures. Every count is read from the source. Reserved slots untouched.

---

## Every double money column has an integer shadow

The forty grandfathered doubles now each carry a shadow: **amounts in
cents**, and **per-unit rates in thousandths** — a fuel unit price of 1.459
is 1459, not rounded to the cent, because a rate is not an amount. Nineteen
tables, thirty-two new columns, each backfilled from its double, each
guarded by the same `BEFORE INSERT` and `BEFORE UPDATE` triggers v22.3
established. The reconciliation now covers all forty pairs at their scales
over every row the whole run wrote, and asserts a shadow exists for every
grandfathered double, so the two lists cannot drift apart.

## The first reader moves

The GST/HST return engine has computed in cents since v21.6; its router
converted the doubles at read time. It now reads the shadows on vendor
bills, expenses and fuel, with the double as fallback only for a row that
somehow has none — which the triggers make impossible for any row written
after the migration.

## Files

**New:** `0062_money_shadows_everywhere.sql` (generated: 32 columns, 19
backfills, 38 triggers)

**Changed:** `money.ts` (scale; `toMillis`) · `zzMoneyPrecision.test.ts` (all
pairs; thousandths) · `gstRouter.ts` (reads shadows) · `schema.ts` · inventory
· generator

## Not built, and named

The remaining readers — AP matching, IFTA fuel totals, payroll runs,
settlements, insurance risk, funding claims — still read the doubles.
Moving each is mechanical now; retiring the doubles and shrinking the
grandfathered list follows, ledger by ledger.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
