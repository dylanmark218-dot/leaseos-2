# LeaseOS — B18: Billing Adjustments, Disputes & Third-Party Work

**Status:** **460 tests, 22 files, zero failures.** 87 tables · 17 migrations · typecheck clean.

Answers: *office staff need to change billing when clients dispute work, including work done by
third-party contractors and third-party callouts.*

---

## 1. Adjustments are new records, never edits

A finalised invoice and its hashed snapshot (B11) are immutable. Office staff correct billing by
issuing a **credit, debit, write-off, reclassification or rate correction** that references the
original.

`effectiveInvoiceTotal` derives what is owed from the original plus every adjustment. The original
figure is never overwritten, so *"what did we originally charge?"* and *"what did we change after?"*
remain two separate, answerable questions — which is exactly what you need when a client asks why
their invoice moved.

---

## 2. The trap in third-party work: a dispute has two sides

**This is the part worth getting right.**

A client disputes 45 minutes of standby. The work was performed by a subcontractor. Two decisions
follow, and they are genuinely independent:

| | Client side | Payable side |
|---|---|---|
| Sub performed as instructed | Credit the client | **Pay the sub in full** — credit comes out of margin |
| Shortfall was the sub's | Credit the client | Recover from the sub as a claim |
| Shared | Credit the client | Split, and notify |

`resolveSubcontractedDispute` returns both sides plus the margin impact, and **never claws back more
than the sub is owed**. Automatically short-paying a sub because a client complained is how a
company either eats margin it did not need to, or stiffs someone who did the work correctly.

Reducing a payable sets `requiresSubcontractorNotice: true`. That is a **claim against them**, not a
bookkeeping entry — they have to be told, and `payableAdjustments` carries the notice and
acknowledgement.

`checkSubcontractLine` also catches two errors that otherwise surface at month end: margin hidden on
a pass-through line, and a marked-up line billed below cost.

---

## 3. Third-party callouts — the 2am revenue leak

The scenario: a driver does work at 02:00 on the word of someone from **another company** on the
same lease. Nobody establishes who is paying. Left alone it becomes an unpaid invoice or a quiet
write-off.

`assessCalloutBilling` records who called, their company, their **claimed** authority, and whether
that authority was **verified against the client's signatory list**.

- Verified client representative → `yes`
- Third-party operator, unverified → `review`: *"confirm the client accepts the charge before invoicing"*
- No bill-to party established → `no`: *"Office follow-up required before this becomes revenue"*
- Authority `unknown` → `no`

**Emergency callouts are never blocked** — the work happens regardless — but they are never assumed
payable either. They return `review` with *"work proceeds regardless. Establish the payer before
invoicing."*

Same principle as everywhere else in LeaseOS: **unauthorised is not the same as unbillable, and
neither is silently resolved.**

---

## 4. Authority is banded, and refusals point somewhere

A clerk cannot write off five figures. Ladder: clerk $500 → supervisor $5,000 → manager $25,000 →
controller unlimited.

A refusal for amount **names who can approve it**:

> $2,500.00 exceeds the billing_clerk limit of $500.00 → escalate to office_supervisor

Someone hitting a ceiling needs to know where to send it, not just that they were declined.

Six reason codes always require evidence regardless of amount — disputed quantity, time or rate,
unauthorised callout, service not performed, subcontractor shortfall. And `"other"` demands a fuller
narrative, because a free-text escape hatch with a two-word explanation is how audit trails rot.

---

## 5. Disputes cannot be closed on an opinion

`resolved_credited` requires an adjustment record to point at. `resolved_upheld` requires the
evidence that supports the charge. A dispute cannot jump from `raised` straight to resolved without
investigation.

Closing one on an opinion is how the same argument recurs three months later with nothing on file.

---

## 6. Subcontractors get the same discipline as our own units

`subcontractors.approvalStatus` defaults to `pending`, with WCB number, insurance expiry and safety
program verification. Unverified is not approved — the same rule that governs whether one of our own
trucks may be dispatched.

---

## 7. Status

| | |
|---|---|
| Tests | **460 across 22 files, 0 failures** |
| New engine | `billingAdjustment.ts` — 35 tests |
| Tables | 87 (7 new), parity verified |
| Migrations | 17, all applied clean against MariaDB |
| Typecheck | clean |

---

## 8. Not built

- **No tRPC router or db helpers** — the engine and schema exist; the API does not.
- **No UI.** The adjustment screen, dispute queue, subcontractor payable view and callout intake
  form are unbuilt.
- **Not wired to the workflow engine.** A disputed invoice should raise a task and a callout with
  unverified authority should raise one too. Neither emits an event yet — the same gap as B17.1.
- **No sub self-service.** Notices are recorded, not delivered.

---

## 9. Note on the pasted document

The document attached with this message **came through empty** — no content reached me. If it was a
B19 spec, please re-paste it.

Sequencing answer: finishing the current task first was right, and it is the pattern that has held
since B16. Starting new scope on top of unverified work is what produced the corrections in B16 and
B17.
