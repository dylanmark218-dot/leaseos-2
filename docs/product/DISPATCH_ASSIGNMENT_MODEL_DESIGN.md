# Dispatch Assignment Model — design

**Status:** **APPROVED** with three owner decisions, recorded in §18 and incorporated throughout.
Design only — nothing here is implemented, and no production code, schema or migration is written by
this document. The implementation plan is `DISPATCH_ASSIGNMENT_IMPLEMENTATION_PLAN.md`.

**Written against:** `main` at `f21cd1b`, with the in-flight stack `#4 → #5 → #6`
(`c72a55a`, `8bb6002`, `363327f`) read for the readiness parts. Every claim carries a `file:line`.

**The question this answers:** LeaseOS has no clean assignment domain. Before another screen is
allowed to call one, what *is* the canonical assignment, and what does assignment mean as distinct
from readiness and from award?

**The short answer, which is not what this document set out to find:** LeaseOS already has the
model. `dispatchRoles` is a slot — requirement beside fill beside status — and postings, staffing
states and the award transaction are all built around it. It is complete in schema and in pure
logic, and it has **no production INSERT**. The work is not to design an assignment subsystem. It
is to finish reaching the one that is already here.

---

## 1. Current-state findings

### 1.1 The slot model exists, in prose as well as in schema

The intent is stated by the owner, not inferred by me:

> `// One posting may need several roles — a rig move is a lead, winch tractors,`
> `// a bed truck, a picker and pilot vehicles, each assigned independently.`
> — `drizzle/schema.ts:1864-1865`, immediately above `dispatchRoles`

> `* A rig move is one posting with independently gated roles. It does not become`
> `* staffed until every REQUIRED role is filled — optional support roles do not`
> `* hold it back. No special-casing by job type.`
> — `server/_core/dispatchLifecycle.ts:185-188`, above `assessStaffing`

`dispatchRoles` (`drizzle/schema.ts:1866-1887`) carries, in one row:

| Concern | Columns |
|---|---|
| Slot identity | `id`, `postingId`, `roleCode`, `roleLabel` |
| What the slot needs | `requiredEquipmentClass`, `requiredTrailerClass`, `requirementsJson` |
| What fills it | `assignedOperatorId`, `assignedUnitId`, `assignedTrailerId` |
| Where it is | `status: open \| invited \| bid_received \| assigned \| cancelled` |

That is slot-and-fill. `jobUnits` is a join row with a free-text `role varchar(100)` that no server
code reads.

### 1.2 The model is unreachable

| Table | Production INSERT | Production UPDATE |
|---|---|---|
| `dispatchPostings` | **none** | `planningState` only, `_core/dispatchTransaction.ts:343` |
| `dispatchRoles` | **none** | binding + status only, `_core/dispatchTransaction.ts:264` |
| `dispatchBids` | **none** | status only, inside the award |
| `dispatchInvitations` | **none** | status only, inside the award |
| `resourceBookings` | award only, `_core/dispatchTransaction.ts:276` | **never** — no release exists |
| `jobUnits` | `dispatchEnforcementService.ts:61` (gated), `db.ts:686` (dead) | **never** |

So a role can be *filled* by the award and never *created* by anything. The entire
posting/bid/staffing subsystem is schema-complete, logic-complete, and has no API door.

### 1.3 Staffing is already derived from slot occupancy

`_core/dispatchTransaction.ts:319-343` selects every role of the posting, calls
`assessStaffing()` (`_core/dispatchLifecycle.ts:190-215`), and moves `planningState` to `staffed`
or `partially_staffed` through `canTransitionPosting` (`:20-44`). A posting is staffed when every
**required** role has an `assignedOperatorId`; optional roles do not hold it back.

Two gaps in that, both real:
- `dispatchRoles` has **no `required` column**, so `dispatchTransaction.ts:328` hardcodes
  `required: true`. The optional-role semantics exist in the pure function and cannot be expressed
  in the data.
- `roleRows.length === 0 ? "staffed"` (`:335`) means a posting with no roles reads as fully staffed.

### 1.4 `usedForAward` is a flag, not a guard

Written in two places — `_core/dispatchTransaction.ts:287-290` (award) and
`dispatchEnforcementService.ts:62` (legacy `jobUnits.create`) — and **read by no production code at
all**. A check can therefore be "spent" an unbounded number of times by either route. This matters
for the design in one specific way: it is the only column the two award paths share, so a third
writer would make it meaningless to any future reader.

### 1.5 `jobUnits` is not an assignment table

Its columns say what it is: `role`, `joinedAt`, `departedAt`, **`hours`, `mileage`,
`workPerformed`** (`drizzle/schema.ts:163-177`). Hours and mileage are facts you know *after* the
work. `todo.md:32,57` calls it the "multi-unit crew table"; the showcase renders it as
"multi-unit crew — Primary unit / Support unit / Standby" (`client/src/showcase/FleetWorkspace.tsx:530-562`).

It is a **participation and worklog record**, written once and never updated, which the v21.2
enforcement work (`drizzle/0039_dispatch_enforcement.sql`) retrofitted into a direct-award path by
bolting on `eligibilityCheckId` and `enforcementModeAtCreate`. That retrofit is the conflation.

### 1.6 Readiness reads no assignment source at all

`composeReadiness` takes `ReadinessSubject = { operatorId, unitId, trailerId, jobId, postingId? }`
as a **parameter** (`server/readinessComposer.ts:54-56`). It does not read `jobUnits` and does not
read `dispatchRoles`. The caller says who to evaluate.

This is good news: there is no competing assignment source feeding readiness today, because there
is no source. PR #5's panel had to resolve a subject itself from `jobUnits.list`, which is exactly
why it inherited that table's hundred-row, job-blind window.

### 1.7 Exclusivity is per-resource, never per-job

`_core/dispatchTransaction.ts:182-206` refuses a booking when the same operator or unit already has
an overlapping booking on a **different** posting — `if (o.postingId === input.postingId) continue;`
(`:199`) explicitly skips same-posting overlap. A person or a truck is in one place at a time; a job
holds many. No UNIQUE constraint anywhere pairs a `jobId` with a `unitId` or `operatorId`.

