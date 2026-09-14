# LeaseOS — v22.2 Checkpoint: Terms Complete the Closeout; COR and Insurance Packages

| | v22.1 | **v22.2** |
|---|---|---|
| Tables | 250 | **250** |
| Migrations | 58 | **59** (`0060`: package kinds) |
| Role-authorized procedures | 356 | **356** |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 90 | **90** |
| Tests | 1,447 | **1,452** (+5, `termsComplete.test.ts`) |
| Test files | 78 | **79** |
| Parity | 250/250 | **250/250 column-level** |
| CI gate | PASS | **PASS** |

No new procedures: this tranche finishes behaviour the existing ones
promised. Every count is read from the source. Reserved slots untouched.

---

## The minimum raises what is billed, never what was worked

A minimum-hours term — recorded with the rest of the account's terms and
approved by a second person — raises a short day's billable hours to the
minimum, and the snapshot **names the raise with its clause**: *Minimum 4 h
per TERMS-… v1 §3.1: 2.5 h billable raised to 4 h*. The events keep their
hours; `minimumApplied` carries what was billable before. A day above the
minimum is untouched; a ticket with nothing billable is not raised to a
minimum.

## Where the signatory wrote "per contract", the contract answers

The v21.11 supplement had a hook for the contract's return-travel answer,
fed by a JSON placeholder on the account. The approved terms now feed it,
with the placeholder as the fallback so nothing regresses: return travel
authorized *per contract* is included on the supplement when the terms say
yes, and stays REVIEW when no contract answers. The event itself is decided
at record time with its citation, as v22.1 established.

## COR and insurance packages

Two more kinds in the builder, with policies and completeness rules like
the rest. **COR** gathers the entity's approved written program versions —
each carrying its own content hash — acknowledgements, tailgate meetings,
inspections, verified training and incidents in the period; **a period with
no incidents is a statement in the manifest, not a blank**; voice
transcripts and approver identities are withheld and listed. **Insurance**
gathers policies with their coverage verification, claims, incidents and
escalated driving events; **premiums and identities are withheld and
listed** — the manifest never carries the premium. Tailgates, inspections
and training are company-wide records, as a COR audit is.

---

## Corrected on the way

Two fixtures fell through their `catch` and would have passed without
exercising the gather; they were made real. A gap assertion was
order-dependent under the full run because the COR gather is company-wide
by design; the test now asserts what its fixture controls.

## Files

**New:** `0060_audit_package_kinds.sql` · `termsComplete.test.ts` (5)

**Changed:** `siteCloseout.ts` (minimum) · `closeoutRouter.ts` (terms loaded
with the ticket; the supplement's contract answer) · `contractTerms.ts` ·
`auditPackage.ts` and `auditRouter.ts` (two kinds) · `schema.ts` · inventory
· generator

## Not built, and named

Terms deciding travel to disposal, queue and unload on the supplement (the
signed authorization governs those; only return travel carries a "per
contract" choice). Package bundles as archives. The older `double` money
columns.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
