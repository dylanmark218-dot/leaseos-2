-- v21.19 — Telematics and video safety.
--
-- Telemetry is evidence: an append-only snapshot of what the unit reported,
-- with its source. A fault code is an OBSERVATION with a count and a span;
-- it becomes a defect only when a mechanic acknowledges it, and its
-- severity is a rule row — unverified, so an active fault is REVIEW, never
-- clear and never BLOCKED by itself. A safety event is reviewed by a person
-- — coached, dismissed, or escalated — and drivers are never scored by a
-- machine. A video clip is a pointer to evidence with a hash, under its own
-- permission; the video itself never leaves the vault.

CREATE TABLE `telemetrySnapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `unitId` int NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `odometerKm` double,
  `engineHours` double,
  `ptoHours` double,
  `idleMinutes` int,
  `fuelLevelPct` double,
  `sourceClientId` int NOT NULL,
  `inboundEventId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `telemetrySnapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `telemetrySnapshots_unit_idx` ON `telemetrySnapshots` (`unitId`, `recordedAt`);
--> statement-breakpoint

CREATE TABLE `faultCodes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `unitId` int NOT NULL,
  `protocol` enum('j1939','obd2','proprietary') NOT NULL,
  `code` varchar(40) NOT NULL,
  `subcode` varchar(20),
  `description` varchar(300),
  `occurrenceCount` int NOT NULL DEFAULT 1,
  `firstSeenAt` timestamp NOT NULL,
  `lastSeenAt` timestamp NOT NULL,
  `status` enum('active','cleared','acknowledged') NOT NULL DEFAULT 'active',
  `severityDetermination` enum('unknown','advisory','inspection_required','critical') NOT NULL DEFAULT 'unknown',
  `severitySource` varchar(120),
  `acknowledgedByUserId` int,
  `acknowledgedAt` timestamp,
  `defectId` int,
  `sourceClientId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `faultCodes_id` PRIMARY KEY(`id`),
  CONSTRAINT `faultCodes_unit_code_unique` UNIQUE(`unitId`,`protocol`,`code`,`subcode`)
);
--> statement-breakpoint

CREATE TABLE `drivingEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `unitId` int NOT NULL,
  `operatorId` int,
  `kind` enum('harsh_brake','rapid_acceleration','harsh_cornering','speeding','seatbelt','distraction','collision_suspected','other') NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `latitude` double,
  `longitude` double,
  `magnitude` double,
  `magnitudeUnit` varchar(20),
  `speedKph` double,
  `postedLimitKph` double,
  `postedLimitSource` varchar(80),
  `videoClipRef` varchar(200),
  `videoClipHash` varchar(64),
  `videoStorageKey` varchar(512),
  `reviewStatus` enum('unreviewed','coached','dismissed','escalated') NOT NULL DEFAULT 'unreviewed',
  `reviewedByUserId` int,
  `reviewedAt` timestamp,
  `reviewNote` varchar(600),
  `sourceClientId` int NOT NULL,
  `inboundEventId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `drivingEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `drivingEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `drivingEvents_unit_idx` ON `drivingEvents` (`unitId`, `recordedAt`);
--> statement-breakpoint

-- Video is looked at under its own permission, and every look is a row.
CREATE TABLE `videoAccessLog` (
  `id` int AUTO_INCREMENT NOT NULL,
  `drivingEventId` int NOT NULL,
  `userId` int NOT NULL,
  `purpose` varchar(200) NOT NULL,
  `at` timestamp NOT NULL,
  CONSTRAINT `videoAccessLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

ALTER TABLE `inboundEvents` MODIFY COLUMN `feed` enum('gps_position','fuel_transaction','eld_duty_status','vehicle_telemetry','fault_code','safety_event','video_clip','generic') NOT NULL;
