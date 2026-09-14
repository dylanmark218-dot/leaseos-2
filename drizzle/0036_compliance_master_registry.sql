-- v20.21 — Compliance Master Registry.
--
-- Compliance stops being a collection of documents and becomes a question:
-- is this person, carrier, unit, trailer and job ready for the work being
-- attempted, under the rules that apply here, today?
--
-- A requirement is a rule row, mirroring `taxRules`: it says why it applies,
-- where, from when, from which source, and what evidence satisfies it. An
-- unverified requirement produces UNKNOWN, never PASS. The regulatory figures
-- the specification cites — twelve-month abstracts, medical intervals by age,
-- three-year certificate terms — are seeded as unverified claims, exactly as
-- the tax thresholds were.
--
-- A credential is a `complianceDocuments` row. That table already carried
-- owner, type, expiry, verification and provenance; it gains the subjects it
-- lacked and the fields a passport needs.

ALTER TABLE `complianceDocuments`
  MODIFY COLUMN `ownerType` enum('operator','unit','job','trailer','carrier','user','equipment') NOT NULL,
  ADD COLUMN `requirementKey` varchar(120) NULL AFTER `docType`,
  ADD COLUMN `identifier` varchar(120) NULL AFTER `title`,
  ADD COLUMN `issuedAt` timestamp NULL AFTER `capturedAt`,
  ADD COLUMN `jurisdiction` varchar(80) NULL AFTER `expiresAt`,
  ADD COLUMN `verifiedByUserId` int NULL AFTER `verificationStatus`,
  ADD COLUMN `verifiedAt` timestamp NULL AFTER `verifiedByUserId`,
  -- Medical fitness and the like: the row exists so the passport can say
  -- "eligible", and nothing else about it is projected outside HR.
  ADD COLUMN `privateDetail` boolean NOT NULL DEFAULT false AFTER `verifiedAt`,
  ADD COLUMN `evidenceRecordId` int NULL AFTER `privateDetail`;
--> statement-breakpoint

CREATE TABLE `complianceRequirements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requirementKey` varchar(120) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `family` varchar(60) NOT NULL,
  `title` varchar(220) NOT NULL,
  `subjectType` enum('operator','unit','trailer','carrier','job','user') NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  -- JSON predicate on the subject, e.g. {"licenceClass":"1"} or {"gvwKgAtLeast":11794}.
  `appliesWhenJson` text,
  -- Which complianceDocuments.docType values satisfy it.
  `satisfiedByDocTypes` text NOT NULL,
  `renewalIntervalDays` int,
  `warnDaysBeforeExpiry` int NOT NULL DEFAULT 30,
  -- What a missing document means. A missing proof-of-insurance is review
  -- (coverage may exist unproven); a missing licence is blocking.
  `missingSeverity` enum('review','blocked') NOT NULL DEFAULT 'review',
  `sourceAuthority` varchar(220),
  `sourceUrl` varchar(600),
  `sourceReference` varchar(300),
  `effectiveFrom` timestamp NOT NULL,
  `effectiveUntil` timestamp,
  `verificationStatus` enum('unverified','verified','superseded','withdrawn') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `complianceRequirements_id` PRIMARY KEY(`id`),
  CONSTRAINT `complianceRequirements_key_version_unique` UNIQUE(`requirementKey`,`version`)
);
--> statement-breakpoint
CREATE INDEX `complianceRequirements_subject_idx` ON `complianceRequirements` (`subjectType`, `jurisdiction`, `verificationStatus`);
--> statement-breakpoint

-- An abstract is obtained under a driver's written authorization, for a
-- purpose, by someone, and access to it is regulated. The consent is the
-- record; the abstract is evidence attached to it.
CREATE TABLE `complianceConsents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `consentRef` varchar(64) NOT NULL,
  `subjectUserId` int NOT NULL,
  `consentType` enum('driver_abstract','commercial_driver_abstract','medical_fitness_confirmation','experience_record_release','background_check','other') NOT NULL,
  `purpose` varchar(300) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `signedAt` timestamp NOT NULL,
  `validUntil` timestamp,
  `coveragePeriodFrom` timestamp,
  `coveragePeriodTo` timestamp,
  `signatureEvidenceRecordId` int,
  `payloadHash` varchar(64),
  `withdrawnAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `complianceConsents_id` PRIMARY KEY(`id`),
  CONSTRAINT `complianceConsents_consentRef_unique` UNIQUE(`consentRef`)
);
--> statement-breakpoint
CREATE INDEX `complianceConsents_subject_idx` ON `complianceConsents` (`subjectUserId`, `consentType`);
--> statement-breakpoint

-- Written safety and maintenance programs, versioned. Never overwritten.
CREATE TABLE `writtenProgramVersions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `programKey` varchar(80) NOT NULL,
  `version` int NOT NULL,
  `title` varchar(220) NOT NULL,
  `programType` enum('safety','maintenance','ohs','emergency_response','other') NOT NULL,
  `financialEntityId` int NOT NULL,
  `effectiveFrom` timestamp NOT NULL,
  `supersededAt` timestamp,
  `supersededByVersion` int,
  `approvedByUserId` int NOT NULL,
  `approvedAt` timestamp NOT NULL,
  `reviewDueAt` timestamp,
  `applicableBranchesJson` text,
  `applicableEquipmentJson` text,
  `documentEvidenceRecordId` int,
  `contentHash` varchar(64),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `writtenProgramVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `writtenProgramVersions_key_version_unique` UNIQUE(`programKey`,`version`)
);
--> statement-breakpoint

CREATE TABLE `programAcknowledgements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `writtenProgramVersionId` int NOT NULL,
  `userId` int NOT NULL,
  `acknowledgedAt` timestamp NOT NULL,
  `method` enum('app','signature','training_session') NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `programAcknowledgements_id` PRIMARY KEY(`id`),
  CONSTRAINT `programAcknowledgements_version_user_unique` UNIQUE(`writtenProgramVersionId`,`userId`)
);
--> statement-breakpoint

-- The regulator's view of the carrier, reconciled against ours. An event on
-- their profile that LeaseOS does not know about is an exception to work.
CREATE TABLE `carrierProfileReviews` (
  `id` int AUTO_INCREMENT NOT NULL,
  `reviewRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  `profileObtainedAt` timestamp NOT NULL,
  `reviewedAt` timestamp,
  `reviewedByUserId` int,
  `nextReviewDueAt` timestamp,
  `inspectionsOnProfile` int NOT NULL DEFAULT 0,
  `convictionsOnProfile` int NOT NULL DEFAULT 0,
  `collisionsOnProfile` int NOT NULL DEFAULT 0,
  `unmatchedExternalEvents` int NOT NULL DEFAULT 0,
  `riskTrend` enum('improving','stable','worsening','unknown') NOT NULL DEFAULT 'unknown',
  `evidenceRecordId` int,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `carrierProfileReviews_id` PRIMARY KEY(`id`),
  CONSTRAINT `carrierProfileReviews_reviewRef_unique` UNIQUE(`reviewRef`)
);
