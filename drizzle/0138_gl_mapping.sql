-- v22.31 — 0138 (P7.6): the general-ledger mapping the accounting-neutral export needs, as
-- per-business configuration. No chart of accounts is seeded: a business's accounts are its
-- own, and inventing a default would be a guess dressed as a fact. Until a business loads its
-- chart and maps its service codes, coding categories and tax treatments, export readiness
-- reports exactly what is unmapped, by name.

CREATE TABLE `commercialGlAccounts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `code` varchar(32) NOT NULL,
  `name` varchar(120) NOT NULL,
  `kind` enum('revenue','cost_of_sales','expense','asset','liability','equity','tax') NOT NULL,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `source` varchar(160) NOT NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialGlAccounts_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialGlAccounts_code` UNIQUE(`bookOrgRef`,`code`)
);
--> statement-breakpoint
CREATE TABLE `commercialGlMappings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `mappingKind` enum('service_code','coding_category','gst_output','gst_input') NOT NULL,
  `mappingKey` varchar(80) NOT NULL,
  `glAccountCode` varchar(32) NOT NULL,
  `source` varchar(160) NOT NULL,
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commercialGlMappings_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialGlMappings_key` UNIQUE(`bookOrgRef`,`mappingKind`,`mappingKey`)
);
