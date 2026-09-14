-- B20 — Records, Evidence & Compliance Vault
-- Slot 0019. Slots 0016 and 0017 remain reserved for the spatial navigation
-- and LoadSense branches; this migration deliberately does not consume them.
--
-- evidenceRecords already exists and is extended in place rather than replaced.
-- workOrders already exists; mechanic release is added as an append-only
-- sibling table rather than by mutating the work order, because a release is a
-- distinct authenticated event and closing a work order is not one.

ALTER TABLE `evidenceRecords`
  ADD COLUMN `trackingNumber` varchar(64),
  ADD COLUMN `recordType` varchar(60) NOT NULL DEFAULT 'other',
  ADD COLUMN `sealState` enum('draft','sealed','amended','superseded') NOT NULL DEFAULT 'draft',
  ADD COLUMN `currentVersion` int NOT NULL DEFAULT 1,
  ADD COLUMN `legalHold` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX `evidenceRecords_trackingNumber_unique` ON `evidenceRecords` (`trackingNumber`);
--> statement-breakpoint
CREATE INDEX `evidenceRecords_sealState_idx` ON `evidenceRecords` (`sealState`);
--> statement-breakpoint

-- One evidence object, many portfolios. The same disposal ticket appears under
-- driver, unit, job, trip, load, disposal and billing without duplicating bytes.
CREATE TABLE `evidenceRelationships` (
  `id` int AUTO_INCREMENT NOT NULL, `evidenceRecordId` int NOT NULL,
  `entityType` enum('operator','unit','trailer','equipment','job','trip','load','manifest','disposalTicket','fieldTicket','workOrder','incident','nearMiss','safetyMeeting','invoice','customer','facility','dailyLog','inspection') NOT NULL,
  `entityId` int, `entityRef` varchar(64),
  `role` varchar(60),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `evidenceRelationships_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `evidenceRelationships_record_idx` ON `evidenceRelationships` (`evidenceRecordId`);
--> statement-breakpoint
CREATE INDEX `evidenceRelationships_entity_idx` ON `evidenceRelationships` (`entityType`, `entityId`);
--> statement-breakpoint
CREATE INDEX `evidenceRelationships_ref_idx` ON `evidenceRelationships` (`entityRef`);
--> statement-breakpoint

-- Amendment chain. Version 1 is never overwritten.
CREATE TABLE `evidenceVersions` (
  `id` int AUTO_INCREMENT NOT NULL, `evidenceRecordId` int NOT NULL,
  `version` int NOT NULL, `supersedesVersion` int,
  `storageKey` varchar(512), `mimeType` varchar(120), `byteSize` int,
  `contentHash` varchar(64) NOT NULL, `manifestHash` varchar(64) NOT NULL,
  `amendmentReason` text, `amendedByUserId` int, `amendedByRole` varchar(40),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `evidenceVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `evidenceVersions_record_version_unique` UNIQUE(`evidenceRecordId`, `version`)
);
--> statement-breakpoint

-- The seal itself: canonical manifest, hashes, and the identity that sealed it.
CREATE TABLE `evidenceSeals` (
  `id` int AUTO_INCREMENT NOT NULL, `evidenceRecordId` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `canonicalManifest` text NOT NULL,
  `contentHash` varchar(64) NOT NULL, `manifestHash` varchar(64) NOT NULL,
  `hashAlgorithm` varchar(20) NOT NULL DEFAULT 'sha256',
  `sealedAt` timestamp NOT NULL, `sealedByUserId` int NOT NULL,
  `sealedByEmployeeNumber` varchar(40),
  `deviceId` varchar(120), `devicePlatform` varchar(40),
  `capturedLatitude` double, `capturedLongitude` double,
  `serverVerifiedAt` timestamp,
  `verificationResult` enum('pending','verified','hash_mismatch','manifest_mismatch') NOT NULL DEFAULT 'pending',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `evidenceSeals_id` PRIMARY KEY(`id`),
  CONSTRAINT `evidenceSeals_record_version_unique` UNIQUE(`evidenceRecordId`, `version`)
);
--> statement-breakpoint

