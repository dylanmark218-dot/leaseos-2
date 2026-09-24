# Checkpoint 0187 — Training Compliance Hardening + Automatic Renewal Operations

Branch: `claude/training-academy-workforce-q3mdse` · Release label unchanged: `LEASEOS_RELEASE` v23.25.

| | |
|---|---|
| Starting commit | `6e76007` (0172 checkpoint), merged with `origin/main` as `590fa23` before any change |
| Ending commit | see `git log` on the branch. The work was pushed as `7856aa0`, then merged with `origin/main` (`60f3899`) and its migrations renumbered 0174/0175 → 0187/0188 |
| Migrations | `0187_training_compliance_operations.sql`, `0188_source_review_history_guards.sql` (trigger-only) |
| New tables | 1: `scheduledJobRuns` |
| New procedures | 9 (4 `academy.*`, 5 `trainingWallet.*`) |
| New permissions | none; existing permissions reused |
| New worker | none; the renewal sweep ticker rides the existing drain worker's heartbeat |

## 0. Survey (done before implementing)

What existed and was reused. No second engine of any kind was added:

- **Validity:** `qualificationValidity.countsAsHeld` and `credentialLifecycle.heldForWork`. There is one rule. Dispatch, the wallet, the renewal queue and verification implications all call it.
- **Renewal planning:** `planRenewalReminders`, now fed an escalation ladder.
- **Notifications:** `workflowNotifications`. Its unique `notificationKey` is the idempotency guard.
- **Audit:** the Academy hash chain (`academyAuditEvents`), via `academyAudit`.
- **Scheduling:** `startProductionWorker` → `startDrainWorker`. Its `heartbeat` port ran the webhook retry sweep. There was **no lease, lock or job-run table**, and the webhook sweep runs on every instance with no ownership (reported below, not changed).
- **Two-person rule:** the inline "proposer may not approve" convention used by commercial office approvals and TDG coverage approval.
- **Exception Centre:** `deriveExceptions`, which is pure. `visibleTo` filters by permission and `forTenant` filters tenant-tagged items.

Findings that shaped the work:

1. **Tenant leaks (fixed, §1).** `loadExceptionSources` was unscoped for every source except the 0172 wallet ones. Security incidents, vendor bills, purchase authorizations, defects, roadside events, credentials, AI proposals and questions, sync conflicts, devices, calibration, insurance, fuel findings and inspector requests from **every** organization were loaded, then filtered only where items happened to carry a tenant tag.
2. **`readiness.forTime`** had no subject check at all.
3. **`readiness.forShift`**'s check was `!scope.tenantId`, which is always false.
4. **`shifts.eligibility`** scoped the post but not the person.
5. **Readiness ID-space confusion.** Readiness looked up `operators.id = userId`. A user id could match an unrelated operator row.
6. **`stableHash` is not a hex format** (it can emit `-`). Its values are persisted and some are recomputed and compared, so it is frozen (§8).
7. **Architectural conflict (not touched, reported).** Unmerged branch `claude/driver-portfolio-credential-wallet-ya8928` builds a second credential wallet on `complianceDocuments`. This line's wallet is `workerQualifications` behind the canonical rule. The two must not both merge.
8. **Migration numbering (resolved).** C1a moved its migration off `0172` to `0174` when it merged, so this branch keeps `0172`/`0173`. The register (`docs/architecture/MIGRATION_COLLISION_REGISTER.md`) confirms this. This checkpoint's migrations were first written as `0174`/`0175`. After main took `0174`, they were renumbered to `0187`/`0188`: the first numbers free on main and on every open branch (register scan, 2026-09-24). The checkpoint is named after its first migration, **0187**. Neither file was ever applied outside development/CI databases, so nothing in a ledger refers to the old names.

## 1. Tenant isolation fixes

Every Exception Centre source is now scoped **at the query, before limits**. The final JSON is not what gets filtered. `loadExceptionSources(scope: TenantScope)`:

