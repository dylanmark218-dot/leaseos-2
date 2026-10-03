-- 0221 — Mechanic Portal + Fleet Maintenance, checkpoint 2: defect → work order → repair → return to service.
-- Design: docs/register/MECHANIC_PORTAL_FLEET_MAINTENANCE_DESIGN.md §3.2–3.3, §5, §9 CP2, on the Fleet &
-- Equipment Portfolio (holds are `unitHolds`; state is the portfolio's projection) and Fleet/Unit
-- Security CP1.5 (units through server/unitScope.ts; return to service is a person's act).
-- Record: docs/register/MECHANIC_PORTAL_CP2_DEFECT_TO_RETURN_TO_SERVICE.md. Trigger DDL is 0222.
--
-- Numbered 0221: the first number above every claim — main ends at 0219, and `claude/eld-compliance-intelligence-ramlrd`
-- holds 0220 (0220_eld_event_ledger.sql). Drafted as 0220 and moved before any environment applied it.

-- A defect keeps what the reporter said and proposed apart from what was decided. `severity` stays the
-- column readiness and the release evaluator read; `severityProposed` is the reporter's word and is never
-- read as a decision. NULL on older rows means not recorded — they predate this checkpoint.
ALTER TABLE `maintenanceDefects`
  ADD COLUMN `defectRef` varchar(64) NULL,
  ADD COLUMN `source` enum('driver_report','mechanic_inspection','roadside','enforcement','telematics','office') NULL,
  ADD COLUMN `driverStatement` text NULL,
  ADD COLUMN `severityProposed` enum('advisory','inspection_required','critical') NULL,
  ADD COLUMN `severityProposedByUserId` int NULL,
  ADD COLUMN `severityDecidedByUserId` int NULL,
  ADD COLUMN `severityDecidedAt` timestamp NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenanceDefects_defectRef_unique` ON `maintenanceDefects` (`defectRef`);
--> statement-breakpoint

-- Every act on a defect, as history: who, in what role, from what to what, and why. Written in the same
-- transaction as the act it records; 0222 refuses UPDATE and DELETE.
CREATE TABLE `maintenanceDefectEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `defectId` int NOT NULL,
  `unitId` int NOT NULL,
  `eventType` enum('reported','severity_decided','sent_to_shop','task_added','task_status','released','returned_to_service','return_to_service_failed','resolved','hold_placed','hold_released','roadside_closed') NOT NULL,
  `fromValue` varchar(120),
  `toValue` varchar(120),
  `reason` varchar(600),
  `actorUserId` int NOT NULL,
  `actorRole` varchar(40) NOT NULL,
  `workOrderId` int,
  `releaseId` int,
  `taskId` int,
  `inspectionId` int,
  `holdRef` varchar(96),
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `maintenanceDefectEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `maintenanceDefectEvents_eventRef_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `maintenanceDefectEvents_defect` ON `maintenanceDefectEvents` (`defectId`, `occurredAt`);
--> statement-breakpoint

-- The repair, as tasks. A work order may carry several; each may name the defect it addresses. Forward
-- only: open → in_progress → done | not_required, or deferred with a reason. A finished task is history
-- (0222). A release is refused while any task is open or in progress.
CREATE TABLE `workOrderTasks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `taskRef` varchar(64) NOT NULL,
  `workOrderId` int NOT NULL,
  `unitId` int NOT NULL,
  `seq` int NOT NULL,
  `kind` enum('inspect','diagnose','repair','replace','adjust','road_test','other') NOT NULL,
  `title` varchar(220) NOT NULL,
  `instructions` text,
  `defectId` int,
  `status` enum('open','in_progress','done','not_required','deferred') NOT NULL DEFAULT 'open',
  `findings` text,
  `correctiveAction` text,
  `deferredReason` varchar(400),
  `createdByUserId` int NOT NULL,
  `completedByUserId` int,
  `completedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workOrderTasks_id` PRIMARY KEY(`id`),
  CONSTRAINT `workOrderTasks_taskRef_unique` UNIQUE(`taskRef`)
);
--> statement-breakpoint
CREATE INDEX `workOrderTasks_workOrder` ON `workOrderTasks` (`workOrderId`, `seq`);
--> statement-breakpoint

-- The return-to-service inspection: a second person's verification that the released repair holds. Its
-- own row in `inspections`, typed, naming the work order and the release it verified. 0222 makes a
-- return-to-service inspection immutable.
ALTER TABLE `inspections`
  MODIFY COLUMN `type` enum('training','pre_trip','post_trip','return_to_service') NOT NULL,
  ADD COLUMN `inspectionRef` varchar(64) NULL,
  ADD COLUMN `outcome` enum('pass','fail') NULL,
  ADD COLUMN `inspectorUserId` int NULL,
  ADD COLUMN `workOrderId` int NULL,
  ADD COLUMN `releaseId` int NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `inspections_inspectionRef_unique` ON `inspections` (`inspectionRef`);
