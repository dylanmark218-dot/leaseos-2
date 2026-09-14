CREATE TABLE `domainEventOutbox` (
  `id` int AUTO_INCREMENT NOT NULL, `eventId` varchar(40) NOT NULL,
  `eventType` varchar(80) NOT NULL, `eventVersion` int NOT NULL DEFAULT 1,
  `aggregateType` varchar(40) NOT NULL, `aggregateId` varchar(64) NOT NULL,
  `tenantId` varchar(40) NOT NULL, `branchId` varchar(40),
  `jobId` varchar(64), `tripId` varchar(64), `unitId` varchar(64),
  `correlationId` varchar(40), `causationId` varchar(40),
  `actorSource` enum('human','system','ai','integration') NOT NULL DEFAULT 'system',
  `actorUserId` varchar(40), `payloadJson` text NOT NULL, `occurredAt` timestamp NOT NULL,
  `claimedAt` timestamp, `claimedBy` varchar(64), `processedAt` timestamp,
  `attemptCount` int NOT NULL DEFAULT 0, `lastError` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `domainEventOutbox_id` PRIMARY KEY(`id`),
  CONSTRAINT `domainEventOutbox_eventId_unique` UNIQUE(`eventId`)
);
--> statement-breakpoint
CREATE INDEX `domainEventOutbox_drain_idx` ON `domainEventOutbox` (`processedAt`,`claimedAt`,`id`);
--> statement-breakpoint
CREATE TABLE `workflowRules` (
  `id` int AUTO_INCREMENT NOT NULL, `ruleKey` varchar(80) NOT NULL,
  `version` int NOT NULL DEFAULT 1, `name` varchar(180) NOT NULL, `description` text,
  `eventType` varchar(80) NOT NULL, `enabled` boolean NOT NULL DEFAULT true,
  `effectiveFrom` timestamp, `effectiveTo` timestamp,
  `tenantId` varchar(40), `branchId` varchar(40),
  `conditionsJson` text NOT NULL, `actionsJson` text NOT NULL, `dedupeOnJson` text,
  `source` varchar(180), `createdBy` int, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workflowRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflowRules_key_version_idx` ON `workflowRules` (`ruleKey`,`version`);
--> statement-breakpoint
CREATE INDEX `workflowRules_event_idx` ON `workflowRules` (`eventType`,`enabled`);
--> statement-breakpoint
CREATE TABLE `operationalTasks` (
  `id` int AUTO_INCREMENT NOT NULL, `taskNumber` varchar(40) NOT NULL,
  `taskType` varchar(60) NOT NULL, `title` varchar(220) NOT NULL, `description` text,
  `status` enum('open','acknowledged','in_progress','waiting','completed','cancelled') NOT NULL DEFAULT 'open',
  `priority` enum('low','normal','high','critical') NOT NULL DEFAULT 'normal',
  `tenantId` varchar(40) NOT NULL, `branchId` varchar(40),
  `subjectType` varchar(40) NOT NULL, `subjectId` varchar(64) NOT NULL,
  `jobId` varchar(64), `tripId` varchar(64), `unitId` varchar(64),
  `assignedRole` varchar(60) NOT NULL, `assignedUserId` int,
  `sourceEventId` varchar(40), `sourceRuleKey` varchar(80), `sourceRuleVersion` int,
  `dedupeKey` varchar(300) NOT NULL, `rootDedupeKey` varchar(300),
  `requiresEvidence` boolean NOT NULL DEFAULT false,
  `completionEvidenceRef` varchar(120), `resolutionCode` varchar(60), `resolutionNote` text,
  `escalationStep` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()), `dueAt` timestamp,
  `acknowledgedAt` timestamp, `completedAt` timestamp, `cancelledAt` timestamp,
  CONSTRAINT `operationalTasks_id` PRIMARY KEY(`id`),
  CONSTRAINT `operationalTasks_taskNumber_unique` UNIQUE(`taskNumber`)
);
--> statement-breakpoint
CREATE INDEX `operationalTasks_queue_idx` ON `operationalTasks` (`status`,`assignedRole`,`dueAt`);
--> statement-breakpoint
CREATE INDEX `operationalTasks_root_idx` ON `operationalTasks` (`rootDedupeKey`);
--> statement-breakpoint
CREATE TABLE `workflowInstances` (
  `id` int AUTO_INCREMENT NOT NULL, `workflowNumber` varchar(40) NOT NULL,
  `workflowKey` varchar(60) NOT NULL, `currentState` varchar(60) NOT NULL,
  `tenantId` varchar(40) NOT NULL, `branchId` varchar(40),
  `subjectType` varchar(40) NOT NULL, `subjectId` varchar(64) NOT NULL,
  `jobId` varchar(64), `tripId` varchar(64), `unitId` varchar(64),
  `dedupeKey` varchar(300) NOT NULL, `sourceEventId` varchar(40),
  `openedAt` timestamp NOT NULL, `closedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workflowInstances_id` PRIMARY KEY(`id`),
  CONSTRAINT `workflowInstances_workflowNumber_unique` UNIQUE(`workflowNumber`)
);
--> statement-breakpoint
CREATE INDEX `workflowInstances_state_idx` ON `workflowInstances` (`workflowKey`,`currentState`);
--> statement-breakpoint
CREATE TABLE `workflowTransitions` (
  `id` int AUTO_INCREMENT NOT NULL, `workflowNumber` varchar(40) NOT NULL,
  `fromState` varchar(60) NOT NULL, `toState` varchar(60) NOT NULL, `action` varchar(80),
  `actorUserId` int, `actorRole` varchar(40),
  `actorSource` enum('human','system','ai','integration') NOT NULL DEFAULT 'human',
  `sourceEventId` varchar(40), `ruleKey` varchar(80), `ruleVersion` int,
  `evidenceRef` varchar(120), `reason` text, `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workflowTransitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `workflowTransitions_wf_idx` ON `workflowTransitions` (`workflowNumber`,`occurredAt`);
--> statement-breakpoint
CREATE TABLE `workflowNotifications` (
  `id` int AUTO_INCREMENT NOT NULL, `notificationKey` varchar(200) NOT NULL,
  `taskId` int, `workflowNumber` varchar(40), `tenantId` varchar(40) NOT NULL,
  `recipientRole` varchar(60), `recipientUserId` int,
  `title` varchar(220) NOT NULL, `body` text, `deepLink` varchar(300),
  `channel` enum('in_app','push','email','sms','integration') NOT NULL DEFAULT 'in_app',
  `status` enum('queued','sent','delivered','viewed','acknowledged','failed') NOT NULL DEFAULT 'queued',
  `queuedAt` timestamp NOT NULL, `sentAt` timestamp, `viewedAt` timestamp,
  `acknowledgedAt` timestamp, `failureReason` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workflowNotifications_id` PRIMARY KEY(`id`),
  CONSTRAINT `workflowNotifications_notificationKey_unique` UNIQUE(`notificationKey`)
);
