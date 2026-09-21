# LeaseOS — v21.3 Checkpoint: IFTA on the Fuel Ledger

| | Previous | New |
|---|---|---|
| Version | v21.2 | **v21.3** |
| Tables | 174 | **176** (+2; `fuelTransactions` extended) |
| Migrations | 38 | **39** |
| Procedures (role-authorized) | 207 | **214** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 158 | **164** |
| Sensitive permissions | 52 | **53** |
| Tests | 1,248 | **1,263** |
| Test files | 56 | **57** |
| Parity | 174/174 | **176/176 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The selling point, made literally true

*The worker scanning fuel receipts is also preparing the quarterly return.*

The fuel-receipt form gained one optional field: **jurisdiction, as printed**.
The adapter carries it with `jurisdictionSource: "receipt"`, the commit writes
it, and the return reads it. Nothing else the worker does changes. A receipt
beats a statement: office may classify an unclassified fill by the operator's
recollection, and may not overwrite what the receipt said.

Distance is the other half, and it is where honesty costs something. There is
no routing source loaded, so **no kilometre is labelled GPS**. A trip's
odometer start and end give a distance; the operator says how much of it was
in each jurisdiction; the split is refused unless the fractions sum to one —
a split that loses or invents kilometres is not normalised. Each part enters
as `odometer_split`, `needs_review`, and whoever recorded it may not verify
it. A stated distance is `operator_stated` and says so.

---

## The return

The arithmetic is the standard one — fleet average from total distance and
fuel; each jurisdiction's taxable litres from its distance at that average;
net litres from taxable minus tax-paid litres bought there; tax from net
litres at the rate — and the suite pins the worked example: 4,000 km and
1,300 L across Alberta and BC, 3.08 km/L, Alberta net −226 L, BC net +224.7 L.

**The rate is a rule row, and nobody has verified one.** Six jurisdictions are
seeded with `ratePerLitre: null`, status `unverified`, so the return names
each rate as *unverified* rather than *missing* — a person knows what to
verify. The litres are reported; the tax is **UNKNOWN**; the determination is
*unknown*; and **finalizing is refused**: *a return cannot be finalized on an
invented rate*.

**Reconciliation is honest about its sources.** Receipts matched; fuel with
known jurisdiction; distance backed by an instrument versus stated; distance
verified versus not; and a second, independent estimate — the odometer
readings printed on the receipts themselves — reconciled against the recorded
distance. A unit recorded at 1,000 km whose receipts imply 500 km is flagged.
Where there is nothing to reconcile the figure is `null`, not 0%.

**Exceptions.** Fuel with no litres or no jurisdiction blocks; a unit with fuel
and no distance blocks — it moved, or the fuel is misattributed; a unit with
distance and no fuel is review — bulk-fuelled, or receipts missing; a distance
record straddling the quarter boundary is review with the date to split it at.

---

## Prepared, finalized, amended — and never overwritten

Preparing writes an `iftaReturns` row with the full summary and a SHA-256 of
it. Finalizing is another person, checks that the ledger still hashes to the
snapshot — *the ledger has changed since this return was prepared; prepare it
again* — and then applies the finalize decision. A new return for a finalized
quarter supersedes the old one, which becomes *amended*; nothing is edited in
place.

---

## Files

**New:** `0040_ifta.sql` · `iftaEngine.ts` · `iftaSeeds.ts` · `iftaRouter.ts`
(7 procedures) · `ifta.test.ts` (14)

**Changed:** `aiProposal.ts` (receipt form field) · `assistantCommitAdapters.ts`
/ `assistantCommitService.ts` (carry and write it) · `recordsAuthorization.ts`
(6 permissions, 1 sensitive, 7 mapped) · `routers.ts` · `schema.ts` · drift
guards · `ci-gate.sh` · inventory

---

## Genuine blockers — one new

**P0** — no routing source: distance is odometer or stated; `gps` and
`routing` exist as sources for the day one is loaded.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no verified rule. **IFTA rates join the list**: every return computes
its litres and holds its tax unknown until a person verifies a quarter's rate
matrix and loads it.

---

## Exact next tranche

The fuel ledger now has two remaining halves the fuel document named:
**bulk fuel** — tank inventory, dispense events, reconciliation against
purchases — which today shows up here as *distance without fuel, review*; and
**fleet card statement import**, matching statement lines to the receipts the
worker scanned, which would lift *receipts matched* from a count to a
reconciliation. Both are packs on the engine, not new engines.
