-- 0189 — Marketplace: posting + bid + award domain (checkpoint 1).
--
-- The commercial layer between a client organization that needs work performed
-- and the contractor organizations able to perform it. Six tables, all carrying
-- the organization they belong to:
--
--   marketplacePostings      the work opportunity and its lifecycle state
--   marketplaceInvitations   who was invited to an invite-only tender
--   marketplaceBids          the bid HEAD — one per (posting, bidder); state moves, content does not
--   marketplaceBidRevisions  write-once: every submission, hashed; v1 is never overwritten
--   marketplaceAwards        one per posting, bound to a revision's content hash, with the client's rationale
--   marketplaceEvents        append-only tender audit trail
--
-- Distinct from dispatchPostings/dispatchBids (0013), which record an operator's
-- willingness to take a shift inside one company. No automatic dispatch creation
-- happens here; that is the next checkpoint's bridge.
--
-- Numbered 0189: 0175–0188 are claimed by open branches (see
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md).
CREATE TABLE `marketplacePostings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `postingRef` varchar(64) NOT NULL,
  `clientOrgRef` varchar(40) NOT NULL,
  `title` varchar(220) NOT NULL,
  `workType` varchar(60) NOT NULL,
  `description` text NULL,
  `pickupLocation` varchar(220) NULL,
  `pickupLsd` varchar(40) NULL,
  `destination` varchar(220) NULL,
  `destinationLsd` varchar(40) NULL,
  `pickupLat` double NULL,
  `pickupLng` double NULL,
  `estimatedQuantityMillis` int NULL,
  `quantityUnit` varchar(20) NULL,
  `equipmentType` varchar(120) NULL,
  `unitsRequired` int NULL,
  `estimatedDurationMinutes` int NULL,
  `estimatedDistanceKm` double NULL,
  `requestedStart` timestamp NULL,
  `deadline` timestamp NULL,
  `biddingClosesAt` timestamp NULL,
  `pricingBasis` enum('fixed_price','unit_rate','hourly','combination','any') NOT NULL DEFAULT 'any',
  `visibility` enum('open','sealed') NOT NULL DEFAULT 'sealed',
  `distribution` enum('public','invite_only') NOT NULL DEFAULT 'public',
  `operatingArea` varchar(120) NULL,
  `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `requirementsJson` text NOT NULL,
  `documentsJson` text NOT NULL,
  `state` enum('draft','published','bidding','bidding_closed','awarded','contracted','dispatched','active','completed','closed','cancelled') NOT NULL DEFAULT 'draft',
  `version` int NOT NULL DEFAULT 1,
  `publishedAt` timestamp NULL,
  `biddingOpenedAt` timestamp NULL,
  `biddingClosedAt` timestamp NULL,
  `awardedAt` timestamp NULL,
  `cancelledAt` timestamp NULL,
  `cancelReason` varchar(500) NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplacePostings_postingRef_unique` (`postingRef`),
  KEY `marketplacePostings_client_idx` (`clientOrgRef`,`state`),
  KEY `marketplacePostings_state_idx` (`state`,`biddingClosesAt`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceInvitations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invitationRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `invitedOrgRef` varchar(40) NOT NULL,
  `status` enum('sent','declined','withdrawn') NOT NULL DEFAULT 'sent',
  `invitedByUserId` int NOT NULL,
  `respondedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceInvitations_invitationRef_unique` (`invitationRef`),
  UNIQUE KEY `marketplaceInvitations_posting_org_unique` (`postingId`,`invitedOrgRef`),
  KEY `marketplaceInvitations_invited_idx` (`invitedOrgRef`,`status`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceBids` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bidRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `bidderOrgRef` varchar(40) NOT NULL,
  `state` enum('draft','submitted','withdrawn','shortlisted','accepted','rejected') NOT NULL DEFAULT 'draft',
  `currentRevisionId` int NULL,
  `revisionCount` int NOT NULL DEFAULT 0,
  `draftContentJson` text NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdByUserId` int NOT NULL,
  `submittedAt` timestamp NULL,
  `withdrawnAt` timestamp NULL,
  `decidedAt` timestamp NULL,
  `decidedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceBids_bidRef_unique` (`bidRef`),
  UNIQUE KEY `marketplaceBids_posting_bidder_unique` (`postingId`,`bidderOrgRef`),
  KEY `marketplaceBids_bidder_idx` (`bidderOrgRef`,`state`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceBidRevisions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `revisionRef` varchar(64) NOT NULL,
  `bidId` int NOT NULL,
  `postingId` int NOT NULL,
  `bidderOrgRef` varchar(40) NOT NULL,
  `revisionNumber` int NOT NULL,
  `contentJson` text NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `pricingType` enum('fixed_price','unit_rate','hourly','combination') NOT NULL,
  `currency` varchar(3) NOT NULL,
  `comparableTotalCents` int NULL,
  `comparableBasis` varchar(200) NOT NULL,
  `readinessJson` text NOT NULL,
  `readinessVerdict` varchar(24) NOT NULL,
  `submittedByUserId` int NOT NULL,
  `submittedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceBidRevisions_revisionRef_unique` (`revisionRef`),
  UNIQUE KEY `marketplaceBidRevisions_bid_revision_unique` (`bidId`,`revisionNumber`),
  KEY `marketplaceBidRevisions_posting_idx` (`postingId`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceAwards` (
  `id` int NOT NULL AUTO_INCREMENT,
  `awardRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `bidId` int NOT NULL,
  `bidRevisionId` int NOT NULL,
  `clientOrgRef` varchar(40) NOT NULL,
  `contractorOrgRef` varchar(40) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `comparableTotalCents` int NULL,
  `currency` varchar(3) NOT NULL,
  `rationale` text NOT NULL,
  `readinessJson` text NOT NULL,
  `state` enum('awarded','contracted','cancelled') NOT NULL DEFAULT 'awarded',
  `awardedByUserId` int NOT NULL,
  `awardedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceAwards_awardRef_unique` (`awardRef`),
  UNIQUE KEY `marketplaceAwards_postingId_unique` (`postingId`),
  KEY `marketplaceAwards_contractor_idx` (`contractorOrgRef`,`state`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceEvents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `eventRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `bidId` int NULL,
  `bidRevisionId` int NULL,
  `awardId` int NULL,
  `eventType` varchar(60) NOT NULL,
  `actorUserId` int NULL,
  `actorOrgRef` varchar(40) NULL,
  `previousState` varchar(40) NULL,
  `newState` varchar(40) NULL,
  `detailJson` text NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceEvents_eventRef_unique` (`eventRef`),
  KEY `marketplaceEvents_posting_idx` (`postingId`,`occurredAt`)
);
