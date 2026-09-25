-- 0196 — Document Control, Checkpoint C: controlled numbering with a ledger, per business, offline blocks.
--
-- Slot: built as 0180 on claude/document-control-architecture-jlffzk; adopted as 0190 (2026-09-24) and
-- renumbered 0196 at the rebase of 2026-09-25, to stay directly after 0195 (Checkpoint B). Content unchanged.
--
-- The counter stays `trackingSequences` (project rule §18) — one row-locked
-- `UPDATE … LAST_INSERT_ID(nextNumber)+n`, the discipline the sheet-serial allocator measured
-- (0 collisions in 1200 concurrent allocations against 733 for read-then-write). Three things are
-- added around it, none of them a second counter:
--
--   1. `scopeKey` on the counter: COALESCE(orgRef,'default'). A business's JSA series is its own;
--      the archival DOC series and every legacy caller (FT, INV, DSP, …) stay on the default scope,
--      so nothing they mint changes. The unique index gains the scope.
--   2. `numberAllocations`: one row per minted number, written in the SAME transaction as the
--      counter bump and the record it numbers. A failed insert rolls the counter back with it, so
--      the server path has no gaps at all; a number that is reserved and never used, voided,
--      damaged or lost carries its state and reason, so any gap that does exist is explainable.
--      The unique index on (scope, series, branch, period, sequence) is the database's own refusal
--      to issue a number twice — a device claiming a number that was already consumed collides here,
--      whatever the application code believed.
--   3. `numberBlocks`: a contiguous range reserved to an enrolled device for offline issue. Ranges
--      cannot overlap because each is cut from the same row-locked counter. A lost or retired
--      device's block is retired: every unissued number in it gets an allocation row saying so, and
--      the counter never moves backwards, so nothing is ever reassigned.
ALTER TABLE `trackingSequences`
  ADD COLUMN `orgRef` varchar(64) NULL,
  ADD COLUMN `scopeKey` varchar(64) NOT NULL DEFAULT 'default';
--> statement-breakpoint
DROP INDEX `trackingSequences_scope_idx` ON `trackingSequences`;
--> statement-breakpoint
CREATE UNIQUE INDEX `trackingSequences_scope_idx` ON `trackingSequences` (`scopeKey`,`sequenceType`,`branch`,`periodKey`);
--> statement-breakpoint
CREATE TABLE `numberBlocks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `allocationRef` varchar(40) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `sequenceType` varchar(24) NOT NULL,
  `branch` varchar(12) NOT NULL DEFAULT '',
  `periodKey` varchar(16) NOT NULL,
  `firstSequence` bigint NOT NULL,
  `lastSequence` bigint NOT NULL,
  `count` int NOT NULL,
  `deviceRef` varchar(64) NOT NULL,
  `allocatedByUserId` int NOT NULL,
  `state` enum('active','exhausted','retired','device_lost') NOT NULL DEFAULT 'active',
  `retiredByUserId` int NULL,
  `retiredAt` timestamp NULL,
  `retireReason` varchar(300) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `numberBlocks_id` PRIMARY KEY(`id`),
  CONSTRAINT `numberBlocks_allocationRef_unique` UNIQUE(`allocationRef`),
  CONSTRAINT `numberBlocks_range_unique` UNIQUE(`scopeKey`,`sequenceType`,`branch`,`periodKey`,`firstSequence`),
  CONSTRAINT `numberBlocks_range_chk` CHECK (`lastSequence` >= `firstSequence` AND `count` = `lastSequence` - `firstSequence` + 1)
);
--> statement-breakpoint
CREATE INDEX `numberBlocks_device` ON `numberBlocks` (`deviceRef`,`state`);
--> statement-breakpoint
CREATE TABLE `numberAllocations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `allocationRef` varchar(40) NOT NULL,
  `orgRef` varchar(64) NULL,
  `scopeKey` varchar(64) NOT NULL,
  `sequenceType` varchar(24) NOT NULL,
  `branch` varchar(12) NOT NULL DEFAULT '',
  `periodKey` varchar(16) NOT NULL,
  `sequence` bigint NOT NULL,
  `formattedNumber` varchar(64) NOT NULL,
  `blockId` int NULL,
  `deviceRef` varchar(64) NULL,
  `state` enum('reserved','issued','voided','damaged','lost','unused_retired') NOT NULL,
  `recordType` varchar(40) NULL,
  `recordId` int NULL,
  `idempotencyKey` varchar(120) NULL,
  `reservedByUserId` int NULL,
  `reservedAt` timestamp NOT NULL DEFAULT (now()),
  `issuedAt` timestamp NULL,
  `closedByUserId` int NULL,
  `closedAt` timestamp NULL,
  `reasonCode` enum('record_insert_failed','cancelled_before_issue','duplicate_issue','printed_and_spoiled','device_lost','device_retired','damaged_in_field','migration_gap','other') NULL,
  `reasonText` varchar(300) NULL,
  CONSTRAINT `numberAllocations_id` PRIMARY KEY(`id`),
  CONSTRAINT `numberAllocations_allocationRef_unique` UNIQUE(`allocationRef`),
  CONSTRAINT `numberAllocations_sequence_unique` UNIQUE(`scopeKey`,`sequenceType`,`branch`,`periodKey`,`sequence`),
  CONSTRAINT `numberAllocations_idempotency_unique` UNIQUE(`scopeKey`,`sequenceType`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE INDEX `numberAllocations_record` ON `numberAllocations` (`recordType`,`recordId`);
--> statement-breakpoint
CREATE INDEX `numberAllocations_state` ON `numberAllocations` (`scopeKey`,`sequenceType`,`periodKey`,`state`);
