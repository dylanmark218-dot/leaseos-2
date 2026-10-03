-- Open Work, part 1 — the post linked to its slot, responses, offers, availability, audit.
-- Design: docs/product/COMPANY_BOARD_OPEN_WORK_DESIGN.md §5–§6.
--
-- `shiftPosts` (0091) is the offer of work and has never known which work. It has no job, posting
-- or slot, its `status` is written once and never moved, and the only response a person could give
-- was interest. `dispatchRoles` (0170) is the slot a person is eventually bound to. This links the
-- two and adds the three records the marketplace lacked. It does not add a third assignment table:
-- a filled post points at the `dispatchRoleAssignmentEvents` row the canonical binding wrote, and
-- restates nothing about it.
--
-- A POST IS NOT A JOB. `dispatchRoleId` is nullable because a shift or overtime opportunity can
-- exist before a job does. An unlinked post collects responses and offers; it cannot be filled.
-- There is no path from an unlinked post to `filled`, and that is the request's "an open-work
-- posting is not necessarily a new job record" made exact.
--
-- OFFERS. `dispatchInvitations` was considered and not reused: it is keyed by operator while every
-- marketplace row is keyed by user, its status enum mixes delivery with response, it has no
-- production writer, and it lacks who offered, when it expires and a replay key. One live offer per
-- person per post, by the 0021 key pattern (NULL once the offer is no longer live).
--
-- AVAILABILITY. A declaration a person makes about their own willingness, consumed by the candidate
-- pool and never by readiness. `orgRef` rather than `tenantId`: the 0132 convention for tables added
-- since, so `orgScopeWhere` applies and the pinned tenantId surface does not move.

ALTER TABLE `shiftPosts`
  MODIFY COLUMN `status` enum('draft','open','closed','filled','cancelled','expired') NOT NULL DEFAULT 'open';
--> statement-breakpoint
ALTER TABLE `shiftPosts`
  ADD COLUMN `dispatchPostingId` int NULL,
  ADD COLUMN `dispatchRoleId` int NULL,
  ADD COLUMN `unitId` int NULL,
  ADD COLUMN `requiredEquipmentClass` varchar(60) NULL,
  ADD COLUMN `overtime` boolean NOT NULL DEFAULT false,
  ADD COLUMN `estimatedHours` int NULL,
  ADD COLUMN `regionCode` varchar(60) NULL,
  -- Display and sort only. Not an input to any eligibility function, as `priority` is not an input
  -- to evaluateDispatchReadiness.
  ADD COLUMN `priority` enum('normal','callout','hotshot','emergency') NOT NULL DEFAULT 'normal',
  ADD COLUMN `publishedAt` timestamp NULL,
  ADD COLUMN `closesAt` timestamp NULL,
  ADD COLUMN `closedAt` timestamp NULL,
  ADD COLUMN `filledAt` timestamp NULL,
  ADD COLUMN `filledByUserId` int NULL,
  ADD COLUMN `cancelledAt` timestamp NULL,
  ADD COLUMN `cancelledByUserId` int NULL,
  ADD COLUMN `cancelReason` varchar(400) NULL;
--> statement-breakpoint
-- Existing rows were published the moment they were posted; say so rather than leave a gap.
UPDATE `shiftPosts` SET `publishedAt` = `postedAt` WHERE `status` = 'open' AND `publishedAt` IS NULL;
--> statement-breakpoint
CREATE INDEX `shiftPosts_role_idx` ON `shiftPosts` (`dispatchRoleId`);
--> statement-breakpoint

ALTER TABLE `shiftInterests`
  -- One standing response per person per post; a new response replaces it in place and the
  -- previous one is written to shiftPostEvents. UNIQUE(postRef, userId) from 0091 stays.
  ADD COLUMN `response` enum('interested','available','request_assignment','declined') NOT NULL DEFAULT 'interested',
  ADD COLUMN `note` varchar(400) NULL,
  ADD COLUMN `deviceCreatedAt` timestamp NULL,
  ADD COLUMN `deviceId` varchar(64) NULL,
  ADD COLUMN `clientMutationId` varchar(64) NULL,
  ADD COLUMN `updatedAt` timestamp NULL;
--> statement-breakpoint