---

## 2. The domain problem

Three concepts are currently one mutation.

| Concept | Question it answers | Where it lives today |
|---|---|---|
| **Assignment** | Who and what is *expected to do* this work? | nowhere reachable; `jobUnits` approximates it |
| **Readiness** | Is that pairing *fit and lawful* to dispatch right now? | `composeReadiness`, server-authoritative, subject supplied by caller |
| **Award** | Is this dispatch *authorised to proceed*? | `dispatch.award` (posting) and `jobUnits.create` (direct) |

`jobUnits.create` performs (1) always, and (3) whenever it is handed an `eligibilityCheckId` — it
sets `usedForAward` and, under `enforced`, refuses without a valid check. Its gate function is
documented as *"The award's rule, without a posting or a bid"* (`_core/dispatchEnforcement.ts:39-41`).

**Proved by execution**, not by reading: a call carrying an `eligibilityCheckId` flipped
`usedForAward` from `0` to `1` on a check whose verdict was `blocked`; the same call without one
was a plain insert; and `decideLegacyAssignment` refuses outright under `enforced`.

---

## 3. Alternatives considered

### Option A — a new `dispatchAssignments` table

Build the append/history assignment subsystem from scratch, hanging off `jobId`.

*Rejected.* It would be the third table claiming to say who is on a job, beside `dispatchRoles` and
`jobUnits`, and it would duplicate `requiredEquipmentClass` / `status` / staffing logic that already
exists and is already tested. `assessStaffing` and `canTransitionPosting` would have to be either
re-implemented or left stranded. This is the "parallel abstraction because the old one is broken"
failure.

### Option B — canonicalise `dispatchRoles`, add an immutable event log

`dispatchRoles` is the current slot state, mutated in place for its binding and status. A new
append-only `dispatchRoleAssignmentEvents` table records every transition. Postings become
creatable; a direct job gets a posting with `distribution: "direct_assignment"`, which the enum
already anticipates (`drizzle/schema.ts:1804`).

*Recommended.* See §4.

### Option C — pure append, current state derived by a `_core` function

No mutable current row; `currentAssignmentFor(roleId, events, at)` derives the binding, as
`currentReleaseEvidenceFor` does for mechanic releases (`_core/mechanicRelease.ts:225-236`).

*Rejected for this subsystem, though it is the newest and most carefully argued idiom in the repo.*
`dispatchRoles` already exists as mutable current state and the award transaction already reads it
that way (`_core/dispatchTransaction.ts:262-272, 319-332`). Making it derived would mean rewriting
the award and the staffing read for no behavioural gain. The derived-state idiom earns its cost
where the *rules of currency are contested* — which release supersedes which — and slot occupancy
is not contested: a slot has one binding, and who put it there is history, not interpretation.

---

## 4. Recommended model

```
job
 └── dispatchPosting                     the dispatch envelope (incl. distribution = direct_assignment)
      └── dispatchRole                   THE SLOT — canonical current assignment
           ├── assignedOperatorId        }
           ├── assignedUnitId            }  the binding
           ├── assignedTrailerId         }
           └── status: open → assigned
      └── dispatchRoleAssignmentEvents   immutable history of every binding change   [NEW]

jobCrewAssignments                       crew participation: co-driver, additional crew, shift window
jobUnits                                 legacy participation/worklog + direct-award artifact
```

**Why this fits LeaseOS specifically:**

- *Audit philosophy.* Every subsystem here owns an append-only event table beside its state
  (`dispatchAuditEvents`, `academyAuditEvents`, `manifestCustodyEvents`, ~30 more). There is a
  generic `domainEventOutbox`, but it has exactly one production writer and its emitter layer is
  formally declared unwired in `engineReachability.test.ts`. The per-subsystem pattern is the house
  convention and the one the newest migrations (0162, 0163) reaffirm.
- *Trucking operations.* A rig move is a lead, winch tractors, a bed truck, a picker and pilot
  vehicles. The owner wrote that sentence into the schema. Slots are how that job is dispatched.
- *Readiness invalidation.* A slot's binding is exactly the readiness subject
  (`operatorId`, `unitId`, `trailerId`), so a binding change is a fingerprint change with no
  translation layer.
- *Tenant isolation.* A role reaches its organization through `posting → job → jobs.orgRef`, the
  same path `jobUnits` uses today for reads.
- *Offline and mobile.* A slot has stable identity (`roleId`) that survives a resource swap. An
  offline client can hold "role 44" and reconcile; it cannot hold "the jobUnits row that will exist".

---

## 5. Data model

### 5.1 `dispatchRoles` — two added columns

| Column | Type | Why |
|---|---|---|
| `required` | `boolean NOT NULL DEFAULT true` | `assessStaffing` already distinguishes required from optional and `dispatchTransaction.ts:328` hardcodes `true` because the data cannot express it. This is a real missing semantic, not a nicety. |

`roleCode` keeps its type (`varchar(60)`) and gains a **validation rule**, not a constraint: it must
match an `active` row in the new catalog (§5.2). No foreign key — house style validates in the
mutation (`jobInScope`, `unitInScope`) rather than at the DDL level, and a hard FK would make
deactivating a role type fail against historical rows.

Nothing else changes. `assignedOperatorId`, `assignedUnitId`, `assignedTrailerId` and `status`
already carry the binding.

### 5.2 `dispatchRoleTypes` — new controlled catalog (OWNER DECISION 3)

`roleCode` must be neither free text nor a closed enum. Free text is how `jobUnits.role` became
meaningless — `varchar(100)`, unvalidated, read by nothing. A SQL/TypeScript enum would mean a
migration every time LeaseOS supports another trucking role.

A catalog table is rows, so it extends without a migration, and it is the same shape LeaseOS already
uses for vocabularies (`facilityDirectory.vocabulary.list` backs the disposal waste-code picker the
same way).

