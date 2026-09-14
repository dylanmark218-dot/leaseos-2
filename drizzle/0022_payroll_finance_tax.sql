-- B20.5 — Payroll, Finance & Tax foundation.
--
-- The governing rule for this whole subsystem:
--
--   LeaseOS catalogues and substantiates. It does not determine tax treatment.
--
-- A receipt is not a deduction, a scale reading is not a wage, and an expense
-- is not deductible because someone photographed it. Every tax rule carries a
-- jurisdiction, a tax year, an effective window, a named source authority and a
-- verification status — and an unverified rule yields UNKNOWN rather than a
-- number. This is the financial form of the routing engine's rule that unknown
-- must stay unknown.
--
-- Nothing here hard-codes a rate, a threshold, a CCA class or a filing
-- requirement. Those arrive as data, from a source, with a date.

/* ---------------- Financial identity ---------------- */

-- One human can be an employee of a corporation AND a sole proprietor running
-- their own shop. Those books must never merge, so the entity is the root of
-- every financial record rather than a column on a person.
CREATE TABLE `financialEntities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `entityRef` varchar(64) NOT NULL,
  `legalName` varchar(220) NOT NULL,
  `operatingName` varchar(220),
  `taxpayerType` enum('corporation','sole_proprietor','partnership','employee','independent_contractor') NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  `fiscalYearEndMonth` int, `fiscalYearEndDay` int,
  `ownerUserId` int, `ownerOperatorId` int,
  `parentEntityId` int,
  `status` enum('active','dormant','closed') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `financialEntities_id` PRIMARY KEY(`id`),
  CONSTRAINT `financialEntities_entityRef_unique` UNIQUE(`entityRef`)
);
--> statement-breakpoint
CREATE INDEX `financialEntities_owner_idx` ON `financialEntities` (`ownerUserId`);
--> statement-breakpoint

-- Registrations are facts about the entity, not rules. Whether a registration
-- is REQUIRED is a rule-engine question.
CREATE TABLE `taxRegistrations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `financialEntityId` int NOT NULL,
  `registrationType` varchar(80) NOT NULL,
  `jurisdiction` varchar(80) NOT NULL,
  `registered` boolean NOT NULL DEFAULT false,
  `registeredAt` timestamp, `closedAt` timestamp,
  `identifierPresent` boolean NOT NULL DEFAULT false,
  `notes` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `taxRegistrations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

/* ---------------- Tax rules, sourced and dated ---------------- */

CREATE TABLE `taxRuleSources` (
  `id` int AUTO_INCREMENT NOT NULL,
  `sourceKey` varchar(120) NOT NULL,
  `authority` varchar(220) NOT NULL,
  `reference` varchar(500),
  `publishedAt` timestamp,
  `retrievedAt` timestamp,
  `verifiedAt` timestamp, `verifiedByUserId` int,
  `status` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `taxRuleSources_id` PRIMARY KEY(`id`),
  CONSTRAINT `taxRuleSources_sourceKey_unique` UNIQUE(`sourceKey`)
);
--> statement-breakpoint

CREATE TABLE `taxRules` (
  `id` int AUTO_INCREMENT NOT NULL,
  `ruleKey` varchar(120) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `jurisdiction` varchar(80) NOT NULL,
  `taxYear` int,
  `entityType` varchar(60),
  `ruleType` varchar(80) NOT NULL,
  `parametersJson` text,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveUntil` timestamp,
  `sourceId` int,
  -- Default is unverified on purpose. A rule has to be verified deliberately.
  `status` enum('unverified','verified','expired','superseded') NOT NULL DEFAULT 'unverified',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `taxRules_id` PRIMARY KEY(`id`),
  CONSTRAINT `taxRules_key_version_unique` UNIQUE(`ruleKey`, `version`)
);
--> statement-breakpoint
CREATE INDEX `taxRules_lookup_idx` ON `taxRules` (`jurisdiction`, `ruleType`, `taxYear`);
--> statement-breakpoint

/* ---------------- Expenses ---------------- */

CREATE TABLE `expenseCategories` (
  `id` int AUTO_INCREMENT NOT NULL,
  `categoryKey` varchar(120) NOT NULL,
  `groupKey` varchar(80) NOT NULL,
  `label` varchar(220) NOT NULL,
  `capitalReviewThreshold` double,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `expenseCategories_id` PRIMARY KEY(`id`),
  CONSTRAINT `expenseCategories_categoryKey_unique` UNIQUE(`categoryKey`)
);
--> statement-breakpoint

