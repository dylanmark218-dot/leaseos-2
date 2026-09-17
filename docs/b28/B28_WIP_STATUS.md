# B28 port — status (v22.23)

**Applied on this branch, gate-green.** The engine is mounted at `widgets.*`
with real dependencies; `myDay` is promoted; the other eleven widgets answer
`unknown` with their reason on the tile until each is promoted in its own step.

| Step (locked order) | State |
|---|---|
| 1–2 baseline / inspect | done (`docs/b28/B28_RECONCILIATION_MATRIX.md`) |
| 3 engine in, context adapted, procedures registered | done — `boardCtx()` in `server/widgetsRouter.ts`; `widgets.offerable/boardResolve/layoutSave` under `myday.read_own` |
| 4 migrations 0127/0128 + schema, parity green | done |
| 5 promote one widget | done — `myDay` via `surfaces.myDay` as the acting user (`server/widgetSources.ts`) |
| 6 the seven as-is sources | **done**: inbox, exceptions, dispatchReadiness (operator and unit from the job's dispatched trip, composed by the dispatch composer); hosRemaining device-local by the engine's plan; search and trackingLookup are on-demand tiles (no query in their options) and say so |
| 7 the resolved sources | **done**: activeJob / activeTrip match the subject by code through `fieldRoute.jobs.list` / `fieldRoute.trips.list`; documentExpiry lists the operator's own documents in the vault's states (current / expiring / expired / unverified / rejected); unitReadiness composes this operator with the selected unit; syncStatus device-local |
| 8 client suites | `.dom.test.tsx` and the Chromium accessibility suite still run under the engine's own toolchain; a `client` Vitest project is its own commit |

Not ported: `widgetsRouter.test.ts` (scratch context), `promotionGate.test.ts` and
`registryIntegrity.test.ts` (assert the scratch permission vocabulary), `guardIntegrity.test.ts` (tools).
