-- v21.15 — Fleet Shop OS.
--
-- Stock is a derivation over an append-only movement ledger: a receive, an
-- issue to a work order, a return, a count adjustment, a core out and a
-- core back, a warranty return, a scrap — each signed, each with a reason
-- and a person. On-hand is the sum; nothing overwrites it. A tire is a
-- serialized asset with a lineage (a retread is the same casing) and an
-- installation history by axle position; its cost per kilometre exists only
-- when both odometers are on record. A warranty claim is raised by one
-- person and decided by another, and a credit is reconciled to the vendor
-- bill line that carries it. A recall is external data — held unverified
-- until a person verifies it — and its effect on each unit is a decision.

CREATE TABLE `parts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `partRef` varchar(64) NOT NULL,
  `partNumber` varchar(80) NOT NULL,
  `oemNumber` varchar(80),
  `description` varchar(220) NOT NULL,
  `category` enum('tire','filter','fluid','belt_hose','brake','electrical','hydraulic','driveline','body','consumable','other') NOT NULL,
  `uom` varchar(20) NOT NULL DEFAULT 'each',
  `isCore` boolean NOT NULL DEFAULT false,
  `coreChargeCents` int,
  `minQty` int,
  `maxQty` int,
  `preferredVendorId` int,
  `status` enum('active','obsolete') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `parts_id` PRIMARY KEY(`id`),
  CONSTRAINT `parts_partRef_unique` UNIQUE(`partRef`),
  CONSTRAINT `parts_partNumber_unique` UNIQUE(`partNumber`)
);
--> statement-breakpoint

CREATE TABLE `partMovements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `movementRef` varchar(64) NOT NULL,
  `partId` int NOT NULL,
  `bin` varchar(40) NOT NULL DEFAULT 'MAIN',
  `kind` enum('receive','issue','return_to_stock','adjust_count','core_out','core_returned','warranty_return','scrap','transfer_in','transfer_out') NOT NULL,
  -- Signed: what this movement did to on-hand. A core_out or core_returned moves the core count, not the part count.
  `qtySigned` int NOT NULL,
  `unitCostCents` int,
  `workOrderId` int,
  `unitId` int,
  `vendorBillLineId` int,
  `warrantyClaimId` int,
  `reason` varchar(300),
  `byUserId` int NOT NULL,
  `at` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `partMovements_id` PRIMARY KEY(`id`),
  CONSTRAINT `partMovements_movementRef_unique` UNIQUE(`movementRef`)
);
--> statement-breakpoint
CREATE INDEX `partMovements_part_idx` ON `partMovements` (`partId`, `bin`, `at`);
--> statement-breakpoint

CREATE TABLE `tires` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tireRef` varchar(64) NOT NULL,
  `serial` varchar(80) NOT NULL,
  `brand` varchar(80),
  `model` varchar(80),
  `size` varchar(40) NOT NULL,
  `positionType` enum('steer','drive','trailer','any') NOT NULL DEFAULT 'any',
  `casingOfTireId` int,
  `retreadCount` int NOT NULL DEFAULT 0,
  `purchaseCostCents` int,
  `purchaseVendorBillLineId` int,
  `status` enum('in_stock','installed','removed','retread_out','scrapped','warranty_claim') NOT NULL DEFAULT 'in_stock',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `tires_id` PRIMARY KEY(`id`),
  CONSTRAINT `tires_tireRef_unique` UNIQUE(`tireRef`),
  CONSTRAINT `tires_serial_unique` UNIQUE(`serial`)
);
--> statement-breakpoint

CREATE TABLE `tireInstallations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tireId` int NOT NULL,
  `unitId` int NOT NULL,
  -- Axle from the front, side, and inner/outer on duals: 1L, 2LO, 2LI, 3RI…
  `axlePosition` varchar(8) NOT NULL,
  `installedAt` timestamp NOT NULL,
  `installOdometerKm` int,
  `installTreadMm` double,
  `removedAt` timestamp,
  `removeOdometerKm` int,
  `removeTreadMm` double,
  `removalReason` enum('worn','damage','rotation','retread','warranty','other'),
  `workOrderId` int,
  `byUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `tireInstallations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `tireInstallations_unit_idx` ON `tireInstallations` (`unitId`, `removedAt`);
--> statement-breakpoint

CREATE TABLE `tireMeasurements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tireId` int NOT NULL,
  `installationId` int,
  `measuredAt` timestamp NOT NULL,
  `treadMm` double,
  `pressureKpa` double,
  `odometerKm` int,
  `byUserId` int NOT NULL,
  `note` varchar(200),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `tireMeasurements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `warrantyPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(64) NOT NULL,
  `subjectType` enum('part','tire','unit_component') NOT NULL,
  `subjectId` int NOT NULL,
  `unitId` int,
  `vendorId` int,
  `coverageUntil` timestamp,
  `coverageKm` int,
  `coverageHours` int,
  `terms` varchar(600),
  `sourceDocumentEvidenceId` int,
  `verificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `warrantyPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `warrantyPolicies_policyRef_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint

