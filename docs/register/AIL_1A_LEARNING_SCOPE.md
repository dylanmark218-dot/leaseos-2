# AIL-1A: governed learning scope foundation

**Purpose:** give LeaseOS a deterministic, server-controlled answer to "**who owns this learning?**"
before it starts learning anything more.

- Design and rulings: `docs/register/AI_GOVERNED_LEARNING_DESIGN.md` §13 (R-1 … R-8), and
  `docs/register/AIL_3R_RESEARCH_GATEWAY_DESIGN.md` §7 (RR-1 … RR-8).
- Characterization baseline: `docs/register/AIL_0_SAFETY_CHARACTERIZATION.md`.
- Baseline: `b1ce035` on `claude/relaxed-carson-qfcopf` (`main` `6f52b57` plus the governance and
  design documents).

**Not in this checkpoint:**
- no model or tool wiring, and no provider activation;
- no web research;
- no personalization, correction aggregation or topic-frequency learning;
- no skills;
- no promotion of any kind;
- no retention engine.

SEC-OUTBOUND-1 **remains open**. AIL-1B and AIL-1C **were not started**.

**Production behaviour change: yes, and deliberately so.** Assistant proposals are now contained to
their organization, and a draft can no longer name another organization's records. Everything that
changed is listed in §6.

---

## 1. The scope contract

One module: `server/_core/learningScope.ts`. It is reached from `server/routers.ts` and
`server/db.ts`, so the engine census counts it as reached and its pin stays at 57.

| Scope | Carries | Visible to | Built from |
|---|---|---|---|
| `GLOBAL` | a `PlatformAuthority` | every organization | **nothing**: see §3 |
| `ORGANIZATION` | `orgRef`, `derivedFrom` | that organization | `organizationScopeFrom(acting)` |
| `USER` | `orgRef`, `userId`, `derivedFrom` | that person, in that organization | `userScopeFrom(acting, sessionUserId)` |
| `SESSION_JOB` | `orgRef`, `userId`, `subject {job \| trip \| agent_run, ref}`, `derivedFrom` | that person, in that organization, in that job | `sessionJobScopeFrom(acting, userId, verifiedSubject)` |

Properties that hold by construction:

- **The kind is stated.** Every scope carries a `kind` discriminator. "No organization id, therefore
  global" is not a rule anywhere in the module, and a missing organization is refused as
  `NO_ORGANIZATION`.
- **Scopes cannot be forged.** Each scope type is branded with a `unique symbol`, the same pattern
  as `AdmittedContextBlock`. The only producers are the constructors above, and they take an
  `ActingScope` (from `resolveActingScope()`) and the session's user id. None of them takes an
  organization or a user id from a caller.
- **One resolver.** `resolveLearningScope({ db, userId, request, verifySubject })` is the only entry
  point. The request names a *kind*, plus a subject for SESSION_JOB, and nothing else. It is refused,
  in this order:
  1. any identity-asserting key, anywhere in the request (`organizationId`, `orgRef`, `tenantId`,
     `userId`, `createdByUserId`, `scope`, `authority` and their spellings):
     `SCOPE_IDENTITY_CLAIM_REFUSED`, even when the value names the caller's own organization;
  2. `GLOBAL`: `GLOBAL_REQUIRES_PLATFORM_AUTHORITY`;
  3. an unknown kind: `SCOPE_KIND_UNKNOWN`;
  4. a non-person principal, such as the cron user `-1`: `NO_AUTHENTICATED_USER`;
  5. two live memberships: `AMBIGUOUS_ORGANIZATION`. It never picks one.
- **Scope is not permission.** The module imports nothing from `recordsAuthorization`. `canSee()` and
  `canTarget()` answer containment only. Authorization stays in `roleProcedure` / `authorize()`.
- **No upward conversion.** No exported function turns one scope kind into a wider one. A test pins
  the export list. USER→ORGANIZATION and ORGANIZATION→GLOBAL promotion are later, governed
  checkpoints.
- **SESSION_JOB is context, not learning.** `isDurableScopeKind("SESSION_JOB") === false`.
  `requireDurableTenantScope()` refuses SESSION_JOB, GLOBAL and a missing owner.
