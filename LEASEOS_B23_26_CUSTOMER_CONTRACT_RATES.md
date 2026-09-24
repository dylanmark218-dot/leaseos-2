# LeaseOS — v23.26 Checkpoint: Customer, Contract and Rate Management

| | v23.25 | **v23.26** |
|---|---|---|
| Tables | 410 | **420** (+10: `customerContacts`, `customerContactRoles`, `commercialAuditEvents`, `customerContracts`, `rateSheets`, `rateSheetVersions`, `jobCommercialContexts`, `jobCommercialParties`, `jobCommercialReferences`, `jobCommercialSnapshots`; 21 columns on `customerAccounts`, 5 on `chargeDefinitions`) |
| Migrations | 169 | **172** (`0182`, `0183`, `0184`) |
| Role-authorized procedures | 652 | **692** (+40, `customerCommercialRouter.ts`) |
| Externally-gated procedures | 36 | **36** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 355 | **366** (+11) |
| Sensitive (fail-closed) | 125 | **128** (+3: `commercial.customer.archive`, `commercial.contract.approve`, `commercial.contract.status`) |
| Grandfathered double money columns | 30 | **30** (nothing new is a double; every new amount is cents, every rate thousandths) |
| Tests | 4,347 | **4,382** (+35: `commercialLifecycle.test.ts` 11, `rateApplicability.test.ts` 7 with 12 cases, `customerCommercial.db.test.ts` 12 through the database) |
| Test files | 319 | **322** |
| Parity | 410/410 | **420/420 column-level** |
| CI gate | PASS | **PASS** (see *Gate* below) |

