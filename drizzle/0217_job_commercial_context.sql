-- v23.31 — 0217: the job's commercial context, and the snapshot that outlives it.
--
-- `jobs.customer` is free text and `jobs.customerOrgRef` a link a person makes in the
-- commercial office; neither says which account, contract, rate sheet or purchase order a job
-- is worked under. This is that record, in two halves:
--
--   jobCommercialContexts   the LIVE assignment: dispatch selects the customer, the contract,
--                            the PO, the sheet. Editable until it is snapshotted; after that a
--                            change is a correction that produces a new snapshot.
--   jobCommercialSnapshots  the IMMUTABLE evidence: at activation (or on demand) the context is
--                            frozen with every version identifier billing will ever need — the
--                            contract version, the rate sheet version and its content hash, the
--                            definition refs and versions, the contacts as they stood, the PO,
--                            the terms, the addresses, the payment terms. A job done under a
--                            $185/h line in June shows $185/h in a later year when the customer's
--                            current sheet says $215/h, because billing reads the snapshot and
--                            never the live sheet. A snapshot is never updated; a correction is
--                            a new sequence number that supersedes the old row, which stays.
--
--   jobCommercialParties     the other companies and people on the job — operator/producer,
--                            prime contractor, consultant company, bill-to, site contact —
--                            as normalized references (an account, a contact, an organization),
--                            not text fields.
--   jobCommercialReferences  PO, work order, AFE, cost centre, project number, the customer's
--                            job number, and so on — one row per reference, extensible by kind,
--                            so a contract can require any of them before dispatch or billing.

CREATE TABLE `jobCommercialContexts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `jobId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  -- NULL = the contracting customer is billed.
  `billToCustomerAccountId` int NULL,
  `contractId` int NULL,
  -- The sheet dispatch chose; the VERSION is resolved by effective date at snapshot time, or
  -- pinned here when a person names one explicitly.
  `rateSheetId` int NULL,
  `pinnedRateSheetVersionId` int NULL,
  `purchaseOrderId` int NULL,
  -- A recorded decision that this job proceeds without a required reference (emergency work).
  -- The gate reads it: with a reason on file the missing PO is REVIEW, not BLOCK.
  `referenceWaiverReason` varchar(400) NULL,
  `referenceWaivedByUserId` int NULL,
  `referenceWaivedAt` timestamp NULL,
  `notes` varchar(600) NULL,
  `currentSnapshotId` int NULL,
  `setByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `rowVersion` int NOT NULL DEFAULT 1,
  CONSTRAINT `jobCommercialContexts_id` PRIMARY KEY(`id`),
  CONSTRAINT `jobCommercialContexts_job_unique` UNIQUE(`jobId`)
);
--> statement-breakpoint
CREATE INDEX `jobCommercialContexts_account_idx` ON `jobCommercialContexts` (`customerAccountId`);
--> statement-breakpoint
CREATE INDEX `jobCommercialContexts_contract_idx` ON `jobCommercialContexts` (`contractId`);
--> statement-breakpoint
CREATE INDEX `jobCommercialContexts_entity_idx` ON `jobCommercialContexts` (`financialEntityId`);
--> statement-breakpoint

CREATE TABLE `jobCommercialParties` (
  `id` int AUTO_INCREMENT NOT NULL,
  `jobId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  -- operator_producer, prime_contractor, consultant_company, disposal_company, site_contact,
  -- consultant_contact, dispatcher_contact, billing_contact, emergency_contact — validated in code.
  `partyRole` varchar(40) NOT NULL,
  `customerAccountId` int NULL,
  `contactId` int NULL,
  `orgRef` varchar(64) NULL,
  -- Only when no record exists yet; the snapshot marks such a party as unlinked.
  `freeText` varchar(220) NULL,
  `status` enum('active','ended') NOT NULL DEFAULT 'active',
  `recordedByUserId` int NOT NULL,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  CONSTRAINT `jobCommercialParties_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `jobCommercialParties_job_idx` ON `jobCommercialParties` (`jobId`, `status`);
--> statement-breakpoint

CREATE TABLE `jobCommercialReferences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `jobId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  -- po, work_order, afe, customer_job_number, cost_centre, project_number, uwi, other.
  `referenceKind` varchar(40) NOT NULL,
  `referenceValue` varchar(120) NOT NULL,
  -- A PO reference that names a recorded purchase order row; NULL for a bare number.
  `customerPurchaseOrderId` int NULL,
  `source` enum('office','dispatch','customer_portal','field','import') NOT NULL DEFAULT 'office',
  `status` enum('active','ended') NOT NULL DEFAULT 'active',
  `recordedByUserId` int NOT NULL,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  CONSTRAINT `jobCommercialReferences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `jobCommercialReferences_job_idx` ON `jobCommercialReferences` (`jobId`, `referenceKind`, `status`);
--> statement-breakpoint

CREATE TABLE `jobCommercialSnapshots` (
  `id` int AUTO_INCREMENT NOT NULL,
  `snapshotRef` varchar(40) NOT NULL,
  `jobId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `sequenceNo` int NOT NULL,
  `reason` enum('activation','correction','manual') NOT NULL,
  `status` enum('current','superseded') NOT NULL DEFAULT 'current',
  `capturedByUserId` int NOT NULL,
  `capturedAt` timestamp NOT NULL,
  -- The reference columns are the ones billing joins on; everything else is in the payload.
  `customerAccountId` int NOT NULL,
  `customerAccountRef` varchar(64) NOT NULL,
  `customerNumber` varchar(40) NULL,
  `customerName` varchar(220) NOT NULL,
  `billToCustomerAccountId` int NOT NULL,
  `contractId` int NULL,
  `contractRef` varchar(40) NULL,
  `contractNumber` varchar(80) NULL,
  `contractVersion` int NULL,
  `termsId` int NULL,
  `termsRef` varchar(64) NULL,
  `termsVersion` int NULL,
  `rateSheetId` int NULL,
  `rateSheetVersionId` int NULL,
  `rateSheetVersionRef` varchar(40) NULL,
  `rateSheetVersion` int NULL,
  `rateSheetContentHash` char(64) NULL,
  `purchaseOrderId` int NULL,
  `poRef` varchar(64) NULL,
  `poNumber` varchar(80) NULL,
  `paymentTermsDays` int NOT NULL,
  `currency` varchar(3) NOT NULL,
  `poRequired` boolean NOT NULL,
  `billingInstructions` text NULL,
  `payloadJson` text NOT NULL,
  `payloadHash` char(64) NOT NULL,
  `supersedesSnapshotId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `jobCommercialSnapshots_id` PRIMARY KEY(`id`),
  CONSTRAINT `jobCommercialSnapshots_ref_unique` UNIQUE(`snapshotRef`),
  CONSTRAINT `jobCommercialSnapshots_job_seq_unique` UNIQUE(`jobId`, `sequenceNo`)
);
--> statement-breakpoint
CREATE INDEX `jobCommercialSnapshots_job_status_idx` ON `jobCommercialSnapshots` (`jobId`, `status`);
--> statement-breakpoint
CREATE INDEX `jobCommercialSnapshots_contract_idx` ON `jobCommercialSnapshots` (`contractId`);
--> statement-breakpoint
CREATE INDEX `jobCommercialSnapshots_sheet_version_idx` ON `jobCommercialSnapshots` (`rateSheetVersionId`);