| Column | Type | Notes |
|---|---|---|
| `id` | `int AUTO_INCREMENT PK` | |
| `roleCode` | `varchar(60) NOT NULL` | stable machine code, never displayed raw |
| `orgRef` | `varchar(64) NULL` | NULL = available to every tenant; set = that organization's own role type. The 0132 convention. |
| `displayName` | `varchar(120) NOT NULL` | what a dispatcher reads |
| `description` | `varchar(500) NULL` | |
| `defaultEquipmentClass` | `varchar(60) NULL` | seeds `dispatchRoles.requiredEquipmentClass` when a role is created |
| `defaultTrailerClass` | `varchar(60) NULL` | seeds `requiredTrailerClass` |
| `active` | `boolean NOT NULL DEFAULT true` | deactivate rather than delete — historical roles keep their code |
| `createdByUserId` | `int NOT NULL` | |
| `createdAt` | `timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP` | |

| `roleTypeKey` | `varchar(140)` PERSISTENT generated | `CONCAT(COALESCE(orgRef,'*'), ':', roleCode)` — the uniqueness key. Never written by the application. |

**Uniqueness — corrected.** `UNIQUE(orgRef, roleCode)` would **not** protect the global catalog.
MariaDB permits unlimited NULLs in a unique index, including a composite one, so three global `LEAD`
rows coexist happily. Verified by execution before this was written:

```sql
CREATE TABLE t (… orgRef varchar(64) NULL, roleCode varchar(60) NOT NULL, UNIQUE KEY u (orgRef, roleCode));
INSERT INTO t VALUES (NULL,'LEAD'), (NULL,'LEAD'), (NULL,'LEAD');   -- all three accepted
```

The repository already hit this exact bug and already fixed it, in
`drizzle/0021_active_role_uniqueness.sql`: a **PERSISTENT generated column** carrying a collision key
with `COALESCE(scopeRef, '*')`, with uniqueness on the key rather than on a tuple containing a NULL.
Its comment is worth repeating — *"Application-level duplicate checks are not a substitute — two
concurrent grants would both pass a read-then-write check."*

So:

```sql
ALTER TABLE dispatchRoleTypes
  ADD COLUMN roleTypeKey varchar(140)
    AS (CONCAT(COALESCE(orgRef, '*'), ':', roleCode)) PERSISTENT;
CREATE UNIQUE INDEX dispatchRoleTypes_roleTypeKey_unique ON dispatchRoleTypes (roleTypeKey);
```

which gives all four required properties: two global `LEAD` refused (`*:LEAD` twice), two `ORG-A`
`LEAD` refused, `ORG-A` and `ORG-B` `LEAD` allowed, and global `LEAD` beside `ORG-A` `LEAD` allowed —
so tenant-first resolution stays possible. In `schema.ts` it is declared as a plain `varchar` with a
comment saying the database derives it, exactly as `userRoleAssignments.activeGrantKey`
(`drizzle/schema.ts:3003`) is.

**A second correction, larger than the first, found while fixing it.** `orgRef IS NULL` in LeaseOS
does **not** mean "global". It means "the historical single tenant's row"
(`server/db.ts:154-164`), and `orgScopeWhere` for a real tenant emits `eq(orgRef, tenantId)` — which
**excludes NULL rows entirely**. Reading this catalog with the house helper would show a member of
`ORG-A` an empty catalog and hand them a validation error for every seeded code.

A catalog is shared vocabulary, not an owned record, so it does not use `orgScopeWhere`. Its read is:

```sql
WHERE orgRef IS NULL OR orgRef = :tenantId      -- global rows are visible to everyone
```

then `resolveRoleType` prefers the tenant row over the global one. This is called out in the
implementation plan as a checkpoint-A test, because the failure mode is silent and a future
developer reaching for the familiar helper would reintroduce it.

**Seed — evidenced only.** From the rig-move sentence in `drizzle/schema.ts:1864-1865`:
`LEAD`, `WINCH_TRACTOR`, `BED_TRUCK`, `PICKER`, `PILOT_VEHICLE`. From the shipped showcase crew
panel (`client/src/showcase/FleetWorkspace.tsx:551,556,561`): `PRIMARY_UNIT`, `SUPPORT_UNIT`,
`STANDBY`.

That is the whole seed. The worked example in §9 uses `VAC_TRUCK` and `WATER_TRUCK`, which are
**illustrative and deliberately not seeded** — adding them is one row insert by whoever knows the
operation, which is precisely the property this design is buying. No industry taxonomy is invented
here.

### 5.3 `dispatchRoleAssignmentEvents` — new, append-only

Modelled on `dispatchAuditEvents` (`drizzle/schema.ts:1999`), which is already role-aware
(`postingId`, `roleId`, `eventType`, `actorUserId`, `actorRole`).

| Column | Type | Notes |
|---|---|---|
| `id` | `int AUTO_INCREMENT PK` | |
| `eventRef` | `varchar(64) NOT NULL UNIQUE` | house convention: a mintable business key |
| `roleId` | `int NOT NULL` | the slot |
| `postingId` | `int NOT NULL` | denormalised for the posting-scoped read |
| `jobId` | `int NOT NULL` | denormalised for the job-scoped read |
| `eventType` | `enum('assignment_created','assignment_reassigned','assignment_unassigned')` | closed set |
| `fromOperatorId` / `fromUnitId` / `fromTrailerId` | `int NULL` | the binding before |
| `toOperatorId` / `toUnitId` / `toTrailerId` | `int NULL` | the binding after |
| `reason` | `varchar(500) NULL` | required for reassign and unassign; see §7 |
| `actorUserId` | `int NOT NULL` | |
| `actorRole` | `varchar(60) NOT NULL` | matches `dispatchAuditEvents` |
| `occurredAt` | `timestamp NOT NULL` | |
| `createdAt` | `timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP` | |

Indexes: `(roleId, id)` — the precondition read in §10 and the per-slot history;
`(jobId, occurredAt)` — the detail screen's history panel.

**No `orgRef`.** The row is reachable only through its role, and the mutation guards tenancy on the
job before writing (§8). Adding an `orgRef` that nothing filters on would be a column that looks
like a guard and is not.

### 5.4 What is *not* added

