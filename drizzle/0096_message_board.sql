-- v22.20 — 0096: the message board.
--
-- Three tables, and the shapes carry the rules.
--
-- `messageChannels.clientRef` is what makes a channel external. Access is
-- decided on the channel rather than per message, because a per-message filter
-- is one somebody eventually forgets and the failure is a customer reading the
-- internal conversation about their own dispute.
--
-- `boardMessages` keeps both clocks. `deviceCreatedAt` is when the driver saw
-- the washout; `serverReceivedAt` is when it arrived, hours later. Overwriting
-- the first destroys the only record of when it actually happened, which is the
-- thing an offline-first system exists to preserve.
--
-- `messageReceipts` is per recipient and advances forward only. There is no
-- column that says "delivered" without a delivery: `deliveredAt` is null until
-- it reached the device, and the sender is shown "Sent" until then.

CREATE TABLE `messageChannels` (
  `id` int AUTO_INCREMENT NOT NULL,
  `channelRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `type` enum('announcement','dispatch','safety','maintenance','field_operations','road_conditions','training','general','job','client','private','emergency') NOT NULL,
  `name` varchar(220) NOT NULL,
  `jobRef` varchar(64),
  `clientRef` varchar(64),
  `crewRef` varchar(64),
  `archived` boolean NOT NULL DEFAULT false,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageChannels_id` PRIMARY KEY(`id`),
  CONSTRAINT `messageChannels_ref_unique` UNIQUE(`channelRef`)
);
--> statement-breakpoint
CREATE INDEX `messageChannels_tenant` ON `messageChannels` (`tenantId`, `type`, `archived`);
--> statement-breakpoint

CREATE TABLE `boardMessages` (
  `id` int AUTO_INCREMENT NOT NULL,
  `messageRef` varchar(64) NOT NULL,
  `channelRef` varchar(64) NOT NULL,
  `authorUserId` int NOT NULL,
  `authorRole` varchar(40) NOT NULL,
  `priority` enum('normal','important','urgent','emergency') NOT NULL DEFAULT 'normal',
  `body` varchar(4000) NOT NULL,
  `latitude` decimal(9,6),
  `longitude` decimal(9,6),
  -- When the device recorded it. Never overwritten by the server's clock.
  `deviceCreatedAt` timestamp NOT NULL,
  `serverReceivedAt` timestamp NULL,
  `deviceId` varchar(64),
  -- Derived from priority, so an urgent bulletin cannot be posted as ignorable.
  `requiresAcknowledgement` boolean NOT NULL DEFAULT false,
  `withdrawnAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `boardMessages_id` PRIMARY KEY(`id`),
  CONSTRAINT `boardMessages_ref_unique` UNIQUE(`messageRef`)
);
--> statement-breakpoint
CREATE INDEX `boardMessages_channel` ON `boardMessages` (`channelRef`, `deviceCreatedAt`);
--> statement-breakpoint

CREATE TABLE `messageReceipts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `messageRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `state` enum('queued_offline','uploaded','accepted','delivered','opened','acknowledged','actioned','resolved') NOT NULL DEFAULT 'accepted',
  `deliveredAt` timestamp NULL,
  `openedAt` timestamp NULL,
  `acknowledgedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageReceipts_id` PRIMARY KEY(`id`),
  CONSTRAINT `messageReceipts_unique` UNIQUE(`messageRef`, `userId`)
);
