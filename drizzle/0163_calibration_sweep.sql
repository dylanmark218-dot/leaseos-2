-- v22.96 — 0163 (P4.2): the calibration sweep is evidence, not an action.
--
-- Owner decision (2026-09-19): when a device is found out of tolerance, the sweep names the legal
-- axle determinations taken in the examiner's suspect window. It says:
--
--   "These determinations were made during a calibration interval we can no longer fully stand
--    behind and require review."
--
-- It does NOT say "these invoices are wrong." Nothing here touches an invoice, a credit, a payment,
-- a manifest, a ticket, a customer, or the stored verdict on any determination. A human reads the
-- report and decides; anything financial goes through the Commercial Office path it always did,
-- under the separation of duties it always had. Running the sweep grants nobody any new authority.
--
-- Immutable by construction: the report and its findings are written once and never updated. A
-- second look at the same device is a second sweep, so the record shows what was known on each
-- occasion rather than one row that quietly became today's answer.
CREATE TABLE `calibrationSweeps` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sweepRef` varchar(64) NOT NULL,
  `measurementDeviceId` int NOT NULL,
  `calibrationEventId` int NOT NULL,
  -- The examiner's stated window, copied here because the sweep is a statement about a moment and
  -- must not change if somebody later edits the event.
  `suspectFrom` timestamp NOT NULL,
  `suspectTo` timestamp NOT NULL,
  `eventType` varchar(40) NOT NULL,
  `errorFound` varchar(300) NULL,
  `determinationsInQuestion` int NOT NULL DEFAULT 0,
  `measurementsInQuestion` int NOT NULL DEFAULT 0,
  `explanation` varchar(1000) NOT NULL,
  `runByUserId` int NOT NULL,
  `runAt` timestamp NOT NULL DEFAULT (now()),
  -- Triage is the human step. `open` is what raises the single Exception Centre case.
  `state` enum('open','triaged') NOT NULL DEFAULT 'open',
  `triagedByUserId` int NULL,
  `triagedAt` timestamp NULL,
  `triageNote` varchar(1000) NULL,
  CONSTRAINT `calibrationSweeps_id` PRIMARY KEY(`id`),
  CONSTRAINT `cs_ref` UNIQUE(`sweepRef`)
);
--> statement-breakpoint
CREATE INDEX `cs_device` ON `calibrationSweeps` (`measurementDeviceId`, `state`);
--> statement-breakpoint
-- One row per reading inside the window. `wasLegalDetermination` is copied from the snapshot as it
-- stood: the sweep records what was relied on, and does not re-derive it later against a
-- calibration that has since been invalidated — which is the whole reason 0159 stored the verdict.
CREATE TABLE `calibrationSweepFindings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sweepId` int NOT NULL,
  `snapshotId` int NOT NULL,
  `snapshotRef` varchar(64) NOT NULL,
  `measuredAt` timestamp NOT NULL,
  `loadId` int NULL,
  `wasLegalDetermination` tinyint(1) NOT NULL,
  `determinationBasis` varchar(500) NULL,
  CONSTRAINT `calibrationSweepFindings_id` PRIMARY KEY(`id`),
  CONSTRAINT `csf_unique` UNIQUE(`sweepId`, `snapshotId`)
);
--> statement-breakpoint
CREATE INDEX `csf_sweep` ON `calibrationSweepFindings` (`sweepId`, `wasLegalDetermination`);
