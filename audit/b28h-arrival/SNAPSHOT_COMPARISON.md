# Snapshot Comparison

These are full-file comparisons between the unique nested source snapshots.

## v20
- Files: **229**
- Bytes: **2551842**
- Common types: `.ts` 83, `.tsx` 74, `.md` 22, `.sql` 17, `.json` 14, `<none>` 6, `.html` 4, `.js` 2

## v22.16
- Files: **558**
- Bytes: **6358592**
- Common types: `.ts` 269, `.md` 91, `.tsx` 90, `.sql` 72, `.json` 14, `<none>` 6, `.html` 4, `.sh` 4

## cal05a-v22.20
- Files: **730**
- Bytes: **8195330**
- Common types: `.ts` 401, `.sql` 102, `.tsx` 96, `.md` 95, `.json` 14, `<none>` 6, `.html` 4, `.sh` 4

## b28h-widget-engine
- Files: **139**
- Bytes: **1756019**
- Common types: `.ts` 58, `.md` 48, `.mjs` 12, `.json` 8, `.tsx` 8, `.html` 3, `.sql` 2

## Delta: v20 → v22.16
- Added: **338**
- Modified: **20**
- Deleted: **9**
- Unchanged same-path files: **200**

### Added examples
- `DATA_SOURCES.md`
- `LEASEOS_B20_10_VERIFIED_SOURCE_REGISTRY.md`
- `LEASEOS_B20_11_P3_TYPED_COMMIT.md`
- `LEASEOS_B20_12_V20_13_PROMOTION.md`
- `LEASEOS_B20_13_PORTALS_FUNDING.md`
- `LEASEOS_B20_14_V20_15_EXTRACTION_QUEUE.md`
- `LEASEOS_B20_15_V20_16_FINGERPRINT_DISPOSAL.md`
- `LEASEOS_B20_16_V20_17_INTEGRITY_CLOSURE.md`
- `LEASEOS_B20_17_V20_18_FUEL_LEDGER.md`
- `LEASEOS_B20_18_V20_19_ROADSIDE_AP.md`
- `LEASEOS_B20_19_V20_20_SECURE_FIELD_RUNTIME.md`
- `LEASEOS_B20_1_WORKFLOW_WIRING.md`
- `LEASEOS_B20_20_V20_21_COMPLIANCE_REGISTRY.md`
- `LEASEOS_B20_21_V20_22_REQUIREMENT_ENGINE.md`
- `LEASEOS_B20_22_V20_23_INSURANCE_RISK.md`
- `LEASEOS_B20_2_AUTHORIZATION.md`
- `LEASEOS_B20_3_AUTHORIZATION_ENFORCEMENT.md`
- `LEASEOS_B20_4_API_MIGRATION.md`
- `LEASEOS_B20_5_PAYROLL_FINANCE_TAX.md`
- `LEASEOS_B20_6_AUTHORIZATION_COMPLETE.md`
- `LEASEOS_B20_7_PAYROLL_FINANCE_API.md`
- `LEASEOS_B20_8_EXTERNAL_DATA_ROUTING.md`
- `LEASEOS_B20_9_UNIVERSAL_PERMISSIONS.md`
- `LEASEOS_B20_MEASUREMENT_LADDER.md`
- `LEASEOS_B20_RECORDS_VAULT.md`

### Modified examples
- `LEASEOS_BILLING_RECORDS_CHAIN.md`
- `LEASEOS_BUILD_PLAN.md`
- `LEASEOS_BUILD_SPEC.md`
- `LEASEOS_MASTER_PROGRAMMING_MANIFEST_V8.md`
- `LEASEOS_TAXONOMY_ROUTING.md`
- `client/src/App.tsx`
- `client/src/main.tsx`
- `drizzle/schema.ts`
- `server/_core/aiProposal.test.ts`
- `server/_core/aiProposal.ts`
- `server/_core/dispatchAward.ts`
- `server/_core/disposalReconciliation.ts`
- `server/_core/domainEmitters.ts`
- `server/_core/trpc.ts`
- `server/_core/workflowRuntime.ts`
- `server/_core/workflowSeeds.ts`
- `server/db.ts`
- `server/fieldroute.test.ts`
- `server/routers.ts`
- `server/storage.ts`

### Deleted examples
- `client/src/pages/BillingSafetyWorkspace.tsx`
- `client/src/pages/ComplianceEngine.tsx`
- `client/src/pages/FleetWorkspace.tsx`
- `client/src/pages/Home.tsx`
- `client/src/pages/LocationWorkspace.tsx`
- `client/src/pages/OfflineVault.tsx`
- `client/src/pages/RouteSafetyWorkspace.tsx`
- `client/src/pages/TripOperationsWorkspace.tsx`
- `dist/index.js`

## Delta: v22.16 → cal05a-v22.20
- Added: **172**
- Modified: **33**
- Deleted: **0**
- Unchanged same-path files: **525**

### Added examples
- `LEASEOS_B22_17_COMMUNICATIONS.md`
- `LEASEOS_B22_18_COMMS_DISPATCH.md`
- `LEASEOS_B22_19_OFFLINE_PACKAGE.md`
- `LEASEOS_UNRELEASED_0079_CDEF.md`
- `client/src/lib/commsView.ts`
- `client/src/pages/AssistantAsk.tsx`
- `client/src/pages/AssistantCalibration.tsx`
- `client/src/pages/CommunicationsPackage.tsx`
- `client/src/pages/CommunicationsPackageStatus.tsx`
- `client/src/pages/RoutePreview.tsx`
- `client/src/pages/TransmitCheck.tsx`
- `client/src/runtime/commsVault.ts`
- `client/src/runtime/safetyLatch.ts`
- `drizzle/0074_communications.sql`
- `drizzle/0075_communications_reach_dispatch.sql`
- `drizzle/0076_offline_communication_package.sql`
- `drizzle/0077_hos_rule_registry.sql`
- `drizzle/0078_route_geography_provenance.sql`
- `drizzle/0079_sync_capture_authorization.sql`
- `drizzle/0080_source_licence_review.sql`
- `drizzle/0081_feed_runs_and_road_advisories.sql`
- `drizzle/0082_enforcement_persistence.sql`
- `drizzle/0083_oos_required_finding_type.sql`
- `drizzle/0084_oos_release_policies.sql`
- `drizzle/0085_policy_scope_binding.sql`

### Modified examples
- `DATA_SOURCES.md`
- `LEASEOS_CURRENT_STATE.md`
- `client/src/App.tsx`
- `client/src/runtime/contracts.ts`
- `client/src/runtime/outbox.ts`
- `client/src/runtime/syncEngine.ts`
- `drizzle/schema.ts`
- `scripts/current-state.sh`
- `server/_core/assistantCommitService.ts`
- `server/_core/dispatchAward.test.ts`
- `server/_core/dispatchAward.ts`
- `server/_core/externalDataRegistry.ts`
- `server/_core/externalSourceSeeds.test.ts`
- `server/_core/externalSourceSeeds.ts`
- `server/_core/recordsAuthorization.ts`
- `server/_core/structures.ts`
- `server/_core/trpc.ts`
- `server/_core/workflowRuntime.ts`
- `server/customerAlertService.ts`
- `server/deviceRouter.ts`
- `server/dispatchRouter.ts`
- `server/documentationTruth.test.ts`
- `server/fieldRuntime.test.ts`
- `server/geoRouter.ts`
- `server/operationalApiAuthorization.test.ts`

### Deleted examples

