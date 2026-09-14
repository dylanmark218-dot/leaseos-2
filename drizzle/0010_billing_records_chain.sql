CREATE TABLE `trackingSequences` (
  `id` int AUTO_INCREMENT NOT NULL, `sequenceType` varchar(24) NOT NULL,
  `branch` varchar(12), `periodKey` varchar(16) NOT NULL, `nextNumber` int NOT NULL DEFAULT 1,
  `prefix` varchar(12) NOT NULL, `separator` varchar(4) NOT NULL DEFAULT '-',
  `yearDigits` int NOT NULL DEFAULT 4, `includeMonth` boolean NOT NULL DEFAULT false,
  `sequenceDigits` int NOT NULL DEFAULT 6,
  `resetPeriod` enum('never','yearly','monthly') NOT NULL DEFAULT 'yearly',
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `trackingSequences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trackingSequences_scope_idx` ON `trackingSequences` (`sequenceType`,`branch`,`periodKey`);
--> statement-breakpoint
CREATE TABLE `trackingReferences` (
  `id` int AUTO_INCREMENT NOT NULL, `trackingNumber` varchar(64) NOT NULL,
  `entityType` varchar(40) NOT NULL, `entityId` int NOT NULL,
  `parentTrackingNumber` varchar(64), `jobId` int, `issuedAt` timestamp NOT NULL,
  `issuedByUserId` int, `onBehalfOfOperatorId` int, `delegationReason` varchar(220),
  `deviceId` varchar(120), `sessionId` varchar(120),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `trackingReferences_id` PRIMARY KEY(`id`),
  CONSTRAINT `trackingReferences_trackingNumber_unique` UNIQUE(`trackingNumber`)
);
--> statement-breakpoint
CREATE INDEX `trackingReferences_entity_idx` ON `trackingReferences` (`entityType`,`entityId`);
--> statement-breakpoint
CREATE INDEX `trackingReferences_job_idx` ON `trackingReferences` (`jobId`);
--> statement-breakpoint
CREATE INDEX `trackingReferences_parent_idx` ON `trackingReferences` (`parentTrackingNumber`);
--> statement-breakpoint
CREATE TABLE `billingBooks` (
  `id` int AUTO_INCREMENT NOT NULL, `bookNumber` varchar(64) NOT NULL, `jobId` int NOT NULL,
  `customer` varchar(220) NOT NULL, `afeNumber` varchar(80), `costCenter` varchar(80),
  `purchaseOrder` varchar(80), `chargedToUwi` varchar(120), `rateCardId` int,
  `billingState` enum('draft','operations_complete','documents_complete','disposal_verified','logs_complete','billing_review','approved','invoiced','disputed','closed') NOT NULL DEFAULT 'draft',
  `blockedReasons` text, `openedAt` timestamp NOT NULL, `closedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()), `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billingBooks_id` PRIMARY KEY(`id`),
  CONSTRAINT `billingBooks_bookNumber_unique` UNIQUE(`bookNumber`)
);
--> statement-breakpoint
CREATE TABLE `loads` (
  `id` int AUTO_INCREMENT NOT NULL, `loadNumber` varchar(64) NOT NULL, `jobId` int NOT NULL,
  `tripId` int, `billingBookId` int, `loadStopId` int, `unloadStopId` int,
  `operatorId` int, `unitId` int, `material` varchar(220), `quantity` double,
  `quantityUnit` varchar(30),
  `measurementMethod` enum('meter','scale','gauge','estimate','customer_stated','unknown') NOT NULL DEFAULT 'unknown',
  `loadTicketNumber` varchar(64),
  `chainState` enum('created','material_identified','loaded','in_transit','arrived_disposal','weighed','unloaded','disposal_verified','billed') NOT NULL DEFAULT 'created',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `loads_id` PRIMARY KEY(`id`), CONSTRAINT `loads_loadNumber_unique` UNIQUE(`loadNumber`)
);
--> statement-breakpoint
CREATE TABLE `disposalBatches` (
  `id` int AUTO_INCREMENT NOT NULL, `batchNumber` varchar(64) NOT NULL, `facilityId` int,
  `jobId` int, `openedAt` timestamp NOT NULL, `closedAt` timestamp,
  `totalQuantity` double, `quantityUnit` varchar(30),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `disposalBatches_id` PRIMARY KEY(`id`),
  CONSTRAINT `disposalBatches_batchNumber_unique` UNIQUE(`batchNumber`)
);
--> statement-breakpoint
CREATE TABLE `disposalTickets` (
  `id` int AUTO_INCREMENT NOT NULL, `ticketNumber` varchar(64) NOT NULL, `loadId` int,
  `disposalBatchId` int, `jobId` int, `tripId` int, `facilityId` int, `operatorId` int,
  `unitId` int, `facilityTicketNumber` varchar(80), `scaleInAt` timestamp,
  `grossKg` double, `tareKg` double, `netKg` double, `quantity` double,
  `quantityUnit` varchar(30),
  `verificationStatus` enum('unverified','needs_review','verified','rejected') NOT NULL DEFAULT 'unverified',
  `source` varchar(80), `confidence` enum('low','medium','high') NOT NULL DEFAULT 'low',
  `evidenceRefs` text, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `disposalTickets_id` PRIMARY KEY(`id`),
  CONSTRAINT `disposalTickets_ticketNumber_unique` UNIQUE(`ticketNumber`)
);
--> statement-breakpoint
CREATE TABLE `dailyLogs` (
  `id` int AUTO_INCREMENT NOT NULL, `logNumber` varchar(64) NOT NULL, `operatorId` int NOT NULL,
  `logDate` timestamp NOT NULL, `reportingLocation` varchar(220), `reportedAt` timestamp,
  `releasedAt` timestamp, `totalOnDutyMinutes` double,
  `completenessPercent` int NOT NULL DEFAULT 0,
  `status` enum('open','submitted','office_review','certified','amended') NOT NULL DEFAULT 'open',
  `paperFallbackRef` varchar(64), `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dailyLogs_id` PRIMARY KEY(`id`),
  CONSTRAINT `dailyLogs_logNumber_unique` UNIQUE(`logNumber`)
);
--> statement-breakpoint
CREATE TABLE `fieldTickets` (
  `id` int AUTO_INCREMENT NOT NULL, `ticketNumber` varchar(64) NOT NULL,
  `scope` enum('job','trip','load','service_event') NOT NULL DEFAULT 'load',
  `jobId` int NOT NULL, `tripId` int, `loadId` int, `billingBookId` int,
  `siteLocationId` int, `operatorId` int, `unitId` int,
  `serviceDescription` varchar(220), `startedAt` timestamp, `completedAt` timestamp,
  `afeNumber` varchar(80), `costCenter` varchar(80),
  `status` enum('draft','presented','closed','amended_after_signature') NOT NULL DEFAULT 'draft',
  `signatureStatus` enum('unsigned','accepted','partially_accepted','refused','no_representative') NOT NULL DEFAULT 'unsigned',
  `createdAt` timestamp NOT NULL DEFAULT (now()), `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTickets_id` PRIMARY KEY(`id`),
  CONSTRAINT `fieldTickets_ticketNumber_unique` UNIQUE(`ticketNumber`)
);
--> statement-breakpoint
CREATE INDEX `fieldTickets_job_idx` ON `fieldTickets` (`jobId`);
--> statement-breakpoint
CREATE INDEX `fieldTickets_scope_idx` ON `fieldTickets` (`scope`,`tripId`,`loadId`);
--> statement-breakpoint
CREATE TABLE `fieldTicketLines` (
  `id` int AUTO_INCREMENT NOT NULL, `fieldTicketId` int NOT NULL,
  `lineKind` enum('service','load','disposal','standby','equipment','personnel','mileage','other') NOT NULL,
  `description` varchar(220) NOT NULL, `quantity` double, `quantityUnit` varchar(30),
  `measurementMethod` enum('meter','scale','gauge','estimate','customer_stated','system_timed','unknown') NOT NULL DEFAULT 'unknown',
  `sourceTrackingNumber` varchar(64),
  `disposition` enum('not_presented','accepted','disputed') NOT NULL DEFAULT 'not_presented',
  `operatorStatement` varchar(220), `customerStatement` varchar(220),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTicketLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `fieldTicketLines_ticket_idx` ON `fieldTicketLines` (`fieldTicketId`);
--> statement-breakpoint
CREATE TABLE `fieldTicketSignatures` (
  `id` int AUTO_INCREMENT NOT NULL, `fieldTicketId` int NOT NULL,
  `result` enum('accepted','partially_accepted','refused','no_representative') NOT NULL,
  `signerName` varchar(180), `signerCompany` varchar(180), `signerRole` varchar(120),
  `signerPhone` varchar(60), `signedScopeStatement` text,
  `signatureStorageKey` varchar(512),
  `signatureMethod` enum('drawn','device_auth','pin','paper_scan'),
  `payloadHash` varchar(128), `refusalReason` text, `capturedAt` timestamp NOT NULL,
  `capturedLatitude` double, `capturedLongitude` double,
  `capturedOffline` boolean NOT NULL DEFAULT false, `witnessedByOperatorId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTicketSignatures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `fieldTicketSignatures_ticket_idx` ON `fieldTicketSignatures` (`fieldTicketId`);
--> statement-breakpoint
CREATE TABLE `fieldTicketEvents` (
  `id` int AUTO_INCREMENT NOT NULL, `fieldTicketId` int NOT NULL,
  `eventType` varchar(60) NOT NULL, `occurredAt` timestamp NOT NULL, `endedAt` timestamp,
  `durationMinutes` double, `sourceTripStopId` int, `authorisedBy` varchar(180),
  `detail` text, `source` varchar(80) NOT NULL DEFAULT 'driver_entry',
  `confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTicketEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `fieldTicketEvents_ticket_idx` ON `fieldTicketEvents` (`fieldTicketId`);
--> statement-breakpoint
CREATE TABLE `invoices` (
  `id` int AUTO_INCREMENT NOT NULL, `invoiceNumber` varchar(64) NOT NULL,
  `billingBookId` int NOT NULL, `jobId` int, `customer` varchar(220) NOT NULL,
  `afeNumber` varchar(80), `purchaseOrder` varchar(80),
  `subtotalCents` int NOT NULL DEFAULT 0, `taxCents` int NOT NULL DEFAULT 0,
  `totalCents` int NOT NULL DEFAULT 0, `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `status` enum('draft','sent','viewed','approved','disputed','partially_paid','paid','void') NOT NULL DEFAULT 'draft',
  `sentAt` timestamp, `viewedAt` timestamp, `dueAt` timestamp,
  `acceptanceToken` varchar(128), `acceptedByName` varchar(180), `acceptedByRole` varchar(120),
  `acceptedAt` timestamp, `acceptanceSignatureKey` varchar(512),
  `disputeReason` text, `disputedAt` timestamp, `externalPortalRef` varchar(120),
  `createdAt` timestamp NOT NULL DEFAULT (now()), `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
  CONSTRAINT `invoices_invoiceNumber_unique` UNIQUE(`invoiceNumber`)
);
--> statement-breakpoint
CREATE TABLE `recordAmendments` (
  `id` int AUTO_INCREMENT NOT NULL, `entityType` varchar(40) NOT NULL, `entityId` int NOT NULL,
  `trackingNumber` varchar(64), `fieldKey` varchar(80) NOT NULL,
  `originalValue` text, `correctedValue` text, `reason` text NOT NULL,
  `supportingTrackingNumber` varchar(64), `actorUserId` int, `actorRole` varchar(40),
  `onBehalfOfOperatorId` int, `afterSignature` boolean NOT NULL DEFAULT false,
  `occurredAt` timestamp NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `recordAmendments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `recordAmendments_entity_idx` ON `recordAmendments` (`entityType`,`entityId`);
