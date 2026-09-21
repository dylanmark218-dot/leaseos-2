-- v22.18 — Communications reach dispatch.
--
-- Three things.
--
-- `communicationPolicies` is the company's own answer to "does an incomplete
-- communication plan stop a truck?" — proposed by one person and approved by
-- another, because it decides whether a driver leaves the yard. LeaseOS has no
-- opinion on it: a city flatdeck operator and a lone worker hauling dangerous
-- goods up a resource road at night need different answers, and hard-coding
-- either would be wrong for the other.
--
-- `radioChannels.serviceStatus` exists because Weatheradio was shut down while
-- its transmitter frequencies stayed published. A frequency database without a
-- retired flag will happily tell a driver to rely on a service that no longer
-- transmits. A retired service authorizes nothing, ever.
--
-- `dispatchEligibilityChecks.routeApprovalRef` lets the award-time recomputation
-- ask the same question the check asked. Without it the recompute would drop
-- the route and its channels and refuse on a fingerprint that never matched.

CREATE TABLE `communicationPolicies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `policyRef` varchar(64) NOT NULL,
  `label` varchar(220) NOT NULL,
  `scopeType` enum('company','branch') NOT NULL DEFAULT 'company',
  `scopeRef` varchar(64),
  `unknownPlanBlocks` boolean NOT NULL DEFAULT false,
  `requireTransmitAuthorization` boolean NOT NULL DEFAULT false,
  `toleratedNoCommunicationKm` double NOT NULL DEFAULT 0,
  `loneWorkerRequiresSatellite` boolean NOT NULL DEFAULT false,
  `rationale` varchar(1000),
  `effectiveFrom` timestamp,
  `effectiveTo` timestamp,
  `status` enum('proposed','approved','superseded','rejected') NOT NULL DEFAULT 'proposed',
  `supersedesPolicyRef` varchar(64),
  `proposedByUserId` int NOT NULL,
  `approvedByUserId` int,
  `approvedAt` timestamp,
  `decisionNote` varchar(400),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `communicationPolicies_id` PRIMARY KEY(`id`),
  CONSTRAINT `communicationPolicies_ref_unique` UNIQUE(`policyRef`)
);
--> statement-breakpoint
CREATE INDEX `communicationPolicies_scope` ON `communicationPolicies` (`scopeType`, `scopeRef`, `status`);
--> statement-breakpoint

ALTER TABLE `radioChannels`
  ADD COLUMN `serviceStatus` enum('active','retired') NOT NULL DEFAULT 'active',
  ADD COLUMN `retiredNote` varchar(400),
  ADD COLUMN `retiredAt` timestamp NULL,
  ADD COLUMN `retiredByUserId` int;
--> statement-breakpoint

ALTER TABLE `dispatchEligibilityChecks`
  ADD COLUMN `routeApprovalRef` varchar(64);
