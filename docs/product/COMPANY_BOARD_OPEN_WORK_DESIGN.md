# Company Board + Open Work — design

**Status:** PROPOSED — design only. No production code, schema or migration is written by this
document. It follows the workflow the two dispatch design documents established: the design is
committed on its own branch, the owner records decisions against the numbered questions in §14, and
implementation starts after that.

**Written against:** `main` at `6f52b57` (SPINE item 1 merged, #10), read together with the open
branches that touch the same ground: `claude/driver-portfolio-api-ya8928` (`0175`–`0177`, the
credential adapter into `composeReadiness`), `docs/dispatch-assignment-model-design` and
`docs/dispatcher-board-design` (both APPROVED). Every claim below carries a `file:line` or a
migration number from this tree; where a claim comes from a branch it says so.

**The request this answers:** a company-wide operational communications system with an open job
board, employee availability ("Offer Me Work"), expressions of interest, dispatcher award through
the canonical assignment, safety acknowledgements, offline Field Mobile operation, tenant isolation
and audit — built as one subsystem the AI Secretary, scheduling engine, Driver Wallet, portals and
notifications can plug into later.

**The short answer, which is not the one the request assumed:** most of it already exists, under
two names the request does not use. The message board (`0096`/`0097`/`0099`, `board.*`) is the
communications layer; open shifts (`0091`, `shifts.*`) is the job board; the slot model
(`dispatchRoles`, `0170`/`0171`) is the canonical assignment. The work is not to design a
communications subsystem. It is to give the board **explicit membership**, give a shift post a
**link to the slot it fills**, add **offers**, **availability** and **mutation identity** for offline
replay, and route the award through `setRoleAssignment` behind a readiness check — and, on the way,
to resolve the `openShifts` duplication that `docs/register/SPINE_WIRING_PLAN.md` names as
prerequisite work. Nothing here is a new engine.

---

## 0. Repository survey

### 0.1 Organization, account, employee

| Concept | Where | What it is |
|---|---|---|
| Organization | `organizations` (`drizzle/schema.ts:6864`), `organizationMemberships` (`:6873`) | `orgRef` is the tenant key. A membership is `employee \| contractor \| client \| system`, with `status`, `effectiveFrom/To`, `branchId`. |
| Acting scope | `resolveActingScope` (`server/_core/actingScope.ts:65`) | Returns `{ tenantId, derivedFrom, membershipRef, branchRefs, global }`. `tenantId` is the membership's `orgRef`, or `SINGLE_TENANT_ID = "default"` (`:43`) for a user with no membership. Two live memberships are **refused** (`AmbiguousOrganization`, `:88`), never resolved. Never reads a tenant from input. |
| Row ownership, two conventions | `tenantId varchar(40)` on 19 tables pinned by `server/tenantIsolation.test.ts:34` (the v22.20 set: `shiftPosts`, `crews`, `messageChannels`, `leaveRequests`, `workerQualifications`…); `orgRef` (NULL = historical single tenant) on the 0132+ set (`jobs.orgRef` `:18`, `dispatchRoleAssignmentEvents.orgRef`, `dispatchEligibilityChecks.orgRef`, `dispatchRoleTypes.orgRef`) | `orgScopeWhere(table, scope)` (`server/db.ts:160`) is the read predicate for `orgRef` tables; v22.20 tables compare `row.tenantId !== acting.tenantId` inline. `jobInScope` (`db.ts:825`), `unitInScope`, `operatorInScope` resolve records through their owner. Postings carry **no** org column; they reach the tenant through `jobs.orgRef` (dispatcher board design F3). |
| User / operator | `users` (`:3`), `operators` (`:120`) with `operators.userId` nullable | The workforce tables key on **`userId`** (`shiftInterests`, `crewMembers`, `workerQualifications`, `leaveRequests`); dispatch keys on **`operatorId`** (`dispatchRoles.assignedOperatorId`, `dispatchBids`, `dispatchInvitations`, `resourceBookings`). `openShiftsRouter.ts:123` reads `operators.id === userId`, which is a conflation, not a mapping (§13, C-10). |
| Roles / permissions | `server/_core/recordsAuthorization.ts` | `roleProcedure("router.proc")` → `OPERATIONAL_PROCEDURE_PERMISSIONS` (`:2182`) → a `Permission` from the union (`:45`–`:330`) → `GRANTS` per `DomainRole` (`:349`, written out per role, no inheritance). `SENSITIVE_PERMISSIONS` (`:1737`) fail closed. Roles: `driver`, `dispatcher`, `mechanic`, `shop_lead`, `safety`, `office`, `management`, `hr`, `legal`, `auditor`, bookkeeping roles. Gate 5 refuses a bare `protectedProcedure`; `server/procedureAuthorization.test.ts` scans a fixed list of router files and `PROCEDURE_AUTHORIZATION_INVENTORY.md` carries the per-router counts. |
| Branch scope | `mayScopePolicyTo` (`actingScope.ts:117`) | Branch is server-owned; `userRoleAssignments.scopeType` is `global \| branch` — there is no organization-scoped role grant (`docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` §2). |

### 0.2 Dispatch posting, slot, assignment, award, readiness

| Concept | Where | Facts that bind this design |
|---|---|---|
| Posting | `dispatchPostings` (`schema.ts:1806`) | `distribution` ∈ `public_internal_bid \| selected_pool \| invite_only \| direct_assignment \| on_call \| emergency \| subcontractor_bid`; `planningState` 14 values, transitions in `POSTING_TRANSITIONS` (`server/_core/dispatchLifecycle.ts:21`): `planning → open_for_bid \| invite_only \| on_call \| direct`, `open_for_bid → bid_closed \| awarding`, `awarding → partially_staffed \| staffed`, `staffed → dispatched → in_progress → completed`. `createPosting` (`server/dispatchRoleService.ts:117`) is the only production INSERT. No `orgRef`. |
| Slot | `dispatchRoles` (`:1876`) | `roleCode` (validated against `dispatchRoleTypes`), `required` (0170), `requiredEquipmentClass/TrailerClass`, `requirementsJson`, the binding `assignedOperatorId/UnitId/TrailerId`, `status open \| invited \| bid_received \| assigned \| cancelled`. |
| Assignment history | `dispatchRoleAssignmentEvents` (`:1936`, `0171`) | Append-only; `eventType assignment_created \| _reassigned \| _unassigned`, from/to binding in full, `actorUserId/Role`, `reason`, `occurredAt`, `orgRef`. Head event id is the concurrency token. |
| **The canonical binding** | `setRoleAssignment` / `clearRoleAssignment` → `applyBinding` (`dispatchRoleService.ts:323`) | One transaction: (1) read role → (2) `SELECT dispatchPostings … FOR UPDATE`, then the role `FOR UPDATE` — **posting lock first, deterministic order** (`:342`–`:349`) → (3) `jobInScope` on the posting's job (`:351`) → (4) `unitInScope`/`operatorInScope` on every named resource (`:362`–`:372`) → (5) head-event check under lock, `CONFLICT` on a stale `expectedLastEventId` (`:374`–`:385`) → (6) OD-1: sibling slots read `FOR UPDATE`, one operator and one unit per posting (`:401`–`:422`) → (7) write binding (`:424`) → (8) append event (`:432`) → (9) `assessStaffing` and a clamped `planningState` move through `canTransitionPosting` (`:449`–`:466`). **It runs no readiness check** — by design it "is not an award" (`:303`). |
| **The award** | `dispatch.award` (`server/dispatchRouter.ts:312`) → `awardAssignment` (`server/_core/dispatchTransaction.ts:72`) | Takes a stored `dispatchEligibilityChecks` row in scope, **recomputes** `composeReadiness` for the check's subject (`dispatchRouter.ts:322`), loads granted overrides, then in one transaction: posting `FOR UPDATE` (`dispatchTransaction.ts:92`), idempotent replay through `dispatchAuditEvents(eventType="assignment_approved", detail=awardIdempotencyKey)` (`:108`–`:129`), `assessEligibilityValidity` against the fresh facts with a 30-minute window (`:155`), overlap re-check on `resourceBookings` inside the lock (`:162`), `decideAward` (`:230` → `dispatchAward.ts:253`: awardable posting state, bid state, validity, **every uncovered finding by override class**, conflicts), a refused attempt written as `assignment_blocked`, then binding + confirmed bookings + `usedForAward` + bids `awarded`/`not_selected` + invitations `awarded` + staffing. |
| Readiness | `composeReadiness(subject, now)` (`server/readinessComposer.ts:379`) → `evaluateDispatchReadiness(input)` (`server/_core/dispatchReadiness.ts:163`) | **`evaluateDispatchReadiness` is a pure function reached only through the composer**; no router calls it (call sites: `readinessComposer.ts`, `hosAttestation.test.ts`, `destinationAcceptance.db.test.ts`). The composer builds `ReadinessInput` from `complianceDocuments`, `operators.license*`, HOS attestation, unit/trailer state, job and route, and returns `{ eligibility: { verdict eligible \| eligible_review \| blocked \| unknown, blockers[{code, severity blocking \| review \| unknown, overridable…}] }, facts, fingerprint, capabilities, capabilityVerdict, automationPolicy, ruleSetHash }` (`:214`). A credential with no record is `*_missing` (blocking); one with no expiry is `*_unknown` (severity `unknown`, manager-overridable) (`dispatchReadiness.ts:126`–`:160`). `dispatch.evaluate` (`dispatchRouter.ts:216`) stores the check with `orgRef`, `postingId`, `roleId`, `fingerprint`, `capabilitiesJson`, `ruleSetHash`. |
| Pre-departure | `dispatchLifecycle.ts:8` | "Match → Bid → Award Gate → Scheduled Assignment → PRE-DEPARTURE GATE → Dispatched." Re-validation after award is the lifecycle's own step, separate from binding and from award. |
| Bids / invitations | `dispatchBids` (`:1987`), `dispatchInvitations` (`:1961`) | **No production INSERT for either** (verified: the only `insert(dispatchBids)`/`insert(dispatchInvitations)` are absent from non-test code). The award updates their statuses if rows exist. `dispatchInvitations.status` mixes delivery (`sent, delivered, viewed`) with response (`interested, declined, no_response, bid_submitted, awarded`). Keyed by `operatorId`. |
| Matching | `server/_core/dispatchMatching.ts` | Pure, declared unwired (`engineReachability.test.ts`: "dispatch surface uses its own path"). `OperatorProfile` already has `onCall`, `availableFrom`, `maxRadiusKm`, `operatingRegions`, `specialtyPools` (`:47`–`:51`) — the "Offer Me Work" inputs, with nothing that stores them (`operatorCapabilities` has no writer and no reader: `docs/compliance/credential-store-reconciliation.md`). |

### 0.3 Open shifts (the job board that exists)

| Concept | Where | Facts |
|---|---|---|
| Post | `shiftPosts` (`schema.ts:6960`, `0091`) | `postRef`, `tenantId`, `title`, `kind open \| assigned`, `startsAt/endsAt`, `location` (free text), `requiredRole`, `requiredQualificationsJson`, `seats`, `status open \| filled \| cancelled \| expired`, `postedByUserId/At`. **No link to a job, posting or slot. No `draft`, `closesAt`, `publishedAt`, overtime, unit or equipment class.** `status` is written once (`open`) and nothing in production moves it. |
| Interest | `shiftInterests` (`:6979`) | `postRef`, `userId`, `expressedAt`, `withdrawnAt`; `UNIQUE(postRef, userId)` ("tapping twice is not two claims"). No tenant column on purpose (`tenantIsolation.test.ts:50`); reached through its post. One response kind only. Nothing in production sets `withdrawnAt`. |
| Router | `server/openShiftsRouter.ts` | `shifts.post` (`shifts.post`, **sensitive**), `shifts.list`, `shifts.eligibility`, `shifts.expressInterest` (`shifts.interest`), `shifts.interests`. Tenancy: `post.tenantId !== acting.tenantId → NOT_FOUND`. `expressInterest` is read-then-insert; the UNIQUE index closes the race but the duplicate-key error is not mapped to the "already recorded" reply (`:175`–`:181`). `eligibility` reads leave, `operators.license*` and `workerQualifications` and reports `qualification_unknown` as blocking (`:96`–`:155`). |
| Engine | `server/_core/openShifts.ts` | Pure: `candidatesFor` (`:68`, reasons `wrong_role \| missing_qualification \| on_approved_leave \| not_rostered \| overlaps_existing`), `summarize`, `expressInterest` (`:160`, refuses an ineligible candidate), `intendToAssign` (`:192`, returns `requiresReadinessCheck: true`, "interest confers no claim"). **Declared unwired** — "openShiftsRouter currently decides inline — a live duplication, not a gap" (`server/engineReachability.test.ts`). `docs/register/SPINE_WIRING_PLAN.md` lists `openShifts` among the four duplications to resolve **before** wiring anything, and its ordering §2 says deleting the inline copy is the work. |
| Credentials it reads | `workerQualifications` (`:7004`) | **No production writer** (`docs/compliance/credential-store-reconciliation.md`, matrix row 3). Owner decision D-05 (2026-09-23): canonical credential authority is `complianceDocuments` + `academyQualifications`; `workerQualifications` becomes a projection or is retired, and nothing is consolidated yet. The driver-portfolio branch reads the canonical pair into `composeReadiness` through `evaluateDriverReadiness`. |
| Availability | — | **Does not exist.** Absence exists: `leaveRequests` (`:6936`, `isAbsent`), crew rotation (`crewCoverage.isAvailable`, `:35`), `on_call` as a posting distribution. There is no declaration of "available", "on call", "overtime", a window or a preference anywhere in the schema, and no `offerMeWork`/`availability` identifier in `server/`, `drizzle/` or `client/`. |

### 0.4 The message board (the communications layer that exists)

| Concept | Where | Facts |
|---|---|---|
| Channel | `messageChannels` (`schema.ts:7060`, `0096`) | `channelRef`, `tenantId`, `type` ∈ `announcement \| dispatch \| safety \| maintenance \| field_operations \| road_conditions \| training \| general \| job \| client \| private \| emergency`, `name`, `jobRef`, `clientRef` (what makes a channel external), `crewRef` (`0093`), `archived`. |
| Access | `mayOpen` (`server/_core/messageBoard.ts:170`), `openChannel` (`server/messageBoardRouter.ts:171`) | External viewer: `client` channels only, and only their own `clientRef`. Internal viewer: **every non-`private` channel**; `private` = `management` role only. A `crewRef` channel additionally requires a current or historical crew membership (`crewRelationship`, `:146`, four standings), and what a member *sees* is the audience recorded per message (`board.read`, `:429`–`:443`). **There is no per-channel membership for non-crew channels, and no direct-message concept**: "private" means management-only, not two people. |
| Message | `boardMessages` (`:7076`) | `priority normal \| important \| urgent \| emergency`; `requiresAcknowledgement` **derived** from priority (`ACKNOWLEDGEMENT_REQUIRED = [urgent, emergency]`, `messageBoard.ts:55`), never chosen; `deviceCreatedAt` (device clock, never overwritten) beside `serverReceivedAt`; `deviceId`; `withdrawnAt/ByUserId`. Edits append to `messageRevisions` (`:7114`, revision 1 is the row); nothing is deleted. Attachments are pointers (`messageAttachments.objectRef`, `:7128`) authorized per reader through `attachmentAuthorizers`. **No client mutation identity**: a retried `board.post` writes a second message. Any `board.post` holder may post `emergency` into any channel they can open — no separate permission (`:300`–`:376`). |
| Receipt / acknowledgement | `messageReceipts` (`:7097`), `advance` (`server/_core/messageLifecycle.ts:61`) | Eight forward-only states `queued_offline → uploaded → accepted → delivered → opened → acknowledged → actioned → resolved`; each advance needs typed evidence; `acknowledged` requires `byUserId === receipt.userId` (`:70`). `advanceReceipt` (`messageBoardRouter.ts:65`) stamps every reached-but-unrecorded state **at the advance time, never earlier**. A receipt row per recipient is written in the same transaction as the message (`:379`). `board.acknowledge` is naturally idempotent (a second call reports "already acknowledged"). `acknowledgementStatus` (`messageBoard.ts:135`) separates read-not-acknowledged from never-delivered. |
| Audience | `board.post` `recipients[]` | For a crew channel derived from current membership (max 500, refused beyond); for every other channel **supplied by the caller**, defaulting to nobody. A company announcement with no `recipients` has no receipts and therefore no acknowledgement roll-call. |
| Emergency broadcast | `broadcast`, `broadcastReaches` (`messageBoard.ts:240`–`:248`) | Pure only; no procedure, no table. |
| Permissions | `board.read`, `board.post`, `board.manage` (sensitive) — held by driver, dispatcher, mechanic, safety, office, management (`recordsAuthorization.ts:355`, `:446`, `:546`, `:615`) | `createChannel → board.manage`; `post/edit/withdraw → board.post`; everything else `board.read` (`:2735`–`:2748`). |
| Not this | `comms.*` (`server/commsRouter.ts`, `0074`–`0076`, `LEASEOS_B22_17_COMMUNICATIONS.md`) | **"Communications" in this repository means radio channels, transmit authorization and the offline communication package on the route.** It is a different subsystem with 30 procedures and its own sensitive permissions. This design does not touch it and does not reuse its name (§13, C-1). |

### 0.5 Field Mobile, offline, sync

| Concept | Where | Facts |
|---|---|---|
| Runtime | `client/src/runtime/contracts.ts` | Six sync states `saved_locally \| queued \| syncing \| synchronized \| failed \| conflict` (`:22`), confirmed by `docs/register/SPINE_WIRING_PLAN.md` ("Sync states — SIX"). `LocalCapture` (`:35`) is the envelope; `Outbox` (`runtime/outbox.ts`) drives the states; `queue()` **refuses a capture with neither `jobId` nor `unitId`** (`outbox.ts:43`). `CaptureKind` (`:27`) has no message, acknowledgement or interest kind. |
| Sync | `sync.receivePackage` (`server/deviceRouter.ts:162`) | Idempotent per capture by device reference and per package by seal; a reused sync nonce is `CONFLICT` (`:244`). **No command ledger**: HS3's `commandId` / `APPLIED \| REJECTED \| IN_DOUBT \| COMMAND_ID_COLLISION` machine is specified (`docs/hybrid-seam/HS_CONTRACTS.md` §2) and not built (`HS0_RECONNAISSANCE.md` §4). |
| Shell | `client/src/portal/PortalShell.tsx`, panels `InboxPanel`, `MyDayPanel`, `ExceptionsPanel`, `TimelinePanel`, `SetupPanel`; `SyncIndicator.tsx` reads `window.leaseosRuntime.outboxStatus` | No board, shift or job-room UI in the shell. The only "communications" pages are the radio package pages (`/comms/package`, `/comms/transmit`, `/comms/status`). Dispatch UI: `client/src/dispatch/DispatchJobDetail*.tsx` (Checkpoint I). |
| Notifications | `workflowNotifications` (in-app, deduplicated by `notificationKey`; `server/customerAlertService.ts:20`), `domainEventOutbox` (`schema.ts:2316`) drained by `server/_core/worker.ts` with `SELECT … FOR UPDATE SKIP LOCKED` | **No push, SMS or email exists** (roadmap: "Customer alerts by email or SMS (in-app only today)"). The transactional writer pattern is `enqueueEnforcementEvent(tx, …)` (`server/_core/enforcementOutbox.ts:43`): same `tx` as the state change, event id derived from the aggregate so a retry cannot enqueue twice; consumption is a separate, retried step. `eventEmitter.ts` (`emitDomainEvent`) is the intended generic door and is declared unwired ("emitters write via raw SQL"). |

### 0.6 Audit, migrations, gates

- **Audit** is per subsystem, append-only, beside the state it explains: `dispatchAuditEvents`, `dispatchRoleAssignmentEvents`, `academyAuditEvents`, `manifestCustodyEvents`, `evidenceAccessEvents`, `securityIncidentEvents`, ~25 more. There is no generic audit ledger and the assignment design (§4, "Audit philosophy") reaffirmed the per-subsystem convention. `auditRouter` builds *packages* over existing rows; it is not a writer.
- **Migrations** are hand-written SQL (`drizzle/NNNN_name.sql`, `--> statement-breakpoint`), applied in filename order by `scripts/apply-migrations.sh`; `drizzle/schema.ts` is hand-maintained beside them and `scripts/verify-parity.sh` requires the `CREATE TABLE` count to equal the `mysqlTable(` count; `server/columnParity.test.ts` checks columns. `main` head is `0174_dispatch_override_provenance.sql`. Open branches claim `0170` (two), `0172`–`0177`, `0178`–`0181` (`docs/architecture/MIGRATION_COLLISION_REGISTER.md` and the scan in §10). `0016`/`0017` are reserved and gate 0 fails if they exist.
- **Gates** (`scripts/ci-gate.sh`): reserved slots → clean MariaDB 10.11 → migrations → parity → `tsc --noEmit` → test-file type-error ratchet pinned at **0** → no bare `protectedProcedure` → `vitest run` with a fail on any `.db.test.ts` that skips while `DATABASE_URL` is set → `pnpm build` → portal/inbound pins → `LEASEOS_CURRENT_STATE.md` regenerated and diffed. `server/documentationTruth.test.ts`, `server/registerClaims.test.ts` and `server/spineWiringPlan.test.ts` police the documents; `server/engineReachability.test.ts` fails when an engine is wired without being removed from `DECLARED_UNWIRED`, or removed without being wired.
- **Conventions**: `xxxRouter.ts` (procedures, zod `.strict()` where staleness matters) + `xxxService.ts`/`_core/xxx.ts` (transactions and pure rules); cross-tenant → `NOT_FOUND`, never `FORBIDDEN` (the disclosure rule, `messageBoardRouter.ts:209`); refusals are `TRPCError` with `PRECONDITION_FAILED`/`CONFLICT`/`FORBIDDEN`, and safety refusals are *recorded* rows (`assignment_blocked`); reason codes are lower-snake strings on structured findings (`operator_licence_missing`, `qualification_unknown`, `on_approved_leave`), never prose parsed back; device time and server time are both kept and neither overwrites the other (`boardMessages.deviceCreatedAt`/`serverReceivedAt`, `LocalCapture.capturedAt`); `unknown` is never `satisfied`.

---

## 1. Findings that shape the design

**F1 — The board has channels but no membership.** `mayOpen` admits every internal user to every non-`private` channel; `private` is a management-only room, not a private conversation. A direct message, a private group, a department room or a job room limited to its crew cannot be expressed except through a `crews` row. That is the one structural gap in the communications layer, and it is exactly the gap the request's privacy rule ("supervisors shouldn't automatically get access to every private DM") needs closed.

**F2 — The job board exists and is disconnected from dispatch.** `shiftPosts` has no `jobId`, `postingId` or `roleId`, so nothing can turn a filled post into a slot binding; `status` never leaves `open`; `shifts.expressInterest` is the only response kind; and eligibility reads a credential store nothing writes. The request's lifecycle (Open → Interested → Candidate → Offered → Accepted → Awarded → Dispatched) is three quarters missing here and three quarters *present* in the dispatch model (`invited`, `bid_received`, `awarding`, `staffed`, `dispatched`). The design's job is to connect the two, not to add a third.

**F3 — The moratorium applies, and it points at this subsystem by name.** `docs/register/SPINE_WIRING_PLAN.md`: "The moratorium stands: no new engines until this path is wired," and its ordering §2 puts `openShifts` among the four duplications to resolve before wiring anything, with "deleting the inline copy is the actual work." A new `_core` engine for the job board or for messaging would fail `engineReachability` unless declared unwired, and would be the fifth copy of a rule that already has two. Everything below is therefore a **deletion, a resolver, or a router over something already written** — the three kinds of work the plan permits (`spineWiringPlan.test.ts:80`).

**F4 — There are three assignment-adjacent states, not two.** The request says "ACCEPTED does not necessarily mean DISPATCHED." The repository is stricter: a slot is **bound** (`setRoleAssignment`, no readiness), a posting is **awarded** (`dispatch.award`: check + fresh facts + bookings + `usedForAward`), and it is **dispatched** after the pre-departure re-validation (`dispatchLifecycle.ts:8`). A marketplace "award" has to say which of the three it performs. This design: it performs the **binding**, gated on a valid readiness check; the posting award and pre-departure gate stay the dispatcher's, unchanged.

**F5 — The award's readiness is a stored check plus a recompute, not a live call.** No router calls `evaluateDispatchReadiness`; the door is `composeReadiness`, and the award consumes it as `dispatchEligibilityChecks` (stored, fingerprinted, `orgRef`-scoped) re-validated against facts recomputed at award time. The marketplace must consume readiness the same way — a check id, validity, uncovered findings — or it becomes the second reader of readiness the C1a work exists to prevent.

**F6 — Offline replay has no identity for messages.** `boardMessages` keeps the device clock and `deviceId` but nothing a retry can be matched on; `shiftInterests` is idempotent by `UNIQUE(postRef, userId)`; acknowledgements are idempotent by the forward-only ladder. The generic answer (HS3 `commandId` ledger) is specified and unbuilt. Until it lands, a per-table `(deviceId, clientMutationId)` unique key is the same guarantee for the two writes that need it (messages, offer responses), and it is exactly what HS3's ledger will later carry.

**F7 — The credential truth is settled and not yet consolidated.** D-05 names `complianceDocuments` + `academyQualifications` as canonical; `openShiftsRouter.eligibility` reads `workerQualifications`, which nothing writes, so every ticket-requiring post is `unknown`. That is fail-closed and useless in equal measure. The board must not read a credential store directly at all: eligibility preview is `composeReadiness` (and, once `0175`–`0177` merges, the driver-portfolio adapter inside it), and the award is the stored check.

**F8 — Tenant isolation is a measured surface, not a property.** `tenantIsolation.test.ts` says so in its header; roadmap step 3 ("Prove tenant isolation") is open. New tables use the `orgRef` convention (`0132`, `0170`, `0171`, `0174`) so `orgScopeWhere` applies and the `tenantId` pin does not move; extended v22.20 tables keep their `tenantId`. Every new procedure gets a cross-organization refusal test in the `tenantScope*.db.test.ts` pattern.

---

## 2. Alternatives considered

**A — A new `conversations` / `conversationMembers` / `messages` set beside the board.** *Rejected.* It would be the second message vocabulary (`messageLifecycle.ts` exists because there were already two receipt vocabularies), a second acknowledgement ladder, a second offline clock pair and a second attachment authorizer. The board's `messageChannels` already carries `type`, `jobRef`, `crewRef` and `archived`; what it lacks is one table and one column.

**B — Reuse `dispatchInvitations` as the offer record.** *Considered and not recommended (owner decision D-2, §14).* It is keyed by `operatorId` while every marketplace row is keyed by `userId`; its status enum conflates delivery (`sent/delivered/viewed`) with response; it has no production writer; and it lacks who offered, when it expires, and a client mutation id. Making it fit means enum surgery on a table the award already updates. A small `shiftOffers` table keyed by post and user, whose award step is the one place both records are touched under one lock, is cheaper and keeps the award transaction's existing behaviour for invitations intact.

**C — Make `shiftPosts` a view over `dispatchPostings`.** *Rejected.* A shift or overtime opportunity can exist before a job does ("available tonight", callout cover, a replacement operator for a unit), and a posting cannot exist without a job (`createPosting` refuses `jobInScope` failure). The post is the *offer of work*; the posting is the *dispatch of a job*. They are linked, not identical, and an unlinked post is simply not awardable (§5.3).

**D — Wire `dispatchMatching` now for the candidate pool.** *Deferred.* It is the other named duplication ("dispatch surface uses its own path") and wiring it is spine work of its own. The first "Offer Me Work" candidate pool is a deterministic query over availability, leave and a readiness preview; when `dispatchMatching` is wired, `OperatorProfile.onCall / availableFrom / maxRadiusKm / operatingRegions` are read from the availability table this design adds.

**E — Store the eligibility answer on the post or the interest.** *Rejected.* Fingerprinted checks already exist and expire; copying a verdict onto a marketplace row would be the drift the request warns about.

---

## 3. Recommended model

```
messageChannels                        the container (type, tenantId, jobRef, crewRef, archived)
 ├── membershipMode: open | explicit | crew                                        [0182, column]
 ├── messageChannelMembers            who may open an EXPLICIT channel, with a member role  [0182]
 ├── messageChannelEvents             membership / moderation / emergency audit             [0182]
 └── boardMessages (+ clientMutationId)  message, receipts, revisions, attachments — as today

shiftPosts                             the offer of work (tenantId, as today)
 ├── + dispatchPostingId, dispatchRoleId, unitId, overtime, closesAt, publishedAt, …   [0183]
 ├── shiftInterests (+ response, clientMutationId, deviceCreatedAt)                     [0183]
 ├── shiftOffers                      dispatcher → person, accept/decline, one award link  [0183]
 └── shiftPostEvents                  append-only marketplace audit                        [0183]

workerAvailability                     declared availability windows and preferences       [0183]

dispatchRoles / dispatchRoleAssignmentEvents      THE slot and its history — unchanged
dispatchEligibilityChecks                          the readiness evidence — unchanged
domainEventOutbox                                  work.* and message.* events — unchanged table
```

Why this fits LeaseOS specifically: every new row is either membership (a resolver the board lacked), a link to a record that already decides the answer (the slot, the check), a declaration a person makes about themselves (availability), or history. No new rule is written; `mayOpen`, `advance`, `candidatesFor`, `intendToAssign`, `applyBinding`, `assessEligibilityValidity` and `decideAward`'s finding rule are the rules.

---

## 4. Communications: the board with membership

### 4.1 Channel kinds

`messageChannels.type` gains `direct`, `group`, `department`, `unit`, `shift` (migration `0182`, enum extension). The request's remaining kinds already exist: company = `general`/`announcement`, dispatch = `dispatch`, safety = `safety`, mechanic = `maintenance`, job = `job`, emergency = `emergency`. `private` keeps its current meaning (management room) and is **not** the DM type; a DM is `direct` with `membershipMode = explicit` and exactly two members.

### 4.2 Membership

`messageChannels.membershipMode ∈ open | explicit | crew` (default `open` for existing rows, `crew` backfilled where `crewRef IS NOT NULL`).

`messageChannelMembers`

| Column | Type | Notes |
|---|---|---|
| `id` | `int AUTO_INCREMENT PK` | |
| `channelRef` | `varchar(64) NOT NULL` | |
| `userId` | `int NOT NULL` | the person; organization is proven through the channel's `tenantId` and the person's membership at add time |
| `memberRole` | `enum('member','moderator','dispatcher','manager','read_only') NOT NULL DEFAULT 'member'` | a channel role, not a domain role; `read_only` cannot post |
| `source` | `enum('manual','job_assignment','crew','direct') NOT NULL DEFAULT 'manual'` | who put them here — `job_assignment` rows are written by the job-room resolver (§4.5) |
| `joinedAt`, `leftAt`, `mutedAt` | `timestamp` | `leftAt` keeps history readable, as the crew rule already does (`crewRelationship` four standings) |
| `addedByUserId` | `int NOT NULL` | |
| `memberKey` | `varchar(140)` PERSISTENT generated | `CONCAT(channelRef, ':', userId, ':', COALESCE(leftAt,'*'))` — one current membership per person per channel, with uniqueness on a key rather than a tuple containing NULL (the `0021` / `dispatchRoleTypes` lesson) |

Access, in `openChannel` (one door, as today): `open` → `mayOpen` as now; `crew` → `crewRelationship` as now; `explicit` → a current or historical `messageChannelMembers` row, current for posting, historical for reading what was sent (the crew standing rule, reused verbatim). A non-member gets `NOT_FOUND` on a messageRef path and `FORBIDDEN` on a channelRef path, the split `messageForCaller` already draws.

### 4.3 Visibility and privacy rules (documented, owner decision D-3)

| Channel | Who may read | Who may post | Management / admin |
|---|---|---|---|
| `open` company channels (`general`, `announcement`, `dispatch`, `safety`, `maintenance`, `department`, `unit`) | every internal member of the organization | `board.post`; `announcement` and `emergency` priority need `board.publish` (§8) | as any member |
| `crew` channels | current and historical crew members | current members whose `crewRole` carries `crew.post` | as today |
| `job` rooms (`explicit`, `source = job_assignment`) | members: dispatcher(s) on the posting, bound operators, added supervisor/mechanic | members not `read_only` | dispatcher role of the posting is a member by construction |
| `direct`, `group` (`explicit`) | members only | members only | **not readable by `board.manage` or `management`.** Moderation is a separate, sensitive `board.moderate`, and every moderator read or withdraw writes a `messageChannelEvents` row (`moderator_read`, `moderator_withdraw`) the audit surface can list. |
| `client` | as today | as today | as today |

Retention: nothing is deleted (`withdraw` keeps text and revisions; `messageRevisions` is append-only). Archive is `archived = true`. A retention *policy* column is not added: the audit-package kinds (`auditPackage.ts:14`) already decide what leaves the building per kind, and a per-channel retention flag with no engine reading it would read as enforced and enforce nothing.

### 4.4 Priority and acknowledgement

The board's four priorities stay (`normal | important | urgent | emergency`); `requiresAcknowledgement` stays derived. The request's `dispatch` and `safety` "priorities" are channel types here (C-4). What changes:

- posting `emergency`, or posting at all into an `emergency` channel, requires `board.publish` (new, sensitive); `board.post` alone is refused with `FORBIDDEN` — today it is not (`messageBoardRouter.ts:300`–`:376`);
- an `announcement` channel post with `recipients: []` is refused: an announcement with no audience has no roll-call. The audience resolver fills it from organization membership (bounded at 500 as crews are; a larger company gets branch channels, refused beyond rather than truncated);
- `emergency_posted` is written to `messageChannelEvents` and `message.critical.created` to the outbox in the post transaction.

### 4.5 Job rooms

A job room is a `job` channel with `membershipMode = explicit` and `jobRef = jobs.jobCode`, created **on demand** by a resolver `ensureJobRoom(tx, { postingId })` called from the marketplace award (§5.5) and from `dispatch.setRoleAssignment` (one added line after the event append). It adds the actor and the bound operator's user (`operators.userId`, refused with a named reason when NULL) as members with `source = job_assignment`; an unassignment sets `leftAt`. No other job-room automation in this checkpoint. What a room "surfaces" (documents, map, contacts, units) is the attachment pointer model that exists (`messageAttachments`, authorized per reader) — a room does not copy them. The contact directory is **not built** (`docs/register/SCOPE_RECONCILIATION_2026-09-21.md` §1 MISSING); when it exists it attaches like any other record.

### 4.6 Offline identity

`boardMessages.clientMutationId varchar(64) NULL` with `UNIQUE(deviceId, clientMutationId)` (both NOT NULL for the key to bind; a browser post without a device sends neither and is not replay-safe, which is the truth today). A `board.post` whose key already exists returns the existing `messageRef` with `replayed: true` and writes nothing. Acknowledgements need no identity (forward-only ladder); the `at` a device sends is stored as the acknowledgement's device time in a new `messageReceipts.deviceAcknowledgedAt`, and `acknowledgedAt` remains the server's stamp — the two-clock rule extended to the one write that lacked it.

---

## 5. Open Work: the job board linked to the slot

### 5.1 The post (`shiftPosts`, extended in `0183`)

| Added column | Type | Why |
|---|---|---|
| `dispatchPostingId` | `int NULL` | the posting this post fills |
| `dispatchRoleId` | `int NULL` | **the slot**. A linked post names one slot; `seats` must be 1 when linked (a posting with four trucks is four posts, one per slot, which is how `dispatchRoles` already models a rig move) |
| `unitId` | `int NULL` | the unit the work is for, when known |
| `requiredEquipmentClass` | `varchar(60) NULL` | seeded from the slot when linked |
| `overtime` | `boolean NOT NULL DEFAULT false` | the request's overtime board is a filter, not a table |
| `estimatedHours` | `int NULL` | |
| `regionCode` | `varchar(60) NULL` | matches `workerAvailability.preferences.regions` |
| `priority` | `enum('normal','callout','hotshot','emergency') NOT NULL DEFAULT 'normal'` | display and sort; **not** an input to any eligibility function, as `priority` is not an input to `evaluateDispatchReadiness` |
| `publishedAt`, `closesAt`, `closedAt`, `cancelledAt`, `cancelledByUserId`, `cancelReason` | timestamps / text | the lifecycle below |
| `openings`? | — | not added: `seats` is it |

`status` becomes `draft | open | closed | filled | cancelled | expired` (adds `draft`, `closed`). Transitions, in a pure table beside `POSTING_TRANSITIONS` and tested the same way:

```
draft → open | cancelled
open → closed | filled | cancelled | expired      (expired: closesAt passed, derived on read and persisted by the next mutation)
closed → open | filled | cancelled                (reopen is allowed; filled needs an award)
filled | cancelled | expired → (terminal)
```

`kind = assigned` posts (the existing enum) are not published to the board; they are read-only notices.

### 5.2 Responses (`shiftInterests`, extended) and offers (`shiftOffers`, new)

`shiftInterests` gains `response enum('interested','available','request_assignment','declined') NOT NULL DEFAULT 'interested'`, `deviceCreatedAt timestamp NULL`, `clientMutationId varchar(64) NULL`, `deviceId varchar(64) NULL`, `note varchar(400) NULL`. `UNIQUE(postRef, userId)` stays: a person has one standing response per post; a new response replaces it in place with the previous one written to `shiftPostEvents`. `withdrawnAt` stays. Refused when the post is not `open` (`PRECONDITION_FAILED`, as today) or is `kind = assigned`.

`shiftOffers`

| Column | Notes |
|---|---|
| `offerRef` `varchar(64) UNIQUE` | |
| `postRef` `varchar(64) NOT NULL` | organization through the post, as `shiftInterests` |
| `userId` `int NOT NULL` | the person offered |
| `offeredByUserId`, `offeredAt`, `expiresAt` | dispatcher's act; `expiresAt` defaults to `closesAt` |
| `status enum('offered','accepted','declined','withdrawn','expired','awarded','not_selected')` | |
| `respondedAt`, `deviceRespondedAt`, `responseClientMutationId`, `responseDeviceId` | the two clocks and the replay key for the accept/decline |
| `awardEventId int NULL` | the `dispatchRoleAssignmentEvents.id` the award produced — the one link between marketplace and slot |
| `offerKey` PERSISTENT generated | `CONCAT(postRef, ':', userId)` with uniqueness among live offers expressed as `CONCAT(postRef,':',userId,':', CASE WHEN status IN ('offered','accepted') THEN 'live' ELSE id END)` — one live offer per person per post |

Response lifecycle, adapted to the repository's vocabulary:

```
(person)   interested | available | request_assignment | declined   ← shiftInterests.response
(dispatch) offered → accepted | declined | withdrawn | expired       ← shiftOffers.status
(dispatch) accepted → awarded ; every other live offer on a filled post → not_selected
```

`accepted` is a person's statement. It binds nothing. The post stays `open`/`closed` until the award.

### 5.3 What is awardable

A post is awardable only when `dispatchRoleId IS NOT NULL`. An unlinked post (a shift with no job yet) can collect responses and offers, and the dispatcher links it — `shifts.link({ postRef, roleId })`, `dispatch.assign`, `jobInScope` on the role's posting — before awarding. There is no path from an unlinked post to `filled`. This is the request's "an open-work posting is not necessarily a new job record" made exact: the post is not a job, and it cannot dispatch anyone until it names the slot on a job.

### 5.4 Eligibility preview — `eligible | ineligible | unknown` with reasons

`shifts.candidates({ postRef })` (dispatcher) and the per-person flag on `shifts.list` (the person's own) come from one resolver, `previewFor(post, userId, now)`, which composes only things that already decide:

1. `on_approved_leave` — `leaveRequests` + `isAbsent` (as today);
2. `not_rostered` — `crewCoverage.isAvailable` where the person is on a crew with a rotation (the `openShifts.candidatesFor` rule, **now reached** — this is the duplication resolution, §9);
3. `declared_unavailable` / `available` / `on_call` — `workerAvailability` (§6), a declaration, never a proof;
4. `readiness_preview` — `composeReadiness({ operatorId, unitId: post.unitId ?? null, trailerId: null, jobId: posting?.jobId ?? null, postingId })`, returning the verdict and blocker codes as-is. When `operators.userId` has no operator for the person, the preview is `unknown` with `no_operator_record` (§13, C-10), never `eligible`.

The card shows the four lines the request drew (`H2S ✓ / First Aid ✓ / TDG ✓ / Unit ✓`) **from the readiness blockers**: a requirement the composer reports as a finding is ✗ with its code; one it does not report is ✓ only if the composer's `capabilities` say that capability was evaluated (`NOT_EVALUATED` renders as `?`, never ✓ — the P8.1 contract). The board never reads `complianceDocuments`, `academyQualifications` or `workerQualifications` itself.

### 5.5 The award — exact transaction and locking boundary (Checkpoint 3)

`shifts.award` — permission `dispatch.assign` (the binding's own permission; no new grant creates a second way to bind a slot).

Input (`.strict()`): `{ postRef, userId, unitId | null, trailerId | null, checkId, expectedLastEventId, reason? }`.

Outside the transaction (reads, as `dispatch.award` does): resolve scope; the post in scope (`tenantId`); the post's role and posting; `jobInScope`; the person's operator (`operators.userId = userId`, in scope); `scopedCheck(checkId)` — an `orgRef`-scoped `dispatchEligibilityChecks` row whose `operatorId`, `unitId`, `trailerId`, `postingId` and `roleId` equal the request's (a check for a different subject or slot is refused, not reused); `composeReadiness` recomputed for that subject **now**; `loadGrantedOverrides(checkId)`.

Then **one transaction**, lock order fixed and documented in the module header because two of these locks already exist in that order:

1. `SELECT dispatchPostings WHERE id = ? FOR UPDATE` — the canonical lock every binding and award takes first.
2. `SELECT dispatchRoles WHERE id = ? FOR UPDATE`.
3. `SELECT shiftPosts WHERE postRef = ? FOR UPDATE` — after the dispatch rows, never before, so a `setRoleAssignment` running concurrently on the same posting queues rather than deadlocks.
4. `SELECT shiftOffers WHERE postRef = ? FOR UPDATE` (all live offers on the post).
5. Refusals, each a `PRECONDITION_FAILED`/`CONFLICT` and each written as a `shiftPostEvents` row `award_refused` with the code before the transaction rolls back the rest (the `assignment_blocked` precedent):
   - post not `open`/`closed`, or `cancelledAt`/`expired` → `post_not_awardable`;
   - post unlinked → `post_unlinked`;
   - slot `cancelled` or posting terminal → the binding's own refusals;
   - `assessEligibilityValidity(check, currentFacts, now, 30)` invalid → `readiness_stale` with its reason (`age` / `dependency_change`);
   - `uncoveredFindings(check.blockers, grantedOverrides, now)` non-empty → `readiness_refused` listing the codes. This is where `blocked` and `unknown` stop the award: a `*_unknown` finding is a finding, and with no grant it is uncovered. **Unknown never passes.**
   - a live `shiftOffers` row for this person in `declined`/`withdrawn`/`expired` → `offer_not_live` (a declined person can still be awarded by a dispatcher? — no: the dispatcher withdraws the old offer and issues a new one; the award follows an `accepted` offer or, with `reason`, no offer at all — the "interest confers no claim, absence of interest is no bar" rule from `intendToAssign`).
6. `applyBinding` **with the caller's `tx`** (a one-line refactor: `applyBinding(args, tx?)`, default opens its own — the resolver over something already written). It performs steps 3–9 of the canonical binding unchanged: scope on resources, head-event `CONFLICT`, OD-1 siblings under lock, the binding, the append-only event, staffing.
7. `shiftOffers`: the person's live offer → `awarded`, `awardEventId = event.id`; every other live offer → `not_selected`; `shiftPosts.status = filled`, `filledAt`, `filledByUserId`.
8. `shiftPostEvents`: `awarded` with `subjectUserId`, `roleId`, `eventId`, `checkId`.
9. `domainEventOutbox`: `work.awarded` through `enqueueBoardEvent(tx, …)` (§8.3), event id derived from `(postRef, eventId)` so a replay cannot enqueue twice.
10. `ensureJobRoom(tx, { postingId })` (§4.5).

Idempotency: a retry with the same `expectedLastEventId` after a committed award hits the head-event check and receives `CONFLICT` with the new head; the client reloads and sees `filled`. That is the binding's own replay semantics, and this design does not add a second key beside it — the request's "idempotent retry does not create duplicate response" is met for interest and offers by their unique keys and for the award by the head token.

What this award does **not** do, on purpose: no `resourceBookings`, no `usedForAward`, no `assignment_approved`, no `dispatchBids`/`dispatchInvitations` update. Those are `dispatch.award`'s durable evidence, and the dispatcher runs `dispatch.award` on the same `checkId` to book the resources and move the posting toward `staffed`/`dispatched`. The marketplace's `filled` and the posting's `planningState` are reported side by side on `shifts.get`, never merged (the `planningState`/`staffing` rule of `listRoles`).

### 5.6 How `evaluateDispatchReadiness()` is invoked

Never directly. `composeReadiness` is the one door (`readinessComposer.ts:379`), it calls `evaluateDispatchReadiness` with the `ReadinessInput` it assembled, and the marketplace consumes the result twice: as a **preview** (§5.4, read, not stored) and as the **stored check** the dispatcher created with `dispatch.evaluate` for the exact subject and slot (§5.5). The award recomputes `composeReadiness` for fingerprint validity exactly as `dispatch.award` does (`dispatchRouter.ts:322`). Pre-departure re-validation is untouched.

### 5.7 Concurrency cases, and where each is decided

| Case | Where it is decided |
|---|---|
| Two people request one opening | both `shiftInterests` rows are written (interest is not a claim); the award decides one under the posting lock |
| Two dispatchers award different people to one slot | second `applyBinding` sees a changed head event → `CONFLICT`; or, if both loaded the same head, the posting lock serialises them and the second fails the head check |
| One person accepts while the dispatcher cancels | `shifts.cancel` takes the same posting → post lock order; the accept (`shiftOffers` update) locks the offer row and re-reads the post under lock, refusing `post_not_awardable` if cancelled first; cancel marks live offers `withdrawn` |
| Retry of an accept from a device | `UNIQUE(responseDeviceId, responseClientMutationId)` → `replayed: true` |
| Retry of an interest | `UNIQUE(postRef, userId)`; the duplicate-key error is caught and mapped to `recorded: false` (fixing today's unmapped race) |
| Award retried after commit | head-event `CONFLICT`, as the binding today |

`server/shiftAwardConcurrency.db.test.ts` runs the real database cases in the `dispatchConcurrency.test.ts` style (parallel connections, `FOR UPDATE`, one survivor).

---

## 6. Availability — the "Offer Me Work" foundation

`workerAvailability` (new, `orgRef` convention)

| Column | Notes |
|---|---|
| `availabilityRef` `varchar(64) UNIQUE` | |
| `orgRef` `varchar(64) NULL` | NULL = single tenant; `orgScopeWhere` |
| `userId` `int NOT NULL` | |
| `state enum('available','unavailable','on_call','available_for_overtime') NOT NULL` | |
| `windowStartsAt`, `windowEndsAt` `timestamp NULL` | both NULL = standing declaration; a window is half-open |
| `preferencesJson` `text NULL` | `{ regions: string[], equipmentClasses: string[], jobTypes: string[], maxDistanceKm: number \| null, overnight: boolean \| null, nights: boolean \| null, weekends: boolean \| null, overtime: boolean \| null }` — declared preferences, validated by zod, **never credentials** |
| `declaredAt`, `deviceDeclaredAt`, `deviceId`, `clientMutationId` | the two clocks and the replay key |
| `source enum('self','dispatcher')`, `recordedByUserId` | a dispatcher may record what a person phoned in; it says so |
| `supersededAt`, `supersededByRef` | append and supersede, never update in place (the `workerQualifications.supersededByHoldingRef` pattern) |

Rules: a declaration is a statement about willingness and is consumed only by the candidate pool (§5.4 step 3) and, later, by `dispatchMatching.OperatorProfile`. It is never an input to `composeReadiness`. `availabilityDeclared` on `ReadinessInput` (`dispatchReadiness.ts:86`) is the one place readiness already knows the concept, and it stays a fact the composer sets, not something the board writes.

Procedures: `shifts.availabilitySet` (own, `shifts.availability_own`, universal-style self scope), `shifts.availabilityMine`, `shifts.availabilityFor` (dispatcher, `shifts.read`). The dispatcher's candidate pool is `shifts.candidates` (§5.4): deterministic filter and a stable order (readiness verdict, then declared state, then declaredAt), every exclusion carrying a code. No ranking score, no automatic assignment. The scheduling engine reads the same table later; nothing here assigns.

---

## 7. Tenant isolation

| Read/mutation | Proof |
|---|---|
| channel, message, receipt, membership | `messageChannels.tenantId === acting.tenantId` in `openChannel` (unchanged) — a member row on a channel outside scope is unreachable because the channel is |
| post, interest, offer, post event | `shiftPosts.tenantId === acting.tenantId` (unchanged); interests/offers/events through the post |
| availability | `orgScopeWhere(workerAvailability, scope)`; a dispatcher reads only members of their organization (`organizationMemberships`) |
| link / award | `jobInScope(role.posting.jobId)` plus `scopedCheck` on `dispatchEligibilityChecks.orgRef` independently (the dispatcher-board rule: a check is never trusted because its `postingId` matched) |
| membership add | the added `userId` must hold an active `organizationMemberships` row for the channel's `tenantId`, or, under the single tenant, no membership at all (`userInScope`, `db.ts:817`) |

Every refusal across the boundary is `NOT_FOUND`. The pinned `tenantId` table count (`tenantIsolation.test.ts`) does not move: the two new tables carry `orgRef`, and `messageChannelMembers`, `shiftOffers`, `shiftPostEvents`, `messageChannelEvents` carry neither (reachable only through their parent, the `shiftInterests` rule).

---

## 8. Authorization

### 8.1 Procedure → permission (no new permission where an existing one is the same act)

| Procedure | Permission | New? |
|---|---|---|
| `board.createChannel` (extended: `membershipMode`, initial members) | `board.manage` (sensitive) | — |
| `board.direct` (create or return the one `direct` channel for two users) | `board.post` | procedure |
| `board.memberAdd` / `board.memberRemove` | `board.manage`, **or** `moderator` membership on that channel | procedure |
| `board.post` | `board.post`; `emergency` priority or `emergency`/`announcement` channel → `board.publish` | **`board.publish`** (sensitive): dispatcher, safety, management |
| `board.moderate.withdraw`, `board.moderate.read` | **`board.moderate`** (sensitive): management, safety | new; every use writes `messageChannelEvents` |
| `board.mine` (inbox: channels I may open, unread and unacknowledged counts) | `board.read` | procedure |
| `shifts.post`, `shifts.publish`, `shifts.close`, `shifts.cancel`, `shifts.link`, `shifts.offer`, `shifts.offerWithdraw` | `shifts.post` (sensitive) | procedures |
| `shifts.respond` (replaces `expressInterest`, keeps it as an alias for one release), `shifts.offerRespond` | `shifts.interest` | procedures |
| `shifts.candidates`, `shifts.interests`, `shifts.get`, `shifts.list` | `shifts.read` | — |
| `shifts.award` | `dispatch.assign` | procedure |
| `shifts.availabilitySet`, `shifts.availabilityMine` | **`shifts.availability_own`** (self-scoped) | new, universal set |
| `shifts.availabilityFor` | `shifts.read` | — |

Ordinary employees hold `board.post`, `shifts.interest`, `shifts.availability_own` and cannot publish company-wide or emergency, cannot post work, cannot award. `PROCEDURE_AUTHORIZATION_INVENTORY.md` counts and `LEASEOS_CURRENT_STATE.md` (generated) move with the router; `procedureAuthorization.test.ts` already scans `openShiftsRouter.ts` and `messageBoardRouter.ts`.

### 8.2 Audit

- `shiftPostEvents` (append-only): `created, published, linked, closed, reopened, cancelled, expired, response_recorded, response_withdrawn, offer_issued, offer_accepted, offer_declined, offer_withdrawn, offer_expired, awarded, not_selected, award_refused` with `actorUserId`, `actorRole`, `subjectUserId`, `detail`, `occurredAt` (server), `deviceOccurredAt` (device, nullable), `orgRef`.
- `messageChannelEvents` (append-only): `member_added, member_left, member_role_changed, channel_archived, emergency_posted, moderator_read, moderator_withdraw`.
- Messages, revisions, receipts are their own record (the request's allowance; the repository's convention).
- `dispatchRoleAssignmentEvents` carries the binding, as it must; the marketplace row points at it and never restates it.

### 8.3 Outbox

`enqueueBoardEvent(tx, { eventType, aggregateType, aggregateId, tenantId, actorUserId, occurredAt, payload })` in `server/_core/boardOutbox.ts`, modelled line for line on `enqueueEnforcementEvent`: same `tx`, event id derived from the aggregate and transition, no I/O. Event types: `work.posted`, `work.offered`, `work.awarded`, `work.cancelled`, `message.critical.created`, `message.acknowledged`, `board.member.added`. Payloads carry refs and codes, **never message bodies** (the request's leak rule; the outbox row is readable by every consumer). The drain worker's consumer writes `workflowNotifications` (`channel: in_app`, `notificationKey` derived so a re-run tells nobody twice) — that is the whole notification system today. Push, SMS and email remain adapters behind the same event; none is built here. Wiring `eventEmitter.emitDomainEvent` instead of a third enqueue helper is the right consolidation and is out of this checkpoint's scope only because it is its own declared-unwired resolution; the helper's signature is `emitDomainEvent`-shaped so the swap is mechanical.

---

## 9. Resolving the `openShifts` duplication (moratorium compliance)

Checkpoint 2 makes `openShiftsRouter` a router over `_core/openShifts.ts`: `candidatesFor` and `summarize` back `shifts.candidates`; `expressInterest` (the pure one) decides the response refusal; `intendToAssign` is what `shifts.offer` returns. The inline eligibility code in `shifts.eligibility` (`openShiftsRouter.ts:107`–`:155`), including its read of `workerQualifications`, is **deleted** and the procedure is re-pointed at `previewFor` (§5.4). `openShifts` leaves `DECLARED_UNWIRED`; `engineReachability.test.ts` proves it is reached. `_core/openShifts.ts` gains no new rule; `previewFor` lives in `server/openShiftsService.ts` as a resolver.

`dispatchMatching` stays declared unwired (Alternative D). No `_core` module is added by this design.

---

## 10. Migrations

Scan of every remote branch against `origin/main` (2026-09-24): claims exist for `0170` (auth-workspace, work-calendar), `0172`–`0175` (training-academy), `0175`–`0177` (driver-portfolio, two branches), `0178`–`0181` (document-control), `0179` (eld, migration-0169-reconciliation). **First number free on `main` and on every open branch: `0182`.**

| Number | File | Contents |
|---|---|---|
| **`0182`** | `0182_board_membership.sql` | `messageChannels`: `type` enum + `direct, group, department, unit, shift`; `membershipMode`; backfill `crew` where `crewRef IS NOT NULL`. `messageChannelMembers` (+ generated `memberKey`, unique). `messageChannelEvents`. `boardMessages`: `clientMutationId`, `UNIQUE(deviceId, clientMutationId)`. `messageReceipts.deviceAcknowledgedAt`. |
| **`0183`** | `0183_open_work_offers_availability.sql` | `shiftPosts`: link, unit, overtime, region, priority, lifecycle timestamps, `status` enum + `draft, closed`. `shiftInterests`: `response`, clocks, replay key, `UNIQUE(deviceId, clientMutationId)`. `shiftOffers` (+ generated `offerKey`). `shiftPostEvents`. `workerAvailability`. |
| **`0184`** | reserved for Checkpoint 3 | only if the award needs a column the design missed; released if not |

Register: this branch's rows go into `docs/architecture/MIGRATION_COLLISION_REGISTER.md` at implementation, per its rule ("the first branch to merge keeps its number; every other claimant takes the next number free … at its own rebase"). Parity: four new `CREATE TABLE` in `0182`/`0183` ↔ four new `mysqlTable(` in `drizzle/schema.ts`. `tenantIsolation.test.ts` pin unchanged (§7).

---

## 11. Offline / Field Mobile (Checkpoint 4 shape, not built here)

- Reads: `board.mine`, `board.read`, `shifts.list`, `shifts.get` are cached in `LocalStore` keyed by ref; the screen shows the `synchronized`-at time of the cache, never "live".
- Writes: three `CaptureKind`s are added — `board_message`, `board_acknowledgement`, `shift_response` — carrying `channelRef`/`messageRef`/`postRef` in `fields`, and `Outbox.queue()` accepts a capture that relates to a channel or post instead of a job or unit (a one-branch change to `outbox.ts:43` guarded by kind). They are sent through the existing tRPC procedures with `clientMutationId = localId` and `deviceId`, not through `sync.receivePackage` (which seals evidence and would make a chat message an evidence record). The six sync states are shown as they are; `synchronized` is set only from the server's `messageRef`/`replayed` reply — **never before**.
- When HS3's command ledger lands, `commandId` is this `clientMutationId`; the per-table unique keys stay as the storage-level guard and the ledger becomes the protocol-level one.
- Navigation: a `BoardPanel` beside `InboxPanel` in `PortalShell` with the five tabs the request drew (Inbox · Dispatch · My Jobs · Open Work · Safety); Open Work card = `shifts.list` row + `previewFor` lines; Interested/Decline = `shifts.respond`; job room = `board.read` on the room the award created.

---

## 12. Test plan

New files, in the repository's two conventions (pure `*.test.ts`, database `*.db.test.ts` guarded by `DATABASE_URL`):

| File | Covers |
|---|---|
| `server/boardMembership.test.ts` | pure: explicit-mode admission, four standings reused, `direct` = two members, `read_only` cannot post, moderator access is an event |
| `server/boardMembershipApi.db.test.ts` | non-member `NOT_FOUND` on messageRef / `FORBIDDEN` on channelRef; management cannot read a `direct` channel; `board.moderate.read` writes `moderator_read`; cross-org member add refused; cross-org channel read refused |
| `server/boardPublish.db.test.ts` | driver with `board.post` cannot post `emergency` or into `announcement`; safety can; `emergency_posted` and `message.critical.created` written in the same transaction (assert by rolling back a forced failure) |
| `server/boardReplay.db.test.ts` | same `(deviceId, clientMutationId)` twice → one message, `replayed: true`; acknowledgement twice → one `acknowledgedAt`; cross-org acknowledge → `NOT_FOUND`; device vs server acknowledgement clocks both kept |
| `server/openWorkLifecycle.test.ts` | pure: post transitions table; response replace-in-place; offer lifecycle; `expired` derivation |
| `server/openWorkApi.db.test.ts` | publish/close/cancel; respond after close refused; respond on `assigned` post refused; interest duplicate → `recorded: false` under a forced race; offer accept/decline replay; cross-org read/respond/offer/award refused; link requires `dispatch.assign` and `jobInScope` |
| `server/openWorkEligibility.db.test.ts` | preview is `unknown` with `no_operator_record`; `NOT_EVALUATED` renders `?` not ✓; a `*_unknown` finding shows ✗ with its code; leave and rotation reasons carried from the engine (the wired `candidatesFor`) |
| `server/shiftAward.db.test.ts` | award binds through `setRoleAssignment` (event row present, `awardEventId` set, staffing recomputed); readiness `blocked` refuses; readiness `unknown` uncovered refuses; stale check refuses; check for another subject refuses; cancelled post refuses; unlinked post refuses; other offers `not_selected`; `work.awarded` outbox row in the same transaction; job room created with dispatcher and operator |
| `server/shiftAwardConcurrency.db.test.ts` | two awards, one slot, one survivor; accept vs cancel; retry after commit → `CONFLICT` |
| `server/availability.db.test.ts` | set/supersede; window half-open; dispatcher reads own org only; candidate pool order is stable and every exclusion has a code; availability never changes a readiness verdict |
| `server/engineReachability.test.ts` (edit) | `openShifts` removed from `DECLARED_UNWIRED` |
| `server/tenantIsolation.test.ts` (unchanged) | proves the pin did not move |
| `server/procedureAuthorization.test.ts`, `PROCEDURE_AUTHORIZATION_INVENTORY.md` (edit) | counts |
| `client/src/portal/BoardPanel.dom.test.tsx` (Checkpoint 4) | queued message never shows as delivered; `?` for not-evaluated |

Existing suites that must keep passing untouched: `openShifts.test.ts` (16), `openShiftsApi.test.ts` (12), `messageBoard.test.ts` (18), `messageBoardApi.test.ts` (12), `messageLifecycle.test.ts` (18), `crewChannels.test.ts` (21), `crewChannelApi.test.ts` (30), `dispatchRoleAssignment.db.test.ts` (59), `dispatchConcurrency.test.ts` (9), `legacyAssignmentGuard.test.ts`.

---

## 13. Contradictions and assumptions in the request, against the tree

| # | The request says | The tree says | This design |
|---|---|---|---|
| C-1 | "Communications subsystem" | `comms.*` is radio communications on the route (v22.17–v22.19, 30 procedures, own sensitive permissions) | The subsystem is the **board** (`board.*`) and **open work** (`shifts.*`); this document does not use "communications" for it |
| C-2 | "the LeaseOS contact directory you already planned" | `SCOPE_RECONCILIATION_2026-09-21.md` §1: **MISSING**; roadmap "Product not built" | Job rooms attach records by pointer; the directory attaches the same way when it exists |
| C-3 | `evaluateDispatchReadiness()` is the gate to invoke | It is pure and reached only through `composeReadiness`; the award consumes a stored, fingerprinted check re-validated against a recompute | §5.5–5.6 consume the check, not the function |
| C-4 | Priorities `normal, dispatch, important, safety, emergency` | Board priorities are `normal, important, urgent, emergency`; dispatch and safety are channel **types**; acknowledgement is derived from priority | Keep the four; no enum change; `board.publish` gates emergency |
| C-5 | Conversation kinds as a list | Twelve channel types exist; `private` means management-only | Add five types; DM = `direct` + explicit membership |
| C-6 | Membership roles `member, moderator, dispatcher, manager, read-only` | Domain roles are separate (`GRANTS`); crews already have a `crewRole` enum | Channel roles are a channel property (§4.2) and confer no domain permission |
| C-7 | Lifecycle `… Accepted → Awarded → Dispatched` | Bound (`setRoleAssignment`) ≠ awarded (`dispatch.award`, bookings) ≠ dispatched (pre-departure gate) | Marketplace award = binding behind a readiness check; the dispatcher's award and pre-departure stay |
| C-8 | "Establish availability" | No availability concept exists; only absence and rotation | `workerAvailability` is new, and declarative only |
| C-9 | "Do not duplicate the credential truth source" | Three stores; D-05 settles the canonical pair; `openShifts` reads the one nothing writes | The board reads readiness only; the inline credential read is deleted (§9) |
| C-10 | Employee ↔ operator | `openShiftsRouter.ts:123` treats `operators.id` as the `userId`; `operators.userId` is the mapping and is nullable | `operators.userId` is used everywhere; a person with no operator row previews `unknown` and cannot be awarded |
| C-11 | "Use the existing outbox" | One production writer; `eventEmitter` declared unwired | Same-transaction enqueue by the enforcement pattern; emitter consolidation is separate spine work |
| C-12 | Push notifications | None exist; in-app `workflowNotifications` only | Events only; adapters later |
| C-13 | "Idempotent retry" for messages | No mutation identity on `boardMessages`; HS3 ledger unbuilt | `(deviceId, clientMutationId)` now; `commandId` later |
| C-14 | Tenant isolation tests "at minimum" | Isolation is a measured surface, not a property (roadmap step 3 open) | Every new procedure gets a cross-org test; the document does not claim org-wide isolation |
| C-15 | "Overtime board" | No table needed | `shiftPosts.overtime` + filter |
| C-16 | Award race "only valid award survives" | Already true for the binding (posting lock + head event, D14) | The marketplace award enters the same lock in the same order |
| C-17 | Migration numbers "based on current main" | `main` head `0174`; open branches to `0181` | `0182`/`0183`, `0184` reserved |
| C-18 | "One giant PR" warning | Repository workflow: design approved, then checkpoints with the gate green each time | Checkpoints in §15 |

---

## 14. Owner decisions requested

- **D-1 — Award semantics.** Marketplace award = slot binding behind a valid readiness check (§5.5), with `dispatch.award` remaining the dispatcher's booking step. *Alternative:* the marketplace award calls `awardAssignment` too, in the same transaction, which makes `filled` mean "booked" and doubles the work the dispatcher's screen already does.
- **D-2 — Offer record.** New `shiftOffers` keyed by `(postRef, userId)` (§5.2). *Alternative:* extend `dispatchInvitations` (Alternative B).
- **D-3 — Moderation of private channels.** `direct`/`group` unreadable by management; `board.moderate` (sensitive) reads with an access event (§4.3). *Alternative:* management reads everything, which the request rules out.
- **D-4 — Announcement audience.** Refuse an announcement with no audience; resolve audience from organization membership, bounded at 500 with branch channels beyond (§4.4). *Alternative:* allow audience-less posts with no roll-call.
- **D-5 — Availability preferences shape.** The eight declared fields in §6. Anything else is deferred to the scheduling engine.
- **D-6 — `shifts.expressInterest` alias.** Keep for one release, then remove, adjusting the inventory count.

---

## 15. Checkpoints

| # | Scope | Gate evidence |
|---|---|---|
| 1 (this) | Survey + design on `claude/leaseos-communications-marketplace-p8ptqw` | documentation guards green; no code |
| 2 | `0182`, `0183`; membership + `board.publish`/`board.moderate`; mutation identity; post lifecycle, responses, offers, availability; `openShifts` wired and the inline copy deleted; outbox helper; every refusal test in §12 except award | full `ci-gate.sh`; `engineReachability` updated; inventory counts |
| 3 | `shifts.award` on `applyBinding(tx)`; job-room resolver; concurrency suite; `work.awarded` | `shiftAward*.db.test.ts`, `dispatchRoleAssignment.db.test.ts` unchanged |
| 4 | Field Mobile slice: `BoardPanel`, Open Work list + card, respond, job room, three capture kinds, queue state | dom tests; `commPackage`/runtime suites unchanged |

Nothing merges until the owner records D-1…D-6.
