CREATE TABLE `specialtyPools` (
  `id` int AUTO_INCREMENT NOT NULL, `code` varchar(60) NOT NULL, `label` varchar(180) NOT NULL,
  `category` varchar(60), `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `specialtyPools_id` PRIMARY KEY(`id`),
  CONSTRAINT `specialtyPools_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `operatorCapabilities` (
  `id` int AUTO_INCREMENT NOT NULL, `operatorId` int NOT NULL,
  `kind` enum('licence','endorsement','certification','orientation','equipment_class','trailer_class','specialty','region','experience') NOT NULL,
  `code` varchar(60) NOT NULL, `label` varchar(180) NOT NULL, `expiresAt` timestamp,
  `isCredential` boolean NOT NULL DEFAULT false, `verifiedAt` timestamp, `documentId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `operatorCapabilities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `operatorCapabilities_op_idx` ON `operatorCapabilities` (`operatorId`,`kind`);
--> statement-breakpoint
CREATE TABLE `operatorAvailability` (
  `id` int AUTO_INCREMENT NOT NULL, `operatorId` int NOT NULL,
  `state` enum('available','unavailable','available_after','on_job','returning','off_duty','on_call','hos_limited','qualification_blocked') NOT NULL,
  `availableFrom` timestamp, `availableUntil` timestamp, `region` varchar(120),
  `maxRadiusKm` double, `preferredServices` varchar(300), `declaredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `operatorAvailability_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `operatorAvailability_op_idx` ON `operatorAvailability` (`operatorId`,`declaredAt`);
--> statement-breakpoint
CREATE TABLE `onCallRotations` (
  `id` int AUTO_INCREMENT NOT NULL, `operatorId` int NOT NULL, `branch` varchar(120),
  `region` varchar(120), `serviceCategory` varchar(60), `poolCode` varchar(60),
  `startsAt` timestamp NOT NULL, `endsAt` timestamp NOT NULL, `position` int NOT NULL DEFAULT 1,
  `status` enum('scheduled','on_call','called','accepted','declined','no_response','dispatched','completed','unavailable') NOT NULL DEFAULT 'scheduled',
  `calledAt` timestamp, `respondedAt` timestamp, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `onCallRotations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `onCallRotations_window_idx` ON `onCallRotations` (`startsAt`,`endsAt`,`status`);
--> statement-breakpoint
CREATE TABLE `dispatchPostings` (
  `id` int AUTO_INCREMENT NOT NULL, `postingNumber` varchar(64) NOT NULL, `jobId` int NOT NULL,
  `distribution` enum('public_internal_bid','selected_pool','invite_only','direct_assignment','on_call','emergency','subcontractor_bid') NOT NULL DEFAULT 'public_internal_bid',
  `poolCode` varchar(60),
  `planningState` enum('draft','planning','open_for_bid','invite_only','on_call','direct','bid_closed','awarding','partially_staffed','staffed','dispatched','in_progress','completed','cancelled') NOT NULL DEFAULT 'draft',
  `planningBlocker` enum('none','awaiting_customer','awaiting_permit','awaiting_equipment','awaiting_crew','awaiting_classification','awaiting_disposal_site','weather') NOT NULL DEFAULT 'none',
  `priority` enum('low','normal','high','emergency') NOT NULL DEFAULT 'normal',
  `requirementsJson` text, `scheduledStart` timestamp, `estimatedDurationMinutes` int,
  `estimatedDistanceKm` double, `expectedLoads` int, `crewSize` int NOT NULL DEFAULT 1,
  `rateVisible` boolean NOT NULL DEFAULT false, `postedRateCents` int, `bidDeadline` timestamp,
  `createdByUserId` int, `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchPostings_id` PRIMARY KEY(`id`),
  CONSTRAINT `dispatchPostings_postingNumber_unique` UNIQUE(`postingNumber`)
);
--> statement-breakpoint
CREATE INDEX `dispatchPostings_queue_idx` ON `dispatchPostings` (`planningState`,`scheduledStart`);
--> statement-breakpoint
CREATE TABLE `dispatchRoles` (
  `id` int AUTO_INCREMENT NOT NULL, `postingId` int NOT NULL, `roleCode` varchar(60) NOT NULL,
  `roleLabel` varchar(180) NOT NULL, `requiredEquipmentClass` varchar(60),
  `requiredTrailerClass` varchar(60), `requirementsJson` text,
  `assignedOperatorId` int, `assignedUnitId` int, `assignedTrailerId` int,
  `status` enum('open','invited','bid_received','assigned','cancelled') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchRoles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchRoles_posting_idx` ON `dispatchRoles` (`postingId`);
--> statement-breakpoint
CREATE TABLE `dispatchInvitations` (
  `id` int AUTO_INCREMENT NOT NULL, `postingId` int NOT NULL, `roleId` int, `operatorId` int,
  `poolCode` varchar(60),
  `status` enum('sent','delivered','viewed','interested','declined','no_response','bid_submitted','awarded','cancelled') NOT NULL DEFAULT 'sent',
  `sentAt` timestamp NOT NULL, `viewedAt` timestamp, `respondedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchInvitations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchInvitations_posting_idx` ON `dispatchInvitations` (`postingId`,`status`);
--> statement-breakpoint
CREATE TABLE `dispatchBids` (
  `id` int AUTO_INCREMENT NOT NULL, `postingId` int NOT NULL, `roleId` int,
  `operatorId` int NOT NULL, `proposedUnitId` int, `proposedTrailerId` int,
  `earliestDeparture` timestamp, `estimatedArrival` timestamp, `bidAmountCents` int,
  `acceptsPostedRate` boolean NOT NULL DEFAULT true, `notes` text,
  `matchScore` int, `matchExplanation` text,
  `status` enum('submitted','withdrawn','awarded','not_selected') NOT NULL DEFAULT 'submitted',
  `submittedAt` timestamp NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchBids_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchBids_posting_idx` ON `dispatchBids` (`postingId`,`status`);
--> statement-breakpoint
CREATE TABLE `dispatchEligibilityChecks` (
  `id` int AUTO_INCREMENT NOT NULL, `postingId` int NOT NULL, `roleId` int,
  `operatorId` int NOT NULL, `unitId` int, `trailerId` int,
  `verdict` enum('eligible','eligible_review','blocked','unknown') NOT NULL,
  `blockersJson` text, `fingerprint` varchar(32) NOT NULL,
  `evaluatedAt` timestamp NOT NULL, `evaluatedByUserId` int,
  `usedForAward` boolean NOT NULL DEFAULT false,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchEligibilityChecks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchEligibilityChecks_lookup_idx` ON `dispatchEligibilityChecks` (`postingId`,`operatorId`,`evaluatedAt`);
--> statement-breakpoint
CREATE TABLE `dispatchOverrides` (
  `id` int AUTO_INCREMENT NOT NULL, `eligibilityCheckId` int, `postingId` int,
  `blockerCode` varchar(80) NOT NULL, `requestedByUserId` int NOT NULL,
  `requestedByRole` varchar(40) NOT NULL, `reason` text, `granted` boolean NOT NULL,
  `refusalReason` varchar(400), `requestedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchOverrides_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchOverrides_posting_idx` ON `dispatchOverrides` (`postingId`);
--> statement-breakpoint
CREATE TABLE `dispatchAuditEvents` (
  `id` int AUTO_INCREMENT NOT NULL, `postingId` int, `roleId` int,
  `eventType` varchar(60) NOT NULL, `actorUserId` int, `actorRole` varchar(40),
  `subjectOperatorId` int, `detail` text, `previousState` varchar(80), `newState` varchar(80),
  `occurredAt` timestamp NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchAuditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatchAuditEvents_posting_idx` ON `dispatchAuditEvents` (`postingId`,`occurredAt`);
--> statement-breakpoint
CREATE TABLE `resourceBookings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `resourceType` enum('operator','unit','trailer','equipment') NOT NULL,
  `resourceRef` varchar(64) NOT NULL, `postingId` int, `jobId` int,
  `startsAt` timestamp NOT NULL, `endsAt` timestamp NOT NULL,
  `bookingState` enum('tentative','confirmed','released','cancelled') NOT NULL DEFAULT 'tentative',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `resourceBookings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `resourceBookings_overlap_idx` ON `resourceBookings` (`resourceRef`,`startsAt`,`endsAt`);
--> statement-breakpoint
CREATE TABLE `dispatchTemplates` (
  `id` int AUTO_INCREMENT NOT NULL, `templateCode` varchar(60) NOT NULL,
  `label` varchar(180) NOT NULL, `customer` varchar(220), `recurrence` varchar(120),
  `requirementsJson` text, `rolesJson` text, `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `dispatchTemplates_id` PRIMARY KEY(`id`),
  CONSTRAINT `dispatchTemplates_templateCode_unique` UNIQUE(`templateCode`)
);
