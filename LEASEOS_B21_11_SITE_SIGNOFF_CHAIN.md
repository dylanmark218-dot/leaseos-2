# LeaseOS — v21.11 Checkpoint: Site Sign-Off & Post-Site Billing Chain (promotion of an unauthored arrival)

| | v21.10 | **v21.11** |
|---|---|---|
| Tables | 198 | **201** (+3; `fieldTickets`, `fieldTicketEvents`, `fieldTicketSignatures`, `customerAccounts` extended) |
| Migrations | 46 | **47** |
| Role-authorized procedures | 246 | **258** (+12, `closeoutRouter.ts`) |
| Externally-gated procedures | 7 | **10** (+3: view, sign and decide a ticket from the portal) |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 61 | **64** (+3); external writes 3 → **5** |
| Tests | 1,348 | **1,360** (+12, `siteCloseout.test.ts`) |
| Parity | 198/198 | **201/201 column-level** |
| CI gate | PASS | **PASS** on a clean database |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## Provenance — read this first

**I did not write this tranche.** Between 19:14 and 19:24 today, fourteen
files appeared in the working tree newer than the v21.10 checkpoint I had
just shipped: `drizzle/0048_site_signoff_chain.sql`, `server/_core/siteCloseout.ts`,
`server/closeoutRouter.ts`, `server/siteCloseout.test.ts`, extensions to
`portalRouter.ts` and `recordsAuthorization.ts`, and edits to my drift
guards, `ci-gate.sh`, `current-state.sh`, `commercialPortal.test.ts` and the
inventory. This is the third such arrival in this project (v20.14, v20.15,
v20.23 before it). The policy is unchanged: **never claim authorship; review
against the invariants; gate; promote with provenance noted.** What follows
is my review and what I found.

---

## What it implements — the closeout document, faithfully

A field ticket's events now say which **clock** they belong to — duty,
payroll, job, customer billing, equipment, standby, travel, disposal,
internal service — and whether the customer is billed for them: *yes*, *no*,
or *review*. Site work is yes. Restocking, post-trip, washout, fuel and
paperwork are **no, by construction**. Standby, holds and everything after
the lease are **review until a contract rule decides** — the document's
"REVIEW REQUIRED, not a made-up answer."

**Stage 1.** The site snapshot is composed, canonically serialized and
hashed. A signature is refused if the ticket changed between review and
signing, and refused with an open site event. It records which
**authorities** were exercised — work, time, quantity, standby, change order
within a limit, invoice approval — against the signatory's authority on
file; an unknown signatory is recorded as exercised and marked *unknown*,
neither refused nor assumed. A paper signature refuses without the scan in
the vault. Revision R1 is written with the snapshot and its hash. A disputed
line keeps both sides — contractor claimed, customer accepted, the
difference, DISPUTED.

**Stage 2.** The post-site supplement includes travel, queue and disposal
only under the basis the consultant signed; return travel *per contract*
stays REVIEW while the rule is unconfigured; nothing after the lease is
billed without a signed basis; disposal required with no ticket is
*blocked*. A facility ticket that disagrees with GPS by more than fifteen
minutes is a **TIME DISCREPANCY — REVIEW**, never the larger number. R2 is
written with `supersedesRevisionId`; R1 stands.

**Three closes**, distinct — field, operational, financial — and a state
machine from OPEN to BILLING_READY with named blockers. `whyTheseHours`
explains 11.82 hours to the customer window by window with the evidence,
and lists what is *not included*.

**From the portal**, a customer views, signs and decides lines on their own
tickets — every entry resolved by the identity's binding and answered *no
such ticket on this account* otherwise; signatory authority for a portal
identity is bound to that identity.

---

## Review findings

1. **Invariants hold.** Unknown stays unknown; internal work is never on the
   customer's clock; the signed snapshot is frozen and amendments are
   revisions; discrepancies never resolve upward; three closes are three.
2. **Authorization is intact.** Twelve role procedures, every one mapped;
   three external procedures, every one mapped and scoped by binding; no
   bare procedure; sensitive additions for witnessing a signature,
   deciding a line, and managing signatory authority.
3. **The arrival changed my gate's bare-procedure pattern** to
   `\w+:\s*protectedProcedure\b` — a *mounted* bare procedure — which is more
   precise than the pattern I wrote. Accepted, and noted so no one wonders.
4. **The arrival edited my guards to the new counts** (external 10, +12
   internal) and extended the generator. I verified each edit reads a true
   count; the gate's step 8 confirms the generated document is current.
5. **Nothing here that I would have refused.** Had the review found a
   rounding-up, a client-declared scope, or a silent overwrite, this
   checkpoint would say so and the tranche would not have been promoted.

---

## Files (arrived)

`0048_site_signoff_chain.sql` · `_core/siteCloseout.ts` · `closeoutRouter.ts`
(12) · `portalRouter.ts` (+3) · `recordsAuthorization.ts` · `siteCloseout.test.ts`
(12) · drift guards · `ci-gate.sh` · `current-state.sh` · inventory

**Written by me:** this checkpoint.

---

## Not built, and named

PDF rendering of R1/R2 (the revision records and hashes exist; the documents
do not). Weather and road-hazard observations as their own timeline (the
document's `weatherObservations` and `roadHazardObservations`). GPS-derived
segments wait on a routing source (P0). The customer's live job board.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P0/P5** — no routing source.
