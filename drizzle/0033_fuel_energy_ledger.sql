-- v20.18 — Fuel & Energy Ledger.
--
-- Fuel is not a generic expense. Every fueling event answers four separate
-- questions — who fueled, who paid, what consumed it, whose record it is — and
-- the answers are frequently four different parties. `expenseRecords` stays
-- the financial record; `fuelTransactions` is the domain record underneath it.
--
-- Fleet cards are stored as tokens. There is no column for a full card number
-- and there will not be one.

CREATE TABLE `fuelAccounts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `accountRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `fuelType` enum('diesel','gasoline','def','propane','cng','lng','electric_charge','other','mixed') NOT NULL,
  `kind` enum('fleet','light_vehicle','equipment','bulk_yard','employee_travel','contractor_advance','other') NOT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fuelAccounts_id` PRIMARY KEY(`id`),
  CONSTRAINT `fuelAccounts_accountRef_unique` UNIQUE(`accountRef`)
);
--> statement-breakpoint

CREATE TABLE `fleetFuelCards` (
  `id` int AUTO_INCREMENT NOT NULL,
  `cardRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `provider` varchar(80) NOT NULL,
  -- Provider-issued token. Not a PAN. Not derivable into one.
  `providerToken` varchar(120),
  `lastFour` varchar(4) NOT NULL,
  `assignedUnitId` int,
  `assignedUserId` int,
  `fuelAccountId` int,
  `status` enum('active','suspended','revoked','expired') NOT NULL DEFAULT 'active',
  `expiresAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fleetFuelCards_id` PRIMARY KEY(`id`),
  CONSTRAINT `fleetFuelCards_cardRef_unique` UNIQUE(`cardRef`)
);
--> statement-breakpoint
CREATE INDEX `fleetFuelCards_entity_last4_idx` ON `fleetFuelCards` (`financialEntityId`, `lastFour`);
--> statement-breakpoint

CREATE TABLE `fuelTransactions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fuelRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `expenseRecordId` int,
  `evidenceRecordId` int,
  `operatorId` int,
  `fueledByUserId` int,
  `unitId` int,
  `trailerId` int,
  `equipmentId` int,
  `jobId` int,
  `tripId` int,
  `fuelAccountId` int,
  `fleetCardId` int,
  `vendorName` varchar(220),
  `merchantLocation` varchar(300),
  `occurredAt` timestamp NOT NULL,
  `fuelType` enum('diesel','gasoline','def','propane','cng','lng','electric_charge','other') NOT NULL,
  `quantity` double,
  `quantityUnit` varchar(12),
  `unitPrice` double,
  `subtotal` double,
  `taxAmount` double,
  `total` double NOT NULL,
  `odometerKm` double,
  `engineHours` double,
  -- "Unit 142" as printed on the slip. A hint for the reviewer; never the key.
  `unitNumberHint` varchar(40),
  `cardLastFourHint` varchar(4),
  `payerType` enum('company','worker_personal','contractor','owner_shareholder','customer','unknown') NOT NULL DEFAULT 'unknown',
  `purpose` enum('company_vehicle_operation','company_equipment_operation','company_business_travel','employee_business_travel','contractor_operation','bulk_tank_purchase','bulk_tank_dispense','personal','unknown') NOT NULL DEFAULT 'unknown',
  `financialTreatment` enum('company_operating_expense','employee_reimbursement_pending','contractor_reimbursement_pending','contractor_fuel_advance','contractor_own_expense','owner_reimbursement_or_equity_review','bulk_fuel_inventory','personal_tax_review','unknown_review_required') NOT NULL DEFAULT 'unknown_review_required',
  `reimbursementStatus` enum('not_applicable','pending','paid','denied') NOT NULL DEFAULT 'not_applicable',
  `reimbursedAmount` double,
  `privateToFueler` boolean NOT NULL DEFAULT false,
  `hosRuleConclusion` enum('requires_status_review','consistent','unknown') NOT NULL DEFAULT 'unknown',
  `classificationReasons` text,
  `status` enum('draft','needs_review','confirmed','reconciled','rejected') NOT NULL DEFAULT 'draft',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fuelTransactions_id` PRIMARY KEY(`id`),
  CONSTRAINT `fuelTransactions_fuelRef_unique` UNIQUE(`fuelRef`)
);
--> statement-breakpoint
CREATE INDEX `fuelTransactions_unit_time_idx` ON `fuelTransactions` (`unitId`, `occurredAt`);
--> statement-breakpoint
CREATE INDEX `fuelTransactions_entity_time_idx` ON `fuelTransactions` (`financialEntityId`, `occurredAt`);
--> statement-breakpoint

-- The fleet card a proposal was opened against. Resolved from the card token
-- at capture time — the same way loadId and facilityId are.
ALTER TABLE `assistantProposals`
  ADD COLUMN `fleetCardId` int NULL AFTER `facilityId`;
--> statement-breakpoint

ALTER TABLE `assistantCommitReceipts`
  MODIFY COLUMN `targetType` enum('trip_stop','maintenance_defect','expense_record','disposal_ticket','fuel_transaction') NOT NULL;
--> statement-breakpoint

-- The receipt links to its domain record as well as its financial one.
ALTER TABLE `evidenceRelationships`
  MODIFY COLUMN `entityType` enum('operator','unit','trailer','equipment','job','trip','load','manifest','disposalTicket','fieldTicket','workOrder','incident','nearMiss','safetyMeeting','invoice','customer','facility','dailyLog','inspection','expenseRecord','financialEntity','taxYear','user','fuelTransaction') NOT NULL;
