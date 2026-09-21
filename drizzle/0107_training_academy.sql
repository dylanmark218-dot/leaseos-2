-- LeaseOS v22.21 Training Academy
-- Versioned learning, assessments, practical competence, credential boundaries,
-- direct supervision, dispatch requirements and append-only audit evidence.

CREATE TABLE `academyCourses` (
  `id` int AUTO_INCREMENT NOT NULL,
  `courseCode` varchar(80) NOT NULL,
  `title` varchar(220) NOT NULL,
  `category` enum('whmis','tdg','erg','commercial_driver','air_brake','load_securement','company','external_track') NOT NULL,
  `credentialBoundary` enum('employer_certificate','company_certificate','external_track_only','knowledge_only') NOT NULL,
  `externalCredentialCode` varchar(100),
  `jurisdiction` varchar(80) NOT NULL,
  `regulated` boolean NOT NULL DEFAULT false,
  `requiresPractical` boolean NOT NULL DEFAULT false,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academyCourses_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyCourses_courseCode_unique` UNIQUE(`courseCode`)
);
--> statement-breakpoint
CREATE TABLE `academyCourseVersions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `courseId` int NOT NULL,
  `versionRef` varchar(96) NOT NULL,
  `versionNumber` int NOT NULL,
  `status` enum('draft','published','retired') NOT NULL DEFAULT 'draft',
  `effectiveAt` timestamp,
  `retiredAt` timestamp,
  `policyJson` text NOT NULL,
  `courseHash` varchar(64) NOT NULL,
  `sourceSnapshotRef` varchar(96),
  `publishedByUserId` int,
  `publishedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyCourseVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyCourseVersions_versionRef_unique` UNIQUE(`versionRef`)
);
--> statement-breakpoint
CREATE TABLE `academyModules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `courseVersionId` int NOT NULL,
  `moduleCode` varchar(80) NOT NULL,
  `title` varchar(220) NOT NULL,
  `orderIndex` int NOT NULL,
  `domainCode` varchar(80) NOT NULL,
  `requiresCompletion` boolean NOT NULL DEFAULT true,
  `requiresPractical` boolean NOT NULL DEFAULT false,
  `estimatedMinutes` int,
  `moduleHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyModules_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyModules_course_version_code_unique` UNIQUE(`courseVersionId`,`moduleCode`)
);
--> statement-breakpoint
CREATE TABLE `academyContentBlocks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `moduleId` int NOT NULL,
  `blockCode` varchar(100) NOT NULL,
  `orderIndex` int NOT NULL,
  `kind` enum('lesson','callout','procedure','scenario','knowledge_check','source_note') NOT NULL,
  `title` varchar(240) NOT NULL,
  `bodyJson` text NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyContentBlocks_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyContentBlocks_module_code_unique` UNIQUE(`moduleId`,`blockCode`)
);
--> statement-breakpoint
CREATE TABLE `academyAssignments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `assignmentRef` varchar(96) NOT NULL,
  `userId` int NOT NULL,
  `courseVersionId` int NOT NULL,
  `status` enum('assigned','in_progress','assessment_ready','practical_pending','completed','failed','overdue','cancelled') NOT NULL DEFAULT 'assigned',
  `assignedByUserId` int NOT NULL,
  `assignedAt` timestamp NOT NULL DEFAULT (now()),
  `dueAt` timestamp,
  `startedAt` timestamp,
  `completedAt` timestamp,
  `completionReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academyAssignments_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAssignments_assignmentRef_unique` UNIQUE(`assignmentRef`)
);
--> statement-breakpoint
CREATE TABLE `academyModuleCompletions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `assignmentId` int NOT NULL,
  `moduleId` int NOT NULL,
  `courseVersionId` int NOT NULL,
  `status` enum('started','completed','invalidated') NOT NULL DEFAULT 'started',
  `startedAt` timestamp,
  `completedAt` timestamp,
  `contentVersionHash` varchar(64) NOT NULL,
  `evidenceJson` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academyModuleCompletions_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyModuleCompletions_assignment_module_unique` UNIQUE(`assignmentId`,`moduleId`)
);
--> statement-breakpoint
CREATE TABLE `academyQuestions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `courseVersionId` int NOT NULL,
  `questionCode` varchar(100) NOT NULL,
  `bankCode` varchar(80) NOT NULL,
  `domainCode` varchar(80) NOT NULL,
  `prompt` text NOT NULL,
  `optionsJson` text NOT NULL,
  `correctAnswerJson` text NOT NULL,
  `explanation` text,
  `critical` boolean NOT NULL DEFAULT false,
  `active` boolean NOT NULL DEFAULT true,
  `questionHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyQuestions_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyQuestions_course_question_unique` UNIQUE(`courseVersionId`,`questionCode`)
);
--> statement-breakpoint
CREATE TABLE `academyAssessments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `courseVersionId` int NOT NULL,
  `assessmentCode` varchar(100) NOT NULL,
  `title` varchar(220) NOT NULL,
  `questionCount` int NOT NULL,
  `passingScorePercent` int NOT NULL,
  `maxAttempts` int,
  `policyJson` text NOT NULL,
  `domainThresholdsJson` text,
  `criticalFailurePolicyJson` text,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyAssessments_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAssessments_version_code_unique` UNIQUE(`courseVersionId`,`assessmentCode`)
);
--> statement-breakpoint
CREATE TABLE `academyAssessmentAttempts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `attemptRef` varchar(96) NOT NULL,
  `assessmentId` int NOT NULL,
  `assignmentId` int NOT NULL,
  `userId` int NOT NULL,
  `courseVersionId` int NOT NULL,
  `status` enum('open','submitted','passed','failed','void') NOT NULL DEFAULT 'open',
  `attemptNumber` int NOT NULL,
  `startedAt` timestamp NOT NULL DEFAULT (now()),
  `submittedAt` timestamp,
  `scorePercent` int,
  `domainScoresJson` text,
  `criticalFailuresJson` text,
  `policySnapshotJson` text NOT NULL,
  `questionSetJson` text NOT NULL,
  `questionSetHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyAssessmentAttempts_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAssessmentAttempts_attemptRef_unique` UNIQUE(`attemptRef`)
);
--> statement-breakpoint
CREATE TABLE `academyAssessmentItems` (
  `id` int AUTO_INCREMENT NOT NULL,
  `attemptId` int NOT NULL,
  `questionId` int NOT NULL,
  `sequenceIndex` int NOT NULL,
  `domainCode` varchar(80) NOT NULL,
  `critical` boolean NOT NULL DEFAULT false,
  `presentedPromptHash` varchar(64) NOT NULL,
  `answerOrderJson` text NOT NULL,
  `responseJson` text,
  `correct` boolean,
  `answeredAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyAssessmentItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAssessmentItems_attempt_sequence_unique` UNIQUE(`attemptId`,`sequenceIndex`)
);
--> statement-breakpoint
CREATE TABLE `academyPracticalEvaluations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `evaluationRef` varchar(96) NOT NULL,
  `assignmentId` int NOT NULL,
  `courseVersionId` int NOT NULL,
  `userId` int NOT NULL,
  `competencyCode` varchar(100) NOT NULL,
  `evaluatorUserId` int NOT NULL,
  `status` enum('competent','needs_practice','failed','revoked') NOT NULL,
  `rubricJson` text NOT NULL,
  `evidenceRecordId` int,
  `observedAt` timestamp NOT NULL,
  `signedAt` timestamp NOT NULL,
  `expiresAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyPracticalEvaluations_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyPracticalEvaluations_evaluationRef_unique` UNIQUE(`evaluationRef`)
);
--> statement-breakpoint
CREATE TABLE `academyQualifications` (
  `id` int AUTO_INCREMENT NOT NULL,
  `qualificationRef` varchar(96) NOT NULL,
  `userId` int NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `sourceKind` enum('academy_certificate','external_credential','direct_supervision','company_signoff') NOT NULL,
  `status` enum('pending','current','expired','revoked','rejected') NOT NULL DEFAULT 'pending',
  `courseVersionId` int,
  `certificateId` int,
  `complianceDocumentId` int,
  `validFrom` timestamp,
  `expiresAt` timestamp,
  `scopeJson` text,
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academyQualifications_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyQualifications_qualificationRef_unique` UNIQUE(`qualificationRef`)
);
--> statement-breakpoint
CREATE TABLE `academyCertificates` (
  `id` int AUTO_INCREMENT NOT NULL,
  `certificateRef` varchar(96) NOT NULL,
  `userId` int NOT NULL,
  `courseId` int NOT NULL,
  `courseVersionId` int NOT NULL,
  `assignmentId` int NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `credentialBoundary` enum('employer_certificate','company_certificate') NOT NULL,
  `issuedByUserId` int NOT NULL,
  `issuedAt` timestamp NOT NULL,
  `expiresAt` timestamp,
  `sourceSnapshotRef` varchar(96) NOT NULL,
  `policySnapshotHash` varchar(64) NOT NULL,
  `certificateHash` varchar(64) NOT NULL,
  `revokedAt` timestamp,
  `revokedByUserId` int,
  `revocationReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyCertificates_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyCertificates_certificateRef_unique` UNIQUE(`certificateRef`)
);
--> statement-breakpoint
CREATE TABLE `academySourceRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sourceRef` varchar(96) NOT NULL,
  `authority` varchar(220) NOT NULL,
  `title` varchar(300) NOT NULL,
  `sourceUrl` varchar(1024),
  `jurisdiction` varchar(80) NOT NULL,
  `edition` varchar(120),
  `effectiveAt` timestamp,
  `reviewStatus` enum('unreviewed','reviewed','superseded','rejected') NOT NULL DEFAULT 'unreviewed',
  `reviewedByUserId` int,
  `reviewedAt` timestamp,
  `snapshotHash` varchar(64) NOT NULL,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academySourceRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `academySourceRecords_sourceRef_unique` UNIQUE(`sourceRef`)
);
--> statement-breakpoint
CREATE TABLE `academyDirectSupervisionRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `supervisionRef` varchar(96) NOT NULL,
  `traineeUserId` int NOT NULL,
  `supervisorUserId` int NOT NULL,
  `jobId` int NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `supervisorQualificationId` int NOT NULL,
  `scopeJson` text NOT NULL,
  `startsAt` timestamp NOT NULL,
  `endsAt` timestamp NOT NULL,
  `physicalPresenceAttested` boolean NOT NULL DEFAULT false,
  `attestedByUserId` int,
  `attestedAt` timestamp,
  `status` enum('planned','active','closed','cancelled') NOT NULL DEFAULT 'planned',
  `closedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyDirectSupervisionRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyDirectSupervisionRecords_supervisionRef_unique` UNIQUE(`supervisionRef`)
);
--> statement-breakpoint
CREATE TABLE `academyRequirements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requirementCode` varchar(100) NOT NULL,
  `title` varchar(240) NOT NULL,
  `qualificationCode` varchar(100) NOT NULL,
  `enforcement` enum('block','review','inform') NOT NULL DEFAULT 'block',
  `recoveryPath` varchar(500),
  `conditionsJson` text,
  `active` boolean NOT NULL DEFAULT true,
  `createdByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `academyRequirements_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyRequirements_requirementCode_unique` UNIQUE(`requirementCode`)
);
--> statement-breakpoint
CREATE TABLE `academyRequirementBindings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bindingRef` varchar(96) NOT NULL,
  `requirementId` int NOT NULL,
  `subjectType` enum('role','equipment','job_type','customer','site','jurisdiction','cargo') NOT NULL,
  `subjectCode` varchar(160) NOT NULL,
  `conditionsJson` text,
  `effectiveAt` timestamp,
  `expiresAt` timestamp,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyRequirementBindings_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyRequirementBindings_bindingRef_unique` UNIQUE(`bindingRef`)
);
--> statement-breakpoint
CREATE TABLE `academyAuditEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(96) NOT NULL,
  `actorUserId` int,
  `subjectType` varchar(80) NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `eventType` varchar(120) NOT NULL,
  `eventJson` text NOT NULL,
  `previousHash` varchar(64),
  `eventHash` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyAuditEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAuditEvents_eventRef_unique` UNIQUE(`eventRef`)
);