CREATE TABLE `expenseRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `expenseRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `vendorName` varchar(220),
  `transactionDate` timestamp NOT NULL,
  `currency` varchar(8) NOT NULL DEFAULT 'CAD',
  `subtotal` double, `salesTaxAmount` double, `total` double NOT NULL,
  `categoryId` int,
  `categorySource` enum('human','ai_proposed','ai_confirmed','merchant_memory') NOT NULL DEFAULT 'human',
  `categoryConfidence` double,
  -- Tax treatment is never derived from having a receipt.
  `taxTreatment` enum(
    'unknown_review_required','potentially_deductible','capital_asset',
    'inventory','employee_reimbursement','personal','mixed_use',
    'non_deductible','taxable_benefit_review'
  ) NOT NULL DEFAULT 'unknown_review_required',
  `treatmentDeterminedByUserId` int, `treatmentDeterminedAt` timestamp,
  `treatmentRuleId` int,
  `businessUsePercent` double NOT NULL DEFAULT 100,
  `paidByUserId` int, `paidPersonally` boolean NOT NULL DEFAULT false,
  `reimbursementRequired` boolean NOT NULL DEFAULT false,
  `jobId` int, `unitId` int, `operatorId` int,
  `evidenceRecordId` int,
  `status` enum('draft','submitted','review','approved','rejected','posted') NOT NULL DEFAULT 'draft',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `expenseRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `expenseRecords_expenseRef_unique` UNIQUE(`expenseRef`)
);
--> statement-breakpoint
CREATE INDEX `expenseRecords_entity_idx` ON `expenseRecords` (`financialEntityId`, `transactionDate`);
--> statement-breakpoint
CREATE INDEX `expenseRecords_treatment_idx` ON `expenseRecords` (`taxTreatment`);
--> statement-breakpoint

-- The personal portion is stored, never deleted to make an expense look wholly
-- business. Both halves survive.
CREATE TABLE `expenseAllocations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `expenseRecordId` int NOT NULL,
  `allocationType` enum('business','personal','job','unit','entity') NOT NULL,
  `jobId` int, `unitId` int, `financialEntityId` int,
  `percent` double NOT NULL, `amount` double NOT NULL,
  `basis` varchar(220),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `expenseAllocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

/* ---------------- Payroll ---------------- */

CREATE TABLE `payGroups` (
  `id` int AUTO_INCREMENT NOT NULL,
  `groupKey` varchar(80) NOT NULL,
  `label` varchar(180) NOT NULL,
  `financialEntityId` int,
  `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payGroups_id` PRIMARY KEY(`id`),
  CONSTRAINT `payGroups_groupKey_unique` UNIQUE(`groupKey`)
);
--> statement-breakpoint

-- Wage data lives here, not on the operational operator record. Dispatch needs
-- to know a driver is available; it does not need to know what they earn.
CREATE TABLE `employeePayrollProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `operatorId` int, `userId` int,
  `employeeNumber` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `employmentType` enum('full_time','part_time','casual','seasonal') NOT NULL,
  `payrollStatus` enum('active','leave','terminated','suspended') NOT NULL DEFAULT 'active',
  `payGroupId` int,
  `defaultPayMethod` enum('hourly','salary','mileage','load','tonne','percentage','piecework','mixed') NOT NULL,
  `effectiveFrom` timestamp NOT NULL,
  `terminatedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `employeePayrollProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `employeePayrollProfiles_employeeNumber_unique` UNIQUE(`employeeNumber`)
);
--> statement-breakpoint

-- Rates are versioned and never overwritten. A March rerun uses the March rate.
CREATE TABLE `payRates` (
  `id` int AUTO_INCREMENT NOT NULL,
  `rateKey` varchar(120) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `employeePayrollProfileId` int, `payGroupId` int,
  `earningType` varchar(80) NOT NULL,
  `calculation` enum('hourly','quantity_times_rate','percentage','flat','formula') NOT NULL,
  `rate` double NOT NULL,
  `unit` enum('hour','km','load','tonne','m3','percent','each') NOT NULL,
  -- For tonne/volume pay: the weakest measurement source permitted to create a
  -- wage. An estimate must not quietly become money.
  `minimumMeasurementAuthority` varchar(60),
  `effectiveFrom` timestamp NOT NULL, `effectiveUntil` timestamp,
  `approvedByUserId` int NOT NULL, `approvedAt` timestamp NOT NULL,
  `supersedesRateId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payRates_id` PRIMARY KEY(`id`),
  CONSTRAINT `payRates_key_version_unique` UNIQUE(`rateKey`, `version`)
);
--> statement-breakpoint