- **What a USER may hold.** A USER or SESSION_JOB scope may hold presentation settings only:
  presentation, accessibility, answer detail, input mode and terminology display.
  `scopeMayHold("USER", c)` is false for every class in `ORGANIZATION_SETTING_CLASSES`: safety,
  compliance, HOS, TDG, permits, permissions, automation, dispatch authority, job assignment,
  regulatory and company procedure. Already true in the existing code: automation policy has no user
  scope at all (`SCOPE_ORDER` is tenant → role → task → customer), and an operator override can only
  make a task more manual.
- **NULL belongs to nobody.** `rowInTenant(row, scope)` is strict equality: a NULL, empty or missing
  tenant matches nothing, not the default tenant and not everybody.

## 2. Trusted derivation path

```
session cookie / bearer → sdk.authenticateRequest → ctx.user.id
                                               ↓
resolveActingScope(db, ctx.user.id)  → { tenantId, derivedFrom }   (never reads input)
                                               ↓
organizationScopeFrom / userScopeFrom / sessionJobScopeFrom(…, verifySessionJobSubject(…, sessionJobSubjectInScope))
```

SESSION_JOB subjects are checked with existing tenant helpers through `sessionJobSubjectInScope`
(`server/db.ts`), and a job or trip ref must be a plain positive integer:

| Subject | Check |
|---|---|
| `job` | `jobInScope` |
| `trip` | `tripInScope` |
| `agent_run` | `agentRuns.tenantId` by strict equality; a run with a NULL tenant anchors nobody |

Anything else is `SESSION_JOB_SUBJECT_UNSUPPORTED`. "Not found" and "someone else's" are the same
answer.

## 3. GLOBAL

**No principal can write GLOBAL learning today.** The repository has no platform role (R-6, and
trust-governance D5 is open). So:

- `PlatformAuthority` is a branded type with **no constructor exported anywhere**. A test scans every
  production file and pins that none casts or forges one.
- The request path's return type is `TenantLearningScope`, which excludes GLOBAL. A request for
  GLOBAL is refused by name.
- `canTarget(anyTenantActor, GLOBAL)` is refused, so tenant-originated learning cannot be written as
  GLOBAL.
- GLOBAL is **not** represented as `orgRef = NULL`.
- Each of these is pinned by test as *not* platform authority:
  - `users.role = 'admin'`;
  - a role grant with `scopeType = 'global'`;
  - `ActingScope.global` (which means "not branch-confined");
  - a `system` tenant proof;
  - a missing organization.
- `perimeter.promote()`, which moves reviewed material into the authoritative (global) rule store,
  now **requires a `PlatformAuthority`**. Production code cannot supply one, so ORGANIZATION → GLOBAL
  promotion is closed there. Its existing validation tests still run, using a test-only forged
  authority. The live HOS promotion ledger (`promotionLedger.promote`, `hos.limitPromote`) is a
  different function and was not touched.

## 4. The three known problem areas (AIL-0 Gap C)

### 4.1 Assistant proposals: fixed

**Migration `0185_assistant_proposal_tenancy.sql`.** A migration is required: a proposal with no
job, trip or unit (an expense receipt, say) has no other durable fact to derive its organization
from.

- **Columns.**
  - `tenantId varchar(40) NULL`
  - `tenantDerivedFrom enum('membership','single_tenant_fallback','backfill_single_tenant_deployment','legacy_unresolved') NOT NULL DEFAULT 'legacy_unresolved'`
  - The default is the fail-closed marker, not a tenant.
- **CHECK `assistantProposals_tenant_shape`.** `tenantId` is NULL if and only if the row is
  `legacy_unresolved`. MariaDB enforces it, and a database test proves both bad shapes are refused.
- **Index.** `(tenantId, commitState, createdAt)`.
- **Legacy rows.** If `organizationMemberships` is empty when the migration runs, no user can ever
  have resolved to anything but `'default'` (the resolver returns another organization only through a
  membership row, and no production path writes one). In that case every existing row is stamped
  `'default'`, marked `backfill_single_tenant_deployment`. Otherwise **nothing is assigned**: rows
  stay `legacy_unresolved`, invisible to everyone and committable by nobody until a person resolves
  them. Nothing is inferred from jobs, trips, units or the creator, and nothing becomes global. A test
  pins the migration text.
