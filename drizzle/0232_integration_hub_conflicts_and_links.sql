-- 0232 — Integration Hub: conflicts, and the connector links on existing gateway tables.
--
-- A conflict records BOTH competing values and the policy the contract declared. Business, safety,
-- billing, HOS, compliance, ticket, dispatch and identity data default to manual review
-- (server/_core/integrationHub/conflict.ts enforces this regardless of what a contract requests).
--
-- webhookSubscriptions/integrationClients/inboundEvents gain a nullable link to a Hub connector.
-- Nothing about their existing behaviour changes for a row with connectorId NULL.

CREATE TABLE `integrationConflicts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `connectorId` int NOT NULL,
  `contractId` int NULL,
  `conflictRef` varchar(64) NOT NULL,
  `entityType` varchar(80) NOT NULL,
  `entityRef` varchar(120) NOT NULL,
  `fieldPath` varchar(160) NULL,
  `sourceValueJson` text NULL,
  `leaseosValueJson` text NULL,
  `sourceRevision` varchar(80) NULL,
  `leaseosRevision` varchar(80) NULL,
  `policy` enum('reject_review','source_wins','leaseos_wins','newest_wins','manual') NOT NULL,
  `decision` enum('pending','source_applied','leaseos_kept','newest_applied','rejected','manual_source','manual_leaseos','manual_custom') NOT NULL DEFAULT 'pending',
  `inboundEventId` int NULL,
  `syncRunId` int NULL,
  `detectedAt` timestamp NOT NULL,
  `resolvedByUserId` int NULL,
  `resolvedAt` timestamp NULL,
  `resolutionNote` varchar(500) NULL,
  `resolvedValueJson` text NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationConflicts_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationConflicts_conflictRef_unique` UNIQUE(`conflictRef`)
);
--> statement-breakpoint
CREATE INDEX `integrationConflicts_org_decision_idx` ON `integrationConflicts` (`orgRef`,`decision`);
--> statement-breakpoint
ALTER TABLE `webhookSubscriptions` ADD COLUMN `connectorId` int NULL AFTER `orgRef`;
--> statement-breakpoint
ALTER TABLE `integrationClients` ADD COLUMN `connectorId` int NULL AFTER `orgRef`;
--> statement-breakpoint
ALTER TABLE `inboundEvents`
  MODIFY COLUMN `clientId` int NULL,
  MODIFY COLUMN `status` enum('accepted','rejected','duplicate','quarantined','processed') NOT NULL,
  ADD COLUMN `connectorId` int NULL AFTER `clientId`,
  ADD COLUMN `eventId` varchar(64) NULL AFTER `idempotencyKey`,
  ADD COLUMN `eventType` varchar(80) NULL AFTER `eventId`,
  ADD COLUMN `schemaVersion` varchar(20) NULL AFTER `eventType`,
  ADD COLUMN `sourceSystem` varchar(80) NULL AFTER `schemaVersion`,
  ADD COLUMN `contentType` varchar(80) NULL AFTER `sourceSystem`,
  ADD COLUMN `correlationId` varchar(64) NULL AFTER `contentType`,
  ADD COLUMN `occurredAt` timestamp NULL AFTER `correlationId`,
  ADD COLUMN `contractId` int NULL AFTER `occurredAt`,
  ADD COLUMN `normalizedJson` text NULL AFTER `contractId`;
--> statement-breakpoint
CREATE UNIQUE INDEX `inboundEvents_connector_key_unique` ON `inboundEvents` (`connectorId`,`idempotencyKey`);
