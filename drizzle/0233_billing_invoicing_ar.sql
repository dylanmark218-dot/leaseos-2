-- 0233 — Billing, Invoicing, Accounts Receivable and Financial Reconciliation (v23.32).
-- Design: LEASEOS_B23_4_BILLING_INVOICING_AR.md.
--
-- Numbered 0233: drafted as 0228 when that was the first number free everywhere; before this commit `main` took 0228
-- (Safety Program Builder, #99, 9ec123a), `claude/payroll-p3-time-candidates` also holds 0228 and
-- `claude/integration-hub-subsystem-6nzrkw` holds 0229–0232. 0233 is the first number free on `main` (head 0228) and on
-- all 133 remote refs at the scan of 2026-10-03. docs/architecture/MIGRATION_COLLISION_REGISTER.md carries the claim.
--
-- Conventions: the book (financialEntityId) is the money boundary; money is integer cents with a currency;
-- quantities are integer thousandths (millis); refs unique; no foreign keys; explicit indexes. Every rule the
-- database can hold is held here as a CHECK or a UNIQUE — the service enforces it first, the table refuses what
-- slips past (a race, a bug, a hand-written UPDATE).
--
-- This migration consumes the commercial source of truth (0217–0219). It creates no customer, contract or rate
-- table: a charge names the job's commercial snapshot, the sheet version and the rate line that priced it.

/* ---------------- Billing workspace: one per job, a modeled state ---------------- */

-- The job's billing state. Moved only through the transition table in server/_core/billingEngine.ts; there is no
-- procedure that writes `state` directly. The readiness evaluation that justified the current state is kept.
CREATE TABLE `billingWorkspaces` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceRef` varchar(40) NOT NULL,
  `jobId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `state` enum('not_ready','awaiting_documents','awaiting_signatures','awaiting_disposal','awaiting_commercial','ready','under_review','approved_for_invoicing','invoiced','partially_paid','paid','disputed','credited') NOT NULL DEFAULT 'not_ready',
  `readinessJson` text NULL,
  `readinessHash` varchar(64) NULL,
  `evaluatedAt` timestamp NULL,
  `holdActive` boolean NOT NULL DEFAULT false,
  `holdReason` varchar(400) NULL,
  `holdByUserId` int NULL,
  `holdAt` timestamp NULL,
  `reviewSubmittedByUserId` int NULL,
  `reviewSubmittedAt` timestamp NULL,
  `reviewDecidedByUserId` int NULL,
  `reviewDecidedAt` timestamp NULL,
  `reviewNote` varchar(600) NULL,
  `rowVersion` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billingWorkspaces_id` PRIMARY KEY(`id`),
  CONSTRAINT `billingWorkspaces_workspaceRef_unique` UNIQUE(`workspaceRef`),
  CONSTRAINT `billingWorkspaces_job_unique` UNIQUE(`jobId`),
  CONSTRAINT `billingWorkspaces_hold_chk` CHECK (`holdActive` = 0 OR (`holdReason` IS NOT NULL AND `holdByUserId` IS NOT NULL)),
  -- separation of duties: the person who submitted the job for review does not approve it
  CONSTRAINT `billingWorkspaces_review_sod_chk` CHECK (`reviewDecidedByUserId` IS NULL OR `reviewSubmittedByUserId` IS NULL OR `reviewDecidedByUserId` <> `reviewSubmittedByUserId`)
);
--> statement-breakpoint
CREATE INDEX `billingWorkspaces_entity_state` ON `billingWorkspaces` (`financialEntityId`, `state`);
--> statement-breakpoint

/* ---------------- Billable charges: the canonical, traceable charge ---------------- */

-- job → evidence (sourceKind/sourceId: the field-ticket line) → customer → contract → sheet version → rate line
-- (definitionRef/definitionVersion) → inputs (inputsJson) → amount. `pricedAmountCents` is what the commercial
-- rate engine priced against the job's SNAPSHOT; `amountCents` is what bills (the priced amount, or an override a
-- second person approved). A charge the engine could not price is `held`, never guessed.
--
-- Partial billing: an invoice consumes a slice of a charge; billedQuantityMillis / billedAmountCents are the running
-- consumption, and the CHECKs make over-consumption (two invoices taking the same charge) impossible at the table.
-- `liveSourceKey` (generated) admits one live charge per evidence line: a second prepare cannot double the charge.
CREATE TABLE `billableCharges` (
  `id` int AUTO_INCREMENT NOT NULL,
  `chargeRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `jobId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  `commercialSnapshotId` int NULL,
  `commercialSnapshotRef` varchar(40) NULL,
  `contractRef` varchar(40) NULL,
  `rateSheetVersionRef` varchar(40) NULL,
  `sourceKind` enum('field_ticket_line','manual') NOT NULL,
  `sourceId` int NULL,
  `sourceRef` varchar(64) NULL,
  `fieldTicketId` int NULL,
  `serviceCode` varchar(60) NULL,
  `lineKind` varchar(40) NULL,
  `description` varchar(300) NOT NULL,
  `quantityMillis` bigint NOT NULL,
  `unit` varchar(20) NOT NULL,
  `measurementSource` varchar(40) NULL,
  `definitionRef` varchar(64) NULL,
  `definitionVersion` int NULL,
  `scopeLevel` varchar(40) NULL,
  `pricingMethod` varchar(40) NULL,
  `rateMillis` int NULL,
  `billableQuantityMillis` bigint NULL,
  `pricedAmountCents` bigint NULL,
  `amountCents` bigint NULL,
  `currency` varchar(3) NOT NULL,
  `pricingOutcome` enum('priced','unknown_rate','conflict','conversion_review','measurement_review','manual') NOT NULL,
  `formula` varchar(400) NULL,
  `inputsJson` text NULL,
  `reasonsJson` text NOT NULL,
  `status` enum('proposed','ready','held','superseded','cancelled') NOT NULL,
  `holdReason` varchar(300) NULL,
  `billedQuantityMillis` bigint NOT NULL DEFAULT 0,
  `billedAmountCents` bigint NOT NULL DEFAULT 0,
  `overrideStatus` enum('none','pending','approved','refused') NOT NULL DEFAULT 'none',
  `overrideAmountCents` bigint NULL,
  `overrideQuantityMillis` bigint NULL,
  `overrideReason` varchar(400) NULL,
  `overrideRequestedByUserId` int NULL,
  `overrideRequestedAt` timestamp NULL,
  `overrideDecidedByUserId` int NULL,
  `overrideDecidedAt` timestamp NULL,
  `supersedesChargeId` int NULL,
  `createdByUserId` int NOT NULL,
  `approvedByUserId` int NULL,
  `approvedAt` timestamp NULL,
  `rowVersion` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `liveSourceKey` varchar(80) AS (CASE WHEN `status` IN ('proposed','ready','held') AND `sourceKind` <> 'manual' THEN CONCAT(`sourceKind`, ':', `sourceId`) ELSE NULL END) PERSISTENT,
  CONSTRAINT `billableCharges_id` PRIMARY KEY(`id`),
  CONSTRAINT `billableCharges_chargeRef_unique` UNIQUE(`chargeRef`),
  CONSTRAINT `billableCharges_live_source_unique` UNIQUE(`liveSourceKey`),
  CONSTRAINT `billableCharges_source_chk` CHECK (`sourceKind` = 'manual' OR `sourceId` IS NOT NULL),
  CONSTRAINT `billableCharges_money_chk` CHECK ((`amountCents` IS NULL OR `amountCents` >= 0) AND (`pricedAmountCents` IS NULL OR `pricedAmountCents` >= 0) AND `quantityMillis` >= 0),
  CONSTRAINT `billableCharges_consumption_chk` CHECK (`billedQuantityMillis` >= 0 AND `billedAmountCents` >= 0
    AND (`billableQuantityMillis` IS NULL OR `billedQuantityMillis` <= `billableQuantityMillis`)
    AND (`amountCents` IS NULL OR `billedAmountCents` <= `amountCents`)
    AND (`billedQuantityMillis` = 0 OR `status` IN ('ready','superseded','cancelled'))),
  CONSTRAINT `billableCharges_ready_chk` CHECK (`status` <> 'ready' OR (`amountCents` IS NOT NULL AND `billableQuantityMillis` IS NOT NULL AND `billableQuantityMillis` > 0)),
  CONSTRAINT `billableCharges_manual_chk` CHECK (`sourceKind` <> 'manual' OR `status` NOT IN ('ready') OR (`approvedByUserId` IS NOT NULL AND `approvedByUserId` <> `createdByUserId`)),
  CONSTRAINT `billableCharges_override_chk` CHECK (`overrideStatus` = 'none' OR (`overrideReason` IS NOT NULL AND `overrideRequestedByUserId` IS NOT NULL)),
  CONSTRAINT `billableCharges_override_sod_chk` CHECK (`overrideDecidedByUserId` IS NULL OR `overrideDecidedByUserId` <> `overrideRequestedByUserId`)
);
--> statement-breakpoint
CREATE INDEX `billableCharges_job_status` ON `billableCharges` (`jobId`, `status`);
--> statement-breakpoint
CREATE INDEX `billableCharges_entity_status` ON `billableCharges` (`financialEntityId`, `status`);
--> statement-breakpoint

/* ---------------- Invoices: per-organization numbering, review, explicit tax ---------------- */

-- Numbering: a billing invoice's number is minted from the ORGANIZATION's INV series (numberSeries.mintNumberInTx,
-- the Document Control ledger: atomic under the series row lock, never max+1, every allocation and every void on
-- the ledger). Two organizations may therefore both issue INV-2026-000001, so uniqueness is per number scope
-- (the organization; 'default' for every invoice numbered before this migration from the shared series).
ALTER TABLE `invoices`
  ADD COLUMN `numberScope` varchar(64) NOT NULL DEFAULT 'default',
  ADD COLUMN `numberAllocationRef` varchar(40) NULL,
  ADD COLUMN `origin` enum('field_ticket','billing_charges') NOT NULL DEFAULT 'field_ticket',
  ADD COLUMN `taxCode` varchar(24) NULL,
  ADD COLUMN `taxRateBps` int NULL,
  ADD COLUMN `taxJurisdiction` varchar(20) NULL,
  ADD COLUMN `paymentTermsDays` int NULL,
  ADD COLUMN `draftedByUserId` int NULL,
  ADD COLUMN `submittedByUserId` int NULL,
  ADD COLUMN `submittedAt` timestamp NULL,
  ADD COLUMN `approvedByUserId` int NULL,
  ADD COLUMN `approvedAt` timestamp NULL,
  ADD COLUMN `issuedByUserId` int NULL,
  ADD COLUMN `overdueNotifiedAt` timestamp NULL,
  ADD COLUMN `rowVersion` int NOT NULL DEFAULT 0,
  MODIFY COLUMN `status` enum('draft','sent','viewed','approved','disputed','partially_paid','paid','void','in_review') NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `invoices` DROP INDEX `invoices_invoiceNumber_unique`;
--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_scope_number_unique` UNIQUE(`numberScope`, `invoiceNumber`);
--> statement-breakpoint
-- A billing-charges invoice adds up, carries an explicit tax code and rate, and is approved by someone other than
-- the person who submitted it. Field-ticket invoices predate these rules and are left as they were.
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_billing_totals_chk` CHECK (`origin` <> 'billing_charges' OR (`totalCents` = `subtotalCents` + `taxCents` AND `subtotalCents` >= 0 AND `taxCents` >= 0 AND `taxCode` IS NOT NULL AND `taxRateBps` IS NOT NULL));
--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_billing_sod_chk` CHECK (`approvedByUserId` IS NULL OR `submittedByUserId` IS NULL OR `approvedByUserId` <> `submittedByUserId`);
--> statement-breakpoint
CREATE INDEX `invoices_number` ON `invoices` (`invoiceNumber`);
--> statement-breakpoint
CREATE INDEX `invoices_entity_status` ON `invoices` (`financialEntityId`, `status`);
--> statement-breakpoint
CREATE INDEX `invoices_job` ON `invoices` (`jobId`);
--> statement-breakpoint

-- Lines: the customer's description stays in `description`; the internal provenance (charge → rate line / sheet
-- version → snapshot → evidence → job) is `provenanceJson`, never printed. A line released by a void keeps its row.
-- `liveTicketLineKey` (generated) admits a field-ticket line on ONE live field-ticket invoice at a time.
ALTER TABLE `invoiceLines`
  ADD COLUMN `billableChargeId` int NULL,
  ADD COLUMN `jobId` int NULL,
  ADD COLUMN `taxCode` varchar(24) NULL,
  ADD COLUMN `taxRateBps` int NULL,
  ADD COLUMN `taxCents` int NULL,
  ADD COLUMN `provenanceJson` text NULL,
  ADD COLUMN `releasedAt` timestamp NULL;
