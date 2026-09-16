-- Project recovery 0109 — LoadSense without a second device/calibration registry.
--
-- The recovered v21 branch had its own LoadSense device and calibration tables.
-- Current LeaseOS already has the canonical `measurementDevices`,
-- `calibrationEvents`, and `measurementDeviceAssignments` registry. 0109 keeps
-- that one source of truth and adds only the material-movement evidence that
-- the modern schema did not already have.

ALTER TABLE `loads`
  MODIFY COLUMN `measurementMethod` enum('meter','scale','loadsense_calibrated','loadsense_uncalibrated','gauge','estimate','customer_stated','unknown') NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `fieldTicketLines`
  MODIFY COLUMN `measurementMethod` enum('meter','scale','loadsense_calibrated','loadsense_uncalibrated','gauge','estimate','customer_stated','system_timed','unknown') NOT NULL DEFAULT 'unknown';
--> statement-breakpoint

CREATE TABLE `loadSenseCalibrationModels` (
  `id` int AUTO_INCREMENT NOT NULL,
  `modelRef` varchar(96) NOT NULL,
  `measurementDeviceId` int NOT NULL,
  `calibrationEventId` int NOT NULL,
  `slope` double NOT NULL,
  `interceptOffset` double NOT NULL,   -- renamed from `offset` (MariaDB reserved word) before first release
  `pointCount` int NOT NULL,
  `rSquared` double,
  `pointsJson` text NOT NULL,
  `status` enum('active','superseded','invalidated') NOT NULL DEFAULT 'active',
  `invalidationReason` varchar(400),
  `effectiveAt` timestamp NOT NULL,
  `invalidatedAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loadSenseCalibrationModels_id` PRIMARY KEY(`id`),
  CONSTRAINT `loadSenseCalibrationModels_modelRef_unique` UNIQUE(`modelRef`)
);
--> statement-breakpoint
CREATE TABLE `loadSenseGatewayFrames` (
  `id` int AUTO_INCREMENT NOT NULL,
  `frameKey` varchar(180) NOT NULL,
  `gatewayDeviceRef` varchar(96) NOT NULL,
  `sequence` int NOT NULL,
  `measurementDeviceId` int,
  `loadId` int,
  `calibrationModelId` int,
  `measuredAt` timestamp NOT NULL,
  `buffered` boolean NOT NULL DEFAULT false,
  `readingsJson` text NOT NULL,
  `vehicleStateJson` text,
  `receivedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loadSenseGatewayFrames_id` PRIMARY KEY(`id`),
  CONSTRAINT `loadSenseGatewayFrames_frameKey_unique` UNIQUE(`frameKey`)
);
--> statement-breakpoint
CREATE TABLE `loadSenseWeightSnapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `snapshotRef` varchar(96) NOT NULL,
  `loadId` int NOT NULL,
  `unitId` int NOT NULL,
  `trailerId` int,
  `jobId` int,
  `tripId` int,
  `measurementDeviceId` int,
  `calibrationModelId` int,
  `measurementSource` enum('estimated','driver_entered','loadsense_uncalibrated','loadsense_calibrated','certified_scale') NOT NULL,
  `tareKg` double NOT NULL,
  `grossKg` double NOT NULL,
  `payloadKg` double NOT NULL,
  `stable` boolean NOT NULL,
  `stabilityScore` double NOT NULL,
  `latitude` double,
  `longitude` double,
  `measuredAt` timestamp NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loadSenseWeightSnapshots_id` PRIMARY KEY(`id`),
  CONSTRAINT `loadSenseWeightSnapshots_snapshotRef_unique` UNIQUE(`snapshotRef`)
);
--> statement-breakpoint
CREATE TABLE `loadSenseAxleWeights` (
  `id` int AUTO_INCREMENT NOT NULL,
  `snapshotId` int NOT NULL,
  `axleGroupKey` varchar(80) NOT NULL,
  `label` varchar(160) NOT NULL,
  `weightKg` double NOT NULL,
  `configuredLimitKg` double,
  `limitSource` varchar(300),
  `status` enum('within','near_limit','over_limit','unknown_limit') NOT NULL,
  `sourceChannelsJson` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loadSenseAxleWeights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `loadSenseScaleReconciliations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `reconciliationRef` varchar(96) NOT NULL,
  `snapshotId` int NOT NULL,
  `certifiedScaleEvidenceId` int,
  `certifiedGrossKg` double NOT NULL,
  `varianceKg` double NOT NULL,
  `variancePercent` double NOT NULL,
  `status` enum('within_tolerance','review','recalibration_recommended') NOT NULL,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loadSenseScaleReconciliations_id` PRIMARY KEY(`id`),
  CONSTRAINT `loadSenseScaleReconciliations_reconciliationRef_unique` UNIQUE(`reconciliationRef`)
);
--> statement-breakpoint
CREATE TABLE `materialDensityProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `profileRef` varchar(96) NOT NULL,
  `materialCode` varchar(160) NOT NULL,
  `densityKgM3` double NOT NULL,
  `source` varchar(400) NOT NULL,
  `verified` boolean NOT NULL DEFAULT false,
  `moistureAdjusted` boolean NOT NULL DEFAULT false,
  `effectiveFrom` timestamp NULL,
  `effectiveTo` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `materialDensityProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `materialDensityProfiles_profileRef_unique` UNIQUE(`profileRef`)
);
