-- v22.20 — 0084: the release policy, as a record an auditor can read.
--
-- The policy engine was real and the policy itself was a TypeScript shape, so
-- "an auditor can read the policy in force that day" was not yet true. This
-- makes it true, on the pattern `communicationPolicies` already established:
-- separate proposer and approver fields, effective-dated, superseded rather than
-- overwritten. The table records two identities; whether they must differ is
-- enforced by the policy API, not by the schema.
--
-- And the order records which policy released it. Without that, an auditor in
-- 2028 reconstructs which policy probably applied; with it they are shown the
-- one that did.

CREATE TABLE `oosReleasePolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(64) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `label` varchar(220) NOT NULL,
  `scopeType` enum('company','branch','terminal') NOT NULL DEFAULT 'company',
  `scopeRef` varchar(64),
  `repairerMayRecordRepairVerification` boolean NOT NULL DEFAULT false,
  `releaserMustDifferFromRepairer` boolean NOT NULL DEFAULT true,
  `releaserMustDifferFromFindingAuthor` boolean NOT NULL DEFAULT false,
  `allowedFindingRolesJson` text NOT NULL,
  `rationale` varchar(1000),
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `status` enum('proposed','approved','superseded','rejected') NOT NULL DEFAULT 'proposed',
  `supersedesPolicyRef` varchar(64),
  `proposedByUserId` int NOT NULL,
  `approvedByUserId` int,
  `approvedAt` timestamp NULL,
  `decisionNote` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `oosReleasePolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `oosReleasePolicies_ref_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint
CREATE INDEX `oosReleasePolicies_inforce` ON `oosReleasePolicies` (`status`, `effectiveFrom`, `effectiveTo`);
--> statement-breakpoint

-- Which policy actually released this order, bound at the moment of release.
ALTER TABLE `outOfServiceOrders`
  ADD COLUMN `releasePolicyRef` varchar(64) NULL,
  ADD COLUMN `releasePolicyVersion` int NULL;
