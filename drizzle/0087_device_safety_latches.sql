-- v22.20 — 0087: what a device says it is holding.
--
-- A tablet that has recorded a confirmed out-of-service order blocks the truck
-- locally before the server has heard of it. This is the server's record of
-- that claim — and it is a claim, not an order. A device reporting a latch does
-- not create a prohibition: it tells the office that a truck is locally
-- stopped, which is information dispatch needs before the paperwork arrives.
--
-- `liftAuthority` is the only column that can clear one, and it is never set
-- from a device report. It is set when the server has an authoritative released
-- or rescinded order to point at.

CREATE TABLE `deviceSafetyLatches` (
  `id` int AUTO_INCREMENT NOT NULL,
  `latchRef` varchar(64) NOT NULL,
  `deviceRef` varchar(64),
  `reportedByUserId` int NOT NULL,
  `captureLocalId` varchar(120) NOT NULL,
  `subjectType` enum('driver','vehicle','trailer','cargo','carrier') NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `capturedAt` timestamp NOT NULL,
  `latitude` double,
  `longitude` double,
  `note` varchar(400),
  `serverEventRef` varchar(64),
  `serverOrderRef` varchar(64),
  `state` enum('blocking','lifted') NOT NULL DEFAULT 'blocking',
  `liftAuthority` enum('released','rescinded'),
  `liftedAt` timestamp NULL,
  `reportedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `deviceSafetyLatches_id` PRIMARY KEY(`id`),
  CONSTRAINT `deviceSafetyLatches_ref_unique` UNIQUE(`latchRef`),
  -- One latch per capture per reporter. A device retrying its report is the
  -- normal case on a bad connection, not a second truck being stopped.
  CONSTRAINT `deviceSafetyLatches_capture_unique` UNIQUE(`reportedByUserId`, `captureLocalId`)
);
--> statement-breakpoint
CREATE INDEX `deviceSafetyLatches_subject` ON `deviceSafetyLatches` (`subjectRef`, `state`);
