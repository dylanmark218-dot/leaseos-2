-- v22.17 — Communications on the route.
--
-- A frequency is not a permission to transmit, so the two facts are two
-- tables: `radioChannels` is what a channel IS, and
-- `companyRadioAuthorizations` is whether THIS company may key up on it.
-- Nothing in the schema lets the first imply the second.
--
-- A channel's geographic conditions live on the channel row as JSON rather
-- than in a table of their own, because a condition is not independently
-- verifiable: a person verifies the channel against the regulator's appendix,
-- and the appendix is where the conditions are written. One verification, one
-- row, one truth.
--
-- `roadRadioAssignments` carries the effective window and the authority tier
-- that v22.15 taught us to want: a road operator's temporary channel change
-- for one week supersedes nothing and expires by arithmetic, and the channel
-- posted on the road outranks every dataset in the building.

CREATE TABLE `radioChannels` (
  `id` int AUTO_INCREMENT NOT NULL,
  `channelKey` varchar(40) NOT NULL,
  `alias` varchar(120) NOT NULL,
  `serviceClass` enum('bc_resource_road','bc_loading','land_mobile_b1','company_private','operator_private','cb_grs','frs_gmrs','public_safety','amateur') NOT NULL,
  `systemType` enum('simplex','repeater','trunked','cb') NOT NULL DEFAULT 'simplex',
  `rxMHz` double,
  `txMHz` double,
  `toneRxHz` double,
  `toneTxHz` double,
  `bandwidthKHz` double,
  `maxPowerW` double,
  `licenceRequired` boolean NOT NULL DEFAULT true,
  `conditionsJson` text NOT NULL,
  `sourceKey` varchar(60) NOT NULL,
  `sourceCitation` varchar(400) NOT NULL,
  `sourceUrl` varchar(600),
  `sourceVersion` varchar(80),
  `retrievedAt` timestamp,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `recordedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `radioChannels_id` PRIMARY KEY(`id`),
  CONSTRAINT `radioChannels_channelKey_unique` UNIQUE(`channelKey`)
);
--> statement-breakpoint
CREATE INDEX `radioChannels_service` ON `radioChannels` (`serviceClass`, `verificationStatus`);
--> statement-breakpoint

CREATE TABLE `companyRadioAuthorizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `authorizationRef` varchar(64) NOT NULL,
  `channelKey` varchar(40) NOT NULL,
  `authorized` boolean NOT NULL DEFAULT false,
  `licenceRef` varchar(120),
  `licenceExpiresAt` timestamp,
  `provincesJson` text,
  `approvedUnitIdsJson` text,
  `evidenceRecordId` int,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `recordedByUserId` int NOT NULL,
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `companyRadioAuthorizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `companyRadioAuthorizations_ref_unique` UNIQUE(`authorizationRef`)
);
--> statement-breakpoint
CREATE INDEX `companyRadioAuthorizations_channel` ON `companyRadioAuthorizations` (`channelKey`, `verificationStatus`);
--> statement-breakpoint

CREATE TABLE `unitRadioCapabilities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `unitId` int NOT NULL,
  `vhf` boolean NOT NULL DEFAULT false,
  `uhf` boolean NOT NULL DEFAULT false,
  `cb` boolean NOT NULL DEFAULT false,
  `satellite` boolean NOT NULL DEFAULT false,
  `cellular` boolean NOT NULL DEFAULT false,
  `programmingProfileRef` varchar(80),
  `programmingProfileVersion` varchar(40),
  `programmedChannelKeysJson` text,
  `programmedAt` timestamp,
  `programmedBy` varchar(200),
  `configurationHash` varchar(64),
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `recordedByUserId` int NOT NULL,
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `unitRadioCapabilities_id` PRIMARY KEY(`id`),
  CONSTRAINT `unitRadioCapabilities_unit_unique` UNIQUE(`unitId`)
);
--> statement-breakpoint