CREATE TABLE `warrantyClaims` (
  `id` int AUTO_INCREMENT NOT NULL,
  `claimRef` varchar(64) NOT NULL,
  `policyId` int NOT NULL,
  `workOrderId` int,
  `partMovementId` int,
  `tireId` int,
  `claimedCents` int NOT NULL,
  `reason` varchar(600) NOT NULL,
  `eligibility` enum('eligible','expired','unknown') NOT NULL,
  `eligibilityReason` varchar(300),
  `raisedByUserId` int NOT NULL,
  `raisedAt` timestamp NOT NULL,
  `status` enum('raised','submitted','approved','denied','credited') NOT NULL DEFAULT 'raised',
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `decisionReason` varchar(400),
  `creditVendorBillLineId` int,
  `creditedCents` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `warrantyClaims_id` PRIMARY KEY(`id`),
  CONSTRAINT `warrantyClaims_claimRef_unique` UNIQUE(`claimRef`)
);
--> statement-breakpoint

CREATE TABLE `serializedTools` (
  `id` int AUTO_INCREMENT NOT NULL,
  `toolRef` varchar(64) NOT NULL,
  `serial` varchar(80) NOT NULL,
  `description` varchar(220) NOT NULL,
  `measurementDeviceId` int,
  `status` enum('available','checked_out','out_for_calibration','retired') NOT NULL DEFAULT 'available',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `serializedTools_id` PRIMARY KEY(`id`),
  CONSTRAINT `serializedTools_toolRef_unique` UNIQUE(`toolRef`),
  CONSTRAINT `serializedTools_serial_unique` UNIQUE(`serial`)
);
--> statement-breakpoint

CREATE TABLE `toolCheckouts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `toolId` int NOT NULL,
  `workerUserId` int NOT NULL,
  `checkedOutAt` timestamp NOT NULL,
  `returnedAt` timestamp,
  `returnCondition` enum('good','damaged','needs_calibration'),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `toolCheckouts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `recallNotices` (
  `id` int AUTO_INCREMENT NOT NULL,
  `recallRef` varchar(64) NOT NULL,
  `source` varchar(120) NOT NULL,
  `sourceRef` varchar(120) NOT NULL,
  `issuedAt` timestamp,
  `summary` varchar(600) NOT NULL,
  `affectedCriteriaJson` text,
  `status` enum('open','scheduled','completed','not_applicable') NOT NULL DEFAULT 'open',
  `verificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `recallNotices_id` PRIMARY KEY(`id`),
  CONSTRAINT `recallNotices_recallRef_unique` UNIQUE(`recallRef`),
  CONSTRAINT `recallNotices_source_ref_unique` UNIQUE(`source`,`sourceRef`)
);
--> statement-breakpoint

CREATE TABLE `recallUnitStatus` (
  `id` int AUTO_INCREMENT NOT NULL,
  `recallId` int NOT NULL,
  `unitId` int NOT NULL,
  `status` enum('unknown','affected','not_affected','completed') NOT NULL DEFAULT 'unknown',
  `workOrderId` int,
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `recallUnitStatus_id` PRIMARY KEY(`id`),
  CONSTRAINT `recallUnitStatus_recall_unit_unique` UNIQUE(`recallId`,`unitId`)
);
