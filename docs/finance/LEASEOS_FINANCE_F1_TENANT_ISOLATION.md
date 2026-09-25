# LeaseOS Finance F1 / F1.1 / F1.2 / F1.3: tenant isolation and security repair

**Status**: F1, F1.1, F1.2 and F1.3 are implemented on `claude/finance-accounting-survey-2mp4h6`. It stops
here: F2 is not started, and no PR is open.
**Base**: cut from `main` = `0060690`. Current `main` (`60f3899`: dispatch slots, C1a, SPINE item 1,
migrations to 0179) is merged in. **No migration** and no new schema. **No new engine.**

This is a security prerequisite for every later Finance & Accounting checkpoint.

**LeaseOS is not completely tenant-isolated.** §7 separates what is **secured now** from what is
**blocked until an ownership migration**. The blocked items cannot be isolated without schema work, so
they now **fail closed** instead of leaking. The inventory ones are unavailable to organizations until
F4.

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

## 7. F1.1 security closure

### 7.1 SECURED NOW

Every procedure below proves **caller → organization → book (or owning parent) → record** server-side.
Out of scope answers `NOT_FOUND`, and role checks are unchanged. Both checks must pass.

**Insurance (12), under `moneyScoped`:**

| Procedure | Proves |
|---|---|
| `policyRecord` | the book |
| `coverageAssign` | the policy's book, and each covered entity |
| `coverageVerify` | the policy's book |
| `coverageForEntity` | the book, and the entity (whose compliance documents it reads) |
| `requirementSet` | fails closed (§7.2) |
| `requirementMatch` | the book; the requirements fail closed (§7.2) |
| `certificateIssue` | the policy's book, and the evidence |
| `renewalCalendar` | the book; its certificate read is limited to this book's policies (it read every company's) |
| `claimOpen` | the policy's book, the incident, the roadside event, the unit and the job |
| `claimCostRecord` | the claim's book; a vendor bill must be the same book's |
| `claimRecoveryRecord` | the claim's book |
| `claimFinancials` | the claim's book |

Covered entities:

- Units and trailers are checked through `coreRecordOwnership`, and operators the same way.
- `company` must be one of the caller's own books.
- A facility is a shared directory entry.
- `equipment` and `branch` have no owner model, so they fail closed (§7.2).

**Book-id procedures outside finance (7 reported, plus 3 calibration siblings and `dispatch.enforcementGet`, found).** These use the generic
`assertCallerOwnsEntity` (`_core/entityScope.ts`), with no finance context:

| Procedure | Fix |
|---|---|
| `compliance.programPublish` | Book proved. The "prior version" is now looked up **within the book**; before, publishing a key another company used **superseded that company's program**. A key another company holds is refused `CONFLICT`: keys are globally unique until the schema scopes them. |
| `compliance.profileReviewRecord` | Book proved; evidence checked. |
| `requirement.packActivate` | Book proved. |
| `requirement.workAuthorization` | Book and worker proved. Equipment credentials fail closed (§7.2). |
| `requirement.authorize` (`equipment.authorize`) | Book, the operator's user, and the evidence proved. |
| `calibration.deviceRegister` | Book proved. |
| `calibration.eventRecord` | Sibling by `deviceRef`: the device's book is proved. |
| `calibration.impact` | Sibling by `deviceRef`: the device's book is proved. |
| `requirement.calibrationSweep` | Sibling by `calibrationEventId`: the device's book is proved. |
| `dispatch.enforcementSet` | A company's own mode needs its own book (`NOT_FOUND` otherwise). The **global** mode is **platform-governed since F1.3** (§7.4): once organizations exist, only platform authority may change it. |
| `dispatch.enforcementGet` | Another company's own mode is `NOT_FOUND`. The global mode is `FORBIDDEN` to organization members (C1a), and readable by the single tenant and by platform authority. |

**Found by the widened structural scan, and fixed:**

| Procedure | What was wrong |
|---|---|
| `funding.opportunitiesList` | Listed **every** company's funding opportunities. |
| `funding.opportunityAdvance` | Changed any company's opportunity. |
| `funding.claimRecord` | Its stacking check read another company's claims on an expense. It now requires the caller's own expense (`expenseRef` is unique; the expense carries the book). |
| `funding.stackingCheck` | Same stacking read as `claimRecord`. |
| `finance.expenseSetTreatment` | Changed the tax treatment of any company's expense. |

