# Dispatcher Board / K-1 Aggregate Query — Design

**Status:** design only. No production code in this branch.
**Baseline:** `0cd4817cca5ca7cfa66af8984bcf02b7268edbdb` (integrated `main`; gate PASS, parity 410/410).
**Branch:** `docs/dispatcher-board-design`.

---

## 1. Current-state survey

Traced against this baseline, not against planning documents.

### 1.1 What exists

| Area | Where | What it actually does |
|---|---|---|
| Jobs | `jobs` (`drizzle/schema.ts`) | `orgRef`, `jobCode`, `type`, `mode`, `customer`, `location`, `status`, `progress`, `eta`, lat/long. `vehicle`/`driver` are **free text**, not references. |
| Postings | `dispatchPostings` | `postingNumber` UNIQUE, **`jobId` NOT unique**, `distribution` (7 values), `planningState` (14 values), `planningBlocker`, `priority`, `scheduledStart`, `crewSize`. **No `orgRef` column.** |
| Slots | `dispatchRoles` | `roleCode`, `roleLabel`, `required`, `requiredEquipmentClass`/`TrailerClass`, `assignedOperatorId`/`UnitId`/`TrailerId`, `status` (`open`/`invited`/`bid_received`/`assigned`/`cancelled`). |
| Slot reads | `dispatch.listRoles` (`dispatch.read`) | Per job **or** per posting. Bounded: 50 postings, 500 roles, 2000 event rows, 200 history. Returns `postings[]`, `roles[]`, `staffing`, `history`. |
| Staffing | `assessStaffing` (`_core/dispatchLifecycle.ts`) | Counts **required** roles only → `state` (`unstaffed`/`partially_staffed`/`staffed`), `filled`, `requiredTotal`, `unfilledRoles[]`, `message`. |
| Readiness | `composeReadiness` (`server/readinessComposer.ts`) | Takes a **subject** (`operatorId`, `unitId`, `trailerId`, `jobId`). Returns `eligibility`, `facts`, `fingerprint`, `contributions`, `capabilities`, `capabilityVerdict`, `automationPolicy`, `ruleSetHash`. Pure read. |
| Capability contract | `_core/interEngineStatus.ts` | `InterEngineStatus = PASS \| REVIEW \| BLOCKED \| UNKNOWN \| NOT_EVALUATED`; `combineForConsumer(contract, results)`. |
| Stored checks | `dispatchEligibilityChecks` | **Has `postingId`, `roleId`, `orgRef`**, plus `verdict`, `blockersJson`, `fingerprint`, `capabilitiesJson`, `capabilityVerdict`, `ruleSetHash`, `evaluatedAt`, `usedForAward`. |
| Validity | `assessEligibilityValidity` (`_core/dispatchAward.ts`) | `{ valid, ageMinutes, requiresReEvaluation, invalidatedBy: "none"\|"age"\|"dependency_change", reason }`, default window **30 min**. |
| Widget board | `_core/boardSemantics.ts` | A **different** board (dashboard tiles, B28C). Prior art, not a data source. |
| Detail route | `/dispatch/:jobId` | `DispatchJobDetail` → `dispatch.listRoles({ jobId })` + `DispatchReadiness`. |

### 1.2 Four findings that change the design

**F1 — A job can have many postings; nothing prevents it.**
`dispatchPostings.jobId` carries no unique constraint (`0013_dispatch_operations.sql` uniquely constrains `postingNumber` only), and `createPosting` checks `jobInScope` then inserts with no per-job guard. Mixed `distribution` values, replacement postings and historical postings are all structurally permitted.

**F2 — `listRoles` already collapses multi-posting jobs, and that is a latent defect.**
For a job query it returns every posting in `postings[]` but sets the scalar `planningState: postings[0]?.planningState ?? null`. On a two-posting job the detail screen shows the *first* posting's lifecycle state beside roles drawn from *both*. This is pre-existing and out of scope to fix here, but the Board must not inherit it.

