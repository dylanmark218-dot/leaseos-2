# LeaseOS post-recovery ownership checkpoint — 2026-09-14

This checkpoint replaces the broad non-default-tenant integration projection quarantine with an explicit, server-managed ownership boundary for legacy core records.

## Implemented

- `coreRecordOwnership` assigns exactly one organization to a legacy `unit`, `operator`, `load`, or `financial_entity` record.
- Assignment is role-gated and the organization is resolved from server-owned acting scope; neither a human request nor a machine payload chooses the organization.
- Existing ownership cannot be silently transferred by the assignment endpoint.
- Non-default organizations fail closed when a referenced legacy record has no explicit ownership row.
- The historical `default` organization retains compatibility for unowned legacy records while migration/backfill is completed.
- Fuel ingestion checks both unit and financial-entity ownership.
- ELD ingestion checks operator ownership.
- Telemetry/fault/safety/video ingestion checks unit ownership; event-only video attachment must be attributable to the same organization's integration client or an owned unit.
- LoadSense frames carrying `loadId` check load ownership before evidence is persisted.

## Deliberately not claimed

This does **not** make every LeaseOS table tenant-isolated. It closes the authenticated machine-to-legacy-core projection boundary. A wider router/read/write ownership conversion remains a separate tranche.

Full dependency/MySQL/browser/native gates were not run in this environment. Syntax/transpile, migration/schema accounting, Git diff integrity, and static boundary checks are the available gates here.
