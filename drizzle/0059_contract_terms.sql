-- v22.1 — Customer contract terms.
--
-- The closeout answers standby, holds, disposal time and return travel as
-- REVIEW because "a contract rule would decide". This is the rule: terms per
-- customer account, versioned, recorded by one person and APPROVED by
-- another against the contract document, effective for a period. A term
-- decides an event's customer-billable answer and is cited on the event
-- (billingRuleRef) with its clause; grace minutes reduce the billable
-- minutes of a standby, never the clock. Without approved terms, the
-- answer stays REVIEW.

CREATE TABLE `customerContractTerms` (
  `id` int AUTO_INCREMENT NOT NULL,
  `termsRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `title` varchar(160) NOT NULL,
  `standbyBillable` enum('yes','no') NOT NULL,
  `standbyFreeMinutes` int NOT NULL DEFAULT 0,
  `customerHoldBillable` enum('yes','no') NOT NULL,
  `weatherHoldBillable` enum('yes','no') NOT NULL,
  `travelToDisposalBillable` enum('yes','no') NOT NULL,
  `disposalQueueBillable` enum('yes','no') NOT NULL,
  `disposalBillable` enum('yes','no') NOT NULL,
  `returnTravelBillable` enum('yes','no') NOT NULL,
  `minimumHours` double,
  `clausesJson` text NOT NULL,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp,
  `sourceDocumentEvidenceId` int,
  `status` enum('draft','approved','superseded') NOT NULL DEFAULT 'draft',
  `recordedByUserId` int NOT NULL,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `supersedesTermsId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerContractTerms_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerContractTerms_termsRef_unique` UNIQUE(`termsRef`)
);
--> statement-breakpoint

ALTER TABLE `fieldTicketEvents` ADD COLUMN `billableMinutes` double AFTER `durationMinutes`;
