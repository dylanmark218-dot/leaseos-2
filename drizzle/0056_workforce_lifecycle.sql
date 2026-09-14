-- v21.20 — Workforce lifecycle.
--
-- An applicant is HR's record: screenings are facts with evidence, and a
-- hire cannot start while a required screening is pending. Onboarding is a
-- plan of tasks; a task that stands for a credential becomes one only when a
-- person verifies it, into the same registry dispatch reads. A competency is
-- signed off by a supervisor, never self-declared. Probation is recommended
-- by one person and decided by another. Offboarding revokes every door the
-- person held before it can close, and says which doors remain.

CREATE TABLE `applicants` (
  `id` int AUTO_INCREMENT NOT NULL,
  `applicantRef` varchar(64) NOT NULL,
  `fullName` varchar(180) NOT NULL,
  `contactJson` text,
  `roleApplied` varchar(120) NOT NULL,
  `source` varchar(120),
  `status` enum('applied','screening','interview','offer','hired','declined','withdrawn') NOT NULL DEFAULT 'applied',
  `hiredUserId` int,
  `decisionReason` varchar(400),
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `applicants_id` PRIMARY KEY(`id`),
  CONSTRAINT `applicants_applicantRef_unique` UNIQUE(`applicantRef`)
);
--> statement-breakpoint

CREATE TABLE `applicantScreenings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `applicantId` int NOT NULL,
  `kind` enum('licence_verification','driver_abstract','references','drug_alcohol','criminal_record','right_to_work','medical_fitness','road_test') NOT NULL,
  `required` boolean NOT NULL DEFAULT true,
  `result` enum('pending','pass','fail','not_required') NOT NULL DEFAULT 'pending',
  `evidenceRecordId` int,
  `note` varchar(400),
  `recordedByUserId` int,
  `recordedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `applicantScreenings_id` PRIMARY KEY(`id`),
  CONSTRAINT `applicantScreenings_applicant_kind_unique` UNIQUE(`applicantId`,`kind`)
);
--> statement-breakpoint

CREATE TABLE `onboardingPlans` (
  `id` int AUTO_INCREMENT NOT NULL,
  `planRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `applicantId` int,
  `position` varchar(120) NOT NULL,
  `startDate` timestamp NOT NULL,
  `probationEndsAt` timestamp,
  `status` enum('in_progress','complete','ended') NOT NULL DEFAULT 'in_progress',
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `onboardingPlans_id` PRIMARY KEY(`id`),
  CONSTRAINT `onboardingPlans_planRef_unique` UNIQUE(`planRef`),
  CONSTRAINT `onboardingPlans_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint

CREATE TABLE `onboardingTasks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `planId` int NOT NULL,
  `taskCode` varchar(60) NOT NULL,
  `title` varchar(220) NOT NULL,
  `required` boolean NOT NULL DEFAULT true,
  `dueBy` timestamp,
  -- When set, completing and verifying this task writes a compliance document of this type for the worker.
  `credentialDocType` varchar(100),
  `credentialValidDays` int,
  `completedAt` timestamp,
  `completedByUserId` int,
  `evidenceRecordId` int,
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `complianceDocumentId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `onboardingTasks_id` PRIMARY KEY(`id`),
  CONSTRAINT `onboardingTasks_plan_code_unique` UNIQUE(`planId`,`taskCode`)
);
--> statement-breakpoint

CREATE TABLE `trainingRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `trainingRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `courseCode` varchar(60) NOT NULL,
  `title` varchar(220) NOT NULL,
  `provider` varchar(160),
  `completedAt` timestamp NOT NULL,
  `expiresAt` timestamp,
  `certificateNumber` varchar(120),
  `evidenceRecordId` int,
  `credentialDocType` varchar(100),
  `verificationStatus` enum('unverified','verified','rejected') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `complianceDocumentId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `trainingRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `trainingRecords_trainingRef_unique` UNIQUE(`trainingRef`)
);
--> statement-breakpoint

CREATE TABLE `competencySignoffs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `competencyCode` varchar(60) NOT NULL,
  `level` enum('trainee','competent','senior') NOT NULL,
  `signedOffByUserId` int NOT NULL,
  `signedOffAt` timestamp NOT NULL,
  `evidenceRecordId` int,
  `note` varchar(400),
  `expiresAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `competencySignoffs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `probationReviews` (
  `id` int AUTO_INCREMENT NOT NULL,
  `planId` int NOT NULL,
  `recommendation` enum('confirm','extend','end') NOT NULL,
  `recommendedByUserId` int NOT NULL,
  `recommendedAt` timestamp NOT NULL,
  `recommendationNote` varchar(600) NOT NULL,
  `decision` enum('confirm','extend','end'),
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `decisionNote` varchar(600),
  `extendedTo` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `probationReviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `offboardings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `offboardingRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `reason` enum('resigned','ended_by_company','contract_end','retired','deceased','other') NOT NULL,
  `lastDay` timestamp NOT NULL,
  `status` enum('open','complete') NOT NULL DEFAULT 'open',
  `rolesRevokedAt` timestamp,
  `devicesRevokedAt` timestamp,
  `identitiesRevokedAt` timestamp,
  `toolsReturnedAt` timestamp,
  `finalPayProposedAt` timestamp,
  `completedByUserId` int,
  `completedAt` timestamp,
  `initiatedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `offboardings_id` PRIMARY KEY(`id`),
  CONSTRAINT `offboardings_offboardingRef_unique` UNIQUE(`offboardingRef`)
);
