-- 0179 — trip-stop row provenance, reconciled forward from the sibling repository's 0169.
--
-- Migration 0169 is claimed twice across the two LeaseOS repositories: leaseos carries
-- `0169_trip_stop_provenance.sql` (commit 9e1a75f, 2026-09-21) and this repository carries
-- `0169_defect_resolution.sql` (PR #4, merged 2026-09-23). Both are applied history in their own
-- repository and neither is renamed: a rename would change a file the ledger has already recorded
-- (`schemaMigrations.checksum`, `migrationLedger.ts`) and read as DRIFT. Convergence is by forward
-- migration instead: this file adds here what leaseos's 0169 added there, and nothing else.
-- See docs/register/MIGRATION_0169_RECONCILIATION.md.
--
-- What the columns mean is unchanged from leaseos's 0169. `tripStops` recorded neither who wrote a
-- stop nor when it was last written. `tripStops.create` and `.update` hold `ctx.user.id` at the
-- write; the assistant commit path holds the actor and the commit instant. `recordedSource`
-- reuses the `proposalFields.source` vocabulary rather than minting a parallel one. NULL is not
-- "unknown": on the assistant path it means the row-level source is not authoritative because
-- provenance is held per FIELD in `proposalFields`, reachable through
-- `assistantCommitReceipts.targetRecordId`.
--
-- `updatedAt` and `updatedByUserId` are what SPINE item 1's receipt reader compares against a
-- receipt's `committedAt` and `actorUserId`: a stop written after its newest assistant commit has
-- no trustworthy committed evidence (server/_core/boundaryEvidence.ts). This is row provenance,
-- not per-boundary confirmation; the resolver derives the latter from committed receipts.
--
-- IF NOT EXISTS: the design intent is idempotent. A database that already carries these columns —
-- one baselined from leaseos, or one this file was run against twice — is left as it is, and no
-- column is created twice. MariaDB 10.11 (the CI and gate database) supports the clause.
--
-- Rollback: this repository has no down migrations. Every column is nullable and nothing here is
-- NOT NULL or indexed, so rolling back is `ALTER TABLE tripStops DROP COLUMN` for the five names
-- below, after removing the writers in server/routers.ts and server/_core/assistantCommitService.ts.
ALTER TABLE `tripStops`
  ADD COLUMN IF NOT EXISTS `recordedByUserId` int NULL,
  ADD COLUMN IF NOT EXISTS `recordedSource` enum('driver_voice','driver_typed','gps','photo_ocr','system_inferred','imported','human_corrected') NULL,
  ADD COLUMN IF NOT EXISTS `updatedByUserId` int NULL,
  ADD COLUMN IF NOT EXISTS `updatedSource` enum('driver_voice','driver_typed','gps','photo_ocr','system_inferred','imported','human_corrected') NULL,
  ADD COLUMN IF NOT EXISTS `updatedAt` timestamp NULL;
