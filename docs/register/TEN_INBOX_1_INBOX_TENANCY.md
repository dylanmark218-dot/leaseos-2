# TEN-INBOX-1: inbox, task and notification tenant isolation

**Invariant:** a role match does not create tenant ownership. Being a manager, dispatcher, safety,
controller or administrator in organization A never delivers organization B's work item.
Ownership comes first; role and person are audience qualifiers after it.

Baseline: `30f6c6b` (AIL-1B, approved). Branch: `claude/relaxed-carson-qfcopf`. **No migration.**
SEC-OUTBOUND-1 remains open. AIL-1B.1 and AIL-1C were not started.

## 0. Owner rulings recorded (2026-10-01)

| Ruling | Recorded as |
|---|---|
| **B1** AI may later read APPROVED company knowledge | Future checkpoint **AIL-1B.1**, after TEN-INBOX-1. Entries go in as data, never system authority, capability, authorization, compliance or tool permission. Admission requires the active organization, `approved` (not superseded or retired), and relevance. Provenance kept: entry id, kind, revision, reviewer, approval time, source, organization, admission time. |
| **B2** automatic knowledge-gap signals | Approved with privacy boundaries, not implemented. The signal carries no raw text, wording, transcript, name or user id. Candidate threshold: at least 3 qualifying events from at least 2 distinct users within 30 days. It creates a candidate only, never approved knowledge. One person's repeated questions stay private. Recorded for AIL-1B.1 or a later learning-signal checkpoint. |
| **B3** `merchantMemory` | Must not be consumed while it lacks proven ownership. Missing ownership is not GLOBAL. No silent copying into organization knowledge. See §6. |
| **B4** who may propose company knowledge | Kept as is: every authorized assistant user, drivers included. Proposal is not authority. |
| **B5** unowned inbox data | This checkpoint. |

## 1. Source matrix (surveyed before any change)

