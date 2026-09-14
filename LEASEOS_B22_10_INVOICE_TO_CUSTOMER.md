# LeaseOS — v22.10 Checkpoint: An Approved Invoice Reaches the Customer

| | v22.9 | **v22.10** |
|---|---|---|
| Tables | 254 | **254** (document kind `invoice`; `invoiceId` on documents) |
| Migrations | 66 | **67** (`0068`) |
| Role-authorized procedures | 374 | **376** (+2: render, send) |
| Externally-gated procedures | 33 | **36** (+3: invoices, invoiceView, invoiceAccept) |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,500 | **1,501** |
| Test files | 85 | **85** |
| Parity | 254/254 | **254/254 column-level** |
| CI gate | PASS | **PASS** (gates 7b and 7c pinned at 36 and 2) |

Every count is read from the source. Reserved slots untouched.

---

## Rendered from the snapshot

The invoice's document is rendered from its frozen billing snapshot and
nothing else — the calculated lines, the treatment and rate, the totals,
the snapshot hash printed on the page. Rendering is idempotent: one
document per invoice, its content hash carried, its source hash the
snapshot's. It is stored beside the ticket's own documents under the kind
`invoice`, so the customer portal lists and downloads it where it already
lists the ticket's R1, post-site and completion documents. A document may
now belong to an invoice rather than a ticket revision.

## Sent with the account's terms

Sending is its own permission. Only a finalized, rendered invoice is sent;
it takes its due date from the account's payment terms and its issue date,
and the account's portal identities are alerted through the queue that
already carries arrival, sign-off and document notices. An invoice sent
before the customer has a portal identity queues nothing — the send says so.

## Seen and accepted in the portal

The customer lists the invoices issued to it — number, dates, total,
document. Viewing one marks it **viewed**, once, and shows the frozen
lines: the sell price, and nothing of cost — the response is tested to
contain no vendor, cost or margin. Acceptance is the customer's act,
recorded in the acceptance fields with the delivery status untouched,
idempotent; a disputed invoice is not accepted over its dispute; another
account sees nothing.

On statuses: `approved` means finalized internally (AR treats it as
issued, `draft` and `void` as not); `sent` and `viewed` are delivery;
acceptance is `acceptedAt`; `disputed`, `partially_paid` and `paid` follow.
No enum value was added.

## Corrected on the way

My fixture invited the customer after sending, so no alert could have been
queued — alerts go to identities, and the send now reports how many. And
the portal's alert list carries title and body, not the kind; the test
reads what the customer reads.

## Files

**New:** `0068_invoice_documents.sql`

**Changed:** `invoicingRouter.ts` (render, send) · `portalRouter.ts`
(invoices, invoiceView, invoiceAccept) · `schema.ts` ·
`recordsAuthorization.ts` (2 permissions, 3 external entries, grants) ·
`invoicing.test.ts` (+1) · three count pins · inventory · generator

## Not built, and named

Credits and voids through this path against a finalized invoice (AR's
credit procedures exist against the row). Excluded lines re-drafted after a
dispute resolves. Email or SMS delivery (in-app alert only, as before). The
guided screen and the document reader.

## Blockers — unchanged

**P9** — no verified rule; a taxable invoice cannot be finalized until a
GST/HST rate is verified. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
