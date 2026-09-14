# LeaseOS — v22.8 Checkpoint: The Paths That Bill Write the Decision

| | v22.7 | **v22.8** |
|---|---|---|
| Tables | 253 | **253** (5 columns on two line tables) |
| Migrations | 64 | **65** (`0066`) |
| Role-authorized procedures | 369 | **371** (+2 queries) |
| Bare `protectedProcedure` | 0 | **0** |
| Grandfathered double money columns | 30 | **30** |
| Tests | 1,494 | **1,497** (+3, `linePricing.test.ts`) |
| Test files | 83 | **84** |
| Parity | 253/253 | **253/253 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## A line records a fact; its decision sits beside it

A field-ticket line has never carried a price — kind, quantity, unit, how it
was measured. It still doesn't. When a line names its service, the resolver
runs as the line is recorded, over the customer's approved definitions in
the ticket's context (customer, job, unit, ticket date); the pricing
decision is written once — measured 7.133 h from the clock, billed 7.25 h
to the contract's quarter-hour, $320/h at the customer contract, the clause
named — and the line carries the decision's reference. **An unknown rate is
a decision that says so**; it is recorded and never stops the field. A unit
outside the pricing vocabulary — barrels — is skipped and said so, never
converted. A line that names no service is a note.

The ticket's pricing view lists every line with its outcome and names the
blockers plainly: *UNKNOWN RATE*, *no service named — cannot price*.

## A vendor line against what was agreed

A vendor-bill line that names its service is priced against the vendor's
agreed payable in the customer's context — the ABC-specific $225, not the
standard $210 — and the line carries the **variance per unit** between what
the vendor billed and what was agreed: billed $240, agreed $225, variance
$15. The decision records what is owed at the agreed rate beside what was
billed; the bill's total is untouched. A query lists every line that does
not match — the first answer to *show me the vendor invoices that don't
match their agreed rates*.

## Corrected on the way

My column insert landed inside a multi-line enum in the schema, and my
ad-hoc typecheck grep only watched `server/` and `client/`, so a `drizzle/`
error was invisible until the test loader refused the file. The gate's own
typecheck step fails on any tree; my greps now do too. Two count pins on
the operational map — maintained by the other hand in v22.7 — moved by
exactly the two new queries.

## Files

**New:** `0066_lines_carry_pricing_decisions.sql` · `linePricing.ts` ·
`linePricing.test.ts` (3)

**Changed:** `schema.ts` · `closeoutRouter.ts` (`lineAdd` prices) ·
`purchasingRouter.ts` (`billRecord` prices and records variance) ·
`commercialSetupRouter.ts` (`ticketPricing`, `vendorRateVariances`) ·
`recordsAuthorization.ts` · two count pins · inventory · generator

## Not built, and named

Invoice lines drawn from ticket decisions (the billing book still prices
from the rate card's `priceLines`; moving it onto the decisions is the next
step of this thread). The guided first-run screen. The AI document reader.
Formula evaluation. Pass-through amounts on ticket lines (the disposal
markup needs the facility's amount; the line carries none yet).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
