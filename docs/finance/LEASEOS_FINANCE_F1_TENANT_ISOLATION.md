# LeaseOS Finance F1 / F1.1 / F1.2 / F1.3: tenant isolation and security repair

**Status**: F1, F1.1, F1.2 and the first F1.3 pass reached `main` through PR #56 (merged as `9569195`,
together with C1b-2: the requirement registry read per organization, and verification through the ledger).
The rest of F1.3 (the final platform-authority rule, the zero-organization bootstrap test, the organization
registry pins and the merged-tree gate fixes) is a follow-up PR on top of that. F2 is not started.
**Base**: originally cut from `main` = `0060690`; the follow-up is based on `main` = `9569195`. **No migration** and no new schema. **No new engine.**

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
| `dispatch.enforcementSet` | A company's own mode: the domain permission, and the book must be the caller's (`NOT_FOUND` otherwise). The **global** mode is **platform configuration** (§7.4). |
| `dispatch.enforcementGet` | Same split: a company's own mode by organization authority, the global mode by platform authority (§7.4). |

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
- `requirementLoad` and main's C1b-2b ledger procedures: **organization-scoped** (§7.5).

### 7.4 F1.3: the global dispatch mode is platform configuration

**Owner decision.** The global dispatch mode is the fallback for every organization without a mode of
its own, and the mode of the legacy path. It is **platform configuration**. An organization's own mode
is **organization configuration**. The two authorities are never conflated.

**The authority.** LeaseOS already has exactly one platform-level authority: `users.role = "admin"`,
the one `adminProcedure` and `records.roles.bootstrapManagement` use. F1.3 adds no second hierarchy.
`server/platformAuthority.ts` (`platformAuthorityProven`) reads it **from the `users` row at call time**:

- a demotion takes effect on the next request;
- a session minted while the user was an admin carries no authority afterwards;
- nothing in the request stands in for it: a role the session claims, admin flags or organization ids in
  the input (the schema strips them, and they would not count anyway);
- a missing row, a missing database or any error answers **no** (fail closed).

**The gate.** `platformOrOrganizationProcedure` (`server/_core/trpc.ts`) chooses the gate from the
request's target, then the handler re-checks the parsed target against the authority that admitted it
(`assertGovernedTarget`), so a raw/parsed mismatch cannot cross gates. Every platform decision (allowed or
refused) is written to `authorizationDecisions` with `permission = 'platform.authority'`.

**Final authority matrix**, organizations existing:

| Caller | Global mode: set | Global mode: read | Own organization's mode | Another organization's mode |
|---|---|---|---|---|
| Platform administrator (users row), **no domain role needed** | ✅ | ✅ | only with the organization permission and ownership, like anyone (no bypass) | `NOT_FOUND`, or `FORBIDDEN` without the permission |
| Organization manager / controller (domain permission) | `FORBIDDEN` | `FORBIDDEN` | ✅ | `NOT_FOUND` |
| Unaffiliated ordinary user, even holding the permission | `FORBIDDEN` | `FORBIDDEN` | — | `NOT_FOUND` |
| Session claiming admin over a users row that says `user`; no users row; demoted admin | `FORBIDDEN` | `FORBIDDEN` | as their ordinary rights | as their ordinary rights |

Reading the global mode is now platform-only too once organizations exist. No client reads it, and the
dispatch path reads it server-side (`loadEnforcementMode`), so nothing loses a status it relied on.
`main`'s C1a read rule let an unaffiliated user read it; F1.3 removes that.

**Fallback behaviour is unchanged** (`currentMode`): an organization's explicit mode wins, and an
organization with none resolves through the global mode.

**BOOTSTRAP (the one exception), exactly:**

- **Condition:** the `organizations` table has **zero rows** (`singleOwnershipDomain()`, read from the
  database; any status counts).
- **What it allows:** reading or setting the **global dispatch mode** on the ordinary domain permission
  (`dispatch.enforcement.manage` to set, `dispatch.read` to read). It is not permission-free: a user
  without the permission is refused even then. Platform authority works throughout.
- **Why it exists:** before any organization exists, the deployment is one tenant, and its legacy jobs
  carry no entity, so the global row is that tenant's only switch. This is what `main`'s C1a allowed the
  single tenant, kept only for as long as it is provably safe.
