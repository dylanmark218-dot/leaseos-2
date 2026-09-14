> **HISTORICAL — DO NOT USE AS CURRENT IMPLEMENTATION STATE.** This document describes an earlier plan. The implemented state is in `LEASEOS_CURRENT_STATE.md` (generated) and the per-release checkpoints.

# LeaseOS — Billing & Records Chain

**Companion to:** `LEASEOS_BUILD_SPEC.md` · `leaseos-prototype.html`
**Status:** engines built and tested (41 passing); schema + migration written; UI prototyped.

This treats numbering, the billing book, chain of custody, field-ticket sign-off and invoice
acceptance as **one milestone**, not five features. They share a spine, and building them
separately would mean three different ideas of what a tracking number is.

---

## 1. The rule everything else follows

> Every operational document has exactly one primary tracking number, every tracking number
> belongs to an authenticated actor and context, and every document traces backward to the job
> and forward to the invoice.

Two architectural consequences, both now enforced in code:

**The human tracking number is never the primary key.** Rows keep their autoincrement `id`.
`trackingReferences` is the universal index mapping a printed or spoken number to whatever table
owns the record. Renumbering a company, adding a branch prefix, or switching to two-digit years
must never require rewriting a foreign key.

**Format is configuration.** `JOB-2026-001842` and `CAL-JOB-26-0001842` are the same sequence
under different company settings. `server/_core/tracking.ts` takes a `SequenceFormat` — prefix,
branch, separator, year digits, month segment, padding, reset period — and no format assumption
is hard-coded anywhere else.

---

## 2. What was built this pass

| File | What it does | Tests |
|---|---|---|
| `server/_core/tracking.ts` | Number formatting, child numbering, period rollover, parsing for the search bar | 18 ✅ |
| `server/_core/billing.ts` | Billing-readiness gates, named blockers, charge-line maths | 15 ✅ |
| `server/_core/fieldTicket.ts` | Scope validation, signed-scope statements, partial acceptance, job reconciliation | 19 ✅ |
| `drizzle/schema.ts` | 10 new tables | — |
| `drizzle/0010_billing_records_chain.sql` | Migration + indexes | — |

Pure functions, no DB or clock dependency — so rollover at a year boundary and a declined
signature are both testable without a database. Same pattern as the geofence engine.

**New tables (13):** `trackingSequences`, `trackingReferences`, `billingBooks`, `loads`,
`disposalTickets`, `disposalBatches`, `dailyLogs`, `fieldTickets`, `fieldTicketLines`,
`fieldTicketSignatures`, `fieldTicketEvents`, `invoices`, `recordAmendments`.

---

## 3. What I added beyond the source document

### 3.0 Resolved: a field ticket is a scoped service event

Question 1 is settled and implemented. A field ticket covers **neither a job nor a trip
exclusively** — it is a billable service event with a required `jobId`, optional `tripId`/`loadId`,
and an explicit `scope`:

| scope | tripId | loadId | Used for |
|---|---|---|---|
| `job` | must be null | must be null | One signature covering the whole job |
| `trip` | required | must be null | One site visit, however many loads |
| `load` | required | required | Customers who sign per load |
| `service_event` | optional | optional | Standby, washout, callout, second operator |

Enforced by `validateFieldTicketScope()`, not by convention. A load-scoped ticket with no trip is
a data error, not a preference.

**Default:** one ticket per billable service occurrence, allowing a ticket to cover multiple loads
where the representative actually signs for the combined service period. Two visits to the same
site on the same day get two tickets — one signature must never be used to prove something that
happened hours later.

**Signature is a separate table.** `fieldTickets` records what the service was;
`fieldTicketSignatures` records who accepted or refused it; `fieldTicketLines` carries the
quantities; `fieldTicketEvents` the timeline. A ticket can be re-presented after an amendment, or
signed by a different representative on a later visit, without overwriting the first signature.

**Partial acceptance is the common case, and it works per line.** "I'll sign the three-hour
service but not the forty-five-minute standby" must not invalidate the accepted lines.
`fieldTicketLines.disposition` is `not_presented | accepted | disputed`;
`deriveSignatureStatus()` rolls those up; `splitByDisposition()` sends accepted lines to billing
and disputed lines to review. Both statements are kept — driver says 45 minutes, company says 20 —
because an erased dispute is a charge quietly written off.

**The ticket records facts, not money.** No rate or amount column exists on `fieldTicketLines` by
design. "45 minutes standby" is evidence; whether it becomes `45 × standby rate` is the rate
engine's decision. That separation keeps accounting logic out of field evidence.

**Voice boundary this creates:** the driver says *"company man signed but wouldn't accept the
standby."* The secretary sets signature = `partially_accepted` and the standby line =
`disputed`. It does **not** turn the driver's statement into an accepted billing fact.

