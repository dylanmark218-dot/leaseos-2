-- 0170 — the work calendar, the task board and the reminder engine.
--
-- What this deliberately is NOT: a copy of any date LeaseOS already owns. Leave, qualification
-- expiries, shift interest, rotations, dispatch bookings, pay periods and HOS clocks stay where
-- they are and keep being PROJECTED onto the calendar at read time (server/calendarRouter.ts,
-- v22.20). The rule that "a calendar with its own event store is a second copy of the truth"
-- still holds for every one of those.
--
-- These tables hold the records whose only owner IS the calendar or the board:
--
--   calendarEvents        a meeting, a training session, a stand-down, a personal appointment,
--                         a block of time set aside for a task. Nothing else owns these dates.
--                         A row may LINK to another record (`sourceType`/`sourceRef`) and never
--                         copies its fields; the projection still reads the owner.
--   workTasks             work a person or the company created for a person. Distinct from
--                         `operationalTasks`, which the workflow engine derives from domain
--                         events one-condition-one-task and which people do not create.
--   reminders             a first-class resource, not a timestamp on a task: several per task or
--                         event, recurring or one-off, relative or absolute, snoozed, acknowledged,
--                         missed, cancelled — each transition an append-only `reminderActions` row.
--
-- Delivery is NOT here. A reminder that fires writes a `workflowNotifications` row (0015) under a
-- derived, unique `notificationKey`, so a sweep that runs twice cannot notify twice and the inbox,
-- the escalation ladder (server/_core/escalation.ts) and every existing reader see it without a
-- second delivery system.
--
-- `orgRef` follows 0132: NULL is the historical single tenant; every write derives it from the
-- caller's membership (resolveActingScope) and never from input.
--
-- Privacy is structural, as in 0090: a personal task, event or reminder is `visibility = private`,
-- the availability read carries no field for a title or a body, and a private row's audit entry
-- records the action and the reference and nothing a person wrote.

