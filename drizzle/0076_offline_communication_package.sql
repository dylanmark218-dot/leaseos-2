-- v22.19 — The offline communication package.
--
-- Everything to here assumed a server the truck can reach. The road where the
-- communication plan matters most is the road where nothing can be fetched, so
-- the plan is sealed before departure and carried.
--
-- A package is a snapshot and is never edited. A driver 60 km up a resource
-- road is acting on what they downloaded this morning, and a record that
-- quietly changed underneath them would make the evidence trail a lie. When the
-- world moves the package does not: `dependencyHash` makes it stale by
-- arithmetic, and `communicationPackageDownloads` says who is carrying which
-- version, so "tomorrow's trip affected" is a query rather than a hope.

CREATE TABLE `communicationPackages` (
  `id` int AUTO_INCREMENT NOT NULL,
  `packageRef` varchar(64) NOT NULL,
  `label` varchar(220) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `planRef` varchar(64),
  `routeApprovalRef` varchar(64),
  `tripId` int,
  `jobId` int,
  `unitId` int,
  `buildRef` varchar(64),
  `segmentIdsJson` text NOT NULL,
  `contentJson` longtext NOT NULL,
  `manifestHash` varchar(64) NOT NULL,
  `dependencyJson` text NOT NULL,
  `dependencyHash` varchar(64) NOT NULL,
  `verdict` enum('covered','gaps','unknown') NOT NULL,
  `totalKm` double NOT NULL DEFAULT 0,
  `zoneCount` int NOT NULL DEFAULT 0,
  `channelCount` int NOT NULL DEFAULT 0,
  `unverifiedChannelCount` int NOT NULL DEFAULT 0,
  `retiredExcludedCount` int NOT NULL DEFAULT 0,
  `mustCallCount` int NOT NULL DEFAULT 0,
  `zonesWithoutChannel` int NOT NULL DEFAULT 0,
  `status` enum('current','superseded','stale') NOT NULL DEFAULT 'current',
  `staleReasonsJson` text,
  `stalenessDetectedAt` timestamp NULL,
  `supersedesPackageRef` varchar(64),
  `builtByUserId` int NOT NULL,
  `builtAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `communicationPackages_id` PRIMARY KEY(`id`),
  CONSTRAINT `communicationPackages_ref_unique` UNIQUE(`packageRef`)
);
--> statement-breakpoint
CREATE INDEX `communicationPackages_label` ON `communicationPackages` (`label`, `status`);
--> statement-breakpoint
CREATE INDEX `communicationPackages_trip` ON `communicationPackages` (`tripId`, `builtAt`);
--> statement-breakpoint

-- Who took what onto which device. Dispatch cannot see a tablet 60 km up a
-- road, but it can see what that tablet was handed and when.
CREATE TABLE `communicationPackageDownloads` (
  `id` int AUTO_INCREMENT NOT NULL,
  `downloadRef` varchar(64) NOT NULL,
  `packageRef` varchar(64) NOT NULL,
  `manifestHash` varchar(64) NOT NULL,
  `deviceRef` varchar(80),
  `userId` int NOT NULL,
  `tripId` int,
  `downloadedAt` timestamp NOT NULL DEFAULT (now()),
  `acknowledgedAt` timestamp NULL,
  CONSTRAINT `communicationPackageDownloads_id` PRIMARY KEY(`id`),
  CONSTRAINT `communicationPackageDownloads_ref_unique` UNIQUE(`downloadRef`)
);
--> statement-breakpoint
CREATE INDEX `communicationPackageDownloads_package` ON `communicationPackageDownloads` (`packageRef`, `downloadedAt`);
--> statement-breakpoint
CREATE INDEX `communicationPackageDownloads_user` ON `communicationPackageDownloads` (`userId`, `downloadedAt`);
