# Dispatch Assignment — implementation plan

**Companion to** `DISPATCH_ASSIGNMENT_MODEL_DESIGN.md` (approved, with owner decisions OD-1/2/3).

**Status:** plan only. No production code is written until this plan is approved.

**Method, throughout, without exception:** RED tests first · minimal production change · mutation
checks that prove each test is not vacuous, with every file restored byte-for-byte and verified by
digest · full `scripts/ci-gate.sh` against a disposable MariaDB before any push · `LEASEOS_CURRENT_STATE.md`
regenerated only through `scripts/current-state.sh` when gate 8 asks.

---

## 0. Git and PR topology

### The recommendation

```
main ──┬── #4 readiness-defect-repair ── #5 readiness-panel ── #6 dispatch-detail
       │                                      │                      │
       │                                      └──────────┬───────────┘
       │                                                 │
       └── feature/dispatch-assignment-backend ──────────┴── feature/dispatch-assignment-ui
           (A–H, server only, from #5's head)                 (I, from #6 + backend)
```

**Cut the backend branch from PR #5's head (`8bb6002`), not from `main` and not from PR #6.**

Three reasons, all mechanical:

1. **Migration numbering.** `main` ends at `0168`; PR #4 adds `0169`. Branching from #5 means `0170`
   and `0171` follow with no gap and no collision, whenever #4 lands.
2. **No conflict in `dispatchRouter.ts`.** PR #5 already modified that file (the capability
   exposure). The backend adds procedures to the same router; branching from #5 means the change is
   already present rather than arriving as a conflicting hunk.
3. **PR #6 is client-only** apart from test files, so the backend does not need it and must not wait
   for it.

The backend PR is then **independently reviewable and independently mergeable** — server, schema and
tests, no UI. That is the property worth protecting: schema and domain work should not be reviewed
through a diff that also moves a screen.

### Why not stack the backend on PR #6

Because a reviewer of a schema change would have to read a UI diff to reach it, and because the UI
activation (checkpoint I) genuinely depends on *both* the backend and PR #6 — which is a merge, not
a stack. Keeping them separate makes that dependency explicit instead of implied by branch order.

### Merge order

`#4 → #5 → #6`, and `backend` any time after `#4` (it only needs the migration number). Checkpoint I
last, after both `#6` and `backend` have landed.

---

## Checkpoint A — role type catalog

**Depends on:** nothing beyond the branch point.

| | |
|---|---|
| **Migration** | `drizzle/0170_dispatch_role_types.sql` — `CREATE TABLE dispatchRoleTypes`, the `roleTypeKey` PERSISTENT generated column + its UNIQUE index, `ALTER TABLE dispatchRoles ADD COLUMN required boolean NOT NULL DEFAULT true`, seed 8 global rows |
| **Schema** | `drizzle/schema.ts` — `dispatchRoleTypes` table, `required` on `dispatchRoles` |
| **Core** | `server/_core/dispatchRoleCatalog.ts` — `resolveRoleType(code, orgRef, rows)`: tenant row first, then global, `active` only; pure, no database |
| **Tests** | `server/_core/dispatchRoleCatalog.test.ts` (pure) · `server/dispatchRoleCatalog.db.test.ts` (below) |

**Correction 1 — uniqueness is DB-enforced through a generated key, not a nullable tuple.**
`UNIQUE(orgRef, roleCode)` does not protect global rows: MariaDB permits unlimited NULLs in a unique
index, proven by execution (three global `LEAD` rows coexisted). The repository already solved this
in `drizzle/0021_active_role_uniqueness.sql` with a PERSISTENT generated collision key using
`COALESCE(scopeRef, '*')`; this follows it exactly:

```sql
roleTypeKey varchar(140) AS (CONCAT(COALESCE(orgRef, '*'), ':', roleCode)) PERSISTENT
UNIQUE INDEX dispatchRoleTypes_roleTypeKey_unique (roleTypeKey)
```

**Six DB tests, RED before the migration exists** — each asserting the *database* refuses, not the
application:
1. global `LEAD` + global `LEAD` → refused
2. `ORG-A` `LEAD` + `ORG-A` `LEAD` → refused
3. `ORG-A` `LEAD` + `ORG-B` `LEAD` → allowed
4. global `LEAD` + `ORG-A` `LEAD` → allowed
5. tenant lookup resolves `ORG-A`'s row before the global one
6. global fallback resolves when the tenant has no override

**Correction 1b — the catalog must NOT be read with `orgScopeWhere`.** `orgRef IS NULL` means "the
historical single tenant" in this repo, not "global", and `orgScopeWhere` for a real tenant emits
`eq(orgRef, tenantId)`, excluding NULL rows. Using the house helper would show an `ORG-A` member an
empty catalog. The catalog read is `orgRef IS NULL OR orgRef = :tenantId`, with tenant-first
resolution. **Test 7:** a member of `ORG-A` sees all eight seeded global types.

