# LeaseOS — v20.19 Checkpoint: Roadside Events + Purchasing + Accounts Payable Spine

| | Previous | New |
|---|---|---|
| Version | v20.18 | **v20.19** |
| Tables | 144 | **150** (+6, `vendors` extended) |
| Migrations | 32 | **33** |
| Procedures (role-authorized) | 152 | **161** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 109 | **120** |
| Sensitive permissions | 33 | **38** |
| Tests | 1,077 | **1,105** |
| Test files | 48 | **49** |
| Parity | 144/144 column-level | **150/150 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched. P4 deferred a third time — see the end.

---

## The document's first instruction, followed first

"Check the current schema before adding any of them." I did, against every
family the document proposes:

| Exists | Extended | Did not exist — added |
|---|---|---|
| `vendors` | account ref, terms, preferred, 24h, status | `spendingLimits`, `roadsideServiceEvents`, `purchaseAuthorizations`, `vendorBills`, `vendorBillLines`, `customerRecoveryProposals` |
| `invoices` | **untouched** — it is Accounts *Receivable* | |
| `workOrders`, `maintenanceDefects` | untouched — a roadside event opens a defect in the existing table | |
| `mechanicRelease.ts` | untouched — `closureImpliesRelease` already says the right thing | |

The document's terminology correction is confirmed by the schema: `invoices`
carries acceptance tokens and disputes — money customers owe. What the company
owes a vendor is a `vendorBill`. The two meet at job costing; they are not the
same table and never were.

Not built this tranche: tire assets, consumable products, inventory lots,
warranty, purchase cards and statements, AR aging, period close. Each is a
family the document names; each is deferred rather than sketched.

---

## The flat tire, end to end — one test

02:15, Unit 142, right steer, near Grande Prairie, immovable, loaded, no
dangerous goods. The end-to-end test walks the whole chain as four different
people, and asserts the rule that holds at each link:

1. **Driver reports.** A critical defect opens in `maintenanceDefects`; the
   unit is held. The driver's statement — *"Blew the right steer... I'm
   okay."* — is stored as their words, not rewritten.
2. **Driver requests $2,200.** Above their $500 emergency limit, so it waits.
   The driver **cannot approve it** — not the permission, and not their own
   request even if they had it.
3. **Shop lead approves up to $2,500.** Within their configured cap.
4. **October 8, the bill arrives for September 30 service.** Flagged as an
   accrual candidate for `2026-09`, for a controller.
5. **Four-way match:** authorized one tire, driver confirmed one, evidence
   present, billed one. Match.
6. **Bookkeeper approves coding.** The response says `unitReleased: false`,
   explicitly, because someone will one day ask.
7. **The bookkeeper who approved cannot release payment.** The controller can.
8. **After payment: the defect is still open.** Nothing in AP touched it.
9. **Recovery proposed** because the customer's site condition caused the
   delay. Status `review_required`. The `invoices` table has zero rows for
   that job.

---

## The rules, each held by a test

**Spending limits are rows, not code.** `routeApproval` knows nothing about
what a driver's limit is; with no rows configured, everything is
"policy-controlled". Emergency limits apply only to emergencies.

**Three grants because they are three people.** `purchasing.request`,
`purchasing.approve` and `payment.release` are distinct. Payment release is
controller-only. A requester approving their own request is refused with
"does not approve it"; an approver cannot authorize beyond their cap, nor
below the estimate.

**Four-way match catches what three-way cannot.** Authorization ↔ operational
event ↔ evidence ↔ bill. Two tires authorized, two confirmed, two evidenced,
three billed: *mismatch*, naming all four figures. A bill for unit 218 against
an authorization and an event on 142 reports the disagreement from both sides.
Missing evidence is *partial*, never *match*. A mismatched bill cannot be
approved.

**Bill lines must add up.** Quantity × price per line; lines to the stated
subtotal, tax and total; credits negative, charges positive. A core charge is
reported **open even when the invoice shows the credit** — the credit is the
vendor's promise, and the ledger keeps the charge open until it clears.

**A vendor's invoice never makes a truck dispatch-ready.**
`billApprovalReleasesUnit` returns `false` for every severity, and
`releasePathFor` names the existing mechanic-release chain as the only way
back to service.

**A company expense is never a customer charge without a person.**
`proposeCustomerRecovery` returns `review_required` with `invoiced: false` as a
literal, or `not_recoverable` with a reason. Nothing in this tranche writes to
`invoices`.

**Cost belongs to the period the service happened in.** `assessAccrual` says
so and marks `requiresControllerApproval: true` as a literal — it proposes an
entry; a controller makes it.

**Unknown movability is inspection-required, never fine.** An immovable truck
with dangerous goods on board, or a driver whose safety is not confirmed,
escalates to safety before maintenance.

---

## Two fixture corrections, no code corrections

The four-way test expected three variances for a bill on the wrong unit and
got four — because the unit disagrees with *both* the authorization and the
event, and the engine correctly reports both. And a purchase request with
`reason: "x"` failed the schema's three-character minimum. Both were my
fixtures; the engine was right both times.

---

## Files

**New:** `0034_roadside_purchasing_ap.sql` · `purchasing.ts` · `purchasingRouter.ts`
(9 procedures) · `purchasingAp.test.ts` (27)

**Changed:** `recordsAuthorization.ts` (11 permissions, 5 sensitive, 9 mapped)
· `routers.ts` (mount) · `schema.ts` · drift guards · `ci-gate.sh` ·
`PROCEDURE_AUTHORIZATION_INVENTORY.md`

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative tax, HOS, retention or funding rule loaded.

---

## On P4, deferred a third time

P4 — encrypted field storage — was next after v20.17, then after v20.18, and
is next again now. Each deferral was for a document that arrived with a real
gap in it, and each gap was worth closing. But the product this trunk
describes is a tablet at a cardlock, at a roadside at 2 a.m., at a facility
with no signal — and none of that works until P4 does. I would not defer it a
fourth time. The accounting families left unbuilt here — tires, inventory,
warranty, cards, statements, period close — are all better built *after* the
capture path is durable, because every one of them starts with a photograph.

**v20.20 — P4 Secure Field Runtime.** Encrypted device database and file
vault, keystore-backed keys, device identity and revocation, sync receipts with
hash verification, conflict handling, storage-pressure rules.
