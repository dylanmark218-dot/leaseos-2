-- 0226 — Payroll P1: compensation agreements, effective-dated versions, earning rules, and the earning-code catalogue.
-- Design: docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md §12 (data model), §22 (owner decisions D3, D4, D9),
-- and the P1 checkpoint section. Owner decision D1 authorizes these tables as the payroll exception to the
-- SPINE moratorium; nothing here is a second ledger, tax engine or approval engine.
--
-- Numbered 0226: the first number free on `main` (head 0222) AND on every open remote branch at the scan of
-- 2026-10-02 immediately before this commit. Claimed elsewhere: 0220 (`claude/eld-compliance-intelligence-ramlrd`,
-- `claude/integration-hub-subsystem-6nzrkw`), 0221–0223 (`claude/integration-hub-subsystem-6nzrkw`), 0224
-- (`claude/eld-compliance-intelligence-ramlrd`, `fix/main-ci-stabilization`), 0225 (`fix/main-ci-stabilization`).
-- Drafted as 0224 and moved before any environment applied it, when the pre-commit rescan found 0224 and 0225
-- taken. docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- Conventions (as on the synchronized main): int AUTO_INCREMENT ids; a unique business ref per row; the financial
-- entity (book) is the money boundary (0146) — no tenantId, no orgRef on money rows; money in integer minor units
-- (`…Cents`), per-unit rates in thousandths (`…Millis`), percentages in thousandths of a percent (`…PercentMillis`,
-- so 12.5 % = 12500); currency varchar(3); `date` for calendar effective windows; `json` for configuration; no
-- foreign keys (links are plain columns, as everywhere in this schema); explicit indexes.
--
-- D3 — the agreement is authoritative for NEW compensation configuration. `payRates` (0022) is untouched: it
-- remains the legacy historical/read path and nothing here converts, deletes or supersedes a legacy rate.

/* ---------------- Earning-code catalogue ---------------- */

-- `financialEntityId` NULL means "shared seed, available to every book" — the catalogue pattern of
-- `dispatchRoleTypes` (0170), where NULL is the opposite of its meaning on owned rows. A book that wants a
-- different REG writes its OWN row with the same code: the generated `codeKey` (book or '*', then the code)
-- makes a book's override unique to that book and leaves the shared seed untouched for everyone else.
-- Tax treatment is METADATA ONLY (D7, P9): nothing reads it to compute a number.
CREATE TABLE `earningCodes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `codeRef` varchar(64) NOT NULL,
  `financialEntityId` int NULL,
  `code` varchar(40) NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` varchar(500) NULL,
  `calculationType` enum('hourly','quantity_times_rate','percentage','flat','per_period_salary','formula') NOT NULL,
  `rateSource` enum('agreement','pay_group','manual','none') NOT NULL DEFAULT 'agreement',
  `kind` enum('earning','reimbursement','deduction','employer_cost','allowance') NOT NULL DEFAULT 'earning',
  `taxTreatmentMetaJson` json NULL,
  `requiresJob` boolean NOT NULL DEFAULT false,
  `requiresUnit` boolean NOT NULL DEFAULT false,
  `requiresApproval` boolean NOT NULL DEFAULT true,
  `countsTowardOvertime` boolean NOT NULL DEFAULT false,
  `activeFrom` date NOT NULL,
  `activeUntil` date NULL,
  `retiredByUserId` int NULL,
  `retiredAt` timestamp NULL,
  -- NULL = seeded by this migration. A person's row names the person.
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `earningCodes_id` PRIMARY KEY(`id`),
  CONSTRAINT `earningCodes_codeRef_unique` UNIQUE(`codeRef`)
);
--> statement-breakpoint
-- Persistent generated collision key (0170 pattern): a nullable composite unique would not refuse a second
-- shared row for the same code, because MariaDB allows multiple NULLs in a unique index.
ALTER TABLE `earningCodes`
  ADD COLUMN `codeKey` varchar(80)
    AS (CONCAT(COALESCE(`financialEntityId`, '*'), ':', `code`)) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `earningCodes_codeKey_unique` ON `earningCodes` (`codeKey`);
