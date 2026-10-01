-- v23.31 — 0217: the customer account becomes the canonical commercial party.
--
-- `customerAccounts` (v21.10) carried terms, credit and the PO/AFE flags and nothing else: no
-- legal name, no address, no tax status, no customer number, no record of who created or
-- changed it. `cashRouter.resolveCustomerAccount` was the only writer, by name. This migration
-- gives the account the profile the commercial backbone needs, additively — every existing row
-- keeps working, every new column is nullable or defaulted.
--
-- Rules the columns carry:
--   * `customerNumber` is the number a person reads aloud, minted from the sequence (CN) or
--     supplied from the customer's own paperwork; it is unique WITHIN the owning financial
--     entity (the money tenant boundary, 0146), never globally, because two businesses may
--     both number their first customer 000001.
--   * commercial history is never deleted. `archivedAt` + `status = inactive` is how an
--     account ends; the rows it owns (contracts, rate sheets, snapshots) stay.
--   * `rowVersion` is an optimistic concurrency token: a write names the version it read and
--     is refused (CONFLICT) if another write got there first. Last-write-wins is not a policy.
--
-- Numbered 0182–0184 when written (2026-09-24); renumbered to 0217–0219 at the merge of main on
-- 2026-10-01, when three other open branches also held 0182–0184 and, by the time it was pushed, the
-- highest claim anywhere was 0216 (docs/architecture/MIGRATION_COLLISION_REGISTER.md).

ALTER TABLE `customerAccounts`
  ADD COLUMN `customerNumber` varchar(40) NULL,
  ADD COLUMN `legalName` varchar(220) NULL,
  ADD COLUMN `tradeName` varchar(220) NULL,
  ADD COLUMN `customerType` enum('producer_operator','oilfield_service','prime_contractor','consultant','disposal_company','municipality','construction','trucking','other') NOT NULL DEFAULT 'other',
  ADD COLUMN `billingAddressJson` text NULL,
  ADD COLUMN `physicalAddressJson` text NULL,
  ADD COLUMN `province` varchar(8) NULL,
  ADD COLUMN `country` varchar(2) NOT NULL DEFAULT 'CA',
  ADD COLUMN `gstNumber` varchar(20) NULL,
  ADD COLUMN `taxStatus` enum('taxable','zero_rated','exempt','unknown') NOT NULL DEFAULT 'unknown',
  ADD COLUMN `defaultCurrency` varchar(3) NOT NULL DEFAULT 'CAD',
  -- Which customer references (po, work_order, afe, cost_centre, project_number, customer_job_number)
  -- must be on a job before it is dispatched or billed; extends the two booleans, never replaces them.
  ADD COLUMN `requiredReferenceKindsJson` text NULL,
  ADD COLUMN `notes` text NULL,
  ADD COLUMN `createdByUserId` int NULL,
  ADD COLUMN `updatedByUserId` int NULL,
  ADD COLUMN `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  ADD COLUMN `archivedAt` timestamp NULL,
  ADD COLUMN `archivedByUserId` int NULL,
  ADD COLUMN `archiveReason` varchar(400) NULL,
  ADD COLUMN `rowVersion` int NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `customerAccounts_entity_number_unique` ON `customerAccounts` (`financialEntityId`, `customerNumber`);
--> statement-breakpoint
CREATE INDEX `customerAccounts_entity_status_idx` ON `customerAccounts` (`financialEntityId`, `status`);
--> statement-breakpoint

-- A person at the customer. There was no contact entity anywhere in the schema (the scope
-- reconciliation of 2026-09-21 names it MISSING); contacts were columns on whatever record
-- needed one. This is the directory, keyed to the account, with links to the two per-person
-- records that already exist: a portal identity (`externalIdentities`) and a signing authority
-- (`signatoryAuthorities`). A contact's roles are rows, not a text field, so "the billing
-- contact as of March" is a query and a job can snapshot exactly the people it used.
CREATE TABLE `customerContacts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contactRef` varchar(40) NOT NULL,
  `financialEntityId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  `displayName` varchar(180) NOT NULL,
  `title` varchar(120) NULL,
  -- The company the person actually works for when it is not the account (a consultant at a
  -- consulting firm placed on the producer's job).
  `company` varchar(220) NULL,
  `phone` varchar(60) NULL,
  `mobile` varchar(60) NULL,
  `email` varchar(220) NULL,
  `preferredChannel` enum('phone','sms','email','portal') NULL,
  `externalIdentityId` int NULL,
  `signatoryAuthorityId` int NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `notes` varchar(600) NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `rowVersion` int NOT NULL DEFAULT 1,
  CONSTRAINT `customerContacts_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerContacts_ref_unique` UNIQUE(`contactRef`)
);
--> statement-breakpoint
CREATE INDEX `customerContacts_account_idx` ON `customerContacts` (`customerAccountId`, `status`);
--> statement-breakpoint
CREATE INDEX `customerContacts_entity_idx` ON `customerContacts` (`financialEntityId`);
--> statement-breakpoint

