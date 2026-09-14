-- v20.23 — Insurance & Risk.
--
-- A policy is a structured object, not a PDF in a folder. Coverage is separate
-- from the policy because one policy covers fifty trucks; the covered-entity
-- rows are the fifty relationships, and the certificate is ONE evidence record
-- related to all of them. A customer's certificate-of-insurance requirement is
-- stored apart from the company's policies, and matched. A claim links to the
-- incident that caused it — whose original driver statement is never
-- rewritten — and keeps the expense side and the recovery side as two things,
-- so an insurer's payment never erases the repair bill.

CREATE TABLE `insuranceProviders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `providerRef` varchar(64) NOT NULL,
  `name` varchar(220) NOT NULL,
  `role` enum('insurer','broker','adjuster','other') NOT NULL,
  `claimsPhone` varchar(40),
  `afterHoursPhone` varchar(40),
  `billingContact` varchar(220),
  `underwriterContact` varchar(220),
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceProviders_id` PRIMARY KEY(`id`),
  CONSTRAINT `insuranceProviders_providerRef_unique` UNIQUE(`providerRef`)
);
--> statement-breakpoint

CREATE TABLE `insurancePolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `policyType` enum('commercial_auto','physical_damage','cargo','general_liability','property','equipment','pollution_environmental','garage','cyber','professional_liability','umbrella_excess','non_owned_auto','wcb','surety_bond','other') NOT NULL,
  `insurerId` int NOT NULL,
  `brokerId` int,
  `policyNumber` varchar(120) NOT NULL,
  `effectiveAt` timestamp NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `status` enum('quoted','binder','active','renewal_pending','cancelled','expired') NOT NULL DEFAULT 'active',
  `annualPremium` double,
  `deductible` double,
  -- The policy document. One record, related to every covered entity.
  `evidenceRecordId` int,
  -- Whether a person has confirmed the coverage with the insurer/broker, as
  -- distinct from the document being on file.
  `coverageVerificationStatus` enum('coverage_verified','coverage_reported','coverage_unknown') NOT NULL DEFAULT 'coverage_reported',
  `coverageVerifiedAt` timestamp,
  `coverageVerifiedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insurancePolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `insurancePolicies_policyRef_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint
CREATE INDEX `insurancePolicies_entity_idx` ON `insurancePolicies` (`financialEntityId`, `status`, `expiresAt`);
--> statement-breakpoint

CREATE TABLE `insurancePolicyCoverages` (
  `id` int AUTO_INCREMENT NOT NULL,
  `insurancePolicyId` int NOT NULL,
  `coverageType` varchar(80) NOT NULL,
  `limitAmount` double,
  `limitBasis` enum('per_occurrence','aggregate','per_vehicle','per_load','other'),
  `deductible` double,
  `additionalInsuredEndorsement` boolean NOT NULL DEFAULT false,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insurancePolicyCoverages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `insuranceCoveredEntities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `insurancePolicyId` int NOT NULL,
  `entityType` enum('unit','trailer','equipment','operator','branch','facility','company') NOT NULL,
  `entityId` int NOT NULL,
  `coveredFrom` timestamp NOT NULL,
  `coveredUntil` timestamp,
  `statedValue` double,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceCoveredEntities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `insuranceCoveredEntities_entity_idx` ON `insuranceCoveredEntities` (`entityType`, `entityId`);
--> statement-breakpoint

-- What a customer requires of us. Stored apart from what we hold.
CREATE TABLE `insuranceRequirements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `customerRef` varchar(220) NOT NULL,
  `coverageType` varchar(80) NOT NULL,
  `minimumLimit` double,
  `additionalInsuredRequired` boolean NOT NULL DEFAULT false,
  `contractingEntityRef` varchar(220),
  `certificateExpiryRequired` boolean NOT NULL DEFAULT true,
  `notes` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceRequirements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `insuranceRequirements_customer_idx` ON `insuranceRequirements` (`customerRef`);
--> statement-breakpoint

CREATE TABLE `insuranceCertificates` (
  `id` int AUTO_INCREMENT NOT NULL,
  `certificateRef` varchar(64) NOT NULL,
  `insurancePolicyId` int NOT NULL,
  `recipientCustomerRef` varchar(220) NOT NULL,
  `issuedAt` timestamp NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `additionalInsuredNamed` boolean NOT NULL DEFAULT false,
  `evidenceRecordId` int,
  `sharedAt` timestamp,
  `sharedByUserId` int,
  `supersededByCertificateId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceCertificates_id` PRIMARY KEY(`id`),
  CONSTRAINT `insuranceCertificates_certificateRef_unique` UNIQUE(`certificateRef`)
);
--> statement-breakpoint

CREATE TABLE `insuranceClaims` (
  `id` int AUTO_INCREMENT NOT NULL,
  `claimRef` varchar(64) NOT NULL,
  `insurancePolicyId` int NOT NULL,
  `incidentReportId` int,
  `roadsideEventId` int,
  `unitId` int,
  `trailerId` int,
  `jobId` int,
  `lossOccurredAt` timestamp NOT NULL,
  `claimType` enum('collision','cargo','property','equipment','environmental','theft','glass','liability','other') NOT NULL,
  `insurerClaimNumber` varchar(120),
  `status` enum('potential','reported','adjuster_assigned','information_requested','under_review','approved','denied','settled','closed') NOT NULL DEFAULT 'potential',
  `deductible` double,
  `estimatedLoss` double,
  `approvedAmount` double,
  `openedByUserId` int NOT NULL,
  `openedAt` timestamp NOT NULL,
  `closedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceClaims_id` PRIMARY KEY(`id`),
  CONSTRAINT `insuranceClaims_claimRef_unique` UNIQUE(`claimRef`)
);
--> statement-breakpoint

-- The expense side. Never erased by a recovery.
CREATE TABLE `insuranceClaimCosts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `insuranceClaimId` int NOT NULL,
  `costType` enum('tow','repair','rental_replacement','cleanup','cargo_loss','downtime','legal','other') NOT NULL,
  `amount` double NOT NULL,
  `vendorBillId` int,
  `expenseRecordId` int,
  `incurredAt` timestamp NOT NULL,
  `note` varchar(300),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceClaimCosts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- The recovery side: what the insurer approved, and what actually arrived.
CREATE TABLE `insuranceClaimRecoveries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `insuranceClaimId` int NOT NULL,
  `recoveryType` enum('approved','received','denied','adjustment') NOT NULL,
  `amount` double NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `reference` varchar(120),
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `insuranceClaimRecoveries_id` PRIMARY KEY(`id`)
);
