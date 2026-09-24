# SEC-1 — Tenant and resource authorization hardening: implementation plan

**Status:** plan for review. Nothing below is implemented. Base: `origin/main` = `6f52b57`. Baseline findings it
closes: V2, V3, V4, V6, V8, V9 (scope and permission halves), V11, V12 (ownership), V15
(`docs/security/LEASEOS_SECURITY_BASELINE.md` §17). Design sections it serves: §6.3, §6.4, §7 (interim projection),
§9 (interim), §15 (permission split).

**Why this is first:** every item is a predicate the codebase already has an idiom for (`*InScope`, `scopeWhere`,
`bookWhere`, `listActiveUserRoleNames`, `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED`), needs **no migration, no new
table, no new dependency, no owner decision**, and has a database-test idiom to copy (`server/tenantScope*.db.test.ts`).
It changes no gate, no permission map except one split, and no client.

**Shape of every item:** write the negative test → run its focused command → observe the named RED → add the
predicate → run again GREEN → run the structural suites → commit test and fix together (CI never sees a red commit;
the RED output is quoted in the commit body). One commit per item; the tranche is one branch and one PR.

**Standing commands**

| Purpose | Command |
|---|---|
| Focused suite (DB) | `DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos_sec1 pnpm exec vitest run <file>` after `bash scripts/apply-migrations.sh` against that disposable database |
| Focused suite (pure) | `pnpm exec vitest run <file>` |
| Typecheck incl. tests | `pnpm exec tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.tests.json` |
| Structural pins | `pnpm exec vitest run server/procedureAuthorization.test.ts server/tenantIsolation.test.ts server/engineReachability.test.ts server/authArchitecture.test.ts` |
| Full gate | `DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos_sec1 bash scripts/ci-gate.sh` (drops and recreates that database; gates 0–8) |
| Regenerate current state | `bash scripts/current-state.sh` (gate 8 fails otherwise) |

Test fixtures follow `server/tenantScopeRecords.db.test.ts:10-30`: `describe.skip` without `DATABASE_URL`, `org()`,
`member(orgRef, roles)`, `jobOwnedBy`, `unitOwnedBy`, `callerFor(userId)` over `appRouter.createCaller`. Across the
boundary the assertion is always `rejects.toMatchObject({ code: "NOT_FOUND" })`, never FORBIDDEN (the oracle rule
already in `attachmentAuthorizers.ts:113-117`).

---

## Item 1 — Assistant draft and commit cannot name another organization's records (V2)

**Files:** `server/routers.ts` (`fieldRoute.assistant.draft`, :670-726), `server/db.ts` (`proposalInScope`,
:916-925), `server/_core/assistantCommitAdapters.ts` (`applyIntent`, :361-661),
new `server/tenantScopeAssistant.db.test.ts`.

**Interfaces**
```ts
// server/db.ts — replaces the first-present-id rule with all-present-ids
export async function proposalInScope(proposalId: string, scope: TenantScope): Promise<boolean>
//   true only if EVERY non-null of jobId, tripId, unitId is in scope; false (→ NOT_FOUND) when the proposal is absent
// server/db.ts — new, used by draft before insert and by commit before write
export async function assistantTargetsInScope(t: { jobId?: number | null; tripId?: number | null; unitId?: number | null }, scope: TenantScope): Promise<boolean>
// server/_core/assistantCommitAdapters.ts — applyIntent receives `scope: TenantScope` and asserts, per adapter:
//   tripStops → tripInScope(stop.tripId); units → unitInScope; financialEntities/fuel → bookWhere org; loads → jobInScope; disposalTickets → jobInScope
```

**Failing tests first** (`server/tenantScopeAssistant.db.test.ts`; `vi.mock("./_core/llm", ...)` returns a fixed
extraction so no model is called):
1. member of A with `assistant.use` drafts with `jobId` owned by B → `NOT_FOUND "Job <id> not found"` (today:
   resolves, proposal stored).
2. draft with in-scope `jobId` and B's `tripId` → `NOT_FOUND` (today: resolves, because `proposalInScope` stops at
   jobId).
3. a proposal created legitimately in A; a `management` caller in B calls `assistant.get/answer/commit` → `NOT_FOUND`.
4. commit whose adapter target (a `tripStops` row of B) was reached by an id in the proposal fields → refused
   `NOT_FOUND`, **no row written** (assert row count on B's `tripStops` unchanged, no `assistantCommitReceipts`
   row).
