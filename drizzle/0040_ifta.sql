-- v21.3 — IFTA on the fuel ledger.
--
-- The worker scanning a fuel receipt is preparing the quarterly return. What
-- the return needs beyond the ledger is (1) the jurisdiction each litre was
-- bought in, with its source, (2) distance by jurisdiction per unit, with its
-- source — odometer or operator-stated until a routing source exists, never
-- "GPS" by assumption — and (3) an immutable record of what was prepared and
-- filed, because the ledger keeps moving after the return does not.
--
-- The tax rate is a rule row in `taxRules`, unverified until a person
-- verifies it. A return whose rate is unverified computes its litres and
-- reports its tax as UNKNOWN.

ALTER TABLE `fuelTransactions`
  ADD COLUMN `jurisdiction` varchar(80) NULL AFTER `merchantLocation`,
  ADD COLUMN `jurisdictionSource` enum('receipt','vendor_location','operator_stated','fleet_card_statement','gps','unknown') NULL AFTER `jurisdiction`;
--> statement-breakpoint

CREATE TABLE `jurisdictionDistanceRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `distanceRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `unitId` int NOT NULL,
  `tripId` int,
  `jurisdiction` varchar(80) NOT NULL,
  `distanceKm` double NOT NULL,
  `periodStart` timestamp NOT NULL,
  `periodEnd` timestamp NOT NULL,
  -- Where the kilometres came from. There is no routing source loaded, so
  -- `gps` and `routing` exist for the day one does; nothing writes them now.
  `source` enum('gps','routing','odometer_split','operator_stated','imported','system_inferred') NOT NULL,
  `verificationStatus` enum('needs_review','verified','rejected') NOT NULL DEFAULT 'needs_review',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `recordedByUserId` int NOT NULL,
  `evidenceRecordId` int,
  `notes` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `jurisdictionDistanceRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `jurisdictionDistanceRecords_distanceRef_unique` UNIQUE(`distanceRef`)
);
--> statement-breakpoint
CREATE INDEX `jurisdictionDistanceRecords_unit_period_idx` ON `jurisdictionDistanceRecords` (`unitId`, `periodStart`, `periodEnd`);
--> statement-breakpoint

CREATE TABLE `iftaReturns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `returnRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `quarter` varchar(7) NOT NULL,
  `periodStart` timestamp NOT NULL,
  `periodEnd` timestamp NOT NULL,
  `status` enum('prepared','finalized','filed','amended') NOT NULL DEFAULT 'prepared',
  `summaryJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `taxDetermination` enum('computed','unknown') NOT NULL,
  `preparedByUserId` int NOT NULL,
  `preparedAt` timestamp NOT NULL,
  `finalizedByUserId` int,
  `finalizedAt` timestamp,
  `supersedesReturnId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `iftaReturns_id` PRIMARY KEY(`id`),
  CONSTRAINT `iftaReturns_returnRef_unique` UNIQUE(`returnRef`)
);
--> statement-breakpoint
CREATE INDEX `iftaReturns_entity_quarter_idx` ON `iftaReturns` (`financialEntityId`, `quarter`);
