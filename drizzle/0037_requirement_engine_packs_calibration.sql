-- v20.22 — Generalized Requirement Engine, compliance packs, equipment
-- authorization, calibration registry.
--
-- Not every requirement applies to every company. A pack activates a set of
-- requirements for a company by jurisdiction, industry, asset type, activity
-- or customer; a hydrovac company and a crane company run the same core and
-- receive different rules. A requirement may now apply to a WORK CONTEXT —
-- who, on what equipment, with what attachment, doing what, where, for whom —
-- rather than to a single subject.
--
-- A measurement device is now a thing with a calibration history, and a load
-- or disposal ticket records WHICH device measured it. That link is what
-- makes "which records depended on the scale that was wrong for three weeks"
-- an answerable question.

ALTER TABLE `complianceRequirements`
  MODIFY COLUMN `subjectType` enum('operator','unit','trailer','carrier','job','user','equipment','attachment','work_context') NOT NULL,
  ADD COLUMN `packKey` varchar(80) NULL AFTER `family`;
--> statement-breakpoint

CREATE TABLE `compliancePacks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `packKey` varchar(80) NOT NULL,
  `title` varchar(220) NOT NULL,
  `description` text,
  -- JSON predicate on the company profile, e.g. {"industriesAny":["hydrovac"]}.
  `activatesWhenJson` text,
  `jurisdiction` varchar(80) NOT NULL DEFAULT '*',
  `core` boolean NOT NULL DEFAULT false,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `compliancePacks_id` PRIMARY KEY(`id`),
  CONSTRAINT `compliancePacks_packKey_unique` UNIQUE(`packKey`)
);
--> statement-breakpoint

CREATE TABLE `companyPackActivations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  `packKey` varchar(80) NOT NULL,
  `activatedAt` timestamp NOT NULL,
  `activatedByUserId` int NOT NULL,
  `reason` varchar(300),
  `deactivatedAt` timestamp,
  `deactivatedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `companyPackActivations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `companyPackActivations_entity_idx` ON `companyPackActivations` (`financialEntityId`, `packKey`);
--> statement-breakpoint

-- Worker × exact equipment type × attachment × employer authorization. The
-- four elements the OHS rule names — trained, competent, familiar with the
-- instructions, authorized by the employer — are four evidence fields, not
-- one certificate.
CREATE TABLE `operatorEquipmentAuthorizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `authorizationRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `equipmentType` varchar(80) NOT NULL,
  `attachmentType` varchar(80),
  `trainingEvidenceId` int,
  `competencyEvidenceId` int,
  `competencyAssessedByUserId` int,
  `competencyAssessedAt` timestamp,
  `instructionsAcknowledgedAt` timestamp,
  `authorizedByUserId` int,
  `authorizedAt` timestamp,
  `expiresAt` timestamp,
  `status` enum('pending','authorized','suspended','revoked','expired') NOT NULL DEFAULT 'pending',
  `revokedReason` varchar(300),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `operatorEquipmentAuthorizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `operatorEquipmentAuthorizations_ref_unique` UNIQUE(`authorizationRef`)
);
--> statement-breakpoint
CREATE INDEX `operatorEquipmentAuthorizations_user_idx` ON `operatorEquipmentAuthorizations` (`userId`, `equipmentType`, `status`);
--> statement-breakpoint

CREATE TABLE `measurementDevices` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deviceRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `deviceType` enum('truck_scale','onboard_load_sensor','load_cell','fuel_meter','flow_meter','vacuum_gauge','pressure_gauge','torque_wrench','gas_detector','sound_meter','temperature_probe','hydraulic_gauge','other') NOT NULL,
  `manufacturer` varchar(120),
  `model` varchar(120),
  `serialNumber` varchar(120),
  `measures` varchar(60) NOT NULL,
  `unitOfMeasure` varchar(20) NOT NULL,
  `calibrationIntervalDays` int,
  `status` enum('active','out_of_service','retired') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `measurementDevices_id` PRIMARY KEY(`id`),
  CONSTRAINT `measurementDevices_deviceRef_unique` UNIQUE(`deviceRef`)
);
--> statement-breakpoint

CREATE TABLE `calibrationEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `measurementDeviceId` int NOT NULL,
  `eventType` enum('calibrated','verified','failed','adjusted','out_of_tolerance_found','returned_to_service') NOT NULL,
  `performedAt` timestamp NOT NULL,
  `performedBy` varchar(180),
  `certificateEvidenceId` int,
  `standardReference` varchar(180),
  `toleranceStated` varchar(80),
  `errorFound` varchar(120),
  -- When a failure is found, from when was the device suspect? Often earlier
  -- than the finding. This bounds the impact analysis.
  `suspectFrom` timestamp,
  `validUntil` timestamp,
  `notes` text,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `calibrationEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `calibrationEvents_device_idx` ON `calibrationEvents` (`measurementDeviceId`, `performedAt`);
--> statement-breakpoint

CREATE TABLE `measurementDeviceAssignments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `measurementDeviceId` int NOT NULL,
  `assignedToType` enum('unit','trailer','facility','shop','worker') NOT NULL,
  `assignedToId` int NOT NULL,
  `assignedFrom` timestamp NOT NULL,
  `assignedUntil` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `measurementDeviceAssignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- Provenance: which device produced the number.
ALTER TABLE `loads` ADD COLUMN `measurementDeviceId` int NULL AFTER `measurementMethod`;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `measurementDeviceId` int NULL AFTER `source`;