**Totals now secured:**

- 84 `moneyScoped` procedures: 72 from F1 + 12 insurance.
- 21 procedures that prove the book themselves:
  - 5 from F1 (`finance.expenseCreate`, `expenseDuplicates`, `commercialSetup` ×3);
  - 11 from F1.1: the 7 reported, 3 calibration siblings, and `dispatch.enforcementGet`, which the optional-input scan found;
  - 5 funding/expense.
- **105 tenant-isolated procedures after F1.1** (84 + 21), and **111 after F1.2** (+6 compliance, §7.3). F1.3 changes who may write one row (the global dispatch mode), not the procedure count.
- Separately, the revoked-role defect is fixed in `commercialApprovalService.decide` and in the `commercialOffice.approvalRequirement` preview.

### 7.2 BLOCKED UNTIL OWNERSHIP MIGRATION: fail closed

These rows carry **no owner at all**, so the server cannot prove whose they are. **Unknown ownership is
not global access.**

`server/ownershipDomain.ts` (`requireProvableOwnership`) refuses these operations with
`PRECONDITION_FAILED` and the message prefix `OWNERSHIP_UNRESOLVED:`, **before anything is read or
written**, whenever any organization exists. The refusal applies to organization members **and** to
the historical single tenant: once organizations exist, rows written by their members cannot be told
apart from the single tenant's.

| Capability now unavailable once organizations exist | Procedures | Why ownership cannot be proven | Unblocked by |
|---|---|---|---|
| Parts catalog, stock positions, receiving, issuing, returns, core returns, counts and adjustments | `shop.partCreate`, `partReceive`, `partIssue`, `partReturn`, `coreReturn`, `partCount`, `stock` | `parts`, bins and `partMovements` have no organization. Positions are sums over every organization's movements. | **F4** (§8) |
| Tire registry | `shop.tireRegister`, `tireInstall`, `tireRemove`, `tireMeasure`, `tireHistory` | `tires` are global, keyed by serial. | **F4** |
| Serialized tools | `shop.toolRegister`, `toolCheckout`, `toolReturn` | `serializedTools` are global, keyed by serial. | **F4** |
| Warranty policies and claims | `shop.warrantyPolicyRecord`, `warrantyClaimRaise`, `warrantyClaimDecide` | Their subjects are parts and tires. Policies and claims are global, keyed by ref. | **F4** |
| Customer insurance requirements | `insurance.requirementSet`, `insurance.requirementMatch` | `insuranceRequirements` is keyed by a **free-text** customer name, and `requirementSet` **replaced every row** for that name. Two companies' "Acme" collided. | A book column on `insuranceRequirements`, in the next finance schema checkpoint (F2) |
| Equipment credentials in a work-authorization evaluation, and insurance coverage of `equipment`/`branch` | `requirement.workAuthorization` (equipment or attachments present), `insurance.coverageAssign`/`coverageForEntity` for `equipment`/`branch` | There is no equipment or branch table; the ids name nothing ownable. | An equipment/branch owner model |

**Still available** in the shop:

- work orders, releases, unit and work-order cost, and recalls by unit, which are scoped through the unit (P4.1);
- verifying a public recall notice (`recallVerify`), which is a shared-directory fact.

**Single-tenant deployments keep full use.** While **no organization exists**, the deployment is provably
one ownership domain, and every one of these operations works as before. This is safe because the
condition is read from the database (not from input, a setting or a role). A deployment with no
organizations has, by definition, one owner. The moment one organization is created, the gate closes
for everyone, including the single tenant, until the rows get an owner.

**Residual, documented.** Issue cost at a work order is an average over receipts made before F1.1 by
every organization. `workOrderCost` and `unitCost` therefore still report a cost figure contaminated by
other organizations' receipt prices, while reading only the caller's own work orders. F4 fixes this
when stock carries an owner.

### 7.3 F1.2: compliance subjects (found in F1.1, fixed in F1.2)

F1.1 found that `complianceRouter` scoped nothing except the two book-id procedures above. **F1.2
fixes it without a migration**, using owners that already exist. One helper,
`requireSubjectInScope` in `server/complianceRouter.ts`, proves the named subject through its owner:

