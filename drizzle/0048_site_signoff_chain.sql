-- v21.11 — Site sign-off and the post-site billing chain.
--
-- The site signature freezes everything known and agreed at the lease.
-- Post-site disposal and travel may be appended only under a billing basis
-- the consultant signed. Restocking, post-trip, washout, fuel and paperwork
-- are recorded — for HOS, payroll, maintenance, cost — and never silently
-- billed. A ticket event now says which CLOCK it belongs to; a signature says
-- which AUTHORITY it exercised; a revision is a frozen snapshot with a hash,
-- and R1 is never overwritten by R2.

ALTER TABLE `fieldTicketEvents`
  ADD COLUMN `clock` enum('duty','payroll','job','customer_billing','equipment','standby','travel','disposal','internal_service') NULL AFTER `eventType`,
  ADD COLUMN `customerBillable` enum('yes','no','review') NOT NULL DEFAULT 'review' AFTER `clock`,
  ADD COLUMN `billingRuleRef` varchar(80) NULL AFTER `customerBillable`;
--> statement-breakpoint

ALTER TABLE `fieldTicketSignatures`
  ADD COLUMN `revision` int NOT NULL DEFAULT 1 AFTER `fieldTicketId`,
  ADD COLUMN `authoritiesExercised` varchar(300) NULL AFTER `signerRole`,
  ADD COLUMN `withinAuthority` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown' AFTER `authoritiesExercised`,
  ADD COLUMN `postSiteAuthorizationJson` text NULL AFTER `signedScopeStatement`,
  ADD COLUMN `externalIdentityId` int NULL AFTER `witnessedByOperatorId`;
--> statement-breakpoint

ALTER TABLE `fieldTickets`
  ADD COLUMN `customerAccountId` int NULL AFTER `jobId`,
  ADD COLUMN `postSiteRequired` boolean NOT NULL DEFAULT false AFTER `completedAt`;
--> statement-breakpoint

ALTER TABLE `customerAccounts`
  ADD COLUMN `delayBillingRulesJson` text NULL AFTER `holdReason`,
  ADD COLUMN `postSiteBillingRuleJson` text NULL AFTER `delayBillingRulesJson`;
--> statement-breakpoint

CREATE TABLE `signatoryAuthorities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `authorityRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `signatoryName` varchar(180) NOT NULL,
  `signatoryRole` varchar(120),
  `externalIdentityId` int,
  `mayConfirmWork` boolean NOT NULL DEFAULT true,
  `maySignTicket` boolean NOT NULL DEFAULT true,
  `mayApproveStandby` boolean NOT NULL DEFAULT false,
  `extraWorkLimitCents` int,
  `mayApproveInvoice` boolean NOT NULL DEFAULT false,
  `mayChangeRates` boolean NOT NULL DEFAULT false,
  `validTo` timestamp,
  `status` enum('active','revoked') NOT NULL DEFAULT 'active',
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `signatoryAuthorities_id` PRIMARY KEY(`id`),
  CONSTRAINT `signatoryAuthorities_authorityRef_unique` UNIQUE(`authorityRef`)
);
--> statement-breakpoint

CREATE TABLE `fieldTicketRevisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentRef` varchar(80) NOT NULL,
  `fieldTicketId` int NOT NULL,
  `revision` int NOT NULL,
  `kind` enum('site_signed','post_site_supplement','final','amendment') NOT NULL,
  `snapshotJson` text NOT NULL,
  `snapshotHash` varchar(64) NOT NULL,
  `billableHoursSite` double,
  `billableHoursPostSite` double,
  `supersedesRevisionId` int,
  `generatedByUserId` int,
  `generatedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTicketRevisions_id` PRIMARY KEY(`id`),
  CONSTRAINT `fieldTicketRevisions_documentRef_unique` UNIQUE(`documentRef`),
  CONSTRAINT `fieldTicketRevisions_ticket_revision_unique` UNIQUE(`fieldTicketId`,`revision`)
);
--> statement-breakpoint

CREATE TABLE `delayEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `delayRef` varchar(64) NOT NULL,
  `jobId` int,
  `tripId` int,
  `unitId` int,
  `fieldTicketId` int,
  `kind` enum('customer_hold','disposal_queue','weather','road_hazard','collision','driver_break','breakdown','other') NOT NULL,
  `hazardType` varchar(60),
  `severity` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `observedAt` timestamp NOT NULL,
  `endedAt` timestamp,
  `observedByOperatorId` int,
  `observation` varchar(600) NOT NULL,
  `latitude` double,
  `longitude` double,
  `externalSourceStatus` enum('available','unavailable','not_checked') NOT NULL DEFAULT 'not_checked',
  `externalSourceNote` varchar(300),
  `billingClassification` enum('billable','non_billable','review_required') NOT NULL DEFAULT 'review_required',
  `classificationRuleRef` varchar(80),
  `broadcast` boolean NOT NULL DEFAULT false,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `delayEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `delayEvents_delayRef_unique` UNIQUE(`delayRef`)
);
--> statement-breakpoint
CREATE INDEX `delayEvents_job_idx` ON `delayEvents` (`jobId`, `observedAt`);