**F3 — Tenancy for postings is derived, never owned.**
`dispatchPostings` has no `orgRef`. Scope must be enforced by joining `jobs` and applying `orgScopeWhere(jobs, scope)`. `dispatchEligibilityChecks` *does* carry `orgRef`, so it can be scoped directly — and must be, independently, rather than trusted because its `postingId` matched.

**F4 — The repository has no pagination convention, only caps.**
Every list procedure surveyed uses a bare `limit: z.number().max(N).default(M)` with no cursor, no total and no `hasMore`. That *is* the 100-row silent-truncation defect PR #6 had to disclose. The Board cannot adopt the established convention because the established convention is the bug.

---

## 2. Row identity

**One Board row = one `dispatchPostings` row.** Not a job.

Proven, not assumed:

- **A job may hold N postings** (F1). A job-keyed row would have to merge a `direct` crew move and an `open_for_bid` vacuum haul into a single "Ready/Blocked" verdict. They are distinct operational dispatches with distinct lifecycles, distinct crews and distinct award paths.
- **`planningState` is a property of the posting**, not of the job. There is no job-level lifecycle field; `jobs.status` is a separate operational status with its own vocabulary.
- **Slots hang off postings** (`dispatchRoles.postingId`), and staffing is assessed per posting.
- **The award operates on a posting.** `dispatchEligibilityChecks.postingId` and the override table's `postingId` both key to posting.

A job-keyed board would therefore have to invent an aggregation across independent dispatches that no LeaseOS table models. **This is not an owner decision** — the schema answers it.

**Consequence for the row key:** `postingId`. `postingNumber` is the human-readable identifier (UNIQUE), and the job's `jobCode`/`customer`/`location` ride along as context.

**Cancelled and completed postings** are excluded from the default board view by filter, not dropped from the model (see §9).

---

## 3. Data sources

Read-only, all of them:

1. `dispatchPostings` ⋈ `jobs` — the row spine and the tenant predicate.
2. `dispatchRoles` — staffing and the assigned resource summary.
3. `dispatchEligibilityChecks` — the **latest stored check per role**, for readiness evidence.
4. `dispatchRoleAssignmentEvents` — the latest assignment event per role, used **only** as a cheap staleness proof (§7).

Explicitly **not** sources: `jobUnits` (legacy, job-blind, guarded), `dispatch.evaluate` (writes), `dispatch.whatAmIMissing` (§13), `composeReadiness` per row (§11).

---

## 4. The aggregate query (K-1)

Name: **`dispatch.board`**. Repository convention is `router.verbNoun` with short names (`listRoles`, `whatAmIMissing`, `readiness`); `board` reads as the noun it returns. Permission **`dispatch.read`**, matching `dispatch.readiness` and `dispatch.listRoles` (`recordsAuthorization.ts:2557,2562`).

### Input

```ts
z.object({
  // Pagination — keyset, never an offset.
  cursor: z.string().max(120).nullable().optional(),
  pageSize: z.number().int().min(1).max(100).default(25),

  // Filters (§12)
  staffing:  z.enum(["unstaffed", "partially_staffed", "staffed"]).array().max(3).optional(),
  readiness: z.enum(["PASS", "REVIEW", "BLOCKED", "UNKNOWN", "NOT_EVALUATED"]).array().max(5).optional(),
  freshness: z.enum(["never_evaluated", "superseded", "expired", "unverified"]).array().max(4).optional(),
  planningState: z.enum([...POSTING_STATES]).array().max(14).optional(),
  search: z.string().max(80).optional(),       // jobCode / postingNumber / customer
  scheduledFrom: z.date().nullable().optional(),
  scheduledTo:   z.date().nullable().optional(),
}).strict()
```

`.strict()` for the same reason `setRoleAssignment` uses it: an unknown key is refused, not silently ignored.

### Output