### 3.1 Field ticket sign-off — the missing piece

The source document covers numbering and billing thoroughly but stops short of the moment that
actually determines whether you get paid: **a customer representative signing at the lease before
the truck leaves.**

`fieldTickets` models this properly:

- **The signer isn't a system user.** A company man or consultant has no login, so identity is
  *captured* (name, company, role, phone) rather than authenticated. Trying to force them into
  the user table would be wrong.
- **Offline by default.** Representatives sign at leases with no signal. `capturedOffline` is a
  flag, not an error path.
- **The payload is hashed at signing time.** Later edits don't silently change what was agreed —
  the job flags `amended_after_signature` and routes to review.
- **A refusal is data.** `declined` with a reason ("disputes the standby time") is far more useful
  to the office than an empty signature box, and `unavailable_onsite` is a distinct third state.
  Neither blocks the invoice; both route it to review.

### 3.2 Cost coding — why invoices actually get rejected

The document's billing states don't include AFE, cost centre, or PO. In practice a customer's
accounts payable will bounce an oilfield invoice with no cost coding regardless of how good the
documentation is. `billingBooks` carries `afeNumber`, `costCenter`, `purchaseOrder` and
`chargedToUwi`, and `evaluateBillingReadiness` treats a missing AFE/PO as **blocking**.

Ask the representative for it while they're standing there signing. Cheaper than chasing it in
three weeks.

### 3.3 Measurement method travels with the quantity

`loads.measurementMethod` — `meter | scale | gauge | estimate | customer_stated | unknown`. An
estimated 8 m³ and a weighed 8.7 m³ are not equally billable, and the billing engine can decline
to auto-generate a charge from an estimate. The document treats quantity as a bare number.

### 3.4 Invoice dispute is a real state, not an exception