| Subject (`ownerType` / `subjectType`) | Proved through |
|---|---|
| `operator` | `operatorInScope` (`coreRecordOwnership`, P4.1) |
| `unit`, `trailer` | `unitInScope` (trailers are units: `trailerUnitId`) |
| `job` | `jobInScope` (`jobs.orgRef`, 0132) |
| `user` | `userInScope` (active membership) |
| `carrier` | `assertCallerOwnsEntity`: the company's legal entity (0146), the same id `programPublish` and `profileReviewRecord` use for carrier compliance |
| `equipment` | `requireProvableOwnership`: no owner exists, so it fails closed once organizations exist (as §7.2) |

A subject from another company answers `NOT_FOUND`, **with the same message as one that does not exist**.

| Procedure | Before | Now |
|---|---|---|
| `compliance.passport` | Any subject's credentials, by id | Subject proved first |
| `compliance.jobPassport` | Any carrier, operator, unit or trailer | **Every** named subject proved before any is read. One foreign subject refuses the whole job. |
| `compliance.medicalEligibility` | Any operator's medical eligibility | Operator proved |
| `compliance.credentialRecord` | Filed a credential against any subject, citing any evidence | Owner proved; evidence proved (`evidenceInScope`) |
| `compliance.credentialVerify` | Verified or rejected any company's credential | The credential's owner proved; another company's credential is "not found" |
| `compliance.consentRecord` | Recorded consent for any person, on any signature evidence | Person and signature evidence proved |

**Not changed, and why** (each one classified in the structural net, so a new procedure cannot default):

- `driverQualification`, `dangerousGoodsAssist`, `securementAssist`, `knowledgeCatalog`: pure evaluators.
  They read no table. `driverQualification` carries an `operatorId` in its input but never looks it up,
  and evaluates only the profile it is given.
- `requirementLoad`: **one shared regulatory registry** for every company (controller only). A
  requirement is a regulation, not a company's record. Note, though, that a controller in one
  organization can therefore supersede a requirement every company's passports read. This is a
  **governance question, not a leak**, and is carried in §11 for an owner decision (platform-only
  loading, or per-company overlays, which would be a schema change).

### 7.4 F1.3: the global dispatch mode is platform-governed

**Owner decision.** The global dispatch mode is the fallback for every organization without a mode of
its own, and the mode of the legacy path. Once organizations exist, only **platform authority** may
change it. Being unaffiliated is not authority.

**The authority.** LeaseOS already has exactly one platform-level authority: `users.role = "admin"`,
the one `adminProcedure` and `records.roles.bootstrapManagement` use. F1.3 adds no second hierarchy.
`server/platformAuthority.ts` (`platformAuthorityProven`) reads it **from the `users` row at the moment
of the change**, not from the session. So:

- a demotion takes effect on the next call;
- a session minted while the user was an admin carries no authority afterwards;
- nothing in the request can stand in for it: a role the context claims, or extra input fields (which the
  schema strips anyway);
- a missing row, a missing database or any error answers **no** (fail closed).

**Who may do what** (`assertEnforcementScope` in `server/dispatchRouter.ts`):

| Caller | Global mode, write | Global mode, read | Own organization's mode | Another organization's mode |
|---|---|---|---|---|
| Platform administrator (users row), with the domain permission | ✅ | ✅ | per existing permissions | `NOT_FOUND` |
| Organization user with the domain permission | `FORBIDDEN` | `FORBIDDEN` (C1a) | ✅ | `NOT_FOUND` |
| Unaffiliated ordinary user with the domain permission, organizations exist | **`FORBIDDEN`** (was allowed under C1a) | ✅ (C1a read rule kept) | — | `NOT_FOUND` |
| Anyone, while **no** organization exists | the one tenant governs its own deployment, as before | as before | — | — |

Platform authority is **not** a domain permission, and the domain permission is not platform authority.
Changing the global mode needs **both**: `dispatch.enforcementSet` (the `roleProcedure` gate, management
or controller) **and** the users row. An administrator without the permission is refused by the role
gate. This is the conservative reading of "use the existing concept". The bootstrap comment in
`recordsRouter` says the same thing: "an admin is not thereby a mechanic".

