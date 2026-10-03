-- 0233 — Approved external source registry: endpoints, approvals and their audit trail, over the B20.8
-- source registry. Design and operating notes: docs/architecture/EXTERNAL_SOURCE_REGISTRY.md.
--
-- Numbered 0233: the first number free on `main` (`48a64e1`, head 0227) and on every open remote branch at
-- the scan of 2026-10-03 immediately before this commit. Drafted as 0228, it moved before any environment
-- applied it: 0228 is claimed by `claude/payroll-p3-time-candidates` and 0229–0232 by
-- `claude/integration-hub-subsystem-6nzrkw`. docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- EXTENDS, DOES NOT DUPLICATE.
--   externalDataSources (0024) stays the one record of a source's identity, licence and terms, and its
--     licence review (`status`, `geo.sourceReview`) is untouched. It gains the approval lifecycle — a
--     separate question: whether LeaseOS may contact the source at all — and a revision counter.
--   providerCredentials (0192) stays the only description of a credential. An endpoint names one by
--     `credentialRef`; there is nowhere in these tables to put a key, a token or a password.
--   externalDatasetImports and externalFeedFetches (0024) were declared and never written. They become
--     the provenance record and the fetch log for registry-governed requests, with an endpoint column.
--
-- ADDITIVE. No row is deleted or rewritten. Every existing source starts in `draft`, which authorises
-- nothing; the only runtime path that reads the lifecycle is the facility directory's ArcGIS importer.
-- No foreign keys (the 0226/0227 convention); explicit indexes, each named for the lookup it serves.
-- externalSourceEvents is append-only: two triggers at the end refuse an UPDATE or a DELETE (the 0203 convention).

ALTER TABLE `externalDataSources`
  ADD COLUMN `lifecycle` enum('draft','pending_approval','approved','suspended','revoked','retired') NOT NULL DEFAULT 'draft',
  -- Increments whenever an endpoint changes what may be contacted. An approval covers one revision.
  ADD COLUMN `revision` int NOT NULL DEFAULT 1,
  -- Increments on every write; a writer names the version it read (expectedRowVersion), so two
  -- reviewers editing at once cannot silently overwrite each other — the commercial-lifecycle convention.
  ADD COLUMN `rowVersion` int NOT NULL DEFAULT 1,
  -- Who made the current revision: they may not approve it.
  ADD COLUMN `revisionByUserId` int NULL,
  ADD COLUMN `lifecycleChangedAt` timestamp NULL,
  ADD COLUMN `sourceClass` enum('regulator','government','commercial','community','customer','vendor') NULL,
  ADD COLUMN `riskClass` enum('low','moderate','high') NULL,
  ADD COLUMN `sensitivity` enum('public','restricted','confidential') NULL,
  ADD COLUMN `termsUrl` varchar(600) NULL,
  ADD COLUMN `createdByUserId` int NULL,
  ADD COLUMN `updatedAt` timestamp NULL;
--> statement-breakpoint

-- What exactly may be contacted for a source. Host and path are stored as the URL parser writes them
-- (lower-case punycode host, canonical path) and compared exactly — never as substrings.
CREATE TABLE `externalSourceEndpoints` (
  `id` int AUTO_INCREMENT NOT NULL,
  -- `<sourceKey>/<endpointKey>`: readable in logs and stable across edits.
  `endpointRef` varchar(210) NOT NULL,
  `externalDataSourceId` int NOT NULL,
  `endpointKey` varchar(80) NOT NULL,
  `displayName` varchar(200) NOT NULL,
  `serviceType` enum('arcgis_feature_server','arcgis_map_server','rest_json','geojson','wfs','json_feed','xml','csv','webhook','other') NOT NULL,
  `httpMethod` enum('GET','POST') NOT NULL DEFAULT 'GET',
  `hostname` varchar(253) NOT NULL,
  `port` int NOT NULL DEFAULT 443,
  `pathPrefix` varchar(600) NOT NULL,
  `pathMatch` enum('exact','prefix') NOT NULL DEFAULT 'prefix',
  `canonicalUrl` varchar(1024) NOT NULL,
  -- providerCredentials.authScheme, verbatim.
  `authScheme` enum('NONE','API_KEY','STATIC_BEARER','OAUTH2_CLIENT_CREDENTIALS','OAUTH2_REFRESH','SIGNED_REQUEST','MUTUAL_TLS') NOT NULL DEFAULT 'NONE',
  -- A pointer into providerCredentials, never a value.
  `credentialRef` varchar(64) NULL,
  `contentTypesJson` json NOT NULL,
  -- Narrow the caller's own limits; bounded here by the egress guard's ceilings (EGRESS_CEILINGS).
  `timeoutMs` int NULL,
  `maxBytes` int NULL,
  `enabled` boolean NOT NULL DEFAULT false,
  -- Health summary, written by every registry-governed request. The fetch log is externalFeedFetches.
  `lastAttemptAt` timestamp NULL,
  `lastSuccessAt` timestamp NULL,
  `lastFailureAt` timestamp NULL,
  `consecutiveFailures` int NOT NULL DEFAULT 0,
  `lastOutcome` enum('ok','http_error','refused_registry','refused_network','timeout','unexpected_response','transport') NULL,
  `lastHttpStatus` int NULL,
  -- SHA-256 of the layer's field list as last read: a change is schema drift.
  `lastSchemaFingerprint` varchar(64) NULL,
  `schemaChangedAt` timestamp NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NULL,
  CONSTRAINT `externalSourceEndpoints_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalSourceEndpoints_endpointRef_unique` UNIQUE(`endpointRef`),
  CONSTRAINT `externalSourceEndpoints_source_key_unique` UNIQUE(`externalDataSourceId`,`endpointKey`),
  -- The egress guard's ceilings, restated so that no write — even one that bypasses the service — can raise them.
  CONSTRAINT `externalSourceEndpoints_limits_chk` CHECK (`port` BETWEEN 1 AND 65535 AND (`timeoutMs` IS NULL OR `timeoutMs` BETWEEN 1000 AND 60000) AND (`maxBytes` IS NULL OR `maxBytes` BETWEEN 1024 AND 33554432)),
  CONSTRAINT `externalSourceEndpoints_credential_chk` CHECK (`authScheme` <> 'NONE' OR `credentialRef` IS NULL)
);
--> statement-breakpoint
-- Resolving a URL to its endpoint starts from the host and port.
CREATE INDEX `externalSourceEndpoints_host_idx` ON `externalSourceEndpoints` (`hostname`, `port`);
--> statement-breakpoint