-- Retention is policy DATA, not code. Statutory minimums stay null and
-- unverified until an authoritative source is actually loaded — company policy
-- applies in the meantime without claiming statutory backing it does not have.
CREATE TABLE `retentionPolicies` (
  `id` int AUTO_INCREMENT NOT NULL, `policyKey` varchar(80) NOT NULL,
  `recordType` varchar(60) NOT NULL, `jurisdiction` varchar(80),
  `statutoryMinimumMonths` int,
  `statutorySourceStatus` enum('unverified','verified','not_applicable') NOT NULL DEFAULT 'unverified',
  `statutorySourceRef` varchar(400), `statutorySourceVersion` varchar(80),
  `statutoryLastVerifiedAt` timestamp,
  `companyRetentionMonths` int NOT NULL,
  `contractRetentionMonths` int,
  `deviceRetentionDays` int,
  `deletionRequiresOfficeReceipt` boolean NOT NULL DEFAULT true,
  `legalHoldOverridesDeletion` boolean NOT NULL DEFAULT true,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `retentionPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `retentionPolicies_policyKey_unique` UNIQUE(`policyKey`)
);
--> statement-breakpoint

CREATE TABLE `recordRetentionState` (
  `id` int AUTO_INCREMENT NOT NULL, `evidenceRecordId` int NOT NULL,
  `retentionPolicyId` int,
  `effectiveRetentionMonths` int, `retentionBasis` varchar(60),
  `officeRetainUntil` timestamp,
  `deviceRetainUntil` timestamp,
  `officeReceivedAt` timestamp, `officeIntegrityVerifiedAt` timestamp,
  `officeReviewedAt` timestamp, `officeReviewedByUserId` int,
  `deviceCopyDeletedAt` timestamp, `deviceCopyDeletedByUserId` int,
  `dispositionedAt` timestamp, `dispositionedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `recordRetentionState_id` PRIMARY KEY(`id`),
  CONSTRAINT `recordRetentionState_record_unique` UNIQUE(`evidenceRecordId`)
);
--> statement-breakpoint

CREATE TABLE `legalHolds` (
  `id` int AUTO_INCREMENT NOT NULL, `holdNumber` varchar(64) NOT NULL,
  `reason` text NOT NULL, `matterRef` varchar(120),
  `incidentNumber` varchar(64),
  `placedByUserId` int NOT NULL, `placedByRole` varchar(40) NOT NULL,
  `placedAt` timestamp NOT NULL,
  `releasedByUserId` int, `releasedByRole` varchar(40),
  `releasedAt` timestamp, `releaseReason` text, `releaseAuthority` varchar(180),
  `status` enum('active','released') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `legalHolds_id` PRIMARY KEY(`id`),
  CONSTRAINT `legalHolds_holdNumber_unique` UNIQUE(`holdNumber`)
);
--> statement-breakpoint

