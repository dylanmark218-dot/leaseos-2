CREATE TABLE `importBatches` (
  `id` int AUTO_INCREMENT NOT NULL, `batchId` varchar(64) NOT NULL,
  `resourceType` varchar(40) NOT NULL, `jurisdiction` varchar(60) NOT NULL,
  `source` varchar(300) NOT NULL, `sourceReference` varchar(500), `licenceNotes` text,
  `datasetVersion` varchar(60) NOT NULL, `effectiveDate` timestamp,
  `importedAt` timestamp NOT NULL, `recordCount` int NOT NULL, `checksum` varchar(128) NOT NULL,
  `validationStatus` enum('rejected','provisional','validated') NOT NULL DEFAULT 'provisional',
  `confidence` enum('unverified','operator_supplied','authority_confirmed') NOT NULL DEFAULT 'unverified',
  `observedRecords` int, `expectedRecords` int,
  `coverageState` enum('unknown','partial','complete') NOT NULL DEFAULT 'unknown',
  `supersededByBatchId` varchar(64), `supersededAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `importBatches_id` PRIMARY KEY(`id`),
  CONSTRAINT `importBatches_batchId_unique` UNIQUE(`batchId`)
);
--> statement-breakpoint
CREATE INDEX `importBatches_scope_idx` ON `importBatches` (`resourceType`,`jurisdiction`,`supersededAt`);
--> statement-breakpoint
CREATE TABLE `datasetConfirmations` (
  `id` int AUTO_INCREMENT NOT NULL, `batchId` varchar(64) NOT NULL,
  `confirmedByUserId` int NOT NULL, `confirmedByName` varchar(180) NOT NULL,
  `authority` varchar(300) NOT NULL, `authorityReference` varchar(300),
  `confirmedAt` timestamp NOT NULL, `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `datasetConfirmations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `datasetConfirmations_batch_idx` ON `datasetConfirmations` (`batchId`);
--> statement-breakpoint
CREATE TABLE `roadSegments` (
  `id` int AUTO_INCREMENT NOT NULL, `segmentId` varchar(64) NOT NULL,
  `label` varchar(220) NOT NULL, `jurisdiction` varchar(60), `roadClass` varchar(60),
  `surface` varchar(40), `lengthKm` double,
  `startLatitude` double, `startLongitude` double, `endLatitude` double, `endLongitude` double,
  `geometryJson` text, `batchId` varchar(64), `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadSegments_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadSegments_segmentId_unique` UNIQUE(`segmentId`)
);
--> statement-breakpoint
CREATE INDEX `roadSegments_jurisdiction_idx` ON `roadSegments` (`jurisdiction`);
--> statement-breakpoint
CREATE TABLE `segmentAttributes` (
  `id` int AUTO_INCREMENT NOT NULL, `segmentId` varchar(64) NOT NULL,
  `checkKey` varchar(60) NOT NULL, `limitValue` double, `textValue` varchar(120),
  `jurisdiction` varchar(60), `source` varchar(300), `sourceVersion` varchar(60),
  `verifiedAt` timestamp,
  `confidence` enum('unverified','operator_supplied','authority_confirmed') NOT NULL DEFAULT 'unverified',
  `batchId` varchar(64), `effectiveFrom` timestamp, `effectiveTo` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `segmentAttributes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `segmentAttributes_lookup_idx` ON `segmentAttributes` (`segmentId`,`checkKey`);
--> statement-breakpoint
CREATE TABLE `bridges` (
  `id` int AUTO_INCREMENT NOT NULL, `structureId` varchar(64) NOT NULL,
  `label` varchar(220), `segmentId` varchar(64), `latitude` double, `longitude` double,
  `direction` varchar(30), `clearanceM` double, `postedWeightKg` double,
  `postedAxleGroupKg` double, `seasonalRestriction` varchar(160),
  `jurisdiction` varchar(60), `source` varchar(300), `sourceVersion` varchar(60),
  `verifiedAt` timestamp,
  `confidence` enum('unverified','operator_supplied','authority_confirmed') NOT NULL DEFAULT 'unverified',
  `batchId` varchar(64), `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bridges_id` PRIMARY KEY(`id`),
  CONSTRAINT `bridges_structureId_unique` UNIQUE(`structureId`)
);
--> statement-breakpoint
CREATE INDEX `bridges_segment_idx` ON `bridges` (`segmentId`);
--> statement-breakpoint
CREATE TABLE `routeEvidenceEntries` (
  `id` int AUTO_INCREMENT NOT NULL, `routeDecisionId` int,
  `routeProfileId` varchar(64) NOT NULL, `tripId` int, `jobId` int,
  `segmentId` varchar(64) NOT NULL, `segmentLabel` varchar(220),
  `checkKey` varchar(60) NOT NULL,
  `axis` enum('legal','feasible','preferred') NOT NULL,
  `result` enum('pass','fail','review','unknown') NOT NULL,
  `reason` varchar(400) NOT NULL,
  `vehicleValue` double, `limitValue` double, `unit` varchar(20),
  `jurisdiction` varchar(60), `source` varchar(300), `sourceVersion` varchar(60),
  `verifiedAt` timestamp,
  `confidence` enum('unverified','operator_supplied','authority_confirmed') NOT NULL DEFAULT 'unverified',
  `evaluatedAt` timestamp NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `routeEvidenceEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `routeEvidenceEntries_profile_idx` ON `routeEvidenceEntries` (`routeProfileId`);
--> statement-breakpoint
CREATE INDEX `routeEvidenceEntries_trip_idx` ON `routeEvidenceEntries` (`tripId`);
