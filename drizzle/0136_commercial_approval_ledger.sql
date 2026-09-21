-- v22.29 — 0136 (P7.4): the approval ledger, and customer accounts linkable to organizations.
--
-- Every money decision the office takes records the requirement the ladder produced at the
-- time (snapshotted with its layer and tier — the answer does not drift if the policy is
-- later changed) and each person's approval in order. Whether the requirement is satisfied
-- is computed from those rows; a subject's status becomes "approved" only then. Credits and
-- write-offs use it now; purchase orders and vendor bills join in P7.5.

CREATE TABLE `commercialApprovals` (
  `id` int AUTO_INCREMENT NOT NULL,
  `approvalRef` varchar(40) NOT NULL,
  `bookOrgRef` varchar(64) NULL,
  `category` varchar(40) NOT NULL,
  `subjectType` varchar(40) NOT NULL,
  `subjectRef` varchar(64) NOT NULL,
  `amountCents` bigint NOT NULL,
  `preparedByUserId` int NULL,
  `requirement` json NOT NULL,
  `status` enum('awaiting','satisfied','refused','review') NOT NULL DEFAULT 'awaiting',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `satisfiedAt` timestamp NULL,
  CONSTRAINT `commercialApprovals_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialApprovals_ref` UNIQUE(`approvalRef`),
  CONSTRAINT `commercialApprovals_subject` UNIQUE(`subjectType`,`subjectRef`)
);
--> statement-breakpoint
CREATE TABLE `commercialApprovalSignatures` (
  `id` int AUTO_INCREMENT NOT NULL,
  `commercialApprovalId` int NOT NULL,
  `sequence` int NOT NULL,
  `userId` int NOT NULL,
  `rolesAtApproval` json NOT NULL,
  `decision` enum('approved','refused') NOT NULL,
  `note` varchar(500) NULL,
  `at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `commercialApprovalSignatures_id` PRIMARY KEY(`id`),
  CONSTRAINT `commercialApprovalSignatures_seq` UNIQUE(`commercialApprovalId`,`sequence`)
);
--> statement-breakpoint
-- A customer account is linked to an organization by a person (P7.2 rule); NULL until then.
ALTER TABLE `customerAccounts` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `customerAccounts_org` ON `customerAccounts` (`orgRef`);
--> statement-breakpoint
-- Customer accounts join the link types (0134's enum, widened; that migration is two commits old and unreleased).
ALTER TABLE `organizationRecordLinks` MODIFY COLUMN `recordType` enum('vendor','facility','job_customer','customer_account') NOT NULL;
--> statement-breakpoint
-- Correction to 0133's seed: the first tier named `office`, but credits and write-offs are
-- decided by the `controller` role in this codebase (office and bookkeeper only request).
-- The default tier-1 approver is therefore controller; the note keeps the owner's word.
UPDATE `commercialApprovalPolicies`
   SET `approverRole` = 'controller',
       `source` = 'owner_decision_2026-09-17 (supervisor up to $5,000 -> controller, who decides credits and write-offs; confirm mapping)'
 WHERE `bookOrgRef` IS NULL AND `approverRole` = 'office' AND `maxAmountCents` = 500000;
