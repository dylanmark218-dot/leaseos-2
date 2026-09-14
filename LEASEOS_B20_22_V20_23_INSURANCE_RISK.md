# LeaseOS — v20.23 Checkpoint: Insurance & Risk

| | Previous | New |
|---|---|---|
| Version | v20.22 | **v20.23** |
| Tables | 164 | **173** (+9) |
| Migrations | 36 | **37** |
| Procedures (role-authorized) | 182 | **194** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 138 | **147** |
| Sensitive permissions | 46 | **49** |
| Tests | 1,179 | **1,198** |
| Test files | 52 | **53** |
| Parity | 164/164 column-level | **173/173 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched. Next since v20.20, built on what the
three tranches between put underneath it.

---

## Six statuses, because two things that look alike are not

| Status | What it means | Effect |
|---|---|---|
| `coverage_verified` | A person confirmed it with the insurer; proof verified | none |
| `coverage_reported` | The company says so; nobody confirmed | review |
| `document_missing` | No proof on file — coverage may well exist | **review** |
| `document_expired` | Proof out of date — policy still runs | **review** |
| `coverage_expired` | The policy itself is past expiry | **blocked** |
| `coverage_unknown` | No policy on record | **blocked** |

The whole point is the middle two. A pink card nobody uploaded does not mean
the truck is uninsured, and the reason string says so: *"coverage is not
assumed absent."* `dispatchInsuranceGate` separates blockers from office
actions; only an expired or absent **policy** blocks. The end-to-end test
puts a unit under a verified policy with no proof on file and dispatch gets
`review` with zero blockers — then office uploads the card, verifies with the
insurer, and dispatch gets `ready`.

`coverage_reported` is the default on recording. Verifying with the insurer
is a separate act with its own permission; dispatch is refused it.

---

## One policy, fifty trucks, one document

Policy → coverages → covered entities. Assigning three units to a policy
whose document is in the vault creates three `evidenceRelationships` rows
with role `insured_under` and **one** evidence record — the test counts both.
The certificate on a tablet at a roadside is that one record, related.

**Customer requirements live apart from company policies**, and are matched:
MATCH / GAP / UNKNOWN per requirement, with a readiness percentage. A limit
below the customer's minimum is a gap that names both numbers; a missing
additional-insured endorsement is a gap; a policy that is reported but
unverified is **unknown, not gap**. A certificate cannot be issued on
unverified coverage — a certificate attests to something, and the test
asserts the refusal.

**One renewal, twenty-seven customers.** The renewal calendar buckets by days
to expiry — expired / 7 / 14 / 30 / 60 / 90 — with an action per bucket, and
for each policy lists the customers whose certificates it invalidates.

---

## A recovery is added beside the cost, never subtracted from it

The specification's collision: tow 2,400, repair 31,000, rental 5,000,
cleanup 1,800 — gross loss **40,200**. Insurer approves 32,500: receivable
outstanding 32,500, unrecovered 7,700, deductible 5,000. Payment arrives:
receivable **0**, gross loss **still 40,200**, and the four costs are still
on the claim. Insurance receivable is its own thing, distinct from customer
AR; `claimFinancials` returns both sides.

A claim links to the incident that caused it, and the test writes an original
driver statement, opens the claim against it, records costs and recoveries,
and reads the statement back **unchanged**. A loss dated outside the policy
period is refused.

---

## Who sees what

A driver reads a summary — status and policy ref; the assessment carries no
premium, and a test asserts it. Verifying coverage, issuing a certificate and
recording claim money are three sensitive permissions. Claim financials are
bookkeeper, controller and management; office opens claims but is refused
the money.

Roadside gets `insurance_proof` items only — category, coverage type, status,
policy ref — on the P4 allowlist. Nothing about premiums or claims reserves
leaves the office on a tablet.

---

## Deferred

Policy installments and premium allocation to units and cost centres
(`insurancePolicies.annualPremium` is recorded; the allocation feeds the
unit-cost view that P7 builds), the fleet schedule / statement of values
generator, the unit add/remove onboarding workflow, loss-run analytics, and
OCR classification of insurance document types into the P3 extraction
pipeline. Each has its tables or its hook now.

---

## Files

**New:** `0038_insurance_risk.sql` · `insuranceRisk.ts` · `insuranceRouter.ts`
(12 procedures) · `insuranceRisk.test.ts` (18)

**Changed:** `recordsAuthorization.ts` (9 permissions, 3 sensitive, 12
mapped) · `routers.ts` · `schema.ts` · drift guards · `ci-gate.sh` · inventory

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative rule loaded in any of five families.

---

## Where this leaves the trunk

From v20.2 at 87 tables, 17 migrations and 472 tests to **173 tables, 37
migrations, 194 role-authorized procedures and 1,198 tests**, every
checkpoint gated from an empty database, every regulatory figure in every
document held as an unverified claim, and every AI or OCR value routed
through one audited, allowlisted, independently authorized commit boundary.

The backend now describes a company's whole operating day. What it does not
have is a screen. **v21.0 — Portal Foundation** is the next tranche and the
first UI one: `PortalShell`, the switcher, My Day, the operational inbox,
universal search and the assistant — composed from `portals.mine`, which has
known which portals each person opens since v20.14.

---

## Promotion review (appended)

*The sections above arrived in the working tree between 06:44 and 06:51,
after the v20.22 checkpoint at 06:40 — the same pattern as v20.14 and v20.15.
I did not write them and am not claiming to. What follows is what I verified,
what I found, and what I changed before promoting.*

### Verified before running anything

| Invariant from the specification | Held? |
|---|---|
| Six coverage statuses; `document_missing` ≠ `coverage_expired` | Yes — the policy's expiry is decided before the document is examined; a rejected proof degrades to `document_missing` (review), never to "uninsured" |
| Dispatch blocked only by an absent or expired *policy*; missing paper is office work | Yes — `dispatchInsuranceGate` separates blockers from office actions |
| Insurance recovery never erases the repair expense | Yes — costs and recoveries are summed side by side; the receivable clears on payment and the costs remain |
| Driver's original statement untouched by a claim | Yes — `claimOpen` reads `originalStatement` and reports it preserved; nothing writes it |
| Customer COI requirements matched as MATCH / GAP / UNKNOWN, unknown when unverified | Yes |
| One renewal names every customer whose certificate it invalidates | Yes |
| Reserved slots 0016/0017 | Untouched |

Gate on the unmodified tree: 173/173 column-level, 1,198 tests, 194 procedures.

### What I found, and changed

**Roadside mode was built beside the P4 allowlist, not on it.** Insurance
emitted `"insurance_proof"` as a bare literal that happened to match
`ROADSIDE_PACKAGE_CATEGORIES` — no import, no check. Rename it on either side
and they diverge silently; add a future insurance category and nothing asks
P4 whether it belongs on the roadside screen. The whole point of the allowlist
is that no module decides for itself. `roadsideInsuranceItems` now imports
`roadsidePackagePermits` and drops anything it does not permit, fail-closed;
`INSURANCE_ROADSIDE_CATEGORY` is a single constant asserted, by test, to be
one the allowlist names verbatim.

**Four ordering cases pinned.** An expired policy with a perfectly verified,
current proof card is `coverage_expired` — the card does not resurrect the
policy. A current policy with an expired card is `document_expired` — the
truck is still insured. A renewal beats its expired predecessor for the same
coverage. And `coverage_reported` holds even with a verified card, until the
insurer has confirmed.

**One mistake of my own:** I wrote a `require` into an ESM test file. Fixed
by using the import the file already had.

### After promotion

Tests 1,198 → **1,205**. Everything else in the table above holds.
