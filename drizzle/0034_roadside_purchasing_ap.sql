-- v20.19 — Roadside events, purchasing and the Accounts Payable spine.
--
-- A flat tire at 2 a.m. and a drum of hydraulic oil create the same problem:
-- something happened, someone paid a vendor, it belongs to a unit and a job,
-- office needs the paperwork, accounting needs the treatment, and management
-- needs the real cost. One spine for all of it.
--
-- `vendors` and `workOrders` already exist and are extended. `invoices` is
-- Accounts RECEIVABLE — what customers owe — and stays that way. What the
-- company owes a vendor is a `vendorBill`, a different thing.

-- Vendor directory becomes a vendor account.
ALTER TABLE `vendors`
  ADD COLUMN `vendorRef` varchar(64) NULL AFTER `id`,
  ADD COLUMN `accountNumberRef` varchar(120) NULL AFTER `email`,
  ADD COLUMN `paymentTermsDays` int NULL AFTER `accountNumberRef`,
  ADD COLUMN `preferred` boolean NOT NULL DEFAULT false AFTER `paymentTermsDays`,
  ADD COLUMN `emergency24h` boolean NOT NULL DEFAULT false AFTER `preferred`,
  ADD COLUMN `status` enum('active','inactive','blocked') NOT NULL DEFAULT 'active' AFTER `emergency24h`;
--> statement-breakpoint

