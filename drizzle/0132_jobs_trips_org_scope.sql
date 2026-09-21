-- v22.25 — 0132 (P4.1, router 1 of many): jobs and trips carry the organization that owns them.
--
-- Until now `jobs.list` and `trips.list` read the whole database. That is
-- correct for one company on one deployment and unsafe for two. Rows created
-- from here on carry the acting organization; rows that predate this carry
-- NULL, which means "the historical single tenant" and is visible only to the
-- `default` scope (see actingScope.SINGLE_TENANT_ID). Nothing is guessed:
-- a legacy row is not assigned to an organization it may not belong to.

ALTER TABLE `jobs` ADD COLUMN `orgRef` varchar(64) NULL;
ALTER TABLE `trips` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `jobs_org_idx` ON `jobs` (`orgRef`,`status`);
--> statement-breakpoint
CREATE INDEX `trips_org_idx` ON `trips` (`orgRef`,`status`);
