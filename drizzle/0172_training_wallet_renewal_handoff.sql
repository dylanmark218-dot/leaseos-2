-- 0172 — Training Academy / Workforce: wallet, renewal, external handoff, study centre.
--
-- Slot: 0169–0171 are claimed by active branches (defect_resolution,
-- dispatch_role_types / organization_scoped_role_grants,
-- dispatch_role_assignment_events), so this checkpoint starts at 0172.
--
-- Nothing here is a second store. The wallet IS `workerQualifications` — the
-- holding table the canonical `countsAsHeld` rule already reads and that no
-- production path wrote until now. The study centre IS the Academy: its
-- questions, modules, assessments and attempts gain a kind and a source
-- reference. Provider identity IS `vendors`; this adds only what a vendor can
-- teach. Reminders go through `workflowNotifications`, whose unique
-- `notificationKey` is the idempotency guard. Handoff history goes to the
-- hash-chained `academyAuditEvents`.

-- ---- the wallet: the facts a credential carries --------------------------
ALTER TABLE `workerQualifications`
  ADD COLUMN `displayName` varchar(220) NULL,
  ADD COLUMN `issuer` varchar(220) NULL,
  ADD COLUMN `issuingJurisdiction` varchar(40) NULL,
  ADD COLUMN `endorsementsJson` text NULL,
  ADD COLUMN `restrictionsJson` text NULL,
  ADD COLUMN `walletBoundary` enum('employer_issued','company_competency','regulator_issued','external_provider','study_only') NULL,
  ADD COLUMN `verificationMethod` varchar(40) NULL,
  ADD COLUMN `verificationSource` varchar(300) NULL,
  ADD COLUMN `backDocumentRef` varchar(64) NULL,
  ADD COLUMN `privateNotes` text NULL,
  ADD COLUMN `supersedesHoldingRef` varchar(64) NULL,
  ADD COLUMN `policyRef` varchar(96) NULL,
  ADD COLUMN `handoffRef` varchar(96) NULL;
--> statement-breakpoint

-- ---- the study library: licence and retrieval facts on the source registry
ALTER TABLE `academySourceRecords`
  ADD COLUMN `sourceKind` enum('study_source','provider_directory','regulatory_reference') NOT NULL DEFAULT 'study_source',
  ADD COLUMN `licenceStatus` enum('unknown','link_only','open_licence_stated','redistribution_prohibited') NOT NULL DEFAULT 'unknown',
  ADD COLUMN `licenceNote` varchar(500) NULL,
  ADD COLUMN `retrievedAt` timestamp NULL,
  ADD COLUMN `contentHash` varchar(64) NULL,
  ADD COLUMN `capabilityCodesJson` text NULL,
  ADD COLUMN `redistributionConfirmedByUserId` int NULL,
  ADD COLUMN `redistributionConfirmedAt` timestamp NULL;
--> statement-breakpoint

-- ---- the assessment engine: what an attempt is for ------------------------
ALTER TABLE `academyAssessments`
  ADD COLUMN `assessmentKind` enum('FINAL_INTERNAL','PRACTICE','MOCK_EXAM','COMPETENCY_KNOWLEDGE') NOT NULL DEFAULT 'FINAL_INTERNAL';
--> statement-breakpoint
ALTER TABLE `academyAssessmentAttempts`
  ADD COLUMN `assessmentKind` enum('FINAL_INTERNAL','PRACTICE','MOCK_EXAM','COMPETENCY_KNOWLEDGE') NOT NULL DEFAULT 'FINAL_INTERNAL';
--> statement-breakpoint
ALTER TABLE `academyQuestions`
  ADD COLUMN `sourceRef` varchar(96) NULL,
  ADD COLUMN `sourceSection` varchar(200) NULL;
--> statement-breakpoint
ALTER TABLE `academyModules`
  ADD COLUMN `sourceRef` varchar(96) NULL,
  ADD COLUMN `sourceSection` varchar(200) NULL,
  ADD COLUMN `companySpecific` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `academyAssignments`
  ADD COLUMN `selfEnrolled` boolean NOT NULL DEFAULT false,
  ADD COLUMN `lastModuleCode` varchar(80) NULL,
  ADD COLUMN `lastViewedAt` timestamp NULL;
--> statement-breakpoint

