# LeaseOS — v21.8 Checkpoint: GST/HST Return Assembly + Close Expansion

| | Previous | New |
|---|---|---|
| Version | v21.7 | **v21.8** |
| Tables | 182 | **184** (+2; `invoices`, `vendorBills` extended) |
| Migrations | 42 | **43** |
| Procedures (role-authorized) | 224 | **229** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 172 | **176** |
| Sensitive permissions | 55 | **56** |
| Tests | 1,308 | **1,320** |
| Test files | 61 | **62** |
| Parity | 182/182 | **184/184 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The lines are facts; the rate is a check

*LeaseOS prepares → verified rules calculate → a human reviews → an
authorized person files.* The return assembles from the ledger:

| Line | Source |
|---|---|
| 101 sales | every invoice in the period, excluding tax |
| 105 collected | what the invoices say — a fact |
| 108 input tax credits | tax on purchases that **carry evidence**, and only when the company is **registered** |
| 104 / 107 | adjustments, each with a reason and a person |
| 109 net tax | 105 + 104 − 108 − 107; negative is a refund |

A purchase without evidence is **withheld and named** — *$3.00 of tax on an
expense with no evidence, not claimed until a receipt is attached* — never
claimed. Without a registration nothing is claimed at all, and the return
says it *may not be a return this entity files*.

**The rate never supplies a figure.** Ten jurisdictions are seeded with
`ratePercent: null`, unverified. When a person has verified one, the return
checks every taxable sale's tax against it and names the ones that differ:
*invoiced $40.00 tax; 5% of $1000.00 is $50.00.* Until then, line 105 is
reported as invoiced and marked **unchecked** — the return does not invent
five percent to check itself with.

**The sales side needed three things it lacked.** Invoices had no entity, no
issue date beyond creation, and no tax treatment. They have all three now; an
unclassified sale blocks the return; tax charged on an exempt or zero-rated
sale blocks it; a taxable sale with no tax is reviewed — once, not twice.

---

## Finalizing is another person acknowledging every finding by code

The preparer may not finalize their own return. Nothing blocking may remain.
Every review item — the unverified rate, the withheld credit, the excluded
invoices — must be **acknowledged by code**, and the acknowledgement is
stored on the return. A review item nobody acknowledged is a refusal, not a
footnote. The ledger must still hash to the snapshot; a receipt arriving
later makes a new return that supersedes the finalized one, which becomes
*amended*.

**A design correction found under the full suite.** Invoices with no entity
were included by default; in a multi-entity database that pulled another
company's invoices into this one's return. A return never silently includes
what it cannot attribute: unassigned invoices are excluded unless the caller
asks, and their existence is a finding — *assign them, or include them on
purpose* — that the filer acknowledges like any other.

---

## Close expansion

A quarter-end month's close readiness now asks for the GST/HST return
beside the IFTA return; classifying a sale or a bill dated in a closed
period is refused, because it changes a filed figure.

---

## Files

**New:** `0044_gst_hst.sql` · `gstReturn.ts` · `gstSeeds.ts` · `gstRouter.ts`
(5 procedures) · `gst.test.ts` (11)

**Changed:** `periodClose.ts` / `periodCloseService.ts` (return status at
quarter end) · `recordsAuthorization.ts` (4 permissions, 1 sensitive,
5 mapped) · `routers.ts` · `schema.ts` · drift guards · `ci-gate.sh` ·
inventory

---

## Genuine blockers — unchanged

**P0** — no routing source. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P9** — no verified rule; GST/HST rates join IFTA rates
and everything before them.

## Where the finance line stands

Receipt → ledger → statement → IFTA → GST/HST → close. Each return is a
derivation over records that carry their source, held unverified where the
rule is, prepared by one person and finalized by another with the findings
on the record. What remains of P7 is **bank reconciliation and full AR**
(v21.9) and **capital assets and CCA** (v21.10) — the same shape.
