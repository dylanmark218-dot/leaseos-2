-- v22.20 — 0097: one receipt vocabulary, and edits that append.
--
-- The board carried a five-value receipt model beside the lifecycle's eight,
-- and the router translated between them on every read. That translation was
-- lossy in one direction that mattered: a receipt at `resolved` had been
-- acknowledged on the way, and the mapping had to guess that back. The board
-- now reads the evidence timestamps and the translation is gone.
--
-- `acceptedAt` is added because the server genuinely witnesses acceptance. The
-- states it does not witness get no column: `queued_offline` is a device fact
-- and `uploaded` is a transport fact, and a column for either would invite
-- somebody to fill it from a nearby timestamp.
--
-- Existing rows get NULL for the new columns. Null means not recorded. It does
-- not mean "probably happened when the row was created", and nothing here
-- backfills it from `createdAt`.

ALTER TABLE `messageReceipts` ADD COLUMN `acceptedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `messageReceipts` ADD COLUMN `actionedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `messageReceipts` ADD COLUMN `resolvedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `boardMessages` ADD COLUMN `withdrawnByUserId` int;
--> statement-breakpoint

-- Revision 1 is the original in `boardMessages.body` and is never written here,
-- so there is exactly one writable original and the two cannot disagree.
CREATE TABLE `messageRevisions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `messageRef` varchar(64) NOT NULL,
  `revision` int NOT NULL,
  `body` varchar(4000) NOT NULL,
  `editedByUserId` int NOT NULL,
  `editedAt` timestamp NOT NULL,
  `reason` varchar(600),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `messageRevisions_id` PRIMARY KEY(`id`),
  CONSTRAINT `messageRevisions_unique` UNIQUE(`messageRef`, `revision`)
);
