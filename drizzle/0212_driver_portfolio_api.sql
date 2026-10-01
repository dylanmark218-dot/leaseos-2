-- 0212 — Driver Portfolio API: what the service layer needs to write.
--
-- 1. The portfolio's audit rows say which organization they belong to, so
--    "who did what, to whose portfolio, in which organization, and when" is a
--    row and not a join. NULL is the historical single tenant, the 0132 rule.
--    The rows stay append-only (0211): ALTER is DDL and fires no row trigger.
-- 2. The event vocabulary gains the mutations the API performs, and a
--    requirement event, which is about the organization rather than one
--    driver, carries no operator.
-- 3. A requirement is never edited in place once it may have governed a
--    dispatch decision: an update retires it and creates its successor, and
--    the successor names what it replaced.
-- 4. A one-credential share is the repository's invitation token pattern
--    (externalIdentityPolicy.newToken / sha256): only the token's hash is
--    stored, with its expiry and its revocation.

ALTER TABLE `driverPortfolioEvents`
  ADD COLUMN `orgRef` varchar(64) NULL AFTER `eventRef`,
  MODIFY COLUMN `operatorId` int NULL,
  MODIFY COLUMN `eventType` enum('credential_uploaded','credential_verified','credential_rejected','credential_superseded','requirement_bound','requirement_modified','requirement_retired','wallet_viewed','portfolio_viewed','credential_shared','share_revoked','share_verified','used_for_dispatch') NOT NULL;
--> statement-breakpoint
CREATE INDEX `driverPortfolioEvents_org_idx`
  ON `driverPortfolioEvents` (`orgRef`,`operatorId`,`id`);
--> statement-breakpoint
ALTER TABLE `driverRequirementBindings`
  ADD COLUMN `supersedesBindingRef` varchar(96) NULL AFTER `bindingRef`;
--> statement-breakpoint
CREATE TABLE `driverCredentialShares` (
  `id` int AUTO_INCREMENT NOT NULL,
  `shareRef` varchar(96) NOT NULL,
  `orgRef` varchar(64),
  `operatorId` int NOT NULL,
  `credentialId` int NOT NULL,
  `credentialCode` varchar(160) NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `audience` varchar(160) NOT NULL,
  `issuedByUserId` int NOT NULL,
  `issuedAt` timestamp NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `revokedAt` timestamp NULL,
  `revokedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `driverCredentialShares_id` PRIMARY KEY(`id`),
  CONSTRAINT `driverCredentialShares_shareRef_unique` UNIQUE(`shareRef`),
  CONSTRAINT `driverCredentialShares_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `driverCredentialShares_operator_idx`
  ON `driverCredentialShares` (`operatorId`,`expiresAt`);