**Correction 1c — catalog defaults are snapshots, not live pointers.**
**Test 8:** create a role from a type, then edit the type's `defaultEquipmentClass`; the existing
role's `requiredEquipmentClass` is unchanged.
**Test 9:** deactivating a type refuses *new* role creation and leaves existing roles readable and
assignable.

**Seed (evidenced only):** `LEAD`, `WINCH_TRACTOR`, `BED_TRUCK`, `PICKER`, `PILOT_VEHICLE` from
`drizzle/schema.ts:1864-1865`; `PRIMARY_UNIT`, `SUPPORT_UNIT`, `STANDBY` from
`client/src/showcase/FleetWorkspace.tsx:551,556,561`. Nothing invented.

**RED first:** the pure resolver tests, then the db tests, all failing on a missing module and a
missing table.

**Mutation checks:** resolve ignoring `active` → 9 fails · resolve global before tenant → 5 fails ·
replace the generated key with `UNIQUE(orgRef, roleCode)` → 1 fails while 2 still passes, which is
the precise shape of the original bug · read the catalog with `orgScopeWhere` → 7 fails · read the
type's defaults live instead of snapshotting → 8 fails.

**Verification:** `pnpm exec tsc --noEmit`, gate 3 table parity (408 → 409), targeted suites.

**Commit boundary:** catalog exists and is queryable. Nothing uses it yet.

---

## Checkpoint B — immutable assignment events

**Depends on:** A (shares the branch, not the table).

| | |
|---|---|
| **Migration** | `drizzle/0171_dispatch_role_assignment_events.sql` — `CREATE TABLE dispatchRoleAssignmentEvents`, indexes `(roleId, id)` and `(jobId, occurredAt)` |
| **Schema** | `drizzle/schema.ts` — the table |
| **Core** | `server/_core/dispatchAssignmentEvents.ts` — `describeTransition(from, to)` returning the `eventType`, and `headEventId(rows)`; pure |
| **Tests** | `server/_core/dispatchAssignmentEvents.test.ts` — open→bound is `assignment_created`, bound→bound is `assignment_reassigned`, bound→null is `assignment_unassigned`, null→null refused |

**Mutation checks:** collapse `assignment_reassigned` into `assignment_created` → the transition test
fails · return the lowest id as head → the head test fails.

**Commit boundary:** the event vocabulary exists and is proven. Nothing writes one yet.

---

## Checkpoint C — the creation door, and the read

**Depends on:** A, B. **Correction 2: this checkpoint exists because without it the whole design is
unreachable.**

The survey found **zero production INSERT paths** for `dispatchPostings` and `dispatchRoles`. An
assignment system that can only fill slots created by test fixtures is not operational. The design
named `createPosting` and `addRole` as missing doors and the first plan draft dropped them; they are
restored here, before any assignment mutation work.

| | |
|---|---|
| **Files** | `server/dispatchRouter.ts` (+3 procedures), `server/dispatchPostingService.ts` (new), `server/_core/recordsAuthorization.ts` (+3 mappings) |

### `dispatch.createPosting` — permission `dispatch.assign`

Input `{ jobId, distribution?, roles?: [{ roleCode, roleLabel?, required?, requiredEquipmentClass?, requiredTrailerClass? }] }`.
`distribution` defaults to `direct_assignment`; `planningState` starts at `direct` for that
distribution and `planning` otherwise — both existing enum values
(`drizzle/schema.ts:1804`, `_core/dispatchLifecycle.ts:26`).

Guards `jobInScope`. Mints a `postingNumber`. Optionally creates roles in the same transaction, so
the common case — "this job needs three vac trucks" — is one call.

**Does not** award, evaluate readiness, create a booking, or touch an eligibility check. Creating a
posting is an act of planning.

### `dispatch.addRole` — permission `dispatch.assign`

Input `{ postingId, roleCode, roleLabel?, required?, requiredEquipmentClass?, requiredTrailerClass? }`.

Resolves `roleCode` through the catalog (tenant-first, active only), **snapshots** the type's
`defaultEquipmentClass` / `defaultTrailerClass` into the role's requirement fields unless explicitly
overridden, sets `required` (default `true`), and creates the slot at `status: "open"` with a null
binding. Never assigns implicitly.

### `dispatch.listRoles` — permission `dispatch.read`

Input `{ jobId }` or `{ postingId }`, `includeHistory?`. Returns each slot's binding, status,
requirement, resolved `displayName` and `lastEventId`, plus the **precise** staffing picture from
`assessStaffing`: `{ state, filled, requiredTotal, unfilledRoles }` and the optional roles
separately.

