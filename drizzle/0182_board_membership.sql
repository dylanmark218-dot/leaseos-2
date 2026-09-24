-- Company Board, part 1 — membership, publish authority and replay identity.
-- Design: docs/product/COMPANY_BOARD_OPEN_WORK_DESIGN.md §4.
--
-- The board (0096) has channels but no membership. `mayOpen` admits every internal user to every
-- non-private channel, and `private` means a management room, not a private conversation. A direct
-- message, a private group or a job room limited to its crew could not be expressed except through
-- a `crews` row. This adds the one table and the one column that close that gap, and nothing else
-- about how a message, a receipt or a revision works changes.
--
-- MEMBERSHIP MODE. `open` is today's rule, and every existing channel keeps it. `crew` is the
-- crew-bounded rule 0093 already enforces, backfilled where a channel names a crew. `explicit` is
-- new: a person opens the channel only through a current or historical `messageChannelMembers` row,
-- with the same four standings the crew rule already draws (current / historical / future_only /
-- never). A channel is one of the three; the router decides once, in `openChannel`.
--
-- UNIQUENESS. One live membership per person per channel. The key follows 0021: NULL once the
-- person has left, so departed rows never collide and a rejoin is a new row, and uniqueness is on
-- the key rather than on a tuple containing NULL (MariaDB permits unlimited NULLs in a unique index).
--
-- REPLAY. `boardMessages` kept the device clock and the device id but nothing a retry could be
-- matched on, so a queued message re-sent after a dropped connection became a second message.
-- `(deviceId, clientMutationId)` is that identity. NULL on either side binds nothing: a browser post
-- without a device is not replay-safe today and this does not pretend otherwise.

ALTER TABLE `messageChannels`
  MODIFY COLUMN `type` enum('announcement','dispatch','safety','maintenance','field_operations','road_conditions','training','general','job','client','private','emergency','direct','group','department','unit','shift') NOT NULL;
--> statement-breakpoint
ALTER TABLE `messageChannels`
  ADD COLUMN `membershipMode` enum('open','explicit','crew') NOT NULL DEFAULT 'open';
--> statement-breakpoint
-- A channel that names a crew has always been crew-bounded; the column now says so.
UPDATE `messageChannels` SET `membershipMode` = 'crew' WHERE `crewRef` IS NOT NULL;
--> statement-breakpoint

CREATE TABLE `messageChannelMembers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `channelRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  -- A channel role, not a domain role. It confers nothing outside this channel.
  `memberRole` enum('member','moderator','dispatcher','manager','read_only') NOT NULL DEFAULT 'member',
  -- Who put them here. `job_assignment` rows are written by the job-room resolver, never by hand.
  `source` enum('manual','job_assignment','crew','direct') NOT NULL DEFAULT 'manual',
  `joinedAt` timestamp NOT NULL,
  `leftAt` timestamp NULL,
  `mutedAt` timestamp NULL,
  `addedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageChannelMembers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- The live-membership key. NULL once the person has left, so history never collides.
ALTER TABLE `messageChannelMembers`
  ADD COLUMN `liveMemberKey` varchar(140)
    AS (CASE WHEN `leftAt` IS NULL THEN CONCAT(`channelRef`, ':', `userId`) ELSE NULL END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `messageChannelMembers_live_unique` ON `messageChannelMembers` (`liveMemberKey`);
--> statement-breakpoint
CREATE INDEX `messageChannelMembers_channel_idx` ON `messageChannelMembers` (`channelRef`, `userId`);
--> statement-breakpoint
CREATE INDEX `messageChannelMembers_user_idx` ON `messageChannelMembers` (`userId`, `leftAt`);
--> statement-breakpoint

-- Membership, moderation and emergency audit. Append-only; nothing in production updates or
-- deletes a row. Ordinary messages are their own record (the row, its revisions, its receipts) and
-- are deliberately not duplicated here.
CREATE TABLE `messageChannelEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  -- No tenant column: an event is reachable only through its channel, which carries the tenant.
  `channelRef` varchar(64) NOT NULL,
  `eventType` enum('member_added','member_left','member_role_changed','channel_archived','emergency_posted','moderator_read','moderator_withdraw') NOT NULL,
  `actorUserId` int NOT NULL,
  `actorRole` varchar(60) NOT NULL,
  `subjectUserId` int,
  `messageRef` varchar(64),
  `detail` varchar(600),
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageChannelEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `messageChannelEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `messageChannelEvents_channel_idx` ON `messageChannelEvents` (`channelRef`, `occurredAt`);
--> statement-breakpoint

ALTER TABLE `boardMessages` ADD COLUMN `clientMutationId` varchar(64) NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `boardMessages_device_mutation_unique` ON `boardMessages` (`deviceId`, `clientMutationId`);
--> statement-breakpoint

-- The one acknowledgement write that lacked its device clock. `acknowledgedAt` stays the server's.
ALTER TABLE `messageReceipts` ADD COLUMN `deviceAcknowledgedAt` timestamp NULL;
