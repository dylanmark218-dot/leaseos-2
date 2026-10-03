-- 0227 — Payroll P2: pay schedules, generated pay periods, and the pay-period state machine with its lock.
-- Design: docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §12 (paySchedules), §13 (pay-period machine), §22
-- (owner decisions; D1 authorizes P1–P8 as the payroll exception to the SPINE moratorium; D6 keeps the payroll
-- lock separate from the accounting period) and the P2 checkpoint section.
--
-- Numbered 0227: the first number free on `main` (head 0226) and on every open remote branch at the scan of
-- 2026-10-03 immediately before this commit (0223 integration hub; 0224 ELD and CI stabilization; 0225 CI
-- stabilization). docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- Conventions as 0226: the book (financialEntityId) is the money boundary; `date` for calendar dates; refs unique;
-- no foreign keys; explicit indexes. No money columns are added.

/* ---------------- Pay schedules ---------------- */

-- A book's payroll calendar. Periods are generated from it deterministically on calendar dates; `timezone` is the
-- zone those dates are wall-clock in, used only to derive the legacy instant columns on a period (startsOn/endsOn).
--   weekly / biweekly / custom: [anchorDate + k·length, anchorDate + (k+1)·length), length 7 / 14 / periodLengthDays
--   semi_monthly: [1st, 16th) and [16th, 1st of next month); anchorDate must be a 1st or a 16th
--   monthly: [anchor day, same day next month); anchorDate's day must be 1–28
-- paymentDate = last day of the period + paymentLagDays; cutoffDate = last day + cutoffLagDays.
CREATE TABLE `paySchedules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `scheduleRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `frequency` enum('weekly','biweekly','semi_monthly','monthly','custom') NOT NULL,
  `anchorDate` date NOT NULL,
  `periodLengthDays` int NULL,
  `paymentLagDays` int NOT NULL DEFAULT 0,
  `cutoffLagDays` int NOT NULL DEFAULT 0,
  `timezone` varchar(64) NOT NULL,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `createdByUserId` int NOT NULL,
  `retiredByUserId` int NULL,
  `retiredAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `paySchedules_id` PRIMARY KEY(`id`),
  CONSTRAINT `paySchedules_scheduleRef_unique` UNIQUE(`scheduleRef`),
  CONSTRAINT `paySchedules_lengths_chk` CHECK (`paymentLagDays` BETWEEN 0 AND 60 AND `cutoffLagDays` BETWEEN -14 AND 60 AND (`periodLengthDays` IS NULL OR `periodLengthDays` BETWEEN 1 AND 62))
);
--> statement-breakpoint
CREATE INDEX `paySchedules_book_idx` ON `paySchedules` (`financialEntityId`, `status`);
--> statement-breakpoint

/* ---------------- Pay periods: schedule link, calendar dates, the machine's actors ---------------- */

-- `periodStartDate`/`periodEndDate` are authoritative for scheduled periods, half-open [start, end) like the 0226
-- version windows. The legacy instant columns (startsOn/endsOn) stay and are derived from them in the schedule's
-- zone. NULL on legacy ad-hoc periods. One period per schedule per start date (multiple NULL schedules allowed,
-- so legacy rows are unaffected).
--
-- The state machine runs over the EXISTING enum, plus `voided`: collecting = OPEN, review = REVIEWING,
-- approved = APPROVED (locked), processing = PROCESSING, closed = FINALIZED, amended = CORRECTED, voided = VOIDED.
-- `paid` stays in the enum for rows written by older code and is read as FINALIZED. No row is rewritten.
ALTER TABLE `payPeriods`
  MODIFY COLUMN `state` enum('draft','collecting','review','approved','processing','paid','closed','amended','voided') NOT NULL DEFAULT 'draft',
  ADD COLUMN `payScheduleId` int NULL,
  ADD COLUMN `periodStartDate` date NULL,
  ADD COLUMN `periodEndDate` date NULL,
  ADD COLUMN `paymentDate` date NULL,
  ADD COLUMN `cutoffDate` date NULL,
  ADD COLUMN `createdByUserId` int NULL,
  ADD COLUMN `submittedByUserId` int NULL,
  ADD COLUMN `submittedAt` timestamp NULL,
  ADD COLUMN `approvedByUserId` int NULL,
  ADD COLUMN `approvedAt` timestamp NULL,
  ADD COLUMN `finalizedByUserId` int NULL,
  ADD COLUMN `finalizedAt` timestamp NULL,
  ADD COLUMN `reopenedByUserId` int NULL,
  ADD COLUMN `reopenedAt` timestamp NULL,
  ADD COLUMN `reopenReason` varchar(400) NULL,
  ADD COLUMN `voidedByUserId` int NULL,
  ADD COLUMN `voidedAt` timestamp NULL,
  ADD COLUMN `voidReason` varchar(400) NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `payPeriods_schedule_start_unique` ON `payPeriods` (`payScheduleId`, `periodStartDate`);
--> statement-breakpoint
CREATE INDEX `payPeriods_book_state_idx` ON `payPeriods` (`financialEntityId`, `state`, `periodStartDate`);
