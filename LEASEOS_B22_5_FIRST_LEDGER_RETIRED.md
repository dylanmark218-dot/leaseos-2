# LeaseOS — v22.5 Checkpoint: The First Ledger Retires Its Doubles

| | v22.4 | **v22.5** |
|---|---|---|
| Tables | 250 | **250** (5 double columns dropped; 40 triggers) |
| Migrations | 61 | **62** (`0063`) |
| Role-authorized procedures | 356 | **356** |
| Bare `protectedProcedure` | 0 | **0** |
| Grandfathered double money columns | 40 | **35** |
| Tests | 1,459 | **1,460** |
| Test files | 80 | **80** |
| Parity | 250/250 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

No new procedures. Every count is read from the source. Reserved slots untouched.

---

## The pattern, end to end, on one ledger

Vendor bills and their lines were the first to gain integer shadows
(v22.3); they are the first to lose their doubles. The order was the one the
invariants demand:

1. **Every reader moved.** Removing the doubles from `schema.ts` made the
   compiler name each one — the vendor statement, the inbox surface, the
   three-way match, the customer recovery proposal, the cash ledger, the
   warranty credit — and each now reads `…Cents`, converting at the API
   boundary where a dollar figure is returned.
2. **Every writer writes only the integers.** The portal intake, the purchasing
   bill record and the fixtures.
3. **The triggers that referenced the doubles were dropped**, then the
   doubles, then `totalCents` and `amountCents` became **NOT NULL** — as the
   doubles were.
4. **The guard shrank on purpose.** Five entries left the grandfathered list;
   a new test keeps the retired ledger retired: no double money on the two
   tables, the totals non-null, no trigger left that names a dropped column.

Along the way the compiler could not see the raw SQL in tests; the gate
could — one raw read of `total` and my own retirement check counting
`quantity` as money, both caught and fixed.

## Files

**New:** `0063_retire_vendor_bill_doubles.sql`

**Changed:** `schema.ts` · `commercialRouter.ts`, `purchasingRouter.ts`,
`portalRouter.ts`, `cashRouter.ts`, `gstRouter.ts`, `shopRouter.ts`,
`surfacesService.ts` (readers and writers) · five test fixtures ·
`zzMoneyPrecision.test.ts` (35; the retirement pinned) · inventory · generator

## Not built, and named

Thirty-five doubles remain, each with its shadow. The next ledgers in the
same order: fuel (three readers: IFTA, GST already moved, the fuel surface),
then expenses, then payroll — where the per-unit rates keep their
thousandths.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
