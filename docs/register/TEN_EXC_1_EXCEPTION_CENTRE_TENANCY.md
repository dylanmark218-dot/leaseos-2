# TEN-EXC-1: Exception Centre tenant isolation

**Invariant:** organization A never receives an exception, status, credential, defect, calibration
item, sync conflict or other operational record that belongs to organization B. This is enforced
in the query, at the server and database boundary, not in the UI.

Baseline: `e9bb232` (AIL-1A.1, approved). Branch: `claude/relaxed-carson-qfcopf`. No migration.
**AIL-1B was not started. SEC-OUTBOUND-1 remains open.** No AI feature work is in this checkpoint.

## 0. Owner rulings recorded (2026-09-24)

- **Exception Centre.** TEN-EXC-1 is complete before AIL-1B, and it is not combined with AIL-1B.
- **Raw AI conversation review.** Raw assistant history is private to the user who asked, within
  their organization. `assistant.curate` is not repurposed for conversation review. Management,
  safety, dispatch and administrator roles get no access to employee AI conversations because of
  their role. Any future cross-user review (security, regulatory, abuse, legal, audit) must be a
  separate governed capability with its own narrow permission and audit trail. That capability is
  not implemented here or in AIL-1B.

## 1. Ownership vocabulary

Every rule below resolves an owner through `server/exceptionScope.ts`. Each `ownerOf.*` evaluates,
inside the SQL, to one of three values:

| Value | Meaning | Who sees the row |
|---|---|---|
| an organization's ref | ownership is proved through the record's own links | that organization only |
| `default` | the record exists and nothing ever claimed it: a historical single-tenant row (the 0132 repo rule) | the default (single-tenant) scope only. **This is not global.** |
| `NULL` (**unresolved**) | the link points to nothing, a person belongs to two organizations, a required stamp is missing, the proposal's owner was never proved, or there is no ownership model | **nobody**, the default scope included |

`ownedBy(scope, required, optional)` admits a row only when **every** owner it carries equals the
caller's organization. An optional link (a nullable column) is checked when it is set. A row whose
links name two organizations is therefore shown to **neither**. The scope always comes from the
session (`actingScopeFor`), never from the request.

## 2. Source matrix (surveyed before any code change)

The "before" column records the state at `e9bb232`. Every source except AI proposals was unscoped.

