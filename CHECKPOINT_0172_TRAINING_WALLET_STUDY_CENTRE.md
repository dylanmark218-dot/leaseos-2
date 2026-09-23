# Checkpoint 0172 — Training Wallet, Renewal, External Handoff, Commercial Driver Study Centre

Branch `claude/training-academy-workforce-q3mdse` · starting commit `0060690` (main at the start of the work) · UNRELEASED (release label unchanged at v23.25)

LeaseOS may educate, prepare, document, remind, coordinate and verify. It never
manufactures an external credential, and study never stands in for government,
licensed or approved training. This checkpoint extends the existing Academy and
qualification store; it adds no second LMS, qualification store, readiness engine,
calendar or notification system.

## 1. What existed, and what was reused

| Area | Found | Reused as |
|---|---|---|
| `workerQualifications` + `qualificationValidity.countsAsHeld` | Canonical holding store read by readiness, open shifts, crews, calendar. **No production code wrote it.** | **The wallet.** Record/verify/reject/supersede now write it; 0173 freezes verified history. |
| `academyQualifications` | Academy-issued certificates (TDG employer, company) | Unchanged; shown in the wallet beside external credentials. |
| `trainingAcademy.ts` assessment engine | Version-locked final assessments | Extended with `PRACTICE`, `MOCK_EXAM`, `COMPETENCY_KNOWLEDGE` kinds, domain-stratified mock draws, weak-area report. |
| `academySourceRecords` + `sourceReview` | Source registry with review gate | Extended into the Study Library (kind, licence status, retrieval date, content hash, capabilities, reviewer-confirmed redistribution). |
| `trainingAcademyRegulatory` (REG-TDG-ROAD-V1) | Server-computed TDG road expiry | Referenced by the TDG renewal policy; never duplicated. |
| `driverTraining.ts` | Licence/Q/restriction evaluator | Kept. C1LP hours corrected to the 2026-09-01 official values. |
| Exception Centre / Inbox / My Day | Read-time projections; inbox reads `workflowNotifications` | Wallet/handoff exceptions derived at read time; reminders delivered as `workflowNotifications` (unique `notificationKey` = idempotency). |
| Calendar | Pure projection with mandatory `source` | Handoff appointments, course due dates and company review dates projected from their owning records. |
| `vendors` | Tenant-scoped vendor identity | Training providers **are** vendors; only a capability tag table was added. |
| `evidenceGrounding` (verifyClaim/verifyAnswer) | Assistant grounding | The study tutor is built on it. |
| `academyAuditEvents` | Hash-chained audit | Wallet, handoff, provider and sweep history written to the same chain. |

## 2. Migrations

Active branches claim 0169 (`defect_resolution`), 0170 (`dispatch_role_types`, `organization_scoped_role_grants`) and 0171 (`dispatch_role_assignment_events`), so this checkpoint starts at **0172**.

- `0172_training_wallet_renewal_handoff.sql`
- `0173_wallet_history_guards.sql` (trigger DDL only, as the runner requires)

### Tables added (5)
`credentialRenewalPolicies`, `credentialCompanySettings`, `trainingProviderCapabilities`, `externalTrainingHandoffs`, `academyQuestionBookmarks`.

### Tables changed
- `workerQualifications`: displayName, issuer, issuingJurisdiction, endorsementsJson, restrictionsJson, walletBoundary, verificationMethod, verificationSource, backDocumentRef, privateNotes, supersedesHoldingRef, policyRef, handoffRef.
- `academySourceRecords`: sourceKind, licenceStatus, licenceNote, retrievedAt, contentHash, capabilityCodesJson, redistributionConfirmedByUserId/At.
- `academyAssessments`, `academyAssessmentAttempts`: assessmentKind.
- `academyQuestions`: sourceRef, sourceSection. `academyModules`: sourceRef, sourceSection, companySpecific.
- `academyAssignments`: selfEnrolled, lastModuleCode, lastViewedAt.

### Triggers (0173)
- A verified holding's facts (user, code, dates, number, verifier, restrictions, endorsements) are immutable; it may only become `superseded`, and only with the replacing holding named.
- Rejected/superseded holdings cannot change. Verified/rejected/superseded holdings cannot be deleted.
- `externalTrainingHandoffs` rows cannot be deleted (cancel instead).

## 3. Procedures

### `trainingWallet.*` (new router, 20)
myWallet, recordOwn, recordFor, verify, reject, personWallet, operationalView, policies, settingsGet, settingsSet, renewalSweep, requestTraining, myHandoffs, handoffSelfUpdate, handoffQueue, handoffUpdate, providerOptions, providerCapabilitySet, complianceDashboard, pathway.

