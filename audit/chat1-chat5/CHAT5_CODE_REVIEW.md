# Chat5 Academy / readiness code review

## Disposition

Chat5 is valuable new work, but it is **not safe to overlay directly on canonical `main`**. It was authored against a parallel 0087/0088/0089 Academy line while canonical LeaseOS already uses migration slots 0087–0090 for other features. Preserve it as a candidate and port it only after refreshing migration numbering and source contracts.

## Confirmed integration blockers

1. **Migration-number collision.** Canonical `main` already contains `0087_device_safety_latches.sql`, `0088_roadside_panel_grants.sql`, `0089_outbox_lease_and_retry.sql`, and `0090_leave_requests.sql`. Chat5 documentation assumes Academy work at 0087/0088 and proposed checkpoint 0089. Allocate fresh migration slots at merge time; do not reuse these numbers.
2. **Missing Academy SQL in Chat5 archive.** The review/runbook refers to `0087_training_academy_hardening.sql` and `0088_academy_retention_trigger.sql`, but those SQL files are not present in Chat5. The feature cannot be represented as a complete database migration from this archive alone.
3. **Numbered-copy filenames break imports.** `sheetSerialAllocator.test-1.ts` imports `./sheetSerialAllocator`, while the supplied implementation is `sheetSerialAllocator-1.ts`. Those names must be normalized before compilation/integration.
4. **Missing test dependency.** `sheetSerial.test.ts` imports `./stub-vitest`, but no `stub-vitest` module exists in Chat5 or canonical main. The repository uses Vitest; the merge candidate changes this to `vitest`.
5. **Placement contract.** `academyReadinessBridge.ts` imports `./dispatchReadiness`; canonical `dispatchReadiness.ts` lives in `server/_core/`. The bridge should be ported there (or have its import rewritten deliberately), not dropped at repository root.
6. **Migration runner is coupled to an absent trigger.** The Chat5 `apply-migrations.sh` ends by requiring `academyCertificates_retention_guard`. On canonical main today that trigger/migration is absent, so merging the script without the Academy migration would make a healthy non-Academy database fail the gate.
7. **Confidential assessment answer key.** `LEASEOS_ASSESSOR_KEY_CONFIDENTIAL.html` identifies itself as “not for distribution” and contains an answer key. It is preserved on a restricted branch only. If this repository is ever public, do not push that branch.

## Positive checks

- `sheetSerial.ts` passes standalone TypeScript checking under strict mode (`tsc --strict`) with the project’s discriminated-union assumptions.
- `academyReadinessBridge.ts` is structurally compatible with canonical `DispatchBlocker` once placed beside `server/_core/dispatchReadiness.ts`.
- No obvious password/token/private-key literal was found in the Chat5 code by the basic secret-pattern pass.

## Merge approach

Use `upgrade/0087-driver-academy`, then `upgrade/0088-academy-hardening`, then `upgrade/0089-academy-readiness` as evidence/candidate progression. Review `fix/chat5-module-paths-and-vitest`, then follow `integration/chat5-academy-port-plan`. Migration numbers must be allocated against the target branch at merge time.
