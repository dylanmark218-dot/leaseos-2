-- v22.0 — Spatial foundation, with no routing source loaded.
--
-- A location's coordinate says where it came from: the ATS dataset, a field
-- GPS fix, the customer's statement, or the THEORETICAL survey grid — the
-- last computed from the Dominion Land Survey definition and never taken
-- for a verified position. A vehicle profile is the shop's measurement or a
-- spec sheet, verified or not. A road restriction is a rule row with a
-- source and a verification status; nothing is seeded. A route request
-- against the network is a record of the ask and of the answer — which,
-- with no routing source loaded, is UNKNOWN and says why. The four-axis
-- evaluation over caller-named segments writes its evidence to the
-- existing routeEvidenceEntries. Migration slots 0016/0017 remain reserved
-- for the routing-source tranche.

ALTER TABLE `locationIdentities`
  ADD COLUMN `lsdValid` boolean AFTER `surfaceLsd`,
  ADD COLUMN `uwiValid` boolean AFTER `uwi`,
  ADD COLUMN `coordinateSource` enum('ats_v41','field_gps','customer_stated','theoretical_grid','unknown') NOT NULL DEFAULT 'unknown' AFTER `downholeLongitude`,
  ADD COLUMN `coordinateConfidence` enum('low','medium','high','unknown') NOT NULL DEFAULT 'unknown' AFTER `coordinateSource`,
  ADD COLUMN `coordinateVerificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified' AFTER `coordinateConfidence`,
  ADD COLUMN `coordinateVerifiedByUserId` int AFTER `coordinateVerificationStatus`,
  ADD COLUMN `coordinateEvidenceRecordId` int AFTER `coordinateVerifiedByUserId`;
--> statement-breakpoint

CREATE TABLE `vehicleProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `unitId` int NOT NULL,
  `heightM` double NOT NULL,
  `widthM` double NOT NULL,
  `lengthM` double NOT NULL,
  `emptyWeightKg` int NOT NULL,
  `axleGroupsJson` text NOT NULL,
  `source` enum('shop_measured','spec_sheet','operator_stated') NOT NULL,
  `measuredAt` timestamp,
  `verificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `vehicleProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `vehicleProfiles_unitId_unique` UNIQUE(`unitId`)
);
--> statement-breakpoint

CREATE TABLE `roadRestrictions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `restrictionRef` varchar(64) NOT NULL,
  `jurisdiction` varchar(40) NOT NULL,
  `roadRef` varchar(120) NOT NULL,
  `segmentId` varchar(80) NOT NULL,
  `segmentLabel` varchar(220) NOT NULL,
  `checkKey` enum('road_weight_restriction','axle_group_limit','bridge_capacity','bridge_axle_limit','overhead_clearance','bridge_clearance','width_restriction','length_restriction','truck_route_designation','dg_corridor','dg_time_restriction','seasonal_closure','road_ban_level','road_owner_permission','oversize_corridor_designation','escort_requirement') NOT NULL,
  `limitValue` double,
  `textValue` varchar(200),
  `unit` varchar(20),
  `effectiveFrom` timestamp,
  `effectiveTo` timestamp,
  `source` varchar(220) NOT NULL,
  `sourceUrl` varchar(500),
  `sourceVersion` varchar(80),
  `verificationStatus` enum('unverified','verified') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `sourceDocumentEvidenceId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadRestrictions_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadRestrictions_restrictionRef_unique` UNIQUE(`restrictionRef`)
);
--> statement-breakpoint
CREATE INDEX `roadRestrictions_segment_idx` ON `roadRestrictions` (`segmentId`, `checkKey`);
--> statement-breakpoint

CREATE TABLE `routeRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requestRef` varchar(64) NOT NULL,
  `tripId` int,
  `jobId` int,
  `unitId` int NOT NULL,
  `originRef` varchar(120) NOT NULL,
  `destinationRef` varchar(120) NOT NULL,
  `sourceStatus` enum('not_loaded','configured_not_implemented','loaded') NOT NULL,
  `determination` enum('unknown','review','blocked','ready') NOT NULL,
  `reason` varchar(400) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `routeRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `routeRequests_requestRef_unique` UNIQUE(`requestRef`)
);
