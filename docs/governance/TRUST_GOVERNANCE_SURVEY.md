# LeaseOS Trust & Governance — repository survey and architecture proposal

**Status: survey only. No production code, schema or behaviour was changed.**
Surveyed against `6f52b57` (this branch's HEAD, equal to `origin/main` at survey time, 2026-09-24).
Every file, table, procedure and migration named below was read in the tree at that commit; where a
root `LEASEOS_*.md` or `docs/register/*` document disagrees with the code, the code is reported and the
document is named as disagreeing. Nothing here is aspirational unless a status column says so.

The seven areas below were surveyed with targeted reads rather than a full audit of every router:
claims about "every procedure" are made only where a CI gate already proves them
(`scripts/ci-gate.sh` gates 5, 7b, 7c; `server/procedureAuthorization.test.ts`).

---

## 1. Repository survey

### 1.1 Authentication

| What | Where | Finding |
|---|---|---|
| Session token | `server/_core/sdk.ts:190-200`, `server/_core/oauth.ts:64-70`, `shared/const.ts:2` | JWT signed with `jose`; lifetime `ONE_YEAR_MS`; cookie `maxAge` one year |
| Cookie policy | `server/_core/cookies.ts:45` | `sameSite: "none"`; no CSRF policy documented (also listed in `docs/register/ROADMAP_2026-09-21.md` "Security, CI and ops") |
| Secret | `server/_core/env.ts:3` | `cookieSecret: process.env.JWT_SECRET ?? ""` — empty default; the roadmap's "production config validator" item 2 is not built |
| Revocation | `server/_core/sdk.ts`, `context.ts` | No server-side session revocation or token version. `createContext` treats any verification failure as anonymous (`context.ts:14-18`) |
| Principal shape | `server/_core/context.ts:4-8` | `TrpcContext.user: User \| null`. `users` has `id, openId, name, email, loginMethod, role: user\|admin` (`drizzle/schema.ts:3-12`). **No account status/suspension field.** |
| Identity provider | `sdk.ts:170-185` | Manus OAuth (`ENV.oAuthServerUrl`, `ENV.forgeApiUrl`); first admin via `OWNER_OPEN_ID` (`server/db.ts:126`) |
| Portal principals | `server/_core/trpc.ts:155-215` | `externalIdentities` (`schema.ts:4871`): hashed bearer token, 90-day TTL, 7-day invitation TTL, 10-minute rotation grace, lockout after 5 failures for 15 min (`externalIdentityPolicy.ts:12-16`), TOTP MFA on `EXTERNAL_SENSITIVE_PERMISSIONS`, `status: invited\|active\|suspended\|revoked`, `revokedReason` |
| Machine principals | `trpc.ts:222-250` | `integrationClients`: hashed key, `orgRef` required, `status`, `lockedUntil`, scopes JSON |
| Device principals | `server/_core/deviceSignature.ts`, migrations `0110`, `0157_signature_device_attestation` | Cryptographic device binding; canonical package signing with 10-minute skew |
| AI principal | `server/_core/actionGateway.ts:129` | `actor.type: "user" \| "agent" \| "system"` exists **only** in the action gateway request type; there is no agent principal in `TrpcContext` or in `authorize()` |

### 1.2 Authorization and role enforcement

There is **one** server-side authorization system, with three gates built to the same shape:

| Gate | File | Ledger row | Fail-closed rule |
|---|---|---|---|
| `roleProcedure(name)` | `server/_core/trpc.ts:71-130` | `authorizationDecisions` on **every** call, denials included | If the audit row cannot be written and the permission is in `SENSITIVE_PERMISSIONS` (125), the call is refused (`trpc.ts:108-117`) |
| `externalProcedure(name)` | `trpc.ts:155-215` | same table, `subjectType: externalIdentity` | same, over `EXTERNAL_SENSITIVE_PERMISSIONS` |
| `integrationProcedure(name)` | `trpc.ts:229-250` | same table, `subjectType: integrationClient` | same, over `INTEGRATION_SENSITIVE_PERMISSIONS` |

Core primitive: `authorize({ userId, grants, permission, resourceBranch? }): AuthorizationResult`
(`server/_core/recordsAuthorization.ts:~1985-2060`), returning
`{ allowed, outcome: "allowed" | "denied_no_role" | "denied_permission" | "denied_scope" | "denied_unauthenticated", effectiveRoles, detail? }`.
Deny beats grant across roles (`DENIALS` before `GRANTS`); universals granted after the denial sweep;
an unresolved resource branch with a branch-confined grant is `denied_scope`, never allowed.

Vocabulary: `Permission` union (355 members, `recordsAuthorization.ts:45`), `DomainRole` (15 roles,
`:26`), `UNIVERSAL_PERMISSIONS` (13), `SENSITIVE_PERMISSIONS` (125). An unmapped procedure name throws
at wiring time (`trpc.ts:70-76`). CI gate 5 pins bare `protectedProcedure` at 0; gates 7b/7c pin that
the portal mounts only `externalProcedure` and inbound only `integrationProcedure`.

Also present: `adminProcedure` keyed on `users.role === "admin"` (`trpc.ts:30-44`), used at 3 call
sites outside `trpc.ts` (system router). It is a second, coarser gate; it writes no ledger row.

Ledger shape (`schema.ts:3104-3119`): `actorUserId, procedureName, permission, rolesHeld, outcome,
subjectType, subjectId, detail(400), occurredAt`. **It carries no `orgRef`, no policy reference, no
policy version, and denials reach the client as prose in `TRPCError.message`** (`trpc.ts:119-128`).

### 1.3 Tenant / organization isolation

| Component | Where | Finding |
|---|---|---|
| Organizations and memberships | migration `0086`; `schema.ts:6837-6890` | `organizations.status: active\|suspended\|closed`; `organizationMemberships.status: active\|suspended\|ended`, `effectiveFrom/To` |
| Acting scope | `server/_core/actingScope.ts:64-104` | `resolveActingScope(db, userId)` → `{ tenantId, derivedFrom: "membership" \| "single_tenant_fallback", membershipRef, branchRefs, global }`. Two active memberships → `AmbiguousOrganization` thrown. **Zero active memberships → falls back to `SINGLE_TENANT_ID = "default"`.** Used by 31 server files |
| Role scope | `userRoleAssignments.scopeType: global \| branch` | No organization scope (`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` §2 confirms; branch `claude/leaseos-auth-workspace-system-t008ad` claims `0170_organization_scoped_role_grants.sql`) |
| Row ownership | `0113 core_record_ownership`, `0132 jobs_trips_org_scope`, `0134 organization_record_links`, `0146-0149` | `orgRef` nullable; NULL = historical single tenant. Cross-org relationship model exists as `organizationRecordLinks` and `jobs.customerOrgRef` |
| Cross-boundary answer | e.g. `server/routers.ts:592`, `recordsRouter.ts` disposition | NOT_FOUND, never FORBIDDEN |
| AI context | `server/_core/contextAdmission.ts`, `contextAssembly.ts` | Admission blocks carry a tenant proof; a cross-org reference answers as a missing one |
| Status | `LEASEOS_CURRENT_STATE.md:995-1003` | "Organization-wide isolation is NOT yet a property this system has" — while `docs/REMAINING_BUILD_REGISTER.md` P4.1 reads **DONE (v22.52)**. The two documents contradict each other; the code supports CURRENT_STATE |

### 1.4 Audit / event ledgers, outbox

Thirty-plus append-style tables (`safetyEvents, signatureAudits, manifestCustodyEvents,
fieldTicketEvents, dispatchRoleAssignmentEvents, dispatchAuditEvents, assistantCommitReceipts,
syncReceipts, evidenceAccessEvents, roleBootstrapEvents, externalAccessLog, videoAccessLog,
enforcementEvents, restrictedAccessEvents, securityIncidentEvents, hosRuleLimitHistory, ...`).
There is **no single canonical audit ledger**; `authorizationDecisions` is the only universal one.

Append-only is enforced by database trigger in exactly six migrations (`0061`, `0062`, `0108`,
`0121`, `0126`, `0130`); everywhere else it is an application convention plus tests.

Outbox: `domainEventOutbox` (`schema.ts`, migration `0089`): `eventId, eventType, eventVersion,
aggregateType/Id, tenantId (NOT NULL), actorSource: human|system|ai|integration, actorUserId,
payloadJson, claimedAt/retryAvailableAt/deadLetteredAt` lease model; written inside domain
transactions on the enforcement path (`LEASEOS_CURRENT_STATE.md:262-268`). **No production writer
sets `actorSource: "ai"`** (grep over `server/` finds only `"human"` and pass-through variables).

### 1.5 Reason codes and error conventions

`shared/_core/errors.ts` holds only `HttpError` and four HTTP constructors. There is no shared reason
code catalog. `reasonCode`/`code` strings exist locally in seven modules (`dispatchReadiness.ts`
`DispatchBlocker.code` such as `hos_insufficient`, `critical_defect`; `actionGateway.ts`
`ComplianceVerdict.reasonCodes`; `destinationAcceptance.ts`; `facilityCompatibility.ts`;
`billingAdjustment.ts`; two routers). The client renders `error.message` in toasts
(`client/src`, 20+ sites) and reads only the tRPC `code` in one place
(`client/src/dispatch/DispatchJobDetail.tsx:121`).

### 1.6 Policy / rule versioning precedents (the strongest reuse candidates)

| Precedent | Shape | Why it matters |
|---|---|---|
| `oosReleasePolicies` (`0084`, `schema.ts:6837`) | `policyRef, tenantId, version, scopeType company\|branch\|terminal, status proposed\|approved\|superseded\|rejected, supersedesPolicyRef, proposedByUserId ≠ approvedByUserId, effectiveFrom/To, rationale`; scope written only via `mayScopePolicyTo` (`actingScope.ts:108+`) | A versioned, two-person, effective-dated, superseded-not-overwritten policy row with tenant from server context. This is the template for governance policy rows |
| `automationPolicies` + `resolveAutomation()` (`0153/0154`, `automationPolicy.ts`) | `policyVersionId, orgRef, capability, scope tenant\|role\|task\|customer, requestedMode, safetyCeilingApplied, source, supersededAt`; resolver returns the full `trace` and `winner`; `SafetyCeiling` is the non-bypassable cap ("P8.4 decides the list" — still undecided) | A precedence resolver with a non-overridable ceiling and an explainable trace |
| `complianceFinding.ts:30-45` | `OverrideClass: NEVER_OVERRIDABLE \| APPROVED_POLICY_ONLY \| WARNING_ONLY \| INFORMATIONAL`; `AuthorityClass: statute_regulation > regulator_order > government_permit_exemption > carrier_safety_policy > client_contract > work_site > company_policy > best_practice` ("a lower authority never weakens a higher one") | An authority ladder already exists in code. The governance hierarchy should extend it, not replace it |
| `APPROVED_OVERRIDE_POLICIES` (`complianceFinding.ts:317`) | `readonly OverridePolicy[] = []` — a **code constant**, empty | Every `APPROVED_POLICY_ONLY` finding is unreleasable today (fail-closed, correct), but policy approval lives in source, not in an auditable, versioned row |
| `dispatchOverrides` (`0174`) | `grantedByUserId/Role/At, grantReason, overrideClass, policyRef, policyVersion, scopeJson, expiresAt, orgRef`; `dispatchEligibilityChecks.ruleSetHash` | An enforcement decision already records the policy ref/version it was made under and the hash of the rule set |
| `commercialApprovalPolicies` | `approverRole, secondPersonRequired, separationOfDuties, source, effectiveFrom` | Two-person approval as policy data |
| HOS rule registry (`0077`, `0119`, `0120`, `0124`) | figures as rows with provenance, `limitPromote` under separation of duties (`limitPromoteSeparationOfDuties.db.test.ts`) | "Law is authored, versioned rows with provenance, never inferred" is already the house rule |
| `interEngineStatus.ts` | `PASS \| REVIEW \| BLOCKED \| UNKNOWN \| NOT_EVALUATED`; NOT_EVALUATED never rounds up | The cross-engine vocabulary any governance decision must map onto |

### 1.7 Safety and dispatch gates

`server/_core/dispatchReadiness.ts:24-52`: `DispatchBlocker { code, label, severity: blocking|review|unknown,
subject, overridable: boolean, overrideAuthority? }` inside `DispatchEligibility { verdict, blockers,
evaluatedAt, explanation }`. Override discipline (`:512-600`): decided by `OverrideClass`, attempts
recorded whether or not granted, `NEVER_OVERRIDABLE` refused for every role including administrator.
An active out-of-service order "is not overridable by anyone in this company" (`CURRENT_STATE.md:297`).
Device safety latches (`0087`) hold on the device until the server's own released/rescinded state
lifts them. `readinessComposer` + `degradationSuite.test.ts` guarantee unlicensed capabilities never
block and broken feeds never pass. The action gateway's `NEVER_AUTONOMOUS` list (`actionGateway.ts:63-70`)
refuses `compliance.override, hos.ignoreViolation, inspection.bypassFailure,
maintenance.clearOutOfService, audit.delete, safety.clearViolation` to any agent.

### 1.8 Record integrity, amendments, sequencing, signatures

| Record | Immutability mechanism | Correction path |
|---|---|---|
| Manifests | DB trigger `0130` SIGNALs on UPDATE of a sealed manifest | `manifestAmendments` (`0129`), append-only, carries hash of what it replaced; `manifestReconciliationOverrides` (`0162`) append-only |
| Invoices | `invoicing.void` (app); "voids recorded, never deleted, refused where money is applied" | supplemental drafts, credits |
| Commercial documents (`0144`) | content never rewritten; new version supersedes with reason ≥10 chars; withdrawal refused under legal hold | version chain |
| Board messages (`0097`) | body revisions kept; withdrawal is not erasure | revision rows |
| Academy sheets/certificates | triggers `0121`, `0126`; two-party signatures with `invalidatedAt/Reason` | supersede |
| Evidence records | `legalHold` flag, `recordRetentionState`, `legalHolds`/`legalHoldRecords`; `records.retention.disposition` returns **eligibility only** ("not an instruction to destroy anything", `recordsRouter.ts`) | — |
| HOS | `hosAttestations` supersede-only; scanned logs are `complianceDocuments` that "touch nothing the readiness engine reads" | **No production write path to `dailyLogs` exists** (only `billing.ts` reads a completeness flag) |
| Sequences | `0117 commercial_chain_numbers`, `0125 academy_sheet_serial_registry`, `trackingReferences` | allocations are rows, gaps visible |

Hard deletes in production code (`grep "\.delete("`): `widgetLayoutItems` (layout replace),
`proposalFields` (`server/db.ts`), and **`insuranceRequirements` in `server/insuranceRouter.ts`**
(replace-all pattern on a compliance-bearing record). No `DELETE FROM` in any migration.

Signatures: `fieldTicketSignatures` (external signer: free-text `signerName/Company/Role`,
`signatureMethod: drawn|device_auth|pin|paper_scan|portal_link`, `payloadHash`, `withinAuthority`),
`academyCertificateSignatures` (`signerUserId`, `signerParty`, method, `payloadHash`),
`commercialApprovalSignatures` (`userId`, `rolesAtApproval`), `hosAttestations` (`attestedByUserId`,
method). Every internal signature names a human user id; the external field-ticket signer is a
named person bound to a portal identity or a device. Nothing lets a service or agent principal
create a signature row, because no such principal exists in `TrpcContext`.

### 1.9 Consent, policy documents, privacy

| Component | Where | Status |
|---|---|---|
| Terms of Service / Privacy Policy / Acceptable Use | `docs/legal/LEGAL_DOCUMENT_REGISTER.md` rows L2, L3, L6, L7, L8, L9, L10 | **All DRAFT-PK** (drafts in project knowledge only). No table, procedure, or client screen for terms acceptance exists |
| `complianceConsents` (`schema.ts:4141`) | `consentType` (hiring checks only), `purpose, requestedByUserId, signedAt, validUntil, signatureEvidenceRecordId, payloadHash, withdrawnAt` | Live; hiring scope only |
| `writtenProgramVersions` + `programAcknowledgements` | `programKey, version, contentHash, effectiveFrom, supersededAt/ByVersion, approvedByUserId`; ack `method: app|signature|training_session` | Wired (`complianceRouter.ts`, `auditRouter.ts`). **Closest precedent to policy-version + acceptance** |
| `monitoringNotices` + `_core/monitoringNotice.ts` (`0160`) | `purpose, noticeVersion, noticeTextHash, issuedAt/By, acknowledgedAt, acknowledgementMethod, supersededAt, withdrawnAt`; `not_notified` is the default; issued ≠ acknowledged | **Engine only. No router imports it; nothing can issue a notice.** `REMAINING_BUILD_REGISTER.md` P4.6 says so ("Still open: the procedures") |
| `retentionPolicies` | `statutoryMinimumMonths` nullable, `statutorySourceStatus: unverified` default, `companyRetentionMonths`, `deviceRetentionDays`, `legalHoldOverridesDeletion` | Company policy, explicitly "not asserted as the statutory rule" (`retentionPolicy.ts` header). No purge job, no erasure path, no user-data export path found |
| Privacy preferences | `externalAlertPreferences` (customer alert kinds) | Portal only; no driver-side location/telemetry preference |
| Security incidents (`0131`) | `securityIncidents`, sequenced `securityIncidentEvents`, `securityIncidentOrganizations`, privacy breach assessments | Wired (`server/securityIncidentsRouter.ts`) |
| Client consent UI | `client/src/pages/HosVerificationConsole.tsx:79,218` | Three separate un-prechecked attestation boxes — the one consent-shaped UI, and it is built correctly |

### 1.10 Customer / public portal and tracking links

`server/portalRouter.ts` mounts 36 `externalProcedure`s. Every portal action writes
`externalAccessLog { action: view|download|sign|decide|authorize|accept_invitation|mfa_*|token_rotate…, recordType, recordRef, recordVersion, context }`.
`customerProjections.ts` projects an `OperationalState` enum with a stated basis and **no coordinates**.
`trackingReferences` are record tracking numbers, not shareable links. **One-time job tracking links
do not exist** (`ROADMAP_2026-09-21.md` "Portal tiers: light tracking link — PLANNED").

### 1.11 Communications / conduct

`messageBoardRouter.ts:544,573`: only the author edits or withdraws, "moderation is a separate
authority" — **but no moderation permission, procedure, report/flag path, block, or rate limit
exists.** Attachments are references authorized per reader at read time; payroll, employee records
and client contracts are never attachable (`CURRENT_STATE.md:380-395`). Crew channel membership is
temporal and snapshotted into receipts.

### 1.12 AI / agent entry points

| Entry point | Gate | Model | Capability |
|---|---|---|---|
| `assistant.draft` (`server/routers.ts:~680-700`) | `roleProcedure` | `invokeLLM()` in `server/_core/llm.ts` via `ENV.forgeApiUrl` (vendor default host) | Produces an `assistantProposals` row and stops. `transcript` and `readBack` persisted |
| `assistant.answer/readBack/acknowledge/commit/reject` | `roleProcedure` | none | `executeAssistantCommit()` (`assistantCommitService.ts`) independently proves the **target** permission, writes once, records `assistantCommitReceipts { requiredPermission, authorizationDecisionId, fieldManifestHash, actorUserId (the committing human), adapterVersion }` |
| `assistant.ask/*` (`assistantAskRouter.ts`) | `roleProcedure` | none on the retrieval path (`evidenceGrounding.verifyClaim`) | Quotes admitted passages |
| `agent.start/requestAction/decideApproval/awaitEvent/get` (`agentRouter.ts`) | `roleProcedure` | none | Records `agentRuns/agentActions/agentApprovals`; `decide()` from `actionGateway.ts`; **executes nothing** |
| Secretary model layer (`server/_core/ai/*`) | — | — | PR #7, declared unwired (`docs/register/AI_RUNTIME_TERMINOLOGY.md`) |

`agentActions` persists `actorType, delegatedByUserId, origin (InstructionAuthority), decision,
decisionReasons, payloadHash, idempotencyKey`. `agentRuns.tenantId` is nullable. AI runs under the
invoking human's roles; there is no separate AI principal, so "AI bypasses authorization" is
structurally impossible today and "AI is attributed" is only true at the proposal/receipt level
(the outbox `ai` actor source is never written).

### 1.13 Tests and CI conventions

`vitest`, `fileParallelism: false`; `*.db.test.ts` gate on `DATABASE_URL` and the CI gate **fails if
a db suite skips while a database is configured** (`ci-gate.sh` gate 6). Architecture-level tests
scan source: `engineReachability.test.ts` (`DECLARED_UNWIRED` honest in both directions),
`degradationSuite.test.ts` (enumerates capabilities and consumers from source),
`documentationTruth.test.ts` (docs bound to code), `procedureAuthorization.test.ts` (counts),
`registerClaims.test.ts` (register artefacts must exist), `oneDoorInvariant.db.test.ts`,
`branchGrantLaundering.test.ts`, `knowledgePerimeter.test.ts`. Caller pattern:
`appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never })`
(`server/academyTdgWiring.db.test.ts:24`). New `docs/governance/*` files are scanned by none of the
truth tests.

### 1.14 Jurisdiction

`retentionPolicies.jurisdiction`, `financialEntities.jurisdiction`, HOS profiles carry applicability
(authority, jurisdiction, weight, operation); `jurisdiction.ts` resolver answers UNKNOWN without a
verified boundary layer (`jurisdiction.test.ts`) and is declared unwired. Seeds are Alberta-centric
(`driverTraining.ts`, `radioChannelSeeds.ts`, `complianceRequirementSeeds.ts`) and every seed is
marked unverified. Nothing hard-codes a province into an enforcement path.

---

## 2. Existing components to reuse (do not duplicate)

1. **`authorize()` + `roleProcedure`/`externalProcedure`/`integrationProcedure`** — the permission
   layer and its ledger. Governance sits *after* it and reads its result; it does not re-decide roles.
2. **`resolveActingScope()`** — the only source of the acting organization. Governance takes
   `organization` from it, never from input.
3. **`actionGateway.decide()`** — already a policy evaluator for agent actions with
   `InstructionAuthority`, `NEVER_AUTONOMOUS`, payload-bound approval, and a `Decision` union. The
   governance decision type must be a superset of it so `decide()` can be adapted, not replaced.
4. **`complianceFinding.AuthorityClass` and `OverrideClass`** — the authority ladder and the
   non-bypassability vocabulary. Extend the ladder with the LeaseOS-owned levels; do not invent a
   second ladder.
5. **`interEngineStatus`** — governance results must adapt to `PASS/REVIEW/BLOCKED/UNKNOWN/NOT_EVALUATED`
   so `readinessComposer`, billing and audit consume them without translation.
6. **`oosReleasePolicies` row shape + `mayScopePolicyTo`** — the template for any organization-authored
   governance policy row (proposed by one, approved by another, effective-dated, superseded).
7. **`automationPolicy.resolveAutomation()`** — the precedence resolver pattern with a ceiling and a
   trace; the governance precedence resolver should be written the same way.
8. **`writtenProgramVersions` / `programAcknowledgements` / `monitoringNotices` / `complianceConsents`**
   — the acceptance-evidence shapes: versioned content hash, issued ≠ acknowledged, method,
   `payloadHash`, `withdrawnAt`, `supersededAt`.
9. **`assistantCommitReceipts`** — the receipt pattern: links `authorizationDecisionId`, hashes the
   manifest, names the human actor. A policy receipt is this shape with a policy ref/version added.
10. **`dispatchOverrides` (0174)** — the override record with grantor, policy ref/version, scope, expiry.
11. **`domainEventOutbox`** with `actorSource: ai` — the attribution slot already exists.
12. **Trigger-guarded append-only tables (`0130`, `0121`)** — the mechanism for acceptance immutability.
13. **Architecture-test pattern** (`degradationSuite`, `engineReachability`) — the model for policy
    conformance tests that enumerate from source and stay standing.
14. **`securityIncidents`** — the evidence sink for abuse/enforcement cases.

---

## 3. Current gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | No policy document registry, no version model, no acceptance record for ToS/Privacy/AUP | §1.9; legal register L2/L3 DRAFT-PK |
| G2 | No stable, shared reason-code catalog; denials are prose | §1.5 |
| G3 | No governance receipt: `authorizationDecisions` lacks `orgRef`, policy ref/version, reason code | §1.2 |
| G4 | No account-state model for internal users (no suspension/lockout on `users`); membership `suspended` is not consulted by `roleProcedure` | §1.1, §1.3 |
| G5 | Owner-approved override policies are a code constant, not versioned data | §1.6 |
| G6 | No moderation authority, abuse report, or rate limit in communications | §1.11 |
| G7 | Monitoring notices unwired; no retention execution; no erasure/export-of-my-data path | §1.9 |
| G8 | AI attribution stops at the proposal/receipt; outbox `ai` source unused; `agentRuns.tenantId` nullable | §1.12 |
| G9 | Organization-scoped roles absent; isolation partial | §1.3 |
| G10 | No human-review/appeal queue for automated denials (only `agentApprovals` for agent actions and the dispatch override request) | §1.7, §1.12 |
| G11 | No AI disclosure surface in the client; LLM host is a vendor default | §1.12 |
| G12 | No jurisdiction on policy documents (needed for province/country variants later) | §1.14 |

---

## 4. Conflicts and duplication risks

1. **A second authority ladder.** `complianceFinding.AuthorityClass` already orders statute →
   best_practice. A governance `PolicyAuthority` enum that is not a strict extension of it would give
   two answers to "which outranks which".
2. **A second decision union.** `actionGateway.Decision` (`allow|deny|require_approval|compliance_block|stale`)
   and `DispatchEligibility.verdict` both exist. Introduce the governance decision as the boundary
   type with adapters (the `interEngineStatus` approach), never as a replacement.
3. **A second ledger.** Writing governance receipts to a table that duplicates
   `authorizationDecisions` would put "why was this refused" in two places. Link, don't copy.
4. **A second acceptance model.** `programAcknowledgements` and `monitoringNotices` already model
   acknowledgement; policy acceptance should share their evidence fields or one of them should be
   generalized. Owner decision (§16-D4).
5. **The SPINE moratorium.** `docs/register/SPINE_WIRING_PLAN.md`: "no new engines until this path is
   wired." Governance is cross-cutting rather than an operational engine, but the owner must say
   whether the moratorium applies (§16-D1). The proposal below keeps the first checkpoint pure and
   non-enforcing so it does not compete with SPINE wiring.
6. **Open-branch collisions.** `claude/leaseos-auth-workspace-system-t008ad` (org-scoped role grants,
   `0170`), `claude/document-control-architecture-jlffzk` (`0178-0181`, document numbering/register),
   `claude/driver-portfolio-*` (`0175-0177`), and `claude/eld-compliance-intelligence-ramlrd`
   (`0179_eld_event_ledger`) each touch governance-adjacent ground. Their branches were not read
   beyond migration names; coordinate before building G9 or record-integrity rules for documents.
7. **`users.role = admin` / `adminProcedure`.** Three uses, all bootstrap or owner notification
   (I14). Governance must not consult it; map each use to a `Permission` or keep it confined to bootstrap.

---

## 5. Proposed Trust & Governance architecture

```
User / Portal identity / Integration client / (future) Agent principal
        │
        ▼
Authentication            sdk.authenticateRequest / externalProcedure token / integration key    [exists]
        │
        ▼
Authorization             authorize() → authorizationDecisions row                                [exists]
        │
        ▼
Acting scope              resolveActingScope() → { tenantId, derivedFrom, branchRefs }           [exists]
        │
        ▼
Trust & Governance        governance.evaluate({ actor, organization, action, resource, context })  [NEW, pure]
  policy engine             ├─ precedence resolver over PolicyAuthority (extends AuthorityClass)
                            ├─ deterministic rule modules (record-integrity, acceptance-required,
                            │   ai-boundary, conduct, tenant, override) — code, versioned, tested
                            ├─ policy rows (org-authored parameters) — DB, versioned, two-person
                            └─ adapters: authorize() result, actionGateway.decide(), DispatchBlocker
        │
        ▼
Safety / regulatory gates readinessComposer, enforcement, OOS latches                            [exist]
        │
        ▼
Domain operation
        │
        ▼
Audit ledger + policy receipt   authorizationDecisions (+reasonCode, orgRef) ← governanceReceipts  [extend]
```

Design rules:

- **Pure core.** `server/_core/governance/evaluate.ts` takes already-resolved inputs (the
  `AuthorizationResult`, the `ActingScope`, the resource snapshot, the policy rows in force) and
  returns a `GovernanceDecision`. No database, no network — the same discipline as `actionGateway.ts`
  and `automationPolicy.ts`, so it is testable without a database and cannot fail open on I/O.
- **One place to call it.** A `governedProcedure(name, action)` builder in `trpc.ts` that composes
  `roleProcedure` and then `evaluate()`, writing the receipt and throwing a `TRPCError` whose `cause`
  carries the machine-readable decision. Routers keep their `roleProcedure` and opt into
  `governedProcedure` per checkpoint; nothing is sprinkled.
- **Deterministic first.** Enforceable rules are code modules with a `RULESET_VERSION` and a
  `ruleSetHash` (the `0174` precedent). Organization policies are DB rows that *parameterize* a rule
  (thresholds, enablement, scope); they never add new logic and cannot exceed a mandatory control
  (the `SafetyCeiling` precedent).
- **Fail closed where the house already does.** Missing policy rows for a mandatory control → `deny`
  with `POLICY_NOT_ESTABLISHED`; missing entitlement → `NOT_EVALUATED` with its reason, exactly as
  `automationPolicy` distinguishes them.
- **Explainable.** Every decision carries `reasonCode` from a shared catalog, a `humanReason`, a
  `remediation`, and the `trace` of policies consulted.

---

## 6. Proposed schema changes (numbers from §14)

### `0182_governance_receipts.sql`
```sql
ALTER TABLE `authorizationDecisions`
  ADD COLUMN `orgRef` varchar(64) NULL,             -- acting organization from resolveActingScope; NULL = legacy row
  ADD COLUMN `reasonCode` varchar(64) NULL;         -- stable code from shared/_core/reasonCodes.ts

CREATE TABLE `governanceReceipts` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `receiptRef` varchar(64) NOT NULL UNIQUE,
  `authorizationDecisionId` int NULL,               -- the permission row this decision followed
  `orgRef` varchar(64) NULL,
  `actorType` enum('user','external','integration','agent','system') NOT NULL,
  `actorId` varchar(64) NOT NULL,
  `delegatedByUserId` int NULL,
  `action` varchar(120) NOT NULL,                   -- "disposal_ticket.modify"
  `resourceType` varchar(60) NULL,
  `resourceRef` varchar(120) NULL,
  `resourceRevisionHash` varchar(128) NULL,
  `decision` enum('allow','deny','require_action','require_review','not_evaluated') NOT NULL,
  `policyId` varchar(120) NOT NULL,
  `policyVersion` varchar(40) NOT NULL,
  `ruleId` varchar(120) NOT NULL,
  `authority` varchar(40) NOT NULL,                 -- PolicyAuthority
  `reasonCode` varchar(64) NOT NULL,
  `humanReason` varchar(600) NOT NULL,
  `remediation` varchar(600) NULL,
  `ruleSetHash` varchar(64) NOT NULL,
  `traceJson` text NOT NULL,                        -- policies consulted, in precedence order
  `evaluatedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- BEFORE UPDATE / BEFORE DELETE triggers SIGNAL 45000 (the 0130 pattern): a receipt is never edited.
```

### `0183_policy_documents.sql`
```sql
CREATE TABLE `policyDocuments` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `policyKey` varchar(80) NOT NULL UNIQUE,          -- "leaseos.terms", "leaseos.privacy", "leaseos.aup", "leaseos.ai_disclosure", "org.<orgRef>.<key>"
  `kind` enum('terms','privacy','acceptable_use','ai_disclosure','organization_policy') NOT NULL,
  `authority` varchar(40) NOT NULL,                 -- PolicyAuthority
  `ownerOrgRef` varchar(64) NULL,                   -- NULL = LeaseOS-owned
  `jurisdiction` varchar(80) NULL,                  -- NULL = all; province/country code otherwise
  `audience` enum('internal_user','external_identity','integration_client','all') NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE `policyDocumentVersions` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `policyDocumentId` int NOT NULL,
  `version` varchar(40) NOT NULL,                   -- semver string; unique per document
  `contentHash` varchar(64) NOT NULL,               -- SHA-256 of the canonical text
  `contentEvidenceRecordId` int NULL,               -- the bytes, in the records vault
  `summaryOfChanges` text NULL,
  `materialChange` boolean NOT NULL,                -- true ⇒ renewed acceptance required
  `status` enum('proposed','approved','superseded','withdrawn') NOT NULL DEFAULT 'proposed',
  `proposedByUserId` int NOT NULL,
  `approvedByUserId` int NULL,                      -- must differ from proposedBy (oosReleasePolicies rule)
  `approvedAt` timestamp NULL,
  `effectiveFrom` timestamp NULL,
  `supersededAt` timestamp NULL,
  `supersededByVersionId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (`policyDocumentId`, `version`)
);
CREATE TABLE `policyAcceptances` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `acceptanceRef` varchar(64) NOT NULL UNIQUE,
  `principalType` enum('user','external_identity','integration_client') NOT NULL,
  `principalId` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `policyDocumentVersionId` int NOT NULL,
  `contentHashAtAcceptance` varchar(64) NOT NULL,   -- must equal the version's contentHash (guarded)
  `state` enum('accepted','declined','withdrawn') NOT NULL,
  `recordedAt` timestamp NOT NULL,                  -- SERVER clock; input never supplies it
  `method` enum('in_app_click','portal_click','signed_document','api_acknowledgement') NOT NULL,
  `presentedTextHash` varchar(64) NOT NULL,         -- what the person saw
  `clientContextHash` varchar(64) NULL,             -- hash of IP + user agent; never the raw values
  `evidenceRecordId` int NULL,
  `supersedesAcceptanceId` int NULL,                -- withdrawal / re-acceptance chain
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- BEFORE UPDATE / BEFORE DELETE triggers SIGNAL 45000. A withdrawal is a new row.
```

### `0184_account_state.sql` (checkpoint G5; may be superseded by the auth-workspace branch)
```sql
CREATE TABLE `accountStateEvents` (
  `id` int AUTO_INCREMENT PRIMARY KEY,
  `principalType` enum('user','external_identity','integration_client') NOT NULL,
  `principalId` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `sequence` int NOT NULL,
  `state` enum('active','restricted','suspended','under_review','reinstated') NOT NULL,
  `reasonCode` varchar(64) NOT NULL,
  `detail` text NULL,
  `evidenceRef` varchar(120) NULL,                  -- securityIncidents.incidentRef or governanceReceipts.receiptRef
  `decidedByUserId` int NOT NULL,                   -- a human, always
  `reviewDueAt` timestamp NULL,
  `occurredAt` timestamp NOT NULL,
  UNIQUE (`principalType`, `principalId`, `sequence`)
);
-- The current state is the latest sequence; the event stream is the appeal record.
```

No column is added to `users`; the state is derived from the append-only stream so a suspension is
never an invisible flag flip.

---

## 7. Proposed TypeScript contracts

`shared/_core/reasonCodes.ts` (shared so the client can render):
```ts
export const REASON_CODES = {
  // permission (maps 1:1 onto authorizationDecisions.outcome)
  DENIED_UNAUTHENTICATED: "denied_unauthenticated", DENIED_NO_ROLE: "denied_no_role",
  DENIED_PERMISSION: "denied_permission", DENIED_SCOPE: "denied_scope",
  // governance
  POLICY_NOT_ESTABLISHED: "POLICY_NOT_ESTABLISHED",
  ACCEPTANCE_REQUIRED: "ACCEPTANCE_REQUIRED", ACCEPTANCE_STALE: "ACCEPTANCE_STALE",
  ISSUED_DOCUMENT_IMMUTABLE: "ISSUED_DOCUMENT_IMMUTABLE", RECORD_UNDER_LEGAL_HOLD: "RECORD_UNDER_LEGAL_HOLD",
  MANDATORY_CONTROL_NOT_OVERRIDABLE: "MANDATORY_CONTROL_NOT_OVERRIDABLE",
  ORG_POLICY_EXCEEDS_CEILING: "ORG_POLICY_EXCEEDS_CEILING",
  TENANT_BOUNDARY: "TENANT_BOUNDARY",
  AGENT_NEVER_AUTONOMOUS: "AGENT_NEVER_AUTONOMOUS", AGENT_CANNOT_SIGN: "AGENT_CANNOT_SIGN",
  AGENT_CANNOT_ATTEST: "AGENT_CANNOT_ATTEST", HUMAN_REVIEW_REQUIRED: "HUMAN_REVIEW_REQUIRED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED", ACCOUNT_UNDER_REVIEW: "ACCOUNT_UNDER_REVIEW",
  RECORD_STALE: "RECORD_STALE",
} as const;
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
```

`server/_core/governance/decision.ts`:
```ts
import type { AuthorityClass } from "../complianceFinding";

/** Extends complianceFinding.AuthorityClass. Order is the precedence order (§9). */
export type PolicyAuthority =
  | AuthorityClass
  | "leaseos_mandatory_control" | "leaseos_terms" | "leaseos_privacy"
  | "organization_policy" | "operational_preference";

export type GovernanceActor =
  | { type: "user"; userId: number; roles: readonly string[] }
  | { type: "external"; identityRef: string; kind: "customer" | "vendor" | "facility" }
  | { type: "integration"; clientRef: string; scopes: readonly string[] }
  | { type: "agent"; agentKey: string; runRef: string; delegatedByUserId: number }
  | { type: "system"; component: string };

export type GovernanceRequest = {
  actor: GovernanceActor;
  organization: ActingScope;                      // from resolveActingScope, never input
  action: string;                                 // "disposal_ticket.modify"
  resource: { type: string; ref: string; revisionHash?: string; orgRef?: string | null; snapshot?: unknown } | null;
  context: {
    permission: AuthorizationResult;              // what authorize() said
    policies: readonly PolicyRowInForce[];        // org-authored rows applicable now
    acceptances?: readonly AcceptanceState[];
    compliance?: ComplianceVerdict | null;        // what the deterministic engines said
    now: Date;
  };
};

export type GovernanceDecision = {
  decision: "allow" | "deny" | "require_action" | "require_review" | "not_evaluated";
  policyId: string; policyVersion: string; ruleId: string;
  authority: PolicyAuthority;
  reasonCode: ReasonCode;
  humanReason: string;
  remediation: string | null;
  requiredAction?: { kind: "accept_policy"; policyKey: string; version: string } | { kind: "amend"; of: string };
  review?: { queue: "governance_review"; reason: string };
  ruleSetHash: string;
  trace: readonly { policyId: string; policyVersion: string; authority: PolicyAuthority; outcome: string }[];
  evaluatedAt: Date;
};

export const RULESET_VERSION = "1.0.0";
export function evaluate(req: GovernanceRequest): GovernanceDecision;      // pure
export function toInterEngineStatus(d: GovernanceDecision): CapabilityResult;
export function fromGatewayDecision(d: actionGateway.Decision, ...): GovernanceDecision;
export function fromDispatchBlocker(b: DispatchBlocker, ...): GovernanceDecision;
```

`server/_core/governance/policy.ts`:
```ts
export type PolicyRule = {
  ruleId: string; policyId: string; authority: PolicyAuthority;
  overrideClass: OverrideClass;                   // reuse complianceFinding
  appliesTo: (req: GovernanceRequest) => boolean;
  decide: (req: GovernanceRequest) => GovernanceDecision | null;   // null = no opinion
};
export type PolicyRowInForce = {
  policyRef: string; version: number; orgRef: string | null; authority: "organization_policy" | "operational_preference";
  ruleId: string; parametersJson: string; effectiveFrom: Date; effectiveTo: Date | null;
};
```

---

## 8. API / middleware integration points

| Point | Change | Checkpoint |
|---|---|---|
| `server/_core/trpc.ts` `roleProcedure` | write `reasonCode` (= `outcome`) and `orgRef` on the existing row; attach `{ reasonCode }` to `TRPCError.cause` so the client can branch | G2 |
| `server/_core/trpc.ts` new `governedProcedure(name, action, resolver)` | `roleProcedure` → `resolveActingScope` → load resource + policies → `evaluate()` → receipt → next or throw | G2 |
| `client/src/main.tsx` error link | read `error.data.reasonCode`; show `humanReason` and `remediation`; never only "Not allowed" | G2 |
| `server/_core/actionGateway.ts` | `decide()` unchanged; `agent.requestAction` additionally calls `evaluate()` with `actor.type = "agent"` and persists the receipt ref on `agentActions` | G4 |
| `server/_core/assistantCommitService.ts` | commit writes the outbox event with `actorSource: "ai"` when the proposal's origin is a model draft, and links the receipt | G4 |
| `server/portalRouter.ts` `portal.invitation.accept` | require `ACCEPTANCE` of the in-force Client Portal Terms version before the identity becomes `active` | G3 |
| Login / `auth.me` | return `pendingAcceptances[]`; the client gates on it; nothing is pre-checked | G3 |
| `server/messageBoardRouter.ts`, `crewRouter.ts` | `conduct.report` procedure → `governance_review` queue; `conduct.moderate` under a new `Permission` | G5 |
| `server/_core/monitoringNotice.ts` | mount `privacy.notice.issue/acknowledge/coverage` | G6 |

---

## 9. Policy precedence model

Extend `AuthorityClass` in place. Highest first:

1. `statute_regulation`, `regulator_order`, `government_permit_exemption` — **authored rows with provenance only** (HOS registry pattern). LeaseOS never asserts what the law is.
2. `leaseos_mandatory_control` (new) — safety/security controls the platform will not let anyone bypass: `NEVER_OVERRIDABLE` findings, `NEVER_AUTONOMOUS` capabilities, tenant boundary, receipt immutability, audit-write-or-refuse.
3. `client_contract`, `carrier_safety_policy` — existing.
4. `leaseos_terms` (new) — Terms of Service / Acceptable Use.
5. `leaseos_privacy` (new) — privacy commitments; may only *narrow* what lower levels do.
6. `work_site`, `company_policy` → renamed in the governance layer as `organization_policy` — rows an organization proposes and a second person approves; each names the `ruleId` it parameterizes and is clamped by the rule's ceiling.
7. `operational_preference`, `best_practice` — dispatcher/customer preferences; never a source of `deny` on a safety rule.

Resolver: walk highest → lowest; the first `deny` from a level whose rule is `NEVER_OVERRIDABLE`
ends evaluation; a lower level may add `require_action`/`require_review` but may never turn a
higher-level `deny` into `allow`; an organization row whose parameters exceed the ceiling produces
`ORG_POLICY_EXCEEDS_CEILING` at approval time and is ignored at evaluation time with a trace entry
(the `clamped: true` pattern). Conflicting equal-level rows → `policy_error` → `require_review`,
never resolved by date or insertion order (`automationPolicy.ts` rule).

---

## 10. Consent / versioning model

- A policy document is `policyDocuments` + `policyDocumentVersions`; a version is proposed by one
  person and approved by a different person; `effectiveFrom` is set at approval; approval of a new
  version supersedes the previous one (never overwrites it).
- `materialChange = true` on a version means every principal in its `audience` has
  `ACCEPTANCE_STALE` until they accept the new version. `materialChange = false` means existing
  acceptances carry forward, and the receipt records which version was in force.
- Acceptance is a `policyAcceptances` row with the **server** timestamp, the content hash the person
  saw, and the method. It is append-only (trigger). Declining is a row. Withdrawal is a row that
  supersedes. Silence is `not_accepted`; there is no default row and no "presumed" state
  (the `monitoringNotice` `not_notified` rule).
- The UI presents the full text or a summary-with-link and an unchecked control; the server
  refuses an acceptance whose `presentedTextHash` does not match an approved version.
- `pendingAcceptances` is computed, never stored: audience ∩ in-force versions − accepted.
- Organization-specific policies use the same tables with `ownerOrgRef` set; their `authority` is
  `organization_policy` and they can require acceptance from that organization's members only.
- Jurisdiction variants are separate documents with `jurisdiction` set; the resolver prefers the
  jurisdiction-specific in-force version for a principal whose organization's jurisdiction matches,
  else the global one. How a principal's jurisdiction is determined is an owner decision (§16-D9).

---

## 11. Privacy / data-processing inventory (as the code stands)

Retention column reports what code does; **no period is invented**. "Policy row" = `retentionPolicies`
class can be assigned; nothing executes deletion.

| Data class | Tables (examples) | Origin | Who reads | Shared outside org | Retention / deletion | Export | Audit | Mismatch / owner decision |
|---|---|---|---|---|---|---|---|---|
| Names / contact | `users`, `operators`, `organizationWorkers`, `applicants.contactJson`, `facilities.contact*` | OAuth profile; office entry | role permissions | customer/vendor/facility portals see display names | none executed | via audit packages | `authorizationDecisions` | D5: contact directory not built (`SCOPE_RECONCILIATION` §1) |
| Driver licences / abstracts / medical fitness | `complianceDocuments`, `complianceConsents`, `workerQualifications`, `qualificationTypes` | office upload; hiring consent | compliance/safety/HR roles | no | policy row only | audit packages (driver) | `evidenceAccessEvents` | medical is health data: restricted-vault tiering not applied (`REMAINING_BUILD_REGISTER` P8.5 note) |
| Training certificates | `academyQualifications`, `academyCertificates`, `academyCertificateSignatures` | learner + employer signatures | academy/HR/safety | inspector requests (`0122`) | trigger-guarded retention chain (`0121`) | — | `academyAuditEvents` | none found |
| Signatures | `fieldTicketSignatures`, `academyCertificateSignatures`, `commercialApprovalSignatures`, `signatureAudits` | device/portal/drawn | per record permission | field-ticket signer is the customer | policy row only | PDF render | `externalAccessLog` (portal) | L9 e-signature evidence policy DRAFT-PK |
| GPS / location history | `tripBreadcrumbs`, `zoneEvents`, `telemetrySnapshots`, `locationIdentities` | device capture; telematics ingest | dispatch/office | customer sees `OperationalState` only, no coordinates | none executed; device clock in `retentionPolicies.deviceRetentionDays` | — | zone confirms are proposed-then-confirmed | **Monitoring notice engine unwired (G7)**; L7 GPS notice DRAFT-PK |
| Photos / video | `evidenceRecords` (storage keys), `videoAccessLog` | device capture | per record | no | policy row; legal hold | audit packages | `videoAccessLog`, `evidenceAccessEvents` | uploads trust the client's `mimeType` string; no byte sniffing (verified, I18) |
| Scanned paperwork / OCR | `documentExtractions`, `documentFingerprints`, `enforcementDocumentExtractions` | assistant / enforcement scan | proposer + committer | no | none | — | `assistantCommitReceipts` | — |
| Employment records | `organizationWorkers`, `applicantScreenings`, `leaveRequests`, `shiftPosts`, `employeePayrollProfiles` | HR | HR/payroll/management | no; never attachable to messages | none | `payroll.export` | `authorizationDecisions` | D&A results not stored anywhere (register P8.5) |
| HOS | `hosAttestations`, `complianceDocuments(scanned_paper)`, `hosRuleLimitHistory` | attestation; scan | dispatch/safety | roadside DTO (`records.roadside.open`) | policy row | audit packages | supersede-only | `dailyLogs` has no writer |
| Vehicle / unit | `units`, inspections, defects, `deviceSafetyLatches` | shop/driver | shop/dispatch | facility/customer chain of custody | — | audit packages | many | — |
| Disposal / manifests | `manifests`, `manifestAmendments`, `disposalTickets`, `facilityStatements` | driver/facility | ops/commercial | disposal facility portal (`0141` contact access) | sealed; amendments | statements | `manifestCustodyEvents` | — |
| Billing / banking | `invoices`, `bankAccounts`, `bankStatementLines`, `customerPayments`, `payroll*` | finance | finance roles | customer portal: own invoices | void, never delete | `invoicing.render`, `payroll.export` | `commercialApprovalSignatures` | — |
| Customer info | `customerAccounts`, `externalIdentities`, `externalAlertPreferences` | office invitation | commercial roles | the customer themselves | `revokedAt` on identity; no data deletion | — | `externalAccessLog` | L3 portal terms never presented (G1) |
| AI prompts / outputs | `assistantProposals.transcript/readBack`, `agentRuns.goal`, `knowledgePassages`, `assistantQuestions` | dictation; agent goals | proposer, admins | no | none; no retention class | — | receipts | `agentRuns.tenantId` nullable (G8); L8 AI policy DRAFT-PK; LLM host is a vendor default |
| Device / telemetry | `fieldDevices`, `deviceKeyEvents`, `deviceSyncNonces`, `syncPackages` | device enrolment | ops | no | — | — | `deviceKeyEvents` | — |
| Security incidents | `securityIncidents*`, `incidentNotificationObligations` | reviewer | incident owner | affected orgs listed | — | — | sequenced events | — |
| Communications | `boardMessages`, `messageRevisions`, `messageAttachments`, `messageReceipts` | users | channel members (temporal) | no | withdrawal ≠ erasure | — | receipts | no moderation/report path (G6) |

Legal register cross-check: L6 (DPA), L7 (GPS notice), L9 (e-signature), L10 (retention schedule),
L19 (PIA) are all DRAFT-PK, so every "policy vs code" comparison above compares code against a draft
nobody has signed off; the mismatches that are certain today are G1, G6, G7 and the HOS/`dailyLogs`
observation.

---

## 12. AI governance boundaries

| Boundary | Today | Proposed rule (`ruleId`) |
|---|---|---|
| Cannot fabricate regulatory records / inspections / locations / times | Model output lands only in `assistantProposals`; commit copies fields under a human's permission; trust-bearing states are `REFUSED` on create (`routers.ts:1573` `classificationStatus`) | `ai.no_trust_bearing_write`: any commit adapter field mapped to a trust-bearing column (status, verdict, timestamp of an event, coordinates, measurement) must originate from a `bound_from_record` or human-entered source, never a model field. Enforced by a source-scanning conformance test over `assistantCommitAdapters.ts` |
| Cannot manufacture signatures | No signature table takes an agent principal; `actionGateway` refuses unregistered capabilities | `ai.no_signature`: `GovernanceActor.type === "agent"` on any `*.sign`, `*.attest`, `*.acknowledge` action → `deny AGENT_CANNOT_SIGN`, authority `leaseos_mandatory_control` |
| Cannot alter completed records without provenance | manifests sealed by trigger; invoices void-only | `record.issued_immutable` applies to every actor; agent gets no exception |
| Cannot claim human approval | `agentApprovals.decidedByUserId`, `approvalCovers()` payload hash | keep; add receipt link |
| Cannot bypass authorization / tenant | runs under the human's roles; `contextAdmission` | `agent` actor evaluated **with** `delegatedByUserId`'s permission result and the delegator's `ActingScope`; `agentRuns.tenantId` becomes NOT NULL (G4) |
| Cannot bypass safety gates | `NEVER_AUTONOMOUS` | map each entry to a `Permission` that no role grants to an agent, so the two lists cannot drift (conformance test) |
| Attributable / auditable | proposal + receipt name the human; outbox `ai` unused | commit writes outbox `actorSource: "ai"` + `actorUserId` = committing human; receipt carries `runRef`/`proposalId` |
| Disclosure | none | `leaseos.ai_disclosure` policy document; client badge on model-drafted proposals; owner decision on wording (§16-D8) |
| Classification vs decision | `classifyRequest()`, `complianceSecretary.ts` | AI may set `require_review` and attach evidence; it may never produce `allow` on a `leaseos_mandatory_control` rule |

---

## 13. Policy conformance test matrix

Suite: `server/governanceConformance.test.ts` (pure) and `server/governanceConformance.db.test.ts`
(against the disposable CI database). Written in the `degradationSuite` style: enumerate rules,
actions and actor types **from source**, so a rule added without a case fails.

| Invariant | Kind | Method |
|---|---|---|
| no cross-tenant data leakage through `evaluate()` | pure | resource `orgRef` ≠ acting `tenantId` → `deny TENANT_BOUNDARY`; receipt written; the error text equals the not-found text |
| missing required consent is not consent | pure | `acceptances: []` → `require_action ACCEPTANCE_REQUIRED`; `undefined` acceptances (feed missing) → `not_evaluated`, never `allow` |
| acceptance cannot be backdated | db | `policy.accept` ignores any client timestamp; `recordedAt` ≥ transaction start; UPDATE on `policyAcceptances` raises 45000 |
| acceptance records identify the exact version | db | `contentHashAtAcceptance` must equal `policyDocumentVersions.contentHash`; mismatch refused |
| issued/completed documents cannot be silently rewritten | db | for each sealed kind (manifest, finalized invoice, approved commercial document, receipt): direct UPDATE raises or the procedure returns `ISSUED_DOCUMENT_IMMUTABLE` with `remediation: "Create an amendment"` |
| AI cannot sign as a human | pure | every action matching `/\.(sign\|attest\|acknowledge)$/` in the procedure map × actor `agent` → `deny AGENT_CANNOT_SIGN` |
| AI cannot bypass authorization | pure | agent request whose `context.permission.allowed === false` → `deny` regardless of any org policy row |
| safety gates remain non-bypassable | pure | every `DispatchBlocker` with `overridable: false` and every `NEVER_AUTONOMOUS` capability → `deny MANDATORY_CONTROL_NOT_OVERRIDABLE` for **every** role and actor type, enumerated from `dispatchReadiness.ts` and `actionGateway.ts` |
| denied actions carry stable reason codes | pure + static | every `deny`/`require_*` returns a `ReasonCode` from the catalog; source scan: no `new TRPCError({ code: "FORBIDDEN"` inside `governedProcedure` paths without `cause.reasonCode` |
| enforcement decisions record policy version | db | every receipt has `policyVersion`, `ruleSetHash` = hash of `RULESET_VERSION` + rule ids; changing a rule module without bumping the version fails a static test |
| lower-priority org policy cannot override mandatory control | pure | for each rule with `overrideClass: NEVER_OVERRIDABLE`, an org row requesting relaxation is ignored with a trace entry `ORG_POLICY_EXCEEDS_CEILING` |
| policy change is auditable | db | approving a version requires `approvedByUserId ≠ proposedByUserId`; supersession leaves the prior row readable |
| suspension is not silent | db | an `accountStateEvents` row with `state: suspended` makes `roleProcedure` deny `ACCOUNT_SUSPENDED` and still writes the ledger row; reinstatement is a new row |
| human review path exists | pure | every `deny` from a rule flagged `reviewable: true` carries `review.queue` |
| receipts are immutable | db | UPDATE/DELETE on `governanceReceipts` raises 45000 |

All of these reuse the `createCaller` fixture pattern and the `DATABASE_URL` gate; the CI gate's
"no skipped db suite" check keeps them from silently not running.

---

## 14. Migration-number assessment (at `6f52b57`)

`drizzle/` on `main`/this branch ends at **`0174_dispatch_override_provenance.sql`** (169 files;
`0016`, `0017`, `0094`, `0095`, `0098`, `0172`, `0173` absent; `0157` used twice).
`LEASEOS_CURRENT_STATE.md` reports 169 migrations, consistent with the file count.

Scan of every remote branch (`git branch -r`, the register's own command) for added
`drizzle/0NNN_*.sql` files above 0169:

| Number | Claimed by |
|---|---|
| 0170 | `claude/leaseos-auth-workspace-system-t008ad` (`organization_scoped_role_grants`), `claude/work-calendar-task-engine-0mtjyk` (`work_calendar_tasks_reminders`) — both collide with main's `0170_dispatch_role_types` |
| 0172, 0173, 0174, 0175 | `claude/training-academy-workforce-q3mdse` (`0174_training_compliance_operations` collides with main's 0174) |
| 0175, 0176, 0177 | `claude/driver-portfolio-api-ya8928`, `claude/driver-portfolio-credential-wallet-ya8928` |
| 0178, 0179, 0180, 0181 | `claude/document-control-architecture-jlffzk` |
| 0179 | `claude/eld-compliance-intelligence-ramlrd` (`eld_event_ledger`), `claude/migration-0169-reconciliation` (`trip_stop_provenance`) |

**First number no branch holds: `0182`.** Recommendation: claim `0182`, `0183`, `0184` for governance
in `docs/architecture/MIGRATION_COLLISION_REGISTER.md` at the first implementation checkpoint, and
add the register row before the SQL file exists. The roadmap's "no check for duplicate migration
prefixes" item stands; a governance checkpoint should not be the one to add it, but it will be
exposed to it.

---

## 15. Rollout plan — small, independently testable checkpoints

| Checkpoint | Scope | Schema | Behaviour change | Proves |
|---|---|---|---|---|
| **G0** | This survey; owner decisions (§16); register rows claimed | none | none | — |
| **G1 — kernel** | `shared/_core/reasonCodes.ts`; `server/_core/governance/{decision,policy,evaluate,adapters}.ts`; rule modules `record.issued_immutable`, `tenant.boundary`, `ai.no_signature`, `mandatory.not_overridable`, `acceptance.required`; adapters from `authorize()`, `decide()`, `DispatchBlocker`; `governanceConformance.test.ts` (pure rows of §13); `engineReachability` `DECLARED_UNWIRED` entry with reason | none | none (pure, unreached) | the decision shape, precedence, and conformance harness |
| **G2 — receipts + explainable denials** | `0182`; `authorizationDecisions.reasonCode/orgRef` written by all three gates; `governedProcedure`; client renders `reasonCode`/`humanReason`; one pilot procedure moved (`manifestCustody.*` modify → `ISSUED_DOCUMENT_IMMUTABLE`) | `0182` | denial messages gain a code; one procedure's refusal becomes a receipt | receipt immutability; codes stable |
| **G3 — policy documents + acceptance** | `0183`; `policy.*` procedures; login/portal acceptance gate; `portal.invitation.accept` requires in-force portal terms; `pendingAcceptances` | `0183` | users and portal identities must accept in-force versions | backdating, version binding, no pre-check |
| **G4 — AI attribution** | outbox `actorSource: "ai"`; `agentRuns.tenantId NOT NULL`; `NEVER_AUTONOMOUS` ↔ `Permission` mapping test; receipt link on `agentActions`; `ai_disclosure` document | small ALTER (within `0183` or `0184`) | AI-drafted commits are visibly attributed | AI cannot sign/bypass |
| **G5 — account state + conduct** | `0184`; `accountStateEvents`; `roleProcedure`/`externalProcedure` consult it; `conduct.report`, `conduct.moderate`; `governance_review` queue in the Exception Centre | `0184` | suspensions enforce and are appealable | suspension not silent; review path |
| **G6 — privacy wiring** | mount `monitoringNotice` procedures; inventory doc under `docs/governance/`; export-of-record and erasure paths only after §16-D6/D7 | none | notices can be issued | coverage states |
| **G7 — organization-scoped roles** | coordinate with `claude/leaseos-auth-workspace-system-t008ad`; not a governance build | theirs | — | tenant isolation as a property |

Each checkpoint is one PR, passes `scripts/ci-gate.sh`, and regenerates `LEASEOS_CURRENT_STATE.md`.

---

## 16. Owner decisions required before implementation

| # | Decision | Why it blocks |
|---|---|---|
| D1 | Does the SPINE moratorium ("no new engines until the one-job path is wired") apply to a cross-cutting governance kernel? | G1 is a new `_core` module |
| D2 | Precedence between `client_contract` and `leaseos_terms`/`leaseos_privacy` (§9 places contract above terms; privacy narrows both) | resolver order |
| D3 | Which controls are `leaseos_mandatory_control` at launch: the current `NEVER_OVERRIDABLE` finding codes, `NEVER_AUTONOMOUS`, tenant boundary, receipt immutability — and whether the P8.4 automation safety floor is folded in | rule modules |
| D4 | Generalize `programAcknowledgements`/`monitoringNotices` into `policyAcceptances`, or keep three acceptance tables with one shared evidence shape | `0183` |
| D5 | Who is the second approver for LeaseOS-owned policy versions (a platform role that no customer organization holds) — implies a platform-operator role that does not exist in `DomainRole` | `policyDocumentVersions.approvedByUserId` |
| D6 | Retention periods, deletion execution, and legal-hold precedence per data class (L10) — **not invented here** | G6 |
| D7 | Whether a "my data" export and an erasure request are product features, and for which principals | G6 |
| D8 | AI disclosure wording and where the badge appears; whether `assistantProposals.transcript` gets a retention class | G4 |
| D9 | How a principal's jurisdiction is determined for jurisdiction-specific policy versions (organization address, `financialEntities.jurisdiction`, or explicit selection) | §10 |
| D10 | Which actions require `require_review` before enforcement (suspension, portal revocation, AI-flagged conduct) and who staffs the `governance_review` queue | G5 |
| D11 | Whether `insuranceRequirements` replace-all delete is acceptable or must become supersede | record-integrity rule scope |
| D12 | Fate of `users.role = admin` / `adminProcedure` | escape-hatch inventory |
| D13 | Move `APPROVED_OVERRIDE_POLICIES` from a code constant to `oosReleasePolicies`-style rows | G2 pilot scope |
| D14 | Legal sign-off on L2, L3, L7, L8, L9 texts before any version can be `approved` — the system can hold a `proposed` version with no approver until then | G3 |

---

## 17. Current behaviour inconsistent with the stated principles (reported, not fixed)

| # | Observation | Principle | Evidence |
|---|---|---|---|
| I1 | A user whose only membership is `suspended` or `ended` resolves to the **single-tenant fallback** instead of being refused, because `resolveActingScope` filters to `active` memberships and then falls back when none remain | least access, fail closed | `actingScope.ts:85-102` |
| I2 | One-year JWTs with no server-side revocation; `SameSite=None` without a documented CSRF policy; `JWT_SECRET` defaults to `""` and nothing refuses to boot | fail closed, security | `sdk.ts:190`, `cookies.ts:45`, `env.ts:3`, roadmap "Security" |
| I3 | Internal users have no suspension state at all; `organizations.status` and `organizationMemberships.status` exist but `roleProcedure` does not consult them | human accountability, enforcement | `schema.ts:3-12`, `trpc.ts:84-92` |
| I4 | Denials are prose; the client shows `error.message`; no stable codes at the API boundary | explainable enforcement | `trpc.ts:119-128`, client toasts |
| I5 | `authorizationDecisions` has no `orgRef` — a multi-organization audit cannot be filtered by tenant | tenant isolation, evidence | `schema.ts:3104` |
| I6 | `APPROVED_OVERRIDE_POLICIES` is a code constant (empty) — a change to it is a code review, not an approved, versioned, effective-dated policy row | policy changes auditable | `complianceFinding.ts:317` |
| I7 | `domainEventOutbox.actorSource = "ai"` exists and is never written; model contributions are attributed only through the committing human | AI attribution | grep result §1.4 |
| I8 | `agentRuns.tenantId` nullable | tenant isolation | `schema.ts:7143` |
| I9 | `monitoringNotices` engine has no router — a driver's GPS is read with no way to record that they were told | user awareness, privacy | §1.9 |
| I10 | Terms of Service / Client Portal Terms are DRAFT-PK; `portal.invitation.accept` activates an external identity with no terms shown | consent, no silence-as-acceptance | `trpc.ts:173-178`, legal register L3 |
| I11 | `insuranceRequirements` hard-deleted and rewritten on update | evidence preservation | `server/insuranceRouter.ts` |
| I12 | "Moderation is a separate authority" in code comments, but no such authority, report path, or rate limit exists | community standards, human review | `messageBoardRouter.ts:544,573` |
| I13 | `REMAINING_BUILD_REGISTER.md` P4.1 says tenant isolation is DONE; `LEASEOS_CURRENT_STATE.md` says it is NOT a property; the code supports the latter | transparency (documentation truth) | §1.3 |
| I14 | `users.role = admin` + `adminProcedure` is a coarse gate beside the ledgered one. Verified narrow: three uses — `records.bootstrapManagement` (writes `roleBootstrapEvents` through `bootstrapManagementRole`), `records.bootstrapStatus`, `system.notifyOwner`. Not a universal escape hatch today, but it writes no `authorizationDecisions` row | administrative override auditable | `trpc.ts:30-44`, `recordsRouter.ts:984-1004`, `systemRouter.ts:16` |
| I15 | Two migrations numbered `0157`; no duplicate-prefix gate | evidence/versioning discipline | `drizzle/`, roadmap |
| I16 | HOS `dailyLogs` has no production writer; the "completed HOS record" the conformance test would protect does not exist as a mutable record yet (attestations and scans are supersede-only) | truthful records — not a violation, but a test with no subject | §1.8 |
| I17 | LLM calls go to a vendor default host and transcripts are persisted with no retention class or disclosure | privacy, user awareness | `llm.ts`, `AI_RUNTIME_TERMINOLOGY.md` door 1 |
| I18 | **Verified:** the evidence upload takes `mimeType` as a client string and passes it straight to `storagePut`; no byte sniffing or magic-number check exists anywhere under `server/` | evidence integrity, security | `routers.ts:409-436` |
| I19 | **Verified:** `tripStops.create` and `.update` spread `...input` into the write and never record `ctx.user.id`; `tripStops` has no actor column on `main`. Provenance for trip stops is on an open branch (`claude/migration-0169-reconciliation`, `0179_trip_stop_provenance.sql`), not merged | truthful records, human accountability | `routers.ts:568-612`, `schema.ts:606` |

None of these were changed by this survey.

---

## 18. Recommended first implementation checkpoint: **G1 — the governance kernel, pure and unreached**

Why G1 and not G2: it needs no migration, cannot conflict with any open branch, does not change
production behaviour, does not touch the SPINE path, and produces the one artefact every later
checkpoint depends on — the decision type, the precedence resolver and the conformance harness —
while owner decisions D1–D3 are made. If D1 says the moratorium applies, G1 is still the right shape
because it is a resolver over things already written, which is the moratorium's own rule.

Files G1 would create:
- `shared/_core/reasonCodes.ts` — the catalog (§7).
- `server/_core/governance/decision.ts` — `PolicyAuthority` (extending `AuthorityClass`),
  `GovernanceActor`, `GovernanceRequest`, `GovernanceDecision`, `RULESET_VERSION`, `ruleSetHash()`.
- `server/_core/governance/policy.ts` — `PolicyRule`, `PolicyRowInForce`, precedence order.
- `server/_core/governance/evaluate.ts` — the pure resolver (§9).
- `server/_core/governance/adapters.ts` — `fromAuthorizationResult`, `fromGatewayDecision`,
  `fromDispatchBlocker`, `toInterEngineStatus`.
- `server/_core/governance/rules/{issuedImmutable,tenantBoundary,agentCannotSign,mandatoryNotOverridable,acceptanceRequired}.ts`.
- `server/_core/governance.test.ts` — unit cases per rule and per precedence branch.
- `server/governanceConformance.test.ts` — the pure rows of §13, enumerating from
  `dispatchReadiness.ts`, `actionGateway.ts`, `recordsAuthorization.ts` and the rules directory.

Files G1 would modify:
- `server/engineReachability.test.ts` — add `governance/*` to `DECLARED_UNWIRED` with the reason
  "wired at G2 through governedProcedure", so the gate stays honest in both directions.
- `docs/architecture/MIGRATION_COLLISION_REGISTER.md` — claim `0182–0184` for G2–G5 (no SQL yet).
- `docs/governance/TRUST_GOVERNANCE_SURVEY.md` — record D1–D3 answers.

Files G1 would **not** touch: `trpc.ts`, any router, `drizzle/`, `recordsAuthorization.ts`,
`actionGateway.ts`, `complianceFinding.ts` (the `PolicyAuthority` extension is a new type that
imports `AuthorityClass`; the existing ladder is unchanged).

Exit criteria: `pnpm check` clean; `pnpm test` green including the new suites; the CI gate's
reachability check passes with the declared entry; `LEASEOS_CURRENT_STATE.md` regenerated
(test-count rows change, nothing else).