CREATE TABLE `payPeriods` (
  `id` int AUTO_INCREMENT NOT NULL,
  `periodRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `startsOn` timestamp NOT NULL, `endsOn` timestamp NOT NULL,
  `state` enum('draft','collecting','review','approved','processing','paid','closed','amended') NOT NULL DEFAULT 'draft',
  `lockedAt` timestamp, `lockedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payPeriods_id` PRIMARY KEY(`id`),
  CONSTRAINT `payPeriods_periodRef_unique` UNIQUE(`periodRef`)
);
--> statement-breakpoint

-- Payroll activity, deliberately separate from HOS duty status. Changing a
-- payroll activity must never rewrite a duty record.
CREATE TABLE `payrollTimeEntries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `payPeriodId` int,
  `activity` enum('driving','on_location','loading','unloading','waiting','standby','shop','training','safety_meeting','travel','break','off_duty') NOT NULL,
  `startedAt` timestamp NOT NULL, `endedAt` timestamp,
  `minutes` int,
  `source` enum('time_clock','employee_submitted','gps_proposed','dispatch_schedule','field_ticket','manual_hr') NOT NULL,
  `confirmedByEmployee` boolean NOT NULL DEFAULT false,
  `jobId` int, `tripId` int, `unitId` int,
  `supersededByEntryId` int,
  `status` enum('open','submitted','verified','disputed','approved','void') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollTimeEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `payrollTimeEntries_employee_idx` ON `payrollTimeEntries` (`employeePayrollProfileId`, `startedAt`);
--> statement-breakpoint

-- Several clocks, none of them silently authoritative.
CREATE TABLE `payrollTimeReconciliations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `payPeriodId` int, `forDate` timestamp NOT NULL,
  `employeeSubmittedMinutes` int,
  `hosOnDutyMinutes` int,
  `leaseosActivityMinutes` int,
  `varianceMinutes` int,
  `outcome` enum('match','within_tolerance','review','unresolved') NOT NULL DEFAULT 'review',
  `resolvedByUserId` int, `resolvedAt` timestamp, `resolutionNote` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollTimeReconciliations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

-- The core unit. Every dollar points at what produced it.
CREATE TABLE `payrollEarningEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `earningRef` varchar(64) NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `payPeriodId` int NOT NULL,
  `earningType` varchar(80) NOT NULL,
  `source` enum('approved_timesheet','trip','load','field_ticket','safety_meeting','work_order','manual_hr_adjustment') NOT NULL,
  `sourceRecordRef` varchar(120),
  `quantity` double NOT NULL,
  `unit` enum('hour','km','load','tonne','m3','percent','each') NOT NULL,
  `payRateId` int, `rateKeyVersion` varchar(140),
  `rateApplied` double,
  `calculatedAmount` double,
  -- Set when the underlying measurement is too weak for the rate's policy.
  `measurementAuthority` varchar(60),
  `blockedReason` varchar(300),
  `status` enum('pending','verified','approved','held','paid','void') NOT NULL DEFAULT 'pending',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollEarningEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `payrollEarningEvents_earningRef_unique` UNIQUE(`earningRef`)
);
--> statement-breakpoint
CREATE INDEX `payrollEarningEvents_period_idx` ON `payrollEarningEvents` (`payPeriodId`, `status`);
--> statement-breakpoint