- **What ends it:** the **first `organizations` row**, for every ordinary user, immediately. No
  application path updates or deletes organization rows. A suspended or closed organization still
  counts, and an ended membership, null or made-up ids, or a claimed session do not bring it back.
  Reopening it would take direct database deletion of every organization row, which is already full
  control of the deployment.
- **Nowhere else:** only `dispatch.enforcementSet` / `enforcementGet` carry the `bootstrap` mark. The
  requirement registry needs none: it is not platform-governed (§7.5).

Proven on an **isolated database with zero organizations**: `server/platformBootstrap.db.test.ts` (§9).

### 7.5 F1.3: the compliance requirement registry is organization-scoped

**What changed under this checkpoint.** F1.3's Decision 2 made the registry platform-governed, because
`requirementLoad` then wrote one table every organization's passports read. While F1.3 was in progress,
`main` merged **C1b-2** (owner decision C1b-Q2 = B), which changed that premise:

- `requirementLoad` now only **proposes** a revision. The proposal is stamped with the proposer's acting
  organization, from server scope (`actingScopeFor`), never from input.
- The registry is **read per organization**: legacy rows with no organization, plus the caller's own
  organization's revisions (`loadRequirementRegistry`).
- Verification (`requirementVerify`, `requirementSecondApprove`), withdrawal and verification policy are
  organization-scoped, with separation of duties **by person**. Another organization's revision is `NOT_FOUND`.

**Owner decision (F1.3, on the merge):** keep C1b-2's organization model. Decision 2's intent, that no
organization can change the requirements another organization reads, is met by that scoping.
`requirementLoad` is therefore **not** platform-only, and organizations keep proposing their own
requirements.

**What F1.3 proves and pins instead:**

- **No shared writes.** The registry has exactly **one writer** in the whole server,
  `proposeRequirement` (`requirementVerification.ts`). It stamps `orgRef` from server scope and never
  `NULL`. The structural test fails if any other file writes the table, or if the stamp is removed.
- **No reads across organizations.** Registry reads filter by organization, and every
  `organization_registry` procedure takes its organization from `actingScopeFor`. The structural test
  fails if an input field could name one.
- **Behaviour:**
  - Org A's proposal is stamped A, even when the input names B.
  - B's passport, provenance, verification, second approval and withdrawal cannot reach A's revision.
  - B proposing the same key leaves A's view **byte-for-byte** unchanged.
  - An unaffiliated controller's proposal belongs to the single tenant (`default`), never to everyone.
  - A's other compliance procedures leave B's view byte-for-byte unchanged.
  - No action anywhere creates a shared (`NULL`-org) row.
- **Equivalent writers searched:**
  - `complianceRequirements` and `requirementVerificationEvents` are written only by the ledger service.
  - `sourceVerificationPolicies` is written only by `setVerificationPolicy`, which is organization-scoped.
  - `compliancePacks` has no writer.
  - `requirement.packActivate` writes a per-book activation (tenant-scoped since F1.1).

`NULL`-organization legacy rows (from before migration 0198) are the only registry rows every
organization reads. They are immutable (0198 triggers) and UNVERIFIED, and no endpoint writes new ones.

### 7.6 The final authority model

| Class | What | Authority | Enforced by |
|---|---|---|---|
| **PLATFORM** | The global dispatch mode (the fallback every organization without its own mode uses) | `users.role = "admin"`, read from the users row at call time; no organization role needed or sufficient | `platformOrOrganizationProcedure` (meta `platformGoverned: "global_target"`) |
| **ORGANIZATION** | An organization's own dispatch mode; finance records (84 money-scoped + 21 book-proven); insurance; compliance subjects (6); the compliance requirement registry (proposals, verification, withdrawal, policy, provenance: C1b-2, pinned by F1.3); every other tenant-owned record | Domain permission **and** ownership through the caller's organization; out of scope = `NOT_FOUND` | `moneyScoped`, the `*InScope` resolvers, `assertCallerOwnsEntity`, `requireSubjectInScope` |
| **SCHEMA-BLOCKED** | Parts, stock, tires, tools, warranty (18 shop procedures) until F4; customer insurance requirements until a book column; equipment and branch credentials and coverage until an owner model exists | Refused (`OWNERSHIP_UNRESOLVED`) whenever any organization exists | `requireProvableOwnership` |
| **BOOTSTRAP** | Global dispatch mode only, while `organizations` has zero rows | The ordinary domain permission | the `bootstrap: "zero_organizations"` branch of `platformOrOrganizationProcedure` |

