# LeaseOS — v21.17 Checkpoint: Commercial Project Management

| | v21.16 | **v21.17** |
|---|---|---|
| Tables | 221 | **227** (+6; `signatoryAuthorities` extended) |
| Migrations | 51 | **52** |
| Role-authorized procedures | 297 | **306** (+9, `projectRouter.ts`) |
| Externally-gated procedures | 29 | **33** (+4) |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 71 | **73** (+2); external sensitive +1 |
| Tests | 1,402 | **1,407** (+5, `commercialProjects.test.ts`) |
| Test files | 71 | **72** |
| Parity | 221/221 | **227/227 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## A price to a customer is frozen

A quote is priced from the customer's approved rate card — the response says
how many lines came from the card — and a code the card cannot price is
refused until it carries an explicit rate. **Issuing freezes it**: a canonical
snapshot and its hash are what the customer accepts, and only management or
the controller issue. A revision is a new version that supersedes; the old
quote and its hash stand. An accepted quote is never revised — the path is a
change order.

## A commitment is recorded as the authority it was made under

The customer accepts the quote **by the hash they saw**, and only a signatory
who holds quote authority on file may; a stale hash and a signatory without
the authority are each refused by name, and a signatory with no record at all
is recorded as *unknown*, not refused. A change order is authorized within
the signatory's extra-work limit, **above it, or without any authority — and
recorded as whichever it was**: the suite authorizes $7,400 against a $5,000
limit, gets *authorized, above authority* with the limit named, and the
office is alerted to confirm with the customer. An RFI is asked inside,
answered outside, and the answer is kept — a second answer is refused rather
than replacing the first.

## A budget is approved by someone else, and the forecast is honest

Budgets are lines by cost code, versioned, approved by someone other than
their author. The forecast is arithmetic over what was quoted, authorized,
billed and collected: committed value is *unknown* without an accepted quote
because change orders alone do not make a commitment; forecast at completion
is *unknown* until a person states how complete the work is, with their name
and the time; collected above billed is a review item.

---

## Files

**New:** `0053_commercial_projects.sql` (6 tables) · `commercialProjects.ts`
· `projectRouter.ts` (9) · `commercialProjects.test.ts` (5)

**Changed:** `portalRouter.ts` (+4: quotes, accept, authorize, answer) ·
`closeoutRouter.ts` (the authority record carries quote and RFI authority) ·
`recordsAuthorization.ts` (7 internal permissions, 2 sensitive, 9 mapped; the
external `portal.customer.commit`) · `routers.ts` · `schema.ts` · drift guards
· inventory · generator

## Not built, and named

Contracts and MSAs as records with their term and expiry. WBS below the cost
code. Earned-value schedules. Contract rules that would decide standby and
return-travel billing (the closeout still says REVIEW where a rule would
decide).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
