# LeaseOS — v20.15 Checkpoint: Document Extraction + Question Queue + Funding Persistence

| | Previous | New |
|---|---|---|
| Version | v20.14 | **v20.15** |
| Tables | 136 | **138** |
| Migrations | 25 | **27** |
| Procedures (role-authorized) | 152 | **152** |
| Bare `protectedProcedure` | 0 | **0** |
| Assistant forms | 2 | **3** (`expense_receipt`) |
| Typed commit targets | 2 | **3** (`expense_record`) |
| Tests | 961 | **1,002** |
| Test files | 42 | **45** |
| Parity | 136/136 | **138/138 — now column-level too** |
| Typecheck | clean | **clean** |
| Build | clean | **clean** — 434.8 kb |

Reserved slots 0016/0017 untouched. Journal runs 0015 → 0018.

---

## Provenance, again, and the explanation this time

The previous turn was compacted mid-tranche. The compaction snapshot was taken
at **01:46:24**; the turn kept running for four more minutes. Five files carry
timestamps between **01:46:38 and 01:50:17** — the second ALTER in migration
0028, `documentExtraction.test.ts`, `questionQueueService.ts` and its test, and
edits to two existing tests. They are exactly pending items 1–3 from my own
summary, and the summary described a state that was already stale when it was
written.

So: my work, from the tail the snapshot missed. I checked the transcript and
the timestamps before concluding that, and I gated the files rather than trust
the conclusion. All of it passes.

---

## P3 continued: a photograph becomes a proposal

`documentExtraction.ts` makes OCR output a first-class proposal — same standing
as a transcribed voice note. Source `photo_ocr`, a confidence, a precision,
status `proposed`. **Nothing in the file writes a fact.**

**Four gates, strictest wins.** `human_only` for anything that becomes money, a
filing date, a billed quantity, or a compliance identifier — regardless of
confidence. `ask` below 85. `review` from 85. `auto_file` only at 98+ **and**
only for low-risk metadata: a vendor name, a currency, a card's last four.

**Auto-file means "no question", not "no review".** Even an auto-filed field is
`proposed`. A test asserts the auto-file band stays narrow, and another that a
total is never auto-filed however confident the read — the failure mode of a
generous auto-filer is a wrong number nobody looked at.

**Classification refuses close races.** A scale ticket read as a receipt files
kilograms as dollars. Keyword scoring is a floor; a confident merchant memory or
engine hint can override it; a race within 25 points is `ambiguous` and the
document-type question goes to the front of the queue.

**Merchant memory earns confidence from confirmed filings, not sightings.** A
vendor seen forty times and never confirmed is forty unconfirmed guesses; its
confidence is zero.

**Questions are exactly what the gates say need asking.** An absent optional
field ranks below an absent required one. A confident vendor name asks nothing.

## The `expense_receipt` form and its adapter

Third form, third typed commit target. The adapter commits to an expense
**draft** with treatment left at the schema default `unknown_review_required` —
the treatment column is not in the intent's values, so the adapter has no way to
set it. A receipt is not a deduction (B20.5), and OCR is not an accountant.

The adapter refuses: a financial entity the server did not resolve; a date that
is not an ISO calendar date (no offset arithmetic on a receipt); a subtotal and
tax that do not add to the total beyond a cent — three numbers that disagree are
a misread, not a rounding difference; a business-use percentage outside 0–100.
DB-backed test commits a real receipt end to end and asserts the receipt row
carries `expense_record`.

`FieldType` gained `number` and `date`. A total is money, not a quantity.

## The question queue is rows, not modals

`assistantQuestions` persists every unanswered question, so "I'll deal with it
later" survives a phone restart. Only the person asked may answer; answers are
validated against the options; re-extracting a proposal supersedes its earlier
pending questions. **Answering records who and how without confirming the
field** — the answer is provenance for the confirmation, not the confirmation.

## Funding persistence, and one boundary tightened

The v20.14 stubs are gone. Claims land on the ledger; the ledger is what makes
the next double-dip detectable. A `possible_duplicate` is **recorded too**, held
for review, so the second reviewer sees both — silence is the failure mode, not
the record.

**`opportunityAdvance` no longer accepts `from`.** v20.14 did, which let a client
assert "from: approved" and skip every rung between an estimate and cash. The
current status is now read from the row. Test-pinned at the source level.

---

## The real defect this turn, and the guard it produced

Migration 0026 declared `fundingClaims.fundingOpportunityId int NOT NULL`.
`schema.ts` declared it nullable. **Parity said 136/136.**

That is the worst kind of disagreement: TypeScript accepts what the database
rejects, and every static check passes. The claims the API now records —
historical claims, claims a bookkeeper knows about that never passed through
matching — have no opportunity, and the original migration would have thrown at
insert time. It got reconciled only because 0028 happened to ALTER the column.
Luck, not a guard.

`columnParity.test.ts` is the guard. For every table drizzle knows, every
column's nullability must match what the applied migrations enforce, and the
database may hold no column `schema.ts` does not declare. 1,800+ columns.

**Proven, not just written.** I reintroduced the exact 0026 drift on the live
database and the test failed naming `fundingClaims.fundingOpportunityId:
schema.ts says NULL, database says NOT NULL`. Restored, green. That restore
step surfaced its own small proof: the ALTER back to NOT NULL failed on "data
truncated" because the suite had already inserted claims with no opportunity —
exactly what the original constraint would have blocked in production.

---

## Files

**New:** `0027_document_extraction_questions.sql` · `0028_commit_receipt_expense_target.sql`
· `documentExtraction.ts` + test · `questionQueueService.ts` + test ·
`fundingService.ts` · `columnParity.test.ts`

**Changed:** `aiProposal.ts` (form, `FieldType`) · `assistantCommitAdapters.ts`
(adapter) · `assistantCommitService.ts` (execution branch) ·
`portalFundingRouter.ts` (persistence, `from` removed) · `schema.ts` · two tests

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative tax, HOS, retention or funding rule loaded; every
determination correctly UNKNOWN or `unverified`.

---

## Exact next tranche

**v20.16 — P3 finish.** Merchant memory persistence (the engine exists; the
table does not), duplicate and document fingerprinting so the same receipt
photographed twice is one expense, home-base distance as evidence for remote
work records, and the auto-filer into the Evidence Vault. Then `disposal_ticket`
and `scale_ticket` forms with adapters — both already classified, both refused
for extraction until a form accepts them.

Then **P4** — encrypted field storage. The question queue and extraction were
built so their capture path drops into it without a rewrite.