The document's lifecycle ends `INVOICED → CLOSED`. Reality includes `sent → viewed → disputed →
re-submitted`. `invoices` models `viewedAt` (so "we never received it" is answerable), a
tokenised `acceptanceToken` for client-side approval without a login, `disputeReason`, and
`externalPortalRef` for customers who require submission through OpenInvoice, Cortex or similar.

### 3.5 Delegation is recorded on the record, not inferred

`trackingReferences` carries `issuedByUserId`, `onBehalfOfOperatorId` and `delegationReason`
together. When the office enters a paper log for a driver, the record shows both — it never
appears as though the driver typed something they didn't.

---

## 4. AI Secretary — what can be filled by voice

The user's specific ask: what a driver can dictate rather than type. Each row is a **form
definition** for the single extraction engine, not separate code.

### Directly billable (highest value — these are the items lost on paper)

| Spoken | Fields extracted | Why it matters |
|---|---|---|
| "Company man had me stand by about forty-five minutes" | standby duration, authorised-by, reason | Standby is billable and routinely goes unrecorded |
| "Ran the extra two hundred feet of hose" | equipment extra, quantity | Line item that rarely reaches the ticket |
| "Washed out after at the facility" | service performed, location | Chargeable service |
| "Second man on site from ten till two" | personnel, hours | Crew charges |
| "Pumped for about three hours" | PTO/pump hours | Some contracts bill on pump hours, not truck hours |
| "AFE is eight-eight-four-one dash twenty-two" | AFE number, source: rep-stated | Prevents an AP rejection |
| "Used the steamer for twenty minutes" | specialty equipment, duration | Specialty rate line |

### Operational record

| Spoken | Fields extracted |
|---|---|
| "Got there around ten, waited eight minutes for the scale" | arrival (approximate), wait, delay reason |
| "Eight thousand litres, metered" | quantity, unit, measurement method |
| "Odometer's two eighty-four two ninety-one" | odometer reading |
| "Took two hundred and twelve litres at the Petro-Pass, card ending 4417" | fuel: volume, site, card |
| "Swapped onto trailer 14 at the yard" | trailer change, time |
| "Pump's grinding on start-up, same as yesterday" | defect, system, recurrence |

### Safety & compliance

| Spoken | Fields extracted |
|---|---|
| "Tailgate with Kyle and Marcus, talked H2S and the wind" | attendees, hazards, controls, PPE |
| "Washed out about two km east of the lease gate" | road observation, GPS, severity |
| "Company man told me to take the north road instead" | customer instruction, who gave it, time |
| "Near miss — pickup came around the corner wide" | incident type, description, no injury flag |
| "Lost radio about six km in on 7A" | comms dead zone, road, channel |

### Reconciliation

| Spoken | Behaviour |
|---|---|
| "Am I done for today?" | Reads actual dispatch state — never guesses |
| "What am I missing?" | Diffs trips vs. loads vs. disposal tickets and names the gap |
| "Close me out" | Walks the open duty entry, missing tickets, then reads back before committing |

### Rules that don't bend

1. **"Around ten" is stored as `10:00` with `precision: approximate`** — never `10:00:00`.
2. **Read-back before commit**, always, for anything touching compliance or billing.
3. **The secretary records, it never diagnoses.** "Grinding on start-up" becomes a defect with the
   driver's words; a mechanic decides what it is.
4. **Voice-extracted values are `pending` until confirmed** and cannot generate an invoice line —
   `calculateChargeLines` excludes unverified sources rather than quietly including them.
5. **Customer instructions are captured verbatim.** "The company man told me to take the north
   road" protects the driver if that road turns out to be restricted.

---

## 5. Billing readiness — the seven gates

`evaluateBillingReadiness` returns state, `completionPercent`, and **named blockers**. Never
"incomplete" — office staff need to know which phone call to make.

| Gate | Blocking? |
|---|---|
| All trips marked complete | Blocking |
| Load tickets present for every load | Blocking |
| Disposal tickets verified | Blocking |
| No unconfirmed values remaining | Blocking |
| Daily logs complete | Blocking |
| Rate card + AFE/PO present | Blocking |
| Field ticket signed (where required) | Blocking if unsigned/presented; **review** if refused, partially accepted, or no rep on site |
| Amendments after signature | Review |

`refused` and `partially_accepted` deliberately do not block. A customer refusing to sign is a
commercial problem for a human, not a reason for the software to freeze an invoice — and under
partial acceptance the accepted lines bill immediately while only the disputed ones wait.

---

## 6. Build order for this milestone

Slots between Phase 1 and Phase 2 of the main plan — the audit log (Phase 1, item 9) must land
first, since `recordAmendments` depends on the same append-only discipline.

| # | Task | Depends on |
|---|---|---|
| B1 | `db.ts` functions + `issueTrackingNumber` (transactional read-modify-write on `trackingSequences`) | migration 0010 |
| B2 | Seed default sequences; admin UI for formats | B1 |
| B3 | Billing book auto-created with every job | Phase 1 jobs UI |
| B4 | `loads` + `disposalTickets` wired to `tripStops` | B1 |
| B5 | Disposal batches (many loads → one ticket) | B4 |
| B6 | Field ticket generation, scope validation, per-line dispositions, offline signature capture + payload hashing | B3 |
| B6b | Ticket reconciliation at job closeout (`reconcileJob`) | B6 |
| B7 | `evaluateBillingReadiness` surfaced on the billing book screen | B4, B6 |
| B8 | Charge-line generation from verified sources only | B7 |
| B9 | Invoice + tokenised client acceptance link | B8 |
| B10 | Dispute handling + evidence package | B9 |
| B11 | Master tracking search (parse → resolve → walk the chain) | B1 |
| B12 | Daily log book; duty records reference it | Phase 1 |
| B13 | End-of-day reconciliation via the secretary | B12, Phase 3 |

**Concurrency note for B1:** issuing a number is a read-modify-write. It must run in a transaction
with a row lock (`SELECT … FOR UPDATE`) on the sequence row, or two drivers creating trips in the
same second will collide. The unique index on `trackingReferences.trackingNumber` is the
backstop, not the mechanism.

---

## 7. Open questions

1. ~~Does a field ticket cover a trip or a job?~~ **Resolved** — scoped service event, see §3.0.
   Remaining sub-question: should the default scope be a per-customer setting, or chosen by the
   driver per ticket? Suggest per-customer default, driver-overridable.
2. **Who may invoice a job with a declined signature?** Suggest manager-and-above, with the
   decline reason shown on the approval screen.
3. **Signature retention** — how long are signature images kept, and does a legal hold on the job
   extend it? Ties into the existing `complianceArtifacts` retention fields.
4. **External portals** — is OpenInvoice/Cortex submission in scope, or is emailed PDF plus the
   acceptance link sufficient for the pilot?
5. **Tax handling** — GST only, or multi-jurisdiction? Affects whether `taxCents` needs to become
   a line-level breakdown.
6. **Sequence starting numbers** — if the company is migrating off a paper book, sequences should
   start at the next paper number rather than 1. `advanceSequence` already accepts `startAt`.

---

## 8. One thing worth stating plainly

The disputed invoice in the prototype (`INV-2026-000388`) is the argument for this whole milestone:
GPS proves the truck sat on site for 92 minutes, but nobody signed for it at the lease, so the
standby charge is likely to be written off.

Good telemetry does not win that argument. A signature at the lease does. That is why field ticket
sign-off belongs in the same milestone as billing, not in a later phase.
