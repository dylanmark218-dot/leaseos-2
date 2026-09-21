-- v21.12 — Portal identity hardening, client discretionary adjustments,
-- weather and road-hazard observations, rendered ticket documents.
--
-- An invitation is accepted once, expires, and yields a bearer token that
-- itself expires and rotates; the previous token lives a few minutes so a
-- rotation does not strand a session. Five failures lock the identity for a
-- while. MFA is a TOTP secret stored encrypted under a server key — never
-- in the clear, never logged.
--
-- A client adjustment is voluntary money — a tip, a bonus, a flat amount, a
-- percentage, or an HOUR-EQUIVALENT. An hour-equivalent is billing value
-- expressed in hours; it is NOT worked time and touches no clock. Who it is
-- meant for is recorded; if it is meant for workers, payroll is PROPOSED to,
-- never written by the customer.
--
-- An observation is what a person saw, when and where, kept separate from
-- what an external source says. Its billing treatment is REVIEW until a
-- contract rule decides. A rendered document is bytes with a hash, produced
-- from a frozen revision, and never overwritten.

ALTER TABLE `externalIdentities`
  ADD COLUMN `invitationTokenHash` varchar(64) NULL AFTER `tokenHash`,
  ADD COLUMN `invitationExpiresAt` timestamp NULL AFTER `invitationTokenHash`,
  ADD COLUMN `acceptedAt` timestamp NULL AFTER `invitationExpiresAt`,
  ADD COLUMN `tokenExpiresAt` timestamp NULL AFTER `acceptedAt`,
  ADD COLUMN `previousTokenHash` varchar(64) NULL AFTER `tokenExpiresAt`,
  ADD COLUMN `previousTokenExpiresAt` timestamp NULL AFTER `previousTokenHash`,
  ADD COLUMN `mfaEnabled` boolean NOT NULL DEFAULT false AFTER `previousTokenExpiresAt`,
  ADD COLUMN `mfaSecretEnc` varchar(400) NULL AFTER `mfaEnabled`,
  ADD COLUMN `failedAttempts` int NOT NULL DEFAULT 0 AFTER `mfaSecretEnc`,
  ADD COLUMN `lockedUntil` timestamp NULL AFTER `failedAttempts`,
  ADD COLUMN `revokedAt` timestamp NULL AFTER `lockedUntil`,
  ADD COLUMN `revokedReason` varchar(300) NULL AFTER `revokedAt`;
--> statement-breakpoint

CREATE TABLE `clientAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `adjustmentRef` varchar(64) NOT NULL,
  `fieldTicketId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  `kind` enum('tip','crew_bonus','exceptional_service_bonus','flat','percent','completion_bonus','callout_bonus','hour_equivalent') NOT NULL,
  -- The basis the amount was computed from, so it can be explained later.
  `basisJson` text NOT NULL,
  `amountCents` int NOT NULL,
  `hourEquivalentMinutes` int,
  `recipientIntent` enum('company','crew','named_workers','operator','supervisor','company_crew_split','unknown') NOT NULL DEFAULT 'unknown',
  `recipientDetailJson` text,
  `reason` varchar(600) NOT NULL,
  `authorizedByExternalIdentityId` int,
  `authorizedByName` varchar(180) NOT NULL,
  `authorizedAt` timestamp NOT NULL,
  `revisionId` int,
  `payrollTreatment` enum('not_applicable','awaiting_recipient','proposed','decided') NOT NULL DEFAULT 'not_applicable',
  `payrollAdjustmentRef` varchar(64),
  `idempotencyHash` varchar(64) NOT NULL,
  `status` enum('authorized','withdrawn') NOT NULL DEFAULT 'authorized',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `clientAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `clientAdjustments_adjustmentRef_unique` UNIQUE(`adjustmentRef`),
  CONSTRAINT `clientAdjustments_idempotency_unique` UNIQUE(`idempotencyHash`)
);
--> statement-breakpoint

CREATE TABLE `weatherObservations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `observationRef` varchar(64) NOT NULL,
  `jobId` int,
  `unitId` int,
  `fieldTicketId` int,
  `observedAt` timestamp NOT NULL,
  `observerType` enum('worker','supervisor','external_source') NOT NULL,
  `observerUserId` int,
  `externalSourceName` varchar(120),
  `conditionsJson` text NOT NULL,
  `visibility` enum('good','reduced','poor','nil','unknown') NOT NULL DEFAULT 'unknown',
  `roadState` enum('dry','wet','snow','ice','mud','flooded','unknown') NOT NULL DEFAULT 'unknown',
  `severity` enum('minor','moderate','severe') NOT NULL,
  `operationalEffect` varchar(400),
  `latitude` double,
  `longitude` double,
  `evidenceRecordId` int,
  `billingTreatment` enum('billable','non_billable','review') NOT NULL DEFAULT 'review',
  `billingRuleRef` varchar(80),
  `customerVisible` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `weatherObservations_id` PRIMARY KEY(`id`),
  CONSTRAINT `weatherObservations_observationRef_unique` UNIQUE(`observationRef`)
);
--> statement-breakpoint

CREATE TABLE `roadHazardObservations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `observationRef` varchar(64) NOT NULL,
  `jobId` int,
  `unitId` int,
  `fieldTicketId` int,
  `observedAt` timestamp NOT NULL,
  `reportedByUserId` int,
  `hazard` enum('snow_ice','mud','flooding','washout','poor_visibility','high_wind','construction','road_closure','restricted_access','soft_road','steep_grade','chain_up','traffic','collision_ahead','wildlife','bridge_restriction','lease_road_damage','locked_gate','customer_traffic_control','other') NOT NULL,
  `severity` enum('minor','moderate','severe') NOT NULL,
  `direction` varchar(40),
  `routeRef` varchar(120),
  `description` varchar(600),
  `latitude` double,
  `longitude` double,
  `evidenceRecordId` int,
  `billingTreatment` enum('billable','non_billable','review') NOT NULL DEFAULT 'review',
  `customerVisible` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadHazardObservations_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadHazardObservations_observationRef_unique` UNIQUE(`observationRef`)
);
--> statement-breakpoint

CREATE TABLE `fieldTicketDocuments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentRef` varchar(64) NOT NULL,
  `fieldTicketId` int NOT NULL,
  `revisionId` int NOT NULL,
  `kind` enum('site_ticket_r1','post_site_ticket','completion_package') NOT NULL,
  `storageKey` varchar(512) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `sourceSnapshotHash` varchar(64) NOT NULL,
  `byteLength` int NOT NULL,
  `generatedByUserId` int,
  `generatedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldTicketDocuments_id` PRIMARY KEY(`id`),
  CONSTRAINT `fieldTicketDocuments_documentRef_unique` UNIQUE(`documentRef`),
  CONSTRAINT `fieldTicketDocuments_revision_kind_unique` UNIQUE(`revisionId`,`kind`)
);
--> statement-breakpoint

CREATE TABLE `externalAccessLog` (
  `id` int AUTO_INCREMENT NOT NULL,
  `externalIdentityId` int NOT NULL,
  `action` enum('view','download','sign','decide','authorize','accept_invitation','mfa_enroll','mfa_confirm','token_rotate') NOT NULL,
  `recordType` varchar(60) NOT NULL,
  `recordRef` varchar(120) NOT NULL,
  `recordVersion` varchar(64),
  `context` varchar(300),
  `at` timestamp NOT NULL,
  CONSTRAINT `externalAccessLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `externalAccessLog_identity_idx` ON `externalAccessLog` (`externalIdentityId`, `at`);
