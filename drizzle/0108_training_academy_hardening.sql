ALTER TABLE `academyCertificates`
  ADD COLUMN `status` enum('pending_signature','active','revoked') NOT NULL DEFAULT 'active' AFTER `credentialBoundary`,
  ADD COLUMN `employeeNameSnapshot` varchar(220) NULL AFTER `issuedByUserId`,
  ADD COLUMN `employerNameSnapshot` varchar(220) NULL AFTER `employeeNameSnapshot`,
  ADD COLUMN `employerBusinessAddressSnapshot` varchar(500) NULL AFTER `employerNameSnapshot`,
  ADD COLUMN `trainingAspectsJson` text NULL AFTER `employerBusinessAddressSnapshot`,
  ADD COLUMN `finalizedAt` timestamp NULL AFTER `issuedAt`,
  ADD COLUMN `retentionUntil` timestamp NULL AFTER `expiresAt`,
  ADD COLUMN `regulatoryProfileRef` varchar(96) NULL AFTER `sourceSnapshotRef`,
  ADD COLUMN `regulatoryProfileHash` varchar(64) NULL AFTER `regulatoryProfileRef`,
  ADD COLUMN `statementOfExperienceId` int NULL AFTER `regulatoryProfileHash`,
  ADD COLUMN `attestationStatement` text NULL AFTER `statementOfExperienceId`,
  ADD COLUMN `attestedAt` timestamp NULL AFTER `attestationStatement`;
--> statement-breakpoint
ALTER TABLE `academySourceRecords`
  ADD COLUMN `sourceTier` enum('authority','industry_association','vendor','unknown') NOT NULL DEFAULT 'unknown' AFTER `authority`;
--> statement-breakpoint
UPDATE `academySourceRecords`
SET `sourceTier` = 'authority'
WHERE `sourceRef` IN ('SRC-WHMIS-AB-2026','SRC-TDG-ROAD-2026','SRC-ERG-2024','SRC-COMPANY-POLICY-TEMPLATE');
--> statement-breakpoint
CREATE TABLE `academyRegulatoryProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `profileRef` varchar(96) NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `mode` enum('road','rail','vessel','air','workplace','company') NOT NULL,
  `profileVersion` int NOT NULL,
  `credentialBoundary` enum('employer_certificate','company_certificate') NOT NULL,
  `validityMonths` int,
  `retentionMonthsAfterExpiry` int,
  `requiresEmployeeSignature` boolean NOT NULL DEFAULT false,
  `requiresEmployerSignature` boolean NOT NULL DEFAULT false,
  `requiresReasonableGroundsAttestation` boolean NOT NULL DEFAULT false,
  `sourceSnapshotRef` varchar(96) NOT NULL,
  `effectiveAt` timestamp NOT NULL,
  `supersededAt` timestamp,
  `profileHash` varchar(64) NOT NULL,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyRegulatoryProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyRegulatoryProfiles_profileRef_unique` UNIQUE(`profileRef`)
);
--> statement-breakpoint
CREATE INDEX `academyRegulatoryProfiles_qualification_mode_idx`
  ON `academyRegulatoryProfiles` (`qualificationCode`,`mode`,`supersededAt`);
--> statement-breakpoint
CREATE TABLE `academyCertificateSignatures` (
  `id` int AUTO_INCREMENT NOT NULL,
  `signatureRef` varchar(96) NOT NULL,
  `certificateId` int NOT NULL,
  `signerUserId` int NOT NULL,
  `signerParty` enum('employee','employer_representative','self_employed') NOT NULL,
  `signerName` varchar(220) NOT NULL,
  `signerRole` varchar(160) NOT NULL,
  `signatureMethod` enum('drawn','electronic_ack','paper_scan') NOT NULL,
  `signatureEvidenceRecordId` int,
  `payloadHash` varchar(64) NOT NULL,
  `signedAt` timestamp NOT NULL,
  `capturedOffline` boolean NOT NULL DEFAULT false,
  `invalidatedAt` timestamp,
  `invalidationReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyCertificateSignatures_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyCertificateSignatures_signatureRef_unique` UNIQUE(`signatureRef`)
);
--> statement-breakpoint
CREATE INDEX `academyCertificateSignatures_certificate_party_idx`
  ON `academyCertificateSignatures` (`certificateId`,`signerParty`,`invalidatedAt`);
--> statement-breakpoint
CREATE TABLE `academyStatementsOfExperience` (
  `id` int AUTO_INCREMENT NOT NULL,
  `statementRef` varchar(96) NOT NULL,
  `userId` int NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `experienceFrom` timestamp NOT NULL,
  `experienceTo` timestamp NOT NULL,
  `dutiesJson` text NOT NULL,
  `dangerousGoodsScopeJson` text,
  `preparedByUserId` int NOT NULL,
  `employerAttestation` text NOT NULL,
  `sourceCertificateId` int,
  `payloadHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyStatementsOfExperience_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyStatementsOfExperience_statementRef_unique` UNIQUE(`statementRef`)
);
--> statement-breakpoint
CREATE INDEX `academyStatementsOfExperience_user_qualification_idx`
  ON `academyStatementsOfExperience` (`userId`,`qualificationCode`,`experienceTo`);
--> statement-breakpoint
CREATE TABLE `complianceKnowledgeItems` (
  `id` int AUTO_INCREMENT NOT NULL,
  `code` varchar(100) NOT NULL,
  `category` enum('tdg','whmis','erg','placards','waste_manifest','cargo_securement','company_policy') NOT NULL,
  `title` varchar(240) NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  `summary` text,
  `bodyJson` text,
  `sourceAuthority` varchar(220),
  `sourceUrl` varchar(1024),
  `regulatoryVersion` varchar(180),
  `sourceVerifiedAt` timestamp,
  `companyScope` varchar(180),
  `companySpecific` boolean NOT NULL DEFAULT false,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `complianceKnowledgeItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `complianceKnowledgeItems_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE INDEX `complianceKnowledgeItems_category_idx`
  ON `complianceKnowledgeItems` (`category`,`jurisdiction`,`active`);
--> statement-breakpoint
CREATE TRIGGER `academyCertificates_retention_guard`
BEFORE DELETE ON `academyCertificates`
FOR EACH ROW
BEGIN
  IF OLD.`retentionUntil` IS NOT NULL AND OLD.`retentionUntil` > CURRENT_TIMESTAMP THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'academy certificate retention period has not elapsed';
  END IF;
END;
