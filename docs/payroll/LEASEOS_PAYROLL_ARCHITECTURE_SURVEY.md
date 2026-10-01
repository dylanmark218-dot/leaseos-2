# LeaseOS Payroll & Compensation — Architecture Survey and Design Report

**Status:** survey and design only. No production code, migration, schema or test was changed to write it.
**Measured at:** `main` = `6f52b57` (2026-09-23), plus every remote branch fetched the same day.
**Re-measured:** 2026-10-01 against `main` = `b35bac4` (333 commits later). The addendum below records what moved;
section text that it supersedes is marked *(superseded, see addendum)*.
**Branch:** `claude/payroll-architecture-survey-g90up6` (this document only).
**Stops here by design:** nothing in §12 onward is built. §21 lists the owner decisions that gate coding.

Repository code is authoritative throughout. Where a checkpoint document and the code disagree, the code is cited
and the disagreement is recorded (§10).

## The finding that changes the premise

LeaseOS already has a payroll subsystem. Migration `0022_payroll_finance_tax.sql` (B20.5) created 22 tables,
including versioned pay rates, pay periods, payroll time entries, three-clock reconciliation, evidence-backed
earning events, pay runs and lines, adjustments, disputes and a separate contractor-settlement ledger.
`server/payrollRouter.ts` exposes 40 role-gated procedures (22 `payroll`, 3 `contractors`, 15 `finance`),
`server/_core/payrollEngine.ts` holds the pure rules (rate in force on the day worked, HOS ≠ payroll ≠ billing,
paid runs corrected by adjustment, contractors refused from employee payroll), and `server/_core/entityScope.ts`
fences money by financial entity (0146). The brief's architectural rules are already stated in those files'
header comments.

What is missing is the layer above the tables: compensation agreements (effective-dated rule sets rather than a
single rate key), a per-tenant earning-code catalogue, pay schedules, an approval workflow for time and expenses,
pay statements, exceptions, an append-only payroll audit, an export boundary, and any UI. Several existing
procedures are also incomplete or unsafe (§10). The design in §11 onward therefore **extends and repairs**
the existing context rather than creating a second one.

Two external constraints shape everything:

1. **The SPINE moratorium.** `docs/register/SPINE_WIRING_PLAN.md:3`: "no new engines until this path is wired";
   permitted work is "a deletion, a resolver, or a router over something already written". The finance survey on
   `claude/finance-accounting-survey-2mp4h6` records an owner decision that the new-engine freeze stands for
   financial-event, journal and export work. Most of §12 is new tables and needs an owner ruling (D1).
2. **Migration numbering is contested.** At the survey, `main` ended at 0174 and the first slot free everywhere was
   0182. At re-measurement (addendum) `main` ends at 0219, 0182 is claimed by PR #99, and the first slot free
   everywhere is **0220** (§17), allocated only at PR time.

## Addendum — re-measured 2026-10-01 (`main` = `b35bac4`)

Between the survey and this re-measurement, `main` took 333 commits and the migration head moved from 0174 to
**`0219_job_commercial_context.sql`**. What changed for this design:

**Merged, and now the convention payroll must follow**

