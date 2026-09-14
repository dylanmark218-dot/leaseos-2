# LeaseOS — v21.5 Checkpoint: Period Close + Fuel-Line Exceptions

| | Previous | New |
|---|---|---|
| Version | v21.4 | **v21.5** |
| Tables | 181 | **182** (+1) |
| Migrations | 40 | **41** |
| Procedures (role-authorized) | 221 | **224** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 169 | **172** |
| Sensitive permissions | 53 | **55** |
| Tests | 1,274 | **1,287** |
| Test files | 58 | **59** |
| Parity | 181/181 | **182/182 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## A period is closed by an action, and the history is the record

`periodCloses` holds actions — `soft_close`, `close`, `reopen` — each with a
reason, a person, a time, and **the readiness the closer saw**. State is the
latest action; there is no status column to flip, and *what did we know when
we closed August* is answerable from the row. Payroll keeps its own lock in
`payPeriods`; this close covers the ledger around it.

**What blocks a close is named, with what to do about it.** Receiptless card
purchases, ambiguous statement lines, mismatched or duplicate-suspected bills,
fuel with no jurisdiction, a tank variance beyond tolerance — blocking. Bills
awaiting coding or approval, fuel or distance awaiting review, draft expenses,
a quarter-end month whose IFTA return is not finalized, records that arrived
after a close — review. Soft-close proceeds over review items and never over
blocking ones; a hard close from open needs nothing to review — *soft-close
first, or clear them*; from soft-closed it needs the review items gone.

**A closed period refuses writes dated in it.** Bill approval, dispenses,
statement imports, distance records and trip splits call `assertPeriodOpen`
against the record's own date: *2026-08 is soft-closed — reopen it to post
here, or date the record in an open period with a note.* A dispense dated in
September goes through while August is shut. The bookkeeper closes; only the
controller reopens, with a reason; then the August dispense goes through.

**The AI Secretary's commits are not hooked.** A receipt for a closed month
enters as a draft and surfaces at the next readiness as a *late arrival*,
rather than being refused at the read-back. That is a choice, stated here.

---

## The fuel line reaches the exception centre

Three sources, gated on the role that acts: a statement with receiptless or
ambiguous lines (`fuel.statement.import`), a tank with an unexplained variance
(`fuel.review`), and a period sitting soft-closed with review items
(`period.close`). The bookkeeper is told, not asked to look.

---

## A scoping bug, found only under the full suite

The readiness loader counted AI proposals awaiting read-back **globally** —
other suites' leftover proposals, from other companies, blocked this entity's
August. Proposals carry no financial entity until they commit, so a close
cannot honestly attribute an uncommitted one. The engine keeps the finding
for the day they do; the loader now counts none rather than everyone's.

---

## The arc

August statement with one purchase nobody scanned → readiness **blocked**,
soft-close refused by name, exception centre shows the statement. Purchase
confirmed receiptless with a reason → a late August receipt still under
review → **review**. Hard close refused — *soft-close first*; soft-close
recorded with one review item; the centre shows the soft-closed period.
Dispense dated in August **refused**; dated in September accepted. Receipt
reviewed → **closed**; closing again refused; bookkeeper may not reopen;
controller reopens for a late invoice; the August dispense now goes through.
History reads *soft_close, close, reopen*, each with its reason, the first
carrying the readiness it saw.

---

## Files

**New:** `0042_period_close.sql` · `periodClose.ts` · `periodCloseService.ts`
· `periodRouter.ts` (3 procedures) · `periodClose.test.ts` (12)

**Changed:** `fuelOpsRouter.ts`, `iftaRouter.ts`, `purchasingRouter.ts`
(write hooks) · `exceptionCentre.ts` / `surfacesService.ts` (3 sources) ·
`recordsAuthorization.ts` (3 permissions, 2 sensitive, 3 mapped) · `routers.ts`
· `schema.ts` · drift guards · `ci-gate.sh` · inventory

---

## Genuine blockers — unchanged

**P0** — no routing source. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P9** — no verified rule; IFTA rates included.

## Where this leaves the finance line

Receipt → ledger → statement → IFTA → return → close. Every step exists;
every finding that stops a close is named with its corrective action; every
close and reopen is a row with a reason. The P7 items still open are year-end
ones — GST/HST return assembly, bank reconciliation, CCA — and each is the
same shape: a derivation over records that carry their source, with the rate
or the rule held unverified until a person verifies it.