CREATE TABLE `recurrenceRules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `ruleRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NULL,
  `frequency` enum('daily','weekdays','weekly','monthly') NOT NULL,
  `intervalCount` int NOT NULL DEFAULT 1,
  -- weekly: which weekdays (0 = Sunday … 6 = Saturday), as a JSON array
  `byWeekdayJson` varchar(60) NULL,
  -- monthly: a day of the month, OR an ordinal weekday (first Monday = 1 / 1; last Friday = -1 / 5)
  `byMonthDay` int NULL,
  `ordinalWeek` int NULL,
  `ordinalWeekday` int NULL,
  -- Occurrences keep the anchor's WALL CLOCK in this zone across a DST change; the instants move.
  `timezone` varchar(64) NOT NULL,
  `anchorAt` timestamp NOT NULL,
  `untilAt` timestamp NULL,
  `occurrenceLimit` int NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `recurrenceRules_id` PRIMARY KEY(`id`),
  CONSTRAINT `recurrenceRules_ref_unique` UNIQUE(`ruleRef`)
);
--> statement-breakpoint
CREATE TABLE `calendarEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NULL,
  `kind` enum('personal','company') NOT NULL,
  `category` enum('shift','meeting','training','safety','maintenance','dispatch','payroll','compliance','task_block','personal','other') NOT NULL,
  -- CONFIRMED is a fact; PROJECTED and RECOMMENDED are advice; REQUIRED needs an acknowledgement.
  `state` enum('confirmed','projected','recommended','required','cancelled') NOT NULL DEFAULT 'confirmed',
  `visibility` enum('private','operational','administrative') NOT NULL,
  `ownerUserId` int NOT NULL,
  `createdByUserId` int NOT NULL,
  `title` varchar(220) NOT NULL,
  `detail` text NULL,
  `location` varchar(220) NULL,
  `startsAt` timestamp NOT NULL,
  `endsAt` timestamp NULL,
  `allDay` boolean NOT NULL DEFAULT false,
  `timezone` varchar(64) NOT NULL,
  `recurrenceRuleRef` varchar(64) NULL,
  -- A link, never a copy. The owner keeps its own date.
  `sourceType` varchar(40) NULL,
  `sourceRef` varchar(120) NULL,
  `taskRef` varchar(64) NULL,
  `requiresAcknowledgement` boolean NOT NULL DEFAULT false,
  `previousStartsAt` timestamp NULL,
  `rescheduledAt` timestamp NULL,
  `rescheduledByUserId` int NULL,
  `cancelledAt` timestamp NULL,
  `cancelledByUserId` int NULL,
  `cancelReason` varchar(400) NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `calendarEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `calendarEvents_ref_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `calendarEvents_owner_window` ON `calendarEvents` (`orgRef`, `ownerUserId`, `state`, `startsAt`);
--> statement-breakpoint
CREATE INDEX `calendarEvents_org_window` ON `calendarEvents` (`orgRef`, `kind`, `startsAt`);
--> statement-breakpoint
CREATE TABLE `calendarEventParticipants` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `participantRole` enum('owner','required','optional','informed') NOT NULL DEFAULT 'required',
  `response` enum('none','accepted','declined','tentative') NOT NULL DEFAULT 'none',
  `respondedAt` timestamp NULL,
  `acknowledgedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `calendarEventParticipants_id` PRIMARY KEY(`id`),
  CONSTRAINT `calendarEventParticipants_unique` UNIQUE(`eventRef`, `userId`)
);
--> statement-breakpoint
CREATE INDEX `calendarEventParticipants_user` ON `calendarEventParticipants` (`userId`);
--> statement-breakpoint
CREATE TABLE `workTasks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NULL,
  `kind` enum('personal','company') NOT NULL,
  -- One vocabulary. Which transitions are legal depends on `kind` (server/_core/workTasks.ts):
  -- a personal task never passes through submitted/verified; a company task with a verifier does.
  `status` enum('inbox','todo','in_progress','waiting','blocked','submitted','verified','completed','cancelled') NOT NULL DEFAULT 'inbox',
  `assignmentState` enum('unassigned','assigned','accepted','declined') NOT NULL DEFAULT 'unassigned',
  `visibility` enum('private','operational') NOT NULL,
  `title` varchar(220) NOT NULL,
  `description` text NULL,
  `priority` enum('low','normal','high','critical') NOT NULL DEFAULT 'normal',
  `createdByUserId` int NOT NULL,
  `assigneeUserId` int NULL,
  `teamRef` varchar(64) NULL,
  `startAt` timestamp NULL,
  `dueAt` timestamp NULL,
  `timezone` varchar(64) NOT NULL,
  `acceptedAt` timestamp NULL,
  `submittedAt` timestamp NULL,
  `completedAt` timestamp NULL,
  `completedByUserId` int NULL,
  `verifiedAt` timestamp NULL,
  `verifiedByUserId` int NULL,
  `cancelledAt` timestamp NULL,
  `cancelledByUserId` int NULL,
  `blockedReason` varchar(400) NULL,
  -- Links to records other contexts own. References, never copies.
  `jobRef` varchar(64) NULL,
  `dispatchRef` varchar(64) NULL,
  `driverUserId` int NULL,
  `unitRef` varchar(64) NULL,
  `documentRef` varchar(64) NULL,
  `sourceType` varchar(40) NULL,
  `sourceRef` varchar(120) NULL,
  `recurrenceRuleRef` varchar(64) NULL,
  `requiresAcknowledgement` boolean NOT NULL DEFAULT false,
  `acknowledgedAt` timestamp NULL,
  -- Regulated work does not clear because somebody pressed Done.
  `requiresCompletionEvidence` boolean NOT NULL DEFAULT false,
  `completionEvidenceRef` varchar(120) NULL,
  -- Company tasks only, and only when a policy is set. A personal task never escalates.
  `escalationPolicyJson` text NULL,
  `escalationStep` int NOT NULL DEFAULT 0,
  `escalatedAt` timestamp NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workTasks_id` PRIMARY KEY(`id`),
  CONSTRAINT `workTasks_ref_unique` UNIQUE(`taskRef`)
);
--> statement-breakpoint
CREATE INDEX `workTasks_assignee` ON `workTasks` (`orgRef`, `assigneeUserId`, `status`, `dueAt`);
--> statement-breakpoint
CREATE INDEX `workTasks_creator` ON `workTasks` (`orgRef`, `createdByUserId`, `status`);
--> statement-breakpoint
CREATE INDEX `workTasks_due` ON `workTasks` (`orgRef`, `kind`, `status`, `dueAt`);
--> statement-breakpoint
CREATE TABLE `workTaskChecklistItems` (
  `id` int AUTO_INCREMENT NOT NULL,
  `itemRef` varchar(64) NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `sortOrder` int NOT NULL DEFAULT 0,
  `label` varchar(220) NOT NULL,
  `done` boolean NOT NULL DEFAULT false,
  `doneAt` timestamp NULL,
  `doneByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workTaskChecklistItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `workTaskChecklistItems_ref_unique` UNIQUE(`itemRef`)
);
--> statement-breakpoint
CREATE INDEX `workTaskChecklistItems_task` ON `workTaskChecklistItems` (`taskRef`, `sortOrder`);
--> statement-breakpoint
CREATE TABLE `workTaskDependencies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `dependsOnTaskRef` varchar(64) NOT NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workTaskDependencies_id` PRIMARY KEY(`id`),
  CONSTRAINT `workTaskDependencies_unique` UNIQUE(`taskRef`, `dependsOnTaskRef`)
);
--> statement-breakpoint
CREATE TABLE `workTaskComments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `commentRef` varchar(64) NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `authorUserId` int NOT NULL,
  `body` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workTaskComments_id` PRIMARY KEY(`id`),
  CONSTRAINT `workTaskComments_ref_unique` UNIQUE(`commentRef`)
);
--> statement-breakpoint
CREATE INDEX `workTaskComments_task` ON `workTaskComments` (`taskRef`, `createdAt`);
--> statement-breakpoint
-- Evidence lives in the vault; this row points at it. No bytes here.
CREATE TABLE `workTaskAttachments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `attachmentRef` varchar(64) NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `evidenceRecordId` int NULL,
  `documentRef` varchar(64) NULL,
  `label` varchar(220) NOT NULL,
  `addedByUserId` int NOT NULL,
  `addedAt` timestamp NOT NULL,
  CONSTRAINT `workTaskAttachments_id` PRIMARY KEY(`id`),
  CONSTRAINT `workTaskAttachments_ref_unique` UNIQUE(`attachmentRef`)
);
--> statement-breakpoint
CREATE INDEX `workTaskAttachments_task` ON `workTaskAttachments` (`taskRef`);
--> statement-breakpoint
CREATE TABLE `reminders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `reminderRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NULL,
  `kind` enum('personal','company') NOT NULL,
  -- normal: a notification. important: notification + persistent in-app. alarm: also a device-local
  -- scheduled notification. compliance: requires acknowledgement and may escalate (company only).
  `level` enum('normal','important','alarm','compliance') NOT NULL DEFAULT 'normal',
  `ownerUserId` int NOT NULL,
  `createdByUserId` int NOT NULL,
  `subjectKind` enum('task','event','standalone') NOT NULL DEFAULT 'standalone',
  `subjectRef` varchar(64) NULL,
  `title` varchar(220) NOT NULL,
  `body` text NULL,
  `deepLink` varchar(300) NULL,
  `relativeTo` enum('none','task_due','event_start','source_date') NOT NULL DEFAULT 'none',
  `offsetMinutes` int NULL,
  `sourceType` varchar(40) NULL,
  `sourceRef` varchar(120) NULL,
  `timezone` varchar(64) NOT NULL,
  `fireAt` timestamp NOT NULL,
  `originalFireAt` timestamp NOT NULL,
  `recurrenceRuleRef` varchar(64) NULL,
  `state` enum('scheduled','fired','snoozed','acknowledged','missed','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  `requiresAcknowledgement` boolean NOT NULL DEFAULT false,
  `missedAfterMinutes` int NOT NULL DEFAULT 60,
  `snoozeCount` int NOT NULL DEFAULT 0,
  `snoozedUntil` timestamp NULL,
  `lastFiredAt` timestamp NULL,
  `acknowledgedAt` timestamp NULL,
  `missedAt` timestamp NULL,
  `completedAt` timestamp NULL,
  `cancelledAt` timestamp NULL,
  `escalationPolicyJson` text NULL,
  `escalationStep` int NOT NULL DEFAULT 0,
  `escalatedAt` timestamp NULL,
  `version` int NOT NULL DEFAULT 1,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `reminders_id` PRIMARY KEY(`id`),
  CONSTRAINT `reminders_ref_unique` UNIQUE(`reminderRef`)
);
--> statement-breakpoint
CREATE INDEX `reminders_owner` ON `reminders` (`orgRef`, `ownerUserId`, `state`, `fireAt`);
--> statement-breakpoint
-- The sweep asks "what is due" and nothing else.
CREATE INDEX `reminders_due` ON `reminders` (`state`, `fireAt`);
--> statement-breakpoint
CREATE INDEX `reminders_subject` ON `reminders` (`subjectKind`, `subjectRef`);
--> statement-breakpoint
-- Append-only. `actionRef` is the idempotency key: a device replaying a snooze it already sent, or
-- a sweep that runs twice over the same minute, inserts nothing the second time.
CREATE TABLE `reminderActions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `actionRef` varchar(120) NOT NULL,
  `reminderRef` varchar(64) NOT NULL,
  `action` enum('created','fired','acknowledged','snoozed','rescheduled','missed','completed','cancelled','escalated','advanced') NOT NULL,
  `actorUserId` int NULL,
  `actorSource` enum('human','system','device') NOT NULL DEFAULT 'human',
  `deviceRef` varchar(64) NULL,
  `occurredAt` timestamp NOT NULL,
  `effectiveAt` timestamp NULL,
  `detail` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `reminderActions_id` PRIMARY KEY(`id`),
  CONSTRAINT `reminderActions_ref_unique` UNIQUE(`actionRef`)
);
--> statement-breakpoint
CREATE INDEX `reminderActions_reminder` ON `reminderActions` (`reminderRef`, `occurredAt`);
--> statement-breakpoint
-- The audit trail for the three subjects, append-only. A private subject's row carries the action
-- and the reference and no content: an administrative screen learns that a reminder was snoozed,
-- never what it said.
CREATE TABLE `workAuditEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(40) NULL,
  `subjectKind` enum('task','event','reminder') NOT NULL,
  `subjectRef` varchar(64) NOT NULL,
  `action` varchar(40) NOT NULL,
  `actorUserId` int NULL,
  `actorSource` enum('human','system','device') NOT NULL DEFAULT 'human',
  `visibility` enum('private','operational') NOT NULL,
  `detailJson` text NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workAuditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `workAuditEvents_subject` ON `workAuditEvents` (`subjectKind`, `subjectRef`, `occurredAt`);
