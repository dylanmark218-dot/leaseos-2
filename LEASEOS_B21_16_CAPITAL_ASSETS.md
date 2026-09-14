# LeaseOS — v21.16 Checkpoint: Capital Assets + CCA + Asset Twin

| | v21.15 | **v21.16** |
|---|---|---|
| Tables | 218 | **221** (+3) |
| Migrations | 50 | **51** |
| Role-authorized procedures | 287 | **297** (+10, `assetRouter.ts`) |
| Externally-gated procedures | 29 | **29** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 68 | **71** (+3) |
| Tests | 1,394 | **1,402** (+8, `capitalAssets.test.ts`) |
| Test files | 70 | **71** |
| Parity | 218/218 | **221/221 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source by `scripts/current-state.sh` and the
gate reads the same files. Reserved slots 0016/0017 untouched.

---

## A truck is one identity

A capital asset links to the unit or trailer the shop already maintains —
*one truck, one identity* — and a second asset on the same unit is refused
by name. It carries acquisition, financing and disposal as facts in cents
with their evidence, and an owner-stated expected life. It enters **pending
capital review**; capitalizing or expensing is decided by someone other than
the recorder, from a threshold when the entity has one and as a *review*
when it does not. Disposal proceeds above cost are noted as a capital gain
outside the schedule, never folded into it.

## The class is a candidate, and the claim needs a verified rate

The CCA class is a **candidate with a source** — accountant, owner-stated,
system-inferred — and only an accountant-sourced class can be verified. The
class's rate is a tax rule row: seven classes seeded with **no rate, no
half-year answer, no incentive factor**, all unverified. The pool is
computed from facts — additions at cost, dispositions at the lesser of cost
and proceeds, recapture when the pool goes negative, terminal loss when the
class empties with a balance — while **the claim and the closing UCC are
UNKNOWN until a person verifies the rate**, and a rule that does not say
whether the half-year rule applies leaves the claim under review rather than
guessing. The suite shows the pool at 20,000,000¢ before the claim with the
claim null under the seeded rate, and 7,400,000¢ with a verified 40% and the
half-year rule.

## The schedule is a snapshot, reviewed by another person

The year-end schedule is built per class from the register and the prior
year's carried balances, snapshotted with a hash by one person, and reviewed
by another who is not the preparer, against an unchanged register. **An
unknown or partial schedule cannot be reviewed as a tax fact and carries no
balance forward**; only a fully computed one writes the class balances the
next year opens with.

## The twin names what it cannot know

Fuel, shop parts and labour, tire runs, distance, engine hours, downtime and
the asset's own cost and life, against what the unit has done. Cost per
kilometre and per hour exist only when every cost is known; replacement is
projected from the owner-stated life in years or kilometres, whichever comes
first at the observed rate. The suite asks for a unit's twin with nothing but
the asset on record and gets *unknown*, with five reasons: no fuel total, no
labour rate, a tire run without both odometers, no distance, and the
asset's — each named, none filled in.

---

## Files

**New:** `0052_capital_assets_cca.sql` (3 tables) · `capitalAssets.ts` ·
`ccaSeeds.ts` · `assetRouter.ts` (10) · `capitalAssets.test.ts` (8)

**Changed:** `recordsAuthorization.ts` (7 permissions, 3 sensitive, 10
mapped) · `routers.ts` · `schema.ts` · drift guards · inventory · generator

## Not built, and named

Financing amortization and interest as a ledger. The Class 10.1 per-vehicle
ceiling as a rule parameter. A year-end package document (the schedule is a
record; the accountant's package is not rendered). Money precision: the
newer tables are in cents; the older `double` money columns remain, forward
migrations only.

## Blockers — unchanged

**P9** — no verified rule; CCA class rates join the rest. **AER ST37 /
ST102 / Alberta 511** — pending. **P0/P5** — no routing source.