No `version` column. LeaseOS has no optimistic-versioning convention — there is no `expectedVersion`,
no `ifMatch`, no `updatedAt`-as-precondition anywhere in `server/`. See §10 for what is used instead.

---

## 6. API contract

Four procedures. `assign` and `reassign` are deliberately **one mutation**, because the difference
between them is whether the slot was already filled — which is server state, not caller intent, and
making the caller declare it invites the caller to be wrong.

### `dispatch.setRoleAssignment` — assign *and* reassign

| | |
|---|---|
| **Permission** | `dispatch.assign` (existing; held by `dispatcher`, `management`) |
| **Input** | `{ roleId: int, operatorId: int \| null, unitId: int \| null, trailerId: int \| null, expectedLastEventId: int \| null, reason?: string(≤500) }` |
| **Output** | `{ roleId, status, binding: {operatorId, unitId, trailerId}, eventId, postingState, staffing: { filled, requiredTotal, unfilledRoles } }` |
| **Tenant** | role → posting → job; `jobInScope`, then `unitInScope` / `operatorInScope` on every supplied id |
| **Concurrency** | `SELECT … FOR UPDATE` on the role; `expectedLastEventId` compare-and-set (§10) |
| **Audit** | one `dispatchRoleAssignmentEvents` row, `assignment_created` when the slot was `open`, `assignment_reassigned` when it was `assigned` |
| **Readiness** | none computed, none consumed. Changing the binding changes the facts; the client re-queries `dispatch.readiness` |
| **Refuses** | a `cancelled` role; a role whose posting is `completed` or `cancelled`; an out-of-scope job/unit/operator; a stale `expectedLastEventId`; `reason` absent when the slot was already filled; **an operator or unit already occupying another active role on this posting** (OD-1); a `roleCode` absent from the active catalog |

### `dispatch.clearRoleAssignment` — unassign

Separate from the above, because "set to nobody" and "set to somebody" differ in what they must
require: an unassignment always takes a reason, and it is the one operation that can move a staffed
posting backwards. Folding it into `setRoleAssignment` as three nulls would make the reason
requirement conditional on the shape of the payload, which is exactly the kind of implicit rule that
gets forgotten.

| | |
|---|---|
| **Permission** | `dispatch.assign` |
| **Input** | `{ roleId: int, expectedLastEventId: int \| null, reason: string(1..500) }` |
| **Output** | as above, with `status: "open"` and a null binding |
| **Audit** | `assignment_unassigned` |

### `dispatch.listRoles` — read

| | |
|---|---|
| **Permission** | `dispatch.read` (existing) |
| **Input** | `{ jobId: int }` or `{ postingId: int }`, `includeHistory?: boolean` |
| **Output** | roles with binding, status, requirement and `lastEventId`; history when asked |

This is the procedure the detail screen needs and `jobUnits.list` cannot be: **job-filtered**, so
no hundred-row tenant-wide window, and it returns `lastEventId` so the screen can hold a
precondition token.

### `dispatch.createPosting` / `dispatch.addRole` — the missing door

Without these, nothing above is reachable. Minimum shape:
`createPosting({ jobId, distribution, roles: [{ roleCode, roleLabel, required, requiredEquipmentClass?, requiredTrailerClass? }] })`,
permission `dispatch.assign`, refusing a job out of scope.

A direct job gets `distribution: "direct_assignment"` and `planningState: "direct"` — both already
in the enums (`drizzle/schema.ts:1804`, `_core/dispatchLifecycle.ts:26`).

---

## 7. Permissions

No new permission. `dispatch.assign` already exists, already means this, and is already held by
exactly `dispatcher` and `management` (`server/_core/recordsAuthorization.ts:2337`).

| Operation | Permission |
|---|---|
| set / clear role assignment, create posting, add role | `dispatch.assign` |
| list roles and history | `dispatch.read` |
| award | `dispatch.award` — **not** granted by any of the above |

That `dispatcher` happens to hold both `dispatch.assign` and `dispatch.award` is irrelevant to the
design: the operations stay separable so that the *grant* can be separated later without touching
the code.

Explicitly **not** granted by assignment: `dispatch.award`, `maintenance.record_release`, any
safety or HOS permission.

---

## 8. Lifecycle and state transitions

```
        ┌──────────── clearRoleAssignment ────────────┐
        ▼                                             │
      OPEN ──── setRoleAssignment ────▶ ASSIGNED ─────┘
        │                                 │
        │                                 └── setRoleAssignment (different binding)
        │                                     ──▶ ASSIGNED, one reassignment event
        └── cancelled (posting cancellation only, not an assignment operation)
```

`invited` and `bid_received` remain the bid path's states and are untouched by this API.

Every transition writes exactly one immutable event. The role row is mutated; the history is not
the role row.

**Transaction for a reassignment** (the shape all three operations share):

```
BEGIN
  SELECT … FROM dispatchPostings WHERE id = :postingId FOR UPDATE   ← serialises the posting
  SELECT … FROM dispatchRoles    WHERE id = :roleId    FOR UPDATE
  role exists, not cancelled                                  → else NOT_FOUND / PRECONDITION_FAILED
  posting not completed/cancelled                             → else PRECONDITION_FAILED
  posting → job; jobInScope(job, scope)                       → else NOT_FOUND
  unitInScope / operatorInScope / unitInScope(trailerId)      → else NOT_FOUND
  roleCode resolves in the active catalog (tenant, then global)→ else BAD_REQUEST
  lastEventId(roleId) == expectedLastEventId                  → else CONFLICT
  no OTHER active role on this posting holds operatorId       → else CONFLICT   (OD-1)
  no OTHER active role on this posting holds unitId           → else CONFLICT   (OD-1)
  capture the old binding from the locked row
  UPDATE dispatchRoles SET assigned*, status='assigned'
  INSERT dispatchRoleAssignmentEvents (from…, to…, reason, actor)
  recompute assessStaffing over this posting's roles
  UPDATE dispatchPostings.planningState if canTransitionPosting allows
COMMIT
```

