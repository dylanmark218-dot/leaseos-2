-- v21.17 — Commercial project management.
--
-- A quote is priced from the customer's rate card, frozen with a hash when
-- issued, and accepted by a customer signatory who holds the authority to
-- accept quotes; a revision is a new version that supersedes, never an
-- edit. A change order is extra work with an amount, authorized within a
-- signatory's extra-work limit or recorded as exceeding it — never assumed.
-- An RFI is a question the contractor asks and the customer answers; both
-- sides' words are kept. A budget is lines by cost code, approved by someone
-- other than its author; the forecast is arithmetic over what was quoted,
-- authorized, billed and collected, and says UNKNOWN about completion until
-- a person states it.

ALTER TABLE `signatoryAuthorities`
  ADD COLUMN `mayAcceptQuotes` boolean NOT NULL DEFAULT false AFTER `mayChangeRates`,
  ADD COLUMN `mayAnswerRfis` boolean NOT NULL DEFAULT true AFTER `mayAcceptQuotes`;
--> statement-breakpoint

CREATE TABLE `quotes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `quoteRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `financialEntityId` int NOT NULL,
  `jobId` int,
  `version` int NOT NULL DEFAULT 1,
  `title` varchar(220) NOT NULL,
  `scope` text,
  `rateCardId` int,
  `subtotalCents` int NOT NULL DEFAULT 0,
  `validUntil` timestamp,
  `status` enum('draft','issued','accepted','declined','expired','superseded','withdrawn') NOT NULL DEFAULT 'draft',
  `snapshotJson` text,
  `snapshotHash` varchar(64),
  `issuedByUserId` int,
  `issuedAt` timestamp,
  `acceptedByName` varchar(180),
  `acceptedByExternalIdentityId` int,
  `acceptedAt` timestamp,
  `acceptanceWithinAuthority` enum('yes','no','unknown'),
  `supersedesQuoteId` int,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `quotes_id` PRIMARY KEY(`id`),
  CONSTRAINT `quotes_quoteRef_unique` UNIQUE(`quoteRef`)
);
--> statement-breakpoint

CREATE TABLE `quoteLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `quoteId` int NOT NULL,
  `lineNo` int NOT NULL,
  `serviceCode` varchar(60) NOT NULL,
  `description` varchar(220) NOT NULL,
  `quantity` double NOT NULL,
  `unit` varchar(20) NOT NULL,
  `rateCents` int NOT NULL,
  `amountCents` int NOT NULL,
  `priceSource` enum('rate_card','explicit') NOT NULL,
  `costCode` varchar(40),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `quoteLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `quoteLines_quote_line_unique` UNIQUE(`quoteId`,`lineNo`)
);
--> statement-breakpoint

CREATE TABLE `changeOrders` (
  `id` int AUTO_INCREMENT NOT NULL,
  `changeOrderRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `jobId` int,
  `fieldTicketId` int,
  `quoteId` int,
  `rfiId` int,
  `description` varchar(600) NOT NULL,
  `reason` varchar(600) NOT NULL,
  `estimatedCents` int NOT NULL,
  `costCode` varchar(40),
  `status` enum('proposed','authorized','declined','withdrawn') NOT NULL DEFAULT 'proposed',
  `snapshotHash` varchar(64) NOT NULL,
  `authorizedByName` varchar(180),
  `authorizedByExternalIdentityId` int,
  `authorizedAt` timestamp,
  `withinAuthority` enum('yes','no','unknown'),
  `authorityDetail` varchar(300),
  `proposedByUserId` int NOT NULL,
  `proposedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `changeOrders_id` PRIMARY KEY(`id`),
  CONSTRAINT `changeOrders_changeOrderRef_unique` UNIQUE(`changeOrderRef`)
);
--> statement-breakpoint

CREATE TABLE `rfis` (
  `id` int AUTO_INCREMENT NOT NULL,
  `rfiRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `jobId` int,
  `question` varchar(1200) NOT NULL,
  `askedByUserId` int NOT NULL,
  `askedAt` timestamp NOT NULL,
  `answer` varchar(2000),
  `answeredByName` varchar(180),
  `answeredByExternalIdentityId` int,
  `answeredAt` timestamp,
  `affectsScope` boolean,
  `status` enum('open','answered','closed') NOT NULL DEFAULT 'open',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `rfis_id` PRIMARY KEY(`id`),
  CONSTRAINT `rfis_rfiRef_unique` UNIQUE(`rfiRef`)
);
--> statement-breakpoint

CREATE TABLE `projectBudgets` (
  `id` int AUTO_INCREMENT NOT NULL,
  `budgetRef` varchar(64) NOT NULL,
  `customerAccountId` int NOT NULL,
  `jobId` int NOT NULL,
  `quoteId` int,
  `version` int NOT NULL DEFAULT 1,
  `totalCents` int NOT NULL DEFAULT 0,
  `status` enum('draft','approved','superseded') NOT NULL DEFAULT 'draft',
  `percentComplete` int,
  `percentCompleteStatedByUserId` int,
  `percentCompleteStatedAt` timestamp,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `supersedesBudgetId` int,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `projectBudgets_id` PRIMARY KEY(`id`),
  CONSTRAINT `projectBudgets_budgetRef_unique` UNIQUE(`budgetRef`)
);
--> statement-breakpoint

CREATE TABLE `budgetLines` (
  `id` int AUTO_INCREMENT NOT NULL,
  `budgetId` int NOT NULL,
  `costCode` varchar(40) NOT NULL,
  `description` varchar(220) NOT NULL,
  `budgetedCents` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `budgetLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `budgetLines_budget_code_unique` UNIQUE(`budgetId`,`costCode`)
);
