-- v22.20 — 0088: handing an inspector a panel.
--
-- `roadsidePanel.ts` has existed for several checkpoints as pure logic with no
-- way to reach it. An inspector at the scale could not be handed anything.
--
-- The grant is the point. A QR code carries a reference; the reference resolves
-- to a row that has to be live, unrevoked and for the unit being presented.
-- Somebody photographing a sticker on a parked truck gets nothing, which is the
-- difference between a pointer and a key.
--
-- Every view is recorded. An inspector opening a panel is a fact the company
-- should be able to see later, and "who saw our compliance records" is not a
-- question to answer from memory.

CREATE TABLE `roadsidePanelGrants` (
  `id` int AUTO_INCREMENT NOT NULL,
  `grantRef` varchar(64) NOT NULL,
  `unitRef` varchar(120) NOT NULL,
  `unitId` int,
  `issuedByUserId` int NOT NULL,
  `issuedFor` varchar(220) NOT NULL,
  `issuedAt` timestamp NOT NULL DEFAULT (now()),
  `expiresAt` timestamp NOT NULL,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int,
  `revocationReason` varchar(400),
  `viewCount` int NOT NULL DEFAULT 0,
  `lastViewedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `roadsidePanelGrants_id` PRIMARY KEY(`id`),
  CONSTRAINT `roadsidePanelGrants_ref_unique` UNIQUE(`grantRef`)
);
--> statement-breakpoint
CREATE INDEX `roadsidePanelGrants_unit` ON `roadsidePanelGrants` (`unitRef`, `expiresAt`);
