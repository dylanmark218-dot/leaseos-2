-- 0169 — a maintenance defect can be resolved, and the row says by whom and on what evidence.
--
-- `maintenanceDefects.status` has carried `resolved` since the table was created, and production
-- code already depends on it: `telematicsRouter` refuses to clear a fault code until "the defect it
-- became" is resolved, and the readiness composer reads defect status to decide whether a unit may
-- move. But there was no write path. Five production sites insert a defect; none ever updated one.
-- So `resolved` was a state the schema promised, one live code path required, and nothing could
-- produce — and readiness filled the gap by inferring resolution from release chronology, which is
-- the defect this migration exists to make fixable (X-1 … X-5).
--
-- Three provenance columns rather than reusing `completedAt`: that column is written by nothing and
-- its meaning was never declared, and quietly giving an unclaimed column a new meaning is how the
-- next reader gets it wrong. `resolvedByReleaseId` is the load-bearing one — it is what lets
-- readiness notice that the release which evidenced a resolution was later revoked.
ALTER TABLE `maintenanceDefects`
  ADD COLUMN `resolvedAt` timestamp NULL,
  ADD COLUMN `resolvedByUserId` int NULL,
  ADD COLUMN `resolvedByReleaseId` int NULL,
  ADD COLUMN `resolutionNote` varchar(400) NULL;
--> statement-breakpoint
-- Readiness asks "are there unresolved critical defects on this unit" on every composition.
CREATE INDEX `maintenanceDefects_unit_state` ON `maintenanceDefects` (`unitId`, `severity`, `status`);
