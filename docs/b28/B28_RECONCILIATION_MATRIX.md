# B28 widget engine → reconciled branch: the twelve judgement calls, resolved against `v22.22`

The engine (36 server files, 20 client files, 604 Vitest + 48 Chromium tests) is preserved
intact on `candidate/b28h-widget-engine` (`bc91356`) under `incoming/b28h-widget-engine/`.
Its own arrival recipe (`tools/finish-b28-on-branch.mjs`, `--inspect` / `--verify`, no
`--apply`) forbids scripting the reconciliation, so this file is that reconciliation
written down against the *real* branch, computed on 2026-09-16 from
`recordsAuthorization.ts` and every mounted router.

## The twelve sources

| widget | contract procedure | on `v22.22` | call to make |
|---|---|---|---|
| `myDay` | `surfaces.myDay` | declared + wired | map as-is |
| `inbox` | `surfaces.inbox` | declared + wired | map as-is |
| `exceptions` | `surfaces.exceptions` | declared + wired | map as-is |
| `dispatchReadiness` | `dispatch.readiness` | declared + wired | map as-is (permission `dispatch.read`) |
| `hosRemaining` | `hos.status` | declared + wired | map as-is; response shape per `B28_HOS_STATUS_CONTRACT.md`; **every determination reads UNKNOWN until a person promotes a figure (P9)** |
| `trackingLookup` | `surfaces.timeline` | declared + wired | map as-is |
| `search` | `surfaces.search` | declared + wired | map as-is |
| `documentExpiry` | `records.documentExpiry` | **missing** | add a read procedure over the records vault (`recordsRouter`) returning `current/expiring/expired/missing/unverified/rejected` per document; permission `records.read` |
| `unitReadiness` | `shop.unitReadiness` | **missing** | do **not** add a shop procedure; the readiness composer already answers per unit — mount `readiness.unit` over `readinessComposer.ts` (it composes inspection, defects, insurance, registration, mechanic release) |
| `activeJob` | `jobs.active` | **missing** | add `jobs.active` (self-scoped: the caller's assigned job with the nearest start) beside `jobs.list`; permission `jobs.read` |
| `activeTrip` | `trips.active` | **missing** | add `trips.active` (self-scoped current trip) beside `trips.list`; permission `trips.read` |
| `syncStatus` | `sync.status` | **missing** | **device-local**, never a server call — reads `client/src/runtime` outbox counts; the contract's `authority: device-local` already says so |

## Structural facts that decide the port

- **Context.** The engine's `trpc.SCRATCH-SHIM.ts` expects `ctx.{userId, permissions, roleKey, tenantId}`. The branch's `roleProcedure` gives `ctx.user.id`; `tenantId` comes from `resolveActingScope(db, ctx.user.id).tenantId`; `roleKey` is the acting domain role. `widgetsRouter.ts` line 81 is the only place this is read — adapt there, delete the shim.
- **Procedures to register** (`OPERATIONAL_PROCEDURE_PERMISSIONS`): `widgets.offerable`, `widgets.boardResolve`, `widgets.layoutSave`, plus the three new reads above. Census tripwires move by +6.
- **Migrations.** `archive/b28h-sql/0126_widget_dashboards.sql` and `0127_widget_layout_revision.sql` are the engine's `0089/0090` renumbered into the next free slots (0125 was taken by the sheet-serial registry). They are in `archive/`, not `drizzle/`, until the checkpoint applies them, so the gate does not run them early. Add the two tables to `drizzle/schema.ts` in the same change (table parity fails otherwise).
- **Client.** `client/src/widgets/*` mounts at `/widgets` (`WidgetBoard`). The `.dom.test.tsx` suites need a jsdom environment; the branch's Vitest config runs node-only — either add a `client` project to the config or keep those suites under the engine's own toolchain until the config change is its own commit.
- **HOS field names.** `widgetSemantics.ts`'s HOS projection was reconciled once (`B28_HOS_RECONCILIATION.md`) against `hosClocks.ts`; re-run `finish-b28-on-branch.mjs --inspect` on `v22.22` — the 0093/0120 work added `currentPromotionRef` and `recordedByUserId` to `hosRuleLimits`, and the `hos.status` payload now carries `selection` + `determination` as `evaluationState.ts` reads them.

## Locked phase order (from the engine's own arrival RC)

1. baseline the untouched branch (`b28h-baseline.mjs`);
2. `--inspect`, `--verify` — no edits;
3. copy the engine files; adapt the one context line; register the three widget procedures;
4. migrations 0126/0127 + schema, table parity green;
5. promote **one** widget — `myDay` (self-scoped, wired, no HOS dependency), not `hosRemaining`;
6. gate green; then the remaining six mapped-as-is widgets; then the three new reads; `syncStatus` last, device-local.

Nothing in this file is applied. It is the plan the next checkpoint executes, with the branch facts already established.
