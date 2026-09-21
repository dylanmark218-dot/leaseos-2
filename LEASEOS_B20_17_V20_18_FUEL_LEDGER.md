# LeaseOS — v20.18 Checkpoint: Fuel & Energy Ledger

| | Previous | New |
|---|---|---|
| Version | v20.17 | **v20.18** |
| Tables | 141 | **144** |
| Migrations | 31 | **32** |
| Procedures (role-authorized) | 152 | **152** |
| Bare `protectedProcedure` | 0 | **0** |
| Assistant forms | 4 | **5** (`fuel_receipt`) |
| Typed commit targets | 4 | **5** (`fuel_transaction`) |
| Tests | 1,044 | **1,077** |
| Test files | 47 | **48** |
| Parity | 141/141 column-level | **144/144 column-level** |
| CI gate | `scripts/ci-gate.sh` | **PASS** |

Reserved slots 0016/0017 untouched. P4 moves to v20.19.

---

## What this corrects

In v20.15 I mapped `fuel_receipt` onto the `expense_receipt` form. That was the
"generic expense" mistake the specification names: it would have made every
fuel purchase a receipt with a total, and it would have let the person who
scanned it look like the person whose expense it is.

Fuel now has its own form, its own domain record, its own fingerprint key, and
a classifier whose first rule is that **scanning a receipt establishes who
scanned it and nothing else.**

---

## Four questions, four answers, four columns

`fuelLedger.ts` answers, separately, who fueled, who paid, what consumed it
and whose record it is. The specification's cases, each pinned by a test:

| Case | Payer | Purpose | Treatment | Whose books |
|---|---|---|---|---|
| Company card, company unit | company | vehicle operation | operating expense | company |
| Worker pays, own vehicle, assigned travel | worker | employee travel | reimbursement pending | company; worker evidence kept |
| **Owner pays for a company truck** | owner | vehicle operation | **reimbursement / equity review** | company — *not* owner personal |
| Contractor, own truck, own account | contractor | contractor operation | contractor's own | contractor |
| **Company card in a contractor truck** | company | contractor operation | **fuel advance** → settlement line | company |
| Bulk tank | company | bulk purchase | **inventory**, not a unit expense | company |
| Declared personal | worker | personal | personal review | **nobody's** — private to the fueler |
| Own vehicle, worker paid, purpose unknown | worker | unknown | **review** — assumed neither | — |
| **No card token** | **unknown** | unknown | review | **none** |

`contractor_own_expense` is one value beyond the specification's treatment
list: a contractor buying fuel for their own truck is neither
reimbursement-pending nor an advance — it is their record, not the company's,
and the ledger has to be able to say so. No treatment says *deductible*;
a test greps for it.

**Worker-side split.** `summarizeWorkerFuel` puts reimbursed fuel under
"employer reimbursed", never under "personally borne" — a partial reimbursement
counts only its shortfall as borne. Pending is neither; it goes to review.

---

## Hints are not bindings

The slip prints "Unit 142" and "•3812". Both are stored as
`unitNumberHint` and `cardLastFourHint`. The unit and card that **bind** the
transaction come from the assignment and the card token the proposal was
opened against — `fleetCardId` joined `loadId` and `facilityId` as a
server-resolved proposal column.

When the hint contradicts the binding, the commit is refused for a person to
look at — not rebound silently in either direction. Two end-to-end tests: a
slip showing •9999 against a proposal opened on •3812, and a slip showing unit
218 against an assignment on 142.

**Card numbers.** `fleetFuelCards` stores a provider token and exactly four
digits. The adapter refuses a card hint that is anything but four digits, with
the message "nothing more is ever stored." A query over every column in the
schema confirms no PAN-shaped column exists.

---

## What is enforced today, and what waits on a fact the server cannot yet resolve

Today the execution branch resolves the payer from a fleet-card token, or
resolves it as **unknown**. A fill with no token lands as
`payerType: unknown`, `unknown_review_required`, with **no expense record on
anyone's books** — tested. That is the correct fail-closed answer.

The classifier fully supports personal payment, contractor accounts and
owner-paid cases, and every one of those paths is tested at the engine. What
does not exist yet is a server-resolved *declaration* that a payment was
personal — a fact the worker states at capture, not one inferred from the
absence of a card. Until that column exists, "no card" means "unknown", never
"the worker paid." That is deliberate: the alternative is exactly the
inference the specification forbids.

---

## The boundaries that stayed boundaries

**HOS.** A confirmed fill produces a `FuelHosContext` with
`writesDutyStatus: false` as a literal, and `ruleConclusion: "unknown"` while
no authoritative rule is loaded (P9). Even loaded, off-duty fueling yields
`requires_status_review`, never a reclassification. The end-to-end test
asserts the stored conclusion is `unknown`.

**Expense record.** Still the financial record, still a draft, treatment
still `unknown_review_required`. The fuel transaction hangs off it.

**Fingerprint.** Fuel keys on vendor, date, total, **quantity, card last four
and unit** — two same-day fills at the same cardlock for the same total are
plausible; two with the same quantity, card and unit are the same fill. A
second photo of the same fill is refused end-to-end.

**Statement ≠ duplicate.** `matchStatementLine` treats a card statement line
and a receipt as two evidence sources for *one* transaction: match, match with
variance, or no match. The opposite of a duplicate. The import pipeline that
feeds it is deferred; the semantics are not.

---

## Deferred, honestly

Bulk tank inventory and dispense events (tables not yet created), the
statement import pipeline and monthly reconciliation, the anomaly panel
(tank-capacity exceedance, odometer regression, fills eight minutes apart), and
`fuelAccounts` wiring — the table exists, nothing writes to it yet.

---

## Files

**New:** `0033_fuel_energy_ledger.sql` · `fuelLedger.ts` · `fuelLedger.test.ts` (33)

**Changed:** `aiProposal.ts` (form) · `documentExtraction.ts` (own mapping;
odometer, price, auth code human-only) · `documentFingerprint.ts` (fuel key) ·
`assistantCommitAdapters.ts` (adapter) · `assistantCommitService.ts`
(resolution, classification, execution, auto-file) · `schema.ts`

---

## Exact next tranche

**v20.19 — P4 Secure Field Runtime.** Unchanged in scope: encrypted device
database and file vault, keystore-backed keys, device identity and revocation,
sync receipts with hash verification. The fuel ledger adds one requirement to
it — the "five seconds at the pump" capture has to work at a cardlock with no
signal and prove on reconnection that the quantity was not altered.
