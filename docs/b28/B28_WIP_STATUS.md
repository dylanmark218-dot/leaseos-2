# B28 port — WIP state (branch `integration/b28-widgets-wip`)

Phase 3 of the locked order is applied here: engine modules copied (14 server, 7
client), the router's context adapted to the branch (`boardCtx()` in
`server/widgetsRouter.ts` — userId from the session, tenantId from
`resolveActingScope`, roleKey requested-or-first-held and refused by
`actorForRole` if not held), `widgets.offerable/boardResolve/layoutSave`
registered under `myday.read_own`, `permissionsForDomainRole()` exported for the
grant source, migrations 0127/0128 in `drizzle/` with schema declared, and the
three iteration-style fixes this tsconfig needs.

**Typecheck: 6 errors, all one cause** — the v1 registry types every widget's
`procedure` as `ProcedureName`, and five sources do not exist on the branch:

```
widgetRegistry.ts:206   "records.documentExpiry"  -> add a read over the records vault (recordsRouter), permission records.read
widgetRegistry.ts:214   "shop.unitReadiness"      -> do not add to shop; mount readiness.unit over readinessComposer
widgetRegistry.ts:222   "jobs.active"             -> add a self-scoped read beside jobs.list
widgetRegistry.ts:230   "trips.active"            -> add a self-scoped read beside trips.list
widgetRegistry.ts:242   "sync.status"             -> device-local; registryV2 already says kind: "device_local"; v1 needs a non-procedure source kind
widgetRegistryV2.ts:254 "trips.active"            -> same as above
```

Not yet done on this branch: mount `widgets: widgetsRouter(deps)` in `routers.ts`
(deps: `drizzleWidgetLayoutStore`, a grant source over `permissionsForDomainRole`,
the tile-reader dispatcher for the seven as-is sources), the `/widgets` route, the
pure engine tests, and the one-widget promotion (`myDay`). The branch does not
build and must not be merged; it exists so the next checkpoint starts from the
adapted state rather than from the archive.
