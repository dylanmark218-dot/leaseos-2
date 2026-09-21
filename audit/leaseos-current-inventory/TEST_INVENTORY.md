# LeaseOS — test coverage inventory

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only. **No test was modified.**

## Headline

| | |
|---|---|
| Test files | **304** (296 server, 8 client DOM) |
| Tests executed on a clean database | **4 196 passed, 3 skipped (4 199)** |
| Test files passing | **304 / 304** |
| Hard-skipped tests | **3**, all in `server/agentRuntimeApi.test.ts` |
| Database-gated files | **125** — `const d = URL ? describe : describe.skip` |
| `.db.test.ts` files | 35 |
| DOM (`jsdom`) test files | 8 |

Measured by running the full suite at this SHA against a freshly migrated MariaDB 10.11 database.
CI runs the identical gate (`.github/workflows/ci.yml` → `scripts/ci-gate.sh`).

## Test groups by feature

| Group | Representative files | What it covers |
|---|---|---|
| Authorization | `procedureAuthorization.test.ts`, `recordsApiAuthorization.test.ts`, `operationalApiAuthorization.test.ts`, `recordsAuthorizationDb.test.ts`, `portalAuthorization.test.ts`, `agentBoundary.test.ts` | every `roleProcedure` name maps to a declared permission; counts are pinned so a new procedure cannot land ungated |
| Tenant isolation | 12 files — `tenantScopeShop.db.test.ts`, `tenantScopeJobsTrips.db.test.ts`, `tenantScopeFieldRuntime.db.test.ts`, `tenantScopeMonolithTail.db.test.ts`, `coreRecordOwnershipBoundary.test.ts` … | cross-tenant reads refuse; unowned records visible only to the default scope |
| Dispatch / readiness | `dispatchGate.test.ts`, `_core/dispatchReadiness.test.ts`, `enforcementReadiness.test.ts`, `_core/degradationSuite.test.ts`, `automationPolicySurface.test.ts`, `hosAttestation.test.ts` | blocker severities, override discipline, award freshness, P8.1 capability contract, P8.2 policy surface |
| Structural guards | `engineReachability.test.ts`, `crossLayerIntegrity.test.ts`, `registerClaims.test.ts`, `widgetSourceContract.test.ts`, `reservedWordColumns.test.ts`, `columnParity` | an unwired engine must be *declared*; the router surface size is pinned; register commit hashes must exist in git history |
| Security | 4 files matching `security*` plus `_core/deviceSignature.attestation.test.ts`, `_core/vaultFailClosed.test.ts`, `sessionAppId.test.ts` | session appId binding, sealed device signatures, vault fail-closed |
| Records / evidence | `_core/evidenceChainWalk.test.ts`, `_core/restrictedVault.test.ts`, `manifestCustody.db.test.ts`, `_core/evidenceSeal` | chain-of-custody walks, restricted tiering, seal integrity |
| Commercial / finance | `periodClose.test.ts`, `contractTerms.test.ts`, `commercialPortal.test.ts`, `commercialProjects.test.ts`, `capitalAssets.test.ts`, `insuranceRisk.test.ts` | period locks, approval ladders, AP/AR chains |
| Mapping / routing | `_core/osmImport.test.ts`, `_core/osmTopology.test.ts`, `_core/osmLoad.test.ts`, `_core/routeEvaluation.test.ts`, `roadSourceNeutrality.test.ts`, `geographyAgreement.test.ts`, `commsDispatch.test.ts` | pure graph and route-evaluation engines, validated against large extracts |
| Training / HOS | `trainingAcademy.test.ts`, `trainingAcademyHardening.test.ts`, `hos.test.ts`, `hosAttestation.test.ts` | requirement bindings, enforcement channels, HOS registry and attestation |
| Integration / machine | `integrationGateway.test.ts`, `enforcementApi.test.ts`, `productionPath.test.ts`, `b20WorkflowWiring.test.ts` | machine gate, end-to-end production chains |
| Offline / runtime | `client/src/runtime/*` via server-side imports (`enforcementReadiness.test.ts` imports `captureSyncPriority`), `fieldRuntime.test.ts` | outbox states, sync priority ordering |
| UI (DOM) | 8 `.dom.test.tsx` — `CommercialOfficeView.dom.test.tsx`, `DisposalFinderView.dom.test.tsx`, `panelSource.dom.test.tsx`, `assistantAskPage.test.ts`, `assistantCalibrationPage.test.ts` | rendering and the panel-source badge contract |

## Skipped tests

Exactly **three**, all with a stated reason, in `server/agentRuntimeApi.test.ts`:

- *"blocks on a compliance unknown and names the codes — not reachable from the API since the facts became server-owned"*
- *"reports stale rather than overwriting a human edit — not reachable from the API since the facts became server-owned"*
- *"allows the same payload once approved, and not a changed one — not reachable from the API since the facts became server-owned"*

These are honest tombstones: the behaviour moved server-side and the API-level assertion no longer applies.

## Environment-gated tests

**125 test files** gate on `DATABASE_URL`. Without a database they report as *passed with the describe skipped* —
they do not fail. This is a real risk class, and the repository defends against it in one place: **gate 6 of
`scripts/ci-gate.sh` fails the build if any `.db.test.ts` suite skips while a database is configured**
(*"no database-backed suite skipped"* appears in the CI log).

That guard covers the 35 `.db.test.ts` files. The other ~90 gated files use the same
`URL ? describe : describe.skip` idiom without the `.db.test.ts` naming, so they are **not** covered by
that check. They do run in CI because CI always supplies `DATABASE_URL`, but a local run without one would
silently skip them.

## Tests that never run in CI

**None identified.** CI runs `pnpm exec vitest run` with no file filter, against a live MariaDB service,
plus a second database for the widget suites (`WIDGET_DB_URL`). Every test file in the repository is
collected.

## Major production paths with no tests

| Path | Evidence |
|---|---|
| **`readinessComposer` critical-defect derivation** | `readinessComposer.ts:318-330` derives `criticalDefectOpen` / `mechanicReleaseRequired` / `mechanicReleaseGiven`. **No test exercises these lines.** Every test touching those booleans supplies them directly as inputs to `evaluateDispatchReadiness`. `dispatchGate.test.ts:161-163` clears a critical defect using a raw `UPDATE maintenanceDefects SET status='resolved'` that **no production caller can perform**, so it cannot distinguish the two mechanisms. *(PR #4 adds 25 cases here; it is not merged.)* |
| **`composeReadiness` enforcement branch** | Gated on `subject.enforcement`, which no production caller supplies. Only tests construct it. |
| **89 procedures** | Have neither a UI caller nor any test reference — listed in `API_INVENTORY.md`. |
| **The `llm.ts` HTTP edge** | `invokeLLM` requires `BUILT_IN_FORGE_API_KEY`; the live request path cannot be exercised without an endpoint. |
| **Capacitor adapter** | Every binding throws `NotOnDeviceError`; the on-device behaviour is untestable in this repository by design, and its own header says so. |

## What the test suite does unusually well

- **Counts are pinned.** The router surface (690), records procedures (17), test-file type errors (0) are all asserted, so growth is deliberate.
- **Unwired engines must be declared.** `engineReachability.test.ts` fails on any engine that is unreached *and* undeclared, and also on any declared-unwired engine that has since become wired. 52 engines are declared with reasons.
- **Register claims are checked against git.** `registerClaims.test.ts` verifies every commit hash the register cites with `git cat-file -e`.
- **Structural duplication is guarded.** `automationPolicySurface.test.ts` fails if any engine starts ordering automation modes itself.
