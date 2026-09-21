-- v22.20 — 0081: what a feed actually returned, and what it said about a road.
--
-- Two tables, because they are two different facts.
--
-- `externalFeedRuns` is the provenance of a collection: when it ran, what the
-- publisher answered, how many records survived normalization, and where the
-- quota stood. A feed that has never run and a feed that ran and failed are not
-- the same state, and neither is a feed that returned nothing because nothing
-- is happening.
--
-- `roadAdvisories` is the publisher's own statement, kept as the publisher made
-- it. `advisoryOnly` is NOT NULL DEFAULT 1 and there is no code path that sets
-- it to 0: a road condition from a traffic feed can put a trip in front of a
-- person, and it can never clear a verified restriction or make an illegal
-- route legal. That is the whole reason this is a separate table from
-- roadRestrictions rather than a row in it.

CREATE TABLE `externalFeedRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `sourceKey` varchar(60) NOT NULL,
  `startedAt` timestamp NOT NULL,
  `finishedAt` timestamp NULL,
  `outcome` enum('succeeded','failed','refused','not_modified') NOT NULL,
  `refusedBecause` enum('not_cleared','no_credential','not_due','quota_exhausted','withdrawn') DEFAULT NULL,
  `httpStatus` int,
  `recordsSeen` int NOT NULL DEFAULT 0,
  `recordsAccepted` int NOT NULL DEFAULT 0,
  `recordsRejected` int NOT NULL DEFAULT 0,
  `rejectionsJson` text,
  `quotaUsedInWindow` int,
  `quotaLimit` int,
  `responseHash` varchar(64),
  `sourceVersion` varchar(120),
  `entityTag` varchar(200),
  `errorText` varchar(1000),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalFeedRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalFeedRuns_ref_unique` UNIQUE(`runRef`)
);
--> statement-breakpoint
CREATE INDEX `externalFeedRuns_source` ON `externalFeedRuns` (`sourceKey`, `startedAt`);
--> statement-breakpoint

CREATE TABLE `roadAdvisories` (
  `id` int AUTO_INCREMENT NOT NULL,
  `advisoryRef` varchar(64) NOT NULL,
  `sourceKey` varchar(60) NOT NULL,
  `externalRef` varchar(200) NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `advisoryType` enum('closure','incident','construction','road_condition','weather','restriction','other') NOT NULL,
  `severity` enum('info','minor','major','closure','unknown') NOT NULL DEFAULT 'unknown',
  `headline` varchar(400) NOT NULL,
  `detail` varchar(2000),
  `roadName` varchar(220),
  `direction` varchar(60),
  `latitude` double,
  `longitude` double,
  `radiusMetres` double,
  `geometryJson` text,
  `effectiveFrom` timestamp NULL,
  `effectiveTo` timestamp NULL,
  `sourceUpdatedAt` timestamp NULL,
  `retrievedAt` timestamp NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  -- Never 0. There is no writer that sets it, and a test holds it that way.
  `advisoryOnly` boolean NOT NULL DEFAULT true,
  `status` enum('active','superseded','withdrawn') NOT NULL DEFAULT 'active',
  `supersededByAdvisoryRef` varchar(64),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadAdvisories_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadAdvisories_ref_unique` UNIQUE(`advisoryRef`)
);
--> statement-breakpoint
CREATE INDEX `roadAdvisories_source_external` ON `roadAdvisories` (`sourceKey`, `externalRef`, `status`);
--> statement-breakpoint
CREATE INDEX `roadAdvisories_location` ON `roadAdvisories` (`latitude`, `longitude`);
