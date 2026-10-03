-- 0229 — Integration Hub: connectors, contracts, and the Hub's own audit trail.
--
-- Slot: main ends at 0219. Open remote branches at claim time (2026-10-01) hold through 0219
-- (customer-contract-rates, just merged) with no branch above it. This takes 0220, the first
-- number free on main and on every open branch. docs/architecture/MIGRATION_COLLISION_REGISTER.md.
-- Renumbered 0220 → 0229 on 2026-10-03 (with 0221–0223 → 0230–0232), unchanged otherwise: main took
-- 0221/0222 (defect lifecycle) and 0226/0227 (payroll), and the ELD branch also holds 0220; 0229 was
-- the first number free on main and every remote branch. The register records the move.
--
-- A connector is the typed, tenant-owned definition of one external system (orgRef NOT NULL from
-- the first migration — tenancy is not a later patch). A contract is the versioned, declarative
-- agreement about what crosses the boundary — never executable. Hub events are the append-only
-- audit trail.
--
-- Credential storage is NOT duplicated here: a connector's secret is a row in `providerCredentials`
-- (0192, S2-C), resolved through server/providerCredentialService.ts under a deterministic
-- providerKey. This migration adds no secret-bearing column anywhere.

CREATE TABLE `integrationConnectors` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `connectorRef` varchar(64) NOT NULL,
  `connectorKey` varchar(80) NOT NULL,
  `definitionVersion` int NOT NULL DEFAULT 1,
  `name` varchar(160) NOT NULL,
  `providerType` enum('transportation_feed','eld','telematics','fuel_card','disposal_facility','customer_system','vendor_system','accounting','payroll','email_sms','mapping','document_storage','government_regulatory','other') NOT NULL,
  `direction` enum('inbound','outbound','bidirectional') NOT NULL,
  `authMethod` enum('none','api_key','hmac_shared_secret','bearer_token','oauth2_client_credentials','oauth2_refresh','signed_request','mutual_tls') NOT NULL,
  `capabilitiesJson` text NOT NULL,
  `configJson` text NOT NULL,
  `status` enum('draft','active','disabled','suspended','revoked') NOT NULL DEFAULT 'draft',
  `critical` boolean NOT NULL DEFAULT false,
  `dataClassification` enum('public','internal','confidential','restricted') NOT NULL DEFAULT 'internal',
  `timeoutMs` int NOT NULL DEFAULT 10000,
  `maxPayloadBytes` int NOT NULL DEFAULT 1048576,
  `syncIntervalSeconds` int NULL,
  `nextSyncAt` timestamp NULL,
  `defaultContractId` int NULL,
  `externalSourceKey` varchar(80) NULL,
  `residency` varchar(40) NULL,
  `retentionDays` int NULL,
  `requiresApprovalJson` text NULL,
  `healthState` enum('unknown','healthy','degraded','rate_limited','authentication_required','disabled','suspended','failing','dead_letter_backlog') NOT NULL DEFAULT 'unknown',
  `consecutiveFailures` int NOT NULL DEFAULT 0,
  `circuitOpenUntil` timestamp NULL,
  `lastSuccessAt` timestamp NULL,
  `lastInboundAt` timestamp NULL,
  `lastOutboundAt` timestamp NULL,
  `lastSyncAt` timestamp NULL,
  `lastHealthCheckAt` timestamp NULL,
  `lastError` varchar(400) NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `integrationConnectors_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationConnectors_connectorRef_unique` UNIQUE(`connectorRef`)
);
--> statement-breakpoint
CREATE INDEX `integrationConnectors_org_status_idx` ON `integrationConnectors` (`orgRef`,`status`);
--> statement-breakpoint
CREATE INDEX `integrationConnectors_sync_due_idx` ON `integrationConnectors` (`status`,`nextSyncAt`);
--> statement-breakpoint
CREATE TABLE `integrationContracts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `contractKey` varchar(80) NOT NULL,
  `version` int NOT NULL,
  `direction` enum('inbound','outbound','bidirectional') NOT NULL,
  `sourceEntity` varchar(80) NOT NULL,
  `destinationEntity` varchar(80) NOT NULL,
  `schemaVersion` varchar(20) NOT NULL,
  `definitionJson` text NOT NULL,
  `conflictPolicy` enum('reject_review','source_wins','leaseos_wins','newest_wins','manual') NOT NULL,
  `idempotencyStrategy` enum('external_id','payload_hash','external_id_and_revision') NOT NULL,
  `cursorStrategy` enum('none','opaque','timestamp','sequence','page') NOT NULL,
  `tombstoneBehaviour` enum('ignore','mark_deleted','reject') NOT NULL DEFAULT 'reject',
  `freshnessSeconds` int NULL,
  `retentionClass` varchar(40) NOT NULL DEFAULT 'operational',
  `authorizationRequirement` varchar(80) NOT NULL,
  `dataOwnership` enum('external','leaseos','shared') NOT NULL,
  `checksum` varchar(64) NOT NULL,
  `status` enum('draft','active','retired') NOT NULL DEFAULT 'active',
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationContracts_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationContracts_scope_key_version_unique` UNIQUE(`scopeKey`,`contractKey`,`version`)
);
--> statement-breakpoint
CREATE TABLE `integrationHubEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `eventType` varchar(60) NOT NULL,
  `targetType` varchar(40) NOT NULL,
  `targetRef` varchar(80) NOT NULL,
  `actorUserId` int NULL,
  `actorSource` enum('human','system','integration') NOT NULL,
  `correlationId` varchar(64) NULL,
  `beforeJson` text NULL,
  `afterJson` text NULL,
  `detail` varchar(500) NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationHubEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationHubEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `integrationHubEvents_org_idx` ON `integrationHubEvents` (`orgRef`,`occurredAt`);
--> statement-breakpoint
CREATE INDEX `integrationHubEvents_target_idx` ON `integrationHubEvents` (`targetType`,`targetRef`);
