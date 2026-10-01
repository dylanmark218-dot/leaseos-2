-- 0222 — Integration Hub: dead letters and their operator action history.
--
-- No acknowledged integration operation may disappear. `integrationDeadLetters` is populated
-- additively, by scanning for terminal failures that already happened elsewhere (a webhookDeliveries
-- row that reached status='dead' per SEC-004/webhookDispatchService.ts, a quarantined inbound event,
-- a dead sync run) — never by changing how those other paths decide an outcome. Operators inspect,
-- requeue, retry now, cancel, acknowledge or resolve; a requeue never erases the attempt history it
-- replays, and a requeued item that dies again is a NEW dead letter linked to the previous one, so
-- there is no dead → retry → dead loop without a person in it.

CREATE TABLE `integrationDeadLetters` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(64) NOT NULL,
  `connectorId` int NULL,
  `deadLetterRef` varchar(64) NOT NULL,
  `kind` enum('outbound_delivery','inbound_event','sync_run') NOT NULL,
  `sourceRef` varchar(80) NOT NULL,
  `subscriptionId` int NULL,
  `eventId` varchar(64) NULL,
  `eventType` varchar(80) NULL,
  `occurredAt` timestamp NULL,
  `payloadRef` varchar(120) NULL,
  `payloadHash` varchar(64) NULL,
  `attemptHistoryJson` text NOT NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `lastError` varchar(400) NULL,
  `httpStatus` int NULL,
  `contractVersion` varchar(40) NULL,
  `correlationId` varchar(64) NULL,
  `reason` varchar(40) NOT NULL,
  `reasonDetail` varchar(500) NULL,
  `deadLetteredAt` timestamp NOT NULL,
  `state` enum('open','requeued','cancelled','acknowledged','resolved') NOT NULL DEFAULT 'open',
  `requeueCount` int NOT NULL DEFAULT 0,
  `previousDeadLetterId` int NULL,
  `acknowledgedByUserId` int NULL,
  `acknowledgedAt` timestamp NULL,
  `resolvedByUserId` int NULL,
  `resolvedAt` timestamp NULL,
  `resolutionNote` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationDeadLetters_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationDeadLetters_deadLetterRef_unique` UNIQUE(`deadLetterRef`)
);
--> statement-breakpoint
CREATE INDEX `integrationDeadLetters_org_state_idx` ON `integrationDeadLetters` (`orgRef`,`state`,`deadLetteredAt`);
--> statement-breakpoint
CREATE INDEX `integrationDeadLetters_source_idx` ON `integrationDeadLetters` (`kind`,`sourceRef`);
--> statement-breakpoint
CREATE TABLE `integrationDeadLetterActions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deadLetterId` int NOT NULL,
  `sequence` int NOT NULL,
  `action` enum('inspected','requeued','retried_now','cancelled','acknowledged','resolved','reopened') NOT NULL,
  `actorUserId` int NULL,
  `note` varchar(500) NULL,
  `resultRef` varchar(80) NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationDeadLetterActions_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationDeadLetterActions_seq_unique` UNIQUE(`deadLetterId`,`sequence`)
);