**Fallback behaviour is unchanged** (`currentMode`): an organization's explicit mode wins, and an
organization with none resolves through the global mode.

## 8. F4 design note: inventory ownership

**Target model: explicit ownership, never inferred from whoever asks.**

- Each of `parts`, `stockLocations` (new; bins become rows) and `partMovements` gets
  `financialEntityId int NOT NULL` → `financialEntities`, which resolves to the organization through
  0146. It uses the same boundary as every other money record, so the F1 guard applies unchanged.
- **Parts become per book.** `UNIQUE(financialEntityId, partNumber)` replaces the global part number.
  Two companies may both stock `FILTER-OIL`; they are different rows.
- **A movement's book must equal its part's and its location's book.** This is enforced in the service
  and backstopped by a trigger. Issues, receipts, returns, counts, adjustments and transfers all
  inherit the rule.
- **A transfer is two movements in one book.** A cross-book transfer is refused; moving stock between
  companies is a sale or purchase, not a transfer.
- **Counts:** `stockCounts` header + lines, per book and location. Variances post as `adjust_count`
  movements in the same book.
- **Tires, serialized tools, warranty policies and claims** get `financialEntityId NOT NULL` the same
  way. A warranty claim's book must equal its policy's.
- **Costing:** the average cost is computed per book (and location). Receipts from other books never
  enter it.

**Migration of existing rows: evidence, never assignment by access.**

1. For each existing part, movement, tire, tool and warranty row, collect deterministic evidence:
   - an **issue** → its work order → the unit's owner (`coreRecordOwnership`);
   - a **receipt** linked to a vendor bill line → that bill's book;
   - a **tire** → the units it was installed on (`tireInstallations` → unit owner);
   - a **warranty claim** → its work order or tire;
   - a **movement's `byUserId`** → that person's organization, as supporting evidence only (membership can change);
   - a **part** → the books of all its movements.
2. **Exactly one book proven** by all evidence → eligible for migration. It is assigned in a script
   run by an administrator, as with `scripts/finance-legacy-ownership.ts`, with a domain event per
   assignment.
3. **Several books** (a part row shared by two companies' movements) → **split**, not guessed. Each
   book gets its own part row, and each movement moves to its own book's row, one migration per
   proven movement. Any movement whose book cannot be proven stays with the quarantined original.
4. **No evidence or conflicting evidence** → quarantined in a `stockOwnershipQuarantine` report for
   an administrator. The row stays unavailable, and nothing is silently assigned.
5. **A deployment that has never had an organization** migrates everything to its single book in one
   step, because it is provably one domain.
6. After the migration, the `ownership_gated_until_F4` shop procedures move to money scoping. Their
   entries in `financeScopeCoverage.test.ts` change class, and the structural test fails until they do.

The migration is **not written in F1.1**. Its number is taken from current `main` plus open PRs when
the F4 migration PR is prepared.

## 9. Tests

| Test | Kind | Proves |
|---|---|---|
| `server/tenantScopeFinance.db.test.ts` | 117 cases (115 DB + 2 pure) | **F1:** 41 cross-tenant attempts against Org A's money are each `NOT_FOUND`. Revoked approvers are refused. A Book B ledger row cannot satisfy Book A. A void is refused in a closed or soft-closed period. Legacy no-book rows fail closed; their classification and backfill are covered. **F1.1:** Org B (holding every relevant role) is refused `NOT_FOUND` on **27 attempts** covering every insurance operation category, compliance, requirements, calibration, dispatch, funding and expenses. B's same-key program cannot supersede A's (`CONFLICT`). The opportunity list excludes A. The global dispatch mode is `FORBIDDEN` to an organization, to set and to read (`main`'s C1a rule). A's rows are unchanged, and same-organization work succeeds. **Inventory:** the real predicate reports not-one-domain once organizations exist. All 18 ownerless shop operations are refused (`OWNERSHIP_UNRESOLVED`) to an organization's shop lead **and** to the single tenant, with no rows written, while the unit's own work-order cost stays readable. Insurance requirements and equipment credentials are refused, and nothing changes. **F1.2:** Org B (every relevant role plus `hr`) is refused `NOT_FOUND` on **18 attempts**: passports of A's operator, unit, trailer, job, person and carrier; job passports mixing A's subjects with B's own; A's medical eligibility; credentials filed against A's subjects or on A's evidence; verifying A's credential; consent for A's person or on A's signature evidence. A foreign subject gets the same message as a missing one. Equipment credentials fail closed. A's credentials and consents are unchanged. Each owner path (carrier, unit, trailer, job, person, operator) resolves for A's own people. **F1.3:** (1) a platform admin sets the global mode, both unaffiliated and as a member of Org A; (2) an unaffiliated ordinary user holding the permission is `FORBIDDEN`, as is an organization user; (3) Org A's manager sets A's own mode; (4) Org A cannot set or read B's mode (`NOT_FOUND`), while B can; (5) an Org A book with no mode resolves `source: global`; (6) A's explicit mode overrides it (`source: entity`) and the global mode is unchanged; (7) **no bypass**: a session claiming admin over a users row that says `user`, admin flags in the input, an explicit `financialEntityId: null`, no users row at all, an admin without the domain permission, and an admin demoted mid-session are all `FORBIDDEN`, and the global row is exactly as the last legitimate write left it. C1a's read rule is kept. |
| `server/financeScopeCoverage.test.ts` | Structural, 14 cases, from the **live router** | The 84 money-namespace procedures (72 + 12 insurance) are marked and use the boundary. The mark is used nowhere else. The scan sees through `.optional()` inputs. **No unscoped money procedure exists anywhere in the API**; the only listed procedures are the 3 portal ones scoped by external identity. Every F1.1 procedure outside the money namespaces proves its book. **Every shop procedure is classified** (unit/work-order scoped, shared public directory, or ownership-gated until F4), so a new one fails until classified. Every gated one calls the gate. **F1.2: every compliance procedure is classified** (subject scoped, book scoped, pure evaluator, or shared registry). Subject-scoped ones call `requireSubjectInScope`, book-scoped ones prove the book, and pure evaluators touch no table. |

