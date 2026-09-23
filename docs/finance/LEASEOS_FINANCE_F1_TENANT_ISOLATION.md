# LeaseOS Finance F1: tenant isolation and security repair

**Status**: implemented on `claude/finance-accounting-survey-2mp4h6`. It stops here: F2 is not started.
**Base**: `main` = `0060690`. **No migration** and no new schema. **No new engine.**

This is a security prerequisite for every later Finance & Accounting checkpoint.

**Finance is not yet completely tenant-isolated.** Shop-parts inventory (§7) and the insurance router
(§8) still carry known exposures. They are reported here, and pinned by name in CI, rather than
hidden.

---

## 1. The requirement, and where it is enforced

The ownership chain is **caller → organization → book (`financialEntities`) → record**.

Every lookup and mutation in the ten finance routers proves this chain before it reads or changes a
record. A record that fails answers `NOT_FOUND` with the same message a missing record gets, so the
refusal never confirms that another organization's record exists.

A finance role held in Organization B grants nothing in Organization A. Roles are checked by
`roleProcedure`; books are checked by the scope guard. Each check stands on its own.

## 2. The centralized scope guard

| Piece | File | What it does |
|---|---|---|
| `moneyScoped(roleProcedure("…"))` | `server/_core/trpc.ts` | Resolves the caller's organization from their membership (never from input) and the books that organization owns. Hands the handler `ctx.money: FinanceScope`. Marks the procedure `meta.moneyScoped` so CI can see it. It wraps `roleProcedure` rather than replacing it, so the permission map, the authorization trail and the pinned `roleProcedure(` counts are unchanged. |
| `financeScopeFor`, `ownsEntity`, `requireOwnedEntity`, `ownedEntityWhere`, `bookOrgWhere`, `ownsBookOrg` | `server/_core/entityScope.ts` (the existing 0146 money-boundary module) | The rules. **A record with no book (`financialEntityId` NULL) is in nobody's scope**: not the single tenant's, and not the first organization's to ask. Two live memberships are refused (`PRECONDITION_FAILED`) rather than guessed. |
| One resolver per record type | `server/financeScope.ts` | `invoiceInScope`, `vendorBillInScope`, `customerCreditInScope`, `writeOffInScope`, `bankStatementInScope`, `gstReturnInScope`, `iftaReturnInScope`, `assetInScope`, `fuelTankInScope`, `customerAccountInScope`, `externalIdentityInScope`, `auditPackageInScope`, and others. Also the reference checks `requireUnit`, `requireJob`, `requireTrip`, `requireLoad`, `requireEvidence` and `requireFuelAccountOfEntity`. |

Records with no book column of their own take their book from the canonical parent that already owns
them. Nothing new is recorded for this:

| Record | Owner resolved through |
|---|---|
| Bank statement | Its bank account |
| Write-off request, collection event | Its invoice |
| Dispute case | The invoice it names |
| Fuel statement line | Its statement |
| Vendor | `bookOrgRef` (0149) |
| Roadside event | The unit's owner (`coreRecordOwnership`) |
| External identity | The customer account's book, or the vendor's book. For a facility identity, the inviting person's organization, because facilities are a shared directory. |
| Audit package | Its subject **and** its preparer's organization. Subject keys such as `vendorRef` are not unique, and the package table records no book. |

The existing payroll, commercial-setup and commercial-office convention (`moneyScope()` +
`assertEntityInScope`) is left as it was and extended where it had gaps (§3).

## 3. Procedures protected

**72 procedures in 10 routers** carry `moneyScoped`. The list below is read from the live `appRouter`:

