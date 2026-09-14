-- v21.16 — Capital assets, CCA, the asset twin.
--
-- A truck is one identity. A capital asset links to the unit, trailer or
-- equipment record the shop already maintains; nothing is entered twice.
-- Acquisition, financing and disposal are facts in cents with their
-- evidence. The CCA class is a CANDIDATE with a source until a person
-- verifies it against the accountant's determination; the class's rate is a
-- tax rule row, unverified with no rate written, so the pool arithmetic is
-- computed from facts while the claim stays UNKNOWN until the rate is
-- verified. A year-end schedule is a snapshot prepared by one person and
-- reviewed by another.

CREATE TABLE `capitalAssets` (
  `id` int AUTO_INCREMENT NOT NULL,
  `assetRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `kind` enum('unit','trailer','equipment','building','leasehold','other') NOT NULL,
  `unitId` int,
  `trailerId` int,
  `description` varchar(220) NOT NULL,
  `acquiredAt` timestamp NOT NULL,
  `acquisitionCostCents` int NOT NULL,
  `acquisitionVendorBillId` int,
  `acquisitionEvidenceRecordId` int,
  `financing` enum('owned','financed','leased') NOT NULL DEFAULT 'owned',
  `lender` varchar(160),
  `financedPrincipalCents` int,
  `ccaClassCandidate` varchar(20),
  `ccaClassSource` enum('accountant','owner_stated','system_inferred'),
  `ccaClassVerificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified',
  `ccaClassVerifiedByUserId` int,
  `expectedLifeKm` int,
  `expectedLifeYears` int,
  `status` enum('pending_capital_review','in_service','out_of_service','disposed','expensed') NOT NULL DEFAULT 'pending_capital_review',
  `capitalReviewedByUserId` int,
  `capitalReviewedAt` timestamp,
  `capitalReviewReason` varchar(400),
  `disposedAt` timestamp,
  `disposalProceedsCents` int,
  `disposalEvidenceRecordId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `capitalAssets_id` PRIMARY KEY(`id`),
  CONSTRAINT `capitalAssets_assetRef_unique` UNIQUE(`assetRef`),
  CONSTRAINT `capitalAssets_unitId_unique` UNIQUE(`unitId`),
  CONSTRAINT `capitalAssets_trailerId_unique` UNIQUE(`trailerId`)
);
--> statement-breakpoint

CREATE TABLE `ccaSchedules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `scheduleRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `fiscalYearEnd` timestamp NOT NULL,
  `summaryJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `determination` enum('computed','partial','unknown') NOT NULL,
  `totalCcaClaimCents` int,
  `status` enum('prepared','reviewed','superseded') NOT NULL DEFAULT 'prepared',
  `preparedByUserId` int NOT NULL,
  `preparedAt` timestamp NOT NULL,
  `reviewedByUserId` int,
  `reviewedAt` timestamp,
  `reviewNote` varchar(400),
  `supersedesScheduleId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `ccaSchedules_id` PRIMARY KEY(`id`),
  CONSTRAINT `ccaSchedules_scheduleRef_unique` UNIQUE(`scheduleRef`)
);
--> statement-breakpoint

-- Closing UCC carried into the next year is a fact from the reviewed schedule, not recomputed from memory.
CREATE TABLE `ccaClassBalances` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  `ccaClass` varchar(20) NOT NULL,
  `fiscalYearEnd` timestamp NOT NULL,
  `closingUccCents` int NOT NULL,
  `fromScheduleId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `ccaClassBalances_id` PRIMARY KEY(`id`),
  CONSTRAINT `ccaClassBalances_entity_class_year_unique` UNIQUE(`financialEntityId`,`ccaClass`,`fiscalYearEnd`)
);
