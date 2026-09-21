-- v21.21 — Audit packages.
--
-- A package asserts nothing new. It is a frozen assembly of records the
-- chain already holds: each item named with its source table, its
-- reference and its content hash; redactions applied by the package kind's
-- policy and LISTED, never silent; what is missing NAMED. The manifest is
-- hashed; the package is the manifest hash. Prepared by one person,
-- released by another — an incomplete package only with its gaps
-- acknowledged. Once released it does not change; a new package
-- supersedes. Every look at a released package is a row.

CREATE TABLE `auditPackages` (
  `id` int AUTO_INCREMENT NOT NULL,
  `packageRef` varchar(64) NOT NULL,
  `kind` enum('vehicle','driver','job','customer','incident','tax') NOT NULL,
  `subjectType` varchar(40) NOT NULL,
  `subjectRef` varchar(80) NOT NULL,
  `periodFrom` timestamp,
  `periodTo` timestamp,
  `recipient` varchar(200) NOT NULL,
  `purpose` varchar(400) NOT NULL,
  `redactionPolicy` varchar(60) NOT NULL,
  `manifestJson` text NOT NULL,
  `manifestHash` varchar(64) NOT NULL,
  `coverStorageKey` varchar(512),
  `coverHash` varchar(64),
  `itemCount` int NOT NULL,
  `redactionCount` int NOT NULL,
  `missingJson` text NOT NULL,
  `status` enum('prepared','released','superseded','withdrawn') NOT NULL DEFAULT 'prepared',
  `preparedByUserId` int NOT NULL,
  `preparedAt` timestamp NOT NULL,
  `releasedByUserId` int,
  `releasedAt` timestamp,
  `releaseNote` varchar(600),
  `gapsAcknowledged` boolean NOT NULL DEFAULT false,
  `supersedesPackageId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `auditPackages_id` PRIMARY KEY(`id`),
  CONSTRAINT `auditPackages_packageRef_unique` UNIQUE(`packageRef`)
);
--> statement-breakpoint

CREATE TABLE `auditPackageItems` (
  `id` int AUTO_INCREMENT NOT NULL,
  `packageId` int NOT NULL,
  `seq` int NOT NULL,
  `itemKind` varchar(60) NOT NULL,
  `sourceTable` varchar(80) NOT NULL,
  `sourceId` int NOT NULL,
  `sourceRef` varchar(120),
  `title` varchar(220) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `storageKey` varchar(512),
  `redactionsJson` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `auditPackageItems_id` PRIMARY KEY(`id`),
  CONSTRAINT `auditPackageItems_package_seq_unique` UNIQUE(`packageId`,`seq`)
);
--> statement-breakpoint

CREATE TABLE `auditPackageAccess` (
  `id` int AUTO_INCREMENT NOT NULL,
  `packageId` int NOT NULL,
  `userId` int NOT NULL,
  `action` enum('view','download','send') NOT NULL,
  `purpose` varchar(300) NOT NULL,
  `at` timestamp NOT NULL,
  CONSTRAINT `auditPackageAccess_id` PRIMARY KEY(`id`)
);
