-- 0234 — Payroll P3: payroll time, operational candidates, earning approval and payroll exceptions.
-- docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §26 (and §27 for the move).
--
-- Slot: drafted and gated as 0228 (main b36f43a, head 0227, nothing at or above 0228 on any of 131 refs). Before P3
-- merged, main took 0228 for the Safety & Compliance Program Builder (#99), the integration hub renumbered to
-- 0229–0232 and three open branches claimed 0233; on merging main into P4 this file moved to 0234, the first slot
-- above every slot in use in any lineage. No environment had applied it as 0228. The DDL is unchanged.
-- Claim recorded in docs/architecture/MIGRATION_COLLISION_REGISTER.md.
--
-- D11: nothing here makes an operational record into pay. Candidates are never stored; a time entry exists only
-- because a person submitted it, and an earning only because approved time met an approved compensation version.
-- No money column is added except an integer duration; no floating point; no foreign keys (repository convention).

-- 1. A pay group may name the schedule its people are paid on (the P2 deviation, resolved). One schedule per profile,
--    through its one pay group: profile → pay group → schedule → the period containing the work date.
ALTER TABLE `payGroups`
  ADD COLUMN `payScheduleId` int NULL;
--> statement-breakpoint
CREATE INDEX `payGroups_book_schedule_idx` ON `payGroups` (`financialEntityId`, `payScheduleId`);
--> statement-breakpoint

-- 2. Payroll time entries: identity, the work date, the earning code, source provenance, offline capture identity,
--    and who submitted, approved, rejected or withdrew. Existing rows keep NULL in every new column.
--    A rejection is `status = 'void'` with rejection provenance beside it; a withdrawal is `void` with withdrawal
--    provenance. No status value is added.
ALTER TABLE `payrollTimeEntries`
  ADD COLUMN `entryRef` varchar(64) NULL,
  ADD COLUMN `workDate` date NULL,
  ADD COLUMN `earningCode` varchar(40) NULL,
  ADD COLUMN `sourceRecordType` enum('hos_duty','dispatch_booking','trip','load','field_ticket') NULL,
  ADD COLUMN `sourceRecordRef` varchar(120) NULL,
  ADD COLUMN `sourceSegment` varchar(120) NULL,
  ADD COLUMN `candidateKey` varchar(64) NULL,
  ADD COLUMN `sourceVersion` varchar(160) NULL,
  ADD COLUMN `sourceFingerprint` varchar(64) NULL,
  ADD COLUMN `notes` varchar(1000) NULL,
  ADD COLUMN `locationText` varchar(200) NULL,
  ADD COLUMN `clientCaptureRef` varchar(80) NULL,
  ADD COLUMN `capturedAt` timestamp NULL,
  ADD COLUMN `deviceRef` varchar(120) NULL,
  ADD COLUMN `createdByUserId` int NULL,
  ADD COLUMN `submittedByUserId` int NULL,
  ADD COLUMN `submittedAt` timestamp NULL,
  ADD COLUMN `approvedByUserId` int NULL,
  ADD COLUMN `approvedAt` timestamp NULL,
  ADD COLUMN `approvalRoute` enum('crew_supervisor','payroll_admin') NULL,
  ADD COLUMN `approvalCrewRef` varchar(64) NULL,
  ADD COLUMN `rejectedByUserId` int NULL,
  ADD COLUMN `rejectedAt` timestamp NULL,
  ADD COLUMN `rejectionReason` varchar(400) NULL,
  ADD COLUMN `withdrawnByUserId` int NULL,
  ADD COLUMN `withdrawnAt` timestamp NULL,
  ADD COLUMN `withdrawReason` varchar(400) NULL,
  ADD COLUMN `supersedesEntryId` int NULL,
  ADD COLUMN `payrollEarningEventId` int NULL;
--> statement-breakpoint
-- The duplicate defence for operational sources, in the database: one effective (not void, not superseded) entry per
-- source segment, across every profile. A PERSISTENT generated column (the 0170/0226 pattern) because MariaDB has no
-- partial unique index; it is NULL — and so outside the unique index — for void and superseded rows. The keys are
-- varchar, not char: MariaDB refuses a generated expression over CHAR (its value depends on PAD_CHAR_TO_FULL_LENGTH).
ALTER TABLE `payrollTimeEntries`
  ADD COLUMN `effectiveSourceKey` varchar(64)
    AS (CASE WHEN `status` <> 'void' AND `supersededByEntryId` IS NULL THEN `candidateKey` END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `payrollTimeEntries_entryRef_unique` ON `payrollTimeEntries` (`entryRef`);
--> statement-breakpoint
CREATE UNIQUE INDEX `payrollTimeEntries_effectiveSource_unique` ON `payrollTimeEntries` (`effectiveSourceKey`);
--> statement-breakpoint
-- The offline defence: one capture is one entry for one profile, however often the device replays it.
CREATE UNIQUE INDEX `payrollTimeEntries_capture_unique` ON `payrollTimeEntries` (`employeePayrollProfileId`, `clientCaptureRef`);
--> statement-breakpoint
CREATE INDEX `payrollTimeEntries_profile_time_idx` ON `payrollTimeEntries` (`employeePayrollProfileId`, `startedAt`);
--> statement-breakpoint
CREATE INDEX `payrollTimeEntries_period_status_idx` ON `payrollTimeEntries` (`payPeriodId`, `status`);
--> statement-breakpoint

-- 3. Earning events: the P1 compensation it was priced from, the time entry it came from (one earning per entry),
--    the integer duration, and who approved it. `calculatedAmountCents`/`rateAppliedMillis` (B22.3) stay authoritative.
ALTER TABLE `payrollEarningEvents`
  ADD COLUMN `earningCode` varchar(40) NULL,
  ADD COLUMN `compensationAgreementVersionId` int NULL,
  ADD COLUMN `agreementVersionRef` varchar(64) NULL,
  ADD COLUMN `rulesHash` varchar(64) NULL,
  ADD COLUMN `compensationRuleId` int NULL,
  ADD COLUMN `payrollTimeEntryId` int NULL,
  ADD COLUMN `workDate` date NULL,
  ADD COLUMN `workedMinutes` int NULL,
  ADD COLUMN `approvedByUserId` int NULL,
  ADD COLUMN `approvedAt` timestamp NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `payrollEarningEvents_timeEntry_unique` ON `payrollEarningEvents` (`payrollTimeEntryId`);
--> statement-breakpoint

-- 4. Payroll exceptions: review signals with a deterministic condition key, persisted so their resolution is
--    auditable (the payrollTimeReconciliations precedent). They never alter pay by themselves.
CREATE TABLE `payrollExceptions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `exceptionRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `payPeriodId` int NULL,
  `employeePayrollProfileId` int NULL,
  `kind` enum('missing_approval','overlapping_entries','duplicate_entry','no_active_agreement','missing_earning_code','earning_rule_mismatch','outside_employment','long_shift','job_reference_missing','source_changed_after_preparation','clock_variance','cross_tenant_reference','self_approval_blocked','no_valid_approver','no_pay_schedule','no_matching_pay_period','locked_pay_period') NOT NULL,
  `severity` enum('blocking','review') NOT NULL,
  `subjectType` varchar(40) NOT NULL,
  `subjectRef` varchar(120) NOT NULL,
  `conditionKey` varchar(64) NOT NULL,
  `detail` varchar(500) NOT NULL,
  `state` enum('open','resolved','dismissed') NOT NULL DEFAULT 'open',
  `raisedByUserId` int NULL,
  `resolvedByUserId` int NULL,
  `resolvedAt` timestamp NULL,
  `resolutionNote` varchar(1000) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollExceptions_id` PRIMARY KEY(`id`),
  CONSTRAINT `payrollExceptions_exceptionRef_unique` UNIQUE(`exceptionRef`)
);
--> statement-breakpoint
-- One open exception per condition; a resolved one leaves the index, so the condition can be raised again later.
ALTER TABLE `payrollExceptions`
  ADD COLUMN `openConditionKey` varchar(64)
    AS (CASE WHEN `state` = 'open' THEN `conditionKey` END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `payrollExceptions_openCondition_unique` ON `payrollExceptions` (`openConditionKey`);
--> statement-breakpoint
CREATE INDEX `payrollExceptions_book_state_idx` ON `payrollExceptions` (`financialEntityId`, `state`, `kind`);
--> statement-breakpoint
CREATE INDEX `payrollExceptions_subject_idx` ON `payrollExceptions` (`subjectType`, `subjectRef`);