CREATE TABLE `payrollEarningEvidence` (
  `id` int AUTO_INCREMENT NOT NULL,
  `payrollEarningEventId` int NOT NULL,
  `evidenceRecordId` int, `evidenceRef` varchar(120),
  `relation` varchar(60),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollEarningEvidence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

CREATE TABLE `payRuns` (
  `id` int AUTO_INCREMENT NOT NULL,
  `payRunRef` varchar(64) NOT NULL,
  `payPeriodId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `state` enum('draft','collecting','review','approved','processing','paid','closed','amended') NOT NULL DEFAULT 'draft',
  `approvedByUserId` int, `approvedAt` timestamp,
  `lockedAt` timestamp,
  `paidAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payRuns_id` PRIMARY KEY(`id`),
  CONSTRAINT `payRuns_payRunRef_unique` UNIQUE(`payRunRef`)
);
--> statement-breakpoint

CREATE TABLE `payRunLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `payRunId` int NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `lineType` enum('earning','deduction','reimbursement','employer_cost') NOT NULL,
  `earningType` varchar(80),
  `payrollEarningEventId` int,
  `quantity` double, `rateApplied` double, `amount` double NOT NULL,
  -- Statutory deductions are not computed from hard-coded rates. A line with
  -- no verified rule stays unresolved rather than guessing a number.
  `taxRuleId` int,
  `ruleStatus` enum('verified','unverified','not_applicable') NOT NULL DEFAULT 'unverified',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payRunLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `payRunLines_run_idx` ON `payRunLines` (`payRunId`);
--> statement-breakpoint

-- Paid payroll is never edited in place. A correction is a new signed record.
CREATE TABLE `payrollAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `adjustmentRef` varchar(64) NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `originalPayRunId` int, `appliedPayRunId` int,
  `reason` text NOT NULL,
  `amount` double NOT NULL,
  `requestedByUserId` int NOT NULL, `requestedAt` timestamp NOT NULL,
  `approvedByUserId` int, `approvedAt` timestamp,
  `status` enum('requested','approved','declined','applied') NOT NULL DEFAULT 'requested',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `payrollAdjustments_adjustmentRef_unique` UNIQUE(`adjustmentRef`)
);
--> statement-breakpoint

-- The employee's own words about their time survive the outcome.
CREATE TABLE `payrollDisputes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `disputeRef` varchar(64) NOT NULL,
  `employeePayrollProfileId` int NOT NULL,
  `payPeriodId` int,
  `payrollTimeEntryId` int, `payrollEarningEventId` int,
  `recordedValue` varchar(120), `claimedValue` varchar(120),
  `employeeStatement` text NOT NULL,
  `status` enum('open','information_requested','approved','declined','withdrawn') NOT NULL DEFAULT 'open',
  `resolvedByUserId` int, `resolvedAt` timestamp, `resolutionNote` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `payrollDisputes_id` PRIMARY KEY(`id`),
  CONSTRAINT `payrollDisputes_disputeRef_unique` UNIQUE(`disputeRef`)
);
--> statement-breakpoint

/* ---------------- Contractors are not employees ---------------- */

-- Deliberately a separate ledger. An owner-operator does not go through
-- employee payroll because they drove a truck.
CREATE TABLE `contractorSettlements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `settlementRef` varchar(64) NOT NULL,
  `contractorEntityId` int NOT NULL,
  `payingEntityId` int NOT NULL,
  `periodStart` timestamp NOT NULL, `periodEnd` timestamp NOT NULL,
  `grossAmount` double NOT NULL,
  `deductionTotal` double NOT NULL DEFAULT 0,
  `netAmount` double NOT NULL,
  `informationReturnAssessment` enum('not_assessed','needs_accountant_review','rule_unverified','assessed') NOT NULL DEFAULT 'not_assessed',
  `informationReturnNote` varchar(300),
  `state` enum('draft','review','approved','paid','closed') NOT NULL DEFAULT 'draft',
  `approvedByUserId` int, `approvedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `contractorSettlements_id` PRIMARY KEY(`id`),
  CONSTRAINT `contractorSettlements_settlementRef_unique` UNIQUE(`settlementRef`)
);
--> statement-breakpoint

CREATE TABLE `contractorSettlementLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contractorSettlementId` int NOT NULL,
  `lineType` enum('freight','fuel_advance','insurance','equipment_rental','deduction','reimbursement','other') NOT NULL,
  `description` varchar(300) NOT NULL,
  `quantity` double, `rateApplied` double, `amount` double NOT NULL,
  `sourceRecordRef` varchar(120), `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `contractorSettlementLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint

/* ---------------- Private personal tax organizer ---------------- */

-- An employee's personal tax documents are theirs. The employer does not see
-- them unless the employee explicitly shares. Stored separately from every
-- company-scoped table for that reason.
CREATE TABLE `personalTaxDocuments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `ownerUserId` int NOT NULL,
  `documentKind` varchar(80) NOT NULL,
  `taxYear` int,
  `evidenceRecordId` int,
  `sharedWithEntityId` int,
  `sharedAt` timestamp, `sharedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `personalTaxDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `personalTaxDocuments_owner_idx` ON `personalTaxDocuments` (`ownerUserId`);