### `academy.*` (13 added)
studyCentre, studyEnroll, moduleResume, practiceOpen, practiceAnswer, practiceSubmit, practiceHistory, missedQuestions, bookmarkToggle, bookmarks, studyLibrary, tutor, sourceConfirmRedistribution.

### Changed
- `academy.assessmentOpen` opens only the `FINAL_INTERNAL` assessment; `assessmentSubmit` refuses a practice/mock attempt.
- **`academy.practicalSignoff` and `academy.certificateIssue` now require a passed `FINAL_INTERNAL` attempt.** Before this, any passed attempt on the assignment counted — which would have let a practice or mock pass stand in for theory once practice existed.
- `academy.dispatchCheck` and `composeReadiness` also consult verified wallet holdings through the canonical rule (with Q's parent licence and the requirement's `interprovincial` condition), and report unverified / expired / restricted with a recovery path.
- `academy.syncCatalog` publishes a seed's new version beside the old (old retired, never edited) and installs practice/mock assessments and credential policies.
- `surfaces.exceptions` / `surfaces.myDay` drop tenant-tagged exceptions that belong to another organization (the new wallet/handoff items are tagged).
- `calendar.*` projection: Q no longer appears as "no expiry recorded"; company review dates are labelled company policy; certificate numbers are no longer put in the operational event detail.

## 4. Permissions

Added: `training.wallet.read_own`, `training.wallet.record_own`, `training.handoff.request_own` (universal — self-scoped in code); `training.wallet.manage`, `training.wallet.verify`, `training.handoff.manage`, `training.provider.manage` (separate provider-directory permission), `training.compliance.read`.
Fail-closed (sensitive): `training.wallet.verify`, `training.wallet.manage`, `training.provider.manage`.
Grants: safety and management — all five manage permissions; hr — manage, verify, handoff, compliance read; office — handoff manage, provider manage. Dispatch uses the existing `dispatch.evaluate` for `operationalView` and gets no wallet documents or notes.

## 5. Renewal behaviour

Policies are seeded, hashed source records (`credentialLifecycle.CREDENTIAL_POLICIES` → `credentialRenewalPolicies`). A policy says which *kind* of date governs a credential; it never supplies an expiry the certificate does not carry.

| Credential | Lifecycle | Reminders |
|---|---|---|
| TDG road | server_profile_expiry (REG-TDG-ROAD-V1, 36 months) | Yes — the sweep and Exception Centre read current Academy-issued certificates (`academyQualifications`, read-only) at their server-computed expiry. The wallet cannot verify one into existence. No air profile exists to borrow from. |
| WHMIS | employer_review | Only if the company sets a review interval — labelled "Company policy … not a legal expiry". |
| First Aid | actual_expiry (typical 36 months shown as context) | Yes, from the verified certificate's own date. |
| H2S Alive | actual_expiry (typical 36 months as context) | Yes. Blended renewal shown only while the verified certificate is current, as "UNKNOWN — verify with provider". |
| Air Brake Q | no_expiry_endorsement | **None.** Held only while a verified, current licence is held. |
| Class 1–4 licences | actual_expiry + restrictions | Yes. A provincially restricted Class 1 fails `interprovincial` requirements. |
| Medical fitness | actual_expiry | Compliance fact only; no medical detail stored. |

Thresholds default to 120/90/60/30/14/7/1 days + expired and are company-configurable. Keys are `cred-renew:{holding}:{dateKind}:{threshold}:{recipient}`; a second sweep sends nothing. Escalation: employee at every threshold; safety and HR roles at ≤30 days/expired; a dispatch-category exception at ≤14 days when an active requirement names the code. **There is no scheduler in the repository**; the sweep runs from the Compliance dashboard button or `trainingWallet.renewalSweep`. Exceptions are computed live regardless.

## 6. External training handoff

States: ACTION_REQUIRED → REQUESTED → ADMIN_REVIEW → PROVIDER_SELECTED → BOOKING_IN_PROGRESS → BOOKED → TRAINING_COMPLETED → DOCUMENT_PENDING → DOCUMENT_UPLOADED_UNVERIFIED → VERIFIED → ACTIVE, plus CANCELLED / EXPIRED / NOT_REQUIRED / UNKNOWN.
Employees request (for themselves), cancel, mark training complete and upload. Everything else is an admin move. VERIFIED/ACTIVE require a linked holding the wallet verified; ACTIVE additionally requires the canonical rule to count it as held. Nothing in readiness reads a handoff.
Admin queue shows employee, credential, current expiry, reason, latest verified certificate, official directory links and company providers (kept separate), required-by date, dispatch impact and requested date.

