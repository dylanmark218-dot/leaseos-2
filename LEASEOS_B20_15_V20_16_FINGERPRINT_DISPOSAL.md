# LeaseOS — v20.16 Checkpoint: Fingerprinting + Disposal Tickets + Merchant Memory

| | Previous | New |
|---|---|---|
| Version | v20.15 | **v20.16** |
| Tables | 138 | **140** |
| Migrations | 27 | **30** |
| Procedures (role-authorized) | 152 | **152** |
| Bare `protectedProcedure` | 0 | **0** |
| Assistant forms | 3 | **4** (`disposal_ticket`) |
| Typed commit targets | 3 | **4** (`disposal_ticket`) |
| Tests | 1,002 | **1,028** |
| Test files | 45 | **46** |
| Parity | 138/138 column-level | **140/140 column-level** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 444.6 kb |

Reserved slots 0016/0017 untouched. No unexpected files in the tree this time.

---

## The same document, twice

A driver photographs a receipt at the pump and again at end of day. The office
scans a facility ticket the driver already captured. Two photos, one document —
two expenses is a double-claim, two disposal tickets makes one load look like two.

`documentFingerprint.ts` keeps two fingerprints, because photos differ and
documents do not. A **content hash** of the bytes catches the same file
uploaded twice. A **structured key** built from what the document *says* —
vendor, date, total; facility, ticket number, load — catches the second photo.

Three verdicts, and what each permits:

- **Exact duplicate** — same bytes. Refused outright, even with a human
  override. There is nothing to review; it is the same file.
- **Possible duplicate** — same key, different bytes. Refused unless a person
  explicitly overrides, and the override is recorded in the reason.
- **Cannot assess** — the key is incomplete. Reported as such, **not as
  "unique"**: a receipt with no total would collide with every receipt from that
  vendor that day. Reaching this at commit means a confirmation was skipped
  upstream, so it is refused.

The load is deliberately part of a disposal key. The same facility ticket
number legitimately recurs across years and facilities; it does not recur across
loads. Vendor names are normalized so punctuation and case cannot fork the key.

---

## Disposal and scale tickets, no longer refused

One form serves both — a scale ticket is the weights, a facility ticket is the
weights plus the facility's own reference. Every weight is precision-sensitive
because net kilograms drive both the disposal gate and the invoice.

**It lands as `needs_review`, never `verified`.** `disposalTickets` already
carried the right shape — `verificationStatus`, `source`, `confidence`,
`evidenceRefs` — and `billing.ts` gates on the *verified* count. So an OCR'd
ticket is simply invisible to an invoice until a person verifies it. No new
gate was needed; the existing one already refused unverified evidence.

**The load's chain state is not touched.** Advancing to `disposal_verified` is
the verifier's act, not the scanner's. The end-to-end test commits a real ticket
and asserts the load stays at `arrived_disposal`.

**Weights must agree.** Gross − tare must equal net within 20 kg — scales print
to the nearest 10 or 20 — and gross below tare is a misread, not a light load.
Net is derived from gross and tare when absent. A ticket with no net, no volume,
and not both gross and tare is refused.

**The record's confidence is its weakest weight.** A confident facility name
does not make an uncertain net figure any more certain.

**Load and facility are server-resolved**, added to the proposal row by
migration 0031 exactly as `tripId` and `unitId` are. A facility name read by OCR
is a hint for the person confirming, not an identifier the record is keyed on.
The proposal's human-readable load must match the server's or the commit is
refused as cross-load.

**One facility ticket per load.** The execution branch locks the load, checks
for an existing ticket with that number, and refuses a second — tested by
committing the same ticket twice and asserting exactly one row.

---

## Merchant memory earns trust from confirmations

The engine already knew this; now there is a ledger. Three events: **seen**
raises nothing but a counter. **Confirmed** — a person committed a proposal for
this vendor as this type — is the only event that earns trust. **Rejected**
counts against it. A vendor seen forty times and never confirmed recalls
nothing; a vendor confirmed three times and then corrected three times stops
being trusted rather than kept being asked.

---

## The test I changed, and why that was right

"Refuses to extract a document no form accepts" used a scale ticket as its
example. That assumption is exactly what this tranche changed. The test now
walks the three types that still have no form — invoice, safety document, load
ticket — and a new test asserts the scale ticket is *no longer* refused. That is
a test tracking an intentional behaviour change, not a test bent to pass.

---

## Files

**New:** `0029_fingerprints_merchant_memory.sql` · `0030_commit_receipt_disposal_target.sql`
· `0031_proposal_load_facility_context.sql` · `documentFingerprint.ts` ·
`merchantMemoryService.ts` · `documentDedupDisposal.test.ts` (23 tests)

**Changed:** `aiProposal.ts` (form) · `documentExtraction.ts` (mapping) ·
`assistantCommitAdapters.ts` (context, adapter) · `assistantCommitService.ts`
(execution branch) · `assistantCommitService.test.ts` (+2 end-to-end) ·
`documentExtraction.test.ts` · `schema.ts`

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative rule loaded; every determination correctly UNKNOWN.

---

## Exact next tranche

**P3 has two pieces left**, both small: home-base distance as evidence for
remote-work records (GPS proposes, never decides — the northern-residents rule
from the funding document), and the auto-filer into the Evidence Vault so an
extracted document is sealed with its fingerprint attached. Then the
fingerprint check wires into `assistantCommitService` as a fifth pre-commit
gate — the engine exists; the service does not yet call it.

Then **P4 — encrypted field storage.** Everything in P3 was built so its
capture path drops into it: proposals, questions, fingerprints and the
extraction record are all rows, not modals, and none of them depend on the
network to exist.