5. positive: same flow entirely inside A commits and writes a receipt (guards against over-narrowing).

**Expected RED:** tests 1, 2, 4 fail with "expected promise to reject… resolved"; 3 passes today for `get` only
(pinned in `tenantScopeMonolithRecords.db.test.ts:41-44`) and fails for `answer/commit`.

**Minimal implementation:** in `draft`, `const scope = await scopeFor(ctx.user.id); if (!(await
assistantTargetsInScope(input, scope))) throw NOT_FOUND` before `invokeLLM` (so a foreign id never even costs a
model call); `proposalInScope` checks all present ids; `applyIntent` receives `scope` from `executeAssistantCommit`
(which already resolves the caller inside the transaction, :190-202) and calls the matching `*InScope` before each
write.

**Verify:** focused suite green; `pnpm exec vitest run server/assistantCommit*.test.ts server/aiProposal*.test.ts`
unchanged; structural pins green.

**Commit:** `Assistant proposals cannot name another organization's job, trip, unit or target row`.

---

## Item 2 — Compliance router scoped to the caller's organization (V3)

**Files:** `server/complianceRouter.ts` (`passport` :66-73, `jobPassport` :75-91, `medicalEligibility` :94-104,
`credentialRecord` :106-126, `credentialVerify` :129-138, `loadCredentials` :50-58), new
`server/tenantScopeCompliance.db.test.ts`.

**Interfaces:** reuse `operatorInScope(operatorId, scope)` (`db.ts:845`), `jobInScope`, `unitInScope`, and
`documentSubjectOwner(ownerType, ownerId)` (`db.ts` after :727) for document ids. No new exports.

**Failing tests first:**
1. dispatcher in B calls `compliance.medicalEligibility({operatorId: <A's operator>})` → `NOT_FOUND` (today: returns
   `eligible` for anyone).
2. `compliance.passport({subjectType:"operator", subjectId: <A's>})` from B → `NOT_FOUND`.
3. `compliance.credentialVerify({documentId: <A's>})` from B's safety → `NOT_FOUND`, row unchanged.
4. `compliance.credentialRecord` for A's operator from B → `NOT_FOUND`, no insert.
5. positive: A's dispatcher gets the projection (`eligible` in `yes|no|unknown`, nothing else — pins that this item
   did not widen the projection).

**Expected RED:** 1–4 resolve today.

**Minimal implementation:** each procedure resolves `scope` and asserts the subject via the matching helper before
`loadCredentials`; `credentialVerify` uses the scoped `db.reviewComplianceDocument` path (`db.ts:759-775`) instead
of the unscoped update.

**Commit:** `Compliance passport, eligibility and credential procedures answer not-found across the organization boundary`.

---

## Item 3 — Private credential rows are projected everywhere they are listed (V4)

**Files:** `server/db.ts` (`listComplianceDocuments` :718-727), `server/routers.ts` (`documents.list` :1521,
`documents.create` :1522-1543), `server/_core/compliancePassport.ts` (`PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED`
:282 — reused, not duplicated), new `server/_core/complianceProjection.ts`, new
`server/_core/complianceProjection.test.ts`, extension to `server/tenantScopeCompliance.db.test.ts`.

**Interfaces**
```ts
// server/_core/complianceProjection.ts — pure
export function projectComplianceDocument<T extends { privateDetail: boolean | null }>(row: T): T
//   when privateDetail is true, sets every field in PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED to null
export function isPrivateDocType(docType: string): boolean   // the rule credentialRecord already applies at complianceRouter.ts:123, moved here so create and record agree
```

**Failing tests first:**
1. pure: a `medical_fitness` row with `privateDetail:true` and a title → projected row has `title`, `identifier`,
   `storageKey`, `storageUrl`, `source` all `null`; `docType`, `expiresAt`, `verificationStatus` kept.
2. pure: `isPrivateDocType("medical_fitness") === true`, `("drivers_licence") === false`.
3. DB: A's office creates a medical document via `documents.create` and lists via `documents.list` → the row's
   private fields are null and `privateDetail` is `true` (today: full row, `privateDetail:false`).
