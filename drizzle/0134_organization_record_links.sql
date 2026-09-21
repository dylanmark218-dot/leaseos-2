-- v22.27 — 0134 (P7.2): linking the office's existing records to organizations is a person's act.
--
-- `vendors`, `facilities` and the client named on a job all predate the organization master.
-- Each now carries a nullable organization reference beside its legacy text, which stays as
-- the captured snapshot. NOTHING IS BACKFILLED BY MATCHING NAMES: a link exists only because
-- a person made it, and every link and unlink is kept in `organizationRecordLinks`.

ALTER TABLE `vendors` ADD COLUMN `orgRef` varchar(64) NULL;
ALTER TABLE `facilities` ADD COLUMN `orgRef` varchar(64) NULL;
ALTER TABLE `jobs` ADD COLUMN `customerOrgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE TABLE `organizationRecordLinks` (
  `id` int AUTO_INCREMENT NOT NULL,
  `linkRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `orgRef` varchar(64) NOT NULL,
  `recordType` enum('vendor','facility','job_customer') NOT NULL,
  `recordId` int NOT NULL,
  `roleKeyRequired` varchar(40) NOT NULL,
  `status` enum('active','ended') NOT NULL DEFAULT 'active',
  `note` varchar(500) NULL,
  `linkedByUserId` int NOT NULL,
  `linkedAt` timestamp NOT NULL DEFAULT (now()),
  `endedByUserId` int NULL,
  `endedAt` timestamp NULL,
  `endReason` varchar(500) NULL,
  CONSTRAINT `organizationRecordLinks_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationRecordLinks_ref` UNIQUE(`linkRef`)
);
--> statement-breakpoint
CREATE INDEX `organizationRecordLinks_record` ON `organizationRecordLinks` (`recordType`,`recordId`,`status`);
--> statement-breakpoint
CREATE INDEX `organizationRecordLinks_org` ON `organizationRecordLinks` (`orgRef`,`status`);