--> statement-breakpoint
CREATE INDEX `earningCodes_book_idx` ON `earningCodes` (`financialEntityId`, `kind`, `activeUntil`);
--> statement-breakpoint
-- Shared seed. Examples a company may use, override per book, or ignore — never an assumption about any
-- company's payroll. REG counts toward overtime; the premium codes (OT, DOUBLE_TIME) do not count toward
-- themselves. Reimbursements, allowances and deductions are typed so a later slice can route them.
INSERT INTO `earningCodes` (`codeRef`, `financialEntityId`, `code`, `name`, `description`, `calculationType`, `rateSource`, `kind`, `requiresJob`, `requiresUnit`, `requiresApproval`, `countsTowardOvertime`, `activeFrom`) VALUES
  ('EC-SEED-REG',          NULL, 'REG',          'Regular hours',            'Hourly work at the regular rate',                        'hourly',              'agreement', 'earning',       false, false, true, true,  '2026-01-01'),
  ('EC-SEED-OT',           NULL, 'OT',           'Overtime',                 'Hours above the agreement''s overtime threshold',         'hourly',              'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-DOUBLE_TIME',  NULL, 'DOUBLE_TIME',  'Double time',              'Hours paid at twice the regular rate',                   'hourly',              'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-DAY_RATE',     NULL, 'DAY_RATE',     'Day rate',                 'A flat amount per day worked',                           'quantity_times_rate', 'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-SHIFT',        NULL, 'SHIFT',        'Shift rate',               'A flat amount per shift worked',                         'quantity_times_rate', 'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-LOAD_PAY',     NULL, 'LOAD_PAY',     'Load pay',                 'Per load hauled',                                        'quantity_times_rate', 'agreement', 'earning',       true,  false, true, false, '2026-01-01'),
  ('EC-SEED-TRIP_PAY',     NULL, 'TRIP_PAY',     'Trip pay',                 'Per trip completed',                                     'quantity_times_rate', 'agreement', 'earning',       true,  false, true, false, '2026-01-01'),
  ('EC-SEED-MILEAGE',      NULL, 'MILEAGE',      'Mileage',                  'Per kilometre driven',                                   'quantity_times_rate', 'agreement', 'earning',       false, true,  true, false, '2026-01-01'),
  ('EC-SEED-STANDBY',      NULL, 'STANDBY',      'Standby',                  'Hours held available without work',                      'hourly',              'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-TRAVEL',       NULL, 'TRAVEL',       'Travel',                   'Travel time to and from a site',                         'hourly',              'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-TRAINING',     NULL, 'TRAINING',     'Training',                 'Time in training or safety meetings',                    'hourly',              'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-CALL_OUT',     NULL, 'CALL_OUT',     'Call-out',                 'A flat amount for being called out',                     'flat',                'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-SHOP',         NULL, 'SHOP',         'Shop hours',               'Mechanic or shop work at the shop rate',                 'hourly',              'agreement', 'earning',       false, false, true, true,  '2026-01-01'),
  ('EC-SEED-BONUS',        NULL, 'BONUS',        'Bonus',                    'A discretionary or contractual bonus',                   'flat',                'manual',    'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-COMMISSION',   NULL, 'COMMISSION',   'Commission',               'A percentage of eligible revenue',                       'percentage',          'agreement', 'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-PER_DIEM',     NULL, 'PER_DIEM',     'Per diem',                 'A daily allowance while away',                           'quantity_times_rate', 'agreement', 'allowance',     false, false, true, false, '2026-01-01'),
  ('EC-SEED-MEAL',         NULL, 'MEAL',         'Meal allowance',           'A meal allowance',                                       'quantity_times_rate', 'agreement', 'allowance',     false, false, true, false, '2026-01-01'),
  ('EC-SEED-SUBSISTENCE',  NULL, 'SUBSISTENCE',  'Subsistence',              'A subsistence allowance',                                'quantity_times_rate', 'agreement', 'allowance',     false, false, true, false, '2026-01-01'),
  ('EC-SEED-EXPENSE_REIMB',NULL, 'EXPENSE_REIMB','Expense reimbursement',    'Repayment of an approved expense',                       'flat',                'none',      'reimbursement', false, false, true, false, '2026-01-01'),
  ('EC-SEED-ADVANCE',      NULL, 'ADVANCE',      'Advance',                  'An advance against future pay',                          'flat',                'manual',    'deduction',     false, false, true, false, '2026-01-01'),
  ('EC-SEED-DEDUCTION',    NULL, 'DEDUCTION',    'Deduction',                'A non-statutory deduction',                              'flat',                'manual',    'deduction',     false, false, true, false, '2026-01-01'),
  ('EC-SEED-RETRO',        NULL, 'RETRO',        'Retroactive pay',          'Pay owed for a past period',                             'flat',                'manual',    'earning',       false, false, true, false, '2026-01-01'),
  ('EC-SEED-CORRECTION',   NULL, 'CORRECTION',   'Correction',               'A correction to a finalized amount',                     'flat',                'manual',    'earning',       false, false, true, false, '2026-01-01');