4. DB: a non-private document lists unchanged (guards against over-projection).

**Expected RED:** 1–2 fail to import; 3 returns the title.

**Minimal implementation:** `listComplianceDocuments` maps rows through `projectComplianceDocument`;
`documents.create` derives `privateDetail: isPrivateDocType(input.docType)`; `complianceRouter.ts:123` calls the
same predicate. `records.evidence` and audit-package readers are unaffected (they already withhold `medical_*`).

**Commit:** `Private compliance documents are projected on every list path, and creation classifies them`.

---

## Item 4 — Approver standing counts only active, global grants (V6)

**Files:** `server/_core/commercialApprovalService.ts:30`, `server/commercialOfficeRouter.ts:207`, new
`server/approvalStanding.db.test.ts`.

**Interfaces:** replace the raw `userRoleAssignments` select with `listActiveUserRoleNames(userId)` (`db.ts:1252`),
which is the projection `authorize()` already trusts and `branchGrantLaundering.test.ts` pins.

**Failing tests first:**
1. a user whose `management` grant is revoked (`revokedAt` set) decides a cash approval → `blocked` (today:
   `approved`, `rolesAtApproval` contains `management`).
2. a user with only a branch-confined `office` grant → `blocked`.
3. positive: active global `management` → `approved`.

**Expected RED:** 1 and 2 approve today.

**Commit:** `Approval standing reads the same active global grants that authorization does`.

---

## Item 5 — Unscoped reads answer not-found across the boundary (V8)

One commit per bullet; each adds cases to the nearest existing `tenantScope*.db.test.ts` or a new one named in the
bullet. All use helpers that exist today; where a table has no organization column, the predicate derives through
the record's job, unit, ticket or preparer, and the plan says so — the column arrives in SEC-5.

| Procedure | File:line | Predicate to add | Test file |
|---|---|---|---|
| `closeout.documentRender` | `closeoutRouter.ts:327-360` | `fieldTicketInScope(ticketNumber, scope)` — the sibling idiom at `:478` | `tenantScopeCloseout.db.test.ts` |
| `audit.packageList/packageGet/packageView/packageDownload/packageRelease/packageWithdraw` | `auditRouter.ts:205-272` | list: `preparedByUserId IN (users in scope)` via `userInScope`; by-ref: `userInScope(p.preparedByUserId, scope)` else NOT_FOUND; recorded as interim until `auditPackages.orgRef` (SEC-5) | new `tenantScopeAudit.db.test.ts` |
| `restrictedVault.matterOpen`, `investigationPropose` | `restrictedVaultRouter.ts:57, 154` | `incidentInScope(incidentNumber, scope)` (`db.ts:864`); add an id-keyed variant `incidentIdInScope` beside it | `restrictedVault*.db.test.ts` (extend) |
| `restrictedVault.breakGlass` | `restrictedVaultRouter.ts:226-252` | `recordType` becomes `z.enum` of kinds with an `*InScope` helper; the target must resolve in scope or NOT_FOUND; grant row unchanged otherwise | same |
| `surfaces.exceptions` / `myDay` loaders | `surfacesService.ts:68-72, 307-318` | `loadOpenSecurityIncidents(db, orgRef)` filters `securityIncidents.orgRef`; compliance titles through `documentOwnerOrg`; proposals through `proposalInScope` | `inboxIsolation.test.ts` (extend) + new db case |
| `surfaces.search` (14 queries) | `surfacesService.ts:206-246` | per query: `orgScopeWhere` where the table has `orgRef`; through `jobs.orgRef` for job-linked tables; through `coreRecordOwnership` for units/operators; a table with no path is **excluded from search** for non-default scopes until SEC-5 (documented in the commit) | new `tenantScopeSearch.db.test.ts` |
| `comms.packageFetch`, `packageStatus` | `commsRouter.ts:747-805` | through the package's `jobId`/`tripId`/`unitId` (`0076:21-23`) using `jobInScope`/`tripInScope`/`unitInScope`; a package with none → default scope only | `tenantScopeComms.db.test.ts` (new) |
| `portalAdmin.identityInvite`, `identityRevoke` | `commercialRouter.ts:107-133` | invite: `orgScopeWhere` on the bound account — `customerAccounts.orgRef`, `vendors.orgRef`, `facilities.orgRef` all exist (verified in `drizzle/schema.ts`); revoke: load the identity, then the same predicate on whichever account it is bound to; foreign → NOT_FOUND. Invite on a vendor must also not flip `vendors.portalEnabled` before the scope check (today it does, :114) | `commercialPortal.test.ts` (extend) |
| `commercialOffice.deliveryUpdate` | `commercialOfficeRouter.ts:645-654` | the `bookWhere` check its sibling `documentDeliveryRecord` uses (:636-637) | `tenantScopeMoney.db.test.ts` (extend) |
| `device.verifySeal`, `sync.resolveConflict`, `sync.receivePackage` item ids | `deviceRouter.ts:274-305, 362-424` | `evidenceInScope(evidenceRecordId, scope)` per item; conflict via its evidence | `tenantScopeFieldRuntime.db.test.ts` (extend) |
| every by-number `invoices` lookup: `render`, `send`, and the four other reads at `invoicingRouter.ts:82, 101, 180, 192` | `invoicingRouter.ts:60-192` | new `invoiceInScope(invoiceNumber, scope)` in `db.ts` beside the other `*InScope` helpers: in scope when `customerAccounts.orgRef` of `invoices.customerAccountId` matches, else when `jobInScope(invoices.jobId)`, else default scope only when both are null (the `fieldTicketInScope` shape, `db.ts:834-843`). The ticket loader at `:27` uses `fieldTicketInScope` | `tenantScopeMoney.db.test.ts` |