-- ---- renewal policy: which KIND of date governs a credential --------------
CREATE TABLE `credentialRenewalPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(96) NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `displayName` varchar(220) NOT NULL,
  `jurisdiction` varchar(40) NOT NULL,
  `policyVersion` int NOT NULL,
  `boundary` enum('employer_issued','company_competency','regulator_issued','external_provider','study_only') NOT NULL,
  `lifecycle` enum('actual_expiry','server_profile_expiry','no_expiry_endorsement','employer_review','unknown') NOT NULL,
  `typicalValidityMonths` int NULL,
  `regulatoryProfileRef` varchar(96) NULL,
  `parentAnyOfJson` text NULL,
  `handoffCapabilitiesJson` text NULL,
  `sourceRefsJson` text NOT NULL,
  `renewalPathwayJson` text NULL,
  `reminderTemplate` text NOT NULL,
  `notes` text NOT NULL,
  `policyHash` varchar(64) NOT NULL,
  `effectiveAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `credentialRenewalPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `credentialRenewalPolicies_ref_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint
CREATE INDEX `credentialRenewalPolicies_code` ON `credentialRenewalPolicies` (`qualificationCode`, `policyVersion`);
--> statement-breakpoint

-- ---- company policy: notification thresholds and review intervals ---------
CREATE TABLE `credentialCompanySettings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tenantId` varchar(40) NOT NULL,
  `warningThresholdsJson` text NOT NULL,
  `perCodeJson` text NULL,
  `updatedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `credentialCompanySettings_id` PRIMARY KEY(`id`),
  CONSTRAINT `credentialCompanySettings_tenant_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint

-- ---- what a vendor can teach (identity stays in `vendors`) ---------------
CREATE TABLE `trainingProviderCapabilities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `capabilityRef` varchar(96) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `vendorId` int NOT NULL,
  `capabilityCode` varchar(60) NOT NULL,
  `preferred` boolean NOT NULL DEFAULT false,
  `bookingUrl` varchar(1024) NULL,
  `serviceArea` varchar(220) NULL,
  `notes` varchar(1000) NULL,
  `active` boolean NOT NULL DEFAULT true,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `trainingProviderCapabilities_id` PRIMARY KEY(`id`),
  CONSTRAINT `trainingProviderCapabilities_ref_unique` UNIQUE(`capabilityRef`),
  CONSTRAINT `trainingProviderCapabilities_vendor_code` UNIQUE(`vendorId`, `capabilityCode`)
);
--> statement-breakpoint

-- ---- the external training handoff --------------------------------------
CREATE TABLE `externalTrainingHandoffs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `handoffRef` varchar(96) NOT NULL,
  `tenantId` varchar(40) NOT NULL,
  `userId` int NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `capabilityCode` varchar(60) NULL,
  `triggerKind` enum('expiring','expired','missing_required','new_hire','career_development','employee_request','admin_initiated') NOT NULL,
  `reason` varchar(500) NULL,
  `status` enum('ACTION_REQUIRED','REQUESTED','ADMIN_REVIEW','PROVIDER_SELECTED','BOOKING_IN_PROGRESS','BOOKED','TRAINING_COMPLETED','DOCUMENT_PENDING','DOCUMENT_UPLOADED_UNVERIFIED','VERIFIED','ACTIVE','CANCELLED','EXPIRED','NOT_REQUIRED','UNKNOWN') NOT NULL DEFAULT 'REQUESTED',
  `dueAt` timestamp NULL,
  `currentExpiresAt` timestamp NULL,
  `preferredArea` varchar(220) NULL,
  `providerVendorId` int NULL,
  `providerContact` varchar(300) NULL,
  `officialSourceRef` varchar(96) NULL,
  `providerUrl` varchar(1024) NULL,
  `ownerUserId` int NULL,
  `bookingReference` varchar(120) NULL,
  `appointmentAt` timestamp NULL,
  `appointmentEndsAt` timestamp NULL,
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `linkedHoldingRef` varchar(64) NULL,
  `dispatchImpact` varchar(500) NULL,
  `lastTransitionAt` timestamp NOT NULL,
  `closedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `externalTrainingHandoffs_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalTrainingHandoffs_ref_unique` UNIQUE(`handoffRef`)
);
--> statement-breakpoint
CREATE INDEX `externalTrainingHandoffs_queue` ON `externalTrainingHandoffs` (`tenantId`, `status`);
--> statement-breakpoint
CREATE INDEX `externalTrainingHandoffs_person` ON `externalTrainingHandoffs` (`userId`, `qualificationCode`);
--> statement-breakpoint

-- ---- practice: bookmarks ------------------------------------------------
CREATE TABLE `academyQuestionBookmarks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `questionId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyQuestionBookmarks_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyQuestionBookmarks_user_question` UNIQUE(`userId`, `questionId`)
);