--> statement-breakpoint

/* ---------------- Compensation agreements ---------------- */

-- One agreement binds one payroll profile to one book. The profile's own book must be the same one;
-- the service refuses a mismatch as "not found". A contractor or owner-operator never gets one: the
-- classification snapshot below is the normalized `organizationWorkers.workerType` (D9), and OWNER_DRIVER
-- is refused by the same hard boundary `assertPayrollEligibility` already draws.
CREATE TABLE `compensationAgreements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `agreementRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `title` varchar(160) NOT NULL,
  `status` enum('draft','active','ended') NOT NULL DEFAULT 'draft',
  `startsOn` date NOT NULL,
  `endsOn` date NULL,
  -- D9: the classification in force when the agreement was written, normalized to the organizationWorkers
  -- vocabulary, and where it came from. Snapshotted so a later reclassification does not rewrite history.
  `workerClassification` enum('OWNER_DRIVER','EMPLOYEE_DRIVER','CO_DRIVER','SWAMPER','LABORER','EQUIPMENT_OPERATOR','HELPER','SHOP_HAND','MECHANIC','MAINTENANCE_SUPERVISOR','BOOKKEEPER','DISPATCHER','SAFETY_COMPLIANCE','OFFICE_ADMIN') NOT NULL,
  `classificationSource` enum('organization_worker','legacy_mapped') NOT NULL,
  `createdByUserId` int NOT NULL,
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `compensationAgreements_id` PRIMARY KEY(`id`),
  CONSTRAINT `compensationAgreements_agreementRef_unique` UNIQUE(`agreementRef`)
);
--> statement-breakpoint
CREATE INDEX `compensationAgreements_book_idx` ON `compensationAgreements` (`financialEntityId`, `status`);
--> statement-breakpoint
CREATE INDEX `compensationAgreements_profile_idx` ON `compensationAgreements` (`employeePayrollProfileId`, `status`);
--> statement-breakpoint

