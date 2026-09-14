# LeaseOS — v22.11 Checkpoint: Credits, Voids and Supplemental Drafts

| | v22.10 | **v22.11** |
|---|---|---|
| Tables | 254 | **254** (void columns on `invoices`) |
| Migrations | 67 | **68** (`0069`) |
| Role-authorized procedures | 376 | **378** (+2: void, disputeResolve) |
| Sensitive (fail-closed) permissions | 94 | **96** |
| Externally-gated procedures | 36 | **36** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,501 | **1,503** |
| Test files | 85 | **85** |
| Parity | 254/254 | **254/254 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## A held line drafts once its dispute resolves

A draft now excludes any line already on a live invoice, naming the invoice,
and what remains is a **supplemental invoice on the same billing book** —
the book's entries are updated for the line, never duplicated. So the
standby line held while disputed drafts by itself, weeks later, once the
customer accepts it; and a draft with nothing new is a named blocker, not a
thrown error.

## A dispute resolved, a credit approved by someone else

An invoice-level dispute — raised in the portal, accepted into a case by
the office — is resolved as **upheld, credited or partial**. The credit is
bounded by the disputed amount, a full credit must equal it and a partial
must fall short of it, and the credit is *requested* through AR's existing
path where a second person approves it; the resolver cannot approve their
own. The invoice returns to its delivery state; the customer is told.

## A void is recorded, never deleted

Who, when, why on the invoice itself. Refused where payments are allocated
or approved credits stand — that is a credit — and refused for a paid
invoice; permitted otherwise, keeping the snapshot and **releasing the
book's entries** so the lines draft again. Tested: the supplemental invoice
voided, its line drafted a third time, its snapshot still there.

## Corrected on the way

The earlier test expected the second draft to *throw* "already on invoice";
it now receives a blocker that names it, which is what an operator needs.
The dispute case's invoice number and disputed amount are nullable and the
credit needs an entity — three refusals the compiler asked for.

## Files

**New:** `0069_invoice_void.sql`

**Changed:** `invoiceDraft.ts` (supplemental draft, `voidCheck`,
`disputeResolution`) · `invoicingRouter.ts` (void, disputeResolve, entries
updated) · `schema.ts` · `recordsAuthorization.ts` · `invoicing.test.ts`
(+2) · two count pins · inventory · generator

## Not built, and named

A supplemental invoice's document and sending run through the same render
and send. Line-level disputes on an invoice (the ticket's per-line
disposition is the mechanism; the case records `invoiceLineRef` but nothing
sets it). Email or SMS delivery. The guided screen and the document reader.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
