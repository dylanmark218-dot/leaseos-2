# Checkpoint 0088 — Academy hardening + reconciliation

**Release label:** UNRELEASED  
**Target:** v22.22  
**Date:** 2026-09-11

## Closed from 0087 review

- Regulated TDG road expiry is computed server-side from `REG-TDG-ROAD-V1`; callers cannot supply an absolute regulated expiry.
- TDG road certificate lifecycle now captures the required employee/employer/place-of-business/training-aspect snapshots, employer-representative + employee signatures, and remains `pending_signature` until finalization.
- Employer reasonable-grounds attestation is explicit and persisted.
- `retentionUntil` is computed and a DB trigger blocks early deletion.
- Statements of experience are modelled and can be attached to re-issuance.
- Source tier is stored; vendor/unknown sources cannot govern certificate issuance.
- US road TDG recognition is modelled and requires an already verified compliance document tied to the user.
- v7/v8 dangerous-goods assistant, securement helper, waste routing, driver-qualification engine and source-backed knowledge store are reconciled forward.
- Duplicate `regulatedTrainingCatalog.ts` is deliberately retired in favour of the versioned Academy catalog.
- Blocker-matrix coverage is materially expanded.
- Learner UI can sign and activate its own pending regulated certificate.

## Validation performed here

- Schema/migration `CREATE TABLE` parity: **307 / 307**.
- Migration files: **86**.
- Pure engines (`trainingAcademy`, regulatory hardening, compliance Secretary, driver qualification) compile with TypeScript.
- Executable standalone hardening checkpoint: **PASS**.
- Current-state generator and structural counts rerun after the changes.
- Parser/static validation is run against modified TS/TSX before packaging.

## Not run / cannot truthfully claim green here

- complete pnpm dependency-backed Vitest suite
- Vite production build
- `scripts/ci-gate.sh` in its intended full environment
- application of all 86 migrations to a disposable MySQL instance
- DB-backed Academy end-to-end issuance/signature/retention tests

Until those are green, this package remains **UNRELEASED**, not GATE-VERIFIED.
