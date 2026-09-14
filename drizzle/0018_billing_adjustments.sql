CREATE TABLE `billingAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL, `adjustmentNumber` varchar(64) NOT NULL,
  `invoiceNumber` varchar(64) NOT NULL, `invoiceId` int, `invoiceLineRef` varchar(64),
  `billingBookId` int, `jobId` int,
  `kind` enum('credit','debit','write_off','reclassify','rate_correction') NOT NULL,
  `amountCents` int NOT NULL, `signedCents` int NOT NULL,
  `reasonCode` varchar(60) NOT NULL, `narrative` text NOT NULL, `evidenceRef` varchar(120),
  `createdByUserId` int NOT NULL, `createdByRole` varchar(40) NOT NULL,
  `approvedByUserId` int, `approvedByRole` varchar(40), `approvedAt` timestamp,
  `payableAdjustmentNumber` varchar(64), `disputeCaseNumber` varchar(64),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billingAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `billingAdjustments_adjustmentNumber_unique` UNIQUE(`adjustmentNumber`)
);
--> statement-breakpoint
CREATE INDEX `billingAdjustments_invoice_idx` ON `billingAdjustments` (`invoiceNumber`);
--> statement-breakpoint
CREATE TABLE `billingAuthorityBands` (
  `id` int AUTO_INCREMENT NOT NULL, `tenantId` varchar(40), `role` varchar(40) NOT NULL,
  `maxCents` int, `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billingAuthorityBands_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `disputeCases` (
  `id` int AUTO_INCREMENT NOT NULL, `caseNumber` varchar(64) NOT NULL,
  `invoiceNumber` varchar(64), `invoiceLineRef` varchar(64), `jobId` int,
  `customer` varchar(220) NOT NULL, `raisedByName` varchar(180),
  `raisedByCompany` varchar(180), `disputedAmountCents` int, `reasonStated` text,
  `status` enum('raised','investigating','evidence_gathered','resolved_upheld','resolved_credited','resolved_partial','escalated','withdrawn') NOT NULL DEFAULT 'raised',
  `ourEvidenceRefs` text, `resolutionNarrative` text, `assignedUserId` int,
  `raisedAt` timestamp NOT NULL, `resolvedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `disputeCases_id` PRIMARY KEY(`id`),
  CONSTRAINT `disputeCases_caseNumber_unique` UNIQUE(`caseNumber`)
);
--> statement-breakpoint
CREATE INDEX `disputeCases_status_idx` ON `disputeCases` (`status`,`raisedAt`);
--> statement-breakpoint
CREATE TABLE `subcontractors` (
  `id` int AUTO_INCREMENT NOT NULL, `code` varchar(40) NOT NULL, `name` varchar(220) NOT NULL,
  `contactName` varchar(180), `contactPhone` varchar(60), `contactEmail` varchar(220),
  `wcbNumber` varchar(80), `insuranceExpiresAt` timestamp, `safetyProgramVerifiedAt` timestamp,
  `approvalStatus` enum('pending','approved','suspended','expired') NOT NULL DEFAULT 'pending',
  `paymentTermsDays` int NOT NULL DEFAULT 30, `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `subcontractors_id` PRIMARY KEY(`id`),
  CONSTRAINT `subcontractors_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `subcontractedLines` (
  `id` int AUTO_INCREMENT NOT NULL, `lineRef` varchar(64) NOT NULL, `jobId` int,
  `billingBookId` int, `invoiceNumber` varchar(64), `subcontractorId` int NOT NULL,
  `basis` enum('pass_through','marked_up','fixed_resale') NOT NULL,
  `costCents` int NOT NULL, `billedCents` int NOT NULL, `subInvoiceRef` varchar(80),
  `workVerifiedBy` varchar(180), `workVerifiedAt` timestamp,
  `payableStatus` enum('pending','approved','held','paid','disputed','short_paid') NOT NULL DEFAULT 'pending',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `subcontractedLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `subcontractedLines_sub_idx` ON `subcontractedLines` (`subcontractorId`,`payableStatus`);
--> statement-breakpoint
CREATE TABLE `payableAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL, `payableAdjustmentNumber` varchar(64) NOT NULL,
  `subcontractorId` int NOT NULL, `subcontractedLineRef` varchar(64),
  `relatedAdjustmentNumber` varchar(64), `amountCents` int NOT NULL,
  `attribution` enum('our_cost','subcontractor_fault','shared') NOT NULL,
  `marginImpactCents` int NOT NULL, `narrative` text NOT NULL,
  `noticeSentAt` timestamp, `subcontractorAcknowledgedAt` timestamp,
  `subcontractorDisputed` boolean NOT NULL DEFAULT false,
  `createdByUserId` int NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payableAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `payableAdjustments_number_unique` UNIQUE(`payableAdjustmentNumber`)
);
--> statement-breakpoint
CREATE TABLE `calloutRecords` (
  `id` int AUTO_INCREMENT NOT NULL, `calloutRef` varchar(64) NOT NULL, `jobId` int,
  `receivedAt` timestamp NOT NULL, `receivedByUserId` int,
  `callerName` varchar(180), `callerCompany` varchar(220), `callerPhone` varchar(60),
  `claimedAuthority` enum('client_representative','client_office','third_party_operator','emergency_services','unknown') NOT NULL DEFAULT 'unknown',
  `authorityVerified` boolean NOT NULL DEFAULT false,
  `verifiedBy` varchar(180), `verifiedAt` timestamp,
  `afeNumber` varchar(80), `purchaseOrder` varchar(80), `billToParty` varchar(220),
  `billableStatus` enum('yes','review','no') NOT NULL DEFAULT 'review',
  `blockersJson` text, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `calloutRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `calloutRecords_calloutRef_unique` UNIQUE(`calloutRef`)
);
