# LeaseOS — v22.7 Checkpoint: Commercial Setup & Rate Resolution

| | v22.6 | **v22.7** |
|---|---|---|
| Tables | 250 | **253** (`chargeDefinitions`, `pricingDecisions`, `commercialSetupProfiles`) |
| Migrations | 63 | **64** (`0065`) |
| Role-authorized procedures | 356 | **369** (+13, `commercialSetup`) |
| Sensitive (fail-closed) permissions | 90 | **93** (+3) |
| Bare `protectedProcedure` | 0 | **0** |
| Grandfathered double money columns | 30 | **30** (nothing new is a double) |
| Tests | 1,478 | **1,494** (+16, `commercialSetup.test.ts`) |
| Test files | 82 | **83** |
| Parity | 250/250 | **253/253 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots untouched.

---

## Never one field called "hourly rate"

One **charge definition** for every pricing method — per unit, flat, minimum
charge, percentage and fixed markup, multiplier, formula — over every unit
the businesses bill by, and for every **rate kind**: what we charge (sell),
what we owe a third party (vendor payable), what the worker earns (payroll
reference), what the service costs us (internal cost). Four rows, never one
number. Amounts are cents; rates and quantities are thousandths; markups are
basis points. A definition carries its scope — customer, vendor, project,
site, contract, job, branch, unit, condition — its effective window, its
source document and clause, its provenance (human, AI-extracted, imported,
negotiated), its approval and its supersession.

## Proposed by one person, approved by another

A definition enters as a proposal, whoever or whatever wrote it, and **prices
nothing until a different person approves it** — the proposer cannot approve
their own, and the office proposes but does not approve. Approval may
supersede an earlier definition, which keeps its history: **a superseded
definition still prices its own window**, so a December job reproduces
December's rate after January's replaces it (tested through the database).

## The resolver never picks something close

Deterministic precedence — job override, change order, PO/AFE, project or
site, customer contract, customer rate card, branch, company. Within a
level the most specific definition wins (the one that names the condition,
the site, the unit); **equal specificity is a CONFLICT** a person resolves;
nothing applicable is **UNKNOWN — REVIEW REQUIRED**; a proposal is named
but prices nothing; an expired definition is named. A vendor carries
different payables for different customers, sites and conditions, and a
vendor payable resolves only for a named vendor.

## A pricing decision is written once

Measured quantity and its source; billable quantity after the contract's
increment and minimum, each named with its clause — *Minimum 4 hour per ABC
MSA 2026 §4.2: 2.5 raised to 4*; rate, definition, scope, formula, inputs,
amount, reasons. A quantity in a unit the definition does not price is a
**CONVERSION REVIEW** unless a sourced conversion rule (material, factor,
source) is supplied and recorded; a measurement the contract does not
accept — an operator estimate where it requires a certified scale — is a
**MEASUREMENT REVIEW**. Pass-through disposal prices at cost plus markup and
needs the pass-through amount; a minimum charge raises a small septic job.

## Who sees what

The customer view carries the sell price only, unless the account is
open-book; the vendor view carries its payable only; management sees the
spread. Margin simulation lives under its own **sensitive** permission with
the company's guardrails — target, warning and minimum-authority bands and
per-role discount floors — which name who must approve a price below the
caller's authority. They are business policy, not law. PO exposure names a
projected overrun before work starts. Go-live readiness is a percentage
with exactly what is missing.

## Reviewed on arrival — not mine

Between two of my edits, two files changed in the working tree by a hand
that was not mine: the router gained the rule that **an AI-extracted or
imported rate names the source document it was read from, or it is not
proposed**, and the generator gained a server-narrative sentence for this
tranche and three honest *not implemented* statements — the first-run
wizard as a screen, AI extraction of rate sheets from uploaded documents,
and formula evaluation. I reviewed each against the invariants: the rule
is exactly what provenance requires, and the statements are true of the
tree. I kept them, wrote the rule's regression test, and made my fixture
obey it. They are recorded here with that provenance, not claimed.

## Files

**New:** `0065_commercial_setup.sql` · `rateResolution.ts` ·
`commercialSetupRouter.ts` (13) · `commercialSetup.test.ts` (16)

**Changed:** `schema.ts` · `recordsAuthorization.ts` (6 permissions, 3
sensitive, 13 procedure entries, 6 role grants) · `routers.ts` (mount) ·
truth guard · inventory · generator (partly by another hand, above)

## Not built, and named

The guided first-run screen (every setup procedure and the readiness
projection exist; the wizard does not). The AI document reader that fills
proposals from uploaded rate sheets, contracts and invoices (the proposal
path exists and requires the document; the extraction does not). Formula
pricing (recorded, never evaluated). Field tickets and vendor bills do not
yet call the resolver on their lines — the decision record exists for them
to reference; wiring the existing billing paths to it is the next step.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