-- One request for approval and what became of it. An approval covers one revision of the source's
-- endpoints, names what it authorises (`scopeJson`), and lapses at `expiresAt`.
CREATE TABLE `externalSourceApprovals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `approvalRef` varchar(40) NOT NULL,
  `externalDataSourceId` int NOT NULL,
  `sourceRevision` int NOT NULL,
  `state` enum('proposed','approved','rejected','superseded','revoked') NOT NULL DEFAULT 'proposed',
  `scopeJson` json NOT NULL,
  -- NULL only for a request seeded from repository evidence; the reason then cites that evidence.
  `requestedByUserId` int NULL,
  `requestedAt` timestamp NOT NULL DEFAULT (now()),
  `requestReason` varchar(1000) NOT NULL,
  -- Whoever decided the request, approving or rejecting it.
  `reviewedByUserId` int NULL,
  `reviewedAt` timestamp NULL,
  `reviewNote` varchar(1000) NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  -- The review-by date. Past it, the approval authorises nothing.
  `expiresAt` timestamp NULL,
  `revokedByUserId` int NULL,
  `revokedAt` timestamp NULL,
  `revokeReason` varchar(1000) NULL,
  `supersededAt` timestamp NULL,
  CONSTRAINT `externalSourceApprovals_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalSourceApprovals_approvalRef_unique` UNIQUE(`approvalRef`),
  CONSTRAINT `externalSourceApprovals_approved_chk` CHECK (`state` <> 'approved' OR (`approvedByUserId` IS NOT NULL AND `approvedAt` IS NOT NULL AND `expiresAt` IS NOT NULL)),
  CONSTRAINT `externalSourceApprovals_revoked_chk` CHECK (`state` <> 'revoked' OR (`revokedByUserId` IS NOT NULL AND `revokedAt` IS NOT NULL AND `revokeReason` IS NOT NULL))
);
--> statement-breakpoint
-- The runtime gate reads a source's standing approval.
CREATE INDEX `externalSourceApprovals_source_idx` ON `externalSourceApprovals` (`externalDataSourceId`, `state`);
--> statement-breakpoint

-- Append-only: every change to a source, its endpoints or its approval, with who, why and the revision.
-- authorizationDecisions records that a person was permitted to try; this records what they changed.
CREATE TABLE `externalSourceEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `externalDataSourceId` int NOT NULL,
  `endpointId` int NULL,
  `approvalId` int NULL,
  `eventType` enum('seeded','created','updated','endpoint_added','endpoint_updated','endpoint_disabled','credential_bound','review_requested','rejected','approved','suspended','resumed','revoked','retired') NOT NULL,
  `fromLifecycle` enum('draft','pending_approval','approved','suspended','revoked','retired') NULL,
  `toLifecycle` enum('draft','pending_approval','approved','suspended','revoked','retired') NULL,
  `sourceRevision` int NOT NULL,
  -- NULL only for a seed.
  `actorUserId` int NULL,
  `reason` varchar(1000) NULL,
  -- Field names and non-secret values only; the service never writes a credential value here.
  `detailJson` json NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalSourceEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- A source's history, in order.
CREATE INDEX `externalSourceEvents_source_idx` ON `externalSourceEvents` (`externalDataSourceId`, `id`);
--> statement-breakpoint

-- Provenance: which endpoint, which revision and which approval an import was authorised under.
ALTER TABLE `externalDatasetImports`
  ADD COLUMN `endpointId` int NULL,
  ADD COLUMN `sourceRevision` int NULL,
  ADD COLUMN `approvalId` int NULL,
  ADD COLUMN `purpose` varchar(80) NULL;
--> statement-breakpoint

-- The fetch log names the endpoint, and records a refusal as well as an answer.
ALTER TABLE `externalFeedFetches`
  ADD COLUMN `endpointId` int NULL,
  MODIFY COLUMN `outcome` enum('ok','rate_limited','error','stale_served','unavailable','refused') NOT NULL;
--> statement-breakpoint

-- A facility import run points at its provenance record.
ALTER TABLE `facilityImportRuns`
  ADD COLUMN `externalDatasetImportId` int NULL;
--> statement-breakpoint

-- The registry's history is evidence: who proposed, approved, suspended or revoked a source, and why.
-- The service only ever inserts an event; the database refuses an update or a delete too, as it does
-- for the Live Assist record (0203), so a later caller cannot rewrite who approved what.
CREATE TRIGGER `externalSourceEvents_append_only`
BEFORE UPDATE ON `externalSourceEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'External source registry events are append-only';
--> statement-breakpoint
CREATE TRIGGER `externalSourceEvents_no_delete`
BEFORE DELETE ON `externalSourceEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'External source registry events are never deleted';
