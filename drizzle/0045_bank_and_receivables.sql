-- v21.9 — Bank reconciliation and accounts receivable.
--
-- A bank statement line is evidence that money moved. It matches one
-- LeaseOS movement — a customer payment, a vendor bill paid, a card
-- statement settled — or it is a finding: an unknown deposit, an unknown
-- withdrawal, or a line that could be two things. LeaseOS movements the
-- statement has not shown yet are outstanding cheques and deposits in
-- transit; that is what a reconciliation is.
--
-- A customer payment is received, then allocated to invoices; an allocation
-- can never exceed the payment or the invoice's balance, and never cross
-- customers. A credit reduces what is owed with a reason and an approver.
-- Collections are events. A write-off is requested by one person and
-- decided by another.

CREATE TABLE `bankAccounts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `accountRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `institution` varchar(120),
  `lastFour` varchar(4),
  `currency` varchar(3) NOT NULL DEFAULT 'CAD',
  `status` enum('active','closed') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bankAccounts_id` PRIMARY KEY(`id`),
  CONSTRAINT `bankAccounts_accountRef_unique` UNIQUE(`accountRef`)
);
--> statement-breakpoint

CREATE TABLE `bankStatements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `statementRef` varchar(64) NOT NULL,
  `bankAccountId` int NOT NULL,
  `periodStart` timestamp NOT NULL,
  `periodEnd` timestamp NOT NULL,
  `openingBalanceCents` int NOT NULL,
  `closingBalanceCents` int NOT NULL,
  `lineCount` int NOT NULL DEFAULT 0,
  `matchedCount` int NOT NULL DEFAULT 0,
  `unmatchedCount` int NOT NULL DEFAULT 0,
  `contentHash` varchar(64) NOT NULL,
  `importedByUserId` int NOT NULL,
  `importedAt` timestamp NOT NULL,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bankStatements_id` PRIMARY KEY(`id`),
  CONSTRAINT `bankStatements_statementRef_unique` UNIQUE(`statementRef`),
  CONSTRAINT `bankStatements_contentHash_unique` UNIQUE(`contentHash`)
);
--> statement-breakpoint

CREATE TABLE `bankStatementLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bankStatementId` int NOT NULL,
  `lineNo` int NOT NULL,
  `postedAt` timestamp NOT NULL,
  `description` varchar(300),
  `reference` varchar(120),
  -- Signed: a deposit is positive, a withdrawal negative.
  `amountCents` int NOT NULL,
  `matchedType` enum('customer_payment','vendor_bill','fuel_statement','transfer','bank_fee','other') ,
  `matchedId` int,
  `matchOutcome` enum('matched','unmatched','ambiguous','timing_difference') NOT NULL,
  `matchReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `bankStatementLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `bankStatementLines_statement_line_unique` UNIQUE(`bankStatementId`,`lineNo`)
);
--> statement-breakpoint

CREATE TABLE `customerPayments` (
  `id` int AUTO_INCREMENT NOT NULL,
  `paymentRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `customer` varchar(220) NOT NULL,
  `receivedAt` timestamp NOT NULL,
  `amountCents` int NOT NULL,
  `method` enum('eft','cheque','card','cash','other') NOT NULL,
  `reference` varchar(120),
  `bankStatementLineId` int,
  `status` enum('unapplied','partially_applied','applied','reversed') NOT NULL DEFAULT 'unapplied',
  `recordedByUserId` int NOT NULL,
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerPayments_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerPayments_paymentRef_unique` UNIQUE(`paymentRef`)
);
--> statement-breakpoint
CREATE INDEX `customerPayments_customer_idx` ON `customerPayments` (`financialEntityId`, `customer`, `receivedAt`);
--> statement-breakpoint

CREATE TABLE `paymentAllocations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `customerPaymentId` int NOT NULL,
  `invoiceId` int NOT NULL,
  `amountCents` int NOT NULL,
  `allocatedByUserId` int NOT NULL,
  `allocatedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `paymentAllocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `paymentAllocations_invoice_idx` ON `paymentAllocations` (`invoiceId`);
--> statement-breakpoint

CREATE TABLE `customerCredits` (
  `id` int AUTO_INCREMENT NOT NULL,
  `creditRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `customer` varchar(220) NOT NULL,
  `invoiceId` int,
  `amountCents` int NOT NULL,
  `reason` varchar(400) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `status` enum('requested','approved','refused') NOT NULL DEFAULT 'requested',
  `evidenceRecordId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerCredits_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerCredits_creditRef_unique` UNIQUE(`creditRef`)
);
--> statement-breakpoint

CREATE TABLE `collectionEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `invoiceId` int NOT NULL,
  `eventType` enum('reminder_sent','statement_sent','call','promise_to_pay','dispute_noted','escalated','write_off_requested','write_off_decided') NOT NULL,
  `note` varchar(600),
  `promisedAmountCents` int,
  `promisedAt` timestamp,
  `byUserId` int NOT NULL,
  `at` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `collectionEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `collectionEvents_invoice_idx` ON `collectionEvents` (`invoiceId`, `at`);
--> statement-breakpoint

CREATE TABLE `writeOffRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `requestRef` varchar(64) NOT NULL,
  `invoiceId` int NOT NULL,
  `amountCents` int NOT NULL,
  `reason` varchar(400) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL,
  `decidedByUserId` int,
  `decidedAt` timestamp,
  `status` enum('requested','approved','refused') NOT NULL DEFAULT 'requested',
  `decisionReason` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `writeOffRequests_id` PRIMARY KEY(`id`),
  CONSTRAINT `writeOffRequests_requestRef_unique` UNIQUE(`requestRef`)
);
