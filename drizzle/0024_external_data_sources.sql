-- B20.8 — External data source registry.
--
-- Before any government or open dataset is imported, the thing that has to
-- exist is provenance. Not the importer, not the tiles — the record of where a
-- layer came from, under what licence, what attribution it obliges us to show,
-- when it was retrieved, and whether anybody has actually verified any of that.
--
-- Same discipline as taxRules: a source is `unverified` until someone checks
-- it, and an unverified source cannot back an operational decision. A road-ban
-- layer whose licence and currency nobody confirmed is exactly the input that
-- produces a confidently wrong "route is clear".
--
-- Deliberately NOT a spatial subsystem. Migration slots 0016 and 0017 stay
-- reserved for the Spatial Navigation and LoadSense branches. This is the
-- provenance layer those branches will need too, built so it reconciles rather
-- than collides.

CREATE TABLE `externalDataSources` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sourceKey` varchar(120) NOT NULL,
  `displayName` varchar(220) NOT NULL,
  `authority` varchar(220) NOT NULL,
  `sourceUrl` varchar(600),
  `jurisdiction` varchar(80),
  `category` enum('base_map','road_network','land_grid','oilfield_assets','road_conditions','weather','wildfire','routing_engine','geocoder','tiles','other') NOT NULL,
  -- Licence facts are claims until verified. Nothing here is asserted by code.
  `licenceName` varchar(180),
  `licenceUrl` varchar(600),
  `attributionRequired` boolean NOT NULL DEFAULT true,
  `attributionText` varchar(600),
  `shareAlikeObligation` boolean NOT NULL DEFAULT false,
  `commercialUsePermitted` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  `redistributionPermitted` enum('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  -- Live feeds are throttled by their operator. Recording it here lets one
  -- cached fetch serve the fleet instead of every truck calling the authority.
  `rateLimitCalls` int, `rateLimitWindowSeconds` int,
  `requiresApiKey` boolean NOT NULL DEFAULT false,
  `updateIntervalHours` int,
  `retrievedAt` timestamp,
  `verifiedAt` timestamp, `verifiedByUserId` int,
  `status` enum('unverified','verified','superseded','withdrawn') NOT NULL DEFAULT 'unverified',
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalDataSources_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalDataSources_sourceKey_unique` UNIQUE(`sourceKey`)
);
--> statement-breakpoint
CREATE INDEX `externalDataSources_category_idx` ON `externalDataSources` (`category`, `status`);
--> statement-breakpoint

-- One import run. Checksum and importer version so a layer in the database can
-- be traced to the exact file and code that produced it.
CREATE TABLE `externalDatasetImports` (
  `id` int AUTO_INCREMENT NOT NULL,
  `importRef` varchar(64) NOT NULL,
  `externalDataSourceId` int NOT NULL,
  `datasetKey` varchar(160) NOT NULL,
  `datasetVersion` varchar(120),
  `sourceFormat` varchar(60),
  `checksumSha256` varchar(64),
  `importerVersion` varchar(60) NOT NULL,
  `featureCount` int,
  `coordinateSystem` varchar(60),
  `effectiveFrom` timestamp, `effectiveUntil` timestamp,
  `retrievedAt` timestamp NOT NULL,
  `importedAt` timestamp NOT NULL,
  `importedByUserId` int,
  `state` enum('pending','imported','failed','superseded','rolled_back') NOT NULL DEFAULT 'pending',
  `failureReason` text,
  `supersedesImportId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalDatasetImports_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalDatasetImports_importRef_unique` UNIQUE(`importRef`)
);
--> statement-breakpoint
CREATE INDEX `externalDatasetImports_dataset_idx` ON `externalDatasetImports` (`datasetKey`, `state`);
--> statement-breakpoint

-- Live feed fetches. Cached centrally and throttled, so a rate limit belongs to
-- the company rather than to whichever truck asked first.
CREATE TABLE `externalFeedFetches` (
  `id` int AUTO_INCREMENT NOT NULL,
  `externalDataSourceId` int NOT NULL,
  `feedKey` varchar(160) NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `respondedAt` timestamp,
  `httpStatus` int,
  `payloadChecksum` varchar(64),
  `recordCount` int,
  `servedFromCache` boolean NOT NULL DEFAULT false,
  `staleSeconds` int,
  `outcome` enum('ok','rate_limited','error','stale_served','unavailable') NOT NULL,
  `detail` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalFeedFetches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `externalFeedFetches_feed_idx` ON `externalFeedFetches` (`feedKey`, `requestedAt`);
