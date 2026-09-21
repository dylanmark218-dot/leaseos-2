# LeaseOS Project Recovery Checkpoint — 2026-09-14

**Status:** RELEASE CANDIDATE / NOT PROMOTED TO `main`  
**Implementation commit:** `18444d4c9622e61e75ae595380161990ff885142`  
**Recovery branch:** `integration/project-recovery-2026-09-14`  
**Protected pre-recovery main:** `74d99de54387894f42daa54c802e4a536eab9313` at `archive/pre-project-recovery`

## Why this checkpoint exists

A Project-wide recovery pass found that several LeaseOS source archives previously treated as unavailable still existed in Project/Library storage. The audit compared those recovered worktrees against the Chat1–Chat5 unified master and separated three cases: exact source that had been lost from the modern tree, historical capabilities already superseded by newer engines, and requirements discussed in Project conversations that were never implemented.

The key loss detector result is narrow: the later 0081→DOC02a source line survives into the modern tree except for the Academy tranche. The recovery therefore did not indiscriminately merge old repositories.

## Integrated in implementation commit 18444d4

### Training Academy recovered and forward-ported

- real recovered Academy core/router/client code
- versioned training catalog and regulatory profiles
- assessment, practical competency and certificate lifecycle
- TDG server-owned expiry, two-signature finalization, reasonable-grounds attestation and retention
- source tiers and foreign TDG road recognition
- Compliance Secretary, WLL/securement assist, waste routing and Class 1/2/3 + Q/S qualification logic
- central dispatch-readiness consumption of explicit Academy bindings
- stale-dispatch fingerprint now includes Academy qualification/requirement/supervision state
- migrations `0107_training_academy.sql` and `0108_training_academy_hardening.sql`
- retention trigger verified by the migration-runner gate

The central readiness composer deliberately refuses to infer jurisdiction or cargo from free-text job/site descriptions. Explicit bindings that require context LeaseOS does not authoritatively have remain UNKNOWN/review rather than being guessed.

### Production workflow worker wired

The existing durable drain worker is now started from the real web-server entrypoint and is also available as a standalone worker process. The implementation uses one shared claimer, routes enforcement through its stricter handler, uses `startOnce`, and shuts down cleanly. It does not create a second competing outbox consumer.

### LoadSense recovered onto the modern measurement model

Recovered v18/v21 calibration/stability/protocol/material-movement logic was ported without restoring the obsolete parallel device registry. `0109_loadsense_material_movement.sql` adds LoadSense-specific calibration models, gateway frames, weight/axle snapshots, certified-scale reconciliation and material-density profiles. The measurement ladder recognizes calibrated versus uncalibrated LoadSense without ever treating onboard weight as a certified trade scale by default.

The authenticated machine/device edge and native BLE/gateway ingestion remain explicitly unwired.

## Current generated source measurements

- tables: **337**
- SQL migrations: **105**
- schema `mysqlTable` / SQL `CREATE TABLE` parity: **337 / 337**
- role-authorized procedure call sites: **507**
- externally gated portal procedures: **36**
- integration/machine procedures: **2**
- bare `protectedProcedure`: **0**
- permissions: **340**
- sensitive/fail-closed permissions: **124**
- universal self-scoped permissions: **13**
- server test files / source-counted `it(` cases: **170 / 2728**
- native runtime bindings still throwing `NotOnDeviceError`: **4**

## Verification performed in this recovery environment

PASS:

- whole-tree syntax/transpile scan of 513 TS/TSX source files, zero syntax diagnostics
- exact schema/migration table-name reconciliation, 337/337 and no duplicates
- focused LoadSense executable checks: calibration, stability, GVW/axle totals, sequence gaps, certified-scale precedence and billing provenance
- focused Academy pure executable checks: regulatory terms, month-end expiry, retention, source-tier gate, finalization, foreign-road recognition and Class 1/2/3 + Q program presence
- `bash -n scripts/apply-migrations.sh`
- engine reachability inventory: 162 core modules / 129 reachable / 33 explicitly unwired / 0 undeclared / 0 stale declarations
- non-empty exact tracked-file duplicate groups: 0
- case-folding path collisions: 0
- common private-key/GitHub/OpenAI/AWS credential-pattern hits: 0
- JSON duplicate-key findings in root config files: 0
- unresolved conflict-marker files in code/config: 0
- `git diff --check`: PASS
- `git fsck --full --no-dangling`: PASS

Not run here and therefore **not claimed green**:

- dependency-backed full TypeScript project check
- full Vitest suite
- clean and upgrade application of all migrations against disposable MySQL/MariaDB
- production Vite/esbuild build
- repository CI gate
- Chromium/browser E2E
- mobile/native-device E2E
- real LoadSense hardware/gateway ingestion

## Promotion rule

Do not fast-forward `main` merely because this recovery/static gate is green. Promote the RC only after the dependency/database/browser/native gate succeeds. Until then, `main` remains the prior verified unified checkpoint and this branch is the integration/release candidate.

## Highest-priority remaining work

1. Run clean + upgrade migration tests and the full repository gate in the intended pnpm/MySQL environment.
2. Implement the native field runtime (Capacitor/encrypted SQLite/keystore/vault/camera/GPS/biometric/local notifications).
3. Build the authenticated LoadSense gateway/device ingestion edge and hardware/simulator tests.
4. Complete HOS/short-haul authoritative rule profiles and native ELD capture.
5. Prove tenant isolation across the full router/database surface.
6. Clear blocked source licences/importers (AER/Alberta 511 and communications sources) before operational use.
7. Create the LeaseOS-specific legal/privacy/licensing suite and choose the repository/product licence.
8. Build remote camp/accommodation operations and the unified company-policy portfolio requested in Project conversations.
9. Reconcile B28 widgets into the real app incrementally; current next free migration slot begins at 0110.
10. Execute the six-month field pilot/release-readiness program after software gates are green.