| Namespace | Procedures |
|---|---|
| `bank` (3) | `accountRegister`, `statementImport`, `reconciliation` |
| `ar` (8) | `paymentRecord`, `paymentAllocate`, `creditRequest`, `creditDecide`, `collectionEvent`, `writeOffRequest`, `writeOffDecide`, `aging` |
| `period` (3) | `readiness`, `close`, `reopen` |
| `gst` (5) | `treatmentSet`, `adjustmentRecord`, `return`, `returnPrepare`, `returnFinalize` |
| `roadside` (2) | `open`, `assignVendor` |
| `purchasing` (2) | `request`, `approve` |
| `vendor` (4) | `billRecord`, `billMatch`, `billApprove`, `paymentRelease` |
| `recovery` (1) | `propose` |
| `invoicing` (7) | `render`, `void`, `disputeResolve`, `send`, `draftFromTicket`, `get`, `finalize` |
| `asset` (10) | `register`, `capitalReview`, `ccaClassSet`, `ccaClassVerify`, `dispose`, `list`, `schedule`, `schedulePrepare`, `scheduleReview`, `twin` |
| `fuel` (7) | `tankRegister`, `dispenseRecord`, `readingRecord`, `tankReconcile`, `statementImport`, `statementLineResolve`, `anomalies` |
| `ifta` (7) | `distanceRecord`, `tripSplit`, `distanceVerify`, `fuelJurisdictionSet`, `quarter`, `quarterPrepare`, `quarterFinalize` |
| `commercial` (4) | `termsSet`, `poRecord`, `rateCardCreate`, `billingCheck` |
| `portalAdmin` (3) | `identityInvite`, `identityRevoke`, `submissionReview` |
| `audit` (6) | `packagePrepare`, `packageRelease`, `packageWithdraw`, `packageGet`, `packageDownload`, `packageList` |

The structural check found **5 more** unscoped procedures in routers the F0 survey had reported as
scoped. They are now fixed using those routers' own convention:

