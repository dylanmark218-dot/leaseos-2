-- v20.13 P3 — typed Assistant commit boundary.
--
-- A display string such as "TRIP-42 unload stop" is not a safe database target,
-- and an HH:MM extracted from speech is not a timestamp without a local date and
-- UTC offset. These three context fields make that boundary explicit.
ALTER TABLE `assistantProposals`
  ADD COLUMN `targetRecordId` int,
  ADD COLUMN `eventDateLocal` varchar(10),
  ADD COLUMN `utcOffsetMinutes` int;
--> statement-breakpoint

-- One row per proposal is both provenance and a DB-enforced idempotency key.
-- The operational write and this receipt are committed in the same transaction.
CREATE TABLE `assistantCommitReceipts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `proposalId` varchar(40) NOT NULL,
  `formKey` varchar(60) NOT NULL,
  `action` enum('create','update') NOT NULL,
  `targetType` enum('trip_stop','maintenance_defect') NOT NULL,
  `targetRecordId` int NOT NULL,
  `requiredPermission` varchar(80) NOT NULL,
  `authorizationDecisionId` int,
  `adapterVersion` varchar(40) NOT NULL,
  `fieldManifest` text NOT NULL,
  `fieldManifestHash` varchar(64) NOT NULL,
  `actorUserId` int NOT NULL,
  `committedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `assistantCommitReceipts_id` PRIMARY KEY(`id`),
  CONSTRAINT `assistantCommitReceipts_proposal_unique` UNIQUE(`proposalId`)
);
--> statement-breakpoint
CREATE INDEX `assistantCommitReceipts_target_idx`
  ON `assistantCommitReceipts` (`targetType`, `targetRecordId`);
