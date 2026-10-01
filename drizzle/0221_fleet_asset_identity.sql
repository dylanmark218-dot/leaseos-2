-- 0221 — Fleet & Equipment Portfolio, asset core: identity and lifecycle on `units`, and components.
-- Design: docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md §A.14, §B.2, §B.3 (reconciliation R-7
-- deferred these from the foundation slice, 0200). Trigger DDL is 0222, in its own file.
--
-- Additive. Every new column is NULL or defaulted; no existing value changes meaning. `vehicleType`
-- stays: every older reader still reads it, and the create path derives it from `assetType`.
-- `assetClass` NULL means "not classified" — the portfolio reports it as such and never guesses from
-- `vehicleType` (a backfill is a proposal a fleet manager confirms per unit, not a migration).
-- `lifecycleStatus` defaults to `active`: every existing unit is in the fleet, which is what it was.
ALTER TABLE `units`
  ADD COLUMN `assetClass` enum('power_unit','trailer','mounted_system','portable_equipment','component') NULL,
  ADD COLUMN `assetType` varchar(60) NULL,
  ADD COLUMN `assetSubtype` varchar(60) NULL,
  ADD COLUMN `companyAssetNumber` varchar(60) NULL,
  ADD COLUMN `serialNumber` varchar(120) NULL,
  ADD COLUMN `plateJurisdiction` varchar(8) NULL,
  ADD COLUMN `make` varchar(80) NULL,
  ADD COLUMN `model` varchar(80) NULL,
  ADD COLUMN `modelYear` smallint NULL,
  ADD COLUMN `manufacturer` varchar(120) NULL,
  ADD COLUMN `ownershipType` enum('owned','leased','rented','customer_supplied','contractor_supplied') NULL,
  ADD COLUMN `acquiredAt` timestamp NULL,
  ADD COLUMN `homeTerminal` varchar(120) NULL,
  ADD COLUMN `assignedBranchRef` varchar(64) NULL,
  ADD COLUMN `assignedDivision` varchar(120) NULL,
  ADD COLUMN `defaultOperatorId` int NULL,
  ADD COLUMN `regulatoryClass` varchar(60) NULL,
  ADD COLUMN `lifecycleStatus` enum('active','seasonal_storage','retired','sold','transferred') NOT NULL DEFAULT 'active',
  ADD COLUMN `lifecycleChangedAt` timestamp NULL,
  ADD COLUMN `lifecycleChangedByUserId` int NULL,
  ADD COLUMN `lifecycleReason` varchar(400) NULL,
  ADD COLUMN `retiredAt` timestamp NULL,
  ADD COLUMN `notes` text NULL;
--> statement-breakpoint
CREATE INDEX `units_lifecycle_idx` ON `units` (`lifecycleStatus`, `assetClass`);
--> statement-breakpoint
-- Parent/child equipment with history. Both ends are `units` rows. Detaching sets `removedAt`; the row
-- is never deleted (0222), so "what was attached during a job" is a temporal query over this table.
CREATE TABLE `unitComponents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `componentRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `parentUnitId` int NOT NULL,
  `childUnitId` int NOT NULL,
  `relationship` enum('mounted','installed','attached','towed') NOT NULL,
  `removable` boolean NOT NULL DEFAULT true,
  `installedAt` timestamp NOT NULL,
  `installedByUserId` int NOT NULL,
  `installWorkOrderId` int NULL,
  `removedAt` timestamp NULL,
  `removedByUserId` int NULL,
  `removeWorkOrderId` int NULL,
  `removalReason` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitComponents_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitComponents_componentRef_unique` UNIQUE(`componentRef`)
);
--> statement-breakpoint
CREATE INDEX `unitComponents_parent_idx` ON `unitComponents` (`parentUnitId`, `removedAt`);
--> statement-breakpoint
CREATE INDEX `unitComponents_child_idx` ON `unitComponents` (`childUnitId`, `removedAt`);