CREATE TABLE `shiftOffers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `offerRef` varchar(64) NOT NULL,
  `postRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `offeredByUserId` int NOT NULL,
  `offeredAt` timestamp NOT NULL,
  `expiresAt` timestamp NULL,
  `status` enum('offered','accepted','declined','withdrawn','expired','awarded','not_selected') NOT NULL DEFAULT 'offered',
  `respondedAt` timestamp NULL,
  `deviceRespondedAt` timestamp NULL,
  `responseDeviceId` varchar(64) NULL,
  `responseClientMutationId` varchar(64) NULL,
  `responseNote` varchar(400) NULL,
  -- The one link between the marketplace and the slot: the assignment event the award produced.
  `awardEventId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `shiftOffers_id` PRIMARY KEY(`id`),
  CONSTRAINT `shiftOffers_offerRef_unique` UNIQUE(`offerRef`)
);
--> statement-breakpoint
ALTER TABLE `shiftOffers`
  ADD COLUMN `liveOfferKey` varchar(140)
    AS (CASE WHEN `status` IN ('offered','accepted') THEN CONCAT(`postRef`, ':', `userId`) ELSE NULL END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `shiftOffers_live_unique` ON `shiftOffers` (`liveOfferKey`);
--> statement-breakpoint
CREATE UNIQUE INDEX `shiftOffers_response_replay_unique` ON `shiftOffers` (`responseDeviceId`, `responseClientMutationId`);
--> statement-breakpoint
CREATE INDEX `shiftOffers_post_idx` ON `shiftOffers` (`postRef`, `status`);
--> statement-breakpoint
CREATE INDEX `shiftOffers_user_idx` ON `shiftOffers` (`userId`, `status`);
--> statement-breakpoint

-- Marketplace audit. Append-only. Both clocks where a device was involved.
CREATE TABLE `shiftPostEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  -- No tenant column: an event is reachable only through its post, which carries the tenant.
  `postRef` varchar(64) NOT NULL,
  `eventType` enum('created','published','linked','closed','reopened','cancelled','expired','response_recorded','response_withdrawn','offer_issued','offer_accepted','offer_declined','offer_withdrawn','offer_expired','awarded','not_selected','award_refused') NOT NULL,
  `actorUserId` int NOT NULL,
  `actorRole` varchar(60) NOT NULL,
  `subjectUserId` int,
  `detail` varchar(600),
  `occurredAt` timestamp NOT NULL,
  `deviceOccurredAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `shiftPostEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `shiftPostEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `shiftPostEvents_post_idx` ON `shiftPostEvents` (`postRef`, `occurredAt`);
--> statement-breakpoint

CREATE TABLE `workerAvailability` (
  `id` int AUTO_INCREMENT NOT NULL,
  `availabilityRef` varchar(64) NOT NULL,
  -- NULL = the historical single tenant, as everywhere since 0132.
  `orgRef` varchar(64),
  `userId` int NOT NULL,
  `state` enum('available','unavailable','on_call','available_for_overtime') NOT NULL,
  -- Both NULL = a standing declaration. A window is half-open: [windowStartsAt, windowEndsAt).
  `windowStartsAt` timestamp NULL,
  `windowEndsAt` timestamp NULL,
  -- Declared preferences, validated on the way in. Never credentials.
  `preferencesJson` text,
  `declaredAt` timestamp NOT NULL,
  `deviceDeclaredAt` timestamp NULL,
  `deviceId` varchar(64) NULL,
  `clientMutationId` varchar(64) NULL,
  -- A dispatcher may record what a person phoned in; the row says so.
  `source` enum('self','dispatcher') NOT NULL DEFAULT 'self',
  `recordedByUserId` int NOT NULL,
  -- Append and supersede, never update in place.
  `supersededAt` timestamp NULL,
  `supersededByRef` varchar(64) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workerAvailability_id` PRIMARY KEY(`id`),
  CONSTRAINT `workerAvailability_ref_unique` UNIQUE(`availabilityRef`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workerAvailability_replay_unique` ON `workerAvailability` (`deviceId`, `clientMutationId`);
--> statement-breakpoint
CREATE INDEX `workerAvailability_user_idx` ON `workerAvailability` (`userId`, `supersededAt`);
--> statement-breakpoint
CREATE INDEX `workerAvailability_org_idx` ON `workerAvailability` (`orgRef`, `state`, `supersededAt`);
