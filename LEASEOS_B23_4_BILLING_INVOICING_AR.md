# LeaseOS — v23.32 Checkpoint: Billing, Invoicing, Accounts Receivable & Financial Reconciliation

| | Before (`main` 9ec123a) | **v23.32** |
|---|---|---|
| Dependency SHA | — | **`9ec123a`** (main after #99, which carries the commercial checkpoint #98 `b35bac4`) |
| Release | v23.31 | **v23.32** — `LEASEOS_RELEASE` read `v23.31` at the dependency SHA (set by the previous numbered checkpoint, B23.3); this checkpoint increments it by one. Payroll P1/P2 and the Safety Program Builder did not move it. |
| Migration | head `0228` | **`0233_billing_invoicing_ar.sql`** (first slot free on main and all 133 refs; see the register) |
| Tables | 479 | **484** (+5: `billingWorkspaces`, `billableCharges`, `invoiceJobLinks`, `invoiceAdjustments`, `accountingSyncRecords`) |
| `billing.*` procedures | 0 | **38**, every one `moneyScoped(roleProcedure(…))` |
| Migrations applied | 205 | **206** |
| Role-authorized procedures | 881 | **919** (+38) |
| Permissions / sensitive | 427 / 172 | **444 / 180** (+17 / +8) |
| Test files / tests passed (skipped) | 485 / 7,398 (3) | **488 / 7,477 (3)** (+3 files, +79 tests) |
| CI gate | PASS | **PASS** |

Every count above is read from the gate logs quoted in §17, not typed from memory.

---

## 1. Purpose and boundary

Billing is an **operational subledger and an integration boundary**, not a general ledger. It turns a job's
accepted, signed evidence into charges priced from the job's **frozen commercial snapshot**, reviews them, invoices
them, and keeps the receivable those invoices create — payments, allocations, credit notes, adjustments, disputes and
aging — until it is settled. What an external ledger needs is queued with a stable reference and a payload hash.

It **consumes** the commercial checkpoint (v23.31) and restates none of it: no customer, contract, rate or rate-line
table is created (`billingBoundary.test.ts` reads the migration and fails if one is). Pricing goes through
`resolveRateForJob` → `priceQuantity` against the snapshot's pinned sheet version; the live-definition pricer
(`linePricing.priceLineAndRecord`) is never called from billing.

## 2. Step 0 — the commercial checkpoint and the dependency

- The commercial checkpoint (`19e3db1`) was already an ancestor of `main`: merged as **#98 (`b35bac4`)** by the owner,
  migrations `0217–0219` and every module unchanged on `main`; `readinessComposer` still wires `commercialReadinessForJob`.
- `main` moved twice while this checkpoint was built: `b36f43a` (payroll P2) → `48a64e1` (#16 driver portfolio) →
  **`9ec123a`** (#99 Safety Program Builder). The branch was re-based onto each before any commit; nothing here was
  built against a stale `main`.
- **Final dependency SHA: `9ec123a`.**
- Baseline gate on the untouched dependency — see §17.

## 3. Collision scan

Before the commit, `origin/main` and all 133 remote refs were scanned (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`,
"Claim: 0233"). `0228` was drafted when it was free everywhere; before commit `main` took `0228` (#99), payroll P3 also
holds `0228`, the integration hub holds `0229–0232`. **0233** is the first number free everywhere. `migrationSlots.test.ts`
pins the head at `0233`. No file of another branch was touched.

## 4. Survey findings (what existed, and the conflicts)

| Found | Conflict with the spec | Resolution here |
|---|---|---|
| `invoicingRouter` drafted from one ticket, no transactions, numbers from the shared global `INV` counter | numbering must be tenant-scoped, atomic, auditable | every INV/CR is minted from the organization's series on the Document Control ledger (`billingNumbers.ts`), in the record's own transaction; the legacy draft runs in one transaction with the ticket locked |
| `invoices.invoiceNumber` and `customerCredits.creditRef` globally UNIQUE | per-organization series collide across organizations | UNIQUE(`numberScope`, number); every lookup by number is filtered to the caller's books and an ambiguous number is refused, never guessed (`financeScope.invoiceInScope`, `customerCreditInScope`, `cashRouter`, `portalRouter`) |
| `linePricing` prices from LIVE definitions | rates must come from the frozen basis | billing prices only through `resolveRateForJob` (snapshot) |
| no DB guard against double billing | must be DB-enforced | generated live-source UNIQUE on charges, consumption CHECKs, live-ticket-line UNIQUE on legacy lines, one-charge-per-invoice UNIQUE |
| payments: no idempotency, no reversal; allocations: no reversal | idempotent import, reversal-based correction | `idempotencyKey` UNIQUE per book; allocation reversal is a NEGATIVE row naming the original (UNIQUE), so every existing SUM reader stays right |
| `ar.creditDecide` approved without checking the balance | two credits must not over-credit | decided under the invoice's lock, re-checked against what is outstanding |
| aging bucketed "current" as ≤30 days from due/issue | buckets are by due date: current = not yet due | `billingEngine.agingBucket` (current, 1–30, 31–60, 61–90, 90+, disputed); the legacy `ar.aging` is left as it was and named in §19 |
| portal statement listed approved-but-unsent invoices; `invoiceDispute` had no status check and looked numbers up globally | customer sees only what was sent | statement excludes approved-and-unsent; dispute looks the number up on the account and refuses unsent states |
| `commercialOffice.ar.approvalLedger` read any book's ledger | strict organization scope | restricted to the caller's own book |
| `_core/billing.ts`, `_core/billingAdjustment.ts` declared unwired | — | left unwired; this checkpoint's engine is `_core/billingEngine.ts` |
| no export/sync state | accounting boundary | `accountingSyncRecords` |

## 5. Architecture

```
commercial (v23.31)              billing (v23.32)                                   existing infrastructure
───────────────────              ─────────────────────────────────────────────      ───────────────────────────
getBillableCommercialContext ──► gatherFacts ─► evaluateReadiness (pure)
resolveRateForJob (snapshot) ──► prepareBilling ─► billableCharges ──┐
                                 review (submit → approve, SoD)       │
                                 invoiceDraft (multi-job, slices) ◄───┘ ──► numberSeries.mintNumberInTx (ledger)
                                 submit → approve (snapshot) → issue  ──────► renderPdf · storagePut · registerControlledDocument
                                 payments · allocations · reversals
                                 credit notes · adjustments · disputes ──────► commercialApprovalService (ladder)
                                 aging · balance · overdue sweep
every write ─────────────────────────────────────────────────────────────────► commercialAuditEvents (the ledger) · domainEventOutbox
issued facts ────────────────────────────────────────────────────────────────► accountingSyncRecords (export boundary)
```

- `server/_core/billingEngine.ts` — every rule, pure: workspace and invoice state machines, readiness, charge status,
  override check, slicing, tax, receivable, aging, allocation / credit / adjustment / dispute checks, export payloads.
- `server/billingService.ts` — the database half: strict scope, one transaction per act, locks, audit, outbox.
- `server/billingNumbers.ts` — per-organization numbering on the Document Control ledger.
- `server/billingRouter.ts` — 38 procedures, all `moneyScoped(roleProcedure(…))`; nothing in the router writes a row.
- UI: `BillingDashboard`, `BillingJob`, `Invoice`, `Receivables` (containers) and their `…View` surfaces.

Domain operations named in the spec → procedures: prepareBilling → `billing.prepare`; recalculateBilling →
`billing.recalculate`; approveInvoice → `billing.invoiceApprove`; issueInvoice → `billing.invoiceIssue`; recordPayment →
`billing.paymentRecord`; allocatePayment → `billing.paymentAllocate`; reverseAllocation → `billing.allocationReverse`;
createCredit → `billing.creditCreate`; approveCredit → `billing.creditDecide`; openDispute → `billing.disputeOpen`;
resolveDispute → `billing.disputeResolve`.

## 6. Schema and migration `0233`

New: `billingWorkspaces` (one per job, modeled state, readiness kept, hold, review SoD CHECK), `billableCharges`
(provenance columns, consumption, override, generated `liveSourceKey` UNIQUE, eight CHECKs), `invoiceJobLinks`,
`invoiceAdjustments` (signed, decided by another person — CHECK), `accountingSyncRecords` (idempotent UNIQUE on book,
entity, ref and payload hash; exported needs an external id — CHECK).

Extended: `invoices` (+`numberScope`, ledger ref, `origin`, explicit `taxCode`/`taxRateBps`/`taxJurisdiction`, terms,
submit/approve/issue actors, `rowVersion`, status `in_review`; UNIQUE(numberScope, number); billing invoices must add up
and carry a tax code — CHECK; approver ≠ submitter — CHECK), `invoiceLines` (+charge, job, tax, internal provenance,
`releasedAt`; generated `liveTicketLineKey` UNIQUE; one charge per invoice UNIQUE), `customerPayments` (+currency,
payer, source, notes, idempotency UNIQUE, reversal fields; methods `wire`, `import`; amount > 0 and reversal
consistency — CHECKs), `paymentAllocations` (+ref, `reversesAllocationId` UNIQUE, reason; sign CHECK),
`customerCredits` (+numberScope UNIQUE, ledger ref, currency, source, dispute link; amount > 0 and SoD — CHECKs),
`disputeCases` (+invoice and line by id, book, opener, resolver, amounts; generated `openKey` UNIQUE),
`commercialAuditEvents.subjectType` (+9 billing subjects — the same ledger).

Money is integer cents (`int`/`bigint`), quantities integer thousandths, tax in basis points: `billingBoundary.test.ts`
reads the migration and pins all 14 money/quantity columns as integer types and no `decimal`/`double`/`float`.

## 7. Readiness rules

`evaluateBillingReadiness(jobId)` returns `{ ready, blockers[], warnings[], suggestedState, billableCents, remainingCents, hash }`,
each issue `{ code, severity, group, message, subject }`. Deterministic: the same facts give the same blockers in the
same order and the same hash.

| Code | Severity | Means |
|---|---|---|
| `commercial_context_missing` / `commercial_snapshot_missing` | blocker | no customer / no frozen basis — billing never prices live |
| `rate_sheet_unresolved`, `reference_missing` | blocker | from the snapshot's own blockers |
| `credit_hold` | **warning** | the customer is on credit hold: work done is still billed; dispatch's own gate lets emergency work through |
| `job_not_complete`, `no_field_ticket`, `ticket_not_closed` | blocker | documents |
| `signature_missing` / `signature_refused` / `signature_stale`, `line_not_presented` | blocker | the site sign-off verdict (`fieldTicketSignatureVerdict`), never "some row says accepted" |
| `line_disputed` | warning | the disputed line is held out; accepted lines bill |
| `disposal_ticket_missing`, `disposal_ticket_unverified` (rejected / needs review) | blocker | when the sheet bills disposal |
| `disposal_ticket_unverified` (unverified) | warning | |
| `charges_not_prepared`, `charge_unpriced`, `manual_charge_pending`, `charge_override_pending`, `currency_mismatch`, `no_billable_amount` | blocker | charges |
| `partially_billed` | warning | what remains of a sliced charge |
| `billing_hold` | blocker | the job's billing hold |

The suggested state names the first unmet group in close-out order: commercial → documents → signatures → disposal →
charges. A reviewed or approved job whose readiness changes is returned automatically (`review_invalidated`).

## 8. Rate and charge provenance

A charge carries: job → evidence (`sourceKind`/`sourceId`/`sourceRef`, the ticket line) → bill-to customer → contract
ref → commercial snapshot (id and ref) → rate-sheet version ref → rate line (`definitionRef`, version, scope level,
pricing method, rate) → inputs (`inputsJson`, measurement source, conversions) → formula → reasons → priced amount →
billing amount (equal, or an approved override). An unpriceable line (unknown rate, conflict, conversion or
measurement review, unrecognized unit, no service code) is a **held** charge with the engine's reasons, never a
substituted rate. An override is requested with a reason, decided by another person (service check + CHECK), never
below what is already invoiced, and its old and new values are on the ledger. A manual charge is proposed and
approved by another person (CHECK). Recalculation supersedes unbilled charges and links each new charge to the one it
replaced; consumed charges are history and are not re-priced.

Invoice lines carry the customer's description in `description` and the internal chain in `provenanceJson`, which the
document never prints (tested: the description carries no `CHG-`/`JCS-`/`RSHT` reference).

## 9. Invoice lifecycle

`draft → in_review → approved → sent (issued)` by events only (`submit`, `return`, `approve`, `issue`, `void`); AR
states (`partially_paid`, `paid`, `disputed`) follow from AR records. Approval is a second person's (service +
CHECK), on a determined tax code and totals that add up; it freezes a `billingSnapshots` row (provenance, commercial
snapshot refs, supporting documents by reference, tax) and emits `invoice.approved`. Issue renders the PDF from the
frozen snapshot, stores it, registers it in Document Control (`invoice` definition, domain-numbered, state `issued`,
linked to the invoice and its jobs), sets issued/due dates from the snapshot's terms, emits `invoice.issued` and
queues the export. A draft is recalculated (tax re-determined once a rate is verified); nothing after submission is
rewritten. A void is recorded on the invoice, releases the charges it consumed (lines kept, marked `releasedAt`), voids
the number on the ledger (never reused), and returns a job with no other live invoice to approved-for-invoicing.
Multi-job invoices (same book, bill-to and currency) and several invoices per job (slices; supplemental review) are
both supported; partial billing tracks billable, billed and remaining quantity and amount per charge, the last slice
taking the remainder to the cent.

Tax: explicit code (`GST-<jurisdiction>`, `HST-…`, `EXEMPT`, `ZERO_RATED`, or `UNDETERMINED`), rate in basis points,
amount per line (half-up integer arithmetic), from the customer's tax status in the snapshot and a **verified**
`gst_hst_rate` rule. A taxable invoice on an unverified rate is drafted `UNDETERMINED` and cannot be approved.

## 10. AR and payments

The receivable is derived, never stored and edited: original − paid (net allocations) − credited (approved credits) ±
adjusted (approved adjustments) = outstanding, with status open / partially paid / paid / overdue / disputed / credit
pending / closed, and an aging bucket by due date. Payments carry date, amount, currency, method (EFT, cheque, card —
reference only; a card number in the reference is refused —, wire, cash, import, other), reference, payer, notes,
source and recorder; an import key makes a replay the same payment (a different payment under the same key is
CONFLICT). Allocation never crosses books, customers or currencies, never exceeds the payment's unapplied amount or the
invoice's outstanding balance (an overpayment stays unapplied), and locks payment then invoice. A reversal is a
negative row naming the allocation, once (UNIQUE). A payment is reversed (NSF) only once nothing of it is applied.
Customer balance: open invoices, outstanding, overdue, unapplied, disputes, recent payments, net owing. The overdue
sweep emits `invoice.overdue` once per invoice.

## 11. Credits and adjustments

Credit notes: numbered in the organization's CR series, tied to the customer and the invoice, reasoned, never beyond
what is outstanding counting pending credits, approved through the approval ladder by someone other than the
requester (service + CHECK), re-checked under the invoice's lock at approval, `credit.approved` emitted and exported.
Adjustments are a separate record: a signed amount with a reason code, requested by one person and decided by another
(CHECK), never taking the receivable below zero; the invoice's own total never changes. Disputes: invoice- or
line-level, one open dispute per invoice line (generated UNIQUE), with amount, reason, notes, document refs, opener and
resolver; resolved as upheld, credited, partial (a credit note is requested for a second person) or withdrawn;
`dispute.opened` / `dispute.resolved` emitted.

## 12. Tenant and security model

Every procedure is `moneyScoped`: the books come from `financeScopeFor` (strict F1) — an ended, lapsed or suspended
membership is FORBIDDEN, never revived by the single-tenant fallback. A record outside the caller's books is NOT FOUND.
Numbers are looked up among the caller's books only. Tested refusals (`billing.db.test.ts`): another organization is
refused the job's billing, readiness, prepare, draft, hold, payment record (into its book, or onto its customer),
allocation, allocation reversal, payment reversal, credit decision, dispute resolution, customer balance and export
mark; its rows never appear in receivables, unapplied payments, the export queue or the dashboard; both organizations
hold `INV-<year>-000001` and each reaches its own. A former member — their only organization, memberships ended — is
refused every invoice, list, receivable, balance, workspace, dashboard, payment, credit, reversal, void, export and
prepare, and nothing moved.

## 13. Authorization matrix

| Permission | office | management | bookkeeper | controller | auditor | driver / mechanic / shop lead | dispatcher |
|---|---|---|---|---|---|---|---|
| `billing.workspace.read` | ✓ | ✓ | ✓ | ✓ | ✓ | denied | — |
| `billing.prepare`, `billing.review.submit`, `billing.charge.override` | ✓ | ✓ | ✓ | ✓ | — | denied | — |
| `billing.review.approve`*, `billing.charge.override.approve`*, `billing.hold`* | — | ✓ | — | ✓ | — | denied | — |
| `invoicing.submit`, `invoicing.issue` | ✓ | ✓ | ✓ | ✓ | — | denied | — |
| `invoicing.approve`* | — | ✓ | — | ✓ | — | denied | — |
| `ar.allocation.reverse`* | — | — | ✓ | ✓ | — | denied | — |
| `ar.payment.reverse`* | — | — | — | ✓ | — | denied | — |
| `ar.adjustment.request` | ✓ | ✓ | ✓ | ✓ | — | denied | — |
| `ar.adjustment.decide`* | — | ✓ | — | ✓ | — | denied | — |
| `ar.dispute.manage` | ✓ | ✓ | ✓ | ✓ | — | denied | — |
| `ar.export.read` | — | ✓ | ✓ | ✓ | ✓ | denied | — |
| `ar.export.mark`* | — | — | ✓ | ✓ | — | denied | — |

`*` sensitive (fail-closed). Reused: `invoicing.draft/read/void/dispute.resolve`, `ar.read/payment.record/payment.apply/credit.request/credit.decide/collect`.
"denied" = in `DENIALS` (deny beats grant across every role a person holds, so an owner-operator who is a driver and
office staff is refused the billing workspace — tested); only the new permissions are denied, so no existing grant was
withdrawn from anyone. Tested refusals: driver and dispatcher refused every billing read; the auditor reads but does
not prepare, approve or mark; the office does not approve or hold; management does not mark exports or reverse
allocations; the bookkeeper does not reverse payments. The UI hides what the server refuses; it is never the boundary.

## 14. UI

`/billing` (dashboard: Needs attention, Ready, Draft, Awaiting approval, Issued, Overdue, Disputed, Paid; filters by
job/invoice text and customer), `/billing/jobs/:jobId` (readiness, frozen basis, charges with provenance, review, hold,
overrides, slice drafting, invoices, history), `/invoices/:invoiceNumber` (totals, receivable, workflow, lines with
internal provenance, payments with reversal, credit notes, adjustments, disputes, supporting documents by reference,
export state, history), `/receivables` (aging by due date, open invoices, unapplied cash, record and apply a payment,
customer balance). Each view renders loading / failed / refused / offline / empty and is in the axe suite at three
widths (12 states). Global search links invoices to `/invoices/<number>`.

## 15. Accounting integration boundary

`accountingSyncRecords`: stable entity type and ref, payload and hash (`billingEngine.exportPayload`), external system,
status (pending, exported, failed, conflict, superseded), external id, attempts, last error, last attempt, last sync.
Queued on issue, void of an issued invoice, payment, payment reversal, allocation and its reversal, approved credit and
approved adjustment. Idempotent on (book, entity, ref, payload hash); a changed fact supersedes the earlier pending row.
`billing.exportQueue` / `billing.exportMark` (exported needs the external id; a replay is acknowledged; exported never
returns to pending). No connector is configured: LeaseOS is the subledger and an exporter reads the queue.

Outbox events (existing `domainEventOutbox`): `billing.ready`, `invoice.approved`, `invoice.issued`, `invoice.overdue`,
`payment.received`, `invoice.paid`, `credit.approved`, `dispute.opened`, `dispute.resolved`. Audit events (existing
`commercialAuditEvents`): charge prepared/superseded/invoiced/released, override requested/approved/refused, manual
charge proposed/approved/refused, review submitted/returned/approved/invalidated, hold placed/released, invoice
created/recalculated/submitted/returned/approved/issued/voided/settled/disputed/overdue, payment recorded/reversed,
payment allocated, allocation reversed, credit created/approved/refused, adjustment requested/approved/refused,
dispute opened/resolved, export marked.

## 16. Tests

| File | Tests | Proves |
|---|---|---|
| `server/billingEngine.test.ts` | 24 | state machines, readiness codes and order, credit hold as warning, slices sum to the cent, tax half-up, receivable and aging, allocation / credit / adjustment / dispute refusals, export hashing |
| `server/billing.db.test.ts` | 12 | ticket-to-cash end to end; fail-closed pricing and overrides; DB-held double-billing defence; partial and multi-job; five races; cross-tenant; ended membership; roles; tax; void; hold; disputes, credits, adjustments, overdue |
| `server/billingBoundary.test.ts` | 7 | no AR on field devices; no field role holds billing; every procedure money-scoped; snapshot-only pricing; integer money; no deletes / FKs; one ledger, one outbox, one register |
| `client/src/a11y/a11y.dom.test.tsx` | +36 | 12 billing states × 3 widths |
| updated guards | — | census 896, paths 974, money procedures 182, head slot 0233, tracking-number coverage recognizes the organization series |
| adjusted existing tests | — | `invoicing.test`, `commercialOffice.db.test`, `tenantScopeFinance.db.test`: raw lookups by a minted number now name the book or scope (numbers are per organization); the revoked-management case uses an invoice large enough for the credit it approves (over-crediting is now refused) |

Concurrency (each "exactly one"): two drafts of one job; six drafts → six consecutive numbers, six ledger rows; two
issues of one invoice; two allocations racing for one payment's unapplied cash; two credit approvals (billing and
legacy paths) racing to over-credit one invoice.

## 17. Full gate

Both gates ran detached with `scripts/ci-gate.sh` on a fresh MariaDB 10.11 database, Node **22.23.3** (`.nvmrc`;
`runtime: Node 22.23.3 · ICU 78.3 · tz 2026c`), pnpm 10.4.1.

| Gate section | Baseline: untouched dependency `9ec123a` | This checkpoint: commit `13847b9` |
|---|---|---|
| 0a / 0. Runtime truth, reserved slots 0016/0017 | pass | pass |
| 2. Migrations applied | 205 | **206** (`0233_billing_invoicing_ar.sql` last) |
| 3. Table parity | `parity OK`, 479 tables | `parity OK`, **484** tables |
| 4. Typecheck | pass | pass |
| 5. Procedure census | 0 bare `protectedProcedure`; 13 ungated sites pinned | 0 bare; 13 ungated sites pinned (billing adds none) |
| 6. Test suite | 485 files, **7,398 passed, 3 skipped** (7,401) | 488 files, **7,477 passed, 3 skipped** (7,480) |
| 6. Reserved-word / ancillary suite | 4 files, 67 passed | 4 files, 67 passed |
| 6b. Fixture isolation | `FIXTURE ISOLATION VERIFIED` | `FIXTURE ISOLATION VERIFIED` |
| 7. Production build | pass | pass |
| 7a. Production-only runtime boot | `PASS — dist/index.js and dist/worker.js boot with production dependencies only` | same |
| 7b / 7c. External and machine gates | 40 externally-gated, 2 integration-gated | 40, 2 (unchanged) |
| 8. Current-state document | `current` | `current` (v23.32, regenerated by `scripts/current-state.sh`) |
| Verdict | **PASS** (exit 0) | **PASS** (exit 0) |

The difference in tests is exactly this checkpoint's: +24 (`billingEngine.test.ts`), +12 (`billing.db.test.ts`), +7
(`billingBoundary.test.ts`), +36 (axe: 12 billing states × 3 widths) = **+79**. There is no pre-existing failure to
prove against the baseline: both are green. The 3 skipped tests are the same three on both sides.

Earlier evidence on the way (each superseded by `main` moving): baseline on `b36f43a` PASS (480 files, 7,285 passed,
3 skipped, 462 tables, 201 migrations); baseline on `48a64e1` PASS (483 files, 7,347 passed, 3 skipped, 465 tables).

## 18. Final commit

The implementation is commit **`13847b9`** (the gate in §17 ran on it). This document's evidence is filled in by a
following documentation-only commit; `git diff 13847b9..HEAD` touches only this file. Branch
`claude/leaseos-billing-invoicing-ar`, pushed; no pull request opened.

## 19. Known limitations (named, not hidden)

- **Legacy `ar.aging`** keeps its v21.9 buckets (≤30 days as "current"); the due-date aging is `billing.receivables`.
  Both read the same allocations, credits and payments.
- **On-account credits** (no invoice) remain reported, not applied to invoices; there is no credit-application record.
- **Approved adjustments** are counted by `billing.*` receivables; the older balance readers (portal statement,
  project and commercial-office views) still compute invoice − allocations − credits and do not add adjustments.
- **Surcharges** (percentage-of-base fuel surcharges) are not computed automatically: the rate engine's
  `percentage_markup` includes the base; a surcharge is entered as an approved manual charge.
- **Tax jurisdiction** is chosen at drafting (default `CA-AB`), not derived from the job's location.
- **Document registration** at issue runs after the issuing transaction; a failure is returned in the result
  (`document.registered = false` with the error) and the invoice stays issued with its stored PDF.
- **No accounting connector**: the export queue and the mark protocol exist; nothing pushes to QuickBooks or Sage.
- Pre-0233 invoices and credits keep their `default` scope; a number that names two records in one organization's
  books (possible only for such data) is refused rather than guessed.
- The billing workspace is created on first touch of a job (prepare, refresh, review) — jobs never touched by billing
  do not appear on the dashboard.

## 20. Recommended next checkpoint

**Bank reconciliation and cash application v2**: bank feed and statement import matched against `customerPayments`
(by idempotency key, reference and amount), lockbox/remittance import into `paymentRecord` with automatic allocation
proposals a person confirms, credit-application records for on-account credits, and the first real accounting
connector reading `accountingSyncRecords` — together with moving the older balance readers onto
`billingEngine.receivable` so every screen agrees on adjustments.