| Source | Scoping |
|---|---|
| criticalDefects, roadsideOpen | `ownershipScopeWhere("unit", …)` |
| vendorBills, purchaseRequests, measurementDevices, openCalibrationSweeps, insurancePolicies, carrierProfileReviews | `financialEntityScopeWhere`: an organization sees rows on the entities it owns; the single tenant sees every row not on an organization-owned entity |
| statementsWithFindings, tanksOutOfTolerance, periodsSoftClosed | `loadFuelLineFindings(scope)`, same financial-entity rule |
| credentials | `complianceDocumentScopeWhere` (document owner's org) |
| aiProposals | job → trip → unit → default scope |
| aiQuestions, inspectorRequests | `memberUserScopeWhere` on the asked/subject user |
| syncConflicts, revokedDevicesWithQueue | join `fieldDevices` + `orgScopeWhere` |
| securityIncidents | `orgScopeWhere` |
| ungatedAssignments | `inArray(jobUnits.jobId, jobScopeSubquery)` |
| wallet renewals/unverified, trainingHandoffs | tenant column / holder's tenant |
| trainingSweepFailures | failure's tenant (an untenanted failure is shown without its subject) |
| facilityDirectory | global reference by design (shared directory) |

`EXCEPTION_SOURCE_TENANCY` (in `exceptionCentre.ts`) classifies every source: 21 org-scoped, 2 user-scoped, 1 global reference. A test parses the `ExceptionSources` type and fails if a new source is added without a classification.

Other scope fixes:

- **Readiness:** `forTime` and `forShift` call `requireSamePerson`, and a user outside the caller's organization is "not found".
- **`shifts.eligibility`:** the same check.
- **Operator lookup:** readiness resolves the operator by `operators.userId`. The legacy `operators.id` fallback applies only when that row has no `userId` **and** is inside the caller's ownership scope.

## 2. Automatic renewal sweep

- **One engine.** `runRenewalSweepForTenant` (`server/renewalOperations.ts`) is called by the Compliance tab button (`trainingWallet.renewalSweep`) and by the scheduler. It calls `planRenewalReminders` and `deliverReminders`.
- **No second scheduler.** `startProductionWorker` wraps the existing heartbeat port with `createRenewalSweepTicker` (once per slot per process, never throws). Settings: `RENEWAL_SWEEP_DISABLED=true` turns it off; `RENEWAL_SWEEP_SLOT_MINUTES` sets the slot length (default 60).
- **Multi-instance safety.** `scheduledJobRuns.slotKey` is unique, so exactly one INSERT per job slot wins. An owner that dies leaves a lease (`leaseUntil`, default 900 s) that expires. One other instance can then take the slot over with a conditional UPDATE that only one can win. Notification keys stay unique underneath, so a takeover cannot double-send.
- **Run record.** Each run records started, completed, lease, inspected, actionable, notifications created, suppressed, failure count, failures JSON (with tenant) and error summary. Status is `running`, `completed`, `partial` or `failed`.
- **Coverage:**
  - verified wallet credentials;
  - Academy-issued certificates (TDG road; read as holdings, never written to the wallet);
  - company review dates (WHMIS), labelled company policy and never "expired";
  - external-training deadlines (14/7/1 to safety/hr);
  - Q and other no-expiry endorsements get nothing.
- **Failures are visible.** `SweepFailureKind` covers TENANT_RESOLUTION_FAILED, POLICY_MALFORMED, LIFECYCLE_EVALUATION_FAILED, NOTIFICATION_WRITE_FAILED, SOURCE_RESOLUTION_FAILED and SWEEP_ABORTED. Each one becomes a **SYSTEM FAILURE** Exception Centre item: "…says nothing about whether the credential is valid; its status is unchanged." `signalFor` keeps SYSTEM_FAILURE, QUALIFICATION_EXPIRED and QUALIFICATION_UNKNOWN apart. A malformed company setting is reported, never silently defaulted away.

## 3. Escalation policy (company policy, not law)

- **Defaults:** 120 employee awareness · 90 employee · 60 + supervisor · 30 + safety/hr · 14 all, urgent · 7 and 1 critical · expired exception.
- **Configuration.** A company can set a different ladder per category (`safety_ticket`, `driver_licence`, `company_review`, `regulated_employer`, `medical`, `other`, `default`) via `trainingWallet.settingsSet({ escalation })`. It is stored in `credentialCompanySettings.escalationPolicyJson`.
- **Validation:** 1–730 days, widest first, and the employee is told at every step.
- **Labelling.** Every ladder carries `COMPANY_POLICY_LABEL`.
- **Supervisor.** The supervisor is the worker's active crew supervisor (`crews.supervisorUserId`).
- **Keys.** Notification keys keep the 0172 format, so existing idempotency holds.

## 4. Delivery boundary

- `DeliveryChannel` is IN_APP, EMAIL or SMS; each has a `DeliveryAdapter`. `deliverReminders` goes through `deliverAcross`.
- **In-app is canonical and is written first.** No email or SMS provider exists in LeaseOS, so those channels return `not_configured` and nothing pretends to send.
- **An external failure never removes or blocks the in-app row.** A suppressed (already delivered) notice is not re-sent externally.

## 5. Source review

- **Screen and data.** The Compliance tab's Source Review panel reads `academy.sourceReviewQueue`. Each row shows:
  - authority, title, jurisdiction, edition, URL and tier;
  - retrieved date;
  - fingerprint, labelled `sha256` or `legacy-stableHash`;
  - state and impact status;
  - proposer, first reviewer, last reviewer and when;
  - superseded-by and supersedes;
  - rejection reason;
  - what it governs: course versions, lessons, questions, renewal policies and regulatory profiles.
- **Actions** (`academy.sourceAct`): REVIEW, then APPROVE by a **different person** (same convention as elsewhere). The proposer may do neither, and a vendor or unknown tier is never trusted. REJECT does not apply to a reviewed source. MARK_SUPERSEDED requires a live successor. Every action requires a note of at least 10 characters and is audited on the Academy chain.
- **Legacy procedure.** `academy.sourceReview` now maps onto the same rule. A first "reviewed" moves the source to `under_review`; a second person's "reviewed" approves it.
- **Immutability (0188 triggers).** Once a source is reviewed, rejected or superseded, its authority, title, jurisdiction, edition, URL, tier and both fingerprints cannot change. A reviewed source may only move to superseded, naming a successor. Rejected and superseded are final, and deletes are refused.
- **New editions.** A new edition is a **new source**: `academy.sourceProposeVersion` creates `<ref>@vN`, starting unreviewed with a `sha256HexV1` snapshot. Old attempts stay bound to their course version.
- **Impact** (`academy.sourceImpact`, also returned on supersede) reports SOURCE_CURRENT, SOURCE_SUPERSEDED_REVIEW_REQUIRED, SOURCE_UNREVIEWED or SOURCE_REJECTED. **Nothing is auto-rewritten.**
- **Tutor.** It still quotes only `reviewed` sources. `under_review` and `unreviewed` sources are "where to look", and the answer is UNKNOWN / REFER TO AUTHORITY.

## 6. Credential verification

- **Queue.** "Uploaded — Verification Required" (`trainingWallet.verificationQueue`) is organization-scoped at the query. Each item shows:
  - employee, credential type, issuer and jurisdiction, number, and the dates as uploaded;
  - front/back documents and restrictions;
  - the previous verified credential;
  - implications: counts now, counts if verified, and the requirements that need it;
  - the handoff that produced it;
  - the correction state;
  - `callerMayAct` or the reason the caller cannot act (their own credential, or they recorded it).
- **Actions:** VERIFY (`verify`), REJECT (`reject`) and REQUEST_CORRECTION (`requestCorrection`). These are server procedures only.
  - Self-verification is FORBIDDEN, and so is verifying a credential you recorded.
  - A dispatcher lacks `training.wallet.verify` and is FORBIDDEN.
  - Another organization's holding is NOT_FOUND.
- **A verifier cannot edit evidence into validity.** A claimed issue or expiry date the verifier reads differently (compared by calendar day) is refused with "request a correction instead of changing it". A date the upload left blank is read off the document and audited.
- **Correction workflow.**
  1. `requestCorrection` records who asked, when and why, and sends the employee an in-app notice. It then blocks verification of that upload.
  2. The employee's `submitCorrection` creates a **new** unverified holding with `correctsHoldingRef`. The old upload becomes `rejected` ("replaced by corrected record …").
  3. Nobody else can submit it for them.

## 7. Handoff → certificate closure

- **Path:** BOOKED → TRAINING_COMPLETED → DOCUMENT_PENDING → DOCUMENT_UPLOADED_UNVERIFIED → VERIFIED → ACTIVE.
- **Linking an upload.** An upload that names no handoff links to the person's one open handoff for that code that is waiting on a certificate.
- **Closing on verify.** On verify, `closeHandoffForVerified` steps the handoff through `handoffTransition` (never by assertion). It sets `linkedHoldingRef` and audits each step. ACTIVE is set only when the canonical rule now counts the credential as held.
- **Completion alone creates nothing.** A test asserts no credential row exists after TRAINING_COMPLETED.
- **Readiness.** Handoff status never satisfies readiness. Readiness and dispatch read handoffs **only for explanation text**.

## 8. Hashing

`stableHash` is unchanged; tests pin its bytes. New integrity values use `sha256HexV1` (canonical JSON → SHA-256 → 64 lowercase hex) from `server/_core/integrityHash.ts`. Every `stableHash` call site is classified A–E in `docs/HASH_CLASSIFICATION.md`, together with a non-destructive migration plan: an algorithm tag column, dual verification, a new chain segment and no rewrite. The tests cover:

- legacy byte stability, including the persisted TDG/WHMIS profile and policy hashes;
- the hex format and key-order independence;
- a source scan that new 0187 integrity files do not use `stableHash`;
- the inspector package hash and new source snapshot hash use `sha256HexV1`;
- every call site named in the document.

## 9. Compliance Operations view, wallet, dispatch

- **Compliance tab queues:**
  - External Training (existing request queue).
  - **Renewal Queue** (`renewalQueue`): employee, credential, target date, days remaining, company-review vs expiry, readiness impact, handoff status, last reminder and next escalation.
  - **Verification Queue**.
  - **Source Review**.
  - **System Exceptions**: sweep failures from the Exception Centre, plus recent runs from `sweepRuns`.
- **My Wallet.** Each credential shows its status (VALID / EXPIRING / EXPIRED / UNVERIFIED / COMPANY_REVIEW_DUE / UNKNOWN) and, **separately**, the renewal in progress (RENEWAL_REQUESTED / BOOKED / AWAITING_DOCUMENT) with steps. Also shown:
  - "A renewal request or booking does not extend it."
  - A company review reads "Company policy review due … — not an expiry".
  - A correction request offers "Upload a corrected record".
- **Dispatch explanation.** No new readiness engine was added. `canonicalVerdicts` (readiness composer) and `trainingWallet.operationalView` add a handoff progress note to a **not-held** verdict only. Examples: "Renewal requested — awaiting booking", "Renewal booked for … — does not count until the new certificate is verified", "Certificate uploaded — Safety verification required". The verdict itself is unchanged and fail-closed.

## 10. Procedures and permissions

| Procedure | Permission |
|---|---|
| `academy.sourceReviewQueue`, `sourceAct`, `sourceProposeVersion`, `sourceImpact` | `academy.source.review` (safety, management) |
| `trainingWallet.verificationQueue`, `requestCorrection` | `training.wallet.verify` (safety, management, hr) |
| `trainingWallet.submitCorrection` | `training.wallet.record_own` (owner-only enforced in the handler) |
| `trainingWallet.renewalQueue`, `sweepRuns` | `training.compliance.read` |

Changed: `verify` (date rule, correction block, handoff closure), `settingsGet/Set` (escalation), `myWallet` (status fields, correction), `operationalView` (`renewalProgress`), `renewalSweep` (engine shared with the scheduler), `sourceReview` (two-person).

Pins updated with reasons: operational procedure map 662 → 671, router surface 724 → 733. The tenant-table pin is unchanged, because `scheduledJobRuns` deliberately has no tenant column (documented in the migration).

## 11. Client

- `client/src/pages/ComplianceOperationsView.tsx`: RenewalQueuePanel, VerificationQueuePanel, SourceReviewPanel and SystemExceptionsPanel, wired into the Training Compliance tab.
- `TrainingWalletView.tsx`: wallet statuses, renewal steps and the correction flow.
- All four new panels run through the axe suite at every viewport. DOM tests are in `ComplianceOperationsView.dom.test.tsx` and `TrainingWalletView.dom.test.tsx`.

## 12. Tests

New:

- `server/_core/complianceOperations.test.ts` (19 tests):
  - escalation defaults, validation and per-category ladders;
  - reminders by ladder, and no Q notices;
  - wallet statuses (company review never expired; a request never extends validity);
  - dispatch notes;
  - delivery boundary: external failure keeps in-app, not_configured, suppressed notices not re-sent;
  - two-person source rule and impact statuses;
  - SYSTEM_FAILURE vs QUALIFICATION_* signals, and the sweep failure → Exception item;
  - Exception source tenancy coverage.
- `server/integrityHash.test.ts` (11 tests): hashing (§8).
- `server/trainingComplianceOps.db.test.ts` (17 tests, real routers on a migrated DB), numbered to the checklist:
  1. cross-tenant Exception Centre (wallet, via service and router);
  2. forTime / forShift / eligibility with a guessed id;
  3. tenancy classification;
  4. ticker on the worker heartbeat records a run;
  5. two instances race — one owner, no duplicate notice;
  6. idempotent later slot;
  7. lease takeover (live refused, expired taken, completed not re-run);
  8. and 9. TDG Academy + wallet participation, company review language, Q none, renewal queue fields;
  10. injected failure → system exception, credential unchanged, still held, invisible to another org;
  11. escalation ladder validated, stored and used, and idempotent;
  12. verification queue contents and scope;
  13. self, dispatcher and cross-tenant verification denied;
  14. no editing into validity; correction round trip;
  15–17. handoff closure, auto-link, no credential from completion, audit trail;
  18. and 19. two-person approval audited, immutability and delete refusal;
  20–22. new version = new source (sha256), proposer can't review, tutor UNKNOWN for unreviewed, supersede impact rewrites nothing, superseded final;
  23. legacy `sourceReview` two-person;
  24. and 25. dispatch ignores requests and bookings, explanation present.
- The existing securityIncidents test gained an adversarial cross-org check.

Re-run: all academy, wallet, workforce, dispatch, readiness, exceptions, audit and authorization suites, as part of the full gate below.

## 13. Gate

`DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos bash scripts/ci-gate.sh` was run on a dropped and recreated database (MariaDB 10.11). Result: **PASS**.

| Step | Result |
|---|---|
| 0–3 | Reserved slots untouched; clean DB; all migrations applied (170 files); schema/migration table parity 414 = 414 |
| 4 | `tsc --noEmit` clean; test-file typecheck (`tsconfig.tests.json`): 0 errors (ceiling 0) |
| 5 | 0 bare `protectedProcedure` |
| 6 | **322 test files passed; 4546 tests passed, 3 skipped, 0 failed**; no database-backed suite skipped |
| 7 | Production build passed; 414 tables; 689 role-authorized procedures; 36 externally-gated; 2 integration-gated |
| 8 | `LEASEOS_CURRENT_STATE.md` regenerated and current |

**After merging `origin/main` (`60f3899`) and renumbering the migrations to 0187/0188**, the gate was run again on a recreated database. Result: **PASS**. Clean DB; all 174 migration files applied; table parity 416 = 416; `tsc` and test-file typecheck clean (0); **347 test files passed; 5079 tests passed, 3 skipped, 0 failed**; build passed; 694 role-authorized procedures; current-state regenerated and current. Procedure pins after the merge: operational map 676 (main 634 + 33 from 0172 + 9 here), router surface 738 (main 696 + 33 + 9).

The first full run on this tree failed 2 tests (`surfaces.test`, `periodClose.test`). Both came from this checkpoint's own money scoping, fixed as defect 10 below. The run above is the rerun after that fix.

## 14. Defects discovered and fixed

1. The Exception Centre loaded every organization's records for every non-wallet source (§1).
2. `readiness.forTime` had no person scope.
3. `readiness.forShift`'s scope check was always true.
4. `shifts.eligibility` read any user id.
5. Readiness `operators.id = userId` ID-space confusion.
6. The renewal sweep could only run by button. It now also runs on the existing worker heartbeat, with ownership.
7. A verifier could overwrite a worker's claimed dates while verifying ("editing into validity").
8. Single-person source approval.
9. Reviewed source facts were mutable, and sources were deletable.
10. Found by this checkpoint's own first full gate run: the first version of the money scoping (`IN (entities of the scope)`) hid single-tenant rows keyed to an entity id with no `financialEntities` row (`surfaces.test`, `periodClose.test`). It was replaced by `financialEntityScopeWhere` (default scope = "not on an entity another organization owns"). An adversarial test now shows org A's bill is invisible to org B and to the single tenant.

## 15. Unresolved (reported, not changed)

- **Competing credential wallet** on `claude/driver-portfolio-credential-wallet-ya8928` (`complianceDocuments`-based). One of the two must be dropped before either merges.
- **Webhook retry sweep** runs on every instance without a lock. It can move onto `scheduledJobRuns` the same way; not changed here to keep scope. `webhookDeliveries` has no unique (subscription, event, attempt).
- **`tdgCoverageApprove`** uses a `!= null` author guard that lets a null author pass the two-person check.
- **`siteCloseout` canonicalJson** serializes `Date` as `{}`.
- **Academy sources are platform-wide reference records** (no tenant column). A safety or management user of any organization can review a shared source. Two different people are still required, but they may come from different organizations. Deciding whether source review should be per-tenant, or restricted to a platform role, is a product decision.
- **Manual-button sweep failures** are returned to the caller and audited, but only scheduled runs are recorded in `scheduledJobRuns` and so surface as System Exceptions.
- **EMAIL/SMS:** no provider exists, so the adapters are declared and report `not_configured`.
- **`sourceReviewQueue`** computes impact per source (N+1 queries). This is fine for the tens of sources installed; paginate if the library grows.
- **Readiness when a sweep fails.** No readiness path consumes sweep state, so a sweep failure cannot produce READY. This is asserted indirectly (credential still held/expired per the rule after an injected failure). There is no separate readiness-composer fault-injection test.

## 16. Rollback

- **Code:** revert this checkpoint's commits. The 0172 behaviour returns, and nothing in 0172 depends on 0187 columns being absent.
- **Schema:** manual SQL is in the headers of `0187_*.sql` and `0188_*.sql` (drop the 0188 triggers first, then the table and columns, then remove the ledger rows).
- **Data safety:** nothing destructive was run. No hash was rewritten, no credential or source row was edited by a migration, and `scheduledJobRuns` is new.
- **Runtime-only rollback:** set `RENEWAL_SWEEP_DISABLED=true` to stop the scheduled sweep without a deploy.