The structural test declares these as separate classes, not one exception list (§9).

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
| `server/tenantScopeFinance.db.test.ts` | 123 cases (121 DB + 2 pure) | **F1:** 41 cross-tenant attempts against Org A's money are each `NOT_FOUND`. Revoked approvers are refused. A Book B ledger row cannot satisfy Book A. A void is refused in a closed or soft-closed period. Legacy no-book rows fail closed; their classification and backfill are covered. **F1.1:** Org B (holding every relevant role) is refused `NOT_FOUND` on **27 attempts** covering every insurance operation category, compliance, requirements, calibration, dispatch, funding and expenses. B's same-key program cannot supersede A's (`CONFLICT`). The opportunity list excludes A. The global dispatch mode is `FORBIDDEN` to an organization, to set and to read (`main`'s C1a rule). A's rows are unchanged, and same-organization work succeeds. **Inventory:** the real predicate reports not-one-domain once organizations exist. All 18 ownerless shop operations are refused (`OWNERSHIP_UNRESOLVED`) to an organization's shop lead **and** to the single tenant, with no rows written, while the unit's own work-order cost stays readable. Insurance requirements and equipment credentials are refused, and nothing changes. **F1.2:** Org B (every relevant role plus `hr`) is refused `NOT_FOUND` on **18 attempts**: passports of A's operator, unit, trailer, job, person and carrier; job passports mixing A's subjects with B's own; A's medical eligibility; credentials filed against A's subjects or on A's evidence; verifying A's credential; consent for A's person or on A's signature evidence. A foreign subject gets the same message as a missing one. Equipment credentials fail closed. A's credentials and consents are unchanged. Each owner path (carrier, unit, trailer, job, person, operator) resolves for A's own people. **F1.3 dispatch:** (1) a platform admin with **no domain role** reads and sets the global mode, unaffiliated or as a member of Org A; (2) an unaffiliated user holding the permission, Org A's manager and Org A's controller are all `FORBIDDEN`, to set and to read; (3) A's manager sets A's own mode; (4) A cannot set or read B's mode (`NOT_FOUND`), a platform admin cannot reach into B's own mode (`FORBIDDEN`), and B can set its own; (5) an Org A book with no mode resolves `source: global`; (6) A's explicit mode overrides it and the global mode is unchanged; (7) **no bypass**: a claimed session, admin flags in the input, an explicit `null` entity, a malformed entity id, no users row, and a demoted admin (next request, same session) are refused, and the global row is exactly as the last legitimate write left it. Platform refusals are in the authorization trail. **F1.3 registry (organization-scoped):** Org A's proposal is stamped A even when the input names B. B's passport, provenance, verify, second approval and withdrawal cannot reach A's revision (`NOT_FOUND`), and B's view is byte-for-byte unchanged. B proposing and verifying the same key leaves A's view byte-for-byte unchanged, and each organization's passport reads its own revision. An unaffiliated controller's proposal is `default`, never shared. Passports keep working after verification. A's credential record and verify, consent, program publish, profile review and verification policy leave B's view byte-for-byte unchanged, and no action creates a `NULL`-org row. |
| `server/platformBootstrap.db.test.ts` | 8 cases, **isolated database** (its own schema copy, zero organizations, dropped afterwards) | Zero organizations: a manager reads and sets the global mode (bootstrap), and a user without the permission is refused even then. A controller's registry proposal belongs to the single tenant (`default`), not to everyone. The first organization is created: the same manager is refused, to set and to read, and a platform admin with **no role** succeeds. Nothing restores bootstrap: an ended or deleted membership, a suspended or closed organization, an explicit `null` entity, raw `orgRef`/`organizationId`/`tenantId` fields, a made-up entity id (`NOT_FOUND`), or a session claiming admin. The global row is exactly as the admin left it. After the first organization, a member's proposal is stamped with that organization. No `NULL`-org row at any point. |
| `server/financeScopeCoverage.test.ts` | Structural, 23 cases, from the **live router** | The 84 money-namespace procedures (72 + 12 insurance) are marked and use the boundary. The mark is used nowhere else. The scan sees through `.optional()` inputs. **No unscoped money procedure exists anywhere in the API**; the only listed procedures are the 3 portal ones scoped by external identity. Every F1.1 procedure outside the money namespaces proves its book. **Every shop procedure is classified** (unit/work-order scoped, shared public directory, or ownership-gated until F4), so a new one fails until classified. Every gated one calls the gate. **F1.2: every compliance procedure is classified** (subject scoped, book scoped, pure evaluator, or shared registry). Subject-scoped ones call `requireSubjectInScope`, book-scoped ones prove the book, and pure evaluators touch no table. **F1.3 governance:**
  - platform governance is read from procedure **meta** that only the wrappers set (a scan proves `_core/trpc.ts` is the only setter);
  - the set of platform-governed procedures, and of bootstrap-bearing ones, is pinned exactly;
  - the wrappers read authority through `platformAuthorityProven` (the users row), never `ctx.user.role`;
  - every live procedure **and every server source file** that writes `dispatchEnforcementSettings` is the decided platform-governed writer, so an equivalent bypass endpoint fails CI;
  - the requirement registry has exactly one writer in the server, which stamps the proposer's organization from server scope (never `NULL`), and it is read per organization. Every registry procedure takes its organization from `actingScopeFor` and none from input;
  - PLATFORM, ORGANIZATION (tenant-scoped), SCHEMA-BLOCKED and BOOTSTRAP are separate declared classes: platform-governed never overlaps tenant-scoped or schema-blocked, and bootstrap only exists inside platform-governed.

