# LeaseOS — v21.9 Checkpoint: Bank Reconciliation + Accounts Receivable

| | Previous | New |
|---|---|---|
| Version | v21.8 | **v21.9** |
| Tables | 184 | **192** (+8) |
| Migrations | 43 | **44** |
| Procedures (role-authorized) | 229 | **240** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 176 | **186** |
| Sensitive permissions | 56 | **58** |
| Tests | 1,320 | **1,332** |
| Test files | 62 | **63** |
| Parity | 184/184 | **192/192 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## A bank line is evidence of a movement, never a movement

The v21.4 rule for card statements, generalised: a bank statement line
matches at most one LeaseOS movement — a customer payment, a vendor bill
paid, a card statement settled — by signed amount within a window, with a
shared reference choosing between twins. Twins with no reference are
*ambiguous, a person decides*. Same amount outside the window is a *timing
difference*, named. Nothing explains it: an *unknown deposit* or an *unknown
withdrawal*, named with its amount. Movements the statement has not shown
are *outstanding cheques* and *deposits in transit*.

**The reconciliation is arithmetic.** Bank closing, less outstanding
withdrawals, plus deposits in transit, against book opening plus movements
— and the difference is the thing to explain. The ledger scenario ends with
a difference of exactly the service fee the books did not have. A statement
whose lines do not sum from opening to closing is refused as incomplete;
the import is idempotent by content; a matched deposit links to its payment.

**A bug the ledger found.** Movements come from tables whose ids overlap,
and the matcher keyed them by id alone — matching payment #7 silently "took"
bill #7, which then vanished from the outstanding list. Identity is kind
and id; pinned.

---

## The collector follows up; the controller authorizes

A payment is received *unapplied*, then allocated: **never crossing
customers, never exceeding the payment's unallocated amount or the invoice's
balance** — an overpayment stays unapplied on the payment; it is not forced
onto the invoice. The invoice settles at zero. A credit is requested by one
person and decided by another. Collections are events — reminders,
statements, calls, promises with an amount and a date, disputes,
escalations. A write-off is requested by the bookkeeper and **decided only by
the controller**, never the requester; approval becomes a credit on the
invoice, with the request and the decision on the invoice's collection
history.

**Aging** is what is left, bucketed from the due date — current, 31–60,
61–90, 90+ — with disputed invoices in their own bucket because chasing them
is a different conversation, unapplied cash reported beside it, and the
oldest first.

---

## Close expansion

A period whose bank has lines nothing explains cannot close — blocking. A
period with no bank statement imported, or payments received and not
applied, is reviewed.

---

## Files

**New:** `0045_bank_and_receivables.sql` (8 tables) ·
`bankReconciliation.ts` · `accountsReceivable.ts` · `cashRouter.ts` (bank 3 +
AR 8 procedures) · `cash.test.ts` (11)

**Changed:** `periodClose.ts` / `periodCloseService.ts` ·
`recordsAuthorization.ts` (10 permissions, 2 sensitive, 11 mapped) ·
`routers.ts` · `schema.ts` · drift guards · `ci-gate.sh` · inventory ·
`periodClose.test.ts` (the August scenario now sees the bank finding)

---

## Genuine blockers — unchanged

**P0** — no routing source. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P9** — no verified rule.

## Where the finance line stands

Receipt → ledger → statement → IFTA → GST/HST → **bank → cash → aging** →
close. Every step is a derivation over records that carry their source;
every act that reduces what a customer owes is two people. What remains of
P7 is **capital assets and CCA** (v21.10), where a truck is one asset
identity for maintenance and for accounting, and the tax class is a rule
held unverified until a person verifies it.
