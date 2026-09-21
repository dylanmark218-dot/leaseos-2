-- v22.20 — 0100: agent runs, steps, gateway decisions and approvals.
--
-- Rebuilt from the schema declarations already in this tree after an edit of
-- mine overwrote a parallel contributor's version of this file. The
-- declarations survived, so this follows them rather than what I would have
-- written.
--
-- What turns an assistant into an agent is that the database remembers the job,
-- not the conversation. A run survives a restart, waits on an event, and
-- resumes — none of which a chat transcript can do.
--
-- `agentActions` stores the gateway's verdict for every request, including the
-- refusals. A log of only what succeeded cannot answer "why didn't it", which
-- is the question people actually ask about an agent.
--
-- `idempotencyKey` is unique: a retry after a lost response finds the original
-- rather than doing the thing twice. That matters most for exactly the actions
-- worth retrying — a message sent, an invoice issued.
--
-- No payload column. The gateway binds approval to a hash, and storing the body
-- here would create a second copy of what was approved, free to disagree with
-- the record it describes.

CREATE TABLE `agentRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `agentKey` varchar(60) NOT NULL,
  `goal` varchar(600) NOT NULL,
  `status` enum('created','planning','ready','executing','waiting_for_input','waiting_for_event','waiting_for_approval','retry_scheduled','blocked','paused','completed','failed','cancelled') NOT NULL DEFAULT 'created',
  `initiatedByUserId` int NOT NULL,
  `awaitingEvent` varchar(120),
  `awaitingFilterJson` text,
  `blockedReason` varchar(600),
  `stepsUsed` int NOT NULL DEFAULT 0,
  `maxSteps` int NOT NULL DEFAULT 40,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `agentRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `agentRuns_ref_unique` UNIQUE(`runRef`)
);
--> statement-breakpoint
CREATE INDEX `agentRuns_tenant` ON `agentRuns` (`tenantId`, `status`);
--> statement-breakpoint
CREATE INDEX `agentRuns_awaiting` ON `agentRuns` (`status`, `awaitingEvent`);
--> statement-breakpoint

CREATE TABLE `agentSteps` (
  `id` int AUTO_INCREMENT NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `stepNumber` int NOT NULL,
  `capability` varchar(80) NOT NULL,
  `status` enum('planned','running','completed','blocked','skipped','failed') NOT NULL DEFAULT 'planned',
  `reason` varchar(600),
  `startedAt` timestamp NULL,
  `completedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `agentSteps_id` PRIMARY KEY(`id`),
  CONSTRAINT `agentSteps_unique` UNIQUE(`runRef`, `stepNumber`)
);
--> statement-breakpoint

CREATE TABLE `agentActions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `actionRef` varchar(64) NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `stepNumber` int,
  `capability` varchar(80) NOT NULL,
  `actorType` enum('user','agent','system') NOT NULL,
  `actorId` varchar(64) NOT NULL,
  -- Both identities. An agent acting for somebody is not that person acting.
  `delegatedByUserId` int,
  `targetEntityType` varchar(60) NOT NULL,
  `targetEntityId` varchar(120) NOT NULL,
  `payloadHash` varchar(128) NOT NULL,
  `origin` enum('system','leaseos_policy','company_policy','authorized_user','workflow_data','external_content') NOT NULL,
  -- Refusals are recorded too: a log of successes cannot say why not.
  `decision` enum('allow','deny','require_approval','compliance_block','stale') NOT NULL,
  `decisionReasons` text NOT NULL,
  `outcome` enum('requested','accepted','executed','verified','failed'),
  `idempotencyKey` varchar(220) NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `agentActions_id` PRIMARY KEY(`id`),
  CONSTRAINT `agentActions_ref_unique` UNIQUE(`actionRef`)
);
--> statement-breakpoint
CREATE INDEX `agentActions_run` ON `agentActions` (`runRef`, `requestedAt`);
--> statement-breakpoint
CREATE INDEX `agentActions_idempotency` ON `agentActions` (`idempotencyKey`);
--> statement-breakpoint
CREATE TABLE `agentApprovals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `approvalRef` varchar(64) NOT NULL,
  `runRef` varchar(64) NOT NULL,
  `capability` varchar(80) NOT NULL,
  `targetEntityId` varchar(120) NOT NULL,
  -- The hash is the point: approving one payload approves no other.
  `payloadHash` varchar(128) NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `decidedByUserId` int,
  `decidedAt` timestamp NULL,
  `decision` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `note` varchar(600),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `agentApprovals_id` PRIMARY KEY(`id`),
  CONSTRAINT `agentApprovals_ref_unique` UNIQUE(`approvalRef`)
);
--> statement-breakpoint
CREATE INDEX `agentApprovals_run` ON `agentApprovals` (`runRef`, `decision`);
