-- 0235 — Marketplace checkpoint 3: the social layer on the commercial core.
--
--   marketplaceClarifications       the tender discussion: a bidder's question is private to the
--                                   asker and the client until the client publishes it, at which
--                                   point question and answer become one clarification every bidder
--                                   reads with the asker withheld; a notice is the client's own
--                                   clarification with no question behind it
--   marketplaceFollows              what an organization wants to hear about (work type, area, both,
--                                   everything); matched when a public posting opens for bidding
--   marketplaceCompanyProfiles      the public face of a company on the board, declared by it
--   marketplacePreferredContractors a client's preferred list; an invite-only tender invites it in one act
--
-- Notifications are NOT a new table: matching work, invitations, published clarifications and
-- award outcomes are delivered as workflowNotifications rows addressed to the organization's
-- dispatcher / office / management roles, which the universal inbox already reads.
CREATE TABLE `marketplaceClarifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `clarificationRef` varchar(64) NOT NULL,
  `postingId` int NOT NULL,
  `kind` enum('question','notice') NOT NULL DEFAULT 'question',
  `askerOrgRef` varchar(40) NOT NULL,
  `askedByUserId` int NOT NULL,
  `question` varchar(2000) NOT NULL,
  `askedAt` timestamp NOT NULL,
  `answer` varchar(4000) NULL,
  `answeredByUserId` int NULL,
  `answeredAt` timestamp NULL,
  `visibility` enum('private','public') NOT NULL DEFAULT 'private',
  `publishedAt` timestamp NULL,
  `publishedByUserId` int NULL,
  `status` enum('open','answered','published') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceClarifications_clarificationRef_unique` (`clarificationRef`),
  KEY `marketplaceClarifications_posting_idx` (`postingId`,`status`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceFollows` (
  `id` int NOT NULL AUTO_INCREMENT,
  `followRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NOT NULL,
  `workType` varchar(60) NULL,
  `operatingArea` varchar(120) NULL,
  `matchKey` varchar(200) NOT NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceFollows_followRef_unique` (`followRef`),
  UNIQUE KEY `marketplaceFollows_org_key_unique` (`orgRef`,`matchKey`),
  KEY `marketplaceFollows_work_type_idx` (`workType`)
);
--> statement-breakpoint
CREATE TABLE `marketplaceCompanyProfiles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(40) NOT NULL,
  `displayName` varchar(220) NOT NULL,
  `description` text NULL,
  `workTypesJson` text NOT NULL,
  `operatingAreasJson` text NOT NULL,
  `equipmentTypesJson` text NOT NULL,
  `updatedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceCompanyProfiles_orgRef_unique` (`orgRef`)
);
--> statement-breakpoint
CREATE TABLE `marketplacePreferredContractors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `clientOrgRef` varchar(40) NOT NULL,
  `contractorOrgRef` varchar(40) NOT NULL,
  `note` varchar(500) NULL,
  `addedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplacePreferredContractors_pair_unique` (`clientOrgRef`,`contractorOrgRef`)
);