- **NULL here means "unresolved".** It is never "global" and never "the default tenant's".

**Enforcement, all on the proposal's own tenant:**

| Path | Before | Now |
|---|---|---|
| `assistant.draft` | owner never recorded; job, trip, unit and target ids copied from the body unchecked | refuses `tenantId`, `orgRef`, `organizationId`, `createdByUserId` and `tenantDerivedFrom` in the body (BAD_REQUEST, not dropped); checks **every** anchor (job, trip, unit, and `targetRecordId` as a trip stop on the proposal's trip for `unload_stop`, or as a financial entity for `expense_receipt` / `fuel_receipt`) **before the model is called**; stamps `tenantId` and `tenantDerivedFrom` from the acting scope |
| `get` / `answer` / `setStatus` / `readBack` / `acknowledge` / `commit` / `reject` (through `proposalInScope`) | owner inferred from the first non-null of job, trip or unit, else the single tenant; a missing row returned "in scope" | strict `rowInTenant(proposal, scope)`; a missing or unresolved row is "not found" |
| `assistant.pending` | no tenant filter without a `tripId` | the query carries `tenantId = acting` on both branches |
| `executeAssistantCommit` (any caller) | no tenant check of its own | resolves the actor's scope **inside the transaction**; refuses another organization's or an unresolved row as "Proposal not found"; re-checks every anchor with the same rule as draft, **on the transaction's own connection** (`proposalAnchorRefusal(tx, …)`), before any field is read |
| Exception Centre AI proposals | every organization's `awaiting_readback` proposals | the caller's organization only. With no scope passed, the proposal slice is empty (fail closed). TEN-EXC-1 later made the scope a required argument for every source. |
| Inbox "my proposals" | by creator only | by creator **and** tenant |

`proposalFields` has no tenant column by design: it is reached only through its proposal, and one
owner per proposal means there is no second copy to disagree with.

### 4.2 Aliases: no schema change, and one correction to the approved design

`facilityAliases` is **GLOBAL public-directory reference data**. It holds regulator and operator
names for a shared disposal facility, can only point at a facility, is written only by seed and
import procedures, and has no AI reader. Adding a tenant column would either create a table where
NULL means global, or put a false owner on public rows.

**This departs from the approved design text** (`AI_GOVERNED_LEARNING_DESIGN.md` D-4, and the AIL-0
todo). A company's own terminology ("Bluebird" = "Bluebird #4 Battery") belongs in a separate
ORGANIZATION-scoped record written only through a proposal. That record is AIL-1B work. Until it
exists, alias containment is enforced by:
- `canSee()`: tested with the same term meaning two different things in two organizations;
- `assembleContext()`'s `CrossTenantContext` refusal, from AIL-0.

**Owner confirmation requested.**

### 4.3 Learning intake: fixed (still unwired)

- `LearningIntake.owner: DurableTenantScope` is **required**. An ownerless intake does not compile,
  and an AIL-0 `@ts-expect-error` pins that.
- `routeLearning()` refuses a SESSION_JOB, GLOBAL or missing owner at runtime, and echoes the owner
  unchanged on the decision. The claim's text never sets it.
- `perimeter.ts` still has no production importer. The census and the AIL-0 Gap D pin are
  unchanged.

## 5. Invariants → tests

`server/learningScope.test.ts` (36 cases, pure) and `server/learningScope.db.test.ts` (17 cases,
database: two organizations, forged ids, a legacy row, an ambiguous member).

| # | Invariant | Where proved |
|---|---|---|
| 1 | Org A cannot read org B's organization-scoped learning | pure `canSee`; database: every proposal read path returns NOT_FOUND |
| 2 | Org A cannot modify org B's | pure `canTarget`; database: answer / setStatus / commit, and a direct `executeAssistantCommit` |
| 3 | A user cannot read another user's USER scope | pure `canSee` (`OTHER_USER`) |
| 4 | USER scope is bounded by organization | pure: same numeric user id in another org → `CROSS_ORGANIZATION` |
| 5 | A request body cannot change trusted scope | database: resolver refuses forged ids; draft refuses five identity fields |
| 6 | A model or tool payload cannot change scope | database: a mocked model response carrying `organizationId`, `tenantId` and `userId` leaves the stamped tenant unchanged. The model's output is never read for identity; the owner comes from the session. Pure: a scope *request* carrying the same keys is refused by name. |
| 7 | SESSION_JOB refs cannot cross organizations | database: another organization's job, trip and agent run → NOT_FOUND; an agent run with a NULL tenant anchors nobody |
| 8 | Tenant records cannot be created as GLOBAL | pure `canTarget(…, GLOBAL)`; database: GLOBAL refused for a manager/controller/safety holder |
| 9 | GLOBAL requires platform authority | no constructor; forgery scan over all production files; the lookalikes in §3 pinned as not authority |
| 10 | NULL organization is not global | `rowInTenant(null, …)` false for every scope; `NO_ORGANIZATION` refusal |
| 11 | Legacy or unresolved ownership fails closed | database: a `legacy_unresolved` proposal is invisible to its creator, to the default tenant and to the pending list, and cannot be committed |
| 12 | Company aliases do not leak | pure: the same term with two meanings in two organizations; AIL-0 `CrossTenantContext` |
| 13 | Company proposals do not leak | database: §4.1 paths, the Exception Centre and the pending list with and without a trip; a row stamped A that names B's trip is refused at commit by the anchor re-check; drafts naming B's financial entity, or a trip stop on another trip, are refused |
| 14 | Learning intake receives trusted ownership | pure and database: the owner comes from the resolver, and a claim naming another org does not move it |
| 15 | User preferences cannot weaken org safety | pure `scopeMayHold`; characterization that automation policy has no user scope and overrides only narrow |
| 16 | Session context does not become durable learning | pure `requireDurableTenantScope`; `routeLearning` refuses a session owner |

**The tests catch real regressions.** Six protections were each reverted temporarily, and the
database suite failed every time:

| Reverted protection | Result |
|---|---|
| old `proposalInScope` | 2 failures |
| unscoped pending list | 2 failures |
| no commit-side tenant check | 2 failures |
| unchecked draft anchors | 1 failure |
| no commit-side anchor re-check | 1 failure |
| no financial-entity anchor check | 1 failure |

## 6. Intentional behaviour changes

1. **A proposal is visible only to its own organization.** Before, a proposal with no job, trip or
   unit was visible to every user without a membership. A member who created one could not see it.
2. **A draft naming another organization's records is refused** (NOT_FOUND) before the model is
   called. This includes a mixed-anchor draft, where the first anchor is the caller's and a later one
   is not.
3. **A draft body carrying an owner field is refused** (BAD_REQUEST).
4. **A commit re-checks the proposal's owner and anchors inside its transaction, on the transaction's
   own connection.** A proposal naming a
   job, trip or unit that does not exist is now refused at commit, where before it was committed.
   Three test fixtures named such ids (a random trip id, job `4242`, trip `8844`). They now create real
   records; the assertions were not loosened.
5. **Pending lists, the Exception Centre's AI proposals and the inbox are tenant-filtered.**
6. **After 0185, on a deployment that already has memberships, pre-existing proposals are
   unresolved.** They are hidden until a person resolves them. On a deployment with none they stay
   the single tenant's.
7. **`perimeter.promote()` requires a platform authority** that nothing in production can supply.
   It is unwired, so nothing observable changes.

## 7. NULL-as-global patterns found, not expanded, not fixed

The survey found several existing places where NULL organization means shared or global. AIL-1A
adds none and fixes none of them, because they are outside its scope:

- the commercial office's NULL book (`commercialOfficeRouter.ts` `bookWhere`, `commercialPolicy.ts`);
  this also makes default-tenant writes into platform defaults;
- the dispatch role catalogue (`dispatchRoleTypes.orgRef IS NULL`);
- the global dispatch-enforcement row;
- platform-default workflow rules and responsibilities (`workflowEngine.ts` `!r.tenantId`);
- the inbox's `isNull(tenantId)` branches for tasks and notifications;
- `contextAdmission`'s `system` proof, which skips the tenant check for any block kind.

## 8. Follow-ups: for AIL-1B, or recorded separately

> **Update (AIL-1A.1):** each item below is classified, and the category-A/B/C items fixed, in
> `AIL_1A1_TENANCY_HARDENING.md` §3. The alias correction (§4.2) and the `assistantQueries` scope
> question are ruled on there.

- **AIL-1B:**
  - an ORGANIZATION-scoped terminology/alias record (§4.2), written only through a proposal and
    looked up organization-first with a GLOBAL fallback;
  - restrict `contextAdmission`'s `system` proof to the `system_prompt` kind **before** any learned
    artifact is admitted to a model context, because the ask path does not run `assembleContext`.
- **Owner ruling needed:** is `assistantQueries` history USER- or ORGANIZATION-scoped? Today any
  `assistant.ask` holder in the organization sees everyone's questions, drivers included.
- **Separate tenancy defects found by the survey** (not AIL-1A):
  - the Exception Centre's *other* sources are unscoped (fixed in TEN-EXC-1);
  - `documentFingerprints` duplicate priors are matched across tenants in the commit service;
  - `merchantMemory` has no organization (it is unwired);
  - `trips.create`, `agent.requestAction` targets and `manifestCustody.bind` take unchecked ids;
  - `surfaces.search`, `timeline` and `chain` apply no tenant filter. Records created at commit carry
    the proposal id (`FUEL-…`, `DSP-AI-…`, `EXP-AI-…`), so another organization's committed proposal ids
    can be listed there. They cannot be read or changed through the proposal paths.
  - the commit adapters also read `loadId`, `facilityId`, `fleetCardId` and `operatorId` from the
    proposal row without a tenant check. No production path writes those columns today (the draft's
    input drops them), but the first writer must add them to `proposalAnchorRefusal`.
  - `assistantQuestions` has no tenant (and no production caller);
  - `agentRuns.tenantId` is nullable (trust-governance G4).
- **Coordination.** `feature/tenant-scope-foundation` rewrites `actingScope.ts` and redefines NULL
  `orgRef` as unattributed. AIL-1A deliberately did not touch `actingScope.ts`.

## 9. Verification

Full `scripts/ci-gate.sh` against a disposable `mariadb:10.11` container (the CI image), from a
clean database:

| Gate | Result |
|---|---|
| 0 Reserved migration slots | pass |
| 1 Clean database | pass |
| 2 Migrations, including `0185` | pass |
| 3 Table parity | pass |
| 4 Typecheck, and the test-file ratchet | pass, 0 test-file errors (ceiling 0) |
| 5 Bare `protectedProcedure` | pass |
| 6 Test suite | 335 of 337 files passed. **1 AIL-1A failure, fixed:** `operationalTruth.test.ts` pins the list of refused fields in `routers.ts`, and the five new draft refusals were added to it (`5808636`). **1 pre-existing failure, not fixed:** the `calendarFixtures.test.ts` clock tripwire on `capitalAssets.test.ts`, already recorded at AIL-0. `columnParity`, `tenantIsolation` and every AIL-1A suite passed against MariaDB, and no database suite was skipped. |
| 7 Production build | pass (run by hand, because the script stops at gate 6) |
| 7b / 7c Portal and inbound gates | pass |
| 8 Current-state document | current |

**Adversarial review.** Four independent lenses reviewed the diff (tenant isolation, correctness,
scope-contract soundness, test and documentation honesty), and a skeptic per lens tried to refute
each finding against the code. Three findings survived, and all three are fixed:

1. The commit-time anchor re-check ran on pool connections outside the transaction, which made the
   "inside its transaction" claim false and risked exhausting the pool under concurrent commits. It
   now runs on the transaction.
2. The commit-side re-check and two draft anchor branches had no test. Three database cases were
   added, and each is mutation-checked.
3. The module header said model output naming an organization was "refused". It is never read for
   identity, which is what is now stated.

The other findings were refuted on reading the code. They are recorded in the review transcript, not
here.