CREATE TABLE `legalHoldRecords` (
  `id` int AUTO_INCREMENT NOT NULL, `legalHoldId` int NOT NULL,
  `evidenceRecordId` int NOT NULL, `addedAt` timestamp NOT NULL DEFAULT (now()),
  `addedByUserId` int,
  CONSTRAINT `legalHoldRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `legalHoldRecords_hold_record_unique` UNIQUE(`legalHoldId`, `evidenceRecordId`)
);
--> statement-breakpoint

-- Offline send queue. Transmission is a state machine, not a boolean.
CREATE TABLE `syncPackages` (
  `id` int AUTO_INCREMENT NOT NULL, `packageRef` varchar(64) NOT NULL,
  `deviceId` varchar(120) NOT NULL, `operatorId` int,
  `state` enum('queued','waiting_for_service','transmitting','server_received','hash_verified','office_accepted','failed','rejected') NOT NULL DEFAULT 'queued',
  `itemCount` int NOT NULL DEFAULT 0,
  `queuedAt` timestamp NOT NULL, `lastAttemptAt` timestamp,
  `attemptCount` int NOT NULL DEFAULT 0,
  `serverReceivedAt` timestamp, `hashVerifiedAt` timestamp, `officeAcceptedAt` timestamp,
  `failureReason` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `syncPackages_id` PRIMARY KEY(`id`),
  CONSTRAINT `syncPackages_packageRef_unique` UNIQUE(`packageRef`)
);
--> statement-breakpoint
CREATE INDEX `syncPackages_state_idx` ON `syncPackages` (`state`);
--> statement-breakpoint

CREATE TABLE `syncPackageItems` (
  `id` int AUTO_INCREMENT NOT NULL, `syncPackageId` int NOT NULL,
  `evidenceRecordId` int NOT NULL, `declaredContentHash` varchar(64) NOT NULL,
  `declaredManifestHash` varchar(64) NOT NULL,
  `state` enum('pending','received','verified','mismatch') NOT NULL DEFAULT 'pending',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `syncPackageItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `syncPackageItems_package_record_unique` UNIQUE(`syncPackageId`, `evidenceRecordId`)
);
--> statement-breakpoint