| # | Source (`ExceptionSources` key) | Table / module | Direct tenant column | Indirect ownership path | Nullable links | Before | Class | Rule now |
|---|---|---|---|---|---|---|---|---|
| 1 | `criticalDefects` | `maintenanceDefects` (+`units` label) | none | `unitId` (NOT NULL) → `coreRecordOwnership` | — | **unscoped** | **B** | unit owner. A dangling `unitId` is unresolved. |
| 2 | `roadsideOpen` | `roadsideServiceEvents` | none | `unitId` (NOT NULL) → unit owner | `jobId`, `tripId`, `operatorId` | **unscoped** | **B** | unit owner, and the job, trip and operator must agree when set |
| 3 | `vendorBills` | `vendorBills` (+`vendors` name) | none | `financialEntityId` (NOT NULL) → `financialEntities.orgRef`; `vendorId` (NOT NULL) → `vendors.bookOrgRef` | `unitId`, `jobId` | **unscoped** | **B** | entity owner **and** vendor book owner (the vendor's name is shown), and the unit and job must agree when set |
| 4 | `purchaseRequests` | `purchaseAuthorizations` | none | `financialEntityId` (NOT NULL) | `vendorId`, `unitId`, `jobId` | **unscoped** | **B** | entity owner, and the vendor, unit and job must agree when set |
| 5 | `credentials` | `complianceDocuments` (+`operators`/`units` labels) | none | by `ownerType`: operator → `coreRecordOwnership`; unit/trailer/equipment → unit; job → `jobs.orgRef`; user → membership | — | **unscoped** | **B**, with carrier as **D** | see §3.2. `carrier` has no ownership model and is unresolved. |
| 6 | `aiProposals` | `assistantProposals` | `tenantId` (0185) | — | — | scoped (AIL-1A) | **A** | strict `tenantId = acting`. `legacy_unresolved` is shown to nobody. |
| 7 | `aiQuestions` | `assistantQuestions` | none | `proposalId` (NOT NULL) → `assistantProposals.tenantId` | `askedToUserId` | **unscoped** | **B** | the proposal's proved owner. A question on a legacy or missing proposal is shown to nobody. |
| 8 | `syncConflicts` | `syncConflicts` | none | `fieldDeviceId` (NOT NULL) → `fieldDevices.orgRef` (stamped at enrolment) | `syncPackageId` → the package's device | **unscoped** | **B**, with legacy as **D** | see §3.3 |
| 9 | `revokedDevicesWithQueue` | `fieldDevices` ⋈ `syncPackages` | `fieldDevices.orgRef` (nullable) | — | — | **unscoped** | **A**, with legacy as **D** | strict `orgRef = acting`. An unstamped device is shown to nobody. |
| 10 | `measurementDevices` | `measurementDevices` (+`calibrationEvents`, keyed to the in-scope devices) | none | `financialEntityId` (NOT NULL) | — | **unscoped** | **B** | entity owner. Status, serial and calibration state are read only for in-scope devices. |
| 11 | `openCalibrationSweeps` | `calibrationSweeps` ⋈ `measurementDevices` | none | `measurementDeviceId` (NOT NULL) → device → entity | — | **unscoped** (LEFT JOIN) | **B** | the device's entity owner. A sweep on a missing device is shown to nobody (now an INNER JOIN). |
| 12 | `insurancePolicies` | `insurancePolicies` | none | `financialEntityId` (NOT NULL) | — | **unscoped** | **B** | entity owner |
| 13 | `carrierProfileReviews` | `carrierProfileReviews` | none | `financialEntityId` (NOT NULL) | — | **unscoped** | **B** | entity owner. The latest-50 window is now taken *after* scoping, so another organization's reviews can no longer crowd out yours. |
| 14 | `inspectorRequests` | `academyInspectorRequests` | none | `subjectUserId` (NOT NULL) → membership; `certificateId` (NOT NULL) → holder → membership | — | **unscoped** | **B** | the subject's organization, and the certificate holder's organization must agree. A subject in two organizations is unresolved. |
| 15 | `securityIncidents` (+`privacyBreachAssessments`, `incidentNotificationObligations` by incident id) | `loadOpenSecurityIncidents` | `orgRef` NOT NULL, stamped with the acting tenant | — | — | **unscoped** | **A** | strict `orgRef = acting` |
| 16 | `facilityDirectory` | `facilities` / `facilityEvidence` / `facilitySourceLicences` | — | — | — | global | **C** | **intentionally GLOBAL**: public directory rows (`facilityKey`) and confirmed public licences only. The operator's own submissions are excluded. |
| 17 | `ungatedAssignments` | `jobUnits` ⋈ `dispatchEligibilityChecks` (`dispatchEnforcementService.loadUngatedAssignments`) | check `orgRef` (nullable) | `jobId`, `unitId` (NOT NULL) | `operatorId`, `eligibilityCheckId` → check owner (`checkInScope` rule: NULL = single tenant) | **unscoped** | **B** | job **and** unit owners, with the operator and check agreeing when set |
| 18 | `statementsWithFindings` | `fuelStatements` (+lines) (`periodCloseService.loadFuelLineFindings`) | none | `financialEntityId` | — | **unscoped** | **B** | entity owner |
| 19 | `tanksOutOfTolerance` | `bulkFuelTanks` (+readings, dispenses) | none | `financialEntityId` | — | **unscoped** | **B** | entity owner |
| 20 | `periodsSoftClosed` | `periodCloses` | none | `financialEntityId` | — | **unscoped** | **B** | entity owner |

**Same sources reached through the inbox and My Day.** `loadInbox` read the purchase-approval queue
and the sync-conflict queue unscoped, and `myDay` composes the inbox. These now use the same rules
(#4 and #8). "My requests" uses rule #4 too. "My questions" is addressed to the caller and uses
rule #7. The Exception Centre's conflict deep link resolves through `sync.resolveConflict`, which now
applies rule #8 and returns "not found" for anything else.

**Caller and authorization.** Every source reaches users only through `surfaces.exceptions`
(`surface.exceptions.read`) and `surfaces.myDay`, and the inbox slices through `surfaces.inbox`.
The widget board (`widgetSources.ts`) calls `surfaces.exceptions` through the caller. After
scoping, `visibleTo` still filters each item by its `requiredPermission`. **Scope decides whose
record it is; authorization decides who may act on it.** No role permission was changed.

## 3. Ownership rules that needed a decision

### 3.1 No NULL-means-global, and no silent assignment

- `NULL` in an owner column means "the historical single tenant" only where the repo already
  defines it so: `jobs`, `trips`, `financialEntities`, `vendors.bookOrgRef`,
  `dispatchEligibilityChecks`, and a unit or operator with no `coreRecordOwnership` row. Those rows
  are shown to the default scope and to no organization. This is the 0132/0146 rule that AIL-1A.1
  already relies on.
- Where a stamp is **written on every row** (`fieldDevices.orgRef` since enrolment stamped it,
  `assistantProposals.tenantId`), a missing stamp proves nothing. Those rows are shown to nobody.
- No historical record was reassigned. No backfill, no migration.

### 3.2 Credentials and people in more than one organization

The repo's membership semantics are those of `resolveActingScope`: memberships that are active and
in effect now. A `user` credential (a person with no operator record; see `workforceRouter.ownerFor`)
resolves as follows:

| Memberships in effect | Owner |
|---|---|
| none | the single tenant |
| exactly one organization | that organization |
| two or more organizations | **unresolved: shown to nobody.** Picking one would decide, silently, which company sees the person's credential. |
| user id names nobody | unresolved |

Operators are employment records owned through `coreRecordOwnership`, and an operator credential
follows that. The exception's status (needs review, expiring) is therefore organization-scoped
along with the credential. An inspector request (#14) uses the same person rule.

### 3.3 Sync conflicts: provenance

`syncConflicts` has no tenant column. The record it names (`recordType`/`recordRef`) is checked
against `SERVER_VERSIONS`, an in-memory registry rather than a table, so it has no resolvable
owner. Provenance is therefore the device that uploaded the package:

- `fieldDevices.orgRef` is stamped by `deviceRouter.enroll` from the acting scope (`default`
  included). A device with `orgRef` NULL predates the stamp. Its conflicts are **unprovable**, and
  they are shown to nobody, the default scope included.
- When the conflict records its package, that package's device must be the same organization's. A
  package with no device, or one from another organization's device, makes the conflict
  unresolved.

### 3.4 Intentionally GLOBAL

Only the facility directory (#16). No other Exception Centre source is global.

## 4. Behaviour changes

1. Every Exception Centre, My Day and inbox-queue item is the caller's organization's. Members of
   the default scope no longer see organizations' records, and organizations no longer see each
   other's.
2. Records with an unresolved owner disappear from the Exception Centre for everyone: dangling
   links, unstamped legacy devices, conflicts from such devices, questions on unresolved proposals,
   carrier credentials, credentials and inspector requests about people in two organizations, and
   rows whose links name two organizations. **Nothing in this checkpoint routes them anywhere
   else**, so a person must find them through the owning record's own screen until a
   platform-level review exists.
3. `loadExceptionSources(now, scope)`, `loadUngatedAssignments(scope)` and
   `loadFuelLineFindings(scope)` require a scope. There is no unscoped call.
4. `surfaces.exceptions` refuses unknown input fields (`.strict()`). A forged `tenantId`, `orgRef` or
   `organizationId` is BAD_REQUEST, not silently dropped.
5. A caller with live memberships in two organizations gets an error from `exceptions` and `myDay`
   (`AmbiguousOrganization`), not a merged view.
6. `sync.resolveConflict` treats another organization's conflict, or an unprovable one, as not found.
7. Per-source limits now apply after scoping, so another organization's volume cannot push yours
   out of the window.

## 5. Tests

**`server/exceptionCentreTenancy.db.test.ts`: 26 cases.**

Fixture: organization A (a1, a2), organization B (b1), a person in both, and real units, operators,
jobs, trips, financial entities, vendors, devices and proposals.

| Case | Proves |
|---|---|
| coverage | the set of sources `loadExceptionSources` returns equals the set the test checks, so a new source fails until it gets a rule and a case |
| one per source (×19) | A's record reaches a1 and a2, not b1. B's reaches b1, not A. Every unresolved or mixed-organization record reaches neither, nor the default scope. See the list below. |
| credentials detail | a person's own credential is their organization's, a trailer is its unit's, a job's is the job's |
| owner resolution | unowned → `default`; dangling unit or user → unresolved; two memberships → unresolved; unstamped device → unresolved; unproved proposal → unresolved |
| combined surfaces | none of B's references appear anywhere in a1's `exceptions`, `myDay` or `inbox` JSON; A's do; the inbox conflict and approval slices carry A's and not B's |
| forged organization | `{tenantId}`, `{orgRef}`, `{organizationId}`, `{scope}` in the request are refused |
| multi-organization caller | `exceptions` and `myDay` fail rather than merge |
| resolve conflict | A cannot resolve B's conflict; nobody can resolve an unstamped device's; B can resolve its own |

Unresolved and mixed cases per source:

- **defect:** missing unit.
- **roadside:** A's unit with B's job, B's trip or B's operator; a missing unit.
- **bill:** A's entity with B's vendor, B's unit or B's job; a missing entity.
- **purchase:** A's entity with B's job, B's vendor or B's unit; a missing entity.
- **credential:** missing unit; carrier; person in two organizations; missing user; missing operator.
- **question:** legacy proposal; missing proposal.
- **conflict:** unstamped device; A's device with B's package; A's device with a package that has no device; missing device.
- **revoked device:** unstamped.
- **measurement device, policy, review, statement, tank, period:** missing entity.
- **sweep:** missing entity's device; missing device.
- **inspector:** subject in two organizations; A's subject with B's certificate holder; missing subject.
- **assignment:** A's job with B's unit; B's operator; B's check; a legacy (NULL) check; a missing job.

**Existing tests updated (fixtures only, no assertion loosened).**

- `academyTdgWiring.db.test.ts`: the learner now works in the office's organization and has a
  `users` row. Before, they were in different organizations, which is exactly the leak.
- `periodClose.test.ts`: the financial entity now exists.
- `securityIncidents.db.test.ts`, `destinationAcceptance.db.test.ts`: pass the actor's acting scope.
- `learningScope.db.test.ts`: "no scope → no proposals" became "a call with no scope fails"
  (`@ts-expect-error`, plus a runtime rejection).

### 5.1 Mutation checks

Each protection was reverted temporarily and the suite run. Every one failed the suite, and the code
was restored. A diff check confirmed the restore.

| # | Reverted protection | Failures |
|---|---|---|
| M1 | defect scope removed | 1 |
| M2 | optional links ignored (mixed-organization rows admitted) | 5 |
| M3 | a person in two organizations attributed to one | 3 |
| M4 | unstamped device treated as the single tenant's | 2 |
| M5 | dangling unit treated as unowned | 4 |
| M6 | credential scope removed | 2 |
| M7 | carrier credential treated as unowned | 1 |
| M8 | question scope removed | 2 |
| M9 | sync-conflict scope removed (centre and inbox) | 3 |
| M10 | calibration-sweep scope removed | 2 |
| M11 | inspector-request scope removed | 2 |
| M12 | security-incident scope removed | 1 |
| M13 | ungated-assignment scope removed | 1 |
| M14 | soft-closed periods unscoped | 2 |
| M15 | inbox approvals unscoped | 1 |
| M16 | `resolveConflict` unscoped | 1 |
| M17 | forged-organization input silently dropped | 1 |
| M18 | vendor link not checked on bills | 1 |

## 6. Found but not changed (outside the Exception Centre)

These were found during the survey. They are recorded for owner decision and were not widened into
this checkpoint.

1. **`loadInbox` tasks and notifications** show rows with `tenantId` NULL to every organization's
   role holders. This is a deliberate v22.20 choice ("legacy rows predate the column"), and it is
   NULL-means-global for role-addressed items. **Owner decision needed.**
2. **`listComplianceDocuments` / `reviewComplianceDocument`** still use the older
   `documentOwnerOrg`, where `user`, `carrier` and dangling subjects fall to the default scope.
   That is under-attribution, not cross-organization exposure between members, but the default
   scope can see a B member's `user` credential there. It should adopt `credentialOwner`.
3. **`academy.inspectorRequestCreate`** accepts a certificate from any organization. **`period.close`**
   and **`fuel.statementImport`** accept a `financialEntityId` without checking that it exists or is
   in scope (the period-close fixture showed this). These are write-integrity issues.
4. **`automationPolicyExceptions`** has no production caller, so nothing was scoped.
