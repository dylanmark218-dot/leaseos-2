# Dispatcher Board — Implementation Plan

**Status:** plan only. No production code until this plan is approved.
**Design:** `DISPATCHER_BOARD_DESIGN.md` (same directory), approved with B1–B3 and Corrections 1–3.
**Branch policy:** implementation starts from a **fresh branch off then-current `main`**, not from this docs branch and not from any retired Dispatcher stack branch. Verify `merge-base` before the first commit.

**Totals:** 8 checkpoints · **51 tests** · **23 mutations**.

Every checkpoint is strict RED → GREEN → REFACTOR, with an explicit commit boundary. A checkpoint does not start while the previous one's focused tests are red.

---

## Checkpoint order and why

| | Checkpoint | Why here |
|---|---|---|
| **BA** | Pure Board semantics | The semantics that decide whether a row can falsely read ready are settled before any data access exists. |
| **BB** | Spine + pagination | The nullable-key and tenancy risks are structural; they belong before readiness composition. |
| **BC** | Batched roles / checks / heads | Introduces the query-count discipline while the surface is still small. |
| **BD** | `dispatch.board` | Composes BA over BB+BC and proves read-only behaviour. |
| **BE** | Canonical detail route | The Board needs somewhere to link to; independent of the aggregate. |
| **BF** | Board UI | Needs a real API. |
| **BG** | Filters / pagination / refresh | Needs a rendered board. |
| **BH** | Structural, mutation, full gate | Last, because it asserts properties of everything above. |

---

## BA — Pure Board semantics

**No database. No router. No UI.**

| | |
|---|---|
| **New** | `server/_core/boardAggregation.ts` · `server/_core/boardAggregation.test.ts` |
| **Edited** | `server/_core/dispatchAward.ts` (extract `ELIGIBILITY_REUSE_WINDOW_MINUTES`) · `server/_core/dispatchLifecycle.ts` (derive `TERMINAL_POSTING_STATES`) |

### Exports

```ts
export type SlotFreshness = "never_evaluated" | "superseded" | "expired" | "unverified";

/** Required slots only. Empty required set short-circuits to NOT_EVALUATED — never PASS. */
export function aggregateRoleReadiness(args: {
  requiredSlots: SlotEvidence[];
  now: Date;
}): { status: InterEngineStatus; requiredRoleCount: number; blockerRecords: number;
      rolesNeedingEvaluation: number; missingRequired: string[]; explanation: string };

/** Worst-of over REQUIRED slots only: never_evaluated > superseded > expired > unverified. */
export function aggregateRequiredFreshness(slots: SlotEvidence[], now: Date): {
  state: SlotFreshness; oldestEvaluatedAt: Date | null; newestEvaluatedAt: Date | null;
  supersededRoleIds: number[];
};

/** Counted beside the aggregate, never folded into it. */
export function summarizeOptionalRoles(slots: SlotEvidence[], now: Date): {
  total: number; evaluated: number; notEvaluated: number; blocked: number;
};

export function slotFreshness(slot: SlotEvidence, now: Date): SlotFreshness;

export function encodeCursor(k: BoardCursor): string;
export function decodeCursor(s: string): BoardCursor;   // throws on malformed
export type BoardCursor = { isNull: 0 | 1; scheduledStart: string | null; postingId: number };
```

### The two load-bearing rules, implemented here

1. **Empty required set.** `aggregateRoleReadiness` short-circuits *before* calling `combineForConsumer`:
   ```ts
   if (args.requiredSlots.length === 0)
     return { status: "NOT_EVALUATED", requiredRoleCount: 0, … };
   ```
   Proved necessary by execution against the baseline: `combineForConsumer({requires: [], optional: []}, [])` returns **`PASS`** — *"every capability this consumer reads answered."*

2. **Required-only inputs.** Optional slots are never passed as `optional` inputs; they go through `summarizeOptionalRoles`.

### Shared window (B3)

`ELIGIBILITY_REUSE_WINDOW_MINUTES = 30` is exported from `_core/dispatchAward.ts` and referenced by `assessEligibilityValidity`'s default parameter. `boardAggregation.ts` imports it. Pure refactor of an existing default — no behaviour change, and the only award-code edit this feature makes.

### Tests (24, all RED first)

B5–B11 (7) · C1a–C1d (4) · C2a–C2d (4) · C3a–C3e cursor round-trip half (5) · W1 (1) · plus 3 for `slotFreshness` boundaries (exactly-at-window, one-second-past, superseded-beats-expired).