-- One role a contact holds for the account, effective-dated. Ended, never deleted.
CREATE TABLE `customerContactRoles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `contactId` int NOT NULL,
  `customerAccountId` int NOT NULL,
  -- dispatcher, consultant, field_consultant, billing, accounts_payable, safety,
  -- operations_manager, emergency, site_contact, other — validated in code, extensible by code.
  `roleKey` varchar(40) NOT NULL,
  `isPrimary` boolean NOT NULL DEFAULT false,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `status` enum('active','ended') NOT NULL DEFAULT 'active',
  `assignedByUserId` int NOT NULL,
  `assignedAt` timestamp NOT NULL DEFAULT (now()),
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  CONSTRAINT `customerContactRoles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `customerContactRoles_contact_idx` ON `customerContactRoles` (`contactId`, `status`);
--> statement-breakpoint
CREATE INDEX `customerContactRoles_account_role_idx` ON `customerContactRoles` (`customerAccountId`, `roleKey`, `status`);
--> statement-breakpoint

-- The commercial change ledger. Append-only, written in the same transaction as the change it
-- records, never updated. Who created a customer, who changed which field from what to what,
-- who approved a contract, who superseded a rate sheet version, which job took which snapshot.
-- `authorizationDecisions` records that a person was allowed to call; this records what changed.
CREATE TABLE `commercialAuditEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `eventRef` varchar(64) NOT NULL,
  `financialEntityId` int NOT NULL,
  `subjectType` enum('customer_account','customer_contact','customer_contract','rate_sheet','rate_sheet_version','rate_line','job_commercial_context','job_commercial_snapshot','customer_purchase_order') NOT NULL,
  `subjectRef` varchar(80) NOT NULL,
  `subjectId` int NULL,
  `eventType` varchar(60) NOT NULL,
  `fromStatus` varchar(40) NULL,
  `toStatus` varchar(40) NULL,
  -- {field: {from, to}} for a field change; empty for a status transition with no field change.
  `changesJson` text NULL,
  `relatedRef` varchar(80) NULL,
  `jobId` int NULL,
  `reason` varchar(500) NULL,
  `actorUserId` int NOT NULL,
  `actorRole` varchar(60) NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialAuditEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialAuditEvents_ref_unique` UNIQUE(`eventRef`)
);
--> statement-breakpoint
CREATE INDEX `commercialAuditEvents_subject_idx` ON `commercialAuditEvents` (`subjectType`, `subjectRef`, `id`);
--> statement-breakpoint
CREATE INDEX `commercialAuditEvents_entity_idx` ON `commercialAuditEvents` (`financialEntityId`, `occurredAt`);
--> statement-breakpoint
CREATE INDEX `commercialAuditEvents_job_idx` ON `commercialAuditEvents` (`jobId`);