## 7. Study Centre, practice banks, library

Tracks (all `external_track_only` unless noted, jurisdiction-aware, version-locked):

| Course | Version | Modules | Original practice questions |
|---|---|---|---|
| AB-COMMERCIAL-FOUNDATION | 1 | 7 (1 company-specific, labelled) | 28 |
| CLASS3 | 2 | 6 (2 company-specific, labelled) | 15 |
| AIRBRAKE-Q | 2 | 5 | 25 |
| CLASS2 | 2 | 4 | 12 |
| CLASS1 (+ C1LP tracker) | 2 | 4 | 15 |
| CLASS4 | 1 | 2 | 8 |
| COMPANY-FIELD (company_certificate, practical required) | 1 | 5 | 12 |

Every question names its source and chapter/section and is an original LeaseOS question written against the official guide — not a government test question. Each track gets PRACTICE (instant feedback, explanation, source section, "study this topic", bookmarks) and MOCK_EXAM (randomized, domain-stratified, weak areas, history) assessments.

Study Library seeds (all **unreviewed**): Alberta Driver's Guide (2026), Commercial Driver's Guide (Spring 2025; PDF sha256 `9bc07d70…2926` recorded; publisher states Open Government Licence – Alberta), Class 1 Learning Pathway, C1LP online learning system, Air Brake Program, upgrade to commercial licence, licensed driver training schools, driver medical fitness, Alberta approved first aid training agencies, Energy Safety Canada H2S Alive, Transport Canada TDG training, CCOHS WHMIS education and training, company field-procedures template. Existing TDG/ERG/WHMIS/company sources unchanged. No publication was copied into LeaseOS; an offline copy requires a reviewed source **and** a reviewer's redistribution confirmation.

Tutor ("Explain this section"): extractive and retrieval-grounded over the course version's lesson passages, verified with the shared `evidenceGrounding` rule. Only passages from **reviewed** sources can support an answer; otherwise the answer is `UNKNOWN — refer to authority` with the official link. It refuses to say a learner passed an official test, to issue a credential, or to call study text law. No language model is called.

Career pathways: Swamper → Class 3 driver; Class 3 → full Class 1. Government eligibility and experience steps read `UNKNOWN — VERIFY WITH AUTHORITY`; a restricted Class 1 does not complete the full-Class-1 step.

## 8. Client

`client/src/pages/TrainingAcademy.tsx` gains tabs: My Wallet, Driver Study Centre, Study Library, Career Path, Training Compliance (shown only when the caller can read it), plus the tutor under each assignment and resume-where-you-left-off. New presentational `client/src/pages/TrainingWalletView.tsx`: 48px touch targets, theme tokens for dark/light, visible source/edition on lessons and answers, boundary notices, read-aloud via the browser's speech synthesis where available. No native encrypted offline storage is claimed.

## 9. Tests

- `server/_core/credentialLifecycle.test.ts` — 31 pure tests.
- `server/trainingWallet.db.test.ts` — 9 router tests on a migrated database.
- `client/src/pages/TrainingWalletView.dom.test.tsx` — 7 DOM tests.
- `client/src/a11y/a11y.dom.test.tsx` — six new surfaces (wallet, study centre ×2, tutor, pathway, compliance) run through the axe WCAG A/AA rules at all three viewports.
- Extended/re-pinned with the reason in the diff: `trainingAcademy.test.ts` (catalog 14 courses / 269 questions), `recordsAuthorization.test.ts` (universal list +3), `procedureAuthorization.test.ts` and `operationalApiAuthorization.test.ts` (629 → 662 declared), `crossLayerIntegrity.test.ts` (690 → 723 router paths), `tenantIsolation.test.ts` (19 → 21 tenant tables; its parser now also sees tables declared with an index callback), `a11yCoverage.test.ts`.

Required-list coverage: 1 (pure + DB), 2 (pure + DB), 3 (pure + DB), 4 (pure + DB + trigger), 5 (pure), 6, 7 (pure), 8, 9, 10, 11, 12 (pure), 13 (pure + DB), 14 (pure + DB), 15 (DB, with an evaluator-holding learner so the refusal is the self-sign-off rule), 16 (DB: wallet, operational view, verify, handoff update/queue, provider capability, exceptions, dashboard), 17 (pure + DB), 18 (pure + DB), 19 (pure + DB), 20 (DB: projected event carries the handoff reference; no calendar write procedure exists), 21 (pure + DB), 22 (pure + DB), 23 (DB), 24 (pure + DB).

