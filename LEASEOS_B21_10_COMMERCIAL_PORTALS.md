# LeaseOS — v21.10 Checkpoint: Commercial Core + External Portals (vendor, customer, facility)

| | Previous | New |
|---|---|---|
| Version | v21.9.1 | **v21.10** |
| Tables | 193 | **198** (+5; `customerAccounts`, `invoices`, `vendors` extended) |
| Migrations | 45 | **46** |
| Role-authorized procedures | 240 | **246** (+6) |
| Externally-gated procedures | 0 | **7** — a new gate, `externalProcedure` |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 188 | **194** (+6 internal; 7 external in a separate universe) |
| Sensitive (fail-closed) | 58 | **61** (+3 internal; 3 external writes) |
| Tests | 1,335 | **1,348** |
| Test files | 63 | **64** |
| Parity | 193/193 | **198/198 column-level** |
| CI gate | PASS | **PASS — step 7b added; PASS is now the single final line** |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## The commercial core: rules an invoice must pass before it exists

A customer account now carries terms — days to pay, a credit limit, whether a
PO or an AFE is required, billing frequency, a hold with its reason. A
purchase order or AFE is an authorization with an amount and a life, and
invoices consume it. A customer rate card prices service lines by code and
unit, versioned, superseding its predecessor; the generic `billingRateCards`
remain the fallback.

`commercial.billingCheck` answers *may this invoice be issued?* with named
findings: **account on hold**, **PO required**, **PO unavailable** — *PO
4500123 has $500.00 remaining of $5000.00; $1000.00 requested* — **AFE
required**, each blocking; **over credit limit**, review. The due date comes
from the terms. Lines are priced from the card with minimums applied, and a
line the card cannot price is a finding — *no rate on the customer's card* —
never a zero.

---

## The external gate

An external identity — a customer, a vendor, a disposal facility — is not a
domain-role user. `externalProcedure` is built like `roleProcedure` and no
weaker: the permission map is consulted at wiring time and an unmapped
procedure refuses to mount; the bearer token is hashed and resolved to
exactly one active identity; the identity's *kind* decides its permissions
and its *binding* decides its scope — **the request never names an account**;
every decision is an audit row; a write from outside is refused when its
audit row cannot be written.

The token is shown once at invitation and stored only as a hash. A customer
identity asking for a vendor's statement is told it *does not hold
portal.vendor.read*. A dispute filed against another customer's invoice is
*no such invoice on this account* — the binding decided, not the request.

**Pinned by test and by gate step 7b:** the portal router mounts no role
procedure; no internal router mounts an external one; every
`externalProcedure(` call site is mapped and the count is 7.

---

## What comes in from outside becomes a record only when a person accepts it

A vendor submits a bill: it must add up, it must not repeat an invoice number
already on file, and a missing purchase authorization is noted for the
four-way match to hold. It enters as SUBMITTED, idempotent by content —
resubmitting the same bill returns the same submission. The office accepts it
with the entity it is billed to, and only then does a `vendorBills` row exist
— *received, unmatched*, into the match, not past it. The vendor's statement
shows each submission's fate and each bill's stage through to *paid*.

A facility submits a scale ticket. Weights that reconcile with the
facility's own SHA-256 of its scale record are **high** confidence; weights
alone **medium**; a quantity alone **low**; weights that do not reconcile are
refused. Accepted, it becomes a `disposalTickets` row at *needs_review* from
source *facility_portal* with the hash in its evidence — the office still
verifies it against the load.

A customer disputes an invoice line; accepted, it becomes a `disputeCases`
row — the dispute engine that already existed — and the invoice is marked
disputed, so AR ages it in its own bucket.

---

## Gate hardening found by building it

My step 7b counted role procedures in the portal router with `grep -c`,
which exits 1 on a count of zero — the exact result I wanted — and under
`set -e` that killed the gate after it had already printed PASS. The count
now tolerates zero, the summary step is no longer named PASS, and **PASS is
the gate's single final line, printed only after every step.**

---

## Files

**New:** `0047_commercial_core_portals.sql` · `commercial.ts` ·
`portalIntake.ts` · `commercialRouter.ts` (commercial 4 + portalAdmin 2) ·
`portalRouter.ts` (7, external) · `commercialPortal.test.ts` (11)

**Changed:** `trpc.ts` (`externalProcedure`) · `recordsAuthorization.ts`
(internal permissions; the external universe) · `db.ts` · `routers.ts` ·
`schema.ts` · drift guards · `ci-gate.sh` (7b; final PASS) ·
`current-state.sh` · inventory

---

## Not built here, and named

The portal *client* — the customer's live job board, map, billable-time
proposal, chain-of-custody view, document centre, daily report — is UI on
top of these procedures and the surfaces, and it does not exist yet. The site
sign-off and post-site billing chain (frozen signed snapshot, post-site
authorization, multiple clocks, weather and road-hazard evidence, PDF
revision chain) is the next commercial tranche. GPS projections to customers
wait on a routing source (P0). External identities have a token; they do not
yet have MFA, expiry, or invitation acceptance flows.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P0/P5** — no routing source.