`procedureAuthorization.test.ts` also recognises the mixed builder as enforcing its declared permission. |

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
| **F1.3:** global dispatch setter trusts the session's admin claim | 3 |
| **F1.3:** unaffiliated ordinary user allowed the global mode after organizations exist | 9 |
| **F1.3:** platform admin still required to hold the organization-domain role | 7 |
| **F1.3:** a proposal's organization taken from the input | 5 |
| **F1.3:** registry read ignores the organization (every organization's revisions visible) | 2 |
| **F1.3:** verification ignores the revision's organization | 2 (plus `main`'s own test 17) |
| **F1.3:** another endpoint (`credentialRecord`) writes the registry | 2 |
| **F1.3:** bootstrap survives the first organization | 9 |
| **F1.3:** a proposal written as a shared (`NULL`-org) row | 9 |

The earlier F1.3 mutations were run against superseded rules (admin plus domain role; then a
platform-only registry), so these nine against the final model replace them. The three platform-only
registry mutations the checkpoint named (`requirementLoad` losing the admin check, a controller allowed,
a demoted admin still allowed) have no target after the owner's decision to keep C1b-2. Their
organization-model equivalents are the rows above, and the demotion case is covered on the dispatch side.

**Existing suites fixed, not weakened.**

- **F1:** 15 suites passed invented book ids.
- **F1.1:**
  - `insuranceRisk` invented book and **unit** ids; `compliancePassport` and `requirementEngine` invented book, operator and job ids. They now create real records.
  - `fleetShop`, `insuranceRisk`, `requirementEngine`, `auditPackage` and `workforce` exercise the single-ownership-domain deployment. Only the ownership predicate is mocked, with a comment pointing to the real-database proof above.
  - `dispatchEnforcement` and `fieldroute` are `main`'s versions since the merge (C1a's rule).
  - **F1.2:** `compliancePassport` invented an operator id. It now creates a real operator.
  - **F1.2:** `fieldroute` used "operator 1", and `purchasingAp` and `requirementEngine` used "evidence 1". On a fresh database those are whichever suite inserted first, and the F1.2 suite's are organization-owned. The gate failed 4 tests exactly that way (reproduced by running F1.2 first). Each suite now uses its own record.
  - `restrictedVaultApi` (from `main`) drew user ids from 960k–990k, which overlaps `recordsAuthorizationDb` and `assistantCommitService`. One fresh-database gate run collided on a role grant (`activeGrantKey` duplicate, 4 tests). It now has its own range (296M).
  - **F1.3:** `dispatchEnforcement`'s manager and `fieldroute`'s setup set the global mode, so each is now a real platform administrator (a users row with role `admin`), not a session claim. `fieldroute`'s admin holds **no** domain role, which proves platform authority alone suffices. It uses an explicit id from its own window (297M): the users auto-increment lands wherever explicit ids pushed it, and an auto-numbered admin collided with another suite's role grant. `dispatchEnforcement` reads the global mode as that administrator.
  - **Merge with `main` (C1b-2):** `compliancePassport` is `main`'s version with the F1.1/F1.2 real-book and real-operator fixtures re-applied. The permission-map pin is `main`'s 639.
  - **Merge with `main` (C1b-2):** `main`'s new `requirementRegistry.db` and `requirementVerification.db` suites passed invented operator ids to passports and invented books to work authorization. They now create real single-tenant operators and books (B's dispatcher reads a B-owned operator), and run as the single-ownership-domain deployment for their equipment requirements (only the predicate is mocked, as in `requirementEngine`).
  - **F1.3's own registry test** now proposes in a jurisdiction of its own (`CA-ZZ-…`). Its first version proposed unverified `CA-AB` requirements, which made later single-tenant `CA-AB` passports UNKNOWN in `compliancePassport`. The first full gate caught this.
  - **Red on `main` itself, fixed here to get a clean gate:** `testIdBands` (the four `dispatchRole*` suites shared base 880M, so each now has its own: 880M–883M) and `ai/workerBoundary` (its guard refused `.update(` anywhere, which caught `createHash("sha256").update(…)`, a hash rather than a table; hash updates are now excluded and every database-write shape is still refused). Both reproduce on `main` (`c626146`) alone.
  - `tenantScopeShop` expects the ownership refusal for its warranty call.
  - `requirementEngine` used a hard-coded job 1, which collided with whichever suite created the first job. It now uses its own job.
  - `portalFundingApi` advanced an opportunity in invented book 1 and claimed against expenses that did not exist. It now uses a real book and real expenses.
  - `operationalTruth` scanned "unit 1". On a fresh database that is whichever suite created the first unit, and the new suite's units are organization-owned. It now scans its own single-tenant unit.
  - The new suite keeps its refusal-only dates in the past, per the `calendarFixtures` rule.
