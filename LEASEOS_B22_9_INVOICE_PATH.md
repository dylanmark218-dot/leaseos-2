# LeaseOS — v22.9 Checkpoint: The Invoice Path

| | v22.8 | **v22.9** |
|---|---|---|
| Tables | 253 | **254** (`invoiceLines`) |
| Migrations | 65 | **66** (`0067`) |
| Role-authorized procedures | 371 | **374** (+3, `invoicing`) |
| Sensitive (fail-closed) permissions | 93 | **94** (`invoicing.finalize`) |
| Bare `protectedProcedure` | 0 | **0** |
| Grandfathered double money columns | 30 | **30** |
| Tests | 1,497 | **1,500** (+3, `invoicing.test.ts`) |
| Test files | 84 | **85** |
| Parity | 253/253 | **254/254 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## A finding first

Setting out to draw invoice lines from the ticket's decisions, I found there
was no invoice path to draw them into. AR, cash, collections and the
commercial check all read `invoices`; nothing in the application wrote one
— every invoice in the tests was raw SQL — and the billing book and billing
snapshot tables had been schema-only since they were declared. The v21
accounts-receivable work stands on rows the product could not produce.
This release produces them.

## Drafted from the ticket's decisions

An invoice is drafted from a **signed** ticket — a refusal or an absent
representative is not a signature to invoice on — from its **accepted**
lines and their **pricing decisions**: the decision's billable quantity,
rate and amount, never re-priced; each invoice line names the ticket line
and the decision it came from, and its basis names the scope level. A
**disputed** line is held under the customer's partial-acceptance
configuration, or blocks the draft where the customer does not accept
partial invoices. A line that named no service is a note and is excluded
with that reason. An unpriced line blocks the draft with its outcome
named — *UNKNOWN RATE*. A ticket amended after signature blocks. Ticket
lines already on a live invoice cannot be drafted again. The job's billing
book is opened if absent, and its entries are written — *ready* for the
invoiced lines, *held* with the reason for the excluded ones.

## Finalized by a second permission into a frozen snapshot

The office drafts; the controller or management finalizes. Finalization is
**refused until a person sets the GST/HST treatment** (`gst.treatmentSet`),
**refused for a taxable invoice while the rate is an unverified rule** —
P9 named in the refusal — and permitted zero-rated or exempt. It freezes a
billing snapshot: the source facts (ticket lines, decisions with their
reasons) and the calculated lines, under a canonical hash the invoice
carries; marks the entries billed and the book invoiced; and cannot run
twice. The rate is a determination from the tax rule engine, never a figure
typed here.

## Corrected on the way

My canonicaliser tested for a `Date` after the object branch had already
swallowed it; the hash test caught it. The GST treatment setter's `source`
is an enum, not free text; my fixture learned. The authorization coherence
suite reads a fixed list of router sources — extended by the other hand for
`commercialSetupRouter` in v22.7 — and needed the new router added.

## Files

**New:** `0067_invoice_lines.sql` · `invoiceDraft.ts` · `invoicingRouter.ts`
(3) · `invoicing.test.ts` (3)

**Changed:** `schema.ts` · `recordsAuthorization.ts` (3 permissions, 1
sensitive, 3 entries, 5 role grants) · `routers.ts` (mount) · two count pins
and the source list · truth guard · inventory · generator

## Not built, and named

The invoice's customer-facing document and its sending through the portal
(the v21.14 notices and documents paths exist; wiring an approved invoice
to them is next). Credits and voids against a finalized invoice through
this path (AR's credit procedures exist against the invoice row). Excluded
lines re-drafted after a dispute resolves. The guided screen and the
document reader.

## Blockers — unchanged

**P9** — no verified rule; a taxable invoice cannot be finalized until a
GST/HST rate is verified. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
