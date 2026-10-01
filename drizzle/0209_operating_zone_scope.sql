-- 0209 — P0-A2.1: an operating zone is one organization's geofence, and the GPS engine reads only
-- the trip's organization's zones.
--
-- Slot: main ends at 0198 (0197 unused). Every remote branch was scanned on 2026-10-01: numbers
-- 0199–0208 are held by open branches (driver portfolio 0202–0204, auth workspace 0207–0208, and
-- others), see docs/architecture/MIGRATION_COLLISION_REGISTER.md. This takes 0209, the first number
-- no branch holds.
--
-- Until now `operatingZones` carried no owner. Any dispatcher, office or management user of any
-- organization could create one (operatingZones.create, reference.write), every organization's
-- list returned it with its name, coordinates and radius, and `listActiveOperatingZones()` fed
-- every active zone to the geofence engine for every trip — so company A's loading pad produced
-- pending enter/exit proposals on company B's trips (reproduced 2026-10-01, P0-A2.1 OZ-T1..T5).
--
-- A zone is tenant configuration, not a fact about the world: the product manifest's zone engine
-- lists yards, home terminals, staging and muster zones; the admin screen tunes radius per site by
-- its own rejection rate; and a zone's only consumer turns a position into an arrival on that
-- organization's trip stop. As jobs and trips (0132) and rate cards (0148): rows created from here
-- on carry the acting organization; rows that predate this carry NULL, which means "the historical
-- single tenant" and is reachable only by the `default` scope (actingScope.SINGLE_TENANT_ID) and
-- evaluated only for trips that carry no organization. Nothing is guessed: a legacy zone is not
-- assigned to an organization it may not belong to.

ALTER TABLE `operatingZones` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `operatingZones_org` ON `operatingZones` (`orgRef`,`active`);