**The persisted `planningState` is not the staffing answer.** It cannot express zero-of-N (design
§8.1). The API's `assessStaffing` result is authoritative for presentation, and the response carries
both so a reader can see the coarse lifecycle value *and* the precise truth without either being
mistaken for the other.

**RED tests** (`server/dispatchPostingCreate.db.test.ts`, `server/dispatchRoleRead.db.test.ts`):
- posting created for an in-scope job; cross-tenant job → `NOT_FOUND`; `dispatch.assign` required
- `direct_assignment` posting lands on a legal `planningState`
- creating a posting writes no booking, no audit event, no eligibility check
- role created `open` with a null binding; unknown `roleCode` → refused; inactive type → refused
- requirement defaults snapshotted from the type, and an explicit override wins
- `listRoles` is job-filtered; cross-tenant → `NOT_FOUND`; `dispatch.read` required
- staffing counts: **0 of 3**, 1 of 3, 3 of 3, and an optional slot left unfilled after all required
  are filled → still `staffed`

**Mutation checks:** drop `jobInScope` on create → the cross-tenant test fails · create the role
`assigned` rather than `open` → the open-slot test fails · read the type's defaults live → the
snapshot test fails · report `planningState` as the staffing answer → the 0-of-3 test fails.

**Note:** `crossLayerIntegrity.test.ts:39` pins the procedure count; each checkpoint adding
procedures updates the pin in the same commit, in the house comment style.

**Commit boundary:** production can now create and read the canonical model. Nothing can be assigned.

## Checkpoint D — `dispatch.setRoleAssignment`

**Depends on:** A, B, C. **The core of the work, and it stays one checkpoint.**

OD-1's duplicate-resource protections apply to the *first* assignment exactly as much as to a
reassignment — a dispatcher filling role 2 with the driver already on role 1 is the same error
whether role 2 was open or occupied. Splitting initial assignment from reassignment would ship the
first without the invariant that makes it safe. Small RED/GREEN commits inside the checkpoint are
fine; the contract is not complete until both paths satisfy every invariant.

| | |
|---|---|
| **Files** | `server/dispatchRouter.ts`, `server/dispatchAssignmentService.ts` (new — the transaction), `server/_core/recordsAuthorization.ts` (→ `dispatch.assign`) |
| **Input** | `{ roleId, operatorId, unitId, trailerId?, expectedLastEventId, reason? }` — **no `eligibilityCheckId` key exists in the schema** |
| **Transaction** | exactly the eleven steps in design §8, posting lock first |

**RED tests** (`server/dispatchAssignment.db.test.ts`), in the design's §17 numbering:
1–4 · 7a–7d (OD-1) · 7i–7k (OD-3) · 8–10 (concurrency) · 11–15 (authorization and tenancy) ·
**16–21 (award separation)** · 24–25 (readiness).

**Mutation checks — the ones that matter most:**

| Planted | Must fail |
|---|---|
| write `usedForAward` | 16 |
| insert a `dispatchAuditEvents` row | 17 |
| insert a `resourceBookings` row | 18 |
| drop the `expectedLastEventId` check | 8, 9 |
| drop the same-posting operator check | 7a |
| drop the same-posting unit check | 7b |
| take the role lock without the posting lock | 7a/7b race under the concurrency harness |
| drop `unitInScope` on `trailerId` | 13 |
| accept any `roleCode` | 7i |

**Commit boundary:** assignment and reassignment work, provably without award semantics.

---

## Checkpoint E — `dispatch.clearRoleAssignment`

**Depends on:** D.

