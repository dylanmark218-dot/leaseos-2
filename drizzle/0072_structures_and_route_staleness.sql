-- v22.15 — Structures, effective-dated restrictions, and route staleness.
--
-- A restriction has always carried an effective window; nothing read it, so a
-- spring ban that ended in June still blocked in September. That is fixed in
-- the evaluator. These tables complete the picture around it:
--
-- `structures` — a bridge, culvert, cattle guard or overhead is a thing on a
--   road with its own identity, posted limits, authority and verification.
--   The older `bridges` table stays; this one supersedes it for new records
--   and carries what it could not: kind, load-rating class, posted-versus-
--   rated, seasonal variation and a second person's verification.
--
-- `routeApprovals` — an approved route carries a dependency fingerprint. Change
--   the truck, the trailer, the load, the permits, the restrictions in force
--   or the imported map, and the approval is stale by arithmetic rather than
--   by somebody remembering to re-run it.

CREATE TABLE `structures` (
  `id` int AUTO_INCREMENT NOT NULL,
  `structureRef` varchar(64) NOT NULL,
  `kind` enum('bridge','culvert','overhead','cattle_guard','ford','narrow_passage','other') NOT NULL,
  `label` varchar(220) NOT NULL,
  `jurisdiction` varchar(60) NOT NULL,
  `segmentId` varchar(80),
  `accessRoadObjectId` int,
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `clearanceM` double,
  `postedWeightKg` int,
  `postedAxleGroupKg` int,
  `ratedWeightKg` int,
  `loadRatingClass` varchar(40),
  `widthM` double,
  `seasonalVariation` varchar(220),
  `effectiveFrom` timestamp NULL,
  `effectiveTo` timestamp NULL,
  `source` varchar(300) NOT NULL,
  `sourceUrl` varchar(600),
  `sourceVersion` varchar(60),
  `sourceDocumentEvidenceId` int,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp NULL,
  `supersedesStructureId` int,
  `recordedByUserId` int NOT NULL,
  `notes` varchar(600),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `structures_id` PRIMARY KEY(`id`),
  CONSTRAINT `structures_structureRef_unique` UNIQUE(`structureRef`)
);
--> statement-breakpoint
CREATE INDEX `structures_segment` ON `structures` (`segmentId`, `verificationStatus`);
--> statement-breakpoint
CREATE INDEX `structures_bbox` ON `structures` (`latitude`, `longitude`);
--> statement-breakpoint

CREATE TABLE `routeApprovals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `approvalRef` varchar(64) NOT NULL,
  `tripId` int,
  `jobId` int,
  `unitId` int NOT NULL,
  `originRef` varchar(120) NOT NULL,
  `destinationRef` varchar(120) NOT NULL,
  `dispatchStatus` varchar(40) NOT NULL,
  `segmentIdsJson` text NOT NULL,
  `fingerprintJson` text NOT NULL,
  `fingerprintHash` varchar(64) NOT NULL,
  `explanation` varchar(2000) NOT NULL,
  `status` enum('approved','stale','revoked','superseded') NOT NULL DEFAULT 'approved',
  `staleReasonsJson` text,
  `stalenessDetectedAt` timestamp NULL,
  `approvedByUserId` int NOT NULL,
  `approvedAt` timestamp NOT NULL DEFAULT (now()),
  `revokedByUserId` int,
  `revokedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `routeApprovals_id` PRIMARY KEY(`id`),
  CONSTRAINT `routeApprovals_approvalRef_unique` UNIQUE(`approvalRef`)
);
--> statement-breakpoint
CREATE INDEX `routeApprovals_trip` ON `routeApprovals` (`tripId`, `status`);
