# SPINE reconciliation against current `main` — 2026-10-03

**Survey only. No production code, no migration, no engine.** This record re-derives the SPINE
position from the tree as it stands, rather than from the order remembered from earlier
checkpoints. Where this record and an earlier document disagree, the tree wins, and the
disagreement is listed in §8.

## 0. Baseline

| Fact | Value | How it was read |
|---|---|---|
| `main` | `c9e3b4611898e0da2e90058ea029e45b25a34284` (merge of #136, 2026-10-03) | `git fetch origin` |
| Migration head | `0228_safety_program_builder.sql` (205 files) | `ls drizzle/*.sql`, tail read |
| Duplicate prefixes on `main` | `0157` only (historical; never reused) | prefix `uniq -d` |
| SPINE plan revision | `docs/register/SPINE_WIRING_PLAN.md` unchanged since `fc35f6f` (restored byte for byte; guarded by `server/spineWiringPlan.test.ts`) | `git log -- docs/register/SPINE_WIRING_PLAN.md` |
| Engine census | **73** unwired `_core` engines (the pinned count in `server/engineReachability.test.ts`), 72 `DECLARED_UNWIRED` keys | `engineReachability.test.ts` |
| AI declared-unwired | **21** `ai/*` keys; no production importer of `server/_core/ai/` | census map; import grep |
| Gate | **PASS** on `main` `c9e3b46`: 485 test files, 7,398 passed, 3 skipped; 479 tables; 205 migrations; 881 role-authorized procedures; 40 external-gated, 2 integration-gated; fixture isolation, production build, production-only boot and current-state regeneration all PASS | `scripts/ci-gate.sh` on MariaDB 10.11.14, Node 22.23.3 (`.nvmrc`) |

## 1. The SPINE order, exactly as the plan writes it

`SPINE_WIRING_PLAN.md`, "The ordering the dependencies force":

1. Per-boundary confirmation on `tripStops`.
2. Resolve the four duplications (`dispatchMatching`, `openShifts`, `complianceDocumentValidity`,
   `fieldTicket`) before wiring any of them.
3. `offlineCapability` → HS1 ("the device seam and the hybrid plan already covers it").
4. The rest of the spine, in path order: dispatch gate → routing → departure → capture → stop
   timing → job close.

**P9 is not this order.** `docs/REMAINING_BUILD_REGISTER.md` §P9 says: *"none is SPINE work, and
none may be built ahead of the spine."* The P9 numbers (P9.1 … P9.13) are the AI-runtime backlog
that follows the spine. `AI_AGENT_RUNTIME_ARCHITECTURE.md` §22 cites P9 numbers inside a sequence
whose first two steps are "BoundaryConfirmation → remaining SPINE wiring". So the earliest
incomplete **SPINE** item decides the next coding task, not the earliest P9 row.

## 2. Status of every SPINE item

| Order | SPINE item | Implementation | Wiring | Tests | Status |
|---|---|---|---|---|---|
| 1 | Per-boundary confirmation | `server/_core/boundaryConfirmation.ts` (resolver, `parseFieldManifest`, `UNREACHABLE_BOUNDARIES`); `server/_core/boundaryEvidence.ts` (chain rule + org-scoped receipt reader over `0179`) | none; its consumer is the stop-timing router, **item 4** by the item's own record | `boundaryConfirmation.test.ts`, `boundaryConfirmationRules.test.ts`, `boundaryEvidence.test.ts`, `boundaryEvidence.db.test.ts`, `tripStopProvenance.test.ts` | **COMPLETE as a chain** (IMPLEMENTED_NOT_WIRED by design; wiring belongs to item 4) |
| 2 | The four duplications | booking conflict → `bookingConflict.ts`; field-ticket copies deleted; `openShifts` engine wired; document validity resolved by #52 | `openShifts`, `complianceDocumentValidity` reached; `dispatchMatching`, `fieldTicket` remainders are non-duplicates, unwired | `spineItem2Duplicates.test.ts`, `bookingConflict.db.test.ts`, `fieldTicketSignature*.db.test.ts` | **COMPLETE** (`SPINE_ITEM2_DUPLICATIONS.md`, 2026-10-01) |
| 3 | `offlineCapability` → HS1 | `server/_core/offlineCapability.ts` (`OfflineClass`, `validateCapability`, `classRiskDisagreements`); HS1's frozen surface `CapabilityMatrix` / `capabilities()` (`docs/hybrid-seam/HS_CONTRACTS.md` §1) **absent**; no hardware-call guard test; `client/src/showcase/Home.tsx` still has the one direct `<input type="file">` | `offlineCapability` imported only by `server/offlineCapability.test.ts` | `offlineCapability.test.ts` | **PARTIAL / DECLARED_UNWIRED — earliest incomplete item** |
| 4a | Dispatch gate | `complianceDocumentValidity` (reached), `jurisdiction` | `jurisdiction` unwired ("callers use their own") | — | PARTIAL |
| 4b | Routing | `routeApprovalPolicy`, `sourcePrecedence`, `truckRoutingAdapter` | all unwired | own tests | DECLARED_UNWIRED (`truckRoutingAdapter` blocked on a routing source) |
| 4c | Departure | `preDepartureCache` | unwired | own tests | DECLARED_UNWIRED |
| 4d | Capture | `phoneLocationGate` | unwired ("there is no phone yet") | own tests | DECLARED_UNWIRED |
| 4e | Stop timing | `siteBaseline` + item 1's chain | unwired; needs `siteStopBaselines`/`siteStopAlerts` + a router | own tests | DECLARED_UNWIRED |
| 4f | Job close | `fieldTicket` (non-duplicate remainder), `tripPassportPackage` | unwired; passport needs tables | own tests | DECLARED_UNWIRED |

**Moratorium:** still in force. Two of the plan's thirteen spine engines are now reached
(`openShifts`, `complianceDocumentValidity`, both via item 2); eleven remain declared unwired,
plus item 1's `boundaryConfirmation` / `boundaryEvidence`. The census's "has no engine that is
unreached and undeclared" test passes, so no new engine has slipped outside it.

## 3. BoundaryConfirmation — independently re-checked

- **State: step 2 of the five-step scale, "present but unwired", by design.** It is not absent
  (1), and not wired into one (3) or both (4) consumers. The resolver and reader exist and are
  green; neither required consumer (`siteBaseline` via the
  stop-timing router, and the billing path via `tripBillingProjection` on `priceLineAndRecord`)
  calls them, and the item's own record assigns both to item 4.
- **Data path holds as designed:** `tripStops.id` → `assistantCommitReceipts`
  (`targetType = 'trip_stop'`, `targetRecordId`) → `fieldManifest` → per-field source + status →
  `boundaryConfirmations()` → (future) `siteBaseline`. The reader scopes the stop by
  `orgScopeWhere(trips, scope)` and compares against `tripStops.updatedAt`/`updatedByUserId`
  (`0179_trip_stop_provenance.sql`).
- **No recreation needed.** Do not rewrite it in a later checkpoint.
- **`setupStartedAt` is still unreachable.** It is a `tripStops` column (`drizzle/schema.ts`), but
  `UnloadStopPatch` (`assistantCommitAdapters.ts`) has no field for it and no form collects it;
  `UNREACHABLE_BOUNDARIES = ["setupStartedAt"]` stands.

## 4. AI layer — merged, not wired

| Concern | State |
|---|---|
| Implementation | `server/_core/ai/` in-tree (PR #7) |
| Production reachability | none: no non-test file outside `server/_core/ai/` imports it; 21 `ai/*` census keys |
| Worker dispatch | `productionWorker.ts` does not dispatch `secretary.narration.captured` |
| Caller injection | no composition root supplies `createCaller` (P9.4, SPINE-blocked) |
| Tool allowlists | `LOAD_UNLOAD_NARRATION`, `BILL_SCAN`; refusal via `agentMayNotCall()` |
| Agent gateway | `decide()` live; executes nothing |
| Model invocation | door 1 `invokeLLM()` at `server/routers.ts:887` inside `assistant.draft`; **still present**, pinned at exactly one by `server/_core/ai/workerBoundary.test.ts` (`PRE_EXISTING_LLM_CALLS_IN_HANDLERS = 1`) and `server/aiRequestBoundary.test.ts`. Not fixed here. |

## 5. Migrations

- `main` head `0228`; only duplicate prefix is the historical `0157`; gaps `0016`, `0017`, `0094`,
  `0095`, `0098` and `0223`–`0225` are unused on `main`.
- The old `0169` collision is resolved: this repository keeps `0169_defect_resolution.sql`; the
  sibling's `0169_trip_stop_provenance.sql` arrives here as `0179`
  (`MIGRATION_0169_RECONCILIATION.md`).
- **Open-branch collisions remain** (scan per `docs/architecture/MIGRATION_COLLISION_REGISTER.md`):
  `0228` — `claude/payroll-p3-time-candidates` (`0228_payroll_time_candidates_exceptions.sql`)
  against `main`'s `0228_safety_program_builder.sql`; `0224` — `claude/eld-compliance-intelligence-ramlrd`
  vs `fix/main-ci-stabilization`; `0229` — `security/driver-portfolio-hardening` vs
  `claude/integration-hub-subsystem-6nzrkw`; `0233` — `claude/leaseos-billing-invoicing-ar`,
  `claude/external-source-registry`, `claude/safety-compliance-program-builder-2qnty0`. The
  register's own table is dated 2026-10-01 (`main` head `0209`) and is stale.
- The next SPINE item needs no migration.

## 6. Repository divergence

| | `leaseos` | `leaseos-2` |
|---|---|---|
| Last push | 2026-10-01 | 2026-10-03 |
| Migrations | 166, head `0169_trip_stop_provenance.sql` | 205, head `0228` |
| Shared migrations | 165, byte-identical | — |

`leaseos-2` is the de facto canonical repository: the SPINE plan, item 1 and item 2 all land here,
and it carries 40 migrations the sibling does not. **No document records an owner ruling** that
`leaseos` is retired or that mirroring continues; `MIGRATION_0169_RECONCILIATION.md` still records a
defect-resolution port owed to `leaseos`. Recommendation: future SPINE commits land in `leaseos-2`
only, unless the owner rules that `leaseos` must be kept in step.

## 7. Next coding task — and why it is not started here

**BoundaryConfirmation is already complete (as a chain) on current `main`; the next ordered
incomplete SPINE item is item 3, `offlineCapability` → HS1.** (It has no P9 number; P9 is the
post-spine AI backlog.)

Item 3 is **not unambiguous on current `main`**, so implementation waits on three answers:

1. **What wires `offlineCapability`?** HS1's frozen contract (`HS_CONTRACTS.md` §1) adds only
   `CapabilityMatrix`/`capabilities()` — device *hardware* availability. `offlineCapability` is
   *action authority* offline (`local_safe` … `server_authoritative`). HS1 never consumes
   `OfflineClass`, and the census counts only server imports, so a client import would not
   register as wiring. The plan says "offlineCapability → HS1" without naming the consumer. Options:
   (a) the client field runtime gates queued actions by `OfflineClass` (value import from
   `server/_core`, one precedent: `client/src/portal/boardModel.ts`; or a move to `shared/`);
   (b) the server applies it when building the gateway registry, so `CAPABILITIES` carry an
   `offlineClass` validated by `classRiskDisagreements()` (server-reached; joins P9.8's direction);
   (c) split item 3: build HS1's `capabilities()` now, keep `offlineCapability` declared until HS3.
2. **The showcase file input.** HS0 proposed deleting `client/src/showcase/`; it is now mounted under
   `/showcase/*` behind `ShowcaseFrame`, so deletion is a product decision. Alternative: the HS1
   guard allowlists `client/src/showcase/` as demo-only, or the input moves behind `FileVault`.
3. **Overlap with PR #120 (HS5).** It touches `client/src/runtime/syncEngine.ts` and
   `docs/hybrid-seam/HS_CONTRACTS.md` but not HS1's surface; landing HS1 first or after #120 only
   changes merge order.

## 8. Corrections found

- `AI_AGENT_RUNTIME_ARCHITECTURE.md` header said "30 `ai/*` entries"; the census has **21** keys
  (the 30 counted every `"ai/` string, including the nine-module cluster list). Corrected in this
  branch.
- `server/engineReachability.test.ts`'s reason for `boundaryConfirmation` still says its reader
  "cannot exist here until tripStops carries updatedAt"; `0179` and `boundaryEvidence`'s reader both
  exist. A test-file string; left for the item-4 checkpoint that removes the entry, recorded here.
- `MIGRATION_COLLISION_REGISTER.md`'s table is dated at `main` head `0209`; current head is `0228`
  and the open collisions are those in §5.
- HS0's "delete `client/src/showcase/`" premise (an unrouted page) no longer holds.