| | |
|---|---|
| **Files** | `server/dispatchRouter.ts`, `server/dispatchAssignmentService.ts` |
| **Input** | `{ roleId, expectedLastEventId, reason }` — reason **required**, unlike D |
| **Tests** | 5, 6, 7e (appended to D's suite): status → `open`, binding null, event written, reason persisted, reason absent → refused, award history untouched |

**Mutation checks:** make `reason` optional → 6 fails · clear the binding without writing an event →
5 fails · skip the staffing recomputation → 7e fails.

**Commit boundary:** the full lifecycle is reachable.

---

## Checkpoint F — staffing integration, and the named limitation

**Depends on:** D, E.

| | |
|---|---|
| **Files** | `server/dispatchAssignmentService.ts` (recompute + `canTransitionPosting`), `server/_core/dispatchLifecycle.ts` (read-only; `assessStaffing` now receives real `required` values instead of the hardcoded `true` at `dispatchTransaction.ts:328`) |
| **Tests** | 7, 7e, 7f, 7g, 7h |

**Carry the design §8.1 limitation into code as a comment, not a silent clamp.** `assessStaffing`
has `unstaffed`; `PostingState` does not, and from `staffed` the only legal backward transition is
`partially_staffed`. The service clamps to the legal transition **and** returns the precise
`assessStaffing` result, so the screen can show "0 of 3 required roles filled" while `planningState`
stays inside its state machine. A separate `staffingState` column is the follow-up if this proves
costly; it is not built here.

**Mutation checks:** recompute on assign only → 7e/7f fail · allow a transition to `awarding` → 7f
fails · treat every role as required → 7 fails.

**Commit boundary:** staffing is honest.

---

## Checkpoint G — readiness subject from the role binding

**Depends on:** D. **Server-side portion only** — the client half is checkpoint I.

| | |
|---|---|
| **Files** | none in `readinessComposer.ts` — the subject stays a caller parameter (design §12) |
| **Tests** | `server/dispatchAssignment.db.test.ts` 24: changing a role's operator moves `computeEligibilityFingerprint` and a prior check reports `invalidatedBy: "dependency_change"` — the role-path extension of PR #6's `F1`/`F2` |

**There is deliberately no production change here.** The fingerprint already does this work; the only
thing that needed proving is that the role binding reaches it. If this checkpoint requires a
production change, something in D was wrong.

**Commit boundary:** may fold into D. Kept separate in the plan so the invariant is not assumed.

---

## Checkpoint H — the legacy guard

**Depends on:** nothing. Can land first if convenient.

| | |
|---|---|
| **Files** | delete `client/src/showcase/FleetWorkspace.tsx:443,569` (its only production caller, already unreachable behind `showcaseGuard.ts:17-29`) · delete the dead `createJobUnit` at `server/db.ts:683-687` and its unused import at `server/routers.ts:132` · rename `createJobUnitGated` → `awardDirectJobAssignmentLegacy` · new test |
| **Test** | design §14's structural guard, built like `clientTruth.test.ts`: no production client file references `trpc.fieldRoute.identity.jobUnits.create` |

**Not done here:** unmounting `jobUnits.create`. It costs four test files, two pinned counts and two
inventory invariants, and buys nothing while it has zero callers. **No `jobUnits` row is touched.**

**Mutation check:** add a `jobUnits.create` call to a production client file → the guard fails.

**Commit boundary:** the mistake cannot be repeated silently.

---

## Checkpoint I — PR #6 UI activation · **OUT OF SCOPE for this branch**

**Not implemented here.** Recorded so the shape is agreed, and built later on a separate branch
combining the backend with PR #6. Nothing in checkpoints A–H depends on it.

**Depends on:** the backend branch **and** PR #6, both merged. Separate branch:
`feature/dispatch-assignment-ui`.

| | |
|---|---|
| **Files** | `client/src/dispatch/DispatchJobDetailView.tsx` + its `.dom.test.tsx` · `client/src/dispatch/DispatchJobDetail.tsx` · `client/src/a11y/a11y.dom.test.tsx` |
| **Change** | replace the `jobUnits.list` read with `dispatch.listRoles({ jobId })`; replace the read-only note with Assign / Change / Unassign per slot; show unfilled slots; show history |
| **Readiness** | the subject comes from the role binding, not from `jobUnits.list[0]` — this removes the hundred-row job-blind window PR #6 had to disclose |

**Three visibly distinct states**, per design §16: **Assigned** (`dispatchRoles.status`) · **Ready**
(the readiness verdict) · **Awarded** (posting state + award record). The existing presentation
module already enforces that readiness cannot be inferred; the assignment badge must not become a
fourth way to imply either of the others.

**Tests:** slot list with unfilled slots · assign from open · change with `expectedLastEventId` ·
stale token → the conflict is *shown*, not swallowed · unassign requires a reason · readiness
refetches after every mutation · a successful assignment never renders "Ready".

**Mutation checks:** skip readiness invalidation after assign → the refetch test fails · render a
conflict as success → the stale test fails · derive "ready" from a successful assignment → the
never-renders-Ready test fails.

---

## Cross-checkpoint verification

Every checkpoint, before its commit:

1. `pnpm exec tsc --noEmit` (the repo's pinned 5.9.3 — a worktree without a `node_modules` symlink
   silently resolves a different `tsc`; link it as the other worktrees do)
2. targeted suites, then the dispatch and readiness suites
3. `git diff --check`
4. full `scripts/ci-gate.sh` against a disposable database — gates 0–8, confirming no
   database-backed suite skipped
5. `crossLayerIntegrity.test.ts:39` pin updated in the same commit that adds a procedure
6. `LEASEOS_CURRENT_STATE.md` regenerated by `scripts/current-state.sh` only when gate 8 asks

**Table parity** (gate 3) moves 408 → 409 at A and 409 → 410 at B. Both are expected and both are
gate-checked.

---

## What this plan does not do

No award changes · no override request or grant · no bid or invitation creation · no Dispatcher
Board · no mechanic or HOS UI · no trailer inventory subsystem · no deletion or deduplication of any
`jobUnits` row · no redesign of commercial award history.
