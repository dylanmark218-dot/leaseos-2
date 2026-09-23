-- 0169: Driver Portfolio and Credential Wallet.
--
-- No credential table. A driver's tickets are `complianceDocuments` rows owned
-- by the operator, recorded by one person and verified by another, and
-- equipment is `operatorEquipmentAuthorizations`. Both were already read by the
-- dispatch composer; a third store of certificates would be a second answer to
-- "does this person hold H2S".
--
-- What was missing is the requirement set (what a customer, a site, a job type
-- or a piece of equipment demands of the operator, and whether each demand is
-- mandatory or only informational) and the record of what happened to a
-- driver's credentials: uploaded, verified, shared, used for a dispatch.
--
-- A binding belongs to the organization whose work it governs. NULL is the
-- historical single tenant, the same rule as 0132: a binding applies only to
-- work of the same organization, so one company's client requirements never
-- reach another company's drivers.

CREATE TABLE `driverRequirementBindings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bindingRef` varchar(96) NOT NULL,
  `orgRef` varchar(64),
  `subjectType` enum('company','customer','site','job_type','equipment','job') NOT NULL,
  `subjectCode` varchar(160) NOT NULL,
  `requirementKind` enum('credential','licence_class','equipment') NOT NULL,
  `requirementCode` varchar(160) NOT NULL,
  `label` varchar(220),
  `enforcement` enum('mandatory','informational') NOT NULL DEFAULT 'mandatory',
  `effectiveAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `active` boolean NOT NULL DEFAULT true,
  `createdByUserId` int NOT NULL,
  `retiredByUserId` int,
  `retiredAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `driverRequirementBindings_id` PRIMARY KEY(`id`),
  CONSTRAINT `driverRequirementBindings_bindingRef_unique` UNIQUE(`bindingRef`)
);
--> statement-breakpoint
CREATE INDEX `driverRequirementBindings_subject_idx`
  ON `driverRequirementBindings` (`orgRef`,`active`,`subjectType`,`subjectCode`);
--> statement-breakpoint
CREATE TABLE `driverPortfolioEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(96) NOT NULL,
  `operatorId` int NOT NULL,
  `credentialId` int,
  `actorUserId` int,
  `eventType` enum('credential_uploaded','credential_verified','credential_rejected','requirement_bound','requirement_retired','wallet_viewed','portfolio_viewed','credential_shared','share_verified','used_for_dispatch') NOT NULL,
  `detail` varchar(400),
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `driverPortfolioEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `driverPortfolioEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `driverPortfolioEvents_operator_idx`
  ON `driverPortfolioEvents` (`operatorId`,`occurredAt`);