## 10. Gate results

Environment: MariaDB 10.11.14 (the CI image version), Node 22, `pnpm install --frozen-lockfile`.

| Run | Result |
|---|---|
| Baseline `scripts/ci-gate.sh` at `0060690` before any change | PASS — 311 files, 4309 passed, 3 skipped |
| Final `scripts/ci-gate.sh` on this branch, clean database | **PASS** — gates 0–8 all green |

Final run detail: migrations 0000→0173 applied to an empty database; table parity 413 = 413; `tsc --noEmit` clean; test-file type errors 0 (ceiling 0); bare `protectedProcedure` 0; **314 test files passed, 4374 tests passed, 3 skipped** (the same 3 as baseline), no database-backed suite skipped; `pnpm build` succeeded; summary tables 413 / migrations 167 / role-authorized procedures 679; externally-gated 36; integration-gated 2; current-state document regenerated by `scripts/current-state.sh` and reported `current`.

Two intermediate full-gate runs failed and were fixed before the final run — recorded because each exposed a real defect:
1. Pins that had to move (procedure census, tenant-table list, a11y coverage), plus `academyTdgWiring`'s inspector test: its fixture named `assignmentId = 1` and inserted an attempt into columns that do not exist (error swallowed), so the "complete" branch had never run; once other suites created assignment 1, it ran and showed the package hash was not hex. Fixed by giving the fixture its own assignment and a real attempt, making the package hash SHA-256 hex, and counting only `FINAL_INTERNAL` attempts as the record of training.
2. A renewal recorded in the same second as the holding it replaces tied on `recordedAt`, and the canonical adapter could then treat the superseded holding as current. Fixed with a tie-break in `qualificationValidity` (superseded sorts first) and a pure test for both row orders.

`stableHash` itself still emits `-` in about half its 8-hex chunks. It was left unchanged on purpose: persisted hashes were made with it (the installed `REG-TDG-ROAD-V1` profile hash contains `-`), so correcting it would make every existing database refuse TDG certificate issuance on a profile-hash mismatch. It needs its own migration-aware change.

## 11. Not verified / honest limits

- Energy Safety Canada pages refused automated retrieval (HTTP 403) from this environment; the H2S facts (3-year validity, blended renewal needs a valid certificate) come from search results and are seeded **unreviewed** for a person to confirm.
- The Commercial Driver's Guide was read and hashed; the Driver's Guide 2026 was not downloaded. Practice questions cite chapters of the Commercial Driver's Guide and the C1LP page; they have not been reviewed by a safety professional, and every source is seeded unreviewed.
- Numeric air-brake values (cut-out 120–135 psi, etc.) are quoted from the Spring 2025 guide's trip air brake inspection; the guide itself says it has no legal authority.
- No scheduler exists to run the renewal sweep automatically; email/SMS/push channels are not wired (in-app only).
- Document upload itself goes through the existing Records vault; the wallet stores the evidence references. Native offline document storage is not implemented and not claimed.
- `stableHash` produces non-hex output (see §10); not changed here because persisted hashes depend on it.
- Pre-existing, not changed here: the Exception Centre loader is not tenant-scoped for older sources; `readiness.forTime` accepts any `userId` without a scope check (noted by the survey). `academyRequirements` are global, not per-tenant.
- Provider directory automation: none. Links to official directories and manual company provider records only.

## 12. Remaining work

Automatic sweep scheduling; email/SMS delivery; Saskatchewan/BC source sets and tracks; reviewer workflow UI for Study Library sources; a verifier UI inside the Compliance tab (the API exists); company-specific WHMIS workplace procedures content; Class 2/4 bus content review; tenant-scoping the older Exception Centre sources and `readiness.forTime`.

## 13. Rollback / recovery

- Code: revert the checkpoint commit(s) on this branch.
- Database: 0172/0173 are additive. To roll back a database that applied them, drop triggers `workerQualifications_history_update_guard`, `workerQualifications_history_delete_guard`, `externalTrainingHandoffs_delete_guard`; drop tables `credentialRenewalPolicies`, `credentialCompanySettings`, `trainingProviderCapabilities`, `externalTrainingHandoffs`, `academyQuestionBookmarks`; drop the added columns listed in §2. Dropping `workerQualifications` columns loses wallet facts recorded since 0172 — export them first. Newly published course versions (`CLASS1:2` etc.) can be set back to `retired` and the `:1` versions to `published`; no attempt rows need changing because attempts are bound to their own version.
