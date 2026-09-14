-- v22.7 — Commercial Setup & Rate Resolution.
--
-- One charge definition for every pricing method and every rate kind: what
-- we charge (sell), what we owe a third party (vendor_payable), what the
-- worker earns (payroll_reference) and what the service costs us
-- (internal_cost) are four rows, never one field. Amounts are cents; rates
-- and quantities are thousandths; markups are basis points. A definition
-- carries its scope (customer, vendor, project, site, contract, job), its
-- effective window, its source document, its provenance, its approval and
-- its supersession. A pricing decision is the immutable record of what a
-- line was priced at and why. The setup profile carries the company's
-- service selections and its margin guardrails — business policy, not law.

CREATE TABLE `chargeDefinitions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `definitionRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `rateKind` enum('sell','vendor_payable','payroll_reference','internal_cost') NOT NULL,
  `serviceCode` varchar(60) NOT NULL,
  `resourceClass` varchar(80),
  `unitId` int,
  `pricingMethod` enum('per_unit','flat','minimum_charge','percentage_markup','fixed_markup','multiplier','formula') NOT NULL,
  `unit` enum('hour','half_hour','day','shift','load','km','mile','m3','litre','kg','tonne','acre','metre','foot','piece','worker','crew','each','none') NOT NULL,
  `rateMillis` int,
  `flatCents` int,
  `basisPoints` int,
  `multiplierMillis` int,
  `formula` varchar(400),
  `minimumQuantityMillis` int,
  `minimumChargeCents` int,
  `billingIncrementMillis` int,
  `roundingMode` enum('nearest','up','down') NOT NULL DEFAULT 'nearest',
  `measurementBasis` enum('any','meter','tank_calibration','certified_scale','load_sensor','facility_ticket','customer_measurement','operator_estimate','manual_entry','clock','odometer','gps') NOT NULL DEFAULT 'any',
  `conditionKey` varchar(60),
  `scopeLevel` enum('job_override','change_order','po_afe','project_site','customer_contract','customer_rate_card','branch','company') NOT NULL,
  `customerAccountId` int,
  `vendorId` int,
  `projectRef` varchar(80),
  `siteRef` varchar(120),
  `contractRef` varchar(80),
  `jobId` int,
  `branchCode` varchar(40),
  `currency` varchar(8) NOT NULL DEFAULT 'CAD',
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `version` int NOT NULL DEFAULT 1,
  `supersedesDefinitionId` int,
  `supersededByDefinitionId` int,
  `sourceKind` enum('human','ai_extracted','imported','negotiated') NOT NULL,
  `sourceDocumentEvidenceId` int,
  `sourceClause` varchar(160),
  `approvalStatus` enum('proposed','approved','rejected','superseded') NOT NULL DEFAULT 'proposed',
  `proposedByUserId` int NOT NULL,
  `proposedAt` timestamp NOT NULL DEFAULT (now()),
  `approvedByUserId` int,
  `approvedAt` timestamp NULL,
  `rejectionReason` varchar(400),
  `notes` varchar(600),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `chargeDefinitions_id` PRIMARY KEY(`id`),
  CONSTRAINT `chargeDefinitions_definitionRef_unique` UNIQUE(`definitionRef`)
);
--> statement-breakpoint
CREATE INDEX `chargeDefinitions_entity_service_kind` ON `chargeDefinitions` (`financialEntityId`, `serviceCode`, `rateKind`, `approvalStatus`);
--> statement-breakpoint
CREATE INDEX `chargeDefinitions_customer` ON `chargeDefinitions` (`customerAccountId`);
--> statement-breakpoint
CREATE INDEX `chargeDefinitions_vendor` ON `chargeDefinitions` (`vendorId`);
--> statement-breakpoint

CREATE TABLE `pricingDecisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `decisionRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `rateKind` enum('sell','vendor_payable') NOT NULL,
  `subjectKind` enum('field_ticket_line','vendor_bill_line','quote_line','job_estimate','simulation') NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `serviceCode` varchar(60) NOT NULL,
  `quantityMillis` int NOT NULL,
  `unit` varchar(20) NOT NULL,
  `measurementSource` varchar(40) NOT NULL,
  `measurementEvidenceId` int,
  `outcome` enum('priced','unknown_rate','conflict','conversion_review','measurement_review') NOT NULL,
  `chargeDefinitionId` int,
  `scopeLevel` varchar(40),
  `rateMillis` int,
  `billableQuantityMillis` int,
  `minimumApplied` boolean NOT NULL DEFAULT false,
  `incrementApplied` boolean NOT NULL DEFAULT false,
  `formula` varchar(400) NOT NULL,
  `inputsJson` text NOT NULL,
  `amountCents` int,
  `reasonsJson` text NOT NULL,
  `decidedByUserId` int NOT NULL,
  `decidedAt` timestamp NOT NULL DEFAULT (now()),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `pricingDecisions_id` PRIMARY KEY(`id`),
  CONSTRAINT `pricingDecisions_decisionRef_unique` UNIQUE(`decisionRef`)
);
--> statement-breakpoint
CREATE INDEX `pricingDecisions_subject` ON `pricingDecisions` (`subjectKind`, `subjectRef`);
--> statement-breakpoint

CREATE TABLE `commercialSetupProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  `servicesJson` text NOT NULL,
  `targetMarginBps` int,
  `warningMarginBps` int,
  `minimumAuthorityMarginBps` int,
  `discountAuthorityJson` text NOT NULL,
  `openBookCustomersJson` text NOT NULL,
  `setByUserId` int NOT NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialSetupProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialSetupProfiles_entity_unique` UNIQUE(`financialEntityId`)
);