**The structural exception list.** It holds **no** unscoped gaps. `EXTERNALLY_SCOPED` holds only
`portal.invoiceView`, `portal.invoiceAccept` and `portal.invoiceDispute`: they are `externalProcedure`
and scoped by the portal identity's account binding, so they are not gaps. The schema-blocked
inventory cases are not exceptions: they **fail closed** and are asserted by class in the `SHOP` map,
with **F4** named as the resolving checkpoint.

**Mutation proof.** Each planted defect turned the suites red, and every file was restored.

| Planted defect | Tests failing |
|---|---|
| **F1:** book check removed from `period.close` | 2 |
| **F1:** revoked roles counted | 1 |
| **F1:** void period guard removed | 2 |
| **F1:** another book's ledger row reused | 1 |
| **F1:** `asset.list` unmarked | 3 |
| **F1:** no-book rows treated as everyone's | 1 |
| **F1.1:** insurance policy scope removed | 6 |
| **F1.1:** `compliance.programPublish` scope removed | 4 |
| **F1.1:** `requirement.packActivate` scope removed | 3 |
| **F1.1:** `calibration.deviceRegister` scope removed | 3 |
| **F1.1:** `dispatch.enforcementSet` scope removed | 5 |
| **F1.1:** inventory fail-closed bypassed | 2 |
| **F1.1:** `funding.stackingCheck` scope removed | 2 |
| **F1.2:** `requireSubjectInScope` made a no-op | 19 |
| **F1.2:** `jobPassport` subject loop removed | 3 |
| **F1.2:** `credentialVerify` owner check removed | 3 |
| **F1.2:** `consentRecord` signature-evidence check removed | 2 |
| **F1.2:** `carrier` resolved as a person instead of a book | 1 |
| **F1.2:** `trailer` resolved as a person instead of a unit | 1 (this one **survived** at first: B was still refused, by accident. The same-organization success test now drives every owner path.) |
| **F1.2:** `job` resolved as a unit | 1 |
| **F1.3:** global write reverted to C1a (any unaffiliated user) | 5 |
| **F1.3:** platform authority always granted | 5 |
| **F1.3:** platform authority never proven | 5 |
| **F1.3:** entity ownership skipped for an entity mode | 1 |
| **F1.3:** organization members allowed to read the global mode | 1 |
| **F1.3:** a write checked with the read rule | 5 |

**Existing suites fixed, not weakened.**