### Mutations (8)

empty-required guard removed · optional fed into `requires` · optional freshness folded in · `NOT_EVALUATED` set-aside removed · required floor removed · `isNull` dropped from cursor · window literal inlined · `superseded`/`expired` precedence swapped.

### Verification
`pnpm exec tsc --noEmit` · focused suite · `git diff --check` · commit.

---

## BB — Board spine and pagination

| | |
|---|---|
| **New** | `server/boardSpine.db.test.ts` |
| **Edited** | `server/dispatchBoardService.ts` *(new file, spine only)* |

Bounded page query: `dispatchPostings ⋈ jobs`, `orgScopeWhere(jobs, scope)`, filters, three-part sort, `LIMIT pageSize + 1`.

**No readiness in this checkpoint** — it stays small deliberately.

### Tests (12)
B1 · B2 tenant isolation · B3 stable pagination · B4 `hasMore` · B15 cross-tenant search · T1/T2 terminal default and retrieval · C3a–C3e (the five NULL-ordering and boundary cases, now against a real database).

### Mutations (5)
tenant predicate removed · terminal exclusion removed · `isNull` term dropped from sort · `hasMore` hard-coded false · cursor replaced by offset.

---

## BC — Batched roles, checks and assignment heads

| | |
|---|---|
| **Edited** | `server/dispatchBoardService.ts` |
| **New** | `server/boardBatching.db.test.ts` |

Three `IN (:ids)` reads for the page's postings/roles, reduced in memory to latest-per-role (the reduction `listRoles` already uses for event heads).

**The query-count test is introduced here**, while the surface is small enough to reason about:

```
readAt = instrumented pool
expect(statements).toBeLessThanOrEqual(6)          // documented bound
expect(count(10 rows)).toBe(count(50 rows))        // constant in row count
```

`<= N` plus the equality, never a brittle exact number — transaction and setup mechanics may add a harmless constant statement.

### Tests (4)
bounded statement count · constant across 10 vs 50 rows · latest-check-per-role reduction correct · `MAX_ROLES_PER_POSTING` reports the cap rather than under-counting.

### Mutations (2)
per-row check query reintroduced (N+1) · cap silently truncates.

---

## BD — `dispatch.board`

| | |
|---|---|
| **Edited** | `server/dispatchRouter.ts` · `server/_core/recordsAuthorization.ts` (one permission-map entry) |
| **New** | `server/dispatchBoard.db.test.ts` |

Composes BA over BB+BC. Permission `dispatch.read`. Input `.strict()`.

**Procedure-count pins move here** (`crossLayerIntegrity`, `operationalApiAuthorization`, `procedureAuthorization`) — +1 procedure, **no new permission**.

### Tests (5)
B12 no writes · B13 `usedForAward` untouched · B14 no eligibility rows written · malformed cursor refused (not reset to page 1) · unknown input key refused by `.strict()`.

**Method for B12–B14:** snapshot `COUNT(*)` and `MAX(id)` of `dispatchEligibilityChecks`, `dispatchAuditEvents`, `resourceBookings` and `dispatchRoleAssignmentEvents` around the call and assert unchanged — the same evidence approach as D19–D25.

### Mutations (2)
query writes a check row · `.strict()` removed.

---

## BE — Canonical posting-aware detail route

| | |
|---|---|
| **New** | `client/src/dispatch/PostingChooser.tsx` + `.dom.test.tsx` · `server/dispatchDetailRoute.db.test.ts` |
| **Edited** | `client/src/App.tsx` · `client/src/dispatch/DispatchJobDetail.tsx` (accept `postingId`) |

`/dispatch/:jobId/posting/:postingId` canonical. `/dispatch/:jobId` resolves per §16.1 and **never guesses**.

`listRoles` already accepts `postingId`, so the detail screen takes a prop — **no new procedure, and `listRoles` is not modified** (DEFECT-LR1 stays recorded, not fixed).

### Tests (6)
R1–R6 (two rows per job · distinct URLs · mismatch refused · cross-tenant undiscoverable · single-posting redirect · multi-posting chooser picks nothing).

### Mutations (2)
resolver picks `postings[0]` · pair validation removed.

---

## BF — Dispatcher Board UI

