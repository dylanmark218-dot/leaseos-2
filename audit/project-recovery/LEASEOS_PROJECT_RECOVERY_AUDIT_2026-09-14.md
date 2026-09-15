# LeaseOS Project-wide recovery and repository audit — 2026-09-14

## Executive result

The Project-wide recovery materially changes the prior Chat1–Chat5 audit. Earlier Project/Library uploads still contained exact LeaseOS source that had been treated as unavailable. The recovery found and preserved those source bytes, compared them to the unified master, and integrated only capabilities that were actually missing and compatible with the modern architecture.

The implementation tranche is fixed at commit `18444d4c9622e61e75ae595380161990ff885142` on `integration/project-recovery-2026-09-14`. Canonical `main` remains `74d99de54387894f42daa54c802e4a536eab9313` pending the full dependency/MySQL/browser/native promotion gate.

The prior 63-row gap matrix is now **68 rows** after adding newly explicit Project-conversation gaps. Major previously blocked Academy/source-recovery findings are closed or substantially reduced; B28, native runtime, HOS, tenant proof, legal/licensing and real hardware/browser gates remain.

## Recovery scope and boundary

The audit used:

- the complete 337-branch Chat1–Chat5 GitHub-ready repository as the restoration base;
- Project/Library gate snapshots from 0081 through DOC02a;
- recovered 0088 gate and Academy reconciliation source;
- v17 Spatial, v18 LoadSense and v21 reconciled Spatial+LoadSense source;
- `leaseos-integrated-ops.diff`;
- the recovered B23 widget package;
- Project file/search evidence for later conversation topics including message board, CVIP/maintenance, secure authentication, legal, AI Secretary, communications and policy/camp requests.

The Project file surface does not expose a raw export of every historical chat transcript. Therefore this audit can prove recovered file/source content and can cross-check Project-conversation requirements available in Project context/search, but it does not claim a byte-for-byte transcript archive of every conversation.

## Source-loss analysis

A chronological worktree comparison found that later 0081→DOC02a application code did not disappear broadly. The significant missing source tranche was the Training Academy line. Spatial and LoadSense appeared missing by historical filename, but their cases differ: most old spatial functionality has later modern equivalents, while LoadSense math/protocol/material-movement logic still supplied useful missing capabilities.

This distinction prevented three failure modes: reintroducing old duplicate tables, creating two routing sources of truth, and reconstructing Academy SQL from prose when the real SQL was recoverable.

## Integrated recovery

### Academy

Recovered and ported into root application code. The historical migrations were preserved on their archive ref and remapped to modern forward slots 0107/0108. Central readiness now consumes explicit Academy bindings and invalidates stale eligibility fingerprints when Academy state changes. Unknown context remains unknown.

### Worker lifecycle

The prior audit correctly identified a production lifecycle gap. The worker engine was not missing; the entrypoint was. This recovery starts the worker from the web process or standalone worker with a single claimer and graceful shutdown.

### LoadSense

Recovered pure engines were adapted to the modern measurement source-of-truth. Migration 0109 adds LoadSense-specific persistence without restoring the historical parallel device registry. Current limitation is the authenticated/native device edge, not the core calibration/stability/reconciliation logic.

### Spatial

Historical source is now recovered and permanently anchored, closing the prior `SOURCE_NOT_SUPPLIED` finding. Modern spatial/routing remains authoritative; old code is evidence, not a second production subsystem.

## Static integrity and source measurements

Generated current state:

| Measure | Result |
|---|---:|
| Tables | 337 |
| SQL migrations | 105 |
| Schema / SQL table parity | 337 / 337 |
| Role-authorized procedures | 507 |
| External portal procedures | 36 |
| Integration procedures | 2 |
| Bare protectedProcedure | 0 |
| Permissions | 340 |
| Sensitive permissions | 124 |
| Universal permissions | 13 |
| Server test files / source-counted cases | 170 / 2728 |
| Native NotOnDeviceError bindings | 4 |

Static/recovery checks passed: 513 TS/TSX source parse/transpile, schema/migration parity, Academy focused pure runtime, LoadSense focused runtime, migration shell syntax, exact duplicate scan, case collision scan, root JSON duplicate-key scan, credential-pattern scan, conflict-marker scan, Git diff check and Git object integrity.

## Project conversation coverage corrections

Several items previously easy to misclassify are already real code:

- **Message board:** implemented in current source with domain semantics, router/tests and attachment/lifecycle authorization.
- **CVIP/maintenance:** substantial current functionality exists through compliance requirements, roadside panel, fleet shop/work orders and readiness. The remaining work is verification/scheduling depth, not a missing core.
- **Communications driver UI:** real `/comms/package`, `/comms/transmit` and `/comms/status` routes exist. Native offline durability and transmission confirmation still remain.
- **Academy/driver training:** now recovered and integrated rather than candidate-only.

Genuinely missing or incomplete Project requirements include LeaseOS-specific legal/privacy/licensing documents, remote camp/accommodation operations, a unified company-policy portfolio, stronger internal/native authentication, and native field runtime/hardware integrations.

## Release blockers that remain

### High priority software/runtime

- native field runtime and encrypted native persistence;
- full HOS/ELD and short-haul authoritative profiles;
- complete tenant-isolation proof;
- real LoadSense authenticated/native gateway edge;
- full clean/upgrade DB + dependency + build + CI + browser/mobile/native gates;
- B28 widget contract/migration reconciliation;
- communications/licensed data importers and blocked external-source terms.

### Product/governance

- LeaseOS-specific terms/privacy/licensing/DPA stack and authoritative repository licence;
- unified company-policy portfolio;
- remote camp/accommodation operations;
- carrier decisions for regulated certificate signatory authority;
- field pilot and operational release process.

## B28 migration consequence

The recovery branch now owns migrations 0107–0109. B28's historical 0089/0090 pair must not be applied as-is. On this target, 0110/0111 are currently free; the integration PR must recalculate the next-free slots immediately before merge.

## Confidential branch warning

`restricted/chat5-assessor-key` still contains explicitly confidential assessment material. Any full all-branches Git bundle or GitHub-ready repository that includes every ref should be treated as **private**. Do not push that ref to a public repository.

## Promotion recommendation

Treat the Project Recovery branch as the new RC and evidence-complete integration candidate, not as automatically released production code. Run the full repository gate in the intended dependency/database environment, fix any failures there, then promote by a reviewed fast-forward/merge while retaining `archive/pre-project-recovery` and all reconstructed recovery refs.