Every count is read from the source. Reserved slots 0016/0017 untouched. Slots 0175–0181 are claimed
by open branches (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`); this checkpoint takes 0182–0184.

---

## The survey first, and what it found

Before a row was written, the tree was read for everything this specification overlaps. The answer
shaped the whole design: **most of the commercial backbone already existed, in pieces, and the job
was to give it a spine rather than a twin.**

| Specification concept | Already in the tree | Decision |
|---|---|---|
| Customer account | `customerAccounts` (v21.10): terms, credit, PO/AFE flags, `status`; created only implicitly by name from a payment | Extended, additively (0182). It is the canonical commercial party. |
| Customer contacts | None. No contact entity anywhere; contacts were columns on whatever record needed one (the 2026-09-21 scope reconciliation names it MISSING) | Built: `customerContacts` + effective-dated `customerContactRoles`, linked to the two per-person records that did exist (`externalIdentities`, `signatoryAuthorities`) |
| Contract | `customerContractTerms` (v22.1) is the billability rulebook, versioned and second-person approved; it has no number, lifecycle, expiry, renewal or documents | Built `customerContracts` as the record, pointing at its terms through `termsId`. Not a second rulebook. |
| Rate sheet / rate line | `chargeDefinitions` (v22.7) is the live pricing vocabulary the resolver prices from, one row per rate, proposed by one person and approved by another; `customerRateCards` (v21.10) and `billingRateCards` (v20) are the legacy paths the roadmap already lists under "Unify billing — delete the second `resolveRate`" | **A rate line IS a charge definition.** `rateSheets` and `rateSheetVersions` are the grouping approved as a unit; `chargeDefinitions.rateSheetVersionId` says which version a line belongs to. No third rate table. |
| Rate resolution | `rateResolution.ts`: deterministic 8-level precedence (job override → change order → PO/AFE → project/site → **customer contract → customer rate card** → branch → company), most-specific wins, equal specificity is CONFLICT, nothing applicable is UNKNOWN | Kept, and extended with conditioned lines (`rateApplicability.ts`) and a pinned-version filter. The precedence the specification suggests is already there, with more levels. |
| Purchase orders / references | `customerPurchaseOrders` (record + evidence); `billingBooks.afeNumber/costCenter/purchaseOrder` free text | Kept the PO row; added `jobCommercialReferences` (one row per kind: po, work_order, afe, customer_job_number, cost_centre, project_number, uwi, other) and required-kind lists on the account and the contract |
| Documents | `commercialDocuments` registry over the records vault (0144) with free-form `commercialDocumentLinks.recordType` | Used as is: a contract's documents are links of record type `customer_contract`, a sheet's `rate_sheet`. No migration, no second attachment system. |
| Tenant boundary | `financialEntities.orgRef` (0146) through `entityIdsInScope`; jobs through `jobs.orgRef` (0132); a foreign record is NOT FOUND, never FORBIDDEN | Every new table keys to `financialEntityId`; job-keyed tables also pass `jobInScope`. |
| Audit | No general ledger; the convention is a domain append-only events table written in the change's own transaction (`dispatchRoleAssignmentEvents`, `contractorPayableEvents`) | Built `commercialAuditEvents`, the same shape |
| Outbox | `domainEventOutbox` with `buildOutboxRow`; the emitter was declared unwired | Wired: every commercial event is a row in the caller's transaction |
| Job ↔ customer | `jobs.customer` is free text; `jobs.customerOrgRef` is a link a person makes; no account, contract, PO or sheet on a job anywhere | Built `jobCommercialContexts` (live) and `jobCommercialSnapshots` (frozen) |
| Dispatch gate | `readinessComposer` + C1a classification; no commercial domain; emergency bypasses nothing in dispatch, and the only commercial precedent is "proceed, then review" (`assessCalloutBilling`) | Added the `commercial` finding domain and five codes; emergency turns a missing paper reference into a review item and nothing else |

**Conflicts with the specification, reported and resolved:**

1. *Foreign keys.* The specification asks for foreign-key constraints where appropriate. The schema
   carries none (one exception in a widget table) and `relations.ts` is empty by design; the
   convention is indexed bare references and server-side scope checks. This checkpoint follows the
   repository, and every reference column is indexed.
2. *The moratorium.* `docs/register/SPINE_WIRING_PLAN.md` says "no new engines until this path is
   wired". The instruction to build this domain is the owner's and wins; the two new engines
   (`commercialLifecycle`, `rateApplicability`) are reached from a router, so the unwired census
   went **down** by one (the outbox emitter is now wired), not up.
3. *Rate-line types as columns.* Refused, as the specification also asks: a line's kind is a
   vocabulary key (`shared/commercialVocabulary.ts`, 32 kinds plus `custom:*`), never a column.
4. *A separate billing status.* `customerAccounts.status` (`active | on_hold | inactive`) is what
   the existing billing check reads (`account_on_hold`). A second status column would disagree with
   it the first time a hold was placed one way and lifted the other. The billing status is that
   column plus `holdReason`, `archivedAt` and the terms; the profile screen shows it as such.
5. *Roles named in the specification* (administrator, commercial/accounting, field user) do not
   exist; the domain roles are `management`, `controller`, `office`, `bookkeeper`, `dispatcher`,
   `driver`, `auditor`, `legal`, and so on. The matrix below maps onto them.

## Versioned rates are the non-negotiable, and they are proven

A job done under a $185/h line in June must show $185/h years later when the sheet says $215/h.
Three mechanisms, tested together through the database:

- **A version is approved as a unit.** Its lines are `chargeDefinitions` rows carrying the version
  id; approving the version approves every line in one transaction, hashes the lines
  (`contentHash`), and closes the previous approved version where the new one opens. A line on an
  approved version has no update path; a superseded version still prices its own window, as
  v22.7 established.
- **A job freezes its basis.** The dispatch posting is the activation point: `createPosting` now
  captures a snapshot — customer, bill-to, contract and version, terms, the governing sheet version
  with its lines and hash, the PO, every reference, the parties and the contacts as they stood, the
  effective payment terms — under a canonical hash. A snapshot is never updated; a correction is a
  new sequence number and the old row is marked superseded and kept. The contract and the version
  record `usedOperationallyAt` and are frozen from then on.
- **Billing reads the snapshot, never the live sheet.** `getBillableCommercialContext(jobId)` and
  `resolveRateForJob` read the frozen lines from the snapshot payload. A supersession that later
  closes the live rows' window behind the job changes nothing about what the job is billed under —
  the suite approves July's $215 version after the June snapshot and prices the job at $185.

## The resolver never picks something close — and now it reads conditions

Precedence, documented for this checkpoint (unchanged from v22.7, extended):

```
job_override > change_order > po_afe > project_site > customer_contract > customer_rate_card > branch > company
```

Within a level the most specific definition wins, where specificity is the number of scope fields
it names **plus the number of conditions it carries**. A rate line may be conditioned on equipment
class, unit type, service or job type, region, province, shift, weekday, quantity or distance band,
disposal facility, material, dangerous-goods class or a customer reference kind (`eq`, `in`, `gte`,
`lte`, `between`). Every condition must hold; **an attribute the job does not know never holds** —
"the shift was not recorded" is not "day shift" — and the reasons name the line set aside and why.
Two lines of equal specificity at one level are a CONFLICT a person resolves; nothing applicable is
UNKNOWN — REVIEW REQUIRED; a proposal prices nothing; an expired or future version is named. A job
pinned to a version never sees a line from another version; company, branch and job-override
definitions stay in play by precedence.

## Contracts have a lifecycle; approval is a second person's

`draft → pending_approval → active → suspended ⇄ active → expired | terminated`, and `superseded`
only by approving the version that replaces it (the old contract stays in force until then). Every
transition is a row in the transition table and a row in the ledger; the drafter or submitter does
not approve; suspension and termination name their reason and are sensitive permissions. A contract
a job has snapshotted is frozen; a change drafts a superseding version. Renewal is a state the
screen shows (in term, notice period, expired), not a job the system runs; the expiry sweep emits
`commercial.contract_expiring` once a day per contract and expires what has ended.

## The job's commercial context, the gate and the field

Dispatch selects customer → contract → PO → sheet (`jobs.contextSet`), records references and
parties, and may record a **reference waiver** (emergency work, PO to follow). The readiness
composer now carries a `commercial` domain: an account on hold or archived and an unusable contract
are policy BLOCKs management may override; a required PO/AFE/reference that is absent is a BLOCK
that a recorded waiver or an emergency posting turns into REVIEW; an unresolved sheet version or a
missing snapshot is REVIEW. The commercial state rides in the job's version inside the eligibility
fingerprint, so a hold placed or a PO recorded between check and award makes the check stale.

The field view (`jobs.fieldSummary`) is the offline subset: the customer's name and number, the
contract number, the references present and the kinds still to collect, the site and consultant
contacts with their phones, the snapshot's hash for dependency fingerprinting. It carries no rate,
no term, no credit figure (a test asserts the confidential field list is absent), and a field-only
caller sees only a job they are assigned to. The full office view strips prices unless the caller
holds `commercial.rates.read`.

## Authorization matrix

| Permission | management | controller | office | bookkeeper | dispatcher | driver | auditor | legal | external_accountant |
|---|---|---|---|---|---|---|---|---|---|
| `commercial.customer.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ |
| `commercial.customer.write` | ✓ | ✓ | ✓ | ✓ | | | | | |
| `commercial.customer.archive` (sensitive) | ✓ | ✓ | | | | | | | |
| `commercial.contract.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `commercial.contract.write` | ✓ | ✓ | ✓ | | | | | ✓ | |
| `commercial.contract.approve` (sensitive) | ✓ | ✓ | | | | | | ✓ | |
| `commercial.contract.status` (sensitive) | ✓ | ✓ | | | | | | | |
| `commercial.rates.propose` (sheets, versions, lines) | ✓ | ✓ | ✓ | | ✓ | | | | |
| `commercial.rates.approve` (sensitive; version decide) | ✓ | ✓ | | | | | | | |
| `commercial.rates.read` (prices visible) | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | | |
| `commercial.job.assign` | ✓ | ✓ | ✓ | | ✓ | | | | |
| `commercial.job.snapshot` | ✓ | ✓ | ✓ | | ✓ | | | | |
| `commercial.job.summary` (field view, no prices) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `commercial.billing.context` | ✓ | ✓ | ✓ | ✓ | | | | | |

Separation of duties sits under the permission: the drafter or submitter of a contract or a sheet
version cannot approve it even when holding the permission (FORBIDDEN, tested).

## Audit, events, concurrency

Every write is one transaction: the row, its `commercialAuditEvents` row (who, what changed from
what to what, why, which job) and its outbox event. Events: `commercial.customer_created`,
`customer_billing_hold[_released]`, `contract_activated | suspended | terminated | expired |
superseded | expiring`, `rate_sheet_version_approved`, `rate_sheet_expiring`,
`job_snapshot_captured`, `job_reference_missing`, `job_reference_waived`. Every mutable commercial
row carries `rowVersion`; a write names the version it read and a stale write is CONFLICT; status
rows are read `FOR UPDATE`; the suite races two approvers on one version and exactly one lands.

## Integration points

- **Jobs:** `jobCommercialContexts` (one per job), snapshots, references, parties; `dispatch.createPosting` returns the capture outcome beside the posting.
- **Dispatch gate:** `commercialReadinessForJob` in `readinessComposer`; five classified codes; version in the fingerprint.
- **Documents:** link registry documents to `customer_contract` / `rate_sheet` / `customer_account` record types; the screens list them.
- **Pricing:** `commercialSetup.definitionApprove/Reject` refuse a sheet-managed line (the version is the unit); `linePricing` and `invoiceDraft` see rate lines as the charge definitions they always priced from.
- **Billing / AR (next checkpoint):** `getBillableCommercialContext(jobId)` — bill-to, customer, contract, terms, the frozen rate lines, PO and references, payment terms, currency, billing instructions, supporting-document requirements, blockers.

## Screens

`/customers` (list with search, status and account-type filters, archived toggle; the profile with
Overview · Contacts · Contracts · Rate sheets · Jobs · Documents · Billing settings · Audit history),
`/contracts/:ref` and `/rate-sheets/:ref`, each a pure view with loading, empty, failed,
unauthorized, offline and archived/frozen states, run through the axe rules at three widths
(19 new surfaces). The sidebar gains *Customers*.

## Corrected on the way

- The snapshot hash first covered `capturedAt`, so a re-capture of an unchanged basis produced a new sequence; the clock is now outside the hash and a re-capture is a no-op.
- `resolveRateForJob` first read the pinned version's lines live; after a backdated supersession their window had closed behind the job and June priced UNKNOWN. It reads the snapshot's frozen lines now, which is what the snapshot is for.
- `z.record` over an enum key is exhaustive in zod 4; the attributes input is `z.partialRecord`.
- A rate sheet number prefix `RS` collided with the roadside event ref; sheet numbers mint as `RSHT`.
- The word "any" in a comment moved the `as any` census; the comment was reworded rather than the pin.
- The first full gate failed on one untouched file: the calendar tripwire (`calendarFixtures.test.ts`) saw `capitalAssets.test.ts`'s 2026-10-15 fixture come within three weeks on the day of this run (the baseline had passed the day before, at 22 days). The file was reviewed as the guard asks — acquisition is a fixed date, the schedule takes an explicit `asOf`, the clock reads stamp grants and refused registrations — and recorded `clock_independent`. Pre-existing and calendar-driven, not this checkpoint's; fixed rather than waited out.

## Files

**New:** `0182_customer_account_profile.sql` · `0183_customer_contracts_rate_sheets.sql` · `0184_job_commercial_context.sql` · `shared/commercialVocabulary.ts` · `_core/rateApplicability.ts` · `_core/commercialLifecycle.ts` · `customerCommercialService.ts` · `customerCommercialRouter.ts` (40) · `commercialLifecycle.test.ts` (11) · `rateApplicability.test.ts` (7) · `customerCommercial.db.test.ts` (12) · `client/src/commercial/shared.tsx` · `pages/Customers.tsx`, `CustomersView.tsx`, `Contract.tsx`, `ContractView.tsx`, `RateSheet.tsx`, `RateSheetView.tsx`

**Changed:** `schema.ts` · `_core/rateResolution.ts` (conditions, pinned version) · `_core/complianceFinding.ts` (commercial domain, five rules, `c1a.3`) · `readinessComposer.ts` · `dispatchRouter.ts` (snapshot at posting) · `commercialSetupRouter.ts` (sheet-managed lines) · `recordsAuthorization.ts` (11 permissions, 3 sensitive, 40 mapped, 9 role blocks) · `routers.ts` (mount) · `App.tsx`, `DashboardLayout.tsx` · a11y suite and coverage · count pins (procedures 674, paths 736, unwired 56) · `trackingNumberCoverage` (CN, CON, RSHT) · inventory · generator narrative · `LEASEOS_RELEASE` · migration collision register

## Not built, and named

Invoices from the billable context (the next checkpoint: Billing, Invoicing, AR, Payments, Credits,
Collections, Reconciliation consumes `getBillableCommercialContext`; nothing here drafts one). The
device package for job commercial metadata (`jobs.fieldSummary` is the subset with its hash; the
pre-departure cache loader is still declared unwired). Wiring the expiry sweep to the worker
heartbeat (it is a door, `customerCommercial.expirySweep`). A contact directory beyond customers
(vendor and facility contacts stay as columns). Retiring `customerRateCards` / `billingRateCards`
(the roadmap's "Unify billing" item; nothing new reads them). Address validation. A rate-sheet
document reader; formula pricing stays recorded, not evaluated.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending. **P0/P5** — no routing source.
