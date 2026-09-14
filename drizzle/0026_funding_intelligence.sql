-- B20.13 — Funding & Incentives Intelligence.
--
-- A grant, tax credit, subsidy or financing program is a knowledge object with
-- the same discipline as a tax rule or an external data source: it carries a
-- source, a verification status, an effective window and a version. Program
-- parameters — percentages, caps, deadlines, eligibility — are recorded as
-- CLAIMED until somebody verifies them against the administering authority.
--
-- An unverified program can be surfaced as "worth investigating". It cannot be
-- presented as money. The status ladder on an opportunity runs
-- estimated → potential → pre_screened → application_submitted → approved →
-- claimed → received, and only the last three describe money that exists.
--
-- The stacking ledger is the part that protects the company: one expense, one
-- funded amount per program, and a detector for the same invoice being claimed
-- twice. Many programs forbid it, and the failure is discovered at audit.

CREATE TABLE `fundingProgramSources` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sourceKey` varchar(120) NOT NULL,
  `authority` varchar(220) NOT NULL,
  `sourceUrl` varchar(600),
  `retrievedAt` timestamp,
  `verifiedAt` timestamp, `verifiedByUserId` int,
  `status` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fundingProgramSources_id` PRIMARY KEY(`id`),
  CONSTRAINT `fundingProgramSources_sourceKey_unique` UNIQUE(`sourceKey`)
);
--> statement-breakpoint

CREATE TABLE `fundingPrograms` (
  `id` int AUTO_INCREMENT NOT NULL,
  `programKey` varchar(120) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `officialName` varchar(300) NOT NULL,
  `governmentLevel` enum('federal','provincial','municipal','regional','industry','other') NOT NULL,
  `country` varchar(8) NOT NULL DEFAULT 'CA',
  `province` varchar(8),
  `administeringOrganization` varchar(220),
  -- Grant ≠ loan ≠ tax credit ≠ deduction. Presenting a loan guarantee as a
  -- grant misstates who ends up owing the money.
  `programType` enum('grant','loan','loan_guarantee','refundable_tax_credit','non_refundable_tax_credit','deduction','rebate','wage_subsidy','cost_share','insurance_risk_management','equity_investment','tax_system_grant') NOT NULL,
  `deliveryMechanism` enum('application_intake','tax_return','lender','continuous','other') NOT NULL DEFAULT 'application_intake',
  `categoryKey` varchar(80) NOT NULL,
  -- Structured eligibility and parameters as claimed by the source. JSON so a
  -- program can carry whatever shape it needs; the engine reads named keys.
  `applicantTypesJson` text,
  `industriesJson` text,
  `exclusionsJson` text,
  `parametersJson` text,
  `preApprovalRequired` boolean NOT NULL DEFAULT false,
  `stackingRule` enum('unknown','permitted','prohibited','conditional') NOT NULL DEFAULT 'unknown',
  `programStatus` enum('unknown','open','closed','upcoming','expired','funding_exhausted','source_changed') NOT NULL DEFAULT 'unknown',
  `intakeOpensAt` timestamp, `intakeClosesAt` timestamp,
  `fundingExhaustionPossible` boolean NOT NULL DEFAULT false,
  `temporaryProgram` boolean NOT NULL DEFAULT false,
  `effectiveFrom` timestamp, `effectiveUntil` timestamp,
  `sourceId` int,
  `verificationStatus` enum('unverified','verified','expired','superseded') NOT NULL DEFAULT 'unverified',
  `lastVerifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fundingPrograms_id` PRIMARY KEY(`id`),
  CONSTRAINT `fundingPrograms_key_version_unique` UNIQUE(`programKey`, `version`)
);
--> statement-breakpoint
CREATE INDEX `fundingPrograms_category_idx` ON `fundingPrograms` (`categoryKey`, `verificationStatus`);
--> statement-breakpoint

-- A program matched to a company. The status ladder is the point: an estimate
-- and received money are not the same row state, and the UI reads the state.
CREATE TABLE `fundingOpportunities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `opportunityRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `fundingProgramId` int NOT NULL,
  `triggerEvent` varchar(80),
  `triggerRecordRef` varchar(120),
  `matchStrength` enum('strong','possible','more_information_required','excluded') NOT NULL,
  `matchReasonsJson` text,
  `missingInformationJson` text,
  `estimatedAmount` double,
  `estimateBasis` varchar(300),
  `status` enum('estimated','potential','pre_screened','application_submitted','approved','claimed','received','declined','expired','withdrawn') NOT NULL DEFAULT 'estimated',
  `preApprovalWarning` boolean NOT NULL DEFAULT false,
  `deadlineAt` timestamp,
  `assignedToUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `fundingOpportunities_id` PRIMARY KEY(`id`),
  CONSTRAINT `fundingOpportunities_ref_unique` UNIQUE(`opportunityRef`)
);
--> statement-breakpoint
CREATE INDEX `fundingOpportunities_entity_idx` ON `fundingOpportunities` (`financialEntityId`, `status`);
--> statement-breakpoint

-- The stacking ledger. One row per (expense, program) funding association.
CREATE TABLE `fundingClaims` (
  `id` int AUTO_INCREMENT NOT NULL,
  `claimRef` varchar(64) NOT NULL,
  `fundingOpportunityId` int NOT NULL,
  `fundingProgramId` int NOT NULL,
  `expenseRef` varchar(120) NOT NULL,
  `eligibleCost` double NOT NULL,
  `claimedAmount` double NOT NULL,
  `claimDate` timestamp NOT NULL,
  `status` enum('draft','submitted','approved','paid','rejected','withdrawn') NOT NULL DEFAULT 'draft',
  `evidenceRecordIdsJson` text,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fundingClaims_id` PRIMARY KEY(`id`),
  CONSTRAINT `fundingClaims_claimRef_unique` UNIQUE(`claimRef`)
);
--> statement-breakpoint
CREATE INDEX `fundingClaims_expense_idx` ON `fundingClaims` (`expenseRef`, `status`);