```ts
{
  rows: BoardRow[];
  nextCursor: string | null;   // null = genuinely the end
  hasMore: boolean;            // never a silent truncation
  pageSize: number;            // what was actually applied
  evaluatedAt: Date;           // when THIS read ran — not a readiness time
}

type BoardRow = {
  postingId: number;
  postingNumber: string;
  jobId: number;
  jobCode: string;
  customer: string;
  location: string;
  distribution: string;
  planningState: string;       // the posting's own, never postings[0] of a job
  planningBlocker: string;
  priority: string;
  scheduledStart: Date | null;

  staffing: {                  // straight from assessStaffing — not recomputed
    state: "unstaffed" | "partially_staffed" | "staffed";
    filled: number;
    requiredTotal: number;
    unfilledRoles: string[];
    optionalTotal: number;
    optionalFilled: number;
  };

  resources: {                 // never one operatorId/unitId — see §5
    operatorIds: number[];
    unitIds: number[];
    trailerIds: number[];
  };

  readiness: {
    status: InterEngineStatus;         // combineForConsumer over the slots
    blockerRecords: number;            // records, NOT root causes — see §6
    rolesNeedingEvaluation: number;
    missingRequired: string[];
    explanation: string;
  };

  freshness: {                 // ALWAYS separate from readiness.status
    state: "never_evaluated" | "superseded" | "expired" | "unverified";
    oldestEvaluatedAt: Date | null;
    newestEvaluatedAt: Date | null;
    supersededRoleIds: number[];
  };

  roleSummaries: {             // one per non-cancelled slot, for the row expander
    roleId: number; roleCode: string; roleLabel: string; required: boolean;
    status: InterEngineStatus;
    freshness: BoardRow["freshness"]["state"];
    operatorId: number | null; unitId: number | null; trailerId: number | null;
  }[];
};
```

**Tenant scope:** `orgScopeWhere(jobs, scope)` on the spine (F3), and `orgScopeWhere(dispatchEligibilityChecks, scope)` applied *independently* on the check read. A check is never trusted because its `postingId` matched.

---

## 5. Multi-role staffing

Taken from `dispatchRoles` for the posting, with `status = "cancelled"` excluded (withdrawn ≠ unfilled — the rule `listRoles` already applies).

- `requiredTotal` / `filled` / `unfilledRoles` come from **`assessStaffing`**, unchanged. No second staffing engine.
- `optionalTotal` / `optionalFilled` are counted beside it, because `assessStaffing` deliberately ignores optional roles and the Board must still be able to show them.
- `"3 / 4 required roles staffed"` renders from `filled` / `requiredTotal`.

**`resources` is three arrays, never three scalars.** A four-truck rig move has four operators and four units; collapsing them to `assignedOperatorId`/`assignedUnitId` is precisely the legacy shape this subsystem replaced.

---

## 6. Readiness aggregation

**The Board invents no aggregation and no new status strings.** It reuses `combineForConsumer` from `_core/interEngineStatus.ts`, applied one level up:

| Capability contract concept | Board mapping |
|---|---|
| `consumer` | the posting (`dispatch.board:posting:<id>`) |
| `requires` | every **required**, non-cancelled slot |
| `optional` | every **optional**, non-cancelled slot |
| a `CapabilityResult` | one slot's stored-check status |

This is load-bearing, because `combineForConsumer` already enforces exactly the invariants asked for:

- `SEVERITY = BLOCKED 4 > UNKNOWN 3 > REVIEW 2 > PASS 1`, **worst-of** across decided slots.
- `NOT_EVALUATED` is **set aside before the worst-of comparison**, so passes cannot round it up, then reintroduced as its own field.
- The **REVIEW floor**: a required slot that was not evaluated, or that *gave no answer at all* (`absentRequired`), can never leave a `PASS` standing.

The worked example resolves correctly with no new code:

> A `PASS`, B `PASS`, C `BLOCKED`, D `NOT_EVALUATED` → decided = {PASS, PASS, BLOCKED} → worst = **BLOCKED**.

And the subtler one:

> A `PASS`, B `PASS`, C `PASS`, D required and never evaluated → worst = PASS, but `absentRequired` is non-empty → **REVIEW**.

**Vocabulary:** the Board emits `InterEngineStatus` only. It does **not** introduce `READY` or `STALE` as statuses. "Ready" is a *presentation* word the UI may use, and §7 governs when it may.

**Blocker counting** follows `boardSemantics.ts`: blockers have no stable identity (`{engine, finding}` prose), so the Board reports `blockerRecords` and **never** a root-cause count. `collectRootCauses` is deliberately absent there for the same reason.

---

## 7. Freshness / staleness — the core safety rule

**Freshness is a separate field from `readiness.status` and is never folded into it.**

### What the Board can and cannot prove cheaply

Proving a stored check is *still current* means recomputing `computeEligibilityFingerprint(currentFacts)`, and `EligibilityFacts` is ~25 version strings — that recomputation **is** `composeReadiness`'s loading phase. Doing it per slot is the N+1 this design forbids (§11).

So the Board is honest about the limit of what it read:

| `freshness.state` | Meaning | How it is proven, cheaply |
|---|---|---|
| `never_evaluated` | no stored check for this slot | absence of a row |
| `superseded` | the **binding changed after the check** | latest `dispatchRoleAssignmentEvents.occurredAt` for the slot **>** check `evaluatedAt` |
| `expired` | outside the reuse window | `evaluatedAt` age > 30 min (`assessEligibilityValidity`'s default) |
| `unverified` | a check exists, in-window, binding unchanged — **facts beyond the binding were not re-read** | everything else |

**`current` is deliberately not a value this query can emit.** The Board cannot prove it without recomputing, so it does not claim it.

### The rule that stops a stale PASS reading as Ready

> **The UI may render a positive readiness word only when `freshness.state === "current"`.**
> `dispatch.board` never returns `"current"`.
> **Therefore the Board never renders the bare word "Ready".**

A previously-passing row renders as, e.g., *"Passed 8 min ago — not re-checked"*, with the age visible. `superseded` and `expired` render as explicitly not-current regardless of the stored verdict.

This is not a degradation — it matches how LeaseOS already behaves: the award re-evaluates and **refuses** on a stale check (`assessEligibilityValidity` → `requiresReEvaluation`). A board that claimed "Ready" would be claiming something the award itself would not accept. The authoritative current answer lives on the Detail screen, which calls `dispatch.readiness` live for one subject.

**Row-level freshness is the worst of its slots'** (`never_evaluated` > `superseded` > `expired` > `unverified`), so one un-evaluated truck cannot be hidden behind three fresh ones.

---

## 8. No automatic evaluation side effects

`dispatchEligibilityChecks` has exactly **one** production writer: `dispatchRouter.ts:231`, inside `dispatch.evaluate`. `dispatch.board` never calls it, so opening the Board creates **zero** rows.

The query performs **no writes of any kind**: no check rows, no `usedForAward`, no audit events, no bookings, no override records. It is a `.query()`, not a `.mutation()`, and P2/B12/B13/B14 enforce that.

---

## 9. Pagination

Keyset (seek) pagination. **This is new** — F4 established the repository has no cursor convention, only caps, and adopting the cap-only pattern would reproduce the defect PR #6 had to disclose.

- **Stable sort:** `(scheduledStart ASC NULLS LAST, postingId ASC)`. `postingId` is the tiebreaker, so the order is total and stable under concurrent inserts. `dispatchPostings_queue_idx (planningState, scheduledStart)` already supports the common filtered ordering.
- **Cursor:** opaque base64 of `{ scheduledStart, postingId }` — the last row of the page, never an offset (offsets skip and duplicate rows under concurrent writes).
- **Page size:** default **25**, max **100**.
- **No silent truncation:** the query reads `pageSize + 1` rows; the extra row sets `hasMore` and is dropped. `nextCursor` is `null` only at a genuine end.
- **Invalid or stale cursor:** refused with `BAD_REQUEST`, never silently reset to page 1 (that would loop a paging client forever).

---

## 10. Permissions and tenancy

- **`dispatch.read`**, proven consistent with `dispatch.readiness` and `dispatch.listRoles` (`recordsAuthorization.ts:2557,2562`). No new permission.
- **Spine scope:** join `jobs`, apply `orgScopeWhere(jobs, scope)` (postings carry no `orgRef` — F3).
- **Check scope:** apply `orgScopeWhere(dispatchEligibilityChecks, scope)` independently.
- **Filters and search are scoped before matching**, never after — a `search` term must not be able to confirm the existence of another tenant's job by its absence or presence.
- UI hiding is not authorization; every guarantee above is a server predicate.

---

## 11. Performance — the N+1 prohibition

A page of 50 postings × 4 roles must **not** cost 1 + 50 + 200 calls.

**Four bounded queries, then in-memory composition:**

1. **Spine** — postings ⋈ jobs, scoped, filtered, ordered, `LIMIT pageSize + 1`. → ≤ 101 rows.
2. **Slots** — `dispatchRoles WHERE postingId IN (:page)`, `LIMIT pageSize * MAX_ROLES_PER_POSTING`. → bounded.
3. **Latest check per role** — `dispatchEligibilityChecks WHERE roleId IN (:roleIds)`, scoped, reduced to the newest `evaluatedAt` per `roleId` in memory (the same reduction `listRoles` already uses for event heads).
4. **Latest assignment event per role** — `dispatchRoleAssignmentEvents WHERE roleId IN (:roleIds)`, newest per role, for `superseded`.

Total: **4 queries per page, independent of row count.** No caches — the prohibition is on N+1 architecture, not an invitation to optimise prematurely.

`MAX_ROLES_PER_POSTING` is a stated cap; if a posting exceeds it the row reports the cap rather than silently under-counting staffing (the same honesty rule as §9).

---

## 12. Filters (v1 — smallest operationally useful set)

Six, all derived from real domain state:

1. **staffing** — `unstaffed` / `partially_staffed` / `staffed` (from `assessStaffing`).
2. **readiness** — the five `InterEngineStatus` values.
3. **freshness** — the four §7 states. *"Show me what needs re-checking"* is the board's main job.
4. **planningState** — the posting's own lifecycle; default view excludes `completed` and `cancelled`.
5. **scheduledFrom / scheduledTo** — the window a dispatcher is working.
6. **search** — `jobCode`, `postingNumber`, `customer`. Prefix-matched on indexed columns; operator/unit search is **excluded from v1** because it would need a join whose selectivity is unproven.

Deliberately excluded: priority, distribution, pool, blocker-type. They are displayable but not yet filterable — twenty filters is not the ask.

---

## 13. `dispatch.whatAmIMissing` — keep separate (answer **C**)

Read rather than assumed:

```ts
const me = await db.select().from(operators).where(eq(operators.userId, ctx.user.id)).limit(1);
if (!me) return { verdict: "unknown", items: [], note: "No operator record is linked to your user" };
```

It resolves the operator from **the caller's own user id**, and it is gated on **`dispatch.readiness_own`** (`recordsAuthorization.ts:2556`), not `dispatch.read`.

It is a **driver self-service checklist**, not a dispatcher tool:

- It cannot answer about another operator's slot, which is the only question a Board row asks.
- A dispatcher typically has no `operators` row, so it would return `{ verdict: "unknown", items: [] }` for every row.
- Its permission is self-scoped by design; wiring it into a dispatcher aggregate would widen `readiness_own` into a cross-operator read.

**It is not used by the Board, and it is not wired merely to gain a caller.** Its overlap with the readiness/blocker summary is real but incidental.

---

## 14. Refresh model

No subscriptions, WebSockets or SSE exist, and this slice adds none.

- **Primary:** explicit "Re-read" button, matching `DispatchJobDetail` and `DispatchReadiness`.
- **Optional polling:** `refetchInterval` of **60 s**, pause-on-hidden-tab, and **only** because `dispatch.board` is provably read-only (§8). Recommended default **off** for v1; it is a switch, not architecture.
- The readiness panel's `staleTime: 0, gcTime: 0, retry: false` rule stays with the panel. The Board is a list and may cache within a page view; it is already explicit that its data is `unverified`.

---

## 15. UI layout (v1, observational)

Columns: posting number + job code · customer · location · scheduled start · planning state · staffing (`3 / 4 required`) · resources (counts, expandable) · readiness status · freshness · blocker-record count · **Open Dispatch**.

Row expander shows `roleSummaries` — per slot: label, required/optional, status, freshness, bound ids.

**Vocabulary rules**, enforced by a presentation module in the shape of `slotPresentation.ts` / `readinessPresentation.ts`:

- The bare word **"Ready" never appears** (§7).
- A `BLOCKED` row is visibly blocked regardless of how many slots passed.
- `NOT_EVALUATED` renders as itself, never as a pass or a blank cell.
- Blocker counts are labelled **records**, never "problems" or "root causes" (§6).

**Actions:** `Open Dispatch` only. No Award, no Override, no Force Ready, no mechanic or safety mutation.

---

## 16. Detail navigation — a real route defect

`/dispatch/:jobId` is **not sufficient** once a row is a posting.

`DispatchJobDetail` calls `listRoles({ jobId })`, which returns all postings for the job and then reports the scalar `planningState` of `postings[0]` (F2). Two Board rows for the same job would both link to `/dispatch/<jobId>` and land on the same screen, showing one posting's lifecycle beside both postings' slots.

**Do not paper this over with "first posting for job."**

Proposal (not implemented here): `/dispatch/:jobId/posting/:postingId`, with the existing `/dispatch/:jobId` retained as a compatibility entry that resolves to the job's single posting and, where there is more than one, **shows a chooser rather than guessing**. `listRoles` already accepts `postingId`, so the detail screen needs a prop, not a new procedure.

This is recorded as **OD-B1** (§19) because it changes a shipped URL.

---

## 17. Empty and error states

| State | Rendering rule |
|---|---|
| No active dispatches | "No active dispatches" — distinct from a filtered-empty result |
| No rows match filters | names the filters, offers to clear them |
| Server failure | `role="alert"`, no rows, **never** an empty list (a failed read is not an empty board) |
| Incomplete staffing | `1 / 3 required` plus the unfilled role labels |
| No readiness evaluation | `NOT_EVALUATED` + `never_evaluated` — never blank |
| Stale evaluation | stored verdict **plus** the freshness qualifier, always together |
| Unknown / unavailable | `UNKNOWN` as itself |

**No state may render a positive readiness word because data was missing.** U5 pins it.

---

## 18. Test strategy

RED-first. Counts are the minimum.

**Aggregate / DB (15):** B1 multiple rows · B2 tenant isolation · B3 stable pagination across concurrent insert · B4 no silent truncation (`hasMore`) · B5 multi-role staffing counts · B6 optional role does not make required staffing incomplete · B7 one `BLOCKED` required role → row not ready · B8 `NOT_EVALUATED` required role → not ready · B9 `UNKNOWN` required role → not ready · B10 **stale prior PASS never renders current** · B11 "no evaluation" is explicit · B12 query performs no writes · B13 does not set `usedForAward` · B14 writes no eligibility check rows · B15 cross-tenant search/filter cannot leak.

**UI (10):** U1 renders server rows · U2 staffing summary · U3 blocked row visibly blocked · U4 stale visibly non-ready · U5 missing data never ready · U6 pagination · U7 filters go to the server · U8 API failure → error state · U9 empty ≠ error · U10 row opens correct detail.

**Structural / performance (4):** P1 no client loop calling `dispatch.readiness` per row · P2 no `dispatch.evaluate` from the Board · P3 no award/override mutation reachable · P4 bounded access.

**Enforcing P4 realistically** — three layers, since a unit test cannot count SQL by intuition:
1. **Query counter** in the DB test: wrap the pool and assert the board call issues **≤ 5** statements for a 50-row × 4-role fixture. This is the real proof.
2. **Scaling assertion:** the same count for 10 rows and for 50 rows — a constant, not a function of row count.
3. **Structural guard** (`legacyAssignmentGuard.test.ts` style, comment-stripped): the Board container names no `useQuery` inside a loop or `.map`, and never imports `dispatch.evaluate`.

**B12–B14 method:** snapshot `COUNT(*)` and `MAX(id)` of `dispatchEligibilityChecks`, `dispatchAuditEvents`, `resourceBookings` and `dispatchRoleAssignmentEvents` around the call and assert unchanged — the same evidence-based approach as D19–D25.

---

## 19. Mutation strategy

| Mutation | Test that must fail |
|---|---|
| stale PASS treated as current | B10 |
| `BLOCKED` role dropped from the combine | B7 |
| `NOT_EVALUATED` rounded to PASS (remove the set-aside) | B8 |
| required floor removed (`absentRequired` ignored) | B8/B9 |
| optional role added to `requires` | B6 |
| tenant predicate removed from the spine | B2 |
| tenant predicate removed from the **check** read only | B15 |
| query writes a check row | B14 |
| `hasMore` hard-coded false | B4 |
| cursor replaced by offset | B3 |
| `MAX_ROLES_PER_POSTING` silently truncates | B5 |
| client adds a per-row `dispatch.readiness` call | P1 |
| client calls `dispatch.evaluate` | P2 |

Each restored byte-for-byte and verified by digest. A surviving mutation is a test gap to investigate.

---

## 20. Explicit exclusions

Award UI · override request/grant · K-2 `blocking + overridable` policy · Force Ready · mechanic work · HOS/mobile/maps/AI · operator/unit search · real-time transport · root-cause counting · `whatAmIMissing` wiring · fixing F2's `postings[0]` collapse.

**K-2 stays separate.** Where a blocker is `blocking` **and** `overridable`, the Board displays the server truth exactly as it is, and offers no Override action. `readinessPresentation.ts` already returns `overrideState: "marked_overridable_but_blocking"` for this case.

---

## 21. Remaining owner decisions

Only three, and only because evidence cannot settle them:

**OD-B1 — Detail route.** `/dispatch/:jobId` is ambiguous for multi-posting jobs (§16). Adopt `/dispatch/:jobId/posting/:postingId` with a chooser fallback, or keep the job route and accept the ambiguity? Changes a shipped URL.

**OD-B2 — Default board scope.** Exclude `completed` and `cancelled` postings by default (proposed), or show everything and make the dispatcher filter? Affects what "the board" means operationally.

**OD-B3 — Freshness window.** `assessEligibilityValidity` defaults to **30 minutes** for the *award*. Is 30 minutes also the right `expired` threshold for a *display* surface, or should the Board show a longer window with age visible? Not a safety question — `expired` and `unverified` are both non-current — but it changes how much of the board looks stale mid-shift.

---

## 22. First implementation checkpoint (after approval)

**Checkpoint BA — the pure aggregation core, no database, no procedure.**

`server/_core/boardAggregation.ts`:
- `aggregateRoleReadiness(roles, checks, events, now)` → per-row `readiness` + `freshness`, built on `combineForConsumer` and `assessStaffing`.
- `boardFreshness(roleFreshness[])` → worst-of.
- `encodeCursor` / `decodeCursor`.

RED first, pure unit tests covering B5–B11 as table-driven cases plus the §19 mutations that apply to pure logic. No migration, no procedure, no UI — so the riskiest semantics (the ones that decide whether a row can falsely read ready) are settled before anything touches the database.

Checkpoints BB (the bounded query + DB tests), BC (UI), BD (structural/perf guards) follow.