Each bullet's RED is "resolves today from a member of another organization"; each GREEN is `NOT_FOUND` plus an
unchanged positive case for the owner.

---

## Item 6 — Security-incident state changes require review authority; loaders and organization inputs are validated (V9)

**Files:** `server/securityIncidentsRouter.ts` (:56-75, :77-82), `server/_core/recordsAuthorization.ts` (one new
procedure entry in the operational map; `procedureAuthorization.test.ts:161` pin moves 634 → 635),
`server/surfacesService.ts:307-318` (from Item 5), `server/securityIncidents.db.test.ts` (extend).

**Interfaces**
```ts
// securityIncidentsRouter.ts
timelineAppend: roleProcedure("securityIncidents.timelineAppend")   // eventType narrowed to evidence_added | scope_changed | customer_identified; never moves status
statusChange:   roleProcedure("securityIncidents.statusChange")     // NEW; eventType triage | contained | recovery | reopened; permission incident.review
organizationAffect: validates input.orgRef exists in `organizations` → else NOT_FOUND
```

**Failing tests first:**
1. a driver in A appends `contained` to A's incident → `FORBIDDEN` (today: status becomes `contained`).
2. a driver appends `evidence_added` → allowed (guards the note path).
3. `organizationAffect` with an unknown `orgRef` → `NOT_FOUND` (today: inserted).
4. safety in B calls `surfaces.exceptions` → A's open incident is absent (today: present).
5. `procedureAuthorization.test.ts` count pin updated in the same commit.

**Commit:** `Security-incident state moves only under review authority, and the exception centre stops crossing organizations`.

---

## Item 7 — The duplicate-upload path never returns another user's record (V11)

**Files:** `server/db.ts` (`findEvidenceByClientCaptureRef` :202-207), `server/routers.ts` (`evidence.upload`
:427-430), `server/evidence*.test.ts` (extend or new `evidenceCaptureRef.db.test.ts`).

**Interface:** `findEvidenceByClientCaptureRef(clientCaptureRef, { capturedByUserId })` returns the row only when it
belongs to the caller; a foreign holder of the same ref yields `CONFLICT "capture reference already used"` with no
id or key in the message.

**Failing tests first:** user B uploads with A's `clientCaptureRef` → today receives A's `id` and `storageKey`;
expected `CONFLICT`, response carries neither. Positive: the same user re-uploading gets the idempotent reply.

**Commit:** `A capture reference is idempotent for its own uploader only`.

---

## Item 8 — Client-supplied storage keys must be the caller's or already in scope (V12, ownership half)

**Files:** `server/_core/storageKey.ts` (extend, no rename), the six inputs (`routers.ts:462, 1529, 1618`;
`recordsRouter.ts:104`; `hosRouter.ts:76`; `commercialOfficeRouter.ts:554, 577`), `server/_core/storageKey.test.ts`
(extend), one db case per input in the nearest `tenantScope*.db.test.ts`.