-- A version is the unit of approval and of history. Its financial rules are frozen at proposal
-- (`rulesJson` is the canonical rule set and `rulesHash` its sha256); approval never edits them, a raise
-- is a new version, and an approved version is only ever closed (`effectiveUntil`, `superseded`) by the
-- approval of its successor. Window contract: [effectiveFrom, effectiveUntil) — inclusive start, exclusive
-- end, by calendar date; NULL end = open. Approved windows of one agreement never overlap.
CREATE TABLE `compensationAgreementVersions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `versionRef` varchar(64) NOT NULL,
  `agreementId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `version` int NOT NULL,
  `effectiveFrom` date NOT NULL,
  `effectiveUntil` date NULL,
  `basis` enum('hourly','salary','day_rate','shift_rate','load_rate','trip_rate','mileage_rate','percentage','job_rate','piece_rate','mixed') NOT NULL,
  `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `rulesHash` char(64) NOT NULL,
  `rulesJson` json NOT NULL,
  `status` enum('proposed','approved','rejected','superseded') NOT NULL DEFAULT 'proposed',
  `proposedByUserId` int NOT NULL,
  `proposedAt` timestamp NOT NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  `rejectedByUserId` int NULL,
  `rejectedAt` timestamp NULL,
  `rejectionReason` varchar(400) NULL,
  -- The commercial approval ledger row (0136) that carried this decision — D4: no second approval engine.
  `approvalRef` varchar(40) NULL,
  `supersedesVersionId` int NULL,
  `supersededByVersionId` int NULL,
  `notes` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `compensationAgreementVersions_id` PRIMARY KEY(`id`),
  CONSTRAINT `compensationAgreementVersions_versionRef_unique` UNIQUE(`versionRef`),
  CONSTRAINT `compensationAgreementVersions_agreement_version_unique` UNIQUE(`agreementId`, `version`)
);
--> statement-breakpoint
CREATE INDEX `compensationAgreementVersions_window_idx` ON `compensationAgreementVersions` (`agreementId`, `status`, `effectiveFrom`);
--> statement-breakpoint
CREATE INDEX `compensationAgreementVersions_book_idx` ON `compensationAgreementVersions` (`financialEntityId`, `status`);
--> statement-breakpoint

-- One row per earning code inside a version. `earningCode` is the code's text at proposal, kept beside the id
-- so a code retired later still reads on the version that used it. Rates are thousandths; percentages are
-- thousandths of a percent. `eligibleRevenueBasisJson` and `overtimeRuleJson` are configuration only in P1:
-- nothing consumes them until the earning-generation slice.
CREATE TABLE `compensationEarningRules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `ruleRef` varchar(64) NOT NULL,
  `versionId` int NOT NULL,
  `earningCodeId` int NOT NULL,
  `earningCode` varchar(40) NOT NULL,
  `calculation` enum('hourly','quantity_times_rate','percentage','flat','per_period_salary','formula') NOT NULL,
  `unit` enum('hour','day','shift','km','load','trip','tonne','m3','percent','each','period') NOT NULL,
  `rateMillis` int NULL,
  `percentMillis` int NULL,
  `overtimeRuleJson` json NULL,
  `eligibleRevenueBasisJson` json NULL,
  `minimumMeasurementAuthority` varchar(60) NULL,
  `requiresJob` boolean NOT NULL DEFAULT false,
  `requiresUnit` boolean NOT NULL DEFAULT false,
  `sortOrder` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `compensationEarningRules_id` PRIMARY KEY(`id`),
  CONSTRAINT `compensationEarningRules_ruleRef_unique` UNIQUE(`ruleRef`)
);
--> statement-breakpoint
CREATE INDEX `compensationEarningRules_version_idx` ON `compensationEarningRules` (`versionId`, `sortOrder`);
--> statement-breakpoint

/* ---------------- D9 on the payroll profile ---------------- */

-- The normalized classification, where it came from, and the organizationWorkers row it came from.
-- NULL on existing rows: unclassified until an agreement (or a classification read) establishes it.
ALTER TABLE `employeePayrollProfiles`
  ADD COLUMN `workerClassification` enum('OWNER_DRIVER','EMPLOYEE_DRIVER','CO_DRIVER','SWAMPER','LABORER','EQUIPMENT_OPERATOR','HELPER','SHOP_HAND','MECHANIC','MAINTENANCE_SUPERVISOR','BOOKKEEPER','DISPATCHER','SAFETY_COMPLIANCE','OFFICE_ADMIN') NULL,
  ADD COLUMN `classificationSource` enum('organization_worker','legacy_mapped') NULL,
  ADD COLUMN `organizationWorkerRef` varchar(64) NULL;
--> statement-breakpoint

/* ---------------- D4: approval through the existing ladder ---------------- */

-- One default tier, unbounded: a compensation-agreement version is approved by the controller, with the
-- preparer (proposer) barred. No second person by default (owner may add a book tier). The amount the
-- ledger records is the version's headline rate in cents (informational under an unbounded tier).
INSERT INTO `commercialApprovalPolicies` (`bookOrgRef`, `category`, `maxAmountCents`, `approverRole`, `secondPersonRequired`, `separationOfDuties`, `source`, `effectiveFrom`)
VALUES (NULL, 'compensation_agreement', NULL, 'controller', false, true, 'owner_decision_2026-10-02 (D4 — payroll P1: controller approves; proposer barred)', '2026-10-02');
