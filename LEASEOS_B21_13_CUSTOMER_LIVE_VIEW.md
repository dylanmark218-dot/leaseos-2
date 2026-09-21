# LeaseOS — v21.13 Checkpoint: Customer Live View + Portal Client Shell

| | v21.12 | **v21.13** |
|---|---|---|
| Tables / migrations | 206 / 48 | **206 / 48** — no schema change |
| Role-authorized procedures | 263 | **263** |
| Externally-gated procedures | 19 | **22** (+3: job board, pre-clearance, notices) |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,369 | **1,377** (+8, `customerLiveView.test.ts`) |
| Test files | 66 | **67** |
| Client build | passes | **passes, with the customer shell** |
| CI gate | PASS | **PASS** |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## What a customer sees live is a projection

**An operational state comes only from ticket events and signatures — never
from a vehicle's speed.** Site work open is WORKING; a hold open is the hold;
travel to disposal is EN ROUTE; disposal is UNLOADING; a signature is
COMPLETE; between events the unit is ON LOCATION if site work has happened
and no more is guessed. Nothing recorded is **UNKNOWN, with the reason on the
chip**: *Unknown — No ticket event recorded — nothing establishes a state.*
Company activity after signing — restocking, post-trip — reads COMPLETE and
says the activity is not customer-visible. An open mechanical or safety event
outranks everything as BREAKDOWN or INCIDENT until resolved. The board orders
attention first, then working, holds, moving, unknown, complete last.

**Readiness is the same engine dispatch uses, projected.** A verdict — READY,
REVIEW, BLOCKED, UNKNOWN — and per finding a subject and a *category derived
from the blocker's code through a fixed dictionary*: driver licence, fitness
for duty, TDG certification, vehicle inspection, customer or site
orientation, insurance certificate… Anything the dictionary does not know is
*requirement under review*. The label, the credential, the document, the
record never cross; the suite feeds codes containing "demerits", "9" and
"diabetes" and checks none of those words survive. An operator the
contractor has no record for is UNKNOWN with the reason, never an error;
an operator with nothing on file is never READY.

**A notice is a template chosen by kind and severity.** *Work temporarily
interrupted — mechanical event under review; replacement equipment being
evaluated.* Info-level events produce nothing. The incident's own title,
detail, names, injuries and findings are never read by the projection; the
suite seeds an event whose title and detail name two people and a wrist
injury and checks none of it appears.

Every board, pre-clearance and notice read is scoped by the binding and
logged.

## The client shell

`client/src/portal/external/` — pure view-models tested in Node (board
order, summary, state chips that say *why* unknown, the pre-clearance
headline and action, the sign-off model listing what the signature covers
and what it does not, an adjustment preview that says an hour-equivalent is
not worked time), a tRPC client that carries the token as a header from
memory and never stores it, and a thin shell at `/customer`: accept an
invitation once, the board, documents with download, notices, the daily
report. The shell never names an account.

---

## Files

**New:** `_core/customerProjections.ts` · `customerLiveView.test.ts` (8) ·
`client/src/portal/external/viewModels.ts`, `portalClient.ts`,
`CustomerPortal.tsx`

**Changed:** `portalRouter.ts` (+3) · `recordsAuthorization.ts` (external
map) · `App.tsx` (`/customer`) · drift guard · inventory · generator

## Not built, and named

Load/material chain-of-custody views; the signing *screen* (the sign-off
model exists; the screen does not); notifications and customer-configurable
alerts; GPS on the board (P0). Quotes, change orders, budgets/WBS.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P0/P5** — no routing source.
