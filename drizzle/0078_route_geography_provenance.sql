-- LeaseOS v22.20 candidate — route geography provenance.
--
-- Do NOT backfill historical approvals with the current graph build. An old
-- approval did not record that fact, and inventing it would make provenance
-- look stronger than it is. Historical NULL means exactly "not recorded".

ALTER TABLE `routeApprovals`
  ADD COLUMN `buildRef` varchar(64) NULL AFTER `destinationRef`;
--> statement-breakpoint
CREATE INDEX `routeApprovals_build` ON `routeApprovals` (`buildRef`, `status`);
