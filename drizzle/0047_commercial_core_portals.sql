-- v21.10 — Commercial core and external portals.
--
-- A customer account carries the rules that decide whether an invoice may
-- even be issued: terms, a credit limit, whether a PO or AFE is required,
-- how often billing happens, whether the account is on hold. A purchase
-- order or AFE is an authorization with an amount and a life; invoices
-- consume it. A customer rate card prices service lines for that customer —
-- the default `billingRateCards` remain the fallback.
--
-- An external identity is a customer, a vendor or a disposal facility, bound
-- to exactly one account. What a portal shows is scoped by that binding on
-- the server; the client never says whose data it wants. A submission —
-- a vendor bill, a facility ticket, a dispute — is idempotent by content,
-- reviewed by a person inside, and becomes a LeaseOS record only on
-- acceptance.

ALTER TABLE `customerAccounts`
  MODIFY COLUMN `status` enum('active','on_hold','inactive') NOT NULL DEFAULT 'active',
  ADD COLUMN `paymentTermsDays` int NOT NULL DEFAULT 30 AFTER `name`,
  ADD COLUMN `creditLimitCents` int NULL AFTER `paymentTermsDays`,
  ADD COLUMN `requiresPurchaseOrder` boolean NOT NULL DEFAULT false AFTER `creditLimitCents`,
  ADD COLUMN `requiresAfe` boolean NOT NULL DEFAULT false AFTER `requiresPurchaseOrder`,
  ADD COLUMN `billingFrequency` enum('per_job','weekly','monthly') NOT NULL DEFAULT 'per_job' AFTER `requiresAfe`,
  ADD COLUMN `holdReason` varchar(300) NULL AFTER `billingFrequency`;
--> statement-breakpoint

CREATE TABLE `customerPurchaseOrders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `poRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `poNumber` varchar(80) NOT NULL,
  `afeNumber` varchar(80),
  `authorizedCents` int NOT NULL,
  `validFrom` timestamp NOT NULL,
  `validTo` timestamp,
  `status` enum('open','exhausted','expired','closed') NOT NULL DEFAULT 'open',
  `evidenceRecordId` int,
  `recordedByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerPurchaseOrders_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerPurchaseOrders_poRef_unique` UNIQUE(`poRef`),
  CONSTRAINT `customerPurchaseOrders_account_po_unique` UNIQUE(`customerAccountId`,`poNumber`)
);
--> statement-breakpoint

CREATE TABLE `customerRateCards` (
  `id` int AUTO_INCREMENT NOT NULL,
  `rateCardRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp,
  `status` enum('draft','approved','superseded') NOT NULL DEFAULT 'draft',
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerRateCards_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerRateCards_rateCardRef_unique` UNIQUE(`rateCardRef`)
);
--> statement-breakpoint

CREATE TABLE `customerRateCardLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `rateCardId` int NOT NULL,
  `serviceCode` varchar(60) NOT NULL,
  `description` varchar(220) NOT NULL,
  `unit` enum('hour','day','km','m3','tonne','load','each') NOT NULL,
  `rateCents` int NOT NULL,
  `minimumCents` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerRateCardLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerRateCardLines_card_code_unique` UNIQUE(`rateCardId`,`serviceCode`)
);
--> statement-breakpoint

ALTER TABLE `invoices`
  ADD COLUMN `customerPurchaseOrderId` int NULL AFTER `purchaseOrder`,
  ADD COLUMN `rateCardId` int NULL AFTER `customerPurchaseOrderId`;
--> statement-breakpoint

CREATE TABLE `externalIdentities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `identityRef` varchar(64) NOT NULL,
  `kind` enum('customer','vendor','facility') NOT NULL,
  `customerAccountId` int,
  `vendorId` int,
  `facilityId` int,
  `email` varchar(220) NOT NULL,
  `displayName` varchar(180) NOT NULL,
  -- SHA-256 of the bearer token. The token itself is shown once and never stored.
  `tokenHash` varchar(64) NOT NULL,
  `status` enum('invited','active','suspended','revoked') NOT NULL DEFAULT 'invited',
  `invitedByUserId` int NOT NULL,
  `invitedAt` timestamp NOT NULL,
  `lastSeenAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalIdentities_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalIdentities_identityRef_unique` UNIQUE(`identityRef`),
  CONSTRAINT `externalIdentities_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint

CREATE TABLE `portalSubmissions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `submissionRef` varchar(64) NOT NULL,
  `externalIdentityId` int NOT NULL,
  `kind` enum('vendor_bill','disposal_ticket','invoice_dispute','po_acknowledgement') NOT NULL,
  `payloadJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `status` enum('submitted','accepted','rejected','duplicate') NOT NULL DEFAULT 'submitted',
  `resultRef` varchar(80),
  `reviewedByUserId` int,
  `reviewedAt` timestamp,
  `reviewReason` varchar(400),
  `submittedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `portalSubmissions_id` PRIMARY KEY(`id`),
  CONSTRAINT `portalSubmissions_submissionRef_unique` UNIQUE(`submissionRef`),
  CONSTRAINT `portalSubmissions_identity_hash_unique` UNIQUE(`externalIdentityId`,`payloadHash`)
);
--> statement-breakpoint

ALTER TABLE `vendors`
  ADD COLUMN `requiresPurchaseAuthorization` boolean NOT NULL DEFAULT false AFTER `paymentTermsDays`,
  ADD COLUMN `portalEnabled` boolean NOT NULL DEFAULT false AFTER `requiresPurchaseAuthorization`;
