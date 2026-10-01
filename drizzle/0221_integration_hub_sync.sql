-- 0221 — Integration Hub: durable sync runs and cursors.
--
-- A sync run walks pages under a cursor. The one rule that matters: the checkpoint advances only
-- in the same transaction as the writes it stands for (integrationHubService.ts executeSyncRun).
-- A crash between pages resumes from the last committed cursor, and the page that gets fetched
-- twice is harmless because every record is idempotent by its contract key. Outbound HTTP for a
-- sync adapter goes through server/_core/egressGuard.ts (egressGet), not a bespoke transport.

CREATE TABLE `integrationSyncRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `connectorId` int NOT NULL,
  `contractId` int NULL,
  `runRef` varchar(64) NOT NULL,
  `triggerKind` enum('scheduled','manual','replay','resume') NOT NULL,
  `state` enum('pending','claimed','running','succeeded','failed','cancelled','dead') NOT NULL DEFAULT 'pending',
  `cursorBefore` text NULL,
  `cursorAfter` text NULL,
  `recordsExamined` int NOT NULL DEFAULT 0,
  `recordsAccepted` int NOT NULL DEFAULT 0,
  `recordsRejected` int NOT NULL DEFAULT 0,
  `recordsChanged` int NOT NULL DEFAULT 0,
  `recordsUnchanged` int NOT NULL DEFAULT 0,
  `pagesFetched` int NOT NULL DEFAULT 0,
  `failureCount` int NOT NULL DEFAULT 0,
  `attemptCount` int NOT NULL DEFAULT 0,
  `lastError` varchar(400) NULL,
  `lastErrorClass` varchar(32) NULL,
  `scheduledFor` timestamp NULL,
  `nextAttemptAt` timestamp NULL,
  `claimedAt` timestamp NULL,
  `claimedBy` varchar(64) NULL,
  `startedAt` timestamp NULL,
  `finishedAt` timestamp NULL,
  `correlationId` varchar(64) NULL,
  `requestedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationSyncRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationSyncRuns_runRef_unique` UNIQUE(`runRef`)
);
--> statement-breakpoint
CREATE INDEX `integrationSyncRuns_due_idx` ON `integrationSyncRuns` (`state`,`nextAttemptAt`);
--> statement-breakpoint
CREATE INDEX `integrationSyncRuns_org_idx` ON `integrationSyncRuns` (`orgRef`,`connectorId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `integrationSyncCursors` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `connectorId` int NOT NULL,
  `contractId` int NOT NULL DEFAULT 0,
  `cursorKey` varchar(80) NOT NULL DEFAULT 'default',
  `cursorValue` text NULL,
  `cursorHash` varchar(64) NULL,
  `committedRunId` int NULL,
  `committedAt` timestamp NULL,
  `resetByUserId` int NULL,
  `resetAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationSyncCursors_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationSyncCursors_unique` UNIQUE(`connectorId`,`contractId`,`cursorKey`)
);
