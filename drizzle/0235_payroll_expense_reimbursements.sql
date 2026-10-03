-- 0235 — Payroll P4: employee expenses and payroll reimbursements, over the existing expense domain.
-- docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §27.
--
-- Slot: allocated immediately before this file was written. `main` = 9ec123a (Safety Program Builder #99 took 0228);
-- payroll P3, carried by this branch, moved 0228 → 0234; the integration hub holds 0229–0232 and three open branches
-- hold 0233. The scan over origin/main and all 135 remote refs found nothing at or above 0234 except P3's own move.
-- Claim recorded in docs/architecture/MIGRATION_COLLISION_REGISTER.md.
--
-- An expense, a reimbursement and a payment stay three things. `expenseRecords.status` keeps the accounting lifecycle;
-- `reimbursementState` is payroll's; nothing here marks anything paid. No second expense table, no second wallet,
-- no floating point (the only new amount is integer cents), no foreign keys (repository convention).

-- 1. The claim, on the expense it is about.
ALTER TABLE `expenseRecords`
  ADD COLUMN `employeePayrollProfileId` int NULL,
  ADD COLUMN `reimbursementState` enum('not_applicable','pending_approval','approved','scheduled','reimbursed','rejected','withdrawn') NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN `reimbursementCents` int NULL,
  ADD COLUMN `claimNotes` varchar(1000) NULL,
  ADD COLUMN `createdByUserId` int NULL,
  ADD COLUMN `clientCaptureRef` varchar(80) NULL,
  ADD COLUMN `capturedAt` timestamp NULL,
  ADD COLUMN `deviceRef` varchar(120) NULL,
  ADD COLUMN `submittedByUserId` int NULL,
  ADD COLUMN `submittedAt` timestamp NULL,
  ADD COLUMN `evidenceFingerprint` varchar(64) NULL,
  ADD COLUMN `evidenceContentHash` varchar(64) NULL,
  ADD COLUMN `reimbursementApprovedByUserId` int NULL,
  ADD COLUMN `reimbursementApprovedAt` timestamp NULL,
  ADD COLUMN `reimbursementRejectedByUserId` int NULL,
  ADD COLUMN `reimbursementRejectedAt` timestamp NULL,
  ADD COLUMN `reimbursementRejectedReason` varchar(400) NULL,
  ADD COLUMN `reimbursementReturnedByUserId` int NULL,
  ADD COLUMN `reimbursementReturnedAt` timestamp NULL,
  ADD COLUMN `reimbursementReturnReason` varchar(400) NULL,
  ADD COLUMN `withdrawnByUserId` int NULL,
  ADD COLUMN `withdrawnAt` timestamp NULL,
  ADD COLUMN `withdrawReason` varchar(400) NULL,
  ADD COLUMN `reimbursementPayRunId` int NULL,
  ADD COLUMN `reimbursementLineId` int NULL,
  ADD COLUMN `supersedesExpenseId` int NULL;
--> statement-breakpoint
-- One receipt, one live claim: a PERSISTENT generated key (the 0170/0226/0234 pattern) that is the evidence id while the
-- claim is live and NULL otherwise, so a rejected or withdrawn claim releases its receipt for a corrected one. Accounting
-- rows that are not claims never enter it, so one receipt may still support several allocated accounting rows.
ALTER TABLE `expenseRecords`
  ADD COLUMN `liveClaimEvidenceId` int
    AS (CASE WHEN `reimbursementState` IN ('pending_approval','approved','scheduled','reimbursed') THEN `evidenceRecordId` END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `expenseRecords_liveClaimEvidence_unique` ON `expenseRecords` (`liveClaimEvidenceId`);
--> statement-breakpoint
-- One capture, one claim, however often a device replays it.
CREATE UNIQUE INDEX `expenseRecords_claim_capture_unique` ON `expenseRecords` (`employeePayrollProfileId`, `clientCaptureRef`);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenseRecords_reimbursementLine_unique` ON `expenseRecords` (`reimbursementLineId`);
--> statement-breakpoint
CREATE INDEX `expenseRecords_book_reimbursement_idx` ON `expenseRecords` (`financialEntityId`, `reimbursementState`);
--> statement-breakpoint
CREATE INDEX `expenseRecords_claimant_idx` ON `expenseRecords` (`employeePayrollProfileId`, `reimbursementState`);
--> statement-breakpoint

-- 2. A reimbursement line names its expense; the unique index is the database's refusal to pay one expense twice.
ALTER TABLE `payRunLines`
  ADD COLUMN `expenseRecordId` int NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `payRunLines_expense_unique` ON `payRunLines` (`expenseRecordId`);
--> statement-breakpoint

-- 3. Payroll exceptions gain the expense review signals (0234's values are kept, in order).
ALTER TABLE `payrollExceptions`
  MODIFY COLUMN `kind` enum('missing_approval','overlapping_entries','duplicate_entry','no_active_agreement','missing_earning_code','earning_rule_mismatch','outside_employment','long_shift','job_reference_missing','source_changed_after_preparation','clock_variance','cross_tenant_reference','self_approval_blocked','no_valid_approver','no_pay_schedule','no_matching_pay_period','locked_pay_period','duplicate_expense','receipt_required','reimbursement_currency_mismatch','evidence_changed_after_submission') NOT NULL;
