-- 0200 — Fleet & Equipment Portfolio, foundation slice: holds, the meter ledger, and the portfolio's history.
-- Design: docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md §A.14, as reconciled in
-- docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md. The trigger DDL is 0201, in its own file.
--
-- Deliberately not here (reconciliation R-7): the identity and lifecycle columns on `units`, and
-- `unitComponents`. Nothing here copies a figure another table already holds.

-- A hold a person or an owning workflow placed, with a typed reason. Holds that ARE other records — a
-- critical defect, a government order, an open roadside event, a critical fault — are not rows here:
-- they are read from their source, and releasing them means acting on the source. Released rows stay.
--
-- `dispatchEffect` (R-1): `warn`, `block`, or `out_of_service`, and `out_of_service` exactly when the
-- hold type is `safety`. `sourceKind` includes `defect` and `work_order` (R-6) so the mechanic portal
-- places its holds here rather than in a table of its own.
CREATE TABLE `unitHolds` (
  `id` int AUTO_INCREMENT NOT NULL,
  `holdRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `unitId` int NOT NULL,
  `holdType` enum('safety','maintenance','inspection','compliance','damage','administrative') NOT NULL,
  `dispatchEffect` enum('warn','block','out_of_service') NOT NULL,
  `reason` varchar(600) NOT NULL,
  `sourceKind` enum('manual','incident','damage_report','inspection','document_expiry','defect','work_order','enforcement') NOT NULL DEFAULT 'manual',
  `sourceRef` varchar(120) NULL,
  `evidenceRecordId` int NULL,
  `placedByUserId` int NOT NULL,
  `placedByRole` varchar(40) NOT NULL,
  `placedAt` timestamp NOT NULL,
  `status` enum('active','released') NOT NULL DEFAULT 'active',
  `releasedAt` timestamp NULL,
  `releasedByUserId` int NULL,
  `releasedByRole` varchar(40) NULL,
  `releaseReason` varchar(600) NULL,
  `releaseEvidenceRecordId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitHolds_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitHolds_holdRef_unique` UNIQUE(`holdRef`)
);
--> statement-breakpoint
CREATE INDEX `unitHolds_unit_active_idx` ON `unitHolds` (`unitId`, `status`, `holdType`);
--> statement-breakpoint

-- Meter readings that have no home elsewhere: a mechanic's, an inspection's, a job closeout's, an
-- import. Telemetry, work-order, fuel, trip and tire figures stay where they are and are read beside
-- these with their source (master-manifest rule 3: one fact, one source). A reading is never edited:
-- 0201 refuses any change to what was observed. Verification is a separate decision on the row, by a
-- second person, and a rejected reading stays on record.
CREATE TABLE `unitMeterReadings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `readingRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `unitId` int NOT NULL,
  `meterType` enum('odometer_km','engine_hours','pto_hours','pump_hours','blower_hours','compressor_hours','generator_hours','other') NOT NULL,
  `reading` double NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `source` enum('driver_manual','mechanic','inspection','job_closeout','imported') NOT NULL,
  `sourceRef` varchar(120) NULL,
  `enteredByUserId` int NOT NULL,
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `verificationStatus` enum('unverified','verified','rejected') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int NULL,
  `verifiedAt` timestamp NULL,
  `note` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitMeterReadings_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitMeterReadings_readingRef_unique` UNIQUE(`readingRef`)
);
--> statement-breakpoint
CREATE INDEX `unitMeterReadings_unit_idx` ON `unitMeterReadings` (`unitId`, `meterType`, `recordedAt`);
--> statement-breakpoint

-- The portfolio's own append-only record (the driverPortfolioEvents pattern). 0201 refuses UPDATE and
-- DELETE on it.
CREATE TABLE `fleetPortfolioEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `unitId` int NOT NULL,
  `subjectType` varchar(40) NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `eventType` enum('asset_created','asset_edited','lifecycle_changed','hold_placed','hold_released','component_attached','component_detached','meter_recorded','meter_verified','meter_rejected','document_recorded','document_verified','inspection_recorded','defect_reported','portfolio_viewed','used_for_dispatch') NOT NULL,
  `previousState` varchar(80) NULL,
  `newState` varchar(80) NULL,
  `detail` varchar(600) NULL,
  `actorUserId` int NULL,
  `actorRole` varchar(40) NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fleetPortfolioEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `fleetPortfolioEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `fleetPortfolioEvents_unit_idx` ON `fleetPortfolioEvents` (`unitId`, `id`);
--> statement-breakpoint
CREATE INDEX `fleetPortfolioEvents_org_idx` ON `fleetPortfolioEvents` (`orgRef`, `occurredAt`);