| Change | Where | Effect on this design |
|---|---|---|
| Finance F1 tenant isolation merged (PR #56) | `moneyScoped(roleProcedure())` in `server/_core/trpc.ts:322`; `financeScopeFor`, `ownsEntity`, `requireOwnedEntity`, `ownedEntityWhere`, `bookOrgWhere`, `assertCallerOwnsEntity` in `server/_core/entityScope.ts`; `server/financeScope.ts`; `server/financeScopeCoverage.test.ts`; `server/tenantScopeFinance.db.test.ts` | New payroll routers use `moneyScoped(...)` and read `ctx.money` (a `FinanceScope` with `entityIds`). The coverage test reads the live router: any procedure whose input carries `financialEntityId`, `expenseRef`, `adjustmentRef` or another money key must be money-scoped or call one of the `SELF_SCOPED` helpers, or the suite fails. D2 is therefore settled by the repository (see §21). |
| Strict acting-scope resolver | `resolveActingScopeStrict`, `RevivedFallbackRefused`, `MembershipRevoked` (`server/_core/actingScope.ts:191-242`) | Money scope now refuses a caller whose membership ended rather than falling back to the single tenant. Payroll inherits this through `financeScopeFor`. |
| Organization-scoped role grants merged (PR #64, renumbered to `0207`/`0208`) | `RoleScopeType = global / organization / branch / unscoped_legacy`, `grantsInOrganization()` in `recordsAuthorization.ts`; `roleProcedure` resolves the organization and passes it to `authorize()` (`trpc.ts:95-139`) | Risk 3 in §19 is reduced: a `payroll_admin` grant is now issued by one organization and reaches only it. Legacy grants are `unscoped_legacy` and fail closed where an organization is required. |
| `periodRouter` scoped | `moneyScoped` + `requireOwnedEntity` (`server/periodRouter.ts:13-21`) | **G3 is fixed on main.** |
| Expense procedures scoped | `finance.expenseCreate/expenseSetTreatment/expenseDuplicates` prove the book (`payrollRouter.ts`, F1 and F1.1 comments) | **G2 is fixed on main.** |
| Approval ladder reads only live roles | `isNull(userRoleAssignments.revokedAt)` (`commercialApprovalService.ts:40`) | **G6 is fixed on main.** D4 (reuse the ladder) is stronger for it. |
| Document Control A–C merged | `0178_document_control_definitions.sql`, `0195_document_control_register.sql`, `0196_document_control_numbering.sql` (`numberAllocations`, `numberBlocks` on `trackingSequences`) | A pay-statement number uses the per-business, ledgered counter that now exists on main rather than the bare allocator described in §6. |
| Customer contracts and rate sheets (PR #98, `0217`–`0219`) | `customerContracts`, `rateSheets`, `rateSheetVersions` | Customer charge rates are now versioned per contract. They carry no pay rate. The "no shared rate" rule in §11 stands and gains a precedent for effective-dated versions. |
| Pinned counts | `OPERATIONAL_PROCEDURE_PERMISSIONS` length is now **723** (`procedureAuthorization.test.ts:178`); `serverPaths.size` is now **793** (`crossLayerIntegrity.test.ts:39`) | §15 and T18 cite the new numbers. |
| Release | `LEASEOS_RELEASE` = `v23.31` | — |

**Still true on `main`**

- `payroll.myStatements` is still unfiltered (G1), `payroll.rateCreate` is still unscoped by design (G4), run approval
  still has no creator ≠ approver check (G5), a run still cannot leave `draft` and `export` is still a stub (G7). The
  only change to `payrollRouter.ts` since the survey is the F1 expense scoping.
- `dutyRecords` still has no tenant column; HOS isolation (PR #71) was done in code, through the operator's owner.
- The SPINE moratorium stands unchanged (`docs/register/SPINE_WIRING_PLAN.md:3`; restated in
  `docs/register/SECRETARY_SPINE_MORATORIUM.md`). The finance F0 owner decisions on `main` are unchanged: the
  new-engine freeze stands for financial-event, journal and export work. **D1 remains the gating decision.**
- `LEASEOS_CURRENT_STATE.md:1027` still records that organization-wide isolation is not yet a property of the system.
- No payroll design, table or router other than this document exists on `main` or on any open branch
  (`git grep -il payroll` over `docs/` finds only finance, document-control, live-assist and knowledge documents that
  mention it in passing).

**Open branches that matter to payroll (2026-10-01)**

| Branch / PR | State | Relevance |
|---|---|---|
| `claude/driver-portfolio-credential-wallet-ya8928` (PR #16) | open; now holds `0210`–`0212` | the credential wallet; still not a money wallet |
| `claude/training-academy-workforce-q3mdse` (no PR) | open; now `0187`–`0188` | the second (training) wallet, unreconciled |
| `claude/finance-accounting-survey-2mp4h6` (PR #61) | open; F1 already merged via #56, PR #61 carries follow-up hardening (`platformBootstrap`, census, coverage test) | may change `financeScopeCoverage.test.ts` again before payroll lands |
| `claude/safety-compliance-program-builder-2qnty0` (PR #99) | open; **claims `0182`** | the number this report provisionally named is taken |
| `claude/leaseos-sign-attest-design-5993ar` (no PR) | open; `0214`–`0216` "sign and attest" foundation | a generic signature/attestation model; the worker-signs-hours question (G12) should be checked against it before P3 |
| `claude/leaseos-communications-marketplace-p8ptqw` (PR #59) | open; `0205`–`0206` | board membership and open work offers; adjacent to shift/open-work, not to pay |

**Migration numbering, re-run (register scan over every remote branch, 2026-10-01)**

`main` holds every number up to `0219` except the historical gaps and the slots still held only by branches
(`0172`, `0173`, `0176`, `0177`, `0180`–`0184`, `0186`–`0188`, `0190`, `0197`, `0199`–`0201`, `0204`–`0206`,
`0210`–`0216`). Open branches claim `0170`, `0172`, `0173`, `0175`–`0188`, `0197`, `0199`–`0201`, `0205`, `0206`
and `0210`–`0216`; `0182` is claimed three times (document-control intake, integration hub, PR #99) and `0214` twice.
Nothing claims `0220` or above. **The first slot free on `main` and on every open branch is now `0220`.** The
register on `main` says "next free `0210`" and is itself stale; the collision register must be refreshed in the same
PR that takes a payroll number. §17's provisional table is re-based to `0220`–`0229` below.

---

## 1. Existing LeaseOS components that can be reused

| Need | Existing component | Reuse |
|---|---|---|
| Permission gate, audit of every decision | `roleProcedure` (`server/_core/trpc.ts:71-136`), `OPERATIONAL_PROCEDURE_PERMISSIONS`, `GRANTS`, `DENIALS`, `SENSITIVE_PERMISSIONS` (`server/_core/recordsAuthorization.ts`) | as is; new procedure names mapped, new permissions added to the union |
| Money tenant fence | `financialEntities.orgRef` (0146) + `entityScope.ts` (`entityIdsInScope`, `assertEntityInScope`, `assertProfileInScope`, `assertRunInScope`, …); `moneyScope()` in `payrollRouter.ts:53-58` | as is; one `assert*InScope` per new record type |
| Operational id proof | `jobInScope`, `tripInScope`, `unitInScope`, `operatorInScope`, `evidenceInScope`, `fieldTicketInScope` (`server/db.ts:800-1012`); `coreRecordOwnership` (0113) | for every evidence pointer payroll accepts |
| Acting organization | `resolveActingScope` (`server/_core/actingScope.ts:65-103`), `SINGLE_TENANT_ID = "default"` | never from input |
| Payroll identity | `employeePayrollProfiles` (`userId`, `operatorId`, `financialEntityId`) and `resolveOwnPayrollProfile` (`payrollService.ts:45-72`) | the profile is the employee record for payroll |
| Versioned rates | `payRates` + `createPayRateVersion` (`payrollService.ts:123-174`), `rateInForce` (`payrollEngine.ts:47-62`) | pattern for agreement versions |
| Evidence-cited earnings | `payrollEarningEvents` + `payrollEarningEvidence`, `calculateEarning` (`payrollEngine.ts:106-192`) blocks with no evidence, wrong unit, weak measurement authority | as is; gains earning code + agreement version |
| Clock separation | `payrollTimeReconciliations`, `reconcileClocks` (`payrollEngine.ts:207-276`), `payrollActivityAffectsHos(): false` | as is |
| Run lifecycle | `PAY_RUN_TRANSITIONS`, `canTransitionPayRun`, `correctionRouteFor` (`payrollEngine.ts:280-311`) | extended with the brief's state names |
| Employee/contractor boundary | `assertPayrollEligibility` / `assertSettlementEligibility` (`payrollEngine.ts:331-357`); `contractorSettlements`, `contractorPayables` (0116) | unchanged |
| Expense record | `expenseRecords`, `expenseAllocations`, `expenseCategories` (0022); `assessExpense`, `buildAllocations`, `findDuplicateCandidates` (`_core/expenseTreatment.ts`) | gains reimbursement state |
| Receipt capture → typed record | `assistantProposals` → `planAssistantCommit` (`expense_draft_create`, `fuel_transaction_create`) → `executeAssistantCommit` → `assistantCommitReceipts` (UNIQUE `proposalId`), `documentFingerprints`, `merchantMemory` | the scan-to-draft path; nothing here approves |
| Document store | `evidenceRecords` (`storageKey`, `clientCaptureRef` UNIQUE, `sealState`, `legalHold`), `evidenceRelationships` (`entityType` includes `expenseRecord`, `user`, `financialEntity`), `evidenceSeals`, `evidenceVersions` (0019) | receipts and rendered statements |
| Generated documents | `renderPdf`/`sha256Hex` (`_core/ticketPdf.ts`), `storagePut` (no URL), `fieldTicketDocuments` with `contentHash` + `sourceSnapshotHash` (`invoicingRouter.ts:58-77` pattern), `commercialDocuments` registry (0144) | pay statement PDF |
| Numbering | `nextTrackingNumber` (`_core/trackingNumbers.ts:60`) over `trackingSequences` (row-locked `LAST_INSERT_ID`), `commercialNumberingPolicies`, `CANONICAL_PREFIXES` coverage test | statement numbers (`PAY`) |
| Restricted access | `restrictedAccessGrants` / `restrictedAccessEvents`, `serveRestricted` (0156; log-before-serve, fail-closed) | pattern for payroll-sensitive documents |
| Approval ladder | `commercialApprovalPolicies`, `commercialApprovals`, `commercialApprovalSignatures`, `decide()` (`_core/commercialApprovalService.ts:24`), `mayApprove` (preparer blocked, no double signing) | candidate for run approval (D4) |
| Separation-of-duties precedents | `timeOffRouter.ts:119` (no self-approval), `_core/workforce.ts:55-71` (recorder ≠ verifier), `limitPromoteSeparationOfDuties.db.test.ts` | the test shape |
| Append-only history | `dispatchRoleAssignmentEvents` (0171), driver-portfolio `SIGNAL` triggers (0176, unmerged), `manifests_seal_guard` (0130) | payroll audit and finalized-run guard |
| Period close | `periodCloses`, `assertPeriodOpen` (`periodCloseService.ts:21-26`) | export posting date (D6) |
| Offline capture | client `Outbox` (`client/src/runtime/outbox.ts`), `syncPackages` / `syncPackageItems` / `deviceSyncNonces`, `evidence.upload` idempotent on `clientCaptureRef`, `captureAuthorizationClaim` never upgraded by sync (0079) | time and expense capture |
| Background work | `domainEventOutbox` + `emitDomainEvent` (`_core/eventEmitter.ts:115`), drain worker with `SKIP LOCKED` lease (`_core/workflowRuntime.ts:362-466`) | export delivery, later |
| Integration gateway | `integrationClients.kind` includes `accounting`; `webhookSubscriptions`/`webhookDeliveries` signed HMAC, per-org (0054/0111) | outbound export delivery, later |
| Surfaces and widgets | `deriveExceptions` (`_core/exceptionCentre.ts:105`) with `requiredPermission` per item; `widgetRegistry.ts` (permission derived from the named procedure); `widgetReaderFor` (`widgetSources.ts`) | payroll exceptions and tiles |
| Client shell | `PortalShell.tsx` portals (`worker_self_service`, `hr_workforce`, `finance_billing`, `management`), `panelContract.ts` procedure whitelist, `QuickCapture` `receipt` capture (`portal/viewModels.ts:146`) | UI mount points |

## 2. Exact files and modules discovered

**Payroll (on `main`)**
- `drizzle/0022_payroll_finance_tax.sql` (421 lines, 22 tables); shadows in `0062_money_shadows_everywhere.sql:147-183`; scope in `0146_financial_entity_scope.sql`
- `drizzle/schema.ts:3131-3490` (`financialEntities` … `personalTaxDocuments`)
- `server/payrollRouter.ts` (903 lines: `payrollRouter`, `contractorRouter`, `financeRouter`)
- `server/payrollService.ts` (712 lines; data access, no repository layer)
- `server/_core/payrollEngine.ts` (394), `_core/expenseTreatment.ts` (312), `_core/taxRuleEngine.ts` (337), `_core/entityScope.ts` (71)
- `server/_core/recordsAuthorization.ts:26-43` (roles), `:83-99, 152-154, 295` (payroll permissions), `:1420-1436` (payroll_admin), `:1471-1548` (controller), `:1702-1735` (DENIALS), `:1737-1923` (sensitive), `:2394-2447` (procedure map)
- `server/payrollApiAuthorization.test.ts` (443 lines, 30 cases), `server/tenantScopeMoney.db.test.ts` (3 cases), `server/procedureAuthorization.test.ts:171` (zero bare `protectedProcedure` in payroll)
- `server/closeoutRouter.ts:363-377` (`closeout.adjustmentPayrollPropose`: a client tip/bonus becomes a `payrollAdjustments` request)
- `server/routers.ts:18-22, 340-343` (mounting)
- Docs: `LEASEOS_B20_5_PAYROLL_FINANCE_TAX.md`, `LEASEOS_B20_7_PAYROLL_FINANCE_API.md`, `LEASEOS_B22_3_MONEY_PRECISION.md`

**Adjacent (on `main`)**: `server/workforceRouter.ts` + `_core/workforce.ts` (hire → offboard; `finalPayProposedAt` is a boolean stamp), `server/timeOffRouter.ts` + `_core/timeOff.ts`, `server/openShiftsRouter.ts`, `server/crewRouter.ts`, `server/contractorOperationsRouter.ts` (0115/0116), `server/hosRouter.ts` + `_core/hos.ts` (`computeClocks`), `server/dispatchRoleService.ts` + `_core/dispatchTransaction.ts` (award writes `resourceBookings`), `server/closeoutRouter.ts` + `_core/siteCloseout.ts` (`EVENT_CLOCK` has a `payroll` clock no event maps to), `server/shopRouter.ts` (`workOrders.laborMinutes`), `server/periodRouter.ts` + `periodCloseService.ts`, `server/commercialOfficeRouter.ts:493-541` (GL mapping, `exportReadiness` always `exported:false`), `server/_core/commercialApprovalService.ts`, `server/_core/attachmentAuthorization.ts:45` (`NEVER_ATTACHABLE = ["payrollDocument","employeeRecord","clientContract"]`), `server/_core/auditPackage.ts:20` (redaction policies already withhold payroll items), `scripts/apply-migrations.sh`, `scripts/migrate.ts` + `_core/migrationLedger.ts`, `scripts/ci-gate.sh`, `docs/architecture/MIGRATION_COLLISION_REGISTER.md`

**On unmerged branches (relevant, not on `main`)**
- `claude/finance-accounting-survey-2mp4h6`: `docs/finance/LEASEOS_FINANCE_F0_DESIGN.md` (finance bounded context: source documents → financial events → journal → connectors; G1–G19 findings; owner decisions incl. the new-engine freeze), `LEASEOS_FINANCE_F1_TENANT_ISOLATION.md`, `server/financeScope.ts`, `moneyScoped(roleProcedure())` in `_core/trpc.ts`, and scope fixes to `finance.expenseCreate/expenseSetTreatment/expenseDuplicates` in `payrollRouter.ts`. No PR open.
- `claude/driver-portfolio-credential-wallet-ya8928` (PR #16) and `claude/driver-portfolio-api-ya8928`: 0175–0177, `driverPortfolioRouter.ts`, `shared/driverWallet.ts`. **The "Driver Wallet" is a credential wallet** (tickets, licence class, equipment authorizations over `complianceDocuments`), not a money wallet; receipt capture is named as "the checkpoint after the wallet UI".
- `claude/training-academy-workforce-q3mdse`: 0172–0175, a second (training) wallet over `workerQualifications`; the portfolio branch flags that the two must be reconciled.
- `claude/leaseos-auth-workspace-system-t008ad`: `0170_organization_scoped_role_grants.sql` (roles gain an organization), `LEASEOS_MIGRATION_POLICY.md`, `_core/migrationSlots.ts` (slot guard), workspace chooser UI.
- `claude/document-control-architecture-jlffzk`: 0178–0181 (document control: definitions, register, per-business numbering with `numberAllocations` and offline `numberBlocks`, templates).
- `claude/work-calendar-task-engine-0mtjyk`: `0170_work_calendar_tasks_reminders.sql`, `workRouter.ts`.

## 3. Existing database tables relevant to payroll

All PKs are `int AUTO_INCREMENT`; money on 0022 tables is a grandfathered `double` with an `…Cents`/`…Millis`
shadow filled by 0062 triggers; no foreign keys anywhere in the schema.

| Table (schema.ts) | Purpose | Scope column | Status enum | Notes for the design |
|---|---|---|---|---|
| `financialEntities` (3131) | the book; money tenant | `orgRef` (0146; NULL = single tenant) | active/dormant/closed | root of every payroll row |
| `payGroups` (3259) | grouping | `financialEntityId` NULL | – | unused by any procedure |
| `employeePayrollProfiles` (3268) | payroll identity | `financialEntityId` | `payrollStatus` active/leave/terminated/suspended | `employmentType` full_time/part_time/casual/seasonal; `defaultPayMethod` 8 values; `userId`/`operatorId` nullable; no classification column |
| `payRates` (3283) | versioned rate | via profile/payGroup (both nullable) | – | `earningType` free text; `rateMillis` shadow; `supersedesRateId` |
| `payPeriods` (3303) | period | `financialEntityId` | 8-value shared enum | `lockedAt` never written |
| `payrollTimeEntries` (3315) | payroll time | via profile | open/submitted/verified/disputed/approved/void | `source` 6 values incl. `time_clock`, `gps_proposed`, `dispatch_schedule`, `field_ticket`; `supersededByEntryId`; no approver, no `sourceRecordRef`, no offline ref |
| `payrollTimeReconciliations` (3333) | three clocks | via profile | match/within_tolerance/review/unresolved | – |
| `payrollEarningEvents` (3349) | pay item | via profile + period | pending/verified/approved/held/paid/void | `source` 7 values; `sourceRecordRef`; `rateKeyVersion`; `blockedReason`; no approver, no run link |
| `payrollEarningEvidence` (3371) | evidence links | – | – | `evidenceRecordId` or `evidenceRef` |
| `payRuns` (3380) | run | `financialEntityId` | same 8-value enum | `approvedByUserId/At`, `lockedAt`, `paidAt`; no finalize/void/snapshot |
| `payRunLines` (3393) | run lines | via run | – | `lineType` earning/deduction/reimbursement/employer_cost; `taxRuleId`, `ruleStatus` (default `unverified`); **no writer on main** |
| `payrollAdjustments` (3410) | corrections | via profile | requested/approved/declined/applied | `originalPayRunId`, `appliedPayRunId`; no kind, no evidence, no affected period |
| `payrollDisputes` (3427) | employee statement | via profile/period | open/information_requested/approved/declined/withdrawn | – |
| `contractorSettlements` / `Lines` (3444/3465) | contractor ledger | `payingEntityId` | draft/review/approved/paid/closed | separate by design |
| `contractorPayables` / `Events` (7894/7917) | private settlement chain (0116) | `payerOrgRef`/`payeeOrgRef` | prepared…void | cents, snapshots, append-only events |
| `expenseRecords` (3200) | receipt/expense | `financialEntityId` | draft/submitted/review/approved/rejected/posted | `paidPersonally`, `reimbursementRequired` (flags only), `evidenceRecordId`, `jobId`/`unitId`/`operatorId`; no submitter/approver columns |
| `expenseAllocations` (3245), `expenseCategories` (3190) | splits, categories | – | – | – |
| `fuelTransactions` (3825) | fuel domain record | `financialEntityId` | draft/needs_review/confirmed/reconciled/rejected | `financialTreatment` incl. `employee_reimbursement_pending`; `reimbursementStatus` not_applicable/pending/paid/denied; `reimbursedAmountCents`; cents only (0064) |
| `personalTaxDocuments` (3480) | employee-owned tax docs | `ownerUserId` | – | employer never sees unless shared |
| `taxRules`, `taxRuleSources`, `taxRegistrations` | sourced, dated rules | – | unverified by default | no CPP/EI/T4/ROE logic anywhere; every determination UNKNOWN (P9) |
| `periodCloses` (4616) | accounting month state | `financialEntityId` | soft_close/close/reopen actions | "Payroll keeps its own lock" (0042:8-9) |
| `commercialGlAccounts` / `commercialGlMappings` (8463/8474) | GL mapping | `bookOrgRef` | – | `mappingKind` has no payroll kind |
| `bankStatementLines` (4704) | bank feed | via account | – | `matchedType` has no payroll kind |
| `clientAdjustments` (4998) | customer tips/bonuses | via ticket | authorized/withdrawn | `payrollTreatment` not_applicable/awaiting_recipient/proposed/decided → `payrollAdjustments` |
| `organizationWorkers` (7869) | operational worker record (0115) | `orgRef` NOT NULL | active/inactive/ended | `workerType` 14 values, `compensationType` 8 values (informational) |
| `organizationMemberships` (6873) | tenant membership (0086) | `orgRef` | active/suspended/ended | `membershipType` employee/contractor/client/system |
| `leaveRequests` (6936) | time off | `tenantId` | requested/approved/declined/cancelled/recorded | `decidedByUserId/At`; no payroll link |
| `shiftPosts`, `shiftInterests`, `crews`, `crewMembers` | scheduling | `tenantId` | – | scheduled times only |
| `authorizationDecisions` (3104) | every gate decision | – | allowed/denied_* | no before/after |
| `commercialApprovals` / `Signatures` / `Policies` | generic money approval ladder | `bookOrgRef` | awaiting/satisfied/refused/review | reusable (D4) |
| `evidenceRecords`, `evidenceRelationships`, `fieldTicketDocuments`, `commercialDocuments` | documents | mixed | – | §6 |
| `trackingSequences` (934) | number allocator | none (type-suffix per book) | – | §6 |
| `syncPackages`, `syncPackageItems`, `deviceSyncNonces`, `fieldDevices` | offline sync | `fieldDevices.orgRef` | queued…office_accepted/rejected | §9 |
| `domainEventOutbox` (2316) | transactional outbox | `tenantId` varchar | lease/retry/dead-letter | §9 |

## 4. Existing employee / driver identity model

There is no `employees`, `drivers`, `workers` or `staff` table. A person is `users` (login; `role` user/admin only)
linked to:

- `organizationMemberships.userId` → the tenant (`orgRef`), `membershipType`, `branchId` (string; no branch table), `effectiveFrom/To`.
- `operators.userId` → the driver/operator record dispatch reads (licence, class, expiry, free-text `company`). Created on hire (`workforceRouter.ts:88`). Owned through `coreRecordOwnership` (recordType `operator`).
- `userRoleAssignments.userId` → domain roles (15 values incl. `payroll_admin`, `controller`); `scopeType` global/branch, **no organization dimension** (the auth-workspace branch adds it).
- `organizationWorkers.userId`/`operatorId` → `workerType` and `compensationType` inside an org (0115; written by contractor operations).
- `employeePayrollProfiles.userId`/`operatorId` → payroll; scoped by `financialEntities.orgRef`; `employeeNumber` unique across the system.
- `applicants` → `onboardingPlans` → `competencySignoffs` → `probationReviews` → `offboardings` (0056; per `userId`, scoped through membership). `offboardingClose()` refuses until "final pay proposed", which is a timestamp, not a payroll write.
- `complianceDocuments` (owner `operator` or `user`) → credentials; `workerQualifications` (`tenantId`) → held qualifications.

`resolveOwnPayrollProfile(userId)` (`payrollService.ts:45`) tries `employeePayrollProfiles.userId`, then the
operator linked to the user. `ownProfileOrThrow` (`payrollRouter.ts:67`) then proves the profile's entity is in
scope and answers NOT_FOUND otherwise. **Employment classification** exists in five places
(`organizationMemberships.membershipType`, `organizationWorkers.workerType`, `contractorBusinessProfiles.operatingMode`,
`commercialJobChains.relationshipType`, `financialEntities.taxpayerType`) plus the pure `WorkerKind`
(`employee | contractor`) that `payroll.profileUpsert` takes **as input** rather than reading from a stored field.

## 5. Existing job / load / HOS / billing relationships

- **Dispatch** carries no worked time. `dispatchPostings` has `scheduledStart` + `estimatedDurationMinutes`;
  `dispatchRoles` (the slot: `assignedOperatorId/UnitId/TrailerId`, status open→assigned) has no time columns;
  the award writes `resourceBookings` (`startsAt`/`endsAt` supplied by the caller) and `dispatchRoleAssignmentEvents`.
  Production code never moves a posting past `staffed`. `dispatchPostings.postedRateCents` is a bid rate visible to
  bidders, not a wage; `dispatchBids.bidAmountCents` is a contractor bid.
- **Jobs / trips / loads.** `jobs.orgRef` (0132), `jobs.driver`/`vehicle` free text; `trips` (`orgRef`, `operatorId`,
  `unitId`, `startedAt`/`completedAt`, odometers) and `tripStops` (arrive/setup/operation/depart timestamps) are
  edited in place; `loads` (`jobId` NOT NULL, `operatorId`, `unitId`, `chainState` created…billed) are owned through
  `coreRecordOwnership`. `jobUnits` (legacy) has `joinedAt`, `departedAt`, `hours`, `mileage`, create-only.
- **Disposal / manifests.** `disposalTickets` (scale kg; `verificationStatus`, only `verified` bills);
  `manifests` sealed with a DB trigger (0130) and amended by hash chain; `manifestCustodyEvents` record
  `accepted_by_facility`.
- **HOS.** `dutyRecords` (`operatorId`, `dutyStatus` driving/on_duty/sleeper_berth/off_duty, `startedAt/endedAt`,
  `durationMinutes`; no tenant, no certification flag, written by drivers, amended by dispatch/HR/management, fed
  by the ELD integration); `dailyLogs.totalOnDutyMinutes` exists but has no reader or writer;
  `hosAttestations` (0155) supersede rather than edit; `computeClocks()` returns a rolling-24h
  `dailyOnDutyMinutes`, nothing persists it. `payrollTimeReconciliations.hosOnDutyMinutes` expects that figure.
- **Field paperwork.** `fieldTickets` (`operatorId`, `unitId`, `startedAt/completedAt`, `signatureStatus`),
  `fieldTicketLines` (`lineKind` incl. `personnel`, `standby`, `mileage`; facts, no money), `fieldTicketEvents`
  (`clock` enum duty/**payroll**/job/customer_billing/…; `EVENT_CLOCK` maps no event to `payroll`), frozen
  `fieldTicketRevisions` (`snapshotJson`/`snapshotHash`), `fieldTicketSignatures` (customer signs; driver only
  witnesses; device attestation 0157). **No worker signs their hours anywhere.**
- **Work orders.** `workOrders.laborMinutes` is one `double` total per work order, `technician` is free text,
  edited in place; `workOrderReleases` name a `technicianUserId` but no hours; labour cost takes the rate as a query
  input (`shopRouter.ts:418`).
- **Training.** `academyAssignments`, `academyModuleCompletions`, `academyAssessmentAttempts`,
  `academyDirectSupervisionRecords` (`traineeUserId`, `supervisorUserId`, `jobId`, `startsAt/endsAt`, attested)
  carry start/complete timestamps but no attendance minutes.
- **Billing.** Customer charge rates are `billingRateCards` (legacy, in place) and versioned
  `customerRateCards`/`Lines` (`rateCents`); `pricingDecisions` (`rateKind` sell/vendor_payable) are the
  immutable-by-convention decision record; invoices freeze into `billingSnapshots` (`payloadHash`) and are
  corrected by `billingAdjustments` (`signedCents`) or voided with the snapshot kept. **No rate card, load, trip or
  ticket line carries a driver pay rate.** The only pay-adjacent columns outside payroll are
  `dispatchPostings.postedRateCents`, `privateRateSchedules.rateCents` (contractor org-to-org),
  `contractorPayables.rateCentsSnapshot`, and the portal's `agreedHourlyRateCents` used for tip maths.
- **Existing bridge into payroll.** `closeout.adjustmentPayrollPropose` turns a customer tip/bonus into a
  `payrollAdjustments` request (writes the `double`; the trigger fills cents). `payrollEarningEvents.source` already
  names `trip`, `load`, `field_ticket`, `work_order`, `safety_meeting`.

## 6. Existing expense / receipt / document infrastructure

- **Receipt → record.** Field capture (`CaptureKind` `fuel_receipt`, `expense_receipt`) → `evidence.upload`
  (idempotent on `clientCaptureRef`) → assistant extraction (`documentExtractions`, `assistantQuestions` with
  `sensitive_human_only`) → `assistantProposals` → `planAssistantCommit` (`expense_draft_create` requires
  `tax.expense.create`; amounts must be exact; `status` forced to `draft`; `financialEntityId` resolved server-side)
  → `executeAssistantCommit` (one transaction: lock, re-authorize, fingerprint duplicate gate with a *recorded*
  override, insert `expenseRecords` or `fuelTransactions`, `evidenceRelationships`, `assistantCommitReceipts`).
  Manual entry is `finance.expenseCreate` (status `submitted`, `reimbursementRequired = paidPersonally`).
  **Nothing here creates a reimbursement**; "reimbursement" is two flags on `expenseRecords`, a treatment enum on
  `fuelTransactions`, and a `lineType` on `payRunLines`/`contractorSettlementLines`.
- **No expense API outside payroll.** `expenseRecords` is read and written only from `payrollService.ts` and the
  assistant commit path; `expenseRecords` has no submitter or approver columns; `finance.expensesList` is
  entity-scoped but `expenseCreate`/`expenseSetTreatment`/`expenseDuplicates` are **not scoped on `main`** (fixed
  on the unmerged finance branch).
- **Documents.** `evidenceRecords` is the store (`storageKey`, never a URL; `sealState`; `legalHold`;
  `trackingNumber` unique); `evidenceRelationships.entityType` enum links records (has `expenseRecord`, `user`,
  `financialEntity`, `fuelTransaction`; no payroll kinds); access events are best-effort
  (`recordsService.ts:366-391` swallows errors), whereas the restricted vault logs before serving and fails closed.
  Rendered PDFs: `renderPdf` → `storagePut("<kind>/<no>/<hash12>.pdf")` → `fieldTicketDocuments` (`contentHash`,
  `sourceSnapshotHash`), idempotent per document ref; optional registration in `commercialDocuments` (`DOC` number,
  version chain, exactly one byte pointer). `NEVER_ATTACHABLE` already names `payrollDocument`.
- **Numbering.** `nextTrackingNumber(db, {sequenceType, branch?, format?})` self-seeds `trackingSequences` and
  allocates under a row lock; format `FT-2026-000042`; per-book counters use a `${type}@${hash8(bookOrgRef)}`
  suffix (`commercialOfficeRouter.ts:33,109`); `commercialNumberingPolicies` hold per-business formats;
  `trackingNumberCoverage.test.ts:22` pins `CANONICAL_PREFIXES` and refuses ad-hoc `ref()` for them. The
  document-control branch (0180) adds `numberAllocations` and offline `numberBlocks` on the same counter.

## 7. Existing tenant-isolation conventions

- **The tenant is `orgRef`** (`organizations.orgRef`), derived only from `organizationMemberships` by
  `resolveActingScope` (`actingScope.ts:65-103`): one active membership → that org; none → `"default"`
  (`single_tenant_fallback`); two → `AmbiguousOrganization` refused. `createContext` puts no tenant on `ctx`.
- **Four column conventions:** `orgRef` (40 tables; NULL = historical single tenant, 0132 rule), `tenantId
  varchar(40)` (19 tables, pinned by `tenantIsolation.test.ts:34-63`), `bookOrgRef` (commercial office),
  `financialEntityId` (41 uses; the money boundary, 0146). Catalogue tables invert NULL to mean "shared"
  (`dispatchRoleTypes`, 0170) and use a generated collision key.
- **Fail-closed shape:** a row outside scope is `NOT_FOUND` with the same message as a missing row
  ("never 'forbidden', which would confirm it exists", `entityScope.ts:8`); `entityIdsInScope` empty means the
  caller sees no money; `entityOwnerFor` gives a new entity the acting org (or none under the default scope);
  `userInScope` requires an active membership in the org (or none anywhere under default); `coreRecordOwnership`
  refuses reassignment (`RECORD_OWNED_BY_ANOTHER_ORGANIZATION`); `tenantIsolation.test.ts:83-97` forbids a
  `tenantId` literal outside `actingScope.ts`; the integration gateway never takes `orgRef` from a payload.
- **What is not yet isolated** (recorded in `LEASEOS_CURRENT_STATE.md:1001` and the finance F1 doc): role grants
  have no org; 72 money procedures in 10 routers were unscoped until F1 (unmerged); `periodRouter` still takes
  `financialEntityId` from input; `shifts.eligibility` and `crews.addMember` accept any `userId`.

## 8. Existing authorization conventions

- **One gate.** `roleProcedure("<ns>.<name>")` resolves the permission at wiring time (an unmapped name throws),
  loads active grants, calls `authorize()` (deny beats grant; branch-confined grants need a resolved branch;
  universals after the deny sweep), writes an `authorizationDecisions` row for every allow and deny, and refuses
  a *sensitive* action whose audit row could not be written. `externalProcedure` (portal) and
  `integrationProcedure` (machine) are built the same way. CI gate 5 and `procedureAuthorization.test.ts` hold bare
  `protectedProcedure` at zero and pin the mapped-procedure count (634) and server path count (696).
- **Vocabulary.** Dotted permission strings; procedure names map one-to-one to a permission in
  `OPERATIONAL_PROCEDURE_PERMISSIONS`. Payroll today: `payroll.read`, `.read_own`, `.read_employee`, `.read_all`,
  `.review`, `.approve`, `.run`, `.adjust`, `.rate.read`, `.rate.write`, `.export`, `.bank.read`,
  `.tax_identifier.read`, `.time.submit_own`, `.dispute.raise_own`, `.profile.write`,
  `closeout.adjustment.payroll_propose`; finance: `tax.expense.create/review`, `finance.entity.write`,
  `contractor.read/write/approve`, `period.read/close/reopen`.
- **Holders.** `payroll_admin`: read_own/employee/all, review, run, adjust, rate.read, export, profile.write,
  contractor.read — and is **denied** `payroll.approve`. `controller`: read_all, approve, rate.read,
  rate.write, finance.entity.write, contractor.approve, period.close/reopen — and never `payroll.run`. `hr`:
  read, read_own, read_employee, review, profile.write. `driver`/`mechanic`/`shop_lead`: read_own, time.submit_own,
  dispute.raise_own only. `dispatcher`: **denied** `payroll.read`; the test "refuses dispatch every payroll
  procedure, own pay included" holds. `management`: no `payroll.*`. `bank.read` and `tax_identifier.read` are held
  by nobody by design. Sensitive (audit-or-refuse): approve, run, adjust, rate.write, export, bank.read,
  tax_identifier.read, profile.write, finance.entity.write, contractor.approve.
- **Self access** is `_own` permissions plus `ctx.user.id`; `payrollApiAuthorization.test.ts:116-138` asserts no
  self-service input schema names a profile, employee number or user id.
- **Separation of duties** is role-level for payroll (run vs approve) and inline user-id comparisons elsewhere
  (`timeOffRouter.ts:119`, `_core/workforce.ts:55-71`, `commercialApprovals.mayApprove`). `runApprove` does not
  compare the approver with the run's creator. The commercial ladder's `decide()` loads roles without
  `revokedAt IS NULL` (`commercialApprovalService.ts:27`; also F0 finding G2).

## 9. Existing audit / outbox / offline-sync conventions

- **Audit.** No generic audit-log table. `authorizationDecisions` is the universal trail (who, procedure,
  permission, roles held, outcome, subject, detail; no before/after). Domain history is append-only tables:
  `dispatchRoleAssignmentEvents` (before/after binding columns, actor, reason, orgRef), `manifestCustodyEvents` +
  `manifestAmendments` (hash chain), `contractorPayableEvents`, `evidenceAccessEvents`, `restrictedAccessEvents`;
  `academyAuditEvents` is the only hash-chained log (previous hash read without a lock). Redaction exists only as
  audit-package policies (which already withhold payroll items), `NEVER_ATTACHABLE`, the biometric-material
  guard, the private leave note, and `human_only` extraction. No PII scrub helper exists.
- **Outbox.** `domainEventOutbox` (0015/0089): `tenantId`, aggregate, payload, `claimedAt` lease (120 s,
  `SKIP LOCKED`), retry backoff, dead letter; `emitDomainEvent(tx, …)` inside the caller's transaction; one
  production worker (`_core/productionWorker.ts`) evaluates workflow rules and dispatches signed webhooks
  per org. No export-job or report-job table; PDFs render synchronously inside the mutation.
- **Offline.** Client `Outbox` (saved_locally → queued → syncing → synchronized | failed | conflict; nothing unsynced
  is deleted) and `syncEngine` upload **evidence only** (form key travels as a note; no proposal or commit on sync).
  Server `sync.receivePackage` (`deviceRouter.ts:162-348`): device bound to the acting org, enrolled P-256 key,
  ±10 min freshness, wire-bytes signature, nonce once, `admitPackage`, server-recomputed content hash, conflicts
  recorded. `captureAuthorizationClaim` is never upgraded by a later sync (0079). `_core/offlineCapability.ts`
  defines local_safe / local_capture / local_prepare / server_authoritative classes but **no production
  capability list declares an `offlineClass`** (the SPINE plan names this seam, HS1). `evidenceRecords.clientCaptureRef`
  and `deviceSafetyLatches (reportedByUserId, captureLocalId)` are the idempotency precedents.

## 10. Gaps and contradictions

Severity: **S** = security or integrity defect on `main` today; **D** = design gap; **O** = owner decision.

| # | Sev | Finding | Evidence |
|---|---|---|---|
| G1 | **S** | `payroll.myStatements` lists **every entity's** paid/closed runs (up to 24) and stamps the caller's employee number on them; `listPayRuns()` is called with no entity filter. | `payrollRouter.ts:112-120`, `payrollService.ts:269-274` |
| G2 | ~~S~~ fixed | `finance.expenseCreate`, `expenseSetTreatment`, `expenseDuplicates` took a `financialEntityId`/`expenseRef` without proving it. **Fixed on `main` by PR #56 (F1/F1.1).** | `payrollRouter.ts:645-760` |
| G3 | ~~S~~ fixed | `period.readiness/close/reopen` took `financialEntityId` from input with no scope check. **Fixed on `main`: `moneyScoped` + `requireOwnedEntity`.** | `periodRouter.ts:13-21` |
| G4 | **S** | `payroll.rateCreate` mints an unscoped, company-wide rate version by `rateKey` ("left unscoped on purpose" per its comment); any `controller` anywhere can supersede any `rateKey`. | `payrollRouter.ts:233-256` |
| G5 | **S** | Run vs approve separation is role-level only; nothing compares the approver with the run's creator, and a user holding both roles (or the solo admin) self-approves silently. | `payrollRouter.ts:427-458`, `recordsAuthorization.ts:2419-2420` |
| G6 | ~~S~~ fixed | The commercial approval ladder's `decide()` counted revoked roles. **Fixed on `main`: `isNull(revokedAt)`.** | `commercialApprovalService.ts:40` |
| G7 | D | A pay run can never leave `draft` through the API: `runApprove.toState` excludes `collecting`, the engine allows only `draft→collecting`. Nothing writes `payRunLines`. `payPeriods.lockedAt` is never written. `payroll.export` is a stub (`exported: true`). | `payrollRouter.ts:431-498`, `payrollEngine.ts:286-297` |
| G8 | D | No earning-code catalogue (`earningType` is free text on `payRates`, `payrollEarningEvents`, `payRunLines`); no compensation agreement; no pay schedule; no statement table; no YTD; no deductions/benefits model. | 0022 |
| G9 | D | `payrollTimeEntries` has no approver, no `sourceRecordRef`, no offline capture ref; `payrollEarningEvents` has no approver and no run link; `payrollAdjustments` has no kind, evidence or affected period; `expenseRecords` has no submitter/approver/reimbursement state. | schema.ts 3315-3427, 3200 |
| G10 | D | `payPeriods` and `payRuns` share one 8-value enum (`draft…amended`) that does not match the brief's OPEN → REVIEWING → APPROVED → PROCESSING → FINALIZED (+ VOIDED/CORRECTED). | 0022 |
| G11 | D | Money on 0022 tables is `double` + shadow; the router writes doubles and relies on triggers; `expenseRecords.currency` is `varchar(8)` while the convention is `varchar(3)`. | 0062, `zzMoneyPrecision.test.ts:16-26` |
| G12 | D | No worked-time capture exists anywhere: dispatch has planned windows only; HOS is a duty log without certification; `dailyLogs` is dead; field-ticket events have a `payroll` clock no event uses; work-order labour is one untyped total; no worker ever signs hours. | §5 |
| G13 | D | Employment classification is spread over five columns plus an input-only `workerKind`; nothing on the profile records it. | §4 |
| G14 | D | "Driver Wallet" in LeaseOS means the credential wallet (PR #16) or the training wallet (unmerged); no money/receipt wallet record exists (F0 G11). The employee expense surface must not become a third. | §2 |
| G15 | D | Audit has no before/after capture and no payroll event table; `authorizationDecisions.detail` is free text that could carry amounts. | §9 |
| G16 | D | Offline sync carries evidence only; a time entry or expense submitted offline has no server-side kind, and no production capability declares an `offlineClass`. | §9 |
| G17 | D | The workforce offboarding "final pay proposed" is a timestamp with no payroll write; `leaveRequests` have no payroll link (paid/unpaid). | `_core/workforce.ts:77`, 0090 |
| G18 | D | `LEASEOS_B20_7` and the code agree on 40 procedures, but B20.5/B20.7 describe a working run lifecycle that the router cannot execute (G7); the docs also predate 0146 scoping. | B20.5 §4, B20.7 |
| G19 | **O** | SPINE moratorium and the finance new-engine freeze vs the new tables this design needs. | `SPINE_WIRING_PLAN.md:3`, F0 owner decision 2 |
| G20 | **O** | Migration numbering: the register is stale (its "next free" lags the scan); at re-measurement `main` ends at 0219, open branches hold up to 0216, 0182 is claimed three times; two 0157 files on main. | §17, addendum |
| G21 | resolved | Role grants had no organization and the F1 wrapper was unmerged. **Both merged (PR #64 as 0207/0208; PR #56).** Payroll builds on `moneyScoped` and organization-scoped grants. | §7, addendum |
| G22 | note | `MoneyScope.tenantId` holds an `orgRef`; `tenantId` and `orgRef` are two names for one idea (`PORTAL_ORG_SCOPE_DEFERRED.md:74`). Payroll adds neither column; it keys to `financialEntityId`. | — |

G1, G4 and G5 are defects in code that exists on `main` today and are permitted repairs under the moratorium; G2, G3 and G6 were repaired on `main` after the survey.

---

## 11. Proposed bounded context for Payroll

Payroll is already a bounded context on `main`: `payrollRouter.ts` (`payroll`, `contractors`, `finance`
namespaces), `payrollService.ts`, `_core/payrollEngine.ts`, `_core/expenseTreatment.ts`, `_core/entityScope.ts`
and the 0022 tables. This design keeps that boundary and hardens it rather than creating a second one.

```
                 ┌──────────────────── PAYROLL CONTEXT (existing, hardened) ───────────────────┐
 operational     │                                                                              │
 contexts        │  IDENTITY     employeePayrollProfiles ──► compensationAgreements (new)        │
 (evidence,      │               ▲ userId / operatorId        └─ compensationAgreementVersions   │
  never money)   │               │                             └─ compensationEarningRules       │
                 │  CATALOGUE    payGroups · earningCodes (new) · payRates (existing, versioned)  │
 dispatch ──────►│                                                                              │
 jobs/trips ────►│  EVIDENCE     payrollTimeEntries (source + sourceRecordRef)                    │
 loads ─────────►│               payrollEarningEvents (+ payrollEarningEvidence)                  │
 HOS ───────────►│               payrollTimeReconciliations                                      │
 field tickets ─►│               payrollExceptions (new)                                          │
 work orders ───►│               ▼ approval (status machine, separation of duties)                │
 expenses ──────►│  APPROVED     earning/time/reimbursement/adjustment in `approved` state         │
                 │               ▼ collect                                                        │
                 │  RUN          paySchedules (new) · payPeriods · payRuns · payStatements (new)   │
                 │               payRunLines (existing) · payStatementSnapshots (new, frozen)       │
                 │               ▼ finalize                                                        │
                 │  EXPORT       payrollExportBatches / payrollExportItems (new; adapter boundary)  │
                 │                                                                              │
                 │  cross-cutting: financialEntity scope fence · roleProcedure permission gate ·  │
                 │  authorizationDecisions trail · payrollAuditEvents (new, append-only) ·        │
                 │  period close (assertPeriodOpen) · evidence vault refs · trackingSequences     │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

**Rules of the context**

1. Operational records never carry pay money. `dispatchPostings.postedRateCents` (0013) is a posting-visible bid
   rate, `privateRateSchedules.rateCents` (0115) is a contractor commercial rate, `pricingDecisions` are customer
   charges. None of them is a wage. Payroll reads them only as *evidence*, through `sourceRecordRef`.
2. Every dollar in payroll cites a `compensationAgreementVersion` (or `payRates` version for the legacy path) and
   the operational record that produced the quantity. `calculateEarning()` already blocks an earning with no
   evidence; this stays.
3. Nothing enters a pay run unless it is in `approved` state in a payroll table. HOS, dispatch, field tickets and
   receipts are *candidates* until a person with `payroll.review` or `payroll.approve` acts.
4. A finalized run is frozen by snapshot (statement rows carry the amounts, rates and version refs as they were);
   corrections are new `payrollAdjustments` rows applied in a later run, never `UPDATE`s on the finalized run.
5. The context owns no tax engine. `payRunLines.ruleStatus = 'unverified'` and the P9 rule (every determination is
   UNKNOWN until a controller verifies a sourced rule) stand. Statutory deductions are export-side or UNKNOWN.
6. Contractor settlement (`contractorSettlements`, `contractorPayables`) stays a separate ledger. An owner-operator
   never gets an employee pay statement; `assertPayrollEligibility` remains a hard refusal.

## 12. Proposed data model

Convention for every new table (house style, §A3 of the survey): `id int AUTO_INCREMENT` PK, a unique `xxxRef varchar(64)`
business ref, `financialEntityId int NOT NULL` as the money scope (the 0146 rule; `orgRef` is derived through
`financialEntities.orgRef`, not duplicated), `…Cents int`, `…Millis int`, `currency varchar(3) NOT NULL DEFAULT 'CAD'`,
`createdAt timestamp NOT NULL DEFAULT (now())`, `xxxByUserId`/`xxxAt` pairs, no foreign keys, indexes as separate
`CREATE INDEX` statements, and a matching `mysqlTable(` declaration in `drizzle/schema.ts` (column parity is tested).
No `tenantId` column on any payroll table: `tenantIsolation.test.ts` pins that list to 19 tables.

### 12.1 Kept as-is (existing 0022 tables)

| Table | Role in the design | Change |
|---|---|---|
| `financialEntities` | the money tenant (book) | none |
| `payGroups` | grouping for schedules/rules | gains `payScheduleId` (nullable) |
| `employeePayrollProfiles` | the payroll identity of a person | gains `workerClassification` (see 12.2), `organizationWorkerRef` (nullable link to `organizationWorkers.workerRef`), `terminatedAt` already exists |
| `payRates` | legacy versioned rate | kept for backward compatibility; new rules live on agreement versions. `rateMillis` becomes the authoritative read |
| `payPeriods` | the period | gains `payScheduleId`, `paymentDate`, `state` narrowed by the engine (12.4) |
| `payrollTimeEntries` | payroll time record | gains `sourceRecordRef varchar(120)`, `earningCodeId`, `submittedByUserId/At`, `approvedByUserId/At`, `rejectedReason`, `clientCaptureRef varchar(120)` (offline idempotency), `notes text`, `locationText`; **no schema change to HOS** |
| `payrollTimeReconciliations` | three-clock comparison | none |
| `payrollEarningEvents` | the pay item | gains `earningCodeId`, `compensationAgreementVersionId`, `approvedByUserId/At`, `payRunId` (set when collected), `dispatchRoleId`/`loadId` (nullable evidence pointers alongside existing `sourceRecordRef`) |
| `payrollEarningEvidence` | evidence links | none |
| `payRuns` | the run | gains `payScheduleId`, `finalizedByUserId/At`, `voidedByUserId/At/Reason`, `snapshotHash char(64)`, `supersedesPayRunId`, `correctionOfPayRunId` |
| `payRunLines` | statement lines | gains `payStatementId`, `payrollAdjustmentId`, `expenseRecordId`, `agreementVersionRef varchar(140)` (frozen text), `amountCents` becomes NOT NULL on write (the double stays grandfathered) |
| `payrollAdjustments` | corrections | gains `adjustmentKind` enum(bonus, correction, missed_hours, overpayment_recovery, expense_reimbursement, advance, deduction, allowance, retro_pay, void_reversal), `affectedPayPeriodId`, `evidenceRecordId`, `declinedReason`, `earningCodeId` |
| `payrollDisputes` | employee statements | none |
| `contractorSettlements`, `contractorPayables` | contractor ledger | none (stays separate) |
| `expenseRecords` | the receipt/expense record | gains the reimbursement state (12.3) |

### 12.2 New tables

**Compensation (effective-dated, versioned)**

```
compensationAgreements
  id, agreementRef UNIQUE, financialEntityId, employeePayrollProfileId,
  title varchar(160), status enum('draft','active','ended'), startsOn date, endsOn date NULL,
  createdByUserId, createdAt

compensationAgreementVersions                 -- never updated once approved
  id, versionRef UNIQUE, agreementId, version int, effectiveFrom date, effectiveUntil date NULL,
  basis enum('hourly','salary','day_rate','shift_rate','load_rate','trip_rate','mileage_rate',
             'percentage','job_rate','piece_rate','mixed'),
  currency, rulesHash char(64) (sha256 of the canonical rule set),
  proposedByUserId, proposedAt, approvedByUserId NULL, approvedAt NULL,
  status enum('proposed','approved','superseded','rejected'), supersedesVersionId NULL,
  UNIQUE(agreementId, version)

compensationEarningRules                      -- one row per earning code within a version
  id, versionId, earningCodeId, calculation enum('hourly','quantity_times_rate','percentage','flat',
      'per_period_salary','formula'), rateMillis int NULL, percentMillis int NULL,
  unit enum('hour','day','shift','km','load','trip','tonne','m3','percent','each','period'),
  overtimeRuleJson json NULL (daily/weekly thresholds, multiplier millis; interpreted by the engine, never by SQL),
  minimumMeasurementAuthority varchar(60) NULL, requiresJob bool, requiresUnit bool,
  eligibleRevenueBasisJson json NULL (for percentage pay: exclusions list),
  sortOrder int
```

Historical reproducibility: an earning event stores `compensationAgreementVersionId` and `rateAppliedMillis`;
a pay statement snapshot stores the version's `rulesHash`. A raise is a new version with a new `effectiveFrom`;
the old version's `effectiveUntil` is closed, never deleted (the `payRates` precedent).

**Earning codes (per-tenant catalogue)**

```
earningCodes
  id, financialEntityId NULL (NULL = shared seed catalogue, the dispatchRoleTypes 0170 pattern, with a
  PERSISTENT generated collision key `codeKey = CONCAT(COALESCE(financialEntityId,'*'),':',code)` UNIQUE),
  code varchar(40), name varchar(120), description varchar(500),
  calculationType enum('hourly','quantity_times_rate','percentage','flat','per_period_salary','formula'),
  rateSource enum('agreement','pay_group','manual','none'),
  kind enum('earning','reimbursement','deduction','employer_cost','allowance'),
  taxTreatmentMetaJson json NULL (metadata only; no calculation),
  requiresJob bool, requiresUnit bool, requiresApproval bool DEFAULT true, countsTowardOvertime bool,
  activeFrom date, activeUntil date NULL, createdByUserId, createdAt
```

Seeded shared codes (examples only, from the brief): REG, OT, DOUBLE_TIME, DAY_RATE, SHIFT, LOAD_PAY, TRIP_PAY,
MILEAGE, STANDBY, TRAVEL, TRAINING, CALL_OUT, SHOP, BONUS, COMMISSION, PER_DIEM, MEAL, SUBSISTENCE,
EXPENSE_REIMB, ADVANCE, DEDUCTION, RETRO, CORRECTION. `payRates.earningType`/`payrollEarningEvents.earningType`
(free text today) migrate to `earningCodeId` with the text column kept for the existing rows.

**Pay schedule**

```
paySchedules
  id, scheduleRef UNIQUE, financialEntityId, name, frequency enum('weekly','biweekly','semi_monthly','monthly','custom'),
  anchorDate date, periodLengthDays int NULL (custom), paymentLagDays int, cutoffLagDays int,
  timezone varchar(64), status enum('active','retired'), createdByUserId, createdAt
```

`payPeriods` rows are generated from a schedule (a resolver, not a background engine) and keep `paymentDate`.

**Pay statement (internal record, not a legal stub)**

```
payStatements
  id, statementRef UNIQUE, statementNumber varchar(64) NULL (tracking sequence 'PAY', minted at finalize),
  payRunId, employeePayrollProfileId, payPeriodId, paymentDate,
  grossCents, reimbursementCents, deductionCents, adjustmentCents, netCents (net = gross + reimb + adj − ded,
  statutory lines UNKNOWN stay outside net until a verified rule exists), currency,
  ytdGrossCents NULL, ytdReimbursementCents NULL (computed at finalize from prior finalized statements in the
  same entity and calendar year; NULL when no rule says what "year" is — owner decision D7),
  state enum('draft','finalized','voided','superseded'), supersedesStatementId NULL,
  snapshotJson json (every line with agreementVersionRef, rateMillis, quantityMillis, evidence refs),
  snapshotHash char(64), finalizedByUserId NULL, finalizedAt NULL, documentEvidenceRecordId NULL,
  UNIQUE(payRunId, employeePayrollProfileId)
```

`payRunLines` become the line items of a statement (`payStatementId`), which reconciles totals: a test sums
lines and compares with the statement header.

**Exceptions**

```
payrollExceptions
  id, exceptionRef UNIQUE, financialEntityId, payPeriodId NULL, employeePayrollProfileId NULL,
  kind enum('missing_approval','overlapping_entries','duplicate_entry','duplicate_expense',
            'no_active_agreement','missing_earning_code','outside_employment','long_shift',
            'job_reference_missing','receipt_required','source_changed_after_preparation',
            'clock_variance','cross_tenant_reference','self_approval_blocked'),
  subjectType varchar(40), subjectRef varchar(120), detail varchar(500),
  status enum('open','acknowledged','resolved','waived'), resolvedByUserId NULL, resolvedAt NULL, resolutionNote,
  createdAt
```

Derived by a resolver over existing rows at review time and persisted so the resolution is auditable
(the `payrollTimeReconciliations` precedent). `source_changed_after_preparation` compares the source record's
current hash/updatedAt with the value captured on the earning event at proposal time.

**Approval policy (configurable separation of duties)**

```
payrollApprovalPolicies
  id, financialEntityId UNIQUE, version int,
  timeApproval enum('supervisor','payroll_admin','either'), timeSelfApproval enum('never','solo_admin_only'),
  expenseApproval enum('supervisor','payroll_admin','either'),
  runRequiresDistinctApprover bool DEFAULT true, runRequiresDistinctFinalizer bool DEFAULT false,
  compensationChangeRequiresSecondApprover bool DEFAULT true,
  soloAdministratorMode bool DEFAULT false (when true and the entity has exactly one holder of payroll roles,
      self-approval is permitted but every such act writes a payrollAuditEvents row with kind 'self_approved'),
  setByUserId, setAt
```

The existing `commercialApprovals` ladder (0136) is generic (`subjectType`/`subjectRef`, snapshotted
requirement, signatures in sequence). Reusing it for pay-run approval is the preferred option (owner decision D4);
the policy table above then only carries the payroll-specific flags.

**Audit**

```
payrollAuditEvents                            -- append-only; BEFORE UPDATE / BEFORE DELETE SIGNAL triggers
  id, eventRef UNIQUE, financialEntityId, actorUserId, actorRole varchar(40),
  subjectType enum('profile','agreement','agreement_version','earning_code','time_entry','earning','expense',
                   'adjustment','pay_period','pay_run','statement','export','policy','schedule'),
  subjectRef varchar(120), eventKind varchar(60), beforeJson json NULL, afterJson json NULL,
  redaction enum('none','amounts_redacted') (amounts are stored; the *general* audit surfaces read the redacted
  projection unless the caller holds payroll.read_all), occurredAt, createdAt
  INDEX (financialEntityId, subjectType, subjectRef, id)
```

The driver-portfolio branch (0176) and `dispatchRoleAssignmentEvents` (0171) are the precedents for append-only
event tables with `SIGNAL` triggers; `authorizationDecisions` continues to record every gate decision.

**Export boundary**

```
payrollExportBatches
  id, batchRef UNIQUE, financialEntityId, payRunId, provider enum('csv_generic','quickbooks_online','sage','xero',
      'adp','wagepoint','dayforce','custom'), adapterVersion varchar(40),
  status enum('prepared','exported','acknowledged','rejected','superseded'), idempotencyKey varchar(120) UNIQUE,
  payloadHash char(64), fileEvidenceRecordId NULL, externalBatchRef varchar(160) NULL,
  errorJson json NULL, preparedByUserId, preparedAt, exportedByUserId NULL, exportedAt NULL, acknowledgedAt NULL

payrollExportItems
  id, batchId, payStatementId, externalId varchar(160) NULL, status enum('pending','sent','accepted','rejected'),
  errorText varchar(500) NULL, UNIQUE(batchId, payStatementId)
```

Re-exporting the same finalized run with the same adapter and payload hash returns the existing batch
(idempotent); a changed payload after a correction run is a new batch that `supersedes` the old one.
The adapter interface is a pure TypeScript module (`server/_core/payrollExport/<provider>.ts`) that maps a
statement snapshot to the provider's line format; the connector layer proposed by the finance F0 design
(Layer 4) is the intended long-term home, so the table above is designed to be that layer's first consumer.

### 12.3 Expense and reimbursement state (existing `expenseRecords`, extended)

```
expenseRecords +
  submittedByUserId, submittedAt, employeePayrollProfileId NULL (the claimant; set only when paidPersonally),
  reimbursementState enum('not_applicable','pending_approval','approved','scheduled','reimbursed','rejected')
      DEFAULT 'not_applicable',
  reimbursementPayRunId NULL, reimbursementStatementId NULL, reimbursementLineId NULL (UNIQUE when set),
  approvedByUserId NULL, approvedAt NULL, rejectedByUserId NULL, rejectedAt NULL, rejectedReason,
  clientCaptureRef varchar(120) NULL (offline idempotency, the evidenceRecords.clientCaptureRef precedent),
  merchantName (vendorName exists), categoryId (exists), jobId/unitId (exist), evidenceRecordId (exists)
```

A receipt scanned into the vault (`evidenceRecords`) or proposed by the assistant (`assistantProposals` → commit
receipt with `targetType = expense_record`) becomes an `expenseRecords` row in `draft`/`submitted`; it reaches
`reimbursementState = approved` only through `payroll.approve_expenses`; the run collects only `approved` rows;
`reimbursed` is written in the same transaction as the statement line, and the UNIQUE on `reimbursementLineId`
is the database's own refusal to reimburse twice.

### 12.4 Classification on the profile

`employeePayrollProfiles.workerClassification enum('employee','contractor','owner_operator','mechanic',
'dispatcher','office_staff','salaried_management','temporary_casual')` stays informational; the *routing* rule is
binary and already exists (`assertPayrollEligibility`): `contractor`/`owner_operator` never receive a profile and
are settled through `contractorSettlements`/`contractorPayables`. `organizationWorkers.workerType` (14 values) and
`organizationMemberships.membershipType` are the operational sources; the profile column is a snapshot of the
classification at profile creation and each agreement version records the classification it was written for.

## 13. Proposed state machines

**Pay period** (narrowed from the shared 8-value enum; `payPeriods` and `payRuns` stop sharing one enum)

```
OPEN ──► REVIEWING ──► APPROVED ──► PROCESSING ──► FINALIZED ──► (CORRECTED via a correction run)
  ▲          │                                        │
  └──────────┘ (reopen, payroll.approve, reason)      └──► VOIDED (payroll.void, reason, before any export ack)
```

Existing engine values map: `collecting→OPEN`, `review→REVIEWING`, `approved→APPROVED`, `processing→PROCESSING`,
`paid/closed→FINALIZED`, `amended→CORRECTED`. The migration keeps the old enum values and adds the new ones;
`canTransitionPayRun` gains the new names and a translation table so old rows still read.

**Pay run**

```
DRAFT ──collect──► COLLECTING ──review──► REVIEW ──approve──► APPROVED ──process──► PROCESSING ──finalize──► FINALIZED
                       ▲                   │                     │                                            │
                       └───────────────────┘ (return to collect) └──► REVIEW (withdraw approval)               ├──► VOIDED
                                                                                                              └──► SUPERSEDED (by a correction run whose correctionOfPayRunId = this)
```

Guards: `collect` requires every collected item `approved`; `approve` requires zero open blocking exceptions and
an approver ≠ creator when the policy says so; `finalize` writes statements + snapshotHash + statement numbers in one
transaction and is refused if the period is not APPROVED or a statement already exists for a profile in this run;
FINALIZED and later states refuse every UPDATE on `payRunLines`/`payStatements` (application guard now; DB
`SIGNAL` trigger in the hardening slice, the manifests_seal_guard precedent).

**Time entry**  `open → submitted → (verified) → approved | rejected | void`, plus `disputed` from
`submitted`/`approved`; an edit after `submitted` is a new row with `supersededByEntryId` set on the old one.

**Earning event**  `pending | held → verified → approved → collected → paid | void`. `held` is the
engine's blocked state and needs a human.

**Expense**  `scanned → draft → submitted → approved | rejected → scheduled → reimbursed`; `rejected` keeps the
row and its evidence; `reimbursed` is terminal and unique per statement line.

**Adjustment**  `requested → approved | declined → applied` (applied only by a run in COLLECTING).

**Compensation agreement version**  `proposed → approved | rejected`; `approved → superseded` when a later
version's `effectiveFrom` closes it. Never deleted.

**Export batch**  `prepared → exported → acknowledged | rejected`; `superseded` when a correction run's batch
replaces it.

## 14. Proposed authorization matrix

The catalogue already has 13 payroll permissions and five finance roles. The brief's `payroll:xxx` names are
mapped onto the existing dotted vocabulary; new permissions are marked **new**.

| Capability (brief) | Existing / proposed permission | driver, mechanic, shop_lead | dispatcher | hr | payroll_admin | controller | management | bookkeeper | external_accountant |
|---|---|---|---|---|---|---|---|---|---|
| view_own | `payroll.read_own` (universal-style, self-scoped) | ✓ | ✓ (own pay only, if they have a profile) | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| view_team | **new** `payroll.read_team` (supervisor projection: time and expense status, *no amounts*) | – | – | ✓ | ✓ | ✓ | ✓ (team status only) | – | – |
| view_all | `payroll.read_all` | – | – | – | ✓ | ✓ | – | – | – |
| submit_time | `payroll.time.submit_own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| approve_time | **new** `payroll.time.approve` (supervisor or payroll_admin per policy) | – | – | ✓ | ✓ | – | ✓ (crew supervisor via branch grant) | – | – |
| manage_compensation | `payroll.rate.write` (controller) + **new** `payroll.agreement.propose` (payroll_admin, hr) | – | – | propose | propose | approve | – | – | – |
| create_run | `payroll.run` | – | – | – | ✓ | – | – | – | – |
| approve_run | `payroll.approve` | – | – | – | – (denied) | ✓ | – | – | – |
| finalize_run | **new** `payroll.finalize` | – | – | – | ✓ (after controller approval) | ✓ | – | – | – |
| export | `payroll.export` | – | – | – | ✓ | ✓ | – | – | – |
| void | **new** `payroll.void` (sensitive) | – | – | – | – | ✓ | – | – | – |
| manage_expenses | `tax.expense.create` (own submit) + **new** `payroll.expense.submit_own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| approve_expenses | **new** `payroll.expense.approve` | – | – | ✓ | ✓ | ✓ | – | – | – |
| bank / tax identifier | `payroll.bank.read`, `payroll.tax_identifier.read` | held by nobody (unchanged) |

Rules carried from the codebase: `DENIALS` keep `payroll.read` off dispatcher, mechanic, shop_lead, driver,
auditor; `payroll_admin` stays denied `payroll.approve`; `controller` never holds `payroll.run`;
`management` gets no `payroll.read_all` (analytics come through an aggregate projection gated by a **new**
`payroll.analytics.read` that returns totals by job/unit/division and never a per-employee amount);
every `_own` procedure resolves the profile from `ctx.user.id`; every id in input is proved with
`assertEntityInScope`/`assertProfileInScope`/`assertRunInScope` and refused as NOT_FOUND. All new write
permissions except `submit_own` join `SENSITIVE_PERMISSIONS` so a failed audit write refuses the act.

## 15. Proposed API / router structure

Keep the existing namespaces (`payroll`, `contractors`, `finance`) and the existing builder discipline: every
procedure is `roleProcedure("<namespace>.<name>")`, mapped in `OPERATIONAL_PROCEDURE_PERMISSIONS`, with zero
bare `protectedProcedure` (CI gate 5 and `procedureAuthorization.test.ts:171`). New namespaces are split out of
`payrollRouter.ts` into files that mirror the repository's one-router-per-domain layout:

| File | Namespace | Procedures (proposed) |
|---|---|---|
| `server/payrollRouter.ts` (existing) | `payroll` | keep the 22; **fix** `myStatements` (entity-filtered, statement-backed) and `export` (stub → batch) |
| `server/payrollCompensationRouter.ts` | `payrollCompensation` | `agreementsList`, `agreementGet`, `agreementCreate`, `versionPropose`, `versionApprove`, `versionReject`, `versionHistory`, `earningCodesList`, `earningCodeUpsert`, `earningCodeRetire`, `policyGet`, `policySet` |
| `server/payrollScheduleRouter.ts` | `payrollSchedule` | `schedulesList`, `scheduleCreate`, `scheduleRetire`, `periodsGenerate`, `periodGet` |
| `server/payrollTimeRouter.ts` | `payrollTime` | `submitOwn` (moves from `payroll.submitTime`, keeps the name mapped), `editOwn` (supersede), `listOwn`, `listTeam`, `listPending`, `approve`, `reject`, `candidatesFromSources` (read-only projection of HOS/dispatch/field-ticket/work-order candidates for a profile and date, never a write) |
| `server/payrollExpenseRouter.ts` | `payrollExpense` | `submitOwn`, `listOwn`, `withdrawOwn`, `listPending`, `approve`, `reject`, `scheduleForReimbursement` |
| `server/payrollRunRouter.ts` | `payrollRun` | `create`, `collect`, `exceptions`, `resolveException`, `review`, `approve`, `withdrawApproval`, `finalize`, `void`, `correctionCreate`, `statementsList`, `statementGet`, `statementDocument` (renders via the document engine), `exportPrepare`, `exportSend`, `exportStatus`, `exportRetry` |
| `server/payrollAnalyticsRouter.ts` | `payrollAnalytics` | `costByPeriod`, `labourByJob`, `labourByUnit`, `labourByDivision`, `overtimeTrend` (aggregates only; gated by `payroll.analytics.read`) |

Service layer: `server/payrollService.ts` stays the data-access module; new pure engines go under
`server/_core/`: `payrollCompensation.ts` (rule-in-force resolution, overtime interpretation), `payrollCollection.ts`
(what a run may collect), `payrollStatement.ts` (statement building + reconciliation of totals), `payrollExceptions.ts`
(exception derivation), `payrollExport/` (adapters + a `csvGeneric` reference implementation). Engines take plain
arguments (no db, no ctx), the repository's convention.

Scope: every new procedure is `moneyScoped(roleProcedure("…"))` and reads `ctx.money` (merged F1 convention;
see addendum). Existing payroll procedures keep `moneyScope()` + `assert*InScope`, which the coverage test accepts as
`SELF_SCOPED`; migrating them to the wrapper is a P0 cleanup, not a prerequisite. Any operational id
passed as evidence (`jobId`, `tripId`, `loadId`, `dispatchRoleId`, `unitId`, `evidenceRecordId`) is proved with the
existing `jobInScope`/`tripInScope`/`unitInScope`/`evidenceInScope` point lookups and refused as NOT_FOUND.

Pinned counts that change with any new procedure: `OPERATIONAL_PROCEDURE_PERMISSIONS` length
(`procedureAuthorization.test.ts:178`, 723 at re-measurement), `serverPaths.size` (`crossLayerIntegrity.test.ts:39`, 793),
`financeScopeCoverage.test.ts` (every money-keyed procedure must be scoped),
the `roleProcedure(` count in `scripts/current-state.sh`, and `PROCEDURE_AUTHORIZATION_INVENTORY.md`.

## 16. Proposed UI surfaces

The client mounts portals in `client/src/portal/PortalShell.tsx` (`worker_self_service`, `hr_workforce`,
`finance_billing`, `management`, …) with a panel contract (`panelContract.ts`) that whitelists the tRPC
procedures a panel may call. Pages live in `client/src/pages/*View.tsx` with a `.dom.test.tsx` beside them.
No payroll page exists today (`grep -ril payroll client/src` is empty).

| Audience | Portal | Panels (proposed) | Reads |
|---|---|---|---|
| Employee | `worker_self_service` ("Me") | Current period, My time (submit/edit, offline), Missing time, My expenses (capture → status), Reimbursements, Pay statements (finalized only) | `payroll.my*`, `payrollTime.*Own`, `payrollExpense.*Own`, `payrollRun.statementGet` (own) |
| Supervisor | `field_leadership`, `dispatch_operations` (team status only) | Pending timesheets, Exceptions for my crew, Unapproved expenses, Job/time discrepancies | `payrollTime.listTeam/listPending/approve`, `payrollExpense.listPending/approve`, `payrollRun.exceptions` (team filter) — **no amounts** |
| Payroll administrator | `finance_billing` → "Payroll" workspace | Pay schedules and periods, Runs (collect → review → finalize), Compensation agreements, Earning codes, Exceptions, Adjustments, Approvals queue, Export status, Reconciliation (statement totals vs lines vs export) | `payrollCompensation.*`, `payrollSchedule.*`, `payrollRun.*` |
| Controller | `finance_billing` | Approve run, Approve agreement versions, Void, Policy | `payrollRun.approve/void`, `payrollCompensation.versionApprove`, `policySet` |
| Management | `management`, `executive` | Aggregate payroll cost, labour by job / unit / division, overtime trend | `payrollAnalytics.*` only |

Quick capture: `client/src/portal/viewModels.ts:146` already defines a `receipt` capture (`kind expense_receipt`,
`needsPhoto`) for field portals; the employee expense panel reuses it. Dashboard widgets: `widgetSources.ts`
declares sources with permissions; payroll widgets are added there with the same permission strings, and the
B28 widget-source matrix (`docs/b28/WIDGET_SOURCE_MATRIX.md`) gains rows.

## 17. Migration strategy

**Numbering (measured, not assumed).** *(The paragraph and table below are the 2026-09-23 measurement; the
addendum re-measures on 2026-10-01: `main` ends at `0219`, nothing claims `0220` or above, so the provisional
numbers are re-based to `0220`–`0229`.)* `main` (`6f52b57`) ended at `0174_dispatch_override_provenance.sql`.
The collision register's own scan (`docs/architecture/MIGRATION_COLLISION_REGISTER.md:11-18`), re-run on
2026-09-23 against every remote branch, shows these claims on open branches:

| Slot | Claimed by |
|---|---|
| 0170 | `claude/leaseos-auth-workspace-system-t008ad`, `claude/work-calendar-task-engine-0mtjyk` (both collide with main's 0170) |
| 0172, 0173, 0174, 0175 | `claude/training-academy-workforce-q3mdse` (0174/0175 collide with main's 0174 and driver-portfolio's 0175) |
| 0175, 0176, 0177 | `claude/driver-portfolio-credential-wallet-ya8928` (PR #16) and `claude/driver-portfolio-api-ya8928` |
| 0178, 0179, 0180, 0181 | `claude/document-control-architecture-jlffzk` |
| 0179 | `claude/eld-compliance-intelligence-ramlrd`, `claude/migration-0169-reconciliation` (PR #17) |

The register itself is stale (it stops at 0174 and predates the 0175–0181 claims), so the two documents that
name 0175 as "the next compliance slot" are also stale. At the survey the first slot free on `main` and on every
open branch was `0182`; **at re-measurement it is `0220`** (0182 is now claimed by PR #99 and two other branches).
Under the register's rule of thumb the number is taken at PR time and re-checked; this document claims nothing
until then. Slots 0016, 0017, 0094, 0095, 0098 and 0157 are never reused.

The runner is `scripts/apply-migrations.sh` (`ls drizzle/*.sql | sort`) in CI and `scripts/migrate.ts` with the
`schemaMigrations` ledger in production; `drizzle/meta/_journal.json` is dead since 0018. Filenames are the
registry; a compound trigger body must be the only content of its file and use a bare `BEGIN` line.

**Proposed files (provisional numbers, allocated at PR time starting from 0220 as of 2026-10-01):**

| Provisional | File | Contents | Slice |
|---|---|---|---|
| 0220 | `0220_payroll_compensation_agreements.sql` | `compensationAgreements`, `compensationAgreementVersions`, `compensationEarningRules`, `earningCodes` (+ generated `codeKey`); `employeePayrollProfiles` + `workerClassification`, `organizationWorkerRef`; `payGroups` + `payScheduleId` | P1 |
| 0221 | `0221_payroll_schedules_periods.sql` | `paySchedules`; `payPeriods` + `payScheduleId`, `paymentDate`, new state values; `payRuns` + `payScheduleId`, finalize/void/snapshot/supersede columns | P2 |
| 0222 | `0222_payroll_time_and_earning_approval.sql` | `payrollTimeEntries` + source/approval/offline columns; `payrollEarningEvents` + `earningCodeId`, `compensationAgreementVersionId`, approval, `payRunId`; `payrollExceptions` | P3 |
| 0223 | `0223_payroll_expense_reimbursement.sql` | `expenseRecords` + reimbursement state and claimant columns, UNIQUE on `reimbursementLineId` | P4 |
| 0224 | `0224_payroll_statements.sql` | `payStatements`; `payRunLines` + `payStatementId`, adjustment/expense links, frozen `agreementVersionRef`; `payrollAdjustments` + kind/evidence/affected period; `trackingSequences` kind `PAY` | P5 |
| 0225 | `0225_payroll_audit_events.sql` | `payrollAuditEvents` table + indexes (DDL only) | P5 |
| 0226 | `0226_payroll_audit_append_only.sql` | `BEGIN…END` SIGNAL triggers only (the 0176 pattern; compound bodies must be alone in a file) | P5 |
| 0227 | `0227_payroll_export_batches.sql` | `payrollExportBatches`, `payrollExportItems`; `bankStatementLines.matchedType` + `payroll_run`; `commercialGlMappings.mappingKind` + `payroll_earning_code` | P6 |
| 0228 | `0228_payroll_approval_policy.sql` | `payrollApprovalPolicies` (or, if D4 chooses the commercial ladder, only the payroll flags) | P7 |
| 0229 | `0229_payroll_finalized_run_guard.sql` | `SIGNAL` triggers refusing UPDATE/DELETE on `payRunLines`/`payStatements` when the run is FINALIZED (the `manifests_seal_guard` pattern) | P8 |

Each migration: header comment naming the slice and rule, `--> statement-breakpoint` separators, mirrored in
`drizzle/schema.ts` in the same commit (column parity), Cents/Millis only (money gate), no reserved-word columns,
no `tenantId`, `LEASEOS_CURRENT_STATE.md` regenerated by `scripts/current-state.sh` (gate 8), and the collision
register updated in the same PR. Existing double columns on 0022 tables stay grandfathered and are not widened;
new code reads and writes only the shadows.

## 18. Test plan

Test style follows the repository: `*.test.ts` for pure engines, `*.db.test.ts` against a real database through
`appRouter.createCaller` with real roles, memberships and ownership (the `tenantScopeMoney.db.test.ts` and
`driverPortfolioApi.db.test.ts` pattern). Every test below names its refusal code.

| # | Requirement (brief §20) | Test | Assertion |
|---|---|---|---|
| T1 | tenant isolation | `tenantScopePayroll.db.test.ts` | Org B's `payroll_admin`/`controller` get NOT_FOUND on every new id-taking procedure for Org A's agreement, period, run, statement, expense and export; lists exclude them; the default scope sees only unowned entities |
| T2 | employee cannot see another employee's payroll | same file | `myStatements`, `statementGet`, `listOwn` for user X never return profile Y's rows even when X and Y share a job and a dispatch slot; `statementGet(id of Y)` is NOT_FOUND |
| T3 | dispatcher cannot access compensation | `payrollApiAuthorization.test.ts` (extend) | dispatcher is FORBIDDEN on `payrollCompensation.*`, `payrollRun.*`, `payrollAnalytics.*`, and on `payroll.read_team` |
| T4 | effective-dated compensation | `payrollCompensation.test.ts` (pure) | rule-in-force for a date picks the version whose window contains it, ties broken by version; a proposed version is never in force |
| T5 | historical payroll does not change after a rate update | `payrollRun.db.test.ts` | finalize run 1 at rate A; approve version 2 at rate B; re-read statement 1 lines, `snapshotHash` and totals unchanged; run 2 uses rate B |
| T6 | HOS data does not automatically become approved payroll | `payrollTime.db.test.ts` | inserting `dutyRecords` creates no `payrollTimeEntries`; `candidatesFromSources` returns candidates with `status: candidate`; `collect` ignores them until `approve` |
| T7 | duplicate pay-entry protection | same | two submissions with the same `clientCaptureRef` yield one row; overlapping entries for one profile raise `overlapping_entries`; the same `sourceRecordRef` proposed twice raises `duplicate_entry` and the second is `held` |
| T8 | expense approval | `payrollExpense.db.test.ts` | a `scanned`/`draft` receipt is never collected; approve requires `payroll.expense.approve`; the claimant approving their own is FORBIDDEN unless policy `soloAdministratorMode` and then an audit row `self_approved` exists |
| T9 | reimbursement only occurs once | same | after `reimbursed`, a second run's `collect` skips it; a forced insert with the same `reimbursementLineId` fails on the UNIQUE |
| T10 | payroll finalization | `payrollRun.db.test.ts` | finalize writes N statements, N statement numbers from `trackingSequences` kind `PAY`, `snapshotHash`, and an export-ready state, all in one transaction; a failure mid-way leaves no statement |
| T11 | finalized run cannot be silently edited | same + `payrollFinalizedGuard.db.test.ts` | `runApprove`/`collect` on FINALIZED is PRECONDITION_FAILED; a raw `UPDATE payRunLines` is refused by the trigger; `payrollAuditEvents` UPDATE/DELETE refused |
| T12 | corrections produce auditable adjustment | same | `correctionCreate` creates run 2 with `correctionOfPayRunId`, statement 1 becomes `superseded` (not edited), an adjustment row with `reason`, `requestedBy`, `approvedBy`, `affectedPayPeriodId`, and two audit rows |
| T13 | cross-tenant source/job IDs are refused | `tenantScopePayroll.db.test.ts` | `submitOwn` with Org B's `jobId`/`unitId`/`tripId`/`evidenceRecordId` is NOT_FOUND; `earningPropose` with Org B's `loadId` is NOT_FOUND; no row is written |
| T14 | export idempotency | `payrollExport.db.test.ts` | `exportPrepare` twice returns the same `batchRef` and `payloadHash`; after a correction run the new batch `supersedes` the old; `idempotencyKey` UNIQUE holds under concurrent calls |
| T15 | offline-submitted employee time cannot bypass approval | `payrollOffline.db.test.ts` | a sync package item of kind `payroll_time_entry` lands as `submitted` with `capturedAt` preserved and `clientCaptureRef` set; it is never `approved`; a package that claims `status: approved` is rejected |
| T16 | self-approval restrictions where configured | `payrollApprovalPolicy.test.ts` (pure) + db | with `runRequiresDistinctApprover`, creator = approver is FORBIDDEN ("You may not approve a run you created"); with `soloAdministratorMode` it is allowed and audited |
| T17 | payroll totals reconcile to statement line items | `payrollStatement.test.ts` (pure) + db | Σ(lines by kind) = header cents for every statement; Σ(statement net) = run net; a deliberately inconsistent snapshot fails `finalize` |
| T18 | drift guards | existing suites | `columnParity`, `zzMoneyPrecision`, `reservedWordColumns`, `tenantIsolation` (19-table pin untouched), `procedureAuthorization` (count bumps), `crossLayerIntegrity` (path count), `migrationLedger` (real corpus applies), gate 8 current-state parity |
| T19 | audit does not leak | `payrollAudit.db.test.ts` | `beforeJson`/`afterJson` for a rate change are readable only with `payroll.read_all`; the general timeline surface receives the `amounts_redacted` projection; `authorizationDecisions.detail` never contains an amount |
| T20 | period lock interplay | `payrollRun.db.test.ts` | a FINALIZED run in a `closed` accounting month is refused by `assertPeriodOpen` for its export posting date unless reopened (owner decision D6) |

## 19. Risks and security concerns

1. **The SPINE moratorium.** `docs/register/SPINE_WIRING_PLAN.md:3` says "no new engines until this path is
   wired"; the finance F0 design records an owner decision that the new-engine freeze stands for
   financial-event, journal and export work. Sections 12.2 (statements, exceptions, export batches, audit) are
   new engines under that definition. This report proposes them but takes nothing until the owner rules (D1).
2. **Existing defects on `main` that payroll inherits.** `payroll.myStatements` lists every entity's runs
   (`payrollRouter.ts:112-120`, unfiltered `listPayRuns`); `payroll.export` is a stub; `finance.expenseCreate`,
   `expenseSetTreatment` and `expenseDuplicates` were unscoped (fixed on `main` since, PR #56);
   `periodRouter` took `financialEntityId` from input without a scope check (fixed on `main` since); `payroll.rateCreate` mints an
   unscoped company-wide rate version by `rateKey`; run vs approve separation is role-level only (no creator ≠
   approver check); `payPeriods.lockedAt` is never written; nothing writes `payRunLines`; a run cannot leave
   `draft` through the API (`runApprove` cannot target `collecting`). These are security or integrity repairs
   and are permitted under the moratorium ("a resolver, or a router over something already written").
3. **Tenancy is not finished, but closer.** Organization-scoped role grants merged after the survey (PR #64,
   `0207`/`0208`): a `payroll_admin` grant is now issued by one organization and `roleProcedure` decides inside it.
   Legacy grants are `unscoped_legacy` and fail closed where an organization is required. Money scope uses the
   strict resolver (no revived single-tenant fallback). Two live memberships are still refused rather than
   resolved. `MoneyScope.tenantId` holds an `orgRef`. `LEASEOS_CURRENT_STATE.md` still says organization-wide
   isolation is not yet a property of the whole system.
4. **Four tenancy columns for money** (`financialEntityId`, `bookOrgRef`, `orgRef`, `tenantId`). Payroll uses
   only `financialEntityId` and never adds `tenantId`.
5. **Money doubles.** 0022's money columns are grandfathered doubles with Cents/Millis shadows filled by
   triggers; the router still writes doubles. New code must write and read only integer minor units and the
   money gate refuses any new double or decimal.
6. **Sensitive data.** No bank, SIN or tax-identifier column exists and the permissions to read them are held by
   nobody; this design adds none (D8). Statements go into the evidence vault as `restricted` records (0156) and
   are never attachable in communications (`LEASEOS_CURRENT_STATE.md:391`). Audit rows carry amounts but the
   general surfaces read a redacted projection.
7. **Offline.** Time and expense capture must ride the existing sync-package path (`syncPackages` →
   `evidenceRecords.clientCaptureRef`, `deviceSyncNonces`) with server-side status forced to `submitted`;
   compensation, approval, finalization and export are online-only and gated by sensitive permissions that
   refuse when the audit row cannot be written.
8. **Two wallets on open branches.** The driver credential wallet (PR #16 + the API branch) and the training
   wallet (`workerQualifications`) are unmerged and not money wallets; the finance survey found "no Driver
   Wallet record" for receipts (F0 G11). The employee expense surface must not become a third wallet: it is a
   panel over `expenseRecords` + `evidenceRecords`.
9. **Pinned counts and the current-state gate.** Any new procedure or table changes pinned numbers in three tests
   and regenerates `LEASEOS_CURRENT_STATE.md`; these edits belong in the same PR.
10. **Tax.** No verified rule exists (P9). Statutory deductions remain UNKNOWN lines; net pay on the internal
    statement is "net of non-statutory items" and the statement says so. Export to a payroll provider is the
    intended route for remittance.
11. **Trigger runner constraint.** Compound `BEGIN…END` triggers must be the sole content of a migration file;
    single-statement triggers must not use `BEGIN`.

## 20. Suggested implementation sequence

Each slice is one PR, one migration number allocated at PR time, one router file, tests in the same PR,
`LEASEOS_CURRENT_STATE.md` regenerated, the collision register refreshed. Nothing starts before the owner
decisions in §21.

| Slice | Scope | Moratorium class | Depends on |
|---|---|---|---|
| **P0 — repairs** (no migration) | scope `payroll.myStatements`; scope `periodRouter`; creator ≠ approver on `runApprove`; add `collecting` to `runApprove`/a `runCollect` procedure over existing tables; write `payRunLines` from approved earnings; port the finance branch's F1 expense scoping if it has not merged | repair / resolver | D2 |
| **P1 — compensation** | 0220: agreements, versions, rules, earning codes; `payrollCompensationRouter`; rule-in-force engine; T4, T5 (pure) | new tables (needs D1) | P0 |
| **P2 — schedules and periods** | 0221; `payrollScheduleRouter`; period generation resolver | new table | P1 |
| **P3 — time and earning approval** | 0222; `payrollTimeRouter`; candidate projection from HOS/dispatch/field tickets/work orders; exceptions resolver; T6, T7, T13, T15 | new columns + one table | P2 |
| **P4 — expenses and reimbursement** | 0223; `payrollExpenseRouter`; QuickCapture receipt wiring; T8, T9 | new columns | P3 |
| **P5 — runs, statements, audit** | 0224, 0225, 0226; `payrollRunRouter` (collect → finalize → correction); statement engine; `PAY` tracking sequence; document rendering via the invoice-document path; T10, T11, T12, T17, T19 | new tables | P4 |
| **P6 — export boundary** | 0227; `csvGeneric` adapter + adapter interface; GL mapping kind; bank match type; T14 | new tables (Layer 4 of F0; needs D1/D5) | P5 |
| **P7 — approval policy** | 0228 or ladder reuse; T16 | table or config | P5, D4 |
| **P8 — DB guards** | 0229 finalized-run triggers | trigger | P5 |
| **P9 — UI** | employee, supervisor, payroll admin, controller, management panels; widgets; panel contract entries | client | P3+ |

Contractor settlement, tax engines, legal pay stubs, and direct-deposit data are explicitly out of every slice.

## 21. Decisions required from the owner before coding

| # | Decision | Why it blocks | Default this report assumes |
|---|---|---|---|
| D1 | Does the SPINE moratorium / new-engine freeze (F0 owner decision 2) apply to payroll tables (statements, exceptions, audit events, export batches)? | Every slice from P1 on adds tables | Yes; only P0 proceeds until ruled |
| D2 | ~~Merge order of F1 and org-scoped grants~~ **Settled by the repository on 2026-10-01**: both merged (PR #56, PR #64). Remaining question: migrate the 22 existing `payroll.*` procedures to `moneyScoped()` in P0, or leave them on `moneyScope()` + `assert*` (the coverage test accepts either) | Consistency of the payroll router | Migrate in P0 |
| D3 | Keep `payRates` as the rate store (extend with agreement links) or migrate rates fully into agreement versions | Data model of P1 and the earning engine | Agreements are authoritative for new profiles; `payRates` read-only legacy |
| D4 | Reuse the commercial approval ladder (`commercialApprovals`, 0136) for run and agreement approval, or a payroll-specific policy table | P7 and the separation-of-duties tests | Reuse the ladder; payroll-only flags in a small policy table |
| D5 | First export adapter and format (generic CSV vs QuickBooks Online journal vs a payroll-provider file such as Wagepoint/ADP) | P6 scope; `commercialSettings.accountingTarget` already exists | Generic CSV first; provider adapters behind the same interface |
| D6 | Relationship between `payPeriods` and the accounting period close (`periodCloses`): does a FINALIZED run post into the month of `paymentDate` and get blocked by `closed`? | T20; whether payroll joins `CloseFacts` | Payroll keeps its own lock (0042 comment) and its export posting date is checked with `assertPeriodOpen` |
| D7 | Year basis for YTD totals (calendar year of `paymentDate` per jurisdiction is the usual rule, but P9 says no rule is verified) | Statement YTD columns | Store NULL until a rule is loaded; show "not available" |
| D8 | Whether LeaseOS will ever hold bank/direct-deposit or tax-identifier data, or leave it entirely to the provider | Vault design, `payroll.bank.read` holders | Never hold it; export carries an opaque employee key |
| D9 | Employment classification vocabulary: adopt `organizationWorkers.workerType` (14 values) as the source of truth and snapshot it, or the 8-value list in this report | Profile column in P1 | Snapshot `organizationWorkers.workerType` when linked; the 8-value column otherwise |
| D10 | Supervisor definition for `payroll.read_team`/`payroll.time.approve`: crew supervisor (`crewMembers.crewRole = supervisor`), branch grant, or an explicit reporting line (none exists) | P3 approval routing | Crew supervisor of the same tenant; else payroll_admin |
| D11 | Time-source policy: may dispatch bookings / field-ticket events / work orders be *proposed* automatically into `payrollTimeEntries` as `open` rows, or only shown as candidates until the employee submits | P3 candidate projection | Candidates only; nothing is written without a person |
| D12 | Pay-statement document: is an internal PDF (via the invoice-document renderer, `restricted` vault record, `PAY` number) in scope for P5 | Document engine wiring | Yes, internal only, watermarked "not a legal pay stub" |

---

## Appendix A. How this survey was taken

- Direct reads of `server/payrollRouter.ts`, `server/payrollService.ts`, `server/_core/payrollEngine.ts`,
  `server/_core/entityScope.ts`, `server/_core/trpc.ts`, `server/_core/recordsAuthorization.ts` (payroll sections),
  `drizzle/0022_payroll_finance_tax.sql`, `0062`, `0146`, `scripts/apply-migrations.sh`, `scripts/ci-gate.sh`,
  `docs/architecture/MIGRATION_COLLISION_REGISTER.md`, `docs/register/SPINE_WIRING_PLAN.md`, and the checkpoint and
  design documents on the branches named in §2.
- Four parallel read-only surveys of the repository (identity and authorization; migrations and finance schema;
  operational records; expenses, documents, numbering, audit, offline, approvals, client), each citing file and line.
- `git fetch origin --prune` followed by the collision register's own scan over every remote branch (§17), and the
  open pull-request list (#7, #15, #16, #17 open on 2026-09-23).
- Re-measured on 2026-10-01 against `main` = `b35bac4`: merged-PR log since `6f52b57`, diffs of the payroll, entity-scope,
  tRPC, authorization, period and approval modules, the register scan re-run, and the open pull-request list
  (16 open, including #16, #61, #99). Findings are in the addendum.
- No tests were run and no dependencies were installed; the report cites the tests that would run.

## Appendix B. Glossary of LeaseOS terms used here

| Term | Meaning in this repository |
|---|---|
| book / financial entity | `financialEntities` row; the tenant boundary for money (0146) |
| acting scope | the organization a caller acts for, derived from membership, never from input |
| single tenant / `"default"` | the historical deployment before organizations existed; NULL `orgRef` rows |
| roleProcedure | the tRPC builder that maps a procedure name to a permission and records every decision |
| sensitive permission | one whose act is refused when its authorization row cannot be written |
| evidence record | a stored document or capture in the vault, addressed by `storageKey`, never by URL |
| tracking number | a human-read number minted from `trackingSequences` under a row lock |
| credential wallet | the driver's tickets and licence projection (PR #16); not a money wallet |
| SPINE moratorium | "no new engines until the one-driver, one-job path is wired" |
| P9 | the standing finding that no tax, regulatory or rate rule is verified; determinations read UNKNOWN |
