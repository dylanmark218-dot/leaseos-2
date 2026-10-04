-- Intelligence Engine Checkpoint 1 — the source catalogue and immutable provenance.
--
-- Additive only. Every new column on an existing table is nullable or defaulted, so
-- every row written before this migration stays valid and means what it meant.
--
-- THE CATALOGUE COLUMNS SIT BESIDE THE LICENCE COLUMNS AND NEVER TOUCH THEM.
-- `knowledgeSources` already holds the licence assessment (0118). What it lacked was a
-- description of the source itself — format, authority, topics, crawl cadence, robots
-- state — which a collector needs and an assessment does not decide. The repository
-- writes these through `registerCatalogueEntry`, whose upsert names only these columns,
-- so seeding the catalogue cannot grant or revoke anything.
--
-- `authorityLevel` uses the same seven values as `knowledgeDocuments.authorityLevel`
-- (0118), deliberately: one authority scale for the subsystem. The A–E tiers are a view
-- over it (`industryTaxonomy.TIER_OF`), not a second column.

ALTER TABLE `knowledgeSources`
  ADD COLUMN `sourceKind` enum('api','html','pdf','xml','json','csv','geojson','warc','rss','sitemap'),
  ADD COLUMN `authorityLevel` enum('law','official_guidance','recognized_standard','manufacturer','company_policy','operational','unverified') NOT NULL DEFAULT 'unverified',
  ADD COLUMN `domainsJson` json,
  ADD COLUMN `topicsJson` json,
  ADD COLUMN `refreshIntervalHours` int,
  ADD COLUMN `crawlPolicyJson` json,
  ADD COLUMN `termsUrl` varchar(500),
  -- Behind a login, paywall or challenge. Never fetched; see collectors.decideFetch.
  ADD COLUMN `accessControlled` boolean NOT NULL DEFAULT false,
  ADD COLUMN `robotsStatus` enum('unchecked','fetched','absent','unreachable') NOT NULL DEFAULT 'unchecked',
  ADD COLUMN `robotsCheckedAt` timestamp NULL,
  ADD COLUMN `licenceNotes` text,
  -- A retired source keeps its rows and its history; it is simply never fetched again.
  ADD COLUMN `active` boolean NOT NULL DEFAULT true,
  ADD COLUMN `deactivatedReason` varchar(300);

-- A chunk says which retrieval it came from, what its own text hashes to, and what it is
-- about. Nullable because pre-0197 chunks carry none of it. From now on the repository
-- always writes `contentHash`, and writes `snapshotRef` and `topicsJson` whenever the text
-- came through a recorded retrieval.
ALTER TABLE `knowledgeChunks`
  ADD COLUMN `snapshotRef` varchar(64),
  ADD COLUMN `contentHash` varchar(64),
  ADD COLUMN `topicsJson` json;

-- One row per retrieval attempt, including the ones that failed.
--
-- A snapshot is evidence of what a publisher served at a moment, so it is append-only:
-- the triggers below refuse DELETE outright and refuse any UPDATE except recording the
-- outcome of extraction, once, on a row still `pending`. A change to a document produces a
-- NEW snapshot and a new `knowledgeVersions` row that points back at the old one; nothing
-- is overwritten.
--
-- `contentSha256` is the hash LeaseOS recomputed from the bytes, never the collector's
-- claim. It is NULL when there were no trustworthy bytes (`unavailable`, `hash_mismatch`).
-- `rawObjectKey` points at the retained original in object storage and is set only where
-- the source's licence permits retaining text (see repository.recordSnapshot).
--
-- Versions are NOT compared on `contentSha256`. When a parser ran before the retrieval was
-- recorded, the version's `contentHash` is the hash of the extracted text, so footer dates and
-- session tokens do not make a regulation look amended; `provenanceJson.fingerprintBasis` says
-- which. `unparseable` is a retrieval whose bytes are real but yielded no text: kept as
-- evidence, no version, the current one untouched.
CREATE TABLE `knowledgeSnapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `snapshotRef` varchar(64) NOT NULL,
  `sourceId` varchar(64) NOT NULL,
  `documentRef` varchar(64) NOT NULL,
  `url` varchar(1000) NOT NULL,
  `retrievedAt` timestamp NOT NULL,
  `collectorKind` enum('api','html','pdf','browser','geodata','sitemap','rss','common_crawl') NOT NULL,
  `collectorVersion` varchar(40) NOT NULL,
  `outcome` enum('first_seen','unchanged','changed','unavailable','hash_mismatch','unparseable') NOT NULL,
  `outcomeReason` varchar(500),
  `httpStatus` int,
  `contentType` varchar(120),
  `etag` varchar(200),
  `lastModified` varchar(64),
  `byteLength` bigint,
  `contentSha256` varchar(64),
  `declaredSha256` varchar(128),
  `rawObjectKey` varchar(300),
  `previousSnapshotRef` varchar(64),
  -- The version this retrieval produced or confirmed. NULL when it produced nothing usable.
  `versionRef` varchar(64),
  `publishedAt` timestamp NULL,
  `effectiveFrom` timestamp NULL,
  `effectiveUntil` timestamp NULL,
  `parserVersion` varchar(40),
  `extractionStatus` enum('pending','extracted','failed','not_applicable') NOT NULL DEFAULT 'pending',
  `extractionError` varchar(500),
  `provenanceJson` json,
  `recordedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `knowledgeSnapshots_id` PRIMARY KEY(`id`),
  CONSTRAINT `knowledgeSnapshots_snapshotRef_unique` UNIQUE(`snapshotRef`)
);
CREATE INDEX `knowledgeSnapshots_document_idx` ON `knowledgeSnapshots` (`documentRef`, `retrievedAt`);
CREATE INDEX `knowledgeSnapshots_source_idx` ON `knowledgeSnapshots` (`sourceId`);

