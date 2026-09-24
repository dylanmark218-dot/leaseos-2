-- v23.26 — 0183: contracts with a lifecycle, and rate sheets as versioned groups of charge
-- definitions.
--
-- WHAT ALREADY EXISTED, AND WHY THIS DOES NOT DUPLICATE IT.
--   * `customerContractTerms` (v22.1) is the billability rulebook (is standby billable, the
--     minimum hours), versioned and approved by a second person. It is not a contract record:
--     it has no number, no lifecycle, no expiry, no renewal, no documents. `customerContracts`
--     is that record and points at its terms through `termsId`.
--   * `chargeDefinitions` (v22.7) is the live pricing vocabulary the resolver prices from, one
--     row per rate, each proposed by one person and approved by another. It is the right rate
--     line. What it lacked was the sheet: a customer-facing document that groups the lines, is
--     approved as a unit, carries a version and an effective window, and is what a job pins.
--     A rate line IS a charge definition; `rateSheetVersionId` says which sheet version it
--     belongs to. The resolver (rateResolution.ts) keeps its precedence and simply sees more
--     definitions; nothing gets a third rate table to disagree with the first two.
--   * `customerRateCards` (v21.10) and `billingRateCards` (v20) remain as the legacy paths the
--     roadmap already names for retirement ("Unify billing"). Nothing here reads them.
--
-- INVARIANTS.
--   * A contract or a rate sheet version that a job has snapshotted (`usedOperationallyAt`
--     set) is never edited again. A correction is a new version that supersedes it; the old
--     row keeps its status history and prices its own window.
--   * A rate line on an approved version is immutable — there is no update path for it.
--   * Status transitions are explicit and tested; every one writes a commercialAuditEvents row.

CREATE TABLE `customerContracts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contractRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  -- Unique within the entity: the customer's own MSA number is often the number both sides use.
  `contractNumber` varchar(80) NOT NULL,
  `title` varchar(220) NOT NULL,
  `contractType` enum('msa','rate_agreement','service_agreement','work_order','purchase_order','framework','other') NOT NULL DEFAULT 'msa',
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `status` enum('draft','pending_approval','active','suspended','expired','terminated','superseded') NOT NULL DEFAULT 'draft',
  -- inherit = the account decides; required / not_required override the account for this contract.
  `poRequirement` enum('inherit','required','not_required') NOT NULL DEFAULT 'inherit',
  `requiredReferenceKindsJson` text NULL,
  -- The customer's own numbers for this agreement: {kind: value}, e.g. {"msa":"MSA-2026-014"}.
  `customerReferencesJson` text NULL,
  -- NULL = the account's terms apply.
  `paymentTermsDays` int NULL,
  `billingInstructions` text NULL,
  `notes` text NULL,
  `termsId` int NULL,
  `renewalKind` enum('none','manual','auto') NOT NULL DEFAULT 'manual',
  `renewalNoticeDays` int NULL,
  `version` int NOT NULL DEFAULT 1,
  `supersedesContractId` int NULL,
  `supersededByContractId` int NULL,
  `submittedByUserId` int NULL,
  `submittedAt` timestamp NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  `approvalNote` varchar(400) NULL,
  `activatedAt` timestamp NULL,
  `suspendedAt` timestamp NULL,
  `suspendedByUserId` int NULL,
  `suspensionReason` varchar(400) NULL,
  `terminatedAt` timestamp NULL,
  `terminatedByUserId` int NULL,
  `terminationReason` varchar(400) NULL,
  `expiredAt` timestamp NULL,
  -- Set the first time a job snapshot references this contract. After this, no edit; supersede.
  `usedOperationallyAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `rowVersion` int NOT NULL DEFAULT 1,
  CONSTRAINT `customerContracts_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerContracts_ref_unique` UNIQUE(`contractRef`),
  CONSTRAINT `customerContracts_entity_number_unique` UNIQUE(`financialEntityId`, `contractNumber`)
);
--> statement-breakpoint
CREATE INDEX `customerContracts_account_idx` ON `customerContracts` (`customerAccountId`, `status`);
--> statement-breakpoint
CREATE INDEX `customerContracts_entity_status_idx` ON `customerContracts` (`financialEntityId`, `status`, `effectiveTo`);
--> statement-breakpoint

