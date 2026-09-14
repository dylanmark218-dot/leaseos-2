-- v21.4 — Bulk fuel, fleet-card statement import, fuel anomalies.
--
-- A bulk tank is inventory. Fuel goes in by purchase and out by dispense;
-- a stick or meter reading says what is actually there; the difference is
-- the variance the yard has to explain. A dispense is a fuel transaction
-- like any other — with a unit, a quantity and the tank's jurisdiction — so
-- IFTA counts it and the unit's consumption reconciles.
--
-- A fleet-card statement is the only record of purchases that did not come
-- from the worker. A statement line with no receipt is a purchase nobody
-- scanned; a receipt with no statement line was not on the company's card.
-- Matching a line to a receipt closes one transaction's loop; it never
-- creates a second expense.

ALTER TABLE `fuelTransactions`
  MODIFY COLUMN `jurisdictionSource` enum('receipt','vendor_location','operator_stated','fleet_card_statement','gps','bulk_tank_location','unknown') NULL,
  ADD COLUMN `bulkFuelTankId` int NULL AFTER `fuelAccountId`,
  ADD COLUMN `statementLineId` int NULL AFTER `bulkFuelTankId`;
--> statement-breakpoint

CREATE TABLE `bulkFuelTanks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tankRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `fuelAccountId` int,
  `name` varchar(120) NOT NULL,
  `location` varchar(300),
  `jurisdiction` varchar(80) NOT NULL,
  `fuelType` enum('diesel','gasoline','def','propane','other') NOT NULL,
  `capacityLitres` double NOT NULL,
  `meterDeviceId` int,
  `varianceTolerancePct` double NOT NULL DEFAULT 2,
  `status` enum('active','out_of_service','retired') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bulkFuelTanks_id` PRIMARY KEY(`id`),
  CONSTRAINT `bulkFuelTanks_tankRef_unique` UNIQUE(`tankRef`)
);
--> statement-breakpoint

CREATE TABLE `bulkFuelDispenses` (
  `id` int AUTO_INCREMENT NOT NULL,
  `dispenseRef` varchar(64) NOT NULL,
  `bulkFuelTankId` int NOT NULL,
  `unitId` int,
  `equipmentId` int,
  `fuelTransactionId` int,
  `litres` double NOT NULL,
  `quantitySource` enum('meter','stick_before_after','stated') NOT NULL,
  `meterBefore` double,
  `meterAfter` double,
  `odometerKm` double,
  `occurredAt` timestamp NOT NULL,
  `dispensedByUserId` int NOT NULL,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bulkFuelDispenses_id` PRIMARY KEY(`id`),
  CONSTRAINT `bulkFuelDispenses_dispenseRef_unique` UNIQUE(`dispenseRef`)
);
--> statement-breakpoint
CREATE INDEX `bulkFuelDispenses_tank_idx` ON `bulkFuelDispenses` (`bulkFuelTankId`, `occurredAt`);
--> statement-breakpoint

CREATE TABLE `bulkFuelReadings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bulkFuelTankId` int NOT NULL,
  `readAt` timestamp NOT NULL,
  `litresOnHand` double NOT NULL,
  `method` enum('stick','gauge','meter_total','delivery_ticket') NOT NULL,
  `readByUserId` int NOT NULL,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bulkFuelReadings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `bulkFuelReadings_tank_idx` ON `bulkFuelReadings` (`bulkFuelTankId`, `readAt`);
--> statement-breakpoint

CREATE TABLE `fuelStatements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `statementRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `fuelAccountId` int NOT NULL,
  `provider` varchar(120) NOT NULL,
  `periodStart` timestamp NOT NULL,
  `periodEnd` timestamp NOT NULL,
  `lineCount` int NOT NULL DEFAULT 0,
  `matchedCount` int NOT NULL DEFAULT 0,
  `varianceCount` int NOT NULL DEFAULT 0,
  `unmatchedCount` int NOT NULL DEFAULT 0,
  `contentHash` varchar(64) NOT NULL,
  `importedByUserId` int NOT NULL,
  `importedAt` timestamp NOT NULL,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fuelStatements_id` PRIMARY KEY(`id`),
  CONSTRAINT `fuelStatements_statementRef_unique` UNIQUE(`statementRef`),
  CONSTRAINT `fuelStatements_contentHash_unique` UNIQUE(`contentHash`)
);
--> statement-breakpoint

CREATE TABLE `fuelStatementLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fuelStatementId` int NOT NULL,
  `lineNo` int NOT NULL,
  `transactionAt` timestamp NOT NULL,
  `cardLastFour` varchar(4),
  `merchant` varchar(220),
  `merchantLocation` varchar(300),
  `jurisdiction` varchar(80),
  `quantity` double,
  `quantityUnit` varchar(12),
  `total` double NOT NULL,
  `unitHint` varchar(40),
  `matchedFuelTransactionId` int,
  `matchOutcome` enum('match','match_with_variance','unmatched','ambiguous') NOT NULL,
  `matchReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fuelStatementLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `fuelStatementLines_statement_line_unique` UNIQUE(`fuelStatementId`,`lineNo`)
);
