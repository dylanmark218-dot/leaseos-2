-- v22.24 — 0129 (P3.1): the manifest becomes a chain of custody.
--
-- Until now a manifest carried its driver, trailer, route and facility as
-- TEXT, and its scale tickets, evidence and signatures as JSON blobs. Nothing
-- could be proved from it: the text could name an operator who never held a
-- licence, a facility that does not exist, a ticket that was also filed
-- against another load.
--
-- ADDITIVE. Every existing column stays and becomes the captured snapshot —
-- what was REPRESENTED at the time — beside a canonical reference:
--   operatorId / trailerUnitId / originFacilityId / destinationFacilityId /
--   tripId / loadId, plus the tenant (orgRef) that owns the manifest.
-- Party snapshots are rows so a later rename of a facility does not rewrite a
-- 2026 manifest. Custody is a sequence of events. An amendment is a row that
-- carries the hash of what it replaced. Evidence is a link into the evidence
-- registry with a named relationship, not a JSON string.
--
-- Nothing here decides what closing a manifest requires. That is an evidence
-- profile per load class, stored as configuration, NONE seeded: a load class
-- with no approved profile closes to REVIEW, never to complete.

ALTER TABLE `manifests` ADD COLUMN `orgRef` varchar(64) NULL;
ALTER TABLE `manifests` ADD COLUMN `tripId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `loadId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `operatorId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `trailerUnitId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `originFacilityId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `destinationFacilityId` int NULL;
ALTER TABLE `manifests` ADD COLUMN `loadClass` varchar(64) NULL;
ALTER TABLE `manifests` ADD COLUMN `sealedAt` timestamp NULL;
ALTER TABLE `manifests` ADD COLUMN `closedAt` timestamp NULL;
ALTER TABLE `manifests` ADD COLUMN `currentHash` varchar(64) NULL;
ALTER TABLE `manifests` ADD COLUMN `amendmentCount` int NOT NULL DEFAULT 0;
ALTER TABLE `manifests` MODIFY COLUMN `status` enum('draft','verified','sealed','complete') NOT NULL DEFAULT 'draft';
--> statement-breakpoint
CREATE INDEX `manifests_org_idx` ON `manifests` (`orgRef`,`status`);
--> statement-breakpoint
CREATE TABLE `manifestPartySnapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `manifestId` int NOT NULL,
  `role` enum('operator','unit','trailer','route','origin_facility','destination_facility') NOT NULL,
  `canonicalEntityId` int NULL,
  `capturedName` varchar(220) NOT NULL,
  `capturedIdentifier` varchar(120) NULL,
  `capturedAddress` varchar(300) NULL,
  `source` enum('backfilled_text','bound_from_record','amendment') NOT NULL,
  `capturedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestPartySnapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `manifestPartySnapshots_manifest_idx` ON `manifestPartySnapshots` (`manifestId`,`role`);
--> statement-breakpoint
CREATE TABLE `manifestCustodyEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `manifestId` int NOT NULL,
  `sequence` int NOT NULL,
  `eventType` enum('loaded','departed_origin','arrived_facility','accepted_by_facility','rejected_by_facility','unloaded','closed') NOT NULL,
  `actorUserId` int NOT NULL,
  `facilityId` int NULL,
  `occurredAt` timestamp NOT NULL,
  `evidenceRecordId` int NULL,
  `notes` varchar(500) NULL,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestCustodyEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `manifestCustodyEvents_seq_unique` UNIQUE(`manifestId`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `manifestAmendments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `manifestId` int NOT NULL,
  `amendmentNo` int NOT NULL,
  `reasonCode` enum('party_correction','quantity_correction','facility_change','evidence_added','other') NOT NULL,
  `reasonText` varchar(500) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `approvedByUserId` int NOT NULL,
  `previousHash` varchar(64) NOT NULL,
  `replacementHash` varchar(64) NOT NULL,
  `changesJson` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestAmendments_id` PRIMARY KEY(`id`),
  CONSTRAINT `manifestAmendments_no_unique` UNIQUE(`manifestId`,`amendmentNo`)
);
--> statement-breakpoint
CREATE TABLE `manifestEvidenceLinks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `manifestId` int NOT NULL,
  `evidenceRecordId` int NOT NULL,
  `relationship` enum('origin_ticket','scale_ticket','disposal_ticket','photo','signature','client_authorization','facility_acceptance','route_evidence') NOT NULL,
  `attachedByUserId` int NOT NULL,
  `attachedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestEvidenceLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `manifestEvidenceLinks_unique` UNIQUE(`manifestId`,`evidenceRecordId`,`relationship`)
);
--> statement-breakpoint
CREATE INDEX `manifestEvidenceLinks_evidence_idx` ON `manifestEvidenceLinks` (`evidenceRecordId`,`relationship`);
--> statement-breakpoint
CREATE TABLE `manifestEvidenceProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `loadClass` varchar(64) NOT NULL,
  `requiredRelationshipsJson` text NOT NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `manifestEvidenceProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `manifestEvidenceProfiles_unique` UNIQUE(`orgRef`,`loadClass`)
);
--> statement-breakpoint
-- Backfill: every legacy text party becomes a snapshot row, marked as such.
-- The text columns are not cleared; they are what was written at the time.
INSERT INTO `manifestPartySnapshots` (`manifestId`, `role`, `canonicalEntityId`, `capturedName`, `source`)
  SELECT `id`, 'operator', NULL, `driver`, 'backfilled_text' FROM `manifests` WHERE `driver` IS NOT NULL AND `driver` <> '';
--> statement-breakpoint
INSERT INTO `manifestPartySnapshots` (`manifestId`, `role`, `canonicalEntityId`, `capturedName`, `source`)
  SELECT `id`, 'trailer', NULL, `trailer`, 'backfilled_text' FROM `manifests` WHERE `trailer` IS NOT NULL AND `trailer` <> '';
--> statement-breakpoint
INSERT INTO `manifestPartySnapshots` (`manifestId`, `role`, `canonicalEntityId`, `capturedName`, `source`)
  SELECT `id`, 'route', NULL, `route`, 'backfilled_text' FROM `manifests` WHERE `route` IS NOT NULL AND `route` <> '';
--> statement-breakpoint
INSERT INTO `manifestPartySnapshots` (`manifestId`, `role`, `canonicalEntityId`, `capturedName`, `source`)
  SELECT `id`, 'destination_facility', NULL, `facility`, 'backfilled_text' FROM `manifests` WHERE `facility` IS NOT NULL AND `facility` <> '';
