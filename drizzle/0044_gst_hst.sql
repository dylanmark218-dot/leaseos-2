-- v21.8 — GST/HST return assembly.
--
-- Output tax is what the invoices say was collected — a fact. Input tax
-- credits are the tax on purchases that carry evidence, and only when the
-- company is registered — a fact and a condition. The rate is a rule row,
-- unverified until a person verifies it, and it checks the return's
-- reasonableness; it never supplies a figure. The return is a snapshot the
-- filer signs; the ledger keeps moving after it does not.
--
-- The sales side needed three things it lacked: which entity issued the
-- invoice, when, and whether the sale was taxable, zero-rated or exempt.

ALTER TABLE `invoices`
  ADD COLUMN `financialEntityId` int NULL AFTER `invoiceNumber`,
  ADD COLUMN `issuedAt` timestamp NULL AFTER `financialEntityId`,
  ADD COLUMN `gstTreatment` enum('taxable','zero_rated','exempt','unknown') NOT NULL DEFAULT 'unknown' AFTER `taxCents`,
  ADD COLUMN `gstTreatmentSource` varchar(40) NULL AFTER `gstTreatment`;
--> statement-breakpoint

ALTER TABLE `vendorBills`
  ADD COLUMN `gstTreatment` enum('taxable','zero_rated','exempt','unknown') NOT NULL DEFAULT 'unknown' AFTER `taxAmount`;
--> statement-breakpoint

CREATE TABLE `gstReturns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `returnRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `period` varchar(7) NOT NULL,
  `periodStart` timestamp NOT NULL,
  `periodEnd` timestamp NOT NULL,
  `status` enum('prepared','finalized','filed','amended') NOT NULL DEFAULT 'prepared',
  `summaryJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `determination` enum('ready','review','blocked') NOT NULL,
  `netTaxCents` int,
  `preparedByUserId` int NOT NULL,
  `preparedAt` timestamp NOT NULL,
  `finalizedByUserId` int,
  `finalizedAt` timestamp,
  `reviewItemsAcknowledged` text,
  `supersedesReturnId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `gstReturns_id` PRIMARY KEY(`id`),
  CONSTRAINT `gstReturns_returnRef_unique` UNIQUE(`returnRef`)
);
--> statement-breakpoint
CREATE INDEX `gstReturns_entity_period_idx` ON `gstReturns` (`financialEntityId`, `period`);
--> statement-breakpoint

CREATE TABLE `gstAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `adjustmentRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `period` varchar(7) NOT NULL,
  `line` enum('104','107') NOT NULL,
  `amountCents` int NOT NULL,
  `reason` varchar(400) NOT NULL,
  `evidenceRecordId` int,
  `recordedByUserId` int NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `gstAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `gstAdjustments_adjustmentRef_unique` UNIQUE(`adjustmentRef`)
);