- **F1:** 15 suites passed invented book ids.
- **F1.1:**
  - `insuranceRisk` invented book and **unit** ids; `compliancePassport` and `requirementEngine` invented book, operator and job ids. They now create real records.
  - `fleetShop`, `insuranceRisk`, `requirementEngine`, `auditPackage` and `workforce` exercise the single-ownership-domain deployment. Only the ownership predicate is mocked, with a comment pointing to the real-database proof above.
  - `dispatchEnforcement` and `fieldroute` are `main`'s versions since the merge (C1a's rule).
  - **F1.2:** `compliancePassport` invented an operator id. It now creates a real operator.
  - **F1.2:** `fieldroute` used "operator 1", and `purchasingAp` and `requirementEngine` used "evidence 1". On a fresh database those are whichever suite inserted first, and the F1.2 suite's are organization-owned. The gate failed 4 tests exactly that way (reproduced by running F1.2 first). Each suite now uses its own record.
  - `restrictedVaultApi` (from `main`) drew user ids from 960k–990k, which overlaps `recordsAuthorizationDb` and `assistantCommitService`. One fresh-database gate run collided on a role grant (`activeGrantKey` duplicate, 4 tests). It now has its own range (296M).
  - **F1.3:** `dispatchEnforcement`'s manager and `fieldroute`'s setup set the global mode, so each is now a real platform administrator (a users row with role `admin`), not a session claim. `fieldroute` uses an explicit id from its own window (297M): the users auto-increment lands wherever explicit ids pushed it, and an auto-numbered admin collided with another suite's role grant.
  - `tenantScopeShop` expects the ownership refusal for its warranty call.
  - `requirementEngine` used a hard-coded job 1, which collided with whichever suite created the first job. It now uses its own job.
  - `portalFundingApi` advanced an opportunity in invented book 1 and claimed against expenses that did not exist. It now uses a real book and real expenses.
  - `operationalTruth` scanned "unit 1". On a fresh database that is whichever suite created the first unit, and the new suite's units are organization-owned. It now scans its own single-tenant unit.
  - The new suite keeps its refusal-only dates in the past, per the `calendarFixtures` rule.
- No assertion was loosened.

## 10. What F1 / F1.1 / F1.2 / F1.3 did not do (per instruction)

F1, F1.1, F1.2 and F1.3 add no migration, journals, financial-event engine, export batches, new inventory tables or
QuickBooks work, make no procurement workflow change and no UI change, and open no PR. The P6.7
purchase-order decision is recorded in `docs/P6_6_P6_7_DECISION_BRIEF.md`. It is **not implemented**:
the current self-authorization within the requester's own limit contradicts that decision, but it is not
a cross-tenant vulnerability (both the request and its approval are now book-scoped). Its fix is
scheduled with F4.

## 11. Carried forward

| Item | Where |
|---|---|
| Compliance operator/unit/credential procedures (§7.3) | **Done in F1.2** |
| Global dispatch mode governance (C1a let any unaffiliated user change it after organizations exist) | **Decided and done in F1.3** (§7.4): platform-governed |
| The single-domain branch of the global write (no organization exists) is covered by reasoning, not a DB test: every shared test database has organizations | Covered when a single-domain deployment test harness exists |
| `compliance.requirementLoad` governs one shared registry: any organization's controller can supersede a requirement every company reads (§7.3) | Owner decision (platform-only loading, or per-company overlays = schema) |
| Parts, stock, tires, tools, warranty ownership: migration, evidence backfill, scoping (§8) | F4, blocker |
| `insuranceRequirements` book column; program keys scoped per company | Next schema checkpoint (F2) |
| Equipment and branch owner model | Owner decision |
| `commercialApprovals` unique key to include the book; `invoices.accountingDate`; `decide()` inside the caller's transaction | F2 |
| P6.7 implementation (limit ∧ ladder, no self-approval) | F4 |
| New finance engines (events, journals, export, generalized inventory) | Frozen until the one-driver / one-job gate passes |
| Migration numbers | Taken from current `main` + open PRs when each migration PR is prepared. Never reserved early. |
| Merging current `main` | **Done** (`60f3899`). The dispatch conflict was resolved to `main`'s C1a code; F1.1's dispatch tests were adapted to it. |
