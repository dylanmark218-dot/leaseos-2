-- v23.26 — 0179: the canonical ELD event ledger, append-only, and the conflict ledger beside it.
--
-- An electronic logging device produces a legal record, and a legal record is never rewritten.
-- Until now the only duty-status store was `dutyRecords` (0008): mutable, untenanted, with no device
-- identity, no sequence and no hash. Nothing that reached it could be proven to be what a device
-- recorded. This migration adds the record that can be.
--
-- Two tables, kept apart on purpose:
--
--   eldEvents                  exactly one canonical accepted event per stable event reference
--                              (a device-minted UUID) and per (enrolled device, device-local
--                              sequence). Guarded below against UPDATE and DELETE.
--   eldEventIngestConflicts    every attempted message that collided with an existing event
--                              reference or device sequence while carrying different content.
--                              Nothing here overwrites the canonical row; the attempt is kept
--                              whole so the discrepancy can be investigated.
--
-- Corrections are additional rows: a later event names the one it supersedes through
-- `supersedesEventRef`. Whether a row is "active" is derived from that column by readers, never
-- stored on the row it would have to mutate.
--
-- What is deliberately NOT here: hours remaining, compliance verdicts, diagnostic status, review
-- state. Those are computed from this ledger and live elsewhere. A column on the legal record that
-- a later process would have to update is a column that makes the record mutable.
--
-- Tenant: `orgRef` is NOT NULL. The organization is the enrolled device's (`fieldDevices.orgRef`,
-- 0110), never a value the client sent. A device with no organization binding cannot append.
--
-- Hashes (version `eld-h1`): `payloadHash` = SHA-256 of `canonicalJson`; `eventHash` = SHA-256 of
-- "eld-h1\n<previousEventHash or empty>\n<payloadHash>". Both are computable on the device from
-- what the device knows, so a device can verify what the server holds. `previousEventHash` is the
-- device's own claim about its previous event; the server compares it to the predecessor's stored
-- `eventHash` when that row exists, and reports (does not store) the verdict.

CREATE TABLE `eldEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `fieldDeviceId` int NULL,
  `deviceSequence` bigint NULL,
  `operatorId` int NULL,
  `unitId` int NULL,
  `eventType` varchar(40) NOT NULL,
  `eventCode` varchar(40) NULL,
  `dutyStatus` enum('driving','on_duty','sleeper_berth','off_duty') NULL,
  `recordOrigin` enum('automatic','driver','office_edit','assumed_unidentified','integration','legacy') NOT NULL,
  `sourceKind` enum('field_device','integration_client','office','migration') NOT NULL,
  `sourceRef` varchar(120) NULL,
  `eventAt` timestamp(3) NOT NULL,
  `eventUtcOffsetMinutes` smallint NULL,
  `receivedAt` timestamp(3) NOT NULL,
  `latitude` double NULL,
  `longitude` double NULL,
  `locationAccuracyM` double NULL,
  `locationSource` enum('gps','network','manual','ecm','none') NULL,
  `jurisdiction` varchar(8) NULL,
  `odometerKm` double NULL,
  `engineHours` double NULL,
  `vehicleSpeedKph` double NULL,
  `annotation` varchar(500) NULL,
  `supersedesEventRef` varchar(64) NULL,
  `canonicalJson` text NOT NULL,
  `payloadHash` char(64) NOT NULL,
  `previousEventHash` char(64) NULL,
  `eventHash` char(64) NOT NULL,
  `hashVersion` varchar(16) NOT NULL DEFAULT 'eld-h1',
  `submittedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `eldEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `eldEvents_eventRef_unique` UNIQUE(`eventRef`),
  CONSTRAINT `eldEvents_device_sequence_unique` UNIQUE(`fieldDeviceId`, `deviceSequence`)
);
--> statement-breakpoint
CREATE INDEX `eldEvents_operator_time` ON `eldEvents` (`operatorId`, `eventAt`);
--> statement-breakpoint
CREATE INDEX `eldEvents_unit_time` ON `eldEvents` (`unitId`, `eventAt`);
--> statement-breakpoint
CREATE INDEX `eldEvents_org_time` ON `eldEvents` (`orgRef`, `eventAt`);
--> statement-breakpoint
CREATE INDEX `eldEvents_supersedes` ON `eldEvents` (`supersedesEventRef`);
--> statement-breakpoint

CREATE TABLE `eldEventIngestConflicts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `conflictRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `fieldDeviceId` int NULL,
  `collisionKind` enum('event_ref','device_sequence') NOT NULL,
  `canonicalEventId` int NOT NULL,
  `canonicalEventRef` varchar(64) NOT NULL,
  `canonicalPayloadHash` char(64) NOT NULL,
  `canonicalEventHash` char(64) NOT NULL,
  `attemptedEventRef` varchar(64) NOT NULL,
  `attemptedDeviceSequence` bigint NULL,
  `attemptedCanonicalJson` text NOT NULL,
  `attemptedPayloadHash` char(64) NOT NULL,
  `attemptedPreviousEventHash` char(64) NULL,
  `attemptedEventHash` char(64) NOT NULL,
  `hashVersion` varchar(16) NOT NULL DEFAULT 'eld-h1',
  `sourceKind` enum('field_device','integration_client','office','migration') NOT NULL,
  `sourceRef` varchar(120) NULL,
  `submittedByUserId` int NULL,
  `receivedAt` timestamp(3) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `eldEventIngestConflicts_id` PRIMARY KEY(`id`),
  CONSTRAINT `eldEventIngestConflicts_ref_unique` UNIQUE(`conflictRef`),
  CONSTRAINT `eldEventIngestConflicts_attempt_unique` UNIQUE(`canonicalEventId`, `attemptedEventHash`)
);
--> statement-breakpoint
CREATE INDEX `eldEventIngestConflicts_device` ON `eldEventIngestConflicts` (`fieldDeviceId`, `receivedAt`);
--> statement-breakpoint
CREATE INDEX `eldEventIngestConflicts_org` ON `eldEventIngestConflicts` (`orgRef`, `receivedAt`);
--> statement-breakpoint

-- The guards. Single-statement triggers, the 0061/0062 form: no BEGIN/END body, so the migration
-- runner needs no DELIMITER handling. A correction is a new row; there is no legitimate UPDATE.
CREATE TRIGGER `eldEvents_immutable_update` BEFORE UPDATE ON `eldEvents` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldEvents is append-only: a correction is a new event that names the one it supersedes';
--> statement-breakpoint
CREATE TRIGGER `eldEvents_immutable_delete` BEFORE DELETE ON `eldEvents` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldEvents is append-only: an ELD event is never deleted';
--> statement-breakpoint
CREATE TRIGGER `eldEventIngestConflicts_immutable_update` BEFORE UPDATE ON `eldEventIngestConflicts` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldEventIngestConflicts is evidence and is never edited';
--> statement-breakpoint
CREATE TRIGGER `eldEventIngestConflicts_immutable_delete` BEFORE DELETE ON `eldEventIngestConflicts` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'eldEventIngestConflicts is evidence and is never deleted';