**Why the posting lock.** OD-1's rule is "not twice on this posting", which is a statement about a
*set* of rows, and MariaDB has no filtered/partial unique index that could express "unique among
rows whose status is assigned". So the guarantee is transactional: take the posting lock the award
already takes (`_core/dispatchTransaction.ts:93-97`), then check and write inside it. Two concurrent
assignments to the same posting serialise; two to different postings do not contend.

The staffing recomputation is the *same* call the award already makes
(`_core/dispatchTransaction.ts:319-343`), so assignment and award cannot disagree about whether a
posting is staffed.

### 8.1 Staffing state, and what it can and cannot say (OWNER DECISION 2)

**The rule.** Staffing is *derived from current required-slot occupancy*, every time a binding
changes. Losing a required role stops a posting presenting itself as staffed, immediately.

| Required roles filled | `assessStaffing().state` | `planningState` |
|---|---|---|
| all | `staffed` | `staffed` |
| some, not all | `partially_staffed` | `partially_staffed` |
| none | `unstaffed` | **see the limitation below** |

An understaffed posting **never** transitions to `awarding`. `awarding` means "we are choosing who
gets this", not "we are missing a truck", and using it for the second would make the bid path
unreadable.

**Award history is never erased.** `dispatchAuditEvents` rows are append-only and nothing in this
design deletes or rewrites one, so an `assignment_approved` for a posting that later loses a driver
stays exactly where it is. What changes is not the record but its *currency*: the binding change
moves `computeEligibilityFingerprint`, `assessEligibilityValidity` returns
`invalidatedBy: "dependency_change"`, and the stale check can no longer authorise an award
(`_core/dispatchAward.ts:100-110`). Historical truth is preserved; stale authority is not reusable.
That is the existing mechanism, used as-is — no new invalidation column.

**A limitation to name rather than hide**, exactly as the owner asked.

`assessStaffing` has three states; `PostingState` has no `unstaffed`
(`_core/dispatchLifecycle.ts:20-44`), and from `staffed` the only legal backward transitions are
`dispatched`, `partially_staffed` and `cancelled`. So a posting that was `staffed` and loses *every*
required role can legally land only on `partially_staffed` — which is not true, and
`planningState` cannot say so.

More fundamentally: `planningState` is one field carrying two questions — *where is this posting in
its commercial life* (was it awarded?) and *is it crewed right now*. Those can disagree the moment a
driver is pulled off an awarded dispatch.

**Recommendation, smallest first:**

1. **Do not overload `planningState`.** Return the precise staffing truth from `dispatch.listRoles`
   as `assessStaffing`'s own `{ state, filled, requiredTotal, unfilledRoles }`, which already exists
   and already distinguishes `unstaffed`. The screen shows "0 of 3 required roles filled"; nothing
   has to lie.
2. **Clamp the backward transition** to `partially_staffed`, the only legal one, and treat it as a
   coarse lifecycle marker rather than a staffing readout.
3. **Do not** redesign commercial award history to fix this. If the imprecision proves operationally
   costly, the correct fix is a separate `staffingState` column beside `planningState` — one field
   per question — and that is a follow-up with its own owner decision, not part of this work.

The implementation plan carries this as an explicit checkpoint-F note so it cannot be lost.

---

## 9. Cardinality and uniqueness

**Settled by evidence, not an owner decision.** The model is (B): many concurrent operators and
units per job, uniform across work types — stated in `drizzle/schema.ts:1864-1865`, in
`_core/dispatchLifecycle.ts:185-188` ("No special-casing by job type"), in
`LEASEOS_B14_DISPATCH.md:158`, in `todo.md:32,57`, and shown in the shipped showcase UI.

**Uniqueness is around the slot, never the job.**

| Rule | Where enforced |
|---|---|
| One binding per role | structural — a role row *is* the binding |
| A role may be filled only once at a time | `FOR UPDATE` + `expectedLastEventId` |
| **One operator may hold at most one active role per posting** (OD-1) | transactional check under the posting lock |
| **One unit may hold at most one active role per posting** (OD-1) | transactional check under the posting lock |
| A resource may not be double-booked across **overlapping postings** | already exists: `_core/dispatchTransaction.ts:182-206` |
| Two roles on the *same* posting hold **different** resources | OD-1; the pre-existing `if (o.postingId === input.postingId) continue` (`:199`) skips same-posting *booking* overlap, so this rule is new and lives in the assignment path |

Worked example — Job 812:

| Role | `roleCode` | Operator | Unit | Status |
|---|---|---|---|---|
| 1 | `VAC_TRUCK` | Driver A | Truck 21 | `assigned` |
| 2 | `VAC_TRUCK` | Driver B | Truck 34 | `assigned` |
| 3 | `WATER_TRUCK` | Driver C | Truck 52 | `assigned` |
| 4 | `VAC_TRUCK` | — | — | `open` |

→ `assessStaffing` reports 3 of 4 required filled → posting is `partially_staffed`.

Fill role 4 → `staffed`. Reassign role 2 from Truck 34 to Truck 77 → roles 1, 3 and 4 are untouched,
posting stays `staffed`, one `assignment_reassigned` event is written naming Truck 34 → Truck 77.

**Duplicate vs legitimate multi-unit — three distinct shapes, three distinct answers:**

| Shape | Answer | Mechanism |
|---|---|---|
| Three trucks, three drivers, three roles on job 812 | **allowed** — this is the whole point | nothing refuses it |
| The same role submitted twice (double-click, retry) | **refused** | `expectedLastEventId` — the second carries a token the first invalidated |
| Driver A on role 1 *and* role 2 of the same posting | **refused** (OD-1) | the transactional check under the posting lock |

OD-1's reasoning: one operator in two active slots is far more often an accidental duplicate, or a
false statement of simultaneous operational capacity, than a real assignment. A person cannot drive
two trucks at once, and a posting that claims they can will mis-staff.

**Sequential use is not affected.** Driver A on role 1, later unassigned, later assigned to role 2 is
two events in history and one active binding at a time. OD-1 constrains *simultaneous* occupancy only.

**If one resource must legitimately satisfy several roles at once** — one driver with two trailers
across a shift — that is a future explicit feature (linked roles, or a shareable role type) with its
own authorization and audit. It is **not** built now, and it must never arrive by relaxing this rule
silently.

