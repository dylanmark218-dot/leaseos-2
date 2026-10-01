# Migration 0169 reconciliation — two histories, one schema

**RELEASE BLOCKER — MIGRATION 0169 RECONCILIATION**, as recorded in
`docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`, resolved by a forward migration. Nothing is
renamed. Surveyed 2026-09-23 against `leaseos` `origin/main` = `9bb26516` and this repository's
`main` = `6f52b574` (after PR #10).

## 1. The sequence around 0169, both repositories

`leaseos` (`dylanmark218-dot/leaseos`):

| File | sha256 (first 16) | Introduced by | Depended on by later migrations | Modelled in `schema.ts` |
|---|---|---|---|---|
| `0165_route_approval_coverage.sql` | `e40b1d4b6ff659ad` | `0d3d29b` 2026-09-19 | none | yes |
| `0166_route_evidence_segment_index.sql` | `5e2a60d5b0d19d0f` | `b0ba120` 2026-09-19 | none | yes |
| `0167_route_evaluation_identity.sql` | `d3f0550771b3d84a` | `a6e5201` 2026-09-19 | none | yes |
| `0168_retire_storage_capability_urls.sql` | `5d48512738889205` | `3fae29e` 2026-09-21 | none | yes |
| `0169_trip_stop_provenance.sql` | `1493cdb2b6a107dd` | `9e1a75f` 2026-09-21 07:15 | none (head) | yes — `tripStops.recordedByUserId`, `recordedSource`, `updatedByUserId`, `updatedSource`, `updatedAt` |

`leaseos-2` (this repository):

| File | sha256 (first 16) | Introduced by | Depended on by later migrations | Modelled in `schema.ts` |
|---|---|---|---|---|
| `0165_route_approval_coverage.sql` | `e40b1d4b6ff659ad` | `6ae3856` import | none | yes |
| `0166_route_evidence_segment_index.sql` | `5e2a60d5b0d19d0f` | `6ae3856` import | none | yes |
| `0167_route_evaluation_identity.sql` | `d3f0550771b3d84a` | `6ae3856` import | none | yes |
| `0168_retire_storage_capability_urls.sql` | `5d48512738889205` | `6ae3856` import | none | yes |
| `0169_defect_resolution.sql` | `9e0244ee9fab51b6` | `c72a55a` (PR #4, merged 2026-09-23 16:23) | none by DDL; `readinessComposer.ts`, `recordsRouter.ts`, `recordsService.ts` read its columns | yes — `maintenanceDefects.resolvedAt`, `resolvedByUserId`, `resolvedByReleaseId`, `resolutionNote`; index `maintenanceDefects_unit_state` |
| `0170_dispatch_role_types.sql` | `a8de3a8e5694a6d2` | `0f5ebf0` (PR #9) | 0171 | yes |
| `0171_dispatch_role_assignment_events.sql` | `91d269605b10ad3a` | `bdf2481` (PR #9) | none | yes |
| `0174_dispatch_override_provenance.sql` | `8ca6b2546b3b912a` | `9866075` (PR #12; built as 0172, moved) | none | yes |
| **`0179_trip_stop_provenance.sql`** | this checkpoint | this checkpoint | none | yes — the same five `tripStops` columns as leaseos's 0169 |

0165–0168 are byte-identical in both repositories (same hashes): this repository is a snapshot of
`leaseos` taken between 0168 and 0169. Full hashes of the two 0169 files:

- `leaseos` `0169_trip_stop_provenance.sql`: `1493cdb2b6a107dda5cdf46d5c182871e28de1a91ca21b23d02af68f756d293b`
- `leaseos-2` `0169_defect_resolution.sql`: `9e0244ee9fab51b6c600b2a1139e096ca40168d14dcf9af93f9bcdf0930559ef`

Slots claimed by open branches here at survey time (register scan): 0169 (`print_audit` on two
scanner/tenant branches; `driver_portfolio` moved to 0175), 0170 (four different files on four
branches), 0171–0173, 0174 (`training_compliance_operations` on the academy branch, colliding with
main's 0174), 0175 (two branches), 0176, 0177, 0178. **0179 is the first number free on `main` and
on every open branch.**

## 2. What each 0169 does

`0169_trip_stop_provenance` (leaseos): `ALTER TABLE tripStops ADD COLUMN` × 5, all nullable, no
index — `recordedByUserId INT`, `recordedSource ENUM(proposalFields.source)`, `updatedByUserId INT`,
`updatedSource ENUM(…)`, `updatedAt TIMESTAMP`. Its domain implementation in the same commit:
`tripStops.create` stamps `recordedByUserId` + `driver_typed`; `tripStops.update` stamps
`updatedByUserId`, `updatedSource`, `updatedAt`; the assistant commit stamps `updatedByUserId` and
`updatedAt = committedAt` and deliberately leaves the source NULL; `tripStopProvenance.test.ts`
pins all three writers.

`0169_defect_resolution` (leaseos-2): `ALTER TABLE maintenanceDefects ADD COLUMN` × 4, all nullable
(`resolvedAt`, `resolvedByUserId`, `resolvedByReleaseId`, `resolutionNote`) and one index. Its domain
implementation landed with it in PR #4 (readiness composer, records router and service).

| Schema capability | leaseos | leaseos-2 before | leaseos-2 after 0179 |
|---|---|---|---|
| trip-stop provenance (5 columns) | yes (0169) | no | **yes (0179)** |
| defect-resolution columns + index | **no** — `maintenanceDefects` has none of the four; no readiness-defect code either | yes (0169) | yes |
| Drizzle schema models trip-stop provenance | yes | no | yes |
| Drizzle schema models defect resolution | no | yes | yes |
| tests depending on trip-stop provenance | `tripStopProvenance.test.ts`, `boundaryEvidence.db.test.ts` | — | same two, plus `migration0179.db.test.ts` |
| tests depending on defect resolution | — | `readinessDefectRepair.db.test.ts` | unchanged |

## 3. Applied outside disposable CI?

Not determinable from either repository, and therefore treated as **possibly applied**. The
evidence available:

- This repository's only deployment tooling is `.github/workflows/ci.yml`, which drops and recreates
  a disposable MariaDB for every run. No Dockerfile, fly/render/railway configuration or deploy
  script names a persistent database.
- The migration runner (`scripts/migrate.ts`, `server/_core/migrationLedger.ts`) records every
  applied file's name and sha256 in a `schemaMigrations` table and **refuses to migrate on drift**:
  a renamed or edited file that a ledger already recorded is `DRIFT`, and a ledger row whose file
  is gone is `missing`. That is the mechanism that makes a rename unsafe on any database that has
  ever run `migrate.ts up` or `baseline`.
- `leaseos` carries `audit/v23.25-b23-engines/gate-final.log` and register text describing
  gate runs on developer databases; whether any of those databases still exists is not knowable
  here.

Renaming either 0169 is therefore unsafe in principle and unnecessary in practice.

## 4. Decision

Both 0169 files stay exactly as they are, in their own histories. Convergence is forward:

- **leaseos-2** gains `0179_trip_stop_provenance.sql`: the same five columns, `ADD COLUMN IF NOT
  EXISTS` (MariaDB 10.11), nullable, no index — idempotent by design and safe on a database that was
  baselined from `leaseos` and already carries them. The domain implementation is ported with it
  (the three writers and their test), and the SPINE item 1 receipt reader lands on the columns.
- **leaseos** is **not** given a defect-resolution migration by this checkpoint. Its
  `maintenanceDefects` table has none of the four columns *and* none of the readiness-defect code
  that reads them (PR #4's composer, router and service changes exist only here). A schema
  migration without its domain implementation would be a promise the code there cannot keep. That
  port is a separate, leaseos-side checkpoint: PR #4's code plus a forward migration numbered
  against leaseos's own sequence (its next free slot is 0170, subject to its HS3 ledger claim).

The proof, in CI: gate 2 applies 0001 → 0179 to a clean database; gate 3 (table parity) is
unchanged because 0179 creates no table; `columnParity.test.ts` proves `schema.ts` and the live
database agree column by column; `migration0179.db.test.ts` proves the five columns exist once with
the declared types and that re-running the migration's statements against the migrated schema
succeeds and creates nothing twice.

**Rollback.** This repository has no down migrations. 0179 adds five nullable, un-indexed columns
and nothing else; rolling back is `ALTER TABLE tripStops DROP COLUMN` for each, after removing the
writers in `server/routers.ts` and `server/_core/assistantCommitService.ts` and the reader in
`server/_core/boundaryEvidence.ts`. A ledger that recorded 0179 would then report it `missing`, by
design.