**Interface**
```ts
// server/_core/storageKey.ts — pure, beside isValidStorageKey
export function storageKeyOwner(key: string): { kind: "user"; userId: number } | { kind: "server"; prefix: "tickets" | "invoices" | "audit" | "generated" } | null
// server/db.ts
export async function storageKeyReferencedInScope(key: string, scope: TenantScope): Promise<boolean>   // any evidenceRecords/complianceDocuments/maintenanceDefects row in scope already carrying it
```
Rule at each input: accept if `storageKeyOwner(key)` is the caller, or the key is already referenced by a row in
scope; otherwise `BAD_REQUEST "storage key is not yours"`. Every server-minted prefix is enumerated in the test the
way `storageKey.test.ts` already enumerates minted shapes, so a legitimate key cannot be refused.

**Failing tests first:** B supplies `"<A userId>/evidence/…"` on `evidence.add` → today accepted; expected refused.
Positive: A's own key accepted; a `tickets/…` key referenced by A's ticket accepted from A's office.

**Commit:** `A client may only cite a storage key it owns or that its organization already holds`.

---

## Item 9 — Port the webhook tenant-isolation fix and its test (V15)

**Files:** `server/webhookDispatchService.ts:29-40`, `server/webhookTenantIsolation.db.test.ts` (ported from
`origin/feature/tenant-scope-foundation` commit `3c4f997`, cited in the commit message; no semantics changed).

**Failing test first:** two subscriptions in A and B, an event in A → today B's secret is decrypted (observable via a
spy on `decryptSecret`); expected: only A's, and only A's subscription is attempted.

**Commit:** `Webhook dispatch filters subscriptions by tenant before decrypting any secret (port of 3c4f997)`.

---

## Integration, negative and regression tests for the tranche

- **Integration:** `bash scripts/ci-gate.sh` gates 0–8 against a disposable MariaDB; every `tenantScope*.db.test.ts`
  must run (gate 6 fails if one skips).
- **Negative families added by this tranche:** wrong tenant (every item), correct permission wrong record (Items 1,
  2, 5, 7, 8), cross-tenant object id (1, 5), manipulated body `orgRef` (6), direct id access (2, 5), role without
  the right permission (6), revoked grant (4), branch-confined grant (4).
- **Security regression pins:** extend `server/tenantIsolation.test.ts` with a case that greps the routers changed
  here for the predicate call (the `wiring guard` idiom from Checkpoint H), so a future edit that removes a
  `*InScope` call fails the pure suite without a database.
- **Not touched, verified unchanged:** `procedureAuthorization.test.ts` counts except the +1 in Item 6;
  `engineReachability.test.ts` (57); `authArchitecture.test.ts`; `branchGrantLaundering.test.ts`.

## Commit boundaries

Nine commits in the order above, each self-contained (test + fix), each with the RED output quoted. Item 5 is one
commit per row of its table. `LEASEOS_CURRENT_STATE.md` is regenerated in the last commit (test-file count changes).
PR title: `SEC-1: tenant and resource authorization hardening`. PR body: the baseline rows closed, the pre-existing
failures observed in the baseline run (the 14 `fieldroute.test.ts` DB-dependent cases noted in
`audit/hardening-2026-09-21/REMEDIATION.md` if they recur), and the dependency-rule statement "no dependency added".

## Rollback

Every commit is a code-only change with no migration: `git revert <sha>` restores the previous behaviour and its
tests. No data is transformed, so nothing needs a down step. Reverting Item 6 must also revert the map count pin.

## What this tranche deliberately does not do

- No organization column on any table (SEC-5); derived predicates are marked interim in each commit.
- No change to `resolveActingScope` or `single_tenant_fallback` (SEC-5).
- No session, step-up, classification enum, encryption or perimeter work (SEC-2, SEC-4, SEC-6, SEC-8, SEC-3).
- No MIME sniffing or malware scanning (SEC-3 / SEC-6): Item 8 is ownership only.
- No client changes.

## Stop condition

After the ninth commit is green on the full gate and the PR is opened, stop and request review. Approval of this
plan is not approval to begin; approval of the PR is not approval of SEC-2.