---

## 10. Concurrency

LeaseOS has **one** mature mechanism — `SELECT … FOR UPDATE` inside a transaction, re-checking after
the lock (17 call sites across 6 production files) — and **no** optimistic-versioning convention at
all. It also has a second, subtler idea used twice independently: a **dependency fingerprint**
compared at commit (`_core/dispatchAward.ts:27-50, 100-110`).

**Recommendation: row lock + `expectedLastEventId`.**

```
A reads role 44, lastEventId = 812
B reads role 44, lastEventId = 812
A: setRoleAssignment(44, …, expectedLastEventId: 812) → ok, writes event 813
B: setRoleAssignment(44, …, expectedLastEventId: 812) → CONFLICT
   "Role 44 changed since you loaded it — reload and try again."
```

`expectedLastEventId` is a version number that already had to exist: it is the head of the slot's
own history, needs no new column, and is monotonic per role.

**What must NOT be used as the token: `checkId`.** It is tempting — the award already uses it that
way, and it answers a richer question. But accepting an `eligibilityCheckId` on an assignment
mutation is precisely the coupling this whole design exists to break, and the column it names is the
one both award routes write. Assignment does not get to hold an eligibility token. §11 makes that
structural.

`expectedLastEventId: null` means "I expect this slot to have no history", which makes a first
assignment safe against a concurrent first assignment.

---

## 11. Award separation — the structural invariant

> **A dispatch assignment mutation writes `dispatchRoles`, `dispatchPostings.planningState` and
> `dispatchRoleAssignmentEvents`. It writes nothing else. It reads no eligibility check.**

Concretely, the assignment API must never:

| Forbidden | Because |
|---|---|
| accept `eligibilityCheckId` in its input | that is the award credential |
| write `dispatchEligibilityChecks.usedForAward` | the only column both award routes share |
| INSERT `resourceBookings` | the only resource reservation, and irreversible — nothing releases one |
| write `dispatchBids.status` / `dispatchInvitations.status` | would retroactively make a bid look selected |
| INSERT `dispatchAuditEvents` | `assignment_approved` doubles as the award's idempotency record |

The last one is why history goes in a **new** table rather than in `dispatchAuditEvents`: that table's
entire production vocabulary is `assignment_approved` and `assignment_blocked`
(`_core/dispatchTransaction.ts:245, 353`), and `assignment_approved` *is* the replay key
(`:109-116`). Writing assignment history there would make an assignment indistinguishable from an
award to the award's own replay check.

`planningState` is the one shared write, and it is safe because it is *derived*: both paths compute
it from the same `assessStaffing` over the same roles. A posting becoming `partially_staffed`
because a slot was filled is not an award; `staffed` is a precondition the award may later read,
never a substitute for it.

**How this is tested, not just asserted:** §17.

---

## 12. Readiness relationship

Today `composeReadiness` takes the subject as a parameter and reads no assignment table
(`server/readinessComposer.ts:54-56`). That stays true. The change is only in *who supplies the
subject*:

```
before:  client → jobUnits.list → filter by jobId → [0] → subject → dispatch.readiness
after:   client → dispatch.listRoles(jobId) → role.binding → subject → dispatch.readiness
```

`EligibilityFacts` already carries `operatorId`, `unitId` and `trailerId`
(`_core/dispatchAward.ts:27-50`), so a binding change moves `computeEligibilityFingerprint` and
`assessEligibilityValidity` reports `invalidatedBy: "dependency_change"` (`:100-110`). PR #6's
`F1`/`F2` prove the composer actually carries the subject into the facts.

**No invalidation marker is needed or wanted.** The fingerprint mismatch already makes a stale check
unusable at the award, and adding a `readinessInvalidatedAt` column would be a second source of
truth about staleness that could disagree with the hash.

Per-role readiness is the natural next step (`dispatch.readiness({ roleId })` resolving the subject
server-side), but it is **not** required by this design and is not proposed here.

---

## 13. Trailer and equipment

**Correction to an earlier finding of mine.** I previously reported that trailer assignment "does
not exist". That conflated two things, and the right distinction is:

- **Schema support exists.** `dispatchRoles.assignedTrailerId`, `dispatchBids.proposedTrailerId`,
  `dispatchRoles.requiredTrailerClass`, `dispatchEligibilityChecks.trailerId`,
  `EligibilityFacts.trailerId` / `trailerStatusVersion`, `enforcementEvents.trailerId`,
  `manifests.trailerUnitId`, and `complianceDocuments.ownerType = 'trailer'`.
- **A reachable mutation does not.** The one writer of `assignedTrailerId` sits behind a posting
  nothing can create.

So: **include trailer binding now.** It costs one more nullable int on a mutation that is already
taking two, and readiness already fingerprints it.

**What is weak, and must be said on screen rather than papered over:** there is no `trailers` table.
A trailer is a `units` row, and `units.vehicleType` is unconstrained `varchar(120)` that **zero**
production lines compare against anything. Nothing can refuse a truck's id passed as `trailerId`.
The mutation must still run `unitInScope` on it — that is the `manifestCustody.bind` precedent
(`server/manifestCustodyRouter.ts:90-93`), which validates `trailerUnitId` as `recordType: "unit"`.

Deferred, explicitly: a trailer inventory subsystem, a `vehicleType` enum, and any rule that
`requiredTrailerClass` is actually satisfied by the bound trailer. The extension point is clean —
`requiredTrailerClass` is already on the slot, waiting for a classifier that can read it.

---

## 14. `jobUnits` — what it is and what becomes of it

**Classification: a participation and worklog record, retrofitted into a direct-award artifact.**
Not an assignment table, and never was: `hours`, `mileage` and `workPerformed` are what you record
after the work, and the row is written once and never updated.

**Future: (B) retained as compatibility and historical data, not retired.**