--> statement-breakpoint
UPDATE `invoiceLines` il JOIN `invoices` i ON i.`id` = il.`invoiceId` SET il.`releasedAt` = COALESCE(i.`voidedAt`, i.`updatedAt`) WHERE i.`status` = 'void';
--> statement-breakpoint
ALTER TABLE `invoiceLines`
  ADD COLUMN `liveTicketLineKey` int AS (CASE WHEN `releasedAt` IS NULL AND `billableChargeId` IS NULL THEN `fieldTicketLineId` ELSE NULL END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoiceLines_live_ticket_line_uq` ON `invoiceLines` (`liveTicketLineKey`);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoiceLines_invoice_charge_uq` ON `invoiceLines` (`invoiceId`, `billableChargeId`);
--> statement-breakpoint
CREATE INDEX `invoiceLines_charge` ON `invoiceLines` (`billableChargeId`);
--> statement-breakpoint
ALTER TABLE `invoiceLines` ADD CONSTRAINT `invoiceLines_charge_tax_chk` CHECK (`billableChargeId` IS NULL OR (`taxCode` IS NOT NULL AND `taxRateBps` IS NOT NULL AND `taxCents` IS NOT NULL AND `taxCents` >= 0 AND `amountCents` >= 0 AND `jobId` IS NOT NULL));
--> statement-breakpoint

-- One invoice may bill several jobs; one job may be billed by several invoices.
CREATE TABLE `invoiceJobLinks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `invoiceId` int NOT NULL,
  `jobId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `invoiceJobLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `invoiceJobLinks_unique` UNIQUE(`invoiceId`, `jobId`)
);
--> statement-breakpoint
CREATE INDEX `invoiceJobLinks_job` ON `invoiceJobLinks` (`jobId`);
--> statement-breakpoint

/* ---------------- Payments: idempotent, reversible by record, no card data ---------------- */

-- `card` is a card REFERENCE (an authorization or receipt number in `reference`); no card number is ever stored.
ALTER TABLE `customerPayments`
  ADD COLUMN `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  ADD COLUMN `payerName` varchar(220) NULL,
  ADD COLUMN `source` enum('manual','import','bank_match','portal') NOT NULL DEFAULT 'manual',
  ADD COLUMN `notes` varchar(600) NULL,
  ADD COLUMN `idempotencyKey` varchar(120) NULL,
  ADD COLUMN `reversedAt` timestamp NULL,
  ADD COLUMN `reversedByUserId` int NULL,
  ADD COLUMN `reversalReason` varchar(400) NULL,
  MODIFY COLUMN `method` enum('eft','cheque','card','cash','other','wire','import') NOT NULL;
--> statement-breakpoint
ALTER TABLE `customerPayments` ADD CONSTRAINT `customerPayments_idempotency_unique` UNIQUE(`financialEntityId`, `idempotencyKey`);
--> statement-breakpoint
ALTER TABLE `customerPayments` ADD CONSTRAINT `customerPayments_amount_chk` CHECK (`amountCents` > 0);
--> statement-breakpoint
ALTER TABLE `customerPayments` ADD CONSTRAINT `customerPayments_reversal_chk` CHECK ((`status` = 'reversed') = (`reversedAt` IS NOT NULL));
--> statement-breakpoint
CREATE INDEX `customerPayments_account` ON `customerPayments` (`customerAccountId`);
--> statement-breakpoint

-- An allocation is reversed by a NEGATIVE row naming it, never by an UPDATE or a DELETE: every reader that sums
-- allocations is right without knowing reversals exist, and the reversal is history. One reversal per allocation.
ALTER TABLE `paymentAllocations`
  ADD COLUMN `allocationRef` varchar(40) NULL,
  ADD COLUMN `reversesAllocationId` int NULL,
  ADD COLUMN `reason` varchar(400) NULL;
--> statement-breakpoint
ALTER TABLE `paymentAllocations` ADD CONSTRAINT `paymentAllocations_allocationRef_unique` UNIQUE(`allocationRef`);
--> statement-breakpoint
ALTER TABLE `paymentAllocations` ADD CONSTRAINT `paymentAllocations_reverses_unique` UNIQUE(`reversesAllocationId`);
--> statement-breakpoint
ALTER TABLE `paymentAllocations` ADD CONSTRAINT `paymentAllocations_sign_chk` CHECK ((`reversesAllocationId` IS NULL AND `amountCents` > 0) OR (`reversesAllocationId` IS NOT NULL AND `amountCents` < 0 AND `reason` IS NOT NULL));
--> statement-breakpoint
CREATE INDEX `paymentAllocations_payment` ON `paymentAllocations` (`customerPaymentId`);
--> statement-breakpoint
CREATE INDEX `paymentAllocations_invoice` ON `paymentAllocations` (`invoiceId`);
--> statement-breakpoint

/* ---------------- Credit notes: numbered per organization ---------------- */

ALTER TABLE `customerCredits`
  ADD COLUMN `numberScope` varchar(64) NOT NULL DEFAULT 'default',
  ADD COLUMN `numberAllocationRef` varchar(40) NULL,
  ADD COLUMN `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  ADD COLUMN `source` enum('manual','dispute','write_off','billing') NOT NULL DEFAULT 'manual',
  ADD COLUMN `disputeCaseId` int NULL,
  ADD COLUMN `decisionNote` varchar(400) NULL;
--> statement-breakpoint
ALTER TABLE `customerCredits` DROP INDEX `customerCredits_creditRef_unique`;
--> statement-breakpoint
ALTER TABLE `customerCredits` ADD CONSTRAINT `customerCredits_scope_ref_unique` UNIQUE(`numberScope`, `creditRef`);
--> statement-breakpoint
ALTER TABLE `customerCredits` ADD CONSTRAINT `customerCredits_amount_chk` CHECK (`amountCents` > 0);
--> statement-breakpoint
ALTER TABLE `customerCredits` ADD CONSTRAINT `customerCredits_sod_chk` CHECK (`approvedByUserId` IS NULL OR `source` = 'write_off' OR `approvedByUserId` <> `requestedByUserId`);
--> statement-breakpoint
CREATE INDEX `customerCredits_ref` ON `customerCredits` (`creditRef`);
--> statement-breakpoint
CREATE INDEX `customerCredits_invoice` ON `customerCredits` (`invoiceId`);
--> statement-breakpoint

/* ---------------- Adjustments: separate from credits, approved, never a balance edit ---------------- */

-- A signed amount on an invoice's receivable (a late fee raises it; an FX or rounding difference may lower it),
-- requested by one person and decided by another. The invoice's own total never changes.
CREATE TABLE `invoiceAdjustments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `adjustmentRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `invoiceId` int NOT NULL,
  `amountCents` int NOT NULL,
  `currency` varchar(3) NOT NULL,
  `reasonCode` enum('late_fee','rounding','fx','correction','other') NOT NULL,
  `reason` varchar(400) NOT NULL,
  `status` enum('requested','approved','refused') NOT NULL DEFAULT 'requested',
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `decidedByUserId` int NULL,
  `decidedAt` timestamp NULL,
  `decisionNote` varchar(400) NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `invoiceAdjustments_id` PRIMARY KEY(`id`),
  CONSTRAINT `invoiceAdjustments_ref_unique` UNIQUE(`adjustmentRef`),
  CONSTRAINT `invoiceAdjustments_amount_chk` CHECK (`amountCents` <> 0),
  CONSTRAINT `invoiceAdjustments_decision_chk` CHECK ((`status` = 'requested') = (`decidedByUserId` IS NULL) AND (`decidedByUserId` IS NULL OR `decidedByUserId` <> `requestedByUserId`))
);
--> statement-breakpoint
CREATE INDEX `invoiceAdjustments_invoice` ON `invoiceAdjustments` (`invoiceId`, `status`);
--> statement-breakpoint

/* ---------------- Disputes: invoice- or line-level, by id ---------------- */

ALTER TABLE `disputeCases`
  ADD COLUMN `invoiceId` int NULL,
  ADD COLUMN `invoiceLineId` int NULL,
  ADD COLUMN `financialEntityId` int NULL,
  ADD COLUMN `openedByUserId` int NULL,
  ADD COLUMN `notes` text NULL,
  ADD COLUMN `documentRefsJson` text NULL,
  ADD COLUMN `resolvedByUserId` int NULL,
  ADD COLUMN `resolutionAmountCents` int NULL,
  ADD COLUMN `creditId` int NULL;
--> statement-breakpoint
-- One open dispute per invoice (line 0) or per invoice line at a time.
ALTER TABLE `disputeCases`
  ADD COLUMN `openKey` varchar(40) AS (CASE WHEN `invoiceId` IS NOT NULL AND `status` IN ('raised','investigating','evidence_gathered','escalated') THEN CONCAT(`invoiceId`, ':', COALESCE(`invoiceLineId`, 0)) ELSE NULL END) PERSISTENT;
--> statement-breakpoint
CREATE UNIQUE INDEX `disputeCases_open_uq` ON `disputeCases` (`openKey`);
--> statement-breakpoint
CREATE INDEX `disputeCases_invoice` ON `disputeCases` (`invoiceId`);
--> statement-breakpoint
ALTER TABLE `disputeCases` ADD CONSTRAINT `disputeCases_amount_chk` CHECK ((`disputedAmountCents` IS NULL OR `disputedAmountCents` > 0) AND (`resolutionAmountCents` IS NULL OR `resolutionAmountCents` >= 0));
--> statement-breakpoint

/* ---------------- Accounting integration boundary ---------------- */

-- What LeaseOS hands an external ledger: a stable entity ref, the payload and its hash, and the export's state.
-- Idempotent on (book, entity, ref, payload hash): queueing the same fact twice is one row; a changed fact is a
-- new row and the old one is superseded. LeaseOS is the subledger; the GL is someone else's.
CREATE TABLE `accountingSyncRecords` (
  `id` int AUTO_INCREMENT NOT NULL,
  `syncRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `entityType` enum('invoice','payment','credit_note','adjustment','allocation') NOT NULL,
  `entityId` int NOT NULL,
  `entityRef` varchar(80) NOT NULL,
  `payloadJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `externalSystem` varchar(40) NOT NULL DEFAULT 'unconfigured',
  `status` enum('pending','exported','failed','conflict','superseded') NOT NULL DEFAULT 'pending',
  `externalId` varchar(120) NULL,
  `attempts` int NOT NULL DEFAULT 0,
  `lastError` varchar(600) NULL,
  `lastAttemptAt` timestamp NULL,
  `lastSyncedAt` timestamp NULL,
  `markedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `accountingSyncRecords_id` PRIMARY KEY(`id`),
  CONSTRAINT `accountingSyncRecords_ref_unique` UNIQUE(`syncRef`),
  CONSTRAINT `accountingSyncRecords_idem_unique` UNIQUE(`financialEntityId`, `entityType`, `entityRef`, `payloadHash`),
  CONSTRAINT `accountingSyncRecords_exported_chk` CHECK (`status` <> 'exported' OR (`externalId` IS NOT NULL AND `lastSyncedAt` IS NOT NULL)),
  CONSTRAINT `accountingSyncRecords_attempts_chk` CHECK (`attempts` >= 0)
);
--> statement-breakpoint
CREATE INDEX `accountingSyncRecords_entity_status` ON `accountingSyncRecords` (`financialEntityId`, `status`);
--> statement-breakpoint

/* ---------------- The existing change ledger learns the billing subjects ---------------- */

ALTER TABLE `commercialAuditEvents` MODIFY COLUMN `subjectType` enum('customer_account','customer_contact','customer_contract','rate_sheet','rate_sheet_version','rate_line','job_commercial_context','job_commercial_snapshot','customer_purchase_order','billing_workspace','billable_charge','invoice','customer_payment','payment_allocation','customer_credit','invoice_adjustment','dispute_case','accounting_sync') NOT NULL;