-- Company-configurable, per role. Not code.
CREATE TABLE `spendingLimits` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  `role` varchar(40) NOT NULL,
  `emergencyPurchaseLimit` double NOT NULL,
  `standardPurchaseLimit` double NOT NULL,
  `canApproveUpTo` double NOT NULL DEFAULT 0,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveUntil` timestamp,
  `setByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `spendingLimits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `spendingLimits_entity_role_idx` ON `spendingLimits` (`financialEntityId`, `role`, `effectiveFrom`);
--> statement-breakpoint

CREATE TABLE `roadsideServiceEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `eventType` enum('flat_tire','tire_blowout','engine_failure','electrical_failure','air_system','brake_issue','coolant_leak','hydraulic_leak','fuel_issue','def_issue','frozen_airline','tow','boost','lockout','collision_recovery','stuck_recovery','trailer_failure','other') NOT NULL,
  `unitId` int NOT NULL,
  `trailerId` int,
  `operatorId` int,
  `reportedByUserId` int NOT NULL,
  `jobId` int,
  `tripId` int,
  `loadId` int,
  `latitude` double, `longitude` double,
  `locationDescription` varchar(300),
  `occurredAt` timestamp NOT NULL,
  `reportedAt` timestamp NOT NULL,
  `vehicleMovable` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `driverSafe` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `loadStatus` enum('empty','loaded','unknown') NOT NULL DEFAULT 'unknown',
  `dangerousGoods` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `assistanceRequired` boolean NOT NULL DEFAULT false,
  `customerAffected` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `driverStatement` text,
  `maintenanceDefectId` int,
  `assignedVendorId` int,
  `estimatedDelayMinutes` int,
  `status` enum('open','vendor_assigned','in_repair','repaired_awaiting_release','closed','cancelled') NOT NULL DEFAULT 'open',
  `closedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadsideServiceEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadsideServiceEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `roadsideServiceEvents_unit_idx` ON `roadsideServiceEvents` (`unitId`, `status`);
--> statement-breakpoint

CREATE TABLE `purchaseAuthorizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `authorizationRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `vendorId` int,
  `vendorNameIfNew` varchar(180),
  `unitId` int,
  `jobId` int,
  `roadsideEventId` int,
  `workOrderId` int,
  `category` varchar(80) NOT NULL,
  `reason` varchar(400) NOT NULL,
  `estimatedAmount` double NOT NULL,
  `authorizedMaximum` double,
  `emergency` boolean NOT NULL DEFAULT false,
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `rejectedByUserId` int,
  `rejectedAt` timestamp,
  `decisionReason` varchar(400),
  `status` enum('requested','approved','rejected','expired','consumed','cancelled') NOT NULL DEFAULT 'requested',
  `expiresAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `purchaseAuthorizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `purchaseAuthorizations_authorizationRef_unique` UNIQUE(`authorizationRef`)
);
--> statement-breakpoint
CREATE INDEX `purchaseAuthorizations_status_idx` ON `purchaseAuthorizations` (`financialEntityId`, `status`);
--> statement-breakpoint

CREATE TABLE `vendorBills` (
  `id` int AUTO_INCREMENT NOT NULL,
  `billRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `vendorId` int NOT NULL,
  `vendorInvoiceNumber` varchar(80) NOT NULL,
  `invoiceDate` timestamp NOT NULL,
  `serviceDate` timestamp,
  `receivedAt` timestamp NOT NULL,
  `dueAt` timestamp,
  `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `subtotal` double NOT NULL,
  `taxAmount` double NOT NULL DEFAULT 0,
  `total` double NOT NULL,
  `purchaseAuthorizationId` int,
  `roadsideEventId` int,
  `workOrderId` int,
  `unitId` int,
  `jobId` int,
  `evidenceRecordId` int,
  `accountingPeriod` varchar(7),
  `accrualCandidate` boolean NOT NULL DEFAULT false,
  `matchOutcome` enum('unmatched','match','mismatch','partial') NOT NULL DEFAULT 'unmatched',
  `matchVariancesJson` text,
  `codingCategory` varchar(80),
  `codedByUserId` int,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `paymentReleasedByUserId` int,
  `paymentReleasedAt` timestamp,
  `status` enum('received','needs_coding','needs_approval','missing_receipt','mismatch','duplicate_suspected','ready_to_pay','paid','disputed','cancelled') NOT NULL DEFAULT 'received',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `vendorBills_id` PRIMARY KEY(`id`),
  CONSTRAINT `vendorBills_billRef_unique` UNIQUE(`billRef`),
  CONSTRAINT `vendorBills_vendor_invoice_unique` UNIQUE(`vendorId`,`vendorInvoiceNumber`)
);
--> statement-breakpoint
CREATE INDEX `vendorBills_status_idx` ON `vendorBills` (`financialEntityId`, `status`);
--> statement-breakpoint

CREATE TABLE `vendorBillLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `vendorBillId` int NOT NULL,
  `lineNo` int NOT NULL,
  `lineType` enum('part','labour','service_call','freight','shop_supplies','environmental_fee','disposal_fee','core_charge','core_credit','tire_levy','tax','warranty_credit','discount','other') NOT NULL,
  `description` varchar(300) NOT NULL,
  `quantity` double NOT NULL DEFAULT 1,
  `unitPrice` double NOT NULL,
  `amount` double NOT NULL,
  -- A core charge stays open until its credit actually appears.
  `coreStatus` enum('not_applicable','open','credited','written_off') NOT NULL DEFAULT 'not_applicable',
  `creditedByLineId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `vendorBillLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `vendorBillLines_bill_idx` ON `vendorBillLines` (`vendorBillId`);
--> statement-breakpoint

-- A company expense that MIGHT be recoverable from a customer. Always a
-- proposal; nothing here invoices anyone.
CREATE TABLE `customerRecoveryProposals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `proposalRef` varchar(64) NOT NULL,
  `vendorBillId` int,
  `expenseRecordId` int,
  `jobId` int NOT NULL,
  `customerRef` varchar(220),
  `companyCost` double NOT NULL,
  `proposedRecovery` double NOT NULL,
  `markupPercent` double,
  `basis` varchar(400) NOT NULL,
  `status` enum('proposed','review_required','approved','declined','invoiced') NOT NULL DEFAULT 'review_required',
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerRecoveryProposals_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerRecoveryProposals_proposalRef_unique` UNIQUE(`proposalRef`)
);