CREATE TRIGGER `knowledgeSnapshots_no_delete`
BEFORE DELETE ON `knowledgeSnapshots`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'knowledge snapshots are append-only evidence and are never deleted';
END;

CREATE TRIGGER `knowledgeSnapshots_append_only`
BEFORE UPDATE ON `knowledgeSnapshots`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`snapshotRef` <=> OLD.`snapshotRef`) OR NOT (NEW.`sourceId` <=> OLD.`sourceId`)
     OR NOT (NEW.`documentRef` <=> OLD.`documentRef`) OR NOT (NEW.`url` <=> OLD.`url`)
     OR NOT (NEW.`retrievedAt` <=> OLD.`retrievedAt`) OR NOT (NEW.`collectorKind` <=> OLD.`collectorKind`)
     OR NOT (NEW.`collectorVersion` <=> OLD.`collectorVersion`) OR NOT (NEW.`outcome` <=> OLD.`outcome`)
     OR NOT (NEW.`outcomeReason` <=> OLD.`outcomeReason`) OR NOT (NEW.`httpStatus` <=> OLD.`httpStatus`)
     OR NOT (NEW.`contentType` <=> OLD.`contentType`) OR NOT (NEW.`etag` <=> OLD.`etag`)
     OR NOT (NEW.`lastModified` <=> OLD.`lastModified`) OR NOT (NEW.`byteLength` <=> OLD.`byteLength`)
     OR NOT (NEW.`contentSha256` <=> OLD.`contentSha256`) OR NOT (NEW.`declaredSha256` <=> OLD.`declaredSha256`)
     OR NOT (NEW.`rawObjectKey` <=> OLD.`rawObjectKey`) OR NOT (NEW.`previousSnapshotRef` <=> OLD.`previousSnapshotRef`)
     OR NOT (NEW.`versionRef` <=> OLD.`versionRef`) OR NOT (NEW.`publishedAt` <=> OLD.`publishedAt`)
     OR NOT (NEW.`effectiveFrom` <=> OLD.`effectiveFrom`) OR NOT (NEW.`effectiveUntil` <=> OLD.`effectiveUntil`)
     OR NOT (NEW.`provenanceJson` <=> OLD.`provenanceJson`) OR NOT (NEW.`recordedByUserId` <=> OLD.`recordedByUserId`)
     OR NOT (NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'knowledge snapshots are append-only; only the extraction outcome may be recorded';
  END IF;
  IF OLD.`extractionStatus` <> 'pending' AND (NOT (NEW.`extractionStatus` <=> OLD.`extractionStatus`)
     OR NOT (NEW.`extractionError` <=> OLD.`extractionError`) OR NOT (NEW.`parserVersion` <=> OLD.`parserVersion`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'a snapshot extraction outcome is recorded once; re-extraction is a new snapshot';
  END IF;
END;
