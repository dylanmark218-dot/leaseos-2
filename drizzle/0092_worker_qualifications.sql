-- v22.20 — 0092: where a qualification lives.
--
-- The DDL below is derived column-for-column from the `qualificationTypes` and
-- `workerQualifications` declarations in schema.ts, which another contributor
-- added without a migration — leaving the tree with schema and migrations
-- disagreeing and the gate red for everybody. Nothing here is invented: the
-- schema was the specification and `verify-parity.sh` is the check.
--
-- I had written a competing `workerQualifications` of my own before noticing
-- theirs, and backed mine out. Theirs is the better shape: `qualificationTypes`
-- carries `blocksCapabilitiesJson`, which is what makes an expiry block the
-- dependency rather than the person — the rule `documentValidity` proved and
-- mine had no way to express.
--
-- `verificationState` defaults to `unverified`, so recording a qualification
-- does not make it current. An unverified row counts as an absent one, which is
-- what it is worth.

CREATE TABLE `qualificationTypes` (
  `id` int AUTO_INCREMENT NOT NULL,
  `code` varchar(60) NOT NULL,
  `label` varchar(220) NOT NULL,
  `issuingBody` varchar(220),
  `requiresDocument` boolean NOT NULL DEFAULT true,
  `renewalMonths` int,
  `blocksCapabilitiesJson` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `qualificationTypes_id` PRIMARY KEY(`id`),
  CONSTRAINT `qualificationTypes_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint

CREATE TABLE `workerQualifications` (
  `id` int AUTO_INCREMENT NOT NULL,
  `holdingRef` varchar(64) NOT NULL,
  `tenantId` varchar(40),
  `userId` int NOT NULL,
  `code` varchar(60) NOT NULL,
  `certificateNumber` varchar(120),
  `issuedAt` timestamp NULL,
  `expiresAt` timestamp NULL,
  `verificationState` enum('unverified','extracted','verified','rejected','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp NULL,
  `documentRef` varchar(64),
  `supersededByHoldingRef` varchar(64),
  `recordedByUserId` int NOT NULL,
  `recordedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workerQualifications_id` PRIMARY KEY(`id`),
  CONSTRAINT `workerQualifications_ref_unique` UNIQUE(`holdingRef`)
);
--> statement-breakpoint
CREATE INDEX `workerQualifications_holder` ON `workerQualifications` (`userId`, `code`, `verificationState`, `expiresAt`);
--> statement-breakpoint
CREATE INDEX `workerQualifications_window` ON `workerQualifications` (`tenantId`, `code`, `expiresAt`);