| | |
|---|---|
| **New** | `client/src/dispatch/DispatchBoard.tsx` (container) · `DispatchBoardView.tsx` + `.dom.test.tsx` · `boardPresentation.ts` + `.dom.test.tsx` |
| **Edited** | `client/src/App.tsx` (route) · `client/src/a11y/a11y.dom.test.tsx` · `server/a11yCoverage.test.ts` |

`boardPresentation.ts` is the vocabulary module, in the shape of `slotPresentation.ts` — and it carries the rule that matters:

> **The bare word "Ready" never appears.** A positive verdict renders only as historical text with its age: *"Last evaluation passed 8 min ago — not re-checked."*

States: loading · empty · filtered-empty · error · blocked · review · unknown · not-evaluated · stale/unverified historical pass.

### Tests (10)
U1–U10, plus the vocabulary assertions (no "Ready"/"Awarded"; `NOT_EVALUATED` rendered as itself; blocker counts labelled *records*).

### Mutations (2)
"Ready" emitted for a stored PASS · missing data rendered as a pass.

---

## BG — Filters, pagination, refresh

| | |
|---|---|
| **Edited** | `DispatchBoard.tsx` · `DispatchBoardView.tsx` + tests |

Six server-backed filters (§12), keyset next-page, manual refresh, optional 60 s polling **off by default** and read-only by construction.

### Tests (folded into U6/U7)
filters reach the server rather than filtering in the client · next-page uses the returned cursor · refresh is read-only.

---

## BH — Structural, mutation battery, full verification

| | |
|---|---|
| **New** | `server/boardStructuralGuard.test.ts` |

Comment-stripped source scan, in the shape of `legacyAssignmentGuard.test.ts` — and matched as **calls**, not names, because that assertion has already failed once in this repository by being satisfied by an import line.

### Tests (4)
P1 no per-row `dispatch.readiness` in a loop or `.map` · P2 no `dispatch.evaluate` from Board code · P3 no award/override/force-ready/assignment mutation reachable from Board v1 · P4 bounded access (the BC counter, re-asserted at the composed surface).

Then: the full 23-mutation battery re-run and each restored byte-for-byte by digest, plus the complete clean-DB `scripts/ci-gate.sh` on a **uniquely named disposable database**, gates 0–8, no DB suite skipped, only the three known `agentRuntimeApi` skips.

---

## Test and mutation ledger

| Checkpoint | Tests | Mutations |
|---|---|---|
| BA | 24 | 8 |
| BB | 12 | 5 |
| BC | 4 | 2 |
| BD | 5 | 2 |
| BE | 6 | 2 |
| BF | 10 | 2 |
| BG | folded into BF | — |
| BH | 4 | (re-runs all 23) |
| **Total** | **51 new** (some BA cases re-asserted against the DB in BB) | **23** |

---

## Expected file inventory

**New (13):** `_core/boardAggregation.ts` + test · `dispatchBoardService.ts` · `boardSpine.db.test.ts` · `boardBatching.db.test.ts` · `dispatchBoard.db.test.ts` · `dispatchDetailRoute.db.test.ts` · `boardStructuralGuard.test.ts` · `DispatchBoard.tsx` · `DispatchBoardView.tsx` + test · `boardPresentation.ts` + test · `PostingChooser.tsx` + test.

**Edited (8):** `_core/dispatchAward.ts` (window constant) · `_core/dispatchLifecycle.ts` (derived terminals) · `dispatchRouter.ts` · `_core/recordsAuthorization.ts` · `App.tsx` · `DispatchJobDetail.tsx` · `a11y.dom.test.tsx` · `a11yCoverage.test.ts` · plus the three procedure-count pins at BD.

**Not touched:** `listRoles` · `composeReadiness` · `combineForConsumer` · `assessStaffing` · `dispatch.evaluate` · award/override code · `jobUnits`. **No migration. No new table. No new permission.**

---

## Risks, named in advance

1. **The window extraction touches award code.** Mitigated: it is a pure refactor of an existing default parameter, W1 pins that both readers use one constant, and it is the only award edit.
2. **A posting with many slots could unbalance the batched reads.** Mitigated by `MAX_ROLES_PER_POSTING`, which reports the cap rather than under-counting (BC).
3. **The query-count test can be brittle.** Mitigated by `<= N` plus the 10-vs-50 equality, never an exact count.
4. **`main` will move under this work.** Mitigated by branching fresh at implementation time and re-running the full gate before the PR, not by assuming today's SHA.