- `jobUnits.list` is load-bearing *today* for `/dispatch/:jobId` (PR #6) and the readiness panel
  (PR #5). It must keep working until `dispatch.listRoles` replaces those two call sites.
- `loadUngatedAssignments` (`dispatchEnforcementService.ts:67-76`) is the only production JOIN on the
  table and feeds the exception centre — an audit record of assignments made without a check. That
  record must not be destroyed.
- No row is ever deleted or rewritten. Historical jobs keep their crew rows exactly as they are.

**`jobUnits.create` — deprecate in place, in three steps of rising cost:**

1. **Now, zero risk.** Delete its only production caller — `client/src/showcase/FleetWorkspace.tsx:443,569`
   — and the dead `createJobUnit` at `server/db.ts:683-687` with its unused import at
   `routers.ts:132`. That call already cannot fire: the showcase tRPC link refuses every mutation
   before it leaves the browser (`client/src/lib/showcaseGuard.ts:17-29`). After this the procedure
   has **zero** production callers.
2. **Then, no code change.** Re-document it in place as the legacy direct-award path and let the
   enforcement ladder be the lever: under `enforced` it already refuses without a valid check.
3. **Eventually.** Once `dispatch.listRoles` has replaced the two `jobUnits.list` call sites and the
   exception centre reads role events instead, unmount `.create`. Not before — unmounting costs four
   test files, two pinned counts (`crossLayerIntegrity.test.ts:39`, pinned at 690 on `main` and 691 with PR #4;
   `operationalApiAuthorization.test.ts:332`) and two bidirectional inventory invariants, and
   buys nothing while the procedure has no callers.

**Guard against repeating the mistake — a test, not a comment.** `clientTruth.test.ts` already scans
every production client file with a regex and asserts a list is empty; that is the mechanism to
copy:

```ts
it("no production client calls jobUnits.create — assignment goes through dispatch.setRoleAssignment", () => {
  const offenders = walk("client/src")
    .filter(f => !f.startsWith("client/src/showcase/"))
    .filter(f => /trpc\.fieldRoute\.identity\.jobUnits\.create/.test(readFileSync(f, "utf8")));
  expect(offenders, "jobUnits.create is the legacy direct-award path; it is not the assignment API").toEqual([]);
});
```

A rename of the internal helper (`createJobUnitGated` → `awardDirectJobAssignmentLegacy`) is worth
doing at step 2 so the name matches what it does.

---

## 15. Migration requirements

Schema changes required, in **two** migrations, all additive. `main` ends at `0168` and PR #4 takes
`0169`, so these are `0170` and `0171`:

**`0170_dispatch_role_types.sql`**
1. `CREATE TABLE dispatchRoleTypes (…)` per §5.2, with the `roleTypeKey` PERSISTENT generated column
   and `UNIQUE INDEX dispatchRoleTypes_roleTypeKey_unique (roleTypeKey)`. **Not** a nullable
   composite unique — see §5.2 for why that would not protect global rows.
2. `ALTER TABLE dispatchRoles ADD COLUMN required boolean NOT NULL DEFAULT true` — expresses the
   optional-role semantics `assessStaffing` already implements.
3. Seed the eight evidenced global role types (`orgRef` NULL).

**`0171_dispatch_role_assignment_events.sql`**
4. `CREATE TABLE dispatchRoleAssignmentEvents (…)` per §5.3, with indexes `(roleId, id)` and
   `(jobId, occurredAt)`.

No `UNIQUE` index expresses OD-1: MariaDB has no filtered unique index, so "unique among rows whose
status is assigned" cannot be a constraint. It is enforced transactionally under the posting lock
(§8).

**No destructive change.** No column is dropped, no row is rewritten, no historical lifecycle state
is manufactured. `DEFAULT true` on `required` is the value `dispatchTransaction.ts:328` already
hardcodes, so existing behaviour is preserved exactly.

**Existing `jobUnits` rows are left alone.** They are not migrated into roles, because doing so would
require inventing a `roleCode` and a slot identity that the rows never had, and would assert that a
worklog entry was a dispatch decision. Duplicates stay as they are — they are historical truth about
what was recorded, and deduplicating them would destroy evidence the exception centre reports on.

**Backfill: none.** There are zero `dispatchPostings` and zero `dispatchRoles` rows in production, so
there is nothing to backfill into.

**Not recommended:** adding `dispatchRoles.jobId` so roles can exist without a posting. It would fork
the model — two ways to reach a role, two ways to compute staffing — to save creating one posting row
per job. The `direct_assignment` distribution and the `direct` planning state exist precisely so that
a direct job is still a posting. Listed in §19 only because it is a defensible alternative if posting
creation proves heavier than expected.

---

## 16. UI implications

Not implemented here. What the API would unlock in PR #6's screen:

| Section | Today | With this API |
|---|---|---|
| Assignment list | `jobUnits.list`, tenant-wide, capped at 100, job-blind | `dispatch.listRoles({ jobId })` — job-filtered, complete, with requirement and status per slot |
| Assign | absent, with a note explaining why | per-slot control on an `open` role |
| Change | absent | per-slot, carrying `expectedLastEventId` |
| Unassign | absent | per-slot, reason required |
| Multi-unit | rows rendered, no slot identity | slots with `roleLabel`, including unfilled ones |
| History | absent | `includeHistory` — who changed what, when, and why |

**Three visibly different states, never merged:**

| State | Source | Meaning |
|---|---|---|
| **Assigned** | `dispatchRoles.status` | somebody is expected to do this work |
| **Ready** | `dispatch.readiness` verdict | that pairing is fit and lawful *right now* |
| **Awarded** | `dispatchPostings.planningState` ≥ `staffed` + the award's own record | authorised to proceed |

A slot can be assigned and not ready. It can be assigned and ready and not awarded. The screen must
never let a green assignment badge read as either of the other two — which is the same rule PR #5's
presentation module already enforces for readiness, and it is why `isReady()` is one line there.

---

## 17. Test strategy

Written before implementation, as RED. Database-backed tests call production tRPC procedures.

**Assignment behaviour**
1. assign an open role → role bound, status `assigned`, one `assignment_created` event
2. three roles on one job, three different units/operators → all succeed, posting `partially_staffed`
3. fill the last required role → posting `staffed`
4. reassign role 2 → roles 1, 3, 4 untouched; one `assignment_reassigned` event naming from → to
5. unassign → status `open`, binding null, `assignment_unassigned` event, reason persisted
6. unassign without a reason → refused
7. optional role left open → posting still `staffed`

**OD-1 — duplicate occupancy**
7a. the same operator on a second active role of the same posting → `CONFLICT`, first binding intact
7b. the same unit on a second active role of the same posting → `CONFLICT`, first binding intact
7c. the same operator on a role of a *different* posting → allowed
7d. operator unassigned from role 1, then assigned to role 2 → allowed (sequential ≠ simultaneous)

**OD-2 — staffing derivation**
7e. unassign one of three filled required roles → posting leaves `staffed`, `assessStaffing` reports
    2 of 3, posting is `partially_staffed`
7f. unassign every required role → posting never reads `staffed`, never transitions to `awarding`,
    and `assessStaffing().state` is `unstaffed`
7g. an already-awarded posting that loses a role keeps every `dispatchAuditEvents` row it had
7h. after that loss, the prior eligibility check reports `invalidatedBy: "dependency_change"`

**OD-3 — role catalog**
7i. a `roleCode` absent from the catalog → refused
7j. a deactivated role type cannot be used for a new role, and existing roles carrying it still read
7k. a tenant-scoped role type resolves ahead of a global one with the same code, and is invisible to
    another tenant

**Identity and concurrency**
8. stale `expectedLastEventId` → `CONFLICT`, and the first writer's binding survives unchanged
9. two concurrent `setRoleAssignment` on one role → exactly one wins (the `dispatchConcurrency.test.ts`
   pattern: fire four, assert one)
10. `expectedLastEventId: null` against a role that already has history → `CONFLICT`

**Authorization and tenancy**
11. a role holding `dispatch.read` but not `dispatch.assign` → refused
12. a job in another organization → `NOT_FOUND`
13. a unit in another organization → `NOT_FOUND`
14. an operator in another organization → `NOT_FOUND`
15. a nonexistent unit / operator / role → `NOT_FOUND`

**Award separation — the invariants that matter most**
16. after `setRoleAssignment`, `dispatchEligibilityChecks.usedForAward` is unchanged for every check
17. after `setRoleAssignment`, **no** `dispatchAuditEvents` row exists for that posting
18. after `setRoleAssignment`, **no** `resourceBookings` row exists
19. after `setRoleAssignment`, `dispatchBids` and `dispatchInvitations` statuses are unchanged
20. the input schema rejects an `eligibilityCheckId` key outright
21. assignment does not make `dispatch.award` succeed — a blocked check still refuses
22. `dispatch.award` on a posting still works end to end after roles were filled by the new API
23. the legacy direct path still works, unchanged, for historical compatibility

**Readiness**
24. changing a role's operator moves `computeEligibilityFingerprint` and a prior check reports
    `invalidatedBy: "dependency_change"` (extends PR #6's `F1`/`F2` to the role path)
25. the assignment mutation returns no readiness verdict of any kind

**Structural**
26. no production client file calls `jobUnits.create` (§14)

**Mutation checks on the safety boundaries** — plant each, confirm the named test fails, restore
byte-for-byte:
- write `usedForAward` in the assignment path → 16 fails
- emit a `dispatchAuditEvents` row → 17 fails
- insert a `resourceBookings` row → 18 fails
- drop the `expectedLastEventId` check → 8 and 9 fail
- drop `unitInScope` → 13 fails
- hardcode `required: true` again → 7 fails
- drop the same-posting operator check → 7a fails
- drop the same-posting unit check → 7b fails
- take the role lock without the posting lock → 7a/7b become racy under the concurrency harness
- recompute staffing only on assign, not on clear → 7e and 7f fail
- accept any `roleCode` string → 7i fails

---

## 18. Owner decisions — resolved

All three questions this design raised have been answered by the owner. They are recorded here in
full because the reasoning, not just the ruling, constrains the implementation.

### OD-1 — a resource may not occupy two active roles on one posting

The same `operatorId` may not hold two active roles on the same posting; nor may the same `unitId`;
exact duplicate bindings are refused. Different operators and units on different roles remain
normal.

*Reason:* that shape is far more likely to be an accidental duplicate, or a false statement of
simultaneous operational capacity, than a real assignment.

*Not solved by relaxing this later.* If one resource must legitimately satisfy several roles at
once, that is an explicit future feature — linked roles, shareable role types, explicit multi-role
authorization — with its own validation and audit. Sequential use is already expressed by assignment
history and is unaffected. Incorporated in §8, §9.

### OD-2 — losing a required role ends staffed status immediately

Staffing is derived from current required-slot occupancy. All required filled → `staffed`; some →
`partially_staffed`; none → the existing pre-staffed vocabulary. Never `awarding`, which is not a
substitute for missing resources. Award history is never erased; previous authority becomes stale
through the existing fingerprint mechanism and must be re-evaluated. Where one `planningState` field
cannot carry both award history and current staffing truth, that is named rather than hidden.
Incorporated in §8.1.

### OD-3 — `roleCode` is a controlled, extensible catalog

Neither free text nor a permanently closed enum. A `dispatchRoleTypes` catalog with stable machine
code, display name, active flag, optional description and optional default equipment/trailer
classes, carrying house provenance columns, extensible by row rather than by migration, with
`dispatchRoles.roleCode` validated against it. Seeded only with roles the repository evidences.
Tenant-specific types are supported by a nullable `orgRef`, which the 0132 convention makes
straightforward and safely scoped. Incorporated in §5.2.

## 19. Remaining blockers

**None that block implementation.**

Two items are carried forward as *named follow-ups*, neither of which gates this work:

1. **Asset typing for trailers.** `units.vehicleType` is free text no production line reads, so the
   server cannot prove a given id is a trailer rather than a truck (§13). The assignment model is
   not weakened to accommodate this — trailer binding ships, and the screen states the limitation.
   Stronger asset typing is a separate prerequisite if and when it is wanted.
2. **`planningState` carrying two questions.** Named in §8.1 with the smallest-first recommendation.
   A separate `staffingState` column is the correct fix if the imprecision proves costly; it is not
   part of this work.
