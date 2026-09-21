-- v22.26 — 0133 (P7.1): the Commercial Office is configured per business, with the owner's
-- 2026-09-17 decisions seeded as the defaults a business may override.
--
-- Every configuration row carries `bookOrgRef`: NULL is the platform default, a value is one
-- business's own answer, which wins over the default for that business. Every seeded row
-- carries its `source`. Nothing here is hard-coded into procedures: the code reads these
-- tables. An amount, role or category no row covers is UNKNOWN to the code, never assumed.

-- 1. What an organization can be. Five built-in roles; a business may add its own.
CREATE TABLE `commercialRoleTypes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `roleKey` varchar(40) NOT NULL,
  `label` varchar(120) NOT NULL,
  `builtIn` boolean NOT NULL DEFAULT false,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `source` varchar(160) NOT NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialRoleTypes_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialRoleTypes_key` UNIQUE(`bookOrgRef`,`roleKey`)
);
--> statement-breakpoint
INSERT INTO `commercialRoleTypes` (`bookOrgRef`,`roleKey`,`label`,`builtIn`,`source`) VALUES
  (NULL,'client','Client',true,'owner_decision_2026-09-17'),
  (NULL,'vendor','Vendor',true,'owner_decision_2026-09-17'),
  (NULL,'disposal_facility','Disposal / Facility',true,'owner_decision_2026-09-17'),
  (NULL,'subcontractor','Subcontractor / Owner-Operator',true,'owner_decision_2026-09-17'),
  (NULL,'supplier','Supplier',true,'owner_decision_2026-09-17');
--> statement-breakpoint
-- One organization, any combination of roles, each with its own commercial number (CLI-…, VEN-…).
CREATE TABLE `organizationCommercialRoles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `roleRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `orgRef` varchar(64) NOT NULL,
  `roleKey` varchar(40) NOT NULL,
  `commercialNumber` varchar(40) NULL,
  `status` enum('active','suspended','ended') NOT NULL DEFAULT 'active',
  `effectiveFrom` date NOT NULL,
  `effectiveTo` date NULL,
  `note` varchar(500) NULL,
  `assignedByUserId` int NOT NULL,
  `assignedAt` timestamp NOT NULL DEFAULT (now()),
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  CONSTRAINT `organizationCommercialRoles_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationCommercialRoles_ref` UNIQUE(`roleRef`),
  CONSTRAINT `organizationCommercialRoles_number` UNIQUE(`bookOrgRef`,`commercialNumber`)
);
--> statement-breakpoint
CREATE INDEX `organizationCommercialRoles_org` ON `organizationCommercialRoles` (`orgRef`,`roleKey`,`status`);
--> statement-breakpoint
-- 2. How commercial numbers are made: the format per sequence, per business.
CREATE TABLE `commercialNumberingPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `sequenceType` varchar(24) NOT NULL,
  `prefix` varchar(12) NOT NULL,
  `separator` varchar(3) NOT NULL DEFAULT '-',
  `yearDigits` tinyint NOT NULL DEFAULT 4,
  `includeMonth` boolean NOT NULL DEFAULT false,
  `sequenceDigits` tinyint NOT NULL DEFAULT 6,
  `resetPeriod` enum('never','yearly','monthly') NOT NULL DEFAULT 'yearly',
  `source` varchar(160) NOT NULL,
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commercialNumberingPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialNumberingPolicies_key` UNIQUE(`bookOrgRef`,`sequenceType`)
);
--> statement-breakpoint
INSERT INTO `commercialNumberingPolicies` (`bookOrgRef`,`sequenceType`,`prefix`,`yearDigits`,`sequenceDigits`,`resetPeriod`,`source`) VALUES
  (NULL,'CLI','CLI',0,6,'never','owner_decision_2026-09-17 (CLI-000123)'),
  (NULL,'VEN','VEN',0,6,'never','owner_decision_2026-09-17 (VEN-000087)'),
  (NULL,'PO','PO',4,6,'yearly','owner_decision_2026-09-17 (PO-2026-001245)'),
  (NULL,'MF','MF',4,6,'yearly','owner_decision_2026-09-17 (MF-2026-004812)'),
  (NULL,'INV','INV',4,6,'yearly','owner_decision_2026-09-17 (INV-2026-003117)');