CREATE TABLE `rateSheets` (
  `id` int AUTO_INCREMENT NOT NULL,
  `rateSheetRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  -- A sheet under a contract prices at the customer_contract level; one without prices at
  -- customer_rate_card. That is the whole precedence difference, and it is explicit.
  `contractId` int NULL,
  `name` varchar(220) NOT NULL,
  `sheetNumber` varchar(80) NULL,
  `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `notes` text NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `rowVersion` int NOT NULL DEFAULT 1,
  CONSTRAINT `rateSheets_id` PRIMARY KEY(`id`),
  CONSTRAINT `rateSheets_ref_unique` UNIQUE(`rateSheetRef`),
  CONSTRAINT `rateSheets_entity_number_unique` UNIQUE(`financialEntityId`, `sheetNumber`)
);
--> statement-breakpoint
CREATE INDEX `rateSheets_account_idx` ON `rateSheets` (`customerAccountId`, `status`);
--> statement-breakpoint
CREATE INDEX `rateSheets_contract_idx` ON `rateSheets` (`contractId`);
--> statement-breakpoint

-- One approved-as-a-unit revision of a sheet. Lines are chargeDefinitions rows carrying this id.
CREATE TABLE `rateSheetVersions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `versionRef` varchar(40) NOT NULL,
  `rateSheetId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `version` int NOT NULL,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `status` enum('draft','pending_approval','approved','rejected','superseded','retired') NOT NULL DEFAULT 'draft',
  -- sha256 over the canonical lines at approval; a snapshot carries it so a later reader can
  -- prove the lines it billed from are the lines that were approved.
  `contentHash` char(64) NULL,
  `notes` text NULL,
  `supersedesVersionId` int NULL,
  `supersededByVersionId` int NULL,
  `submittedByUserId` int NULL,
  `submittedAt` timestamp NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  `rejectedByUserId` int NULL,
  `rejectedAt` timestamp NULL,
  `rejectionReason` varchar(400) NULL,
  `usedOperationallyAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `rowVersion` int NOT NULL DEFAULT 1,
  CONSTRAINT `rateSheetVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `rateSheetVersions_ref_unique` UNIQUE(`versionRef`),
  CONSTRAINT `rateSheetVersions_sheet_version_unique` UNIQUE(`rateSheetId`, `version`)
);
--> statement-breakpoint
CREATE INDEX `rateSheetVersions_sheet_status_idx` ON `rateSheetVersions` (`rateSheetId`, `status`, `effectiveFrom`);
--> statement-breakpoint
CREATE INDEX `rateSheetVersions_entity_expiry_idx` ON `rateSheetVersions` (`financialEntityId`, `status`, `effectiveTo`);
--> statement-breakpoint

-- A rate line is a charge definition on a sheet version. `lineKind` is the extensible catalogue
-- (hourly_equipment, per_load, standby, fuel_surcharge, …; see shared rate-line vocabulary) and
-- `applicabilityJson` the conditions beyond the scope columns (equipment class, shift, province,
-- quantity band, facility, material, dangerous-goods class). Both read by the resolver.
ALTER TABLE `chargeDefinitions`
  ADD COLUMN `rateSheetVersionId` int NULL,
  ADD COLUMN `lineNo` int NULL,
  ADD COLUMN `lineKind` varchar(40) NULL,
  ADD COLUMN `label` varchar(220) NULL,
  ADD COLUMN `applicabilityJson` text NULL;
--> statement-breakpoint
CREATE INDEX `chargeDefinitions_sheet_version_idx` ON `chargeDefinitions` (`rateSheetVersionId`, `lineNo`);
