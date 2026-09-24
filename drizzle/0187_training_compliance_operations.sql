-- 0187 — Training compliance hardening + automatic renewal operations.
--
-- Slot: this branch first numbered this file 0174. Main then took 0174 for
-- dispatch_override_provenance (C1a). Per docs/architecture/MIGRATION_COLLISION_REGISTER.md, the
-- unmerged claimant renumbers to the first number free on main and on every open branch.
-- The register scan on 2026-09-24 found 0170-0186 claimed, so this file is 0187 and its
-- trigger file is 0188. Neither file was ever applied outside development/CI databases.
--
-- One new table. There was no lease, lock or job-run table in LeaseOS — the drain
-- worker's heartbeat runs the webhook retry sweep on every instance with no
-- ownership at all. `scheduledJobRuns` is the minimum that makes a periodic job
-- safe under several application instances: one row per job per time slot, its
-- unique `slotKey` is the ownership (an INSERT that loses the race owns nothing),
-- `leaseUntil` lets another instance take over a slot whose owner died, and the
-- row is the run record (started, completed, inspected, actionable, created,
-- suppressed, failures). It carries no tenant column on purpose: a run spans every
-- organization; each failure inside `failuresJson` names the tenant it concerns.
--
-- Rollback (manual; nothing here rewrites existing data):
--   DROP TABLE `scheduledJobRuns`;
--   ALTER TABLE `workerQualifications` DROP COLUMN `correctionRequestedAt`, DROP COLUMN `correctionRequestedByUserId`,
--     DROP COLUMN `correctionNote`, DROP COLUMN `correctsHoldingRef`;
--   (first drop 0188's triggers, then) UPDATE `academySourceRecords` SET `reviewStatus`='unreviewed' WHERE `reviewStatus`='under_review';
--   ALTER TABLE `academySourceRecords` MODIFY `reviewStatus` enum('unreviewed','reviewed','superseded','rejected') NOT NULL DEFAULT 'unreviewed',
--     DROP COLUMN `proposedByUserId`, DROP COLUMN `firstReviewedByUserId`, DROP COLUMN `firstReviewedAt`, DROP COLUMN `firstReviewNote`,
--     DROP COLUMN `approvedByUserId`, DROP COLUMN `approvedAt`, DROP COLUMN `rejectionReason`, DROP COLUMN `supersedesSourceRef`, DROP COLUMN `supersededBySourceRef`;
--   ALTER TABLE `credentialCompanySettings` DROP COLUMN `escalationPolicyJson`;
--   DELETE FROM the migration ledger the row for this file. Code from 0187 must be reverted first.

CREATE TABLE `scheduledJobRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runRef` varchar(96) NOT NULL,
  `jobKey` varchar(80) NOT NULL,
  `slotKey` varchar(160) NOT NULL,
  `ownerId` varchar(120) NOT NULL,
  `status` enum('running','completed','partial','failed') NOT NULL DEFAULT 'running',
  `startedAt` timestamp NOT NULL,
  `leaseUntil` timestamp NOT NULL,
  `completedAt` timestamp NULL,
  `inspected` int NOT NULL DEFAULT 0,
  `actionable` int NOT NULL DEFAULT 0,
  `notificationsCreated` int NOT NULL DEFAULT 0,
  `suppressed` int NOT NULL DEFAULT 0,
  `failureCount` int NOT NULL DEFAULT 0,
  `failuresJson` text NULL,
  `errorSummary` varchar(1000) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `scheduledJobRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `scheduledJobRuns_ref_unique` UNIQUE(`runRef`),
  CONSTRAINT `scheduledJobRuns_slot_unique` UNIQUE(`slotKey`)
);
--> statement-breakpoint
CREATE INDEX `scheduledJobRuns_job` ON `scheduledJobRuns` (`jobKey`, `startedAt`);
--> statement-breakpoint

-- ---- credential correction: a verifier asks, the owner re-submits; nothing is edited into validity
ALTER TABLE `workerQualifications`
  ADD COLUMN `correctionRequestedAt` timestamp NULL,
  ADD COLUMN `correctionRequestedByUserId` int NULL,
  ADD COLUMN `correctionNote` varchar(1000) NULL,
  ADD COLUMN `correctsHoldingRef` varchar(64) NULL;
--> statement-breakpoint

-- ---- source review: two people, versioned, immutable once decided -----------
ALTER TABLE `academySourceRecords`
  MODIFY COLUMN `reviewStatus` enum('unreviewed','under_review','reviewed','superseded','rejected') NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN `proposedByUserId` int NULL,
  ADD COLUMN `firstReviewedByUserId` int NULL,
  ADD COLUMN `firstReviewedAt` timestamp NULL,
  ADD COLUMN `firstReviewNote` varchar(2000) NULL,
  ADD COLUMN `approvedByUserId` int NULL,
  ADD COLUMN `approvedAt` timestamp NULL,
  ADD COLUMN `rejectionReason` varchar(1000) NULL,
  ADD COLUMN `supersedesSourceRef` varchar(96) NULL,
  ADD COLUMN `supersededBySourceRef` varchar(96) NULL;
--> statement-breakpoint

-- ---- escalation ladders per credential category: company policy -------------
ALTER TABLE `credentialCompanySettings`
  ADD COLUMN `escalationPolicyJson` text NULL;