CREATE TABLE `roadRadioAssignments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `assignmentRef` varchar(64) NOT NULL,
  `segmentId` varchar(80) NOT NULL,
  `channelKey` varchar(40) NOT NULL,
  `roadName` varchar(220),
  `authorityTier` enum('posted_sign','operator_instruction','regulatory_authority','planning_map','company_entry','driver_observation','community_reference','unverified_submission') NOT NULL,
  `callDirectionLoaded` enum('increasing_km','decreasing_km'),
  `callIntervalKm` double,
  `mustCallKmJson` text,
  `effectiveFrom` timestamp,
  `effectiveTo` timestamp,
  `permanent` boolean NOT NULL DEFAULT true,
  `supersedesAssignmentRef` varchar(64),
  `sourceKey` varchar(60) NOT NULL,
  `sourceCitation` varchar(400),
  `observedAt` timestamp,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `recordedByUserId` int NOT NULL,
  `verifiedByUserId` int,
  `verifiedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadRadioAssignments_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadRadioAssignments_ref_unique` UNIQUE(`assignmentRef`)
);
--> statement-breakpoint
CREATE INDEX `roadRadioAssignments_segment` ON `roadRadioAssignments` (`segmentId`, `verificationStatus`);
--> statement-breakpoint

CREATE TABLE `radioSignObservations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `observationRef` varchar(64) NOT NULL,
  `segmentId` varchar(80),
  `roadName` varchar(220),
  `observedChannelText` varchar(120) NOT NULL,
  `resolvedChannelKey` varchar(40),
  `latitude` double NOT NULL,
  `longitude` double NOT NULL,
  `evidenceRecordId` int,
  `photoHash` varchar(64),
  `tripId` int,
  `note` varchar(400),
  `status` enum('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  `decisionNote` varchar(400),
  `observedByUserId` int NOT NULL,
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `createdAssignmentRef` varchar(64),
  `observedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `radioSignObservations_id` PRIMARY KEY(`id`),
  CONSTRAINT `radioSignObservations_ref_unique` UNIQUE(`observationRef`)
);
--> statement-breakpoint
CREATE INDEX `radioSignObservations_status` ON `radioSignObservations` (`status`, `segmentId`);
--> statement-breakpoint

CREATE TABLE `communicationCoverage` (
  `id` int AUTO_INCREMENT NOT NULL,
  `coverageRef` varchar(64) NOT NULL,
  `segmentId` varchar(80) NOT NULL,
  `medium` enum('cellular','satellite','radio') NOT NULL,
  `state` enum('available','intermittent','unavailable') NOT NULL,
  `carrier` varchar(120),
  `authorityTier` enum('posted_sign','operator_instruction','regulatory_authority','planning_map','company_entry','driver_observation','community_reference','unverified_submission') NOT NULL,
  `sourceKey` varchar(60) NOT NULL,
  `sourceCitation` varchar(400),
  `observedAt` timestamp,
  `tripId` int,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `communicationCoverage_id` PRIMARY KEY(`id`),
  CONSTRAINT `communicationCoverage_ref_unique` UNIQUE(`coverageRef`)
);
--> statement-breakpoint
CREATE INDEX `communicationCoverage_segment` ON `communicationCoverage` (`segmentId`, `medium`);
--> statement-breakpoint

CREATE TABLE `communicationPlans` (
  `id` int AUTO_INCREMENT NOT NULL,
  `planRef` varchar(64) NOT NULL,
  `unitId` int,
  `tripId` int,
  `jobId` int,
  `buildRef` varchar(64),
  `segmentIdsJson` text NOT NULL,
  `totalKm` double NOT NULL DEFAULT 0,
  `verdict` enum('covered','gaps','unknown') NOT NULL,
  `unknownChannelKm` double NOT NULL DEFAULT 0,
  `noCommunicationKm` double NOT NULL DEFAULT 0,
  `zonesJson` text NOT NULL,
  `coverageJson` text NOT NULL,
  `ladderJson` text NOT NULL,
  `mustCallJson` text NOT NULL,
  `fingerprintHash` varchar(64) NOT NULL,
  `explanation` varchar(2000) NOT NULL,
  `computedByUserId` int NOT NULL,
  `computedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `communicationPlans_id` PRIMARY KEY(`id`),
  CONSTRAINT `communicationPlans_ref_unique` UNIQUE(`planRef`)
);
--> statement-breakpoint
CREATE INDEX `communicationPlans_trip` ON `communicationPlans` (`tripId`, `computedAt`);

--> statement-breakpoint

-- The source registry learns two categories. Radio spectrum authorizations and
-- modelled mobile-coverage layers are neither road networks nor base maps, and
-- filing them as `other` would hide what a licence review is actually reviewing.
ALTER TABLE `externalDataSources`
  MODIFY COLUMN `category` enum('base_map','road_network','land_grid','oilfield_assets','road_conditions','weather','wildfire','routing_engine','geocoder','tiles','spectrum','coverage','other') NOT NULL;
