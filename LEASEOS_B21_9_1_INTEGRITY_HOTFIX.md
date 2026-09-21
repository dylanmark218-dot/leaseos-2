# LeaseOS — v21.9.1 Checkpoint: Authorization & Financial Integrity Hotfix

| | Previous (claimed) | Previous (actual) | Now (generated) |
|---|---|---|---|
| Version | v21.9 | v21.9 | **v21.9.1** |
| Tables | 192 | 192 | **193** (+1) |
| Migrations | 44 | 44 | **45** |
| Procedures (role-authorized) | 240 | 240 | **240** |
| Bare `protectedProcedure` | 0 | 0 | **0** |
| Permissions | 186 | **188** | **188** |
| Sensitive (fail-closed) | 58 | **49** | **58** |
| Universal | 8 | 8 | **8** |
| Tests | 1,332 | 1,332 | **1,335** |
| CI gate | PASS | PASS | **PASS — with a new step** |

Every number in the right-hand column is read from the source by
`scripts/current-state.sh`. None is written by hand.

---

## What the audit found, and what I found about how I work

The audit reported four P0 findings. All four were real. I verified each
against the code before fixing it, and the first one is mine.

**1. Nine sensitive actions were never in the fail-closed set.** The array
held 49, not the 58 my checkpoint claimed. Six tranches — v21.1 through
v21.9 — each added its sensitive permissions with an unasserted string
replacement anchored on a comment line that an earlier tranche had already
moved. Each replacement silently did nothing, and each checkpoint *added*
the new count to the previous claim instead of reading the array. My own
first recount said 54 — it had picked up five names quoted inside comments.
The true numbers: **49 before, 58 now.** Awarding dispatch, granting an
override, changing enforcement, finalizing IFTA and GST returns, closing and
reopening a period, deciding a credit or a write-off are all now refused when
their audit row cannot be written, and a test pins all nine by name.

**2. A branch-confined grant passed every generic gate.** `authorize` treated
"no branch supplied" and "the record has no branch" as the same thing, and
nothing outside the authorization module ever supplied a branch. Now
`undefined` means the gate did not resolve one — a confined grant cannot be
judged there and fails closed; only a global grant passes — and `null` means
a caller loaded the record and found it company-wide, where confined grants
apply. Universal self-scoped permissions are unaffected. The test that had
pinned the old behaviour by name was rewritten to pin the distinction.

**3. Cash could cross entities.** Allocation compared customer *names*, and
two companies can each have an "ABC Energy". `customerAccounts` is identity:
one entity, one account, one name, resolved server-side and never supplied as
an id. An allocation requires the same entity and the same account. A credit
against an invoice takes its entity and customer *from the invoice*. A
legacy invoice with no entity is refused, not credited to an invented
entity 0 — that fallback is gone. A pre-account invoice takes the payment's
account on first application, same entity and name, and keeps it.

**4. Cash application raced.** Allocation now runs in one transaction with
the payment and invoice rows locked and balances recomputed under the lock.
Three simultaneous allocations of the same balance: **exactly one commits**,
and the suite proves it with `Promise.allSettled`.

---

## The documentation reset

`LEASEOS_CURRENT_STATE.md` is generated from the source — tables,
migrations, procedures, permissions with comments stripped, tests, native
bindings still unbound — and **CI gate step 8 regenerates it and fails if the
committed copy differs**. No count can be added rather than read again. The
old plans (`LEASEOS_BUILD_PLAN*`, `LEASEOS_MASTER_PROGRAMMING_MANIFEST_V*`)
carry a HISTORICAL banner. The inventory's hand-written sensitive count is
replaced by a pointer to the generated file.

Also from the audit: the portal shell now subscribes to connectivity changes
instead of reading `navigator.onLine` once at mount.

---

## Files

**New:** `0046_customer_accounts.sql` · `scripts/current-state.sh` ·
`LEASEOS_CURRENT_STATE.md` (generated)

**Changed:** `recordsAuthorization.ts` (nine sensitive; unknown ≠ none) ·
`accountsReceivable.ts` (identity) · `cashRouter.ts` (locked allocation,
derived credit, no entity 0) · `PortalShell.tsx` · `ci-gate.sh` (step 8) ·
`recordsAuthorization.test.ts`, `cash.test.ts` · inventory · `schema.ts` ·
historical documents bannered

---

## The audit's roadmap, adopted

v21.10 capital assets and CCA with the money-precision migration begun ·
v21.11 customer and commercial core · v21.12 parts, tires, inventory,
warranty · v21.13 digital twin and TCO · v21.14 external identity and portals
· v21.15 integration gateway · v21.16 telematics and video safety · v21.17
recruiting and onboarding · v21.18 audit package builder · v22.0 spatial —
with P9 verification and native field deployment as the two parallel tracks
that do not wait.