- No assertion was loosened.

## 10. What F1 / F1.1 / F1.2 / F1.3 did not do (per instruction)

F1, F1.1, F1.2 and F1.3 add no migration, journals, financial-event engine, export batches, new inventory tables or
QuickBooks work, and make no procurement workflow change and no UI change. The PR is opened only after the complete gate passes, and is not merged. The P6.7
purchase-order decision is recorded in `docs/P6_6_P6_7_DECISION_BRIEF.md`. It is **not implemented**:
the current self-authorization within the requester's own limit contradicts that decision, but it is not
a cross-tenant vulnerability (both the request and its approval are now book-scoped). Its fix is
scheduled with F4.

## 11. Carried forward

| Item | Where |
|---|---|
| Compliance operator/unit/credential procedures (§7.3) | **Done in F1.2** |
| Global dispatch mode governance (C1a let any unaffiliated user change it after organizations exist) | **Decided and done in F1.3** (§7.4): platform configuration; bootstrap only at zero organizations, proven on an isolated database |
| Global compliance requirement registry governance | **Decided in F1.3** (§7.5): keep C1b-2's organization-scoped registry; F1.3 pins "no shared writes, no cross-organization reads". Platform-governed shared requirements, if ever wanted, are a future design. |
| Parts, stock, tires, tools, warranty ownership: migration, evidence backfill, scoping (§8) | F4, blocker |
| `insuranceRequirements` book column; program keys scoped per company | Next schema checkpoint (F2) |
| Equipment and branch owner model | Owner decision |
| `commercialApprovals` unique key to include the book; `invoices.accountingDate`; `decide()` inside the caller's transaction | F2 |
| P6.7 implementation (limit ∧ ladder, no self-approval) | F4 |
| New finance engines (events, journals, export, generalized inventory) | Frozen until the one-driver / one-job gate passes |
| Migration numbers | Taken from current `main` + open PRs when each migration PR is prepared. Never reserved early. |
| Merging current `main` | **Done** (`60f3899`). The dispatch conflict was resolved to `main`'s C1a code; F1.1's dispatch tests were adapted to it. |
