CREATE TABLE `taxonomyEntries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `dimension` enum('service','truck','trailer','cargo','environment','radius','load_method','unload_method','billing_unit','safety_ticket','ppe','permit') NOT NULL,
  `code` varchar(40) NOT NULL, `label` varchar(180) NOT NULL, `parentCode` varchar(40),
  `attributesJson` text, `active` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `taxonomyEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomyEntries_dim_code_idx` ON `taxonomyEntries` (`dimension`,`code`);
--> statement-breakpoint
CREATE TABLE `regulatoryThresholds` (
  `id` int AUTO_INCREMENT NOT NULL, `jurisdiction` varchar(60) NOT NULL,
  `widthM` double NOT NULL, `heightM` double NOT NULL, `lengthM` double NOT NULL,
  `gvwKg` double NOT NULL, `source` varchar(300) NOT NULL,
  `effectiveDate` timestamp, `lastVerified` timestamp,
  `confidence` enum('unverified','operator_supplied','authority_confirmed') NOT NULL DEFAULT 'unverified',
  `supersededAt` timestamp, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `regulatoryThresholds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `regulatoryThresholds_jurisdiction_idx` ON `regulatoryThresholds` (`jurisdiction`,`supersededAt`);
--> statement-breakpoint
CREATE TABLE `customerBillingConfigs` (
  `id` int AUTO_INCREMENT NOT NULL, `customer` varchar(220) NOT NULL,
  `defaultTicketScope` enum('job','trip','load','service_event') NOT NULL DEFAULT 'load',
  `allowedScopeOverrides` varchar(200),
  `signatureRequired` boolean NOT NULL DEFAULT true,
  `partialAcceptanceAllowed` boolean NOT NULL DEFAULT true,
  `requiredFields` text, `requiredDocuments` text, `externalPortal` varchar(120),
  `paymentTermsDays` int NOT NULL DEFAULT 30,
  `createdAt` timestamp NOT NULL DEFAULT (now()), `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `customerBillingConfigs_id` PRIMARY KEY(`id`),
  CONSTRAINT `customerBillingConfigs_customer_unique` UNIQUE(`customer`)
);
--> statement-breakpoint
CREATE TABLE `billingBookEntries` (
  `id` int AUTO_INCREMENT NOT NULL, `billingBookId` int NOT NULL,
  `fieldTicketLineId` int, `tripId` int, `loadId` int, `disposalTicketId` int,
  `rateCardId` int, `billingUnit` varchar(60),
  `billingStatus` enum('pending','ready','held','billed','credited','written_off') NOT NULL DEFAULT 'pending',
  `holdReason` varchar(300), `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billingBookEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `billingBookEntries_book_idx` ON `billingBookEntries` (`billingBookId`);
--> statement-breakpoint
CREATE TABLE `billingSnapshots` (
  `id` int AUTO_INCREMENT NOT NULL, `invoiceId` int NOT NULL, `billingBookId` int NOT NULL,
  `capturedAt` timestamp NOT NULL, `capturedByUserId` int,
  `rateCardVersion` varchar(40), `sourceFactsJson` text NOT NULL,
  `calculatedLinesJson` text NOT NULL, `excludedLinesJson` text,
  `subtotalCents` int NOT NULL, `totalCents` int NOT NULL,
  `payloadHash` varchar(128) NOT NULL, `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billingSnapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `billingSnapshots_invoice_idx` ON `billingSnapshots` (`invoiceId`);