- `finance.expenseCreate` (wrote an expense into any book id);
- `finance.expenseDuplicates` (listed another book's expenses);
- `commercialSetup.definitionPropose`, `commercialSetup.rateResolve` and `commercialSetup.pricingDecide` (read another book's rates, or wrote pricing decisions into it).

**Total repaired: 77 procedures.**

### Leaks inside procedures, closed in the same pass

- **`gst.return` / `returnPrepare`**:
  - Loaded every invoice in the database for the window, then filtered in memory. It now queries by book.
  - Counted every company's unassigned invoices in a review item. It now counts only no-book invoices whose own customer account is this book's.
  - `includeUnassignedInvoices: true` pulled **any** tenant's no-book invoices into the return. It is now refused.
- **`audit.packagePrepare` (`cor`, `insurance`)**: gathered **every** company's safety events, tailgates, inspections, training and escalated driving events. It now gathers them from the caller's scope only.
- **`audit.packagePrepare` (`vendor`)**: bills, approval ledgers, contractor payables, facility statements and registry documents are now read from the caller's books only.
- **`asset.twin`**: the unit must be in scope, and the asset and fuel rows are now read from the caller's books.
- **`fuel.statementImport`, `fuel.tankRegister`**: the fuel account must belong to the named book.
- **`fuel.statementLineResolve`**: the fuel transaction must be in the statement's own book.
- **`vendor.billRecord`**: a purchase-authorization or roadside reference from another book now links nothing. This is the same as the existing behaviour for an unknown reference.
- **Evidence ids** attached to money records must be evidence the caller could open (`evidenceInScope`).

## 4. Approval-ladder fixes

- **Revoked roles never count.** `commercialApprovalService.decide` read roles with no
  `revokedAt IS NULL` filter, so a revoked grant satisfied, refused or counted toward approvals. It is
  now filtered. The same defect in the read-only preview `commercialOffice.approvalRequirement` is
  fixed too.
  - Every other production read of `userRoleAssignments` was checked; all already filter.
- **Book + subject identity.** A ledger row is keyed `UNIQUE(subjectType, subjectRef)` (0136), so a
  row for the same subject identifier in another book used to be found and reused. It is now never
  reused: `decide` returns `blocked`, naming the other book.
  - Folding the book into the unique key needs a migration and is recorded for F2. Subject refs are
    system-issued, so this is a guard, not a normal path.
- **Cross-organization approval** is also refused one step earlier, by the resolvers: B's credentials
  cannot reach A's credit, write-off, bill or payment at all.

## 5. Period-close fix

`invoicing.void` now calls the existing hook `assertPeriodOpen(entity, issuedAt ?? createdAt,
"Void of invoice …")`, like every other dated finance write:

- A **closed or soft-closed** period refuses the void (`PRECONDITION_FAILED`), and nothing changes.
- The correction path is the existing one: a credit dated in an open period, or a controller reopening
  the period with a reason. There is no bypass.

A dedicated `invoices.accountingDate` column remains an F2 item, because it needs a migration.

## 6. Legacy rows with no book

- **Runtime.** Every finance endpoint fails closed for a no-book row, including the single tenant.
- **Audit.** `server/financeLegacyOwnership.ts` handles `invoices`, the only table behind these
  routers with a nullable book column.
  - It reads deterministic evidence that already exists:
    - the customer account's book;
    - the books of allocated payments;
    - the books of credits;
    - the organization of the job or billing book, which names a book only when that organization owns exactly one.
  - It classifies each row as **PROVEN** (all evidence names one book), **AMBIGUOUS** (the evidence disagrees), or **UNPROVEN** (there is no evidence).
- **Remediation.** `scripts/finance-legacy-ownership.ts`:
  - `report` is read-only.
  - `assign <invoiceNumber> --reason …` backfills **one** named, PROVEN invoice. It re-proves the row
    under a row lock and records a `finance.legacy_book_assigned` domain event in the same
    transaction. AMBIGUOUS and UNPROVEN rows are refused.
  - There is deliberately no bulk mode.

## 7. Inventory: a security blocker for F4

Parts inventory has **no organization ownership**. `parts`, `partMovements` and bins carry none, and
stock positions are sums over every organization's movements. Confirmed exposures in `shopRouter`,
none of which F1 changed:

| Procedure | Exposure |
|---|---|
| `shop.stock` (no part number) | Reads **every organization's** parts, on-hand quantities, average costs and reorder findings. |
| `shop.partCount` | Can adjust **any** part's on-hand by part number. Org B can zero Org A's stock. |
| `shop.partReceive`, `partReturn`, `coreReturn` | Can move stock on any part. `partReceive` also accepts any organization's vendor bill line. |
| `shop.partIssue` | The work order is scoped, but the part and bin are global. B can consume A's stock, and the issue cost is averaged across every organization's receipts. |
| `shop.partCreate` | Part numbers are one global catalog. A collision reveals that another organization has that part. |

**Can a parent prove ownership?** Only partly:

- Issues trace to a work order, and so to its unit's owner.
- Bill-linked receipts trace to the bill's book.
- Counts, returns, unlinked receipts and core returns carry no evidence, and one part row can be shared by several organizations.

**No safe guard is possible without a migration.** Failing these procedures closed for organization
members would switch off parts inventory for them. That is a product decision and was not taken
unilaterally.

**Blocking issue for F4**: parts and movements need a book (or organization) column, a backfill that
uses the evidence above, and scoping. Until then, parts inventory must not be presented as
tenant-isolated.

## 8. Other unscoped procedures found, outside the approved slice

These are pinned **by name** in `financeScopeCoverage.test.ts` (`KNOWN_UNSCOPED`). Deleting a line is
how one is closed, and the test fails if the list goes stale.

| Router | Procedures | Note |
|---|---|---|
| `insurance` | **All 12**: `policyRecord`, `coverageAssign`, `coverageVerify`, `coverageForEntity`, `requirementSet`, `requirementMatch`, `certificateIssue`, `renewalCalendar`, `claimOpen`, `claimCostRecord`, `claimRecoveryRecord`, `claimFinancials` | Zero scope calls. The structural check pins the 4 that take a book id; the other 8 take policy or claim refs. **Recommend fixing next**; it uses the same pattern. |
| `compliance` | `programPublish`, `profileReviewRecord` | Safety compliance; takes a book id unchecked. |
| `requirement` | `packActivate`, `workAuthorization`, `authorize` | Requirement engine; takes a book id unchecked. |
| `calibration` | `deviceRegister` | Takes a book id unchecked. |
| `dispatch` | `enforcementSet` | Takes a book id unchecked. Dispatch is under change on PR #9. |

## 9. Tests

| Test | Kind | Proves |
|---|---|---|
| `server/tenantScopeFinance.db.test.ts` | 52 cases (50 DB + 2 pure) | Two organizations; B holds controller + management + office + shop lead. **41 attempts** against A are each `NOT_FOUND`. They cover: read A's AR; mutate, void or send A's invoice; record, apply or release A's payment; access A's AP bills; close, reopen or read A's period; finalize A's GST; A's fuel and IFTA; A's credit terms; prepare, read, download or release A's audit package; decide A's credit with B's credentials. The refusal message equals a missing record's. A's rows are unchanged afterwards. The package list excludes A. Same-organization work still succeeds. A revoked role cannot approve. A Book B ledger row cannot satisfy Book A. A void in a closed or soft-closed period is refused, and allowed after a reopen. A no-book invoice is `NOT_FOUND` to everyone, and `includeUnassignedInvoices` is refused. Legacy classification and backfill are covered, including the refusal of ambiguous rows and the event on assignment. |
| `server/financeScopeCoverage.test.ts` | Structural, 6 cases | Read from the **live router**. All 72 finance procedures are marked, and each handler reads `ctx.money`. The mark is used nowhere else. Across the whole API, any procedure whose input takes `financialEntityId` or a money key is scoped, self-scoped, or a named exception. The exception list only shrinks. |

**Mutation proof.** Each planted defect turned the suites red. Each file was restored afterwards.

| Planted defect | Tests failing |
|---|---|
| Book check removed from `period.close` | 2 |
| Revoked roles counted | 1 |
| Void period guard removed | 2 |
| Another book's ledger row reused | 1 |
| `asset.list` unmarked | 3 |
| No-book rows treated as everyone's | 1 |

**Existing suites fixed, not weakened.** Fifteen suites passed **invented** book ids (for example
`const entityId = 1_600_000 + random`) or an invented job id straight into the routers. They passed
only because no book was checked, which is the vulnerability itself.

- They now create a real `financialEntities` row: owned by the single tenant in single-tenant suites, and by the test's organization in `commercialOffice.db.test.ts`.
- `purchasingAp.test.ts` creates a real job.
- `commercialOffice.db.test.ts` P7.8 keeps its vendor in the organization's book (`bookOrgRef`).
- No assertion was loosened.

## 10. What F1 did not do (per instruction)

F1 adds no migration, journals, financial-event engine, export batches, new inventory tables or
QuickBooks work, and makes no UI change. The P6.7 purchase-order decision is recorded in
`docs/P6_6_P6_7_DECISION_BRIEF.md`. It is **not implemented**: the current self-authorization within
the requester's own limit contradicts that decision, and the fix is scheduled with F4.

## 11. Carried forward

| Item | Where |
|---|---|
| Parts/stock ownership: migration, evidence backfill, scoping | F4, blocker |
| Insurance router scoping (12), and the 7 non-finance procedures | Owner decision; recommend next |
| `commercialApprovals` unique key to include the book | F2, migration |
| `invoices.accountingDate` | F2, migration |
| `decide()` inside the caller's transaction | F2 |
| P6.7 implementation (limit ∧ ladder, no self-approval) | F4 |
| New finance engines (events, journals, export, generalized inventory) | Frozen until the one-driver / one-job gate passes |
| Migration numbers | Taken from current `main` + open PRs when each migration PR is prepared. Never reserved early. The auth-workspace branch renumbers its `0170`; PR #9 keeps `0170`/`0171`. |
