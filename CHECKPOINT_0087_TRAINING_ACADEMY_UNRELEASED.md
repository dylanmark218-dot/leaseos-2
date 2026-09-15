# Checkpoint 0087 — v22.21 Training Academy — UNRELEASED

Date: 2026-09-11
Base: `leaseos-0086-GATE-VERIFIED-UNRELEASED.zip`
Target: v22.21 Training Academy

## Completed in this checkpoint

- Added the 18-table versioned Training Academy schema/migration.
- Reached exact **303 / 303** schema-to-migration table parity.
- Added actual WHMIS, TDG road, ERG, load-securement, company-orientation, Class 1/2/3, air-brake, H2S and First Aid learning content/boundaries.
- Added 50 WHMIS + 75 TDG + 25 ERG banks and 158 total questions.
- Added deterministic randomized assessment snapshots and grading with domain/critical-failure policies.
- Locked final assessments behind current-version required module completion.
- Added separate practical competency sign-off with same-version enforcement and no self-signoff.
- Added source snapshot review gate and external-track certificate refusal.
- Added TDG physical direct-supervision workflow bound to named person/job/time/scope.
- Added training qualification requirements and dispatch blockers with recovery paths.
- Added append-only hash-chained Academy audit events.
- Added first-class Academy authorization and sensitive-action classification.
- Added Training Academy API router and root router mount.
- Added learner-facing `/training-academy` UI and sidebar entry.
- Added pure Academy tests and a dependency-light executable checkpoint script.
- Updated generated-current-state template to describe the Academy.

## Checkpoint validation

PASS:

- `scripts/verify-parity.sh` → `303 / 303 · parity OK`
- pure engine TypeScript compile
- pure behavior harness
- authorization harness
- TypeScript parser checks on all modified TS/TSX/schema files
- `protectedProcedure` source count remains 0

NOT RUN / NOT CLAIMED:

- complete `pnpm test`
- complete `pnpm build`
- full `scripts/ci-gate.sh`
- applying all migrations to a disposable MySQL instance
- database-backed Academy end-to-end tests
- browser/mobile end-to-end interaction tests

Reason: the base archive contains no installable pnpm dependency tree; Corepack attempted to retrieve pnpm from npm and was blocked by the sandbox network, and no disposable MySQL service is available. The repository is therefore packaged as **UNRELEASED**, not gate-verified.

## Recovery / rollback

The checkpoint is packaged separately from 0086. The accompanying diff is generated directly between an untouched extraction of the 0086 base and this 0087 worktree. To roll back, return to the 0086 archive; do not attempt to reverse training records in a production database by deleting audit events.
