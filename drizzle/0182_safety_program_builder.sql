-- 0182 — Safety & Compliance Program Builder: the data model and template engine.
--
-- Slot: main ends at 0174 (C1a). Claims on open branches at this checkpoint (2026-09-24, scanned
-- with the collision register's command): 0170 (eld, auth-workspace, work-calendar), 0172–0175
-- (training-academy-workforce), 0175–0177 (driver-portfolio ×2), 0178–0181 (document-control),
-- 0179 (eld-event-ledger, migration-0169-reconciliation). 0182 is the first number no branch holds.
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- What this is. A trucking, hydrovac, vacuum-truck, construction or oilfield-service company builds
-- a written and IMPLEMENTED safety management system from LeaseOS templates rather than a blank
-- document. Alberta separates the requirements — an NSC carrier's safety and maintenance programs are
-- not satisfied by an OHS program alone, and an employer of 20+ regularly employed workers must have a
-- health and safety program — so the model separates them too: the library is organized by module
-- and by jurisdiction pack, and a company assembles its manual from the packs that apply to it.
--
-- Why every policy is a controlled object and not a paragraph. A COR audit looks at documentation,
-- interviews and observation; "a policy exists" proves the first only. So a policy has a code the
-- server mints, versions whose bodies are never rewritten after approval (a new version supersedes;
-- the chain hash makes a rewrite visible), an approver who is not the preparer, acknowledgements bound
-- to the exact version hash the worker saw, scheduled reviews, corrective actions whose verifier is
-- not their completer, and an append-only event ledger. A training matrix is a snapshot of a
-- computation (`computationRef`), not a live view, so what dispatch was told on a date can be shown.
--
-- Regulatory references seed as UNVERIFIED and templates as `not_inferred_from_template`. Nothing in
-- this migration or its seeder turns a template into a regulatory determination; a person verifies a
-- reference and reviews a template's content, and both acts are recorded with who and when.
--
-- `orgRef` NULL = the historical single tenant (0132). `scopeKey` = COALESCE(orgRef, 'platform'),
-- written by the server, so a unique index can see the platform/tenant split.
--
-- The 0036 pair `writtenProgramVersions` / `programAcknowledgements` is untouched: it remains the
-- compliance registry's record that a program was published. This is where the program is authored.
CREATE TABLE `safetyProgramModules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `moduleKey` varchar(60) NOT NULL,
  `ordinal` int NOT NULL,
  `title` varchar(160) NOT NULL,
  `description` text NULL,
  `codePrefix` varchar(8) NOT NULL,
  `appliesWhenJson` text NULL,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `safetyProgramModules_moduleKey_unique` (`moduleKey`)
);
--> statement-breakpoint
CREATE TABLE `policyTemplates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `templateKey` varchar(120) NOT NULL,
  `orgRef` varchar(64) NULL,                                  -- NULL = LeaseOS platform template
  `moduleKey` varchar(60) NOT NULL,
  `packKey` varchar(60) NOT NULL,
  `documentKind` enum('policy','procedure','safe_work_practice','plan','program','form','statement') NOT NULL,
  `title` varchar(220) NOT NULL,
  `summary` text NULL,
  `templateVersion` int NOT NULL DEFAULT 1,
  `contentStatus` enum('skeleton','draft','reviewed') NOT NULL DEFAULT 'skeleton',
  `sectionsJson` text NOT NULL,
  `bodyMarkdown` text NULL,
  `contentHash` varchar(64) NOT NULL,
  `acknowledgementRequired` boolean NOT NULL DEFAULT false,
  `reviewIntervalMonths` int NOT NULL DEFAULT 12,
  `defaultOwnerRole` varchar(40) NOT NULL,
  `regulatoryReferenceKeysJson` text NOT NULL,
  `regulatoryBasis` enum('not_inferred_from_template','verified_source_cited') NOT NULL DEFAULT 'not_inferred_from_template',
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `policyTemplates_templateKey_unique` (`templateKey`),
  KEY `policyTemplates_module_pack` (`moduleKey`, `packKey`)
);
--> statement-breakpoint
CREATE TABLE `regulatoryReferences` (
  `id` int NOT NULL AUTO_INCREMENT,
  `referenceKey` varchar(120) NOT NULL,
  `jurisdiction` varchar(40) NOT NULL,
  `authority` varchar(160) NOT NULL,
  `instrument` varchar(220) NOT NULL,
  `provision` varchar(160) NULL,
  `title` varchar(240) NOT NULL,
  `url` varchar(500) NULL,
  `summary` text NULL,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `recordedByUserId` int NULL,
  `verifiedByUserId` int NULL,
  `verifiedAt` timestamp NULL,
  `verificationNote` varchar(400) NULL,
  `sourceSnapshotHash` varchar(64) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `regulatoryReferences_referenceKey_unique` (`referenceKey`)
);
--> statement-breakpoint
CREATE TABLE `policyRegulatoryLinks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `subjectType` enum('template','policy') NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `referenceKey` varchar(120) NOT NULL,
  `linkedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `policyRegulatoryLinks_subject_ref` (`subjectType`, `subjectRef`, `referenceKey`)
);
--> statement-breakpoint
CREATE TABLE `companySafetyPrograms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `programRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `financialEntityId` int NULL,
  `name` varchar(220) NOT NULL,
  `jurisdictionPackKeysJson` text NOT NULL,
  `moduleKeysJson` text NOT NULL,
  `operationsProfileJson` text NOT NULL,
  `status` enum('draft','active','retired') NOT NULL DEFAULT 'draft',
  `assembledAt` timestamp NULL,
  `assemblyHash` varchar(64) NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `companySafetyPrograms_programRef_unique` (`programRef`),
  KEY `companySafetyPrograms_scope` (`scopeKey`, `status`)
);
--> statement-breakpoint
CREATE TABLE `companyPolicies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `policyRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `programRef` varchar(64) NULL,
  `policyCode` varchar(40) NOT NULL,                           -- minted by the server: HSE-POL-001
  `templateKey` varchar(120) NULL,
  `templateVersion` int NULL,
  `moduleKey` varchar(60) NOT NULL,
  `packKey` varchar(60) NOT NULL,
  `documentKind` enum('policy','procedure','safe_work_practice','plan','program','form','statement') NOT NULL,
  `title` varchar(220) NOT NULL,
  `appliesTo` varchar(300) NOT NULL,
  `ownerRole` varchar(40) NOT NULL,
  `ownerUserId` int NULL,
  `approverRole` varchar(40) NOT NULL,
  `status` enum('draft','active','retired') NOT NULL DEFAULT 'draft',
  `currentVersionId` int NULL,
  `acknowledgementRequired` boolean NOT NULL DEFAULT true,
  `reviewIntervalMonths` int NOT NULL DEFAULT 12,
  `nextReviewDueAt` timestamp NULL,
  `retiredAt` timestamp NULL,
  `retiredByUserId` int NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `companyPolicies_policyRef_unique` (`policyRef`),
  UNIQUE KEY `companyPolicies_scope_code` (`scopeKey`, `policyCode`),
  KEY `companyPolicies_scope_status` (`scopeKey`, `status`, `moduleKey`)
);
--> statement-breakpoint
CREATE TABLE `policyVersions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `versionRef` varchar(64) NOT NULL,
  `companyPolicyId` int NOT NULL,
  `versionNumber` int NOT NULL,
  `versionLabel` varchar(20) NOT NULL,
  `state` enum('draft','approved','superseded','withdrawn') NOT NULL DEFAULT 'draft',
  `title` varchar(220) NOT NULL,
  `sectionsJson` text NOT NULL,
  `bodyMarkdown` text NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `changeSummary` varchar(500) NULL,
  `clientOverlayRefsJson` text NULL,
  `preparedByUserId` int NOT NULL,
  `preparedAt` timestamp NOT NULL,
  `approvedByUserId` int NULL,                                -- never the preparer; enforced in code and tested
  `approvedAt` timestamp NULL,
  `approvalNote` varchar(400) NULL,
  `effectiveFrom` timestamp NULL,
  `supersededAt` timestamp NULL,
  `supersedesVersionId` int NULL,
  `supersededByVersionId` int NULL,
  `withdrawnAt` timestamp NULL,
  `withdrawnByUserId` int NULL,
  `withdrawalReason` varchar(400) NULL,
  `previousVersionHash` varchar(64) NULL,
  `versionHash` varchar(64) NOT NULL,                         -- chain over the policy's versions
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `policyVersions_versionRef_unique` (`versionRef`),
  UNIQUE KEY `policyVersions_policy_number` (`companyPolicyId`, `versionNumber`)
);
--> statement-breakpoint
CREATE TABLE `policyAcknowledgements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `acknowledgementRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `companyPolicyId` int NOT NULL,
  `policyVersionId` int NOT NULL,
  `userId` int NOT NULL,
  `versionHash` varchar(64) NOT NULL,                         -- the exact version the worker saw
  `contentHash` varchar(64) NOT NULL,
  `readAt` timestamp NULL,
  `understoodAt` timestamp NULL,
  `questionsAnsweredAt` timestamp NULL,
  `questionsNote` varchar(500) NULL,
  `signedAt` timestamp NULL,                                  -- NULL until read, understood and questions are all recorded
  `method` enum('in_app','signed_document','training_session') NOT NULL DEFAULT 'in_app',
  `signatureHash` varchar(64) NULL,
  `evidenceRecordId` int NULL,
  `deviceRef` varchar(64) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `policyAcknowledgements_acknowledgementRef_unique` (`acknowledgementRef`),
  UNIQUE KEY `policyAcknowledgements_version_user` (`policyVersionId`, `userId`),
  KEY `policyAcknowledgements_org_user` (`orgRef`, `userId`)
);
--> statement-breakpoint
CREATE TABLE `clientPolicyOverlays` (
  `id` int NOT NULL AUTO_INCREMENT,
  `overlayRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `clientOrgRef` varchar(64) NULL,
  `customerAccountId` int NULL,
  `clientName` varchar(220) NOT NULL,
  `moduleKey` varchar(60) NULL,
  `companyPolicyId` int NULL,
  `title` varchar(220) NOT NULL,
  `requirementsJson` text NOT NULL,
  `sourceDescription` varchar(400) NULL,
  `sourceEvidenceRecordId` int NULL,
  `status` enum('draft','active','retired') NOT NULL DEFAULT 'active',
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `clientPolicyOverlays_overlayRef_unique` (`overlayRef`),
  KEY `clientPolicyOverlays_org_status` (`orgRef`, `status`)
);
--> statement-breakpoint
CREATE TABLE `policyReviews` (
  `id` int NOT NULL AUTO_INCREMENT,
  `reviewRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `companyPolicyId` int NOT NULL,
  `policyVersionId` int NULL,
  `reviewType` enum('scheduled','triggered','post_incident','regulatory_change','client_requirement','audit_finding') NOT NULL,
  `scheduledFor` timestamp NOT NULL,
  `status` enum('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  `completedAt` timestamp NULL,
  `reviewedByUserId` int NULL,
  `outcome` enum('no_change','revision_required','retire') NULL,
  `findings` text NULL,
  `resultingVersionId` int NULL,
  `nextReviewDueAt` timestamp NULL,
  `scheduledByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `policyReviews_reviewRef_unique` (`reviewRef`),
  KEY `policyReviews_policy_status` (`companyPolicyId`, `status`)
);
--> statement-breakpoint
CREATE TABLE `trainingRequirements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `requirementRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `positionCode` varchar(60) NOT NULL,
  `requirementKind` enum('external_certificate','company_training','client_orientation','policy_acknowledgement','equipment_competency') NOT NULL,
  `qualificationCode` varchar(100) NULL,
  `policyRef` varchar(64) NULL,
  `title` varchar(220) NOT NULL,
  `source` enum('pack','company','client_overlay') NOT NULL,
  `packKey` varchar(60) NULL,
  `overlayRef` varchar(64) NULL,
  `renewalMonths` int NULL,
  `warnDaysBeforeExpiry` int NOT NULL DEFAULT 60,
  `enforcement` enum('block','review','inform') NOT NULL DEFAULT 'block',
  `active` boolean NOT NULL DEFAULT true,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `trainingRequirements_requirementRef_unique` (`requirementRef`),
  KEY `trainingRequirements_scope_position` (`scopeKey`, `positionCode`, `active`)
);
--> statement-breakpoint
CREATE TABLE `companyTrainingMatrix` (
  `id` int NOT NULL AUTO_INCREMENT,
  `matrixRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `computationRef` varchar(64) NOT NULL,                      -- one run; a snapshot, not a live view
  `userId` int NOT NULL,
  `positionCode` varchar(60) NOT NULL,
  `requirementRef` varchar(64) NOT NULL,
  `requirementKind` enum('external_certificate','company_training','client_orientation','policy_acknowledgement','equipment_competency') NOT NULL,
  `status` enum('compliant','expiring','expired','missing','pending_verification') NOT NULL,
  `expiresAt` timestamp NULL,
  `evidenceKind` enum('worker_qualification','academy_qualification','training_record','policy_acknowledgement','none') NOT NULL,
  `evidenceRef` varchar(120) NULL,
  `detail` varchar(400) NULL,
  `current` boolean NOT NULL DEFAULT true,
  `computedAt` timestamp NOT NULL,
  `computedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `companyTrainingMatrix_matrixRef_unique` (`matrixRef`),
  KEY `companyTrainingMatrix_org_current` (`orgRef`, `current`, `status`),
  KEY `companyTrainingMatrix_user_current` (`userId`, `current`)
);
--> statement-breakpoint
CREATE TABLE `correctiveActions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `actionRef` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `sourceType` enum('policy_review','inspection','incident','near_miss','audit_finding','cor_gap','acknowledgement_gap','training_gap','observation','client_requirement','other') NOT NULL,
  `sourceRef` varchar(120) NULL,
  `title` varchar(220) NOT NULL,
  `description` text NOT NULL,
  `rootCause` text NULL,
  `priority` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  `assignedToUserId` int NOT NULL,
  `dueAt` timestamp NOT NULL,
  `status` enum('open','in_progress','completed','verified','cancelled') NOT NULL DEFAULT 'open',   -- overdue is derived from dueAt
  `completedAt` timestamp NULL,
  `completedByUserId` int NULL,
  `completionNote` varchar(500) NULL,
  `verifiedAt` timestamp NULL,
  `verifiedByUserId` int NULL,                                -- never the completer; enforced in code and tested
  `verificationNote` varchar(500) NULL,
  `evidenceRecordId` int NULL,
  `cancelledAt` timestamp NULL,
  `cancelledByUserId` int NULL,
  `cancellationReason` varchar(400) NULL,
  `openedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `correctiveActions_actionRef_unique` (`actionRef`),
  KEY `correctiveActions_org_status_due` (`orgRef`, `status`, `dueAt`)
);
--> statement-breakpoint
-- Append-only at the application layer; each row carries the previous row's hash.
CREATE TABLE `safetyProgramEvents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `eventRef` varchar(96) NOT NULL,
  `orgRef` varchar(64) NULL,
  `actorUserId` int NULL,
  `subjectType` varchar(80) NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `eventType` varchar(120) NOT NULL,
  `eventJson` text NOT NULL,
  `previousHash` varchar(64) NULL,
  `eventHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `safetyProgramEvents_eventRef_unique` (`eventRef`),
  KEY `safetyProgramEvents_subject` (`subjectType`, `subjectRef`)
);
