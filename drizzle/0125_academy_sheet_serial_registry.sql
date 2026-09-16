-- v22.22 — 0125 (realizes Chat 5's PENDING-2/3): the paper assessment-sheet registry.
--
-- A printed sheet is an instrument. Its serial is minted here (Crockford base32,
-- no I/L/O/U, checksum in the serial), allocated in blocks under a row lock so
-- two print runs can never mint the same number, and filed exactly once when
-- the paper comes back. `sheetSerial.ts` decides what a scan may become — a
-- practice sheet never resolves to credential evidence, an unknown serial is
-- UNKNOWN and not a new record, a second scan of the same sheet is refused.
--
-- Sequences and allocations are the allocator's own tables, written by raw SQL
-- inside `sheetSerialAllocator.ts` (LAST_INSERT_ID(nextValue) + n under the
-- UPDATE's row lock; see that file for why). The registry row is the sheet.

CREATE TABLE `sheetSerialSequences` (
  `scope` varchar(120) NOT NULL,
  `nextValue` bigint NOT NULL DEFAULT 1,
  CONSTRAINT `sheetSerialSequences_scope` PRIMARY KEY(`scope`)
);
--> statement-breakpoint
CREATE TABLE `sheetSerialAllocations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `allocationRef` varchar(26) NOT NULL,
  `scope` varchar(120) NOT NULL,
  `firstSequence` bigint NOT NULL,
  `lastSequence` bigint NOT NULL,
  `count` int NOT NULL,
  `printBatchRef` varchar(64),
  `allocatedByUserId` int NOT NULL,
  `state` enum('reserved','printed','voided') NOT NULL DEFAULT 'reserved',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `sheetSerialAllocations_id` PRIMARY KEY(`id`),
  CONSTRAINT `sheetSerialAllocations_ref_unique` UNIQUE(`allocationRef`),
  CONSTRAINT `sheetSerialAllocations_range_unique` UNIQUE(`scope`,`firstSequence`),
  CONSTRAINT `sheetSerialAllocations_count_matches` CHECK (`lastSequence` - `firstSequence` + 1 = `count`)
);
--> statement-breakpoint
CREATE TABLE `academyAssessmentSheets` (
  `id` int AUTO_INCREMENT NOT NULL,
  `serial` varchar(40) NOT NULL,
  `ticketCode` varchar(24) NOT NULL,
  `courseVersionRef` varchar(96) NOT NULL,
  `itemSetRef` varchar(96) NOT NULL,
  `itemSetReviewStatus` enum('draft','in_review','approved','retired') NOT NULL DEFAULT 'draft',
  `allocationRef` varchar(26) NOT NULL,
  `state` enum('issued','printed','returned','transcribed','void') NOT NULL DEFAULT 'issued',
  `voidedReason` varchar(300),
  `courseVersionSupersededAt` timestamp NULL,
  `transcribedAt` timestamp NULL,
  `transcribedByUserId` int,
  `transcriptionRef` varchar(96),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `academyAssessmentSheets_id` PRIMARY KEY(`id`),
  CONSTRAINT `academyAssessmentSheets_serial_unique` UNIQUE(`serial`)
);
--> statement-breakpoint
CREATE INDEX `academyAssessmentSheets_version_idx` ON `academyAssessmentSheets` (`courseVersionRef`,`state`);
