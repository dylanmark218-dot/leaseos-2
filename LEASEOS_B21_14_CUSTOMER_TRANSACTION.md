# LeaseOS — v21.14 Checkpoint: Customer Transaction & Field Closeout Completion (with v21.13.1 Documentation Truth Guards)

| | v21.13 | **v21.14** |
|---|---|---|
| Tables | 206 | **207** (+1) |
| Migrations | 48 | **49** |
| Role-authorized procedures | 263 | **264** (+1) |
| Externally-gated procedures | 22 | **29** (+7) |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,377 | **1,386** (+9: 5 truth guards, 4 transaction) |
| Test files | 67 | **69** |
| Parity | 206/206 | **207/207 column-level** |
| Client build | passes | **passes, with the signing screen and the vendor/facility shells** |
| CI gate | PASS | **PASS** |

Every count is read from the source by `scripts/current-state.sh`. Reserved
slots 0016/0017 untouched.

---

## v21.13.1 — the documentation drift was mine, and it is now guarded

The audit found three drifts and all three were real. The inventory carried a
hand-written *10 procedures* for the portal after the count became 22. It
carried *five* and *two universal permissions* as if current. And the
generated state kept listing *PDF rendering* and *Portal client UI* as
unimplemented after both existed — because a v21.12 edit to the generator's
narrative anchored on text that did not match and silently did nothing, the
same failure that produced the sensitive-permission drift in v21.9.1.

The inventory no longer carries any count it does not read: the portal row
points to the generated file; historical counts are marked HISTORY. And
`documentationTruth.test.ts` reads the source and the documents together: the
inventory's portal row may not hand-write a count; any *N universal
permissions* outside a HISTORY line must equal the array; the generated
state must show the source's external and universal counts; and the *Not
implemented* section may not name anything whose file exists in the tree —
eleven claim-to-path pairs, extended as things are built. The generator's
native-binding line was itself corrected by the new test: it counted lines
mentioning `NotOnDeviceError`, including the import; it now counts throws.

---

## v21.14 — a customer can now run the transaction

**Told at each step, once, on the existing queue.** Alerts travel on
`workflowNotifications` to `external:<identityRef>`, keyed once per identity
per kind per subject; the kinds are the customer-safe fourteen — arrival,
work start, delay, breakdown, notice, load and disposal complete, sign-off
ready, R1, R2, document ready, dispute update, billing update, job complete —
so nothing private has a kind to subscribe to. Load-level kinds default off;
the customer switches any of them. The hooks sit where the events happen:
the first site work is arrival and work start, a hold is a delay, `sitePrepare`
is sign-off ready, the signature is R1, the supplement is R2, a render is
document ready, an adjustment is a billing update, a reviewed dispute is a
dispute update, the completion package is job complete. The suite turns
delays off, records site work twice, and receives *Crew arrived* once and
*Delay recorded* never; two identities on one account each receive R1 once.

**Chain of custody from canonical loads.** Source → unit → movement →
destination, quantity always with its method — *12.4 m3 (scale)*, *quantity
not recorded (customer_stated)* — and evidence only as far as the disposal
ticket's own state: *verified (high)*, *on file, scan — proposed, not
certified — awaiting the contractor's verification*, *no disposal ticket
yet*. The chain is complete only when every load has a verified ticket.

**The approval queue and the timeline.** Tickets awaiting the signature,
lines awaiting a decision, unread alerts; and one chronological customer
record — events with their billing answer, the signature, revisions with
hashes, documents, adjustments, observations — from which company time is
absent, and which says so.

**The completion package.** One PDF over the frozen revisions, the
signature and its authority, the loads with their tickets and states, the
adjustments with hour-equivalents marked, and the rendered documents each
named by hash; rendered once per revision state; downloaded under audit.

**The screens.** The signing screen shows what the signature covers and
what it does not, lets the signer choose the authorities they intend to
exercise — the server decides which they may — carries the post-site basis
with restocking and post-trip fixed at *never billable*, and refuses a paper
signature without its scan's evidence record. Chain of custody, alerts and
preferences, the queue with accept/dispute per line, the timeline, and the
tip/bonus form with an hour-equivalent preview that says *not worked time*.
Vendor and facility shells at `/vendor` and `/facility` over the procedures
those identities already hold.

---

## Files

**New:** `0050_customer_alert_preferences.sql` · `customerAlerts.ts` ·
`customerAlertService.ts` · `documentationTruth.test.ts` (5) ·
`customerTransaction.test.ts` (4) · `SignOffScreen.tsx`, `ChainOfCustody.tsx`,
`AlertsPanel.tsx`, `VendorFacilityPortal.tsx`

**Changed:** `portalRouter.ts` (+7; billing-update hook) · `closeoutRouter.ts`
(+1; alert hooks) · `commercialRouter.ts` (dispute-update hook) ·
`recordsAuthorization.ts` · `CustomerPortal.tsx`, `viewModels.ts` · `App.tsx`
· inventory (counts removed) · `current-state.sh` (narrative; throws counted)
· drift guards

## Not built, and named

Email/SMS delivery of customer alerts (queued in-app only; the queue's
other channels exist). GPS on the board and route-derived segments (P0).
Quotes, change orders, budgets/WBS. Browser end-to-end tests of the screens.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending
written permission. **P0/P5** — no routing source.