| # | Source | Tenant column | User target | Role target | Anchors | Writers and how the tenant was set | Readers / delivery | Before | After |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `operationalTasks` | `tenantId` NOT NULL | `assignedUserId` | `assignedRole` NOT NULL | `jobId`, `tripId`, `unitId` (id strings), subject | workflow runtime (from the outbox row's tenant); requirement licence task (`row.orgRef ?? "default"`) | `loadInbox` → `surfaces.inbox`, `surfaces.myDay`, the inbox and My Day widgets | tenant **or NULL** (dead branch), anchors unchecked | strict tenant, and every anchor's owner must agree (`taskInScope`) |
| 2 | `workflowNotifications` (internal) | `tenantId` NOT NULL | `recipientUserId` | `recipientRole` | `taskId` | workflow runtime (task's or event's tenant); enforcement outbox (claimed event's tenant) | same as #1 | tenant **or NULL** (dead branch) | strict tenant, and the linked task must be the same organization's (`notificationInScope`) |
| 3 | `workflowNotifications` (customer alerts, `external:<identityRef>`) | `tenantId` | — | the external identity | customer account | `queueCustomerAlert`: `args.tenantId ?? "default"`, and no caller ever passed it, so **every customer alert went to `"default"`** | `portal.alerts`, `portal.approvalQueue` (unread count), `portal.alertAcknowledge` | role string only, with no tenant predicate | written under the owner of the account's **book**; read and acknowledged only under that owner |
| 4 | `domainEventOutbox` → rules | `tenantId` NOT NULL | — | — | job, trip, unit | enforcement (acting scope); finance legacy book (`ent?.orgRef ?? "default"`) | drain worker (all tenants, carries the row's tenant forward); webhooks (strict) | `"default"` for a missing book | a missing book is refused; a NULL book owner is the single tenant (0146) |
| 5 | workflow dedupe read | — | — | — | subject | — | `applyEventConsequences` | open tasks of **any** tenant for the subject decided dedupe | only the event's tenant's open tasks |
| 6 | calendar `forScheduling` / `exceptions` | `leaveRequests.tenantId` (nullable) | `input.userId` | — | — | — | dispatcher view of a person's calendar | another organization's person's leave windows were returned (private ones redacted) | that person must be in the caller's organization, otherwise "not found" |
| 7 | assistant proposals / questions, purchase approvals, sync conflicts in the inbox | various | — | — | — | — | `loadInbox` | scoped in AIL-1A and TEN-EXC-1 | unchanged |
| 8 | `agentRuns` / `agentApprovals` | `tenantId` | initiator | — | — | acting scope | per-run reads, strict | no approval queue exists | unchanged (nothing to deliver) |
| 9 | `messageChannels` / board messages and receipts | `tenantId` | per-user receipts | crew audience | — | acting scope | strict | — | unchanged |
| 10 | `organizationInvitations` | `orgRef` NOT NULL | email | — | — | acting scope | list and cancel by `orgRef` | — | unchanged |
| 11 | Live Assist sessions | `orgRef` NOT NULL | `userId` | — | — | acting scope | owner-scoped | — | unchanged |
| 12 | onboarding plans and tasks | none (per user) | `userId` | — | — | — | guarded by `userInScope` | — | unchanged |
| 13 | `externalAlertPreferences` | none | the session's external identity | — | — | the identity itself | the identity itself | — | unchanged (self-only, not a work item) |
| 14 | push, email, SMS | — | — | — | — | — | **none exist**: `workflowNotifications.channel` is only ever `in_app`, and nothing sends or advances it | — | nothing to fix |
| 15 | unread and badge counts | — | — | — | — | — | internal: none beyond the inbox's own counts (#1, #2); external: `portal.approvalQueue.unreadAlerts` (#3) | — | covered by #1–#3 |
| 16 | `workflowInstances` / transitions | `tenantId` NOT NULL | — | — | — | no production writer | no production reader | — | unchanged |

## 2. Ownership rule

Every company-facing item resolves to exactly one of the following:

| Owner | How | Delivered to |
|---|---|---|
| **ORGANIZATION** | the row's own `tenantId`, which every anchor it names must agree with | holders of the target role **in that organization** |
| **USER_WITHIN_ORGANIZATION** | `tenantId` plus `assignedUserId`/`recipientUserId` | that person, **only while acting for that organization** |
| **EXPLICIT_PLATFORM_GLOBAL** | none exists (§5) | — |
| **LEGACY_UNRESOLVED** | a dangling or disagreeing anchor, or a writer that cannot establish an owner | nobody; the writer refuses or queues nothing |

`taskInScope` and `notificationInScope` reuse TEN-EXC-1's `ownedBy` and `ownerOf`. The row's own
stamp is required, and its job, trip, unit or task must resolve to the same organization. NULL never
equals anything.

**The single tenant (`"default"`) is an organization, not a bucket.** It is the owner only when that
is proved: the acting scope of a person with no membership, or a book whose `orgRef` is NULL (0146).
Its work reaches its own people and no organization's. Before this checkpoint, two writers stamped
`"default"` because they *could not* establish an owner (#3, #4). They no longer do.

## 3. Behaviour

- **Role targeting:** organization first, then role. Roles come from `listActiveUserRoleNames`, which
  holds only grants in the acting organization.
- **User targeting:** organization first, then person. A notification addressed to A's driver but
  stamped B is shown to nobody.
- **People in two organizations:** the existing acting-scope semantics apply.
  - With no selection, they get "Choose which organization", not a merged inbox.
  - With a selection they hold, they see that organization's items only.
  - A selection they don't hold is refused.
- **Forged input:** `surfaces.inbox` and `surfaces.myDay` now take only a strict empty object. A
  request naming a tenant, organization or user is refused, not ignored.
- **Customer alerts:**
  - The owner is the account's **book** (`financialEntities.orgRef`). `customerAccounts.orgRef`
    names the *client's* organization, not the company serving it.
  - An account or book that doesn't exist gets no alert.
  - The portal lists, counts and acknowledges only alerts stamped with that owner. An alert carrying
    the identity's role string but another organization's stamp is invisible to it.
- **Writers refuse rather than guess:**
  - the requirement licence task needs its revision's `orgRef` (the `"default"` fallback was
    unreachable, and is now a refusal);
  - the finance legacy book event needs the book to exist.
- **Workflow dedupe:** another organization's open task never suppresses this organization's
  consequence.
- **Calendar:** reading another person's calendar requires that person to be in the caller's
  organization; otherwise "Person not found".

## 4. Legacy and unowned data

- Neither inbox table can hold a NULL tenant (NOT NULL since creation), so there were no NULL rows to
  hide. The read's `isNull` branches matched nothing and are removed. The source pin that asserted
  them now asserts their absence (owner ruling B5).
- Rows whose anchors dangle or disagree are shown to nobody.
- Customer alerts already stamped `"default"` stay on that row. They are shown to a portal identity
  only if its account's book is the single tenant's. An identity whose book belongs to an organization
  no longer sees them. No row was rewritten, because the original owner cannot be re-proved from the
  row alone.

## 5. Platform-global notifications

None exist, and none was invented. AIL-1A's `PlatformAuthority` has no constructor. The only
untenanted outbound notice is `system.notifyOwner`, an admin procedure that calls an external service
and writes no work item. A future outage, security or migration notice needs its own explicit
mechanism with its own test.

## 6. `merchantMemory` (owner ruling B3)

| Question | Finding |
|---|---|
| Does anything read it? | No production code imports `merchantMemoryService`. Nothing outside the two defining files calls `recallMerchant`, the `noteMerchant*` writers, `merchantMemoryConfidence` or `classifyDocument` (the extractor entry point that accepts a merchant hint). Only tests use them. |
| Is it reachable by AI or company intelligence? | No. No router, assistant path, company-knowledge path or extraction path wired into a router reaches it. |
| Ownership anchors | None. The key is `(vendorNormalized, documentType)`, with no tenant, organization, user or book. |

It stays blocked, and a test pins it unreachable. Redesign, or deprecation once AIL-1B terminology
and preference records exist, is later work.

## 7. Tests

**`server/inboxTenancy.db.test.ts`: 12 cases.** Organization A (manager, driver, safety),
organization B (the same three roles), a single-tenant safety user, and a person in both.

| Case | Proves |
|---|---|
| role targeting | A's safety task reaches A's safety user only: not B's safety, not the single tenant's, not A's manager. A single-tenant task reaches the single tenant only. |
| counts and My Day | B's inbox counts and My Day exclude A's task and notification; A's My Day includes them |
| user targeting | a notification to A's driver reaches only them; one addressed to them but stamped B reaches nobody |
| conflicting or dangling links | a task naming B's job or B's unit, or a missing unit, and a notification pointing at B's task: nobody sees them |
| forged input | `{tenantId}`, `{orgRef}`, `{organizationId}`, `{userId}` refused on `inbox` and `myDay` |
| two organizations | no selection → refused; select A → A's only; select B → B's only; select an organization not held → refused |
| customer alert owner | the book's owner, not the client `orgRef`; a missing book queues nothing; a NULL-owner book is the single tenant's |
| portal | an identity sees, counts and acknowledges only alerts under its account's owner; a same-role alert stamped B is invisible and cannot be acknowledged |
| calendar | another organization's person is "not found" through both scheduling reads; a colleague's calendar still works |
| workflow dedupe | B's open task for the same subject does not suppress A's consequence; within A, dedupe still holds |
| writer fallbacks | the requirement and finance writers carry no `"default"` fallback |
| `merchantMemory` | unreachable from production code |

**Existing tests changed (owner ruling B5, no assertion loosened):**
- `inboxIsolation.test.ts`: "tolerates a null tenant in the query" became "has no null-tenant
  branch", asserting the opposite.
- `surfaces.test.ts`: "reads no user id from the request" now asserts the only input is the strict
  empty `NO_INPUT`, and that a request carrying a user id is refused. That is stronger than the
  previous "has no `.input(`".

### 7.1 Mutation checks

Each protection was reverted temporarily, and the suite failed every time. The code was restored.

| # | Reverted protection | Failures |
|---|---|---|
| I1 | task delivered on role match alone | 5 |
| I2 | notification delivered on role or user match alone | 6 |
| I3 | task links not checked | 1 |
| I4 | notification's task not checked | 1 |
| I5 | single-tenant rows shown to every organization (shared bucket) | 1 (after adding the single-tenant case; the first run missed it) |
| I6 | forged input silently ignored | 1 |
| I7 | customer alert owner = shared `"default"` | 1 |
| I8 | customer alert owner = the client's `orgRef` | 1 |
| I9 | portal alerts unscoped | 1 |
| I10 | calendar reads across organizations | 1 |
| I11 | workflow dedupe across organizations | 1 |
| I12 | requirement task falls back to `"default"` | 1 |
| I13 | finance event for a missing book | 1 |

## 8. Found but not changed

- `consumeEnforcementEvents` (test-only) claims enforcement events across all tenants. It carries
  each row's tenant forward and has no production caller.
- `sweepLiveAssist` purges across tenants as a background job. That is maintenance, not delivery.
- The external portal's other reads still key on the identity's account. They are not inbox items and
  were not changed.
