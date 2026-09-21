-- v22.21 — 0118 (recovered from chat 4 checkpoint 0089): what LeaseOS has been allowed to read.
--
-- The knowledge tables exist to make one thing impossible: ingesting material
-- nobody checked the licence on. Every document belongs to a source, every
-- source carries a stored assessment, and a document cannot leave `QUARANTINED`
-- without the assessment permitting the specific use.
--
-- The 511 Alberta case is why the columns look like this. Alberta's terms allow
-- non-commercial educational reproduction and require written permission for
-- commercial use; the developer API exists but does not obviously override
-- that; and the companion manual says plainly it is not to be reproduced or
-- sold for commercial gain. So "can we use this?" is not one boolean. It is
-- four, and they are genuinely independent: LeaseOS may link to that course
-- today, and may not store a sentence of it.
--
-- `commercialReuseAuthorized` is the flag that cannot be set casually. The
-- assessment's own condition is that written permission exists, so the column
-- is meaningless without `permissionDocumentId` and the application refuses to
-- set one without the other.

CREATE TABLE `knowledgeSources` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sourceId` varchar(64) NOT NULL,
  `sourceName` varchar(200) NOT NULL,
  `owner` varchar(200) NOT NULL,
  `jurisdiction` varchar(16) NOT NULL,
  `homeUrl` varchar(500),

  -- The stored assessment. Absent means nothing may be done with the source.
  `assessmentId` varchar(64),
  `assessedAt` date,
  `assessedByUserId` int,
  `licenceStatus` enum(
    'unassessed',
    'blocked_pending_written_permission',
    'authorized_commercial',
    'authorized_non_commercial_only',
    'link_and_metadata_only',
    'prohibited'
  ) NOT NULL DEFAULT 'unassessed',

  -- Four independent permissions, because they are four legal questions.
  `linkingAuthorized` boolean NOT NULL DEFAULT false,
  `metadataOnlyAuthorized` boolean NOT NULL DEFAULT false,
  `ragIngestionAuthorized` boolean NOT NULL DEFAULT false,
  `modelTrainingAuthorized` boolean NOT NULL DEFAULT false,
  `apiProductionAuthorized` boolean NOT NULL DEFAULT false,
  `commercialReuseAuthorized` boolean NOT NULL DEFAULT false,

  -- The written permission. Without it, commercialReuseAuthorized stays false.
  `permissionDocumentId` varchar(64),
  `permissionScope` json,
  `permissionRecordedByUserId` int,
  `permissionRecordedAt` timestamp,

  -- Kept so a future reader does not re-derive why, or guess what would change it.
  `reasonsJson` json,
  `conditionsToUnblockJson` json,
  `officialSourcesJson` json,

  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `knowledgeSources_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgeSources_sourceId_unique` UNIQUE(`sourceId`)
);

-- A fetched document. Created quarantined, always.
CREATE TABLE `knowledgeDocuments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `documentRef` varchar(64) NOT NULL,
  `sourceId` varchar(64) NOT NULL,
  `title` varchar(400) NOT NULL,
  `url` varchar(1000),

  -- What the job intends. Checked against the source at every transition, not
  -- once at creation — a job that changes its mind fails when it tries.
  `purpose` enum(
    'link_only','metadata_only','rag_ingestion',
    'api_production','api_dev_testing','model_training','commercial_redisplay'
  ) NOT NULL,

  `state` enum(
    'QUARANTINED','LICENCE_CHECKED','PARSED','CLASSIFIED','VERIFIED','PUBLISHED','REJECTED'
  ) NOT NULL DEFAULT 'QUARANTINED',
  `rejectedReason` varchar(500),
  `gateDecisionCode` varchar(64),

  `authorityLevel` enum(
    'law','official_guidance','recognized_standard','manufacturer',
    'company_policy','operational','unverified'
  ) NOT NULL DEFAULT 'unverified',

  `fetchedAt` timestamp NOT NULL,
  `fetchedByUserId` int,
  `contentHash` varchar(64) NOT NULL,

  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
  CONSTRAINT `knowledgeDocuments_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgeDocuments_documentRef_unique` UNIQUE(`documentRef`)
);

-- Versions, so a rule can be shown as it stood on a date rather than only as it
-- stands now. Supersession is recorded; nothing is overwritten.
CREATE TABLE `knowledgeVersions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `versionRef` varchar(64) NOT NULL,
  `documentRef` varchar(64) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `effectiveFrom` timestamp,
  `effectiveUntil` timestamp,
  `publishedAt` timestamp,
  `supersedesVersionRef` varchar(64),
  `supersededByVersionRef` varchar(64),
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `knowledgeVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgeVersions_versionRef_unique` UNIQUE(`versionRef`)
);

-- Chunks. Storing text is reproduction, whatever the pipeline calls it, so a
-- row here is only permitted where the source allows reproduction. The
-- application enforces that; the column records which assessment allowed it.
CREATE TABLE `knowledgeChunks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `chunkRef` varchar(64) NOT NULL,
  `documentRef` varchar(64) NOT NULL,
  `versionRef` varchar(64),
  `ordinal` int NOT NULL,
  `text` text NOT NULL,
  `tokenCount` int,
  `section` varchar(200),
  `page` int,
  -- Which assessment permitted this text to be stored.
  `authorizedByAssessmentId` varchar(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `knowledgeChunks_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgeChunks_chunkRef_unique` UNIQUE(`chunkRef`)
);

CREATE INDEX `knowledgeDocuments_sourceId_idx` ON `knowledgeDocuments` (`sourceId`);
CREATE INDEX `knowledgeDocuments_state_idx` ON `knowledgeDocuments` (`state`);
CREATE INDEX `knowledgeVersions_documentRef_idx` ON `knowledgeVersions` (`documentRef`);
CREATE INDEX `knowledgeChunks_documentRef_idx` ON `knowledgeChunks` (`documentRef`);