CREATE TABLE `syncReceipts` (
  `id` int AUTO_INCREMENT NOT NULL, `syncPackageId` int NOT NULL,
  `evidenceRecordId` int NOT NULL,
  `computedContentHash` varchar(64) NOT NULL, `computedManifestHash` varchar(64) NOT NULL,
  `matched` boolean NOT NULL,
  `receivedAt` timestamp NOT NULL, `failureDetail` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `syncReceipts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- Incident reporting. The operator's own words are stored verbatim and
-- separately from any structured summary.
CREATE TABLE `incidentReports` (
  `id` int AUTO_INCREMENT NOT NULL, `incidentNumber` varchar(64) NOT NULL,
  `incidentType` enum('hazard_observation','near_miss','incident','collision','injury','environmental_release','property_damage','equipment_event') NOT NULL,
  `severity` enum('none','minor','moderate','serious','critical') NOT NULL DEFAULT 'minor',
  `operatorId` int, `employeeNumber` varchar(40),
  `jobId` int, `tripId` int, `unitId` int, `trailerId` int,
  `occurredAt` timestamp NOT NULL, `reportedAt` timestamp NOT NULL,
  `latitude` double, `longitude` double, `locationDescription` varchar(400),
  `originalStatement` text NOT NULL,
  `originalStatementSource` enum('typed','voice','dictated_transcript') NOT NULL DEFAULT 'typed',
  `structuredSummary` text,
  `summarySource` enum('human','ai_proposed','ai_confirmed') NOT NULL DEFAULT 'human',
  `injuryReported` boolean NOT NULL DEFAULT false,
  `emergencyServicesAttended` boolean NOT NULL DEFAULT false,
  `policeAttended` boolean NOT NULL DEFAULT false,
  `environmentalRelease` boolean NOT NULL DEFAULT false,
  `dangerousGoodsInvolved` boolean NOT NULL DEFAULT false,
  `unNumber` varchar(20), `dangerousGoodsClass` varchar(20),
  `dangerousGoodsVerified` boolean NOT NULL DEFAULT false,
  `workStopped` boolean NOT NULL DEFAULT false,
  `unitHeld` boolean NOT NULL DEFAULT false,
  `supervisorNotifiedAt` timestamp, `supervisorUserId` int,
  `safetyReviewedAt` timestamp, `safetyReviewedByUserId` int,
  `escalationState` enum('captured','sealed','management_notified','under_review','corrective_action','closed') NOT NULL DEFAULT 'captured',
  `convertedFromNearMissId` int,
  `status` enum('open','under_review','closed') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `incidentReports_id` PRIMARY KEY(`id`),
  CONSTRAINT `incidentReports_incidentNumber_unique` UNIQUE(`incidentNumber`)
);
--> statement-breakpoint
CREATE INDEX `incidentReports_escalation_idx` ON `incidentReports` (`escalationState`);
--> statement-breakpoint

CREATE TABLE `incidentPeople` (
  `id` int AUTO_INCREMENT NOT NULL, `incidentReportId` int NOT NULL,
  `role` enum('involved','witness','injured','supervisor','third_party') NOT NULL,
  `operatorId` int, `employeeNumber` varchar(40),
  `name` varchar(180), `company` varchar(180), `contact` varchar(180),
  `statement` text, `statementSource` enum('typed','voice','dictated_transcript'),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `incidentPeople_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `incidentActions` (
  `id` int AUTO_INCREMENT NOT NULL, `incidentReportId` int NOT NULL,
  `actionType` enum('immediate','corrective','preventive','notification') NOT NULL,
  `description` text NOT NULL,
  `assignedToUserId` int, `dueAt` timestamp,
  `completedAt` timestamp, `completedByUserId` int,
  `createdByUserId` int NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `incidentActions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- Near miss stays a separate, deliberately short record. It escalates into an
-- incident rather than being one.
CREATE TABLE `nearMissReports` (
  `id` int AUTO_INCREMENT NOT NULL, `nearMissNumber` varchar(64) NOT NULL,
  `operatorId` int, `employeeNumber` varchar(40),
  `jobId` int, `unitId` int,
  `occurredAt` timestamp NOT NULL, `reportedAt` timestamp NOT NULL,
  `latitude` double, `longitude` double,
  `originalStatement` text NOT NULL,
  `originalStatementSource` enum('typed','voice','dictated_transcript') NOT NULL DEFAULT 'typed',
  `structuredSummary` text,
  `anyoneInjured` boolean NOT NULL DEFAULT false,
  `workStopped` boolean NOT NULL DEFAULT false,
  `escalatedToIncidentId` int, `escalatedAt` timestamp,
  `reviewedAt` timestamp, `reviewedByUserId` int,
  `status` enum('open','reviewed','escalated','closed') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `nearMissReports_id` PRIMARY KEY(`id`),
  CONSTRAINT `nearMissReports_nearMissNumber_unique` UNIQUE(`nearMissNumber`)
);
--> statement-breakpoint

-- Mechanic release. Append-only sibling of workOrders: closing a work order is
-- not a release, and a release is an authenticated act by a named technician.
CREATE TABLE `workOrderReleases` (
  `id` int AUTO_INCREMENT NOT NULL, `workOrderId` int NOT NULL,
  `unitId` int NOT NULL,
  `releaseType` enum('full','restricted','revoked') NOT NULL,
  `restrictionDetail` text,
  `repairSummary` text NOT NULL,
  `testProcedure` text, `testResult` enum('pass','fail','not_required'),
  `roadTestPerformed` boolean NOT NULL DEFAULT false, `roadTestNotes` text,
  `technicianUserId` int NOT NULL, `technicianIdentifier` varchar(80) NOT NULL,
  `technicianCertificationRef` varchar(120),
  `releasedAt` timestamp NOT NULL,
  `resolvedDefectIds` varchar(400),
  `supersededByReleaseId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workOrderReleases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `workOrderReleases_unit_idx` ON `workOrderReleases` (`unitId`);
--> statement-breakpoint

-- Who opened what. Sensitive categories need this to be defensible.
CREATE TABLE `evidenceAccessEvents` (
  `id` int AUTO_INCREMENT NOT NULL, `evidenceRecordId` int NOT NULL,
  `actorUserId` int NOT NULL, `actorRole` varchar(40) NOT NULL,
  `action` enum('viewed','downloaded','exported','shared','printed','seal_verified') NOT NULL,
  `context` varchar(220), `scope` varchar(60),
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `evidenceAccessEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `evidenceAccessEvents_record_idx` ON `evidenceAccessEvents` (`evidenceRecordId`);
