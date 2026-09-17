-- v22.33 — 0140: the driver-facing half of the facility directory — hours with provenance,
-- call-ahead confirmations, and wait-time reports. A call-ahead is a fact somebody witnessed:
-- who called, whom they spoke to, what was accepted, for how long. It is the "facility
-- confirmation" the compatibility engine asks for, and it expires. A wait report is one
-- person's observation at one time; the current wait is the freshest report, or UNKNOWN.

CREATE TABLE `facilityOperatingHours` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityId` int NOT NULL,
  `dayOfWeek` tinyint NOT NULL,
  `opensAt` char(5) NULL,
  `closesAt` char(5) NULL,
  `closed` boolean NOT NULL DEFAULT false,
  `note` varchar(300) NULL,
  `source` enum('facility_stated','website','regulator','driver_reported','unknown') NOT NULL DEFAULT 'unknown',
  `evidenceId` int NULL,
  `statedAt` timestamp NOT NULL,
  `setByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityOperatingHours_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityOperatingHours_day` UNIQUE(`facilityId`,`dayOfWeek`)
);
--> statement-breakpoint
CREATE TABLE `facilityCallAheads` (
  `id` int AUTO_INCREMENT NOT NULL,
  `callAheadRef` varchar(40) NOT NULL,
  `facilityId` int NOT NULL,
  `loadId` int NULL,
  `wasteCode` varchar(60) NULL,
  `calledByUserId` int NOT NULL,
  `calledAt` timestamp NOT NULL,
  `phoneUsed` varchar(60) NULL,
  `spokeTo` varchar(160) NULL,
  `outcome` enum('accepted','accepted_with_conditions','refused','no_answer','call_back') NOT NULL,
  `conditions` varchar(500) NULL,
  `quotedWaitMinutes` int NULL,
  `validUntil` timestamp NULL,
  `note` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityCallAheads_id` PRIMARY KEY(`id`),
  CONSTRAINT `facilityCallAheads_ref` UNIQUE(`callAheadRef`)
);
--> statement-breakpoint
CREATE INDEX `facilityCallAheads_facility` ON `facilityCallAheads` (`facilityId`,`calledAt`);
--> statement-breakpoint
CREATE INDEX `facilityCallAheads_load` ON `facilityCallAheads` (`loadId`);
--> statement-breakpoint
CREATE TABLE `facilityWaitReports` (
  `id` int AUTO_INCREMENT NOT NULL,
  `facilityId` int NOT NULL,
  `reportedByUserId` int NOT NULL,
  `reportedAt` timestamp NOT NULL,
  `waitMinutes` int NOT NULL,
  `trucksInQueue` int NULL,
  `source` enum('driver_observed','facility_stated','dispatcher_relayed') NOT NULL,
  `note` varchar(300) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `facilityWaitReports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `facilityWaitReports_facility` ON `facilityWaitReports` (`facilityId`,`reportedAt`);
