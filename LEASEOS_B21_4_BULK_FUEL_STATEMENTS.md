# LeaseOS — v21.4 Checkpoint: Bulk Fuel, Statement Import, Anomalies

| | Previous | New |
|---|---|---|
| Version | v21.3 | **v21.4** |
| Tables | 176 | **181** (+5; `fuelTransactions` extended) |
| Migrations | 39 | **40** |
| Procedures (role-authorized) | 214 | **221** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 164 | **169** |
| Tests | 1,263 | **1,274** |
| Test files | 57 | **58** |
| Parity | 176/176 | **181/181 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The fuel ledger's two remaining halves

The fuel document (v20.18) deferred three things: bulk fuel, the fleet-card
statement import, and an anomaly panel. All three are here, and they close
two loops opened in v21.3.

**A bulk dispense is a fuel transaction.** Unit, litres, the tank's
jurisdiction with `jurisdictionSource: bulk_tank_location`, purpose
`bulk_tank_dispense`, treatment `bulk_fuel_inventory`. IFTA counts it as
tax-paid litres where the tank stands — the unit that read as *distance
without fuel, review* in v21.3 now reconciles. A metered dispense whose meter
readings disagree with the stated litres is refused; a stated one enters
`needs_review`; nothing bigger than the tank is accepted, as a dispense or as
a reading.

**A tank is inventory.** Between two readings, expected is opening plus
purchases minus dispenses; variance is measured minus expected. Negative
variance is fuel that *left without a dispense* — unrecorded fill, leak or
theft — and the reason says so. Positive is an unrecorded purchase or a
misread. An expectation above capacity is never called reconciled. The
tolerance is the company's parameter about its own yard, not a regulatory
figure.

**A statement line is evidence of a transaction, never a transaction.** The
import is idempotent by content hash. Every line is matched server-side
against the ledger's card transactions: same card, time within the window,
same total — using the matcher v20.18 built. A line that could be two
receipts is *ambiguous, a person decides*, not matched to the first. A
transaction already claimed by another line is not offered again. Matched
receipts are linked, marked `reconciled`, and — where the receipt had no
jurisdiction — take the statement's, sourced `fleet_card_statement`. The
unmatched lines are the finding: *no receipt on the ledger for this purchase —
nobody scanned it.* Card receipts the statement never claimed are listed too.
A person resolves a line to a later-captured receipt, with a reason; a line
already matched, or a receipt already claimed, is refused.

**Anomalies.** Four rules, each a comparison with the unit's own tank or
history: a fill bigger than the tank; two real fills within two hours; an
odometer that went backwards; consumption beyond twice the unit's median
once there are four readings to compare with. Exactly twice is not "far off".
The capacity rule is inert until units carry a tank capacity, and the
procedure says so rather than pretending.

---

## Files

**New:** `0041_bulk_fuel_statements.sql` · `bulkFuel.ts` · `fuelOpsRouter.ts`
(7 procedures) · `bulkFuel.test.ts` (10)

**Changed:** `recordsAuthorization.ts` (5 permissions, 7 mapped) ·
`routers.ts` · `schema.ts` · drift guards · `ci-gate.sh` · inventory

---

## Genuine blockers — unchanged

**P0** — no routing source. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P9** — no verified rule; IFTA rates included.

---

## Where the fuel line stands

Receipt → ledger → statement → IFTA → return: every step exists, every value
carries its source, and the two figures a person would ask for — *what did we
pay for that we have no receipt for* and *what left the tank that we did not
pump* — are answered by name. What the line still lacks is a routing source
for distance and a verified rate for tax, and both are P0/P9, not code.

## Exact next tranche

Two candidates. **Exception-centre sources for the fuel line** — unmatched
statement lines, tank variance beyond tolerance, and anomalies — so the yard
and the bookkeeper are told rather than asked to look; it is a pure addition
to the derivation and the service loader. Or **period close** on the finance
side: locking a period once its statements are imported, its returns
prepared and its bills matched, with the same append-only history the
enforcement setting uses.
