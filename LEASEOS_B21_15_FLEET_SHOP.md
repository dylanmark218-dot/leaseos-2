# LeaseOS — v21.15 Checkpoint: Fleet Shop OS

| | v21.14 | **v21.15** |
|---|---|---|
| Tables | 207 | **218** (+11) |
| Migrations | 49 | **50** |
| Role-authorized procedures | 264 | **287** (+23, `shopRouter.ts`) |
| Externally-gated procedures | 29 | **29** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 65 | **68** (+3) |
| Tests | 1,386 | **1,394** (+8, `fleetShop.test.ts`) |
| Test files | 69 | **70** |
| Parity | 207/207 | **218/218 column-level** |
| CI gate | PASS | **PASS — and its summary now reads the same files the generator does** |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## Stock is a derivation; a count is a movement

Parts have a number, a category, a unit, a core charge if they carry one,
and a minimum and maximum. Everything that happens to them is a signed row
in `partMovements` — receive, issue, return, core out, core returned,
warranty return, scrap, transfer, count adjustment — with a reason and a
person. **On-hand is the sum.** Average cost is weighted over receives; an
issue leaves at that average and carries it to the work order. Cores are
counted beside the parts, out with the issue and back with the return, and a
return beyond what is outstanding is refused. An issue beyond on-hand is
refused by the shortfall: *2 on hand, 5 requested — short by 3*. A physical
count adjusts the record to what was counted and **keeps the variance as the
movement**; counting is the shop lead's and sensitive. A part with a minimum
and no movement ever is *unknown, not zero*. The suite reads the ledger back
and finds exactly what happened, in order, nothing overwritten.

## A tire is in one place, and its kilometres are known or they are not

A tire has a serial, a size, a position type and — if a retread — the
casing it came from, with its retread count. It is installed in exactly one
axle position on one unit at a time (*2LO, 3RI*); a bad position, a tire
installed elsewhere, an occupied position, a trailer tire on a steer axle
are each refused by name. Measurements record tread and pressure against
the shop's own limits — configuration, not regulation. On removal, **its
kilometres exist only when both odometers were recorded**, and its cost per
kilometre only when kilometres and a purchase cost exist: 48,000 km at
1.29¢/km on the first run; then re-installed without an odometer, the
lifetime says *unknown* rather than reporting the half it knows as the whole.

## Warranty and recalls: verified, or unknown

A warranty policy is recorded unverified; verifying it needs the source
document in the vault. A claim under an unverified policy is *unknown* —
not eligible — and cannot be approved until the policy is verified; it can
be denied. The raiser may not decide; deciding is the controller's or
management's and sensitive; approval with a credit reconciles to a
`warranty_credit` bill line, and only that. A recall is external data:
recorded unverified, deduplicated by source and reference, and **no unit is
cleared of it until someone other than its recorder verifies it**;
completion needs the work order that did the work.

## Cost says what it knows

A work order's parts cost is the issues at their average; a part with no
cost on record makes it *a floor, not a total*; labour is unknown until a
rate is configured. A unit's cost rolls those up with its tire runs and
**names every reason it is partial** — the suite asks for the unit's cost
without a rate and gets parts, *labour unknown*, and no invented total; with
a rate, 62,000¢ and the tire at 1.29¢/km.

---

## Files

**New:** `0051_fleet_shop.sql` (11 tables) · `fleetShop.ts` · `shopRouter.ts`
(23) · `fleetShop.test.ts` (8)

**Changed:** `recordsAuthorization.ts` (10 permissions, 3 sensitive, 23
mapped) · `routers.ts` · `schema.ts` · drift guards · inventory ·
`ci-gate.sh` (**router discovery, not a hand-written list**) · generator

## Not built, and named

Fluids as measured inventory (the parts ledger holds them by unit, not by
volume). Reorder as a purchase authorization (the finding exists; it does not
raise one). Tire rotation planning. Shop labour rates as configuration
(supplied per query today).

## Blockers — unchanged

**P9** — no verified rule; the shop's tread limits are its own thresholds and
say so. **AER ST37 / ST102 / Alberta 511** — pending. **P0/P5** — no routing
source.
