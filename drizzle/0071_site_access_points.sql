-- v22.14 — Legal land in both directions, and the entrance as its own record.
--
-- `siteAccessPoints` — a lease has entrances, not a pin. Each is proposed
-- (from the imported grid and roads) or reported by a driver, and becomes
-- confirmed only when a person confirms it; confirmations accumulate with
-- the trip they came from, so confidence is a count of evidence, never an
-- assertion. What a configuration has actually been driven through is
-- recorded as a fingerprint, because one truck's passage does not prove
-- another's.

CREATE TABLE `siteAccessPoints` (
  `id` int AUTO_INCREMENT NOT NULL,
  `accessRef` varchar(64) NOT NULL,
  `locationIdentityId` int,
  `lsdCanonical` varchar(64) NOT NULL,
  `label` varchar(180) NOT NULL,
  `accessKind` enum('lease_entrance','emergency_access','alternate_entrance','staging','unknown') NOT NULL DEFAULT 'lease_entrance',
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `approachRoadObjectId` int,
  `approachRoadLabel` varchar(220),
  `approachSurfaceKind` varchar(20),
  `metresFromParcelCentroid` int,
  `touchesParcel` boolean NOT NULL DEFAULT false,
  `gatePresent` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `turnaroundCapability` enum('confirmed','none','unknown') NOT NULL DEFAULT 'unknown',
  `status` enum('proposed','confirmed','rejected','superseded') NOT NULL DEFAULT 'proposed',
  `preferred` boolean NOT NULL DEFAULT false,
  `originKind` enum('derived_from_grid','driver_reported','office_recorded') NOT NULL,
  `originDetail` varchar(400),
  `proposedByUserId` int NOT NULL,
  `proposedAt` timestamp NOT NULL DEFAULT (now()),
  `confirmedByUserId` int,
  `confirmedAt` timestamp NULL,
  `rejectionReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `siteAccessPoints_id` PRIMARY KEY(`id`),
  CONSTRAINT `siteAccessPoints_accessRef_unique` UNIQUE(`accessRef`)
);
--> statement-breakpoint
CREATE INDEX `siteAccessPoints_lsd` ON `siteAccessPoints` (`lsdCanonical`, `status`);
--> statement-breakpoint

CREATE TABLE `siteAccessConfirmations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `siteAccessPointId` int NOT NULL,
  `tripId` int,
  `unitId` int,
  `operatorId` int,
  `configurationFingerprint` varchar(120),
  `outcome` enum('reached','could_not_reach','reached_with_difficulty') NOT NULL,
  `detail` varchar(400),
  `observedAt` timestamp NOT NULL,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `siteAccessConfirmations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `siteAccessConfirmations_point` ON `siteAccessConfirmations` (`siteAccessPointId`);