--> statement-breakpoint
-- 3. Which accounting system the office exports to. The core stays accounting-neutral.
CREATE TABLE `commercialSettings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `accountingTarget` enum('none','quickbooks_online','sage','xero','custom') NOT NULL DEFAULT 'quickbooks_online',
  `accountingTargetLabel` varchar(120) NULL,
  `source` varchar(160) NOT NULL,
  `updatedByUserId` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `commercialSettings_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialSettings_book` UNIQUE(`bookOrgRef`)
);
--> statement-breakpoint
INSERT INTO `commercialSettings` (`bookOrgRef`,`accountingTarget`,`accountingTargetLabel`,`source`) VALUES
  (NULL,'quickbooks_online','QuickBooks Online (first export target; core is accounting-neutral)','owner_decision_2026-09-17');
--> statement-breakpoint
-- 4. Who approves money, at what level. Tiers per category per business; an amount no tier
-- covers is UNKNOWN. The owner's ladder named supervisor / manager / administrator-owner,
-- which are not LeaseOS roles: the default maps them to office / management / management
-- with a second person, and says so in `source` so the mapping can be confirmed or changed.
CREATE TABLE `commercialApprovalPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `category` varchar(40) NOT NULL,
  `maxAmountCents` bigint NULL,
  `approverRole` varchar(40) NOT NULL,
  `secondPersonRequired` boolean NOT NULL DEFAULT false,
  `separationOfDuties` boolean NOT NULL DEFAULT true,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `source` varchar(200) NOT NULL,
  `effectiveFrom` date NOT NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialApprovalPolicies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `commercialApprovalPolicies_lookup` ON `commercialApprovalPolicies` (`bookOrgRef`,`category`,`status`);
--> statement-breakpoint
INSERT INTO `commercialApprovalPolicies` (`bookOrgRef`,`category`,`maxAmountCents`,`approverRole`,`secondPersonRequired`,`source`,`effectiveFrom`)
SELECT NULL, c.category, t.maxAmountCents, t.approverRole, t.secondPerson,
       CONCAT('owner_decision_2026-09-17 (', t.tierNote, ')'), '2026-09-17'
FROM (SELECT 'purchase_order' AS category UNION ALL SELECT 'vendor_bill' UNION ALL SELECT 'credit'
      UNION ALL SELECT 'rate_override' UNION ALL SELECT 'write_off' UNION ALL SELECT 'payment') c
CROSS JOIN (
  SELECT 500000 AS maxAmountCents, 'office' AS approverRole, false AS secondPerson, 'supervisor up to $5,000 -> office; confirm mapping' AS tierNote
  UNION ALL SELECT 2500000, 'management', false, 'manager up to $25,000 -> management; confirm mapping'
  UNION ALL SELECT NULL, 'management', true, 'administrator/owner above $25,000 -> management with a second person; confirm mapping'
) t;
--> statement-breakpoint
-- 5. What the office classifies. Profitability dimensions are seeded; load categories and
-- document types start EMPTY — the business adds its own rather than inheriting a guess.
CREATE TABLE `commercialCategoryTypes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `kind` enum('document_type','load_category','profitability_dimension') NOT NULL,
  `categoryKey` varchar(40) NOT NULL,
  `label` varchar(120) NOT NULL,
  `builtIn` boolean NOT NULL DEFAULT false,
  `status` enum('active','retired') NOT NULL DEFAULT 'active',
  `source` varchar(160) NOT NULL,
  `createdByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialCategoryTypes_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialCategoryTypes_key` UNIQUE(`bookOrgRef`,`kind`,`categoryKey`)
);
--> statement-breakpoint
INSERT INTO `commercialCategoryTypes` (`bookOrgRef`,`kind`,`categoryKey`,`label`,`builtIn`,`source`) VALUES
  (NULL,'profitability_dimension','client','Client',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','job','Job',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','load','Load',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','unit','Unit',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','driver','Driver / Operator',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','branch','Branch',true,'owner_decision_2026-09-17'),
  (NULL,'profitability_dimension','contractor','Contractor',true,'owner_decision_2026-09-17');
